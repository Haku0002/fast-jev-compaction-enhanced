import { describe, expect, it, vi } from 'vitest';
import {
  choiceAnswer,
  claudeAsker,
  collectToolCalls,
  compact,
  compactResponsesInput,
  estimateTokens,
  goalFromMessages,
  noulAnswer,
  openaiAsker,
  parseClaudeReply,
  planRequests,
  questionTokens,
  resolveOptions,
  retryAfterMs,
  withTimeout,
  type JevAsker,
  type JevQuestions,
  type Message,
  type ResponsesItem,
} from '../src/index.js';

/**
 * The seven behaviours the 0.8.0 audit reproduced from a snapshot. They live
 * here now so the snapshot can rot without taking them along, and each one
 * names the failure a consumer saw.
 */

const big = 'x'.repeat(2000);

/** One call whose result is large enough to stub, and a closing turn. */
function pair(id = 'A', tool = 'Read', input: Record<string, unknown> = { file_path: '/a.ts' }): Message[] {
  return [
    { role: 'user', text: 'fix it', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: big }] },
    { role: 'assistant', text: 'done', toolUses: [] },
  ];
}

/** Answers every question with one fixed noul probability. */
function noul(value: number): JevAsker {
  return { async ask(_s, questions) { return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: value }])) }; } };
}

describe('a choice answer keeps the result of the call it chose', () => {
  // Regression: the decider kept `keepResult` at 1 for every choice, so a
  // confident "stub" still sent the whole result (P1 of the audit).
  it('stubs a call answered "stub" at 99% confidence', async () => {
    const judge: JevAsker = {
      async ask(_s, questions) {
        return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, {
          type: 'choice' as const, choice: 'stub', confidence: 0.99,
          probabilities: { keep_result: 0.01, keep: 0, stub: 0.99 },
        }])) };
      },
    };
    const out = await compact(pair(), judge, { primitive: 'choice', preserveRecentMessages: 1, arbitrateBand: 0 });
    expect(out.decisions[0]).toMatchObject({ action: 'stub_call', reason: 'call_stubbed' });
    expect(out.decisions[0]!.keepCall).toBeLessThan(0.05);
    expect(out.decisions[0]!.keepResult).toBeGreaterThan(0.95);
    expect(out.messages[2]!.toolResults![0]!.text.length).toBeLessThan(200);
  });
});

describe('a malformed answer leaves the call unscored instead of crashing', () => {
  // Regression: `in` on a primitive threw, so one odd reply failed the round.
  it('reads a bare number and ignores an unusable one', () => {
    expect(noulAnswer({ call_t1: 0.9 } as never, 'call_t1')).toBe(0.9);
    expect(noulAnswer({ call_t1: '0.9' } as never, 'call_t1')).toBeUndefined();
    expect(choiceAnswer({ call_t1: { probabilities: 1 } } as never, 'call_t1')).toBeUndefined();
  });

  it('completes a round of flat numbers with nothing scored', async () => {
    const flat: JevAsker = { async ask(_s, q) { return { answers: Object.fromEntries(Object.keys(q).map((k) => [k, 0.1])) as never }; } };
    const out = await compact(pair(), flat, { preserveRecentMessages: 1 });
    // A bare number is a usable score, so nothing is left unscored.
    expect(out.stats.unscored).toBe(0);
    expect(out.decisions.map((d) => d.action)).toEqual(['stub_call']);
  });
});

describe('a Claude judge works with the choice primitive', () => {
  // Regression: the choice prompt asked for a shape parseClaudeReply could not
  // read, so Claude + choice always produced nothing.
  const claude = claudeAsker(async ({ prompt }) => {
    const names = [...prompt.matchAll(/^- (\w+):/gm)].map((m) => m[1]);
    return JSON.stringify(Object.fromEntries(names.map((n) => [n, 0.1])));
  });

  it('stubs through the choice primitive and the noul one alike', async () => {
    const choice = await compact(pair(), claude, { primitive: 'choice', preserveRecentMessages: 1 });
    expect(choice.decisions[0]!.action).toBe('stub_call');
    expect(choice.decisions[0]!.resultChars).toBe(big.length);
    const plain = await compact(pair(), claude, { preserveRecentMessages: 1 });
    expect(plain.decisions[0]!.action).toBe('stub_call');
  });
});

