# Memory Shelf

Optional retrieval companion for Codex, Claude or another MCP client. SQLite
stores explicitly imported original text and versions. FTS retrieves candidates;
Jev reranking is opt-in. It does not rewrite live conversations.

The portable core and CLI require Python 3.10+ with SQLite FTS5. MCP additionally
requires `pip install -r retrieval/memory-shelf/requirements.txt`. `tiktoken` is
optional for reference-token counts; otherwise responses use a conservative
UTF-8 byte budget. No existing Claude credential file is read.

This machine also retains a verified public-corpus SQLite snapshot under
`data/`, with 559 CPython documents and the two-document fast-jev sample. That
local snapshot is ignored by Git and excluded from the npm package. It grants
no new external-scoring permission; other installations start with an empty
store and explicitly import their own material.

From the repository root:

```sh
python retrieval/memory-shelf/shelf.py --db /path/to/shelf.sqlite3 ingest /path/to/notes.md --project example
python retrieval/memory-shelf/efficient.py 'query terms' --db /path/to/shelf.sqlite3 --project example
python retrieval/memory-shelf/shelf.py --db /path/to/shelf.sqlite3 read 1 --project example
python -m unittest discover -s retrieval/memory-shelf -p 'test_*.py'
python retrieval/memory-shelf/mcp_smoke.py --db /path/to/shelf.sqlite3 --project example --query 'known evidence'
```

Use `--jev` only when the query and candidate excerpts may be sent to TypeSafe;
its credential is `TYPESAFE_API_KEY`. The direct CLI flag explicitly opts in.
For MCP, run `python retrieval/memory-shelf/server.py` over stdio and configure
`MEMORY_SHELF_DB` for the desired store. The default remains offline.
`memory_projects` lists imported scopes before choosing `memory_search`,
`memory_read` or `memory_stats`. For a standalone installed Codex runtime, see
[installation](../../docs/install-codex.md).

External MCP reranking additionally needs `MEMORY_SHELF_JEV=1` and
`MEMORY_SHELF_EXTERNAL_MANIFEST` pointing to an operator-approved manifest.
That manifest maps each permitted project to its exact ordered document rows
(`id`, `source`, `sha256`). Adding or changing any source disables external
scoring for that snapshot. This repository does not ship an approval manifest.

Defaults: up to 3 original excerpts, a 2,200 reference-token/byte budget,
classic recall and a one-hour score cache. `retrieval_query` supplies translated
recall terms separately from the original query. `known_refs` suppresses only
exact excerpts still in current context; clear it after compaction or handoff.
Low scores produce `insufficient_evidence`, which calls for broader retrieval.

[Consolidated experiment](../../docs/legacy-memory-shelf.md) records the old
chat's decisions, historical results and limitations. The reports under
`benchmarks/` are historical; no live benchmark was repeated during migration.
