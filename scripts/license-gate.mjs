#!/usr/bin/env node
/**
 * D59.06 / D59.07：发行前的许可门禁
 *
 * 规则只有一条：**素材没有书面授权，就不许公开发行。**
 * 判断依据是 docs/licensing/assets.json（素材清单）+ docs/licensing/approvals.json（批准台账），
 * 不是"我觉得应该没问题"。
 *
 * 退出码 0 = 可以发布；1 = 有未批准项。
 * 用法：node scripts/license-gate.mjs [--report]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const dir = path.join(ROOT, 'docs', 'licensing');
const assetsFile = path.join(dir, 'assets.json');
const approvalsFile = path.join(dir, 'approvals.json');

for (const f of [assetsFile, approvalsFile]) {
  if (!fs.existsSync(f)) {
    console.error('✗ 缺少 ' + path.relative(ROOT, f) + '（先跑 npm run license:audit）');
    process.exit(1);
  }
}

const assets = JSON.parse(fs.readFileSync(assetsFile, 'utf8'));
const approvals = JSON.parse(fs.readFileSync(approvalsFile, 'utf8'));
const byId = new Map();
for (const a of approvals.items || []) byId.set(a.id, a);

const results = [];
for (const it of assets.items || []) {
  let status = 'ok';
  let reason = '';
  if (it.redistributable === 'yes') { status = 'ok'; reason = '许可允许再分发'; }
  else if (it.redistributable === 'no') { status = 'ok'; reason = '不随发行版分发'; }
  else {
    const ap = byId.get(it.id);
    if (ap && ap.approved && ap.approvedBy && ap.evidence) {
      status = 'approved';
      reason = '已由 ' + ap.approvedBy + ' 于 ' + ap.approvedAt + ' 批准';
    } else {
      status = 'block';
      reason = it.redistributable === 'pending' ? '来源/授权未确认' : '需附许可条款但尚未确认已附';
    }
  }
  results.push({ id: it.id, name: it.name, license: it.license, status, reason });
}

const blockers = results.filter((r) => r.status === 'block');
const approved = results.filter((r) => r.status === 'approved');
console.log('[license-gate] 素材 ' + results.length + ' 项：通过 ' + (results.length - blockers.length) + '，已批准 ' + approved.length + '，阻塞 ' + blockers.length);
for (const b of blockers) console.log('  BLOCK ' + b.id + '（' + b.name + '）— ' + b.reason + '｜许可：' + b.license);

if (process.argv.includes('--report')) {
  const out = { at: new Date().toISOString(), results, blockers: blockers.length };
  fs.writeFileSync(path.join(dir, 'gate-report.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log('[license-gate] 报告 → docs/licensing/gate-report.json');
}

if (blockers.length) {
  console.log('[license-gate] FAIL：按 D59.07，存在未授权素材时不得公开发行。');
  process.exit(1);
}
console.log('[license-gate] PASS');
