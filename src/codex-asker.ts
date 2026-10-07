import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { openaiAsker, type OpenAIJudgeRequest } from './openai-asker.js';
import type { JevAsker } from './types.js';

export interface CodexAskerOptions {
  /** Native Codex executable. This adapter does not execute shell command strings. */
  executable: string;
  /** Explicit OpenAI model accepted by the signed-in Codex account. */
  model: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** Optional HTTP(S) proxy for this child only; user config is never rewritten. */
  proxy?: string;
  /** Includes startup, inference and reply delivery. Default 90000 ms. */
  timeoutMs?: number;
}

/**
 * An optional judge/arbiter through the official Codex CLI and its ChatGPT login.
 * Runs in an empty ephemeral directory, requests JSON only, and rejects a turn
 * that uses tools. It does not read OAuth tokens or rewrite a running thread.
 */
export function codexAsker(options: CodexAskerOptions): JevAsker {
  if (!options.executable?.trim()) throw new Error('Codex judge requires a native executable');
  if (!options.model?.trim() || options.model.startsWith('-')) throw new Error('Codex judge requires an explicit model');
  const timeoutMs = options.timeoutMs ?? 90_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Codex timeoutMs must be positive');
  if (options.reasoningEffort !== undefined && !['low', 'medium', 'high', 'xhigh'].includes(options.reasoningEffort)) throw new Error('Invalid Codex reasoning effort');
  if (options.proxy) {
    const url = new URL(options.proxy);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Codex proxy must be an HTTP(S) URL without credentials, query or fragment');
    }
  }
  return openaiAsker((request) => complete(request, options, timeoutMs), { model: options.model });
}

async function complete(request: OpenAIJudgeRequest, options: CodexAskerOptions, timeoutMs: number): Promise<unknown> {
  const work = await mkdtemp(join(tmpdir(), 'fast-jev-codex-'));
  try {
    const schemaPath = join(work, 'schema.json'), replyPath = join(work, 'reply.json');
    await writeFile(schemaPath, JSON.stringify(request.text.format.schema));
    const usage = await new Promise<Record<string, unknown> | undefined>((finish, reject) => {
      const child = spawn(options.executable, [
        'exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', 'read-only',
        '--model', options.model, '--config', `model_reasoning_effort="${options.reasoningEffort ?? 'medium'}"`,
        '--config', 'web_search="disabled"', '--output-schema', schemaPath,
        '--output-last-message', replyPath, '--json', '--cd', work, '-',
      ], {
        env: { ...process.env, OPENAI_API_KEY: '', TYPESAFE_API_KEY: '', RUST_LOG: 'error',
          ...(options.proxy ? { HTTP_PROXY: options.proxy, HTTPS_PROXY: options.proxy } : {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let buffer = '', tokens: Record<string, unknown> | undefined;
      let failed = false, completed = false, settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true; clearTimeout(timer); child.kill(); reject(error);
      };
      const timer = setTimeout(() => fail(new Error(`Codex judge timed out after ${timeoutMs} ms`)), timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        if (buffer.length > 1_000_000) { fail(new Error('Codex judge event exceeded size limit')); return; }
        const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
        for (const line of lines) {
          let event: Record<string, unknown>;
          try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          if (event.type === 'turn.completed') { completed = true; tokens = event.usage as Record<string, unknown> | undefined; }
          if (event.type === 'turn.failed' || event.type === 'error') failed = true;
          if (event.type === 'item.started' || event.type === 'item.completed') {
            const type = (event.item as { type?: string } | undefined)?.type;
            if (type && !['agent_message', 'reasoning'].includes(type)) {
              fail(new Error('Codex judge attempted a tool call')); return;
            }
          }
        }
      });
      // Drain diagnostics without copying response bodies or credentials into errors.
      child.stderr.resume();
      child.on('error', () => fail(new Error('Could not start the native Codex judge')));
      child.on('close', (code) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (code !== 0 || failed || !completed) reject(new Error(`Codex judge did not complete (exit ${code})`));
        else finish(tokens);
      });
      child.stdin.on('error', () => fail(new Error('Could not deliver the Codex judge request')));
      child.stdin.end(request.instructions + '\nDo not call tools, read files or continue the coding task. Score only the supplied data.\n' + request.input);
    });
    if ((await stat(replyPath)).size > 1_000_000) throw new Error('Codex judge reply exceeded size limit');
    return { status: 'completed', model: options.model, output_text: await readFile(replyPath, 'utf8'), usage };
  } finally {
    if (!resolve(work).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected Codex judge workspace');
    await rm(work, { recursive: true, force: true });
  }
}
