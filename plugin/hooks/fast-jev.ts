import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

const DEFAULTS = {
  dropThreshold: 0.8,
  protectThreshold: 0.7,
  preserveRecentMessages: 6,
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  maxWindowChars: 60_000,
  previewChars: 800,
  model: 'jev-latest',
};

const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';

const COMPACTION_CONTEXT =
  'A coding assistant conversation is being compacted to free context. Each unit is one message, or a tool call together with its result. Units judged removable are deleted permanently; kept units stay verbatim. The assistant can always re-read files and re-run commands, so tool output that has already been used is not needed again.';

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

export type HookFetch = (
  url: string,
  init?: HookFetchInit,
) => Promise<HookFetchResponse>;

export type CompactionUnit = {
  id: string;
  messages: SessionMessage[];
  pinned: boolean;
  preview: string;
};

export type UnitAnswer = {
  drop: number;
  protect: number;
};

export type UnitDecision = UnitAnswer & {
  id: string;
  action: 'keep' | 'drop';
  reason: 'pinned' | 'protected' | 'below_threshold' | 'dropped';
};

export type ModConfig = {
  apiKey?: string;
  dropThreshold?: number;
  protectThreshold?: number;
  preserveRecentMessages?: number;
  compactAtPercent?: number;
  minReductionRatio?: number;
  maxWindowChars?: number;
  previewChars?: number;
  model?: string;
  goal?: string;
};

type ResolvedConfig = {
  apiKey?: string;
  dropThreshold: number;
  protectThreshold: number;
  preserveRecentMessages: number;
  compactAtPercent: number;
  minReductionRatio: number;
  maxWindowChars: number;
  previewChars: number;
  model: string;
  goal: string;
};

type JevAnswer = { type?: 'noul'; noul: number };

type JevResponse = {
  answers?: Record<string, JevAnswer>;
};

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function optionNumber(
  options: PluginOptions | ModConfig,
  key: keyof ModConfig,
  fallback: number,
): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(
  options: PluginOptions | ModConfig,
  key: keyof ModConfig,
  fallback: string,
): string {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function resolveConfig(options: PluginOptions | ModConfig): ResolvedConfig {
  return {
    apiKey:
      typeof options.apiKey === 'string' && options.apiKey.length > 0
        ? options.apiKey
        : undefined,
    dropThreshold: optionNumber(
      options,
      'dropThreshold',
      DEFAULTS.dropThreshold,
    ),
    protectThreshold: optionNumber(
      options,
      'protectThreshold',
      DEFAULTS.protectThreshold,
    ),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        optionNumber(
          options,
          'preserveRecentMessages',
          DEFAULTS.preserveRecentMessages,
        ),
      ),
    ),
    compactAtPercent: optionNumber(
      options,
      'compactAtPercent',
      DEFAULTS.compactAtPercent,
    ),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      DEFAULTS.minReductionRatio,
    ),
    maxWindowChars: Math.max(
      1,
      Math.floor(
        optionNumber(options, 'maxWindowChars', DEFAULTS.maxWindowChars),
      ),
    ),
    previewChars: Math.max(
      1,
      Math.floor(optionNumber(options, 'previewChars', DEFAULTS.previewChars)),
    ),
    model: optionString(options, 'model', DEFAULTS.model),
    goal: optionString(options, 'goal', ''),
  };
}

function hasMatchingToolResult(
  assistant: SessionMessage,
  user: SessionMessage,
): boolean {
  if (assistant.role !== 'assistant' || assistant.toolUses.length === 0) {
    return false;
  }
  const ids = new Set(assistant.toolUses.map((tool) => tool.tool_use_id));
  const resultIds = new Set(
    (user.toolResults ?? []).map((result) => result.tool_use_id),
  );
  return [...ids].every((id) => resultIds.has(id));
}

function toolPreview(tool: ToolUseSummary, limit: number): string {
  let input = '';
  try {
    input = JSON.stringify(tool.input);
  } catch {
    input = '[unserializable input]';
  }
  return `${tool.tool}: ${truncate(input, limit)}`;
}

function resultPreview(result: ToolResultSummary, limit: number): string {
  const status = result.isError ? 'error' : 'ok';
  return `${status} ${result.text.length} chars: ${truncate(result.text, limit)}`;
}

function unitPreview(messages: readonly SessionMessage[], limit: number): string {
  const roles = messages.map((message) => message.role).join('+');
  const tools = messages
    .flatMap((message) => message.toolUses)
    .map((tool) => toolPreview(tool, limit))
    .join('; ');
  const results = messages
    .flatMap((message) => message.toolResults ?? [])
    .map((result) => resultPreview(result, limit))
    .join('; ');
  const text = truncate(
    messages
      .map((message) => message.text)
      .filter(Boolean)
      .join('\n'),
    limit,
  );
  return `role=${roles}; tools=${tools || '(none)'}; results=${results || '(none)'}; text=${text}`;
}

