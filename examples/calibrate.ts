/**
 * Calibrates the judge against a real session: asks Jev about every candidate
 * call of a Claude Code transcript twice, once with the questions the library
 * sends (each spelling its criterion out) and once with a one-line phrasing
 * that leans on the rubric in the state's context alone, on the same windows,
 * and reports how the probabilities fell under each and where the two
 * disagree. Measured on a 125-call session on 2026-09-24, the short phrasing
 * sat 0.31 lower on average and flipped 86 of 125 decisions at 0.5, with
 * every Edit but one under the threshold; the long phrasing is the one kept.
 *
 *   TYPESAFE_API_KEY=... npm run calibrate                      # newest session
 *   TYPESAFE_API_KEY=... npm run calibrate -- path/to/session.jsonl
 *   npm run calibrate -- --dry [path]                            # plan only, no requests
 *
 * The output answers two questions: is a threshold of 0.5 where the answers
 * actually split (or does the judge sit at 0.3-0.5 for most calls, in which
 * case `keepCallThreshold` should come down), and did shortening the
 * questions move the answers.
 */
import {
  askResult,
  collectToolCalls,
  estimateTokens,
  JevClient,
  noulAnswer,
  planRequests,
  questionsFor,
  questionTokens,
  resolveOptions,
  type JevQuestions,
  type ToolCall,
} from '../src/index.js';
import { loadSession, newestSessionPath } from './session.js';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const path = args.find((arg) => !arg.startsWith('--')) ?? newestSessionPath();
if (!path) {
  console.error('no session transcript found; pass a path to a .jsonl');
  process.exit(1);
}

const options = resolveOptions({ preserveRecentMessages: 6 });
const messages = loadSession(path);
const calls = collectToolCalls(messages, options.preserveRecentMessages);
const candidates = calls.filter((call) => !call.pinned);
console.log(`${path}`);
console.log(`${messages.length} messages, ${calls.length} tool calls, ${candidates.length} candidates`);

/** The one-line phrasing that was tried and measured worse; kept for comparison. */
function shortQuestionsFor(call: ToolCall): JevQuestions {
  const questions: JevQuestions = {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) is still needed for the task`,
    },
  };
  if (askResult(call, options)) {
    questions[`result_${call.id}`] = {
      type: 'noul',
      instructions: `The full output of ${call.id} (${call.resultChars} chars) is still needed`,
    };
  }
  return questions;
}

const styles = {
  long: (call: ToolCall) => questionsFor(call, options),
  short: shortQuestionsFor,
} as const;
type Style = keyof typeof styles;

// Planned with the library's questions, the larger, so both styles fit the same windows.
const plan = planRequests(messages, calls, candidates, {
  ...options,
  questionTokens: (call) => Math.max(questionTokens(call, options), estimate(shortQuestionsFor(call))),
});
console.log(`${plan.requests.length} request(s) per style, ${plan.unscored.length} unscored`);
for (const request of plan.requests) {
  console.log(`  window of ${request.calls.length} calls, state ~${request.tokens} tokens`);
}
if (dry) process.exit(0);

function estimate(questions: JevQuestions): number {
  return estimateTokens(JSON.stringify(questions));
}

const client = new JevClient();
type Answer = { keepCall: number; keepResult: number | undefined };
const answers: Record<Style, Map<string, Answer>> = { short: new Map(), long: new Map() };

for (const style of Object.keys(styles) as Style[]) {
  const started = Date.now();
  for (const request of plan.requests) {
    const questions: JevQuestions = Object.assign({}, ...request.calls.map((call) => styles[style](call)));
    const response = await client.ask(request.state, questions);
    for (const call of request.calls) {
      const keepCall = noulAnswer(response.answers, `call_${call.id}`);
      if (keepCall === undefined) continue;
      answers[style].set(call.id, {
        keepCall,
        keepResult: askResult(call, options) ? noulAnswer(response.answers, `result_${call.id}`) : undefined,
      });
    }
  }
  console.log(`\n${style} questions: ${answers[style].size} calls answered in ${Date.now() - started} ms`);
  report(style);
}

function bands(values: number[]): string {
  const edges = [0.1, 0.3, 0.5, 0.7, 0.9, 1.01];
  const labels = ['<0.1', '<0.3', '<0.5', '<0.7', '<0.9', '≥0.9'];
  const counts = edges.map(() => 0);
  for (const value of values) {
    const i = edges.findIndex((edge) => value < edge);
    counts[i < 0 ? edges.length - 1 : i]! += 1;
  }
  return labels.map((label, i) => `${String(counts[i]).padStart(4)} ${label}`).join('  ');
}

function report(style: Style): void {
  const scored = [...answers[style].values()];
  console.log(`  keepCall    ${bands(scored.map((a) => a.keepCall))}`);
  const asked = scored.filter((a) => a.keepResult !== undefined);
  console.log(`  keepResult  ${bands(asked.map((a) => a.keepResult!))}   (${asked.length} asked)`);
  for (const threshold of [0.5, 0.3, 0.2]) {
    const stubbed = scored.filter((a) => a.keepCall < threshold).length;
    const kept = asked.filter((a) => a.keepResult! >= threshold).length;
    console.log(`  at threshold ${threshold}: ${stubbed} stubbed, ${kept} results kept verbatim, ${scored.length - stubbed - kept} truncated`);
  }
  const byTool = new Map<string, number[]>();
  for (const call of candidates) {
    const answer = answers[style].get(call.id);
    if (!answer) continue;
    byTool.set(call.tool, [...(byTool.get(call.tool) ?? []), answer.keepCall]);
  }
  for (const [tool, values] of [...byTool.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    console.log(`  ${tool.padEnd(14)} ${String(values.length).padStart(4)} calls, mean keepCall ${mean.toFixed(2)}, ${values.filter((v) => v < 0.5).length} under 0.5`);
  }
}

const both = candidates.filter((call) => answers.short.has(call.id) && answers.long.has(call.id));
if (both.length > 0) {
  const diffs = both.map((call) => ({ call, diff: answers.short.get(call.id)!.keepCall - answers.long.get(call.id)!.keepCall }));
  const mean = diffs.reduce((sum, d) => sum + d.diff, 0) / diffs.length;
  const flipped = diffs.filter((d) => (answers.short.get(d.call.id)!.keepCall >= 0.5) !== (answers.long.get(d.call.id)!.keepCall >= 0.5)).length;
  console.log(`\nshort minus long: mean keepCall difference ${mean.toFixed(3)}, ${flipped}/${both.length} decisions flip at 0.5`);
  console.log('largest disagreements:');
  for (const { call, diff } of [...diffs].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 10)) {
    const about = Object.values(call.input).find((v): v is string => typeof v === 'string')?.replace(/\s+/g, ' ').slice(0, 60) ?? '';
    console.log(`  ${call.id.padEnd(5)} ${call.tool.padEnd(10)} short ${answers.short.get(call.id)!.keepCall.toFixed(2)} long ${answers.long.get(call.id)!.keepCall.toFixed(2)} (${diff > 0 ? '+' : ''}${diff.toFixed(2)}) ${about}`);
  }
}
