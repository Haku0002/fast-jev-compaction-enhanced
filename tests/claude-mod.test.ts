import { describe, expect, it } from 'vitest';
import {
  compactOrFallback,
  compactWithFetch,
  decideUnit,
  groupMessages,
  packWindows,
  type CompactionUnit,
} from '../plugin/hooks/fast-jev.ts';

type Message = {
  role: 'user' | 'assistant';
  text: string;
  toolUses: Array<{
    tool_use_id: string;
    tool: string;
    input: Record<string, unknown>;
  }>;
  toolResults?: Array<{
    tool_use_id: string;
    text: string;
    isError: boolean;
    result?: unknown;
  }>;
  handle?: string;
};

function message(
  role: Message['role'],
  text: string,
  extra: Partial<Message> = {},
): Message {
  return { role, text, toolUses: [], ...extra };
}

function units(...previews: string[]): CompactionUnit[] {
  return previews.map((preview, index) => ({
    id: `unit-${index}`,
    messages: [message('user', preview)],
    pinned: false,
    preview,
  }));
}

describe('Claude Code mod pure logic', () => {
  it('groups an assistant tool call with its following tool result', () => {
    const grouped = groupMessages([
      message('user', 'start'),
      message('assistant', '', {
        toolUses: [
          { tool_use_id: 'tool-1', tool: 'Read', input: { file: 'a.ts' } },
        ],
      }),
      message('user', '', {
        toolResults: [
          { tool_use_id: 'tool-1', text: 'contents', isError: false },
        ],
      }),
      message('assistant', 'done'),
    ], { preserveRecentMessages: 0 });

    expect(grouped).toHaveLength(3);
    expect(grouped[1]?.messages).toHaveLength(2);
    expect(grouped[1]?.messages[0]?.role).toBe('assistant');
    expect(grouped[1]?.messages[1]?.toolResults?.[0]?.tool_use_id).toBe('tool-1');
  });

  it('pins the first unit and newest messages', () => {
    const grouped = groupMessages(
      [
        message('user', 'first'),
        message('assistant', 'old'),
        message('user', 'new'),
      ],
      { preserveRecentMessages: 1 },
    );

    expect(grouped.map((unit) => unit.pinned)).toEqual([true, false, true]);
  });

  it('packs windows without exceeding the character budget after the first unit', () => {
    const packed = packWindows(units('1234', '5678', '90'), 8);
    expect(packed.map((window) => window.map((unit) => unit.preview))).toEqual([
      ['1234', '5678'],
      ['90'],
    ]);
  });

  it('applies the requested decision matrix', () => {
    const config = {
      dropThreshold: 0.8,
      toolOutputDropThreshold: 0.5,
      minKindConfidence: 0.5,
      protectedKinds: new Set(['user_instruction' as const]),
    };
    const unit = { id: 'unit-1', pinned: false };
    expect(decideUnit(unit, {
      drop: 0.99,
      kind: 'user_instruction',
      kindConfidence: 0.9,
    }, config).reason).toBe('protected_kind');
    expect(decideUnit(unit, {
      drop: 0.2,
      kind: 'other',
      kindConfidence: 0.9,
    }, config).reason).toBe('below_threshold');
    expect(decideUnit(unit, {
      drop: 0.9,
      kind: 'other',
      kindConfidence: 0.2,
    }, config).reason).toBe('low_confidence');
    expect(decideUnit(unit, {
      drop: 0.9,
      kind: 'other',
      kindConfidence: 0.9,
    }, config).action).toBe('drop');
    expect(decideUnit({ id: 'unit-0', pinned: true }, {
      drop: 1,
      kind: 'other',
      kindConfidence: 1,
    }, config).reason).toBe('pinned');
    const toolUnit = { id: 'tool-unit', pinned: false, toolOutput: true };
    expect(decideUnit(toolUnit, {
      drop: 0.2,
      truncate: 0.6,
      kind: 'stale_tool_output',
      kindConfidence: 0.9,
    }, config)).toMatchObject({ action: 'truncate', reason: 'truncated' });
    expect(decideUnit(toolUnit, {
      drop: 0.7,
      truncate: 0.2,
      kind: 'stale_tool_output',
      kindConfidence: 0.9,
    }, config)).toMatchObject({ action: 'drop', reason: 'dropped' });
    expect(decideUnit(toolUnit, {
      drop: 0.1,
      truncate: 0.3,
      kind: 'stale_tool_output',
      kindConfidence: 0.9,
    }, config)).toMatchObject({ action: 'keep', reason: 'below_threshold' });
    expect(decideUnit(toolUnit, {
      drop: 0.2,
      truncate: 0.7,
      kind: 'user_instruction',
      kindConfidence: 0.9,
    }, config)).toMatchObject({ action: 'keep', reason: 'protected_kind' });
  });

  it('falls back when the estimated reduction is too small', async () => {
    const messages = [
      message('user', 'pinned context'),
      message('assistant', 'small candidate'),
    ];
    const fallback = await compactOrFallback(
      messages,
      {
        apiKey: 'test-key',
        preserveRecentMessages: 0,
        minReductionRatio: 0.9,
      },
      async (_url, init) => {
        const body = JSON.parse(init?.body ?? '{}') as {
          questions: Record<string, { type: string }>;
        };
        const answers = Object.fromEntries(
          Object.keys(body.questions).map((key) => [
            key,
            key.startsWith('drop_')
              ? { type: 'noul', noul: 0.1 }
              : { type: 'choice', choice: 'other', confidence: 0.9 },
          ]),
        );
        return { status: 200, ok: true, text: JSON.stringify({ answers }) };
      },
    );

    expect(fallback).toBeNull();
  });

  it('truncates stale tool results while preserving tool calls', async () => {
    const toolResultText = 'x'.repeat(2000);
    const toolCall = message('assistant', '', {
      handle: 'h-call',
      toolUses: [
        { tool_use_id: 'tool-1', tool: 'Read', input: { file: 'a.ts' } },
      ],
    });
    const toolResult = message('user', '', {
      handle: 'h-r',
      toolResults: [
        {
          tool_use_id: 'tool-1',
          text: toolResultText,
          isError: false,
          result: { bulky: true },
        },
      ],
    });
    const recent = Array.from({ length: 6 }, (_, index) =>
      message('assistant', `recent-${index}`),
    );
    const transcript = [message('user', 'first'), toolCall, toolResult, ...recent];
    const fetchFn = async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as {
        questions: Record<string, unknown>;
      };
      const answers = Object.fromEntries(
        Object.keys(body.questions).map((key) => [
          key,
          key === 'fate_unit-1'
            ? {
                type: 'choice',
                choice: 'truncate',
                probabilities: { keep: 0.1, truncate: 0.7, drop: 0.2 },
                confidence: 0.8,
              }
            : {
                type: 'choice',
                choice: 'stale_tool_output',
                confidence: 0.9,
              },
        ]),
      );
      return { status: 200, ok: true, text: JSON.stringify({ answers }) };
    };

    const result = await compactWithFetch(
      transcript,
      { apiKey: 'test-key', preserveRecentMessages: 6 },
      fetchFn,
    );
    const returnedCall = result.messages.find(
      (candidate) => candidate.handle === 'h-call',
    );
    const returnedResult = result.messages.find(
      (candidate) => candidate.toolResults?.some(
        (candidateResult) => candidateResult.tool_use_id === 'tool-1',
      ),
    );

    expect(returnedCall).toBe(toolCall);
    expect(returnedResult).not.toBe(toolResult);
    expect(returnedResult?.handle).toBeUndefined();
    expect(returnedResult?.toolResults?.[0]?.result).toBeUndefined();
    expect(returnedResult?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(result.truncatedResults).toBe(1);
    expect(result.charsAfter).toBeLessThan(result.charsBefore);

    const shortResult = message('user', '', {
      handle: 'h-short',
      toolResults: [
        { tool_use_id: 'tool-1', text: 'short'.repeat(20), isError: false },
      ],
    });
    const shortTranscript = [message('user', 'first'), toolCall, shortResult, ...recent];
    const short = await compactWithFetch(
      shortTranscript,
      { apiKey: 'test-key', preserveRecentMessages: 6 },
      fetchFn,
    );
    const unchanged = short.messages.find(
      (candidate) => candidate.handle === 'h-short',
    );
    expect(unchanged).toBe(shortResult);
    expect(short.truncatedResults).toBe(0);
  });
});
