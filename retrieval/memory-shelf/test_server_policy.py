import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from efficient import EfficientShelf
from server import external_allowed, memory_projects


class ExternalPolicyTests(unittest.TestCase):
    def test_project_discovery_lists_metadata_without_returning_document_text(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'data.db'
            shelf = EfficientShelf(path)
            shelf.ingest('local-project', 'local-source', 'document', 'text must not be returned by project listing')
            shelf.close()
            with patch.dict(os.environ, {'MEMORY_SHELF_DB': str(path), 'MEMORY_SHELF_JEV': '0'}):
                result = memory_projects()
            self.assertEqual(result['projects'], [{'project': 'local-project', 'revisions': 1, 'sources': 1, 'jev_enabled_for_snapshot': False}])
            self.assertNotIn('text must not be returned', json.dumps(result))

    def test_only_unchanged_approved_snapshot_can_use_external_judge(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)
            shelf=EfficientShelf(path/'data.db')
            shelf.ingest('public','public-url','doc','public evidence')
            rows=[dict(r) for r in shelf.db.execute('SELECT id,source,sha256 FROM documents ORDER BY id')]
            (path/'allow.json').write_text(json.dumps({'public':rows}),encoding='utf-8')
            env={'MEMORY_SHELF_DB':str(path/'data.db'),'MEMORY_SHELF_JEV':'1',
                 'MEMORY_SHELF_EXTERNAL_MANIFEST':str(path/'allow.json')}
            with patch.dict(os.environ,env):
                self.assertTrue(external_allowed('public'))
                self.assertFalse(external_allowed('private'))
                shelf.ingest('public','new-source','doc','new material not yet authorized')
                self.assertFalse(external_allowed('public'))
            shelf.close()


if __name__=='__main__':
    unittest.main(verbosity=2)
