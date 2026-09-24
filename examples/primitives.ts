/**
 * Compares the two System One primitives the judge can be asked with, on one
 * real session: every candidate call of a transcript is put to Jev twice on
 * the same windows, once as the two `noul` questions (keep the call; keep its
 * full result) and once as one `choice` whose options are the actions
 * themselves, and the report says how decisive each was and where they
 * disagree.
 *
 *   TYPESAFE_API_KEY=... npm run primitives                      # newest session
 *   TYPESAFE_API_KEY=... npm run primitives -- path/to/session.jsonl
 *   npm run primitives -- --dry [path]                           # plan only, no requests
 *
 * The question it answers: `noul` scores measured on this project sat inside
 * the arbitration band for about four calls in five, which leaves the cheap
 * judge deciding almost nothing. A `choice` asks the judge to compare the
 * actions instead of estimating two truths, so the test is whether its
 * probabilities commit. They do (29% of calls near 0.5 against 60% on an
 * 800-call session), but committing is not being right: `evaluate.ts`
 * checks both against what the session did next, and there `choice` lost
 * far more of what was needed.
 */
import {
  askResult,
  choiceAnswer,
  collectToolCalls,
  estimateTokens,
  JevClient,
  noulAnswer,
  planRequests,
  questionsFor,
  resolveOptions,
  type CallAnswer,
  type JevQuestions,
  type ResolvedCompactOptions,
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

const base = resolveOptions({ preserveRecentMessages: 6 });
const styles: Record<string, ResolvedCompactOptions> = {
  noul: { ...base, primitive: 'noul' },
  choice: { ...base, primitive: 'choice' },
};
type Style = keyof typeof styles;

const messages = loadSession(path);
const calls = collectToolCalls(messages, base.preserveRecentMessages);
const candidates = calls.filter((call) => !call.pinned);
console.log(`${path}`);
console.log(`${messages.length} messages, ${calls.length} tool calls, ${candidates.length} candidates`);

const estimate = (questions: JevQuestions): number => estimateTokens(JSON.stringify(questions));
const plan = planRequests(messages, calls, candidates, {
  ...base,
  questionTokens: (call) =>
    Math.max(...Object.values(styles).map((options) => estimate(questionsFor(call, options)))),
});
console.log(`${plan.requests.length} request(s) per primitive, ${plan.unscored.length} unscored`);
for (const request of plan.requests) {
  console.log(`  window of ${request.calls.length} calls, state ~${request.tokens} tokens`);
}
if (dry) process.exit(0);

const client = new JevClient();
const answers: Record<Style, Map<string, CallAnswer>> = { noul: new Map(), choice: new Map() };
const timing: Record<string, number> = {};

for (const style of Object.keys(styles) as Style[]) {
  const options = styles[style]!;
  const started = Date.now();
  for (const request of plan.requests) {
    const questions: JevQuestions = Object.assign(
      {},
      ...request.calls.map((call) => questionsFor(call, options)),
    );
    const { answers: replied } = await client.ask(request.state, questions);
    for (const call of request.calls) {
      if (options.primitive === 'choice') {
        const answer = choiceAnswer(replied, `call_${call.id}`);
        if (answer) answers[style].set(call.id, answer);
        continue;
      }
      const keepCall = noulAnswer(replied, `call_${call.id}`);
      if (keepCall === undefined) continue;
      const keepResult = askResult(call, options) ? noulAnswer(replied, `result_${call.id}`) : 0;
      if (keepResult === undefined) continue;
      answers[style].set(call.id, { keepCall, keepResult });
    }
  }
  timing[style] = Date.now() - started;
  console.log(`\n${style}: ${answers[style].size} calls answered in ${timing[style]} ms`);
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

function action(answer: CallAnswer, call: ToolCall): string {
  if (askResult(call, base) && answer.keepResult >= base.keepThreshold) return 'keep';
  return answer.keepCall >= base.keepCallThreshold ? 'drop_result' : 'stub_call';
}

function report(style: Style): void {
  const scored = [...answers[style].values()];
  const keepCall = scored.map((a) => a.keepCall);
  console.log(`  keepCall    ${bands(keepCall)}`);
  const asked = candidates.filter((c) => askResult(c, base) && answers[style].has(c.id));
  console.log(`  keepResult  ${bands(asked.map((c) => answers[style].get(c.id)!.keepResult))}   (${asked.length} asked)`);
  const band = keepCall.filter((v) => Math.abs(v - base.keepCallThreshold) < base.arbitrateBand).length;
  const decisive = keepCall.reduce((sum, v) => sum + Math.abs(v - 0.5), 0) / (keepCall.length || 1);
  console.log(
    `  in the arbitration band: ${band}/${keepCall.length} (${Math.round((100 * band) / (keepCall.length || 1))}%)` +
      `   mean |p-0.5| ${decisive.toFixed(3)}   range ${Math.min(...keepCall).toFixed(2)}-${Math.max(...keepCall).toFixed(2)}`,
  );
  const acts = new Map<string, number>();
  for (const call of candidates) {
    const answer = answers[style].get(call.id);
    if (answer) acts.set(action(answer, call), (acts.get(action(answer, call)) ?? 0) + 1);
  }
  console.log(`  actions: ${[...acts.entries()].sort().map(([a, n]) => `${a}=${n}`).join('  ')}`);
}

const both = candidates.filter((c) => answers.noul.has(c.id) && answers.choice.has(c.id));
if (both.length > 0) {
  const differ = both.filter((c) => action(answers.noul.get(c.id)!, c) !== action(answers.choice.get(c.id)!, c));
  console.log(`\nsame decision on ${both.length - differ.length}/${both.length}, differ on ${differ.length}`);
  console.log('largest disagreements:');
  const sorted = [...both].sort(
    (a, b) =>
      Math.abs(answers.choice.get(b.id)!.keepCall - answers.noul.get(b.id)!.keepCall) -
      Math.abs(answers.choice.get(a.id)!.keepCall - answers.noul.get(a.id)!.keepCall),
  );
  for (const call of sorted.slice(0, 12)) {
    const n = answers.noul.get(call.id)!;
    const c = answers.choice.get(call.id)!;
    const about = Object.values(call.input).find((v): v is string => typeof v === 'string')?.replace(/\s+/g, ' ').slice(0, 44) ?? '';
    console.log(
      `  ${call.id.padEnd(5)} ${call.tool.padEnd(10)} noul ${n.keepCall.toFixed(2)}/${n.keepResult.toFixed(2)} ${action(n, call).padEnd(11)}` +
        ` choice ${c.keepCall.toFixed(2)}/${c.keepResult.toFixed(2)} ${action(c, call).padEnd(11)} ${about}`,
    );
  }
}
