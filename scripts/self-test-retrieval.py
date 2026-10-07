"""Measure MCP retrieval and explicit dedup on sanitized messages from the current chat."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'retrieval'/'memory-shelf'))
from efficient import EfficientShelf
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def parsed(result):
    if result.isError:
        raise RuntimeError('MCP tool failed')
    return json.loads(result.content[0].text)


def content(item):
    value = item.get('content', '')
    return '\n'.join(block.get('text', '') for block in value) if isinstance(value, list) else str(value)


async def main(directory):
    directory = Path(directory).resolve()
    data = json.loads((directory/'sanitized-input.json').read_text(encoding='utf-8'))
    db = directory/'retrieval.sqlite3'
    project = 'current-chat-sanitized'
    shelf = EfficientShelf(db)
    messages = [(index, item) for index, item in enumerate(data) if item.get('type') == 'message' and item.get('role') in ('user', 'assistant') and content(item).strip()]
    try:
        for index, item in messages:
            shelf.ingest(project, f'self-test://current-chat#message-{index}', f"{item['role']} message {index}", content(item))
    finally:
        shelf.close()
    cases = [
        ('当前项目的新仓库地址是什么？', 'Haku0002 fast jev compaction enhanced', ['Haku0002/fast-jev-compaction-enhanced']),
        ('Codex 的原生 compact 能被这个库直接替换吗？', 'Codex compact hooks', ['不支持替换整份历史']),
        ('压缩前这一轮的 TypeScript 和 Python 验证数量是多少？', '76 17 TypeScript Python', ['76', '17']),
    ]
    results = []
    env = {**os.environ, 'MEMORY_SHELF_DB': str(db), 'MEMORY_SHELF_JEV': '0', 'PYTHONDONTWRITEBYTECODE': '1'}
    params = StdioServerParameters(command=sys.executable, args=[str(ROOT/'retrieval'/'memory-shelf'/'server.py')], env=env)
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as client:
            await client.initialize()
            for query, retrieval_query, expected in cases:
                request = {'project': project, 'query': query, 'retrieval_query': retrieval_query, 'limit': 3, 'max_tokens': 2200}
                first = parsed(await client.call_tool('memory_search', request))
                texts = [row['text'] for row in first['results']]
                hit = lambda text: all(word in text for word in expected)
                refs = [row['ref'] for row in first['results']]
                repeated = parsed(await client.call_tool('memory_search', {**request, 'known_refs': refs}))
                assert repeated['status'] == 'already_in_context' and not repeated['results']
                results.append({'query': query, 'top1': bool(texts) and hit(texts[0]), 'top3': any(hit(text) for text in texts),
                    'status': first['status'], 'returned_reference_tokens': first['metrics']['returned_tokens'],
                    'repeat_reference_tokens': repeated['metrics']['returned_tokens'], 'mode': first['mode'],
                    'budget_unit': first['metrics']['budget_unit'], 'external_judge_calls': first['metrics']['api_calls'],
                    'dedup_status': repeated['status']})
            # Clearing known_refs after a context change must bring evidence back.
            first_case = cases[0]
            reset = parsed(await client.call_tool('memory_search', {'project': project, 'query': first_case[0], 'retrieval_query': first_case[1], 'known_refs': []}))
            assert reset['results']
    report = {'project': project, 'messages_imported': len(messages), 'queries': results,
              'top1_hits': sum(row['top1'] for row in results), 'top3_hits': sum(row['top3'] for row in results),
              'dedup_checks_passed': len(results), 'reset_restores_evidence': True, 'external_judge_calls': 0,
              'scope': 'Local MCP retrieval of visible sanitized user/assistant messages only; no automatic conversation ingestion.'}
    (directory/'retrieval-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    asyncio.run(main(args.out))
