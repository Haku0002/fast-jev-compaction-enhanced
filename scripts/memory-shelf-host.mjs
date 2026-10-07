/** Stable installed MCP entrypoint. Runtime metadata contains paths, never keys. */
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = process.env.MEMORY_SHELF_HOME ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'fast-jev-compaction');
let config;
try { config = JSON.parse(await readFile(join(home, 'runtime.json'), 'utf8')); }
catch { throw new Error('Memory Shelf runtime is not installed; run scripts/install-codex-memory.py first'); }
const env = { ...process.env, MEMORY_SHELF_DB: join(home, 'shelf.sqlite3'),
  MEMORY_SHELF_EXTERNAL_MANIFEST: join(home, 'approved-public-snapshots.json'),
  MEMORY_SHELF_JEV: config.enable_jev ? '1' : '0',
  TIKTOKEN_CACHE_DIR: join(home, 'tokenizer-cache'), PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8',
  ...(config.proxy ? { HTTP_PROXY: config.proxy, HTTPS_PROXY: config.proxy } : {}) };
const child = spawn(config.python, [join(config.server_dir, 'server.py')], { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { process.stderr.write('Could not start the installed Memory Shelf runtime\n'); process.exitCode = 1; });
child.on('close', (code) => { process.exitCode = code ?? 1; });