export function groupMessages(
  messages: readonly SessionMessage[],
  options: Pick<ModConfig, 'preserveRecentMessages' | 'previewChars'> = {},
): CompactionUnit[] {
  const preserveRecentMessages = Math.max(
    0,
    Math.floor(
      options.preserveRecentMessages ?? DEFAULTS.preserveRecentMessages,
    ),
  );
  const previewChars = Math.max(
    1,
    Math.floor(options.previewChars ?? DEFAULTS.previewChars),
  );
  const recentStart = Math.max(0, messages.length - preserveRecentMessages);
  const units: CompactionUnit[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    const next = messages[index + 1];
    const paired =
      message.role === 'assistant' &&
      next?.role === 'user' &&
      hasMatchingToolResult(message, next);
    const grouped = paired ? [message, next] : [message];
    const end = index + grouped.length - 1;
    units.push({
      id: `unit-${index}`,
      messages: grouped,
      pinned: index === 0 || end >= recentStart,
      preview: unitPreview(grouped, previewChars),
    });
    index = end;
  }
  return units;
}

export function packWindows(
  units: readonly CompactionUnit[],
  maxWindowChars: number,
): CompactionUnit[][] {
  const windows: CompactionUnit[][] = [];
  let current: CompactionUnit[] = [];
  let currentChars = 0;
  for (const unit of units) {
    const size = unit.preview.length;
    if (current.length > 0 && currentChars + size > maxWindowChars) {
      windows.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(unit);
    currentChars += size;
  }
  if (current.length > 0) windows.push(current);
  return windows;
}

const UNANSWERED: UnitAnswer = { drop: 0, protect: 0 };

export function decideUnit(
  unit: Pick<CompactionUnit, 'id' | 'pinned'>,
  answer: UnitAnswer,
  config: Pick<ResolvedConfig, 'dropThreshold' | 'protectThreshold'>,
): UnitDecision {
  if (unit.pinned) {
    return { id: unit.id, ...UNANSWERED, action: 'keep', reason: 'pinned' };
  }
  const decision: UnitDecision = {
    id: unit.id,
    ...answer,
    action: 'keep',
    reason: 'below_threshold',
  };
  if (answer.protect >= config.protectThreshold) {
    decision.reason = 'protected';
  } else if (answer.drop >= config.dropThreshold) {
    decision.action = 'drop';
    decision.reason = 'dropped';
  }
  return decision;
}

function messageChars(message: SessionMessage): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    total += tool.tool.length;
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
    total += tool.text?.length ?? 0;
  }
  for (const result of message.toolResults ?? []) {
    total += result.text.length + result.tool_use_id.length;
  }
  return total;
}

function goalFromMessages(messages: readonly SessionMessage[]): string {
  return messages
    .filter(
      (message) =>
        message.role === 'user' &&
        message.text.trim().length > 0 &&
        (!message.toolResults || message.toolResults.length === 0),
    )
    .slice(-3)
    .map((message) => truncate(message.text, 500))
    .join('\n');
}

function questionsFor(units: readonly CompactionUnit[]): Record<string, unknown> {
  return Object.fromEntries(
    units.flatMap((unit) => [
      [
        `drop_${unit.id}`,
        {
          type: 'noul',
          instructions: `Unit ${unit.id} can be deleted without losing anything the assistant still needs`,
        },
      ],
      [
        `protect_${unit.id}`,
        {
          type: 'noul',
          instructions: `Unit ${unit.id} is where the user states a standing rule, constraint, or preference for the assistant to keep following, or names work that has still not been done`,
        },
      ],
    ]),
  );
}

function noul(answers: Record<string, JevAnswer>, name: string): number {
  const answer = answers[name];
  if (!answer || typeof answer.noul !== 'number') {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return answer.noul;
}

function answerFor(
  answers: Record<string, JevAnswer>,
  unit: CompactionUnit,
): UnitAnswer {
  return {
    drop: noul(answers, `drop_${unit.id}`),
    protect: noul(answers, `protect_${unit.id}`),
  };
}

async function askWindow(
  window: readonly CompactionUnit[],
  goal: string,
  config: ResolvedConfig,
  fetchFn: HookFetch,
): Promise<Map<string, UnitDecision>> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const response = await fetchFn(SYSTEM_ONE_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      state: {
        context: COMPACTION_CONTEXT,
        goal,
        window: window.map((unit) => ({
          id: unit.id,
          role: unit.messages.map((message) => message.role).join('+'),
          preview: unit.preview,
        })),
      },
      questions: questionsFor(window),
    }),
  });
  if (!response.ok) {
    throw new Error(`TypeSafe request failed with HTTP ${response.status}`);
  }
  const parsed = JSON.parse(response.text) as JevResponse;
  if (!parsed.answers) throw new Error('TypeSafe response has no answers');
  return new Map(
    window.map((unit) => {
      const answer = answerFor(parsed.answers as Record<string, JevAnswer>, unit);
      return [
        unit.id,
        decideUnit(unit, answer, config),
      ];
    }),
  );
}

