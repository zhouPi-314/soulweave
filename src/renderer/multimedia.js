/**
 * SoulWeave S7：多媒体中心（第 9 个已实现模块）
 *
 * 依据：01 需求 §7.9「麦克风/扬声器、ASR/TTS 服务…图片识别、QQ 图片、
 *       授权截图、图片生成 API、质量尺寸/次数」
 *       「内置测试麦克风 / 试听音色 / **测试图片理解** / **测试图片生成**」
 *
 * 三块：
 *   1. 图片理解 —— 上传/拖入/填 URL，测试识别，看结论
 *   2. 屏幕截图 —— 授权闸门（默认零授权）+ 截一张
 *   3. 设置     —— 视觉端点、QQ 图片开关、图片生成入口
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

export async function renderMultimedia(host, onChange) {
  host.textContent = '';
  host.appendChild(loading('正在读取多模态配置…'));

  const [vres, gres] = await Promise.all([
    window.soulweave.visionConfigGet().catch((e) => ({ ok: false, error: String(e) })),
    window.soulweave.captureGrants().catch((e) => ({ ok: false, error: String(e), grants: [] })),
  ]);

  host.textContent = '';
  if (!vres || !vres.ok) {
    host.appendChild(tip('读取视觉配置失败：' + ((vres && vres.error) || '未知'), 'bad'));
    return;
  }

  const cfg = vres.config || {};
  const eff = vres.effective || {};
  const reload = () => (onChange ? onChange() : renderMultimedia(host, onChange));

  // ── 状态条 ──
  const statSec = el('div', 'sec');
  statSec.appendChild(el('div', 'sec-title', '状态'));
  const stats = el('div', 'ls-stats');
  const mkStat = (k, v, u, cls) => {
    const s = el('div', 'ls-stat' + (cls ? ' ' + cls : ''));
    s.appendChild(el('div', 'ls-stat-k', k));
    const vv = el('div', 'ls-stat-v', String(v));
    if (u) vv.appendChild(el('span', 'ls-stat-u', u));
    s.appendChild(vv);
    return s;
  };
  stats.appendChild(mkStat('图片理解', eff.hasKey && eff.baseUrl ? '已配置' : '未配置', '', eff.hasKey ? 'hot' : ''));
  stats.appendChild(mkStat('QQ 图片', cfg.qqImageEnabled ? '识别' : '不识别', ''));
  stats.appendChild(mkStat('截图授权', (gres.grants || []).filter((g) => g.decision.allowed).length, '个', ''));
  // 用户最常问"到底用的哪个模型"，把它摆到状态条里，不用点进设置翻
  stats.appendChild(mkStat('识别模型', eff.model || '未选择', ''));
  statSec.appendChild(stats);
  if (!eff.hasKey) {
    statSec.appendChild(el('div', 'mm-next', '下一步：在下面的「识别方案」里填端点与 Key，或直接勾选「复用云端 Agent 的配置」。'));
    statSec.appendChild(tip('图片理解还没配好。可以在「角色 → 云端 Agent」配一次，这里勾选「复用」即可。', 'warn'));
  }
  host.appendChild(statSec);

  // ── 顺序：先"接上谁"，再"试一下" ──
  //
  // 【为什么把设置提到最前】
  // 原来第一屏是"图片理解"的测试框，但没配端点时它根本跑不出结果——
  // 用户看到的是一个用不了的工具，却不知道要先配 Key。
  // 现在：识别方案 → 图片理解（试）→ 屏幕截图（试），
  // 未配置时状态条已经给出提示，测试区也会自己说明。
  host.appendChild(settingsSection(cfg, eff, reload));
  host.appendChild(visionSection(cfg, eff, reload));
  host.appendChild(captureSection(gres, reload));
}

// ─── 图片理解 ───────────────────────────────────────

function visionSection(cfg, eff, reload) {
  const sec = el('div', 'sec');
  sec.appendChild(el('div', 'sec-title', '试一试：图片理解'));
  sec.appendChild(el('div', 'sec-hint',
    '把图片拖进来，或填一个图片地址，让模型描述它看到的内容。结果只显示在这里，不会自动发布。'));

  const drop = el('div', 'mm-drop');
  drop.appendChild(el('div', 'mm-drop-i', '⬇'));
  drop.appendChild(el('div', 'mm-drop-t', '把图片拖到这里，或点击选择文件'));
  drop.appendChild(el('div', 'mm-drop-h', '支持 PNG / JPEG / WebP / GIF，单张不超过 8 MB'));

  const fileIn = document.createElement('input');
  fileIn.type = 'file';
  fileIn.accept = 'image/png,image/jpeg,image/webp,image/gif';
  fileIn.style.display = 'none';

  const preview = el('div', 'mm-preview');
  const out = el('div');

  let pickedPath = null;
  let pickedDataUri = null;

  const showPicked = (name, dataUri) => {
    preview.textContent = '';
    const img = document.createElement('img');
    img.src = dataUri;
    img.className = 'mm-thumb';
    img.alt = name;
    preview.appendChild(img);
    const meta = el('div', 'mm-meta');
    meta.appendChild(el('div', 'mm-fname', name));
    preview.appendChild(meta);
  };

  const pick = async () => {
    const r = await window.soulweave.pickFile({
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    }).catch(() => null);
    if (!r || !r.ok || !r.path) return;
    pickedPath = r.path;
    pickedDataUri = null;
    const url = 'file:///' + String(r.path).replace(/\\/g, '/').replace(/[#%?]/g, encodeURIComponent);
    showPicked(String(r.path).split(/[\\/]/).pop() || '图片', url);
  };

  drop.addEventListener('click', pick);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (!/^image\//.test(f.type)) { out.textContent = ''; out.appendChild(tip('这个文件不是图片', 'bad')); return; }
    if (f.size > 8 * 1024 * 1024) { out.textContent = ''; out.appendChild(tip('图片超过 8 MB', 'bad')); return; }
    const buf = await f.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    pickedDataUri = 'data:' + f.type + ';base64,' + b64;
    pickedPath = null;
    showPicked(f.name, pickedDataUri);
  });

  drop.appendChild(fileIn);
  sec.appendChild(drop);
  sec.appendChild(preview);

  // URL 输入
  const urlRow = el('div', 'mm-url');
  const urlIn = el('input', 'ls-input');
  urlIn.type = 'text';
  urlIn.placeholder = '或者粘贴一个图片地址 https://…';
  urlRow.appendChild(urlIn);
  sec.appendChild(urlRow);

  const promptRow = el('div', 'mm-url');
  const promptIn = el('input', 'ls-input');
  promptIn.type = 'text';
  promptIn.placeholder = '想问什么？（留空 = 描述这张图）';
  promptRow.appendChild(promptIn);
  sec.appendChild(promptRow);

  const row = el('div', 'ls-btn-row');

  // 快速识别：只要一段描述
  row.appendChild(btn('快速识别', 'primary', async () => {
    out.textContent = '';
    const payload = { prompt: promptIn.value.trim() || undefined, sourceKind: 'user_upload' };
    if (pickedPath) payload.path = pickedPath;
    else if (pickedDataUri) payload.dataUri = pickedDataUri;
    else if (urlIn.value.trim()) payload.url = urlIn.value.trim();
    else { out.appendChild(tip('还没有图片', 'bad')); return; }

    out.appendChild(loading('正在识别…（首次可能要十几秒）'));
    const r = await window.soulweave.visionDescribe(payload).catch((e) => ({ ok: false, error: String(e) }));
    out.textContent = '';
    out.appendChild(visionResult(r));
  }));

  // 结构化识别：逐行 OCR + 版面 + 实体 + 不确定项（借 ModLens 的思路）
  row.appendChild(btn('结构化识别', '', async () => {
    out.textContent = '';
    const payload = { depth: 'full', prompt: promptIn.value.trim() || undefined, sourceKind: 'user_upload' };
    if (pickedPath) payload.path = pickedPath;
    else if (pickedDataUri) payload.dataUri = pickedDataUri;
    else if (urlIn.value.trim()) payload.url = urlIn.value.trim();
    else { out.appendChild(tip('还没有图片', 'bad')); return; }

    out.appendChild(loading('正在提取结构化证据…（图越大越慢）'));
    const r = await window.soulweave.visionEvidence(payload).catch((e) => ({ ok: false, error: String(e) }));
    out.textContent = '';
    if (!r || !r.ok) {
      out.appendChild(tip('识别失败：' + ((r && r.error) || '未知'), 'bad'));
      return;
    }
    out.appendChild(evidenceView(r));
  }));

  sec.appendChild(row);
  sec.appendChild(out);
  return sec;
}

/** 结构化证据展示（借鉴 ModLens 的 ocr/layout/semantics/uncertainty 结构） */
function evidenceView(r) {
  const ev = r.evidence || {};
  const box = el('div', 'mm-evidence');

  if (ev.summary) {
    const s = el('div', 'mm-ev-summary');
    s.textContent = ev.summary;
    box.appendChild(s);
  }

  // OCR：逐行转录
  const lines = (ev.ocr && ev.ocr.lines) || [];
  if (lines.length) {
    const sec = el('div', 'mm-ev-sec');
    const h = el('div', 'mm-ev-h');
    h.appendChild(el('span', 'mm-ev-t', '识别到的文字'));
    h.appendChild(el('span', 'mm-ev-c', lines.length + ' 行'));
    sec.appendChild(h);
    const body = el('div', 'mm-ev-ocr');
    for (const l of lines.slice(0, 60)) {
      const row = el('div', 'mm-ev-line');
      row.textContent = l.text;
      if (l.confidence != null && l.confidence < 0.7) row.classList.add('low');
      body.appendChild(row);
    }
    if (lines.length > 60) body.appendChild(el('div', 'mm-ev-more', '…还有 ' + (lines.length - 60) + ' 行'));
    sec.appendChild(body);
    box.appendChild(sec);
  }

  // 版面分区
  const regions = (ev.layout && ev.layout.regions) || [];
  if (regions.length) {
    const sec = el('div', 'mm-ev-sec');
    const h = el('div', 'mm-ev-h');
    h.appendChild(el('span', 'mm-ev-t', '版面结构'));
    h.appendChild(el('span', 'mm-ev-c', regions.length + ' 块'));
    sec.appendChild(h);
    const body = el('div', 'mm-ev-regions');
    for (const r2 of regions.slice(0, 20)) {
      const row = el('div', 'mm-ev-region');
      row.appendChild(el('span', 'mm-ev-type', r2.type));
      row.appendChild(el('span', 'mm-ev-text', r2.text));
      body.appendChild(row);
    }
    sec.appendChild(body);
    box.appendChild(sec);
  }

  // 实体
  const ents = (ev.semantics && ev.semantics.entities) || [];
  if (ents.length) {
    const sec = el('div', 'mm-ev-sec');
    sec.appendChild(el('div', 'mm-ev-h', '实体'));
    const tags = el('div', 'mm-tags');
    for (const e of ents.slice(0, 20)) {
      const t = el('span', 'mm-tag');
      t.textContent = e.name + (e.type && e.type !== 'other' ? '（' + e.type + '）' : '');
      tags.appendChild(t);
    }
    sec.appendChild(tags);
    box.appendChild(sec);
  }

  // 不确定项（模型自述）
  const unc = ev.uncertainty || [];
  if (unc.length) {
    const sec = el('div', 'mm-ev-sec mm-ev-unc');
    sec.appendChild(el('div', 'mm-ev-h', '模型没把握的地方'));
    for (const u of unc.slice(0, 10)) sec.appendChild(el('div', 'mm-ev-line', '· ' + u));
    box.appendChild(sec);
  }

  // 自检（我们自己加的防编造）
  const checks = ev.selfChecks || [];
  if (checks.length) {
    const sec = el('div', 'mm-ev-sec mm-ev-check');
    sec.appendChild(el('div', 'mm-ev-h', '自检提醒'));
    for (const c of checks) sec.appendChild(el('div', 'mm-ev-line', '· ' + c));
    box.appendChild(sec);
  }

  const meta = [];
  if (r.model) meta.push('模型 ' + r.model);
  if (r.ms) meta.push(r.ms + ' ms');
  if (r.parsed === false) meta.push('未按 JSON 返回');
  if (meta.length) box.appendChild(el('div', 'mm-result-meta', meta.join(' · ')));

  return box;
}

