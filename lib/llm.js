// llm.js — a tiny client for any OpenAI-compatible chat server.
// Works with LM Studio (http://localhost:1234/v1), Ollama
// (http://localhost:11434/v1), llama.cpp server, vLLM, etc.
// Set LLM_BASE_URL to switch backends — no other changes needed.

const BASE = (process.env.LLM_BASE_URL ?? 'http://localhost:1234/v1').replace(/\/$/, '');

/** List available model ids from the backend. */
export async function listModels() {
  const res = await fetch(`${BASE}/models`);
  if (!res.ok) throw new Error(`GET /models → ${res.status}`);
  const data = await res.json();
  return (data.data ?? []).map((m) => m.id);
}

/**
 * Streaming chat completion with tool support.
 * Returns { content, toolCalls } once the turn ends; calls onDelta(text)
 * for each streamed content chunk so the UI can render live.
 *
 * The fiddly part is tool_calls: they arrive as *deltas* spread across
 * many chunks (name in one, argument fragments in the rest), keyed by
 * `index`. You must accumulate them — a single chunk is never the whole call.
 */
export async function chatStream({ model, messages, tools, onDelta }) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, stream: true, temperature: 0.3 }),
  });
  if (!res.ok) throw new Error(`chat → ${res.status}: ${(await res.text()).slice(0, 300)}`);

  let content = '';
  const toolCalls = [];
  const decoder = new TextDecoder();
  let buf = '';

  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;

      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      const delta = evt.choices?.[0]?.delta ?? {};

      if (delta.content) {
        content += delta.content;
        onDelta?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? 0;
        toolCalls[i] ??= { id: tc.id ?? `call_${i}`, name: '', args: '' };
        if (tc.id) toolCalls[i].id = tc.id;
        if (tc.function?.name) toolCalls[i].name += tc.function.name;
        if (tc.function?.arguments) toolCalls[i].args += tc.function.arguments;
      }
    }
  }
  return { content, toolCalls: toolCalls.filter(Boolean) };
}
