/**
 * Scores the judge against what a session actually did next. The transcript
 * is cut at a point (`--cut`, default 0.6 of its messages); the calls before
 * the cut are put to Jev as a compaction at that point would put them, once
 * per primitive, and the messages after the cut stand as ground truth:
 *
 * - `needOutput`: a distinctive line of the call's output (24+ chars, line
 *   numbers stripped) turns up again in something the assistant wrote after
 *   the cut (a tool input such as an Edit's old_string, a command, its text),
 *   before any later call fetched the same target again. The assistant used
 *   that output; dropping it would have cost a re-fetch.
 * - `needCall`: `needOutput`, or the call's file is touched again after the
 *   cut before a later call re-fetched it. The file was still in play.
 *
 * Both are heuristics with a known bias (an exact line match misses a
 * paraphrase, so they undercount need); they are the same for both
 * primitives, so they rank them fairly. The report gives each primitive's
 * AUC against both labels (threshold-free), and what the default thresholds
 * would lose.
 *
 *   TYPESAFE_API_KEY=... npm run evaluate -- path/to/session.jsonl [--cut 0.6] [--runs 1] [--out file.json]
 *   npm run evaluate -- --dry path/to/session.jsonl
 *
 * Measured on 2026-09-25, three sessions from other projects (a Python
 * caption app, a Windows display tool, a game), cut at 60%, 1412 calls:
 *
 *   stubbed at the default thresholds   stubbed   needed calls lost   used outputs lost
 *   noul                                    512      49 of 238            16 of 45
 *   choice                                 1096     133 of 238            38 of 45
 *   by tool name alone (file tools kept)   1061      15 of 238            15 of 45
 *
 * Both primitives were stable across two runs (r 0.99 on keepCall). Neither
 * kept a used output whole, and neither `keepResult` ranked used outputs
 * above unused ones (pooled AUC 0.38 and 0.38). Letting the judge override
 * the tool rule where it was confident rescued at most 6 needed calls for 273
 * fewer stubs (noul), or lost more (choice). `needCall` leans toward file
 * tools by construction (a file touched again), so the tool rule's margin
 * there is overstated; `needOutput` does not have that lean, and the rule
 * still lost fewer. The game session had almost no positives (its calls are
 * mostly Bash orchestration whose output is never quoted back).
 */
import { writeFileSync } from 'node:fs';
import {
  askResult,
  callTarget,
  choiceAnswer,
  collectToolCalls,
  estimateTokens,
  JevClient,
  noulAnswer,
  planRequests,
  questionsFor,
  resolveOptions,
  type JevQuestions,
  type Message,
  type ResolvedCompactOptions,
  type ToolCall,
} from '../src/index.js';
import { loadSession } from './session.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dry = args.includes('--dry');
const cut = Number(flag('--cut') ?? 0.6);
const runs = Math.max(1, Number(flag('--runs') ?? 1));
const out = flag('--out');
const VALUED = new Set(['--cut', '--runs', '--out']);
const path = args.find((arg, i) => !arg.startsWith('--') && !VALUED.has(args[i - 1] ?? ''));
if (!path) {
  console.error('pass a path to a session .jsonl');
  process.exit(1);
}

const all = loadSession(path);
const at = Math.floor(all.length * cut);
const prefix = all.slice(0, at);
const future = all.slice(at);
const base = resolveOptions({ preserveRecentMessages: 6 });
const styles: Record<string, ResolvedCompactOptions> = {
  noul: { ...base, primitive: 'noul' },
  choice: { ...base, primitive: 'choice' },
};

const calls = collectToolCalls(prefix, base.preserveRecentMessages);
const candidates = calls.filter((call) => !call.pinned && !call.tombstone);
console.log(path);
console.log(
  `${all.length} messages, cut at ${at} (${Math.round(cut * 100)}%): ${calls.length} calls before it, ${candidates.length} candidates`,
);

