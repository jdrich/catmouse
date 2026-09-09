// SuperGrok / Grok CLI OAuth adapter. Own PKCE against auth.x.ai.
// Tokens: <repo>/.grok-oauth.json (gitignored).

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ISSUER = 'https://auth.x.ai';
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
const CLIENT_ID = process.env.GROK_OAUTH_CLIENT_ID || 'b1a00492-073a-47ea-816f-4c329264a828';
const SCOPE =
  process.env.GROK_OAUTH_SCOPE ||
  'openid profile email offline_access grok-cli:access api:access';
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = Number(process.env.GROK_OAUTH_CALLBACK_PORT || '56122');
const CALLBACK_PATH = '/callback';
const PROXY_BASE = 'https://cli-chat-proxy.grok.com/v1';
const REFRESH_SKEW_MS = 120_000;
const PENDING_TTL_MS = 15 * 60_000;
const LOGIN_CMD = 'npx --yes tsx adapters/grok-cli/login.ts';
const CODE_RE = /^[A-Za-z0-9._~-]{32,2048}$/;
const PNA_ORIGINS = new Set(['https://auth.x.ai', 'https://accounts.x.ai']);

export type GrokSession = {
  version: 1;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenEndpoint: string;
  baseUrl: string;
};

type Discovery = {
  authorization_endpoint: string;
  token_endpoint: string;
  device_authorization_endpoint?: string;
};

type PendingLogin = {
  version: 1;
  verifier: string;
  state: string;
  redirectUri: string;
  tokenEndpoint: string;
  authorizeUrl: string;
  createdAt: number;
};

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function sessionPath(): string {
  return process.env.GROK_OAUTH_PATH || join(repoRoot(), '.grok-oauth.json');
}

export function pendingPath(): string {
  return process.env.GROK_OAUTH_PENDING_PATH || join(repoRoot(), '.grok-oauth-pending.json');
}

export function loadSession(): GrokSession | null {
  try {
    const raw = JSON.parse(readFileSync(sessionPath(), 'utf8')) as Partial<GrokSession>;
    if (raw.version !== 1 || !raw.accessToken || !raw.refreshToken) return null;
    return {
      version: 1,
      accessToken: raw.accessToken,
      refreshToken: raw.refreshToken,
      expiresAt: Number(raw.expiresAt) || 0,
      tokenEndpoint: raw.tokenEndpoint || `${ISSUER}/oauth2/token`,
      baseUrl: raw.baseUrl || PROXY_BASE,
    };
  } catch {
    return null;
  }
}

