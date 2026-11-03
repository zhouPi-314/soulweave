/**
 * SoulWeave S6.14：虚拟生活（Life Studio）界面
 *
 * 设计原则：
 *   · 每个标签页只做一件事，避免一屏塞满
 *   · 空状态一定告诉用户「下一步做什么」，不留死路
 *   · 虚构内容始终带「虚构」徽章（D46：不能让用户误以为是真实经历）
 *   · 失败信息带可操作建议，不是「出错了」三个字
 *   · 间距 4/8/16/24，正文 13px/1.6，次要文字对比度 ≥ 4.5:1
 */

import { swCall } from './api.js';

const $ = (s) => document.querySelector(s);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function h(tag, cls, text) { return el(tag, cls, text); }

// ── 小工具 ──────────────────────────────────────

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || '');
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    if (sameDay) return '今天 ' + hm;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  } catch (e) { return String(iso || ''); }
}

function fmtMinute(m) {
  const n = Number(m);
  if (!isFinite(n)) return '--:--';
  const hh = Math.floor((n % 1440) / 60);
  const mm = n % 60;
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

const KIND_LABEL = {
  sleep: '睡眠', work: '工作', study: '学习', meal: '用餐',
  rest: '休息', play: '娱乐', walk: '散步', custom: '自定义',
  diary: '日记', moment: '瞬间', activity: '活动',
};

function kindLabel(k) { return KIND_LABEL[k] || String(k || ''); }

function tag(text, cls) {
  const t = el('span', 'ls-tag' + (cls ? ' ' + cls : ''), text);
  return t;
}

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

function emptyBox(title, desc) {
  const b = el('div', 'ls-empty');
  b.appendChild(el('div', 'ls-empty-t', title));
  b.appendChild(el('div', 'ls-empty-d', desc));
  return b;
}

// ── 模态框 ─────────────────────────────────────

/**
 * 通用确认框。返回 Promise，值由按钮的 value 决定。
 * 用于「必须让用户决定」的场景（例如核显不可用）。
 */
function modal(opts) {
  return new Promise((resolve) => {
    const mask = el('div', 'ls-mask');
    const box = el('div', 'ls-modal');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');

    if (opts.title) box.appendChild(el('div', 'ls-modal-t', opts.title));
    if (opts.body) box.appendChild(el('div', 'ls-modal-b', opts.body));
    if (opts.detail) box.appendChild(el('div', 'ls-modal-d', opts.detail));

    const row = el('div', 'ls-modal-a');
    const close = (v) => { try { mask.remove(); } catch (e) { void e; } resolve(v); };
    for (const b of (opts.actions || [{ label: '知道了', value: true, primary: true }])) {
      const btn = el('button', 'ls-btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''), b.label);
      btn.type = 'button';
      btn.addEventListener('click', () => close(b.value));
      row.appendChild(btn);
    }
    box.appendChild(row);
    mask.appendChild(box);
    mask.addEventListener('click', (e) => { if (e.target === mask && opts.dismissable !== false) close(false); });
    document.body.appendChild(mask);
    const first = row.querySelector('.ls-btn.primary') || row.querySelector('.ls-btn');
    if (first) first.focus();
  });
}

function stat(k, v, u) {
  const s = el('div', 'ls-stat');
  s.appendChild(el('div', 'ls-stat-k', k));
  const vv = el('div', 'ls-stat-v', String(v));
  if (u) vv.appendChild(el('span', 'ls-stat-u', u));
  s.appendChild(vv);
  return s;
}

function loading(text) { return el('div', 'ls-loading', text || '加载中…'); }

// ── 当前角色 ────────────────────────────────────

/** 多角色（与主窗口一致） */
const CHARACTERS = [
  { id: '冰糖', label: '🍬 冰糖', desc: '本地 DSH' },
  { id: '小橘子', label: '🍊 小橘子', desc: '云端 API' },
];

let CURRENT_CHAR = '冰糖';

// ── 标签页 ──────────────────────────────────────

const TABS = [
  { id: 'today', label: '今天' },
  { id: 'diary', label: '日记' },
  { id: 'album', label: '相册' },
  { id: 'schedule', label: '日程' },
  { id: 'proactive', label: '主动' },
  { id: 'image', label: '图片生成' },
];

let activeTab = 'today';
let diaryLimit = 20;
let albumFavOnly = false;
let pendingSlots = null;

/** 入口：设置中心「虚拟生活」模块调用 */
export async function renderLifeStudio(host) {
  host.textContent = '';

  // 角色切换（两个角色各自独立的日程/日记/相册）
  const charBar = el('div', 'chips');
  charBar.style.marginBottom = '12px';
  for (const c of CHARACTERS) {
    const b = el('button', 'chip' + (c.id === CURRENT_CHAR ? ' on' : ''), c.label);
    b.type = 'button';
    b.title = c.desc;
    b.addEventListener('click', () => {
      if (CURRENT_CHAR === c.id) return;
      CURRENT_CHAR = c.id;
      diaryLimit = 20;
      renderLifeStudio(host);
    });
    charBar.appendChild(b);
  }
  host.appendChild(charBar);

  const tabs = el('div', 'ls-tabs');
  tabs.setAttribute('role', 'tablist');
  const body = el('div');

  function paintTabs() {
    tabs.textContent = '';
    for (const t of TABS) {
      const b = el('button', 'ls-tab' + (t.id === activeTab ? ' on' : ''), t.label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', t.id === activeTab ? 'true' : 'false');
      b.addEventListener('click', () => { activeTab = t.id; paintTabs(); paint(); });
      tabs.appendChild(b);
    }
  }

  function paint() {
    body.textContent = '';
    const fn = {
      today: renderToday,
      diary: renderDiary,
      album: renderAlbum,
      schedule: renderSchedule,
      proactive: renderProactive,
      image: renderImageSettings,
    }[activeTab];
    if (fn) fn(body);
  }

  paintTabs();
  host.appendChild(tabs);
  host.appendChild(body);
  paint();
}

// ═══ 今天 ═══════════════════════════════════════

function fmtLeft(mins) {
  if (mins >= 60) {
    const h = Math.floor(mins / 60), m = mins % 60;
    return h + ' 小时' + (m ? ' ' + m + ' 分' : '');
  }
  return mins + ' 分钟';
}

async function renderToday(host) {
  host.appendChild(loading('正在读取今天的安排…'));

  let act = null, health = null, err = null;
  try {
    act = await swCall('lifeActivityNow', { ownerCharacter: CURRENT_CHAR });
    health = await swCall('lifeHealth');
  } catch (e) { err = String(e); }

  host.textContent = '';

  if (err) {
    host.appendChild(tip('读取失败：' + err, 'bad'));
    host.appendChild(tip('如果提示「数据库未配置」，请先到「看板」完成数据库连接设置。', 'warn'));
    return;
  }

  // 数据库状态
  if (health && health.ok === false) {
    host.appendChild(tip('数据库尚未就绪：' + (health.error || '未知原因') + '。日程与日记暂时不会保存。', 'warn'));
  }

  const a = act && act.activity;

  // 主角卡
  const hero = el('div', 'ls-hero');
  const heroMain = el('div', 'ls-hero-main');
  heroMain.appendChild(el('div', 'ls-hero-k', '此刻在做'));
  heroMain.appendChild(el('div', 'ls-hero-v', a && a.title ? a.title : '空闲'));

  let sub = '尚未配置今日日程，下面显示的是默认安排。';
  if (a && a.kind) sub = kindLabel(a.kind) + (a.scene ? ' · ' + a.scene : '');
  heroMain.appendChild(el('div', 'ls-hero-m', sub));

  const badges = el('div', 'ls-hero-badges');
  if (a && a.startMinute != null && a.endMinute != null) {
    badges.appendChild(tag(fmtMinute(a.startMinute) + ' – ' + fmtMinute(a.endMinute), 'kind'));
  }
  badges.appendChild(tag('角色 · ' + CURRENT_CHAR, 'kind'));
  if (act && act.slots) badges.appendChild(tag('共 ' + act.slots + ' 段日程', 'kind'));
  heroMain.appendChild(badges);
  hero.appendChild(heroMain);

  // 右侧：这一段走到哪了。
  // 【为什么加】
  // 原来这张卡只有左边三行字，右边 2/3 是空的 —— 大卡片装小信息，
  // 第一屏看着像没加载完。把"还剩多久"补上去，卡片才配得上它的尺寸。
  //
  // 字段：lifeActivityNow 返回的是 endsAtMinute / minutesLeft，
  // 不一定带 startMinute，所以只有拿得到起点时才画进度条。
  const endsAt = a && (a.endsAtMinute != null ? a.endsAtMinute : a.endMinute);
  if (a && endsAt != null) {
    const now = new Date().getHours() * 60 + new Date().getMinutes();
    const left = a.minutesLeft != null ? a.minutesLeft : (endsAt - now);
    const side = el('div', 'ls-hero-side');
    side.appendChild(el('div', 'ls-hero-side-k', left > 0 ? '这一段还剩' : '这一段已经结束'));
    side.appendChild(el('div', 'ls-hero-side-v', left > 0 ? fmtLeft(left) : '准备进入下一段'));
    side.appendChild(el('div', 'ls-hero-side-n', '到 ' + fmtMinute(endsAt) + ' 结束'));
    if (a.startMinute != null && endsAt > a.startMinute) {
      const span = endsAt - a.startMinute;
      const pct = Math.round((Math.min(span, Math.max(0, now - a.startMinute)) / span) * 100);
      const bar = el('div', 'ls-hero-bar');
      const fill = el('div', 'ls-hero-bar-i');
      fill.style.width = pct + '%';
      bar.appendChild(fill);
      side.appendChild(bar);
      side.appendChild(el('div', 'ls-hero-side-n', pct + '% · ' + span + ' 分钟一段'));
    }
    hero.appendChild(side);
  }
  host.appendChild(hero);

  // 今日时间轴
  const sec = el('div', 'sec');
  sec.appendChild(el('div', 'sec-title', '今日时间轴'));

  let slots = [];
  try {
    const r = await swCall('lifeScheduleGet', { ownerCharacter: CURRENT_CHAR });
    if (r && r.ok && Array.isArray(r.slots)) slots = r.slots;
  } catch (e) { /* ignore */ }

  if (!slots.length) {
    sec.appendChild(emptyBox('还没有日程', '到「日程」页添加几段安排，这里就会显示一整天的节奏。'));
  } else {
    const tl = el('div', 'ls-tl');
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    for (const s of slots) {
      const on = a && a.kind === s.kind && a.startMinute === s.startMinute;
      const item = el('div', 'ls-tl-i' + (on ? ' on' : ''));
      item.appendChild(el('div', 'ls-tl-t', fmtMinute(s.startMinute) + ' – ' + fmtMinute(s.endMinute)));
      item.appendChild(el('div', 'ls-tl-n', s.title || kindLabel(s.kind)));
      if (s.scene) item.appendChild(el('div', 'ls-tl-s', s.scene));
      tl.appendChild(item);
    }
    sec.appendChild(tl);
  }
  host.appendChild(sec);

  // 快捷入口
  const quick = el('div', 'sec');
  quick.appendChild(el('div', 'sec-title', '快速操作'));
  const row = el('div', 'ls-btn-row');
  row.appendChild(btn('写一篇今天的日记', 'primary', async () => {
    try {
      const r = await swCall('lifeEventCreate', {
        ownerCharacter: CURRENT_CHAR, kind: 'diary',
        title: (a && a.title ? a.title : '今天') + ' · 随手记',
        body: '', source: 'user', isFictional: true,
      });
      if (r && r.ok) { activeTab = 'diary'; renderLifeStudio($('#sb-content')); }
    } catch (e) { /* ignore */ }
  }));
  row.appendChild(btn('查看相册', '', () => { activeTab = 'album'; renderLifeStudio($('#sb-content')); }));
  row.appendChild(btn('调整日程', '', () => { activeTab = 'schedule'; renderLifeStudio($('#sb-content')); }));
  quick.appendChild(row);
  host.appendChild(quick);
}

// ═══ 日记 ═══════════════════════════════════════

async function renderDiary(host) {
  host.appendChild(loading('正在读取日记…'));

  let r = null, err = null;
  try {
    r = await swCall('lifeEventList', { ownerCharacter: CURRENT_CHAR, limit: diaryLimit, includeDeleted: false });
  } catch (e) { err = String(e); }

  host.textContent = '';
  if (err) { host.appendChild(tip('读取失败：' + err, 'bad')); return; }
  if (!r || r.ok === false) { host.appendChild(tip('读取失败：' + ((r && r.error) || '未知原因'), 'bad')); return; }

  const list = Array.isArray(r.events) ? r.events : [];
  const total = typeof r.total === 'number' ? r.total : list.length;

  // 统计
  const stats = el('div', 'ls-stats');
  stats.appendChild(stat('全部记录', total, '条'));
  const fictional = list.filter((x) => x.isFictional).length;
  stats.appendChild(stat('虚构', fictional, '条'));
  const aiGen = list.filter((x) => x.aiGenerated).length;
  stats.appendChild(stat('AI 生成', aiGen, '条'));
  host.appendChild(stats);

  // 说明
  host.appendChild(tip('带「虚构」标记的内容是角色的想象，不是真实发生的事。这是设计上的明确区分。'));

  // 新建
  const sec = el('div', 'sec');
  sec.appendChild(el('div', 'sec-title', '写点什么'));
  const titleIn = el('input', 'ls-input');
  titleIn.type = 'text';
  titleIn.placeholder = '标题，例如「午后在阳台晒太阳」';
  titleIn.maxLength = 80;
  sec.appendChild(titleIn);

  const bodyIn = el('textarea', 'ls-textarea');
  bodyIn.placeholder = '正文（可选）';
  sec.appendChild(bodyIn);

  const row = el('div', 'ls-btn-row');
  const addBtn = btn('保存', 'primary', async () => {
    const t = titleIn.value.trim();
    if (!t) { titleIn.focus(); return; }
    addBtn.disabled = true;
    try {
      const res = await swCall('lifeEventCreate', {
        ownerCharacter: CURRENT_CHAR, kind: 'diary', title: t,
        body: bodyIn.value.trim(), source: 'user', isFictional: true,
      });
      if (res && res.ok) { diaryLimit = 20; renderLifeStudio($('#sb-content')); }
      else { addBtn.disabled = false; alert('保存失败：' + ((res && res.error) || '未知')); }
    } catch (e) { addBtn.disabled = false; alert('保存失败：' + e); }
  });
  row.appendChild(addBtn);
  sec.appendChild(row);
  host.appendChild(sec);

  // 列表
  const listSec = el('div', 'sec');
  listSec.appendChild(el('div', 'sec-title', '最近记录'));

  if (!list.length) {
    listSec.appendChild(emptyBox('还没有任何记录', '在上面写第一条，或者等角色自己写日记。'));
  } else {
    for (const ev of list) listSec.appendChild(eventCard(ev));

    if (total > list.length) {
      const more = el('div', 'ls-btn-row');
      more.appendChild(btn('加载更多（还有 ' + (total - list.length) + ' 条）', '', () => {
        diaryLimit += 20;
        renderLifeStudio($('#sb-content'));
      }));
      listSec.appendChild(more);
    }
  }
  host.appendChild(listSec);
}

function eventCard(ev) {
  const c = el('div', 'ls-card');
  const hd = el('div', 'ls-card-h');
  hd.appendChild(el('div', 'ls-card-t', ev.title || '（无标题）'));
  if (ev.isFictional) hd.appendChild(tag('虚构', 'fictional'));
  if (ev.aiGenerated) hd.appendChild(tag('AI 生成', 'ai'));
  c.appendChild(hd);

  const meta = el('div', 'ls-card-d', fmtDate(ev.occurredAt) + ' · ' + kindLabel(ev.kind));
  c.appendChild(meta);

  if (ev.body) {
    const b = el('div', 'ls-card-b', ev.body);
    c.appendChild(b);
    if (ev.body.length > 90) {
      b.style.cursor = 'pointer';
      b.title = '点击展开 / 收起';
      b.addEventListener('click', () => b.classList.toggle('open'));
    }
  }

  const act = el('div', 'ls-card-a');
  act.appendChild(btn('删除', 'sm danger', async () => {
    if (!confirm('删除这条记录？可以在数据库里恢复。')) return;
    try {
      const r = await swCall('lifeEventDelete', { id: ev.id });
      if (r && r.ok) renderLifeStudio($('#sb-content'));
      else alert('删除失败：' + ((r && r.error) || '未知'));
    } catch (e) { alert('删除失败：' + e); }
  }));
  c.appendChild(act);
  return c;
}

// ═══ 相册 ═══════════════════════════════════════


async function renderAlbum(host) {
  host.appendChild(loading('正在读取相册…'));

  let r = null, err = null;
  try {
    r = await swCall('lifeAlbumList', { ownerCharacter: CURRENT_CHAR, favoriteOnly: albumFavOnly, limit: 60 });
  } catch (e) { err = String(e); }

  host.textContent = '';
  if (err) { host.appendChild(tip('读取失败：' + err, 'bad')); return; }
  if (!r || r.ok === false) { host.appendChild(tip('读取失败：' + ((r && r.error) || '未知原因'), 'bad')); return; }

  const media = Array.isArray(r.media) ? r.media : [];

  // 筛选
  const bar = el('div', 'ls-btn-row');
  const allBtn = btn('全部', albumFavOnly ? '' : 'primary', () => { albumFavOnly = false; renderLifeStudio($('#sb-content')); });
  const favBtn = btn('只看收藏', albumFavOnly ? 'primary' : '', () => { albumFavOnly = true; renderLifeStudio($('#sb-content')); });
  bar.appendChild(allBtn);
  bar.appendChild(favBtn);
  host.appendChild(bar);

  if (!media.length) {
    host.appendChild(emptyBox(
      albumFavOnly ? '还没有收藏的图片' : '相册是空的',
      albumFavOnly ? '在「全部」里点图片右上角的星标即可收藏。' : '角色主动分享或生成图片后会自动出现在这里。到「图片生成」页可以配置生成来源。'
    ));
    return;
  }

  const grid = el('div', 'ls-album');
  for (const m of media) grid.appendChild(albumItem(m));
  host.appendChild(grid);
}

function albumItem(m) {
  const d = el('div', 'ls-album-item');
  d.setAttribute('role', 'button');
  d.setAttribute('tabindex', '0');

  const ph = el('div', 'ls-album-ph', m.relPath || '（无路径）');
  d.appendChild(ph);

  // 尝试加载本地图片（file: 协议在 CSP 里已允许）
  const srcPath = m.absPath || m.relPath;
  if (srcPath && /\.(png|jpe?g|webp|gif)$/i.test(srcPath)) {
    const img = document.createElement('img');
    img.alt = m.prompt || '相册图片';
    img.loading = 'lazy';
    img.src = 'file:///' + String(srcPath).replace(/\\/g, '/').replace(/^\/+/, '');
    img.addEventListener('load', () => { ph.style.display = 'none'; });
    img.addEventListener('error', () => { img.remove(); });
    d.appendChild(img);
  }

  const fav = el('button', 'ls-album-fav' + (m.favorite ? ' on' : ''), m.favorite ? '★' : '☆');
  fav.type = 'button';
  fav.title = m.favorite ? '取消收藏' : '收藏';
  fav.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      const r = await swCall('lifeAlbumFavorite', { id: m.id });
      if (r && r.ok) { fav.textContent = r.favorite ? '★' : '☆'; fav.classList.toggle('on', !!r.favorite); }
    } catch (err) { /* ignore */ }
  });
  d.appendChild(fav);

  return d;
}

