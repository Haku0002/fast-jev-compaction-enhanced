#!/usr/bin/env node
import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chatAskerFor, CHAT_PROVIDERS } from './chat-asker.js';
import { JevClient } from './client.js';
import { OpenAIClient } from './openai-client.js';
import { codexAsker } from './codex-asker.js';
import { compactTranscript, detectFormat, historyOf, parseTranscript, type TranscriptFormat } from './formats.js';
import { compactResponsesInput, codexRolloutInput, responsesToMessages, type ResponsesItem } from './responses.js';
import { collectToolCalls } from './state.js';
import type { JevAsker, Message } from './types.js';

const FORMATS = ['auto', 'responses', 'codex', 'anthropic', 'claude-code', 'openai-chat', 'gemini', 'ai-sdk', 'messages'];

const HELP = `Usage: fast-jev-compact --input FILE [--format FORMAT] [options]

  --format FORMAT           auto (default), responses, codex, anthropic, claude-code,
                            openai-chat, gemini, ai-sdk, messages
  --dry-run                 Local inspection; no requests or file writes
  --output FILE             New file in the input's own format; never overwrites
  --judge jev|openai|codex|chat
                            Explicit provider (default: jev)
  --provider NAME           For --judge chat: ${Object.keys(CHAT_PROVIDERS).join(', ')}
  --model MODEL             Judge model; required for openai, codex or chat
  --arbiter-model MODEL     Opt-in OpenAI arbitration of borderline Jev decisions
  --codex-executable PATH   Use Codex login for the judge/arbiter instead of an API key
  --codex-proxy URL         Optional proxy for the Codex child only
  --base-url URL            Explicit API root for the OpenAI or chat judge
  --api-key-env NAME        Environment variable holding the chat judge's key
  --goal TEXT               Current task description
  --help                    Show usage

Credentials come from TYPESAFE_API_KEY, OPENAI_API_KEY, or the provider's own
variable for --judge chat. The selected judge receives a fitted state derived
from the input. This command exports a separate file; it does not edit a live
session or replace any host's native /compact.`;

function parse(args: string[]): Map<string, string> {
  const values = new Set(['--input', '--output', '--format', '--judge', '--model', '--arbiter-model', '--base-url', '--goal', '--codex-executable', '--codex-proxy', '--provider', '--api-key-env']);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (options.has(arg)) throw new Error('An option was supplied twice');
    if (arg === '--dry-run' || arg === '--help') { options.set(arg, 'true'); continue; }
    if (!values.has(arg)) throw new Error('Unknown option; run with --help');
    const value = args[++index];
    // A value may itself start with `--` (`--goal "--keep the API stable"`); only a known flag is a missing value.
    if (value === undefined || value === '' || values.has(value) || value === '--dry-run' || value === '--help') {
      throw new Error('An option is missing its value');
    }
    options.set(arg, value);
  }
  return options;
}

/** A JSON document, or JSON Lines (Claude Code transcripts, exports). */
function parseDocument(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    const lines = source.split(/\r?\n/).filter((line) => line.trim());
    try {
      return lines.map((line) => JSON.parse(line) as unknown);
    } catch {
      throw new Error('Input is neither JSON nor JSON Lines');
    }
  }
}

