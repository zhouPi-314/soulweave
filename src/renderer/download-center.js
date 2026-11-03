/**
 * SoulWeave S7：资源下载中心（第 14 个模块）
 *
 * 用户要求：「所有的资源下载任务和版本更新任务都归其管理，其他板块各司其职」
 *
 * 这个面板只做一件事：把「现在在下什么、下了多少、还要多久」说清楚。
 * 其他板块（语音 / 多媒体 / 模型）需要资源时，把任务丢进队列，然后指向这里。
 */

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

function btn(label, cls, onClick) {
  const b = el('button', 'ls-btn' + (cls ? ' ' + cls : ''), label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function tip(text, kind) {
  const t = el('div', 'ls-tip' + (kind ? ' ' + kind : ''));
  t.appendChild(el('span', 'ls-tip-i', kind === 'bad' ? '✕' : kind === 'warn' ? '!' : 'i'));
  t.appendChild(el('span', null, text));
  return t;
}

const loading = (t) => el('div', 'ls-loading', t || '加载中…');

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, x = v;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2) + ' ' + u[i];
}

function fmtEta(s) {
  if (s == null || !Number.isFinite(s) || s < 0) return '—';
  const v = Math.round(s);
  if (v < 1) return '即将完成';
  if (v < 60) return v + ' 秒';
  const m = Math.floor(v / 60);
  if (m < 60) return m + ' 分 ' + (v % 60) + ' 秒';
  return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
}

const STATE_LABEL = {
  queued: '排队中', running: '下载中', paused: '已暂停',
  completed: '已完成', failed: '失败', cancelled: '已取消',
};

