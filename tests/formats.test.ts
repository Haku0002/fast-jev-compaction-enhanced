import { describe, expect, it } from 'vitest';
import {
  applyDecisions,
  callTarget,
  chatAsker,
  collectToolCalls,
  compact,
  compactResponsesInput,
  compactTranscript,
  decideCall,
  detectFormat,
  goalFromMessages,
  isChange,
  isCompactSummary,
  JevClient,
  parseJudgeReply,
  parseTranscript,
  probabilityOf,
  resolveOptions,
  retryAfterMs,
  stubInput,
  stripReasoning,
  withTimeout,
  type JevAsker,
  type JevQuestions,
  type Message,
} from '../src/index.js';

/** Answers every call question with `keepCall` and every result question with `keepResult`. */
function fixed(keepCall: number, keepResult: number): JevAsker {
  return {
    async ask(_state, questions) {
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((name) => [name, { noul: name.startsWith('call_') ? keepCall : keepResult }]),
        ),
      };
    },
  };
}

const long = 'line of tool output\n'.repeat(120);
const tail = (n: number) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `later ${i}` }));

describe('format detection', () => {
  it('recognises each history shape', () => {
    expect(detectFormat([{ role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }] }])).toBe('anthropic');
    expect(detectFormat([{ role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'f', arguments: '{}' } }] }])).toBe('openai-chat');
    expect(detectFormat([{ role: 'model', parts: [{ functionCall: { name: 'f', args: {} } }] }])).toBe('gemini');
    expect(detectFormat([{ type: 'function_call', call_id: 'a', name: 'f', arguments: '{}' }])).toBe('responses');
    expect(detectFormat([{ role: 'assistant', content: [{ type: 'tool-call', id: 'a', name: 'f', arguments: '{}' }] }])).toBe('ai-sdk');
    expect(detectFormat([{ role: 'user', text: 'x', toolUses: [] }])).toBe('messages');
    expect(detectFormat([{ type: 'assistant', message: { role: 'assistant', content: [] } }])).toBe('anthropic');
  });
});

describe('Anthropic Messages', () => {
  const history = [
    { role: 'user', content: 'Fix the parser. Never touch legacy/.' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'plan', signature: 'sig-1' },
        { type: 'text', text: 'Reading.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/a.ts' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: long }] }] },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_2', name: 'Screenshot', input: {} }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'image', source: { type: 'base64', data: 'AAAA' } }, { type: 'text', text: long }] }],
    },
    ...tail(6),
  ];

  it('truncates a text result in place and keeps thinking, signatures and images untouched', async () => {
    const out = await compactTranscript(history, fixed(0.9, 0.1));
    expect(out.format).toBe('anthropic');
    expect(out.history).toHaveLength(history.length);
    // The thinking block and its signature are the same object.
    expect((out.history[1] as { content: unknown[] }).content[0]).toBe(history[1]!.content[0]);
    const result = (out.history[2] as { content: { content: { text: string }[] }[] }).content[0]!;
    expect(result.content[0]!.text).toMatch(/fast-jev-compaction truncated \d+ chars/);
    expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
    // A result holding an image is pinned: never a candidate, so the same object.
    expect(out.history[4]).toBe(history[4]);
    expect(out.decisions.find((d) => d.tool_use_id === 'toolu_2')?.reason).toBe('pinned');
    // Untouched messages are the same objects.
    expect(out.history[0]).toBe(history[0]);
    expect(history[2]!.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: long }] }]);
  });

  it('removes a deleted call with its result and never leaves an orphan', async () => {
    const out = await compactTranscript(history, fixed(0.1, 0.1), { dropCalls: 'delete' });
    const ids = JSON.stringify(out.history);
    expect(ids).not.toContain('toolu_1');
    expect(ids).toContain('toolu_2');
    // The assistant turn keeps its thinking and narration, and says what was removed.
    const turn = out.history[1] as { content: { type: string; text?: string }[] };
    expect(turn.content.map((b) => b.type)).toEqual(['thinking', 'text']);
    expect(turn.content[1]!.text).toMatch(/^Reading\.\n\[fast-jev-compaction removed 1 tool call/);
    // The user message that held only the removed result is gone.
    expect(out.history).toHaveLength(history.length - 1);
  });

  it('reads Claude Code .jsonl lines and writes back inside the wrapper', async () => {
    const lines = history.map((message) => ({ type: message.role, uuid: `u-${Math.random()}`, message }));
    const out = await compactTranscript(lines, fixed(0.9, 0.1));
    expect(out.format).toBe('anthropic');
    const wrapped = out.history[2] as { uuid: string; message: { content: { content: { text: string }[] }[] } };
    expect(wrapped.uuid).toBe(lines[2]!.uuid);
    expect(wrapped.message.content[0]!.content[0]!.text).toMatch(/truncated/);
  });
});

