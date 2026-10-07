import json
from pathlib import Path
import tempfile
import unittest

from efficient import EfficientShelf, counter


class EfficientTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.calls = 0
        def ranker(query, rows):
            self.calls += 1
            return [{**row, 'relevance': .9 - i * .1} for i, row in enumerate(rows)], {'input_tokens': 100, 'output_tokens': 10}
        self.shelf = EfficientShelf(Path(self.tmp.name) / 'test.db', ranker=ranker)
        for source in ('one', 'two'):
            self.shelf.ingest('p', source, source, ('cache evidence ' + source + '\n') * 100)

    def tearDown(self):
        self.shelf.close()
        self.tmp.cleanup()

    def test_cache_hit_and_version_invalidation(self):
        first = self.shelf.lookup('p', 'cache evidence', use_jev=True)
        second = self.shelf.lookup('p', 'cache evidence', use_jev=True)
        self.assertEqual((first['mode'], second['mode']), ('jev_live', 'jev_cache'))
        self.assertEqual(self.calls, 1)
        self.assertEqual(second['metrics']['input_tokens'], 0)
        self.shelf.ingest('p', 'one', 'one', 'updated cache evidence')
        self.shelf.lookup('p', 'cache evidence', use_jev=True)
        self.assertEqual(self.calls, 2)

    def test_expiration_and_failed_rank_are_not_reused(self):
        self.shelf.cache_ttl = -1
        self.shelf.lookup('p', 'cache', use_jev=True)
        self.shelf.lookup('p', 'cache', use_jev=True)
        self.assertEqual(self.calls, 2)
        def fail(query, rows):
            raise TimeoutError()
        self.shelf.ranker = fail
        result = self.shelf.lookup('p', 'cache', use_jev=True)
        self.assertEqual(result['mode'], 'local_fallback')
        self.assertTrue(result['results'])

    def test_acknowledged_refs_only_suppress_exact_evidence(self):
        first = self.shelf.lookup('p', 'cache')
        refs = [r['ref'] for r in first['results']]
        second = self.shelf.lookup('p', 'cache', known_refs=refs)
        self.assertEqual(second['status'], 'already_in_context')
        self.assertEqual(second['results'], [])
        self.assertEqual(second['sources'], {})
        self.shelf.ingest('other', 'one', 'one', 'cache evidence one\n' * 100)
        other = self.shelf.lookup('other', 'cache', known_refs=refs)
        self.assertTrue(other['results'])

    def test_complete_response_budget_and_exact_preview(self):
        result = self.shelf.lookup('p', 'cache', max_tokens=512)
        count, _ = counter()
        self.assertLessEqual(count(result), 512)
        self.assertEqual(count(result), result['metrics']['returned_tokens'])
        for row in result['results']:
            source = self.shelf.db.execute('SELECT content FROM documents WHERE id=?', (row['doc'],)).fetchone()[0]
            self.assertEqual(row['text'], source[row['start']:row['end']])

    def test_low_relevance_produces_explicit_insufficiency(self):
        self.shelf.ranker = lambda q, rows: ([{**r, 'relevance': .05} for r in rows], {})
        result = self.shelf.lookup('p', 'cache', use_jev=True)
        self.assertEqual(result['status'], 'insufficient_evidence')
        self.assertFalse(result['results'])

    def test_empty_and_single_candidate_do_not_call_judge(self):
        empty = self.shelf.lookup('p', 'xyzzzz', use_jev=True)
        self.assertEqual(empty['status'], 'no_candidates')
        self.shelf.ingest('single', 'only', 'one', 'unique evidence')
        result = self.shelf.lookup('single', 'unique', use_jev=True)
        self.assertEqual(result['mode'], 'local_single_candidate')
        self.assertEqual(self.calls, 0)

    def test_scorer_identity_and_expired_cache_cleanup(self):
        self.shelf.lookup('p', 'cache', use_jev=True)
        self.shelf.scorer_version = 'different-provider-or-model'
        self.shelf.lookup('p', 'cache', use_jev=True)
        self.assertEqual(self.calls, 2)
        self.shelf.db.execute('UPDATE ranking_cache SET expires=0')
        self.shelf.db.commit()
        self.shelf.lookup('p', 'cache', use_jev=True)
        expired = self.shelf.db.execute('SELECT COUNT(*) FROM ranking_cache WHERE expires=0').fetchone()[0]
        self.assertEqual(expired, 0)

    def test_validation_and_project_isolation(self):
        self.assertFalse(self.shelf.lookup('unknown', 'cache')['results'])
        for refs in [['invalid'], ['a' * 24] * 101]:
            with self.assertRaises(ValueError):
                self.shelf.lookup('p', 'cache', known_refs=refs)
        with self.assertRaises(ValueError):
            self.shelf.lookup('p', 'cache', retrieval_query='')


if __name__ == '__main__':
    unittest.main(verbosity=2)
