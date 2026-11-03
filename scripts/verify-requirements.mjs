/**
 * 需求行为级验证：把 181 行需求逐条对到"真的跑过"的检查上。
 *
 * 【本轮的三个修正】
 * 1. 每次读 DOM 前先断言 #sb-title 等于目标面板名；不等就判 FAIL，
 *    绝不在"没切过去"的页面上读数据（上一版就是这样产生了假阳性）。
 * 2. 选择器全部按真实 DOM 校正（.theme-card / .ls-tab / .rule / .roster-head …）。
 * 3. 结果写进 docs/S12-UI-Redesign/14-需求行为级验证.md，含每条的证据。
 *
 * 诚实边界：检查是"类级"的（面板内关键元素存在且可交互），不是每条需求的专属用例。
 * 本机不具备的条件（真实 QQ、摄像头、云端额度）不伪造通过。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const GIVEN = arg('--port', null);
const PORT = Number(GIVEN || 0) || (9700 + Math.floor(Math.random() * 200));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 面板 id → 标题（用于断言真的切过去了） */
const TITLES = {
  dashboard: '看板', life: '虚拟生活', character: '智能体绑定', roster: '角色档案',
  live2d: '形象管理', theme: '主题', voice: '语音', model: '模型', social: '社交',
  memory: '记忆', permission: '权限', multimedia: '多媒体', resource: '资源',
  downloads: '下载中心', maintenance: '维护', extension: '扩展',
};

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

const listTargets = async () => {
  try { return await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); } catch { return null; }
};

let child = null;
if (!GIVEN) {
  const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const tmp = path.join(ROOT, '..', '..', '08_temp', 'tmp');
  child = spawn(exe, ['.', '--remote-debugging-port=' + PORT], {
    cwd: ROOT,
    env: { ...process.env, TEMP: tmp, TMP: tmp, ELECTRON_RUN_AS_NODE: undefined },
    stdio: 'ignore',
  });
}

let targets = null;
for (let i = 0; i < 40; i++) { await sleep(1000); targets = await listTargets(); if (targets && targets.length) break; }
if (!targets) { console.log('连不上 CDP'); process.exit(1); }

const mainT = targets.find((t) => /renderer[\\/]index\.html/.test(t.url || ''));
const mc = await connect(mainT.webSocketDebuggerUrl);
await mc.send('Runtime.enable');
await mc.send('Runtime.evaluate', { expression: 'window.soulweave.openSettings()' });
await sleep(6000);

targets = await listTargets();
const stgT = targets.filter((t) => /settings/i.test(t.url || '')).pop();
const c = await connect(stgT.webSocketDebuggerUrl);
await c.send('Runtime.enable');
await sleep(2000);

const ev = async (expr) => {
  const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  return r.result ? r.result.value : undefined;
};

/** 切面板 + 断言标题；返回 {ok, title} */
async function gotoPanel(id) {
  const want = TITLES[id];
  await ev("window.__swSelect && window.__swSelect('" + id + "')");
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    const t = await ev("(document.getElementById('sb-title')||{}).textContent");
    if (t === want) { await sleep(900); return { ok: true, title: t }; }
  }
  const t = await ev("(document.getElementById('sb-title')||{}).textContent");
  return { ok: false, title: t };
}

const checks = [];
const add = (key, title, fn) => checks.push({ key, title, fn });

add('panels', '16 个模块都能打开并切到正确面板', async () => {
  const ids = Object.keys(TITLES);
  const bad = [];
  for (const id of ids) {
    const before = c.events.length;
    const r = await gotoPanel(id);
    if (!r.ok) bad.push(id + '→' + r.title);
    const n = await ev("document.querySelectorAll('#sb-content > *').length");
    if (!n) bad.push(id + ':空');
    if (c.events.slice(before).some((e) => e.method === 'Runtime.exceptionThrown')) bad.push(id + ':异常');
  }
  return { ok: bad.length === 0, evidence: bad.length ? '问题：' + bad.join('、') : '16/16 标题与内容都正确' };
});

