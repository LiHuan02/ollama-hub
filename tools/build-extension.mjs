#!/usr/bin/env node
/** 同步共享 UI/解析器到 MV3 扩展目录。extension/ 中的 app.js、index.html、parser 为构建产物。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const jobs = [
  ['public/index.html', 'extension/index.html'],
  ['public/app.js', 'extension/app.js'],
  ['lib/site-parser.mjs', 'extension/lib/site-parser.mjs'],
];
for (const [src, dst] of jobs) {
  const to = path.join(root, dst);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(root, src), to);
  console.log(`✓ ${src} → ${dst}`);
}