export type CompactionOutput = {
  messages: SessionMessage[];
  decisions: UnitDecision[];
  charsBefore: number;
  charsAfter: number;
};

export async function compactWithFetch(
  messages: readonly SessionMessage[],
  options: ModConfig = {},
  fetchFn: HookFetch,
): Promise<CompactionOutput> {
  const config = resolveConfig(options);
  const units = groupMessages(messages, config);
  const candidates = units.filter((unit) => !unit.pinned);
  if (candidates.length === 0) {
    return {
      messages: [...messages],
      decisions: units.map((unit) => decideUnit(unit, UNANSWERED, config)),
      charsBefore: messages.reduce((sum, message) => sum + messageChars(message), 0),
      charsAfter: messages.reduce((sum, message) => sum + messageChars(message), 0),
    };
  }
  const windows = packWindows(candidates, config.maxWindowChars);
  const results = await Promise.all(
    windows.map((window) => askWindow(window, goalFromMessages(messages), config, fetchFn)),
  );
  const byId = new Map(results.flatMap((result) => [...result.entries()]));
  const decisions = units.map((unit) => {
    const decision = byId.get(unit.id);
    return decision ?? decideUnit(unit, UNANSWERED, config);
  });
  const dropped = new Set(
    decisions
      .filter((decision) => decision.action === 'drop')
      .map((decision) => decision.id),
  );
  const keptUnits = units.filter((unit) => !dropped.has(unit.id));
  const kept = keptUnits.flatMap((unit) => unit.messages);
  return {
    messages: kept,
    decisions,
    charsBefore: messages.reduce((sum, message) => sum + messageChars(message), 0),
    charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
  };
}

export function reductionRatio(result: CompactionOutput): number {
  return result.charsBefore === 0
    ? 0
    : (result.charsBefore - result.charsAfter) / result.charsBefore;
}

export async function compactOrFallback(
  messages: readonly SessionMessage[],
  options: ModConfig = {},
  fetchFn: HookFetch,
): Promise<CompactionOutput | null> {
  const result = await compactWithFetch(messages, options, fetchFn);
  return reductionRatio(result) <
    (options.minReductionRatio ?? DEFAULTS.minReductionRatio)
    ? null
    : result;
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function summarize(result: CompactionOutput): string {
  const counts = new Map<UnitDecision['reason'], number>();
  for (const decision of result.decisions) {
    counts.set(decision.reason, (counts.get(decision.reason) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([reason, count]) => `${count} ${reason}`);
  return `${percent(reductionRatio(result))} reduction; ${parts.join(', ')}`;
}

function optionConfig(options: PluginOptions): ModConfig {
  return {
    apiKey: typeof options.apiKey === 'string' && options.apiKey.length > 0 ? options.apiKey : undefined,
    dropThreshold: optionNumber(options, 'dropThreshold', DEFAULTS.dropThreshold),
    protectThreshold: optionNumber(
      options,
      'protectThreshold',
      DEFAULTS.protectThreshold,
    ),
    preserveRecentMessages: optionNumber(
      options,
      'preserveRecentMessages',
      DEFAULTS.preserveRecentMessages,
    ),
    compactAtPercent: optionNumber(
      options,
      'compactAtPercent',
      DEFAULTS.compactAtPercent,
    ),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      DEFAULTS.minReductionRatio,
    ),
    maxWindowChars: optionNumber(
      options,
      'maxWindowChars',
      DEFAULTS.maxWindowChars,
    ),
    previewChars: optionNumber(options, 'previewChars', DEFAULTS.previewChars),
    model: optionString(options, 'model', DEFAULTS.model),
  };
}

async function getApiKey(
  $: { env: { get: (name: string) => Promise<string | undefined> } },
  config: ModConfig,
): Promise<string | undefined> {
  return config.apiKey || (await $.env.get('TYPESAFE_API_KEY'));
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = optionConfig(options);
  let compacting = false;

  on('session.compact', async ($, event, next) => {
    try {
      const apiKey = await getApiKey($, configured);
      const result = await compactWithFetch(
        event.messages,
        { ...configured, apiKey },
        async (url, init) => {
          const response = await $.http.fetch(url, init);
          return {
            status: response.status,
            ok: response.ok,
            text: response.text,
          };
        },
      );
      const minReduction =
        configured.minReductionRatio ?? DEFAULTS.minReductionRatio;
      if (reductionRatio(result) < minReduction) {
        $.ui.log(
          `fallback (below ${percent(minReduction)} minimum: ${summarize(result)})`,
        );
        return next(event);
      }
      $.ui.log(`kept ${result.messages.length}/${event.messages.length} messages (${summarize(result)})`);
      return { messages: result.messages };
    } catch (error) {
      $.ui.log(
        `fallback (${error instanceof Error ? error.message : String(error)})`,
      );
      return next(event);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < (configured.compactAtPercent ?? DEFAULTS.compactAtPercent)) {
        return next(event);
      }
      compacting = true;
      await $.session.compact();
      return next(event);
    } finally {
      compacting = false;
    }
  });
};
