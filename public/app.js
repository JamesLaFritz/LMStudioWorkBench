// app.js — minimal UI: stream the agent's output, render approval cards.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let streamEl = null;

init();
async function init() {
  const res = await (await fetch('/api/models')).json();
  $('ws').textContent = res.ok ? `workspace: ${res.workspace}` : `backend offline: ${res.error}`;
  $('model').innerHTML = (res.models ?? []).map((m) => `<option>${esc(m)}</option>`).join('');
  connectWS();
  $('composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
}

async function send() {
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  add('user', text);
  const res = await (await fetch('/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model: $('model').value, mode: $('mode').value }),
  })).json();
  if (res.error) add('assistant', `Error: ${res.error}`);
}

function connectWS() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (m) => {
    const evt = JSON.parse(m.data);
    if (evt.type === 'delta') {
      if (!streamEl) streamEl = add('assistant', '');
      streamEl.textContent += evt.text;
      scroll();
    }
    if (evt.type === 'done') {
      if (streamEl) { streamEl.textContent = evt.text ?? streamEl.textContent; streamEl = null; }
      scroll();
    }
    if (evt.type === 'tool') {
      streamEl = null;
      const el = document.createElement('div');
      el.className = 'toolcard';
      el.textContent = `TOOL · ${evt.tool} ${evt.detail ?? ''}`;
      $('chat').appendChild(el);
      scroll();
    }
    if (evt.type === 'approval') approvalCard(evt);
  };
  ws.onclose = () => setTimeout(connectWS, 3000);
}

function approvalCard(evt) {
  const el = document.createElement('div');
  el.className = 'toolcard approve';
  let html = `<b>APPROVAL · ${esc(evt.tool)}</b><br><span>${esc(evt.detail ?? '')}</span>`;
  if (evt.diff) {
    const del = evt.diff.old ? evt.diff.old.split('\n').map((l) => `<span class="del">- ${esc(l)}</span>`).join('\n') + '\n' : '';
    const add = (evt.diff.new ?? '').split('\n').map((l) => `<span class="add">+ ${esc(l)}</span>`).join('\n');
    html += `<div class="diff">${del}${add}</div>`;
  }
  html += `<div>
    <button data-d="approve">Approve</button>
    <button data-d="deny">Deny</button>
    <button data-d="always">Always Allow</button></div>`;
  el.innerHTML = html;
  el.addEventListener('click', async (e) => {
    const d = e.target.dataset?.d;
    if (!d) return;
    await fetch('/api/approval', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: d }) });
    el.querySelector('div:last-child').textContent = `→ ${d.toUpperCase()}`;
  });
  $('chat').appendChild(el);
  scroll();
}

function add(kind, text) {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  el.textContent = text;
  $('chat').appendChild(el);
  scroll();
  return el;
}
const scroll = () => { const c = $('chat'); c.scrollTop = c.scrollHeight; };
