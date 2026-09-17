// Reference example; the Agent SDK is intentionally not a package dependency.
import { query, type HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { runClaudeHook } from '../src/index.js';

const runInProcess: HookCallback = async (input) => {
  const result = await runClaudeHook(input, {
    apiKey: process.env.TYPESAFE_API_KEY,
    goal: process.env.FAST_JEV_GOAL,
  });
  return result.stdout
    ? JSON.parse(result.stdout)
    : {};
};

const messages = query({
  prompt: 'Continue the coding task.',
  options: {
    hooks: {
      PreCompact: [{ hooks: [runInProcess] }],
      SessionStart: [{ matcher: 'compact', hooks: [runInProcess] }],
    },
  },
});

for await (const message of messages) {
  console.log(message);
}
