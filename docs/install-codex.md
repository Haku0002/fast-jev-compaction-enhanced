# Install the retrieval companion in Codex

Codex CLI and desktop share MCP configuration. This installs versioned code and
Python dependencies in a separate runtime. It does not replace native `/compact`.

1. Use Python 3.10+ to provision the server:

   ```sh
   python scripts/install-codex-memory.py
   ```

2. Register its stable Node entrypoint:

   ```sh
   codex mcp add fast_jev_memory -- node /absolute/path/to/.codex/fast-jev-compaction/host.mjs
   ```

3. Add `env_vars = ["TYPESAFE_API_KEY"]` to that MCP server's config table if
   enabling Jev. Forward the existing environment value; never put a key in the
   repository or launcher. Set the key in the environment that launches Codex.

4. Start a fresh Codex client session and verify `memory_projects`,
   `memory_search`, `memory_read` and `memory_stats` are available. The current
   chat may need its tools reloaded after registering a new server.

The operator explicitly imports documents and approves external scoring scopes.
Use `--seed-db` and `--approved-manifest` to seed a previously approved public
snapshot; `--enable-jev` turns on scoring only for those exact source hashes.
`--proxy` configures the server child only. Existing databases are not replaced.
Private conversation test fixtures must not be seeded into a public-snapshot
manifest. The installer never scans unrelated files or writes credentials.

For updates, rerun the installer from the verified checkout; a new server process
loads the copied code. Its runtime is independent of any old conversation folder.
Record the installed file hashes and exercise the configured MCP server before
claiming an update is active.

Sources: [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp) and
[developer commands](https://learn.chatgpt.com/docs/developer-commands).
