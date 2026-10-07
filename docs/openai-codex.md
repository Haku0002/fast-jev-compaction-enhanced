# OpenAI and Codex integration

This work starts from `e2bdf63` (0.6.0). Upstream `tamaratran/main` is
`e3f262a` and is already an ancestor. Its open PRs are proposals, not releases.
`Haku0002/fast-jev-compaction-enhanced` has the same `e2bdf63` tip. Work continues locally
on `openai-codex`, with that repository as `origin` and the original as `upstream`.

## Workflow

1. Keep the calibrated Jev Noul questions and the existing Claude adapter.
2. Add an injectable OpenAI Responses judge with a strict answer schema. The
   caller chooses its model; no model is silently substituted. Missing or invalid
   answers preserve the affected calls.
   Claude Code can also explicitly select this backend over its host HTTP API.
3. Adapt raw Responses input to the core and rebuild from original items. Keep
   message roles, assistant `phase`, call ids, opaque reasoning/compaction items,
   images and unknown item types. Only complete, unambiguous text tool pairs are
   eligible for compaction.
4. Read Codex JSONL as an offline export. Apply the latest `replacement_history`
   before reading subsequent items; never count the pre-compaction log twice.
5. Provide a CLI that writes a separate Responses input file. Dry runs are local;
   judging sends the fitted state to the explicitly selected provider. Input files
   and existing output files must not be overwritten.
6. Validate provider failure, timeout, pairing, metadata preservation and Unicode
   boundaries with synthetic inputs, followed by the existing Claude tests.
7. Preserve the earlier Memory Shelf retrieval prototype separately. When
   Responses compaction changes the context, clear caller-held `known_refs`.
   See [the consolidated experiment](legacy-memory-shelf.md).

## Native Codex boundary

Codex `PreCompact` accepts control fields, including `continue: false`; it does
not accept a replacement message list. `thread/compact/start` invokes Codex's own
compaction. `thread/inject_items` appends items; it does not replace history.
The locally generated app-server schema labels `thread/resume.history` unstable
and for Codex Cloud only. This implementation does not use that field or edit a
running Codex rollout.

The adapter supports OpenAI API agents that own their input history and offline
Codex exports. It does not replace `/compact` in the stock Codex desktop/CLI.
Claude Code's `session.compact` adapter remains the native integration there.

Sources checked on 2026-10-07:

- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

## Upstream proposals relevant to this work

- [#132](https://github.com/tamaratran/fast-jev-compaction/pull/132) and
  [#110](https://github.com/tamaratran/fast-jev-compaction/pull/110): preserve
  Unicode surrogate pairs at truncation boundaries.
- [#117](https://github.com/tamaratran/fast-jev-compaction/pull/117): bound waits
  and clean up timers.
- [#126](https://github.com/tamaratran/fast-jev-compaction/pull/126): cap request
  cost and add another transport. This fork already uses windowed states; the
  proposal's cost model must not be copied without checking that difference.
- [#112](https://github.com/tamaratran/fast-jev-compaction/pull/112) and
  [#125](https://github.com/tamaratran/fast-jev-compaction/pull/125): guard native
  hook lifecycle and unsupported headless operations.

Archived-output recovery merits a separate opt-in design: retention markers
must point to actually saved output, storage needs an explicit destination, and
credentials must not be persisted. It is not enabled by this provider migration.
