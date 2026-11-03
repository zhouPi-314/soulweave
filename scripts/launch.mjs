#!/usr/bin/env node
/**
 * SoulWeave 一键启动器
 *
 * 做的事：
 *   1. 检查依赖是否装好
 *   2. 判断源码是否比构建产物新 —— 只有真的改了才重新构建
 *   3. 清掉 ELECTRON_RUN_AS_NODE（这个环境变量会让 Electron 变成纯 Node，窗口起不来）
 *   4. 启动 Electron
 *
 * 参数：
 *   --rebuild   强制重新构建
 *   --dev       打开开发者工具
 *   --silent    不输出构建日志（给无窗口启动用）
 *   --wait      前台运行并等待退出（给命令行用）
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 说明：ROOT 由脚本自身位置推导，所以从任何目录执行本脚本都能正确定位项目。
// 但 `npm start` 只读当前目录的 package.json，在别处执行会报错 —— 这是 npm 的行为，与本脚本无关。
// 下面的检查是最后一道保险：万一本脚本被复制到别处，也别静默失败。
if (!fs.existsSync(path.join(ROOT, 'package.json'))) {
  console.error('');
  console.error('  [启动失败] 定位不到项目根目录：' + ROOT);
  console.error('  请使用项目内的「start-SoulWeave.cmd」。');
  console.error('');
  process.exit(1);
}
const argv = process.argv.slice(2);
const FORCE = argv.includes('--rebuild');
const DEVTOOLS = argv.includes('--dev');
const SILENT = argv.includes('--silent');
const WAIT = argv.includes('--wait');

function say(msg) { if (!SILENT) console.log(msg); }
function die(msg) {
  console.error('');
  console.error('  [启动失败] ' + msg);
  console.error('');
  process.exit(1);
}

// ── 1. 依赖检查 ──────────────────────────────
const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(electronExe)) {
  die('找不到 Electron。请先在项目目录运行：npm install');
}

// ── 2. 判断是否需要构建 ──────────────────────
const distMain = path.join(ROOT, 'dist', 'main', 'index.js');
const distIndex = path.join(ROOT, 'dist', 'renderer', 'index.html');
const distSettings = path.join(ROOT, 'dist', 'renderer', 'settings.html');

function newestMtime(dir, filter) {
  let newest = 0;
  if (!fs.existsSync(dir)) return newest;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (filter && !filter(e.name)) continue;
      try { const st = fs.statSync(full); if (st.mtimeMs > newest) newest = st.mtimeMs; } catch (err) { /* ignore */ }
    }
  }
  return newest;
}

const srcNewest = Math.max(
  newestMtime(path.join(ROOT, 'src'), (n) => /\.(ts|js|cjs|mjs|html|css)$/.test(n)),
  fs.existsSync(path.join(ROOT, 'vite.config.ts')) ? fs.statSync(path.join(ROOT, 'vite.config.ts')).mtimeMs : 0,
  fs.existsSync(path.join(ROOT, 'package.json')) ? fs.statSync(path.join(ROOT, 'package.json')).mtimeMs : 0
);

const outputs = [distMain, distIndex, distSettings];
const missing = outputs.filter((f) => !fs.existsSync(f));
const distOldest = outputs.filter((f) => fs.existsSync(f)).reduce((min, f) => {
  const t = fs.statSync(f).mtimeMs;
  return min === 0 ? t : Math.min(min, t);
}, 0);

const needBuild = FORCE || missing.length > 0 || (distOldest > 0 && srcNewest > distOldest);

if (needBuild) {
  if (missing.length) say('[构建] 缺少产物：' + missing.map((f) => path.relative(ROOT, f)).join(', '));
  else if (FORCE) say('[构建] 强制重新构建');
  else say('[构建] 源码有更新，重新构建…');

  // Windows 下 npm 是 npm.cmd，必须 shell:true 或显式 .cmd
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npmCmd, ['run', 'build'], {
    cwd: ROOT, stdio: SILENT ? 'ignore' : 'inherit', shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    die('构建失败（退出码 ' + r.status + '）。请在上面的输出里查找错误。');
  }
  say('[构建] 完成');
} else {
  say('[构建] 产物是最新的，跳过');
}

// ── 3. 启动 Electron ─────────────────────────
// ELECTRON_RUN_AS_NODE 会让 electron.exe 以纯 Node 模式运行，不创建窗口。
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// 把 TEMP/TMP 固定到项目内，避免构建时在别处散落临时文件（曾把临时文件散落到项目外）
const tmpDir = path.join(ROOT, '.tmp');
try { fs.mkdirSync(tmpDir, { recursive: true }); env.TEMP = tmpDir; env.TMP = tmpDir; } catch (e) { /* ignore */ }
if (DEVTOOLS) env.SOULWEAVE_DEVTOOLS = '1';

say('[启动] SoulWeave…');

// 关键：分离模式下必须用 ignore。
// 用 inherit 时子进程会持有父进程的 stdout 管道，调用方（如 PowerShell）会一直等，
// 表现为「启动器卡住不返回」——已实测踩到。
const child = spawn(electronExe, ['.'], {
  cwd: ROOT,
  env,
  stdio: WAIT ? 'inherit' : 'ignore',
  detached: !WAIT,
  windowsHide: !WAIT,
});

child.on('error', (e) => die('无法启动 Electron：' + String(e)));

if (WAIT) {
  child.on('exit', (code) => process.exit(code === null ? 1 : code));
} else {
  // 分离运行：启动器立即退出，应用继续活着
  child.unref();
  say('[启动] 已拉起，本窗口可以关闭');
  setTimeout(() => process.exit(0), 300);
}
