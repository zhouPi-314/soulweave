/**
 * SoulWeave：QQ 账号（多实例）
 *
 * 【显示规则】
 * 不标「第一个 / 第二个」，只显示**这个号自己是谁**：完整 QQ 号 + 昵称。
 * 未登录时就显示「未登录」，不编造顺序编号。
 *
 * 【实时】
 * 页面在的时候每 5 秒拉一次；昵称/号/在线状态就地更新，
 * 只有「运行状态变了」（端口起没起、登录没登录）才整体重绘，
 * 这样二维码不会被刷新打断。
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

function stateChips(it) {
  const wrap = el('div', 'qi-chips');
  const chip = (label, on, cls) => {
    const c = el('span', 'qi-chip' + (on ? ' on' : '') + (cls ? ' ' + cls : ''));
    c.appendChild(el('span', 'qi-dot'));
    c.appendChild(el('span', null, label));
    return c;
  };
  wrap.appendChild(chip(it.webuiUp ? '运行中' : '未运行', it.webuiUp));
  wrap.appendChild(chip(it.loggedIn ? '已登录' : '未登录', it.loggedIn));
  if (it.accountLabel) {
    wrap.appendChild(chip(it.accountOnline ? '已接入' : '已配置未连接', it.accountOnline, 'acc'));
  }
  return wrap;
}

function sig(it) {
  return [it.webuiUp, it.loggedIn, it.uin, it.accountLabel, it.accountOnline, it.nick].join('|');
}

export async function renderQqInstances(host, onChange) {
  host.textContent = '';
  host.appendChild(loading('正在读取 QQ 账号…'));

  const res = await window.soulweave.qqInstancesList().catch((e) => ({ ok: false, error: String(e) }));
  host.textContent = '';
  if (!res || !res.ok) {
    host.appendChild(tip('读取失败：' + ((res && res.error) || '未知'), 'bad'));
    return;
  }

  const list = res.instances || [];
  const reload = () => (onChange ? onChange() : renderQqInstances(host, onChange));

  const sec = el('div');
  sec.appendChild(el('div', 'sec-hint',
    '一个 QQ 号 = 一套独立的 NapCat 实例和端口。多个号可以同时在线，各自绑不同的角色。'));

  const cards = new Map();
  for (const it of list) {
    const card = instanceCard(it, reload);
    cards.set(it.id, card);
    sec.appendChild(card);
  }

  // 添加入口
  const addRow = el('div', 'qi-add');
  const addBtn = btn('＋ 添加另一个 QQ 号', 'primary', async () => {
    addBtn.disabled = true;
    addBtn.textContent = '正在准备实例…';
    const r = await window.soulweave.qqInstancesAdd({});
    addBtn.disabled = false;
    addBtn.textContent = '＋ 添加另一个 QQ 号';
    if (!r || !r.ok) { addRow.appendChild(tip('添加失败：' + ((r && r.error) || '未知'), 'bad')); return; }
    reload();
  });
  addRow.appendChild(addBtn);
  addRow.appendChild(el('div', 'ls-note', '会复制一份 NapCat 实例（重目录用链接，几秒钟），并自动分配一套新端口。'));
  sec.appendChild(addRow);
  host.appendChild(sec);

  // ── 实时刷新 ──
  const old = window.__qiLiveTimer;
  if (old) clearInterval(old);
  const timer = setInterval(async () => {
    if (!document.body.contains(host)) { clearInterval(timer); window.__qiLiveTimer = null; return; }
    const r = await window.soulweave.qqInstancesList().catch(() => null);
    if (!r || !r.ok) return;
    let structureChanged = false;
    for (const it of r.instances || []) {
      const card = cards.get(it.id);
      if (!card) { structureChanged = true; break; }
      if (card.dataset.sig !== sig(it)) { structureChanged = true; break; }
      paintCard(card, it);
    }
    if ((r.instances || []).length !== cards.size) structureChanged = true;
    if (structureChanged) { clearInterval(timer); reload(); }
  }, 5000);
  window.__qiLiveTimer = timer;
}

/** 就地更新昵称 / QQ 号 / 状态点，不打断二维码 */
function paintCard(card, it) {
  const nick = card.querySelector('[data-role=nick]');
  const uin = card.querySelector('[data-role=uin]');
  const chips = card.querySelector('[data-role=chips]');
  if (nick) nick.textContent = it.loggedIn ? (it.nick || '（无昵称）') : '未登录';
  if (uin) uin.textContent = it.loggedIn ? String(it.uin) : '—';
  if (chips) { chips.textContent = ''; chips.appendChild(stateChips(it)); }
}

