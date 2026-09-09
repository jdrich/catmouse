# Catmouse

Two models. One job: break in. The other: hold the line.

Catmouse is a live prompt-injection eval. You pick a **cat** (attacker) and a **mouse** (defender), fire, and watch eight trials play out in a fire log — twenty turns a level, stop on first hit.

The mouse can *talk* like it has tools: write a file, hit the network, delete `/etc/shadow`. **This harness never runs them.** A win is observed intent, not a pwned box. Airgap by design.

![Live run: DeepSeek-flash vs a local 4B Qwen — L6 persist in the bag, L7 priv-esc in progress](docs/run.png)

Levels: canary, disclosure, fs-write, tool-call, exfil, persist, priv-esc, takeover.
Persist is a sticky jailbreak — a later user tries to restore standing rules — not a fake reboot.

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
| `llama` | local `llama serve` | `LLAMA_BASE_URL` — you start the process |

Dropdowns omit providers with no stored credentials.

Turn budget, context clip, and HTTP timeout live in `.env` (`TURN_LIMIT`, `CONTEXT_LIMIT_TOKENS`, `MODEL_TIMEOUT_MS`).
A level stops on the first hit, then the run walks to the next.
