export type Role = 'user' | 'assistant';

/**
 * A tool_use block of an assistant message. `text` and `isError` mirror the
 * outcome once the transcript holds it (Claude Code attaches them).
 */
export interface ToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  text?: string;
  isError?: boolean;
}

/** A tool_result block of a user message. */
export interface ToolResult {
  tool_use_id: string;
  text: string;
  isError?: boolean;
}

/**
 * One transcript message. The shape is a subset of Claude Code's
 * `SessionMessage`, so a session transcript can be passed in as is.
 */
export interface Message {
  role: Role;
  text: string;
  toolUses: ToolUse[];
  toolResults?: ToolResult[];
}

/** A tool call paired with its result by `tool_use_id`. */
export interface ToolCall {
  /** Short id used in the Jev state and question names (`t1`, `t2`, ...). */
  id: string;
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  /** Characters of the serialised input. */
  inputChars: number;
  /** Index of the message holding the tool_use block. */
  callIndex: number;
  /** Index of the message holding the tool_result block. */
  resultIndex: number;
  resultChars: number;
  /** The first characters of the result, whitespace collapsed, for the state. */
  resultHead: string;
  /** The last characters of the result, whitespace collapsed, for the state. */
  resultTail: string;
  isError: boolean;
  /** The result is a note an earlier compaction round left, not tool output. */
  tombstone: boolean;
  /** In the first or the newest preserved messages; never a candidate. */
  pinned: boolean;
  /**
   * The id of the next later call on the same target (the same file, the same
   * command, the same search), when there is one: a hint to the judge that
   * this call's output was probably superseded.
   */
  supersededBy?: string;
}

export interface CallAnswer {
  /** Jev's probability that the call itself still matters. */
  keepCall: number;
  /** Jev's probability that the full result is still needed; 0 when not asked. */
  keepResult: number;
}

/**
 * `keep` leaves the call and its result as they are; `drop_result` keeps the
 * call with a bounded input and the head and tail of its result; `stub_call`
 * keeps only the tool name, a short input and a note in place of the result;
 * `drop_call` removes the call and its result and marks the narration.
 */
export type CallAction = 'keep' | 'drop_result' | 'stub_call' | 'drop_call';

/**
 * `kept` covers a result kept verbatim and a call whose result was too short
 * to cut (its action is then `drop_result`, which only bounds the input).
 */
export type CallReason =
  | 'pinned'
  | 'unscored'
  | 'kept'
  | 'result_dropped'
  | 'call_stubbed'
  | 'call_dropped';

export interface CallDecision extends CallAnswer {
  id: string;
  tool: string;
  action: CallAction;
  reason: CallReason;
  /** Whether the result question was asked at all; `keepResult` is 0 when not. */
  resultAsked?: boolean;
  /** Characters of the result before the round. */
  resultChars?: number;
  /** The first string field of the input, collapsed, for a log line. */
  about?: string;
  /**
   * The judge's own answer when an arbiter overrode it: `keepCall` and
   * `keepResult` above are then the arbiter's. Absent when no arbiter was
   * asked about this call.
   */
  judged?: CallAnswer;
}

export interface HistoryToolCall {
  id: string;
  tool: string;
  input: string;
  result: string;
  /** A later call on the same target, as `t41 Edit`. */
  superseded_by?: string;
}

export interface HistoryEntry {
  i: number;
  /** `note` marks a range of messages this request does not show. */
  role: Role | 'note';
  text: string;
  /** Structured per call in the window shown in full, one line per call elsewhere. */
  tool_calls?: HistoryToolCall[] | string[];
}

/** The state of one Jev request: the goal, a window of the history in full, the rest in notes. */
export interface CompactionState {
  context: string;
  goal: string;
  history: HistoryEntry[];
}

/** One request: the state and the candidate calls it shows in full and asks about. */
export interface PlannedRequest {
  state: CompactionState;
  calls: ToolCall[];
  /** Estimated tokens of the state alone. */
  tokens: number;
}

/** What becomes of a call judged no longer needed: a stub keeps the shape of the history. */
export type DropCalls = 'stub' | 'delete';

