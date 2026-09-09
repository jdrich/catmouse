// Fetch GET $BASE_URL/models once and write .models-cache.json (gitignored).
// Re-run this to refresh. run.ts does not hit /models.
// npx --yes tsx harness/models.ts

import { adapters, type AdapterId } from '../adapters/index.ts';
import { listModels } from './genericClient.ts';
import { loadEnv } from './loadEnv.ts';
import { cachePath, writeModelCache, type ModelCache } from './modelCache.ts';

loadEnv();

async function main() {
  const cache: ModelCache = { fetchedAt: new Date().toISOString(), providers: {} };
  for (const id of Object.keys(adapters) as AdapterId[]) {
    const adapter = adapters[id];
    process.stdout.write(`${id}  ${adapter.spec.baseURL}\n`);
    try {
      const auth = await adapter.resolveList();
      const models = await listModels(auth.baseURL, auth.apiKey, auth.headers);
      cache.providers[id] = { baseURL: auth.baseURL, models };
      for (const m of models) process.stdout.write(`  ${m}\n`);
      if (!models.length) process.stdout.write('  (none)\n');
    } catch (err) {
      process.stderr.write(`  ${err instanceof Error ? err.message : err}\n`);
    }
  }
  writeModelCache(cache);
  process.stdout.write(`wrote ${cachePath()}\n`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
