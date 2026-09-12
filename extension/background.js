/**
 * Ollama Hub 扩展 — background service worker (MV3, module)
 *
 * 职责：
 *   1. 代理对 Ollama API (127.0.0.1:11434) 的请求 —— 扩展页面的 origin 会被
 *      Ollama 的 CORS 校验拒绝，而 background 拥有 host_permissions，可直连
 *   2. 抓取并解析 ollama.com 的搜索/版本页面（复用 lib/site-parser.mjs）
 *   3. 通过长连接 Port 转发模型下载的流式进度
 */
import { parseListPage, parseTagsPage } from './lib/site-parser.mjs';

const OLLAMA = 'http://127.0.0.1:11434';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SCRAPE_TTL = 120_000;

// 点击工具栏图标 → 打开控制台页
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
});

// ---------------- ollama.com 抓取（带缓存） ----------------
const cache = new Map();
async function scrapeSite(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < SCRAPE_TTL) return hit.html;
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`ollama.com 返回 HTTP ${r.status}`);
  const html = await r.text();
  cache.set(url, { t: Date.now(), html });
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return html;
}

const encodeModelPath = (name) => name.split('/').map(encodeURIComponent).join('/');

// ---------------- 一次性消息：status / search / model / ollama ----------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.kind === 'status') {
        try {
          const r = await fetch(OLLAMA + '/api/version', { signal: AbortSignal.timeout(3000) });
          const j = await r.json();
          sendResponse({ ok: true, version: j.version, upstream: OLLAMA });
        } catch {
          sendResponse({ ok: false, upstream: OLLAMA });
        }
      } else if (msg.kind === 'search') {
        const q = String(msg.q || '').trim();
        const sort = msg.sort === 'newest' ? 'newest' : 'popular';
        const caps = (msg.caps || []).filter((c) => /^[a-z][a-z-]*$/.test(c)).slice(0, 8);
        let url;
        if (q || caps.length) {
          const us = new URLSearchParams();
          if (q) us.set('q', q);
          for (const c of caps) us.append('c', c);
          if (sort === 'newest') us.set('o', 'newest');
          url = 'https://ollama.com/search' + (us.toString() ? '?' + us : '');
        } else {
          url = 'https://ollama.com/library?sort=' + sort;
        }
        sendResponse({ query: q, sort, caps, count: 0, items: parseListPage(await scrapeSite(url)) });
      } else if (msg.kind === 'model') {
        const name = String(msg.name || '');
        const modelPath = name.includes('/')
          ? `https://ollama.com/${encodeModelPath(name)}/tags`
          : `https://ollama.com/library/${encodeModelPath(name)}/tags`;
        const html = await scrapeSite(modelPath);
        const data = parseTagsPage(html, name);
        if (!data.tags.length) sendResponse({ error: `未找到模型 ${name} 的版本列表` });
        else sendResponse(data);
      } else if (msg.kind === 'ollama') {
        const r = await fetch(OLLAMA + msg.path, {
          method: msg.method || 'GET',
          headers: msg.body ? { 'Content-Type': 'application/json' } : undefined,
          body: msg.body ? JSON.stringify(msg.body) : undefined,
        });
        let j = {};
        try { j = await r.json(); } catch {}
        if (!r.ok) sendResponse({ __error: true, error: j.error || `HTTP ${r.status}` });
        else sendResponse(j);
      } else {
        sendResponse({ error: 'unknown kind' });
      }
    } catch (e) {
      sendResponse({ error: e.message || String(e) });
    }
  })();
  return true; // 保持消息通道以支持异步 sendResponse
});

// ---------------- 下载流式进度（长连接 Port） ----------------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'pull') return;
  const ac = new AbortController();
  let started = false;
  port.onMessage.addListener(async (m) => {
    if (m.type === 'cancel') ac.abort();
    else if (m.model && !started) {
      started = true;
      try {
        const r = await fetch(OLLAMA + '/api/pull', {
          method: 'POST',
          signal: ac.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: m.model, name: m.model, stream: true }),
        });
        if (!r.ok) {
          let msg = `HTTP ${r.status}`;
          try { msg = (await r.json()).error || msg; } catch {}
          throw new Error(msg);
        }
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            try { port.postMessage({ type: 'line', line: JSON.parse(line) }); } catch {}
          }
        }
        port.postMessage({ type: 'end', error: null });
      } catch (e) {
        port.postMessage({ type: 'end', error: ac.signal.aborted ? null : (e.message || String(e)) });
      }
    }
  });
  port.onDisconnect.addListener(() => ac.abort());
});