function visionResult(r) {
  const box = el('div', 'mm-result ' + (r && r.ok ? 'ok' : 'bad'));
  const head = el('div', 'mm-result-h');
  head.appendChild(el('span', 'mm-result-dot'));
  head.appendChild(el('span', null, r && r.ok ? '识别完成' : '识别失败'));
  box.appendChild(head);

  if (r && r.ok) {
    const body = el('div', 'mm-result-text');
    body.textContent = r.text || '';
    box.appendChild(body);
    if (r.tags && r.tags.length) {
      const tags = el('div', 'mm-tags');
      for (const t of r.tags) tags.appendChild(el('span', 'mm-tag', t));
      box.appendChild(tags);
    }
    const meta = [];
    if (r.model) meta.push('模型 ' + r.model);
    if (r.ms) meta.push(r.ms + ' ms');
    if (r.image) meta.push(r.image.format + ' ' + (r.image.width || '?') + '×' + (r.image.height || '?') + ' · ' + Math.round((r.image.bytes || 0) / 1024) + ' KB');
    if (meta.length) box.appendChild(el('div', 'mm-result-meta', meta.join(' · ')));
  } else {
    box.appendChild(el('div', 'mm-result-text', (r && r.error) || '未知错误'));
    if (r && r.code) box.appendChild(el('div', 'mm-result-meta', '错误码：' + r.code));
  }
  return box;
}