add('roster', '角色档案：3 个分区 + 角色卡', async () => {
  const g = await gotoPanel('roster');
  if (!g.ok) return { ok: false, evidence: '面板未切换（' + g.title + '）' };
  const secs = JSON.parse((await ev("JSON.stringify(Array.from(document.querySelectorAll('#sb-content .sec-title')).map(x=>x.textContent.trim()))")) || '[]');
  const cards = await ev("document.querySelectorAll('#sb-content .roster-head').length");
  const personaBtn = await ev("JSON.stringify(Array.from(document.querySelectorAll('#sb-content button')).map(x=>x.textContent.trim()).filter(t=>/人格卡/.test(t)))");
  return { ok: secs.includes('角色清单') && cards >= 2 && /人格卡/.test(personaBtn), evidence: '分区 ' + secs.join('/') + '，角色 ' + cards + ' 个，人格卡按钮 ' + personaBtn };
});

add('persona', '人格卡：点开是 4 字段表单', async () => {
  const g = await gotoPanel('roster');
  if (!g.ok) return { ok: false, evidence: '面板未切换' };
  await ev("(()=>{const b=Array.from(document.querySelectorAll('#sb-content button')).find(x=>/填写人格卡|编辑人格卡/.test(x.textContent)); if(b)b.click();})()");
  await sleep(500);
  const n = await ev("(()=>{const f=document.querySelector('.persona-form');return f? f.querySelectorAll('.persona-field').length : -1;})()");
  return { ok: n === 4, evidence: '字段数 ' + n };
});

add('live2d', '形象管理：形象库/内置形象/导入三区 + 内置卡', async () => {
  const g = await gotoPanel('live2d');
  if (!g.ok) return { ok: false, evidence: '面板未切换（' + g.title + '）' };
  const secs = JSON.parse((await ev("JSON.stringify(Array.from(document.querySelectorAll('#sb-content .sec-title')).map(x=>x.textContent.trim()))")) || '[]');
  const cards = await ev("document.querySelectorAll('#sb-content .cmp').length");
  return { ok: secs.includes('内置形象') && secs.includes('导入新形象') && cards >= 3, evidence: '分区 ' + secs.join('/') + '，形象卡 ' + cards };
});

add('theme', '主题：5 套可选且切换真的改 data-theme', async () => {
  const g = await gotoPanel('theme');
  if (!g.ok) return { ok: false, evidence: '面板未切换（' + g.title + '）' };
  const n = await ev("document.querySelectorAll('#sb-content .theme-card').length");
  const before = await ev("document.documentElement.getAttribute('data-theme') + '/' + (document.documentElement.getAttribute('data-theme-name')||'')");
  await ev("(()=>{const b=document.querySelectorAll('#sb-content .theme-card')[2]; if(b)b.click();})()");
  await sleep(700);
  const mid = await ev("document.documentElement.getAttribute('data-theme') + '/' + (document.documentElement.getAttribute('data-theme-name')||'')");
  await ev("(()=>{const b=document.querySelectorAll('#sb-content .theme-card')[0]; if(b)b.click();})()");
  await sleep(500);
  return { ok: n >= 5 && before !== mid, evidence: '主题卡 ' + n + ' 张，' + before + ' → ' + mid + '（已还原）' };
});

add('model', '模型：4 档画质 + 当前档位状态卡', async () => {
  const g = await gotoPanel('model');
  if (!g.ok) return { ok: false, evidence: '面板未切换（' + g.title + '）' };
  const chips = await ev("document.querySelectorAll('#sb-content .chips .chip').length");
  const stats = await ev("document.querySelectorAll('#sb-content .stat-card').length");
  const secs = JSON.parse((await ev("JSON.stringify(Array.from(document.querySelectorAll('#sb-content .sec-title')).map(x=>x.textContent.trim()))")) || '[]');
  return { ok: chips >= 4 && stats >= 3 && secs.includes('画质档位'), evidence: '画质档 ' + chips + '，状态卡 ' + stats + '，分区 ' + secs.join('/') };
});

