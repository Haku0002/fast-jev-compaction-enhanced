import { describe, expect, it } from 'vitest';
import {
  abridgeInput,
  applyDecisions,
  buildJevRequest,
  collectToolCalls,
  compact,
  compactMessages,
  decideCall,
  estimateTokens,
  goalFromMessages,
  isRetryable,
  JevClient,
  parseJevResponse,
  planRequests,
  prunableShare,
  pruneMachineBlocks,
  questionsFor,
  questionTokens,
  reductionRatio,
  resolveOptions,
  stubInput,
  withRetry,
  type HistoryToolCall,
  type JevAsker,
  type JevQuestions,
  type Message,
} from '../src/index.js';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): Message {
  return message('assistant', '', { toolUses: [{ tool_use_id: id, tool, input, text }] });
}

function result(id: string, text: string, isError = false): Message {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }] });
}

const fileA = 'export const a = 1;\n'.repeat(50);
const fileB = 'export const b = 2;\n'.repeat(50);

function transcript(): Message[] {
  return [
    message('user', 'Never edit anything under src/generated. Fix the failing test.'),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    message('assistant', 'a.ts looks fine; checking b.ts'),
    call('tool-2', 'Read', { file_path: 'src/b.ts' }, fileB),
    result('tool-2', fileB),
    call('tool-3', 'Bash', { command: 'npm test' }, 'FAIL b.test.ts'),
    result('tool-3', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'The failure is in b.test.ts; fixing now.'),
    message('user', 'go ahead'),
  ];
}

/** `n` Read calls with a long result each, between a prompt and a closing line. */
function manyCalls(n: number, resultText = 'r'.repeat(600)): Message[] {
  const messages = [message('user', 'start')];
  for (let i = 0; i < n; i += 1) {
    messages.push(call(`c${i}`, 'Read', { file_path: `/repo/src/module-${i}.ts` }, resultText), result(`c${i}`, resultText));
  }
  messages.push(message('assistant', 'done'));
  return messages;
}

type Seen = { state: unknown; questions: string[] };

function fakeJev(answer: (name: string) => number, seen: Seen[] = []): JevAsker {
  return {
    async ask(state, questions: JevQuestions) {
      seen.push({ state, questions: Object.keys(questions) });
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [key, { type: 'noul' as const, noul: answer(key) }]),
        ),
      };
    },
  };
}

const defaults = resolveOptions();

function planOptions(overrides: Partial<Parameters<typeof planRequests>[3]> = {}) {
  return {
    maxStateTokens: 25_000,
    maxRequestTokens: 30_000,
    preserveRecentMessages: 0,
    goal: 'fix the test',
    questionTokens: (c: Parameters<typeof questionTokens>[0]) => questionTokens(c, defaults),
    ...overrides,
  };
}

describe('options', () => {
  it('fills in defaults and ignores non-finite or unknown values', () => {
    expect(resolveOptions()).toEqual({
      goal: '',
      keepThreshold: 0.5,
      keepCallThreshold: 0.5,
      preserveRecentMessages: 6,
      maxStateTokens: 25_000,
      maxRequestTokens: 30_000,
      truncateHeadChars: 300,
      dropCalls: 'stub',
      stubChars: 120,
      pruneMachineText: true,
      concurrency: 4,
    });
    expect(
      resolveOptions({
        keepThreshold: Number.NaN,
        preserveRecentMessages: 2.7,
        truncateHeadChars: -1.2,
        dropCalls: 'delete',
        concurrency: 0,
        pruneMachineText: false,
      }),
    ).toMatchObject({
      keepThreshold: 0.5,
      preserveRecentMessages: 2,
      truncateHeadChars: 0,
      dropCalls: 'delete',
      concurrency: 1,
      pruneMachineText: false,
    });
  });
});

describe('token estimate', () => {
  it('charges words, digits, CJK, dense runs and symbols separately', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello world')).toBe(2);
    expect(estimateTokens('internationalization')).toBe(4);
    expect(estimateTokens('12345678')).toBe(4);
    expect(estimateTokens('这是一个测试')).toBeGreaterThanOrEqual(6);
    expect(estimateTokens('3f9a8c2b1d4e5f6a7b8c9d0e1f2a3b4c')).toBeGreaterThanOrEqual(10);
    const json = JSON.stringify({ file_path: '/Users/x/src/a.ts', old_string: 'a = 1;', n: 42 });
    expect(estimateTokens(json)).toBeGreaterThanOrEqual(Math.ceil(json.length / 3));
  });
});

