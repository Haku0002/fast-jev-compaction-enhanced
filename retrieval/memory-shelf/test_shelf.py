import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from shelf import Shelf


class ShelfTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.shelf = Shelf(Path(self.tmp.name) / 'test.db')

    def tearDown(self):
        self.shelf.close()
        self.tmp.cleanup()

    def test_chinese_retrieval_and_project_isolation(self):
        self.shelf.ingest('a', 'doc', '配置', '压缩阈值设为百分之六十。')
        self.shelf.ingest('b', 'secret', '配置', '另一个项目的压缩阈值。')
        results = self.shelf.search('a', '压缩阈值')['results']
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]['source'], 'doc')
        with self.assertRaises(ValueError):
            self.shelf.read('b', results[0]['chunk_id'])

    def test_revisions_revert_and_idempotence(self):
        old = self.shelf.ingest('a', 'doc', 'settings', 'threshold alpha')
        self.assertTrue(self.shelf.ingest('a', 'doc', 'settings', 'threshold alpha')['unchanged'])
        old_chunk = self.shelf.search('a', 'alpha')['results'][0]['chunk_id']
        self.shelf.ingest('a', 'doc', 'settings', 'threshold beta')
        self.assertFalse(self.shelf.search('a', 'alpha')['results'])
        self.assertTrue(self.shelf.search('a', 'alpha', include_history=True)['results'])
        self.assertFalse(self.shelf.read('a', old_chunk)['is_latest'])
        new = self.shelf.ingest('a', 'doc', 'settings', 'threshold alpha')
        self.assertNotEqual(old['document_id'], new['document_id'])
        self.assertEqual(self.shelf.search('a', 'alpha')['results'][0]['document_id'], new['document_id'])

    def test_exact_unicode_pagination_and_budget(self):
        content = ('threshold 中文🙂\r\n' * 600) + 'THE END'
        self.shelf.ingest('a', 'doc', 'original', content)
        chunk = self.shelf.db.execute('SELECT id FROM chunks ORDER BY start LIMIT 1').fetchone()[0]
        offset, pieces = 0, []
        while True:
            page = self.shelf.read('a', chunk, offset, 231)
            pieces.append(page['text'])
            if page['next_offset'] is None:
                break
            offset = page['next_offset']
        self.assertEqual(''.join(pieces), content)
        result = self.shelf.search('a', 'threshold', budget_chars=2000)
        self.assertTrue(result['results'])
        self.assertLessEqual(result['result_chars'], 2000)
        self.assertFalse(self.shelf.search('a', 'threshold', budget_chars=256)['results'])

    def test_query_syntax_is_data_and_unknown_is_empty(self):
        self.shelf.ingest('a', 'doc', 'file', 'threshold')
        self.assertFalse(self.shelf.search('a', 'xyzunknown')['results'])
        self.assertFalse(self.shelf.search('a', '" OR * - :')['results'])

    def test_jev_is_opt_in_and_failure_preserves_local_results(self):
        self.shelf.ingest('a', 'doc', 'file', 'threshold evidence')
        with patch('shelf.urllib.request.urlopen') as request:
            self.shelf.search('a', 'threshold')
            request.assert_not_called()
        with patch.dict(os.environ, {}, clear=True):
            result = self.shelf.search('a', 'threshold', use_jev=True)
        self.assertEqual(result['mode'], 'local_fts_fallback')
        self.assertTrue(result['results'])

    def test_jev_response_validation_and_ranking(self):
        for name in ('one', 'two'):
            self.shelf.ingest('a', name, name, 'threshold ' + name)
        baseline = self.shelf.search('a', 'threshold')['results']
        scores = {str(row['chunk_id']): {'noul': value}
                  for row, value in zip(baseline, [0.1, 0.9])}
        with patch.dict(os.environ, {'TYPESAFE_API_KEY': 'fake-test-only'}), \
                patch('shelf.urllib.request.urlopen') as request:
            response = request.return_value.__enter__.return_value
            response.read.return_value = json.dumps({'answers': scores}).encode()
            result = self.shelf.search('a', 'threshold', use_jev=True)
            self.assertEqual(result['mode'], 'jev_reranked')
            self.assertEqual(result['results'][0]['chunk_id'], baseline[1]['chunk_id'])
            sent = json.loads(request.call_args.args[0].data)
            self.assertEqual(len(sent['state']['candidates']), 2)
            response.read.return_value = b'{"answers": {}}'
            fallback = self.shelf.search('a', 'threshold', use_jev=True)
            self.assertEqual(fallback['mode'], 'local_fts_fallback')
            self.assertEqual(fallback['results'][0]['chunk_id'], baseline[0]['chunk_id'])

    def test_translated_recall_keeps_original_question_for_judge(self):
        self.shelf.ingest('a', 'doc', 'clock', 'monotonic clock unaffected by system clock updates')
        self.assertFalse(self.shelf.search('a', '如何测量耗时')['results'])
        with patch('shelf.jev_rank') as rank:
            rank.side_effect = lambda query, rows: (rows, {})
            result = self.shelf.search('a', '如何测量耗时', use_jev=True,
                                      retrieval_query='monotonic clock')
        self.assertTrue(result['results'])
        self.assertEqual(rank.call_args.args[0], '如何测量耗时')
        self.assertEqual(result['retrieval_query'], 'monotonic clock')

    def test_invalid_retrieval_query_fails_before_network(self):
        with patch('shelf.jev_rank') as rank:
            for query in ['', 'x' * 1001]:
                with self.assertRaises(ValueError):
                    self.shelf.search('a', 'original', use_jev=True, retrieval_query=query)
            rank.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)