for (const [key, id, label, need] of [
  ['voice', 'voice', '语音', '语音识别（ASR）'],
  ['social', 'social', '社交', 'QQ 账号'],
  ['memory', 'memory', '记忆', '数据库连接'],
  ['resource', 'resource', '资源', '资源回收'],
  ['maintenance', 'maintenance', '维护', '环境诊断'],
  ['extension', 'extension', '扩展', '手机 Web'],
  ['downloads', 'downloads', '下载中心', '下载任务'],
]) {
  add(key, label + '：切到正确面板且关键分区存在', async () => {
    const g = await gotoPanel(id);
    if (!g.ok) return { ok: false, evidence: '面板未切换（' + g.title + '）' };
    const secs = JSON.parse((await ev("JSON.stringify(Array.from(document.querySelectorAll('#sb-content .sec-title')).map(x=>x.textContent.trim()))")) || '[]');
    return { ok: secs.some((s) => s.indexOf(need) >= 0), evidence: '分区 ' + secs.length + ' 个：' + secs.slice(0, 6).join('/') };
  });
}

add('multimedia', '多媒体：先配后试（识别方案在测试之前）', async () => {
  const g = await gotoPanel('multimedia');
  if (!g.ok) return { ok: false, evidence: '面板未切换（' + g.title + '）' };
  const secs = JSON.parse((await ev("JSON.stringify(Array.from(document.querySelectorAll('#sb-content .sec-title')).map(x=>x.textContent.trim()))")) || '[]');
  const iCfg = secs.findIndex((s) => s.indexOf('识别方案') >= 0);
  const iTest = secs.findIndex((s) => s.indexOf('试一试') >= 0);
  const stats = await ev("document.querySelectorAll('#sb-content .ls-stat').length");
  return { ok: iCfg >= 0 && iTest > iCfg && stats >= 4, evidence: '顺序 ' + secs.join(' → ') + '；状态卡 ' + stats };
});

add('permission', '权限：状态条 + 策略规则 ≥6 条', async () => {
  const g = await gotoPanel('permission');
  if (!g.ok) return { ok: false, evidence: '面板未切换（' + g.title + '）' };
  const rules = await ev("document.querySelectorAll('#sb-content .rule, #sb-content .lv').length");
  const stats = await ev("document.querySelectorAll('#sb-content .stat-card').length");
  const secs = JSON.parse((await ev("JSON.stringify(Array.from(document.querySelectorAll('#sb-content .sec-title')).map(x=>x.textContent.trim()))")) || '[]');
  return { ok: rules >= 6 && stats >= 3, evidence: '规则 ' + rules + ' 条，状态卡 ' + stats + '，分区 ' + secs.join('/') };
});

add('life', '虚拟生活：6 页签 + 主角卡右侧剩余时间', async () => {
  const g = await gotoPanel('life');
  if (!g.ok) return { ok: false, evidence: '面板未切换（' + g.title + '）' };
  const tabs = await ev("document.querySelectorAll('#sb-content .ls-tab, #sb-content .ls-tabs button').length");
  await ev("(()=>{const t=Array.from(document.querySelectorAll('#sb-content button, #sb-content .ls-tab')).find(x=>x.textContent.trim()==='今天'); if(t)t.click();})()");
  await sleep(2500);
  const side = await ev("!!document.querySelector('.ls-hero-side')");
  return { ok: tabs >= 6 && side === true, evidence: '页签 ' + tabs + ' 个，主角卡右栏 ' + side };
});

add('dashboard', '看板：KPI 卡渲染', async () => {
  const g = await gotoPanel('dashboard');
  if (!g.ok) return { ok: false, evidence: '面板未切换（' + g.title + '）' };
  const kpi = await ev("document.querySelectorAll('#sb-content .kpi').length");
  return { ok: kpi >= 4, evidence: 'KPI ' + kpi + ' 张' };
});

add('window', '设置窗口：最小化/最大化/关闭三控件', async () => {
  const n = await ev("['sb-min','sb-max','sb-close'].filter(id=>document.getElementById(id)).length");
  return { ok: n === 3, evidence: '控件 ' + n + '/3' };
});

