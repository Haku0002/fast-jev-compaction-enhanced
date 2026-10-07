"""Provision a standalone MCP runtime without storing credentials or scanning files."""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import venv

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=Path(os.environ.get('CODEX_HOME', Path.home()/'.codex'))/'fast-jev-compaction')
    parser.add_argument('--seed-db', type=Path)
    parser.add_argument('--approved-manifest', type=Path)
    parser.add_argument('--proxy')
    parser.add_argument('--enable-jev', action='store_true')
    args = parser.parse_args()
    home = args.home.resolve()
    home.mkdir(parents=True, exist_ok=True)
    interpreter = home/'venv'/('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if not interpreter.exists():
        venv.EnvBuilder(with_pip=True).create(home/'venv')
    dependencies = ['mcp==1.30.0', 'tiktoken==0.14.0']
    command = [str(interpreter), '-m', 'pip', 'install', '--disable-pip-version-check', *dependencies]
    if args.proxy:
        command.extend(['--proxy', args.proxy])
    installed = subprocess.run(command, capture_output=True, text=True)
    if installed.returncode:
        raise RuntimeError('Runtime dependency installation failed; pip diagnostics were not copied into project files')
    server_dir = home/'server'/'0.7.0'
    server_dir.mkdir(parents=True, exist_ok=True)
    for name in ['shelf.py', 'efficient.py', 'server.py']:
        shutil.copy2(ROOT/'retrieval'/'memory-shelf'/name, server_dir/name)
    shutil.copy2(ROOT/'scripts'/'memory-shelf-host.mjs', home/'host.mjs')
    db_path = home/'shelf.sqlite3'
    if args.seed_db and not db_path.exists():
        source = sqlite3.connect(args.seed_db.resolve().as_uri()+'?mode=ro', uri=True)
        try:
            with sqlite3.connect(db_path) as destination:
                source.backup(destination)
        finally:
            source.close()
    if not db_path.exists():
        # Provisioning, rather than read-only tools, owns creation of an empty shelf.
        initialized = subprocess.run([str(interpreter), '-c',
            'import sys; sys.path.insert(0,sys.argv[1]); from efficient import EfficientShelf; '
            'shelf=EfficientShelf(sys.argv[2]); shelf.close()', str(server_dir), str(db_path)],
            env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}, capture_output=True, text=True)
        if initialized.returncode:
            raise RuntimeError('Could not provision the empty retrieval database')
    if args.approved_manifest:
        approved = json.loads(args.approved_manifest.read_text(encoding='utf-8'))
        with sqlite3.connect(db_path) as db:
            db.row_factory = sqlite3.Row
            for project, expected in approved.items():
                rows = [dict(row) for row in db.execute('SELECT id,source,sha256 FROM documents WHERE project=? ORDER BY id', (project,))]
                if not rows or rows != expected:
                    raise RuntimeError('Approved snapshot did not match the selected database')
                for row in db.execute('SELECT content,sha256 FROM documents WHERE project=?', (project,)):
                    if hashlib.sha256(row['content'].encode('utf-8')).hexdigest() != row['sha256']:
                        raise RuntimeError('Snapshot content hash mismatch')
        (home/'approved-public-snapshots.json').write_text(json.dumps(approved, indent=2)+'\n', encoding='utf-8')
    if args.enable_jev and not (home/'approved-public-snapshots.json').exists():
        raise RuntimeError('Jev requires an explicit approved snapshot manifest')
    config = {'version': '0.7.0', 'python': str(interpreter), 'server_dir': str(server_dir),
              'enable_jev': args.enable_jev, 'proxy': args.proxy}
    (home/'runtime.json').write_text(json.dumps(config, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'runtime_home': str(home), 'version': config['version'], 'jev_enabled': args.enable_jev,
                      'database_exists': db_path.exists(), 'credentials_written': False}))


if __name__ == '__main__':
    main()
