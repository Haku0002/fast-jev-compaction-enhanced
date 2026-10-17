import type { JevQuestions, JevResponse } from './types.js';

/**
 * Reading a judge's answers out of whatever a chat model sends back. Models
 * differ: some wrap JSON in a code fence, some think aloud first (DeepSeek R1
 * and Qwen in `<think>` tags, others in plain prose that may itself contain
 * braces), some nest the map under `answers`, some return a list of
 * `{ name, probability }` rows, some write `"85%"` or `"0.8"` as strings,
 * some add trailing commas or comments, and a few answer with a bare
 * `name: 0.8` line per question. Each of these is accepted; a reply that
 * answers none of the questions is an error.
 */

const THINK_BLOCK = /<(think|thinking|reasoning|reflection|analysis)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
/** An unclosed reasoning block runs to the end; everything before its opening tag is the answer. */
const OPEN_THINK = /<(think|thinking|reasoning|reflection|analysis)\b[^>]*>(?![\s\S]*<\/\1\s*>)[\s\S]*$/i;
const FENCE = /```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)```/g;

/** The reply text without reasoning blocks. */
export function stripReasoning(text: string): string {
  let out = text.replace(THINK_BLOCK, ' ');
  // A model that closes a block it never opened (`... </think> {json}`) puts its answer after the tag.
  const close = out.search(/<\/(think|thinking|reasoning|reflection|analysis)\s*>/i);
  if (close >= 0) out = out.slice(out.indexOf('>', close) + 1);
  return out.replace(OPEN_THINK, ' ');
}

/** Every balanced `{…}` or `[…]` span of `text`, outermost first, in order; strings are respected. */
export function jsonCandidates(text: string): string[] {
  const spans: string[] = [];
  for (let start = 0; start < text.length; start += 1) {
    const open = text[start];
    if (open !== '{' && open !== '[') continue;
    let depth = 0;
    let quote: string | undefined;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i]!;
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = undefined;
        continue;
      }
      if (ch === '"') quote = ch;
      else if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') {
        depth -= 1;
        if (depth === 0) {
          spans.push(text.slice(start, i + 1));
          start = i;
          break;
        }
      }
    }
  }
  return spans;
}

/** Parses JSON a model wrote, forgiving comments, trailing commas, single quotes and bare keys. */
export function lenientJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // fall through to the repairs below
  }
  const repaired = text
    // line and block comments outside strings (good enough for judge replies)
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match, string: string | undefined) => string ?? '')
    // single-quoted strings
    .replace(/'((?:\\.|[^'\\])*)'/g, (_, body: string) => JSON.stringify(body.replace(/\\'/g, "'")))
    // bare keys
    .replace(/([{,]\s*)([A-Za-z_][\w.-]*)\s*:/g, '$1"$2":')
    // percentages and Python literals
    .replace(/:\s*(-?\d+(?:\.\d+)?)\s*%/g, (_, n: string) => `: ${Number(n) / 100}`)
    .replace(/\bNone\b/g, 'null')
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    // trailing commas
    .replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(repaired);
}

/**
 * A probability from a number, a numeric string, a percentage, or a yes/no
 * word. A bare number above 1 is read on a 0-100 scale only when the caller
 * says the whole reply uses that scale (`percentScale`); otherwise it is out
 * of range and the question stays unscored.
 */
export function probabilityOf(value: unknown, percentScale = false): number | undefined {
  const n = rawNumber(value);
  if (n === undefined) return undefined;
  if (n.percent) return n.value >= 0 && n.value <= 1 ? n.value : undefined;
  const scaled = percentScale ? n.value / 100 : n.value;
  return scaled >= 0 && scaled <= 1 ? scaled : undefined;
}

/** The number a value states, and whether it was written as a percentage. */
function rawNumber(value: unknown): { value: number; percent: boolean } | undefined {
  let n: number | undefined;
  let percent = false;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'boolean') n = value ? 1 : 0;
  else if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    const match = /^(-?\d+(?:\.\d+)?)\s*%$/.exec(text);
    if (match) {
      n = Number(match[1]) / 100;
      percent = true;
    } else if (/^-?\d+(?:\.\d+)?$/.test(text)) n = Number(text);
    else if (['yes', 'true', 'keep'].includes(text)) n = 1;
    else if (['no', 'false', 'drop'].includes(text)) n = 0;
  } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ['noul', 'probability', 'p', 'prob', 'score', 'value', 'answer', 'confidence']) {
      if (key in record) return rawNumber(record[key]);
    }
  }
  return n === undefined || !Number.isFinite(n) ? undefined : { value: n, percent };
}

/**
 * Whether a reply's bare numbers are on a 0-100 scale: some exceed 1, none
 * exceed 100, none is negative, and none is a fraction below 1 (a reply
 * that mixes 0.9 with 7 is ambiguous, so its out-of-range numbers stay
 * unscored).
 */
