import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from efficient import EfficientShelf
from server import mcp, memory_projects, memory_read, memory_stats


class ServerMetadataTests(unittest.IsolatedAsyncioTestCase):
    async def test_advertised_permissions_match_tool_effects(self):
        tools = {tool.name: tool for tool in await mcp.list_tools()}
        self.assertEqual(set(tools), {'memory_search', 'memory_read', 'memory_projects', 'memory_stats'})
        for name, tool in tools.items():
            self.assertIsNotNone(tool.annotations)
            self.assertFalse(tool.annotations.destructiveHint, name)
            self.assertEqual(tool.annotations.readOnlyHint, name != 'memory_search', name)
            self.assertEqual(tool.annotations.openWorldHint, name == 'memory_search', name)
            self.assertEqual(tool.annotations.idempotentHint, name != 'memory_search', name)


class ServerReadTests(unittest.TestCase):
    def test_read_tools_open_existing_evidence_without_writes(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'evidence.db'
            shelf = EfficientShelf(path)
            shelf.ingest('public', 'https://example.test/doc', 'Evidence', 'verified archived evidence')
            chunk = shelf.db.execute('SELECT id FROM chunks').fetchone()[0]
            before = list(shelf.db.iterdump())
            shelf.close()
            with patch.dict(os.environ, {'MEMORY_SHELF_DB': str(path), 'MEMORY_SHELF_JEV': '0'}):
                self.assertEqual(memory_projects()['projects'][0]['project'], 'public')
                self.assertEqual(memory_stats('public')['sources'], 1)
                self.assertIn('verified archived evidence', memory_read('public', chunk)['text'])
            readonly = EfficientShelf(path, read_only=True)
            try:
                self.assertEqual(list(readonly.db.iterdump()), before)
                with self.assertRaises(sqlite3.OperationalError):
                    readonly.db.execute('DELETE FROM documents')
            finally:
                readonly.close()

    def test_read_tools_do_not_create_a_missing_database(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'missing' / 'evidence.db'
            with patch.dict(os.environ, {'MEMORY_SHELF_DB': str(path), 'MEMORY_SHELF_JEV': '0'}):
                for call in (memory_projects, lambda: memory_stats('public'), lambda: memory_read('public', 1)):
                    with self.assertRaises(sqlite3.OperationalError):
                        call()
            self.assertFalse(path.parent.exists())
