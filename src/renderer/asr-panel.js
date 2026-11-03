/**
 * SoulWeave S7：云端 ASR 服务商面板
 *
 * 用户要求：第一层（OpenAI 兼容通用）与第二层（协议不兼容的大厂）
 * 都放在同一个「云端 ASR」区，并且要有**官方图标**。
 *
 * 设计参考角色模块的服务商卡片：一行一个品牌，左图标右信息，
 * 选中后展开凭据表单，填完点「测试连接」。
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

function tip(text, kind) {
  const t = el('div', 'ls-tip' + (kind ? ' ' + kind : ''));
  t.appendChild(el('span', 'ls-tip-i', kind === 'bad' ? '✕' : kind === 'warn' ? '!' : 'i'));
  t.appendChild(el('span', null, text));
  return t;
}

const loading = (t) => el('div', 'ls-loading', t || '加载中…');

export async function renderAsrSection(host, rerender) {
  host.textContent = '';
  host.appendChild(loading('正在读取语音识别配置…'));

  const res = await window.soulweave.asrConfigGet().catch((e) => ({ ok: false, error: String(e) }));
  host.textContent = '';
  if (!res || !res.ok) {
    host.appendChild(tip('读取失败：' + ((res && res.error) || '未知'), 'bad'));
    return;
  }

  const universal = res.universal || [];
  const vendor = res.vendor || [];
  const cfg = res.config || {};
  const creds = res.credentials || {};
  const reload = () => (rerender ? rerender() : renderAsrSection(host, rerender));

  // ── 当前状态 ──
  const stat = el('div', 'asr-stat');
  if (cfg.enabled && cfg.providerId) {
    const p = [...universal, ...vendor].find((x) => x.id === cfg.providerId);
    stat.appendChild(el('span', 'asr-stat-on', '● 已启用'));
    stat.appendChild(el('span', 'asr-stat-txt', (p ? p.name : cfg.providerId) + (cfg.model ? (' · ' + cfg.model) : '')));
  } else {
    stat.appendChild(el('span', 'asr-stat-off', '○ 未启用'));
    stat.appendChild(el('span', 'asr-stat-txt', '语音识别默认用本地 whisper，云端是可选加速'));
  }
  host.appendChild(stat);

  // ── 第一层：OpenAI 兼容通用 ──
  host.appendChild(layerBlock('第一层 · OpenAI 兼容通用接口',
    '只要对方支持 audio/transcriptions 协议就能接。填 Base URL 即可，包括你自己的中转站或自建服务。',
    universal, cfg, creds, reload));

  // ── 第二层：协议不兼容的大厂 ──
  host.appendChild(layerBlock('第二层 · 协议不兼容的大厂',
    '这些厂商用自有签名与异步任务，需要单独适配。优点是中文质量与免费额度更好。',
    vendor, cfg, creds, reload));
}

function layerBlock(title, hint, providers, cfg, creds, reload) {
  const box = el('div', 'asr-layer');
  const head = el('div', 'asr-layer-h');
  head.appendChild(el('div', 'asr-layer-t', title));
  head.appendChild(el('div', 'asr-layer-c', providers.length + ' 家'));
  box.appendChild(head);
  box.appendChild(el('div', 'asr-layer-hint', hint));

  const grid = el('div', 'asr-grid');
  for (const p of providers) {
    const on = cfg.providerId === p.id;
    const card = el('div', 'asr-card' + (on ? ' on' : ''));

    const top = el('div', 'asr-card-top');
    const mark = el('span', 'asr-mark');
    mark.innerHTML = brandIcon(p.iconId || p.id, 24);
    top.appendChild(mark);
    const meta = el('div', 'asr-meta');
    meta.appendChild(el('div', 'asr-name', p.name));
    meta.appendChild(el('div', 'asr-tag', p.tagline));
    top.appendChild(meta);
    if (p.domestic) top.appendChild(el('span', 'asr-badge', '国内'));
    card.appendChild(top);

    // 免费额度 / 计费
    const rows = el('div', 'asr-rows');
    if (p.freeTier) rows.appendChild(kv('免费', p.freeTier, /无/.test(p.freeTier) ? '' : 'good'));
    if (p.pricing) rows.appendChild(kv('计费', p.pricing));
    if (p.models && p.models.length) rows.appendChild(kv('模型', p.models.slice(0, 3).join(' / ')));
    card.appendChild(rows);

    if (p.note) card.appendChild(el('div', 'asr-note', p.note));

    // 操作行
    const acts = el('div', 'asr-acts');
    if (p.keyUrl) {
      acts.appendChild(btn('获取 Key', 'sm', async () => {
        try { await window.soulweave.asrOpenUrl({ url: p.keyUrl }); } catch (e) { /* ignore */ }
      }));
    }
    if (p.docsUrl) {
      acts.appendChild(btn('文档', 'sm ghost', async () => {
        try { await window.soulweave.asrOpenUrl({ url: p.docsUrl }); } catch (e) { /* ignore */ }
      }));
    }
    acts.appendChild(btn(on ? '已启用' : '配置…', on ? 'sm' : 'sm primary', () => {
      openConfig(p, cfg, creds[p.id] || {}, reload);
    }));
    card.appendChild(acts);

    grid.appendChild(card);
  }
  box.appendChild(grid);
  return box;
}

