#!/usr/bin/env node
import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { JevClient } from './client.js';
import { OpenAIClient } from './openai-client.js';
import { codexAsker } from './codex-asker.js';
import { compactResponsesInput, codexRolloutInput, responsesToMessages, type ResponsesItem } from './responses.js';
import { collectToolCalls } from './state.js';
import type { JevAsker } from './types.js';

const HELP = `Usage: fast-jev-compact --input FILE --format responses|codex [options]

  --dry-run                 Local inspection; no requests or file writes
  --output FILE             New Responses input JSON file; never overwrites
  --judge jev|openai|codex  Explicit provider (default: jev)
  --model MODEL             Judge model; required for openai or codex
  --arbiter-model MODEL     Opt-in OpenAI arbitration of borderline Jev decisions
  --codex-executable PATH   Use Codex login for the judge/arbiter instead of an API key
  --codex-proxy URL         Optional proxy for the Codex child only
  --base-url URL            Explicit API root for the OpenAI judge
  --goal TEXT               Current task description
  --help                    Show usage

Credentials come from TYPESAFE_API_KEY or OPENAI_API_KEY. The selected judge
receives a fitted state derived from the input. This command exports a separate
file; it does not edit a live Codex session or replace native /compact.`;

function parse(args: string[]): Map<string, string> {
  const values = new Set(['--input', '--output', '--format', '--judge', '--model', '--arbiter-model', '--base-url', '--goal', '--codex-executable', '--codex-proxy']);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (options.has(arg)) throw new Error('An option was supplied twice');
    if (arg === '--dry-run' || arg === '--help') { options.set(arg, 'true'); continue; }
    if (!values.has(arg)) throw new Error('Unknown option; run with --help');
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error('An option is missing its value');
    options.set(arg, value);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  if (options.has('--help')) { process.stdout.write(HELP + '\n'); return; }
  const inputPath = options.get('--input');
  const format = options.get('--format');
  if (!inputPath || !['responses', 'codex'].includes(format ?? '')) throw new Error('--input and --format responses|codex are required');
  const source = await readFile(inputPath, 'utf8');
  let input: ResponsesItem[];
  if (format === 'codex') input = codexRolloutInput(source);
  else {
    let parsed: unknown;
    try { parsed = JSON.parse(source) as unknown; }
    catch { throw new Error('Responses input contains invalid JSON'); }
    if (!Array.isArray(parsed) || !parsed.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))) {
      throw new Error('Responses input must be a JSON array of items');
    }
    input = parsed as ResponsesItem[];
  }
  if (options.has('--dry-run')) {
    const { messages, protectedCalls } = responsesToMessages(input);
    const calls = collectToolCalls(messages, 6);
    process.stdout.write(JSON.stringify({ dryRun: true, items: input.length, calls: calls.length, candidates: calls.filter((call) => !call.pinned).length, protectedCalls }) + '\n');
    return;
  }
  const outputPath = options.get('--output');
  if (!outputPath || resolve(inputPath) === resolve(outputPath)) throw new Error('--output must name a separate new file');
  // Check before judging to avoid spending requests on an unusable destination.
  const exists = await access(outputPath).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return false;
  });
  if (exists) throw new Error('Output already exists; choose a new file');
  const judge = options.get('--judge') ?? 'jev';
  if (!['jev', 'openai', 'codex'].includes(judge)) throw new Error('--judge must be jev, openai or codex');
  const model = options.get('--model');
  if (judge !== 'jev' && !model) throw new Error('--model is required for an OpenAI/Codex judge');
  if (judge !== 'jev' && options.has('--arbiter-model')) throw new Error('--arbiter-model is only for a Jev first judge');
  const executable = options.get('--codex-executable');
  const codexOptions = (selectedModel: string) => ({ executable: executable!, model: selectedModel, proxy: options.get('--codex-proxy') });
  if (judge === 'codex' && !executable) throw new Error('--codex-executable is required for a Codex judge');
  if (executable && judge !== 'codex' && !(judge === 'jev' && options.has('--arbiter-model'))) throw new Error('--codex-executable is for a Codex judge or Jev arbiter');
  if (options.has('--codex-proxy') && !executable) throw new Error('--codex-proxy requires --codex-executable');
  if (executable && options.has('--base-url')) throw new Error('--base-url is only for the direct OpenAI HTTP transport');
  if (judge === 'jev' && options.has('--base-url') && !options.has('--arbiter-model')) {
    throw new Error('--base-url configures OpenAI; use it with an OpenAI judge or arbiter');
  }
  const asker: JevAsker = judge === 'codex' ? codexAsker(codexOptions(model!)) : judge === 'openai'
    ? new OpenAIClient({ model: model!, baseUrl: options.get('--base-url') })
    : new JevClient({ model });
  const arbiterModel = options.get('--arbiter-model');
  const arbiter = arbiterModel ? (executable ? codexAsker(codexOptions(arbiterModel)) : new OpenAIClient({ model: arbiterModel, baseUrl: options.get('--base-url') })) : undefined;
  const result = await compactResponsesInput(input, asker, { goal: options.get('--goal'), arbiter });
  await writeFile(outputPath, JSON.stringify(result.input, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ itemsBefore: result.itemsBefore, itemsAfter: result.itemsAfter, contextChanged: result.contextChanged, stats: result.stats, protectedCalls: result.protectedCalls }) + '\n');
}

void main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.message : 'Compaction failed') + '\n');
  process.exitCode = 1;
});
