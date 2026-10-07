/** Compare saved OpenAI-only decisions with Jev and a real borderline Codex arbiter. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { compactResponsesInput, codexAsker, resolveOptions } from '../dist/index.js';

const flag = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const folder = flag('--out'), executable = flag('--codex'), proxy = flag('--proxy');
if (!folder || !executable) throw new Error('--out and --codex are required');
const raw = await readFile(folder + '/sanitized-input.json', 'utf8');
const input = JSON.parse(raw);
const baseline = JSON.parse(await readFile(folder + '/report.json', 'utf8'));
const jev = JSON.parse(await readFile(folder + '/jev-report.json', 'utf8'));
const digest = (value) => createHash('sha256').update(value).digest('hex');
if (digest(raw) !== jev.snapshot.sha256 || digest(raw) !== baseline.snapshot.sha256) throw new Error('Frozen chat hash mismatch');
const primary = {
  async ask(state, questions) {
    const hash = digest(JSON.stringify({ state, questions }));
    const saved = jev.requests.find((request) => request.requestHash === hash);
    if (!saved) throw new Error('Primary replay did not match the actual Jev request');
    return saved.response;
  },
};
const model = baseline.model;
const arbiterRows = [];
const realArbiter = codexAsker({ executable, model, proxy });
const arbiter = {
  async ask(state, questions) {
    const started = Date.now();
    console.log(JSON.stringify({ stage: 'arbitrating', questions: Object.keys(questions).length, model }));
    const response = await realArbiter.ask(state, questions);
    arbiterRows.push({ questions: Object.keys(questions).length, ms: Date.now() - started, response });
    return response;
  },
};
const result = await compactResponsesInput(input, primary, { ...resolveOptions(), goal: jev.goal, concurrency: 1, arbiter });
const audit = {
  messagesVerbatim: JSON.stringify(input.filter((item) => item.type === 'message')) === JSON.stringify(result.input.filter((item) => item.type === 'message')),
  metadataPreserved: input.every((item, index) => ['type', 'role', 'id', 'call_id', 'phase', 'name', 'status', 'namespace', 'internal_chat_message_metadata_passthrough'].every((key) => JSON.stringify(item[key]) === JSON.stringify(result.input[index]?.[key]))),
};
if (!Object.values(audit).every(Boolean)) throw new Error('Hybrid preservation audit failed');
const report = { snapshot: jev.snapshot, primaryRequestedAlias: jev.model, primaryReturnedModel: jev.requests[0].response.model, arbiterModel: model,
  samePrimaryAnswers: true, actualNewJevRequests: 0, actualNewArbiterRequests: arbiterRows.length,
  arbiterRows, stats: result.stats, decisions: result.decisions, audit,
  charsReduction: 1 - result.stats.charsAfter / result.stats.charsBefore,
  combinedStageMs: jev.stats.ms + result.stats.ms, liveContextModified: false };
await writeFile(folder + '/hybrid-report.json', JSON.stringify(report, null, 2), { mode: 0o600 });
await writeFile(folder + '/hybrid-compacted-input.json', JSON.stringify(result.input), { mode: 0o600 });
console.log(JSON.stringify({ stage: 'hybrid-completed', stats: result.stats, audit, charsReduction: report.charsReduction,
  combinedStageMs: report.combinedStageMs, arbiter: arbiterRows.map((row) => ({ questions: row.questions, ms: row.ms, usage: row.response.usage })) }));
