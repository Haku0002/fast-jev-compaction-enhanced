#!/usr/bin/env node

import { runClaudeHook } from './hooks.js';

let source = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  source += chunk;
}

try {
  const input: unknown = JSON.parse(source);
  const result = await runClaudeHook(input, {
    apiKey: process.env.TYPESAFE_API_KEY,
    goal: process.env.FAST_JEV_GOAL,
    dropThreshold: process.env.FAST_JEV_DROP_THRESHOLD
      ? Number(process.env.FAST_JEV_DROP_THRESHOLD)
      : undefined,
    maxContextChars: process.env.FAST_JEV_MAX_CONTEXT_CHARS
      ? Number(process.env.FAST_JEV_MAX_CONTEXT_CHARS)
      : undefined,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 0;
}
