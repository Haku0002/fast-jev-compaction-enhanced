import { compact } from './compact.js';
import type {
  CallDecision,
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  MessageAuthor,
  ToolResult,
  ToolUse,
} from './types.js';

/**
 * Transcript adapters for the history formats agents and providers keep, so
 * one compaction core serves all of them. Each adapter reads a native
 * history into the core's `Message[]` with a back-reference per tool call and
 * result, and writes the decisions back onto the native items: anything a
 * decision does not touch stays the same object (ids, signatures, reasoning,
 * provider metadata and unknown fields included), and only the text of a
 * tool result (and, where the format allows it, a call's input) changes.
 *
 * Formats:
 * - `anthropic`: Messages API `{ role, content: string | blocks }` (also the
 *   `{ messages, system }` request body and Claude Code `.jsonl` lines).
 * - `openai-chat`: Chat Completions `{ role, content, tool_calls }` with
 *   `role: 'tool'` results, and legacy `function_call` / `role: 'function'`.
 *   This is what DeepSeek, Qwen, Kimi, GLM, Mistral, Groq, OpenRouter,
 *   vLLM, Ollama and LM Studio speak.
 * - `gemini`: `{ role: 'user' | 'model', parts }` with `functionCall` and
 *   `functionResponse` parts (also `{ contents }`).
 * - `responses`: OpenAI Responses / Codex input items; see `responses.ts`.
 * - `ai-sdk`: Vercel AI SDK style `{ role, content: [...] }` with
 *   `tool-call` blocks and `role: 'tool'` results (also `tool-result`
 *   parts); several agent harnesses keep their messages in this shape.
 * - `messages`: the core's own `Message[]`, passed through.
 *
 * Host-specific stores (an event log, a database) belong in a bridge package
 * that reads them into one of these shapes; this module stays host-neutral.
 */
export type TranscriptFormat = 'anthropic' | 'openai-chat' | 'gemini' | 'responses' | 'ai-sdk' | 'messages';

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A tool input as an object: parsed JSON arguments, or the raw value under `input`. */
export function toolInput(value: unknown): { input: Record<string, unknown>; raw: 'object' | 'json' | 'text' } {
  if (isObj(value)) return { input: value, raw: 'object' };
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return { input: {}, raw: 'json' };
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isObj(parsed)) return { input: parsed, raw: 'json' };
    } catch {
      // not JSON: a free-form or custom-tool input
    }
    return { input: { input: value }, raw: 'text' };
  }
  return { input: value === undefined || value === null ? {} : { input: value }, raw: 'object' };
}

/** Joins the text of mixed content: a string, or blocks/parts with `text`. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return isObj(content) && typeof content.text === 'string' ? content.text : '';
  return content
    .flatMap((block) => {
      if (typeof block === 'string') return [block];
      if (!isObj(block)) return [];
      if (typeof block.text === 'string' && TEXT_TYPES.has(String(block.type ?? 'text'))) return [block.text];
      return [];
    })
    .join('\n');
}

const TEXT_TYPES = new Set(['text', 'input_text', 'output_text']);

/**
 * Whether a tool output holds only text, so cutting it loses nothing the
 * judge did not see: a string, or blocks that are all plain text.
 */
function textOnly(content: unknown): boolean {
  if (typeof content === 'string') return true;
  if (!Array.isArray(content)) return false;
  return content.every((block) => typeof block === 'string' || (isObj(block) && TEXT_TYPES.has(String(block.type)) && typeof block.text === 'string'));
}

/** Rewrites a tool output to `text`, in the shape it came in: a string, or one text block of its own type. */
function rewriteOutput(content: unknown, text: string): unknown {
  if (typeof content === 'string') return text;
  if (Array.isArray(content)) {
    const first = content.find((block) => isObj(block) && TEXT_TYPES.has(String(block.type)));
    const type = isObj(first) ? String(first.type) : 'text';
    return [{ type, text }];
  }
  return text;
}

/** A reference from a core message back to where its parts live in the native history. */
export interface Ref {
  /** Index of the native item. */
  item: number;
}

/** Where each tool call and result of the core transcript lives natively. */
export interface ToolRefs {
  calls: Map<string, { item: number; block: number; raw: 'object' | 'json' | 'text' }>;
  results: Map<string, { item: number; block: number }>;
}

