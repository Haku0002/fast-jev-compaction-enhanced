import { describe, expect, it } from 'vitest';
import {
  compactOrFallback,
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
  }>;
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
      protectThreshold: 0.7,
    };
    const unit = { id: 'unit-1', pinned: false };
    expect(decideUnit(unit, { drop: 0.99, protect: 0.9 }, config).reason).toBe(
      'protected',
    );
    expect(decideUnit(unit, { drop: 0.2, protect: 0.1 }, config).reason).toBe(
      'below_threshold',
    );
    expect(decideUnit(unit, { drop: 0.9, protect: 0.69 }, config).action).toBe(
      'drop',
    );
    expect(decideUnit(unit, { drop: 0.6, protect: 0.1 }, config).action).toBe(
      'keep',
    );
    expect(
      decideUnit({ ...unit, toolOutput: true }, { drop: 0.6, protect: 0.1 }, config)
        .action,
    ).toBe('drop');
    expect(
      decideUnit({ id: 'unit-0', pinned: true }, { drop: 1, protect: 0 }, config)
        .reason,
    ).toBe('pinned');
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
            { type: 'noul', noul: key.startsWith('drop_') ? 0.1 : 0.2 },
          ]),
        );
        return { status: 200, ok: true, text: JSON.stringify({ answers }) };
      },
    );

    expect(fallback).toBeNull();
  });
});
