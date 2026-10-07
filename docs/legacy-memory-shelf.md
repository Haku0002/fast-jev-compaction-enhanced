# Consolidated Memory Shelf experiment

The earlier local Memory Shelf prototype and its public-corpus reports were
reviewed on 2026-10-07. This file preserves the technical decisions relevant to
this project. Private chat references remain in local provenance, not this repo.

## User intent retained

- Retrieval is an auxiliary tool to reduce unnecessary context and repeat
  requests; it does not replace the agent's memory or native compaction.
- The core and MCP should remain portable. The old Codex machine adapter was
  experimental and separate.
- Evaluate on large, pinned public material with rewritten questions, distractors
  and absent-evidence cases. Mock connectivity is not retrieval-quality evidence.
- Only explicitly imported material belongs in the shelf. Empty search results
  do not establish that a game, file or fact does not exist on the machine.

## Preserved implementation

`retrieval/memory-shelf/` now contains the versioned SQLite/FTS store, budgeted
retrieval, optional Jev reranking, MCP server and their tests. The store preserves
original text and content hashes; returned references bind project, source,
version and exact character range. The MCP server defaults to local retrieval
and requires an exact approved snapshot manifest before external scoring.

The old `codex_host.py`, machine settings, approval manifest, credentials,
virtual environment and downloaded source-tree checkout were not migrated.
The old host automatically enabled Jev and read Claude settings; that lifecycle
is unsuitable for a portable Codex/OpenAI package. Generic environment-based
configuration takes its place.

After checking every document against the prior public-snapshot manifest and
recomputing all content hashes, the old SQLite store was also backed up locally
to `retrieval/memory-shelf/data/shelf.sqlite3`. It retains 561 public documents
and 11,297 chunks across the CPython corpus and fast-jev sample. That data folder
is excluded from Git and the npm package; no old external-scoring approval was
enabled. The portable source and historical reports are sufficient for other
users to create their own store, while this machine can keep using its existing
public index without depending on the old chat's directory.

Historical reports, cases, pinned corpus manifest and the CPython license are in
`retrieval/memory-shelf/benchmarks/`. Their old relative links describe the
original experiment; they do not imply that its raw corpus or every result file
is shipped here. The retrieval source also retains its sample-source license.

## Historical evidence, not a new benchmark

The September experiment used 559 CPython documentation files at commit
`972cfaae3f1349a2b822a0003e96e980c59a402f`, about 3.23 million reference tokens and
11,279 chunks. On the fixed 16 English questions, evidence at rank 1 improved
from 7/16 with local FTS to 13/16 with Jev; top 3 went from 9/16 to 14/16.

The final retrieval configuration retained 13/16 top 1 and 14/16 top 3, while
median returned reference tokens fell from 3,146 to 1,493. Same-query cache hits
took about 30 ms with zero Jev calls. First-query latency remained about 0.85 s.
These are archived measurements on a small known question set, using
`cl100k_base` as a reference counter; they are not billing or whole-task savings.

## Decisions and limitations retained

- Default to bounded complete source chunks, not generated summaries. A
  650-character preview experiment fell to 9/16 top 1 and was not adopted.
- Scoring cannot recover evidence missing from the candidate pool. Chinese
  queries over English documents need caller-supplied `retrieval_query`; no
  automatic multilingual semantic retrieval was demonstrated.
- Expanded/Porter recall had mixed results and stays experimental.
- Use `known_refs` only while exact text remains in current context. Clear it
  after compaction or handoff; references are not permanent read receipts.
- Cache keys bind the query, candidates, project revision and scorer version.
  Failed rankings must not be cached. Changing provider/model needs a different
  scorer identity.
- `insufficient_evidence` means broaden the search or consult another source,
  not that the entire corpus has no answer.
- Imported recency is not verified source freshness. Project filters are not a
  multi-user access boundary. Cache capacity and multilingual recall still need
  representative evaluation.

## Connection to the OpenAI work

The Responses compactor reports `contextChanged`. A caller using the shelf must
reset its `known_refs` when that is true. Opaque Responses items stay opaque;
this adapter does not ingest reasoning into the shelf. Recoverable archives of
selected dropped tool outputs are a future opt-in integration, not automatic
capture of conversations.

The existing Claude default remains calibrated Noul plus its configured arbiter.
The OpenAI judge needs representative retention evaluation before replacing a
default; wider score distributions and shorter histories do not prove quality.
