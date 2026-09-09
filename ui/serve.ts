// Local UI + run listener. 127.0.0.1 only. Keys never leave this process.
// npx --yes tsx ui/serve.ts

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapters, type AdapterId } from '../adapters/index.ts';
import { listModels, type ReasoningEffort } from '../harness/genericClient.ts';
import { loadEnv, turnLimit } from '../harness/loadEnv.ts';
import { readModelCache, writeModelCache, type ModelCache } from '../harness/modelCache.ts';
import { canResume, driveRun, LEVELS, loadRun, publicRun, type RunEvent, type RunRecord } from '../harness/run.ts';

const uiRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(uiRoot, '..');
const port = Number(process.env.PORT || 5173);
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

loadEnv(join(repoRoot, '.env'));

// Refresh model list on start if enabled (default true)
if (process.env.REFRESH_MODELS_ON_START !== 'false') {
  try { unlinkSync(join(repoRoot, '.models-cache.json')); } catch {}
}

type SseClient = ServerResponse;
const sse = new Set<SseClient>();
let current: { id: string; abort: AbortController; run?: RunRecord } | null = null;

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function emit(event: RunEvent) {
  const payload =
    event.type === 'start' || event.type === 'done'
      ? { ...event, run: publicRun(event.run) }
      : event;
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sse) client.write(line);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32_000) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function listRunFiles(): Promise<RunRecord[]> {
  const dir = join(repoRoot, 'runs');
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const runs: RunRecord[] = [];
  for (const name of names) {
    try {
      const raw = JSON.parse(await readFile(join(dir, name), 'utf8')) as RunRecord;
      if (raw?.kind === 'attack' && raw.id) runs.push(publicRun(raw));
    } catch {
      /* skip junk */
    }
  }
  runs.sort((a, b) => b.at.localeCompare(a.at));
  return runs;
}

function readyIds(): AdapterId[] {
  return (Object.keys(adapters) as AdapterId[]).filter((id) => adapters[id].hasCredentials());
}

function defaultRole(role: 'ATTACKER' | 'DEFENDER', fallback: AdapterId): { provider: string; model: string } {
  const ready = readyIds();
  const envProvider = process.env[`${role}_PROVIDER`] || '';
  const provider = ready.includes(envProvider as AdapterId)
    ? envProvider
    : ready.includes(fallback)
      ? fallback
      : ready[0] || '';
  return { provider, model: process.env[`${role}_MODEL`] || '' };
}

function defaults() {
  return {
    attacker: defaultRole('ATTACKER', 'grok-cli'),
    defender: defaultRole('DEFENDER', 'opencode'),
  };
}

