// workbench-mini — a minimal Claude-Code-style agent workbench for local LLMs.
// Backend: any OpenAI-compatible server (LM Studio, Ollama, llama.cpp, vLLM).
//   LM Studio (default): LLM_BASE_URL=http://localhost:1234/v1
//   Ollama:              LLM_BASE_URL=http://localhost:11434/v1
// Usage: node server.js [workspace-folder]   (defaults to ./sandbox)
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listModels } from './lib/llm.js';
import { Agent } from './lib/agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ?? 4600;
const WORKSPACE = path.resolve(process.argv[2] ?? path.join(__dirname, 'sandbox'));
fs.mkdirSync(WORKSPACE, { recursive: true });

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const broadcast = (evt) => {
  const msg = JSON.stringify(evt);
  for (const client of wss.clients) if (client.readyState === 1) client.send(msg);
};

let agent = null; // one session per server run — restart for a fresh one

app.get('/api/models', async (_req, res) => {
  try { res.json({ ok: true, models: await listModels(), workspace: WORKSPACE }); }
  catch (err) { res.json({ ok: false, error: String(err).slice(0, 200) }); }
});

app.post('/api/chat', async (req, res) => {
  const { text, model, mode } = req.body;
  if (!agent) agent = new Agent({ model, workspace: WORKSPACE, broadcast });
  if (mode) agent.mode = mode;
  try { res.json({ reply: await agent.send(String(text ?? '')) }); }
  catch (err) { res.status(500).json({ error: String(err.message ?? err) }); }
});

app.post('/api/approval', (req, res) => {
  res.json({ ok: agent?.resolveApproval(req.body.decision) ?? false });
});

server.listen(PORT, () => {
  console.log(`workbench-mini → http://localhost:${PORT}`);
  console.log(`backend:   ${process.env.LLM_BASE_URL ?? 'http://localhost:1234/v1 (LM Studio default)'}`);
  console.log(`workspace: ${WORKSPACE}`);
});