export async function renderDownloads(host, onChange) {
  host.textContent = '';
  host.appendChild(loading('正在读取下载任务…'));

  const [res, wm] = await Promise.all([
    window.soulweave.downloadList().catch((e) => ({ ok: false, error: String(e), tasks: [] })),
    window.soulweave.downloadWhisperModels().catch(() => ({ ok: false, models: [] })),
  ]);
  host.textContent = '';

  const tasks = (res && res.tasks) || [];
  const stats = (res && res.stats) || {};
  const reload = () => (onChange ? onChange() : renderDownloads(host, onChange));

  // ── 概览 ──
  const statSec = el('div', 'sec');
  statSec.appendChild(el('div', 'sec-title', '总览'));
  const grid = el('div', 'ls-stats');
  const mk = (k, v, u, cls) => {
    const s = el('div', 'ls-stat' + (cls ? ' ' + cls : ''));
    s.appendChild(el('div', 'ls-stat-k', k));
    const vv = el('div', 'ls-stat-v', String(v));
    if (u) vv.appendChild(el('span', 'ls-stat-u', u));
    s.appendChild(vv);
    return s;
  };
  grid.appendChild(mk('进行中', stats.running || 0, '个', stats.running ? 'hot' : ''));
  grid.appendChild(mk('排队', stats.queued || 0, '个'));
  grid.appendChild(mk('已完成', stats.completed || 0, '个'));
  grid.appendChild(mk('已下载', fmtBytes(stats.receivedBytes || 0), ''));
  statSec.appendChild(grid);
  if (stats.failed) statSec.appendChild(tip('有 ' + stats.failed + ' 个任务失败，可以点「重试」。', 'warn'));
  host.appendChild(statSec);

  // ── 任务列表 ──
  const listSec = el('div', 'sec');
  listSec.appendChild(el('div', 'sec-title', '下载任务'));
  listSec.appendChild(el('div', 'sec-hint', '所有板块的资源下载都在这里排队。关掉面板不影响下载，回来还能看到进度。'));

  // 任务栏只放"还没结束"的任务。
  // 用户明确要求：下到 100% 的任务不该继续占着进度条的位置。
  // 完成的仍在「总览」里计数、仍能用「清理已结束」清掉，只是不再占列表。
  const activeTasks = tasks.filter((x) => x.state !== 'done' && x.state !== 'completed');
  const doneCount = tasks.length - activeTasks.length;

  if (!tasks.length) {
    listSec.appendChild(el('div', 'dl-empty', '还没有下载任务'));
  } else if (!activeTasks.length) {
    listSec.appendChild(el('div', 'dl-empty', '没有正在进行的下载'));
    const bar0 = el('div', 'dl-toolbar');
    bar0.appendChild(btn('清理已结束的 ' + doneCount + ' 个任务', 'sm ghost', async () => {
      await window.soulweave.downloadClearFinished();
      reload();
    }));
    listSec.appendChild(bar0);
  } else {
    const bar = el('div', 'dl-toolbar');
    // 失败的任务单独一组，并且能一键全重试：
    // 断网时常常一次挂掉七八个，逐个点重试很折磨人。
    const failedTasks = activeTasks.filter((x) => x.state === 'failed');
    if (failedTasks.length) {
      bar.appendChild(btn('重试全部失败（' + failedTasks.length + '）', 'sm primary', async () => {
        for (const f of failedTasks) await window.soulweave.downloadResume({ id: f.id }).catch(() => {});
        reload();
      }));
    }
    bar.appendChild(btn('清理已结束', 'sm ghost', async () => {
      await window.soulweave.downloadClearFinished();
      reload();
    }));
    listSec.appendChild(bar);
    const failedGroup = activeTasks.filter((x) => x.state === 'failed');
    const otherTasks = activeTasks.filter((x) => x.state !== 'failed');
    for (const t of otherTasks) listSec.appendChild(taskCard(t, reload));
    if (failedGroup.length) {
      listSec.appendChild(el('div', 'dl-group-t', '失败（' + failedGroup.length + '）'));
      for (const t of failedGroup) listSec.appendChild(taskCard(t, reload));
    }
    if (doneCount) {
      listSec.appendChild(el('div', 'cmp-w', '已完成 ' + doneCount + ' 个，已从列表收起（仍在「总览」计数里）。'));
    }
  }
  host.appendChild(listSec);

  // 有任务在跑时自动刷新：下载面板最怕"进度条不动"，
  // 让人以为卡死了，只能反复点重进。就地重渲染并保住滚动位置。
  try {
    if (window.__dlTimer) { clearInterval(window.__dlTimer); window.__dlTimer = null; }
    const busy = tasks.some((x) => x.state === 'running' || x.state === 'queued' || x.state === 'paused');
    if (busy) {
      window.__dlTimer = setInterval(() => {
        const box = document.getElementById('sb-content');
        const keep = box ? box.scrollTop : 0;
        renderDownloads(host, onChange).then(() => {
          const b2 = document.getElementById('sb-content');
          if (b2) b2.scrollTop = keep;
        }).catch(() => {});
      }, 1500);
      const stop = () => { if (window.__dlTimer) { clearInterval(window.__dlTimer); window.__dlTimer = null; } };
      window.addEventListener('hashchange', stop, { once: true });
    }
  } catch (e) { /* ignore */ }

  // ── 各板块的资源区 ──
  //
  // 【为什么分区】
  // 用户的原话：「各个板块一个区行」。
  // 每个板块需要下载的东西不一样，混在一起会让人不知道自己在看什么。
  // 每个区保持和「语音识别模型」同样的详细度：名称、用途、体积、评价、状态。
  const whisperSec = whisperSection(wm, reload);
  whisperSec.id = 'dl-sec-whisper';
  host.appendChild(whisperSec);

  const adapterSec = adapterSection(reload);
  adapterSec.id = 'dl-sec-adapter';
  host.appendChild(adapterSec);

  // 从别的板块跳进来时，滚到对应分区并闪一下
  const focus = window.__dlFocus;
  if (focus) {
    window.__dlFocus = null;
    requestAnimationFrame(() => {
      const target = document.getElementById('dl-sec-' + focus);
      if (!target) return;
      target.scrollIntoView({ block: 'start', behavior: 'smooth' });
      target.classList.add('dl-flash');
      setTimeout(() => target.classList.remove('dl-flash'), 1400);
    });
  }
}

/**
 * 从其他板块跳到下载中心。
 *
 * 其他板块不再自己开下载对话框 —— 点了就跳到这里，
 * 用户永远只有一个地方看进度。
 */
export function gotoDownloads(section) {
  window.__dlFocus = section || '';
  if (window.__swSelect) window.__swSelect('downloads');
}

