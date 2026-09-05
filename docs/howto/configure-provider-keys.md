# Router-fallback provider keys (Groq, Gemini, OpenRouter)

You have OpenRouter already. This note walks through adding the other two keys the fallback chain needs, so a billing or routing failure can move the session to the next provider instead of stopping.

The chain this repo ships is fixed. Groq absorbs load first, Gemini comes second, OpenRouter `:free` models sit last for short bursts. An entry only serves when its key is present, so a missing Groq or Gemini key just means a shorter chain. Everything still runs.

## What pi and the extension actually check

Use environment variables. That is the path that works today.

Pi itself accepts a key from `auth.json` (written by `/login`) or from the environment, with `auth.json` winning when both exist. The fallback extension is stricter. It reads the environment on every call and skips any entry whose variable is missing or blank. A `/login`-only setup makes pi happy but leaves the fallback entry out. Set the variables and both sides agree.

The three names, and nothing but the names, appear in logs and notices. Values never do.

| Order | Provider in pi | Variable | Serves |
| --- | --- | --- | --- |
| 1 | `groq` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| 2 | `google` | `GEMINI_API_KEY` | `gemini-3.1-flash-lite`, then `gemini-3.1-pro-preview` |
| 3 | `openrouter` | `OPENROUTER_API_KEY` | four `:free` models in rotation |

Pi reads `process.env` live. Export first, then start pi from the same shell. A pi session that is already running will not see a key you export afterwards. Restart it.

## 1. Get the two missing keys

### Groq

1. Open `console.groq.com` and sign in.
2. Go to API Keys and create a new key. Copy it once. Groq shows it only at creation time.
3. Keep the tab open until step 2 below is done, then close it.

The free tier is generous and needs no card for basic use. If Groq asks for billing later, that only matters when you outgrow the free allowance.

### Gemini (Google AI Studio)

1. Open `aistudio.google.com` and sign in with a Google account.
2. Click Get API Key, then Create API key. Copy it once.
3. If Google offers a Cloud project prompt, accept the default. You do not need Vertex or `gcloud` for this path. The plain AI Studio key is what pi expects as `GEMINI_API_KEY`.

### OpenRouter (verify what you have)

1. Open `openrouter.ai/keys` and confirm a key exists.
2. If you signed in with `/login openrouter` before, pi stored an OAuth-minted key in `~/.pi/agent/auth.json`. That covers normal pi use.
3. For fallback you still need `OPENROUTER_API_KEY` in the environment (see why above). Copy the key value from the OpenRouter dashboard so you can export it in the next step.

## 2. Set them on macOS (zsh)

This shell uses `~/.zshrc`, so make the exports persistent there. One line per key.

```bash
# append once (paste your real keys inside the quotes)
printf '%s\n' 'export GROQ_API_KEY="gsk-..."' >> ~/.zshrc
printf '%s\n' 'export GEMINI_API_KEY="AIza-..."' >> ~/.zshrc
printf '%s\n' 'export OPENROUTER_API_KEY="sk-or-v1-..."' >> ~/.zshrc

# load them into this shell
source ~/.zshrc
```

For one session only (testing, shared machine), skip the file and export directly. The keys vanish when the shell closes.

```bash
export GROQ_API_KEY="gsk-..."
export GEMINI_API_KEY="AIza-..."
export OPENROUTER_API_KEY="sk-or-v1-..."
```

Check presence without printing values. Each command should print a small nonzero number (the length plus newline), never the key.

```bash
printf '%s' "$GROQ_API_KEY" | wc -c
printf '%s' "$GEMINI_API_KEY" | wc -c
printf '%s' "$OPENROUTER_API_KEY" | wc -c
```

A `0` means that variable is empty in this shell. Fix the export and `source ~/.zshrc` again.

Then start pi from this same shell.

```bash
pi
```

Apps launched from Finder or Spotlight do not inherit `~/.zshrc`, so always launch pi from the terminal where you verified the variables. That trips people up more than anything else.

## 3. About `/login`

`/login` is fine as a complement, not a substitute. Run it inside pi, pick the provider, paste the key when asked. Pi writes `~/.pi/agent/auth.json` with mode `0600` and uses that copy first.

Keep the environment exports in place anyway. Without them the provider works in pi but stays out of the fallback rotation, and `/fallback status` will keep reporting fewer eligible providers than you expect.

## 4. Confirm inside pi

Run the status command in any session.

```text
/fallback status
```

Look at the `serving` and failure lines. A healthy setup with all three keys shows the episode budget and the current provider. Right after a real failure and switch you should see a `router-fallback-event` card naming the provider that took over (for example Groq to Gemini), plus one line in `/fallback status` under last failure and last switch.

If the notice says there are no eligible providers and names the three variables, pi saw none of them. That message always means the environment, not the model. Go back to step 2, verify the counts, restart pi from that shell, and check again.

Two kill-switches can also silence everything even with keys set. `PI_BADGER_ROUTER_FALLBACK=0` disables the extension, and `/fallback off` pauses it for the session. `/fallback on` lifts the session pause. `/fallback reset` opens a fresh episode with a zeroed switch count.

## 5. Keep the keys safe

Treat these like passwords. Short version. Do not paste them into chat, issues, or screen shares, and do not commit them. This repo never wants values, only names.

A few habits that pay off.

- Keep `~/.zshrc` readable only by you (`chmod 600 ~/.zshrc`).
- Keep `~/.pi/agent/auth.json` at its default `0600`. Do not loosen it.
- Prefer the macOS Keychain or 1Password for storage, and pull at shell start instead of keeping plaintext around longer than needed. An export that calls `security find-generic-password` or `op read` in `~/.zshrc` works, since the extension only cares that the variable is set when pi runs.
- Rotate a key the moment it leaks. Delete it at the provider dashboard (Groq console, AI Studio, OpenRouter keys page), create a replacement, update `~/.zshrc` and `auth.json` if you used `/login`, then restart pi.

## Troubleshooting

No eligible providers after setting keys. You exported after pi started, or pi started outside the configured shell. Source the file, verify the nonzero counts, restart pi from that shell.

One provider missing from rotation. That variable is blank or has a typo in the name. The extension matches exact names (`GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`). Check spelling and quotes in `~/.zshrc`.

Keys work in a fresh terminal but not in your IDE terminal. The IDE was launched before the edit, so it holds the old environment. Quit the IDE fully (not just the terminal tab) and reopen it, or launch pi from the working terminal instead.

Auth errors on first use. The key is wrong, revoked, or pasted with extra whitespace. Re-copy from the provider dashboard, re-export, restart pi. For Gemini, confirm the key came from AI Studio and not a Vertex service-account file. Those are different credentials.

Fallback never fires at all. Check the two kill-switches first (`PI_BADGER_ROUTER_FALLBACK` and `/fallback off`), then the failure kind. Throttle (429), request errors (400/403/404), and context overflow deliberately never switch. Only billing exhaustion, auth with somewhere to go, and dead model routes (503) move the chain.

## Reference

- Groq console (`console.groq.com`) for `GROQ_API_KEY`
- Google AI Studio (`aistudio.google.com`) for `GEMINI_API_KEY`
- OpenRouter keys (`openrouter.ai/keys`) for `OPENROUTER_API_KEY`
- Pi provider docs in the installed package (`docs/providers.md` under `@earendil-works/pi-coding-agent`) for the full variable table and `auth.json` format
- Repo README section on the router-fallback extension for chain order, budgets, and `/fallback` command details
