/**
 * SoulWeave：QQ 白名单（谁能触发 AI）
 *
 * 【按 QQ 号分开】
 * 两个号的好友和群不是同一批，白名单必须各管各的。
 * 顶部选「这个设置属于哪个号」，下面就是那个号的名单。
 *
 * 【统一在「社交」里配】
 * 角色管理只负责「这个角色绑哪个号、发给谁」；
 * 「谁能触发我」属于账号自身的安全设置，只在这里改。
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

const loading = (t) => el('div', 'ls-loading', t || '加载中…');

function parseIds(raw) {
  return String(raw || '')
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter((x) => /^\d{3,}$/.test(x));
}

export async function renderWhitelist(host, onChange) {
  host.textContent = '';
  host.appendChild(loading('正在读取白名单…'));

  const [snap, inst] = await Promise.all([
    window.soulweave.qqSnapshot().catch(() => null),
    window.soulweave.qqInstancesList().catch(() => null),
  ]);
  const data = snap && snap.ok ? snap.data : null;
  host.textContent = '';
  if (!data) { host.appendChild(el('div', 'ls-tip bad', '读取 QQ 状态失败')); return; }

  const accounts = data.accounts || [];
  const instances = (inst && inst.instances) || [];

  if (!accounts.length) {
    host.appendChild(el('div', 'ls-tip warn',
      '还没有接入任何 QQ 号。先在下面把 QQ 登上去并「接入 SoulWeave」，这里才能配白名单。'));
    return;
  }

  // 选中的账号：默认第一个，切账号就整体重绘
  // 默认选一个在线的；都离线才用第一个
  const onlineOne = accounts.find((a) => a.state === 'online') || accounts[0];
  const pick = (window.__wlPick && accounts.some((a) => a.label === window.__wlPick))
    ? window.__wlPick
    : onlineOne.label;

  const meta = instances.find((x) => x.accountLabel === pick) || {};
  const selfUin = meta.uin ? String(meta.uin) : (accounts.find((a) => a.label === pick) || {}).selfId || '';

  const policies = data.policies || {};
  const pol = policies[pick] || data.policy || {};
  const owners = Array.isArray(pol.ownerIds) ? pol.ownerIds.slice() : [];
  const users = Array.isArray(pol.allowedUserIds) ? pol.allowedUserIds.slice() : [];
  const groups = Array.isArray(pol.allowedGroupIds) ? pol.allowedGroupIds.slice() : [];
  // 两个名单互斥：同一个人不该同时是主人和好友
  const friends = users.filter((x) => owners.indexOf(x) < 0);
  const ownerSet = owners;

  // ── 账号选择 ──
  const head = el('div', 'wl-row wl-head');
  const lab = el('div', 'wl-lab');
  lab.appendChild(el('div', 'wl-title', '这个设置属于哪个 QQ 号'));
  lab.appendChild(el('div', 'wl-hint', '每个号的白名单各自独立。'));
  head.appendChild(lab);

  const sel = document.createElement('select');
  sel.className = 'ls-input wl-select';
  for (const a of accounts) {
    const m = instances.find((x) => x.accountLabel === a.label) || {};
    const o = document.createElement('option');
    o.value = a.label;
    const who = m.uin || a.selfId || '';
    o.textContent = (m.nick || a.label) + (who ? ' · ' + who : '') + (a.state === 'online' ? '' : '（离线）');
    if (a.label === pick) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => {
    window.__wlPick = sel.value;
    if (onChange) onChange();
  });
  head.appendChild(sel);
  host.appendChild(head);

  const out = el('div');
  const save = async (patch, okText) => {
    const r = await window.soulweave.qqPolicySet({ ...patch, label: pick });
    if (r && r.warnings && r.warnings.length) {
      out.textContent = '';
      for (const w of r.warnings) out.appendChild(el('div', 'ls-tip warn', w));
    }
    // 【重要】保存不重绘整页：重绘会把滚动条弹回顶部，用户会以为操作没生效。
    // 就地更新提示 + 顶部 toast 就够了。
    if (r && r.ok) {
      const sw = await import('./settings.js').catch(() => null);
      if (sw && sw.toast) sw.toast(okText || '已保存');
      if (!(r.warnings && r.warnings.length)) out.textContent = '';
    }
    // 名单变了必须重绘才能看到 chip 变化；但由调用方决定要不要重绘
    return r;
  };
  const repaint = () => { if (onChange) onChange(); };

  host.appendChild(listBlock({
    title: '主人（主号）',
    hint: '你自己的号。可以让角色做事：切换角色、查记忆、跑工具。建议只放一个。',
    kind: 'user',
    accountLabel: pick,
    selfUin,
    ids: owners,
    accent: 'owner',
    onAdd: async (ids) => {
      const next = Array.from(new Set([...owners, ...ids]));
      await save({ ownerIds: next, allowedUserIds: users.filter((x) => next.indexOf(x) < 0) }, '已设为主人');
      repaint();
    },
    onRemove: async (id) => {
      await save({ ownerIds: owners.filter((x) => x !== id) }, '已取消主人');
      repaint();
    },
  }));

  host.appendChild(listBlock({
    title: '好友（可私聊）',
    hint: '这些号私聊时角色会回应，但只能闲聊：不能下指令、不能查记忆、不能触发截图。',
    kind: 'user',
    accountLabel: pick,
    selfUin,
    ids: friends,
    onAdd: async (ids) => {
      const next = Array.from(new Set([...friends, ...ids]));
      await save({ allowedUserIds: next }, '已加入好友');
      repaint();
    },
    onRemove: async (id) => {
      await save({ allowedUserIds: users.filter((x) => x !== id) }, '已移出好友');
      repaint();
    },
  }));

  host.appendChild(listBlock({
    title: '允许的群',
    hint: '只有这些群里的消息会被处理。群聊默认还要求 @ 机器人才回应。',
    kind: 'group',
    accountLabel: pick,
    selfUin: '',
    ids: groups,
    onAdd: async (ids) => {
      await save({ allowedGroupIds: Array.from(new Set([...groups, ...ids])) }, '已加入群');
      repaint();
    },
    onRemove: async (id) => {
      await save({ allowedGroupIds: groups.filter((x) => x !== id) }, '已移出群');
      repaint();
    },
  }));

  const atRow = el('div', 'wl-row');
  const atLab = el('div', 'wl-lab');
  atLab.appendChild(el('div', 'wl-title', '群里必须 @ 机器人'));
  atLab.appendChild(el('div', 'wl-hint', '关掉后群里每句话都会被处理，容易吵，默认开。'));
  atRow.appendChild(atLab);
  atRow.appendChild(btn(pol.requireAtInGroup ? '是（推荐）' : '否', 'sm', async () => {
    await save({ requireAtInGroup: !pol.requireAtInGroup }, pol.requireAtInGroup ? '已改为不要求 @' : '已改为必须 @');
    repaint();
  }));
  host.appendChild(atRow);

  if (!owners.length && !friends.length) {
    host.appendChild(el('div', 'ls-tip warn',
      '这个号还没设主人，也没加好友 —— 现在没有任何人能触发 AI。先把你自己的号设为主人。'));
  } else if (!owners.length) {
    host.appendChild(el('div', 'ls-tip warn',
      '还没设主人：主人能下指令，好友只能闲聊。建议把你自己的号设为主人。'));
  }
  host.appendChild(out);
}

function listBlock(cfg) {
  const box = el('div', 'wl-block' + (cfg.accent ? ' wl-' + cfg.accent : ''));
  const head = el('div', 'wl-row');
  const lab = el('div', 'wl-lab');
  lab.appendChild(el('div', 'wl-title', cfg.title));
  lab.appendChild(el('div', 'wl-hint', cfg.hint));
  head.appendChild(lab);
  head.appendChild(el('span', 'wl-count', String(cfg.ids.length)));
  box.appendChild(head);

  const chips = el('div', 'wl-chips');
  if (!cfg.ids.length) chips.appendChild(el('div', 'wl-empty', '还没有任何条目'));
  for (const id of cfg.ids) {
    const chip = el('span', 'wl-chip' + (cfg.selfUin && id === cfg.selfUin ? ' self' : ''));
    chip.appendChild(el('span', 'wl-chip-id', id));
    if (cfg.selfUin && id === cfg.selfUin) chip.appendChild(el('span', 'wl-chip-tag', '本号'));
    const x = el('button', 'wl-chip-x', '✕');
    x.type = 'button';
    x.title = '移除 ' + id;
    x.setAttribute('aria-label', '移除 ' + id);
    x.addEventListener('click', async () => { x.disabled = true; await cfg.onRemove(id); });
    chip.appendChild(x);
    chips.appendChild(chip);
  }
  box.appendChild(chips);

  const addRow = el('div', 'wl-add');
  const inp = document.createElement('input');
  inp.className = 'ls-input wl-input';
  inp.type = 'text';
  inp.placeholder = cfg.kind === 'user' ? '输入 QQ 号，回车添加（可一次粘多个）' : '输入群号，回车添加（可一次粘多个）';
  addRow.appendChild(inp);

  const warn = el('div');
  const addBtn = btn('添加', 'sm primary', async () => {
    let ids = parseIds(inp.value);
    if (!ids.length) { inp.focus(); return; }
    warn.textContent = '';
    // 不能把机器人自己的号加进白名单：自己跟自己聊没有意义，
    // 而且 QQ 也不会把消息投给自己。
    if (cfg.kind === 'user' && cfg.selfUin) {
      const blocked = ids.filter((x) => x === cfg.selfUin);
      ids = ids.filter((x) => x !== cfg.selfUin);
      if (blocked.length) {
        warn.appendChild(el('div', 'ls-tip warn', cfg.selfUin + ' 是这个实例自己登录的号，不能加进白名单。'));
      }
    }
    if (!ids.length) return;
    addBtn.disabled = true;
    inp.value = '';
    await cfg.onAdd(ids);
    addBtn.disabled = false;
  });
  addRow.appendChild(addBtn);

  if (cfg.accountLabel) {
    addRow.appendChild(btn(cfg.kind === 'user' ? '从好友选…' : '从群列表选…', 'sm ghost', () => openPicker(cfg, inp)));
  } else {
    addRow.appendChild(el('span', 'wl-hint', '（QQ 连上后才能从列表选）'));
  }
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); } });
  box.appendChild(addRow);
  box.appendChild(warn);
  return box;
}

function openPicker(cfg, inp) {
  const mask = el('div', 'wl-mask');
  const modal = el('div', 'wl-modal');
  const head = el('div', 'wl-modal-head');
  head.appendChild(el('div', 'wl-modal-title', cfg.kind === 'user' ? '选择好友' : '选择群'));
  const cls = el('button', 'wl-chip-x', '✕');
  cls.type = 'button';
  cls.title = '关闭';
  cls.addEventListener('click', () => mask.remove());
  head.appendChild(cls);
  modal.appendChild(head);

  const search = document.createElement('input');
  search.className = 'ls-input';
  search.type = 'search';
  search.placeholder = cfg.kind === 'user' ? '搜索昵称、备注或 QQ 号…' : '搜索群名或群号…';
  modal.appendChild(search);

  const list = el('div', 'wl-pick-list');
  modal.appendChild(list);
  list.appendChild(loading('正在拉列表…'));

  mask.appendChild(modal);
  mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
  document.body.appendChild(mask);

  let items = [];
  const paint = () => {
    list.textContent = '';
    const q = search.value.trim().toLowerCase();
    const shown = !q ? items : items.filter((t) =>
      (t.name || '').toLowerCase().includes(q) || String(t.id).includes(q));
    if (!items.length) { list.appendChild(el('div', 'wl-empty', '列表是空的（账号没连上？）')); return; }
    if (!shown.length) { list.appendChild(el('div', 'wl-empty', '没有匹配的条目')); return; }
    for (const t of shown.slice(0, 300)) {
      const row = el('button', 'wl-pick-row');
      row.type = 'button';
      row.appendChild(el('span', 'wl-pick-name', t.name || t.id));
      row.appendChild(el('span', 'wl-pick-id', t.id));
      const isSelf = cfg.kind === 'user' && cfg.selfUin && String(t.id) === cfg.selfUin;
      const picked = cfg.ids.includes(String(t.id));
      if (isSelf) row.appendChild(el('span', 'wl-pick-on', '本号'));
      else if (picked) row.appendChild(el('span', 'wl-pick-on', '已在名单'));
      row.addEventListener('click', async () => {
        if (isSelf || picked) { mask.remove(); return; }
        await cfg.onAdd([String(t.id)]);
        mask.remove();
      });
      list.appendChild(row);
    }
  };

  window.soulweave.rosterTargets({ accountLabel: cfg.accountLabel, kind: cfg.kind === 'user' ? 'private' : 'group' })
    .then((r) => {
      if (!r || !r.ok) { list.textContent = ''; list.appendChild(el('div', 'wl-empty', '拉取失败：' + ((r && r.error) || '未知'))); return; }
      items = r.targets || [];
      paint();
    })
    .catch((e) => { list.textContent = ''; list.appendChild(el('div', 'wl-empty', '拉取失败：' + e)); });
  search.addEventListener('input', paint);
}

export function ensureWhitelistStyles() {
  if (document.getElementById('wl-styles')) return;
  const st = document.createElement('style');
  st.id = 'wl-styles';
  st.textContent = `
.wl-head { margin-bottom: 10px; }
.wl-select { max-width: 300px; }
.wl-block.wl-owner { border-color: rgba(201,167,255,.34); background: rgba(201,167,255,.045); }
.wl-block.wl-owner .wl-title { color: #C9A7FF; }
.wl-owner .wl-chip { border-color: rgba(201,167,255,.35); }
.wl-block {
  padding: 12px 14px; margin-bottom: 10px;
  border: 1px solid var(--sb-line); border-radius: 11px;
  background: rgba(127,127,127,.045);
}
.wl-row { display: flex; align-items: center; gap: 10px; }
.wl-lab { flex: 1; min-width: 0; }
.wl-title { font-size: 12.5px; font-weight: 650; }
.wl-hint { font-size: 11.5px; color: var(--sb-dim); margin-top: 3px; line-height: 1.55; }
.wl-count {
  font-size: 11.5px; padding: 1px 8px; border-radius: 999px;
  border: 1px solid var(--sb-line); color: var(--sb-dim);
  font-variant-numeric: tabular-nums;
}
.wl-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.wl-empty { font-size: 12px; color: var(--sb-dim); }
.wl-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 4px 3px 9px; border-radius: 7px;
  border: 1px solid rgba(110,168,254,.4); background: rgba(110,168,254,.13);
  font-size: 11.5px;
}
.wl-chip.self { border-color: rgba(232,196,106,.5); background: rgba(232,196,106,.12); }
.wl-chip-id { font-variant-numeric: tabular-nums; letter-spacing: .2px; }
.wl-chip-tag { font-size: 11.5px; color: #E8C46A; }
.wl-chip-x {
  border: 0; background: transparent; color: var(--sb-dim);
  cursor: pointer; font-size: 11.5px; padding: 1px 5px; border-radius: 4px;
}
.wl-chip-x:hover { background: rgba(255,120,120,.18); color: #FF8E8E; }
.wl-add { display: flex; gap: 7px; margin-top: 10px; align-items: center; flex-wrap: wrap; }
.wl-input { flex: 1; min-width: 180px; }
.wl-mask {
  position: fixed; inset: 0; z-index: 9100; background: rgba(6,6,12,.66);
  display: flex; align-items: center; justify-content: center;
}
.wl-modal {
  width: min(460px, 92vw); max-height: 78vh; display: flex; flex-direction: column;
  gap: 9px; padding: 14px 15px 16px;
  border: 1px solid var(--sb-line); border-radius: 14px;
  background: #16161E; box-shadow: 0 24px 64px rgba(0,0,0,.55);
}
.wl-modal-head { display: flex; align-items: center; gap: 8px; }
.wl-modal-title { flex: 1; font-size: 13px; font-weight: 650; }
.wl-pick-list { overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.wl-pick-row {
  display: flex; align-items: baseline; gap: 9px; width: 100%;
  padding: 8px 10px; border-radius: 8px; border: 1px solid transparent;
  background: transparent; color: var(--sb-fg); font: inherit; font-size: 12px;
  text-align: left; cursor: pointer;
}
.wl-pick-row:hover { background: rgba(110,168,254,.12); border-color: rgba(110,168,254,.3); }
.wl-pick-name { font-weight: 600; }
.wl-pick-id { font-size: 11.5px; color: var(--sb-dim); font-variant-numeric: tabular-nums; }
.wl-pick-on { margin-left: auto; font-size: 11.5px; color: #6EE7A8; }
`;
  document.head.appendChild(st);
}
