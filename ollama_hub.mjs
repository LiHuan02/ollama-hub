#!/usr/bin/env node
/**
 * Ollama Hub — Ollama 本地可视化控制台
 *
 * 零依赖，仅需 Node.js >= 18。
 * 功能：
 *   1. 提供本地网页 UI（public/index.html）
 *   2. 反向代理 Ollama REST API（默认 127.0.0.1:11434），规避浏览器 CORS 限制，支持流式下载进度
 *   3. 抓取并解析 ollama.com 的模型搜索 / 模型库 / 版本(tags) 页面，供 UI 浏览与搜索模型
 *   4. 检测本机内存/显存，供 UI 估算各版本模型的本机运行压力
 *
 * 用法:
 *   node ollama_hub.mjs [--port 11435] [--no-open]
 * 环境变量:
 *   OLLAMA_HOST       Ollama 地址，默认 http://127.0.0.1:11434
 *   OLLAMA_HUB_PORT   监听端口，默认 11435（被占用时若已有本工具实例则直接打开它，否则向后寻找）
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseListPage, parseTagsPage } from './lib/site-parser.mjs';

const execFileP = promisify(execFile);
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

// ------------------------- ollama.com 抓取 -------------------------
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
  if (scrapeCache.size > 80) scrapeCache.delete(scrapeCache.keys().next().value);
  return html;
}

const encodeModelPath = (name) => name.split('/').map(encodeURIComponent).join('/');

const FEATURED_RECOMMENDATIONS = ['glm-5.3', 'glm-5.3-flash', 'deepseek-v4-flash'];
function sortItems(items, sort) {
  const age = (item) => item.updatedAt ? Date.parse(item.updatedAt) : 0;
  const pulls = (item) => item.pullsCount || 0;
  return [...items].sort((a, b) => {
    if (sort === 'downloads') return pulls(b) - pulls(a) || age(b) - age(a);
    if (sort === 'newest') return age(b) - age(a) || pulls(b) - pulls(a);
    // 官网动态推荐流没有公开参数；以近期推荐置顶项 + 官网最新流作为可解释的本地推荐。
    const ai = FEATURED_RECOMMENDATIONS.indexOf(a.name), bi = FEATURED_RECOMMENDATIONS.indexOf(b.name);
    if (ai >= 0 || bi >= 0) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    return age(b) - age(a) || pulls(b) - pulls(a);
  });
}

function applyListFilters(items, { source, updated, minPulls }) {
  const now = Date.now();
  const days = { '7d': 7, '30d': 30, '90d': 90, '1y': 366 }[updated];
  return items.filter((item) => {
    if (source && source !== 'all' && item.source !== source) return false;
    if (minPulls && (item.pullsCount || 0) < minPulls) return false;
    if (days && (!item.updatedAt || Date.parse(item.updatedAt) < now - days * 864e5)) return false;
    return true;
  });
}

// ------------------------- 本机硬件检测 -------------------------
async function detectHardware() {
  const data = { ramGB: +(os.totalmem() / 2 ** 30).toFixed(1), vramGB: 0, gpus: [], gpuDetails: [], detectedAt: new Date().toISOString() };
  try {
    const { stdout } = await execFileP('nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader'], { timeout: 4000 });
    for (const line of stdout.trim().split('\n')) {
      const [name, mem] = line.split(',').map((s) => s.trim());
      const mb = parseInt(String(mem || '').replace(/[^\d]/g, ''), 10);
      if (!isNaN(mb)) { const vramGB = +(mb / 1024).toFixed(1); data.vramGB += vramGB; data.gpus.push(name); data.gpuDetails.push({ name, vramGB }); }
    }
  } catch { /* 无 NVIDIA 卡或驱动未装 */ }
  if (!data.vramGB) {
    try {
      const { stdout } = await execFileP('wmic',
        ['path', 'win32_VideoController', 'get', 'Name,AdapterRAM', '/format:list'], { timeout: 4000 });
      let name = '', ramB = 0, has = false;
      const flush = () => {
        if (has && name && ramB > 2 ** 30) {
          const vramGB = +(ramB / 2 ** 30).toFixed(1);
          data.vramGB += vramGB; data.gpus.push(name); data.gpuDetails.push({ name, vramGB });
        }
        name = ''; ramB = 0; has = false;
      };
      for (const line of stdout.split('\n')) {
        const [k, v] = line.trim().split('=');
        if (k === 'Name') { flush(); name = v; has = true; }
        else if (k === 'AdapterRAM') ramB = parseInt(v, 10) || 0;
      }
      flush();
    } catch { /* wmic 不可用 */ }
  }
  data.vramGB = +data.vramGB.toFixed(1);
  data.maxSingleVramGB = Math.max(0, ...data.gpuDetails.map((gpu) => gpu.vramGB));
  return data;
}

