# fast-jev-compaction

Claude Code plugin that replaces the compaction summary with Jev decisions:
every tool call and result is scored in one fast request, stale ones are
dropped or truncated, everything kept stays verbatim. Also usable as an npm
library.

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library never rewrites anything. It only deletes tool
calls and tool results Jev says are no longer needed, and it asks Jev while
showing it the whole conversation. User and assistant text stays verbatim and
in order.

The repository is both an npm package (`src/`) and a Claude Code plugin
(`hooks/`, `.claude-plugin/`) that uses the package to replace Claude Code's
built-in compaction summary with the original messages.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. The candidates are walked oldest first and cut into **windows** of
   consecutive messages. Each window goes to the judge in one request whose
   **state** shows the window in full: every call with its input (up to 300
   characters), the head and the tail of its output (120 + 100 characters, so
   a command's verdict at the end is visible), a `superseded_by` hint naming
   the next later call on the same file, command or search, texts abridged
   to head + tail, host blocks (system reminders, task notifications) elided.
   The first message and the newest `preserveRecentMessages` messages frame
   every window, and a `note` entry stands for each range the request leaves
   out. A window closes when its state would pass `maxStateTokens` (25k by
   default) or state plus questions `maxRequestTokens` (30k, under Jev's 32k
   request limit). A candidate that does not fit even alone is retried with
   texts collapsed and calls one-lined, and kept untouched (`unscored`) if
   that fails too. So every call the judge is asked about is one it can see.
3. Tokens are estimated without a tokenizer (a word per six letters, half a
   token per digit, 1.15 per CJK character, a third per character of a dense
   run such as a hash or base64, ~one per other symbol), calibrated on real
   requests to land 1-6% above the counts Jev reports.
4. For every candidate the judge gets a `noul` question: does the **call**
   still carry information the task depends on (a file or command being
   worked with, a decision, a constraint, an edit that was made). When the
   result is long enough that cutting it would change something, and is not
   a note left by an earlier round, a second question asks whether its
   **output** holds information the assistant would need again (an error, a
   value, contents being edited) beyond what re-running the tool would give.
   Each question spells its criterion out even though the state's `context`
   states it too: a one-line phrasing was tried and, measured on a real
   session (`npm run calibrate`), sat 0.3 lower across the board and flipped
   two thirds of the decisions, so the longer wording stays.
   Optionally an **arbiter** (`arbiter`, any `JevAsker`) re-judges the calls
   whose answer landed within `arbitrateBand` (0.15) of a threshold, over the
   same window, and its answer replaces the judge's; the decision keeps the
   judge's answer as `judged` so the two can be compared.
5. Requests run with `concurrency` in flight; a rate limit or server error is
   retried once (after the `Retry-After` the server asks for, when it gives
   one under 30 s; a longer wait fails the round instead), and once one
   request has failed the others stop. Answers are merged. A call the judge left unanswered stays untouched
   (`unscored`); only a reply that answers nothing fails the round.
6. Decisions per call:
   - `keepResult >= keepThreshold` -> keep call and result verbatim;
   - else `keepCall >= keepCallThreshold` -> keep the call, cut the result to
     `truncateHeadChars` characters (two thirds head, one third tail) plus a
     note, and cut every oversized input field (a Write's content, an Edit's
     strings) to a head the same way; a result too short to cut counts as
     `kept`;
   - else -> `dropCalls: 'stub'` (default) keeps the tool name, the input cut
     to `stubChars` characters and a one-line note in place of the result,
     so the history keeps a call before every report the assistant wrote;
     `dropCalls: 'delete'` removes the call with its result and appends a
     marker to the turn's narration saying so.
7. Machine-generated blocks in old user messages (`<system-reminder>`,
   `<task-notification>`, command echoes) are cut to a head and a note by
   rule, without a question (`pruneMachineText`). The person's own words,
   and every assistant text, stay verbatim and in order.
8. The message list is rebuilt: a message that loses all its content is
   removed, untouched messages are returned as the same objects, and no result
   is ever left without its call.

Jev failures, replies that answer nothing and a missing key throw; the caller
(or the Claude Code hook) decides what to fall back to. `prunableShare(messages)`
tells, without a request, how much of a history is tool traffic and host
blocks at all.

## Install and usage

```sh
npm install fast-jev-compaction
export TYPESAFE_API_KEY=...
```

```ts
import { compactMessages, reductionRatio, type Message } from 'fast-jev-compaction';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in as is.

To bring your own transport, implement `JevAsker` (one `ask(state, questions)`
method) and call `compact(messages, asker, options)`; `buildJevRequest` and
`parseJevResponse` give you the HTTP request body and response validation.
The building blocks (`collectToolCalls`, `planRequests`, `questionsFor`,
`decideCall`, `applyDecisions`, `pruneMachineBlocks`) are exported too.

`apiKey` defaults to `process.env.TYPESAFE_API_KEY`. Never commit the key or
put it in a source file.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key (`compactMessages`/`JevClient`) |
| `model` | `jev-latest` | Jev model name |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | System One endpoint |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 human prompts | Ongoing task description included in the state |
| `keepThreshold` | `0.5` | Minimum probability for a result to stay verbatim |
| `keepCallThreshold` | `0.5` | Minimum probability for a call to stay (with a bounded result) |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for one request's state |
| `maxRequestTokens` | `30000` | Estimated ceiling for one request's state plus questions |
| `truncateHeadChars` | `300` | Characters kept of a cut result (head and tail), input field or host block |
| `dropCalls` | `stub` | What becomes of an unneeded call: `stub` or `delete` |
| `stubChars` | `120` | Characters of input kept on a stub |
| `pruneMachineText` | `true` | Cut host blocks in old user messages |
| `concurrency` | `4` | Requests in flight at once |
| `arbiter` | none | A second `JevAsker` for the calls the judge was unsure about |
| `arbitrateBand` | `0.15` | Half-width of the band around a threshold that goes to the arbiter |

`result.stats` reports message and character counts before and after, how
many characters were prunable at all, the per-reason decision counts, the
largest request state in estimated tokens, and the number of requests. Each
entry of `result.decisions` carries both probabilities, whether the result
question was asked, the result's size and a short `about` (the first string
of the input), enough to audit a round after the fact.

## Limitations

- Only tool calls, results and host blocks are candidates; the person's and
  the assistant's text is never removed or shortened in the output (it is
  only abridged in the state the judge sees).
- Token sizes are estimates from character counts, not a tokenizer.
- Calibration is at the request level; a probability is not a proof that a
  result is safe to cut. The assistant can always re-run the tool.
- The judge sees each window with the frame around it, not the whole
  history at once; a result whose value only shows far away from its call
  may be cut. The `superseded_by` hint covers the commonest case (the same
  file read or edited again later); the plugin's `fork` backend shows the
  judge the whole conversation instead.

## Claude Code plugin

The repository root is a Claude Code function-hook plugin: `hooks/fast-jev.ts`
is a thin adapter that feeds `session.compact` transcripts through `src/`,
scored by Jev when `TYPESAFE_API_KEY` is set and otherwise by Claude (Haiku
by default) through the session's own API client, or by a fork of the
session itself (`backend: fork`), and falls back to Claude Code's built-in
summary on errors or after `timeoutMs`. See [`hooks/README.md`](hooks/README.md) for configuration and the
Claude Code 2.1.274 type reference.

### Install in Claude Code

Function hooks are an early-access Claude Code feature (2.1.274+), so the
opt-in flag must be set wherever Claude Code runs, e.g. in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "TYPESAFE_API_KEY": "<your key>" } }
```

Then add this repository as a plugin marketplace and install the plugin,
either from the shell or as slash commands inside a session:

```sh
claude plugin marketplace add tamaratran/fast-jev-compaction
claude plugin install fast-jev-compaction@fast-jev-compaction
```

The install prompts for the plugin options (API key, thresholds, `dropCalls`,
…); leave them at their defaults to use `TYPESAFE_API_KEY` from the environment,
or leave the key unset to score with the session's own model instead.
Start a new session (hooks modules load at session start). From then on
`/compact` (and auto-compaction) goes through the judge: the toast reads
`[manual] [jev] kept N/M messages, no summary (…)` when the pruned history
replaced the built-in summary, `… history left unchanged` when too little of it
is tool traffic to be worth a round, or `fallback to built-in summary (…)`
when the judge fails. Every outcome is also appended to
`~/.claude/fast-jev-compaction.log`.

To run from a checkout without installing: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`
from the repository root. No publishing step is required; the marketplace is
just the repo's `.claude-plugin/marketplace.json`.

## Development

```sh
npm install
npm run typecheck        # library + hook
npm test
npm run build
npm run validate:plugin  # claude plugin validate
TYPESAFE_API_KEY="$(cat ~/.typesafe_key)" npm run demo
TYPESAFE_API_KEY="$(cat ~/.typesafe_key)" npm run calibrate -- [session.jsonl]
```

The unit tests use a fake Jev and never contact TypeSafe. The demo is the live
network check.

`npm run calibrate` scores a real Claude Code transcript (the newest under
`~/.claude/projects` unless a path is given) twice on the same windows, with
the short questions the library sends and with the long ones that spelled
the rubric out per question, and prints how the probabilities fell under
each, what the thresholds 0.5, 0.3 and 0.2 would do, the mean per tool, and
the calls where the two phrasings disagree most. Run it before moving
`keepCallThreshold`; `--dry` only plans the windows. `examples/session.ts`
is the transcript reader, usable on its own.

## Animated demo (macOS)

`demo/JevDemo` is a small native SwiftUI app that plays a scripted, dramatized
version of the compaction flow inside a Claude Code-style terminal: the tool
calls of a canned transcript are scored, results and calls Jev lets go turn red
and collapse away, and the rest stays verbatim. It never calls the API; it
exists to be screen recorded.

```sh
demo/JevDemo/build.sh   # builds demo/JevDemo/build/JevDemo.app and launches it
```

Press space in the app to replay from the start.