/** QQ 协议端（默认 NapCat，可换 SnowLuma / Lagrange） */
function adapterSection(reload) {
  const sec = el('div', 'sec');
  sec.appendChild(el('div', 'sec-title', 'QQ 协议端'));
  sec.appendChild(el('div', 'sec-hint',
    'SoulWeave 默认用 NapCat。想换成 SnowLuma 或 Lagrange 也可以——下载后按各自说明配置，' +
    '再在「社交」里改连接方式即可，界面不用动。'));

  const box = el('div');
  sec.appendChild(box);

  const load = async () => {
    box.textContent = '';
    box.appendChild(loading('正在查询三个协议端的最新版本…'));
    const r = await window.soulweave.qqAdapterList().catch(() => null);
    box.textContent = '';
    if (!r || !r.ok) {
      box.appendChild(tip('查询失败：' + ((r && r.error) || '网络不可用'), 'bad'));
      const retry = btn('重试', 'sm ghost', load);
      box.appendChild(retry);
      return;
    }
    const grid = el('div', 'dl-models');
    for (const a of (r.adapters || [])) {
      grid.appendChild(adapterCard(a, reload));
    }
    box.appendChild(grid);
    box.appendChild(el('div', 'dl-foot',
      '下载后不会自动安装，也不会被执行。解压和配置由你来做。'));
  };

  load();
  return sec;
}

function adapterCard(a, reload) {
  const card = el('div', 'dl-model');
  const head = el('div', 'dl-model-h');
  head.appendChild(el('div', 'dl-model-n', a.name));
  if (a.id === 'napcat') head.appendChild(el('span', 'dl-badge ok', '默认'));
  head.appendChild(el('span', 'dl-badge', a.version));
  card.appendChild(head);
  card.appendChild(el('div', 'dl-model-note', a.needsQqClient ? '需要本机已装 QQ 客户端' : '不需要 QQ 客户端，独立运行'));
  const meta = el('div', 'dl-model-meta');
  meta.appendChild(el('span', null, '体积 ' + fmtBytes(a.sizeBytes)));
  card.appendChild(meta);
  card.appendChild(el('div', 'dl-model-warn', a.license));
  card.appendChild(el('div', 'dl-model-warn', a.caution));

  const prog = el('div', 'dl-model-prog', '');
  const b = btn('下载', 'sm primary', async () => {
    b.disabled = true;
    prog.textContent = '开始下载…';
    const off = window.soulweave.onQqAdapterProgress((d) => {
      if (!d) return;
      if (d.total) prog.textContent = '下载中 ' + Math.round(d.got / d.total * 100) + '%';
      else prog.textContent = '已下载 ' + fmtBytes(d.got || 0);
    });
    const r = await window.soulweave.qqAdapterDownload({ info: a }).catch(() => null);
    try { off && off(); } catch (e) { /* ignore */ }
    b.disabled = false;
    if (!r || !r.ok) { prog.textContent = '失败：' + ((r && r.error) || '未知'); return; }
    const vr = await window.soulweave.qqAdapterVerify({ path: r.path, sha256: r.sha256 }).catch(() => null);
    prog.textContent = '已下载 ' + fmtBytes(r.bytes) + (vr && vr.ok ? ' · 校验通过' : ' · 校验异常');
    if (reload) reload();
  });
  card.appendChild(b);
  card.appendChild(prog);
  return card;
}

