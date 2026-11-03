#!/usr/bin/env node
/**
 * SoulWeave 结构检查：模块级语句是否被误嵌进函数内
 *
 * 【为什么存在】
 * 本项目已连续 6 次因为「用相邻行做 splice 锚点」把代码插进错误的嵌套层级：
 *   1. _disposalQueue 字段       → 泄漏修复静默失效
 *   2. DISPOSAL_DELAY_FRAMES     → 同上
 *   3. window:control/state      → 窗口按钮全部失效
 *   4. Kokoro IPC 块             → 嵌进 piper handler
 *   5. warmupKokoro              → 找不到符号
 *   6. voice:config 块           → 同时导致多句连播/打断/配置读取三个缺陷
 *
 * 病根：只看插入位置的行，不验证插入后的括号层级。
 * 本脚本把「层级必须为 0」变成可执行断言。
 *
 * 用法: node scripts/check-structure.mjs [--json]
 * 退出码: 0 通过 / 1 有违规
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 用字符码避免源码里的转义/模板嵌套问题
const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);
const BT = String.fromCharCode(96);
const DQ = String.fromCharCode(34);
const SQ = String.fromCharCode(39);

/** 必须位于模块顶层的模式（括号深度 0） */
/**
 * 规则分级说明
 * ────────────
 * - ipcMain 注册：**必须 depth 0**。嵌进别的 handler 会导致「重复注册 / 未注册」，
 *   本项目 6 次事故里有 3 次是这个（window:control、Kokoro、voice:config）。
 * - app 生命周期：必须 depth 0。
 * - argv 自测块：**允许 depth <= 1**，因为它们正常就写在 app.whenReady().then(...) 回调里；
 *   但如果跑到 depth 2（嵌进了某个 handler），就是事故形态，必须报出来。
 */
const RULES = [
  { re: /^\s*ipcMain\.(handle|on)\s*\(/, label: 'ipcMain 注册', maxDepth: 0 },
  { re: /^\s*app\.whenReady\s*\(/, label: 'app.whenReady', maxDepth: 0 },
  // app.on(...) 正常写在 whenReady 回调内，允许 depth 1
  { re: /^\s*app\.on\s*\(/, label: 'app.on 事件', maxDepth: 1 },
  { re: /^\s*if\s*\(\s*argv\.includes\(/, label: 'argv 自测块', maxDepth: 1 },
];

/**
 * 逐字符扫描，返回每行的起始括号深度。
 * 需正确处理：行注释、块注释、单双引号、模板字符串（含插值）、正则字面量。
 * 处理不当时会把字符串里的括号当代码括号 —— 这正是人工检查容易误判的地方。
 */
function computeDepths(src) {
  const depths = [];
  let depth = 0;
  let i = 0;
  let line = 0;
  const n = src.length;
  const regexPrev = new Set('(,=:[!&|?{};+-*%<>~^');

  function atLineStart() {
    if (depths[line] === undefined) depths[line] = depth;
  }

  while (i < n) {
    const c = src[i];

    if (c === NL) { line++; i++; continue; }
    atLineStart();

    // 行注释
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== NL) i++;
      continue;
    }

    // 块注释
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === NL) line++;
        i++;
      }
      i += 2;
      continue;
    }

    // 单/双引号字符串
    if (c === DQ || c === SQ) {
      const q = c;
      i++;
      while (i < n) {
        if (src[i] === BS) { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        if (src[i] === NL) line++;
        i++;
      }
      continue;
    }

    // 模板字符串
    if (c === BT) {
      i++;
      while (i < n) {
        if (src[i] === BS) { i += 2; continue; }
        if (src[i] === BT) { i++; break; }
        if (src[i] === '$' && src[i + 1] === '{') {
          i += 2;
          let inner = 1;
          while (i < n && inner > 0) {
            const ch = src[i];
            if (ch === NL) { line++; i++; continue; }
            if (ch === DQ || ch === SQ) {
              const q2 = ch; i++;
              while (i < n) {
                if (src[i] === BS) { i += 2; continue; }
                if (src[i] === q2) { i++; break; }
                i++;
              }
              continue;
            }
            if (ch === '{') inner++;
            else if (ch === '}') inner--;
            i++;
          }
          continue;
        }
        if (src[i] === NL) line++;
        i++;
      }
      continue;
    }

    // 正则字面量
    if (c === '/') {
      let j = i - 1;
      while (j >= 0 && /\s/.test(src[j])) j--;
      const prev = j >= 0 ? src[j] : '';
      const isRegex = prev === '' || regexPrev.has(prev);
      if (isRegex) {
        i++;
        let inClass = false;
        while (i < n) {
          const ch = src[i];
          if (ch === BS) { i += 2; continue; }
          if (ch === NL) { line++; break; }
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) { i++; break; }
          i++;
        }
        while (i < n && /[a-z]/.test(src[i])) i++;
        continue;
      }
    }

    if (c === '{') depth++;
    else if (c === '}') depth = depth > 0 ? depth - 1 : 0;
    i++;
  }

  for (let k = 0; k < depths.length; k++) if (depths[k] === undefined) depths[k] = 0;
  return depths;
}