export function saveSession(session: GrokSession): void {
  const path = sessionPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function clearPending(): void {
  try {
    unlinkSync(pendingPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function clearSession(): void {
  clearPending();
  try {
    unlinkSync(sessionPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function savePending(pending: PendingLogin): void {
  const path = pendingPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(pending, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function loadPending(): PendingLogin | null {
  try {
    const raw = JSON.parse(readFileSync(pendingPath(), 'utf8')) as Partial<PendingLogin>;
    if (raw.version !== 1 || !raw.verifier || !raw.redirectUri || !raw.tokenEndpoint) return null;
    if (!raw.createdAt || Date.now() - raw.createdAt > PENDING_TTL_MS) return null;
    return raw as PendingLogin;
  } catch {
    return null;
  }
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

function assertXaiHttps(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`bad ${label}`);
  }
  if (url.protocol !== 'https:') throw new Error(`${label} must be https`);
  const host = url.hostname.toLowerCase();
  if (host !== 'x.ai' && host !== 'auth.x.ai' && host !== 'accounts.x.ai' && !host.endsWith('.x.ai')) {
    throw new Error(`${label} is not an xAI host`);
  }
  return url.toString();
}

async function discover(): Promise<Discovery> {
  const res = await fetch(DISCOVERY, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const json = (await res.json()) as Discovery;
  return {
    authorization_endpoint: assertXaiHttps(json.authorization_endpoint, 'authorization_endpoint'),
    token_endpoint: assertXaiHttps(json.token_endpoint, 'token_endpoint'),
    device_authorization_endpoint: json.device_authorization_endpoint
      ? assertXaiHttps(json.device_authorization_endpoint, 'device_authorization_endpoint')
      : undefined,
  };
}

async function postForm(url: string, body: URLSearchParams): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { error: `HTTP ${res.status}`, error_description: text.slice(0, 300) };
  }
  if (!res.ok) {
    const detail = String(json.error_description || json.error || text.slice(0, 300));
    throw new Error(`token request ${res.status}: ${detail}`);
  }
  return json;
}

function sessionFromTokenPayload(payload: Record<string, unknown>, tokenEndpoint: string): GrokSession {
  const accessToken = String(payload.access_token ?? '');
  const refreshToken = String(payload.refresh_token ?? '');
  if (!accessToken) throw new Error('token response missing access_token');
  if (!refreshToken) throw new Error('token response missing refresh_token');
  const ttl = Number(payload.expires_in ?? 3600);
  return {
    version: 1,
    accessToken,
    refreshToken,
    expiresAt: Date.now() + (Number.isFinite(ttl) ? ttl : 3600) * 1000 - REFRESH_SKEW_MS,
    tokenEndpoint,
    baseUrl: process.env.GROK_CLI_BASE_URL || PROXY_BASE,
  };
}

async function exchangeCode(pending: PendingLogin, code: string): Promise<GrokSession> {
  const payload = await postForm(
    pending.tokenEndpoint,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier,
    }),
  );
  const session = sessionFromTokenPayload(payload, pending.tokenEndpoint);
  saveSession(session);
  clearPending();
  return session;
}

function parsePastedCode(input: string, expectedState: string): string {
  const value = input.trim();
  if (!value) throw new Error('empty authorization code');
  try {
    const url = new URL(value);
    if (url.pathname !== CALLBACK_PATH) throw new Error('callback URL path was not /callback');
    const state = url.searchParams.get('state');
    if (state && state !== expectedState) throw new Error('oauth state mismatch');
    const code = url.searchParams.get('code');
    if (!code) throw new Error('callback URL missing code');
    return code;
  } catch (err) {
    if (err instanceof TypeError) {
      if (!value.includes('=') && CODE_RE.test(value)) return value;
      throw new Error('paste the callback URL or the one-time code from xAI');
    }
    throw err;
  }
}

function applyPnaCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && PNA_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Vary', 'Origin');
  }
}

function openBrowser(url: string): void {
  const plat = process.platform;
  const child =
    plat === 'win32'
      ? spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' })
      : plat === 'darwin'
        ? spawn('open', [url], { detached: true, stdio: 'ignore' })
        : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onErr = (err: Error) => reject(err);
    server.once('error', onErr);
    server.listen(port, CALLBACK_HOST, () => {
      server.removeListener('error', onErr);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    });
  });
}

async function startCallback(state: string): Promise<{
  code: Promise<string>;
  server: Server;
  redirectUri: string;
}> {
  let settled = false;
  let resolveCode: (code: string) => void;
  let rejectCode: (err: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const finish = (fn: () => void) => {
    if (settled) return;
    settled = true;
    fn();
  };
  const server = createServer((req, res) => {
    applyPnaCors(req, res);
    const page = (status: number, body: string) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    try {
      const reqUrl = new URL(req.url || '/', `http://${CALLBACK_HOST}`);
      const keys = [...reqUrl.searchParams.keys()].join(',') || '-';
      process.stderr.write(
        `[oauth] ${req.method} ${reqUrl.pathname} keys=${keys} origin=${req.headers.origin || '-'}\n`,
      );
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (reqUrl.pathname !== CALLBACK_PATH) {
        page(404, 'not found');
        return;
      }
      const err = reqUrl.searchParams.get('error');
      if (err) {
        page(400, `login failed: ${err}`);
        finish(() => rejectCode(new Error(`authorization ${err}`)));
        return;
      }
      if (reqUrl.searchParams.get('state') !== state) {
        page(400, 'state mismatch');
        finish(() => rejectCode(new Error('oauth state mismatch')));
        return;
      }
      const granted = reqUrl.searchParams.get('code');
      if (!granted) {
        page(400, 'missing code');
        finish(() => rejectCode(new Error('authorization code missing')));
        return;
      }
      page(200, '<p>Catmouse is signed in. You can close this tab.</p>');
      finish(() => resolveCode(granted));
    } catch (e) {
      page(500, 'callback error');
      finish(() => rejectCode(e instanceof Error ? e : new Error('callback error')));
    }
  });
  let port: number;
  try {
    port = await listen(server, CALLBACK_PORT);
  } catch {
    port = await listen(server, 0);
  }
  return { code, server, redirectUri: `http://${CALLBACK_HOST}:${port}${CALLBACK_PATH}` };
}

function authorizeUrl(oidc: Discovery, pending: Pick<PendingLogin, 'redirectUri'>, challenge: string, state: string): string {
  const auth = new URL(oidc.authorization_endpoint);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('client_id', CLIENT_ID);
  auth.searchParams.set('redirect_uri', pending.redirectUri);
  auth.searchParams.set('scope', SCOPE);
  auth.searchParams.set('code_challenge', challenge);
  auth.searchParams.set('code_challenge_method', 'S256');
  auth.searchParams.set('state', state);
  auth.searchParams.set('nonce', b64url(crypto.getRandomValues(new Uint8Array(16))));
  auth.searchParams.set('plan', process.env.GROK_OAUTH_PLAN || 'generic');
  // Public Grok CLI client_id. The issuer still expects this referrer on authorize.
  auth.searchParams.set('referrer', process.env.GROK_OAUTH_REFERRER || 'pi-grok-cli');
  return auth.toString();
}

/** Exchange a pasted one-time code or callback URL against the pending PKCE. */
export async function completeLogin(pasted: string): Promise<GrokSession> {
  const pending = loadPending();
  if (!pending) throw new Error(`no pending login. Run: ${LOGIN_CMD}`);
  return exchangeCode(pending, parsePastedCode(pasted, pending.state));
}

/** Bind loopback, open browser, wait for redirect, exchange code. */
export async function loginBrowser(): Promise<GrokSession> {
  const oidc = await discover();
  const { verifier, challenge } = await pkce();
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const callback = await startCallback(state);
  const url = authorizeUrl(oidc, { redirectUri: callback.redirectUri }, challenge, state);
  savePending({
    version: 1,
    verifier,
    state,
    redirectUri: callback.redirectUri,
    tokenEndpoint: oidc.token_endpoint,
    authorizeUrl: url,
    createdAt: Date.now(),
  });
  process.stdout.write(`Listening on ${callback.redirectUri}\n`);
  process.stdout.write(`Open this URL:\n${url}\n`);
  openBrowser(url);
  try {
    const granted = await Promise.race([
      callback.code,
      new Promise<string>((_, reject) => {
        setTimeout(() => reject(new Error('timed out waiting for grok login callback')), 15 * 60_000);
      }),
    ]);
    return await exchangeCode(
      {
        version: 1,
        verifier,
        state,
        redirectUri: callback.redirectUri,
        tokenEndpoint: oidc.token_endpoint,
        authorizeUrl: url,
        createdAt: Date.now(),
      },
      granted,
    );
  } finally {
    await new Promise<void>((resolve) => callback.server.close(() => resolve()));
  }
}

export async function loginDevice(onCode: (info: { userCode: string; verifyUrl: string }) => void): Promise<GrokSession> {
  const oidc = await discover();
  if (!oidc.device_authorization_endpoint) throw new Error('issuer has no device authorization endpoint');
  const started = await postForm(
    oidc.device_authorization_endpoint,
    new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }),
  );
  const deviceCode = String(started.device_code ?? '');
  const userCode = String(started.user_code ?? '');
  const verifyUrl = String(started.verification_uri_complete || started.verification_uri || '');
  if (!deviceCode || !userCode || !verifyUrl) throw new Error('device authorization missing fields');
  onCode({ userCode, verifyUrl });
  let intervalMs = Math.max(1, Number(started.interval ?? 5)) * 1000;
  const deadline = Date.now() + Math.max(60, Number(started.expires_in ?? 600)) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const payload = await postForm(
        oidc.token_endpoint,
        new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: CLIENT_ID,
          device_code: deviceCode,
        }),
      );
      const session = sessionFromTokenPayload(payload, oidc.token_endpoint);
      saveSession(session);
      return session;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('authorization_pending')) continue;
      if (msg.includes('slow_down')) {
        intervalMs += 5000;
        continue;
      }
      throw err;
    }
  }
  throw new Error('device login expired');
}