function instanceCard(it, reload) {
  const card = el('div', 'qi-card');
  card.dataset.sig = sig(it);

  // 头：昵称 + 完整 QQ 号（不写「第几个」）
  const head = el('div', 'qi-head');
  const idBox = el('div', 'qi-id');
  const nickEl = el('div', 'qi-label');
  nickEl.dataset.role = 'nick';
  nickEl.textContent = it.loggedIn ? (it.nick || '（无昵称）') : '未登录';
  idBox.appendChild(nickEl);

  const uinEl = el('div', 'qi-uin-big');
  uinEl.dataset.role = 'uin';
  uinEl.textContent = it.loggedIn ? String(it.uin) : '—';
  idBox.appendChild(uinEl);

  idBox.appendChild(el('div', 'qi-sub',
    'WebUI ' + it.webuiPort + ' · HTTP ' + it.httpPort + ' · WS ' + it.wsPort + (it.managed ? ' · 自动创建' : '')));
  head.appendChild(idBox);

  const chips = el('div');
  chips.dataset.role = 'chips';
  chips.appendChild(stateChips(it));
  head.appendChild(chips);
  card.appendChild(head);

  // 登录后以「昵称（QQ号）」为准；「接入标识」只在未登录时作为占位提示出现，
  // 避免出现「第二个 QQ号」这种占位味道的名字。
  if (it.accountLabel) {
    const who = el('div', 'qi-who');
    const real = it.loggedIn && (it.nick || it.uin)
      ? (it.nick || '未命名') + (it.uin ? '（' + it.uin + '）' : '')
      : '';
    // 未登录时不再露出「第二个 QQ号」这种占位标识：那是内部路由名，对用户没意义
    who.appendChild(el('span', 'qi-acc', real ? ('账号：' + real) : '尚未登录'));
    card.appendChild(who);
  }

  const out = el('div');
  const row = el('div', 'qi-acts');

  /** 重新登录：杀干净再拉起，专门对付「手机退了、PC 还挂着」 */
  const doRelogin = async () => {
    out.textContent = '';
    out.appendChild(loading('正在结束旧进程…'));
    const r = await window.soulweave.qqInstancesRelogin({ id: it.id }).catch((e) => ({ ok: false, error: String(e) }));
    out.textContent = '';
    if (!r || !r.ok) { out.appendChild(tip('重新登录失败：' + ((r && r.error) || '未知'), 'bad')); return; }
    out.appendChild(note('已杀掉 ' + (r.killed || 0) + ' 个旧进程' + (r.webuiUp ? '，实例已重启' : '，但端口没起来'), r.webuiUp ? 'ok' : ''));
    if (r.webuiUp) {
      // 重启完还没登录就把码直接亮出来，省一次点击
      const l = await window.soulweave.qqInstancesList().catch(() => null);
      const cur = (l && l.instances || []).find((x) => x.id === it.id);
      if (cur && !cur.loggedIn) await showQr(it, out, reload);
      else setTimeout(reload, 900);
    } else {
      setTimeout(reload, 1200);
    }
  };

  const doKill = async () => {
    if (!confirm('结束这个账号占着的 QQ / NapCat 进程？\n只影响这一个实例，不会动别的账号。')) return;
    out.textContent = '';
    out.appendChild(loading('正在清理…'));
    const r = await window.soulweave.qqInstancesKill({ id: it.id }).catch((e) => ({ ok: false, error: String(e) }));
    out.textContent = '';
    if (!r || !r.ok) { out.appendChild(tip('清理失败：' + ((r && r.error) || '未知'), 'bad')); return; }
    out.appendChild(note(r.killed ? ('已清理 ' + r.killed + ' 个进程：' + (r.pids || []).join(', ')) : '没有发现占用的进程', 'ok'));
    setTimeout(reload, 1200);
  };

  if (!it.webuiUp) {
    row.appendChild(btn('▶ 启动', 'primary', () => doLaunch(it, out, card, reload)));
  } else if (!it.loggedIn) {
    row.appendChild(btn('扫码登录', 'primary', async () => { await showQr(it, out, reload); }));
  }

  // 重新登录对**每一个**账号都存在，不只是第一个
  row.appendChild(btn('重新登录', '', doRelogin));
  row.appendChild(btn('杀掉僵尸进程', 'ghost', doKill));

  if (it.loggedIn && !it.accountLabel) {
    row.appendChild(btn('接入 SoulWeave', 'primary', async () => {
      out.textContent = '';
      out.appendChild(loading('正在接入…'));
      const r = await window.soulweave.qqInstancesBindAccount({ id: it.id });
      out.textContent = '';
      if (!r || !r.ok) { out.appendChild(tip('接入失败：' + ((r && r.error) || '未知'), 'bad')); return; }
      out.appendChild(note('已接入：' + r.accountLabel + '（' + r.wsUrl + '）', 'ok'));
      setTimeout(reload, 900);
    }));
  } else if (it.loggedIn && it.accountLabel) {
    row.appendChild(btn('重新连接', '', async () => {
      out.textContent = '';
      const r = await window.soulweave.qqInstancesBindAccount({ id: it.id });
      out.textContent = '';
      if (!r || !r.ok) { out.appendChild(tip('重连失败：' + ((r && r.error) || '未知'), 'bad')); return; }
      out.appendChild(note('已请求重连：' + r.accountLabel, 'ok'));
      setTimeout(reload, 900);
    }));
  }

  if (it.managed) {
    row.appendChild(btn('删除这个账号', 'ghost', async () => {
      if (!confirm('删除这个 QQ 账号？会同时删掉它的实例目录和配置。')) return;
      const r = await window.soulweave.qqInstancesRemove({ id: it.id });
      if (!r || !r.ok) { alert('删除失败：' + ((r && r.error) || '未知')); return; }
      reload();
    }));
  }

  card.appendChild(row);
  card.appendChild(out);
  return card;
}