// ─── 屏幕截图 ───────────────────────────────────────

function captureSection(gres, reload) {
  const sec = el('div', 'sec');
  sec.appendChild(el('div', 'sec-title', '试一试：屏幕截图'));
  sec.appendChild(el('div', 'sec-hint',
    '默认**没有任何授权**。一次授权只对应一次截取，截完即失效；不会持续抓屏。截图只在内存里，不落盘。'));

  const grants = gres.grants || [];
  const accounts = grants.filter((g) => g.decision.allowed);

  const list = el('div', 'mm-grants');
  if (!grants.length) {
    list.appendChild(el('div', 'mm-empty', '还没有任何截图授权'));
  }
  for (const g of grants) {
    const card = el('div', 'mm-grant');
    const info = el('div', 'mm-grant-info');
    info.appendChild(el('div', 'mm-grant-name', g.ownerCharacter));
    const scopeLabel = g.grant.scope === 'once' ? '一次性' : g.grant.scope === 'session' ? '本次会话' : '已拒绝';
    const stateLabel = g.decision.allowed ? '可用' : g.decision.code;
    info.appendChild(el('div', 'mm-grant-sub', scopeLabel + ' · ' + stateLabel));
    card.appendChild(info);
    card.appendChild(btn('撤销', 'sm ghost', async () => {
      const r = await window.soulweave.captureRevoke({ ownerCharacter: g.ownerCharacter });
      if (r && r.ok) reload(); else alert('撤销失败：' + ((r && r.error) || '未知'));
    }));
    list.appendChild(card);
  }
  sec.appendChild(list);

  // 授权表单
  const form = el('div', 'mm-form');
  const roleIn = el('input', 'ls-input');
  roleIn.type = 'text';
  roleIn.placeholder = '给哪个角色授权（如 冰糖）';
  roleIn.value = (grants[0] && grants[0].ownerCharacter) || '冰糖';
  form.appendChild(roleIn);

  const scopeSel = document.createElement('select');
  scopeSel.className = 'ls-input';
  [['once', '只允许一次'], ['session', '本次会话允许（30 分钟）'], ['denied', '明确拒绝']].forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    scopeSel.appendChild(o);
  });
  form.appendChild(scopeSel);
  sec.appendChild(form);

  const out = el('div');
  const row = el('div', 'ls-btn-row');
  row.appendChild(btn('保存授权', '', async () => {
    const r = await window.soulweave.captureGrant({
      ownerCharacter: roleIn.value.trim(),
      scope: scopeSel.value,
      targetKind: 'fullscreen',
    });
    if (r && r.ok) { out.textContent = ''; out.appendChild(tip('已保存', 'ok')); reload(); }
    else { out.textContent = ''; out.appendChild(tip('保存失败：' + ((r && r.error) || '未知'), 'bad')); }
  }));
  row.appendChild(btn('立即截一张', 'primary', async () => {
    out.textContent = '';
    out.appendChild(loading('正在截图…'));
    const r = await window.soulweave.captureTake({
      ownerCharacter: roleIn.value.trim(),
      targetKind: 'fullscreen',
    }).catch((e) => ({ ok: false, error: String(e) }));
    out.textContent = '';
    out.appendChild(captureResult(r));
    if (r && r.ok) reload();
  }));
  sec.appendChild(row);
  sec.appendChild(out);
  return sec;
}