describe('parseClaudeReply survives the shapes a model actually emits', () => {
  const questions: JevQuestions = {
    call_t1: { type: 'noul', instructions: 'x' },
    result_t1: { type: 'noul', instructions: 'y' },
  };
  const scores = (reply: string) =>
    Object.fromEntries(Object.entries(parseClaudeReply(reply, questions).answers).map(([k, a]) => [k, a.noul]));

  it.each([
    ['a think block before the JSON', ' thinking{"call_t1": p}</think>\n{"call_t1":0.8,"result_t1":0.2}'],
    ['prose after the JSON', '{"call_t1":0.8,"result_t1":0.2}\n(format: {name: p})'],
    ['an answers wrapper', '{"answers":{"call_t1":0.8,"result_t1":0.2}}'],
    ['a fenced block', '```json\n{"call_t1":0.8,"result_t1":0.2}\n```'],
    ['a trailing comma', '{"call_t1":0.8,"result_t1":0.2,}'],
  ])('parses %s', (_label, reply) => {
    expect(scores(reply)).toEqual({ call_t1: 0.8, result_t1: 0.2 });
  });

  it('reads percentages whether quoted or bare', () => {
    expect(scores('{"call_t1":"15%","result_t1":"85%"}')).toEqual({ call_t1: 0.15, result_t1: 0.85 });
    expect(scores('{"call_t1":15,"result_t1":85}')).toEqual({ call_t1: 0.15, result_t1: 0.85 });
  });

  it('surfaces out-of-range answers rather than inventing scores', () => {
    expect(() => parseClaudeReply('{"call_t1":-3,"result_t1":7}', questions)).toThrow(/answered none/);
  });
});

describe('a repeated raw tool-call id keeps its own pairing', () => {
  // Regression: two calls sharing an id mis-paired, so a kept Read received the
  // result of the following Bash call.
  const repeated = (): Message[] => [
    { role: 'user', text: 'task', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'call_0', tool: 'Read', input: { file_path: '/a.ts' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'call_0', text: 'A'.repeat(3000) }] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'call_0', tool: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'call_0', text: 'B'.repeat(3000) }] },
    { role: 'assistant', text: 'ok', toolUses: [] },
  ];

  it('numbers the duplicate and pins both, since the id alone cannot say which result is whose', async () => {
    const calls = collectToolCalls(repeated(), 1);
    expect(calls.map((c) => c.id)).toEqual(['t1', 't2']);
    expect(calls.map((c) => c.pinned)).toEqual([true, true]);
    const out = await compact(repeated(), noul(0.05), { preserveRecentMessages: 1 });
    expect(out.messages[2]!.toolResults![0]!.text).toBe('A'.repeat(3000));
    expect(out.messages[4]!.toolResults![0]!.text).toBe('B'.repeat(3000));
  });
});

describe('the arbiter is a second opinion, never a failure point', () => {
  // Regression: one throwing arbiter failed a round the judge had completed.
  it("keeps the judge's decisions when the arbiter throws", async () => {
    const judge = noul(0.45);
    const flaky: JevAsker = { async ask() { throw new Error('arbiter timed out after 90000 ms'); } };
    const withArbiter = await compact(pair(), judge, { preserveRecentMessages: 1, arbitrateBand: 0.5, arbiter: flaky });
    const without = await compact(pair(), judge, { preserveRecentMessages: 1, arbitrateBand: 0.5 });
    expect(withArbiter.decisions.map((d) => d.action)).toEqual(without.decisions.map((d) => d.action));
    expect(withArbiter.stats.arbiterFailures).toBeGreaterThan(0);
  });
});

describe('supersede hints stay to the cases that really supersede', () => {
  const hints = (uses: Array<[string, Record<string, unknown>]>) => {
    const messages: Message[] = [{ role: 'user', text: 't', toolUses: [] }];
    uses.forEach(([tool, input], index) => {
      messages.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: `u${index}`, tool, input }] });
      messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `u${index}`, text: 'r' }] });
    });
    return collectToolCalls(messages, 0).map((call) => `${call.id}${call.supersededBy ? `->${call.supersededBy}` : ''}`);
  };

  it('treats a whitespace-only command difference as the same call', () => {
    expect(hints([['Bash', { command: 'npm  test' }], ['Bash', { command: 'npm test' }]])).toEqual(['t1->t2', 't2']);
  });

  // 0.8.0 decided these are different work: another glob, another directory,
  // another query, and a read after an edit.
  it.each([
    ['another glob', [['Grep', { pattern: 'TODO', glob: '*.ts' }], ['Grep', { pattern: 'TODO', glob: '*.md' }]]],
    ['another workdir', [['exec_command', { cmd: 'npm test', workdir: '/a' }], ['exec_command', { cmd: 'npm test', workdir: '/b' }]]],
    ['another query', [['mcp__x__search', { path: 'src', query: 'foo' }], ['mcp__x__search', { path: 'src', query: 'bar' }]]],
    ['a read after an edit', [['Edit', { file_path: '/a.ts', old_string: 'x', new_string: 'y' }], ['Read', { file_path: '/a.ts' }]]],
  ])('does not hint through %s', (_label, uses) => {
    expect(hints(uses as Array<[string, Record<string, unknown>]>)).toEqual(['t1', 't2']);
  });
});