function note(text, kind) {
  return el('div', 'qi-note' + (kind ? ' ' + kind : ''), text);
}

async function doLaunch(it, out, card, reload) {
  out.textContent = '';
  out.appendChild(loading('已发起启动，正在等端口起来…'));
  const r = await window.soulweave.qqInstancesLaunch({ id: it.id }).catch((e) => ({ ok: false, error: String(e) }));
  if (!r || !r.ok) { out.textContent = ''; out.appendChild(tip('启动失败：' + ((r && r.error) || '未知'), 'bad')); return; }
  let n = 0;
  let stalled = 0;
  const t = setInterval(async () => {
    n++;
    if (!document.body.contains(card)) { clearInterval(t); return; }
    const s = await window.soulweave.qqInstancesList().catch(() => null);
    const cur = (s && s.instances || []).find((x) => x.id === it.id);
    if (cur && cur.webuiUp) { clearInterval(t); reload(); return; }
    stalled++;
    if (stalled % 4 === 0) {
      out.textContent = '';
      out.appendChild(loading('还在等端口…（已 ' + Math.round(n * 1.5) + ' 秒）'));
    }
    if (n >= 30) {
      clearInterval(t);
      const d = await window.soulweave.qqInstancesDiag({ id: it.id }).catch(() => null);
      out.textContent = '';
      out.appendChild(diagnoseView(it, d, false, async (elev) => {
        out.textContent = '';
        out.appendChild(loading(elev ? '已请求管理员方式启动…' : '已发起启动…'));
        await window.soulweave.qqInstancesLaunch({ id: it.id, elevated: elev });
        setTimeout(reload, 6000);
      }));
    }
  }, 1500);
}