function captureResult(r) {
  const box = el('div', 'mm-result ' + (r && r.ok ? 'ok' : 'bad'));
  const head = el('div', 'mm-result-h');
  head.appendChild(el('span', 'mm-result-dot'));
  head.appendChild(el('span', null, r && r.ok ? '已截取' : '被拒绝'));
  box.appendChild(head);

  if (r && r.ok && r.dataUri) {
    const img = document.createElement('img');
    img.src = r.dataUri;
    img.className = 'mm-shot';
    box.appendChild(img);
    if (r.meta) box.appendChild(el('div', 'mm-result-meta',
      r.meta.width + '×' + r.meta.height + ' · ' + Math.round(r.meta.bytes / 1024) + ' KB'));
    box.appendChild(el('div', 'mm-result-meta', '这张图只在内存里，刷新页面就没了'));
  } else {
    box.appendChild(el('div', 'mm-result-text', (r && r.error) || '未知原因'));
    if (r && r.decision && r.decision.code) {
      box.appendChild(el('div', 'mm-result-meta', '判定：' + r.decision.code));
    }
  }
  return box;
}

// ─── 设置 ───────────────────────────────────────────

function settingsSection(cfg, eff, reload) {
  const sec = el('div', 'sec');
  sec.appendChild(el('div', 'sec-title', '识别方案'));

  // 复用云端 Agent
  const reuseRow = el('div', 'mm-row');
  const reuseLab = el('div', 'mm-lab');
  reuseLab.appendChild(el('div', 'mm-title', '复用云端 Agent 的配置'));
  reuseLab.appendChild(el('div', 'mm-hint', '勾上就用「角色 → 云端 Agent」里的地址、模型和 Key，不用再填一遍。'));
  reuseRow.appendChild(reuseLab);
  reuseRow.appendChild(btn(cfg.reuseCloudAgent ? '已开启' : '已关闭', 'sm', async () => {
    const r = await window.soulweave.visionConfigSet({ reuseCloudAgent: !cfg.reuseCloudAgent });
    if (r && r.ok) reload();
  }));
  sec.appendChild(reuseRow);

  // 当前实际生效
  const effBox = el('div', 'mm-eff');
  effBox.appendChild(el('div', 'mm-eff-r', '地址：' + (eff.baseUrl || '（未配置）')));
  effBox.appendChild(el('div', 'mm-eff-r', '模型：' + (eff.model || '（未配置）')));
  effBox.appendChild(el('div', 'mm-eff-r', 'Key：' + (eff.hasKey ? '已配置' : '（未配置）')));
  sec.appendChild(effBox);

  // 自定义端点
  const custom = el('div', 'mm-form');
  const urlIn = el('input', 'ls-input');
  urlIn.type = 'text';
  urlIn.placeholder = '自定义视觉端点（留空则用上面的）';
  urlIn.value = cfg.baseUrl || '';
  custom.appendChild(urlIn);
  const modelIn = el('input', 'ls-input');
  modelIn.type = 'text';
  modelIn.placeholder = '视觉模型名，如 qwen-vl-plus / glm-4v / gpt-4o-mini';
  modelIn.value = cfg.model || '';
  custom.appendChild(modelIn);
  const keyIn = el('input', 'ls-input');
  keyIn.type = 'password';
  keyIn.placeholder = cfg.hasKey ? '已保存（留空不修改）' : 'API Key';
  custom.appendChild(keyIn);
  sec.appendChild(custom);

  const out = el('div');
  const row = el('div', 'ls-btn-row');
  row.appendChild(btn('保存', '', async () => {
    const patch = { baseUrl: urlIn.value.trim(), model: modelIn.value.trim() };
    if (keyIn.value.trim()) patch.apiKey = keyIn.value.trim();
    const r = await window.soulweave.visionConfigSet(patch);
    out.textContent = '';
    if (r && r.ok) { out.appendChild(tip('已保存', 'ok')); reload(); }
    else out.appendChild(tip('保存失败：' + ((r && r.error) || '未知'), 'bad'));
  }));
  row.appendChild(btn('测试图片理解', 'primary', async () => {
    out.textContent = '';
    out.appendChild(loading('正在发一张 1×1 的图测试…'));
    const r = await window.soulweave.visionTest({}).catch((e) => ({ ok: false, error: String(e) }));
    out.textContent = '';
    out.appendChild(visionResult(r));
  }));
  sec.appendChild(row);
  sec.appendChild(out);

  // QQ 图片
  const qqRow = el('div', 'mm-row');
  const qqLab = el('div', 'mm-lab');
  qqLab.appendChild(el('div', 'mm-title', '识别 QQ 好友发来的图片'));
  qqLab.appendChild(el('div', 'mm-hint',
    '默认关闭。开启后，好友发来的图片会被下载并发送给上面的服务商识别——请确认你接受这一点。'));
  qqRow.appendChild(qqLab);
  qqRow.appendChild(btn(cfg.qqImageEnabled ? '已开启' : '已关闭', 'sm', async () => {
    const r = await window.soulweave.visionConfigSet({ qqImageEnabled: !cfg.qqImageEnabled });
    if (r && r.ok) reload();
  }));
  sec.appendChild(qqRow);

  if (cfg.qqImageEnabled) {
    sec.appendChild(tip('QQ 图片识别已开启：好友发来的图片会上传到你配置的服务商。', 'warn'));
  }

  // 图片生成入口
  const genSec = el('div', 'mm-gen');
  genSec.appendChild(el('div', 'mm-title', '图片生成'));
  genSec.appendChild(el('div', 'mm-hint', '图片生成的完整设置在「虚拟生活 → 图片生成」。这里只做跳转。'));
  const goBtn = btn('去图片生成设置 →', 'sm', () => {
    const nav = Array.from(document.querySelectorAll('#sb-nav .nav-item')).find((b) => b.textContent.includes('虚拟生活'));
    if (nav) nav.click();
  });
  genSec.appendChild(goBtn);
  sec.appendChild(genSec);

  return sec;
}

