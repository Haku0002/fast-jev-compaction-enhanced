import { buildClaudePrompt, CLAUDE_JUDGE_SYSTEM, replyText } from './claude-asker.js';
import { parseJudgeReply } from './judge-reply.js';
import { isRetryable, RequestTimeoutError, retryAfterMs, withRetry } from './request.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

/**
 * A judge over any OpenAI-compatible Chat Completions endpoint: OpenAI,
 * DeepSeek, Qwen/DashScope, Moonshot/Kimi, Zhipu/GLM, Mistral, Groq,
 * Together, OpenRouter, a relay, or a local vLLM / Ollama / LM Studio.
 *
 * Endpoints differ in what they accept, so the request starts with the most
 * helpful options and drops one per retry when the server rejects it (400 or
 * 422): `response_format: json_object` first, then a `system` message folded
 * into the user turn, then `temperature`. Reasoning models are fine: their
 * `reasoning_content` and `<think>` blocks are skipped when reading the reply.
 */
export interface ChatAskerOptions {
  /** Model id as the endpoint names it. */
  model: string;
  /** API root including the version segment, e.g. `https://api.deepseek.com/v1`. */
  baseUrl: string;
  /** Bearer token; omitted for a local server that needs none. */
  apiKey?: string;
  /** Extra headers (OpenRouter's `HTTP-Referer`, Azure's `api-key`, …). */
  headers?: Record<string, string>;
  /** Reply token cap; a reasoning model needs room for its thinking. Default scales with the questions. */
  maxTokens?: number;
  /** Default 0. */
  temperature?: number;
  /**
   * Ask for `response_format: { type: 'json_object' }`. `auto` (default) tries
   * it and drops it if the endpoint refuses.
   */
  jsonMode?: 'auto' | 'on' | 'off';
  /** Extra body fields, merged last (e.g. `{ enable_thinking: false }` for Qwen). */
  extraBody?: Record<string, unknown>;
  fetch?: typeof fetch;
  /** Per request, body reading included. Default 60000 ms. */
  timeoutMs?: number;
  /** Retries for network failures, 429 and 5xx. Default 1. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class ChatRequestError extends Error {
  constructor(
    readonly status: number,
    detail: string,
    readonly retryAfterMs?: number,
  ) {
    super(`Chat judge request failed (${status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    this.name = 'ChatRequestError';
  }
}

interface Attempt {
  json: boolean;
  system: boolean;
  temperature: boolean;
}

/** The chat body for one judge request. */
export function buildChatJudgeBody(
  state: JevState,
  questions: JevQuestions,
  options: Pick<ChatAskerOptions, 'model' | 'maxTokens' | 'temperature' | 'extraBody'>,
  attempt: Attempt = { json: true, system: true, temperature: true },
): Record<string, unknown> {
  const prompt = buildClaudePrompt(state, questions);
  const messages = attempt.system
    ? [
        { role: 'system', content: CLAUDE_JUDGE_SYSTEM },
        { role: 'user', content: prompt },
      ]
    : [{ role: 'user', content: `${CLAUDE_JUDGE_SYSTEM}\n\n${prompt}` }];
  const count = Object.keys(questions).length;
  return {
    model: options.model,
    messages,
    max_tokens: options.maxTokens ?? Math.max(512, count * 24 + 256),
    ...(attempt.temperature ? { temperature: options.temperature ?? 0 } : {}),
    ...(attempt.json ? { response_format: { type: 'json_object' } } : {}),
    stream: false,
    ...(options.extraBody ?? {}),
  };
}

/** The answer text of a Chat Completions reply, without its reasoning. */
export function chatReplyText(reply: unknown): string {
  if (reply === null || typeof reply !== 'object') return replyText(reply);
  const choices = (reply as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return replyText(reply);
  const message = (choices[0] as { message?: unknown; text?: unknown }).message;
  if (message && typeof message === 'object') {
    const content = (message as { content?: unknown }).content;
    // `reasoning_content` / `reasoning` are the model's thinking, not its answer.
    if (typeof content === 'string' && content.trim()) return content;
    if (Array.isArray(content)) return replyText(content);
    // Some reasoning endpoints put the whole answer in the reasoning field when content is empty.
    const reasoning = (message as { reasoning_content?: unknown; reasoning?: unknown }).reasoning_content ??
      (message as { reasoning?: unknown }).reasoning;
    return typeof reasoning === 'string' ? reasoning : '';
  }
  const text = (choices[0] as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}

export function chatAsker(options: ChatAskerOptions): JevAsker {
  if (!options.model?.trim()) throw new Error('Chat judge requires an explicit model');
  const root = new URL(options.baseUrl);
  if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash) {
    throw new Error('baseUrl must be an HTTP(S) API root without credentials, query or fragment');
  }
  if (root.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(root.hostname)) {
    throw new Error('Remote Chat judge endpoints require HTTPS');
  }
  const endpoint = /\/chat\/completions\/?$/.test(root.pathname)
    ? root.href
    : `${root.href.replace(/\/$/, '')}/chat/completions`;
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');
  const jsonMode = options.jsonMode ?? 'auto';
  // What the endpoint accepted last time, so later requests skip the probes.
  const learned: Attempt = { json: jsonMode !== 'off', system: true, temperature: true };

  async function post(body: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          ...(options.headers ?? {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });
      const text = await response.text();
      if (!response.ok) {
        const delay = response.headers.get('retry-after');
        throw new ChatRequestError(response.status, errorDetail(text), retryAfterMs(delay ? { 'retry-after': delay } : undefined));
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error('Chat judge endpoint returned malformed JSON');
      }
    } catch (error) {
      if (controller.signal.aborted) throw new RequestTimeoutError(`Chat judge request timed out after ${timeoutMs} ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function complete(state: JevState, questions: JevQuestions): Promise<unknown> {
    for (;;) {
      const attempt = { ...learned };
      try {
        return await withRetry(() => post(buildChatJudgeBody(state, questions, options, attempt)), {
          retries: options.retries,
          sleep: options.sleep,
          // Retrying this client's own deadline only repeats the same slow wait.
          shouldRetry: (error) => !(error instanceof RequestTimeoutError) && isRetryable(error),
        });
      } catch (error) {
        const rejected = error instanceof ChatRequestError && (error.status === 400 || error.status === 422);
        if (!rejected) throw error;
        // Drop one optional feature and try again; give up when nothing is left to drop.
        if (learned.json && jsonMode !== 'on') learned.json = false;
        else if (learned.system) learned.system = false;
        else if (learned.temperature) learned.temperature = false;
        else throw error;
      }
    }
  }

  return {
    async ask(state, questions): Promise<JevResponse> {
      if (Object.keys(questions).length === 0) return { model: options.model, answers: {} };
      const reply = await complete(state, questions);
      const parsed = parseJudgeReply(chatReplyText(reply), questions, options.model);
      const usage = reply && typeof reply === 'object' ? (reply as { usage?: Record<string, unknown> }).usage : undefined;
      const input = usage?.prompt_tokens ?? usage?.input_tokens;
      const output = usage?.completion_tokens ?? usage?.output_tokens;
      return {
        ...parsed,
        model: typeof (reply as { model?: unknown })?.model === 'string' ? (reply as { model: string }).model : options.model,
        ...(typeof input === 'number' || typeof output === 'number'
          ? { usage: { ...(typeof input === 'number' ? { input_tokens: input } : {}), ...(typeof output === 'number' ? { output_tokens: output } : {}) } }
          : {}),
      };
    },
  };
}

/** The provider's error message, never the request (which may echo the transcript). */
function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error && typeof parsed.error.message === 'string') return parsed.error.message;
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    // not JSON
  }
  return '';
}

/**
 * Known OpenAI-compatible endpoints, so a caller can name a provider instead
 * of a URL. The key is read from the listed environment variable.
 */
export const CHAT_PROVIDERS: Record<string, { baseUrl: string; keyEnv: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', keyEnv: 'DEEPSEEK_API_KEY' },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyEnv: 'DASHSCOPE_API_KEY' },
  moonshot: { baseUrl: 'https://api.moonshot.ai/v1', keyEnv: 'MOONSHOT_API_KEY' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyEnv: 'ZHIPUAI_API_KEY' },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', keyEnv: 'MISTRAL_API_KEY' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY' },
  together: { baseUrl: 'https://api.together.xyz/v1', keyEnv: 'TOGETHER_API_KEY' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY' },
  xai: { baseUrl: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY' },
  ollama: { baseUrl: 'http://localhost:11434/v1', keyEnv: '' },
  lmstudio: { baseUrl: 'http://localhost:1234/v1', keyEnv: '' },
  vllm: { baseUrl: 'http://localhost:8000/v1', keyEnv: '' },
};

/** A chat judge for a named provider (`deepseek`, `qwen`, …) or an explicit base URL. */
export function chatAskerFor(
  provider: string,
  options: Omit<ChatAskerOptions, 'baseUrl'> & { baseUrl?: string },
): JevAsker {
  const known = Object.hasOwn(CHAT_PROVIDERS, provider) ? CHAT_PROVIDERS[provider] : undefined;
  const baseUrl = options.baseUrl ?? known?.baseUrl;
  if (!baseUrl) throw new Error(`Unknown chat provider ${provider}; pass baseUrl`);
  const apiKey = options.apiKey ?? (known?.keyEnv ? process.env[known.keyEnv] : undefined);
  return chatAsker({ ...options, baseUrl, apiKey });
}
