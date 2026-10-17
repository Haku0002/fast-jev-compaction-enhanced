import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = (args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((finish, reject) => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: root,
    env: { ...process.env, OPENAI_API_KEY: 'test-only-key', TYPESAFE_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  child.on('error', reject);
  child.on('close', (status) => finish({ status, stdout, stderr }));
});

const input = [
  { type: 'message', role: 'user', content: 'fix parser' },
  { type: 'function_call', call_id: 'a', name: 'exec_command', arguments: '{"cmd":"npm test"}' },
  { type: 'function_call_output', call_id: 'a', output: 'start\n' + 'log '.repeat(500) + '\nFAIL parser' },
  ...Array.from({ length: 7 }, (_, i) => ({ type: 'message', role: i % 2 ? 'user' : 'assistant', content: `later ${i}` })),
];

async function inFixture(fn: (path: string) => Promise<void>): Promise<void> {
  const path = await mkdtemp(join(tmpdir(), 'fast-jev-cli-test-'));
  try { await fn(path); }
  finally {
    if (!resolve(path).startsWith(resolve(tmpdir()))) throw new Error('Unexpected fixture location');
    await rm(path, { recursive: true, force: true });
  }
}

describe('CLI other formats', () => {
  it('detects a Chat Completions history and exports it in the same format', async () => {
    const chat = [
      { role: 'system', content: 'agent' },
      { role: 'user', content: 'fix parser' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'sh', arguments: '{"cmd":"npm test"}' } }] },
      { role: 'tool', tool_call_id: 'a', content: 'start\n' + 'log '.repeat(500) + '\nFAIL parser' },
      ...Array.from({ length: 7 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: `later ${i}` })),
    ];
    let calls = 0;
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += String(chunk); });
      request.on('end', () => {
        calls += 1;
        expect(request.url).toBe('/v1/chat/completions');
        const sent = JSON.parse(body) as { messages: { content: string }[] };
        const names = [...sent.messages.at(-1)!.content.matchAll(/- ((?:call|result)_t\d+):/g)].map((m) => m[1]!);
        const answers = Object.fromEntries(names.map((name) => [name, name.startsWith('call_') ? 0.9 : 0.1]));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: '<think>{}</think>' + JSON.stringify(answers) } }] }));
      });
    });
    await new Promise<void>((finish) => server.listen(0, '127.0.0.1', finish));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a local test endpoint');
    try {
      await inFixture(async (path) => {
        const source = join(path, 'chat.json'), destination = join(path, 'out.json');
        await writeFile(source, JSON.stringify({ model: 'x', messages: chat }));
        const dry = await cli(['--input', source, '--dry-run']);
        expect(JSON.parse(dry.stdout)).toMatchObject({ dryRun: true, format: 'openai-chat', calls: 1, candidates: 1 });
        // A value may start with `--`; only a known flag in its place is a missing value.
        const dashed = await cli(['--input', source, '--goal', '--keep the API stable', '--dry-run']);
        expect(dashed.status).toBe(0);
        const missing = await cli(['--input', source, '--goal', '--dry-run']);
        expect(missing.stderr).toContain('missing its value');
        const result = await cli(['--input', source, '--output', destination, '--judge', 'chat', '--model', 'judge-model', '--base-url', `http://127.0.0.1:${address.port}/v1`]);
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        const exported = JSON.parse(await readFile(destination, 'utf8')) as { model: string; messages: { content: string }[] };
        expect(exported.model).toBe('x');
        expect(exported.messages[3]!.content).toMatch(/FAIL parser/);
        expect(exported.messages[3]!.content).toMatch(/fast-jev-compaction truncated/);
        expect(calls).toBe(1);
      });
    } finally { await new Promise<void>((finish, reject) => server.close((error) => error ? reject(error) : finish())); }
  });
});

describe('CLI exported history', () => {
  it('supports offline Codex inspection and refuses an existing destination before judging', async () => {
    await inFixture(async (path) => {
      const source = join(path, 'session.jsonl');
      const destination = join(path, 'existing.json');
      await writeFile(source, input.map((payload) => JSON.stringify({ type: 'response_item', payload })).join('\n'));
      await writeFile(destination, 'original');
      const inspected = await cli(['--input', source, '--format', 'codex', '--dry-run']);
      expect(inspected.status).toBe(0);
      expect(JSON.parse(inspected.stdout)).toMatchObject({ dryRun: true, calls: 1, candidates: 1 });
      const rejected = await cli(['--input', source, '--format', 'codex', '--output', destination, '--judge', 'openai', '--model', 'm']);
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain('Output already exists');
      expect(await readFile(destination, 'utf8')).toBe('original');
    });
  });

  it('runs the selected HTTP transport end to end without touching the input', async () => {
    let calls = 0;
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += String(chunk); });
      request.on('end', () => {
        calls += 1;
        const sent = JSON.parse(body) as { model: string; input: string; store: boolean };
        expect(request.url).toBe('/v1/responses');
        expect(sent.model).toBe('test-model');
        expect(sent.store).toBe(false);
        const questions = JSON.parse(sent.input).questions as Record<string, unknown>;
        const answers = Object.fromEntries(Object.keys(questions).map((name) => [name, name.startsWith('call_') ? 0.9 : 0.1]));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'completed', output_text: JSON.stringify({ answers }) }));
      });
    });
    await new Promise<void>((finish) => server.listen(0, '127.0.0.1', finish));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a local test endpoint');
    try {
      await inFixture(async (path) => {
        const source = join(path, 'input.json'), destination = join(path, 'output.json');
        const original = JSON.stringify(input);
        await writeFile(source, original);
        const result = await cli(['--input', source, '--format', 'responses', '--output', destination, '--judge', 'openai', '--model', 'test-model', '--base-url', `http://127.0.0.1:${address.port}/v1`]);
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ contextChanged: true, stats: { requests: 1, resultsDropped: 1 } });
        expect(await readFile(source, 'utf8')).toBe(original);
        const exported = JSON.parse(await readFile(destination, 'utf8'));
        expect(exported[2].call_id).toBe('a');
        expect(exported[2].output).toContain('FAIL parser');
        expect(exported[2].output.length).toBeLessThan(input[2]!.output!.length);
        expect(calls).toBe(1);
      });
    } finally { await new Promise<void>((finish, reject) => server.close((error) => error ? reject(error) : finish())); }
  });
});
