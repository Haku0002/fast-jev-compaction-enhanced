import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { claudeAsker, DEFAULT_CLAUDE_MODEL, forkAsker, type Completer, type Forker } from '../src/claude-asker.js';
import { compact, prunableShare, reductionRatio, resolveOptions } from '../src/compact.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse, withRetry, withTimeout } from '../src/request.js';
import type {
  CallDecision,
  CompactOptions,
  CompactResult,
  DropCalls,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

/**
 * `jev` scores over HTTP; `claude` over `$.model.complete` with windowed
 * states; `fork` over `$.model.fork`, the session's own transcript from its
 * prompt cache, so the judge sees the whole conversation at no input cost;
 * `auto` picks `jev` when a key is set, else `claude`.
 */
export type Backend = 'auto' | 'jev' | 'claude' | 'fork';
export type NothingToPrune = 'keep' | 'summary';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  model: DEFAULT_MODEL,
  backend: 'auto' as Backend,
  claudeModel: DEFAULT_CLAUDE_MODEL,
  nothingToPrune: 'keep' as NothingToPrune,
  timeoutMs: 90_000,
  arbiterModel: 'haiku',
};

/** The Claude judge reads far more than Jev; its windows default to this size. */
const CLAUDE_STATE_TOKENS = 80_000;
const CLAUDE_REQUEST_TOKENS = 100_000;
/** The fork judge has the transcript already; the state is only planned, never sent, so one window takes everything. */
const FORK_STATE_TOKENS = 4_000_000;
const FORK_REQUEST_TOKENS = 4_000_000;
/** Percentage points the context must fall, or grow past the last trigger, before turn.complete compacts again. */
const REARM_PERCENT = 10;
const LOG_LINES = 200;
/** Lines kept of the per-call decisions log, about 30 compactions of a long session. */
const DECISION_LOG_LINES = 3000;

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
  /** Response headers, when the transport has them; `Retry-After` paces a retry. */
  headers?: Record<string, string>;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  model: string;
  /** Which judge scores the calls: Jev over HTTP, Claude over `$.model.complete` or `$.model.fork`, or Jev when a key is set. */
  backend: Backend;
  /** Model alias or id for the Claude judge. */
  claudeModel: string;
  /** When too little is prunable: leave the history as it is, or hand it to the built-in summary. */
  nothingToPrune: NothingToPrune;
  /** Milliseconds one judge request may take before the round is given up; 0 waits forever. */
  timeoutMs: number;
  /**
   * Model alias or id that re-judges the calls Jev was unsure about (within
   * `arbitrateBand` of a threshold) over `$.model.complete`; empty turns the
   * arbiter off. Only with the Jev judge: the Claude judges are their own.
   */
  arbiterModel: string;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function resolveBackend(value: string | undefined): Backend {
  return value === 'jev' || value === 'claude' || value === 'fork' ? value : HOOK_DEFAULTS.backend;
}

