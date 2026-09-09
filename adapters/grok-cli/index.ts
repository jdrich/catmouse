import type { ClientConfig } from '../../harness/genericClient.ts';
import type { Adapter, ListAuth, ProviderSpec } from '../types.ts';
import { ensureGrokSession, grokProxyHeaders, loadSession } from './oauth.ts';

export const id = 'grok-cli' as const;

export const spec: ProviderSpec = {
  baseURL: 'https://cli-chat-proxy.grok.com/v1',
  api: 'responses',
};

export async function resolveClient(model: string): Promise<ClientConfig> {
  const session = await ensureGrokSession();
  return {
    apiKey: session.accessToken,
    baseURL: process.env.GROK_CLI_BASE_URL || session.baseUrl || spec.baseURL,
    model,
    api: spec.api,
    headers: grokProxyHeaders(model),
  };
}

export async function resolveList(): Promise<ListAuth> {
  const session = await ensureGrokSession();
  return {
    baseURL: process.env.GROK_CLI_BASE_URL || session.baseUrl || spec.baseURL,
    apiKey: session.accessToken,
    headers: grokProxyHeaders(),
  };
}

export function hasCredentials() {
  return Boolean(loadSession());
}

export const grokCli = { id, spec, hasCredentials, resolveClient, resolveList } satisfies Adapter;

export { ensureGrokSession, grokProxyHeaders } from './oauth.ts';