function taskCard(t, reload) {
  const card = el('div', 'dl-card dl-' + t.state);
  const head = el('div', 'dl-head');
  const info = el('div', 'dl-info');
  info.appendChild(el('div', 'dl-label', t.label));
  if (t.note) info.appendChild(el('div', 'dl-note', t.note));
  head.appendChild(info);
  head.appendChild(el('span', 'dl-state', STATE_LABEL[t.state] || t.state));
  card.appendChild(head);

  // 进度条
  const total = t.totalBytes || t.approxBytes || 0;
  const pct = total > 0 ? Math.min(100, (t.receivedBytes / total) * 100) : null;
  const barWrap = el('div', 'dl-bar');
  const fill = el('div', 'dl-fill');
  if (pct != null) fill.style.width = pct.toFixed(1) + '%';
  else if (t.state === 'running') fill.classList.add('indeterminate');
  barWrap.appendChild(fill);
  card.appendChild(barWrap);

  const meta = el('div', 'dl-meta');
  const left = el('span');
  left.textContent = fmtBytes(t.receivedBytes) + (total > 0 ? (' / ' + fmtBytes(total)) : '');
  meta.appendChild(left);
  if (t.state === 'running') {
    if (t.speedBps > 0) meta.appendChild(el('span', 'dl-speed', fmtBytes(t.speedBps) + '/s'));
    if (t.etaSeconds != null) meta.appendChild(el('span', 'dl-eta', '剩 ' + fmtEta(t.etaSeconds)));
  }
  if (pct != null) meta.appendChild(el('span', 'dl-pct', pct.toFixed(0) + '%'));
  card.appendChild(meta);

  if (t.error) card.appendChild(el('div', 'dl-err', t.error));

  const acts = el('div', 'dl-acts');
  if (t.state === 'running') {
    acts.appendChild(btn('暂停', 'sm', async () => { await window.soulweave.downloadPause({ id: t.id }); reload(); }));
    acts.appendChild(btn('取消', 'sm ghost', async () => { await window.soulweave.downloadCancel({ id: t.id }); reload(); }));
  } else if (t.state === 'paused') {
    acts.appendChild(btn('继续', 'sm primary', async () => { await window.soulweave.downloadResume({ id: t.id }); reload(); }));
    acts.appendChild(btn('取消', 'sm ghost', async () => { await window.soulweave.downloadCancel({ id: t.id }); reload(); }));
  } else if (t.state === 'failed') {
    acts.appendChild(btn('重试', 'sm primary', async () => { await window.soulweave.downloadResume({ id: t.id }); reload(); }));
    acts.appendChild(btn('移除', 'sm ghost', async () => { await window.soulweave.downloadRemove({ id: t.id }); reload(); }));
  } else if (t.state === 'queued') {
    acts.appendChild(btn('取消', 'sm ghost', async () => { await window.soulweave.downloadCancel({ id: t.id }); reload(); }));
  }
  card.appendChild(acts);
  return card;
}

function whisperSection(wm, reload) {
  const sec = el('div', 'sec');
  sec.appendChild(el('div', 'sec-title', '语音识别模型'));
  sec.appendChild(el('div', 'sec-hint',
    '本地语音识别需要模型文件。base 已内置，其余按需下载——下载走上面的队列，可以随时暂停。'));

  const models = (wm && wm.models) || [];
  if (!models.length) {
    sec.appendChild(el('div', 'dl-empty', '读取模型清单失败'));
    return sec;
  }

  const grid = el('div', 'dl-models');
  for (const m of models) {
    const card = el('div', 'dl-model' + (m.installed ? ' installed' : ''));
    const head = el('div', 'dl-model-h');
    head.appendChild(el('div', 'dl-model-n', m.label));
    if (m.bundled) head.appendChild(el('span', 'dl-badge', '内置'));
    if (m.installed) head.appendChild(el('span', 'dl-badge ok', '已下载'));
    card.appendChild(head);
    card.appendChild(el('div', 'dl-model-note', m.note));
    const meta = el('div', 'dl-model-meta');
    meta.appendChild(el('span', null, '体积 ' + fmtBytes(m.bytes)));
    meta.appendChild(el('span', null, '质量 ' + '★'.repeat(m.quality) + '☆'.repeat(5 - m.quality)));
    meta.appendChild(el('span', null, '速度 ' + '★'.repeat(m.speed) + '☆'.repeat(5 - m.speed)));
    card.appendChild(meta);
    if (!m.installed) {
      card.appendChild(btn('下载', 'sm primary', async () => {
        const r = await window.soulweave.downloadWhisperModel({ id: m.id });
        if (r && r.ok) reload(); else alert('加入队列失败：' + ((r && r.error) || '未知'));
      }));
    }
    grid.appendChild(card);
  }
  sec.appendChild(grid);
  return sec;
}

