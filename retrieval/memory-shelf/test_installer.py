import contextlib
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from server import memory_projects


class InstallerTests(unittest.TestCase):
    def test_unseeded_provisioning_supports_read_only_discovery(self):
        source = Path(__file__).resolve().parents[2] / 'scripts' / 'install-codex-memory.py'
        spec = importlib.util.spec_from_file_location('memory_installer', source)
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        real_run = subprocess.run
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            interpreter = home / 'venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
            interpreter.parent.mkdir(parents=True)
            interpreter.touch()

            def run(command, **kwargs):
                if command[1:4] == ['-m', 'pip', 'install']:
                    return subprocess.CompletedProcess(command, 0)
                command[0] = sys.executable
                return real_run(command, **kwargs)

            # Dependency/bootstrap behavior is covered by the real installed runtime.
            # Exercise the actual isolated database-provisioning child here, without downloads.
            with patch.object(installer.subprocess, 'run', side_effect=run), \
                    patch.object(sys, 'argv', ['install-codex-memory.py', '--home', str(home)]), \
                    contextlib.redirect_stdout(io.StringIO()):
                installer.main()
            self.assertTrue((home / 'shelf.sqlite3').is_file())
            with patch.dict(os.environ, {'MEMORY_SHELF_DB': str(home / 'shelf.sqlite3'), 'MEMORY_SHELF_JEV': '0'}):
                self.assertEqual(memory_projects()['projects'], [])
