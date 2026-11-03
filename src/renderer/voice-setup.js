import { swCall, swOn } from './api.js';
/**
 * SoulWeave S3-8：语音组件引导与配置
 *
 * 定位：不是「下载器」，是**引导器**。
 * 因为 espeak-ng 是 GPL-3.0、GPT-SoVITS 是 3–5 GB 运行时，
 * 由应用代为下载会把分发责任揽到自己身上（见 S3-07 评估）。
 *
 * 所以这里只做三件事：
 *   1. 说明每个组件是什么、为什么要它、什么许可
 *   2. 打开上游页面（用户自己取）
 *   3. 自动探测 / 手动指定它装在哪，并记住
 */
const STATUS_TEXT = {
  ready: '已就绪',
  missing: '路径不存在',
  invalid: '内容不对',
  unconfigured: '未配置',
};

let lastComponents = [];
let lastPiperNote = '';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function statusClass(s) {
  if (s === 'ready') return 'ok';
  if (s === 'unconfigured') return 'warn';
  return 'bad';
}

export async function refreshComponents() {
  const api = window.soulweave;
  if (!api?.listVoiceComponents) { lastComponents = []; return []; }
  try {
    const r = await swCall('listVoiceComponents', );
    lastComponents = (r && r.components) || [];
  } catch (e) {
    lastComponents = [];
  }
  return lastComponents;
}

export function getComponents() { return lastComponents; }

/** 渲染引导区 */
export function renderSetup(host) {
  if (!host) return;
  host.textContent = '';

  if (!lastComponents.length) {
    host.appendChild(el('div', 'set-hint', '正在读取组件状态…'));
    return;
  }

  for (const c of lastComponents) {
    const box = el('div', 'cmp-item');

    const head = el('div', 'cmp-head');
    head.appendChild(el('span', 'cmp-name', c.label));
    const badge = el('span', 'cmp-badge ' + statusClass(c.status), STATUS_TEXT[c.status] || c.status);
    head.appendChild(badge);
    box.appendChild(head);

    box.appendChild(el('div', 'cmp-why', c.why));
    box.appendChild(el('div', 'cmp-meta', '许可：' + c.license));

    if (c.path) {
      box.appendChild(el('div', 'cmp-path', c.path));
    }
    if (c.detail && c.status !== 'ready') {
      box.appendChild(el('div', 'cmp-detail', c.detail));
    }

    const row = el('div', 'cmp-actions');

    const btnUp = el('button', 'cap-chip', '前往获取');
    btnUp.type = 'button';
    btnUp.title = c.upstream;
    btnUp.addEventListener('click', async () => {
      try { await swCall('openComponentUpstream', c.id); } catch (e) { console.error('[soulweave]', e); }
    });
    row.appendChild(btnUp);

    if (c.kind !== 'service') {
      const btnAuto = el('button', 'cap-chip', '自动探测');
      btnAuto.type = 'button';
      btnAuto.addEventListener('click', async () => {
        btnAuto.disabled = true;
        const old = btnAuto.textContent;
        btnAuto.textContent = '探测中…';
        const r = await swCall('autoDetectComponent', c.id);
        btnAuto.disabled = false;
        btnAuto.textContent = old;
        if (r && r.ok) { await refreshComponents(); renderSetup(host); }
        else { btnAuto.title = (r && r.error) || '未找到'; }
      });
      row.appendChild(btnAuto);

      const btnPick = el('button', 'cap-chip', '指定位置');
      btnPick.type = 'button';
      btnPick.addEventListener('click', async () => {
        const p = window.__pickComponentPath ? await window.__pickComponentPath(c.kind) : null;
        if (!p) return;
        const r = await swCall('setComponentPath', c.id, p);
        if (r && r.ok) { await refreshComponents(); renderSetup(host); }
      });
      row.appendChild(btnPick);
      // 探活：service 组件专用
      if (c.kind === 'service') {
        const btnProbe = el('button', 'cap-chip', '测试连接');
        btnProbe.type = 'button';
        btnProbe.addEventListener('click', async () => {
          btnProbe.disabled = true;
          const old = btnProbe.textContent;
          btnProbe.textContent = '连接中…';
          const r = await swCall('probeComponent', c.id);
          btnProbe.disabled = false;
          btnProbe.textContent = old;
          const line = document.getElementById('probe-' + c.id);
          if (line) {
            if (r && r.ok) line.textContent = '连接正常 · HTTP ' + (r.status ?? '—') + ' · ' + (r.ms ?? 0) + 'ms';
            else line.textContent = '连接失败：' + ((r && r.error) || '未知原因');
            line.hidden = false;
          }
        });
        row.appendChild(btnProbe);

        const probeLine = el('div', 'cmp-detail', '');
        probeLine.id = 'probe-' + c.id;
        probeLine.hidden = true;
        box.appendChild(probeLine);
      }
    } else {
      const btnUrl = el('button', 'cap-chip', '填写地址');
      btnUrl.type = 'button';
      btnUrl.addEventListener('click', async () => {
        const cur = c.path || 'http://127.0.0.1:9880';
        const url = window.prompt ? window.prompt('服务地址', cur) : null;
        if (!url) return;
        const r = await swCall('setComponentPath', c.id, url.trim());
        if (r && r.ok) { await refreshComponents(); renderSetup(host); }
      });
      row.appendChild(btnUrl);
    }

    box.appendChild(row);

    if (c.id === 'piper') {
      const note = el('div', 'cmp-detail', lastPiperNote || '');
      if (lastPiperNote) box.appendChild(note);
    }

    host.appendChild(box);
  }
}