add('pet', '主窗口：Live2D 就绪、无未捕获异常', async () => {
  const r = await mc.send('Runtime.evaluate', {
    expression: "JSON.stringify({live2d:!!window.__soulweaveLive2D, status:(document.getElementById('status')||{}).textContent||''})",
    returnByValue: true,
  });
  const st = JSON.parse(r.result.value || '{}');
  const ex = mc.events.filter((e) => e.method === 'Runtime.exceptionThrown').length;
  return { ok: st.live2d === true && ex === 0, evidence: '运行器 ' + st.live2d + '，状态「' + st.status + '」，异常 ' + ex };
});

// ── 跑检查 ──
const results = {};
for (const chk of checks) {
  try {
    const r = await chk.fn();
    results[chk.key] = { title: chk.title, ok: !!r.ok, evidence: String(r.evidence || '') };
    console.log((r.ok ? '  ok    ' : '  FAIL  ') + chk.title + ' — ' + r.evidence);
  } catch (e) {
    results[chk.key] = { title: chk.title, ok: false, evidence: '执行异常：' + e };
    console.log('  FAIL  ' + chk.title + ' — 执行异常 ' + e);
  }
}

// ── 逐条路由 ──
const basePath = path.join(ROOT, '..', '..', '00_baseline', '07_SoulWeave_完整需求追踪与版本变更矩阵.md');
const baseRows = fs.readFileSync(basePath, 'utf8').split('\n')
  .filter((l) => /^\|\s*D\d+(\.\d+)?\s*\|/.test(l))
  .map((l) => l.split('|').map((s) => s.trim()).filter(Boolean))
  .map((p) => ({ id: p[0], text: p[1] || '', priority: p[4] || '' }));

const RULES = [
  [/Live2D|形象/i, 'live2d'],
  [/人格|性格|语气|人设/, 'persona'],
  [/主题|配色|深色|浅色|夜间模式/, 'theme'],
  [/画质|帧率|渲染|性能|GPU|显存/, 'model'],
  [/语音|TTS|ASR|音色|麦克风|扬声器|朗读/, 'voice'],
  [/QQ|OneBot|群聊|私聊|消息|社交|好友/, 'social'],
  [/记忆|检索|向量|上下文/, 'memory'],
  [/权限|审批|授权|L0|L1|L2|L3|L4|L5|安全/, 'permission'],
  [/下载|安装包|资源|磁盘|缓存/, 'downloads'],
  [/图片|截图|视觉|多模态|OCR/, 'multimedia'],
  [/日程|日记|生活|主动|作息|相册/, 'life'],
  [/窗口|托盘|最大化|最小化|分辨率|DPI|缩放/, 'window'],
  [/启动|引导|开场|动画|首次/, 'pet'],
  [/看板|仪表|概览|监控/, 'dashboard'],
  [/角色|姐姐|妹妹|冰糖|小橘子|多角色/, 'roster'],
];

// 这些行为必须有真实环境才能证明（QQ 在线、麦克风、云端额度…）。
// 本机没有，就不写成 PASS——写成"类级"，明确还差人工补验。
// 发布阶段才交付的需求：安装包、官网、许可审计。它们不是"界面没做好"，
// 而是 S12 本身要交付的东西 —— 单独标出来，别混进"未验证"。
const RELEASE_STAGE = [
  /安装包|安装器|安装状态机|更新版本|更新说明|更新前备份|安装修复|下载源|镜像|官网|Pages|Releases/i,
  /许可|再分发|供应链|安全审查|隐私门禁|不修改用户已有/,
  /目录分别可选|私有安装|避免全局 PATH|打包/,
];

const NEEDS_ENV = [
  /QQ|群|私聊|好友|消息发送|接收|OneBot/i,
  /麦克风|扬声器|录音|试听|播放|朗读|TTS|ASR/,
  /云端|API|额度|密钥|联网|网络/,
  /下载|安装|更新/,
  /GPU|显存|显卡|摄像头|截图授权/,
];

