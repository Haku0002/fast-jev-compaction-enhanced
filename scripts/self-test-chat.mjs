/** Evaluate a sanitized copy of the current Codex phase through the user's Codex login. */
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { compactResponsesInput, codexRolloutInput, responsesToMessages, collectToolCalls, openaiAsker, resolveOptions } from '../dist/index.js';

const option = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const source = option('--source'), destination = option('--out'), executable = option('--codex'), model = option('--model');
if (!source || !destination || !executable || !model) throw new Error('--source, --out, --codex and --model are required');
await mkdir(destination, { recursive: true });

let redacted = 0;
const secrets = Object.entries(process.env).filter(([key, value]) => /API.?KEY|TOKEN|PASSWORD|SECRET/i.test(key) && value?.length >= 16).map(([, value]) => value);
const credential = /\b(?:apikey_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b|\bBearer\s+[A-Za-z0-9._-]{16,}/g;
function sanitize(value) {
  if (typeof value === 'string') {
    let clean = value;
    for (const secret of secrets) if (clean.includes(secret)) { redacted += 1; clean = clean.split(secret).join('[credential removed]'); }
    return clean.replace(credential, () => { redacted += 1; return '[credential removed]'; });
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitize(entry)]));
  return value;
}
const text = (item) => Array.isArray(item.content) ? item.content.map((block) => block.text ?? '').join('\n') : String(item.content ?? '');
const raw = await readFile(source, 'utf8');
// A live log may have a partly written last record; snapshot only complete lines.
const complete = raw.endsWith('\n') ? raw : raw.slice(0, raw.lastIndexOf('\n') + 1);
const all = codexRolloutInput(complete);
const start = all.findLastIndex((item) => item.role === 'user' && text(item).includes('这个对话是从 Claude 迁移过来的'));
if (start < 0) throw new Error('The requested Codex phase was not found');
const relativeEnd = all.slice(start).findIndex((item) => item.role === 'user' && text(item).trim() === '你可以自己在这对话里测试一下。');
if (relativeEnd < 0) throw new Error('The self-test cutoff was not found');
const segment = all.slice(start, start + relativeEnd);
const input = sanitize(segment.filter((item) => item.type !== 'reasoning' && item.type !== 'compaction'
  && !(item.type === 'message' && !['user', 'assistant'].includes(item.role))));
const serialized = JSON.stringify(input);
if (secrets.some((secret) => serialized.includes(secret)) || /\bapikey_[A-Za-z0-9_]{16,}|\bsk-[A-Za-z0-9_-]{16,}/.test(serialized)) {
  throw new Error('Credential check failed');
}
await writeFile(join(destination, 'sanitized-input.json'), serialized, { mode: 0o600 });
const baseline = responsesToMessages(input);
const collected = collectToolCalls(baseline.messages, 6);
const beforeFix = input.map((item) => Array.isArray(item.output) ? { ...item, output: [{ type: 'unsupported_text_array', text: '' }] } : item);
const old = responsesToMessages(beforeFix);
const oldCalls = collectToolCalls(old.messages, 6);
const snapshot = { records: input.length, toolPairs: collected.length, candidates: collected.filter((call) => !call.pinned).length,
  oldSupportedPairs: oldCalls.length, protectedPairs: baseline.protectedCalls.length, skippedReasoningRecords: segment.filter((item) => item.type === 'reasoning').length,
  redactedStrings: redacted, sha256: createHash('sha256').update(serialized).digest('hex') };
console.log(JSON.stringify({ stage: 'prepared', snapshot }));

