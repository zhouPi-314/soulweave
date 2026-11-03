#!/usr/bin/env node
/**
 * 下载并校验 NapCat（D59.02 / 内置协议端）
 *
 * 为什么固定版本：NapCat 的许可要求"随附完整许可文本 + 来源"，
 * 随便跟最新版会让"我们分发的是哪个版本、对应哪份许可"变得不可追溯。
 *
 * 用法：
 *   node scripts/fetch-napcat.mjs --variant full   # NapCat.Shell.Windows.Node.zip（118 MB）
 *   node scripts/fetch-napcat.mjs --variant shell  # NapCat.Shell.zip（34 MB）
 *   node scripts/fetch-napcat.mjs --variant full --print  # 只打印将要做什么
 *
 * 产物：resources/napcat/{...}，以及 resources/napcat/version.json
 * 注意：本脚本不修改 NapCat 代码（许可条款 2：修改版不得公开发布）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const VERSION = 'v4.18.42';
const ASSETS = {
  full: { file: 'NapCat.Shell.Windows.Node.zip', bytes: 118_400_000 },
  shell: { file: 'NapCat.Shell.zip', bytes: 34_300_000 },
};
const args = process.argv.slice(2);
const variant = args.includes('--variant') ? args[args.indexOf('--variant') + 1] : 'full';
const printOnly = args.includes('--print');

if (!ASSETS[variant]) { console.error('✗ --variant 只能是 full / shell'); process.exit(1); }
const asset = ASSETS[variant];
const url = 'https://github.com/NapNeko/NapCatQQ/releases/download/' + VERSION + '/' + asset.file;
const destDir = path.join(ROOT, 'resources', 'napcat');
const zipPath = path.join(destDir, asset.file);

console.log('[napcat] 版本 ' + VERSION + ' · ' + asset.file + ' · 约 ' + (asset.bytes / 1048576).toFixed(0) + ' MB');
console.log('[napcat] 来源 ' + url);
console.log('[napcat] 落点 ' + path.relative(ROOT, destDir));
console.log('[napcat] 许可：Limited Redistribution License（非商业；须附全文与署名）');
if (printOnly) { console.log('[napcat] --print 模式，未下载'); process.exit(0); }

fs.mkdirSync(destDir, { recursive: true });
if (!fs.existsSync(zipPath)) {
  console.log('[napcat] 下载中…');
  execFileSync(process.platform === 'win32' ? 'curl.exe' : 'curl', ['-L', '--fail', '-o', zipPath, url], { stdio: 'inherit' });
} else {
  console.log('[napcat] 已存在，跳过下载');
}

const h = crypto.createHash('sha256');
h.update(fs.readFileSync(zipPath));
const sha = h.digest('hex');
console.log('[napcat] sha256 ' + sha);

// 解压（Windows 自带 tar 可解 zip；失败则提示手动）
try {
  execFileSync('tar', ['-xf', zipPath, '-C', destDir], { stdio: 'inherit' });
  console.log('[napcat] 已解压');
} catch (e) {
  console.error('[napcat] 解压失败，请手动解压到 ' + destDir);
  process.exit(1);
}

fs.writeFileSync(path.join(destDir, 'version.json'), JSON.stringify({
  name: 'NapCat', version: VERSION, asset: asset.file, sha256: sha,
  license: 'Limited Redistribution License for NapCat',
  licenseFile: 'third_party/napcat/LICENSE-napcat.txt',
  source: 'https://github.com/NapNeko/NapCatQQ',
  fetchedAt: new Date().toISOString(),
  note: '非商业用途；须随包附许可全文与署名；不得公开分发修改版。',
}, null, 2), 'utf8');
console.log('[napcat] version.json 已写入');
