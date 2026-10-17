# rtk for pi: after-tool pipeline, project savings and the LLM proxy (research record)

**Date:** 2026-10-17 · **Task:** pbi-rtk-pipeline-statusline-proxy-coverage · rtk 1.0.1, pi-coding-agent 1.3.0

User decisions: high loop; status through `ctx.ui.setStatus`; proxy: show whether pi's traffic
goes through it, and route pi through it when that works the same; savings scoped to the
project, for both the command hooks and the proxy; Claude Code config stays untouched.

## Findings

### F1 — In pi, rtk only runs before a tool, never after it, so the after-tool pipeline does nothing for pi [MEASURED]
Evidence: `extensions/rtk/index.ts` handles only `tool_call` for `bash` (`rtk rewrite`).
`history.db` `commands` holds exactly 7 rows above the ~30k-char cap (`rtk gain` "Excluded: 7").
Five of them have no matching `hook_decisions` row, which points to pi as the source:
- `rtk read` of mcp_tools.py: 11,360 → 11,360 tokens
- `git show`: 10,164 → 6,414
- a `grep`: 11,502 → 4,822
- this session's `ls -R`
- this session's `grep`

Two came from Claude (`ls docs/changelog`, `hook_decisions` = ask; compressed to 622).
`haiku-large-shell` (>5,000 tokens → Haiku digest) never ran on the pi rows.
`rtk gain --by-pipeline` shows 2 hook-site pipeline calls in 30 days.

### F2 — The "Excluded" count tracks raw input size, so it rises no matter how well output is compressed [MEASURED]
Evidence: all 7 excluded rows have `input_tokens*4 > 30000`, including rows compressed 99%.
The useful signal is how much an oversized output was cut, not how many oversized outputs there were.

### F3 — `rtk hook claude` with a Claude-shaped PostToolUse payload runs the whole user pipeline for any caller [MEASURED + READ]
Evidence: probes via `echo JSON | rtk hook claude`; rtk-ai/rtk `src/hooks/posthook.rs`
(`extract()` ~866, `rebuild()` ~947, `track()` 1033).

Supported shapes:

| Claude tool | `tool_input` | `tool_response` | Comes back in |
|---|---|---|---|
| Bash | `{command}` | `{stdout,stderr,interrupted}` | `updatedToolOutput.stdout` |
| Read | `{file_path}` | `{type:"text",file:{filePath,content}}` | `file.content` |
| Grep | `{pattern,path}` | `{mode:"content",content}` | `content` |
| Glob | — | `{filenames}` | never changed |
| WebFetch | `{url}` | `{result}` | `result` |
| WebSearch | — | `{results:[string]}` | `results` |
| `mcp__*` and unknown names | — | `{content:[{type:"text",text}]}` or `{result}` | the same field |

Behaviour:
- Empty stdout with exit 0 means pass (the output is left unchanged).
- Write and Edit are never processed.
- Text under 512 characters passes (`guards.min_size`).

### F4 — A posthook run records a `commands` row tagged with the cwd of the rtk process, not the payload's `cwd` [MEASURED]
Evidence: probe rows show `rtk_cmd="rtk posthook <tool> <format>"` and `original_cmd="<Tool> <source>"`;
`project_path` is the spawned process's cwd.
`engine_attribution` is written only when compression actually happens.
So the pi handler must spawn rtk with `cwd = ctx.cwd`, or `rtk gain -p` misses the run.

### F5 — pi tool results map cleanly onto the Claude shapes [READ]
Evidence: pi-coding-agent `dist/core/tools/{bash,read,grep,find,ls}.js`, `extensions/types.d.ts:985-1120`, `runner.js:900-955`.

What each pi tool returns:
- **bash:** one text block with stdout and stderr combined, plus truncation trailers, plus `Command exited with code N` and `isError` on failure.
- **read:** raw text with no line numbers.
- **grep:** `path:line: text` lines, which rtk's `matches` filter handles (measured).
- **find, ls:** a list of paths, which rtk passes through unchanged (Glob).

How results flow:
- MCP tool names are `mcp__<server>__<tool>`.
- `tool_result` handlers chain, and a throwing handler is caught, so a failure leaves the original result in place.
- Replacing `content` without `structuredContent` drops `structuredContent`.

### F6 — `pi.exec` cannot pass stdin [READ]
Evidence: `dist/core/exec.d.ts:7-14`; the options are only `signal`, `timeout` and `cwd`.
The handler has to spawn `rtk hook claude` with `node:child_process` and write the payload to stdin.

### F7 — Project-scoped command-hook savings are cheap to read; the proxy keeps only global numbers until requests carry `x-rtk-project` [MEASURED + READ]
Evidence:
- `rtk gain -p -f json` returns `{summary:{total_commands,total_input,total_output,total_saved,avg_savings_pct,…,oversized_excluded}}` in about 6 ms.
- The proxy's `rtk-proxy.db` `usage_records` table has `project`, `session` and `client` columns; 0 of 1029 rows set `project`.
- The proxy docs (`/docs/proxy/configuration/`) list the attribution headers `x-rtk-project` and `x-rtk-session`.
- `rtk llm-proxy stats` prints global text only.

### F8 — pi can redirect its built-in anthropic provider and add request headers from an extension [READ]
Evidence: pi-coding-agent `dist/core/extensions/types.d.ts`:
- `pi.registerProvider("anthropic", { baseUrl })` is documented as "Override baseUrl for an existing provider" (around line 1340).
- `before_provider_headers` lets a handler mutate the headers in place (line 698).
- `ctx.model.baseUrl` holds the effective URL (pi-ai `Model.baseUrl`).
- `model_select` fires when the model changes.

### F9 — pi's request shape works through rtk-proxy, but the requests are not identical: the proxy adds the pipeline's directives [MEASURED]
Evidence: live `/v1/messages` calls to `claude-haiku-4-5` with `x-api-key`, SSE, thinking, `cache_control` and the `anthropic-beta` header, sent once direct and once via 127.0.0.1:8080.

What is the same:
- Both returned 200 with the same SSE event set and a thinking block.
- Prompt caching survives: the second call was served from cache through the proxy (11,064 cached tokens direct, 11,369 via the proxy).

What differs:
- The proxy adds about 305 cached tokens plus about 317 uncached input tokens per request: 326 against 9 uncached on the cached run, and 2,268 against 1,646 on the uncached run.
- `rtk pipeline show` lists the merged directives `rtk-awareness` and `terse-output`. These change how the agent writes, so behaviour is not identical.
- The proxy recorded `usage_records.project` = the `x-rtk-project` header verbatim (the full cwd path), plus `session` and `pipeline=haiku-compaction`. Project-scoped proxy savings therefore need routed pi traffic carrying that header.

Conclusion: routing pi through the proxy is opt-in, not the default. It changes the agent's prompt and costs about 320 uncached tokens per request, recovered only on large tool results (ccr above 1,500 tokens).

## Still open
- How long and in what shape the Haiku route takes on a real >5,000-token pi output (a paid call, run once).
