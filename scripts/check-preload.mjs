#!/usr/bin/env node
/**
 * SoulWeave preload 覆盖检查
 *
 * 【为什么存在】
 * 渲染层大量使用 window.soulweave?.method?.() 这种**双可选调用**。
 * 方法不存在时它**静默什么都不做** —— 不报错不提示，
 * 表现就是「按钮点不动」这种极难排查的问题（S3-21 真实踩到）。
 *
 * 断言三件事：
 *   1. 渲染层调用的每个 soulweave 方法，preload 都导出了
 *   2. preload 导出的每个方法，主进程都注册了对应 channel
 *   3. 兼容两种写法：window.soulweave.x() 与 const api = window.soulweave; api.x()
 *
 * 用法: node scripts/check-preload.mjs [--json]
 * 退出码: 0 通过 / 1 有缺口
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'index.cjs'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8');

// ── preload 导出
// 分两部分：
//   exportedKeys  所有暴露给渲染层的 key（不管实现跨几行）
//   keyToChannel  能确定 channel 的（同一行里有 ipcRenderer.invoke/send/on）
// 早先只靠同一行匹配，导致 onThemeChanged 这种跨行定义被误判为「未导出」。
const exportedKeys = new Set();
for (const m of preloadSrc.matchAll(/^  (\w+):/gm)) exportedKeys.add(m[1]);

const keyToChannel = new Map();
for (const m of preloadSrc.matchAll(/^  (\w+):[^\n]*?ipcRenderer\.(?:invoke|send|on)\('([^']+)'/gm)) {
  keyToChannel.set(m[1], m[2]);
}

// ── 主进程注册的 channel
const channels = new Set();
for (const m of mainSrc.matchAll(/ipcMain\.(?:handle|on)\('([^']+)'/g)) channels.add(m[1]);

// ── 渲染层调用：支持 window.soulweave?.x?.( 与别名 api.x(
// 注意 ?.method?.() 里名字后面是 「?」「.」「(」 三个字符，
// 所以可选点必须单独写成 \.? —— 少了它就会漏掉所有双可选调用（本脚本第一版就错在这）。
const CALL_RE = /window\.soulweave\??\.(\w+)\??\.?\s*\(/g;
const ALIAS_RE = /(?:const|let|var)\s+(\w+)\s*=\s*window\.soulweave\b/g;
const used = new Map();

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    if (!/\.(js|ts)$/.test(e.name)) continue;
    if (e.name === 'api.js') continue; // 实现本身，不算调用方
    const t = fs.readFileSync(full, 'utf8');
    const note = (name) => {
      if (!used.has(name)) used.set(name, new Set());
      used.get(name).add(e.name);
    };
    for (const m of t.matchAll(CALL_RE)) note(m[1]);
    // S3-22：渲染层已统一改为 swCall('name', ...) / swOn('name', ...)
    for (const m of t.matchAll(/\bsw(?:Call|On)\('(\w+)'/g)) note(m[1]);
    // 别名：const api = window.soulweave  →  api.method(
    for (const a of t.matchAll(ALIAS_RE)) {
      const alias = a[1];
      const re = new RegExp('\\b' + alias + '\\??\\.(\\w+)\\??\\.?\\s*\\(', 'g');
      for (const m of t.matchAll(re)) note(m[1]);
    }
  }
}
walk(path.join(ROOT, 'src', 'renderer'));

// ── 禁用写法检查：双可选调用会掩盖缺失的方法（S3-21 事故成因）
const forbidden = [];
function scanForbidden(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { scanForbidden(full); continue; }
    if (!/\.(js|ts)$/.test(e.name)) continue;
    if (e.name === 'api.js') continue; // api.js 自己就是实现
    const t = fs.readFileSync(full, 'utf8');
    const lines = t.split('\n');
    lines.forEach((line, i) => {
      if (/window\.soulweave\?\.\w+\?\.\(/.test(line) || /\bapi\?\.\w+\?\.\(/.test(line)) {
        forbidden.push({ file: e.name, line: i + 1, text: line.trim().slice(0, 100) });
      }
    });
  }
}
scanForbidden(path.join(ROOT, 'src', 'renderer'));

// 检查：用了 swCall/swOn 却没从 api.js 导入
// S3-23 真实踩到：boot.js 加了 swOn 调用但没加 import，
// ReferenceError 被 try/catch 吞掉，表现为功能静默失效。
const missingImport = [];
function scanImports(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { scanImports(full); continue; }
    if (!/\.js$/.test(e.name)) continue;
    if (e.name === 'api.js') continue;
    const t = fs.readFileSync(full, 'utf8');
    if (!/\bsw(?:Call|On)\(/.test(t)) continue;
    if (!/from\s+['"][^'"]*api\.js['"]/.test(t)) missingImport.push({ file: e.name });
  }
}
scanImports(path.join(ROOT, 'src', 'renderer'));

const missingInPreload = [];
for (const [name, files] of used) {
  if (!exportedKeys.has(name)) missingInPreload.push({ name, files: [...files].sort() });
}

const missingInMain = [];
for (const [name, ch] of keyToChannel) {
  if (!channels.has(ch)) missingInMain.push({ name, channel: ch });
}

missingInPreload.sort((a, b) => a.name.localeCompare(b.name));
const ok = missingInPreload.length === 0 && missingInMain.length === 0 && forbidden.length === 0 && missingImport.length === 0;

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok, exported: exportedKeys.size, channels: channels.size, used: used.size, missingInPreload, missingInMain, forbidden }, null, 2));
} else {
  console.log('[check-preload] preload 导出 ' + exportedKeys.size + ' 个 · 主进程注册 ' + channels.size + ' 个 · 渲染层调用 ' + used.size + ' 个');
  if (missingInPreload.length) {
    console.log('[check-preload] FAIL 渲染层调用了但 preload 没导出（调用会静默失效）：');
    for (const x of missingInPreload) console.log('    ' + x.name + '   ← ' + x.files.join(', '));
  }
  if (missingInMain.length) {
    console.log('[check-preload] FAIL preload 暴露了但主进程没注册（调用会 reject）：');
    for (const x of missingInMain) console.log('    ' + x.name + ' → ' + x.channel);
  }
  if (forbidden.length) {
    console.log('[check-preload] FAIL 存在双可选调用（会掩盖方法缺失，请改用 swCall/swOn）：');
    for (const x of forbidden) console.log('    ' + x.file + ':' + x.line + '  ' + x.text);
  }
  if (missingImport.length) {
    console.log('[check-preload] FAIL 用了 swCall/swOn 却没 import（会抛 ReferenceError）：');
    for (const x of missingImport) console.log('    ' + x.file);
  }
  if (ok) console.log('[check-preload] OK 三方对齐，无隐藏失败写法，import 完整');
}

process.exit(ok ? 0 : 1);
