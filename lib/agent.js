// agent.js — the agent loop: the model proposes tool calls, we execute them
// inside a workspace jail, writes and commands wait for human approval.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chatStream } from './llm.js';

export const TOOL_DEFS = [
  { name: 'read_file', needsApproval: false,
    description: 'Read a UTF-8 text file. Returns at most 40000 chars.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path relative to the workspace root' } }, required: ['path'] } },
  { name: 'list_dir', needsApproval: false,
    description: 'List files and folders at a path (non-recursive).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'grep', needsApproval: false,
    description: 'Search file contents with a regex. Returns matching lines as file:line (max 100).',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Folder to search; default "."' } }, required: ['pattern'] } },
  { name: 'write_file', needsApproval: true,
    description: 'Create or overwrite a file with the given content.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file', needsApproval: true,
    description: 'Replace an exact text snippet in a file. old_text must match exactly once.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
  { name: 'run_command', needsApproval: true,
    description: 'Run a shell command in the workspace root. Returns stdout+stderr (max 20000 chars).',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
];

const SYSTEM_PROMPT = `You are a coding agent operating on files inside one workspace via tools.
Rules, in order:
1. Never invent file contents — read before you edit. Never claim an action you did not take.
2. Plan briefly, then act with tools. One logical step at a time.
3. Prefer minimal edits via edit_file; write_file only for new files.
4. Writes and commands need user approval; if denied, adjust your approach rather than retrying the same call.
5. Be terse. Report what changed, not how hard you worked.`;

export class Agent {
  constructor({ model, workspace, broadcast }) {
    this.model = model;
    this.workspace = path.resolve(workspace);
    this.broadcast = broadcast;                 // (event) => void, straight to the UI
    this.messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    this.pending = null;                        // resolver for an approval we're waiting on
    this.allowlist = new Set();                 // "always allow" decisions for this session
    this.mode = 'ask';                          // 'ask' | 'plan' (read-only) | 'auto' (no gates)
    this.busy = false;
  }

  /**
   * The workspace jail. Every path the model supplies goes through here.
   * The model's input is untrusted — without this check, "read ../../.ssh/id_rsa"
   * is a working exfiltration tool.
   */
  safe(rel) {
    const abs = path.resolve(this.workspace, rel ?? '.');
    if (abs !== this.workspace && !abs.startsWith(this.workspace + path.sep)) {
      throw new Error(`Path escapes workspace: ${rel}`);
    }
    return abs;
  }

  /** One user turn: loop until the model answers in plain text (or 16 hops). */
  async send(userText) {
    if (this.busy) throw new Error('Agent is mid-turn; resolve the pending approval first.');
    this.busy = true;
    this.messages.push({ role: 'user', content: userText });
    try {
      for (let hop = 0; hop < 16; hop++) {
        const { content, toolCalls } = await chatStream({
          model: this.model,
          messages: this.messages,
          tools: TOOL_DEFS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
          onDelta: (d) => this.broadcast({ type: 'delta', text: d }),
        });

        if (!toolCalls.length) {
          this.messages.push({ role: 'assistant', content });
          this.broadcast({ type: 'done', text: content });
          return content;                        // the model is done talking
        }

        this.messages.push({
          role: 'assistant', content: content || null,
          tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } })),
        });
        for (const tc of toolCalls) {
          const result = await this.execute(tc); // may pause here awaiting approval
          this.messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
      }
      const bail = 'Stopped after 16 tool hops — the task likely needs to be split.';
      this.broadcast({ type: 'done', text: bail });
      return bail;
    } finally {
      this.busy = false;
    }
  }

  async execute(tc) {
    let args;
    try { args = JSON.parse(tc.args || '{}'); }
    catch { return `ERROR: unparseable tool arguments: ${tc.args?.slice(0, 200)}`; }
    const def = TOOL_DEFS.find((t) => t.name === tc.name);
    if (!def) return `ERROR: unknown tool ${tc.name}`;

    const preview = tc.name === 'run_command' ? args.command : (args.path ?? args.pattern ?? '');
    this.broadcast({ type: 'tool', tool: tc.name, detail: preview });

    // The gate. Reads pass free; writes and commands stop the world.
    if (def.needsApproval && this.mode === 'plan') {
      return 'BLOCKED: this session is in PLAN mode — no writes or commands. Describe the intended change instead.';
    }
    if (def.needsApproval && this.mode !== 'auto' && !this.allowlist.has(tc.name)) {
      const decision = await this.askApproval(tc.name, args);
      if (decision === 'deny') return 'DENIED by user. Do not retry this exact action; ask or adjust.';
      if (decision === 'always') this.allowlist.add(tc.name);
    }

    try {
      switch (tc.name) {
        case 'read_file': {
          const text = fs.readFileSync(this.safe(args.path), 'utf8');
          return text.length > 40000 ? text.slice(0, 40000) + `\n…truncated (${text.length} chars total)` : text;
        }
        case 'list_dir':
          return fs.readdirSync(this.safe(args.path ?? '.'), { withFileTypes: true })
            .map((e) => (e.isDirectory() ? 'd ' : 'f ') + e.name).join('\n') || '(empty)';
        case 'grep': {
          const re = new RegExp(args.pattern);
          const hits = [];
          const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
              if (hits.length >= 100) return;
              const p = path.join(dir, e.name);
              if (e.isDirectory()) { if (!/node_modules|\.git/.test(e.name)) walk(p); continue; }
              if (!/\.(md|js|ts|json|txt|cs|py|html|css)$/i.test(e.name)) continue;
              fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => {
                if (hits.length < 100 && re.test(l)) hits.push(`${path.relative(this.workspace, p)}:${i + 1}: ${l.trim().slice(0, 200)}`);
              });
            }
          };
          walk(this.safe(args.path ?? '.'));
          return hits.join('\n') || 'no matches';
        }
        case 'write_file': {
          const abs = this.safe(args.path);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, args.content, 'utf8');
          return `wrote ${args.path} (${args.content.length} chars)`;
        }
        case 'edit_file': {
          const abs = this.safe(args.path);
          const text = fs.readFileSync(abs, 'utf8');
          const count = text.split(args.old_text).length - 1;
          if (count === 0) return 'ERROR: old_text not found — re-read the file.';
          if (count > 1) return `ERROR: old_text matches ${count} times — provide a longer unique snippet.`;
          fs.writeFileSync(abs, text.replace(args.old_text, args.new_text), 'utf8');
          return `edited ${args.path}`;
        }
        case 'run_command':
          return await new Promise((resolve) => {
            const child = spawn(args.command, { cwd: this.workspace, shell: true, timeout: 120000 });
            let out = '';
            child.stdout.on('data', (c) => (out += c));
            child.stderr.on('data', (c) => (out += c));
            child.on('close', (code) => resolve(`exit ${code}\n${out.slice(0, 20000)}`));
            child.on('error', (err) => resolve(`ERROR: ${err}`));
          });
      }
    } catch (err) {
      return `ERROR: ${String(err).slice(0, 500)}`;
    }
  }

  /**
   * "Stop the world" is just an unresolved promise. The agent's turn awaits it;
   * the UI shows a card; the user's click resolves it and the turn continues.
   */
  askApproval(tool, args) {
    return new Promise((resolve) => {
      this.pending = { resolve };
      this.broadcast({
        type: 'approval', tool,
        detail: tool === 'run_command' ? args.command : args.path,
        diff: tool === 'edit_file' ? { old: args.old_text, new: args.new_text }
            : tool === 'write_file' ? { new: (args.content ?? '').slice(0, 4000) } : null,
      });
    });
  }

  resolveApproval(decision) {              // 'approve' | 'deny' | 'always'
    if (!this.pending) return false;
    this.pending.resolve(decision);
    this.pending = null;
    return true;
  }
}