describe('withTimeout', () => {
  // Regression: a rejecting sleep left an unhandled rejection behind.
  it('resolves the wrapped promise even when the sleeper rejects', async () => {
    const slow = Promise.withResolvers<string>();
    setTimeout(() => slow.resolve('done'), 20);
    await expect(withTimeout(slow.promise, 5, () => Promise.reject(new Error('sleep aborted')))).resolves.toBe('done');
  });

  it('does not hold the process for the full deadline', async () => {
    const started = Date.now();
    await withTimeout(Promise.resolve('fast'), 1000, (ms) => new Promise((r) => setTimeout(r, ms)));
    expect(Date.now() - started).toBeLessThan(300);
  });
});

describe('a partially unscored judge result still decides the rest', () => {
  // Regression: a null for one question rejected the whole round.
  const openai = openaiAsker(async (req) => {
    const names = Object.keys(JSON.parse(req.input).questions);
    return {
      status: 'completed',
      output_text: JSON.stringify({ answers: Object.fromEntries(names.map((n) => [n, n.startsWith('call_') ? 0.1 : null])) }),
    };
  }, { model: 'm' });

  it('keeps the call and marks the null result unscored', async () => {
    const out = await compact(pair(), openai, { preserveRecentMessages: 1 });
    expect(out.decisions.map((d) => `${d.action}/${d.reason}`)).toEqual(['keep/unscored']);
  });
});

describe('planRequests under random shapes', () => {
  // Invariant: every candidate is asked exactly once and no request exceeds its
  // budget, whatever the mixture of prose, pairs and protected recent turns.
  it('covers 400 generated conversations without a coverage or budget problem', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T,>(values: T[]) => values[Math.floor(rnd() * values.length)]!;
    const words = ['alpha', 'beta', 'x1y2z3w4v5u6t7s8r9', 'const', '\n', '中文', '😀', 'QmFzZTY0U3RyaW5nSGVyZQ==', ' '];
    const text = (n: number) => { let s = ''; while (s.length < n) s += `${pick(words)} `; return s; };
    const problems: string[] = [];

    for (let trial = 0; trial < 400; trial += 1) {
      const n = 2 + Math.floor(rnd() * 25);
      const messages: Message[] = [{ role: 'user', text: text(50 + rnd() * 800), toolUses: [] }];
      for (let i = 0; i < n; i += 1) {
        const roll = rnd();
        if (roll < 0.15) messages.push({ role: 'user', text: text(rnd() * 2000), toolUses: [] });
        else if (roll < 0.25) messages.push({ role: 'assistant', text: text(rnd() * 900), toolUses: [] });
        const id = `id${i}`;
        const output = text(rnd() < 0.5 ? rnd() * 200 : rnd() * 6000);
        messages.push({ role: 'assistant', text: rnd() < 0.3 ? text(200) : '', toolUses: [{ tool_use_id: id, tool: pick(['Read', 'Bash', 'Grep']), input: { file_path: `/f${i % 4}`, body: text(rnd() * 1500) } }] });
        messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: output }] });
      }
      messages.push({ role: 'assistant', text: 'done', toolUses: [] });
      const preserve = Math.floor(rnd() * 8);
      const maxState = 300 + Math.floor(rnd() * 6000);
      const maxRequest = maxState + Math.floor(rnd() * 800);
      const options = resolveOptions({ preserveRecentMessages: preserve, maxStateTokens: maxState, maxRequestTokens: maxRequest, primitive: rnd() < 0.5 ? 'choice' : 'noul' });
      const calls = collectToolCalls(messages, preserve);
      const candidates = calls.filter((c) => !c.pinned);
      const plan = planRequests(messages, calls, candidates, { ...options, questionTokens: (c) => questionTokens(c, options) });
      const seen = new Map<string, number>();
      for (const request of plan.requests) for (const call of request.calls) seen.set(call.id, (seen.get(call.id) ?? 0) + 1);
      for (const call of plan.unscored) seen.set(call.id, (seen.get(call.id) ?? 0) + 1);
      for (const call of candidates) if (seen.get(call.id) !== 1) problems.push(`trial ${trial}: ${call.id} asked ${seen.get(call.id)}x`);
      for (const request of plan.requests) {
        const actual = estimateTokens(JSON.stringify(request.state));
        const questionCost = request.calls.reduce((sum, call) => sum + questionTokens(call, options), 0);
        if (actual > maxState || actual + questionCost > maxRequest) {
          problems.push(`trial ${trial}: ~${actual}+${questionCost} over ${maxState}/${maxRequest}`);
        }
      }
    }
    expect(problems.slice(0, 5)).toEqual([]);
  });
});