async function fetchModels(): Promise<ModelCache> {
  const cache: ModelCache = { fetchedAt: new Date().toISOString(), providers: {} };
  await Promise.all(
    readyIds().map(async (id) => {
      const adapter = adapters[id];
      try {
        const auth = await adapter.resolveList();
        const models = await listModels(auth.baseURL, auth.apiKey, auth.headers);
        cache.providers[id] = { baseURL: adapter.spec.baseURL, models };
      } catch (err) {
        cache.providers[id] = {
          baseURL: adapter.spec.baseURL,
          models: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  writeModelCache(cache);
  return cache;
}

function modelsPayload(cache: ModelCache | null) {
  const providers: Record<string, { models: string[]; error?: string; baseURL: string }> = {};
  for (const id of readyIds()) {
    const row = cache?.providers?.[id];
    providers[id] = {
      baseURL: adapters[id].spec.baseURL,
      models: row?.models ?? [],
      ...(row?.error ? { error: row.error } : {}),
    };
  }
  return {
    fetchedAt: cache?.fetchedAt ?? null,
    providers,
    levels: LEVELS.map(({ id, name, goal }) => ({
      id,
      name,
      summary: goal.summary ?? '',
    })),
    defaults: defaults(),
    turnLimit: turnLimit(),
  };
}

function isAdapterId(value: string): value is AdapterId {
  return value in adapters;
}

async function startRun(body: { attacker?: { provider?: string; model?: string }; defender?: { provider?: string; model?: string } }) {
  if (current) {
    const err = new Error('a run is already in progress');
    (err as Error & { status: number }).status = 409;
    throw err;
  }
  const attacker = {
    provider: body.attacker?.provider || process.env.ATTACKER_PROVIDER || '',
    model: body.attacker?.model || process.env.ATTACKER_MODEL || '',
    reasoningEffort: body.attacker?.reasoningEffort as ReasoningEffort | undefined,
  };
  const defender = {
    provider: body.defender?.provider || process.env.DEFENDER_PROVIDER || '',
    model: body.defender?.model || process.env.DEFENDER_MODEL || '',
    reasoningEffort: body.defender?.reasoningEffort as ReasoningEffort | undefined,
  };
  if (!isAdapterId(attacker.provider) || !isAdapterId(defender.provider)) {
    throw new Error('attacker and defender need a known provider');
  }
  if (!adapters[attacker.provider].hasCredentials() || !adapters[defender.provider].hasCredentials()) {
    throw new Error('that provider has no credentials stored');
  }
  if (!attacker.model || !defender.model) throw new Error('pick attacker and defender models');

  const abort = new AbortController();
  const at = new Date().toISOString();
  const id = `run-${at.replace(/[:.]/g, '').slice(0, 15)}`;
  current = {
    id,
    abort,
    run: {
      id,
      at,
      kind: 'attack',
      status: 'running',
      attacker,
      defender,
      successes: 0,
      note: 'starting',
      levels: {},
    },
  };

  void driveRun({
    id,
    attacker,
    defender,
    signal: abort.signal,
    onEvent: (event) => {
      if ((event.type === 'start' || event.type === 'done') && current) current.run = event.run;
      emit(event);
    },
  })
    .catch(() => undefined)
    .finally(() => {
      if (current?.id === id) current = null;
    });

  return { id, attacker, defender };
}

async function resumeRun(id: string) {
  if (current) {
    const err = new Error('a run is already in progress');
    (err as Error & { status: number }).status = 409;
    throw err;
  }
  const prior = await loadRun(id);
  if (!prior) {
    const err = new Error('not found');
    (err as Error & { status: number }).status = 404;
    throw err;
  }
  if (!canResume(prior)) throw new Error('this run cannot be resumed');
  const abort = new AbortController();
  current = {
    id: prior.id,
    abort,
    run: { ...prior, status: 'running', error: undefined, note: 'resuming' },
  };
  void driveRun({
    resume: prior,
    signal: abort.signal,
    onEvent: (event) => {
      if ((event.type === 'start' || event.type === 'done') && current) current.run = event.run;
      emit(event);
    },
  })
    .catch(() => undefined)
    .finally(() => {
      if (current?.id === prior.id) current = null;
    });
  return { id: prior.id, attacker: prior.attacker, defender: prior.defender, resume: true };
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const { pathname } = url;
  if (req.method === 'GET' && pathname === '/api/models') {
    const refresh = url.searchParams.get('refresh') === '1';
    if (refresh || !readModelCache()) {
      json(res, 200, modelsPayload(await fetchModels()));
      return true;
    }
    json(res, 200, modelsPayload(readModelCache()));
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/runs') {
    const live = current?.run ? publicRun(current.run) : current ? { id: current.id, status: 'running' } : null;
    json(res, 200, { current: live, runs: await listRunFiles() });
    return true;
  }
  if (req.method === 'GET' && pathname.startsWith('/api/runs/')) {
    const id = pathname.slice('/api/runs/'.length);
    if (!/^run-[A-Za-z0-9._-]+$/.test(id)) {
      json(res, 400, { error: 'bad id' });
      return true;
    }
    if (current?.id === id && current.run) {
      json(res, 200, publicRun(current.run));
      return true;
    }
    const file = join(repoRoot, 'runs', `${id}.json`);
    if (!existsSync(file)) {
      json(res, 404, { error: 'not found' });
      return true;
    }
    json(res, 200, publicRun(JSON.parse(readFileSync(file, 'utf8')) as RunRecord));
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/runs') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}') as Parameters<typeof startRun>[0];
      json(res, 202, await startRun(body));
    } catch (err) {
      const status = (err as { status?: number }).status || 400;
      json(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/runs/resume') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}') as { id?: string };
      if (!body.id || !/^run-[A-Za-z0-9._-]+$/.test(body.id)) {
        json(res, 400, { error: 'bad id' });
        return true;
      }
      json(res, 202, await resumeRun(body.id));
    } catch (err) {
      const status = (err as { status?: number }).status || 400;
      json(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/runs/abort') {
    if (!current) {
      json(res, 404, { error: 'no run in progress' });
      return true;
    }
    current.abort.abort();
    json(res, 200, { id: current.id, status: 'aborting' });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const hello = current?.run ? publicRun(current.run) : current ? { id: current.id, status: 'running' } : null;
    res.write(`data: ${JSON.stringify({ type: 'hello', current: hello })}\n\n`);
    sse.add(res);
    req.on('close', () => sse.delete(res));
    return true;
  }
  return false;
}

function serveStatic(urlPath: string, res: ServerResponse) {
  const rel = (urlPath.replace(/^\/+/, '') || 'index.html');
  if (rel.split(/[\\/]/).some((part) => part === '..')) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  const root = resolve(uiRoot);
  const file = resolve(root, rel);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (file !== root && !file.startsWith(prefix)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  readFile(file)
    .then((buf) => {
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
      res.end(buf);
    })
    .catch(() => {
      res.writeHead(404);
      res.end('not found');
    });
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  void handleApi(req, res, url)
    .then((hit) => {
      if (!hit) serveStatic(decodeURIComponent(url.pathname), res);
    })
    .catch((err) => {
      if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`catmouse ui http://127.0.0.1:${port}/`);
});