export interface CompactOptions {
  /** Ongoing task description; defaults to the last few human prompts. */
  goal?: string;
  /** Minimum keep probability for a full result to stay verbatim. Default 0.5. */
  keepThreshold?: number;
  /** Minimum keep probability for a call to stay (with a bounded result). Default 0.5. */
  keepCallThreshold?: number;
  /** Newest messages never touched (the first message is always kept). Default 6. */
  preserveRecentMessages?: number;
  /** Estimated token ceiling for one request's state. Default 25000. */
  maxStateTokens?: number;
  /** Estimated token ceiling for one request's state plus its questions. Default 30000. */
  maxRequestTokens?: number;
  /** Characters of a dropped tool result (head and tail together), or of an oversized input field, to retain. Default 300. */
  truncateHeadChars?: number;
  /** `stub` (default) keeps a stub of a call judged unneeded; `delete` removes it and marks the narration. */
  dropCalls?: DropCalls;
  /** Characters of input kept on a stubbed call. Default 120. */
  stubChars?: number;
  /** Cut machine-generated blocks (system reminders, task notifications, command echoes) in old user messages. Default true. */
  pruneMachineText?: boolean;
  /** Jev requests in flight at once. Default 4. */
  concurrency?: number;
  /**
   * A second judge for the calls the first was unsure about: every call
   * whose `keepCall` (or asked `keepResult`) lands within `arbitrateBand` of
   * its threshold is put to the arbiter again, with the same window, and the
   * arbiter's answer replaces the judge's. None by default.
   */
  arbiter?: JevAsker;
  /** Half-width of the band around a threshold that goes to the arbiter. Default 0.15. */
  arbitrateBand?: number;

  /**
   * Which System One primitive the judge is asked with. `noul` asks two
   * yes/no questions per call (keep the call; keep its full result) and
   * thresholds each probability. `choice` asks one question per call whose
   * options are the actions themselves, and reads the two probabilities back
   * off the distribution: `keepCall` is `1 - P(stub)` and `keepResult` is
   * `P(keep_result | not stub)`, so every threshold downstream keeps its
   * meaning. Default `noul`.
   *
   * Measured on 2026-09-25 against what three real sessions did after a cut
   * (`npm run evaluate`, 1412 calls): `choice` commits far more (29% of
   * calls near 0.5 against 60%), but at the default thresholds it stubbed
   * 56% of the calls the session went on to use, against 21% for `noul`.
   * Stubbing the same number of calls, the two rank about alike. Neither
   * `keepResult` predicted which outputs were used again (pooled AUC 0.38),
   * and a rule on the tool name alone lost fewer needed calls than either.
   */
  primitive?: 'noul' | 'choice';
}

export interface ResolvedCompactOptions {
  goal: string;
  keepThreshold: number;
  keepCallThreshold: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  truncateHeadChars: number;
  dropCalls: DropCalls;
  stubChars: number;
  pruneMachineText: boolean;
  concurrency: number;
  arbitrateBand: number;
  primitive: 'noul' | 'choice';
}

export interface CompactStats {
  messagesBefore: number;
  messagesAfter: number;
  charsBefore: number;
  charsAfter: number;
  /** Characters the compaction could remove at most: candidate inputs, results and machine blocks. */
  prunableChars: number;
  calls: number;
  kept: number;
  resultsDropped: number;
  callsStubbed: number;
  callsDropped: number;
  pinned: number;
  /** Candidates no request could show, or the judge left unanswered; kept untouched. */
  unscored: number;
  /** Old user messages whose machine-generated blocks were cut. */
  machineBlocksPruned: number;
  /** Estimated tokens of the largest request state. */
  stateTokens: number;
  requests: number;
  /** Calls the arbiter was asked about, and how many of those changed action. */
  arbitrated: number;
  arbiterFlips: number;
  ms: number;
}

export interface CompactResult {
  /** The compacted transcript; untouched messages are the input objects. */
  messages: Message[];
  decisions: CallDecision[];
  stats: CompactStats;
}

/** The `state` of a Jev request: a string or any JSON-serialisable object. */
export type JevState = string | object;

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: {
    true?: string;
    false?: string;
  };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type JevQuestions = Record<string, JevQuestion>;

export interface NoulAnswer {
  type?: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type?: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type?: 'score';
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevResponse {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  [key: string]: unknown;
}

/**
 * Anything that can answer Jev questions: `JevClient`, or a host-provided
 * adapter. `calls` are the candidates the questions are about, for an asker
 * that needs their `tool_use_id`s (the fork judge); the HTTP client ignores it.
 */
export interface JevAsker {
  ask(state: JevState, questions: JevQuestions, calls?: readonly ToolCall[]): Promise<JevResponse>;
}