const rows = baseRows.map((r) => {
  let key = 'panels';
  for (const [re, k] of RULES) { if (re.test(r.text)) { key = k; break; } }
  const res = results[key] || { ok: false, evidence: '无对应检查', title: key };
  // 优先级：真的失败 > 发布阶段未实现 > 需要外部环境（用户已确认可验）> 通过
  const release = RELEASE_STAGE.some((re) => re.test(r.text));
  const env = NEEDS_ENV.some((re) => re.test(r.text));
  let behavior;
  if (!res.ok) behavior = 'FAIL';
  else if (release) behavior = '待实现（S12）';
  else if (env) behavior = '人工确认';
  else behavior = 'PASS';
  return { id: r.id, priority: r.priority, text: r.text.slice(0, 46), via: res.title, behavior, evidence: res.evidence };
});

const pass = rows.filter((r) => r.behavior === 'PASS').length;
const envCount = rows.filter((r) => r.behavior === '人工确认').length;
const releaseCount = rows.filter((r) => r.behavior === '待实现（S12）').length;
const fail = rows.filter((r) => r.behavior === 'FAIL').length;
const out = [];
out.push('# S12-14 需求行为级验证（逐条）');
out.push('');
out.push('> 生成：' + new Date().toISOString().slice(0, 19).replace('T', ' ') + '　脚本：`scripts/verify-requirements.mjs`');
out.push('> 逐条：' + rows.length + '　PASS ' + pass + '　人工确认 ' + envCount + '　待实现（S12） ' + releaseCount + '　FAIL ' + fail);
out.push('');
out.push('## 这一版修了什么');
out.push('');
out.push('上一版的结果是**假阳性**：面板切换没生效，八个面板读到同一份内容。本版：');
out.push('');
out.push('1. 每次读 DOM 前先断言 `#sb-title` 等于目标面板名，不等直接判 FAIL；');
out.push('2. 选择器按真实 DOM 校正（`.theme-card`、`.ls-tab`、`.rule`、`.roster-head` …）；');
out.push('3. 主题检查会真的切一次主题再切回来，确认 `data-theme` 变了。');
out.push('');
out.push('## 检查汇总');
out.push('');
out.push('| 检查 | 结果 | 证据 |');
out.push('|---|---|---|');
for (const v of Object.values(results)) {
  out.push('| ' + v.title + ' | ' + (v.ok ? 'PASS' : 'FAIL') + ' | ' + String(v.evidence).replace(/\|/g, '/') + ' |');
}
out.push('');
out.push('## 读法');
out.push('');
out.push('- **PASS**：该需求所属面板的行为检查通过，且这条需求本身不需要外部环境就能证明；');
out.push('- **人工确认**：所属面板的检查过了，且需要 QQ / 麦克风 / 云端额度这类外部环境；');
out.push('  2026-11-02 用户确认这三项环境在本机已验证通过（机器侧仍是类级检查）；');
out.push('- **待实现（S12）**：安装包、官网、许可审计这类**发布阶段才交付**的需求 —— 不是界面问题，');
out.push('  而是 S12 本身的工作量，列出来才不会误以为"全做完了"；');
out.push('- **FAIL**：所属检查没过；');
out.push('- 每行都是"类级"结论，不是为这条需求单独写的用例。');
out.push('');
out.push('## 逐条');
out.push('');
out.push('| ID | 优先级 | 需求摘要 | 验证方式 | 行为 | 证据 |');
out.push('|---|---|---|---|---|---|');
for (const r of rows) {
  out.push('| ' + r.id + ' | ' + r.priority + ' | ' + r.text.replace(/\|/g, '/') + ' | ' + String(r.via).replace(/\|/g, '/') + ' | ' + r.behavior + ' | ' + String(r.evidence).replace(/\|/g, '/') + ' |');
}
const outPath = path.join(ROOT, 'docs', 'S12-UI-Redesign', '14-需求行为级验证.md');
fs.writeFileSync(outPath, out.join('\n') + '\n', 'utf8');
console.log('\n逐条：' + rows.length + '，PASS ' + pass + '，人工确认 ' + envCount + '，待实现（S12） ' + releaseCount + '，FAIL ' + fail);
console.log('写入 ' + outPath);
c.close(); mc.close();
if (child) { try { child.kill(); } catch {} }
process.exit(fail > 0 ? 2 : 0);
