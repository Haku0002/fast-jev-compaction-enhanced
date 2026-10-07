import { compact, removedMarker } from './compact.js';
import type { CompactOptions, CompactResult, JevAsker, Message, ToolResult, ToolUse } from './types.js';

/** Open-ended to preserve new API items and provider-specific metadata verbatim. */
export interface ResponsesItem { [key: string]: unknown }

export interface ProtectedCall { callId: string; reason: string }

export interface ResponsesCompaction extends Omit<CompactResult, 'messages'> {
  input: ResponsesItem[];
  itemsBefore: number;
  itemsAfter: number;
  /** Reset caller-held retrieval known_refs after the context changes. */
  contextChanged: boolean;
  protectedCalls: ProtectedCall[];
}

type Pair = { id: string; callIndex: number; resultIndex: number; custom: boolean; tool: ToolUse };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textOf(item: ResponsesItem): string {
  if (typeof item.content === 'string') return item.content;
  if (!Array.isArray(item.content)) return '';
  return item.content.flatMap((block: unknown) =>
    object(block) && ['input_text', 'output_text', 'text'].includes(String(block.type)) && typeof block.text === 'string'
      ? [block.text] : [],
  ).join('\n');
}

/** Native Codex often returns several input_text blocks for one tool result. */
function toolOutputText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every((block) => object(block) && block.type === 'input_text' && typeof block.text === 'string'
    && Object.keys(block).every((key) => key === 'type' || key === 'text'))) return undefined;
  return value.map((block) => (block as { text: string }).text).join('\n');
}

function rebuiltToolOutput(original: unknown, text: string): unknown {
  return typeof original === 'string' ? text : [{ type: 'input_text', text }];
}

/** Project complete text pairs into the core while keeping one position per native item. */
export function responsesToMessages(input: readonly ResponsesItem[]): {
  messages: Message[]; protectedCalls: ProtectedCall[];
} {
  const { messages, protectedCalls } = project(input);
  return { messages, protectedCalls };
}

function project(input: readonly ResponsesItem[]): {
  messages: Message[]; pairs: Pair[]; protectedCalls: ProtectedCall[];
} {
  const messages: Message[] = input.map((item) => ({
    role: item.role === 'user' ? 'user' : 'assistant',
    text: item.type === 'message' || (!item.type && typeof item.role === 'string')
      ? (item.role === 'system' || item.role === 'developer' ? `[${item.role} context]\n` : '') + textOf(item) : '',
    toolUses: [],
  }));
  const callIndexes = new Map<string, number[]>();
  const resultIndexes = new Map<string, number[]>();
  input.forEach((item, index) => {
    if (typeof item.call_id !== 'string' || !item.call_id) return;
    const type = String(item.type ?? '');
    const map = type.endsWith('_call_output') ? resultIndexes : type.endsWith('_call') ? callIndexes : undefined;
    if (!map) return;
    const indexes = map.get(item.call_id) ?? [];
    indexes.push(index);
    map.set(item.call_id, indexes);
  });
  const protectedCalls: ProtectedCall[] = [];
  const pairs: Pair[] = [];
  for (const [id, indexes] of callIndexes) {
    const results = resultIndexes.get(id) ?? [];
    const callIndex = indexes[0]!;
    const item = input[callIndex]!;
    if (!['function_call', 'custom_tool_call'].includes(String(item.type))) continue;
    const protect = (reason: string): void => { protectedCalls.push({ callId: id, reason }); };
    if (indexes.length !== 1 || results.length !== 1) { protect('missing or ambiguous tool pair'); continue; }
    const resultIndex = results[0]!;
    const result = input[resultIndex]!;
    if (resultIndex <= callIndex || result.type !== `${item.type}_output`) { protect('out-of-order or mismatched tool pair'); continue; }
    if (typeof item.name !== 'string' || (item.status !== undefined && item.status !== 'completed')) {
      protect('incomplete tool call'); continue;
    }
    const resultText = toolOutputText(result.output);
    if (resultText === undefined || item.encrypted_function_args || (result.status !== undefined && result.status !== 'completed')) {
      protect('opaque, multimodal or incomplete tool pair'); continue;
    }
    const custom = item.type === 'custom_tool_call';
    let args: Record<string, unknown>;
    if (custom) {
      if (typeof item.input !== 'string') { protect('non-text custom input'); continue; }
      args = { input: item.input };
    } else {
      let parsed: unknown;
      try { parsed = typeof item.arguments === 'string' ? JSON.parse(item.arguments) as unknown : undefined; }
      catch { protect('malformed function arguments'); continue; }
      if (!object(parsed)) { protect('non-object function arguments'); continue; }
      args = parsed;
    }
    const tool: ToolUse = { tool_use_id: id, tool: item.name, input: args, text: resultText };
    const output: ToolResult = { tool_use_id: id, text: resultText };
    messages[callIndex]!.toolUses = [tool];
    messages[resultIndex]!.role = 'user';
    messages[resultIndex]!.toolResults = [output];
    pairs.push({ id, callIndex, resultIndex, custom, tool });
  }
  return { messages, pairs, protectedCalls };
}

