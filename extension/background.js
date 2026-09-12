import { parseListPage, parseTagsPage } from './lib/site-parser.mjs';

const OLLAMA = 'http://127.0.0.1:11434';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SCRAPE_TTL = 120_000;
const cache = new Map();

chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('index.html') }));

async function scrapeSite(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < SCRAPE_TTL) return hit.html;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`ollama.com 返回 HTTP ${r.status}`);
  const html = await r.text(); cache.set(url, { t: Date.now(), html });
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return html;
}
const encodeModelPath = (name) => name.split('/').map(encodeURIComponent).join('/');
const age = (i) => i.updatedAt ? Date.parse(i.updatedAt) : 0;
const pulls = (i) => i.pullsCount || 0;
const FEATURED_RECOMMENDATIONS = ['glm-5.3', 'glm-5.3-flash', 'deepseek-v4-flash'];
function sortItems(items, sort) {
  return [...items].sort((a, b) => {
    if (sort === 'downloads') return pulls(b) - pulls(a) || age(b) - age(a);
    if (sort === 'newest') return age(b) - age(a) || pulls(b) - pulls(a);
    const ai = FEATURED_RECOMMENDATIONS.indexOf(a.name), bi = FEATURED_RECOMMENDATIONS.indexOf(b.name);
    if (ai >= 0 || bi >= 0) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    return age(b) - age(a) || pulls(b) - pulls(a);
  });
}
function applyFilters(items, f = {}) {
  const limit = { '7d': 7, '30d': 30, '90d': 90, '1y': 366 }[f.updated];
  const minPulls = Number(f.minPulls) || 0;
  return items.filter((i) => (!f.source || f.source === 'all' || i.source === f.source) && (!minPulls || pulls(i) >= minPulls) && (!limit || (i.updatedAt && Date.parse(i.updatedAt) >= Date.now() - limit * 864e5)));
}

const OLLAMA_OPS = {
  tags: { path: '/api/tags', method: 'GET' },
  ps: { path: '/api/ps', method: 'GET' },
  show: { path: '/api/show', method: 'POST' },
  delete: { path: '/api/delete', method: 'DELETE' },
  unload: { path: '/api/generate', method: 'POST' },
};
async function ollamaOp(op, body) {
  const def = OLLAMA_OPS[op];
  if (!def) throw new Error('不允许的 Ollama 操作');
  const r = await fetch(OLLAMA + def.path, { method: def.method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.kind === 'status') {
        try { const r = await fetch(OLLAMA + '/api/version', { signal: AbortSignal.timeout(3000) }); const j = await r.json(); sendResponse({ ok: true, version: j.version, upstream: OLLAMA }); }
        catch { sendResponse({ ok: false, upstream: OLLAMA }); }
      } else if (msg.kind === 'search') {
        const q = String(msg.q || '').trim();
        const sort = ['recommended', 'newest', 'downloads'].includes(msg.sort) ? msg.sort : 'recommended';
        const caps = (msg.caps || []).filter((c) => /^[a-z][a-z-]*$/.test(c)).slice(0, 8);
        let url;
        if (q || caps.length) { const us = new URLSearchParams(); if (q) us.set('q', q); for (const c of caps) us.append('c', c); if (sort === 'newest') us.set('o', 'newest'); url = 'https://ollama.com/search?' + us; }
        else url = sort === 'downloads' ? 'https://ollama.com/library' : 'https://ollama.com/library?sort=newest';
        const items = sortItems(applyFilters(parseListPage(await scrapeSite(url)), msg.filters), sort);
        sendResponse({ query: q, sort, caps, filters: msg.filters || {}, count: items.length, items });
      } else if (msg.kind === 'model') {
        const name = String(msg.name || '');
        const url = name.includes('/') ? `https://ollama.com/${encodeModelPath(name)}/tags` : `https://ollama.com/library/${encodeModelPath(name)}/tags`;
        const data = parseTagsPage(await scrapeSite(url), name);
        sendResponse(data.tags.length ? data : { error: `未找到模型 ${name} 的版本列表` });
      } else if (msg.kind === 'ollama') {
        sendResponse(await ollamaOp(msg.op, msg.body));
      } else sendResponse({ error: 'unknown kind' });
    } catch (e) { sendResponse({ __error: true, error: e.message || String(e) }); }
  })();
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'pull') return;
  const ac = new AbortController(); let started = false; let finished = false;
  const finish = (payload) => { if (!finished) { finished = true; try { port.postMessage({ type: 'end', ...payload }); } catch {} } };
  port.onMessage.addListener(async (m) => {
    if (m.type === 'cancel') { ac.abort(); return; }
    if (!m.model || started) return;
    started = true;
    try {
      const r = await fetch(OLLAMA + '/api/pull', { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: m.model, name: m.model, stream: true }) });
      if (!r.ok) { let j = {}; try { j = await r.json(); } catch {} throw new Error(j.error || `HTTP ${r.status}`); }
      const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true }); let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const raw = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!raw) continue;
          const line = JSON.parse(raw); if (line.error) throw new Error(line.error); port.postMessage({ type: 'line', line });
        }
      }
      finish({ error: null });
    } catch (e) { finish(ac.signal.aborted ? { cancelled: true } : { error: e.message || String(e) }); }
  });
  port.onDisconnect.addListener(() => ac.abort());
});