function kv(k, v, cls) {
  const r = el('div', 'asr-kv');
  r.appendChild(el('span', 'asr-k', k));
  r.appendChild(el('span', 'asr-v' + (cls ? ' ' + cls : ''), v));
  return r;
}

/** 配置弹窗 */
function openConfig(p, cfg, saved, reload) {
  const mask = el('div', 'asr-mask');
  const modal = el('div', 'asr-modal');

  const head = el('div', 'asr-modal-h');
  const mark = el('span', 'asr-mark');
  mark.innerHTML = brandIcon(p.iconId || p.id, 22);
  head.appendChild(mark);
  head.appendChild(el('div', 'asr-modal-t', p.name));
  const x = el('button', 'asr-x', '✕');
  x.type = 'button';
  x.title = '关闭';
  x.addEventListener('click', () => mask.remove());
  head.appendChild(x);
  modal.appendChild(head);

  const body = el('div', 'asr-modal-b');
  const inputs = {};

  // Base URL（通用层可改；自定义必填）
  if (p.protocol === 'openai-compatible') {
    body.appendChild(field('Base URL', 'baseUrl', p.baseUrl || '', p.id === 'custom' ? '必填，如 https://api.xxx.com/v1' : '留空用默认'));
  }

  // 凭据
  for (const c of p.credentials) {
    body.appendChild(field(c.label, c.key, (saved[c.key] || ''), c.placeholder || '', !!c.secret));
  }

  // 模型
  if (p.models && p.models.length) {
    const row = el('div', 'asr-f');
    row.appendChild(el('label', 'asr-f-l', '模型'));
    const sel = document.createElement('select');
    sel.className = 'ls-input';
    for (const m of p.models) {
      const o = document.createElement('option');
      o.value = m; o.textContent = m;
      if (cfg.model === m) o.selected = true;
      sel.appendChild(o);
    }
    row.appendChild(sel);
    inputs.__model = sel;
    body.appendChild(row);
  } else {
    body.appendChild(field('模型', 'model', cfg.model || '', '填模型名'));
  }

  modal.appendChild(body);

  const out = el('div', 'asr-out');
  const foot = el('div', 'asr-foot');
  const saveBtn = btn('保存并启用', 'primary', async () => {
    saveBtn.disabled = true;
    out.textContent = '';
    const payload = { providerId: p.id, enabled: true };
    const c = {};
    for (const k of Object.keys(inputs)) {
      if (k === '__model') continue;
      const v = String(inputs[k].value || '').trim();
      if (v) c[k] = v;
    }
    payload.credentials = c;
    if (inputs.__model) payload.model = inputs.__model.value;
    else if (inputs.model) payload.model = String(inputs.model.value || '').trim();
    if (inputs.baseUrl) payload.baseUrl = String(inputs.baseUrl.value || '').trim();
    const r = await window.soulweave.asrConfigSet(payload).catch((e) => ({ ok: false, error: String(e) }));
    saveBtn.disabled = false;
    out.textContent = '';
    if (r && r.ok) {
      out.appendChild(tip('已保存并启用', 'ok'));
      setTimeout(() => { mask.remove(); reload(); }, 500);
    } else {
      out.appendChild(tip('保存失败：' + ((r && r.error) || '未知'), 'bad'));
    }
  });
  foot.appendChild(saveBtn);

  const testBtn = btn('测试连接', '', async () => {
    testBtn.disabled = true;
    testBtn.textContent = '测试中…';
    out.textContent = '';
    out.appendChild(loading('正在发一段静音测试…'));
    const c = {};
    for (const k of Object.keys(inputs)) {
      if (k === '__model') continue;
      const v = String(inputs[k].value || '').trim();
      if (v) c[k] = v;
    }
    const r = await window.soulweave.asrTest({
      providerId: p.id, credentials: c,
      model: inputs.__model ? inputs.__model.value : (inputs.model ? String(inputs.model.value || '').trim() : undefined),
      baseUrl: inputs.baseUrl ? String(inputs.baseUrl.value || '').trim() : undefined,
    }).catch((e) => ({ ok: false, error: String(e) }));
    testBtn.disabled = false;
    testBtn.textContent = '测试连接';
    out.textContent = '';
    const box = el('div', 'asr-res ' + (r && r.ok ? 'ok' : 'bad'));
    const h = el('div', 'asr-res-h');
    h.appendChild(el('span', 'asr-res-dot'));
    h.appendChild(el('span', null, r && r.ok ? '连接成功' : '连接失败'));
    box.appendChild(h);
    if (r && r.ok) {
      if (r.ms) box.appendChild(el('div', 'asr-res-r', '耗时 ' + r.ms + ' ms'));
      if (r.text) box.appendChild(el('div', 'asr-res-r', '识别结果：' + r.text));
    } else {
      box.appendChild(el('div', 'asr-res-r', (r && r.error) || '未知错误'));
    }
    out.appendChild(box);
  });
  foot.appendChild(testBtn);

  if (cfg.providerId === p.id) {
    foot.appendChild(btn('停用', 'ghost', async () => {
      const r = await window.soulweave.asrConfigSet({ enabled: false }).catch(() => null);
      if (r && r.ok) { mask.remove(); reload(); }
    }));
  }
  foot.appendChild(btn('取消', 'ghost', () => mask.remove()));
  modal.appendChild(foot);
  modal.appendChild(out);

  mask.appendChild(modal);
  mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
  document.body.appendChild(mask);

  function field(label, key, value, placeholder, secret) {
    const row = el('div', 'asr-f');
    row.appendChild(el('label', 'asr-f-l', label));
    const inp = document.createElement('input');
    inp.className = 'ls-input';
    inp.type = secret ? 'password' : 'text';
    inp.value = value || '';
    inp.placeholder = placeholder || '';
    row.appendChild(inp);
    inputs[key] = inp;
    return row;
  }
}

