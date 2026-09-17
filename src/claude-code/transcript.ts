import { readFile } from 'node:fs/promises';

import type { Message } from '../messages.js';
import type { Role } from '../types.js';

// Claude Code's transcript schema is internal and versioned; keep this parser defensive.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .flatMap((block) => {
      if (!isRecord(block) || block.type !== 'text') return [];
      return typeof block.text === 'string' ? [block.text] : [];
    })
    .join('\n');
}

function toolUseText(block: Record<string, unknown>): string {
  const name = typeof block.name === 'string' ? block.name : 'unknown';
  let input = '';
  try {
    input = JSON.stringify(block.input) ?? 'null';
  } catch {
    input = '[unserializable input]';
  }
  return `[tool_use ${name}] ${input}`.slice(0, 500);
}

function parseEntry(value: unknown): Message[] {
  if (!isRecord(value)) return [];
  if (value.isMeta === true || value.isSidechain === true) return [];
  const type = value.type;
  if (type !== 'user' && type !== 'assistant') return [];
  const message = value.message;
  if (!isRecord(message) || message.role !== type) return [];
  if (message.isMeta === true || message.isSidechain === true) return [];

  const content = message.content;
  if (typeof content === 'string') {
    return content.trim() ? [{ role: type, content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const messages: Message[] = [];
  const textBlocks: string[] = [];
  const flushText = () => {
    const text = textBlocks.join('\n');
    textBlocks.length = 0;
    if (text.trim()) messages.push({ role: type, content: text });
  };

  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      textBlocks.push(block.text);
    } else if (block.type === 'tool_result') {
      flushText();
      const toolContent = textFromContent(block.content);
      if (toolContent.trim()) messages.push({ role: 'tool', content: toolContent });
    } else if (block.type === 'tool_use') {
      flushText();
      messages.push({ role: 'assistant', content: toolUseText(block) });
    }
  }
  flushText();
  return messages;
}

export async function readTranscript(path: string): Promise<Message[]> {
  const source = await readFile(path, 'utf8');
  const messages: Message[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      messages.push(...parseEntry(JSON.parse(line) as unknown));
    } catch {
      // Individual malformed lines should not prevent best-effort recovery.
    }
  }
  return messages;
}
