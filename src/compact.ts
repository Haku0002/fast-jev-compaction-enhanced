import { choiceAnswer, noulAnswer } from './request.js';
import {
  collectToolCalls,
  estimateTokens,
  isPinned,
  isTombstone,
  planRequests,
  pruneMachineBlocks,
} from './state.js';
import type {
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactResult,
  JevAsker,
  JevQuestions,
  Message,
  PlannedRequest,
  ResolvedCompactOptions,
  ToolCall,
  ToolResult,
  ToolUse,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  keepThreshold: 0.5,
  keepCallThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
  dropCalls: 'stub',
  stubChars: 120,
  pruneMachineText: true,
  concurrency: 4,
  arbitrateBand: 0.15,
  primitive: 'noul',
};

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function whole(value: number | undefined, fallback: number, min: number): number {
  return Math.max(min, Math.floor(finite(value, fallback)));
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold: finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    keepCallThreshold: finite(options.keepCallThreshold, DEFAULT_OPTIONS.keepCallThreshold),
    preserveRecentMessages: whole(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages, 0),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(1, finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens)),
    truncateHeadChars: whole(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars, 0),
    dropCalls: options.dropCalls === 'delete' ? 'delete' : DEFAULT_OPTIONS.dropCalls,
    stubChars: whole(options.stubChars, DEFAULT_OPTIONS.stubChars, 0),
    pruneMachineText:
      typeof options.pruneMachineText === 'boolean'
        ? options.pruneMachineText
        : DEFAULT_OPTIONS.pruneMachineText,
    concurrency: whole(options.concurrency, DEFAULT_OPTIONS.concurrency, 1),
    arbitrateBand: Math.max(0, finite(options.arbitrateBand, DEFAULT_OPTIONS.arbitrateBand)),
    primitive: options.primitive === 'choice' ? 'choice' : DEFAULT_OPTIONS.primitive,
  };
}

/** Whether the result question is worth asking: truncation would change it and it is real output. */
export function askResult(
  call: Pick<ToolCall, 'resultChars' | 'tombstone'>,
  options: Pick<ResolvedCompactOptions, 'truncateHeadChars'>,
): boolean {
  return !call.tombstone && call.resultChars > options.truncateHeadChars + 120;
}

/**
 * The `choice` question asked about one call: one question whose options are
 * the actions themselves, so the judge compares them instead of estimating
 * two truths. The criteria carry the same wording the `noul` questions were
 * calibrated on. A call whose result is too short to be worth asking about
 * gets the two-option form.
 */
export function choiceQuestionFor(
  call: Pick<ToolCall, 'id' | 'tool' | 'resultChars' | 'tombstone'>,
  options: Pick<ResolvedCompactOptions, 'truncateHeadChars'>,
): JevQuestions {
  const stub = `Neither the call nor its output is still needed: routine exploration, or superseded by later work`;
  if (!askResult(call, options)) {
    return {
      [`call_${call.id}`]: {
        type: 'choice',
        instructions: `How much of tool call ${call.id} (${call.tool}) the current task still needs`,
        criteria: {
          keep: `The call still matters: a file or command the assistant is working with, a decision, a constraint, or an edit that was made`,
          stub,
        },
      },
    };
  }
  return {
    [`call_${call.id}`]: {
      type: 'choice',
      instructions: `How much of tool call ${call.id} (${call.tool}, ${call.resultChars} chars of output) the current task still needs`,
      criteria: {
        keep_result: `The full output is still needed to continue the current task correctly (an error message, a value, file contents being edited, a constraint), beyond what re-running the tool would give`,
        keep: `The call itself carries information the task still depends on (the file or command it names, the decision or the edit it made), but its full output is not needed again`,
        stub,
      },
    },
  };
}

