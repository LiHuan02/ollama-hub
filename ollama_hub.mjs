#!/usr/bin/env node
/**
 * Ollama Hub — Ollama 本地可视化控制台
 *
 * 零依赖，仅需 Node.js >= 18。
 * 功能：
 *   1. 提供本地网页 UI（public/index.html）
 *   2. 反向代理 Ollama REST API（127.0.0.1:11434），规避浏览器 CORS 限制，支持流式下载进度
 *   3. 抓取并解析 ollama.com 的模型搜索 / 模型库 / 版本(tags) 页面，供 UI 浏览与搜索模型
 *
 * 用法:
 *   node ollama_hub.mjs [--port 11435] [--no-open]
 * 环境变量:
 *   OLLAMA_HOST       Ollama 地址，默认 http://127.0.0.1:11434
 *   OLLAMA_HUB_PORT   监听端口，默认 11435（被占用时自动向后寻找可用端口）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPSTREAM = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SCRAPE_TTL = 120_000;

// ------------------------- 命令行参数 -------------------------
const argv = process.argv.slice(2);
let wantPort = parseInt(process.env.OLLAMA_HUB_PORT || '11435', 10);
let autoOpen = true;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--port' && argv[i + 1]) wantPort = parseInt(argv[++i], 10);
  else if (argv[i] === '--no-open') autoOpen = false;
  else if (argv[i] === '-h' || argv[i] === '--help') {
    console.log('用法: node ollama_hub.mjs [--port 11435] [--no-open]');
    process.exit(0);
  }
}

// ------------------------- 小工具 -------------------------
function send(res, code, body, headers = {}) {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(buf);
}
const sendJSON = (res, code, obj) => send(res, code, JSON.stringify(obj));

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x0*27;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d));
}
const stripTags = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

// ------------------------- ollama.com 抓取与解析 -------------------------
const scrapeCache = new Map();
async function scrapeSite(url) {
  const hit = scrapeCache.get(url);
  if (hit && Date.now() - hit.t < SCRAPE_TTL) return hit.html;
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`ollama.com 返回 HTTP ${r.status}`);
  const html = await r.text();
  scrapeCache.set(url, { t: Date.now(), html });
  if (scrapeCache.size > 80) scrapeCache.delete(scrapeCache.keys().next().value); // 简单淘汰
  return html;
}

/** 解析搜索页 / 模型库列表页中每个 <li> 结果卡片 */
function parseListPage(html) {
  const items = [];
  const liRe = /<li[^>]*>\s*<a href="\/library\/([^"]+)"[\s\S]*?<\/li>/g;
  let m;
  while ((m = liRe.exec(html))) {
    const name = decodeEntities(m[1]);
    const block = m[0];
    const desc = block.match(/<p class="max-w-lg[^"]*">([\s\S]*?)<\/p>/);
    const caps = [...block.matchAll(/class="[^"]*bg-indigo-50[^"]*"[^>]*>([^<]+)<\/span>/g)].map((x) => x[1].trim());
    const variants = [...block.matchAll(/class="[^"]*bg-\[#ddf4ff\][^"]*"[^>]*>([^<]+)<\/span>/g)].map((x) => x[1].trim());
    const pulls = block.match(/<span[^>]*>([^<]+)<\/span>\s*<span class="hidden sm:flex">&nbsp;Pulls<\/span>/);
    const tags = block.match(/<span[^>]*>([^<]+)<\/span>\s*<span class="hidden sm:flex">&nbsp;Tags<\/span>/);
    const updated = block.match(/Updated(?:&nbsp;)?<\/span>\s*<span[^>]*>([^<]+)<\/span>/);
    items.push({
      name,
      description: desc ? decodeEntities(stripTags(desc[1])) : '',
      capabilities: caps,
      variants,
      pulls: pulls ? pulls[1].trim() : '',
      tagCount: tags ? tags[1].trim() : '',
      updated: updated ? updated[1].trim() : '',
    });
  }
  return items;
}

/** 解析模型 tags 页（https://ollama.com/library/<name>/tags） */
function parseTagsPage(html, name) {
  const capabilities = [...html.matchAll(/class="[^"]*bg-indigo-50[^"]*"[^>]*>([^<]+)<\/span>/g)]
    .slice(0, 12).map((x) => x[1].trim());
  const variants = [...html.matchAll(/class="[^"]*bg-\[#ddf4ff\][^"]*"[^>]*>([^<]+)<\/span>/g)]
    .slice(0, 30).map((x) => x[1].trim());
  const tags = [];
  const blocks = html.split(/<div class="group px-4 py-3">/).slice(1);
  for (const b of blocks) {
    const val = b.match(/<input class="command hidden" value="([^"]+)"/);
    if (!val) continue;
    const cols = [...b.matchAll(/<p class="col-span-2 text-neutral-500 text-\[13px\]">\s*([^<]*?)\s*<\/p>/g)].map((x) => x[1]);
    const digest = b.match(/font-mono[^>]*>([0-9a-f]{12})</);
    const updated = b.match(/·&nbsp;([^<]+)</);
    const input = b.match(/<div class="col-span-2 text-neutral-500 text-\[13px\]\s*">([\s\S]*?)<\/div>/);
    const full = decodeEntities(val[1]);
    tags.push({
      tag: full.startsWith(name + ':') ? full.slice(name.length + 1) : full,
      model: full,
      size: cols[0] || '',
      context: cols[1] || '',
      input: input ? stripTags(input[1]) : '',
      digest: digest ? digest[1] : '',
      updated: updated ? updated[1].trim() : '',
    });
  }
  return { name, capabilities, variants, tags };
}

const encodeModelPath = (name) => name.split('/').map(encodeURIComponent).join('/');

// ------------------------- Ollama API 代理 -------------------------
async function proxyOllama(req, res) {
  const u = new URL(req.url, 'http://x');
  const target = UPSTREAM + u.pathname.replace(/^\/ollama/, '') + (u.search || '');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  const ac = new AbortController();
  req.on('close', () => ac.abort());
  try {
    const r = await fetch(target, {
      method: req.method,
      body: body && body.length ? body : undefined,
      headers: body && body.length ? { 'Content-Type': req.headers['content-type'] || 'application/json' } : {},
      signal: ac.signal,
      // 大模型下载可能持续很久，不设超时
    });
    if (u.searchParams.get('stream') === '1' && r.body) {
      res.writeHead(r.status, {
        'Content-Type': r.headers.get('content-type') || 'application/x-ndjson',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        Connection: 'close',
      });
      Readable.fromWeb(r.body).on('error', () => res.end()).pipe(res);
    } else {
      const buf = Buffer.from(await r.arrayBuffer());
      send(res, r.status, buf, { 'Content-Type': r.headers.get('content-type') || 'application/json' });
    }
  } catch (e) {
    if (!res.headersSent) sendJSON(res, 502, { error: `无法连接 Ollama (${UPSTREAM})：${e.cause?.code || e.message}` });
    else res.end();
  }
}

// ------------------------- 路由 -------------------------
async function handleRequest(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    // Ollama API 反向代理
    if (p.startsWith('/ollama/')) return await proxyOllama(req, res);

    if (req.method === 'GET') {
      // 静态文件（public/）
      if (p === '/' || p === '/index.html') {
        const f = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
        return send(res, 200, f, { 'Content-Type': 'text/html; charset=utf-8' });
      }
      if (p === '/favicon.ico') return send(res, 204, '', { 'Content-Type': 'image/x-icon' });
      if (p.startsWith('/public/')) {
        const file = path.normalize(path.join(PUBLIC_DIR, p.slice('/public/'.length)));
        if (!file.startsWith(PUBLIC_DIR)) return sendJSON(res, 403, { error: 'forbidden' });
        if (!fs.existsSync(file)) return sendJSON(res, 404, { error: 'not found' });
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
        return send(res, 200, fs.readFileSync(file), { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      }

      // 服务与 Ollama 连接状态
      if (p === '/api/status') {
        try {
          const r = await fetch(UPSTREAM + '/api/version', { signal: AbortSignal.timeout(3000) });
          const j = await r.json();
          return sendJSON(res, 200, { ok: true, version: j.version, upstream: UPSTREAM });
        } catch {
          return sendJSON(res, 200, { ok: false, upstream: UPSTREAM });
        }
      }

      // 模型搜索 / 热门列表（数据源：ollama.com）
      if (p === '/hub/search') {
        const q = (u.searchParams.get('q') || '').trim();
        const sort = u.searchParams.get('sort') === 'newest' ? 'newest' : 'popular';
        const url = q
          ? `https://ollama.com/search?q=${encodeURIComponent(q)}`
          : `https://ollama.com/library?sort=${sort}`;
        const items = parseListPage(await scrapeSite(url));
        return sendJSON(res, 200, { query: q, sort, count: items.length, items });
      }

      // 模型版本(tags)详情（数据源：ollama.com）
      if (p.startsWith('/hub/model/')) {
        const name = decodeURIComponent(p.slice('/hub/model/'.length));
        if (!name) return sendJSON(res, 400, { error: '缺少模型名' });
        const html = await scrapeSite(`https://ollama.com/library/${encodeModelPath(name)}/tags`);
        const data = parseTagsPage(html, name);
        if (!data.tags.length) return sendJSON(res, 404, { error: `未找到模型 ${name} 的版本列表` });
        return sendJSON(res, 200, data);
      }
    }
    sendJSON(res, 404, { error: 'not found' });
  } catch (e) {
    sendJSON(res, 502, { error: e.message || String(e) });
  }
}

// ------------------------- 启动 -------------------------
function listen(port, tries = 10) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handleRequest);
    srv.once('error', (e) => {
      if (e.code === 'EADDRINUSE' && tries > 0) resolve(listen(port + 1, tries - 1));
      else reject(e);
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* 打不开就算了，控制台里有地址 */ }
}

const srv = await listen(wantPort);
const { port } = srv.address();
const url = `http://127.0.0.1:${port}`;
console.log('┌─────────────────────────────────────────────┐');
console.log('│  🦙  Ollama Hub 已启动                        │');
console.log(`│  地址     ${url.padEnd(34)}│`);
console.log(`│  Ollama  ${UPSTREAM.padEnd(34)}│`);
console.log('│  停止服务：关闭本窗口 / Ctrl+C               │');
console.log('└─────────────────────────────────────────────┘');
if (autoOpen && port === wantPort) openBrowser(url); // 端口被顺延时大概率是旧实例在跑，不再自动开页
else if (autoOpen) console.log('提示: 默认端口被占用，已自动换用上述地址（可能是已有一个实例在运行）');