export function ensureDownloadStyles() {
  if (document.getElementById('dl-styles')) return;
  const st = document.createElement('style');
  st.id = 'dl-styles';
  st.textContent = `
.dl-toolbar { display: flex; justify-content: flex-end; margin-bottom: 8px; }
.dl-empty { font-size: 11.5px; color: var(--sb-dim); padding: 14px 0; }
.dl-card {
  padding: 12px 14px; margin-bottom: 9px; border-radius: 11px;
  border: 1px solid var(--sb-line); background: rgba(127,127,127,.045);
}
.dl-card.dl-running { border-color: rgba(110,168,254,.4); background: rgba(110,168,254,.06); }
.dl-card.dl-failed { border-color: rgba(255,120,120,.4); background: rgba(255,120,120,.06); }
.dl-card.dl-completed { border-color: rgba(110,231,168,.3); }
.dl-head { display: flex; align-items: flex-start; gap: 10px; }
.dl-info { flex: 1; min-width: 0; }
.dl-label { font-size: 12.5px; font-weight: 650; }
.dl-note { font-size: 11.5px; color: var(--sb-dim); margin-top: 2px; }
.dl-state {
  font-size: 11.5px; padding: 1px 8px; border-radius: 999px;
  border: 1px solid var(--sb-line); color: var(--sb-dim); flex: none;
}
.dl-running .dl-state { color: #A9C7FF; border-color: rgba(110,168,254,.5); background: rgba(110,168,254,.12); }
.dl-completed .dl-state { color: #6EE7A8; border-color: rgba(110,231,168,.4); background: rgba(110,231,168,.1); }
.dl-failed .dl-state { color: #FF8E8E; border-color: rgba(255,120,120,.4); background: rgba(255,120,120,.1); }
.dl-bar {
  height: 5px; border-radius: 3px; background: rgba(127,127,127,.16);
  margin-top: 10px; overflow: hidden;
}
.dl-fill {
  height: 100%; border-radius: 3px; width: 0;
  background: linear-gradient(90deg, #6EA8FE, #C9A7FF);
  transition: width .3s ease;
}
.dl-fill.indeterminate {
  width: 35% !important;
  animation: dl-slide 1.2s ease-in-out infinite;
}
@keyframes dl-slide {
  0% { margin-left: -35%; }
  100% { margin-left: 100%; }
}
.dl-meta {
  display: flex; gap: 12px; margin-top: 7px; flex-wrap: wrap;
  font-size: 11.5px; color: var(--sb-dim); font-variant-numeric: tabular-nums;
}
.dl-speed { color: #A9C7FF; }
.dl-pct { margin-left: auto; color: var(--sb-fg); }
.dl-err { font-size: 11.5px; color: #FF8E8E; margin-top: 7px; line-height: 1.5; }
.dl-acts { display: flex; gap: 6px; margin-top: 9px; flex-wrap: wrap; }
.dl-models { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 9px; }
.dl-model {
  padding: 11px 13px; border-radius: 10px;
  border: 1px solid var(--sb-line); background: rgba(127,127,127,.04);
}
.dl-model.installed { border-color: rgba(110,231,168,.32); background: rgba(110,231,168,.05); }
.dl-model-h { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.dl-model-n { font-size: 12px; font-weight: 650; }
.dl-badge {
  font-size: 11.5px; padding: 1px 6px; border-radius: 4px;
  border: 1px solid var(--sb-line); color: var(--sb-dim);
}
.dl-badge.ok { color: #6EE7A8; border-color: rgba(110,231,168,.4); background: rgba(110,231,168,.1); }
.dl-model-note { font-size: 11.5px; color: var(--sb-dim); margin-top: 4px; line-height: 1.5; }
.dl-model-meta {
  display: flex; gap: 10px; flex-wrap: wrap; margin-top: 7px;
  font-size: 11.5px; color: var(--sb-dim);
}
.ls-stat.hot .ls-stat-v { color: #A9C7FF; }
.dl-model-warn { font-size: 11.5px; color: var(--sb-dim); margin-top: 5px; line-height: 1.5; }
.dl-model-prog { font-size: 11.5px; color: var(--sb-dim); margin-top: 6px; min-height: 14px; }
.dl-foot { font-size: 11.5px; color: var(--sb-dim); margin-top: 9px; line-height: 1.6; }
.sec.dl-flash { animation: dl-flash 1.3s ease; border-radius: 10px; }
@keyframes dl-flash {
  0% { box-shadow: 0 0 0 0 rgba(110,168,254,0); }
  25% { box-shadow: 0 0 0 3px rgba(110,168,254,.35); }
  100% { box-shadow: 0 0 0 0 rgba(110,168,254,0); }
}
`;
  document.head.appendChild(st);
}