function summary(messages: readonly Message[]): { calls: number; candidates: number } {
  const calls = collectToolCalls(messages, 6);
  return { calls: calls.length, candidates: calls.filter((call) => !call.pinned).length };
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  if (options.has('--help')) { process.stdout.write(HELP + '\n'); return; }
  const inputPath = options.get('--input');
  const requested = options.get('--format') ?? 'auto';
  if (!inputPath) throw new Error('--input is required');
  if (!FORMATS.includes(requested)) throw new Error(`--format must be one of ${FORMATS.join(', ')}`);
  const source = await readFile(inputPath, 'utf8');
  let input: ResponsesItem[] | undefined;
  let document: unknown;
  let format: TranscriptFormat;
  if (requested === 'codex') {
    input = codexRolloutInput(source);
    format = 'responses';
  } else {
    document = parseDocument(source);
    format = requested === 'auto' ? detectFormat(historyOf(document)) : requested === 'claude-code' ? 'anthropic' : (requested as TranscriptFormat);
    if (format === 'responses') {
      const items = historyOf(document);
      if (!items.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))) {
        throw new Error('Responses input must be a JSON array of items');
      }
      input = items as ResponsesItem[];
    }
  }
  if (options.has('--dry-run')) {
    if (input) {
      const { messages, protectedCalls } = responsesToMessages(input);
      process.stdout.write(JSON.stringify({ dryRun: true, format, items: input.length, ...summary(messages), protectedCalls }) + '\n');
    } else {
      const parsed = parseTranscript(document, format);
      process.stdout.write(JSON.stringify({ dryRun: true, format, items: historyOf(document).length, messages: parsed.messages.length, ...summary(parsed.messages) }) + '\n');
    }
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
  if (!['jev', 'openai', 'codex', 'chat'].includes(judge)) throw new Error('--judge must be jev, openai, codex or chat');
  const model = options.get('--model');
  if (judge !== 'jev' && !model) throw new Error('--model is required for an OpenAI, Codex or chat judge');
  if ((options.has('--provider') || options.has('--api-key-env')) && judge !== 'chat') {
    throw new Error('--provider and --api-key-env are for --judge chat');
  }
  if (judge === 'chat' && (options.has('--arbiter-model') || options.has('--codex-executable'))) {
    throw new Error('--arbiter-model and --codex-executable are not used with --judge chat');
  }
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
  let asker: JevAsker;
  if (judge === 'codex') asker = codexAsker(codexOptions(model!));
  else if (judge === 'openai') asker = new OpenAIClient({ model: model!, baseUrl: options.get('--base-url') });
  else if (judge === 'chat') {
    const provider = options.get('--provider') ?? (options.has('--base-url') ? 'custom' : '');
    if (!provider) throw new Error('--judge chat needs --provider or --base-url');
    const keyEnv = options.get('--api-key-env');
    asker = chatAskerFor(provider, {
      model: model!,
      baseUrl: options.get('--base-url'),
      ...(keyEnv ? { apiKey: process.env[keyEnv] ?? '' } : {}),
    });
  } else asker = new JevClient({ model });
  const arbiterModel = options.get('--arbiter-model');
  const arbiter = arbiterModel ? (executable ? codexAsker(codexOptions(arbiterModel)) : new OpenAIClient({ model: arbiterModel, baseUrl: options.get('--base-url') })) : undefined;
  const goal = options.get('--goal');
  if (input) {
    const result = await compactResponsesInput(input, asker, { goal, arbiter });
    await writeFile(outputPath, JSON.stringify(result.input, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify({ format, itemsBefore: result.itemsBefore, itemsAfter: result.itemsAfter, contextChanged: result.contextChanged, stats: result.stats, protectedCalls: result.protectedCalls }) + '\n');
    return;
  }
  const result = await compactTranscript(document, asker, { goal, arbiter, format });
  // JSON Lines in, JSON Lines out; otherwise the history replaces the list it came from.
  const lines = Array.isArray(document) && !source.trimStart().startsWith('[');
  const body = lines
    ? result.history.map((item) => JSON.stringify(item)).join('\n') + '\n'
    : JSON.stringify(Array.isArray(document) ? result.history : replaceHistory(document, result.history), null, 2) + '\n';
  await writeFile(outputPath, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ format, itemsBefore: historyOf(document).length, itemsAfter: result.history.length, stats: result.stats }) + '\n');
}

/** The input envelope with its message list replaced. */
function replaceHistory(document: unknown, history: unknown[]): unknown {
  const envelope = document as Record<string, unknown>;
  for (const key of ['messages', 'contents', 'input', 'history', 'items', 'conversation']) {
    if (Array.isArray(envelope[key])) return { ...envelope, [key]: history };
  }
  return history;
}

void main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.message : 'Compaction failed') + '\n');
  process.exitCode = 1;
});