function diagnoseView(it, d, elevated, relaunch) {
  const box = el('div', 'qi-diag');
  box.appendChild(el('div', 'qi-diag-h', '45 秒内端口没起来'));
  const facts = [];
  if (d && d.ok) {
    facts.push('WebUI ' + it.webuiPort + '：' + (d.ports.webui ? '通' : '不通'));
    facts.push('引导进程：' + d.bootCount + ' 个');
    facts.push('QQ 进程：' + d.qqCount + ' 个');
    facts.push('二维码缓存：' + (d.hasQrCache ? '有' : '无'));
  }
  for (const f of facts) box.appendChild(el('div', 'qi-diag-r', f));
  let advice = '';
  if (!d || !d.ok) advice = '拿不到诊断信息，重启 SoulWeave 后再试。';
  else if (d.bootCount === 0) advice = '引导进程没起来 —— 多半被系统拦下了。先试「换用管理员方式」，再不行检查杀毒软件。';
  else advice = '进程起了但端口不通：可能 QQ 拒绝再开实例，或被旧进程占着。先「杀掉僵尸进程」再启动。';
  box.appendChild(el('div', 'qi-diag-advice', advice));
  if (d && d.logTail) {
    const pre = el('pre', 'qi-diag-log');
    pre.textContent = d.logTail.slice(-900);
    box.appendChild(pre);
  }
  const acts = el('div', 'qi-acts');
  if (!elevated) acts.appendChild(btn('换用管理员方式', 'primary', () => relaunch(true)));
  acts.appendChild(btn('重新检查', '', () => {
    window.soulweave.qqInstancesDiag({ id: it.id }).then((dd) => {
      box.parentNode.replaceChild(diagnoseView(it, dd, elevated, relaunch), box);
    });
  }));
  box.appendChild(acts);
  return box;
}

async function showQr(it, out, reload) {
  out.textContent = '';
  const wrap = el('div', 'qi-qr');
  const img = document.createElement('img');
  img.alt = 'QQ 登录二维码';
  img.className = 'qi-qr-img';
  wrap.appendChild(img);
  const hint = el('div', 'qi-qr-hint', '正在获取二维码…');
  wrap.appendChild(hint);
  out.appendChild(wrap);

  let lastHash = '';
  let fails = 0;
  const load = async () => {
    const r = await window.soulweave.qqInstancesQrcode({ id: it.id }).catch(() => null);
    if (r && r.ok && r.pngBase64) {
      fails = 0;
      if (r.pngHash && r.pngHash === lastHash) {
        // 同一个码：不要动 DOM，也不要覆盖提示（旧码仍然有效）
        hint.textContent = '用手机 QQ 扫这个码';
        return;
      }
      lastHash = r.pngHash || '';
      img.src = 'data:image/png;base64,' + r.pngBase64;
      img.style.display = 'block';
      hint.textContent = '用手机 QQ 扫这个码';
      return;
    }
    if (r && r.loggedIn) { hint.textContent = '已登录'; return; }

    // 【关键】已经有一张码显示着了，就别用错误文案把它盖掉。
    // 轮询偶尔拿到一次失败很常见（NapCat 正在重建会话），
    // 旧码在 2 分钟内依然能扫。连续失败才提示可能是码过期了。
    fails++;
    if (lastHash) {
      if (fails >= 3) {
        hint.textContent = '二维码可能已过期：连续 ' + fails + ' 次取不到新码，点「重新登录」再试';
      }
      return;
    }
    img.style.display = 'none';
    hint.textContent = '二维码暂不可用' + (r && r.error ? '：' + r.error : '');
  };
  await load();

  const t = setInterval(async () => {
    if (!document.body.contains(wrap)) { clearInterval(t); return; }
    // 用 list 判定（它同时看 WebUI 和 OneBot，任一说是登录就算）
    const l = await window.soulweave.qqInstancesList().catch(() => null);
    const cur = (l && l.instances || []).find((x) => x.id === it.id);
    if (cur && cur.loggedIn) {
      clearInterval(t);
      hint.textContent = '✅ 已登录 ' + (cur.nick || cur.uin);
      setTimeout(reload, 700);
      return;
    }
    await load();
  }, 2500);
}