describe('OpenAI Chat Completions', () => {
  const history = [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'Run the tests.' },
    {
      role: 'assistant',
      content: null,
      reasoning_content: 'thinking…',
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'npm test', note: 'mine' }) } },
        { id: 'call_b', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'x.ts' }) } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_a', content: long },
    { role: 'tool', tool_call_id: 'call_b', content: long },
    ...tail(6),
  ];

  it('keeps the system prompt, rewrites tool messages and stubs without clobbering a real `note` field', async () => {
    const out = await compactTranscript(history, fixed(0.1, 0.1));
    expect(out.format).toBe('openai-chat');
    expect(out.history[0]).toBe(history[0]);
    const assistant = out.history[2] as { reasoning_content: string; tool_calls: { id: string; function: { arguments: string } }[] };
    expect(assistant.reasoning_content).toBe('thinking…');
    expect(assistant.tool_calls.map((c) => c.id)).toEqual(['call_a', 'call_b']);
    const args = JSON.parse(assistant.tool_calls[0]!.function.arguments);
    expect(args).toMatchObject({ command: 'npm test', note: 'mine' });
    expect((out.history[3] as { content: string }).content).toMatch(/^\[fast-jev-compaction dropped the \d+-char result/);
  });

  it('deletes calls from tool_calls and drops their tool messages', async () => {
    const out = await compactTranscript(history, fixed(0.1, 0.1), { dropCalls: 'delete' });
    expect(JSON.stringify(out.history)).not.toMatch(/call_a|call_b/);
    const assistant = out.history[2] as Record<string, unknown>;
    expect(assistant.tool_calls).toBeUndefined();
  });

  it('pairs legacy function_call with the next function reply', () => {
    const parsed = parseTranscript([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, function_call: { name: 'f', arguments: '{"a":1}' } },
      { role: 'function', name: 'f', content: 'done' },
    ]);
    const calls = collectToolCalls(parsed.messages, 0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tool: 'f', input: { a: 1 }, resultChars: 4 });
  });
});

describe('Gemini', () => {
  const history = [
    { role: 'user', parts: [{ text: 'Check the weather and the file.' }] },
    {
      role: 'model',
      parts: [
        { functionCall: { name: 'read_file', args: { path: 'a.ts' } }, thoughtSignature: 'sig' },
        { functionCall: { name: 'read_file', args: { path: 'b.ts' } } },
      ],
    },
    {
      role: 'user',
      parts: [
        { functionResponse: { name: 'read_file', response: { output: long } } },
        { functionResponse: { name: 'read_file', response: { output: long } } },
      ],
    },
    ...tail(6).map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
  ];

  it('pairs id-less calls by name in order and never deletes a signed call', async () => {
    const out = await compactTranscript(history, fixed(0.1, 0.1), { dropCalls: 'delete' });
    expect(out.format).toBe('gemini');
    const model = out.history[1] as { parts: Record<string, unknown>[] };
    // The signed call stays exactly as it was; the unsigned one is deleted.
    expect(model.parts).toHaveLength(1);
    expect(model.parts[0]).toBe(history[1]!.parts[0]);
    const responses = (out.history[2] as { parts: { functionResponse: { response: { output: string } } }[] }).parts;
    expect(responses).toHaveLength(1);
    expect(responses[0]!.functionResponse.response.output).toMatch(/dropped the \d+-char result/);
  });
});

describe('AI SDK style messages', () => {
  it('reads tool-call blocks and role tool results, and recognises host messages', () => {
    const parsed = parseTranscript([
      { role: 'user', content: [{ type: 'text', text: 'Runtime snapshot' }], source: { kind: 'runtime-context' } },
      { role: 'user', content: [{ type: 'text', text: 'Do the task' }], source: { kind: 'user' } },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a"}' }] },
      { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'body' }] },
    ]);
    expect(parsed.format).toBe('ai-sdk');
    expect(parsed.messages[0]!.author).toBe('transient');
    expect(goalFromMessages(parsed.messages)).toBe('Do the task');
    expect(collectToolCalls(parsed.messages, 0)[0]).toMatchObject({ tool: 'read', input: { path: 'a' } });
  });
});

