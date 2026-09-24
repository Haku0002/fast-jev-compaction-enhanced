import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** The HTTP request for one Jev call, for any fetch-like transport. */
export function buildJevRequest(
  params: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  return {
    url: params.baseUrl ?? SYSTEM_ONE_URL,
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model ?? DEFAULT_MODEL,
      state,
      questions,
    }),
  };
}

/** A failed Jev request: the status, and how long the server asked to wait before another try. */
export class JevRequestError extends Error {
  readonly status: number;
  /** From a `Retry-After` header, in milliseconds; undefined when the server gave none. */
  readonly retryAfterMs: number | undefined;

  constructor(status: number, body: string, retryAfterMs?: number) {
    super(`Jev request failed (${status}): ${body.slice(0, 200)}`);
    this.name = 'JevRequestError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Milliseconds a `Retry-After` header asks for: seconds, or an HTTP date; undefined when absent or unreadable. */
export function retryAfterMs(headers: Record<string, string> | undefined, now = Date.now()): number | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'retry-after');
  const value = key === undefined ? undefined : headers[key]?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** Validates a Jev response body; throws on anything but an `answers` object. */
export function parseJevResponse(
  status: number,
  ok: boolean,
  text: string,
  headers?: Record<string, string>,
): JevResponse {
  if (!ok) {
    throw new JevRequestError(status, text, retryAfterMs(headers));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Jev returned malformed JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('answers' in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== 'object'
  ) {
    throw new Error('Jev response is missing answers');
  }
  return parsed as JevResponse;
}

/**
 * The `noul` probability of one answer, or `undefined` when the judge left
 * the question unanswered or answered it with something that is not a finite
 * number. A missing answer leaves that one call unscored; it is never a
 * reason to fail the whole round.
 */
export function noulAnswer(
  answers: Record<string, JevAnswer>,
  name: string,
): number | undefined {
  const answer = answers[name];
  if (
    !answer ||
    !('noul' in answer) ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul)
  ) {
    return undefined;
  }
  return answer.noul;
}

/** Failures worth one more try: rate limits, server errors, a dropped connection, a timeout. */
const RETRYABLE = /\((429|5\d\d)\)|fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|socket|network|timed out/i;

export function isRetryable(error: unknown): boolean {
  return RETRYABLE.test(error instanceof Error ? error.message : String(error));
}

/** A pause on the host timer, or none where the module has no timer. */
function defaultSleep(ms: number): Promise<void> {
  const timer = (globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown }).setTimeout;
  return new Promise<void>((resolve) => (timer ? timer(resolve, ms) : resolve()));
}

/**
 * Runs `fn`, retrying a retryable failure `retries` times with a growing
 * pause. A failure that carries `retryAfterMs` (a 429 with `Retry-After`)
 * waits that long instead, up to `maxDelayMs`; a longer wait is not worth a
 * compaction's while, so the error is thrown as it is.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    retries?: number;
    delayMs?: number;
    maxDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const retries = options.retries ?? 1;
  const delayMs = options.delayMs ?? 1500;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= retries || !isRetryable(error)) throw error;
      const asked = error instanceof JevRequestError ? error.retryAfterMs : undefined;
      if (asked !== undefined && asked > maxDelayMs) throw error;
      await sleep(asked ?? delayMs * (attempt + 1));
    }
  }
}

/**
 * Rejects with `<what> timed out after <ms> ms` when `promise` has not
 * settled by then. The pending work is not cancelled (a fetch has no handle
 * here); the caller just stops waiting for it. No timeout without a sleeper.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  sleep: ((ms: number) => Promise<void>) | undefined,
  what = 'request',
): Promise<T> {
  if (!sleep || !(ms > 0)) return promise;
  let done = false;
  const timer = new Promise<never>((_, reject) => {
    void sleep(ms).then(() => {
      if (!done) reject(new Error(`${what} timed out after ${ms} ms`));
    });
  });
  return Promise.race<T>([promise, timer]).finally(() => {
    done = true;
  });
}
