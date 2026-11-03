/**
 * SoulWeave：角色管理（第 13 个功能模块）
 *
 * 这个模块只有一个职责：**决定「哪个角色，用哪个 QQ 号，发给谁」**。
 * 创建角色、改名、休眠是配角；绑定才是主角。
 *
 * 【为什么重做】
 * 上一版只有三个复选框（QQ 私聊 / QQ 群 / Live2D），
 * 用户的原话是「我怎么把 QQ 绑到小橘子，找不到绑定按钮」。
 * 这不是按钮藏起来了 —— 是数据层压根没有「哪个账号、发给谁」这两个字段，
 * 界面再怎么写也长不出真正的绑定。
 *
 * 现在每个角色卡里都有：
 *   账号下拉（来自真实登录的 OneBot 账号，带在线状态）
 *   私聊 / 群 二选一
 *   对象选择（真实好友列表 / 群列表，可搜索）
 *   测试发送（等真实回执，显示 retcode 与 message_id）
 *
 * 互斥规则：一个 QQ 账号同时只服务一个角色，冲突时界面明确提示谁被释放了。
 */

import { brandIcon } from './icons.js';

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

function iconBtn(label, title, cls, onClick) {
  const b = el('button', 'ls-btn' + (cls ? ' ' + cls : ''), label);
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
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

const KIND_LABEL = { local_dsh: '本地 Agent', cloud_api: '云端 API' };
const PROTECT_LABEL = { fixed_protected: '固定保护', default_protected: '默认保护', normal: '普通' };

// ─── 简易弹窗（不依赖外部框架） ───────────────────────

function openModal(title, buildBody, opts = {}) {
  const mask = el('div', 'roster-mask');
  const box = el('div', 'roster-modal');
  const head = el('div', 'roster-modal-head');
  head.appendChild(el('div', 'roster-modal-title', title));
  const close = iconBtn('✕', '关闭', 'ghost roster-modal-x', () => mask.remove());
  head.appendChild(close);
  box.appendChild(head);

  const body = el('div', 'roster-modal-body');
  box.appendChild(body);
  buildBody(body);
  mask.appendChild(box);

  mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
  const onKey = (e) => { if (e.key === 'Escape') { mask.remove(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  if (opts.wide) box.classList.add('wide');
  document.body.appendChild(mask);
  return { mask, body, close: () => mask.remove() };
}

/** 真实回执 → 人能读的一行结论 */
function receiptBox(r) {
  const ok = !!(r && r.ok);
  const box = el('div', 'roster-receipt ' + (ok ? 'ok' : 'bad'));
  const head = el('div', 'roster-receipt-h');
  head.appendChild(el('span', 'roster-receipt-dot'));
  head.appendChild(el('span', null, ok ? '已送达 QQ' : '没发出去'));
  box.appendChild(head);

  const rows = [];
  if (ok) {
    if (r.messageId) rows.push('消息 ID：' + r.messageId);
    rows.push('retcode：' + (r.retcode === 0 ? '0' : String(r.retcode)));
    if (r.character) rows.push('发送者：' + r.character);
    if (r.accountLabel) rows.push('账号：' + r.accountLabel);
  } else {
    rows.push('原因：' + (r && (r.error || ('retcode ' + (r && r.retcode)))));
    if (r && r.selfTarget) rows.push('注意：目标是机器人自己，QQ 不会投递给「自己」');
  }
  if (r && r.warning) rows.push(r.warning);
  for (const line of rows) box.appendChild(el('div', 'roster-receipt-r', line));
  return box;
}

// ─── 主渲染 ─────────────────────────────────────────

export async function renderRoster(host, rerender) {
  host.textContent = '';
  host.appendChild(loading('正在读取角色名册…'));

  const [data, accRes] = await Promise.all([
    window.soulweave.rosterList().catch((e) => ({ ok: false, error: String(e) })),
    window.soulweave.rosterAccounts().catch((e) => ({ ok: false, error: String(e), accounts: [] })),
  ]);

  host.textContent = '';
  if (!data || !data.ok) {
    host.appendChild(tip('读取失败：' + ((data && data.error) || '未知'), 'bad'));
    return;
  }

  const chars = data.characters || [];
  // 预取形象清单，供每个角色的下拉使用（一次请求，避免 N 次）
  try {
    const lr = await window.soulweave.live2dList();
    window.__live2dModels = (lr && lr.models) || [];
  } catch (e) { window.__live2dModels = []; }
  const trashed = data.trashed || [];
  const sum = data.summary || {};
  const accounts = (accRes && accRes.accounts) || [];
  const go = () => (rerender ? rerender() : renderRoster(host, rerender));

  // ── 概览 ──
  const statSec = el('div', 'sec');
  statSec.appendChild(el('div', 'sec-title', '概览'));
  const stats = el('div', 'ls-stats');
  const mkStat = (k, v, u, cls) => {
    const s = el('div', 'ls-stat' + (cls ? ' ' + cls : ''));
    s.appendChild(el('div', 'ls-stat-k', k));
    const vv = el('div', 'ls-stat-v', String(v));
    if (u) vv.appendChild(el('span', 'ls-stat-u', u));
    s.appendChild(vv);
    return s;
  };
  stats.appendChild(mkStat('角色总数', chars.length, '个'));
  stats.appendChild(mkStat('已绑 QQ', sum.qqBound || 0, '个', 'hot'));
  stats.appendChild(mkStat('绑 Live2D', sum.live2d || 0, '个'));
  stats.appendChild(mkStat('未绑定', sum.unbound || 0, '个'));
  statSec.appendChild(stats);

  if (!accounts.length) {
    statSec.appendChild(tip('还没有任何 QQ 账号连上来。先去「社交」把 QQ 登上，这里才能选账号。', 'warn'));
  }
  if ((sum.unbound || 0) > 0) {
    statSec.appendChild(tip('有 ' + sum.unbound + ' 个角色没有绑定 QQ 也没有 Live2D，它们只存在于名册里。', 'warn'));
  }
  host.appendChild(statSec);

  // ── 角色清单 ──
  const listSec = el('div', 'sec');
  const listTitle = el('div', 'sec-title', '角色清单');
  listSec.appendChild(listTitle);
  listSec.appendChild(el('div', 'sec-hint', '每个角色独立绑定：一个 QQ 账号同一时间只服务一个角色。没绑 QQ 就选「不绑定」，它只在 Live2D 里出现。'));
  for (const c of chars) listSec.appendChild(characterCard(c, go, accounts));
  host.appendChild(listSec);

  // ── 新建角色 ──
  host.appendChild(createSection(data.limits || {}, go));

  // ── 回收站 ──
  if (trashed.length) {
    const tSec = el('div', 'sec');
    tSec.appendChild(el('div', 'sec-title', '回收站（' + trashed.length + '）'));
    for (const c of trashed) {
      const row = el('div', 'ls-slot');
      row.appendChild(el('div', 'ls-slot-n', c.name));
      row.appendChild(btn('恢复', 'sm', async () => {
        const r = await window.soulweave.rosterRestore({ id: c.id });
        if (r && r.ok) go(); else alert('恢复失败：' + ((r && r.error) || '未知'));
      }));
      tSec.appendChild(row);
    }
    host.appendChild(tSec);
  }
}

// ─── 角色卡片 ───────────────────────────────────────

function avatar(c) {
  const d = el('div', 'roster-avatar' + (c.kind === 'local_dsh' ? ' local' : ' cloud'));
  d.textContent = String(c.name || '?').slice(0, 1);
  return d;
}

function characterCard(c, go, accounts) {
  const card = el('div', 'roster-card ' + (c.kind === 'local_dsh' ? 'local' : 'cloud'));

  const head = el('div', 'roster-head');
  head.appendChild(avatar(c));
  const info = el('div', 'roster-info');
  const nameRow = el('div', 'roster-name-row');
  nameRow.appendChild(el('span', 'roster-name', c.name));
  nameRow.appendChild(el('span', 'roster-kind ' + (c.kind === 'local_dsh' ? 'local' : 'cloud'), KIND_LABEL[c.kind] || c.kind));
  if (c.protection !== 'normal') nameRow.appendChild(el('span', 'roster-protect', PROTECT_LABEL[c.protection] || c.protection));
  if (c.state === 'sleeping') nameRow.appendChild(el('span', 'roster-protect sleep', '休眠中'));
  info.appendChild(nameRow);
  if (c.note) info.appendChild(el('div', 'roster-note', c.note));
  head.appendChild(info);

  if (c.kind === 'cloud_api') {
    const wrap = el('span', 'roster-provider');
    const m = el('span', 'brand-mark sm');
    m.innerHTML = brandIcon(c.cloudProviderId || 'custom', 15);
    m.title = c.cloudProviderId || '';
    wrap.appendChild(m);
    head.appendChild(wrap);
  }
  card.appendChild(head);

  // ★ 核心：QQ 绑定面板
  card.appendChild(qqPanel(c, go, accounts));

  // Live2D 形象绑定：选哪个形象的/不显示（形象在「形象」面板里管理）
  const l2d = el('div', 'roster-persona');
  const l2dRow = el('div', 'persona-row');
  l2dRow.appendChild(el('label', null, 'Live2D 形象'));
  const sel = document.createElement('select');
  sel.className = 'ls-input';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '不显示形象';
  sel.appendChild(none);
  for (const m of (window.__live2dModels || [])) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.name + (m.visible ? '' : '（已隐藏）');
    sel.appendChild(o);
  }
  sel.value = c.live2dModelId || '';
  sel.addEventListener('change', async () => {
    const r = await window.soulweave.live2dBind({ characterId: c.id, modelId: sel.value || null });
    if (!r || !r.ok) { alert('保存失败：' + ((r && r.error) || '未知')); return; }
    toast(sel.value ? '已绑定形象' : '已设为不显示形象');
    go();
  });
  l2dRow.appendChild(sel);
  l2d.appendChild(l2dRow);
  card.appendChild(l2d);

  // 人格卡：tagline / 性格标签 / 说话风格 / 补充设定
  const p = c.persona || {};
  const pbox = el('div', 'roster-persona');
  const phead = el('div', 'row');
  phead.appendChild(el('div', 'cmp-nm', '人格卡'));
  // 人格卡编辑器：内联表单，不再用 4 个连续的 prompt() 弹窗。
  //
  // 【为什么改】
  // 用户反馈"没找到人格卡在哪"。原来入口是一个很小的「编辑」按钮，
  // 点开还是 4 个 prompt 弹窗——既难找，也不知道一共几项。
  // 现在：按钮就在人格卡标题旁，点开是 4 个字段的表单，能看见全貌。
  const pform = el('div', 'persona-form');
  pform.hidden = true;
  const mkField = (label, hint, node) => {
    const row = el('div', 'persona-field');
    const lb = el('label', null, label);
    if (hint) lb.appendChild(el('span', 'persona-hint', hint));
    row.appendChild(lb);
    row.appendChild(node);
    return row;
  };
  const fTagline = el('input', 'ls-input');
  fTagline.type = 'text';
  fTagline.maxLength = 40;
  fTagline.placeholder = '例如：住在你电脑里的小糖罐';
  fTagline.value = p.tagline || '';
  const fTraits = el('input', 'ls-input');
  fTraits.type = 'text';
  fTraits.placeholder = '3–6 个词，用逗号分隔：黏人，爱吃糖，怕黑';
  fTraits.value = (p.traits || []).join('，');
  const fTone = el('input', 'ls-input');
  fTone.type = 'text';
  fTone.placeholder = '例如：短句、爱用感叹号、偶尔撒娇';
  fTone.value = p.tone || '';
  const fNotes = el('textarea', 'ls-textarea');
  fNotes.placeholder = '口癖、喜好、忌讳，或任何你希望她记住的设定';
  fNotes.value = p.notes || '';

  pform.appendChild(mkField('一句话介绍', '会出现在对话与名片里', fTagline));
  pform.appendChild(mkField('性格关键词', '最多 6 个', fTraits));
  pform.appendChild(mkField('说话风格', '', fTone));
  pform.appendChild(mkField('补充设定', '', fNotes));

  const pacts = el('div', 'ls-btn-row');
  const psave = btn('保存人格卡', 'primary', async () => {
    psave.disabled = true;
    try {
      const res = await window.soulweave.rosterUpdate({
        id: c.id,
        persona: {
          tagline: fTagline.value.trim(),
          tone: fTone.value.trim(),
          notes: fNotes.value.trim(),
          traits: String(fTraits.value || '').split(/[,，、;；\s]+/).filter(Boolean).slice(0, 6),
        },
      });
      if (!res || !res.ok) { alert('保存失败：' + ((res && res.error) || '未知')); return; }
      toast('人格卡已保存');
      go();
    } finally { psave.disabled = false; }
  });
  const pcancel = btn('取消', '', () => {
    pform.hidden = true;
    pedit.textContent = '编辑人格卡';
  });
  pacts.appendChild(psave);
  pacts.appendChild(pcancel);
  pform.appendChild(pacts);

  const pedit = btn(p.tagline ? '编辑人格卡' : '填写人格卡', 'sm', () => {
    pform.hidden = !pform.hidden;
    pedit.textContent = pform.hidden ? '编辑人格卡' : '收起';
    if (!pform.hidden) fTagline.focus();
  });
  phead.appendChild(pedit);
  pbox.appendChild(phead);
  pbox.appendChild(pform);
  if (p.tagline) pbox.appendChild(el('div', 'roster-note', p.tagline));
  if (p.traits && p.traits.length) {
    const tags = el('div', 'chips');
    for (const tr of p.traits) tags.appendChild(el('span', 'tag-chip', tr));
    pbox.appendChild(tags);
  }
  if (p.tone) pbox.appendChild(el('div', 'cmp-w', '口吻：' + p.tone));
  if (p.notes) pbox.appendChild(el('div', 'cmp-w', p.notes));
  if (!p.tagline && !(p.traits || []).length && !p.tone && !p.notes) {
    pbox.appendChild(el('div', 'cmp-w', '还没有填人格卡。写几句"她是什么样的人"，对话时会更像她。'));
  }
  card.appendChild(pbox);

  // Live2D
  const live = el('label', 'roster-bind roster-live');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!(c.bindings && c.bindings.live2d);
  cb.addEventListener('change', async () => {
    const r = await window.soulweave.rosterBind({ id: c.id, bindings: { live2d: cb.checked } });
    if (!r || !r.ok) { cb.checked = !cb.checked; alert('保存失败：' + ((r && r.error) || '未知')); }
    else go();
  });
  live.appendChild(cb);
  live.appendChild(el('span', null, '在 Live2D 桌宠里出现'));
  card.appendChild(live);

  // 云端角色：独立密钥
  if (c.kind === 'cloud_api') card.appendChild(cloudPanel(c, go));

  // 操作
  const acts = el('div', 'roster-acts');
  acts.appendChild(btn(c.state === 'sleeping' ? '唤醒' : '休眠', 'sm', async () => {
    const r = await window.soulweave.rosterSetState({ id: c.id, state: c.state === 'sleeping' ? 'active' : 'sleeping' });
    if (r && r.ok) go(); else alert('操作失败：' + ((r && r.error) || '未知'));
  }));
  acts.appendChild(btn('改名', 'sm', async () => {
    const next = prompt('新的名字（最多 24 字）', c.name);
    if (next == null) return;
    const r = await window.soulweave.rosterUpdate({ id: c.id, name: next.trim() });
    if (r && r.ok) go(); else alert('改名失败：' + ((r && r.error) || '未知'));
  }));
  if (c.protection === 'normal') {
    acts.appendChild(btn('移入回收站', 'sm danger', async () => {
      if (!confirm('把「' + c.name + '」移入回收站？QQ 绑定会一并清空。')) return;
      const r = await window.soulweave.rosterTrash({ id: c.id });
      if (r && r.ok) go(); else alert('删除失败：' + ((r && r.error) || '未知'));
    }));
  }
  card.appendChild(acts);
  return card;
}

// ─── QQ 绑定面板（这个模块存在的原因） ───────────────

function qqPanel(c, go, accounts) {
  const wrap = el('div', 'roster-qq');
  const head = el('div', 'roster-qq-head');
  head.appendChild(el('span', 'roster-qq-title', 'QQ 绑定'));

  // 只要绑了账号就算「已绑定」——发给谁由社交白名单决定，不再是这里的必要条件
  const bound = !!(c.qq && c.qq.accountLabel);
  const status = el('span', 'roster-qq-status ' + (bound ? 'on' : 'off'));
  status.appendChild(el('span', 'roster-qq-dot'));
  status.appendChild(el('span', null, bound ? '已绑定' : '未绑定'));
  head.appendChild(status);

  if (bound) {
    const acc = accounts.find((a) => a.label === c.qq.accountLabel);
    const online = acc && acc.online;
    head.appendChild(el('span', 'roster-qq-online ' + (online ? 'on' : 'off'),
      online ? '账号在线' : '账号离线'));
  }
  wrap.appendChild(head);

  // 已绑定时给一行摘要：谁的号 → 发到哪（目标来自「社交 → 白名单」）
  if (bound) {
    const sum = el('div', 'roster-qq-sum');
    const arrow = el('div', 'roster-qq-route');
    arrow.appendChild(el('span', 'roster-qq-acct', c.qq.accountLabel));
    arrow.appendChild(el('span', 'roster-qq-arrow', '→'));
    if (c.route) {
      arrow.appendChild(el('span', 'roster-qq-target',
        (c.route.kind === 'group' ? '群 ' : '好友 ') + c.route.id));
      arrow.appendChild(el('span', 'roster-qq-tid',
        c.route.source === 'whitelist' ? '来自白名单' : '旧配置'));
    } else {
      arrow.appendChild(el('span', 'roster-qq-target', '还没有可发对象'));
    }
    sum.appendChild(arrow);
    wrap.appendChild(sum);
    if (!c.route) {
      wrap.appendChild(tip('这个账号的白名单是空的（或没设群），所以没地方发。去「社交 → 谁能触发」加一个主号或群。', 'warn'));
    }
  }

  // 按钮行
  const row = el('div', 'roster-qq-acts');
  if (!accounts.length) {
    row.appendChild(el('span', 'roster-qq-empty', '还没有连上的 QQ 账号，先去「社交」登录'));
  } else {
    row.appendChild(btn(bound ? '更换账号…' : '选择 QQ 号…', bound ? 'sm' : 'primary sm', () => {
      openModal((bound ? '换绑：' : '绑定：') + c.name, (body) => buildBindForm(body, c, accounts, go), { wide: true });
    }));

    if (bound) {
      row.appendChild(btn('测试发送', 'sm', async () => {
        const out = el('div', 'roster-qq-out');
        row.appendChild(out);
        out.appendChild(loading('正在发送并等待 QQ 回执…'));
        const r = await window.soulweave.rosterPushTest({ id: c.id });
        out.textContent = '';
        out.appendChild(receiptBox(r));
        if (r && r.ok && !r.selfTarget) out.appendChild(el('div', 'roster-qq-hint', '去 QQ 看看有没有收到这条。'));
      }));
      row.appendChild(btn('解绑', 'sm ghost', async () => {
        if (!confirm('解除「' + c.name + '」的 QQ 绑定？（Live2D 不受影响）')) return;
        const r = await window.soulweave.rosterUnbindChannel({ id: c.id });
        if (r && r.ok) go(); else alert('解绑失败：' + ((r && r.error) || '未知'));
      }));
    }
  }
  wrap.appendChild(row);

  // 账号没连上时先说明白：绑定本身能存，但发不出去
  if (accounts.length) {
    const acc0 = accounts.find((a) => a.label === (bound ? c.qq.accountLabel : accounts[0].label));
    if (acc0 && !acc0.online) {
      wrap.appendChild(tip('QQ 账号现在没连上（' + acc0.state + '）。绑定可以照常保存，但要真正发出去，得先在「社交」里把 QQ 登上。', 'warn'));
    }
  }

  // 目标就是机器人自己的提醒（最容易踩的坑）
  if (bound) {
    const acc = accounts.find((a) => a.label === c.qq.accountLabel);
    if (acc && acc.selfId && c.route && c.route.kind === 'private' && String(acc.selfId) === String(c.route.id)) {
      wrap.appendChild(tip('你绑的是机器人自己的 QQ 号。QQ 不会把私聊投递给「自己」，这条消息永远收不到。请改成你本人的另一个 QQ 号，或者绑一个群。', 'warn'));
    }
  }
  return wrap;
}

function buildBindForm(body, c, accounts, go) {
  // 角色这边只决定「用哪个 QQ 号」。
  // 发给谁已经统一到「社交 → 谁能触发」的白名单里了，这里不再重复问。
  const state = {
    accountLabel: (c.qq && c.qq.accountLabel) || (accounts[0] && accounts[0].label) || '',
  };

  body.appendChild(el('div', 'roster-f-h',
    '发到哪个群 / 哪个好友，由「社交 → 谁能触发」里的白名单决定。这里只选这个角色用哪个 QQ 号。'));

  // ① 账号
  const accField = el('div', 'roster-f');
  accField.appendChild(el('label', 'roster-f-l', '用哪个 QQ 号'));
  const accSel = document.createElement('select');
  accSel.className = 'ls-input roster-select';
  for (const a of accounts) {
    const o = document.createElement('option');
    o.value = a.label;
    const who = a.boundTo && a.boundTo.id !== c.id ? '（现在归 ' + a.boundTo.name + '）' : '';
    o.textContent = a.label + (a.selfId ? ' · ' + a.selfId : '') + (a.online ? '' : ' · 离线') + who;
    if (a.label === state.accountLabel) o.selected = true;
    accSel.appendChild(o);
  }
  accSel.addEventListener('change', () => { state.accountLabel = accSel.value; refreshTakeover(); });
  accField.appendChild(accSel);
  accField.appendChild(el('div', 'roster-f-h', '一个账号同时只服务一个角色；绑给这里，原来的角色会被自动释放。'));
  body.appendChild(accField);

  // 接管提示
  const takeover = el('div');
  body.appendChild(takeover);
  function refreshTakeover() {
    takeover.textContent = '';
    const a = accounts.find((x) => x.label === state.accountLabel);
    if (a && a.boundTo && a.boundTo.id !== c.id) {
      takeover.appendChild(tip('这个账号目前绑在「' + a.boundTo.name + '」身上，继续绑定会把它转给「' + c.name + '」。', 'warn'));
    }
  }
  refreshTakeover();

  // 提交
  const foot = el('div', 'roster-f-foot');
  const outBox = el('div');
  const submit = btn('保存绑定', 'primary', async () => {
    if (!state.accountLabel) { outBox.textContent = ''; outBox.appendChild(tip('还没选账号', 'bad')); return; }
    submit.disabled = true;
    submit.textContent = '保存中…';
    const r = await window.soulweave.rosterBindChannel({
      id: c.id,
      accountLabel: state.accountLabel,
    });
    submit.disabled = false;
    submit.textContent = '保存绑定';
    if (r && r.ok) {
      document.querySelectorAll('.roster-mask').forEach((m) => m.remove());
      if (r.released && r.released.length) {
        alert('已绑定。账号从「' + r.released.join('、') + '」转给了「' + c.name + '」。');
      }
      go();
      return;
    }
    outBox.textContent = '';
    outBox.appendChild(tip('保存失败：' + ((r && r.error) || '未知'), 'bad'));
  });
  foot.appendChild(submit);
  foot.appendChild(btn('取消', 'ghost', () => {
    document.querySelectorAll('.roster-mask').forEach((m) => m.remove());
  }));
  body.appendChild(foot);
  body.appendChild(outBox);
}


// ─── 每个角色独立的云端密钥 ───────────────────────────

function cloudPanel(c, go) {
  const wrap = el('div', 'roster-cloud');
  const head = el('div', 'roster-cloud-head');
  head.appendChild(el('span', 'roster-cloud-title', '角色密钥'));
  const badge = el('span', 'roster-cloud-badge', '未配置');
  head.appendChild(badge);
  wrap.appendChild(head);
  wrap.appendChild(el('div', 'roster-f-h', '每个云端角色用自己的 Key，互不影响。Key 用系统加密保存，不落明文。'));

  const box = el('div', 'roster-cloud-box');
  wrap.appendChild(box);

  const openBtn = btn('配置密钥…', 'sm', async () => {
    box.textContent = '';
    box.appendChild(loading('读取配置…'));
    const r = await window.soulweave.rosterCloudGet({ id: c.id });
    box.textContent = '';
    if (!r || !r.ok) { box.appendChild(tip('读取失败：' + ((r && r.error) || '未知'), 'bad')); return; }
    buildCloudForm(box, c, r, go);
  });
  wrap.appendChild(openBtn);

  // 预读一次，只更新徽章，不展开表单
  window.soulweave.rosterCloudGet({ id: c.id }).then((r) => {
    if (r && r.ok) {
      badge.textContent = r.config.hasKey ? '已配置 Key' : '未配置';
      badge.classList.toggle('on', !!r.config.hasKey);
      if (r.config.model) openBtn.title = '当前模型：' + r.config.model;
    }
  }).catch(() => {});

  return wrap;
}

function buildCloudForm(box, c, res, go) {
  const cfg = res.config || {};
  const providers = res.providers || [];
  let providerId = cfg.providerId || 'deepseek';

  const provField = el('div', 'roster-f');
  provField.appendChild(el('label', 'roster-f-l', '服务商'));
  const sel = document.createElement('select');
  sel.className = 'ls-input roster-select';
  for (const p of providers) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name + (p.domestic ? '' : ' · 境外');
    if (p.id === providerId) o.selected = true;
    sel.appendChild(o);
  }
  provField.appendChild(sel);
  box.appendChild(provField);

  const modelField = el('div', 'roster-f');
  modelField.appendChild(el('label', 'roster-f-l', '模型'));
  const modelIn = el('input', 'ls-input');
  modelIn.type = 'text';
  modelIn.value = cfg.model || '';
  modelIn.placeholder = '留空则用服务商默认模型';
  modelField.appendChild(modelIn);
  box.appendChild(modelField);

  const keyField = el('div', 'roster-f');
  keyField.appendChild(el('label', 'roster-f-l', 'API Key'));
  const keyIn = el('input', 'ls-input');
  keyIn.type = 'password';
  keyIn.placeholder = cfg.hasKey ? '已保存（留空不修改）' : '粘贴这个服务商的 Key';
  keyField.appendChild(keyIn);
  box.appendChild(keyField);

  const out = el('div');
  const row = el('div', 'roster-f-foot');
  const save = btn('保存', '', async () => {
    save.disabled = true;
    const r = await window.soulweave.rosterCloudSet({
      id: c.id, providerId, apiKey: keyIn.value.trim() || undefined, model: modelIn.value.trim() || undefined,
    });
    save.disabled = false;
    out.textContent = '';
    if (r && r.ok) {
      out.appendChild(tip('已保存', 'ok'));
      if (go) go();
    } else out.appendChild(tip('保存失败：' + ((r && r.error) || '未知'), 'bad'));
  });
  const test = btn('测试连通性', '', async () => {
    test.disabled = true;
    test.textContent = '测试中…';
    out.textContent = '';
    out.appendChild(loading('正在发一条真实请求…'));
    const r = await window.soulweave.rosterCloudTest({
      id: c.id, providerId, model: modelIn.value.trim() || undefined, apiKey: keyIn.value.trim() || undefined,
    });
    test.disabled = false;
    test.textContent = '测试连通性';
    out.textContent = '';
    const card = el('div', 'roster-receipt ' + (r && r.ok ? 'ok' : 'bad'));
    const h = el('div', 'roster-receipt-h');
    h.appendChild(el('span', 'roster-receipt-dot'));
    h.appendChild(el('span', null, r && r.ok ? '连接成功' : '连接失败'));
    card.appendChild(h);
    if (r && r.ok) {
      if (r.model) card.appendChild(el('div', 'roster-receipt-r', '模型：' + r.model));
      if (r.ms) card.appendChild(el('div', 'roster-receipt-r', '耗时：' + r.ms + ' ms'));
      if (r.reply) card.appendChild(el('div', 'roster-receipt-reply', '回复：' + r.reply));
    } else {
      card.appendChild(el('div', 'roster-receipt-r', '原因：' + ((r && r.error) || '未知')));
    }
    out.appendChild(card);
  });
  row.appendChild(save);
  row.appendChild(test);
  if (cfg.hasKey) {
    row.appendChild(btn('清除 Key', 'ghost', async () => {
      const r = await window.soulweave.rosterCloudClearKey({ id: c.id });
      if (r && r.ok) { out.textContent = ''; out.appendChild(tip('已清除', 'ok')); if (go) go(); }
      else out.appendChild(tip('清除失败：' + ((r && r.error) || '未知'), 'bad'));
    }));
  }
  box.appendChild(row);
  box.appendChild(out);

  sel.addEventListener('change', () => {
    providerId = sel.value;
    const p = providers.find((x) => x.id === providerId);
    if (p) { modelIn.value = (p.models && p.models[0]) || ''; modelIn.placeholder = (p.models && p.models.join(' / ')) || ''; }
  });
}

// ─── 新建角色 ───────────────────────────────────────

function createSection(limits, go) {
  const sec = el('div', 'sec');
  sec.appendChild(el('div', 'sec-title', '新建角色'));
  sec.appendChild(el('div', 'sec-hint',
    '本地 Agent 角色当前版本只能有一个（已由冰糖占用）；云端 API 角色可以建多个，每个用自己的 API Key。'));

  let kind = 'cloud_api';
  const kindRow = el('div', 'roster-kinds');
  const mkKind = (id, label, iconBrand, disabled, reason) => {
    const b = el('button', 'roster-kind-btn' + (id === kind ? ' on' : '') + (disabled ? ' disabled' : ''));
    b.type = 'button';
    const m = el('span', 'brand-mark sm');
    m.innerHTML = brandIcon(iconBrand, 16);
    b.appendChild(m);
    b.appendChild(el('span', null, label));
    if (disabled) b.title = reason || '不可用';
    else {
      b.addEventListener('click', () => {
        kind = id;
        Array.from(kindRow.children).forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
      });
    }
    return b;
  };
  kindRow.appendChild(mkKind('cloud_api', '云端 API 角色', 'deepseek', false));
  kindRow.appendChild(mkKind('local_dsh', '本地 Agent 角色', 'deepseek', !!limits.localLimitReached,
    '当前版本只支持一个本地角色'));
  sec.appendChild(kindRow);

  const nameRow = el('div', 'ls-field');
  nameRow.appendChild(el('label', null, '名字'));
  const nameBody = el('div', 'ls-field-body');
  const nameIn = el('input', 'ls-input');
  nameIn.type = 'text';
  nameIn.maxLength = 24;
  nameIn.placeholder = '例如：小满';
  nameBody.appendChild(nameIn);
  nameRow.appendChild(nameBody);
  sec.appendChild(nameRow);

  const noteRow = el('div', 'ls-field');
  noteRow.appendChild(el('label', null, '备注'));
  const noteBody = el('div', 'ls-field-body');
  const noteIn = el('input', 'ls-input');
  noteIn.type = 'text';
  noteIn.placeholder = '可选，随便写点什么';
  noteBody.appendChild(noteIn);
  noteRow.appendChild(noteBody);
  sec.appendChild(noteRow);

  const out = el('div');
  const row = el('div', 'ls-btn-row');
  const addBtn = btn('创建角色', 'primary', async () => {
    addBtn.disabled = true;
    out.textContent = '';
    try {
      const r = await window.soulweave.rosterCreate({ kind, name: nameIn.value.trim(), note: noteIn.value.trim() });
      if (r && r.ok) { go(); return; }
      out.appendChild(tip((r && r.error) || '创建失败', 'bad'));
    } catch (e) {
      out.appendChild(tip('创建失败：' + e, 'bad'));
    } finally {
      addBtn.disabled = false;
    }
  });
  row.appendChild(addBtn);
  sec.appendChild(row);
  sec.appendChild(out);
  return sec;
}

// ─── 样式 ───────────────────────────────────────────

export function ensureRosterStyles() {
  if (document.getElementById('roster-styles')) return;
  const st = document.createElement('style');
  st.id = 'roster-styles';
  st.textContent = `
/* 角色卡：深色玻璃卡，圆角 12，边框只用 rgba（深色主题里实色灰边会脏） */
.roster-card {
  padding: 14px 16px; margin-bottom: 12px;
  border: 1px solid var(--sb-line); border-radius: 12px;
  background: rgba(127,127,127,.045);
  transition: border-color .16s ease, box-shadow .16s ease;
}
.roster-card:hover { border-color: rgba(110,168,254,.30); }
.roster-card.local {
  background: linear-gradient(135deg, rgba(77,107,254,.10), rgba(127,127,127,.03));
  border-color: rgba(77,107,254,.22);
}
.roster-card.cloud {
  background: linear-gradient(135deg, rgba(201,167,255,.10), rgba(110,168,254,.04));
  border-color: rgba(201,167,255,.20);
}

.roster-head { display: flex; align-items: center; gap: 12px; }
.roster-avatar {
  width: 40px; height: 40px; border-radius: 12px; flex: none;
  display: flex; align-items: center; justify-content: center;
  font-size: 17px; font-weight: 700; letter-spacing: .5px;
}
.roster-avatar.local { background: rgba(77,107,254,.22); color: #9DB4FF; }
.roster-avatar.cloud { background: rgba(201,167,255,.22); color: #D6BCFF; }
.roster-info { flex: 1; min-width: 0; }
.roster-name-row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.roster-name { font-size: 14px; font-weight: 650; letter-spacing: .2px; }
.roster-kind {
  font-size: 11.5px; padding: 1px 6px; border-radius: 5px;
  border: 1px solid var(--sb-line); letter-spacing: .3px;
}
.roster-kind.local { color: #9DB4FF; border-color: rgba(77,107,254,.45); background: rgba(77,107,254,.12); }
.roster-kind.cloud { color: #D6BCFF; border-color: rgba(201,167,255,.45); background: rgba(201,167,255,.12); }
.roster-protect {
  font-size: 11.5px; color: var(--sb-dim); padding: 1px 6px;
  border-radius: 5px; background: rgba(127,127,127,.13);
}
.roster-protect.sleep { color: #E8C46A; background: rgba(232,196,106,.14); }
.roster-note { font-size: 12px; color: var(--sb-dim); margin-top: 4px; line-height: 1.55; }
.roster-provider { flex: none; }

/* ── QQ 绑定面板 ── */
.roster-qq {
  margin-top: 12px; padding: 12px 13px;
  border: 1px solid rgba(110,168,254,.18); border-radius: 10px;
  background: rgba(110,168,254,.045);
}
.roster-qq-head { display: flex; align-items: center; gap: 9px; }
.roster-qq-title { font-size: 12px; font-weight: 650; letter-spacing: .3px; }
.roster-qq-status {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11.5px; padding: 1px 7px; border-radius: 999px;
  border: 1px solid var(--sb-line);
}
.roster-qq-status.on { color: #6EE7A8; border-color: rgba(110,231,168,.42); background: rgba(110,231,168,.10); }
.roster-qq-status.off { color: var(--sb-dim); }
.roster-qq-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.roster-qq-online { font-size: 11.5px; margin-left: auto; }
.roster-qq-online.on { color: #6EE7A8; }
.roster-qq-online.off { color: #E8C46A; }

.roster-qq-sum { margin-top: 9px; }
.roster-qq-route {
  display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  font-size: 12px;
}
.roster-qq-acct {
  padding: 2px 8px; border-radius: 6px; font-weight: 600;
  background: rgba(110,168,254,.16); color: #A9C7FF;
}
.roster-qq-arrow { color: var(--sb-dim); }
.roster-qq-target { color: var(--sb-fg); font-weight: 600; }
.roster-qq-tid { font-size: 11.5px; color: var(--sb-dim); font-variant-numeric: tabular-nums; }

.roster-qq-acts { display: flex; gap: 7px; margin-top: 10px; flex-wrap: wrap; align-items: center; }
.roster-qq-empty { font-size: 12px; color: var(--sb-dim); }
.roster-qq-out { flex-basis: 100%; margin-top: 9px; }
.roster-qq-hint { font-size: 11.5px; color: var(--sb-dim); margin-top: 6px; }

/* ── 回执卡 ── */
.roster-receipt {
  margin-top: 8px; padding: 10px 12px; border-radius: 9px;
  border: 1px solid var(--sb-line); background: rgba(127,127,127,.05);
  font-size: 11.5px; line-height: 1.65;
}
.roster-receipt.ok { border-color: rgba(110,231,168,.40); background: rgba(110,231,168,.08); }
.roster-receipt.bad { border-color: rgba(255,120,120,.40); background: rgba(255,120,120,.08); }
.roster-receipt-h { display: flex; align-items: center; gap: 7px; font-weight: 650; font-size: 12px; }
.roster-receipt.ok .roster-receipt-h { color: #6EE7A8; }
.roster-receipt.bad .roster-receipt-h { color: #FF8E8E; }
.roster-receipt-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.roster-receipt-r { color: var(--sb-dim); margin-top: 3px; font-variant-numeric: tabular-nums; }
.roster-receipt-reply {
  margin-top: 6px; padding: 7px 9px; border-radius: 7px;
  background: rgba(127,127,127,.09); color: var(--sb-fg);
  max-height: 96px; overflow: auto; white-space: pre-wrap;
}

/* ── Live2D 行 ── */
.roster-live {
  display: flex; align-items: center; gap: 7px;
  margin-top: 11px; font-size: 11.5px; cursor: pointer;
  color: var(--sb-dim);
}
.roster-live input { accent-color: var(--sb-accent); }

/* ── 云端密钥 ── */
.roster-cloud {
  margin-top: 11px; padding: 11px 13px; border-radius: 10px;
  border: 1px solid var(--sb-line); background: rgba(201,167,255,.045);
}
.roster-cloud-head { display: flex; align-items: center; gap: 9px; }
.roster-cloud-title { font-size: 12px; font-weight: 650; }
.roster-cloud-badge {
  font-size: 11.5px; padding: 1px 7px; border-radius: 999px;
  border: 1px solid var(--sb-line); color: var(--sb-dim);
}
.roster-cloud-badge.on { color: #6EE7A8; border-color: rgba(110,231,168,.4); background: rgba(110,231,168,.1); }
.roster-cloud-box { margin-top: 4px; }

/* ── 表单 ── */
.roster-f { margin-top: 11px; }
.roster-f-l { display: block; font-size: 11.5px; color: var(--sb-dim); margin-bottom: 5px; letter-spacing: .3px; }
.roster-f-h { font-size: 11.5px; color: var(--sb-dim); margin-top: 5px; line-height: 1.55; }
.roster-f-foot { display: flex; gap: 8px; margin-top: 15px; flex-wrap: wrap; align-items: center; }
.roster-select { width: 100%; }
.roster-search { width: 100%; margin-bottom: 9px; }

.roster-seg { display: flex; gap: 0; border: 1px solid var(--sb-line); border-radius: 8px; overflow: hidden; }
.roster-seg-btn {
  flex: 1; padding: 7px 10px; font: inherit; font-size: 11.5px;
  background: transparent; color: var(--sb-dim); border: 0; cursor: pointer;
  transition: background .14s, color .14s;
}
.roster-seg-btn + .roster-seg-btn { border-left: 1px solid var(--sb-line); }
.roster-seg-btn:hover { background: rgba(127,127,127,.08); color: var(--sb-fg); }
.roster-seg-btn.on { background: rgba(110,168,254,.18); color: #C7DAFF; font-weight: 650; }

.roster-target-slot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.roster-chip {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 5px 6px 5px 10px; border-radius: 8px;
  border: 1px solid rgba(110,168,254,.4); background: rgba(110,168,254,.12);
  font-size: 11.5px;
}
.roster-chip-kind { font-size: 11.5px; color: var(--sb-dim); }
.roster-chip-name { font-weight: 650; }
.roster-chip-id { font-size: 11.5px; color: var(--sb-dim); font-variant-numeric: tabular-nums; }
.roster-chip-x { padding: 1px 5px !important; font-size: 11.5px !important; }

/* ── 选择器弹窗 ── */
.roster-mask {
  position: fixed; inset: 0; z-index: 9000;
  background: rgba(6,6,12,.66); backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center;
}
.roster-modal {
  width: min(460px, 92vw); max-height: 82vh;
  display: flex; flex-direction: column;
  border: 1px solid var(--sb-line); border-radius: 14px;
  background: #16161E;
  box-shadow: 0 24px 64px rgba(0,0,0,.55);
}
.roster-modal.wide { width: min(520px, 94vw); }
.roster-modal-head {
  display: flex; align-items: center; gap: 8px;
  padding: 13px 15px; border-bottom: 1px solid var(--sb-line);
}
.roster-modal-title { font-size: 13px; font-weight: 650; flex: 1; }
.roster-modal-x { padding: 2px 7px !important; }
.roster-modal-body { padding: 13px 15px 16px; overflow: auto; }

.roster-pick-list { display: flex; flex-direction: column; gap: 2px; }
.roster-pick-row {
  display: flex; align-items: baseline; gap: 9px;
  padding: 8px 10px; border-radius: 8px; width: 100%;
  border: 1px solid transparent; background: transparent;
  color: var(--sb-fg); font: inherit; font-size: 12px;
  text-align: left; cursor: pointer;
  transition: background .12s, border-color .12s;
}
.roster-pick-row:hover { background: rgba(110,168,254,.12); border-color: rgba(110,168,254,.3); }
.roster-pick-name { font-weight: 600; }
.roster-pick-id { font-size: 11.5px; color: var(--sb-dim); font-variant-numeric: tabular-nums; }
.roster-pick-nick { font-size: 11.5px; color: var(--sb-dim); margin-left: auto; }

/* 概览里「已绑 QQ」高亮 */
.ls-stat.hot .ls-stat-v { color: #A9C7FF; }
`;
  document.head.appendChild(st);
}