describe('core fixes', () => {
  it('never makes a result longer by stubbing it', () => {
    const messages: Message[] = [
      { role: 'user', text: 'go', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Bash', input: { command: 'true' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'ok', isError: false }] },
    ];
    const options = { ...resolveOptions(), preserveRecentMessages: 0 };
    const calls = collectToolCalls(messages, 0);
    const applied = applyDecisions(messages, [decideCall(calls[0]!, { keepCall: 0, keepResult: 0 }, options)], calls, options);
    expect(applied.messages[2]!.toolResults![0]!.text).toBe('ok');
  });

  it('does not overwrite a real `note` input field', () => {
    const stub = stubInput({ note: 'keep me', body: 'y'.repeat(500) }, 20);
    expect(stub.note).toBe('keep me');
    expect(stub._note).toBe('[fast-jev-compaction abridged this input]');
  });

  it('recognises the summaries of other hosts, and never takes host text as the goal', () => {
    expect(isCompactSummary('This is an automatically generated checkpoint condensing an earlier span of the conversation.')).toBe(true);
    expect(isCompactSummary('<compacted-summary>\n## Primary Request')).toBe(true);
    expect(isCompactSummary('<summary>old</summary>')).toBe(true);
    expect(isCompactSummary('Please summarise this file')).toBe(false);
    const goal = goalFromMessages([
      { role: 'user', text: 'Real request', toolUses: [] },
      { role: 'user', text: 'Current runtime context …', toolUses: [], author: 'transient' },
      { role: 'user', text: '<system-reminder>skills</system-reminder>', toolUses: [], author: 'host' },
    ]);
    expect(goal).toBe('Real request');
  });

  it('cuts an old transient host message but keeps host text that is still needed', () => {
    const snapshot = 'Current runtime context. '.repeat(100);
    const messages: Message[] = [
      { role: 'user', text: 'task', toolUses: [] },
      { role: 'user', text: snapshot, toolUses: [], author: 'transient' },
      { role: 'user', text: snapshot, toolUses: [], author: 'host' },
      { role: 'assistant', text: 'done', toolUses: [] },
    ];
    const applied = applyDecisions(messages, [], [], { ...resolveOptions(), preserveRecentMessages: 1 });
    expect(applied.messages[1]!.text).toMatch(/truncated \d+ chars of this host message\]$/);
    expect(applied.messages[2]).toBe(messages[2]);
  });

  it('supersedes across spellings of the same file and command', () => {
    const messages: Message[] = [
      { role: 'user', text: 'go', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'read', input: { filePath: 'C:\\repo\\a.ts' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'x' }] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'b', tool: 'edit', input: { path: 'C:/repo/a.ts' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'b', text: 'y' }] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'c', tool: 'sh', input: { cmd: ['npm', 'test'] } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c', text: 'z' }] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'd', tool: 'sh', input: { cmd: 'npm   test' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'd', text: 'w' }] },
    ];
    const calls = collectToolCalls(messages, 0);
    expect(calls[0]!.supersededBy).toBe('t2');
    expect(calls[2]!.supersededBy).toBe('t4');
  });

  it('reports the call id on every decision and aligns the output with the input', async () => {
    const messages: Message[] = [
      { role: 'user', text: 'go', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: 'a' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: long }] },
      { role: 'assistant', text: 'done', toolUses: [] },
    ];
    const result = await compact(messages, fixed(0.1, 0.1), { preserveRecentMessages: 1, dropCalls: 'delete' });
    expect(result.decisions[0]!.tool_use_id).toBe('a');
    expect(result.aligned.map((m) => m === null)).toEqual([false, true, true, false]);
  });
});