// ---- ground truth from the messages after the cut ----
const LINE_NUMBER = /^\s*\d+(?:→|\t)/;
const normalize = (line: string): string => line.replace(LINE_NUMBER, '').trim();
const distinctive = (text: string): string[] => {
  const lines = new Set<string>();
  for (const raw of text.split('\n').slice(0, 600)) {
    const line = normalize(raw);
    if (line.length >= 24 && /[A-Za-z一-鿿]/.test(line)) lines.add(line);
  }
  return [...lines];
};
const stringsOf = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : value && typeof value === 'object'
      ? Object.values(value).flatMap(stringsOf)
      : [];

/** Tools that fetch a target's current content: a later one makes an older output stale. */
const FETCH = new Set(['Read', 'Grep', 'Glob', 'Bash', 'PowerShell', 'WebFetch', 'LS', 'NotebookRead']);
const fileKey = (key: string | undefined): string | undefined => (key && key.startsWith('file:') ? key.split('@')[0] : undefined);

/** First message index (in the whole transcript) after the cut where each line appears in assistant-written content. */
const firstUse = new Map<string, number>();
/** First index after the cut at which each target key or file is fetched again, and touched at all. */
const firstFetch = new Map<string, number>();
const firstTouch = new Map<string, number>();
future.forEach((message: Message, offset) => {
  const index = at + offset;
  const written: string[] = [];
  if (message.role === 'assistant') written.push(message.text);
  for (const use of message.toolUses) {
    written.push(...stringsOf(use.input));
    const target = callTarget(use.tool, use.input);
    if (!target) continue;
    const keys = [target.key, target.file, fileKey(target.key)].filter((k): k is string => Boolean(k));
    for (const key of keys) {
      if (!firstTouch.has(key)) firstTouch.set(key, index);
      if (FETCH.has(use.tool) && !firstFetch.has(key)) firstFetch.set(key, index);
    }
  }
  for (const text of written) {
    for (const raw of text.split('\n')) {
      const line = normalize(raw);
      if (line.length >= 24 && !firstUse.has(line)) firstUse.set(line, index);
    }
  }
});

/** A later fetch of the same target before the cut: the older output is not the one anyone reads. */
const refetchedBeforeCut = new Set<string>();
{
  const seen = new Set<string>();
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const call = calls[i]!;
    const target = callTarget(call.tool, call.input);
    if (!target) continue;
    const file = target.file ?? fileKey(target.key);
    if (seen.has(target.key) || (file && seen.has(file) && call.tool === 'Read')) refetchedBeforeCut.add(call.id);
    if (FETCH.has(call.tool)) {
      seen.add(target.key);
      if (call.tool === 'Read' && !target.file && file) seen.add(file);
    }
  }
}

function labels(call: ToolCall, text: string): { needOutput: boolean; needCall: boolean } {
  if (refetchedBeforeCut.has(call.id)) return { needOutput: false, needCall: false };
  const target = callTarget(call.tool, call.input);
  const keys = target ? [target.key, target.file, fileKey(target.key)].filter((k): k is string => Boolean(k)) : [];
  const refetch = Math.min(Infinity, ...keys.map((k) => firstFetch.get(k) ?? Infinity));
  const used = Math.min(Infinity, ...distinctive(text).map((line) => firstUse.get(line) ?? Infinity));
  const needOutput = used < Infinity && used < refetch;
  const file = target ? (target.file ?? fileKey(target.key)) : undefined;
  const touched = file ? (firstTouch.get(file) ?? Infinity) : Infinity;
  const needCall = needOutput || (touched < Infinity && touched <= refetch);
  return { needOutput, needCall };
}

const resultText = new Map<string, string>();
prefix.forEach((message) => {
  for (const result of message.toolResults ?? []) resultText.set(result.tool_use_id, result.text);
});

type Score = { keepCall: number; keepResult: number; raw?: unknown };
const records = candidates.map((call) => {
  const text = resultText.get(call.tool_use_id) ?? '';
  const target = callTarget(call.tool, call.input);
  return {
    id: call.id,
    tool: call.tool,
    target: target?.key.slice(0, 120),
    resultChars: call.resultChars,
    resultAsked: askResult(call, base),
    position: call.callIndex / Math.max(1, at),
    isError: call.isError,
    supersededBy: call.supersededBy,
    ...labels(call, text),
    scores: {} as Record<string, Score[]>,
  };
});
type Record_ = (typeof records)[number];
const byId = new Map(records.map((r) => [r.id, r]));
console.log(
  `ground truth: ${records.filter((r) => r.needOutput).length} need their output, ${records.filter((r) => r.needCall).length} need the call (of ${records.length})`,
);