describe('Responses input mapping with interleaved and protected pairs', () => {
  // Regression: outputs were paired to calls by position, so B received A's
  // text once the outputs arrived out of order.
  it('maps by call_id and leaves an unparseable call alone', async () => {
    const body = (tag: string) => `${tag} `.repeat(400);
    const input: ResponsesItem[] = [
      { type: 'message', role: 'user', content: 'task' },
      { type: 'function_call', call_id: 'A', name: 'read', arguments: '{"path":"a"}' },
      { type: 'function_call', call_id: 'P', name: 'read', arguments: 'not json' },
      { type: 'function_call', call_id: 'B', name: 'read', arguments: '{"path":"b"}' },
      { type: 'function_call_output', call_id: 'B', output: body('B') },
      { type: 'function_call_output', call_id: 'P', output: body('P') },
      { type: 'function_call_output', call_id: 'A', output: body('A') },
      { type: 'custom_tool_call', call_id: 'C', name: 'apply_patch', input: 'x'.repeat(3000) },
      { type: 'custom_tool_call_output', call_id: 'C', output: body('C') },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
    ];
    const judge: JevAsker = { async ask(_s, q) {
      return { answers: Object.fromEntries(Object.keys(q).map((k) => [k, { noul: k.endsWith('_t2') ? 0.95 : 0.05 }])) };
    } };
    const result = await compactResponsesInput(input, judge, { preserveRecentMessages: 1, arbitrateBand: 0 });
    expect(result.decisions.map((d) => `${d.about}:${d.action}`)).toEqual(['a:stub_call', 'b:keep', expect.stringMatching(/:stub_call$/)]);
    const output = (id: string) => String((result.input.find((item) => item.call_id === id) as { output?: unknown } | undefined)?.output ?? '');
    expect(output('B')).toBe(body('B').trimEnd().slice(0, output('B').length));
    expect(output('A').length).toBeLessThan(200);
    expect(output('P')).toBe(body('P').trimEnd().slice(0, output('P').length));
  });
});

describe('small regressions around the edges of a round', () => {
  it('reads a fractional Retry-After as seconds', () => {
    expect(retryAfterMs({ 'retry-after': '1.5' })).toBe(1500);
    expect(retryAfterMs({ 'retry-after': '2' })).toBe(2000);
  });

  it('does not give a stubbed call a text it never had', async () => {
    const out = await compact(pair(), noul(0.05), { preserveRecentMessages: 1 });
    expect(out.messages[1]!.toolUses[0]!.text).toBeUndefined();
  });

  it('keeps a correction that arrived with a tool result', () => {
    expect(goalFromMessages([
      { role: 'user', text: 'old task', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'X', tool: 'Bash', input: { command: 'ls' } }] },
      { role: 'user', text: 'stop, use pnpm instead of npm', toolUses: [], toolResults: [{ tool_use_id: 'X', text: 'Interrupted' }] },
    ])).toBe('old task\nstop, use pnpm instead of npm');
  });

  it('counts a call as arbiter-reviewed even when the arbiter answers nothing', async () => {
    const fence = noul(0.45);
    const silent: JevAsker = { async ask() { return { answers: {}, unscored: ['call_t1', 'result_t1'] }; } };
    const out = await compact(pair(), fence, { preserveRecentMessages: 1, arbiter: silent });
    expect(out.stats.arbiterReviewed).toBe(1);
  });
});

describe('a limited window that fails', () => {
  // Regression: parallel requests later in a failed round produced unhandled
  // rejections and kept sending after the first failure.
  it('stops after the failing request and leaves no rejection unhandled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const messages: Message[] = [{ role: 'user', text: 'task', toolUses: [] }];
      for (let i = 0; i < 12; i += 1) {
        messages.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: `c${i}`, tool: 'Read', input: { file_path: `/f${i}` } }] });
        messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `c${i}`, text: 'z'.repeat(3000) }] });
      }
      messages.push({ role: 'assistant', text: 'done', toolUses: [] });
      let sent = 0;
      const failing: JevAsker = { async ask() { sent += 1; throw new Error(`fail ${sent}`); } };
      await expect(compact(messages, failing, { preserveRecentMessages: 1, maxStateTokens: 900, maxRequestTokens: 1200, concurrency: 4 }))
        .rejects.toThrow(/fail/);
      const settled = Promise.withResolvers<void>();
      setTimeout(settled.resolve, 50);
      await settled.promise;
      expect(sent).toBeLessThan(12);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      vi.useRealTimers();
    }
  });
});
