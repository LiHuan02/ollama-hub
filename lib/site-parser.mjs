/** ollama.com 页面解析与列表元数据标准化（Web 服务/扩展共享）。 */
export function decodeEntities(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0*39;|&#x0*27;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d));
}
export const stripTags = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

export function parseCompactNumber(value) {
  const m = String(value || '').trim().match(/^([\d.]+)\s*([KMB])?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1));
}

/** 将官网的 “2 days ago / 1 year ago / just now” 转成可比较时间。 */
export function parseRelativeTime(value, now = Date.now()) {
  const text = String(value || '').trim().toLowerCase();
  if (!text || text === 'never') return null;
  if (/just now|moments? ago/.test(text)) return new Date(now).toISOString();
  const m = text.match(/(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago/);
  if (!m) return null;
  const n = Number(m[1]);
  const ms = { minute: 60e3, hour: 36e5, day: 864e5, week: 6048e5, month: 26298e5, year: 315576e5 }[m[2]];
  return new Date(now - n * ms).toISOString();
}

export function parseSizeBytes(value) {
  const m = String(value || '').trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? Math.round(n * ({ B: 1, KB: 2 ** 10, MB: 2 ** 20, GB: 2 ** 30, TB: 2 ** 40 }[m[2].toUpperCase()])) : null;
}

const isModelPath = (href) => /^\/library\/[A-Za-z0-9._-]+$/.test(href) || /^\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(href);

export function parseListPage(html, now = Date.now()) {
  const items = [];
  const liRe = /<li[^>]*>\s*<a href="([^"]+)" class="group w-full[^"]*">([\s\S]*?)<\/li>/g;
  let m;
  while ((m = liRe.exec(html))) {
    const href = m[1];
    if (!isModelPath(href)) continue;
    const source = href.startsWith('/library/') ? 'official' : 'community';
    const name = decodeEntities(href.replace(/^\/(?:library\/)?/, ''));
    const block = m[2];
    const desc = block.match(/<p class="max-w-lg[^"]*">([\s\S]*?)<\/p>/);
    const caps = [...block.matchAll(/class="[^"]*bg-indigo-50[^"]*"[^>]*>([^<]+)<\/span>/g)].map((x) => x[1].trim());
    const variants = [...block.matchAll(/class="[^"]*bg-\[#ddf4ff\][^"]*"[^>]*>([^<]+)<\/span>/g)].map((x) => x[1].trim());
    const pulls = block.match(/<span[^>]*>([^<]+)<\/span>\s*<span class="hidden sm:flex">&nbsp;Pulls<\/span>/);
    const tags = block.match(/<span[^>]*>([^<]+)<\/span>\s*<span class="hidden sm:flex">&nbsp;Tags?<\/span>/);
    const updated = block.match(/Updated(?:&nbsp;)?<\/span>\s*<span[^>]*>([^<]+)<\/span>/);
    const pullsRaw = pulls ? pulls[1].trim() : '';
    const updatedRaw = updated ? updated[1].trim() : '';
    items.push({
      name, href, source,
      description: desc ? decodeEntities(stripTags(desc[1])) : '',
      capabilities: caps, variants, pulls: pullsRaw, pullsRaw, pullsCount: parseCompactNumber(pullsRaw),
      tagCount: tags ? tags[1].trim() : '', updated: updatedRaw, updatedRaw,
      updatedAt: parseRelativeTime(updatedRaw, now), fetchedAt: new Date(now).toISOString(),
    });
  }
  return items;
}

export function parseTagsPage(html, name, now = Date.now()) {
  const capabilities = [...html.matchAll(/class="[^"]*bg-indigo-50[^"]*"[^>]*>([^<]+)<\/span>/g)].slice(0, 12).map((x) => x[1].trim());
  const variants = [...html.matchAll(/class="[^"]*bg-\[#ddf4ff\][^"]*"[^>]*>([^<]+)<\/span>/g)].slice(0, 30).map((x) => x[1].trim());
  const tags = [];
  for (const b of html.split(/<div class="group px-4 py-3">/).slice(1)) {
    const val = b.match(/<input class="command hidden" value="([^"]+)"/);
    if (!val) continue;
    const cols = [...b.matchAll(/<p class="col-span-2 text-neutral-500 text-\[13px\]">\s*([^<]*?)\s*<\/p>/g)].map((x) => x[1]);
    const digest = b.match(/font-mono[^>]*>([0-9a-f]{12})</);
    const updated = b.match(/·&nbsp;([^<]+)</);
    const input = b.match(/<div class="col-span-2 text-neutral-500 text-\[13px\]\s*">([\s\S]*?)<\/div>/);
    const full = decodeEntities(val[1]);
    const size = cols[0] || '';
    const updatedRaw = updated ? updated[1].trim() : '';
    tags.push({ tag: full.startsWith(name + ':') ? full.slice(name.length + 1) : full, model: full,
      size, sizeBytes: parseSizeBytes(size), context: cols[1] || '', input: input ? stripTags(input[1]) : '',
      digest: digest ? digest[1] : '', updated: updatedRaw, updatedRaw, updatedAt: parseRelativeTime(updatedRaw, now) });
  }
  return { name, capabilities, variants, tags };
}