function resolveDropCalls(value: string | undefined): DropCalls | undefined {
  return value === 'stub' || value === 'delete' ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal' | 'dropCalls' | 'pruneMachineText'>> = {};
  for (const key of [
    'keepThreshold',
    'keepCallThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
    'stubChars',
    'concurrency',
    'arbitrateBand',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
    backend: resolveBackend(optionString(options, 'backend')),
    claudeModel: optionString(options, 'claudeModel') ?? HOOK_DEFAULTS.claudeModel,
    nothingToPrune:
      optionString(options, 'nothingToPrune') === 'summary' ? 'summary' : HOOK_DEFAULTS.nothingToPrune,
    timeoutMs: Math.max(0, optionNumber(options, 'timeoutMs', HOOK_DEFAULTS.timeoutMs)),
    arbiterModel:
      typeof options['arbiterModel'] === 'string' ? options['arbiterModel'].trim() : HOOK_DEFAULTS.arbiterModel,
  };
  const dropCalls = resolveDropCalls(optionString(options, 'dropCalls'));
  if (dropCalls) config.dropCalls = dropCalls;
  if (typeof options['pruneMachineText'] === 'boolean') {
    config.pruneMachineText = options['pruneMachineText'];
  }
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** A `JevAsker` over the engine's `$.http.fetch`, with one retry on a transient failure. */
export function jevAsker(
  fetchFn: HookFetch,
  apiKey: string,
  model: string,
  sleep?: (ms: number) => Promise<void>,
): JevAsker {
  return {
    ask(state, questions) {
      return withRetry(
        async () => {
          const request = buildJevRequest({ apiKey, model }, state, questions);
          const response = await fetchFn(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
          });
          return parseJevResponse(response.status, response.ok, response.text, response.headers);
        },
        { sleep },
      );
    },
  };
}

/** The same asker with every `ask` bounded to `ms`; a timed-out request fails the round like any other error. */
export function timedAsker(asker: JevAsker, ms: number, sleep: ((ms: number) => Promise<void>) | undefined): JevAsker {
  if (!sleep || ms <= 0) return asker;
  return {
    ask: (state, questions, calls) =>
      withTimeout(asker.ask(state, questions, calls), ms, sleep, 'judge request'),
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** The judge the config and the available key select: `jev`, `claude` or `fork`. */
export function selectBackend(config: HookConfig): Exclude<Backend, 'auto'> {
  if (config.backend === 'auto') return config.apiKey ? 'jev' : 'claude';
  return config.backend;
}

/** The library options for the selected judge: the Claude judges get wider windows unless set. */
export function libraryOptions(config: HookConfig): CompactOptions {
  const backend = selectBackend(config);
  if (backend === 'jev') return config;
  const wide = backend === 'fork' ? [FORK_STATE_TOKENS, FORK_REQUEST_TOKENS] : [CLAUDE_STATE_TOKENS, CLAUDE_REQUEST_TOKENS];
  return {
    ...config,
    maxStateTokens: config.maxStateTokens ?? wide[0],
    maxRequestTokens: config.maxRequestTokens ?? wide[1],
  };
}

export type Judges = {
  fetch: HookFetch;
  complete?: Completer;
  fork?: Forker;
  sleep?: (ms: number) => Promise<void>;
};

/** Builds the asker for the selected judge; throws when Jev is selected without a key. */
export function pickAsker(config: HookConfig, judges: Judges): JevAsker {
  const backend = selectBackend(config);
  let asker: JevAsker;
  if (backend === 'fork') {
    if (!judges.fork) throw new Error('fork judge needs $.model.fork');
    asker = forkAsker(judges.fork);
  } else if (backend === 'claude') {
    if (!judges.complete) throw new Error('Claude judge needs $.model.complete');
    asker = claudeAsker(judges.complete, { model: config.claudeModel });
  } else {
    if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
    asker = jevAsker(judges.fetch, config.apiKey, config.model, judges.sleep);
  }
  return timedAsker(asker, config.timeoutMs, judges.sleep);
}

/** The arbiter for the borderline calls, when Jev judges and a model is named; none otherwise. */
export function pickArbiter(config: HookConfig, judges: Judges): JevAsker | undefined {
  if (selectBackend(config) !== 'jev' || !config.arbiterModel || !judges.complete) return undefined;
  return timedAsker(claudeAsker(judges.complete, { model: config.arbiterModel }), config.timeoutMs, judges.sleep);
}

/** Runs the library over a session transcript; throws when the judge is unavailable or fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  judges: Judges,
): Promise<SessionCompaction> {
  const arbiter = pickArbiter(config, judges);
  const options: CompactOptions = arbiter ? { ...libraryOptions(config), arbiter } : libraryOptions(config);
  const result = await compact(messages, pickAsker(config, judges), options);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** The scored (not pinned, not unscored) decisions of a round. */
function scored(result: CompactResult): CallDecision[] {
  return result.decisions.filter((d) => d.reason !== 'pinned' && d.reason !== 'unscored');
}

const BANDS: readonly [label: string, below: number][] = [
  ['<0.1', 0.1],
  ['<0.3', 0.3],
  ['<0.5', 0.5],
  ['≥0.5', Number.POSITIVE_INFINITY],
];

function bands(values: readonly number[]): string {
  const counts = BANDS.map(() => 0);
  for (const value of values) {
    const index = BANDS.findIndex(([, below]) => value < below);
    const band = index < 0 ? BANDS.length - 1 : index;
    counts[band] = (counts[band] ?? 0) + 1;
  }
  return BANDS.map(([label], i) => `${counts[i]} ${label}`).join(', ');
}

/**
 * How the judge's probabilities fell, in four bands each for the call and
 * the result question: the quickest check that a threshold is placed where
 * the answers actually split, or that a round stubbed nearly everything
 * because the judge sat just under 0.5 rather than near zero.
 */
export function probabilityProfile(result: CompactResult): string {
  const decisions = scored(result);
  if (decisions.length === 0) return '';
  const asked = decisions.filter((d) => d.resultAsked);
  const call = `call p: ${bands(decisions.map((d) => d.keepCall))}`;
  const arbitrated = result.stats.arbitrated > 0 ? ` | arbiter: ${result.stats.arbitrated} re-judged, ${result.stats.arbiterFlips} flipped` : '';
  if (asked.length === 0) return `${call}${arbitrated}`;
  return `${call} | result p (${asked.length} asked): ${bands(asked.map((d) => d.keepResult))}${arbitrated}`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const profile = probabilityProfile(result);
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsStubbed > 0 ? `${stats.callsStubbed} stubbed` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} removed` : '',
    stats.unscored > 0 ? `${stats.unscored} unscored` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
    stats.machineBlocksPruned > 0 ? `${stats.machineBlocksPruned} host blocks cut` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; ${stats.requests} request(s), largest state ~${stats.stateTokens} tokens, ${stats.ms} ms${
    profile ? `; ${profile}` : ''
  }`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

/**
 * One line per decision for the decisions log file, with what the call was
 * about and how big its result was, so a stubbed Edit or a kept Read can be
 * told apart after the fact.
 */
export function decisionLines(result: CompactResult): string[] {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map((d) => {
      const was = (value: number, judged: number | undefined): string =>
        judged === undefined ? value.toFixed(2) : `${value.toFixed(2)}(jev ${judged.toFixed(2)})`;
      const call = was(d.keepCall, d.judged?.keepCall);
      const res = d.resultAsked ? was(d.keepResult, d.judged?.keepResult) : '-';
      const size = d.resultChars === undefined ? '' : ` ${d.resultChars}ch`;
      return `  ${d.id} ${d.tool} ${d.action} call=${call} result=${res}${size} ${d.about ?? ''}`.trimEnd();
    });
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

/** Whether turn.complete should compact now, given the context percentage and what it did last. */
export function shouldCompact(
  percentUsed: number,
  compactAtPercent: number,
  memory: { armed: boolean; lastTriggered: number },
): boolean {
  if (percentUsed < compactAtPercent - REARM_PERCENT) memory.armed = true;
  if (percentUsed < compactAtPercent) return false;
  if (!memory.armed && percentUsed < memory.lastTriggered + REARM_PERCENT) return false;
  memory.armed = false;
  memory.lastTriggered = percentUsed;
  return true;
}

type Env = { env: { get: (name: string) => Promise<string | undefined> } };
type SettingsReader = { settings: { read: () => Promise<Readonly<Record<string, unknown>>> } };

async function getApiKey($: Env & SettingsReader, config: HookConfig): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

type Ui = {
  ui: {
    log: (text: string) => void;
    toast: (text: string, options?: { timeoutMs?: number }) => void;
  };
};

function notify($: Ui, text: string, quiet: boolean): void {
  $.ui.log(text);
  if (!quiet) $.ui.toast(text, { timeoutMs: 15_000 });
}

type Recorder = Env & {
  clock: { now: () => Promise<number> };
  fs: {
    exists: (path: string) => Promise<boolean>;
    read: (path: string) => Promise<string>;
    write: (path: string, text: string) => Promise<void>;
  };
  store: { set: (key: string, value: unknown) => Promise<void> };
};

async function homeDir($: Env): Promise<string | undefined> {
  return (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'));
}

/** Appends `lines` to `path`, keeping the last `keep` lines; never throws. */
async function appendBounded($: Recorder, path: string, lines: readonly string[], keep: number): Promise<void> {
  try {
    const previous = (await $.fs.exists(path)) ? await $.fs.read(path) : '';
    const kept = previous.split('\n').filter(Boolean);
    kept.push(...lines);
    await $.fs.write(path, `${kept.slice(-keep).join('\n')}\n`);
  } catch {
    // a log line is never worth failing a compaction
  }
}

/** Appends one line to `~/.claude/fast-jev-compaction.log` and keeps the last outcome in the store; never throws. */
async function record($: Recorder, line: string): Promise<void> {
  try {
    const stamp = new Date(await $.clock.now()).toISOString();
    await $.store.set('lastCompaction', { at: stamp, line });
    const home = await homeDir($);
    if (!home) return;
    await appendBounded($, `${home}/.claude/fast-jev-compaction.log`, [`${stamp} ${line}`], LOG_LINES);
  } catch {
    // a log line is never worth failing a compaction
  }
}

/**
 * Appends a round's per-call decisions to `~/.claude/fast-jev-compaction.decisions.log`
 * under a header naming the round, so thresholds can be checked against what
 * the judge actually answered; never throws.
 */
async function recordDecisions($: Recorder, header: string, result: CompactResult): Promise<void> {
  try {
    const stamp = new Date(await $.clock.now()).toISOString();
    const home = await homeDir($);
    if (!home) return;
    const lines = [`${stamp} ${header}`, ...decisionLines(result)];
    await appendBounded($, `${home}/.claude/fast-jev-compaction.decisions.log`, lines, DECISION_LOG_LINES);
  } catch {
    // a log line is never worth failing a compaction
  }
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;
  const memory = { armed: true, lastTriggered: 0 };

  on('session.compact', async ($, event, next) => {
    const quiet = event.trigger === 'precompute' || event.agentId !== undefined;
    const tag = `[${event.trigger}${event.agentId ? ` ${event.agentId}` : ''}]`;
    try {
      const config: HookConfig = { ...configured, apiKey: await getApiKey($, configured) };
      if (event.instructions) {
        config.goal = config.goal ? `${event.instructions}\n${config.goal}` : event.instructions;
      }
      const backend = selectBackend(config);
      const share = prunableShare(event.messages, libraryOptions(config));
      if (share < config.minReductionRatio) {
        const line = `${tag} ${percent(share)} of the history is prunable (below ${percent(
          config.minReductionRatio,
        )} minimum)`;
        if (event.trigger === 'auto' || config.nothingToPrune === 'summary') {
          notify($, `${line}; built-in summary`, quiet);
          await record($, `${line}; built-in summary`);
          return next(event);
        }
        notify($, `${line}; history left unchanged`, quiet);
        await record($, `${line}; history left unchanged`);
        return { messages: event.messages };
      }
      const { result, messages } = await compactSession(event.messages, config, {
        fetch: async (url, init) => {
          const response = await $.http.fetch(url, init);
          return { status: response.status, ok: response.ok, text: response.text, headers: response.headers };
        },
        complete: (request) => $.model.complete(request),
        // The fork judge is only for the main conversation: a subagent's transcript is not the session's.
        fork: event.agentId === undefined ? (request) => $.model.fork(request) : undefined,
        sleep: (ms) => $.clock.sleep(ms),
      });
      for (const line of decisionLogLines(result)) $.ui.log(line);
      const line = `${tag} [${backend}] kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(
        result,
      )})`;
      notify($, line, quiet);
      await record($, line);
      await recordDecisions($, line, result);
      return { messages };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      notify($, `${tag} fallback to built-in summary (${reason})`, quiet);
      await record($, `${tag} fallback to built-in summary (${reason})`);
      return next(event);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting || event.agentId !== undefined) return next(event);
    try {
      const { context } = await $.session.usage();
      if (!shouldCompact(context.percent ?? 0, configured.compactAtPercent, memory)) return next(event);
      compacting = true;
      const outcome = await $.session.compact();
      if (outcome.skip) $.ui.log(`auto-compact skipped (${outcome.skip})`);
    } catch (error) {
      $.ui.log(
        `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
