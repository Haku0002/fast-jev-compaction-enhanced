import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildOpenAIJudgeRequest, compact, JevClient, noulAnswer, OpenAIClient, openaiAsker, parseOpenAIJudgeResponse,
  type JevQuestions, type Message, type OpenAIJudgeRequest,
} from '../src/index.js';

const questions: JevQuestions = {
  call_t1: { type: 'noul', instructions: 'This call is still needed' },
  result_t1: { type: 'noul', instructions: 'This output is still needed' },
};
const reply = (answers: unknown) => ({
  status: 'completed', model: 'chosen-model',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ answers }) }] }],
  usage: { input_tokens: 60, output_tokens: 12 },
});

describe('OpenAI Responses judge', () => {
  it('requests a strict schema, retains full criteria and leaves storage and model choice explicit', async () => {
    let sent: OpenAIJudgeRequest | undefined;
    const asker = openaiAsker(async (request) => { sent = request; return reply({ call_t1: 0.8, result_t1: 0.1 }); }, { model: 'chosen-model' });
    const response = await asker.ask({ goal: 'fix parser', history: [] }, questions);
    expect(sent).toMatchObject({ model: 'chosen-model', store: false, text: { format: { type: 'json_schema', strict: true } } });
    expect(JSON.parse(sent!.input).questions).toEqual(questions);
    expect(sent!.reasoning).toBeUndefined();
    expect(response.answers).toEqual({ call_t1: { type: 'noul', noul: 0.8 }, result_t1: { type: 'noul', noul: 0.1 } });
    expect(response.usage).toEqual({ input_tokens: 60, output_tokens: 12 });
    expect(() => buildOpenAIJudgeRequest({}, questions, { model: '' })).toThrow(/explicit model/);
  });

  it('supports choice distributions without dropping their criteria', async () => {
    const choice: JevQuestions = { call_t1: { type: 'choice', instructions: 'Choose retention', criteria: { stub: 'obsolete', keep: 'input matters', keep_result: 'output needed' } } };
    const request = buildOpenAIJudgeRequest({}, choice, { model: 'chosen-model' });
    expect(JSON.parse(request.input).questions.call_t1.criteria).toEqual(choice.call_t1!.criteria);
    const parsed = parseOpenAIJudgeResponse(reply({ call_t1: { stub: 0.2, keep: 0.3, keep_result: 0.5 } }), choice);
    expect(parsed.answers.call_t1).toMatchObject({ type: 'choice', choice: 'keep_result', probabilities: { stub: 0.2, keep: 0.3, keep_result: 0.5 } });
    expect(parseOpenAIJudgeResponse(reply({ call_t1: { stub: 0.2 } }), choice).answers).toEqual({});
    expect(parseOpenAIJudgeResponse(reply({ call_t1: { stub: 1, keep: 1, keep_result: 1 } }), choice).answers).toEqual({});
  });

  it('fails closed on refusals, incomplete replies and JSON hidden in reasoning', () => {
    expect(() => parseOpenAIJudgeResponse({ ...reply({ call_t1: 1 }), status: 'incomplete' }, questions)).toThrow(/not completed/);
    expect(() => parseOpenAIJudgeResponse({ status: 'completed', output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: '{"answers":{"call_t1":1}}' }] }] }, questions)).toThrow(/malformed JSON/);
    expect(() => parseOpenAIJudgeResponse({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'refused' }] }] }, questions)).toThrow(/refused/);
    expect(parseOpenAIJudgeResponse(reply({ call_t1: -1, result_t1: '0.9junk' }), questions).answers).toEqual({});
  });

  it('preserves calls on explicit abstention and never fetches for empty questions', async () => {
    const complete = vi.fn(async () => reply({ call_t1: null, result_t1: null }));
    const asker = openaiAsker(complete, { model: 'chosen-model' });
    const messages: Message[] = [
      { role: 'user', text: 'inspect file', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: 'a.ts' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'result '.repeat(100) }] },
    ];
    const result = await compact(messages, asker, { preserveRecentMessages: 0 });
    expect(result.messages).toEqual(messages);
    expect(result.decisions[0]?.reason).toBe('unscored');
    await asker.ask({}, {});
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported score questions before invoking the provider', async () => {
    const complete = vi.fn();
    await expect(openaiAsker(complete, { model: 'chosen-model' }).ask({}, { score: { type: 'score', instructions: 'rank', criteria: ['a'] } })).rejects.toThrow(/does not support score/);
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('OpenAI HTTP transport', () => {
  afterEach(() => vi.useRealTimers());

  it('uses the selected endpoint and honors Retry-After without echoing error bodies', async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return requests.length === 1
        ? new Response('do-not-log-this-key', { status: 429, headers: { 'retry-after': '0' } })
        : Response.json(reply({ call_t1: 0.7, result_t1: 0.8 }));
    });
    const client = new OpenAIClient({ model: 'chosen-model', apiKey: 'test-key', baseUrl: 'http://localhost:1234/v1', fetch: fetcher });
    await client.ask({}, questions);
    expect(requests.map((request) => request.url)).toEqual(['http://localhost:1234/v1/responses', 'http://localhost:1234/v1/responses']);
    expect(requests[0]?.init?.redirect).toBe('error');
    expect(JSON.parse(requests[0]!.init!.body as string).store).toBe(false);
    const failed = new OpenAIClient({ model: 'chosen-model', apiKey: 'test-key', fetch: async () => new Response('do-not-log-this-key', { status: 401 }) });
    await expect(failed.ask({}, questions)).rejects.toThrow('OpenAI judge request failed (401)');
    expect(() => new OpenAIClient({ model: 'm', baseUrl: 'http://remote.example/v1' })).toThrow(/HTTPS/);
  });

  it('aborts a stalled request and clears its timer', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const client = new OpenAIClient({ model: 'm', apiKey: 'test-key', timeoutMs: 20, retries: 0,
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        signal = init!.signal as AbortSignal;
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    });
    const pending = expect(client.ask({}, questions)).rejects.toThrow(/timed out after 20/);
    await vi.advanceTimersByTimeAsync(20);
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('applies the deadline to body reading, not only receipt of HTTP headers', async () => {
    vi.useFakeTimers();
    const client = new OpenAIClient({ model: 'm', apiKey: 'test-key', timeoutMs: 10, retries: 0,
      fetch: async (_url, init) => ({ ok: true, status: 200, headers: new Headers(),
        text: () => new Promise<string>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('body aborted')))),
      }) as Response,
    });
    const pending = expect(client.ask({}, questions)).rejects.toThrow(/timed out after 10/);
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('also bounds the default Jev library transport and treats invalid probabilities as unscored', async () => {
    vi.useFakeTimers();
    const client = new JevClient({ apiKey: 'test-key', timeoutMs: 10,
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    const pending = expect(client.ask({}, questions)).rejects.toThrow(/Jev request timed out after 10/);
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
    expect(noulAnswer({ x: { noul: -1 } }, 'x')).toBeUndefined();
    expect(noulAnswer({ x: { noul: 1.01 } }, 'x')).toBeUndefined();
  });
});
