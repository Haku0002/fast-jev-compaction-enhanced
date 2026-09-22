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

`backend: auto` (the default) picks Jev when a key is available, Claude
otherwise.

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
4. On a judge failure (network, malformed answer, missing key) the hook logs
   the reason and delegates to the built-in summary.

Every outcome goes to `$.ui.log`, to a toast (not on `precompute` or for a
subagent's transcript), to the plugin store (`lastCompaction`) and to
`~/.claude/fast-jev-compaction.log`, so a headless or desktop install can
tell which path a compaction took. The per-call `decisions:` lines with both
probabilities are logged for diagnosis.

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
| `maxStateTokens` | `25000` (Claude judge: `80000`) |
| `maxRequestTokens` | `30000` (Claude judge: `100000`) |
| `truncateHeadChars` | `300` |
| `concurrency` | `4` |
| `model` | `jev-latest` |

The TypeSafe key can be supplied as the sensitive `apiKey` plugin option or
through `TYPESAFE_API_KEY` (environment or the `env` block of
`~/.claude/settings.json`).

Every option except `apiKey`, `backend`, `claudeModel`, `compactAtPercent`,
`minReductionRatio`, `nothingToPrune` and `model` is passed straight to the
library; see the root README for what they do.

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

## Scope and caveat

Function hooks are early access and may change between Claude Code releases.
This mod uses the generated declarations from 2.1.274 in
`types/claude-code.d.ts`; regenerate and review that file after a
Claude Code upgrade.

References:

- [Claude Code plugins](https://code.claude.com/docs/en/plugins)
- [Claude Code plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
