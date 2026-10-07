import { describe, expect, it } from 'vitest';
import {
  compactSession,
  decisionLines,
  decisionLog,
  decisionLogLines,
  probabilityProfile,
  libraryOptions,
  pickArbiter,
  resolveHookConfig,
  selectBackend,
  shouldCompact,
  summarize,
  toSessionMessages,
} from '../hooks/fast-jev.ts';
import { applyDecisions, collectToolCalls, decideCall, resolveOptions, type Message } from '../src/index.js';

type SessionMessage = Message & { handle?: string };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input, text }],
    handle: `h-${id}`,
  });
}

function result(id: string, text: string, isError = false): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }], handle: `r-${id}` });
}

const fileA = 'export const a = 1;\n'.repeat(50);

function transcript(): SessionMessage[] {
  return [
    message('user', 'Fix the failing test.', { handle: 'h-0' }),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    call('tool-2', 'Bash', { command: 'npm test' }, 'FAIL'),
    result('tool-2', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'Fixing now.', { handle: 'h-5' }),
    message('user', 'go ahead', { handle: 'h-6' }),
  ];
}

function jevFetch(answer: (name: string) => number, bodies: string[] = []) {
  return async (_url: string, init?: { body?: string }) => {
    bodies.push(init?.body ?? '');
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer(key) }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

const DEFAULT_CONFIG = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  model: 'jev-latest',
  backend: 'auto',
  claudeModel: 'haiku',
  nothingToPrune: 'keep',
  timeoutMs: 90_000,
  arbiterModel: 'haiku',
};

describe('hook config', () => {
  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual(DEFAULT_CONFIG);
    expect(
      resolveHookConfig({
        apiKey: 'k',
        keepThreshold: 0.3,
        keepCallThreshold: 0.4,
        maxStateTokens: 1000,
        model: 'jev-x',
        goal: 'g',
        compactAtPercent: 'no',
        dropCalls: 'delete',
        pruneMachineText: false,
        nothingToPrune: 'summary',
        stubChars: 50,
      }),
    ).toEqual({
      ...DEFAULT_CONFIG,
      apiKey: 'k',
      keepThreshold: 0.3,
      keepCallThreshold: 0.4,
      maxStateTokens: 1000,
      model: 'jev-x',
      goal: 'g',
      dropCalls: 'delete',
      pruneMachineText: false,
      nothingToPrune: 'summary',
      stubChars: 50,
    });
    expect(resolveHookConfig({ backend: 'claude', claudeModel: 'sonnet' })).toMatchObject({
      backend: 'claude',
      claudeModel: 'sonnet',
    });
    expect(resolveHookConfig({ backend: 'bogus', dropCalls: 'bogus', nothingToPrune: 'bogus' })).toMatchObject({
      backend: 'auto',
      nothingToPrune: 'keep',
    });
    expect(resolveHookConfig({ backend: 'fork' }).backend).toBe('fork');
    expect(resolveHookConfig({ arbiterModel: ' sonnet ' }).arbiterModel).toBe('sonnet');
    expect(resolveHookConfig({ arbiterModel: '' }).arbiterModel).toBe('');
    expect(resolveHookConfig({ arbitrateBand: 0.2 }).arbitrateBand).toBe(0.2);
    expect('dropCalls' in resolveHookConfig({ dropCalls: 'bogus' })).toBe(false);
  });

  it('selects jev only when a key is available in auto mode, and widens the Claude judge', () => {
    const base = resolveHookConfig({});
    expect(selectBackend(base)).toBe('claude');
    expect(selectBackend({ ...base, apiKey: 'k' })).toBe('jev');
    expect(selectBackend({ ...base, apiKey: 'k', backend: 'claude' })).toBe('claude');
    expect(selectBackend({ ...base, backend: 'jev' })).toBe('jev');
    expect(libraryOptions(base)).toMatchObject({ maxStateTokens: 80_000, maxRequestTokens: 100_000 });
    expect(libraryOptions({ ...base, maxStateTokens: 500 })).toMatchObject({ maxStateTokens: 500, maxRequestTokens: 100_000 });
    expect('maxStateTokens' in libraryOptions({ ...base, apiKey: 'k' })).toBe(false);
  });
});