describe('tool call collection', () => {
  it('pairs each tool call with its result, pins recent ones and reads the result head', () => {
    const calls = collectToolCalls(transcript(), 3);
    expect(calls.map((c) => [c.id, c.tool, c.callIndex, c.resultIndex, c.pinned])).toEqual([
      ['t1', 'Read', 1, 2, false],
      ['t2', 'Read', 4, 5, false],
      ['t3', 'Bash', 6, 7, true],
    ]);
    expect(calls[2]?.isError).toBe(true);
    expect(calls[0]?.resultChars).toBe(fileA.length);
    expect(calls[0]?.resultHead.startsWith('export const a = 1; export const a = 1;')).toBe(true);
    expect(calls[0]?.inputChars).toBe(JSON.stringify({ file_path: 'src/a.ts' }).length);
    expect(calls.every((c) => !c.tombstone)).toBe(true);
  });

  it('ignores calls without a result and recognises notes left by an earlier round', () => {
    expect(collectToolCalls([message('user', 'hi'), call('x', 'Read', {}, '')], 0)).toHaveLength(0);
    const note = `${'x'.repeat(300)}\n[fast-jev-compaction truncated 1700 chars of this tool result; re-run the tool if needed]`;
    const calls = collectToolCalls([message('user', 'hi'), call('x', 'Read', {}, note), result('x', note)], 0);
    expect(calls[0]?.tombstone).toBe(true);
  });
});

describe('host blocks and goal', () => {
  it('cuts long machine-generated blocks in a user text and leaves the words around them', () => {
    const block = `<system-reminder>${'r'.repeat(1000)}</system-reminder>`;
    const text = `Fix it\n${block}\nplease`;
    const pruned = pruneMachineBlocks(text, 100);
    expect(pruned.startsWith('Fix it\n<system-reminder>')).toBe(true);
    expect(pruned.endsWith('</system-reminder>\nplease')).toBe(true);
    expect(pruned).toMatch(/\[fast-jev-compaction truncated \d+ chars of this <system-reminder> block\]/);
    expect(pruned.length).toBeLessThan(text.length / 2);
    const short = 'Fix it\n<system-reminder>short</system-reminder>';
    expect(pruneMachineBlocks(short, 100)).toBe(short);
    expect(pruneMachineBlocks('no blocks', 100)).toBe('no blocks');
  });

  it('builds the goal from human prompts only', () => {
    const goal = goalFromMessages([
      message('user', 'This session is being continued from a previous conversation. Summary: …'),
      message('user', 'Fix the parser'),
      message('assistant', 'ok'),
      message('user', '<command-name>/compact</command-name><command-message>compact</command-message>'),
      message('user', `<system-reminder>${'x'.repeat(50)}</system-reminder>\nthen add a test`),
      result('r', 'tool output'),
    ]);
    expect(goal).toBe('Fix the parser\nthen add a test');
  });
});

