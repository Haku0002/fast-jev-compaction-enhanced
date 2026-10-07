# Local validation, 2026-10-07

Working branch: `openai-codex`, based on `e2bdf63` from
`Haku0002/fast-jev-compaction-enhanced`. Local feature version: 0.7.0.
Candidate checks were completed before publication and client installation.
The standalone MCP installation is documented in [install-codex.md](install-codex.md).

## Checks

- TypeScript: 83 tests pass, including 55 existing tests. New coverage includes
  Responses pairing/metadata, refusal/abstention, Unicode boundaries, bounded
  HTTP/body waits, selected endpoint/key behavior and CLI file protection.
- `npm run typecheck` and `npm run build` pass.
- `claude plugin validate .claude-plugin/plugin.json` passes. The host validator
  requires literal `$.env.get` names; both credential names are statically listed.
- Python retrieval: 18 unit/policy tests pass, including project discovery, scorer-identity cache
  invalidation and expired-cache cleanup.
- MCP stdio smoke: the migrated server initializes and lists all three tools;
  search/read and exact-reference dedup pass on the local public snapshot with
  zero external judge requests. `mcp_smoke.py` preserves that reproducible check.
- CLI: a real child process posts to a loopback mock Responses server and writes
  a separate compacted input file. Input is unchanged, call ids stay paired and
  the command verdict remains in the retained tail. Offline inspection and an
  existing destination are also checked.
- Package inspection excludes databases, credentials, approval manifests and
  Python bytecode. CLI, docs, portable retrieval and historical reports ship.
- The local public SQLite backup matches all previous approved source hashes;
  its 561 documents were rehashed before backup. Git and npm exclude the store.
- Installed-runtime verification: the registered `fast_jev_memory` Node launcher
  starts the independent Python runtime, lists four tools, completes a real
  `jev_live` query and a `jev_cache` repeat, and reads original evidence. No
  credential value is written to the runtime metadata or repository.

## Limits

The [current-chat test](current-chat-test.md) additionally ran a real OpenAI
judge through Codex's ChatGPT login. It found and fixed native text-array output
handling and checked one conversation copy. The direct Responses HTTP client
still has synthetic/loopback coverage only. General retention quality and
whole-task savings remain unproven. Historical Memory Shelf results remain historical.

The [Jev-first comparison](jev-current-chat-test.md) additionally exercised the
real TypeSafe service via `jev-latest`, an explicit `jev-preview` check, actual
Jev retrieval reranking/cache, and the exported `codexAsker` as a borderline
arbiter. Both aliases reported the same version label during this account check;
the client follows aliases rather than pinning response version strings.

Codex's native `/compact` cannot accept this library's replacement history through
the documented hook interface. This version supports API-owned history, offline
Codex exports and optional MCP retrieval. Claude Code retains its native hook;
new hook code requires a new session after an installed artifact is updated.
