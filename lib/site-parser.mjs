/**
 * ollama.com 页面解析器 — 被 node 服务与浏览器扩展共享
 * 解析搜索/模型库列表页与模型版本(tags)页，官网改版时只需调整此文件。
 */

export function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x0*27;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d));
}

export const stripTags = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** 模型链接形如 /library/name 或 /owner/name(社区模型) */
const isModelPath = (href) =>
  /^\/library\/[A-Za-z0-9._-]+$/.test(href) ||
  /^\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(href);

/** 解析搜索页 / 模型库列表页中每个 <li> 结果卡片 */
export function parseListPage(html) {
  const items = [];
  const liRe = /<li[^>]*>\s*<a href="([^"]+)" class="group w-full[^"]*">([\s\S]*?)<\/li>/g;
  let m;
  while ((m = liRe.exec(html))) {
    if (!isModelPath(m[1])) continue;
    const name = decodeEntities(m[1].replace(/^\/(?:library\/)?/, ''));
    const block = m[2];
    const desc = block.match(/<p class="max-w-lg[^"]*">([\s\S]*?)<\/p>/);
    const caps = [...block.matchAll(/class="[^"]*bg-indigo-50[^"]*"[^>]*>([^<]+)<\/span>/g)].map((x) => x[1].trim());
    const variants = [...block.matchAll(/class="[^"]*bg-\[#ddf4ff\][^"]*"[^>]*>([^<]+)<\/span>/g)].map((x) => x[1].trim());
    const pulls = block.match(/<span[^>]*>([^<]+)<\/span>\s*<span class="hidden sm:flex">&nbsp;Pulls<\/span>/);
    const tags = block.match(/<span[^>]*>([^<]+)<\/span>\s*<span class="hidden sm:flex">&nbsp;Tags?<\/span>/);
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
export function parseTagsPage(html, name) {
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
