"""Verify a local search/read MCP roundtrip without enabling external scoring."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def value(result):
    if result.isError:
        raise RuntimeError('MCP tool returned an error')
    return json.loads(result.content[0].text)


async def check(db, project, query):
    server = Path(__file__).resolve().with_name('server.py')
    env = {**os.environ, 'MEMORY_SHELF_DB': str(Path(db).resolve()),
           'MEMORY_SHELF_JEV': '0', 'PYTHONDONTWRITEBYTECODE': '1'}
    params = StdioServerParameters(command=sys.executable, args=[str(server)], env=env)
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as client:
            await client.initialize()
            names = sorted(tool.name for tool in (await client.list_tools()).tools)
            assert names == ['memory_projects', 'memory_read', 'memory_search', 'memory_stats']
            args = {'project': project, 'query': query, 'limit': 1}
            found = value(await client.call_tool('memory_search', args))
            assert found['mode'] == 'local' and found['results'], 'Choose a query with local evidence'
            item = found['results'][0]
            original = value(await client.call_tool('memory_read', {
                'project': project, 'chunk_id': item['chunk_id'], 'max_chars': 1400}))
            assert original['text'] and original['source'] == found['sources'][item['doc']]['uri']
            repeat = value(await client.call_tool('memory_search', {**args, 'known_refs': [item['ref']]}))
            assert repeat['status'] == 'already_in_context' and not repeat['results']
            stats = value(await client.call_tool('memory_stats', {'project': project}))
            assert stats['jev_enabled_for_snapshot'] is False
            return {'tools': names, 'search_read': 'PASS', 'exact_reference_dedup': 'PASS',
                    'external_judge_requests': 0}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', required=True)
    parser.add_argument('--project', required=True)
    parser.add_argument('--query', required=True)
    args = parser.parse_args()
    if not Path(args.db).is_file():
        parser.error('--db must be an existing imported shelf')
    print(json.dumps(asyncio.run(check(args.db, args.project, args.query))))