export interface Parsed {
  format: TranscriptFormat;
  messages: Message[];
  /** For each core message, the native item it came from. */
  refs: Ref[];
  tools: ToolRefs;
  /** Native items with no core message (system prompts, reasoning-only items); kept as they are. */
  skipped: number;
}

/* ------------------------------------------------------------------ detect */

/** Unwraps the common request/response envelopes around a history. */
export function historyOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isObj(value)) throw new Error('A transcript must be an array of messages or an object holding one');
  for (const key of ['messages', 'contents', 'input', 'history', 'items', 'conversation']) {
    if (Array.isArray(value[key])) return value[key] as unknown[];
  }
  throw new Error('No message list found (looked for messages, contents, input, history, items)');
}

/** Guesses the format of a history from the shape of its items. */
export function detectFormat(history: readonly unknown[]): TranscriptFormat {
  let anthropic = 0, chat = 0, gemini = 0, responses = 0, aiSdk = 0, core = 0;
  for (const item of history) {
    if (!isObj(item)) continue;
    if (Array.isArray(item.parts) || item.role === 'model') gemini += 2;
    if (typeof item.type === 'string' && /(^message$|_call$|_call_output$|^reasoning$|^compaction)/.test(item.type) && !('role' in item && Array.isArray(item.toolUses))) responses += 2;
    if (Array.isArray(item.toolUses)) core += 3;
    if (Array.isArray(item.tool_calls) || item.role === 'tool' && typeof item.tool_call_id === 'string' || isObj(item.function_call) || item.role === 'function') chat += 3;
    if (item.role === 'tool' && typeof item.toolCallId === 'string') aiSdk += 3;
    if (Array.isArray(item.content)) {
      for (const block of item.content) {
        if (!isObj(block)) continue;
        if (block.type === 'tool_use' || block.type === 'tool_result' || block.type === 'thinking' || block.type === 'redacted_thinking') anthropic += 2;
        if (block.type === 'tool-call' || block.type === 'tool-result' || block.type === 'reasoning') aiSdk += 2;
        if (block.type === 'input_text' || block.type === 'output_text') responses += 1;
        if (block.type === 'image_url') chat += 1;
      }
    }
    // A Claude Code transcript line wraps the API message.
    if (isObj(item.message) && (item.type === 'user' || item.type === 'assistant')) anthropic += 3;
  }
  const scores: [TranscriptFormat, number][] = [
    ['messages', core],
    ['ai-sdk', aiSdk],
    ['anthropic', anthropic],
    ['openai-chat', chat],
    ['gemini', gemini],
    ['responses', responses],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  if (scores[0]![1] === 0) return history.some((item) => isObj(item) && typeof item.type === 'string') ? 'responses' : 'openai-chat';
  return scores[0]![0];
}

/* ------------------------------------------------------------ host text */

/**
 * Who wrote a user-side message, for a format whose messages carry a
 * `source.kind` (or `author`) tag: `user` is the person; kinds a caller lists
 * as transient are host snapshots a later one supersedes; any other kind is
 * host text still needed. Untagged messages stay `undefined` (unknown).
 */
export function authorOfSource(
  sourceKind: string | undefined,
  transientKinds: ReadonlySet<string> = DEFAULT_TRANSIENT_KINDS,
): MessageAuthor | undefined {
  if (sourceKind === undefined) return undefined;
  if (sourceKind === 'user' || sourceKind === 'person' || sourceKind === 'human') return 'person';
  if (transientKinds.has(sourceKind)) return 'transient';
  return 'host';
}

/** Snapshot-style host kinds common across harnesses; a bridge passes its own set. */
export const DEFAULT_TRANSIENT_KINDS: ReadonlySet<string> = new Set([
  'runtime-context',
  'time-context',
  'tool-jobs',
  'user-approval',
  'subagent-settled',
  'environment',
  'notification',
]);

/* --------------------------------------------------------------- readers */

function core(role: 'user' | 'assistant', text: string): Message {
  return { role, text, toolUses: [] };
}

function readAnthropic(history: readonly unknown[]): Parsed {
  const messages: Message[] = [];
  const refs: Ref[] = [];
  const tools: ToolRefs = { calls: new Map(), results: new Map() };
  let skipped = 0;
  history.forEach((raw, item) => {
    // Claude Code `.jsonl` lines wrap the API message; sidechains are not this conversation.
    const entry = isObj(raw) && isObj(raw.message) && (raw.type === 'user' || raw.type === 'assistant') ? raw.message : raw;
    if (!isObj(entry) || (isObj(raw) && raw.isSidechain === true)) { skipped += 1; return; }
    const role = entry.role === 'assistant' ? 'assistant' : entry.role === 'user' ? 'user' : undefined;
    if (!role) { skipped += 1; return; }
    const message = core(role, '');
    const texts: string[] = [];
    const blocks: unknown[] = typeof entry.content === 'string' ? [{ type: 'text', text: entry.content }] : Array.isArray(entry.content) ? entry.content : [];
    blocks.forEach((block, index) => {
      if (!isObj(block)) return;
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      else if ((block.type === 'tool_use' || block.type === 'server_tool_use') && typeof block.id === 'string' && role === 'assistant') {
        const { input, raw: shape } = toolInput(block.input);
        message.toolUses.push({ tool_use_id: block.id, tool: String(block.name ?? ''), input });
        tools.calls.set(block.id, { item, block: index, raw: shape });
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const result: ToolResult = { tool_use_id: block.tool_use_id, text: contentText(block.content), isError: block.is_error === true };
        if (!textOnly(block.content ?? '')) result.pinned = true;
        (message.toolResults ??= []).push(result);
        tools.results.set(block.tool_use_id, { item, block: index });
      }
    });
    message.text = texts.join('\n');
    if (message.text === '' && message.toolUses.length === 0 && !message.toolResults) { skipped += 1; return; }
    messages.push(message);
    refs.push({ item });
  });
  return { format: 'anthropic', messages, refs, tools, skipped };
}

function readOpenAIChat(history: readonly unknown[]): Parsed {
  const messages: Message[] = [];
  const refs: Ref[] = [];
  const tools: ToolRefs = { calls: new Map(), results: new Map() };
  let skipped = 0;
  // Legacy `function_call` has no id: pair each with the next `role: 'function'` reply.
  const pendingLegacy: string[] = [];
  history.forEach((raw, item) => {
    if (!isObj(raw)) { skipped += 1; return; }
    const role = raw.role;
    if (role === 'assistant') {
      const message = core('assistant', contentText(raw.content));
      if (Array.isArray(raw.tool_calls)) {
        raw.tool_calls.forEach((call, index) => {
          if (!isObj(call) || typeof call.id !== 'string') return;
          const fn = isObj(call.function) ? call.function : isObj(call.custom) ? call.custom : {};
          const { input, raw: shape } = toolInput(fn.arguments ?? fn.input);
          message.toolUses.push({ tool_use_id: call.id, tool: String(fn.name ?? call.type ?? ''), input });
          tools.calls.set(call.id, { item, block: index, raw: shape });
        });
      } else if (isObj(raw.function_call)) {
        const id = `legacy_fn_${item}`;
        const { input, raw: shape } = toolInput(raw.function_call.arguments);
        message.toolUses.push({ tool_use_id: id, tool: String(raw.function_call.name ?? ''), input });
        tools.calls.set(id, { item, block: -1, raw: shape });
        pendingLegacy.push(id);
      }
      messages.push(message);
      refs.push({ item });
      return;
    }
    if (role === 'tool' || role === 'function') {
      const id = role === 'tool' && typeof raw.tool_call_id === 'string' ? raw.tool_call_id : pendingLegacy.shift();
      if (id === undefined) { skipped += 1; return; }
      const result: ToolResult = { tool_use_id: id, text: contentText(raw.content), isError: raw.is_error === true };
      if (!textOnly(raw.content ?? '')) result.pinned = true;
      const message = core('user', '');
      message.toolResults = [result];
      tools.results.set(id, { item, block: -1 });
      messages.push(message);
      refs.push({ item });
      return;
    }
    if (role === 'user') {
      messages.push(core('user', contentText(raw.content)));
      refs.push({ item });
      return;
    }
    // system / developer: the frame of every request, never a candidate.
    skipped += 1;
  });
  return { format: 'openai-chat', messages, refs, tools, skipped };
}

function readGemini(history: readonly unknown[]): Parsed {
  const messages: Message[] = [];
  const refs: Ref[] = [];
  const tools: ToolRefs = { calls: new Map(), results: new Map() };
  let skipped = 0;
  // Gemini 1.x calls carry no id: pair by name, in order.
  const pendingByName = new Map<string, string[]>();
  history.forEach((raw, item) => {
    if (!isObj(raw) || !Array.isArray(raw.parts)) { skipped += 1; return; }
    const role = raw.role === 'model' ? 'assistant' : 'user';
    const message = core(role, '');
    const texts: string[] = [];
    raw.parts.forEach((part, index) => {
      if (!isObj(part)) return;
      if (typeof part.text === 'string' && part.thought !== true) texts.push(part.text);
      const call = isObj(part.functionCall) ? part.functionCall : isObj(part.function_call) ? part.function_call : undefined;
      const response = isObj(part.functionResponse) ? part.functionResponse : isObj(part.function_response) ? part.function_response : undefined;
      if (call) {
        const name = String(call.name ?? '');
        const id = typeof call.id === 'string' && call.id ? call.id : `gemini_${item}_${index}`;
        const use: ToolUse = { tool_use_id: id, tool: name, input: toolInput(call.args).input };
        // Gemini 2.5+/3 signs a call part; the signature must come back with the call as it was.
        if (part.thoughtSignature !== undefined || part.thought_signature !== undefined) use.lockedInput = true;
        message.toolUses.push(use);
        tools.calls.set(id, { item, block: index, raw: 'object' });
        const queue = pendingByName.get(name) ?? [];
        queue.push(id);
        pendingByName.set(name, queue);
      }
      if (response) {
        const name = String(response.name ?? '');
        const queue = pendingByName.get(name) ?? [];
        const id = typeof response.id === 'string' && response.id ? response.id : queue[0];
        if (id === undefined) return;
        const at = queue.indexOf(id);
        if (at >= 0) queue.splice(at, 1);
        const body = response.response;
        const text = typeof body === 'string' ? body : JSON.stringify(body ?? null);
        const result: ToolResult = { tool_use_id: id, text, isError: isObj(body) && 'error' in body && !('output' in body) && !('result' in body) };
        if (Array.isArray(response.parts) && response.parts.length > 0) result.pinned = true;
        (message.toolResults ??= []).push(result);
        tools.results.set(id, { item, block: index });
      }
    });
    message.text = texts.join('\n');
    if (message.text === '' && message.toolUses.length === 0 && !message.toolResults) { skipped += 1; return; }
    messages.push(message);
    refs.push({ item });
  });
  return { format: 'gemini', messages, refs, tools, skipped };
}

function readAiSdk(history: readonly unknown[]): Parsed {
  const messages: Message[] = [];
  const refs: Ref[] = [];
  const tools: ToolRefs = { calls: new Map(), results: new Map() };
  let skipped = 0;
  history.forEach((raw, item) => {
    if (!isObj(raw)) { skipped += 1; return; }
    const role = raw.role;
    const content = typeof raw.content === 'string' ? [{ type: 'text', text: raw.content }] : Array.isArray(raw.content) ? raw.content : [];
    const source = isObj(raw.source) ? raw.source : undefined;
    if (role === 'tool') {
      const id = typeof raw.toolCallId === 'string' ? raw.toolCallId : source && typeof source.callId === 'string' ? source.callId : undefined;
      if (!id) { skipped += 1; return; }
      const result: ToolResult = { tool_use_id: id, text: contentText(content), isError: raw.isError === true };
      if (!textOnly(content)) result.pinned = true;
      const message = core('user', '');
      message.toolResults = [result];
      tools.results.set(id, { item, block: -1 });
      messages.push(message);
      refs.push({ item });
      return;
    }
    if (role === 'assistant') {
      const message = core('assistant', '');
      const texts: string[] = [];
      content.forEach((block: unknown, index: number) => {
        if (!isObj(block)) return;
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        if (block.type === 'tool-call') {
          const id = typeof block.id === 'string' ? block.id : typeof block.toolCallId === 'string' ? block.toolCallId : undefined;
          if (!id) return;
          const { input, raw: shape } = toolInput(block.arguments ?? block.input ?? block.args);
          message.toolUses.push({ tool_use_id: id, tool: String(block.name ?? block.toolName ?? ''), input });
          tools.calls.set(id, { item, block: index, raw: shape });
        }
      });
      message.text = texts.join('\n');
      messages.push(message);
      refs.push({ item });
      return;
    }
    if (role === 'user') {
      // AI SDK v4 puts `tool-result` parts on the user/tool side.
      const message = core('user', contentText(content));
      content.forEach((block: unknown, index: number) => {
        if (!isObj(block) || block.type !== 'tool-result' || typeof block.toolCallId !== 'string') return;
        const output = block.output ?? block.result;
        const text = typeof output === 'string' ? output : isObj(output) && typeof output.value === 'string' ? output.value : JSON.stringify(output ?? null);
        (message.toolResults ??= []).push({ tool_use_id: block.toolCallId, text, isError: block.isError === true });
        tools.results.set(block.toolCallId, { item, block: index });
      });
      const author = authorOfSource(source && typeof source.kind === 'string' ? source.kind : undefined);
      if (author) message.author = author;
      messages.push(message);
      refs.push({ item });
      return;
    }
    skipped += 1;
  });
  return { format: 'ai-sdk', messages, refs, tools, skipped };
}

function readCore(history: readonly unknown[]): Parsed {
  const messages = history.filter((item): item is Message => isObj(item) && Array.isArray(item.toolUses)) as Message[];
  return {
    format: 'messages',
    messages,
    refs: messages.map((_, item) => ({ item })),
    tools: { calls: new Map(), results: new Map() },
    skipped: history.length - messages.length,
  };
}

/** Reads a native history into the core transcript, with references back. */
export function parseTranscript(value: unknown, format?: TranscriptFormat): Parsed {
  const history = historyOf(value);
  const chosen = format ?? detectFormat(history);
  switch (chosen) {
    case 'anthropic':
      return readAnthropic(history);
    case 'openai-chat':
      return readOpenAIChat(history);
    case 'gemini':
      return readGemini(history);
    case 'ai-sdk':
      return readAiSdk(history);
    case 'messages':
      return readCore(history);
    case 'responses':
      throw new Error('Use compactResponsesInput for OpenAI Responses / Codex input');
  }
}

/** The core transcript of a native history, for inspection or a dry run. */
export function toMessages(value: unknown, format?: TranscriptFormat): Message[] {
  return parseTranscript(value, format).messages;
}

/* --------------------------------------------------------------- writers */

function clone<T>(value: T): T {
  return Array.isArray(value) ? ([...value] as T) : isObj(value) ? ({ ...value } as T) : value;
}

/** Serialises an input back to the shape it came in. */
function nativeInput(input: Record<string, unknown>, raw: 'object' | 'json' | 'text'): unknown {
  if (raw === 'object') return input;
  if (raw === 'text') {
    const text = typeof input.input === 'string' ? input.input : JSON.stringify(input.input ?? '');
    const note = Object.entries(input).find(([key, value]) => key !== 'input' && typeof value === 'string' && value.startsWith('[fast-jev-compaction'));
    return note ? `${text}\n${String(note[1])}` : text;
  }
  return JSON.stringify(input);
}

/**
 * Writes the compacted core transcript back onto the native history. Items
 * whose calls and results are unchanged are returned as the same objects.
 */
export function applyToNative(value: unknown, parsed: Parsed, result: Pick<CompactResult, 'aligned'>): unknown[] {
  const history = historyOf(value);
  const out: unknown[] = [...history];
  const changed = new Set<number>();
  const edit = (item: number): Obj => {
    if (!changed.has(item)) {
      const original = out[item];
      // Claude Code `.jsonl` lines wrap the API message: edit the inner one.
      if (isObj(original) && isObj(original.message) && parsed.format === 'anthropic') {
        out[item] = { ...original, message: { ...original.message, content: clone(original.message.content) } };
      } else if (isObj(original)) {
        const copy: Obj = { ...original };
        for (const key of ['content', 'parts', 'tool_calls']) if (Array.isArray(copy[key])) copy[key] = [...(copy[key] as unknown[])];
        out[item] = copy;
      }
      changed.add(item);
    }
    const current = out[item] as Obj;
    return parsed.format === 'anthropic' && isObj(current.message) ? (current.message as Obj) : current;
  };
  const removed = new Set<number>();

  result.aligned.forEach((after, index) => {
    const before = parsed.messages[index]!;
    const ref = parsed.refs[index]!;
    if (after === before) return;
    if (after === null) {
      removed.add(ref.item);
      return;
    }
    if (after.text !== before.text) writeText(edit(ref.item), parsed.format, after.text, before.text);
    const uses = new Map(after.toolUses.map((tool) => [tool.tool_use_id, tool]));
    for (const tool of before.toolUses) {
      const now = uses.get(tool.tool_use_id);
      const at = parsed.tools.calls.get(tool.tool_use_id);
      if (!at) continue;
      if (!now) {
        removeCall(edit(at.item), parsed.format, at.block, tool.tool_use_id);
        continue;
      }
      if (now.input !== tool.input) writeInput(edit(at.item), parsed.format, at.block, nativeInput(now.input, at.raw));
    }
    const results = new Map((after.toolResults ?? []).map((r) => [r.tool_use_id, r]));
    for (const res of before.toolResults ?? []) {
      const now = results.get(res.tool_use_id);
      const at = parsed.tools.results.get(res.tool_use_id);
      if (!at) continue;
      if (!now) {
        removeResult(edit(at.item), parsed.format, at.block, res.tool_use_id);
        continue;
      }
      if (now.text !== res.text) writeResult(edit(at.item), parsed.format, at.block, now.text);
    }
  });

  // Blocks removed above leave `undefined` holes; drop them, then any item left empty.
  return out.flatMap((item, index) => {
    if (removed.has(index)) return [];
    if (!changed.has(index) || !isObj(item)) return [item];
    const inner = parsed.format === 'anthropic' && isObj(item.message) ? (item.message as Obj) : item;
    for (const key of ['content', 'parts', 'tool_calls']) {
      if (Array.isArray(inner[key])) inner[key] = (inner[key] as unknown[]).filter((block) => block !== undefined);
    }
    if (Array.isArray(inner.tool_calls) && inner.tool_calls.length === 0) delete inner.tool_calls;
    const empty =
      (Array.isArray(inner.content) && inner.content.length === 0 && !inner.tool_calls && !inner.function_call) ||
      (Array.isArray(inner.parts) && inner.parts.length === 0);
    return empty ? [] : [item];
  });
}

function writeText(target: Obj, format: TranscriptFormat, text: string, before: string): void {
  if (format === 'gemini') {
    const parts = target.parts as unknown[];
    const first = parts.findIndex((part) => isObj(part) && typeof part.text === 'string' && part.thought !== true);
    if (first < 0) return;
    parts.forEach((part, index) => {
      if (index !== first && isObj(part) && typeof part.text === 'string' && part.thought !== true) parts[index] = undefined;
    });
    parts[first] = { ...(parts[first] as Obj), text };
    return;
  }
  if (typeof target.content === 'string' || target.content === null || target.content === undefined) {
    target.content = text;
    return;
  }
  if (!Array.isArray(target.content)) return;
  const blocks = target.content;
  const textual = blocks.map((block, index) => ({ block, index })).filter(({ block }) => isObj(block) && TEXT_TYPES.has(String(block.type)) && typeof block.text === 'string');
  if (textual.length === 0) {
    blocks.unshift({ type: 'text', text });
    return;
  }
  // The texts were joined with newlines; when a suffix was appended, it goes on the last block.
  if (text.startsWith(before) && textual.length > 0) {
    const last = textual[textual.length - 1]!;
    blocks[last.index] = { ...(last.block as Obj), text: `${String((last.block as Obj).text)}${text.slice(before.length)}` };
    return;
  }
  const [first, ...rest] = textual;
  blocks[first!.index] = { ...(first!.block as Obj), text };
  for (const { index } of rest) blocks[index] = undefined;
}

function writeInput(target: Obj, format: TranscriptFormat, block: number, input: unknown): void {
  if (format === 'anthropic') {
    const blocks = target.content as unknown[];
    blocks[block] = { ...(blocks[block] as Obj), input };
  } else if (format === 'openai-chat') {
    if (block < 0) target.function_call = { ...(target.function_call as Obj), arguments: typeof input === 'string' ? input : JSON.stringify(input) };
    else {
      const calls = target.tool_calls as unknown[];
      const call = calls[block] as Obj;
      const key = isObj(call.function) ? 'function' : 'custom';
      const fn = call[key] as Obj;
      const field = 'arguments' in fn || key === 'function' ? 'arguments' : 'input';
      calls[block] = { ...call, [key]: { ...fn, [field]: typeof input === 'string' ? input : JSON.stringify(input) } };
    }
  } else if (format === 'gemini') {
    const parts = target.parts as unknown[];
    const part = parts[block] as Obj;
    const key = isObj(part.functionCall) ? 'functionCall' : 'function_call';
    parts[block] = { ...part, [key]: { ...(part[key] as Obj), args: input } };
  } else if (format === 'ai-sdk') {
    const blocks = target.content as unknown[];
    const original = blocks[block] as Obj;
    const key = 'arguments' in original ? 'arguments' : 'input' in original ? 'input' : 'args';
    blocks[block] = { ...original, [key]: key === 'arguments' && typeof input !== 'string' ? JSON.stringify(input) : input };
  }
}

function writeResult(target: Obj, format: TranscriptFormat, block: number, text: string): void {
  if (format === 'anthropic') {
    const blocks = target.content as unknown[];
    const original = blocks[block] as Obj;
    blocks[block] = { ...original, content: rewriteOutput(original.content ?? '', text) };
  } else if (format === 'openai-chat' || (format === 'ai-sdk' && block < 0)) {
    target.content = rewriteOutput(target.content, text);
  } else if (format === 'gemini') {
    const parts = target.parts as unknown[];
    const part = parts[block] as Obj;
    const key = isObj(part.functionResponse) ? 'functionResponse' : 'function_response';
    const response = part[key] as Obj;
    // A cut JSON body is no longer JSON: it travels as `{ output: text }`, the documented shape.
    parts[block] = { ...part, [key]: { ...response, response: { output: text } } };
  } else if (format === 'ai-sdk') {
    const blocks = target.content as unknown[];
    const original = blocks[block] as Obj;
    const key = 'output' in original ? 'output' : 'result';
    const before = original[key];
    blocks[block] = { ...original, [key]: isObj(before) && 'value' in before ? { ...before, type: 'text', value: text } : text };
  }
}

function removeCall(target: Obj, format: TranscriptFormat, block: number, id: string): void {
  if (format === 'openai-chat') {
    if (block < 0) delete target.function_call;
    else (target.tool_calls as unknown[])[block] = undefined;
  } else if (format === 'gemini') (target.parts as unknown[])[block] = undefined;
  else if (Array.isArray(target.content)) (target.content as unknown[])[block] = undefined;
  void id;
}

function removeResult(target: Obj, format: TranscriptFormat, block: number, id: string): void {
  if (block < 0) {
    // A whole `role: 'tool'` message: emptied, then dropped by the caller.
    target.content = [];
    return;
  }
  if (format === 'gemini') (target.parts as unknown[])[block] = undefined;
  else if (Array.isArray(target.content)) (target.content as unknown[])[block] = undefined;
  void id;
}

/* ------------------------------------------------------------------ entry */

export interface TranscriptCompaction extends Omit<CompactResult, 'messages' | 'aligned'> {
  format: TranscriptFormat;
  /** The compacted history, in the input's own format. */
  history: unknown[];
  /** The core transcript the judge scored, after compaction. */
  messages: Message[];
}

/**
 * Compacts a history in any supported format: detects (or takes) the format,
 * scores its tool calls with the asker and writes the result back in the same
 * format. For a format whose tool calls cannot be rewritten safely (signed
 * reasoning, a host that forbids it), pass `rewriteInputs: false`.
 */
export async function compactTranscript(
  value: unknown,
  asker: JevAsker,
  options: CompactOptions & { format?: TranscriptFormat } = {},
): Promise<TranscriptCompaction> {
  const parsed = parseTranscript(value, options.format);
  const result = await compact(parsed.messages, asker, options);
  return {
    format: parsed.format,
    history: applyToNative(value, parsed, result),
    messages: result.messages,
    decisions: result.decisions,
    stats: result.stats,
  };
}

/** Decisions by the native call id, for callers that rewrite their own store (an event log, a database). */
export function decisionsByCallId(decisions: readonly CallDecision[]): Map<string, CallDecision> {
  return new Map(decisions.filter((d) => d.tool_use_id !== undefined).map((d) => [d.tool_use_id!, d]));
}
