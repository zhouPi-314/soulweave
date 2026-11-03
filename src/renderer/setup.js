/**
 * SoulWeave 首启向导（独立页面）
 *
 * 三步：环境自检 → 数据库（必须）→ 资源包（可跳过）→ 完成。
 * 只通过 preload 暴露的 window.setupApi 与主进程通信，不直接碰 Node。
 */
const api = window.setupApi;
const $ = (s) => document.querySelector(s);

let step = 1;
const state = {
  env: null,
  dbMode: 'embedded',
  dbReady: false,
  packs: [],
  packDone: new Set(),
};

function paintSteps() {
  $('#steps').innerHTML = [1, 2, 3, 4].map((i) => '<i class="' + (i <= step ? 'on' : '') + '"></i>').join('');
  document.querySelectorAll('.pane').forEach((p) => { p.hidden = Number(p.dataset.pane) !== step; });
  $('#back').disabled = step === 1 || step === 4;
  $('#next').textContent = step === 3 ? '完成' : step === 4 ? '开始使用' : '继续';
  // 注意：不能在 dbReady 为 false 时禁用「继续」——那会死锁（要点它才会去初始化）
  $('#next').disabled = (step === 1 && !state.env) || false;
}

async function detectEnv() {
  const list = $('#env-checks');
  list.innerHTML = '';
  const add = (text, st, cls) => {
    const li = document.createElement('li');
    li.innerHTML = '<span>' + text + '</span><span class="st ' + (cls || '') + '">' + st + '</span>';
    list.appendChild(li);
    return li;
  };
  const loading = add('操作系统', '检查中…');
  const r = await api.detect().catch((e) => ({ ok: false, error: String(e) }));
  list.innerHTML = '';
  if (r && r.ok) {
    add('操作系统 · ' + (r.os || 'Windows'), '正常', 'ok');
    add('数据库组件', r.pgInstalled ? '已内置' : '缺失（将使用已有数据库）', r.pgInstalled ? 'ok' : 'bad');
    add('可用磁盘', (r.freeGB || 0) + ' GB 可用', r.freeGB >= 5 ? 'ok' : 'bad');
    add('已有 PostgreSQL', r.existingPort ? '检测到（端口 ' + r.existingPort + '）' : '未检测到', 'ok');
    state.env = r;
  } else {
    add('环境检测失败：' + ((r && r.error) || '未知'), '继续', 'bad');
    state.env = { ok: true };
  }
  paintSteps();
}

function renderDbChoices() {
  const box = $('#db-choices');
  const existing = state.env && state.env.existingPort;
  const opts = [
    { id: 'embedded', t: '使用 SoulWeave 自带的数据库（推荐）', h: '在你自己的用户目录里创建独立实例，端口 55432，不碰系统里已有的数据库' },
    { id: 'external', t: existing ? '使用本机已有的 PostgreSQL（端口 ' + existing + '）' : '使用我已有的 PostgreSQL', h: '需要填写主机、端口、库名、用户名与密码' },
  ];
  box.innerHTML = '';
  for (const o of opts) {
    const d = document.createElement('div');
    d.className = 'choice' + (state.dbMode === o.id ? ' on' : '');
    d.innerHTML = '<span class="radio"></span><span><span class="t">' + o.t + '</span><br><span class="h">' + o.h + '</span></span>';
    d.onclick = () => { state.dbMode = o.id; state.dbReady = false; renderDbChoices(); $('#ext-form').hidden = o.id !== 'external'; paintSteps(); };
    box.appendChild(d);
  }
  $('#ext-form').hidden = state.dbMode !== 'external';
}