describe('audit fixes', () => {
  const big = 'x'.repeat(2000);
  const base = (): Message[] => [
    { role: 'user', text: 'fix it', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'A', tool: 'Read', input: { file_path: '/a.ts' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'A', text: big }] },
    { role: 'assistant', text: 'done', toolUses: [] },
  ];

  it('pins every call whose id is reused, so a decision cannot land on the wrong result', async () => {
    const A = 'A-output '.repeat(300);
    const messages: Message[] = [
      { role: 'user', text: 'task', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'c0', tool: 'Read', input: { file_path: '/a.ts' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c0', text: A }] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'c0', tool: 'Bash', input: { command: 'ls' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c0', text: A }] },
      { role: 'assistant', text: 'ok', toolUses: [] },
    ];
    const out = await compact(messages, fixed(0.05, 0.05), { preserveRecentMessages: 1 });
    expect(out.decisions.every((d) => d.reason === 'pinned')).toBe(true);
    expect(out.messages).toEqual(messages);
  });

  it('keeps the judge answers when the arbiter fails', async () => {
    const judge: JevAsker = { async ask(_s, q) { return { answers: Object.fromEntries(Object.keys(q).map((k) => [k, { noul: k === 'call_t1' ? 0.45 : 0.05 }])) }; } };
    const flaky: JevAsker = { async ask() { throw new Error('arbiter timed out'); } };
    const out = await compact(base(), judge, { preserveRecentMessages: 1, arbiter: flaky });
    expect(out.decisions[0]!.action).toBe('stub_call');
    expect(out.stats).toMatchObject({ arbitrated: 1, arbiterAnswered: 0, arbiterFailures: 1 });
  });

  it('reads a chat judge that answers a choice question with a probability, and a bare-number answer', async () => {
    const bare: JevAsker = { async ask(_s, q) { return { answers: Object.fromEntries(Object.keys(q).map((k) => [k, 0.1])) as never }; } };
    expect((await compact(base(), bare, { preserveRecentMessages: 1 })).stats.unscored).toBe(0);
    expect((await compact(base(), bare, { preserveRecentMessages: 1, primitive: 'choice' })).decisions[0]!.action).toBe('stub_call');
  });

  it('does not treat a different glob, directory or a later read as superseding', () => {
    const sup = (uses: Array<[string, Record<string, unknown>]>) => {
      const m: Message[] = [{ role: 'user', text: 't', toolUses: [] }];
      uses.forEach(([tool, input], i) => {
        m.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: `u${i}`, tool, input }] });
        m.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `u${i}`, text: 'r' }] });
      });
      return collectToolCalls(m, 0)[0]!.supersededBy;
    };
    expect(sup([['Grep', { pattern: 'TODO', glob: '*.ts' }], ['Grep', { pattern: 'TODO', glob: '*.md' }]])).toBeUndefined();
    expect(sup([['exec', { cmd: 'npm test', workdir: '/a' }], ['exec', { cmd: 'npm test', workdir: '/b' }]])).toBeUndefined();
    expect(sup([['Edit', { file_path: '/a.ts', old_string: 'x', new_string: 'y' }], ['Read', { file_path: '/a.ts' }]])).toBeUndefined();
    expect(sup([['Edit', { file_path: '/a.ts', old_string: 'x', new_string: 'y' }], ['Write', { file_path: '/a.ts', content: 'z' }]])).toBe('t2');
    expect(sup([['Read', { file_path: '/a.ts' }], ['Edit', { file_path: '/a.ts', old_string: 'x', new_string: 'y' }]])).toBe('t2');
  });

  it('keeps a call unscored, rather than failing the round, when part of its answer is null', async () => {
    const partial: JevAsker = {
      async ask(_s, q) {
        const names = Object.keys(q);
        return {
          answers: Object.fromEntries(names.filter((n) => n.startsWith('call_')).map((n) => [n, { noul: 0.1 }])),
          unscored: names.filter((n) => n.startsWith('result_')),
        };
      },
    };
    const out = await compact(base(), partial, { preserveRecentMessages: 1 });
    expect(out.decisions[0]).toMatchObject({ action: 'keep', reason: 'unscored' });
  });

  it('reads a 0-100 scale only when the whole reply uses it', () => {
    const questions: JevQuestions = { call_t1: { type: 'noul', instructions: 'a' }, result_t1: { type: 'noul', instructions: 'b' } };
    expect(parseJudgeReply('{"call_t1":85,"result_t1":15}', questions).answers).toMatchObject({ call_t1: { noul: 0.85 }, result_t1: { noul: 0.15 } });
    // 0.9 next to 7 is ambiguous: the 7 stays unscored rather than becoming 0.07.
    expect(parseJudgeReply('{"call_t1":0.9,"result_t1":7}', questions).answers).toEqual({ call_t1: { type: 'noul', noul: 0.9 } });
    expect(() => parseJudgeReply('{"call_t1":-3,"result_t1":700}', questions)).toThrow(/answered none/);
  });

  it('maps Responses decisions by call id even when outputs come back out of order', async () => {
    const big = (tag: string) => `${tag} `.repeat(400);
    const input = [
      { type: 'message', role: 'user', content: 'task' },
      { type: 'function_call', call_id: 'A', name: 'read', arguments: '{"path":"a"}' },
      { type: 'function_call', call_id: 'P', name: 'read', arguments: 'not json' },
      { type: 'function_call', call_id: 'B', name: 'read', arguments: '{"path":"b"}' },
      { type: 'function_call_output', call_id: 'B', output: big('B') },
      { type: 'function_call_output', call_id: 'P', output: big('P') },
      { type: 'function_call_output', call_id: 'A', output: big('A') },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
    ];
    const keepB: JevAsker = { async ask(_s, q) { return { answers: Object.fromEntries(Object.keys(q).map((k) => [k, { noul: k.endsWith('_t2') ? 0.95 : 0.05 }])) }; } };
    const res = await compactResponsesInput(input, keepB, { preserveRecentMessages: 1, arbitrateBand: 0 });
    const outputs = Object.fromEntries(res.input.filter((it) => typeof it.output === 'string').map((it) => [it.call_id, it.output as string]));
    expect(outputs.B).toBe(big('B'));
    expect(outputs.P).toBe(big('P'));
    expect(outputs.A).toMatch(/fast-jev-compaction dropped/);
  });

  it('takes a person\'s words typed next to a tool result as part of the goal', () => {
    const goal = goalFromMessages([
      { role: 'user', text: 'old task', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'X', tool: 'Bash', input: { command: 'ls' } }] },
      {
        role: 'user',
        text: '[Request interrupted by user for tool use]\nstop, use pnpm instead of npm',
        toolUses: [],
        toolResults: [{ tool_use_id: 'X', text: 'Interrupted' }],
      },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'Y', text: 'out' }] },
    ]);
    expect(goal).toBe('old task\nstop, use pnpm instead of npm');
  });

  it('cancels the timeout timer once the promise settles', async () => {
    let cancelled = false;
    const sleep = (ms: number, options?: { signal?: AbortSignal }) =>
      new Promise<void>((resolve, reject) => {
        const handle = setTimeout(resolve, ms);
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(handle);
          cancelled = true;
          reject(new Error('aborted'));
        });
      });
    expect(await withTimeout(Promise.resolve('fast'), 60_000, sleep)).toBe('fast');
    expect(cancelled).toBe(true);
  });

  it('reads a fractional Retry-After as seconds', () => {
    expect(retryAfterMs({ 'retry-after': '1.5' })).toBe(1500);
    expect(retryAfterMs({ 'Retry-After': '2' })).toBe(2000);
    expect(retryAfterMs({ 'retry-after': '-1' })).toBeUndefined();
  });

  it('counts the calls put to the arbiter even when it answers none of them', async () => {
    const judge: JevAsker = { async ask(_s, q) { return { answers: Object.fromEntries(Object.keys(q).map((k) => [k, { noul: k === 'call_t1' ? 0.45 : 0.05 }])) }; } };
    const silent: JevAsker = { async ask(_s, q) { return { answers: {}, unscored: Object.keys(q) }; } };
    const out = await compact(base(), judge, { preserveRecentMessages: 1, arbiter: silent });
    expect(out.stats).toMatchObject({ arbitrated: 1, arbiterAnswered: 0, arbiterFailures: 0 });
  });

  it('does not invent a result text for a call that carried none', () => {
    const messages: Message[] = [
      { role: 'user', text: 'go', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: 'x', body: 'y'.repeat(500) } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'z'.repeat(2000) }] },
    ];
    const options = { ...resolveOptions(), preserveRecentMessages: 0 };
    const calls = collectToolCalls(messages, 0);
    const applied = applyDecisions(messages, [decideCall(calls[0]!, { keepCall: 0, keepResult: 0 }, options)], calls, options);
    expect(applied.messages[1]!.toolUses[0]!.text).toBeUndefined();
    expect(applied.messages[2]!.toolResults![0]!.text).toMatch(/dropped the 2000-char result/);
  });

  it('reads a code-mode program for what it is about, so supersede works under a run_code preset', () => {
    // A code-mode agent calls its tools from inside one program, so the input is { code }
    // and the file, command and pattern keys are nowhere to be found.
    const read = (path: string) => ({ code: `const r = await tools.read({ file_path: '${path}' });\nreturn r;` });
    expect(callTarget('run_code', read('C:\\repo\\a.ts'))).toEqual({ key: 'file:C:/repo/a.ts' });
    expect(callTarget('run_code', { code: 'await tools.pwsh({ command: `npm   test` })' })).toEqual({ key: 'pwsh:npm test' });
    // Several calls in one program: its own key, so an identical re-run still matches.
    const multi = { code: 'await tools.read({ file_path: "a" }); await tools.read({ file_path: "b" });' };
    const key = callTarget('run_code', multi)!.key;
    expect(key).toMatch(/^code:[0-9a-f]+$/);
    expect(callTarget('run_code', { code: multi.code.replace(/ /g, '  ') })!.key).toBe(key);
    expect(callTarget('run_code', { code: 'await tools.read({ file_path: "a" }); await tools.read({ file_path: "c" });' })!.key).not.toBe(key);
    // A program that writes is a change, so a later read does not supersede it.
    expect(isChange('run_code', { code: 'await tools.write({ file_path: "a", content: "x" })' })).toBe(true);
    expect(isChange('run_code', read('a'))).toBe(false);

    const sup = (uses: Array<[string, Record<string, unknown>]>) => {
      const m: Message[] = [{ role: 'user', text: 't', toolUses: [] }];
      uses.forEach(([tool, input], i) => {
        m.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: `u${i}`, tool, input }] });
        m.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `u${i}`, text: 'r' }] });
      });
      return collectToolCalls(m, 0)[0]!.supersededBy;
    };
    // Two programs reading the same file: the first is superseded.
    expect(sup([['run_code', read('/a.ts')], ['run_code', read('/a.ts')]])).toBe('t2');
    // A program and a direct call share the key space.
    expect(sup([['run_code', read('/a.ts')], ['Read', { file_path: '/a.ts' }]])).toBe('t2');
    // A writing program is not superseded by a later read of the same file.
    expect(sup([['run_code', { code: 'await tools.write({ file_path: "/a.ts", content: "x" })' }], ['run_code', read('/a.ts')]])).toBeUndefined();
    // Different programs do not supersede each other.
    expect(sup([['run_code', read('/a.ts')], ['run_code', read('/b.ts')]])).toBeUndefined();
  });

  it('retries a dropped Jev connection instead of losing the round', async () => {
    let calls = 0;
    const flaky: typeof globalThis.fetch = async () => {
      calls += 1;
      if (calls < 3) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ model: 'jev-latest', answers: { call_t1: { type: 'noul', noul: 0.4 } } }), { status: 200 });
    };
    const client = new JevClient({ apiKey: 'k', fetch: flaky, sleep: async () => undefined });
    const response = await client.ask({ goal: 'g' }, { call_t1: { type: 'noul', instructions: 'a' } });
    expect(response.answers.call_t1).toEqual({ type: 'noul', noul: 0.4 });
    expect(calls).toBe(3);
  });

  it('does not leave an unhandled rejection when the sleeper rejects', async () => {
    const seen: unknown[] = [];
    const listener = (error: unknown) => seen.push(error);
    process.on('unhandledRejection', listener);
    try {
      const value = await withTimeout(new Promise((r) => setTimeout(() => r('done'), 20)), 10, () => Promise.reject(new Error('aborted')));
      await new Promise((r) => setTimeout(r, 20));
      expect(value).toBe('done');
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});

describe('judge replies from different models', () => {
  const questions: JevQuestions = {
    call_t1: { type: 'noul', instructions: 'a' },
    result_t1: { type: 'noul', instructions: 'b' },
  };
  const read = (text: string) => parseJudgeReply(text, questions).answers;

  it('reads plain, fenced, nested and listed answers', () => {
    expect(read('{"call_t1":0.9,"result_t1":0.2}')).toEqual({ call_t1: { type: 'noul', noul: 0.9 }, result_t1: { type: 'noul', noul: 0.2 } });
    expect(read('Sure!\n```json\n{"call_t1": 0.9, "result_t1": 0.2}\n```')).toMatchObject({ call_t1: { noul: 0.9 } });
    expect(read('{"answers":{"call_t1":{"noul":0.7},"result_t1":{"probability":0.1}}}')).toMatchObject({ call_t1: { noul: 0.7 }, result_t1: { noul: 0.1 } });
    expect(read('[{"name":"call_t1","probability":0.6},{"name":"result_t1","probability":0.3}]')).toMatchObject({ call_t1: { noul: 0.6 } });
  });

  it('skips reasoning that contains braces, before or around the answer', () => {
    const r1 = '<think>Maybe {"call_t1": 0.1} is wrong; consider {x}</think>\n{"call_t1":0.8,"result_t1":0.4}';
    expect(read(r1)).toMatchObject({ call_t1: { noul: 0.8 }, result_t1: { noul: 0.4 } });
    const unopened = 'reasoning here {not json} </think>{"call_t1":0.5,"result_t1":0.5}';
    expect(read(unopened)).toMatchObject({ call_t1: { noul: 0.5 } });
    expect(stripReasoning('<thinking>a</thinking>b')).toBe(' b');
  });

  it('forgives percentages, strings, 0-100 scales, trailing commas, comments and bare keys', () => {
    expect(read("{call_t1: '85%', result_t1: 20, // low\n}")).toMatchObject({ call_t1: { noul: 0.85 }, result_t1: { noul: 0.2 } });
    expect(read('{"call_t1": "0.9", "result_t1": "no"}')).toMatchObject({ call_t1: { noul: 0.9 }, result_t1: { noul: 0 } });
    expect(probabilityOf('yes')).toBe(1);
    expect(probabilityOf(150)).toBeUndefined();
    expect(probabilityOf(85)).toBeUndefined();
    expect(probabilityOf(85, true)).toBe(0.85);
  });

  it('falls back to name: value lines, and matches keys case-insensitively', () => {
    expect(read('call_t1: 0.9\nresult_t1 = 15%')).toMatchObject({ call_t1: { noul: 0.9 }, result_t1: { noul: 0.15 } });
    expect(read('{"CALL_T1":0.9}')).toMatchObject({ call_t1: { noul: 0.9 } });
  });

  it('treats null as unscored and an empty reply as an error', () => {
    const response = parseJudgeReply('{"call_t1":null,"result_t1":0.3}', questions);
    expect(response.unscored).toEqual(['call_t1']);
    expect(() => parseJudgeReply('I cannot help', questions)).toThrow(/no JSON object/);
    expect(() => parseJudgeReply('{"other":1}', questions)).toThrow(/answered none/);
  });
});

describe('OpenAI-compatible chat judge', () => {
  const questions: JevQuestions = { call_t1: { type: 'noul', instructions: 'a' } };

  it('reads content, ignores reasoning_content, and drops response_format when refused', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      bodies.push(body);
      if (body.response_format) {
        return new Response(JSON.stringify({ error: { message: 'response_format not supported' } }), { status: 400 });
      }
      return new Response(
        JSON.stringify({
          model: 'deepseek-reasoner',
          choices: [{ message: { role: 'assistant', reasoning_content: '{"call_t1":0.0}', content: '{"call_t1":0.75}' } }],
          usage: { prompt_tokens: 100, completion_tokens: 5 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;
    const asker = chatAsker({ model: 'deepseek-reasoner', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', fetch });
    const response = await asker.ask({ goal: 'g' }, questions);
    expect(response.answers.call_t1).toEqual({ type: 'noul', noul: 0.75 });
    expect(response.usage).toEqual({ input_tokens: 100, output_tokens: 5 });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.response_format).toBeUndefined();
    // The next request remembers the endpoint refused it.
    await asker.ask({ goal: 'g' }, questions);
    expect(bodies).toHaveLength(3);
    expect(bodies[2]!.response_format).toBeUndefined();
  });

  it('folds the system prompt into the user turn for an endpoint that rejects it', async () => {
    const bodies: { messages: { role: string }[] }[] = [];
    const fetch = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { messages: { role: string }[] };
      bodies.push(body);
      if (body.messages.some((m) => m.role === 'system')) return new Response('{"error":"system role not allowed"}', { status: 422 });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'call_t1: 0.4' } }] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const asker = chatAsker({ model: 'm', baseUrl: 'http://localhost:11434/v1', fetch, jsonMode: 'off' });
    const response = await asker.ask({}, questions);
    expect(response.answers.call_t1).toEqual({ type: 'noul', noul: 0.4 });
    expect(bodies.at(-1)!.messages).toHaveLength(1);
  });
});