/**
 * The `noul` questions asked about one call: keep the call; keep its full
 * result, when that is a choice. Each spells its criterion out, although the
 * state's context states it too: measured on a real transcript
 * (`npm run calibrate`), a one-line question that leaned on the context
 * alone pulled every probability down by about 0.3 and flipped two thirds
 * of the decisions, so the longer wording is the calibrated one.
 */
export function questionsFor(
  call: Pick<ToolCall, 'id' | 'tool' | 'resultChars' | 'tombstone'>,
  options: Pick<ResolvedCompactOptions, 'truncateHeadChars' | 'primitive'>,
): JevQuestions {
  if (options.primitive === 'choice') return choiceQuestionFor(call, options);
  const questions: JevQuestions = {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) carries information the current task still depends on: a file or command the assistant is working with, a decision, a constraint, or an edit that was made`,
    },
  };
  if (askResult(call, options)) {
    questions[`result_${call.id}`] = {
      type: 'noul',
      instructions: `The output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) holds information the assistant would need again to continue the current task correctly (an error message, a value, file contents it is editing, a constraint), beyond what re-running the tool would give`,
    };
  }
  return questions;
}

export function questionTokens(
  call: Pick<ToolCall, 'id' | 'tool' | 'resultChars' | 'tombstone'>,
  options: Pick<ResolvedCompactOptions, 'truncateHeadChars' | 'primitive'>,
): number {
  return estimateTokens(JSON.stringify(questionsFor(call, options)));
}

export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned' | 'resultChars' | 'tombstone'>,
  answer: CallAnswer,
  options: Pick<
    ResolvedCompactOptions,
    'keepThreshold' | 'keepCallThreshold' | 'dropCalls' | 'truncateHeadChars'
  >,
): CallDecision {
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  const asked = askResult(call, options);
  if (asked && answer.keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= options.keepCallThreshold) {
    // A result too short to cut is kept as it is; `drop_result` then only bounds the input.
    return { ...base, action: 'drop_result', reason: asked ? 'result_dropped' : 'kept' };
  }
  return options.dropCalls === 'delete'
    ? { ...base, action: 'drop_call', reason: 'call_dropped' }
    : { ...base, action: 'stub_call', reason: 'call_stubbed' };
}

/**
 * Asks one request and maps the answers back to its calls. A call the judge
 * left unanswered (either of its questions) is absent from the map, and so
 * stays unscored; a reply that answers none of the questions is an error.
 */
async function askRequest(
  asker: JevAsker,
  request: PlannedRequest,
  options: Pick<ResolvedCompactOptions, 'truncateHeadChars' | 'primitive'>,
): Promise<Map<string, CallAnswer>> {
  const questions: JevQuestions = Object.assign(
    {},
    ...request.calls.map((call) => questionsFor(call, options)),
  );
  const { answers } = await asker.ask(request.state, questions, request.calls);
  const scored = new Map<string, CallAnswer>();
  for (const call of request.calls) {
    if (options.primitive === 'choice') {
      const answer = choiceAnswer(answers, `call_${call.id}`);
      if (answer) scored.set(call.id, answer);
      continue;
    }
    const keepCall = noulAnswer(answers, `call_${call.id}`);
    if (keepCall === undefined) continue;
    if (!askResult(call, options)) {
      scored.set(call.id, { keepCall, keepResult: 0 });
      continue;
    }
    const keepResult = noulAnswer(answers, `result_${call.id}`);
    if (keepResult === undefined) continue;
    scored.set(call.id, { keepCall, keepResult });
  }
  if (scored.size === 0 && request.calls.length > 0) {
    throw new Error(`Invalid Jev answers: none of ${Object.keys(questions).length} questions answered`);
  }
  return scored;
}

/** Whether an answer sits close enough to a threshold to be worth a second opinion. */
export function isBorderline(
  call: Pick<ToolCall, 'resultChars' | 'tombstone'>,
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, 'keepThreshold' | 'keepCallThreshold' | 'truncateHeadChars' | 'arbitrateBand'>,
): boolean {
  if (options.arbitrateBand <= 0) return false;
  if (Math.abs(answer.keepCall - options.keepCallThreshold) < options.arbitrateBand) return true;
  return askResult(call, options) && Math.abs(answer.keepResult - options.keepThreshold) < options.arbitrateBand;
}

/**
 * Puts the borderline calls of each request to the arbiter, with the same
 * state the judge saw, and returns the arbiter's answers by call id. A call
 * the arbiter leaves unanswered keeps the judge's answer. Requests without a
 * borderline call cost nothing.
 */
async function arbitrate(
  arbiter: JevAsker,
  requests: readonly PlannedRequest[],
  answers: ReadonlyMap<string, CallAnswer>,
  options: ResolvedCompactOptions,
): Promise<Map<string, CallAnswer>> {
  const overrides = new Map<string, CallAnswer>();
  const work = requests
    .map((request) => ({
      state: request.state,
      calls: request.calls.filter((call) => {
        const answer = answers.get(call.id);
        return answer !== undefined && isBorderline(call, answer, options);
      }),
    }))
    .filter((request) => request.calls.length > 0);
  const answered = await runLimited(work, options.concurrency, (request) =>
    askRequest(arbiter, { state: request.state, calls: request.calls, tokens: 0 }, options),
  );
  for (const map of answered) for (const [id, answer] of map) overrides.set(id, answer);
  return overrides;
}

/**
 * Runs `fn` over `items` with at most `limit` in flight; rejects on the first
 * failure, and the other workers stop taking new items once one has failed.
 */
async function runLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index]!);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** How `keepChars` of a cut result are split: two thirds head, one third tail (where a command's verdict is). */
export function headTail(keepChars: number): { head: number; tail: number } {
  const tail = Math.floor(keepChars / 3);
  return { head: keepChars - tail, tail };
}

/**
 * A dropped result as the history keeps it: its head, its tail and a note,
 * the note last so a later round recognises it (`isTombstone`).
 */
function truncatedResultText(text: string, isError: boolean, keepChars: number): string {
  if (text.length <= keepChars + 120) return text;
  const { head, tail } = headTail(keepChars);
  const omitted = text.length - head - tail;
  const kept = keepChars > 0 ? `${text.slice(0, head)}\n[…]\n${tail > 0 ? `${text.slice(-tail)}\n` : ''}` : '';
  return `${kept}[fast-jev-compaction truncated ${omitted} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
}

