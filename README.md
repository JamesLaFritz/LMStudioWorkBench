# workbench-mini

A minimal **Claude-Code-style agent workbench for local LLMs** — the model proposes tool calls, they execute inside a workspace jail, and writes/commands stop for your approval. Vanilla JS, two dependencies (`express`, `ws`), ~450 lines.

Companion repo for the article **[Your Local LLM Can Use Tools Too](https://medium.com/@ktmarine1999)** — part of the [Ember OS](https://ktmarine1999.medium.com/i-built-an-ai-operating-system-in-obsidian-so-my-game-dev-hours-actually-count-441c2ce19606) series.

## Quick start

```bash
npm install
node server.js path/to/workspace     # defaults to ./sandbox
# open http://localhost:4600
```

Requires a local OpenAI-compatible LLM server with a **tool-calling model** loaded (Qwen-class 9B+ recommended; 30B MoE works great on a 24 GB GPU).

## Backends

Any OpenAI-compatible server works — switch with one env var:

| Backend | `LLM_BASE_URL` |
|---|---|
| **LM Studio** (default) | `http://localhost:1234/v1` |
| **Ollama** | `http://localhost:11434/v1` |
| **llama.cpp** (`llama-server`) | `http://localhost:8080/v1` |
| **vLLM** | `http://localhost:8000/v1` |

```bash
LLM_BASE_URL=http://localhost:11434/v1 node server.js   # Ollama
```

Notes: tool-calling quality depends on the *model* more than the backend — pick one trained for function calling. Some backends differ in streaming details; this client sticks to the widely-supported subset (`stream: true`, delta accumulation) on purpose. Reasoning models may emit `<think>…</think>` in their output — the mini shows it raw.

## What's in the box

```
server.js          # express + websocket wiring (~60 lines)
lib/llm.js         # streaming client for any OpenAI-compatible backend
lib/agent.js       # the loop: tools, workspace jail, approval gate
public/index.html  # one-page UI
public/app.js      # stream rendering + approval cards
```

- **Six tools:** `read_file`, `list_dir`, `grep` (free) · `write_file`, `edit_file`, `run_command` (gated).
- **Workspace jail:** every model-supplied path is resolved and checked against the workspace root.
- **Approval gate:** gated tools suspend the agent's turn on an unresolved promise until you click Approve / Deny / Always Allow. Deny feeds back to the model so it adjusts.
- **Modes:** Ask (default) · Plan (read-only) · Auto (no gates — you were warned).

## Security

This executes model-chosen shell commands **on your machine** after your approval. Keep the workspace pointed at a sandbox folder, read every `run_command` card before approving, and don't run it in Auto mode on anything you love. The jail stops path escapes; it does not make `run_command` safe.

## License

MIT
