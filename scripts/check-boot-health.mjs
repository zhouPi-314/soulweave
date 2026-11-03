/**
 * 启动健康检查：确认"应用启动了，而且启动过程中没有报错"。
 *
 * 【为什么需要这个】
 * S12 期间有两个真实缺陷都是"跑起来才暴露"的：
 *   - `pj is not defined`（打开设置就抛，页面看不出来）
 *   - `stopAllMotions`（主窗口启动抛，白屏风险）
 * 单元测试全部是绿的，因为没人把它们跑起来。
 * 这个脚本补的就是这一段：真的启动 Electron，连 CDP，读异常。
 *
 * 用法：
 *   node scripts/check-boot-health.mjs                # 自己拉起一个实例
 *   node scripts/check-boot-health.mjs --port 9333    # 连已在跑的实例
 *
 * 退出码：0 = 通过；1 = 有异常/窗口没起来。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(arg('--port', 0)) || (9300 + Math.floor(Math.random() * 400));
const OWN = !arg('--port', null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  try {
    const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
    return await r.json();
  } catch { return null; }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pend = new Map();
    const events = [];
    ws.on('open', () => resolve({
      events,
      send(method, params) {
        return new Promise((ok, bad) => {
          const i = ++id;
          pend.set(i, { ok, bad });
          ws.send(JSON.stringify({ id: i, method, params: params || {} }));
        });
      },
      close() { try { ws.close(); } catch {} },
    }));
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.id && pend.has(m.id)) {
        const { ok, bad } = pend.get(m.id);
        pend.delete(m.id);
        if (m.error) bad(new Error(JSON.stringify(m.error))); else ok(m.result);
      } else if (m.method) events.push(m);
    });
    ws.on('error', reject);
  });
}

const exceptions = (conn) => conn.events
  .filter((e) => e.method === 'Runtime.exceptionThrown')
  .map((e) => {
    const d = e.params.exceptionDetails || {};
    const desc = String((d.exception || {}).description || '').split('\n')[0];
    return (String(d.text || '') + ' | ' + desc).trim();
  });

let child = null;
let failures = [];

function fail(msg) { failures.push(msg); console.log('  FAIL  ' + msg); }
function pass(msg) { console.log('  ok    ' + msg); }

async function main() {
  console.log('[boot-health] 端口 ' + PORT + (OWN ? '（自启实例）' : '（连已有实例）'));

  if (OWN) {
    const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
    if (!fs.existsSync(exe)) { console.log('[boot-health] 找不到 electron.exe，跳过'); process.exit(0); }
    const tmp = path.join(ROOT, '..', '..', '08_temp', 'tmp');
    child = spawn(exe, ['.', '--remote-debugging-port=' + PORT], {
      cwd: ROOT,
      env: { ...process.env, TEMP: tmp, TMP: tmp, ELECTRON_RUN_AS_NODE: undefined },
      stdio: 'ignore',
      detached: false,
    });
  }

  let list = null;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    list = await targets();
    if (list && list.length) break;
  }
  if (!list || !list.length) { console.log('[boot-health] 没能连上 CDP'); process.exit(1); }

  // ── 1. 主窗口 ──
  const main = list.find((t) => /renderer[\\/]index\.html/.test(t.url || ''));
  if (!main) fail('主窗口没有出现');
  else {
    const c = await connect(main.webSocketDebuggerUrl);
    await c.send('Runtime.enable');
    await c.send('Log.enable');
    await sleep(3500);
    const ex = exceptions(c);
    if (ex.length) fail('主窗口有 ' + ex.length + ' 条未捕获异常：' + ex.slice(0, 3).join(' ; '));
    else pass('主窗口启动无未捕获异常');
    const r = await c.send('Runtime.evaluate', {
      expression: "JSON.stringify({ live2d: !!window.__soulweaveLive2D, status: (document.getElementById('status')||{}).textContent || '' })",
      returnByValue: true,
    });
    const v = JSON.parse(r.result.value || '{}');
    if (!v.live2d) fail('Live2D 运行器没有就绪');
    else pass('Live2D 运行器就绪（状态：' + v.status + '）');
    c.close();
  }

  // ── 2. 设置窗口 ──
  const c2 = await connect(main.webSocketDebuggerUrl);
  await c2.send('Runtime.enable');
  await c2.send('Runtime.evaluate', { expression: 'window.soulweave.openSettings()', awaitPromise: true });
  c2.close();
  await sleep(4000);

  list = await targets();
  const stg = (list || []).find((t) => /settings/i.test(t.url || ''));
  if (!stg) fail('设置窗口没有打开');
  else {
    const c = await connect(stg.webSocketDebuggerUrl);
    await c.send('Runtime.enable');
    await sleep(2500);
    const ex = exceptions(c);
    if (ex.length) fail('设置窗口有 ' + ex.length + ' 条未捕获异常：' + ex.slice(0, 3).join(' ; '));
    else pass('设置窗口启动无未捕获异常');
    const r = await c.send('Runtime.evaluate', {
      expression: "document.querySelectorAll('.nav-item[data-id]').length",
      returnByValue: true,
    });
    const n = r.result.value;
    if (!n || n < 14) fail('导航项只有 ' + n + ' 个（预期 ≥14）');
    else pass('导航项 ' + n + ' 个');
    c.close();
  }

  console.log('[boot-health] ' + (failures.length ? 'FAILED (' + failures.length + ')' : 'PASS'));
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.log('[boot-health] 异常：' + e); process.exit(1); })
  .finally(() => { if (child) { try { child.kill(); } catch {} } });