describe('request planning', () => {
  it('shows the window in full, framed by the first and newest messages', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 2);
    const { requests, unscored } = planRequests(messages, calls, calls, planOptions({ preserveRecentMessages: 2 }));
    expect(unscored).toHaveLength(0);
    expect(requests).toHaveLength(1);
    const { state, calls: asked } = requests[0]!;
    expect(asked.map((c) => c.id)).toEqual(['t1', 't2', 't3']);
    expect(state.goal).toBe('fix the test');
    const json = JSON.stringify(state);
    expect(json).not.toContain(fileA);
    expect(json).toContain('Never edit anything under src/generated');
    expect(json).toContain('go ahead');
    expect(state.history.map((entry) => entry.i)).toEqual([0, 1, 3, 4, 6, 8, 9]);
    const first = state.history[1]?.tool_calls?.[0] as HistoryToolCall;
    expect(first).toMatchObject({ id: 't1', tool: 'Read', input: JSON.stringify({ file_path: 'src/a.ts' }) });
    expect(first.result).toMatch(/^export const a = 1; .*… \(ok, 1000 chars\)$/);
    expect((state.history[4]?.tool_calls?.[0] as HistoryToolCall).result).toMatch(/\(error\)$/);
  });

  it('defaults the goal to the latest human prompts', () => {
    const { requests } = planRequests(transcript(), [], collectToolCalls(transcript(), 0), planOptions({ goal: '' }));
    expect(requests[0]?.state.goal).toContain('Fix the failing test');
    expect(requests[0]?.state.goal).toContain('go ahead');
  });

  it('cuts a long history into windows that each fit, and notes what a window leaves out', () => {
    const messages = manyCalls(40);
    const calls = collectToolCalls(messages, 1);
    const candidates = calls.filter((c) => !c.pinned);
    const options = planOptions({ preserveRecentMessages: 1, maxStateTokens: 1500, maxRequestTokens: 2000 });
    const { requests, unscored } = planRequests(messages, calls, candidates, options);
    expect(unscored).toHaveLength(0);
    expect(requests.length).toBeGreaterThan(3);
    expect(requests.flatMap((r) => r.calls.map((c) => c.id))).toEqual(candidates.map((c) => c.id));
    for (const request of requests) {
      expect(request.tokens).toBeLessThanOrEqual(1500);
      expect(estimateTokens(JSON.stringify(request.state))).toBeLessThanOrEqual(request.tokens);
      expect(request.state.history[0]?.text).toBe('start');
      expect(request.state.history.at(-1)?.text).toBe('done');
      for (const asked of request.calls) {
        expect(JSON.stringify(request.state)).toContain(`"id":"${asked.id}"`);
      }
    }
    const middle = requests[Math.floor(requests.length / 2)]!;
    const notes = middle.state.history.filter((entry) => entry.role === 'note');
    expect(notes).toHaveLength(2);
    expect(notes[0]?.text).toMatch(/^\[… messages \d+–\d+ not shown in this request: \d+ messages, \d+ tool calls …\]$/);
  });

  it('one-lines a window that does not fit in full, and gives up on what fits no way', () => {
    const messages = manyCalls(3, 'x');
    messages.splice(2, 0, message('assistant', 'lorem ipsum '.repeat(200)));
    const calls = collectToolCalls(messages, 0);
    const tight = planRequests(messages, calls, calls, planOptions({ maxStateTokens: 700, maxRequestTokens: 900 }));
    expect(tight.unscored).toHaveLength(0);
    expect(JSON.stringify(tight.requests[0]?.state)).toContain('chars omitted');
    const hopeless = planRequests(messages, calls, calls, planOptions({ maxStateTokens: 1, maxRequestTokens: 2 }));
    expect(hopeless.requests).toHaveLength(0);
    expect(hopeless.unscored.map((c) => c.id)).toEqual(calls.map((c) => c.id));
  });
});

describe('questions and decisions', () => {
  const large = { id: 't1', tool: 'Read', pinned: false, resultChars: 2000, tombstone: false };
  const small = { ...large, resultChars: 20 };
  const tombstone = { ...large, tombstone: true };

  it('asks about the result only when cutting it would change something', () => {
    expect(Object.keys(questionsFor(large, defaults))).toEqual(['call_t1', 'result_t1']);
    expect(Object.keys(questionsFor(small, defaults))).toEqual(['call_t1']);
    expect(Object.keys(questionsFor(tombstone, defaults))).toEqual(['call_t1']);
    expect(questionsFor(large, defaults).call_t1?.instructions).toContain('still depends on');
  });

  it('keeps, truncates, stubs or removes by the two thresholds', () => {
    expect(decideCall(large, { keepCall: 0.9, keepResult: 0.7 }, defaults).action).toBe('keep');
    expect(decideCall(large, { keepCall: 0.9, keepResult: 0.2 }, defaults).action).toBe('drop_result');
    expect(decideCall(large, { keepCall: 0.1, keepResult: 0.2 }, defaults).action).toBe('stub_call');
    expect(decideCall(large, { keepCall: 0.1, keepResult: 0.2 }, { ...defaults, dropCalls: 'delete' }).action).toBe(
      'drop_call',
    );
    expect(decideCall(small, { keepCall: 0.9, keepResult: 0.9 }, defaults).action).toBe('drop_result');
    expect(decideCall(large, { keepCall: 0.45, keepResult: 0.1 }, { ...defaults, keepCallThreshold: 0.4 }).action).toBe(
      'drop_result',
    );
    expect(decideCall({ ...large, pinned: true }, { keepCall: 0, keepResult: 0 }, defaults)).toMatchObject({
      action: 'keep',
      reason: 'pinned',
    });
  });
});