export function ensureQqInstancesStyles() {
  if (document.getElementById('qi-styles')) return;
  const st = document.createElement('style');
  st.id = 'qi-styles';
  st.textContent = `
.qi-card {
  padding: 13px 15px; margin-bottom: 10px;
  border: 1px solid var(--sb-line); border-radius: 12px;
  background: rgba(127,127,127,.045);
  transition: border-color .16s;
}
.qi-card:hover { border-color: rgba(110,168,254,.28); }
.qi-head { display: flex; align-items: flex-start; gap: 10px; flex-wrap: wrap; }
.qi-id { flex: 1; min-width: 0; }
.qi-label { font-size: 14px; font-weight: 650; }
.qi-uin-big {
  font-size: 12px; color: #A9C7FF; font-variant-numeric: tabular-nums;
  letter-spacing: .4px; margin-top: 2px;
}
.qi-sub { font-size: 11.5px; color: var(--sb-dim); margin-top: 3px; font-variant-numeric: tabular-nums; }
.qi-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.qi-chip {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11.5px; padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--sb-line); color: var(--sb-dim);
}
.qi-chip.on { color: #6EE7A8; border-color: rgba(110,231,168,.4); background: rgba(110,231,168,.1); }
.qi-chip.on.acc { color: #A9C7FF; border-color: rgba(110,168,254,.45); background: rgba(110,168,254,.12); }
.qi-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.qi-who { display: flex; align-items: center; gap: 8px; margin-top: 9px; flex-wrap: wrap; font-size: 11.5px; }
.qi-acc { color: var(--sb-dim); }
.qi-acts { display: flex; gap: 7px; margin-top: 11px; flex-wrap: wrap; }
.qi-add { margin-top: 12px; }
.qi-note {
  margin-top: 9px; padding: 8px 11px; border-radius: 8px; font-size: 11.5px;
  border: 1px solid var(--sb-line); background: rgba(127,127,127,.05); color: var(--sb-dim);
}
.qi-note.ok { border-color: rgba(110,231,168,.38); background: rgba(110,231,168,.08); color: #9CE8BF; }
.qi-qr { text-align: center; padding: 10px 0 2px; }
.qi-qr-img {
  width: 180px; height: 180px; border-radius: 10px; background: #fff; padding: 8px;
  display: none; margin: 0 auto;
}
.qi-qr-hint { font-size: 12px; color: var(--sb-dim); margin-top: 8px; line-height: 1.6; }
.qi-diag {
  margin-top: 10px; padding: 10px 12px; border-radius: 9px;
  border: 1px solid rgba(232,196,106,.35); background: rgba(232,196,106,.07);
}
.qi-diag-h { font-size: 12px; font-weight: 650; color: #E8C46A; margin-bottom: 6px; }
.qi-diag-r { font-size: 12px; color: var(--sb-dim); line-height: 1.75; font-variant-numeric: tabular-nums; }
.qi-diag-advice { font-size: 11.5px; color: var(--sb-fg); margin-top: 7px; line-height: 1.65; }
.qi-diag-log {
  margin-top: 8px; max-height: 130px; overflow: auto;
  font-size: 11.5px; line-height: 1.55; color: var(--sb-dim);
  background: rgba(0,0,0,.25); border-radius: 7px; padding: 8px 9px;
  white-space: pre-wrap; word-break: break-all;
}
`;
  document.head.appendChild(st);
}
