import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Message, ToolResult, ToolUse } from '../src/index.js';

/**
 * Reads a Claude Code session transcript (`~/.claude/projects/<project>/<session>.jsonl`)
 * into the library's `Message[]`: one message per API message, the assistant's
 * text and tool_use blocks together, tool_result blocks on the user side,
 * thinking and host bookkeeping left out. Subagent (sidechain) entries are
 * skipped; they are not the session's own conversation.
 */
export function sessionToMessages(jsonl: string): Message[] {
  type Block = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
  type Entry = { type?: string; isSidechain?: boolean; message?: { id?: string; role?: string; content?: unknown } };

  const messages: Message[] = [];
  let lastAssistantId: string | undefined;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (entry.isSidechain || (entry.type !== 'user' && entry.type !== 'assistant') || !entry.message) continue;
    const content = entry.message.content;
    const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as Block[]) : [];

    if (entry.type === 'assistant') {
      const id = entry.message.id;
      let target = id !== undefined && id === lastAssistantId ? messages[messages.length - 1] : undefined;
      if (!target || target.role !== 'assistant') {
        target = { role: 'assistant', text: '', toolUses: [] };
        messages.push(target);
      }
      lastAssistantId = id;
      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
          target.text = target.text ? `${target.text}\n${block.text}` : block.text;
        } else if (block.type === 'tool_use' && typeof block.id === 'string') {
          const input = block.input !== null && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {};
          target.toolUses.push({ tool_use_id: block.id, tool: String(block.name ?? ''), input });
        }
      }
      continue;
    }

    lastAssistantId = undefined;
    const message: Message = { role: 'user', text: '', toolUses: [] };
    const results: ToolResult[] = [];
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        message.text = message.text ? `${message.text}\n${block.text}` : block.text;
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        results.push({ tool_use_id: block.tool_use_id, text: blockText(block.content), isError: block.is_error === true });
      }
    }
    if (results.length > 0) message.toolResults = results;
    if (message.text || results.length > 0) messages.push(message);
  }

  const byId = new Map<string, ToolResult>();
  for (const message of messages) for (const result of message.toolResults ?? []) byId.set(result.tool_use_id, result);
  for (const message of messages) {
    for (const tool of message.toolUses as ToolUse[]) {
      const result = byId.get(tool.tool_use_id);
      if (!result) continue;
      tool.text = result.text;
      if (result.isError) tool.isError = true;
    }
  }
  return messages;
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: { type?: string; text?: string }) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** The newest session transcript under `~/.claude/projects`, or of one project folder. */
export function newestSessionPath(projectDir?: string): string | undefined {
  const root = join(homedir(), '.claude', 'projects');
  const dirs = projectDir ? [projectDir] : readdirSync(root).map((name) => join(root, name));
  let newest: { path: string; mtime: number } | undefined;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      const mtime = statSync(path).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { path, mtime };
    }
  }
  return newest?.path;
}

export function loadSession(path: string): Message[] {
  return sessionToMessages(readFileSync(path, 'utf8'));
}
