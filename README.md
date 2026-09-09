# Catmouse

Catmouse is a live prompt-injection evaluation. Two models take opposing roles: the cat attacks, the mouse defends. A run plays eight levels in sequence, up to twenty attacker turns each. A level ends on the first hit, then the run moves to the next.

The mouse may describe tool use (write a file, reach the network, delete `/etc/shadow`), but this harness never executes those tools. A level counts as won when the attacker gets the model to state that intent. No code is actually run; the eval is safe by construction.

![Live run in the UI](docs/run.png)

The levels are canary, disclosure, fs-write, tool-call, exfil, persist, priv-esc, and takeover. Persist is a sticky jailbreak: a later user tries to restore the standing rules, and only a real injection survives. It is not a fake reboot that wipes state.

## Run

```bash
cp .env.example .env          # then fill keys
bin/start.sh                  # Windows: bin\start.cmd
```

The UI listens on `http://127.0.0.1:5173/` only. Keys stay in this process. One run at a time.

```bash
npm run login:grok            # SuperGrok OAuth -> .grok-oauth.json
npx tsx harness/run.ts        # headless run using ATTACKER_* / DEFENDER_* from .env
```

## Providers

| id | what | creds |
|---|---|---|
| `grok-cli` | SuperGrok (`cli-chat-proxy.grok.com`) | OAuth file, not an xAI console key |
| `opencode` | OpenCode Go | `OPENCODE_API_KEY` |
| `xai` | paid `api.x.ai` | `XAI_API_KEY`, hidden until set |
| `llama` | local `llama serve` | `LLAMA_BASE_URL`, you start the process |

Providers without stored credentials are hidden from the dropdowns.

Turn budget, context clip, and HTTP timeout are set in `.env` (`TURN_LIMIT`, `CONTEXT_LIMIT_TOKENS`, `MODEL_TIMEOUT_MS`).