function checkFile(absPath) {
  const src = fs.readFileSync(absPath, 'utf8');
  const lines = src.split(NL);
  const depths = computeDepths(src);
  const bad = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (!text || !text.trim()) continue;
    for (const rule of RULES) {
      if (!rule.re.test(text)) continue;
      const d = depths[i] === undefined ? 0 : depths[i];
      if (d > rule.maxDepth) {
        bad.push({
          file: path.relative(ROOT, absPath),
          line: i + 1,
          depth: d,
          maxDepth: rule.maxDepth,
          label: rule.label,
          text: text.trim().slice(0, 100),
        });
      }
      break;
    }
  }
  return bad;
}

function targets() {
  const out = [];
  const mainDir = path.join(ROOT, 'src', 'main');
  if (fs.existsSync(mainDir)) {
    for (const f of fs.readdirSync(mainDir)) if (f.endsWith('.ts')) out.push(path.join(mainDir, f));
  }
  const pre = path.join(ROOT, 'src', 'preload', 'index.cjs');
  if (fs.existsSync(pre)) out.push(pre);
  return out;
}

/**
 * 自证测试：证明检查器**真的能抓到**违规。
 *
 * 一个永远返回「通过」的检查器等于没有检查。
 * 这里用一段合成的坏代码验证检测能力：
 *   - 正例（顶层）应通过
 *   - 反例（嵌在函数内）应被抓到
 */
function selfTest() {
  const goodSrc = [
    "ipcMain.handle('a:b', () => { return 1; });",
    "if (argv.includes('--x')) { doIt(); }",
  ].join(NL);
  const badSrc = [
    "ipcMain.handle('outer:x', async () => {",
    "  ipcMain.handle('inner:y', () => 1);",
    "  return 0;",
    "});",
  ].join(NL);

  const tmp = path.join(ROOT, 'scripts', '.structure-selftest.ts');
  try {
    fs.writeFileSync(tmp, goodSrc, 'utf8');
    const good = checkFile(tmp);
    fs.writeFileSync(tmp, badSrc, 'utf8');
    const bad = checkFile(tmp);

    const pass = good.length === 0 && bad.length === 1 && bad[0].depth === 1;
    console.log('[check-structure] 自证测试: ' + (pass ? 'OK' : 'FAIL') +
      '  (正例违规=' + good.length + ', 反例违规=' + bad.length + ')');
    return pass;
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  }
}

const files = targets();
const all = [];
for (const f of files) all.push(...checkFile(f));

if (process.argv.includes('--selftest')) {
  process.exit(selfTest() ? 0 : 1);
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: all.length === 0, checked: files.length, violations: all }, null, 2));
} else {
  console.log('[check-structure] 检查文件数: ' + files.length);
  if (all.length === 0) {
    console.log('[check-structure] OK 所有模块级语句都在顶层 (depth 0)');
  } else {
    console.log('[check-structure] FAIL 发现 ' + all.length + ' 处嵌套违规:');
    for (const v of all) {
      console.log('  ' + v.file + ':' + v.line + '  depth=' + v.depth + ' (上限 ' + v.maxDepth + ')  [' + v.label + ']');
      console.log('      ' + v.text);
    }
    console.log('');
    console.log('  说明：这些语句被误嵌进函数/块内部，模块加载时不会执行。');
  }
}

process.exit(all.length === 0 ? 0 : 1);
