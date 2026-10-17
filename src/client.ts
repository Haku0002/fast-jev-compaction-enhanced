import { buildJevRequest, isRetryable, parseJevResponse, RequestTimeoutError, withRetry, type Sleeper } from './request.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

export interface JevClientOptions {
  /** Defaults to `process.env.TYPESAFE_API_KEY`. */
  apiKey?: string;
  /** Defaults to `jev-latest`. */
  model?: string;
  /** Defaults to the System One endpoint. */
  baseUrl?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Includes response-body reading; defaults to 30000 ms. */
  timeoutMs?: number;
  /**
   * Extra attempts for a retryable failure: a dropped connection, a timeout,
   * a rate limit, a server error. A flaky link or proxy otherwise loses the
   * whole round. Defaults to 2.
   */
  retries?: number;
  /** First pause between attempts, doubling; defaults to 1500 ms. */
  retryDelayMs?: number;
  /** The host's timer, so a pause is cancelled with the round. */
  sleep?: Sleeper;
}

/** Asks Jev over HTTP with the global `fetch` (or an injected one). */
export class JevClient implements JevAsker {
  private readonly apiKey: string;
  private readonly model: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number | undefined;
  private readonly sleep: Sleeper | undefined;

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY ?? '';
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('timeoutMs must be positive');
    this.retries = options.retries ?? 2;
    this.retryDelayMs = options.retryDelayMs;
    this.sleep = options.sleep;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    if (!this.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
    return withRetry(() => this.attempt(state, questions), {
      retries: this.retries,
      // A dropped connection, a rate limit or a server error is worth another attempt; this
      // client's own timeout is not, since a second wait spends the same budget on the same
      // slow server and delays the step that is waiting for the round.
      shouldRetry: (error) => !(error instanceof RequestTimeoutError) && isRetryable(error),
      ...(this.retryDelayMs === undefined ? {} : { delayMs: this.retryDelayMs }),
      ...(this.sleep === undefined ? {} : { sleep: this.sleep }),
    });
  }

  private async attempt(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    const request = buildJevRequest(
      { apiKey: this.apiKey, model: this.model, baseUrl: this.baseUrl },
      state,
      questions,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
        redirect: 'error',
      });
      const delay = response.headers.get('retry-after');
      return parseJevResponse(response.status, response.ok, await response.text(), delay ? { 'retry-after': delay } : undefined);
    } catch (error) {
      if (controller.signal.aborted) throw new RequestTimeoutError(`Jev request timed out after ${this.timeoutMs} ms`);
      throw error;
    } finally { clearTimeout(timer); }
  }
}