describe('turn.complete trigger', () => {
  it('fires at the threshold once, then only after the context falls back or grows past it', () => {
    const memory = { armed: true, lastTriggered: 0 };
    expect(shouldCompact(50, 60, memory)).toBe(false);
    expect(shouldCompact(60, 60, memory)).toBe(true);
    expect(shouldCompact(62, 60, memory)).toBe(false);
    expect(shouldCompact(65, 60, memory)).toBe(false);
    expect(shouldCompact(70, 60, memory)).toBe(true);
    expect(shouldCompact(75, 60, memory)).toBe(false);
    expect(shouldCompact(55, 60, memory)).toBe(false);
    expect(shouldCompact(45, 60, memory)).toBe(false);
    expect(shouldCompact(61, 60, memory)).toBe(true);
  });
});

describe('session message mapping', () => {
  it('returns the engine objects for untouched messages and handle-less copies for rebuilt ones', () => {
    const messages = transcript();
    const options = { ...resolveOptions(), preserveRecentMessages: 0 };
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, options),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, options),
    ];
    const output = applyDecisions(messages, decisions, calls, options).messages;
    const mapped = toSessionMessages(messages, output);
    expect(mapped.map((m) => m.handle)).toEqual(['h-0', undefined, undefined, 'h-tool-2', 'r-tool-2', 'h-5', 'h-6']);
    expect(mapped[1]?.toolUses[0]?.text).toContain('[fast-jev-compaction truncated');
    expect(mapped[2]?.toolResults?.[0]).toMatchObject({ tool_use_id: 'tool-1', isError: false });
    expect(mapped[3]).toBe(messages[3]);
  });
});

