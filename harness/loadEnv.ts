import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Load repo-root .env into process.env. Existing env wins. */
export function loadEnv(path?: string) {
  const file = path ?? join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === '') process.env[key] = val;
  }
}

function envInt(key: string, fallback: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Attacker turns per level. Default 20. */
export function turnLimit(): number {
  return envInt('TURN_LIMIT', 20);
}

/** Context clip for both sides. Default 128000. */
export function contextLimitTokens(): number {
  return envInt('CONTEXT_LIMIT_TOKENS', 128_000);
}

/** Per-request model HTTP timeout. Default 180s. */
export function modelTimeoutMs(): number {
  return envInt('MODEL_TIMEOUT_MS', 180_000);
}