/**
 * Compact input owned by an API agent. Rebuild by original index, so item order,
 * roles, assistant phase and opaque items never pass through a lossy conversion.
 * Machine-block pruning is disabled for native messages; only tool pairs change.
 */
export async function compactResponsesInput(
  input: readonly ResponsesItem[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<ResponsesCompaction> {
  const { messages, pairs, protectedCalls } = project(input);
  const result = await compact(messages, asker, { ...options, pruneMachineText: false });
  const decisions = new Map(result.decisions.map((decision) => [decision.id, decision]));
  const tools = new Map(result.messages.flatMap((message) => message.toolUses.map((tool) => [tool.tool_use_id, tool] as const)));
  const outputs = new Map(result.messages.flatMap((message) => (message.toolResults ?? []).map((output) => [output.tool_use_id, output] as const)));
  const replacements = new Map<number, ResponsesItem | null>();
  // Core short ids enumerate these eligible pairs in call order.
  pairs.forEach((pair, index) => {
    const decision = decisions.get(`t${index + 1}`);
    if (!decision || decision.action === 'keep') return;
    const original = input[pair.callIndex]!;
    const originalOutput = input[pair.resultIndex]!;
    if (decision.action === 'drop_call') {
      replacements.set(pair.callIndex, {
        type: 'message', role: 'assistant', phase: 'commentary',
        content: [{ type: 'output_text', text: removedMarker([pair.tool]) }],
      });
      replacements.set(pair.resultIndex, null);
      return;
    }
    const tool = tools.get(pair.id);
    const output = outputs.get(pair.id);
    if (!tool || !output) throw new Error('Compaction lost a tool pair');
    if (tool.input !== pair.tool.input) {
      const customInput = typeof tool.input.note === 'string'
        ? `${String(tool.input.input)}\n${tool.input.note}` : tool.input.input;
      replacements.set(pair.callIndex, {
        ...original,
        ...(pair.custom ? { input: customInput } : { arguments: JSON.stringify(tool.input) }),
      });
    }
    if (output.text !== pair.tool.text) replacements.set(pair.resultIndex, {
      ...originalOutput, output: rebuiltToolOutput(originalOutput.output, output.text),
    });
  });
  const compacted = input.flatMap((item, index) => {
    if (!replacements.has(index)) return [item];
    const replacement = replacements.get(index)!;
    return replacement === null ? [] : [replacement];
  });
  return {
    input: compacted, decisions: result.decisions, stats: result.stats,
    itemsBefore: input.length, itemsAfter: compacted.length, contextChanged: replacements.size > 0, protectedCalls,
  };
}

/** Read a Codex rollout export without rewriting a live session or exposing hidden reasoning. */
export function codexRolloutInput(jsonl: string): ResponsesItem[] {
  let input: ResponsesItem[] = [];
  for (const [index, line] of jsonl.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let entry: unknown;
    try { entry = JSON.parse(line) as unknown; }
    catch { throw new Error(`Invalid Codex JSONL at line ${index + 1}`); }
    if (!object(entry)) throw new Error(`Invalid Codex entry at line ${index + 1}`);
    if (entry.type === 'response_item') {
      if (!object(entry.payload) || typeof entry.payload.type !== 'string') {
        throw new Error(`Invalid response item at line ${index + 1}`);
      }
      input.push(entry.payload);
    } else if (entry.type === 'compacted') {
      const history = object(entry.payload) ? entry.payload.replacement_history : undefined;
      if (!Array.isArray(history) || !history.every((item) => object(item) && typeof item.type === 'string')) {
        throw new Error(`Codex compaction at line ${index + 1} has no usable replacement_history; export native items instead`);
      }
      input = history;
    }
  }
  return input;
}