describe('applying decisions', () => {
  const options = { ...defaults, preserveRecentMessages: 0 };

  it('stubs unneeded calls, truncates dropped results and leaves kept ones alone', () => {
    const messages = transcript();
    messages[4]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[5]!.toolResults![0]!.text = 'x'.repeat(2000);
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.1, keepResult: 0.1 }, options),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.1 }, options),
      decideCall(calls[2]!, { keepCall: 0.9, keepResult: 0.9 }, options),
    ];
    const { messages: kept } = applyDecisions(messages, decisions, calls, options);
    expect(kept).toHaveLength(messages.length);
    expect(kept[0]).toBe(messages[0]);
    expect(kept[1]).not.toBe(messages[1]);
    expect(kept[1]?.toolUses[0]).toMatchObject({ tool: 'Read', input: { file_path: 'src/a.ts' } });
    expect(kept[1]?.toolUses[0]?.text).toBe(
      '[fast-jev-compaction dropped the 1000-char result of this call; re-run the tool if needed]',
    );
    expect(kept[2]?.toolResults?.[0]?.text).toBe(kept[1]?.toolUses[0]?.text);
    expect(kept[4]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(kept[5]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(kept[6]).toBe(messages[6]);
    expect(kept[7]?.toolResults?.[0]?.text).toContain('expected 2 to be 3');

    const shortMessages = transcript();
    shortMessages[4]!.toolUses[0]!.text = 'y'.repeat(100);
    shortMessages[5]!.toolResults![0]!.text = 'y'.repeat(100);
    const { messages: shortKept } = applyDecisions(shortMessages, decisions, calls, options);
    expect(shortKept[4]).toBe(shortMessages[4]);
    expect(shortKept[5]).toBe(shortMessages[5]);
  });

  it('removes calls in delete mode and marks the narration that loses them', () => {
    const messages = transcript();
    messages[1]!.text = 'Reading a.ts first.';
    const calls = collectToolCalls(messages, 0);
    const deleting = { ...options, dropCalls: 'delete' as const };
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.1, keepResult: 0.1 }, deleting),
      decideCall(calls[1]!, { keepCall: 0.1, keepResult: 0.1 }, deleting),
      decideCall(calls[2]!, { keepCall: 0.9, keepResult: 0.9 }, deleting),
    ];
    const { messages: kept } = applyDecisions(messages, decisions, calls, deleting);
    expect(kept.map((m) => m.text || m.toolUses[0]?.tool_use_id || m.toolResults?.[0]?.tool_use_id)).toEqual([
      'Never edit anything under src/generated. Fix the failing test.',
      `Reading a.ts first.\n[fast-jev-compaction removed 1 tool call(s) from this turn: Read(src/a.ts); this text is the assistant's report, not the tool record — re-verify with a tool before relying on it]`,
      'a.ts looks fine; checking b.ts',
      'tool-3',
      'tool-3',
      'The failure is in b.test.ts; fixing now.',
      'go ahead',
    ]);
    expect(kept[1]?.toolUses).toHaveLength(0);
  });

  it('cuts oversized input fields of a kept call and shrinks a stub to a few characters', () => {
    const content = 'x'.repeat(5000);
    const abridged = abridgeInput({ file_path: 'x.ts', content, n: 1 }, 300);
    expect(abridged.file_path).toBe('x.ts');
    expect(abridged.n).toBe(1);
    expect(abridged.content).toBe(`${'x'.repeat(300)}\n[fast-jev-compaction omitted 4700 chars of this field]`);
    const same = { file_path: 'x.ts', content: 'short' };
    expect(abridgeInput(same, 300)).toBe(same);

    const stub = stubInput({ file_path: 'x.ts', content }, 120);
    expect(stub.file_path).toBe('x.ts');
    expect(stub.content).toBe(`${'x'.repeat(116)}…`);
    expect(stub.note).toBe('[fast-jev-compaction abridged this input]');
    expect(stubInput(same, 120)).toBe(same);

    const messages = [message('user', 'start'), call('w', 'Write', { file_path: 'x.ts', content }, 'ok'), result('w', 'ok')];
    const calls = collectToolCalls(messages, 0);
    const { messages: kept } = applyDecisions(
      messages,
      [decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0 }, options)],
      calls,
      options,
    );
    expect(kept[1]?.toolUses[0]?.input.content).toMatch(/omitted 4700 chars/);
    expect(kept[1]?.toolUses[0]?.text).toBe('ok');
    expect(kept[2]).toBe(messages[2]);
  });

  it('honours truncateHeadChars, including a zero head', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, options)];
    const original = messages[2]!.toolResults![0]!.text;
    const total = original.length;

    const { messages: kept } = applyDecisions(messages, decisions, calls, { ...options, truncateHeadChars: 50 });
    expect(kept[2]?.toolResults?.[0]?.text).toBe(
      `${original.slice(0, 50)}\n[fast-jev-compaction truncated ${total - 50} chars of this tool result; re-run the tool if needed]`,
    );
    expect(kept[1]?.toolUses[0]?.text).toBe(kept[2]?.toolResults?.[0]?.text);

    const { messages: noHead } = applyDecisions(messages, decisions, calls, { ...options, truncateHeadChars: 0 });
    expect(noHead[2]?.toolResults?.[0]?.text).toBe(
      `[fast-jev-compaction truncated ${total} chars of this tool result; re-run the tool if needed]`,
    );
  });

  it('cuts host blocks in old user messages but not in pinned ones', () => {
    const block = `<task-notification>${'n'.repeat(2000)}</task-notification>`;
    const messages = [
      message('user', `Do the thing\n${block}`),
      message('assistant', 'ok'),
      message('user', `${block}\nnow this`),
      message('assistant', 'done'),
      message('user', block),
    ];
    const applied = applyDecisions(messages, [], [], { ...defaults, preserveRecentMessages: 1 });
    expect(applied.machineBlocksPruned).toBe(1);
    expect(applied.messages[0]).toBe(messages[0]);
    expect(applied.messages[2]?.text).toMatch(/truncated \d+ chars of this <task-notification> block/);
    expect(applied.messages[2]?.text.endsWith('</task-notification>\nnow this')).toBe(true);
    expect(applied.messages[4]).toBe(messages[4]);
    const off = applyDecisions(messages, [], [], { ...defaults, preserveRecentMessages: 1, pruneMachineText: false });
    expect(off.messages).toEqual(messages);
  });
});