// ------------------------- Ollama API 代理 -------------------------
async function proxyOllama(req, res) {
  const u = new URL(req.url, 'http://x');
  const target = UPSTREAM + u.pathname.replace(/^\/ollama/, '') + (u.search || '');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  const ac = new AbortController();
  let streamFinished = false;
  const abortUpstream = () => { if (!ac.signal.aborted) ac.abort(); };
  req.on('aborted', abortUpstream);
  // POST body 已经读完后，客户端取消会发生在 response/socket，而不是 req.close。
  res.on('close', () => { if (!streamFinished && !res.writableEnded) abortUpstream(); });
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
      const upstreamStream = Readable.fromWeb(r.body);
      upstreamStream.on('error', () => { if (!res.writableEnded) res.end(); });
      upstreamStream.on('end', () => { streamFinished = true; });
      upstreamStream.pipe(res);
    } else {
      const buf = Buffer.from(await r.arrayBuffer());
      streamFinished = true;
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
      if (p === '/app.js') return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'app.js')), { 'Content-Type': 'text/javascript; charset=utf-8' });
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

      // 本机硬件（供运行压力估算）
      if (p === '/api/hardware') {
        return sendJSON(res, 200, await detectHardware());
      }

      // 模型搜索 / 热门列表（数据源：ollama.com）
      //  - 无 q 时浏览模型库：/library?sort=popular|newest（官网同款排序）
      //  - 有 q 或带筛选时走 /search：排序参数为 o，能力筛选为可重复的 c
      if (p === '/hub/search') {
        const q = (u.searchParams.get('q') || '').trim();
        const sort = ['recommended', 'newest', 'downloads'].includes(u.searchParams.get('sort')) ? u.searchParams.get('sort') : 'recommended';
        const caps = (u.searchParams.get('caps') || '').split(',').map((s) => s.trim().toLowerCase())
          .filter((s) => /^[a-z][a-z-]*$/.test(s)).slice(0, 8);
        const filters = {
          source: ['all', 'official', 'community'].includes(u.searchParams.get('source')) ? u.searchParams.get('source') : 'all',
          updated: ['7d', '30d', '90d', '1y'].includes(u.searchParams.get('updated')) ? u.searchParams.get('updated') : '',
          minPulls: Math.max(0, Number(u.searchParams.get('minPulls')) || 0),
        };
        let url;
        if (q || caps.length) {
          const us = new URLSearchParams();
          if (q) us.set('q', q);
          for (const c of caps) us.append('c', c);
          if (sort === 'newest') us.set('o', 'newest');
          url = 'https://ollama.com/search' + (us.toString() ? '?' + us : '');
        } else {
          // 推荐/最新都基于官网最新流；推荐再加入当前的近期精选置顶。
          url = sort === 'downloads' ? 'https://ollama.com/library' : 'https://ollama.com/library?sort=newest';
        }
        const scraped = parseListPage(await scrapeSite(url));
        const items = sortItems(applyListFilters(scraped, filters), sort);
        return sendJSON(res, 200, { query: q, sort, caps, filters, count: items.length, items });
      }

      // 模型版本(tags)详情（数据源：ollama.com）
      if (p.startsWith('/hub/model/')) {
        const name = decodeURIComponent(p.slice('/hub/model/'.length));
        if (!name) return sendJSON(res, 400, { error: '缺少模型名' });
        const modelPath = name.includes('/')
          ? `https://ollama.com/${encodeModelPath(name)}/tags`
          : `https://ollama.com/library/${encodeModelPath(name)}/tags`;
        const html = await scrapeSite(modelPath);
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
function listenOnce(port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handleRequest);
    srv.once('error', (e) => reject(e));
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

/** 探测端口上是否已有本工具实例（区分 Ollama Hub 和无关程序） */
async function isHubInstance(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return j && typeof j.ok === 'boolean' && typeof j.upstream === 'string';
  } catch { return false; }
}

function openBrowser(url) {
  const command = process.platform === 'win32' ? 'powershell.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['-NoProfile', '-Command', `Start-Process '${url}'`] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => console.error(`无法自动打开浏览器，请手动访问：${url}`));
  child.unref();
}

let srv = null;
for (let tries = 0; tries < 10; tries++) {
  const port = wantPort + tries;
  try {
    srv = await listenOnce(port);
    break;
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    if (await isHubInstance(port)) {
      console.log(`检测到 Ollama Hub 已在运行（端口 ${port}），直接为你打开页面。`);
      if (autoOpen) openBrowser(`http://127.0.0.1:${port}`);
      process.exit(0);
    }
    // 端口被无关程序占用，尝试下一个
  }
}
if (!srv) throw new Error('连续 10 个端口均被占用');

const { port } = srv.address();
const url = `http://127.0.0.1:${port}`;
console.log('┌─────────────────────────────────────────────┐');
console.log('│  🦙  Ollama Hub 已启动                        │');
console.log(`│  地址     ${url.padEnd(34)}│`);
console.log(`│  Ollama  ${UPSTREAM.padEnd(34)}│`);
console.log('│  停止服务：关闭本窗口 / Ctrl+C               │');
console.log('└─────────────────────────────────────────────┘');
if (autoOpen) openBrowser(url);
if (port !== wantPort) console.log(`提示: 默认端口 ${wantPort} 被占用，已改用 ${port}`);
