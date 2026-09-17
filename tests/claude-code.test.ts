import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  readTranscript,
  runClaudeHook,
  type JevQuestions,
} from '../src/index.js';

const tempDirs: string[] = [];

async function tempTranscript(lines: unknown[]): Promise<{
  directory: string;
  path: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'fast-jev-claude-'));
  tempDirs.push(directory);
  const path = join(directory, 'session.jsonl');
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join('\n'));
  return { directory, path };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('readTranscript', () => {
  it('parses text, tool results, tool uses, and skips malformed or sidechain entries', async () => {
    const { path } = await tempTranscript([
      { type: 'user', message: { role: 'user', content: 'Fix the parser.' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will inspect the test.' },
            { type: 'tool_use', name: 'Read', input: { file: 'src/parser.ts' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              content: [{ type: 'text', text: 'FAIL parser.test.ts' }],
            },
          ],
        },
      },
      { type: 'assistant', message: { role: 'assistant', content: 'Done.' } },
      { type: 'user', isMeta: true, message: { role: 'user', content: 'skip' } },
      { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: 'skip' } },
      { type: 'system', message: { role: 'system', content: 'skip' } },
      '{not json',
    ]);

    await expect(readTranscript(path)).resolves.toEqual([
      { role: 'user', content: 'Fix the parser.' },
      { role: 'assistant', content: 'I will inspect the test.' },
      { role: 'assistant', content: '[tool_use Read] {"file":"src/parser.ts"}' },
      { role: 'tool', content: 'FAIL parser.test.ts' },
      { role: 'assistant', content: 'Done.' },
    ]);
  });
});

describe('runClaudeHook', () => {
  it('snapshots the transcript for PreCompact', async () => {
    const { directory, path } = await tempTranscript([
      { type: 'user', message: { role: 'user', content: 'Keep this.' } },
    ]);

    const result = await runClaudeHook({
      hook_event_name: 'PreCompact',
      session_id: 'abc',
      transcript_path: path,
    }, { apiKey: 'test-key' });

    const snapshot = join(directory, '.fast-jev', 'abc.precompact.jsonl');
    expect(result).toEqual({ stdout: '', exitCode: 0 });
    await expect(readFile(snapshot, 'utf8')).resolves.toContain('Keep this.');
  });

  it('emits retained protected chunks, excludes chatter, and deletes the snapshot', async () => {
    const { directory, path } = await tempTranscript([
      { type: 'user', message: { role: 'user', content: 'Fix the parser test.' } },
      { type: 'assistant', message: { role: 'assistant', content: 'Hello there.' } },
      { type: 'user', message: { role: 'user', content: 'Remember the pending task.' } },
    ]);
    const precompact = await runClaudeHook({
      hook_event_name: 'PreCompact',
      session_id: 'abc',
      transcript_path: path,
    }, { apiKey: 'test-key' });
    expect(precompact.exitCode).toBe(0);

    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        state: { transcript: Array<{ id: string; text: string }> };
        questions: JevQuestions;
      };
      const answers = Object.fromEntries(
        Object.entries(body.questions).map(([id]) => {
          const chunkId = id.replace(/^(drop|kind)_/, '');
          const text = body.state.transcript.find((chunk) => chunk.id === chunkId)?.text ?? '';
          const kind = text.includes('Fix') ? 'user_instruction' : text.includes('pending') ? 'pending_task' : 'chatter';
          return [
            id,
            id.startsWith('drop_')
              ? { type: 'noul', noul: 0.95 }
              : { type: 'choice', choice: kind, confidence: 0.95, probabilities: { [kind]: 0.95 } },
          ];
        }),
      );
      return new Response(JSON.stringify({ answers }), { status: 200 });
    });

    const result = await runClaudeHook({
      hook_event_name: 'SessionStart',
      source: 'compact',
      session_id: 'abc',
      transcript_path: path,
    }, { apiKey: 'test-key', fetch: fetcher, maxContextChars: 500 });

    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(output.hookSpecificOutput.additionalContext).toContain('[user_instruction] (user) Fix the parser test.');
    expect(output.hookSpecificOutput.additionalContext).toContain('[pending_task] (user) Remember the pending task.');
    expect(output.hookSpecificOutput.additionalContext).not.toContain('Hello there.');
    await expect(readFile(join(directory, '.fast-jev', 'abc.precompact.jsonl'))).rejects.toThrow();
  });

  it('ignores SessionStart events that are not compact', async () => {
    const fetcher = vi.fn();
    const result = await runClaudeHook({
      hook_event_name: 'SessionStart',
      source: 'startup',
    }, { apiKey: 'test-key', fetch: fetcher });
    expect(result).toEqual({ stdout: '', exitCode: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports network errors without blocking Claude', async () => {
    const { path } = await tempTranscript([
      { type: 'user', message: { role: 'user', content: 'Keep this.' } },
    ]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const precompact = await runClaudeHook({
      hook_event_name: 'PreCompact',
      session_id: 'abc',
      transcript_path: path,
    }, { apiKey: 'test-key' });
    expect(precompact.exitCode).toBe(0);

    const result = await runClaudeHook({
      hook_event_name: 'SessionStart',
      source: 'compact',
      session_id: 'abc',
      transcript_path: path,
    }, {
      apiKey: 'test-key',
      fetch: vi.fn(async () => {
        throw new Error('network unavailable');
      }),
    });

    expect(result).toEqual({ stdout: '', exitCode: 0 });
    expect(error).toHaveBeenCalledWith('network unavailable');
  });
});