describe('compact', () => {
  it('asks every candidate once across the windows and merges the answers', async () => {
    const seen: Seen[] = [];
    const messages = manyCalls(40, 'r'.repeat(2000));
    const output = await compact(messages, fakeJev((name) => (name.startsWith('call_') ? 0.9 : 0.1), seen), {
      preserveRecentMessages: 1,
      maxStateTokens: 1500,
      maxRequestTokens: 2000,
      concurrency: 3,
    });
    expect(output.stats.requests).toBe(seen.length);
    expect(seen.length).toBeGreaterThan(3);
    const asked = seen.flatMap((r) => r.questions).sort();
    const expected = Array.from({ length: 40 }, (_, i) => [`call_t${i + 1}`, `result_t${i + 1}`]).flat().sort();
    expect(asked).toEqual(expected);
    expect(new Set(seen.map((r) => JSON.stringify(r.state))).size).toBe(seen.length);
    expect(output.decisions.every((d) => d.action === 'drop_result')).toBe(true);
    expect(output.messages).toHaveLength(messages.length);
    expect(output.stats).toMatchObject({ resultsDropped: 40, kept: 0, callsStubbed: 0, unscored: 0, pinned: 0 });
    expect(output.stats.stateTokens).toBeLessThanOrEqual(1500);
    expect(reductionRatio(output)).toBeGreaterThan(0.5);
  });

  it('keeps everything without calling Jev when no tool call is a candidate', async () => {
    const seen: Seen[] = [];
    const messages = [message('user', 'hello'), message('assistant', 'hi')];
    const output = await compact(messages, fakeJev(() => 0, seen));
    expect(seen).toHaveLength(0);
    expect(output.stats).toMatchObject({ requests: 0, stateTokens: 0, calls: 0 });
    expect(output.messages).toEqual(messages);
  });

  it('keeps unscored candidates untouched', async () => {
    const seen: Seen[] = [];
    const output = await compact(transcript(), fakeJev(() => 0, seen), {
      preserveRecentMessages: 1,
      maxStateTokens: 1,
      maxRequestTokens: 2,
    });
    expect(seen).toHaveLength(0);
    expect(output.decisions.map((d) => d.reason)).toEqual(['unscored', 'unscored', 'unscored']);
    expect(output.messages).toEqual(transcript());
  });

  it('reports a tiny reduction when Jev wants everything kept', async () => {
    const output = await compact(transcript(), fakeJev(() => 0.95), { preserveRecentMessages: 1 });
    expect(output.decisions.map((d) => d.action)).toEqual(['keep', 'keep', 'drop_result']);
    expect(reductionRatio(output)).toBe(0);
  });

  it('rejects malformed answers', async () => {
    const broken: JevAsker = {
      ask: async () => ({ answers: { call_t1: { noul: 0.5 } } }),
    };
    await expect(compact(transcript(), broken, { preserveRecentMessages: 1 })).rejects.toThrow(
      /Invalid Jev answer/,
    );
  });

  it('measures how much of a history is prunable without a request', () => {
    expect(prunableShare(transcript(), { preserveRecentMessages: 1 })).toBeGreaterThan(0.8);
    expect(prunableShare([message('user', 'hello'), message('assistant', 'hi')])).toBe(0);
    expect(prunableShare([])).toBe(0);
  });
});

