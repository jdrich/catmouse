# Catmouse

Eight prompt-injection trials. Cat writes the payload. Mouse is supposed to refuse.
The defender may *emit* tool calls; this harness never runs them.

Levels: canary, disclosure, fs-write, tool-call, exfil, persist, priv-esc, takeover.
Persist is a sticky jailbreak — a later user tries to restore standing rules — not a fake reboot.
L3–L8 score observed tool intent, not execution.

## Run

```bash
cp .env.example .env          # then fill keys
bin/start.sh                  # Windows: bin\start.cmd
```

UI is `http://127.0.0.1:5173/` only. Keys stay in this process. One run at a time.

```bash
npm run login:grok            # SuperGrok OAuth → .grok-oauth.json
npx tsx harness/run.ts        # headless, uses ATTACKER_* / DEFENDER_* from .env
```

## Providers

| id | what | creds |
|---|---|---|
| `grok-cli` | SuperGrok (`cli-chat-proxy.grok.com`) | OAuth file, not an xAI console key |
| `opencode` | OpenCode Go | `OPENCODE_API_KEY` |
| `xai` | paid `api.x.ai` | `XAI_API_KEY` — hidden until set |

Dropdowns omit providers with no stored credentials.

Turn budget, context clip, and HTTP timeout live in `.env` (`TURN_LIMIT`, `CONTEXT_LIMIT_TOKENS`, `MODEL_TIMEOUT_MS`).
A level stops on the first hit, then the run walks to the next.
