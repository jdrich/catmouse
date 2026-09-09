import type { ClientApi, ClientConfig } from '../harness/genericClient.ts';

export type ProviderSpec = {
  baseURL: string;
  api: ClientApi;
  keyEnv?: string;
};

export type ListAuth = {
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
};

/** Every provider implements this. Harness never branches on vendor. */
export type Adapter = {
  id: string;
  spec: ProviderSpec;
  hasCredentials(): boolean;
  resolveClient(model: string): Promise<ClientConfig>;
  resolveList(): Promise<ListAuth>;
};
