import { describe, expect, it } from 'vitest';
import { codexRolloutInput, compactResponsesInput, type JevAsker, type ResponsesItem } from '../src/index.js';

function judge(score: number): JevAsker {
  return { ask: async (_state, questions) => ({ answers: Object.fromEntries(Object.keys(questions).map((name) => [name, { noul: score }])) }) };
}

function transcript(): ResponsesItem[] {
  return [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Keep public API stable' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the parser' }] },
    { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'opaque' },
    { type: 'function_call', id: 'f1', call_id: 'a', name: 'exec_command', namespace: 'functions', arguments: '{ "cmd": "npm test" }', status: 'completed', custom_metadata: 5 },
    { type: 'function_call_output', id: 'o1', call_id: 'a', output: 'BEGIN\n' + 'data\n'.repeat(200) + 'FAIL parser: exit 1', custom_metadata: 6 },
    { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'The parser failed', annotations: [] }] },
    { type: 'compaction', encrypted_content: 'opaque-compaction' },
    { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Fix ready' }] },
    { type: 'future_item', payload: { bytes: 'opaque' } },
  ];
}

describe('native Responses history', () => {
  it('retains exact objects, phases, privileged roles and opaque data when kept', async () => {
    const input = transcript();
    const result = await compactResponsesInput(input, judge(1), { preserveRecentMessages: 0 });
    expect(result.input).toEqual(input);
    expect(result.contextChanged).toBe(false);
    result.input.forEach((item, index) => expect(item).toBe(input[index]));
  });

  it('truncates only a paired result, preserving its tail and all other metadata', async () => {
    const input = transcript();
    const asker: JevAsker = { ask: async (_state, questions) => ({ answers: Object.fromEntries(Object.keys(questions).map((name) => [name, { noul: name.startsWith('call_') ? 0.9 : 0.1 }])) }) };
    const result = await compactResponsesInput(input, asker, { preserveRecentMessages: 0 });
    expect(result.input[4]).toMatchObject({ id: 'o1', call_id: 'a', custom_metadata: 6 });
    expect(result.contextChanged).toBe(true);
    expect(result.input[4]!.output).toContain('FAIL parser: exit 1');
    expect((result.input[4]!.output as string).length).toBeLessThan((input[4]!.output as string).length);
    result.input.forEach((item, index) => { if (index !== 4) expect(item).toBe(input[index]); });
  });

  it('protects incomplete, ambiguous, encrypted and multimodal tool pairs', async () => {
    for (const tweak of [
      (input: ResponsesItem[]) => { input.pop(); input.splice(4, 1); },
      (input: ResponsesItem[]) => { input.push({ ...input[4] }); },
      (input: ResponsesItem[]) => { input[3]!.status = 'in_progress'; },
      (input: ResponsesItem[]) => { input[3]!.arguments = '{broken'; },
      (input: ResponsesItem[]) => { input[3]!.encrypted_function_args = 'opaque'; },
      (input: ResponsesItem[]) => { input[4]!.output = [{ type: 'input_image', image_url: 'data:image/png;base64,opaque' }]; },
    ]) {
      const input = transcript(); tweak(input);
      const result = await compactResponsesInput(input, { ask: async () => { throw new Error('must not judge'); } }, { preserveRecentMessages: 0 });
      expect(result.input).toEqual(input);
      expect(result.protectedCalls).toHaveLength(1);
    }
  });

  it('scores and truncates native Codex text-array outputs while retaining the array wire shape', async () => {
    const input = transcript();
    input[4]!.output = [
      { type: 'input_text', text: 'first result\n' + 'data '.repeat(200) },
      { type: 'input_text', text: 'last result\nFAIL parser: exit 1' },
    ];
    const asker: JevAsker = { ask: async (_state, questions) => ({ answers: Object.fromEntries(Object.keys(questions).map((name) => [name, { noul: name.startsWith('call_') ? 0.9 : 0.1 }])) }) };
    const result = await compactResponsesInput(input, asker, { preserveRecentMessages: 0 });
    expect(result.stats.calls).toBe(1);
    expect(result.protectedCalls).toEqual([]);
    expect(result.input[4]).toMatchObject({ id: 'o1', call_id: 'a', custom_metadata: 6 });
    const output = result.input[4]!.output as { type: string; text: string }[];
    expect(output).toHaveLength(1);
    expect(output[0]!.type).toBe('input_text');
    expect(output[0]!.text).toContain('first result');
    expect(output[0]!.text).toContain('FAIL parser: exit 1');
    expect(output[0]!.text).toContain('truncated');
  });

  it('keeps text arrays unchanged when retained or when their blocks carry opaque metadata', async () => {
    for (const output of [
      [{ type: 'input_text', text: 'retained '.repeat(100) }],
      [{ type: 'input_text', text: 'source '.repeat(100), source: 'opaque-origin' }],
    ]) {
      const input = transcript(); input[4]!.output = output;
      const result = await compactResponsesInput(input, judge(1), { preserveRecentMessages: 0 });
      expect(result.input[4]).toBe(input[4]);
      expect(result.input[4]!.output).toBe(output);
    }
  });

  it('keeps pairing and original order for interleaved function and custom calls', async () => {
    const input: ResponsesItem[] = [
      { role: 'user', content: 'start' },
      { type: 'function_call', call_id: 'a', name: 'read', arguments: '{"path":"a"}' },
      { type: 'custom_tool_call', call_id: 'b', name: 'apply_patch', input: '*** Begin Patch\nraw input\n*** End Patch' },
      { type: 'custom_tool_call_output', call_id: 'b', output: 'patch '.repeat(150) },
      { type: 'function_call_output', call_id: 'a', output: 'file '.repeat(150) },
    ];
    const result = await compactResponsesInput(input, judge(0), { preserveRecentMessages: 0 });
    expect(result.input.map((item) => item.call_id)).toEqual(input.map((item) => item.call_id));
    expect(result.input[2]!.input).toBe(input[2]!.input);
    expect(result.input[3]!.output).toContain('dropped the');
    expect(result.input[4]!.output).toContain('dropped the');
  });

  it('carries the stub marker back into a long custom-tool input', async () => {
    const result = await compactResponsesInput([
      { type: 'message', role: 'user', content: 'test' },
      { type: 'custom_tool_call', call_id: 'a', name: 'apply_patch', input: 'patch '.repeat(300) },
      { type: 'custom_tool_call_output', call_id: 'a', output: [{ type: 'input_text', text: 'done '.repeat(200) }] },
    ], judge(0), { preserveRecentMessages: 0 });
    expect(result.input[1]!.input).toContain('[fast-jev-compaction abridged this input]');
    expect(result.input[1]!.input).toContain('patch ');
    expect(result.input[1]!.call_id).toBe('a');
  });

  it('marks a deleted call and removes only its output, without leaving an orphan', async () => {
    const input = transcript();
    const result = await compactResponsesInput(input, judge(0), { preserveRecentMessages: 0, dropCalls: 'delete' });
    expect(result.input.some((item) => item.call_id === 'a')).toBe(false);
    expect(result.input[3]).toMatchObject({ type: 'message', role: 'assistant', phase: 'commentary' });
    expect(JSON.stringify(result.input[3])).toContain('removed 1 tool call');
    expect(result.input.at(-1)).toBe(input.at(-1));
  });
});

describe('Codex offline exports', () => {
  it('uses replacement_history and ignores duplicated UI events', () => {
    const current = transcript();
    const jsonl = [
      { type: 'session_meta', payload: { id: 'session' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'old context' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'old context' } },
      { type: 'compacted', payload: { message: 'summary', replacement_history: current } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'next task' } },
    ].map((entry) => JSON.stringify(entry)).join('\n');
    const items = codexRolloutInput(jsonl);
    expect(items).toEqual([...current, { type: 'message', role: 'user', content: 'next task' }]);
    expect(JSON.stringify(items)).not.toContain('old context');
  });

  it('does not silently discard corrupt lines or invent unsupported legacy history', () => {
    expect(() => codexRolloutInput('{broken')).toThrow(/line 1/);
    expect(() => codexRolloutInput('{"type":"compacted","payload":{"message":"legacy"}}')).toThrow(/no usable replacement_history/);
  });
});
