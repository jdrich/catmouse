import { randomUUID } from 'node:crypto';
import { completionsAdapter } from './completions.ts';
import * as grokCli from './grok-cli/index.ts';
import type { Adapter } from './types.ts';

/** Named providers. Same Adapter interface; different auth/wire impls. */
export const adapters = {
  xai: completionsAdapter('xai', {
    baseURL: 'https://api.x.ai/v1',
    keyEnv: 'XAI_API_KEY',
    api: 'chat',
  }),
  opencode: completionsAdapter('opencode', {
    baseURL: 'https://opencode.ai/zen/go/v1',
    keyEnv: 'OPENCODE_API_KEY',
    api: 'chat',
    // Grok/GPT on Go are /responses; the rest are chat/completions.
    apiForModel: (model) =>
      /^(grok-|gpt-)/i.test(model) ? 'responses' : 'chat',
    // Go requires a stable conversation id + a named UA.
    // https://opencode.ai/docs/go/#where-can-i-use-it
    // New UUID per resolveClient — one conversation per level, not the whole run.
    headers: () => ({
      'User-Agent': 'catmouse/1.0',
      'x-opencode-session': randomUUID(),
    }),
  }),
  [grokCli.id]: grokCli,
} as const satisfies Record<string, Adapter>;

export type AdapterId = keyof typeof adapters;
export type { Adapter, ListAuth } from './types.ts';