async function applyDb() {
  const err = $('#db-error');
  err.hidden = true;
  const prog = $('#db-progress');
  prog.hidden = false;
  $('#db-msg').textContent = state.dbMode === 'embedded' ? '正在初始化本地数据库（约 10 秒）…' : '正在连接你提供的数据库…';
  let pct = 8;
  const timer = setInterval(() => { pct = Math.min(92, pct + 4); $('#db-bar').style.width = pct + '%'; }, 350);
  const payload = state.dbMode === 'embedded' ? { mode: 'embedded' } : {
    mode: 'external',
    host: $('#ext-host').value.trim(), port: Number($('#ext-port').value) || 5432,
    database: $('#ext-db').value.trim(), user: $('#ext-user').value.trim(), password: $('#ext-pass').value,
  };
  const r = await api.applyDatabase(payload).catch((e) => ({ ok: false, error: String(e) }));
  console.log('[setup] apply ->', JSON.stringify(r));
  clearInterval(timer);
  $('#db-bar').style.width = '100%';
  if (r && r.ok) {
    $('#db-msg').textContent = '数据库已就绪';
    state.dbReady = true;
    setTimeout(() => { prog.hidden = true; }, 400);
  } else {
    prog.hidden = true;
    err.hidden = false;
    err.textContent = '数据库配置失败：' + ((r && r.error) || '未知') +
      '\n\n可以：① 重试 ② 改用已有数据库 ③ 查看应用日志（%APPDATA%\\SoulWeave）';
  }
  paintSteps();
}

async function testExternal() {
  const msg = $('#ext-msg');
  msg.textContent = '测试中…';
  const r = await api.testDatabase({
    host: $('#ext-host').value.trim(), port: Number($('#ext-port').value) || 5432,
    database: $('#ext-db').value.trim(), user: $('#ext-user').value.trim(), password: $('#ext-pass').value,
  }).catch((e) => ({ ok: false, error: String(e) }));
  msg.textContent = r && r.ok ? '连接成功' : ('连接失败：' + ((r && r.error) || '未知'));
  msg.style.color = r && r.ok ? '#6EE7A8' : '#FF9C9C';
}

async function loadPacks() {
  const list = $('#packs');
  const r = await api.packs().catch(() => ({ ok: false, packs: [] }));
  state.packs = (r && r.packs) || [];
  // 如实显示下载源来自哪一级：环境变量 / 配置文件 / 发布默认
  const src = $('#pack-source');
  if (src) {
    const s2 = (r && r.source) || null;
    const label = !s2 ? '' : (s2.kind === 'env' ? '环境变量' : s2.kind === 'file' ? '本地配置' : '发布默认');
    src.textContent = s2 ? ('下载源：' + label + ' · ' + s2.url) : '';
  }
  list.innerHTML = '';
  for (const p of state.packs) {
    const row = document.createElement('div');
    row.className = 'pack';
    row.innerHTML = '<div class="grow"><div class="n">' + p.name + '</div><div class="h">' + p.hint + '</div></div>';
    const b = document.createElement('button');
    b.className = 'btn ghost';
    b.textContent = p.installed ? '已安装' : '下载';
    b.disabled = !!p.installed;
    b.onclick = () => startPackDownload(p, b);
    row.appendChild(b);
    list.appendChild(row);
  }
}

async function startPackDownload(p, btn) {
  btn.disabled = true;
  btn.textContent = '下载中…';
  const prog = $('#pack-progress');
  prog.hidden = false;
  $('#pack-msg').textContent = '正在下载 ' + p.name + '…';
  const off = api.onPackProgress((d) => {
    if (d.id !== p.id) return;
    if (d.total) $('#pack-bar').style.width = Math.round((d.received / d.total) * 100) + '%';
    $('#pack-msg').textContent = p.name + ' · ' + Math.round(d.received / 1048576) + ' / ' +
      (d.total ? Math.round(d.total / 1048576) : '?') + ' MB';
  });
  const r = await api.downloadPack(p.id).catch((e) => ({ ok: false, error: String(e) }));
  off && off();
  if (r && r.ok) {
    btn.textContent = '已安装';
    state.packDone.add(p.id);
  } else {
    btn.disabled = false;
    btn.textContent = '重试';
    $('#pack-msg').textContent = '下载失败：' + ((r && r.error) || '未知') + '（可稍后在下载中心重试）';
  }
}

$('#back').onclick = () => { if (step > 1) { step -= 1; paintSteps(); } };
$('#next').onclick = async () => {
  if (step === 4) { await api.finish(); return; }
  if (step === 2) { await applyDb(); if (!state.dbReady) return; }
  if (step === 3) {
    $('#done-note').textContent = state.packDone.size
      ? '已下载 ' + state.packDone.size + ' 个资源包。'
      : '资源包之后再下也可以：设置中心 → 下载中心。';
    await api.finish();
    return;
  }
  step += 1;
  if (step === 2) { renderDbChoices(); }
  if (step === 3) { await loadPacks(); }
  paintSteps();
};
$('#ext-test').onclick = testExternal;

paintSteps();
detectEnv();
