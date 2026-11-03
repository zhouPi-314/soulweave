#!/usr/bin/env node
/**
 * D59.04 / D59.05：依赖许可审计 → SBOM + THIRD-PARTY-LICENSES
 *
 * 输出三样东西：
 *   1. docs/licensing/SBOM.json      —— 机器可读（名字/版本/许可/来源/是否随包分发）
 *   2. THIRD-PARTY-LICENSES.md       —— 随安装包分发的人类可读清单
 *   3. 控制台风险摘要                 —— 高 copyleft / 无许可 / 未知，退出码非 0 表示有阻塞
 *
 * 判定规则（写死在代码里，避免"这次算了吧"）：
 *   · AGPL / SSPL / GPL 系 → 阻塞（闭源分发不兼容）
 *   · UNKNOWN / UNLICENSED → 阻塞（不能分发没有许可的代码）
 *   · LGPL / MPL / EPL / CDDL → 警告（可分发但有义务，需在 NOTICE 里保留）
 *   · 其余（MIT/ISC/Apache/BSD/0BSD/CC0/BlueOak 等）→ 通过
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lockFile = path.join(ROOT, 'package-lock.json');
if (!fs.existsSync(lockFile)) { console.error('✗ 缺少 package-lock.json'); process.exit(1); }
const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));

function licenseOf(name, entry) {
  if (entry.license) return String(entry.license);
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8'));
    if (pj.license) return String(pj.license);
    if (Array.isArray(pj.licenses)) return pj.licenses.map((x) => x.type || x).join(' OR ');
  } catch (e) { /* ignore */ }
  return 'UNKNOWN';
}

const BLOCK = /(^|[^A-Z])(A?GPL|SSPL)/i;
const WARN = /(LGPL|MPL|EPL|CDDL|EUPL|OSL|CPL)/i;
const OK = /^(MIT|ISC|BSD-2-Clause|BSD-3-Clause|0BSD|Apache-2\.0|CC0-1\.0|BlueOak-1\.0\.0|WTFPL|Python-2\.0|Unlicense|Zlib|BlueOak)/i;

const components = [];
const blockers = [];
const warnings = [];
for (const [key, entry] of Object.entries(lock.packages || {})) {
  if (!key.startsWith('node_modules/')) continue;
  const name = key.replace(/^node_modules\//, '');
  const license = licenseOf(name, entry);
  // 表达式（"MIT OR CC0-1.0"）按"任一分支可接受即可"判定：双许可意味着可以选宽松的那个
  const parts = license.replace(/[()]/g, '').split(/\s+(?:OR|AND)\s+/i).map((x) => x.trim()).filter(Boolean);
  const anyOk = parts.some((p) => OK.test(p));
  const anyWarn = parts.some((p) => WARN.test(p));
  const kind = BLOCK.test(license) && !anyOk ? 'block'
    : (parts.every((p) => /UNKNOWN|UNLICENSED/i.test(p))) ? 'block'
    : anyOk ? 'ok' : anyWarn ? 'warn' : 'warn';
  const c = {
    name, version: entry.version || '',
    license,
    dev: !!entry.dev,
    // 随安装包分发的是生产依赖；devDep 不进包，但仍记录以便审计
    distributed: !entry.dev,
    risk: kind,
  };
  components.push(c);
  if (c.risk === 'block') blockers.push(c);
  else if (c.risk === 'warn') warnings.push(c);
}

components.sort((a, b) => a.name.localeCompare(b.name));

const sbom = {
  schema: 'soulweave-sbom/1',
  generatedAt: new Date().toISOString(),
  application: { name: pkg.name, version: pkg.version, license: 'PENDING (D59.01)' },
  runtime: { electron: (pkg.devDependencies || {}).electron, node: process.version },
  summary: {
    total: components.length,
    distributed: components.filter((c) => c.distributed).length,
    block: blockers.length,
    warn: warnings.length,
  },
  components,
};
const outDir = path.join(ROOT, 'docs', 'licensing');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'SBOM.json'), JSON.stringify(sbom, null, 2), 'utf8');

const lines = [];
lines.push('# 第三方许可清单（随安装包分发）');
lines.push('');
lines.push('> 由 `npm run license:audit` 生成，**不要手改**。生成时间：' + sbom.generatedAt);
lines.push('>');
lines.push('> 应用自身许可证：待定（D59.01，需用户批准）。');
lines.push('');
lines.push('共 ' + components.length + ' 个包，其中随包分发 ' + sbom.summary.distributed + ' 个；阻塞项 ' + blockers.length + '，需注意 ' + warnings.length + '。');
lines.push('');
lines.push('## 随包分发的依赖');
lines.push('');
lines.push('| 包 | 版本 | 许可 |');
lines.push('|---|---|---|');
for (const c of components.filter((x) => x.distributed)) lines.push('| ' + c.name + ' | ' + c.version + ' | ' + c.license + ' |');
lines.push('');
lines.push('## 仅开发期使用（不随包分发）');
lines.push('');
lines.push('| 包 | 版本 | 许可 |');
lines.push('|---|---|---|');
for (const c of components.filter((x) => !x.distributed)) lines.push('| ' + c.name + ' | ' + c.version + ' | ' + c.license + ' |');
lines.push('');
lines.push('## 需要人工确认的条目');
lines.push('');
if (!warnings.length && !blockers.length) lines.push('无。');
for (const c of blockers) lines.push('- **阻塞**：' + c.name + '@' + c.version + ' → ' + c.license);
for (const c of warnings) lines.push('- 注意：' + c.name + '@' + c.version + ' → ' + c.license);
fs.writeFileSync(path.join(ROOT, 'THIRD-PARTY-LICENSES.md'), lines.join('\n') + '\n', 'utf8');

console.log('[license-audit] ' + components.length + ' 个包（随包分发 ' + sbom.summary.distributed + '）');
for (const c of blockers) console.log('  BLOCK ' + c.name + '@' + c.version + ' — ' + c.license);
for (const c of warnings) console.log('  warn  ' + c.name + '@' + c.version + ' — ' + c.license);
console.log('[license-audit] SBOM → docs/licensing/SBOM.json，清单 → THIRD-PARTY-LICENSES.md');
if (blockers.length) { console.log('[license-audit] FAIL：' + blockers.length + ' 个阻塞项'); process.exit(1); }
console.log('[license-audit] PASS（警告 ' + warnings.length + ' 项）');