function stubResultText(text: string, isError: boolean): string {
  if (isTombstone(text)) return text;
  return `[fast-jev-compaction dropped the ${text.length}-char result${
    isError ? ' (error)' : ''
  } of this call; re-run the tool if needed]`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserializable]';
  }
}

/**
 * Cuts each oversized field of a kept call's input (a Write's content, an
 * Edit's strings, a heredoc) to a head and a note; the same object comes
 * back when every field is short.
 */
export function abridgeInput(
  input: Record<string, unknown>,
  headChars: number,
): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const text = typeof value === 'string' ? value : value !== null && typeof value === 'object' ? safeJson(value) : null;
    if (text !== null && text.length > headChars + 120) {
      out[key] = `${text.slice(0, headChars)}\n[fast-jev-compaction omitted ${text.length - headChars} chars of this field]`;
      changed = true;
    } else out[key] = value;
  }
  return changed ? out : input;
}

/** The input of a stub: every field, in order, cut to `chars` characters in all. */
export function stubInput(input: Record<string, unknown>, chars: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let budget = chars;
  let changed = false;
  for (const [key, value] of Object.entries(input)) {
    const text = typeof value === 'string' ? value : safeJson(value);
    if (text.length <= budget) {
      out[key] = value;
      budget -= text.length;
      continue;
    }
    out[key] = budget > 0 ? `${text.slice(0, budget)}…` : '…';
    changed = true;
    budget = 0;
  }
  if (changed) out.note = '[fast-jev-compaction abridged this input]';
  return changed ? out : input;
}

