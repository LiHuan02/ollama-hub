#!/usr/bin/env node
/**
 * 同步共享文件到扩展目录（extension/ 里这两份是构建产物）：
 *   public/index.html      → extension/index.html
 *   lib/site-parser.mjs    → extension/lib/site-parser.mjs
 * 修改源文件后重新运行：node tools/build-extension.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const jobs = [
  ['public/index.html', 'extension/index.html'],
  ['lib/site-parser.mjs', 'extension/lib/site-parser.mjs'],
];
for (const [src, dst] of jobs) {
  const to = path.join(root, dst);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(root, src), to);
  console.log(`✓ ${src} → ${dst}`);
}
