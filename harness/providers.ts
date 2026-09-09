import { adapters, type AdapterId } from '../adapters/index.ts';
import type { ClientConfig } from './genericClient.ts';

export const providers = adapters;
export type ProviderId = AdapterId;

function req(name: string, fallback?: string): string {
  const v = process.env[name] || fallback || '';
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export async function resolveNamedClient(provider: string, model: string): Promise<ClientConfig> {
  if (!model) throw new Error('missing model');
  if (provider && provider in adapters) {
    return adapters[provider as AdapterId].resolveClient(model);
  }
  throw new Error(`unknown provider ${provider || '(empty)'}`);
}

export async function resolveRoleClient(role: 'ATTACKER' | 'DEFENDER'): Promise<ClientConfig> {
  const model = req(`${role}_MODEL`);
  const provider = process.env[`${role}_PROVIDER`] || '';
  if (provider && provider in adapters) {
    return adapters[provider as AdapterId].resolveClient(model);
  }
  return {
    apiKey: req(`${role}_API_KEY`),
    baseURL: req(`${role}_BASE_URL`),
    model,
  };
}