const work = await mkdtemp(join(tmpdir(), 'fast-jev-chat-judge-'));
const runs = [];
async function completeWithCodex(request) {
  if (runs.length >= 2) throw new Error('Self-test budget: at most two judge batches');
  const index = runs.length + 1;
  const schema = join(work, `schema-${index}.json`), replyPath = join(work, `reply-${index}.json`);
  await writeFile(schema, JSON.stringify(request.text.format.schema));
  const entry = { batch: index, model, questions: Object.keys(JSON.parse(request.input).questions).length, transport: 'codex-exec-chatgpt-login', status: 'running', events: {} };
  runs.push(entry);
  console.log(JSON.stringify({ stage: 'judging', batch: index, questions: entry.questions, model }));
  const started = Date.now();
  const exit = await new Promise((finish, reject) => {
    const child = spawn(executable, ['exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', 'read-only',
      '--model', model, '--config', 'model_reasoning_effort="medium"', '--config', 'web_search="disabled"',
      '--output-schema', schema, '--output-last-message', replyPath, '--json', '--cd', work, '-'], {
      env: { ...process.env, OPENAI_API_KEY: '', TYPESAFE_API_KEY: '', RUST_LOG: 'error',
        ...(option('--proxy') ? { HTTP_PROXY: option('--proxy'), HTTPS_PROXY: option('--proxy') } : {}) }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '', error = '', tools = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Codex judge timed out after 120 seconds; ${error}`)); }, 120_000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        let event; try { event = JSON.parse(line); } catch { continue; }
        entry.events[event.type] = (entry.events[event.type] ?? 0) + 1;
        if (event.type === 'turn.completed') entry.usage = event.usage;
        if (event.type === 'turn.failed' || event.type === 'error') error = sanitize(JSON.stringify(event)).slice(0, 500);
        if (event.type === 'item.completed' && !['agent_message', 'reasoning'].includes(event.item?.type)) tools += 1;
      }
    });
    child.stderr.on('data', (chunk) => { error = sanitize(String(chunk)).slice(-1000); });
    child.on('error', (failure) => { clearTimeout(timer); reject(failure); });
    child.on('close', (code) => {
      clearTimeout(timer); entry.toolsUsed = tools;
      if (code !== 0 || tools > 0) reject(new Error(`Codex judge failed (${code}); tools=${tools}; ${error}`));
      else finish(code);
    });
    child.stdin.end(request.instructions + '\nDo not call tools, read files, search or continue the coding task. Score only the supplied data.\n' + request.input);
  });
  const outputText = await readFile(replyPath, 'utf8');
  JSON.parse(outputText);
  entry.status = 'completed'; entry.ms = Date.now() - started;
  await writeFile(join(destination, `judge-answers-${index}.json`), outputText, { mode: 0o600 });
  return { status: 'completed', model, output_text: outputText, usage: entry.usage };
}

try {
  const goal = 'Continue work on Haku0002/fast-jev-compaction-enhanced. Preserve the current repository and branch, Codex integration limitations, verified checks, memory-shelf decisions and unfinished work. Older exploratory outputs can be abridged only when those facts remain available.';
  const result = await compactResponsesInput(input, openaiAsker(completeWithCodex, { model }), { ...resolveOptions(), goal, concurrency: 1 });
  const human = (items) => items.filter((item) => item.type === 'message').map((item) => JSON.stringify(item));
  const toolIds = (items) => items.filter((item) => ['custom_tool_call', 'function_call'].includes(item.type)).map((item) => item.call_id);
  const audit = { humanMessagesVerbatim: JSON.stringify(human(input)) === JSON.stringify(human(result.input)),
    toolCallIdsAndOrderPreserved: JSON.stringify(toolIds(input)) === JSON.stringify(toolIds(result.input)),
    pairedOutputsPreserved: result.input.filter((item) => String(item.type).endsWith('_call_output')).length === collected.length,
    metadataPreserved: input.every((item, index) => ['id', 'call_id', 'phase', 'name', 'status', 'namespace', 'internal_chat_message_metadata_passthrough'].every((key) => JSON.stringify(item[key]) === JSON.stringify(result.input[index]?.[key]))) };
  if (Object.values(audit).some((value) => value !== true)) throw new Error('History preservation audit failed');
  const kept = JSON.stringify(result.input);
  const facts = ['Haku0002/fast-jev-compaction-enhanced', '0.7.0', 'known_refs', 'Memory Shelf', 'phase'];
  const factChecks = facts.map((fact) => ({ fact, before: serialized.includes(fact), after: kept.includes(fact) }));
  const charsReduction = result.stats.charsBefore ? 1 - result.stats.charsAfter / result.stats.charsBefore : 0;
  const report = { snapshot, model, judgeRuns: runs, stats: result.stats, contextChanged: result.contextChanged, charsReduction,
    audit, factChecks, decisions: result.decisions, liveContextModified: false,
    limits: ['The judge ran through Codex login, not the direct Responses HTTP client.', 'Reduction is characters, not billed tokens.', 'Fact checks do not predict all later-needed evidence.'] };
  await writeFile(join(destination, 'compacted-input.json'), kept, { mode: 0o600 });
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ stage: 'completed', stats: result.stats, charsReduction, audit, factChecks, judgeRuns: runs }));
} catch (error) {
  await writeFile(join(destination, 'failure-report.json'), JSON.stringify({ snapshot, runs, error: sanitize(error.message), liveContextModified: false }, null, 2), { mode: 0o600 });
  throw error;
} finally {
  if (!resolve(work).startsWith(resolve(tmpdir()))) throw new Error('Unexpected judge workspace');
  await rm(work, { recursive: true, force: true });
}
