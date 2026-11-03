/**
 * SoulWeave：云端 Agent 界面（第二角色「小橘子」）
 *
 * 设计要点：
 *   · 服务商卡片带品牌标记与「获取 Key」直达官方页，用户不用自己找入口
 *   · Key 只显示是否已配置，不回显明文
 *   · 「测试连接」用真实对话请求验证，不是假 ping
 */

import { brandIcon } from './icons.js';

const $ = (s) => document.querySelector(s);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
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

function loading(text) { return el('div', 'ls-loading', text || '加载中…'); }

/** 入口：在「角色」模块里渲染云端 Agent 配置 */
export async function renderCloudAgent(host, rerender) {
  host.textContent = '';
  host.appendChild(loading('正在读取云端配置…'));

  let data = null, err = null;
  try {
    data = await window.soulweave.cloudAgentGet();
  } catch (e) { err = String(e); }

  host.textContent = '';
  if (err || !data || !data.ok) {
    host.appendChild(tip('读取失败：' + (err || (data && data.error) || '未知'), 'bad'));
    return;
  }

  const cfg = data.config || {};
  const providers = data.providers || [];
  const cur = providers.find((p) => p.id === cfg.providerId) || providers[0];

  // 说明
  host.appendChild(tip('「小橘子」走云端模型，需要你自己的 API Key。Key 用系统加密保存，界面上不回显。'));

  // ── 服务商选择 ──
  const sec = el('div', 'sec');
  sec.appendChild(el('div', 'sec-title', '选一个服务商'));
  sec.appendChild(el('div', 'sec-hint', '点卡片右侧的「获取 Key」直达官方控制台。国内服务不用梯子。'));

  const grid = el('div', 'ca-grid');
  for (const p of providers) {
    const card = el('div', 'ca-card' + (p.id === cfg.providerId ? ' on' : ''));
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');

    const head = el('div', 'ca-card-h');
    const mark = el('span', 'ca-mark');
    mark.innerHTML = brandIcon(p.iconId || p.id, 22);
    head.appendChild(mark);
    head.appendChild(el('span', 'ca-name', p.name));
    if (p.domestic) head.appendChild(el('span', 'ca-badge domestic', '国内'));
    card.appendChild(head);
    card.appendChild(el('div', 'ca-tag', p.tagline));

    const acts = el('div', 'ca-card-a');
    if (p.keyUrl) {
      const kb = btn('获取 Key', 'sm', async (e) => {
        e.stopPropagation();
        try { await window.soulweave.cloudAgentOpenKeyPage({ providerId: p.id, url: p.keyUrl }); }
        catch (err2) { alert('打开失败：' + err2); }
      });
      acts.appendChild(kb);
    }
    if (p.docsUrl) {
      acts.appendChild(btn('文档', 'sm', async (e) => {
        e.stopPropagation();
        try { await window.soulweave.cloudAgentOpenKeyPage({ url: p.docsUrl }); } catch (err2) { void err2; }
      }));
    }
    card.appendChild(acts);

    const pick = async () => {
      const r = await window.soulweave.cloudAgentSet({ providerId: p.id });
      if (r && r.ok) rerender();
    };
    card.addEventListener('click', pick);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    grid.appendChild(card);
  }
  sec.appendChild(grid);
  host.appendChild(sec);

  // ── 当前配置 ──
  const csec = el('div', 'sec');
  csec.appendChild(el('div', 'sec-title', '配置「' + (cur ? cur.name : '自定义') + '」'));

  if (cur && cur.note) csec.appendChild(tip(cur.note, 'warn'));

  // API Key
  const keyRow = el('div', 'ls-field');
  keyRow.appendChild(el('label', null, 'API Key'));
  const keyBody = el('div', 'ls-field-body');
  const keyIn = el('input', 'ls-input');
  keyIn.type = 'password';
  keyIn.autocomplete = 'off';
  keyIn.placeholder = cfg.hasKey ? '已保存（留空表示不修改）' : '粘贴你的 API Key';
  keyBody.appendChild(keyIn);
  if (cfg.hasKey) keyBody.appendChild(el('div', 'ls-note', '已保存 Key，不再显示明文。'));
  keyRow.appendChild(keyBody);
  csec.appendChild(keyRow);

  // 服务地址
  const urlRow = el('div', 'ls-field');
  urlRow.appendChild(el('label', null, '服务地址'));
  const urlBody = el('div', 'ls-field-body');
  const urlIn = el('input', 'ls-input');
  urlIn.type = 'text';
  urlIn.value = String(cfg.baseUrl || '');
  urlIn.placeholder = 'https://api.example.com/v1';
  urlBody.appendChild(urlIn);
  urlRow.appendChild(urlBody);
  csec.appendChild(urlRow);

  // 模型
  const mRow = el('div', 'ls-field');
  mRow.appendChild(el('label', null, '模型'));
  const mBody = el('div', 'ls-field-body');
  const models = (cur && cur.models) || [];
  if (models.length) {
    const sel = el('select', 'sel');
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m; o.textContent = m;
      if (cfg.model === m) o.selected = true;
      sel.appendChild(o);
    }
    mBody.appendChild(sel);
    mBody.appendChild(btn('或手动输入', 'sm', () => {
      sel.remove();
      const inp = el('input', 'ls-input');
      inp.type = 'text';
      inp.value = String(cfg.model || '');
      inp.placeholder = '模型名';
      inp.id = 'ca-model-input';
      mBody.insertBefore(inp, mBody.firstChild);
    }));
    mBody.dataset.usesSelect = '1';
  } else {
    const inp = el('input', 'ls-input');
    inp.type = 'text';
    inp.value = String(cfg.model || '');
    inp.placeholder = '模型名';
    inp.id = 'ca-model-input';
    mBody.appendChild(inp);
  }
  mRow.appendChild(mBody);
  csec.appendChild(mRow);

  // ── 网络出口 ──
  //
  // 之前出口写死「跟随系统代理」：用户一关代理客户端，境外服务立刻不通，
  // 报错只有 fetch failed，看不出是代理没了。这里把出口变成可选，
  // 并把「实际解析到的代理」显示出来，方便对账。
  const netRow = el('div', 'ls-field');
  netRow.appendChild(el('label', null, '网络'));
  const netBody = el('div', 'ls-field-body');

  const modeSel = document.createElement('select');
  modeSel.className = 'sel';
  const MODES = [
    ['system', '跟随系统代理'],
    ['direct', '强制直连（不用代理）'],
    ['custom', '自定义代理地址'],
  ];
  for (const [v, label] of MODES) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    if ((cfg.proxyMode || 'system') === v) o.selected = true;
    modeSel.appendChild(o);
  }
  netBody.appendChild(modeSel);

  const proxyIn = el('input', 'ls-input');
  proxyIn.type = 'text';
  proxyIn.value = String(cfg.proxyUrl || '');
  proxyIn.placeholder = 'http://127.0.0.1:10090';
  proxyIn.style.marginTop = '7px';
  proxyIn.style.display = (cfg.proxyMode === 'custom') ? '' : 'none';
  netBody.appendChild(proxyIn);

  const resolvedNote = el('div', 'ls-note', '正在读取实际出口…');
  netBody.appendChild(resolvedNote);

  modeSel.addEventListener('change', () => {
    proxyIn.style.display = modeSel.value === 'custom' ? '' : 'none';
  });

  netRow.appendChild(netBody);
  csec.appendChild(netRow);

  window.soulweave.cloudAgentProxyInfo().then((r) => {
    if (!r || !r.ok) { resolvedNote.textContent = '读取出口失败：' + ((r && r.error) || '未知'); return; }
    resolvedNote.textContent = '当前实际出口：' + r.resolved + (r.usingProxy ? '（走代理）' : '（直连）');
    if (!r.usingProxy && (cfg.proxyMode || 'system') === 'system') {
      resolvedNote.textContent += ' · 系统代理未开启，境外服务会连不上';
    }
  }).catch(() => { resolvedNote.textContent = ''; });

  // 操作
  const out = el('div');
  out.style.marginTop = '10px';

  const row = el('div', 'ls-btn-row');
  row.appendChild(btn('保存', 'primary', async () => {
    const patch = { baseUrl: urlIn.value.trim(), proxyMode: modeSel.value };
    if (modeSel.value === 'custom') patch.proxyUrl = proxyIn.value.trim();
    if (keyIn.value.trim()) patch.apiKey = keyIn.value.trim();
    const useSel = mBody.dataset.usesSelect === '1';
    const sel = mBody.querySelector('select');
    const inp = mBody.querySelector('#ca-model-input');
    patch.model = sel ? sel.value : (inp ? inp.value.trim() : cfg.model);
    const r = await window.soulweave.cloudAgentSet(patch);
    if (r && r.ok) rerender();
    else alert('保存失败：' + ((r && r.error) || '未知'));
  }));

  row.appendChild(btn('测试连接', '', async () => {
    out.textContent = '';
    out.appendChild(el('div', 'ls-note', '正在请求模型…'));
    const sel = mBody.querySelector('select');
    const inp = mBody.querySelector('#ca-model-input');
    const payload = {
      providerId: cfg.providerId,
      baseUrl: urlIn.value.trim(),
      model: sel ? sel.value : (inp ? inp.value.trim() : cfg.model),
      proxyMode: modeSel.value,
      proxyUrl: modeSel.value === 'custom' ? proxyIn.value.trim() : '',
    };
    if (keyIn.value.trim()) payload.apiKey = keyIn.value.trim();
    const r = await window.soulweave.cloudAgentTest(payload);
    out.textContent = '';
    if (r && r.ok) {
      out.appendChild(tip('连接成功' + (r.ms ? '（' + r.ms + ' ms）' : '') + (r.reply ? ' · 模型回：' + r.reply : ''), ''));
      if (r.proxy) out.appendChild(el('div', 'ls-note', '实际出口：' + r.proxy.resolved));
    } else {
      out.appendChild(tip('连接失败：' + ((r && r.error) || '未知'), 'bad'));
      if (r && r.proxy) out.appendChild(el('div', 'ls-note', '实际出口：' + r.proxy.resolved));
    }
  }));
  csec.appendChild(row);
  csec.appendChild(out);
  host.appendChild(csec);
}

