# fast-jev-compaction Claude Code mod

This plugin uses Claude Code function hooks to replace a compaction with the
original messages, minus the tool traffic a judge says is no longer needed.
`hooks/fast-jev.ts` is a thin adapter: it reads the plugin options, picks the
judge, hands `session.compact` transcripts to the `fast-jev-compaction`
library in `src/` (the plugin folder is the repository root, so the hook
imports it directly) and maps the result back onto session messages. The
person's and the assistant's text is never touched.

## Judges

- **Jev** (TypeSafe System One) over `$.http.fetch`, when `TYPESAFE_API_KEY`
  is set (or `backend: jev`). Windows of 25k tokens, under Jev's 32k limit.
- **Claude** over `$.model.complete`, the session's own API client, when no
  key is set (or `backend: claude`). No extra key or billing; `claudeModel`
  picks the model (`haiku` by default) and the windows default to 80k
  tokens so the judge sees more at once.
- **Fork** over `$.model.fork` (`backend: fork`, experimental): one
  completion appended to the session's own transcript, which the model
  already holds in its prompt cache. The judge sees the whole conversation
  verbatim instead of a windowed state, at almost no input cost; the prompt
  carries only the goal, a legend mapping the short ids to `tool_use_id`s,
  and the questions, all in one request. It uses the session's model, not
  `claudeModel`, is only used for the main conversation (a subagent's
  transcript is not the session's), and when the fork answers null (a cold
  snapshot, an API error) the hook falls back to the built-in summary.

`backend: auto` (the default) picks Jev when a key is available, Claude
otherwise. Every judge request is bounded by `timeoutMs` (90 s by default);
a request that outlives it fails the round like any other error.

With the Jev judge, an **arbiter** (`arbiterModel`, `haiku` by default,
empty to turn off) re-judges over `$.model.complete` the calls Jev was
unsure about: those whose `keepCall` (or asked `keepResult`) landed within
`arbitrateBand` (0.15) of its threshold, so with the defaults a call Jev
scored between 0.35 and 0.65. The arbiter sees the same window Jev saw and
is asked only about those calls; its answer replaces Jev's, and the
decisions log shows both (`call=0.90(jev 0.40)`). The outcome line counts
how many calls were re-judged and how many changed action. To compare
arbiters, set `arbiterModel` to `haiku` and then to `sonnet`, compact a
similar session with each, and read the flipped lines in the decisions
log; the one whose flips you would have made yourself is the better
arbiter. A call the arbiter does not answer keeps Jev's score; an arbiter
failure fails the round like a judge failure.

## What a compaction does

1. `prunableShare` measures, without a request, how much of the history is
   tool traffic and host blocks. Below `minReductionRatio` there is nothing
   worth a round: the history is returned **unchanged** (`nothingToPrune:
   keep`), except on an automatic compaction at the window limit, which gets
   the built-in summary because the conversation has to shrink. A lossless
   round is never followed by a lossy summary just because little was left
   to prune.
2. Otherwise the library scores the candidates in windows (see the root
   README), truncates, stubs or removes them, cuts old host blocks, and the
   hook hands the rebuilt list back. Untouched messages keep the engine's
   `handle`; rebuilt ones are handed over without one so the engine takes
   the edited content.
3. `/compact <instructions>` puts the instructions in front of the goal the
   judge is shown.
4. On a judge failure (network, timeout, a reply that answers nothing,
   missing key) the hook logs the reason and delegates to the built-in
   summary. A reply that leaves some calls unanswered is not a failure:
   those calls stay untouched and the rest of the round stands.

Every outcome goes to `$.ui.log`, to a toast (not on `precompute` or for a
subagent's transcript), to the plugin store (`lastCompaction`) and to
`~/.claude/fast-jev-compaction.log`, so a headless or desktop install can
tell which path a compaction took. The outcome line ends with a profile of
the judge's answers in four bands (`call p: 60 <0.1, 20 <0.3, 13 <0.5, 6
≥0.5 | result p (40 asked): …`): if most calls sit in `<0.5` rather than
`<0.1`, the judge is unsure rather than certain, and `keepCallThreshold`
deserves a look. The per-call decisions, one line each with both
probabilities, the result's size and what the call was about, go to
`$.ui.log` and to `~/.claude/fast-jev-compaction.decisions.log` (the last
3000 lines are kept), so a stubbed Edit can be found afterwards. To check
the thresholds against a whole transcript rather than one round, run
`npm run calibrate` in the repository (see the root README).

A Jev `429` is retried after the `Retry-After` the server asks for; one
over 30 seconds fails the round to the built-in summary instead of holding
the compaction.

The `turn.complete` hook requests compaction when `context.percent` reaches
`compactAtPercent`, with an in-flight guard and hysteresis: it does not fire
again until the context has fallen 10 points below the threshold, or grown
10 points past the level at which it last fired. That keeps a session that
plateaus above the threshold from compacting on every turn.

## Configuration

The plugin declares these `userConfig` values in
`.claude-plugin/plugin.json`:

| Option | Default |
| --- | ---: |
| `backend` | `auto` |
| `claudeModel` | `haiku` |
| `keepThreshold` | `0.5` |
| `keepCallThreshold` | `0.5` |
| `dropCalls` | `stub` |
| `stubChars` | `120` |
| `pruneMachineText` | `true` |
| `preserveRecentMessages` | `6` |
| `compactAtPercent` | `60` |
| `minReductionRatio` | `0.25` |
| `nothingToPrune` | `keep` |
| `timeoutMs` | `90000` |
| `maxStateTokens` | `25000` (Claude judge: `80000`; fork: unbounded) |
| `maxRequestTokens` | `30000` (Claude judge: `100000`; fork: unbounded) |
| `truncateHeadChars` | `300` |
| `concurrency` | `4` |
| `arbiterModel` | `haiku` |
| `arbitrateBand` | `0.15` |
| `model` | `jev-latest` |

The TypeSafe key can be supplied as the sensitive `apiKey` plugin option or
through `TYPESAFE_API_KEY` (environment or the `env` block of
`~/.claude/settings.json`).

Every option except `apiKey`, `backend`, `claudeModel`, `arbiterModel`,
`compactAtPercent`, `minReductionRatio`, `nothingToPrune`, `timeoutMs` and
`model` is passed straight to the library; see the root README for what
they do.

## Install

Function hooks are an early-access Claude Code feature (2.1.274+). Enable
them before installing or loading the module:

```sh
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
export TYPESAFE_API_KEY="<your TypeSafe key>"   # optional: without it the Claude judge is used

claude plugin marketplace add tamaratran/fast-jev-compaction
claude plugin install fast-jev-compaction@fast-jev-compaction
```

For local development:

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .
```

An installed plugin is a copy taken at install time, not the source
directory, even for a directory marketplace. After changing the source, bump
the version in `.claude-plugin/plugin.json` and `marketplace.json`, run
`claude plugin update fast-jev-compaction@fast-jev-compaction`, then start
a new session. `/reload-plugins` does not replace a loaded hooks module: a
`/compact` after it still runs the copy the session started with. For a
tighter loop, load the source directory itself with `--plugin-dir` (or
`CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`
for the desktop app): that folder is watched, and a save reloads the module.

## Scope and caveat

Function hooks are early access and may change between Claude Code releases.
This mod uses the generated declarations from 2.1.274 in
`types/claude-code.d.ts`; regenerate and review that file after a
Claude Code upgrade.

References:

- [Claude Code plugins](https://code.claude.com/docs/en/plugins)
- [Claude Code plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