export async function refreshSession(session: GrokSession): Promise<GrokSession> {
  const payload = await postForm(
    session.tokenEndpoint,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: session.refreshToken,
    }),
  );
  const next: GrokSession = {
    ...session,
    accessToken: String(payload.access_token ?? ''),
    refreshToken: String(payload.refresh_token ?? session.refreshToken),
    expiresAt:
      Date.now() +
      (Number.isFinite(Number(payload.expires_in)) ? Number(payload.expires_in) : 3600) * 1000 -
      REFRESH_SKEW_MS,
  };
  if (!next.accessToken) throw new Error('refresh missing access_token');
  saveSession(next);
  return next;
}

export async function ensureGrokSession(): Promise<GrokSession> {
  const current = loadSession();
  if (!current) throw new Error(`not logged in to Grok CLI. Run: ${LOGIN_CMD}`);
  if (Date.now() < current.expiresAt) return current;
  return refreshSession(current);
}

export function grokProxyHeaders(model?: string): Record<string, string> {
  const version = process.env.GROK_CLI_VERSION || '0.2.91';
  const headers: Record<string, string> = {
    'User-Agent': `grok-pager/${version} grok-shell/${version}`,
    'x-grok-client-identifier': 'grok-pager',
    'x-grok-client-version': version,
    'x-xai-token-auth': 'xai-grok-cli',
  };
  if (model) headers['x-grok-model-override'] = model;
  return headers;
}
