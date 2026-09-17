import { estimateTokens } from './state.js';
import { noulAnswer } from './request.js';
import type { JevAsker, JevQuestions } from './types.js';

const DEFAULT_MIN_CHARS = 4_000;
const DEFAULT_CHUNK_LINES = 20;
const DEFAULT_KEEP_THRESHOLD = 0.5;
const DEFAULT_MAX_STATE_TOKENS = 25_000;
const MAX_REQUEST_TOKENS = 30_000;

const OUTPUT_CONTEXT =
  'A coding agent ran a shell command. Its output is split into numbered chunks. The agent will only see the chunks that are kept; the full output is saved to a file it can read later. Decide which chunks the agent needs to understand the outcome of the command and continue its task: errors, failures, warnings, summaries, final results, and lines the task depends on are needed; repetitive progress output, verbose listings, download/install noise and boilerplate are not.';

export interface TrimOutputOptions {
  minChars?: number;
  chunkLines?: number;
  keepThreshold?: number;
  maxStateTokens?: number;
}

export interface TrimOutputInput {
  command: string;
  goal: string;
  output: string;
  fullOutputPath?: string;
}

export interface TrimOutputResult {
  output: string;
  trimmed: boolean;
  chunks: number;
  kept: number;
  dropped: number;
  charsBefore: number;
  charsAfter: number;
  scores: number[];
}

type OutputChunk = {
  id: string;
  text: string;
  lines: number;
  chars: number;
};

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function chunkOutput(output: string, chunkLines: number): OutputChunk[] {
  const lines = output.split('\n');
  const chunks: OutputChunk[] = [];
  for (let start = 0; start < lines.length; start += chunkLines) {
    const text = lines.slice(start, start + chunkLines).join('\n');
    chunks.push({
      id: `c${chunks.length + 1}`,
      text,
      lines: Math.min(chunkLines, lines.length - start),
      chars: text.length,
    });
  }
  return chunks;
}

function stateFor(
  input: TrimOutputInput,
  chunks: readonly OutputChunk[],
): { context: string; task: string; command: string; chunks: { id: string; text: string }[] } {
  return {
    context: OUTPUT_CONTEXT,
    task: input.goal,
    command: input.command,
    chunks: chunks.map(({ id, text }) => ({ id, text })),
  };
}

function questionFor(chunk: OutputChunk): JevQuestions {
  const n = chunk.id.slice(1);
  return {
    [chunk.id]: {
      type: 'noul',
      instructions: `Chunk c${n} must stay visible to the agent for it to understand the result of the command and continue its task.`,
      criteria: {
        true: 'The chunk contains an error, failure, warning, summary, final result, or information the task depends on.',
        false: 'The chunk is repetitive, verbose, or boilerplate output the agent can act without.',
      },
    },
  };
}

