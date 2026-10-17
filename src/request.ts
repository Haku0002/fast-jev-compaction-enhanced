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
  // Delay-seconds; a fractional value is not standard, but some servers send one.
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
  if (/^[\d.\s+-]+$/.test(value)) return undefined;
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
  const answer: unknown = answers[name];
  // A custom asker may hand back a bare probability instead of `{ noul }`.
  const value = typeof answer === 'number' ? answer : answer !== null && typeof answer === 'object' ? (answer as { noul?: unknown }).noul : undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return undefined;
  return value;
}

/**
 * The two probabilities a `choice` answer carries, or `undefined` when the
 * judge left the question unanswered or answered it without a usable
 * distribution. The options are the actions themselves, so the distribution
 * already holds both numbers the thresholds want, read as the nested decision
 * they are: a call is worth keeping at all with `1 - P(stub)`, and, given
 * that, its full result is worth keeping with `P(keep_result) / (1 -
 * P(stub))`. The conditional is the one that matches what the `noul`
 * question asked, so `keepThreshold` keeps its meaning; the raw share would
 * be diluted by the third option. A two-option question (no result worth
 * asking about) has no `keep_result`, and `keepResult` is then 0.
 */
export function choiceAnswer(
  answers: Record<string, JevAnswer>,
  name: string,
): { keepCall: number; keepResult: number; nested: true } | undefined {
  const answer: unknown = answers[name];
  if (answer === null || typeof answer !== 'object') return undefined;
  const p = (answer as { probabilities?: unknown }).probabilities;
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return undefined;
  const probabilities = p as Record<string, unknown>;
  const at = (key: string): number => {
    const value = probabilities[key];
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  };
  if (!('stub' in probabilities)) return undefined;
  const keepCall = Math.min(1, Math.max(0, 1 - at('stub')));
  if (!('keep_result' in probabilities)) return { keepCall, keepResult: 0, nested: true };
  const keepResult = keepCall > 0 ? Math.min(1, at('keep_result') / keepCall) : 0;
  // `keepResult` is conditional on keeping the call, so the call threshold is checked first.
  return { keepCall, keepResult, nested: true };
}

/** Failures worth one more try: rate limits, server errors, a dropped connection, a timeout. */
const RETRYABLE = /\((429|5\d\d)\)|fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|socket|network|timed out/i;

export function isRetryable(error: unknown): boolean {
  return RETRYABLE.test(error instanceof Error ? error.message : String(error));
}

/** A pause on the host timer, cancelled by `signal`; none where the module has no timer. */
export function defaultSleep(ms: number, options: { signal?: AbortSignal } = {}): Promise<void> {
  const g = globalThis as {
    setTimeout?: (fn: () => void, ms: number) => unknown;
    clearTimeout?: (handle: unknown) => void;
  };
  return new Promise<void>((resolve, reject) => {
    if (!g.setTimeout) {
      resolve();
      return;
    }
    if (options.signal?.aborted) {
      reject(new Error('sleep aborted'));
      return;
    }
    const handle = g.setTimeout(() => {
      options.signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      g.clearTimeout?.(handle);
      reject(new Error('sleep aborted'));
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
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
      const retryHint = error !== null && typeof error === 'object' && 'retryAfterMs' in error ? error.retryAfterMs : undefined;
      const asked = typeof retryHint === 'number' && Number.isFinite(retryHint) && retryHint >= 0 ? retryHint : undefined;
      if (asked !== undefined && asked > maxDelayMs) throw error;
      await sleep(asked ?? delayMs * (attempt + 1));
    }
  }
}

/**
 * A pause the caller can cancel. Hosts pass their own timer (Claude Code's
 * `$.clock.sleep(ms, { signal })`); a sleeper that ignores the signal still
 * works, it just keeps its timer until it fires.
 */
export type Sleeper = (ms: number, options?: { signal?: AbortSignal }) => Promise<void>;

/**
 * Rejects with `<what> timed out after <ms> ms` when `promise` has not
 * settled by then. The pending work is not cancelled (a fetch has no handle
 * here); the caller just stops waiting for it. The timer is cancelled as
 * soon as the promise settles. No timeout without a sleeper.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  sleep: Sleeper | undefined,
  what = 'request',
): Promise<T> {
  if (!sleep || !(ms > 0)) return promise;
  let done = false;
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  const timer = new Promise<never>((_, reject) => {
    // A sleeper that rejects (an aborted or cancelled timer) must not surface as an unhandled rejection.
    let pending: Promise<void>;
    try {
      pending = controller ? sleep(ms, { signal: controller.signal }) : sleep(ms);
    } catch {
      return;
    }
    void Promise.resolve(pending).then(
      () => {
        if (!done) reject(new Error(`${what} timed out after ${ms} ms`));
      },
      () => undefined,
    );
  });
  return Promise.race<T>([promise, timer]).finally(() => {
    done = true;
    controller?.abort();
  });
}
