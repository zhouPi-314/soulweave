/* 把 announcements/*.md 编译成 announcements.json
   约束：只支持极小子集（frontmatter 的 date/level/title + 纯文本正文），
   这是刻意的 —— 公告不需要富文本，而富文本是 XSS 的主要入口。 */
import fs from 'node:fs';
import path from 'node:path';

const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''));
const src = path.join(dir, 'announcements');
const files = fs.readdirSync(src).filter((f) => f.endsWith('.md')).sort().reverse();

const items = files.map((f) => {
  const raw = fs.readFileSync(path.join(src, f), 'utf8');
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!m) throw new Error('缺少 frontmatter：' + f);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return {
    date: meta.date || '',
    level: ['dev', 'fix', 'release', 'notice'].includes(meta.level) ? meta.level : 'notice',
    title: meta.title || f,
    body: m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    ...(meta.url ? { url: meta.url } : {}),
  };
});

const out = { updatedAt: new Date().toISOString().slice(0, 10), items };
fs.writeFileSync(path.join(dir, 'announcements.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log('announcements.json ← ' + items.length + ' 篇');