const estimate = (questions: JevQuestions): number => estimateTokens(JSON.stringify(questions));
const plan = planRequests(prefix, calls, candidates, {
  ...base,
  questionTokens: (call) => Math.max(...Object.values(styles).map((o) => estimate(questionsFor(call, o)))),
});
console.log(`${plan.requests.length} request(s) per primitive per run, ${plan.unscored.length} unscored`);
if (dry) process.exit(0);

const client = new JevClient();
for (let run = 0; run < runs; run += 1) {
  for (const [style, options] of Object.entries(styles)) {
    const started = Date.now();
    for (const request of plan.requests) {
      const questions: JevQuestions = Object.assign({}, ...request.calls.map((c) => questionsFor(c, options)));
      const { answers } = await client.ask(request.state, questions);
      for (const call of request.calls) {
        const record = byId.get(call.id);
        if (!record) continue;
        let score: Score | undefined;
        if (options.primitive === 'choice') {
          const answer = choiceAnswer(answers, `call_${call.id}`);
          const raw = answers[`call_${call.id}`];
          if (answer) score = { ...answer, raw: raw && 'probabilities' in raw ? raw.probabilities : undefined };
        } else {
          const keepCall = noulAnswer(answers, `call_${call.id}`);
          const keepResult = askResult(call, options) ? noulAnswer(answers, `result_${call.id}`) : 0;
          if (keepCall !== undefined && keepResult !== undefined) score = { keepCall, keepResult };
        }
        if (score) (record.scores[style] ??= [])[run] = score;
      }
    }
    console.log(`run ${run + 1} ${style}: ${Date.now() - started} ms`);
  }
}

/** Mann-Whitney AUC: the chance a random positive outscores a random negative. */
function auc(pairs: { score: number; label: boolean }[]): number {
  const pos = pairs.filter((p) => p.label).map((p) => p.score);
  const neg = pairs.filter((p) => !p.label).map((p) => p.score);
  if (!pos.length || !neg.length) return NaN;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

console.log('');
for (const style of Object.keys(styles)) {
  const scored = records.filter((r) => r.scores[style]?.[0]);
  const s = (r: Record_): Score => r.scores[style]![0]!;
  const act = (r: Record_): string =>
    r.resultAsked && s(r).keepResult >= base.keepThreshold
      ? 'keep'
      : s(r).keepCall >= base.keepCallThreshold
        ? 'drop_result'
        : 'stub_call';
  const aucCall = auc(scored.map((r) => ({ score: s(r).keepCall, label: r.needCall })));
  const aucOutCall = auc(scored.map((r) => ({ score: s(r).keepCall, label: r.needOutput })));
  const asked = scored.filter((r) => r.resultAsked);
  const aucOut = auc(asked.map((r) => ({ score: s(r).keepResult, label: r.needOutput })));
  const stubbed = scored.filter((r) => act(r) === 'stub_call');
  const keptVerbatim = scored.filter((r) => act(r) === 'keep');
  console.log(
    `${style.padEnd(7)} AUC keepCall~needCall ${aucCall.toFixed(3)}  keepCall~needOutput ${aucOutCall.toFixed(3)}  keepResult~needOutput ${aucOut.toFixed(3)} (${asked.length} asked)`,
  );
  console.log(
    `        at 0.5: stubbed ${stubbed.length}/${scored.length}, of which ${stubbed.filter((r) => r.needOutput).length} needed their output; kept verbatim ${keptVerbatim.length} (${keptVerbatim.filter((r) => r.needOutput).length} needed)`,
  );
}
if (out) {
  writeFileSync(out, JSON.stringify({ path, cut, at, messages: all.length, records }, null, 1));
  console.log(`\nwrote ${out}`);
}
