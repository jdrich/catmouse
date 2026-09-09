import type { ClientApi, ClientConfig } from '../harness/genericClient.ts';
import type { Adapter, ListAuth, ProviderSpec } from './types.ts';

function envPrefix(id: string) {
  return id.replace(/-/g, '_').toUpperCase();
}

export function completionsAdapter(
  id: string,
  init: {
    baseURL: string;
    keyEnv: string;
    api?: ClientApi;
    apiForModel?: (model: string) => ClientApi;
    headers?: () => Record<string, string>;
  },
): Adapter {
  const spec: ProviderSpec = {
    baseURL: init.baseURL,
    keyEnv: init.keyEnv,
    api: init.api ?? 'chat',
  };

  const baseURL = () => process.env[`${envPrefix(id)}_BASE_URL`] || spec.baseURL;
  const apiKey = () => process.env[spec.keyEnv!] || '';

  return {
    id,
    spec,
    hasCredentials: () => Boolean(apiKey()),
    async resolveClient(model: string): Promise<ClientConfig> {
      const key = apiKey();
      if (!key) throw new Error(`missing env ${spec.keyEnv}`);
      return {
        apiKey: key,
        baseURL: baseURL(),
        model,
        api: init.apiForModel?.(model) ?? spec.api,
        headers: init.headers?.(),
      };
    },
    async resolveList(): Promise<ListAuth> {
      return {
        baseURL: baseURL(),
        apiKey: apiKey() || undefined,
        headers: init.headers?.(),
      };
    },
  };
}