export function ensureAsrStyles() {
  if (document.getElementById('asr-styles')) return;
  const st = document.createElement('style');
  st.id = 'asr-styles';
  st.textContent = `
.asr-stat {
  display: flex; align-items: center; gap: 9px;
  padding: 10px 13px; border-radius: 9px; margin-bottom: 12px;
  border: 1px solid var(--sb-line); background: rgba(127,127,127,.04);
}
.asr-stat-on { color: #6EE7A8; font-size: 12px; font-weight: 650; }
.asr-stat-off { color: var(--sb-dim); font-size: 12px; font-weight: 650; }
.asr-stat-txt { font-size: 11.5px; color: var(--sb-dim); }
.asr-layer { margin-bottom: 16px; }
.asr-layer-h { display: flex; align-items: center; gap: 9px; margin-bottom: 4px; }
.asr-layer-t { font-size: 12.5px; font-weight: 650; }
.asr-layer-c {
  font-size: 11.5px; padding: 1px 8px; border-radius: 999px;
  border: 1px solid var(--sb-line); color: var(--sb-dim);
}
.asr-layer-hint { font-size: 11.5px; color: var(--sb-dim); margin-bottom: 10px; line-height: 1.6; }
.asr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 9px; }
.asr-card {
  padding: 11px 12px; border-radius: 11px;
  border: 1px solid var(--sb-line); background: rgba(127,127,127,.045);
  transition: border-color .16s, background .16s;
}
.asr-card:hover { border-color: rgba(110,168,254,.35); }
.asr-card.on {
  border-color: rgba(110,168,254,.75);
  background: linear-gradient(135deg, rgba(110,168,254,.13), rgba(201,167,255,.06));
}
.asr-card-top { display: flex; align-items: center; gap: 9px; }
.asr-mark { display: inline-flex; flex: none; }
.asr-meta { flex: 1; min-width: 0; }
.asr-name { font-size: 12.5px; font-weight: 650; }
.asr-tag { font-size: 11.5px; color: var(--sb-dim); margin-top: 2px; line-height: 1.5; }
.asr-badge {
  font-size: 11.5px; padding: 1px 6px; border-radius: 4px;
  border: 1px solid rgba(110,231,168,.4); color: #6EE7A8; background: rgba(110,231,168,.12);
}
.asr-rows { margin-top: 9px; display: flex; flex-direction: column; gap: 3px; }
.asr-kv { display: flex; gap: 7px; font-size: 11.5px; line-height: 1.5; }
.asr-k { color: var(--sb-dim); flex: none; min-width: 30px; }
.asr-v { color: var(--sb-fg); flex: 1; min-width: 0; word-break: break-word; }
.asr-v.good { color: #6EE7A8; }
.asr-note {
  margin-top: 8px; padding: 6px 9px; border-radius: 7px; font-size: 11.5px; line-height: 1.55;
  background: rgba(232,196,106,.08); color: #E8C46A;
}
.asr-acts { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
.asr-mask {
  position: fixed; inset: 0; z-index: 9200; background: rgba(6,6,12,.68);
  display: flex; align-items: center; justify-content: center;
}
.asr-modal {
  width: min(480px, 93vw); max-height: 85vh; display: flex; flex-direction: column;
  border: 1px solid var(--sb-line); border-radius: 14px; background: #16161E;
  box-shadow: 0 24px 64px rgba(0,0,0,.55);
}
.asr-modal-h {
  display: flex; align-items: center; gap: 9px;
  padding: 13px 15px; border-bottom: 1px solid var(--sb-line);
}
.asr-modal-t { flex: 1; font-size: 13px; font-weight: 650; }
.asr-x {
  border: 0; background: transparent; color: var(--sb-dim);
  cursor: pointer; font-size: 12px; padding: 2px 7px; border-radius: 5px;
}
.asr-x:hover { background: rgba(255,120,120,.16); color: #FF8E8E; }
.asr-modal-b { padding: 13px 15px 4px; overflow: auto; }
.asr-f { margin-bottom: 11px; }
.asr-f-l { display: block; font-size: 11.5px; color: var(--sb-dim); margin-bottom: 5px; }
.asr-foot {
  display: flex; gap: 8px; padding: 10px 15px 14px; flex-wrap: wrap; align-items: center;
}
.asr-out { padding: 0 15px 14px; }
.asr-res {
  padding: 10px 12px; border-radius: 9px;
  border: 1px solid var(--sb-line); background: rgba(127,127,127,.05);
}
.asr-res.ok { border-color: rgba(110,231,168,.4); background: rgba(110,231,168,.08); }
.asr-res.bad { border-color: rgba(255,120,120,.4); background: rgba(255,120,120,.08); }
.asr-res-h { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 650; }
.asr-res.ok .asr-res-h { color: #6EE7A8; }
.asr-res.bad .asr-res-h { color: #FF8E8E; }
.asr-res-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.asr-res-r { font-size: 12px; color: var(--sb-dim); margin-top: 4px; line-height: 1.6; }
`;
  document.head.appendChild(st);
}