export async function refreshPiperVoices() {
  try {
    const r = await swCall('listPiperVoices', );
    if (!r || !r.ok) { lastPiperNote = ''; return null; }
    const skipped = r.skipped || [];
    if (skipped.length) {
      lastPiperNote = '已隐藏 ' + skipped.length + ' 个音色（音素方案 ' +
        Array.from(new Set(skipped.map(x => x.phonemeType))).join('/') +
        ' 不受当前 Piper 版本支持，合成会崩溃）';
    } else {
      lastPiperNote = '';
    }
    return r;
  } catch (e) { return null; }
}

export async function initVoiceSetup() {
  await refreshComponents();
  await refreshPiperVoices();
  return lastComponents;
}

// ── 首次使用引导页 ───────────────────────────────
const ONBOARD_KEY = 'soulweave.voiceOnboardShown';

export function openOnboard(force = false) {
  const host = document.getElementById('voice-onboard');
  if (!host) return;
  host.hidden = false;
  const body = document.getElementById('voice-onboard-body');
  if (!body) return;
  refreshComponents().then(() => {
    refreshPiperVoices().then(() => {
      renderSetup(body);
      body.appendChild(el('div', 'set-hint',
        '这些组件都不随应用分发：espeak-ng 是 GPL-3.0，GPT-SoVITS / CosyVoice 是数 GB 的运行时。' +
        '请通过「前往获取」自行下载，再用「自动探测」或「指定位置」告诉本应用它装在哪。'));
    });
  });
  if (!force) {
    try { localStorage.setItem(ONBOARD_KEY, '1'); } catch (e) { /* ignore */ }
  }
}

export function closeOnboard() {
  const host = document.getElementById('voice-onboard');
  if (host) host.hidden = true;
}

export function maybeShowOnboardOnFirstRun() {
  let shown = false;
  try { shown = localStorage.getItem(ONBOARD_KEY) === '1'; } catch (e) { /* ignore */ }
  if (shown) return;
  // 首次运行且 Piper 未配置 → 提示一次
  refreshComponents().then((list) => {
    const piper = list.find((c) => c.id === 'piper');
    if (piper && piper.status !== 'ready') {
      setTimeout(() => openOnboard(), 4200);
    }
  });
}

/** 计算某个 provider 是否可用（依赖组件都 ready） */
export function providerReady(providerId) {
  const need = lastComponents.filter((c) => (c.providers || []).includes(providerId) && c.required);
  if (!need.length) return true;
  return need.every((c) => c.status === 'ready');
}