function usesPercentScale(values: readonly unknown[]): boolean {
  const numbers = values.map(rawNumber).filter((n): n is { value: number; percent: boolean } => n !== undefined && !n.percent);
  if (!numbers.some((n) => n.value > 1)) return false;
  return numbers.every((n) => n.value >= 0 && n.value <= 100 && !(n.value > 0 && n.value < 1));
}

/** Looks for the answer map inside a parsed reply: the object itself, `answers`, or a list of rows. */
function answerMap(parsed: unknown, names: readonly string[]): Record<string, unknown> | undefined {
  if (Array.isArray(parsed)) {
    const map: Record<string, unknown> = {};
    for (const row of parsed) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
      const r = row as Record<string, unknown>;
      const name = r.name ?? r.question ?? r.id ?? r.key;
      if (typeof name === 'string') map[name] = 'noul' in r || 'probability' in r || 'p' in r || 'score' in r || 'value' in r ? r : r.answer;
    }
    return Object.keys(map).length > 0 ? map : undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const record = parsed as Record<string, unknown>;
  if (names.some((name) => name in record)) return record;
  for (const key of ['answers', 'answer', 'scores', 'probabilities', 'results', 'result', 'output', 'data']) {
    const inner = record[key];
    if (inner !== undefined) {
      const found = answerMap(inner, names);
      if (found) return found;
    }
  }
  return undefined;
}

/** Last resort: `name: 0.8` / `name = 80%` / `"name" -> 0.8` lines. */
function lineAnswers(text: string, names: readonly string[]): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`["'\`*]*${escaped}["'\`*]*\\s*(?::|=|->|=>|\\|)\\s*["']?(-?\\d+(?:\\.\\d+)?\\s*%?)`, 'i').exec(text);
    if (match) map[name] = match[1];
  }
  return map;
}

/**
 * Reads `noul` answers for `questions` from a free-form model reply. Keys are
 * matched exactly, then case-insensitively. A question the reply leaves out,
 * or answers with something that is not a probability, is left out (its call
 * stays unscored); a question answered with `null` is reported as unscored.
 */
export function parseJudgeReply(text: string, questions: JevQuestions, model = 'judge'): JevResponse {
  const names = Object.keys(questions);
  const visible = stripReasoning(text);
  const sources: string[] = [];
  for (const match of visible.matchAll(FENCE)) sources.push(match[1]!);
  sources.push(visible);
  // The reasoning itself, last: a model that only answers inside its thinking.
  if (visible !== text) sources.push(text);

  let best: { map: Record<string, unknown>; hits: number } | undefined;
  for (const source of sources) {
    // Larger candidates first, and later ones before earlier ones of the same size: the answer
    // usually comes last, after any example the model quoted.
    const candidates = jsonCandidates(source).reverse();
    for (const candidate of candidates) {
      let parsed: unknown;
      try {
        parsed = lenientJson(candidate);
      } catch {
        continue;
      }
      const map = answerMap(parsed, names);
      if (!map) continue;
      const hits = names.filter((name) => resolveKey(map, name) !== undefined).length;
      if (!best || hits > best.hits) best = { map, hits };
      if (hits === names.length) break;
    }
    if (best && best.hits === names.length) break;
  }
  if (!best || best.hits === 0) {
    const map = lineAnswers(visible, names);
    const hits = Object.keys(map).length;
    if (hits > 0) best = { map, hits };
  }
  if (!best) {
    if (!/[{[]/.test(text)) throw new Error(`${model} judge returned no JSON object`);
    throw new Error(`${model} judge answered none of the questions`);
  }

  const answers: JevResponse['answers'] = {};
  const unscored: string[] = [];
  const map = best.map;
  const percentScale = usesPercentScale(
    names.map((name) => resolveKey(map, name)).filter((key): key is string => key !== undefined).map((key) => map[key]),
  );
  for (const name of names) {
    const key = resolveKey(best.map, name);
    if (key === undefined) continue;
    const value = best.map[key];
    if (value === null) {
      unscored.push(name);
      continue;
    }
    const p = probabilityOf(value, percentScale);
    if (p !== undefined) answers[name] = { type: 'noul', noul: p };
  }
  if (names.length > 0 && Object.keys(answers).length === 0 && unscored.length < names.length) {
    throw new Error(`${model} judge answered none of the questions`);
  }
  return { model, answers, ...(unscored.length > 0 ? { unscored } : {}) };
}

function resolveKey(map: Record<string, unknown>, name: string): string | undefined {
  if (Object.hasOwn(map, name)) return name;
  const lower = name.toLowerCase();
  return Object.keys(map).find((key) => key.trim().toLowerCase() === lower);
}
