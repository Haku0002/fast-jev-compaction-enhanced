import { openaiAsker, OpenAIRequestError, type OpenAIAskerOptions, type OpenAIJudgeRequest } from './openai-asker.js';
import { retryAfterMs, withRetry } from './request.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

export interface OpenAIClientOptions extends OpenAIAskerOptions {
  /** Defaults to OPENAI_API_KEY. Credentials are never included in errors. */
  apiKey?: string;
  /** API root including /v1. Only an explicitly supplied URL selects another provider. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Covers fetch and response-body reading; defaults to 30000. */
  timeoutMs?: number;
  /** Defaults to one retry for network failures, 429 and server errors. */
  retries?: number;
}

/** Direct Responses transport. An existing SDK client can instead use openaiAsker. */
export class OpenAIClient implements JevAsker {
  private readonly options: OpenAIClientOptions;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenAIClientOptions) {
    if (!options.model?.trim()) throw new Error('OpenAI judge requires an explicit model');
    this.options = options;
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    const root = new URL(options.baseUrl ?? 'https://api.openai.com/v1');
    if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash) {
      throw new Error('baseUrl must be an HTTP API root without credentials, query or fragment');
    }
    if (root.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(root.hostname)) {
      throw new Error('Remote OpenAI endpoints require HTTPS');
    }
    this.endpoint = root.href.replace(/\/$/, '') + '/responses';
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('timeoutMs must be positive');
    if (options.retries !== undefined && (!Number.isInteger(options.retries) || options.retries < 0 || options.retries > 5)) {
      throw new Error('retries must be an integer from 0 to 5');
    }
  }

  private async complete(request: OpenAIJudgeRequest): Promise<unknown> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is not configured');
    return withRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetcher(this.endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(request),
          signal: controller.signal,
          redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel();
          const delay = response.headers.get('retry-after');
          throw new OpenAIRequestError(response.status, retryAfterMs(delay ? { 'retry-after': delay } : undefined));
        }
        const text = await response.text();
        try { return JSON.parse(text) as unknown; } catch { throw new Error('OpenAI endpoint returned malformed JSON'); }
      } catch (error) {
        if (controller.signal.aborted) throw new Error(`OpenAI judge request timed out after ${this.timeoutMs} ms`);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }, { retries: this.options.retries });
  }

  ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    return openaiAsker((request) => this.complete(request), this.options).ask(state, questions);
  }
}