/** 生成样式（只注入一次） */
export function ensureCloudAgentStyles() {
  if (document.getElementById('ca-styles')) return;
  const st = document.createElement('style');
  st.id = 'ca-styles';
  st.textContent = `
.ca-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
  gap: 9px;
  margin-bottom: 6px;
}
.ca-card {
  padding: 11px 12px;
  border: 1px solid var(--sb-line);
  border-radius: 10px;
  background: rgba(127,127,127,.05);
  cursor: pointer;
  transition: border-color .14s, background .14s, transform .08s;
}
.ca-card:hover { border-color: rgba(110,168,254,.45); background: rgba(127,127,127,.09); }
.ca-card:active { transform: scale(.99); }
.ca-card.on {
  border-color: rgba(110,168,254,.75);
  background: linear-gradient(135deg, rgba(110,168,254,.14), rgba(201,167,255,.07));
  box-shadow: inset 0 0 0 1px rgba(110,168,254,.25);
}
.ca-card:focus-visible { outline: 2px solid var(--sb-accent); outline-offset: 2px; }
.ca-card-h { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.ca-mark { display: inline-flex; flex: none; }
.ca-name { font-size: 12.5px; font-weight: 600; flex: 1; min-width: 0; }
.ca-badge {
  font-size: 11.5px; padding: 1px 5px; border-radius: 4px;
  border: 1px solid rgba(80,200,120,.4); color: #6FD08C;
  background: rgba(80,200,120,.14);
}
.ca-tag { font-size: 12px; color: var(--sb-dim); line-height: 1.5; }
.ca-card-a { display: flex; gap: 5px; margin-top: 8px; }
`;
  document.head.appendChild(st);
}