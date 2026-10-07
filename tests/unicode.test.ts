import { describe, expect, it } from 'vitest';
import { abridgeInput, compactResponsesInput, sliceText, stubInput, truncate, type JevAsker } from '../src/index.js';

const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('Unicode retention', () => {
  it('keeps head and tail within budget without splitting a pair', () => {
    const text = 'a🔥b😀c';
    for (let limit = 0; limit <= text.length; limit += 1) {
      for (const part of [sliceText(text, 0, limit), sliceText(text, text.length - limit)]) {
        expect(part).not.toMatch(lone);
        expect(part.length).toBeLessThanOrEqual(limit);
      }
      expect(truncate(text, limit)).not.toMatch(lone);
    }
    expect(sliceText('a🔥b', 0, 2)).toBe('a');
    expect(sliceText('a🔥b', -2)).toBe('b');
  });

  it('does not introduce lone surrogates into tool stubs, result tails or judge state', async () => {
    const input = { content: 'a🔥' + 'x'.repeat(500) };
    expect(JSON.stringify(abridgeInput(input, 2))).not.toMatch(/\\ud83d/i);
    expect(JSON.stringify(stubInput(input, 2))).not.toMatch(/\\ud83d/i);
    const text = '🔥'.repeat(1000);
    const judge: JevAsker = { ask: async (state, questions) => {
      expect(JSON.stringify(state)).not.toMatch(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/);
      return { answers: Object.fromEntries(Object.keys(questions).map((name) => [name, { noul: name.startsWith('call_') ? 1 : 0 }])) };
    } };
    const result = await compactResponsesInput([
      { role: 'user', content: '🔎'.repeat(500) },
      { type: 'function_call', call_id: 'a', name: 'Read', arguments: '{"path":"emoji.txt"}' },
      { type: 'function_call_output', call_id: 'a', output: text },
    ], judge, { preserveRecentMessages: 0, truncateHeadChars: 5 });
    expect(result.input[2]!.output).not.toMatch(lone);
  });
});