function briefInput(input: Record<string, unknown>): string {
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.replace(/\s+/g, ' ').slice(0, 60);
    }
  }
  return '';
}

/** The note a `delete` compaction leaves on a turn whose calls were removed. */
export function removedMarker(dropped: readonly Pick<ToolUse, 'tool' | 'input'>[]): string {
  const list = dropped.map((tool) => `${tool.tool}(${briefInput(tool.input)})`).join(', ');
  return `[fast-jev-compaction removed ${dropped.length} tool call(s) from this turn: ${list}; this text is the assistant's report, not the tool record — re-verify with a tool before relying on it]`;
}

export interface Applied {
  messages: Message[];
  machineBlocksPruned: number;
}

/**
 * Rebuilds the conversation from the decisions. A dropped result keeps a
 * bounded head, tail and note and its input's oversized fields are cut; a
 * stub keeps the tool name with a short input and a note for the result; a
 * deleted call disappears with its result and marks the turn's narration.
 * Old user messages lose the bulk of their host blocks. Messages that lose
 * all their content are removed; untouched messages are returned as the
 * same objects they came in as.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  options: Pick<
    ResolvedCompactOptions,
    'truncateHeadChars' | 'stubChars' | 'pruneMachineText' | 'preserveRecentMessages'
  >,
): Applied {
  const headChars = options.truncateHeadChars;
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  const kept: Message[] = [];
  let machineBlocksPruned = 0;
  messages.forEach((message, index) => {
    let text = message.text;
    if (
      options.pruneMachineText &&
      message.role === 'user' &&
      !isPinned(index, messages.length, options.preserveRecentMessages)
    ) {
      const pruned = pruneMachineBlocks(text, headChars);
      if (pruned !== text) {
        machineBlocksPruned += 1;
        text = pruned;
      }
    }
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched && text === message.text) {
      kept.push(message);
      return;
    }
    const dropped: ToolUse[] = [];
    const toolUses = message.toolUses.flatMap((tool): ToolUse[] => {
      const action = actions.get(tool.tool_use_id);
      if (!action) return [tool];
      if (action === 'drop_call') {
        dropped.push(tool);
        return [];
      }
      const isError = tool.isError ?? false;
      const original = tool.text ?? '';
      const input =
        action === 'stub_call' ? stubInput(tool.input, options.stubChars) : abridgeInput(tool.input, headChars);
      const resultText =
        action === 'stub_call' ? stubResultText(original, isError) : truncatedResultText(original, isError, headChars);
      if (input === tool.input && resultText === original) return [tool];
      const copy: ToolUse = { tool_use_id: tool.tool_use_id, tool: tool.tool, input, text: resultText };
      if (tool.isError) copy.isError = true;
      return [copy];
    });
    const toolResults = (message.toolResults ?? []).flatMap((result): ToolResult[] => {
      const action = actions.get(result.tool_use_id);
      if (!action) return [result];
      if (action === 'drop_call') return [];
      const isError = result.isError ?? false;
      const resultText =
        action === 'stub_call' ? stubResultText(result.text, isError) : truncatedResultText(result.text, isError, headChars);
      if (resultText === result.text) return [result];
      return [{ tool_use_id: result.tool_use_id, text: resultText, isError: result.isError }];
    });
    if (dropped.length > 0 && text.trim().length > 0) text = `${text}\n${removedMarker(dropped)}`;
    if (text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) return;
    const unchanged =
      text === message.text &&
      toolUses.length === message.toolUses.length &&
      toolUses.every((tool, i) => tool === message.toolUses[i]) &&
      toolResults.length === (message.toolResults ?? []).length &&
      toolResults.every((result, i) => result === message.toolResults?.[i]);
    if (unchanged) {
      kept.push(message);
      return;
    }
    const rebuilt: Message = { role: message.role, text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  });
  return { messages: kept, machineBlocksPruned };
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) total += safeJson(tool.input).length;
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

/** Characters a compaction could remove at most: candidate inputs and results, and old host blocks. */
export function prunableChars(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  options: Pick<ResolvedCompactOptions, 'truncateHeadChars' | 'pruneMachineText' | 'preserveRecentMessages'>,
): number {
  let total = 0;
  for (const call of calls) if (!call.pinned) total += call.inputChars + call.resultChars;
  if (options.pruneMachineText) {
    messages.forEach((message, index) => {
      if (message.role !== 'user' || isPinned(index, messages.length, options.preserveRecentMessages)) return;
      total += message.text.length - pruneMachineBlocks(message.text, options.truncateHeadChars).length;
    });
  }
  return total;
}

