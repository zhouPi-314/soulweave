#!/usr/bin/env node
/**
 * D57.15 / D57.18：官网上线前的发布门禁
 *
 * 站点是公开的，所以"别把不该公开的东西传上去"必须由脚本守，而不是靠记性。
 * 检查四类问题：
 *   1. 不该进站点的文件类型（安装包、二进制、数据库、源码包）
 *   2. 体积超限（> 8 MB 的东西几乎一定不该出现在静态站）
 *   3. 私人信息（本机路径、用户名、口令、令牌）
 *   4. 隐私红线（第三方脚本、统计 SDK、Cookie 追踪）
 *
 * 用法：node scripts/publish-gate.mjs ../03_delivery/website
 * 退出码 0 = 可以发布；1 = 有阻塞项。
 */
import fs from 'node:fs';
import path from 'node:path';

const target = path.resolve(process.argv[2] || '../03_delivery/website');
const MAX_BYTES = 8 * 1024 * 1024;
const BAD_EXT = new Set(['.exe', '.msi', '.dll', '.node', '.pdb', '.zip', '.7z', '.rar', '.sqlite', '.db', '.pgdump', '.asar']);
const BAD_PATTERNS = [
  { re: /[A-Za-z]:\\SoulWeave/i, why: '本机工程路径' },
  { re: /C:\\Users\\[A-Za-z0-9_-]+/i, why: '本机用户目录路径' },
  ...(process.env.USERNAME && process.env.USERNAME !== 'unknown'
    ? [{ re: new RegExp('\\b' + process.env.USERNAME + '\\b', 'i'), why: '本机用户名' }]
    : []),
  { re: /PaaAdmin/i, why: '数据库口令' },
  { re: /\bsk-[A-Za-z0-9]{16,}/, why: 'API Key' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/, why: 'GitHub Token' },
  { re: /\.runtime-userdata/i, why: '运行时私有数据目录' },
  { re: /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/, why: '私钥' },
];
const PRIVACY = [
  { re: /<script[^>]+src=["']https?:\/\//i, why: '第三方脚本' },
  { re: /googletagmanager|google-analytics|gtag\(|hm\.baidu|cnzz|clarity\.ms|hotjar/i, why: '统计/追踪代码' },
  { re: /document\.cookie\s*=/i, why: '写 Cookie' },
];

const TEXT_EXT = new Set(['.html', '.css', '.js', '.json', '.md', '.txt', '.svg', '.xml', '.yml', '.yaml']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(f, out);
    } else out.push(f);
  }
  return out;
}

if (!fs.existsSync(target)) {
  console.error('✗ 目录不存在：' + target);
  process.exit(1);
}

const files = walk(target);
const blockers = [];
const warnings = [];
let total = 0;

for (const f of files) {
  const rel = path.relative(target, f).replace(/\\/g, '/');
  const ext = path.extname(f).toLowerCase();
  const st = fs.statSync(f);
  total += st.size;

  if (BAD_EXT.has(ext)) blockers.push({ file: rel, why: '禁止发布的文件类型 ' + ext });
  if (st.size > MAX_BYTES) blockers.push({ file: rel, why: '文件过大（' + (st.size / 1048576).toFixed(1) + ' MB）' });

  if (!TEXT_EXT.has(ext)) continue;
  const text = fs.readFileSync(f, 'utf8');
  for (const p of BAD_PATTERNS) if (p.re.test(text)) blockers.push({ file: rel, why: p.why });
  for (const p of PRIVACY) if (p.re.test(text)) blockers.push({ file: rel, why: p.why });
  // 站外相对引用（会把站点绑死在某个路径上）
  if (ext === '.html' && /src="https?:\/\//i.test(text) && !/<script[^>]+src=["']https?:\/\//i.test(text)) {
    warnings.push({ file: rel, why: '页面引用了外部资源' });
  }
}

const report = {
  at: new Date().toISOString(),
  target,
  files: files.length,
  totalBytes: total,
  blockers,
  warnings,
};
const outFile = path.resolve('docs', 'S12-UI-Redesign', '30-D57-发布门禁报告.json');
try { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8'); } catch (e) { /* ignore */ }

console.log('[publish-gate] ' + target);
console.log('  文件 ' + files.length + ' 个，共 ' + (total / 1048576).toFixed(2) + ' MB');
for (const w of warnings) console.log('  warn  ' + w.file + ' — ' + w.why);
if (blockers.length) {
  for (const b of blockers) console.log('  BLOCK ' + b.file + ' — ' + b.why);
  console.log('[publish-gate] FAIL：' + blockers.length + ' 项阻塞');
  process.exit(1);
}
console.log('[publish-gate] PASS（警告 ' + warnings.length + ' 项）');