describe('compactSession', () => {
  it('supports an explicit OpenAI backend with a separate key and model', async () => {
    const config = resolveHookConfig({ backend: 'openai', openaiModel: 'chosen-model', openaiApiKey: 'openai-test-key', apiKey: 'typesafe-test-key', preserveRecentMessages: 1 });
    const requests: { url: string; body: Record<string, unknown>; authorization?: string }[] = [];
    const { result } = await compactSession(transcript(), config, {
      fetch: async (url, init) => {
        const body = JSON.parse(init!.body!) as Record<string, unknown>;
        requests.push({ url, body, authorization: init?.headers?.authorization });
        const data = JSON.parse(body.input as string) as { questions: Record<string, unknown> };
        return { ok: true, status: 200, text: JSON.stringify({ status: 'completed', output_text: JSON.stringify({ answers: Object.fromEntries(Object.keys(data.questions).map((name) => [name, 0.9])) }) }) };
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: 'https://api.openai.com/v1/responses', authorization: 'Bearer openai-test-key', body: { model: 'chosen-model', store: false } });
    expect(result.stats.arbitrated).toBe(0);
    await expect(compactSession(transcript(), { ...config, openaiApiKey: undefined }, { fetch: jevFetch(() => 0) })).rejects.toThrow(/OPENAI_API_KEY/);
    await expect(compactSession(transcript(), { ...config, openaiModel: undefined }, { fetch: jevFetch(() => 0) })).rejects.toThrow(/openaiModel/);
    expect(selectBackend(resolveHookConfig({ openaiApiKey: 'k' }))).toBe('claude');
  });

  it('runs the library over the engine fetch and reports the outcome', async () => {
    const bodies: string[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k', model: 'jev-x' };
    const { result: output, messages } = await compactSession(transcript(), config, {
      fetch: jevFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1), bodies),
    });
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).model).toBe('jev-x');
    expect(output.decisions.map((d) => d.action)).toEqual(['stub_call', 'drop_result']);
    expect(messages.map((m) => m.handle)).toEqual(['h-0', undefined, undefined, 'h-tool-2', 'r-tool-2', 'h-5', 'h-6']);
    expect(messages[1]?.toolUses[0]?.text).toMatch(/^\[fast-jev-compaction dropped the 1000-char result/);
    // t2's result is too short to cut: kept, with its input bounded.
    expect(summarize(output)).toMatch(
      /^\d+% reduction; 1 kept, 1 stubbed; 1 request\(s\), largest state ~\d+ tokens, \d+ ms; call p: 0 <0.1, 1 <0.3, 0 <0.5, 1 ≥0.5 \| result p \(1 asked\): 0 <0.1, 1 <0.3, 0 <0.5, 0 ≥0.5$/,
    );
    expect(decisionLog(output)).toBe('t1:Read:stub_call/call=0.10/result=0.10 t2:Bash:drop_result/call=0.90/result=0.00');
    expect(decisionLines(output)).toEqual([
      '  t1 Read stub_call call=0.10 result=0.10 1000ch src/a.ts',
      '  t2 Bash drop_result call=0.90 result=- 34ch npm test',
    ]);
    expect(probabilityProfile({ ...output, decisions: [] })).toBe('');
    expect(decisionLogLines(output)).toEqual([`decisions: ${decisionLog(output)}`]);
  });

  it('removes calls outright in delete mode', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1, dropCalls: 'delete' }), apiKey: 'k' };
    const { messages } = await compactSession(transcript(), config, { fetch: jevFetch(() => 0.1) });
    expect(messages.map((m) => m.handle)).toEqual(['h-0', 'h-5', 'h-6']);
  });

  it('splits a long decision log into ui.log lines under the host limit', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    const { result: output } = await compactSession(transcript(), config, { fetch: jevFetch(() => 0.1) });
    const lines = decisionLogLines(output, 60);
    expect(lines).toEqual([
      'decisions (1/2): t1:Read:stub_call/call=0.10/result=0.10',
      'decisions (2/2): t2:Bash:stub_call/call=0.10/result=0.00',
    ]);
    expect(lines.every((line) => line.length <= 60)).toBe(true);
    expect(decisionLogLines({ ...output, decisions: [] })).toEqual(['decisions: (none)']);
  });

  it('retries a transient Jev failure once', async () => {
    let attempts = 0;
    const slept: number[] = [];
    // The recording sleeper resolves at once, so the timeout is off for this test.
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1, timeoutMs: 0 }), apiKey: 'k' };
    const flaky = jevFetch(() => 0.1);
    const { result: output } = await compactSession(transcript(), config, {
      fetch: async (url, init) => {
        attempts += 1;
        if (attempts === 1) return { status: 503, ok: false, text: 'busy' };
        return flaky(url, init);
      },
      sleep: async (ms) => void slept.push(ms),
    });
    expect(attempts).toBe(2);
    expect(slept).toEqual([1500]);
    expect(output.stats.requests).toBe(1);
  });

  it('sends the calls Jev was unsure about to the arbiter model, and only with the Jev judge', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1, arbiterModel: 'sonnet' }), apiKey: 'k' };
    const prompts: { model: string; prompt: string }[] = [];
    const complete = async (request: { model: string; prompt: string }) => {
      prompts.push(request);
      return '{"call_t1": 0.9, "result_t1": 0.2}';
    };
    const { result: output } = await compactSession(transcript(), config, {
      fetch: jevFetch((name) => (name === 'call_t1' ? 0.4 : 0.05)),
      complete,
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.model).toBe('sonnet');
    expect(prompts[0]?.prompt).toContain('- call_t1:');
    expect(prompts[0]?.prompt).not.toContain('- call_t2:');
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_result', 'stub_call']);
    expect(output.stats).toMatchObject({ arbitrated: 1, arbiterFlips: 1 });
    expect(summarize(output)).toContain('arbiter: 1 re-judged, 1 flipped');
    expect(decisionLines(output)[0]).toBe('  t1 Read drop_result call=0.90(jev 0.40) result=0.20(jev 0.05) 1000ch src/a.ts');

    expect(pickArbiter({ ...config, arbiterModel: '' }, { fetch: jevFetch(() => 0), complete })).toBeUndefined();
    expect(pickArbiter({ ...config, backend: 'claude' }, { fetch: jevFetch(() => 0), complete })).toBeUndefined();
    expect(pickArbiter(config, { fetch: jevFetch(() => 0) })).toBeUndefined();
  });

  it('paces a retry by Retry-After and gives up on one too long to wait for', async () => {
    const slept: number[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1, timeoutMs: 0 }), apiKey: 'k' };
    const good = jevFetch(() => 0.1);
    let attempts = 0;
    const { result: output } = await compactSession(transcript(), config, {
      fetch: async (url, init) => {
        attempts += 1;
        if (attempts === 1) return { status: 429, ok: false, text: 'busy', headers: { 'retry-after': '3' } };
        return good(url, init);
      },
      sleep: async (ms) => void slept.push(ms),
    });
    expect(attempts).toBe(2);
    expect(slept).toEqual([3000]);
    expect(output.stats.requests).toBe(1);

    let tries = 0;
    await expect(
      compactSession(transcript(), config, {
        fetch: async () => {
          tries += 1;
          return { status: 429, ok: false, text: 'busy', headers: { 'retry-after': '600' } };
        },
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(/429/);
    expect(tries).toBe(1);
  });

  it('scores through the Claude judge when no key is set, asking only the questions that matter', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    const prompts: string[] = [];
    const complete = async (request: { model: string; prompt: string }) => {
      prompts.push(request.prompt);
      expect(request.model).toBe('haiku');
      return '```json\n{"call_t1": 0.1, "result_t1": "0.05", "call_t2": 0.95}\n```';
    };
    const { result: output, messages } = await compactSession(transcript(), config, {
      fetch: jevFetch(() => 0),
      complete,
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('- call_t1:');
    expect(prompts[0]).toContain('- result_t1:');
    expect(prompts[0]).not.toContain('- result_t2:');
    expect(output.decisions.map((d) => d.action)).toEqual(['stub_call', 'drop_result']);
    expect(messages.map((m) => m.handle)).toEqual(['h-0', undefined, undefined, 'h-tool-2', 'r-tool-2', 'h-5', 'h-6']);
  });

  it('throws when the Claude judge answers badly so the hook falls back, but tolerates a partial answer', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    const fetch = jevFetch(() => 0);
    await expect(compactSession(transcript(), config, { fetch, complete: async () => 'nope' })).rejects.toThrow(/no JSON/);
    await expect(
      compactSession(transcript(), config, { fetch, complete: async () => '{"other": 0.1}' }),
    ).rejects.toThrow(/answered none/);
    const { result: partial } = await compactSession(transcript(), config, {
      fetch,
      complete: async () => '{"call_t1": 0.1, "result_t1": 0.1}',
    });
    expect(partial.decisions.map((d) => d.reason)).toEqual(['call_stubbed', 'unscored']);
    await expect(compactSession(transcript(), config, { fetch })).rejects.toThrow(/model\.complete/);
  });

  it('scores through a fork of the session when backend is fork: no state, a legend of tool_use_ids', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1, backend: 'fork' });
    expect(selectBackend(config)).toBe('fork');
    expect(libraryOptions(config).maxStateTokens).toBeGreaterThan(1_000_000);
    const prompts: string[] = [];
    const fork = async (request: { prompt: string }) => {
      prompts.push(request.prompt);
      return { text: '{"call_t1": 0.1, "result_t1": 0.1, "call_t2": 0.9}' };
    };
    const { result: output, messages } = await compactSession(transcript(), config, { fetch: jevFetch(() => 0), fork });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('- t1 = Read tool-1 (1000 chars)');
    expect(prompts[0]).toContain('- t2 = Bash tool-2 (34 chars, error)');
    expect(prompts[0]).toContain('CURRENT GOAL:');
    expect(prompts[0]).not.toContain('"history"');
    expect(prompts[0]).not.toContain(fileA.slice(0, 40));
    expect(output.decisions.map((d) => d.action)).toEqual(['stub_call', 'drop_result']);
    expect(messages.map((m) => m.handle)).toEqual(['h-0', undefined, undefined, 'h-tool-2', 'r-tool-2', 'h-5', 'h-6']);
    await expect(
      compactSession(transcript(), config, { fetch: jevFetch(() => 0), fork: async () => null }),
    ).rejects.toThrow(/fork unavailable/);
    await expect(compactSession(transcript(), config, { fetch: jevFetch(() => 0) })).rejects.toThrow(/model\.fork/);
  });

  it('gives up on a judge request that outlives timeoutMs', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1, timeoutMs: 10 }), apiKey: 'k' };
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const hung = () => new Promise<{ status: number; ok: boolean; text: string }>(() => undefined);
    await expect(compactSession(transcript(), config, { fetch: hung, sleep })).rejects.toThrow(
      /judge request timed out after 10 ms/,
    );
    const quick = resolveHookConfig({ timeoutMs: -5 });
    expect(quick.timeoutMs).toBe(0);
  });

  it('throws on a missing key and on failed requests so the hook falls back', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1, timeoutMs: 0 }), backend: 'jev' as const };
    await expect(compactSession(transcript(), config, { fetch: jevFetch(() => 0) })).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(
      compactSession(
        transcript(),
        { ...config, apiKey: 'k' },
        { fetch: async () => ({ status: 500, ok: false, text: 'x' }), sleep: async () => undefined },
      ),
    ).rejects.toThrow(/500/);
  });
});