// ═══ 日程 ═══════════════════════════════════════

async function renderSchedule(host) {
  host.appendChild(loading('正在读取日程…'));

  let r = null, err = null;
  try {
    r = await swCall('lifeScheduleGet', { ownerCharacter: CURRENT_CHAR });
  } catch (e) { err = String(e); }

  host.textContent = '';
  if (err) { host.appendChild(tip('读取失败：' + err, 'bad')); return; }

  const slots = (r && Array.isArray(r.slots)) ? r.slots.slice() : [];
  const fromDefault = r && r.source === 'default';

  if (fromDefault) {
    host.appendChild(tip('当前显示的是默认安排，还没有保存到数据库。修改后点「保存」即可生效。', 'warn'));
  }

  host.appendChild(tip('日程决定角色什么时候在做什么。主动消息只在「清醒」时段发送，不会在睡眠时间打扰你。'));

  const sec = el('div', 'sec');
  sec.appendChild(el('div', 'sec-title', '一天的节奏'));

  if (!slots.length) {
    sec.appendChild(emptyBox('还没有日程', '添加第一段，例如「09:00–12:00 工作」。'));
  } else {
    slots.sort((a, b) => Number(a.startMinute) - Number(b.startMinute));
    for (const s of slots) {
      const row = el('div', 'ls-slot');
      row.appendChild(el('div', 'ls-slot-t', fmtMinute(s.startMinute) + '–' + fmtMinute(s.endMinute)));
      row.appendChild(el('div', 'ls-slot-n', (s.title || kindLabel(s.kind)) + (s.scene ? ' · ' + s.scene : '')));
      const del = btn('删', 'sm danger', () => {
        const i = slots.indexOf(s);
        if (i >= 0) { slots.splice(i, 1); pendingSlots = slots; renderLifeStudio($('#sb-content')); }
      });
      row.appendChild(del);
      sec.appendChild(row);
    }
  }

  // 添加一行
  const addRow = el('div', 'ls-field');
  addRow.appendChild(el('label', null, '新增一段'));
  const fb = el('div', 'ls-field-body');

  const r1 = el('div', 'row');
  const startIn = el('input', 'ls-input');
  startIn.type = 'time'; startIn.value = '09:00'; startIn.style.flex = '0 0 110px';
  const endIn = el('input', 'ls-input');
  endIn.type = 'time'; endIn.value = '12:00'; endIn.style.flex = '0 0 110px';
  r1.appendChild(startIn);
  r1.appendChild(el('span', null, '到'));
  r1.appendChild(endIn);
  fb.appendChild(r1);

  const titleIn = el('input', 'ls-input');
  titleIn.type = 'text';
  titleIn.placeholder = '在做什么，例如「工作」「午休」';
  fb.appendChild(titleIn);

  const addB = btn('添加', 'primary', () => {
    const st = toMinutes(startIn.value);
    const en = toMinutes(endIn.value);
    const tt = titleIn.value.trim() || '自定义';
    if (st == null || en == null) return;
    slots.push({ ownerCharacter: CURRENT_CHAR, kind: 'custom', startMinute: st, endMinute: en, daysMask: 127, title: tt });
    pendingSlots = slots;
    renderLifeStudio($('#sb-content'));
  });
  const brow = el('div', 'ls-btn-row');
  brow.appendChild(addB);
  fb.appendChild(brow);
  addRow.appendChild(fb);
  sec.appendChild(addRow);
  host.appendChild(sec);

  // 保存
  const saveSec = el('div', 'sec');
  const saveRow = el('div', 'ls-btn-row');
  const saveB = btn('保存到数据库', 'primary', async () => {
    saveB.disabled = true;
    try {
      const res = await swCall('lifeScheduleSave', { ownerCharacter: CURRENT_CHAR, slots });
      if (res && res.ok) { pendingSlots = null; renderLifeStudio($('#sb-content')); }
      else { saveB.disabled = false; alert('保存失败：' + ((res && res.error) || '未知')); }
    } catch (e) { saveB.disabled = false; alert('保存失败：' + e); }
  });
  saveRow.appendChild(saveB);
  saveSec.appendChild(saveRow);
  host.appendChild(saveSec);
}