function batches(
  chunks: readonly OutputChunk[],
  stateTokens: number,
): OutputChunk[][] {
  const budget = MAX_REQUEST_TOKENS - stateTokens;
  const result: OutputChunk[][] = [];
  let current: OutputChunk[] = [];
  let currentTokens = 0;
  for (const chunk of chunks) {
    const tokens = estimateTokens(JSON.stringify(questionFor(chunk)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      result.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for output questions (~${stateTokens} of ${MAX_REQUEST_TOKENS} tokens)`,
      );
    }
    current.push(chunk);
    currentTokens += tokens;
  }
  if (current.length > 0) result.push(current);
  return result;
}

function outputMarker(
  chunks: readonly OutputChunk[],
  fullOutputPath: string | undefined,
): string {
  const lines = chunks.reduce((sum, chunk) => sum + chunk.lines, 0);
  const chars =
    chunks.reduce((sum, chunk) => sum + chunk.chars, 0) + Math.max(0, chunks.length - 1);
  return `[fast-jev-compaction trimmed ${lines} lines (${chars} chars)${
    fullOutputPath ? `; full output: ${fullOutputPath} (Read or grep it if needed)` : ''
  }]`;
}

export async function trimOutput(
  input: TrimOutputInput,
  asker: JevAsker,
  options: TrimOutputOptions = {},
): Promise<TrimOutputResult> {
  const minChars = Math.max(0, finite(options.minChars, DEFAULT_MIN_CHARS));
  const chunkLines = Math.max(
    1,
    Math.floor(finite(options.chunkLines, DEFAULT_CHUNK_LINES)),
  );
  const keepThreshold = finite(options.keepThreshold, DEFAULT_KEEP_THRESHOLD);
  const maxStateTokens = Math.max(
    1,
    finite(options.maxStateTokens, DEFAULT_MAX_STATE_TOKENS),
  );

  if (input.output.length <= minChars) {
    return {
      output: input.output,
      trimmed: false,
      chunks: 0,
      kept: 0,
      dropped: 0,
      charsBefore: input.output.length,
      charsAfter: input.output.length,
      scores: [],
    };
  }

  const chunks = chunkOutput(input.output, chunkLines);
  if (chunks.length <= 2) {
    return {
      output: input.output,
      trimmed: false,
      chunks: chunks.length,
      kept: chunks.length,
      dropped: 0,
      charsBefore: input.output.length,
      charsAfter: input.output.length,
      scores: [],
    };
  }

  let stateChunks = chunks.map((chunk) => ({ ...chunk }));
  let state = stateFor(input, stateChunks);
  let stateTokens = estimateTokens(JSON.stringify(state));
  let omitted = new Set<number>();
  if (stateTokens > maxStateTokens) {
    stateChunks = chunks.map((chunk) => ({
      ...chunk,
      text: chunk.text
        .split('\n')
        .map((line) => line.slice(0, 200))
        .join('\n'),
    }));
    state = stateFor(input, stateChunks);
    stateTokens = estimateTokens(JSON.stringify(state));
  }
  if (stateTokens > maxStateTokens) {
    omitted = new Set(
      chunks
        .map((_, index) => index)
        .filter((index) => index >= 40 && index < chunks.length - 40),
    );
    stateChunks = chunks.map((chunk, index) =>
      omitted.has(index)
        ? { ...chunk, text: '[… omitted from state …]' }
        : { ...chunk },
    );
    state = stateFor(input, stateChunks);
    stateTokens = estimateTokens(JSON.stringify(state));
  }

  const asked = chunks.filter((_, index) => !omitted.has(index));
  const scores = Array<number>(chunks.length).fill(0);
  scores[0] = 1;
  scores[chunks.length - 1] = 1;
  const questionBatches = batches(asked, stateTokens);
  const answered = await Promise.all(
    questionBatches.map(async (batch) => {
      const questions = Object.assign({}, ...batch.map(questionFor));
      return asker.ask(state, questions);
    }),
  );
  let answerOffset = 0;
  for (const batch of questionBatches) {
    const response = answered[answerOffset++];
    if (!response) throw new Error('Missing Jev output answer batch');
    for (const chunk of batch) scores[chunks.indexOf(chunk)] = noulAnswer(response.answers, chunk.id);
  }

  const keptIndexes = new Set<number>();
  for (let index = 0; index < chunks.length; index += 1) {
    if (
      !omitted.has(index) &&
      (index === 0 || index === chunks.length - 1 || scores[index]! >= keepThreshold)
    ) {
      keptIndexes.add(index);
    }
  }
  const droppedIndexes = chunks
    .map((_, index) => index)
    .filter((index) => !keptIndexes.has(index));
  if (droppedIndexes.length === 0) {
    return {
      output: input.output,
      trimmed: false,
      chunks: chunks.length,
      kept: chunks.length,
      dropped: 0,
      charsBefore: input.output.length,
      charsAfter: input.output.length,
      scores,
    };
  }

  const parts: string[] = [];
  for (let index = 0; index < chunks.length;) {
    if (keptIndexes.has(index)) {
      parts.push(chunks[index]!.text);
      index += 1;
      continue;
    }
    const run: OutputChunk[] = [];
    while (index < chunks.length && !keptIndexes.has(index)) run.push(chunks[index++]!);
    parts.push(outputMarker(run, input.fullOutputPath));
  }
  const output = parts.join('\n');
  return {
    output,
    trimmed: true,
    chunks: chunks.length,
    kept: keptIndexes.size,
    dropped: droppedIndexes.length,
    charsBefore: input.output.length,
    charsAfter: output.length,
    scores,
  };
}