export function ensureMultimediaStyles() {
  if (document.getElementById('mm-styles')) return;
  const st = document.createElement('style');
  st.id = 'mm-styles';
  st.textContent = `
.mm-drop {
  border: 1.5px dashed rgba(110,168,254,.35); border-radius: 12px;
  padding: 22px 16px; text-align: center; cursor: pointer;
  background: rgba(110,168,254,.04); transition: border-color .16s, background .16s;
}
.mm-drop:hover, .mm-drop.over { border-color: rgba(110,168,254,.75); background: rgba(110,168,254,.10); }
.mm-drop-i { font-size: 22px; color: #6EA8FE; opacity: .8; }
.mm-drop-t { font-size: 12.5px; margin-top: 6px; font-weight: 600; }
.mm-drop-h { font-size: 11.5px; color: var(--sb-dim); margin-top: 4px; }
.mm-preview { display: flex; gap: 10px; align-items: center; margin-top: 10px; }
.mm-thumb { max-width: 120px; max-height: 120px; border-radius: 8px; border: 1px solid var(--sb-line); }
.mm-meta { font-size: 12px; color: var(--sb-dim); }
.mm-fname { font-weight: 600; color: var(--sb-fg); }
.mm-url { margin-top: 9px; }
.mm-result {
  margin-top: 10px; padding: 11px 13px; border-radius: 10px;
  border: 1px solid var(--sb-line); background: rgba(127,127,127,.05);
}
.mm-result.ok { border-color: rgba(110,231,168,.4); background: rgba(110,231,168,.07); }
.mm-result.bad { border-color: rgba(255,120,120,.4); background: rgba(255,120,120,.07); }
.mm-result-h { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 650; }
.mm-result.ok .mm-result-h { color: #6EE7A8; }
.mm-result.bad .mm-result-h { color: #FF8E8E; }
.mm-result-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.mm-result-text {
  margin-top: 7px; font-size: 12px; line-height: 1.7; color: var(--sb-fg);
  white-space: pre-wrap; max-height: 260px; overflow: auto;
}
.mm-result-meta { margin-top: 6px; font-size: 11.5px; color: var(--sb-dim); font-variant-numeric: tabular-nums; }
.mm-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.mm-tag {
  font-size: 11.5px; padding: 2px 8px; border-radius: 999px;
  border: 1px solid rgba(110,168,254,.4); background: rgba(110,168,254,.12); color: #A9C7FF;
}
.mm-shot { max-width: 100%; border-radius: 9px; border: 1px solid var(--sb-line); margin-top: 8px; }

/* 结构化证据 */
.mm-evidence {
  margin-top: 10px; padding: 12px 14px; border-radius: 11px;
  border: 1px solid var(--sb-line); background: rgba(127,127,127,.05);
}
.mm-ev-summary { font-size: 12.5px; line-height: 1.7; color: var(--sb-fg); }
.mm-ev-sec { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--sb-line); }
.mm-ev-sec:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
.mm-ev-h {
  display: flex; align-items: center; gap: 8px;
  font-size: 12px; font-weight: 650; color: var(--sb-dim); margin-bottom: 7px;
}
.mm-ev-t { color: var(--sb-fg); }
.mm-ev-c {
  font-size: 11.5px; padding: 1px 6px; border-radius: 999px;
  border: 1px solid var(--sb-line); color: var(--sb-dim);
}
.mm-ev-ocr {
  max-height: 220px; overflow: auto; border-radius: 8px;
  background: rgba(0,0,0,.22); padding: 9px 11px;
}
.mm-ev-line {
  font-size: 11.5px; line-height: 1.75; color: var(--sb-fg);
  white-space: pre-wrap; word-break: break-word;
}
.mm-ev-line.low { color: #E8C46A; }
.mm-ev-more { font-size: 11.5px; color: var(--sb-dim); margin-top: 5px; }
.mm-ev-regions { display: flex; flex-direction: column; gap: 5px; }
.mm-ev-region { display: flex; gap: 8px; align-items: baseline; font-size: 11.5px; }
.mm-ev-type {
  flex: none; font-size: 11.5px; padding: 1px 6px; border-radius: 4px;
  border: 1px solid rgba(110,168,254,.4); color: #A9C7FF; background: rgba(110,168,254,.1);
}
.mm-ev-text { flex: 1; min-width: 0; line-height: 1.6; }
.mm-ev-unc .mm-ev-line { color: #E8C46A; }
.mm-ev-check .mm-ev-line { color: #FF8E8E; }
.mm-grants { display: flex; flex-direction: column; gap: 7px; margin-bottom: 10px; }
.mm-grant {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 12px; border-radius: 9px;
  border: 1px solid var(--sb-line); background: rgba(127,127,127,.045);
}
.mm-grant-info { flex: 1; min-width: 0; }
.mm-grant-name { font-size: 12px; font-weight: 650; }
.mm-grant-sub { font-size: 11.5px; color: var(--sb-dim); margin-top: 2px; }
.mm-empty { font-size: 12px; color: var(--sb-dim); }
.mm-form { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.mm-form > * { flex: 1; min-width: 160px; }
.mm-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.mm-lab { flex: 1; min-width: 0; }
.mm-title { font-size: 12.5px; font-weight: 650; }
.mm-hint { font-size: 11.5px; color: var(--sb-dim); margin-top: 3px; line-height: 1.55; }
.mm-eff {
  padding: 9px 12px; border-radius: 9px; margin-bottom: 10px;
  border: 1px solid var(--sb-line); background: rgba(127,127,127,.04);
}
.mm-eff-r { font-size: 12px; color: var(--sb-dim); line-height: 1.8; font-variant-numeric: tabular-nums; }
.mm-gen { margin-top: 12px; padding: 11px 13px; border-radius: 10px; border: 1px solid var(--sb-line); }
.ls-stat.hot .ls-stat-v { color: #6EE7A8; }
`;
  document.head.appendChild(st);
}