function toMinutes(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || ''));
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (!isFinite(h) || !isFinite(mi)) return null;
  return h * 60 + mi;
}

// ═══ 主动 ═══════════════════════════════════════

/** 闸门名称 → 中文字面 */
const GATE_LABEL = {
  time: '时段',
  frequency: '频率',
  budget: '额度',
  'no-plan': '无计划',
  'not-due': '未到点',
};

async function renderProactive(host) {
  host.appendChild(loading('正在读取主动行为状态…'));

  let r = null, err = null;
  try {
    r = await swCall('lifeProactiveStatus', { ownerCharacter: CURRENT_CHAR });
  } catch (e) { err = String(e); }

  host.textContent = '';
  if (err) { host.appendChild(tip('读取失败：' + err, 'bad')); return; }
  if (!r || r.ok === false) { host.appendChild(tip('读取失败：' + ((r && r.error) || '未知原因'), 'bad')); return; }

  const plan = r.plan || {};
  const usage = r.usage || {};
  const decision = r.decision || {};
  const limits = r.limits || {};
  const freq = limits.frequency || {};
  const minutes = Array.isArray(plan.minutes) ? plan.minutes.slice() : [];

  host.appendChild(tip('主动私聊受三重闸门约束：时段 → 频率 → 额度。任何一道不通过都不会发消息，这是为了不让角色变成骚扰。'));

  // 统计
  const stats = el('div', 'ls-stats');
  stats.appendChild(stat('今日已发', usage.count != null ? usage.count : 0, '条'));
  stats.appendChild(stat('每日上限', freq.dailyMax != null ? freq.dailyMax : '—', '条'));
  stats.appendChild(stat('本小时', (usage.hourCount != null ? usage.hourCount : 0) + ' / ' + (freq.hourlyMax != null ? freq.hourlyMax : '—'), ''));
  stats.appendChild(stat('计划点', minutes.length, '个'));
  host.appendChild(stats);

  // 当前判定
  const sec = el('div', 'sec');
  sec.appendChild(el('div', 'sec-title', '当前判定'));

  if (decision.shouldAct) {
    sec.appendChild(tip('现在可以主动发消息。' + (decision.trigger && decision.trigger.hint ? '触发原因：' + decision.trigger.hint : ''), ''));
  } else {
    const by = decision.blockedBy;
    const label = GATE_LABEL[by] || '未知';
    let msg = '正在被「' + label + '」拦住：' + (decision.reason || '未给出原因');
    if (decision.nextAt) {
      const d = new Date(decision.nextAt);
      if (!isNaN(d.getTime())) {
        msg += '（' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ' 后可再试）';
      }
    }
    sec.appendChild(tip(msg, by === 'no-plan' ? 'warn' : 'warn'));
  }
  host.appendChild(sec);

  // 今日计划
  const psec = el('div', 'sec');
  psec.appendChild(el('div', 'sec-title', '今日计划点'));

  if (!minutes.length) {
    psec.appendChild(emptyBox('今天没有计划点', '计划点由作息时间表和随机种子生成。先到「日程」页配置作息，再回来点「重新生成计划」。'));
  } else {
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const tl = el('div', 'ls-tl');
    let pastCount = 0;
    for (const m of minutes) {
      const past = m < nowMin - 5;
      const near = Math.abs(m - nowMin) <= 5;
      if (past) pastCount++;
      const item = el('div', 'ls-tl-i' + (near ? ' on' : ''));
      item.appendChild(el('div', 'ls-tl-t', fmtMinute(m)));
      item.appendChild(el('div', 'ls-tl-n', near ? '即将触发' : (past ? '已过去' : '计划中')));
      tl.appendChild(item);
    }
    psec.appendChild(tl);
    if (pastCount === minutes.length) {
      psec.appendChild(el('div', 'ls-note', '今天的计划点都已过去。明天会按新的作息重新生成。'));
    }
  }
  host.appendChild(psec);

  // 立刻执行一次（手动触发，仍受频率/额度闸门约束）
  const runSec = el('div', 'sec');
  runSec.appendChild(el('div', 'sec-title', '立即执行一次'));
  runSec.appendChild(el('div', 'sec-hint', '跳过「等到计划点」，直接走一遍完整流程：生成图片 → 存进相册 → 写一条记录。仍然受频率和额度限制。'));

  const runOut = el('div');
  runOut.style.marginTop = '10px';

  const runRow = el('div', 'ls-btn-row');
  const runBtn = btn('执行一次', 'primary', async () => {
    runBtn.disabled = true;
    runOut.textContent = '';
    runOut.appendChild(el('div', 'ls-note', '正在生成，可能需要几秒…'));
    try {
      const r = await swCall('lifeProactiveRun', { ownerCharacter: CURRENT_CHAR, force: true });
      runOut.textContent = '';
      if (r && r.ok) {
        const card = el('div', 'ls-card');
        const hd = el('div', 'ls-card-h');
        hd.appendChild(el('div', 'ls-card-t', '完成：' + (r.activity && r.activity.title || '此刻')));
        hd.appendChild(tag(r.trigger === 'manual' ? '手动' : r.trigger === 'signal' ? '想起你' : '计划', 'kind'));
        card.appendChild(hd);
        card.appendChild(el('div', 'ls-card-d', '来源：' + providerLabel(r.provider) + ' · ' + Math.round((r.bytes || 0) / 1024) + 'KB'));
        card.appendChild(el('div', 'ls-card-b open', '已存入相册，并写了一条记录（编号 ' + r.eventId + '）。'));
        const ar = el('div', 'ls-card-a');
        ar.appendChild(btn('去相册看看', 'sm primary', () => { activeTab = 'album'; renderLifeStudio($('#sb-content')); }));
        ar.appendChild(btn('去日记看看', 'sm', () => { activeTab = 'diary'; renderLifeStudio($('#sb-content')); }));
        card.appendChild(ar);
        runOut.appendChild(card);
      } else if (r && r.stage === 'gate') {
        const map = { time: '时段', frequency: '频率', budget: '额度', 'no-plan': '无计划', 'not-due': '未到点' };
        runOut.appendChild(tip('被「' + (map[r.blockedBy] || r.blockedBy) + '」闸门拦住：' + (r.reason || '') + '。这是保护机制，避免短时间内发太多。', 'warn'));
      } else {
        runOut.appendChild(tip('执行失败：' + ((r && r.error) || '未知原因') + (r && r.stage ? '（阶段：' + r.stage + '）' : ''), 'bad'));
      }
    } catch (e) {
      runOut.textContent = '';
      runOut.appendChild(tip('执行失败：' + e, 'bad'));
    } finally {
      runBtn.disabled = false;
    }
  });
  runRow.appendChild(runBtn);
  runSec.appendChild(runRow);
  runSec.appendChild(runOut);
  host.appendChild(runSec);

  // 操作
  const act = el('div', 'ls-btn-row');
  act.appendChild(btn('重新生成计划', '', async () => {
    try {
      await swCall('lifeProactiveResetPlan');
      renderLifeStudio($('#sb-content'));
    } catch (e) { alert('重置失败：' + e); }
  }));
  host.appendChild(act);
}
// ═══ 图片生成设置 ═══════════════════════════════