describe('retry', () => {
  it('retries a transient failure once and gives up on the rest', async () => {
    const slept: number[] = [];
    let attempts = 0;
    const flaky = async (): Promise<string> => {
      attempts += 1;
      if (attempts === 1) throw new Error('Jev request failed (429): slow down');
      return 'ok';
    };
    await expect(withRetry(flaky, { sleep: async (ms) => void slept.push(ms) })).resolves.toBe('ok');
    expect(slept).toEqual([1500]);
    await expect(
      withRetry(async () => {
        throw new Error('Jev request failed (400): bad');
      }),
    ).rejects.toThrow(/400/);
    expect(isRetryable(new Error('fetch failed'))).toBe(true);
    expect(isRetryable(new Error('Invalid Jev answer for x'))).toBe(false);
  });
});

describe('HTTP client', () => {
  it('builds a System One request', () => {
    const request = buildJevRequest({ apiKey: 'k' }, { a: 1 }, {
      q: { type: 'noul', instructions: 'x' },
    });
    expect(request.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(request.headers.authorization).toBe('Bearer k');
    expect(JSON.parse(request.body)).toEqual({
      model: 'jev-latest',
      state: { a: 1 },
      questions: { q: { type: 'noul', instructions: 'x' } },
    });
  });

  it('rejects failed and malformed responses', () => {
    expect(() => parseJevResponse(500, false, 'boom')).toThrow(/500/);
    expect(() => parseJevResponse(200, true, 'not json')).toThrow(/malformed/);
    expect(() => parseJevResponse(200, true, '{}')).toThrow(/missing answers/);
    expect(parseJevResponse(200, true, '{"answers":{}}')).toEqual({ answers: {} });
  });

  it('asks over fetch and refuses to run without a key', async () => {
    const bodies: string[] = [];
    const client = new JevClient({
      apiKey: 'k',
      model: 'jev-test',
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return new Response(JSON.stringify({ answers: { q: { noul: 0.4 } } }), { status: 200 });
      }) as typeof fetch,
    });
    const response = await client.ask('state', { q: { type: 'noul', instructions: 'x' } });
    expect(response.answers.q).toEqual({ noul: 0.4 });
    expect(JSON.parse(bodies[0]!).model).toBe('jev-test');

    const keyless = new JevClient({ apiKey: '' });
    await expect(keyless.ask('s', {})).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(
      compactMessages(transcript(), { apiKey: '', preserveRecentMessages: 1 }),
    ).rejects.toThrow(/TYPESAFE_API_KEY/);
  });
});
