import { EventEmitter } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

const runner = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: runner }));
import { codexAsker, type JevQuestions } from '../src/index.js';

const questions: JevQuestions = { call_t1: { type: 'noul', instructions: 'The call still matters' } };

function childFixture(mode: 'success' | 'tool' | 'failure') {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter & { resume(): void }; stdin: EventEmitter & { end(prompt: string): void }; kill(): boolean };
  child.stdout = new EventEmitter();
  child.stderr = Object.assign(new EventEmitter(), { resume: vi.fn() });
  child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', 1)); return true; });
  child.stdin = Object.assign(new EventEmitter(), { end(prompt: string) {
    const args = runner.mock.calls.at(-1)![1] as string[];
    const path = args[args.indexOf('--output-last-message') + 1]!;
    void (async () => {
      if (mode === 'tool') {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'item.started', item: { type: 'command_execution' } }) + '\n'));
        return;
      }
      if (mode === 'failure') { child.emit('close', 2); return; }
      const data = JSON.parse(prompt.split('\n').at(-1)!) as { questions: Record<string, unknown> };
      const schemaPath = args[args.indexOf('--output-schema') + 1]!;
      const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
      expect(schema.properties.answers.required).toEqual(Object.keys(data.questions));
      await writeFile(path, JSON.stringify({ answers: { call_t1: 0.9 } }));
      child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message' } }) + '\n'));
      child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 120, output_tokens: 14 } }) + '\n'));
      child.emit('close', 0);
    })();
  } });
  return child;
}

describe('Codex login judge/arbiter', () => {
  it('uses an explicit native executable, read-only ephemeral scope and no TypeSafe key in the child', async () => {
    runner.mockImplementation(() => childFixture('success'));
    const result = await codexAsker({ executable: 'native-codex', model: 'chosen-model', proxy: 'http://127.0.0.1:7897' }).ask({ goal: 'test' }, questions);
    const [executable, args, options] = runner.mock.calls.at(-1)!;
    expect(executable).toBe('native-codex');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--ignore-user-config');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(options.env).toMatchObject({ OPENAI_API_KEY: '', TYPESAFE_API_KEY: '', HTTPS_PROXY: 'http://127.0.0.1:7897' });
    expect(options.shell).toBeUndefined();
    expect(result.answers.call_t1).toEqual({ type: 'noul', noul: 0.9 });
    expect(result.usage).toEqual({ input_tokens: 120, output_tokens: 14 });
  });

  it('rejects a judge that attempts tools instead of accepting its response', async () => {
    runner.mockImplementation(() => childFixture('tool'));
    await expect(codexAsker({ executable: 'native-codex', model: 'chosen-model' }).ask({}, questions)).rejects.toThrow(/attempted a tool call/);
  });

  it('fails without a completed turn and validates proxy/model configuration before starting', async () => {
    runner.mockImplementation(() => childFixture('failure'));
    await expect(codexAsker({ executable: 'native-codex', model: 'chosen-model' }).ask({}, questions)).rejects.toThrow(/did not complete/);
    expect(() => codexAsker({ executable: 'native-codex', model: '' })).toThrow(/explicit model/);
    expect(() => codexAsker({ executable: 'native-codex', model: 'm', proxy: 'http://user:secret@host' })).toThrow(/without credentials/);
  });
});
