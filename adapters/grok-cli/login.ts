// SuperGrok / Grok CLI OAuth. Writes .grok-oauth.json in the repo (gitignored).
// npx --yes tsx adapters/grok-cli/login.ts
// npx --yes tsx adapters/grok-cli/login.ts --code PASTE
// npx --yes tsx adapters/grok-cli/login.ts --device
// npx --yes tsx adapters/grok-cli/login.ts status
// npx --yes tsx adapters/grok-cli/login.ts logout

import {
  completeLogin,
  clearSession,
  ensureGrokSession,
  loadSession,
  loginBrowser,
  loginDevice,
  sessionPath,
} from './oauth.ts';

function redact(session: { expiresAt: number; baseUrl: string; accessToken: string }) {
  return {
    path: sessionPath(),
    baseUrl: session.baseUrl,
    expiresAt: new Date(session.expiresAt).toISOString(),
    accessTokenChars: session.accessToken.length,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'login';
  if (cmd === 'logout') {
    clearSession();
    console.log(`removed ${sessionPath()}`);
    return;
  }
  if (cmd === 'status') {
    const s = loadSession();
    if (!s) {
      console.log(`not logged in (${sessionPath()})`);
      process.exitCode = 1;
      return;
    }
    const live = Date.now() < s.expiresAt ? s : await ensureGrokSession();
    console.log(JSON.stringify(redact(live), null, 2));
    return;
  }
  if (cmd === '--device' || cmd === 'device') {
    const session = await loginDevice(({ userCode, verifyUrl }) => {
      console.log(`Visit ${verifyUrl}`);
      console.log(`Code: ${userCode}`);
    });
    console.log(JSON.stringify(redact(session), null, 2));
    return;
  }
  if (cmd === '--code' || cmd === 'code') {
    const pasted = args[1] || '';
    if (!pasted) {
      console.error('usage: adapters/grok-cli/login.ts --code PASTE');
      process.exit(2);
    }
    const session = await completeLogin(pasted);
    console.log(JSON.stringify(redact(session), null, 2));
    return;
  }
  if (cmd !== 'login' && cmd !== '--wait' && cmd !== 'wait') {
    console.error('usage: adapters/grok-cli/login.ts [login|--code|--device|status|logout]');
    process.exit(2);
  }

  const session = await loginBrowser();
  console.log(JSON.stringify(redact(session), null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
