import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ModelCache = {
  fetchedAt: string;
  providers: Record<string, { baseURL: string; models: string[]; error?: string }>;
};

export function cachePath() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '.models-cache.json');
}

export function readModelCache(): ModelCache | null {
  try {
    return JSON.parse(readFileSync(cachePath(), 'utf8')) as ModelCache;
  } catch {
    return null;
  }
}

export function writeModelCache(cache: ModelCache) {
  writeFileSync(cachePath(), JSON.stringify(cache, null, 2) + '\n', 'utf8');
}