/** The share of the history a compaction could remove at most, 0 to 1; no request is made. */
export function prunableShare(messages: readonly Message[], options: CompactOptions = {}): number {
  const resolved = resolveOptions(options);
  const before = messages.reduce((sum, message) => sum + messageChars(message), 0);
  if (before === 0) return 0;
  return prunableChars(messages, collectToolCalls(messages, resolved.preserveRecentMessages), resolved) / before;
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/**
 * Compacts a transcript by asking Jev, for every tool call outside the pinned
 * first and newest messages, whether the call and whether its full result
 * are still useful. The candidates are scored in windows, each request
 * showing its window in full (see `planRequests`). Throws when Jev fails;
 * the caller decides whether to fall back.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);

  let requests: PlannedRequest[] = [];
  const answers = new Map<string, CallAnswer>();
  if (candidates.length > 0) {
    const plan = planRequests(messages, calls, candidates, {
      ...resolved,
      questionTokens: (call) => questionTokens(call, resolved),
    });
    requests = plan.requests;
    const answered = await runLimited(requests, resolved.concurrency, (request) =>
      askRequest(asker, request, resolved),
    );
    for (const map of answered) for (const [id, answer] of map) answers.set(id, answer);
  }

  const overrides =
    options.arbiter && answers.size > 0 ? await arbitrate(options.arbiter, requests, answers, resolved) : new Map<string, CallAnswer>();
  let arbiterFlips = 0;

  const decisions = calls.map((call): CallDecision => {
    const about = { resultAsked: askResult(call, resolved), resultChars: call.resultChars, about: briefInput(call.input) };
    if (call.pinned) return { ...decideCall(call, { keepCall: 1, keepResult: 1 }, resolved), ...about };
    const answer = answers.get(call.id);
    if (!answer) {
      return { id: call.id, tool: call.tool, keepCall: 1, keepResult: 1, action: 'keep', reason: 'unscored', ...about };
    }
    const override = overrides.get(call.id);
    if (!override) return { ...decideCall(call, answer, resolved), ...about };
    const judged = decideCall(call, answer, resolved);
    const decision = { ...decideCall(call, override, resolved), ...about, judged: answer };
    if (decision.action !== judged.action) arbiterFlips += 1;
    return decision;
  });
  const applied = applyDecisions(messages, decisions, calls, resolved);
  return {
    messages: applied.messages,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: applied.messages.length,
      charsBefore,
      charsAfter: applied.messages.reduce((sum, message) => sum + messageChars(message), 0),
      prunableChars: prunableChars(messages, calls, resolved),
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: count(decisions, 'result_dropped'),
      callsStubbed: count(decisions, 'call_stubbed'),
      callsDropped: count(decisions, 'call_dropped'),
      pinned: count(decisions, 'pinned'),
      unscored: count(decisions, 'unscored'),
      machineBlocksPruned: applied.machineBlocksPruned,
      stateTokens: requests.reduce((max, request) => Math.max(max, request.tokens), 0),
      requests: requests.length,
      arbitrated: overrides.size,
      arbiterFlips,
      ms: Date.now() - started,
    },
  };
}