const SOURCE_MODES = [
  { id: 'bundled-only', label: '只用素材包', hint: '不联网、不用 GPU，最省电，画质固定' },
  { id: 'bundled-then-local', label: '素材包优先，本地 SD 兜底', hint: '推荐。有合适的图用图，没有就本地生成' },
  { id: 'local-only', label: '只用本地 SD', hint: '每张都现场生成，画质更统一但更耗 GPU' },
  { id: 'cloud-first', label: '云端优先', hint: '需要配 API Key，画质最好，但会消耗额度' },
  { id: 'comfyui-first', label: '外部 ComfyUI 优先', hint: '用你自己装的 ComfyUI 出图，连不上时退回本地 SD' },
  { id: 'custom', label: '自定义顺序', hint: '完全按你自己的排序（高级）' },
];

async function renderImageSettings(host) {
  host.appendChild(loading('正在检测设备…'));

  let dev = null, cfg = null, tiers = null, probe = null, err = null;
  try {
    cfg = await swCall('imageConfigGet');
    dev = await swCall('imageDevice');
    try { tiers = await swCall('imageTiers'); } catch (e2) { tiers = null; }
    try { probe = await swCall('imageProbe'); } catch (e3) { probe = null; }
  } catch (e) { err = String(e); }

  host.textContent = '';
  if (err) { host.appendChild(tip('读取配置失败：' + err, 'bad')); return; }

  const c = (cfg && cfg.config) || {};

  // ── 设备 ──
  const dsec = el('div', 'sec');
  dsec.appendChild(el('div', 'sec-title', '这台电脑'));

  if (dev && dev.ok) {
    const s = el('div', 'ls-stats');
    const p = dev.profile || {};
    const gpuName = p.primaryGpu ? String(p.primaryGpu.name || '')
      .replace(/NVIDIA\s+/i, '').replace(/GeForce\s+/i, '')
      .replace(/Laptop GPU/i, '').replace(/\s+Graphics/i, '').trim() : '';
    const gpuVram = p.primaryGpu && p.primaryGpu.vramMb ? Math.round(p.primaryGpu.vramMb / 1024) + ' GB' : '';
    if (gpuName) {
      s.appendChild(stat('显卡 · ' + gpuName, gpuVram || '显存未知', ''));
    } else {
      s.appendChild(stat('显卡', '无独显', ''));
    }
    s.appendChild(stat('内存', Math.round((p.ramMb || 0) / 1024), 'GB'));
    if (p.disk) s.appendChild(stat('磁盘可用', p.disk.freeGb, 'GB'));
    dsec.appendChild(s);

    dsec.appendChild(el('div', 'ls-note', dev.summary || ''));

    const rec = dev.recommendation || {};
    if (rec.reason) dsec.appendChild(el('div', 'ls-note', '推荐档位：' + rec.reason));

    // 档位列表（优先用 imageTiers，带内置标记与原因）
    let tl = (tiers && Array.isArray(tiers.tiers)) ? tiers.tiers : (rec.tiers || []);
    if (tl.length) {
      const tbox = el('div');
      tbox.style.marginTop = '10px';
      for (const t of tl) {
        const canRun = t.usable != null ? t.usable : !!t.canRun;
        const row = el('div', 'ls-tier' + (canRun ? ' usable' : ''));
        const n = el('div', 'ls-tier-n', t.label || t.tier);
        let reason = t.reason;
        if (!reason) {
          if (t.deviceOk === false && t.minVramMb > 0) {
            reason = '需要 ' + Math.round(t.minVramMb / 1024) + 'GB 显存 / ' + Math.round(t.minRamMb / 1024) + 'GB 内存';
          } else if (t.modelOk === false) {
            reason = '模型文件未下载';
          }
        }
        if (reason) n.appendChild(el('div', 'ls-tier-r', reason));
        else n.appendChild(el('div', 'ls-tier-r',
          '需要 ' + Math.round((t.minVramMb || 0) / 1024) + 'GB 显存 / ' + Math.round((t.minRamMb || 0) / 1024) + 'GB 内存'));
        row.appendChild(n);
        if (t.bundled) row.appendChild(tag('随包提供', 'bundled'));
        row.appendChild(tag(canRun ? '可运行' : '不可运行', canRun ? 'ok' : 'no'));
        tbox.appendChild(row);
      }
      dsec.appendChild(tbox);
    }

    const rrow = el('div', 'ls-btn-row');
    rrow.appendChild(btn('重新检测', '', async () => {
      try { await swCall('imageDeviceRefresh'); renderLifeStudio($('#sb-content')); } catch (e) { /* ignore */ }
    }));
    dsec.appendChild(rrow);
  } else {
    dsec.appendChild(tip('设备检测失败：' + ((dev && dev.error) || '未知'), 'warn'));
  }
  host.appendChild(dsec);

  // ── 素材包 ──
  if (probe && probe.ok && probe.pack) {
    const psec = el('div', 'sec');
    psec.appendChild(el('div', 'sec-title', '内置素材包'));
    const ps = el('div', 'ls-stats');
    ps.appendChild(stat('图片数量', probe.pack.total || 0, '张'));
    ps.appendChild(stat('可安全读取', probe.pack.readable != null ? probe.pack.readable : (probe.pack.total || 0), '张'));
    psec.appendChild(ps);
    if (!probe.pack.total) {
      psec.appendChild(tip('素材包还没生成。这不影响使用——本地 SD 和云端都能出图，最差也会用占位图。', 'warn'));
    }
    host.appendChild(psec);
  }

  // ── 图片来源 ──
  const ssec = el('div', 'sec');
  ssec.appendChild(el('div', 'sec-title', '图片来源'));
  ssec.appendChild(el('div', 'sec-hint', '决定角色发图时优先用哪种方式。默认是「素材包优先，本地 SD 兜底」。'));

  const curMode = c.sourceMode || 'bundled-then-local';
  const chips = el('div', 'chips');
  for (const m of SOURCE_MODES) {
    const b = el('button', 'chip' + (m.id === curMode ? ' on' : ''), m.label);
    b.type = 'button';
    b.title = m.hint;
    b.addEventListener('click', async () => {
      const res = await swCall('imageConfigSet', { sourceMode: m.id });
      if (res && res.ok) renderLifeStudio($('#sb-content'));
    });
    chips.appendChild(b);
  }
  ssec.appendChild(chips);

  const curHint = SOURCE_MODES.find((m) => m.id === curMode);
  if (curHint) ssec.appendChild(el('div', 'ls-note', curHint.hint));
  host.appendChild(ssec);

  // ── 本地 SD ──
  const lsec = el('div', 'sec');
  lsec.appendChild(el('div', 'sec-title', '本地 SD（stable-diffusion.cpp）'));

  const lsd = c.localSd || {};
  const lEnable = el('label', 'switch');
  const lChk = document.createElement('input');
  lChk.type = 'checkbox';
  lChk.checked = lsd.enabled !== false;
  lChk.addEventListener('change', async () => {
    await swCall('imageConfigSet', { localSd: { enabled: lChk.checked } });
  });
  lEnable.appendChild(lChk);
  lEnable.appendChild(el('span', null, '启用本地生成'));
  lsec.appendChild(lEnable);

  lsec.appendChild(el('div', 'ls-note', '本机 512×512、12 步实测约 5.7 秒（RTX 4050）。模型随安装包提供，无需下载。'));
  host.appendChild(lsec);

  // ── 云端 ──
  const cl = c.cloud || {};
  const csec = el('div', 'sec');
  csec.appendChild(el('div', 'sec-title', '云端生成（可选）'));
  csec.appendChild(el('div', 'sec-hint', '不配置也能用，配置后画质更好但会消耗免费额度。'));

  // 供应商
  const provRow = el('div', 'ls-field');
  provRow.appendChild(el('label', null, '服务商'));
  const provBody = el('div', 'ls-field-body');
  const provSel = el('select', 'sel');
  for (const [id, label] of [['cloudflare', 'Cloudflare Workers AI（免费 230 张/天）'], ['modelscope', 'ModelScope 魔搭'], ['openai-compatible', '其他 OpenAI 兼容服务']]) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = label;
    if ((cl.provider || 'cloudflare') === id) o.selected = true;
    provSel.appendChild(o);
  }
  provSel.addEventListener('change', async () => {
    await swCall('imageConfigSet', { cloud: { provider: provSel.value } });
    renderLifeStudio($('#sb-content'));
  });
  provBody.appendChild(provSel);
  provRow.appendChild(provBody);
  csec.appendChild(provRow);

  // 字段
  const fields = [];
  if ((cl.provider || 'cloudflare') === 'cloudflare') {
    fields.push({ key: 'accountId', label: 'Account ID', ph: 'Cloudflare 控制台右下角', type: 'text' });
    fields.push({ key: 'apiKey', label: 'API Token', ph: '留空表示不修改', type: 'password' });
  } else if (cl.provider === 'modelscope') {
    fields.push({ key: 'apiKey', label: 'API Key', ph: '留空表示不修改', type: 'password' });
  } else {
    fields.push({ key: 'baseUrl', label: '服务地址', ph: 'https://api.example.com/v1', type: 'text' });
    fields.push({ key: 'model', label: '模型名', ph: '例如 Kwai-Kolors/Kolors', type: 'text' });
    fields.push({ key: 'apiKey', label: 'API Key', ph: '留空表示不修改', type: 'password' });
  }

  const inputs = {};
  for (const f of fields) {
    const row = el('div', 'ls-field');
    row.appendChild(el('label', null, f.label));
    const body = el('div', 'ls-field-body');
    const inp = el('input', 'ls-input');
    inp.type = f.type;
    inp.placeholder = f.ph || '';
    inp.autocomplete = 'off';
    if (f.key === 'apiKey') {
      inp.value = '';
    } else {
      inp.value = String(cl[f.key] || '');
    }
    inputs[f.key] = inp;
    body.appendChild(inp);
    if (f.key === 'apiKey' && cl.hasKey) {
      body.appendChild(el('div', 'ls-note', '已保存 Key（不再显示）。留空表示保持不变。'));
    }
    row.appendChild(body);
    csec.appendChild(row);
  }

  const crow = el('div', 'ls-btn-row');
  const saveC = btn('保存云端配置', 'primary', async () => {
    const cloud = {};
    for (const k of Object.keys(inputs)) {
      const v = inputs[k].value.trim();
      if (k === 'apiKey' && !v) continue;
      cloud[k] = v;
    }
    const res = await swCall('imageConfigSet', { cloud });
    if (res && res.ok) renderLifeStudio($('#sb-content'));
  });
  crow.appendChild(saveC);
  crow.appendChild(btn('测试连接', '', async () => {
    try {
      const r = await swCall('imageCloudTest');
      alert(r && r.ok ? '连接正常' + (r.freePerDay ? '，免费额度约 ' + r.freePerDay + ' 张/天' : '') : '连接失败：' + ((r && r.error) || '未知'));
    } catch (e) { alert('测试失败：' + e); }
  }));
  csec.appendChild(crow);
  host.appendChild(csec);

  // ── ComfyUI ──
  const cmf = c.comfyui || {};
  const msec = el('div', 'sec');
  msec.appendChild(el('div', 'sec-title', '外部 ComfyUI（高级）'));
  msec.appendChild(el('div', 'sec-hint', '如果你已经装了 ComfyUI，可以让 SoulWeave 调用它。没装就保持关闭，不影响其他功能。'));

  const mEn = el('label', 'switch');
  const mChk = document.createElement('input');
  mChk.type = 'checkbox';
  mChk.checked = !!cmf.enabled;
  mChk.addEventListener('change', async () => {
    await swCall('imageConfigSet', { comfyui: { enabled: mChk.checked } });
  });
  mEn.appendChild(mChk);
  mEn.appendChild(el('span', null, '启用 ComfyUI'));
  msec.appendChild(mEn);

  const epRow = el('div', 'ls-field');
  epRow.appendChild(el('label', null, '服务地址'));
  const epBody = el('div', 'ls-field-body');
  const epIn = el('input', 'ls-input');
  epIn.type = 'text';
  epIn.placeholder = 'http://127.0.0.1:8188';
  epIn.value = String(cmf.endpoint || '');
  epBody.appendChild(epIn);
  epRow.appendChild(epBody);
  msec.appendChild(epRow);

  const mrow = el('div', 'ls-btn-row');
  mrow.appendChild(btn('保存地址', '', async () => {
    await swCall('imageConfigSet', { comfyui: { endpoint: epIn.value.trim() } });
    renderLifeStudio($('#sb-content'));
  }));
  mrow.appendChild(btn('测试连接', '', async () => {
    try {
      const r = await swCall('imageComfyuiTest', { endpoint: epIn.value.trim() });
      alert(r && r.ok ? '连接正常' : '连接失败：' + ((r && r.error) || '未知'));
    } catch (e) { alert('测试失败：' + e); }
  }));
  mrow.appendChild(btn('查看安装引导', '', async () => {
    try {
      const r = await swCall('imageComfyuiGuide');
      if (r && r.ok && r.guide) {
        alert(r.guide.title + '\n\n' + (r.guide.steps || []).join('\n'));
      }
    } catch (e) { /* ignore */ }
  }));
  msec.appendChild(mrow);
  host.appendChild(msec);

  // ── 试生成 ──
  const testSec = el('div', 'sec');
  testSec.appendChild(el('div', 'sec-title', '试一下'));
  testSec.appendChild(el('div', 'sec-hint', '用当前设置生成一张，确认链路通不通。'));

  const preview = el('div');
  preview.style.marginTop = '10px';

  const trow = el('div', 'ls-btn-row');
  const genBtn = btn('试生成一张', 'primary', async () => {
    genBtn.disabled = true;
    preview.textContent = '';
    preview.appendChild(el('div', 'ls-note', '正在生成，首次可能要十几秒…'));
    try {
      const r = await swCall('imageGenerate', {
        prompt: 'a cozy room with warm light, anime style',
        character: CURRENT_CHAR, activityKind: 'rest',
      });
      preview.textContent = '';
      if (r && r.ok) {
        const img = document.createElement('img');
        img.src = 'data:' + (r.mime || 'image/png') + ';base64,' + r.base64;
        img.alt = '生成结果';
        img.style.cssText = 'width:200px;height:200px;object-fit:cover;border-radius:9px;border:1px solid var(--sb-line)';
        preview.appendChild(img);
        preview.appendChild(el('div', 'ls-note', '来源：' + providerLabel(r.used) + ' · ' + Math.round((r.bytes || 0) / 1024) + 'KB'));
      } else if (r && r.code === 'IGPU_ONLY') {
        const go = await modal({
          title: '本地生成不可用',
          body: '这台电脑只有集成显卡。stable-diffusion.cpp 在核显上会稳定崩溃，所以本地 SD 无法使用。',
          detail: '建议切到「素材包优先」：用内置图片，需要时再由本地 SD 兜底。',
          actions: [
            { label: '切换到「素材包优先」', value: 'switch', primary: true },
            { label: '保持当前设置', value: 'keep' },
          ],
        });
        if (go === 'switch') {
          await swCall('imageConfigSet', { sourceMode: 'bundled-then-local', localSd: { enabled: false } });
          renderLifeStudio($('#sb-content'));
          return;
        }
        preview.appendChild(el('div', 'ls-note', '已保持当前设置。生成会失败，你可以随时回来切换。'));
      } else {
        preview.appendChild(tip('生成失败：' + ((r && r.error) || '未知原因'), 'bad'));
        const tries = (r && r.attempts) || [];
        if (tries.length) {
          const txt = tries.map((a) => providerLabel(a.id) + (a.ok ? ' ✓' : ' ✗ ' + (a.skipped || a.error || ''))).join(' → ');
          preview.appendChild(el('div', 'ls-note', '尝试过程：' + txt));
        }
      }
    } catch (e) {
      preview.textContent = '';
      preview.appendChild(tip('生成失败：' + e, 'bad'));
    } finally {
      genBtn.disabled = false;
    }
  });
  trow.appendChild(genBtn);
  testSec.appendChild(trow);
  testSec.appendChild(preview);
  host.appendChild(testSec);

  // ── 诊断 ──
  const diagSec = el('div', 'sec');
  diagSec.appendChild(el('div', 'sec-title', '诊断与修复'));
  diagSec.appendChild(el('div', 'sec-hint', '检查配置和设备，把「出不了图」翻译成具体原因和修法。'));

  const diagBody = el('div');

  const drow = el('div', 'ls-btn-row');
  const diagBtn = btn('开始诊断', 'primary', async () => {
    diagBtn.disabled = true;
    diagBody.textContent = '';
    diagBody.appendChild(loading('正在检查…'));
    try {
      const r = await swCall('imageDiagnose');
      diagBody.textContent = '';
      if (!r || !r.ok) {
        diagBody.appendChild(tip('诊断失败：' + ((r && r.summary) || '未知'), 'bad'));
        return;
      }
      diagBody.appendChild(el('div', 'ls-note', r.summary));
      for (const f of (r.findings || [])) {
        const card = el('div', 'ls-card');
        const hd = el('div', 'ls-card-h');
        hd.appendChild(el('div', 'ls-card-t', f.title));
        hd.appendChild(tag(
          f.severity === 'error' ? '需要处理' : f.severity === 'warn' ? '建议' : '提示',
          f.severity === 'error' ? 'no' : f.severity === 'warn' ? 'fictional' : 'kind'
        ));
        card.appendChild(hd);
        card.appendChild(el('div', 'ls-card-b open', f.detail));
        if (f.fixes && f.fixes.length) {
          const fr = el('div', 'ls-card-a');
          for (const fx of f.fixes) {
            fr.appendChild(btn(fx.label, 'sm primary', async () => {
              const res2 = await swCall('imageFix', { action: fx.action, payload: fx.payload || {} });
              if (res2 && res2.ok) renderLifeStudio($('#sb-content'));
              else alert('修复失败：' + ((res2 && res2.error) || '未知'));
            }));
          }
          card.appendChild(fr);
        }
        diagBody.appendChild(card);
      }

      // 复制报告
      const rrow2 = el('div', 'ls-btn-row');
      rrow2.appendChild(btn('复制诊断报告', '', async () => {
        try {
          await navigator.clipboard.writeText(r.report || '');
          alert('报告已复制。可以粘贴到任意 AI 助手（包括你本地的 Agent）里请它分析。');
        } catch (e) {
          alert('复制失败，请在控制台查看报告：\\n' + String(e));
          console.log(r.report);
        }
      }));
      diagBody.appendChild(rrow2);
    } catch (e) {
      diagBody.textContent = '';
      diagBody.appendChild(tip('诊断失败：' + e, 'bad'));
    } finally {
      diagBtn.disabled = false;
    }
  });
  drow.appendChild(diagBtn);
  diagSec.appendChild(drow);
  diagSec.appendChild(diagBody);
  host.appendChild(diagSec);

  // ── 进阶项折叠 ──
  //
  // 【为什么折叠】
  // 这一页原本有 16 个区块一路铺到底：本地 SD 模型名、ComfyUI 端口、诊断报告……
  // 绝大多数人每次进来只是想看「今天她做了什么」。这些配置不是不重要，
  // 是**不该和今天的动态抢第一屏**。收进一个折叠区，标题写清楚里面有什么。
  try {
    // 只收"配置项"。图片来源（选哪种出图方式）和试一下（立刻看到效果）
    // 是这个页面的主线，收进去等于把功能藏了。
    const ADV = [
      '这台电脑', '内置素材包', '本地 SD（stable-diffusion.cpp）',
      '云端生成（可选）', '外部 ComfyUI（高级）', '诊断与修复',
    ];
    const all = Array.from(host.children).filter((n) => n.classList && n.classList.contains('sec'));
    const advSecs = all.filter((s) => {
      const tt = s.querySelector('.sec-title');
      return tt && ADV.includes(String(tt.textContent || '').trim());
    });
    if (advSecs.length >= 3) {
      const fold = document.createElement('details');
      fold.className = 'sec fold';
      const sum = document.createElement('summary');
      sum.className = 'fold-sum';
      sum.appendChild(el('span', 'fold-title', '素材与生成设置'));
      sum.appendChild(el('span', 'fold-hint', '图片来源 · 本地 SD · 云端 · ComfyUI · 诊断（' + advSecs.length + ' 项）'));
      fold.appendChild(sum);
      const body = el('div', 'fold-body');
      fold.appendChild(body);
      // 先把自己插到原位置，再把子区块搬进来：
      // 反过来会先让子区块脱离 host，insertBefore 的参照节点就不在树上了。
      const firstAdv = advSecs[0];
      host.insertBefore(fold, firstAdv);
      for (const s of advSecs) {
        // 折叠区里的子区块不再画自己的卡片边框，避免"卡中卡"
        s.classList.add('sec-plain');
        body.appendChild(s);
      }
    }
  } catch (e) { /* 折叠失败就保持原样，不影响功能 */ }
}