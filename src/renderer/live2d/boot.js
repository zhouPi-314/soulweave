import { SoulWeaveLive2D } from './stage.js';
import * as QualityApi from '../quality.js';
import * as BackgroundApi from '../background.js';
import { initTitlebar } from '../titlebar.js';
import { initAutonomy } from '../autonomy.js';
import { initTheme } from '../theme.js';
import { initToast } from '../toast.js';
import * as VoiceStudio from '../voice-studio.js';
import * as VoiceSetup from '../voice-setup.js';
import { swCall, swOn } from '../api.js';

const canvas = document.getElementById('live2d-canvas');
const statusEl = document.getElementById('status');
const fpsEl = document.getElementById('fps');
const setStatus = (s) => { if (statusEl) statusEl.textContent = s; };

function loadCubismCore() {
  return new Promise((resolve) => {
    if (window.Live2DCubismCore) return resolve(true);
    const s = document.createElement('script');
    s.src = './core/live2dcubismcore.min.js';
    s.onload = () => resolve(!!window.Live2DCubismCore);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

async function main() {
  try {
    setStatus('加载 Cubism Core…');
    if (!await loadCubismCore()) { setStatus('Cubism Core 加载失败'); return; }

    setStatus('初始化渲染器…');
    const app = new SoulWeaveLive2D(canvas, {
      onFps: (f) => { if (fpsEl) fpsEl.textContent = f + ' FPS'; },
    });
    if (!app.initialize()) { setStatus('渲染器初始化失败'); return; }

    setStatus('加载模型…');
    // S2-7：桌宠模式默认只显示 1 个角色（竖屏下多角色会重叠，且桌宠本就该是单个角色）
  const isPetMode = new URLSearchParams(location.search).get('mode') === 'pet';
  const initialModel = (() => {
    const q = new URLSearchParams(location.search).get('model');
    if (q !== null) { const n = Number(q); if (Number.isInteger(n) && n >= 0) return n; }
    return isPetMode ? Number(window.SOULWEAVE_PET_MODEL || 0) : 0;
  })();
  // S2-16 安全阀 E：若因回收而重载，恢复上次的角色组合
  let restored = false;
  try {
    const saved = sessionStorage.getItem('soulweave.models');
    if (saved) {
      const arr = JSON.parse(saved);
      if (Array.isArray(arr) && arr.length && arr.every((n) => Number.isInteger(n))) {
        app.loadByIndices(arr, { silent: true });
        restored = true;
      }
    }
  } catch (e) { /* ignore */ }

  // 用户导入的 Live2D 形象优先：角色绑定了形象且形象可见时，加载那个模型；
  // 失败（路径失效/格式不支持）就回落到内置模型 —— 绝不白屏。
  let loadedCustom = false;
  if (!restored) {
    try {
      const act = await swCall('live2dActive');
      const p = act && act.model && act.model.path;
      if (act && act.ok && p && String(p).startsWith('builtin:')) {
        // 内置形象：形象库里存的是 builtin:Hiyori 这样的标记，
        // 直接按 ModelDir 里的下标加载，不走文件路径。
        const key = String(p).slice('builtin:'.length);
        const idx = ['Hiyori', 'Haru', 'Mark'].indexOf(key);
        if (idx >= 0) {
          app.loadByIndex(idx);
          loadedCustom = true;
          setStatus('运行中 · ' + (act.model.name || act.characterName || ''));
        }
      } else if (act && act.ok && p && String(p).toLowerCase().endsWith('.model3.json')) {
        const url = 'file:///' + String(p).replace(/\\/g, '/');
        loadedCustom = app.loadByPath(url);
        if (loadedCustom) setStatus('运行中 · ' + (act.model.name || act.characterName || ''));
      }
    } catch (e) { loadedCustom = false; }
  }
  if (!loadedCustom && !restored) app.loadByIndex(initialModel);

    setStatus('运行中');
    app.run();

    // 布局就绪后同步 canvas 分辨率（修复 300x150 拉伸）
    requestAnimationFrame(() => {
      app.syncSize();
      requestAnimationFrame(() => app.syncSize());
    });
    window.addEventListener('resize', () => app.syncSize());
    if (window.ResizeObserver) {
      new ResizeObserver(() => app.syncSize()).observe(canvas);
    }
    window.__soulweaveLive2D = app;
    window.__loadModels = (idxs) => app.loadByIndices(idxs);
    // S3-1：音色工坊（系统音色，离线可用）
  window.__voiceStudio = VoiceStudio;
  window.__voiceSetup = VoiceSetup;
  VoiceStudio.initVoiceStudio().catch(() => {});
  VoiceSetup.initVoiceSetup().then(() => {
    try { VoiceSetup.maybeShowOnboardOnFirstRun(); } catch (e) {}
  }).catch(() => {});

  // S2-26：主题跟随（尽早应用，避免闪一下深色）
  initTheme().catch(() => {});
  // S2-26：轻提示 + 首次托盘引导
  try { initToast(); } catch (e) { /* ignore */ }

  // S2-25：角色动作自主性（模型驱动 + 本地自主）
  try { initAutonomy(); } catch (e) { /* ignore */ }

  // S2-23：自绘标题栏（桌宠模式自动隐藏）
  try { initTitlebar(); } catch (e) { /* ignore */ }

  // S2-13：窗口背景（默认透明；桌宠模式强制透明）
  window.__backgroundApi = BackgroundApi;
  BackgroundApi.initBackground();
  // S3-23：设置中心改了背景 → 主窗口立刻重绘（localStorage 同源共享）
  try {
    swOn('onBackgroundChanged', (state) => {
      window.__bgReceived = (window.__bgReceived || 0) + 1;
      window.__bgLastState = state;
      window.__bgIsPet = document.body.classList.contains('pet-mode');
      if (state && typeof state === 'object') BackgroundApi.setBackground(state);
      else BackgroundApi.initBackground();
    });
  } catch (e) { console.error('[soulweave] 背景变更订阅失败', e); }

  // S2-10：画质预设（boot 时即应用，避免先高后低闪一下）
  window.__qualityApi = QualityApi;
  {
    const qk = QualityApi.getQuality();
    QualityApi.applyQuality(qk);
    window.__dprCap = QualityApi.dprCapFor(qk);
    window.__superSample = QualityApi.superSampleFor(qk);
  }

  window.__renderStats = () => app.getRenderStats();
  // SoulWeave S2-9：动作表情面板 + 文本流式
  window.__modelCaps = () => app.getModelCapabilities();
  window.__playExpressionAt = (mi, name) => app.playExpressionAt(mi, name);
  window.__playMotionAt = (mi, group, idx) => app.playMotionAt(mi, group, idx);

  /**
   * 文本流式渲染器（S2 核心 UI 机制）
   *
   * 【重要】这里只实现「流式渲染」这一层：
   *   任意文本源（真实模型 / Mock）都可以按 chunk 推进来。
   * A-12 真实 DSH prompt 未获授权，因此本函数不发起任何网络/模型调用。
   * 界面上会明确标注「本地模拟」，不得被当作真实模型对话。
   */
  window.__streamText = (text, opts = {}) => {
    const el = document.getElementById('dialog-text');
    if (!el) return Promise.resolve(false);
    const chunk = Math.max(1, opts.chunkSize || 2);
    const interval = Math.max(8, opts.intervalMs || 28);

    // S2-25：先剥离动作指令，并记录每条指令在干净文本中的位置；
    // 流式播放推进到该位置时才触发动作 —— 这样「说到做到」，
    // 而不是文本一开始就把动作全放完。
    let clean = text;
    let intents = [];
    try {
      const parsed = window.__autonomyParse ? window.__autonomyParse(text) : null;
      if (parsed) { clean = parsed.text; intents = parsed.intents; }
    } catch (e) { /* ignore */ }
    intents.sort((a, b) => a.at - b.at);

    el.textContent = '';
    el.parentElement?.classList.add('streaming');
    return new Promise((resolve) => {
      let i = 0;
      let next = 0;
      const timer = setInterval(() => {
        i += chunk;
        el.textContent = clean.slice(0, i);
        while (next < intents.length && intents[next].at <= i) {
          try { window.__aiAct?.(intents[next]); } catch (e) { /* ignore */ }
          next++;
        }
        if (i >= clean.length) {
          clearInterval(timer);
          el.textContent = clean;
          while (next < intents.length) {
            try { window.__aiAct?.(intents[next]); } catch (e) { /* ignore */ }
            next++;
          }
          el.parentElement?.classList.remove('streaming');
          resolve(true);
        }
      }, interval);
    });
  };
  /**
   * S4-0：微信/QQ 式消息流 + 真实流式（SSE）
   *
   * 每条消息是一个气泡：自己在右、角色在左。
   * 模型增量到达时直接往「当前 AI 气泡」里追加。
   *
   * 【为什么每次 Append 都要重新解析动作指令】
   * [[expr:微笑]] 可能被拆到多个 chunk（"[[expr:微" + "笑]]"），
   * 必须对累积缓冲重新解析，才能等指令完整后再触发。
   */
  let _sbuf = '';
  let _sbubble = null;
  let _sbox = null;
  let _sfired = 0;

  function _msgsBox() { return document.getElementById('dialog-messages'); }

  /** 追加一条消息气泡，返回气泡元素 */
  window.__appendMessage = (role, text, opts) => {
    const box = _msgsBox();
    if (!box) return null;
    const row = document.createElement('div');
    row.className = 'msg ' + (role === 'me' ? 'me' : role === 'sys' ? 'sys' : 'ai');
    const bub = document.createElement('div');
    bub.className = 'bubble' + (opts && opts.streaming ? ' streaming' : '');
    bub.textContent = text == null ? '' : String(text);
    row.appendChild(bub);
    box.appendChild(row);
    try { box.scrollTop = box.scrollHeight; } catch (err) { /* ignore */ }
    return bub;
  };

  /** 开始一条 AI 消息（创建气泡） */
  window.__streamBegin = () => {
    _sbuf = '';
    _sfired = 0;
    _sbubble = window.__appendMessage('ai', '', { streaming: true });
    _sbox = _sbubble ? _sbubble.parentElement : null;
    return !!_sbubble;
  };

  window.__streamAppend = (delta) => {
    if (typeof delta !== 'string' || !delta) return false;
    _sbuf += delta;
    if (!_sbubble) {
      _sbubble = window.__appendMessage('ai', '', { streaming: true });
      if (!_sbubble) return false;
    }
    let clean = _sbuf;
    let intents = [];
    try {
      const parsed = window.__autonomyParse ? window.__autonomyParse(_sbuf) : null;
      if (parsed) { clean = parsed.text; intents = parsed.intents || []; }
    } catch (err) { /* 解析失败就原样显示 */ }
    // 末尾未闭合的 "[[" 先不显示，避免半截指令闪一下
    const open = clean.lastIndexOf('[[');
    if (open >= 0 && clean.indexOf(']]', open) < 0) clean = clean.slice(0, open);
    _sbubble.textContent = clean;
    const box = _msgsBox();
    if (box) { try { box.scrollTop = box.scrollHeight; } catch (err) { /* ignore */ } }
    intents.sort((a, b2) => a.at - b2.at);
    while (_sfired < intents.length && intents[_sfired].at <= clean.length) {
      try { window.__aiAct?.(intents[_sfired]); } catch (err) { /* ignore */ }
      _sfired++;
    }
    return true;
  };

  window.__streamEnd = () => {
    if (!_sbubble) return false;
    let clean = _sbuf;
    let intents = [];
    try {
      const parsed = window.__autonomyParse ? window.__autonomyParse(_sbuf) : null;
      if (parsed) { clean = parsed.text; intents = parsed.intents || []; }
    } catch (err) { /* ignore */ }
    _sbubble.textContent = clean;
    _sbubble.classList.remove('streaming');
    intents.sort((a, b2) => a.at - b2.at);
    while (_sfired < intents.length) {
      try { window.__aiAct?.(intents[_sfired]); } catch (err) { /* ignore */ }
      _sfired++;
    }
    return clean;
  };

  /** 清空消息列表（用于新会话） */
  window.__clearMessages = () => {
    const box = _msgsBox();
    if (box) box.textContent = '';
    _sbuf = ''; _sbubble = null; _sfired = 0;
  };

  // SoulWeave S2-1：交互诊断（供自动化验收）  // SoulWeave S2-1：交互诊断（供自动化验收）
  window.__interactionStats = () => app.getInteractionStats();
  // SoulWeave S2-1：交互模拟 API（屏幕 NDC 坐标）
  window.__tapAt = (x, y) => app.tapAt(x, y);
  window.__beginDragAt = (x, y) => app.beginDragAt(x, y);
  window.__dragAt = (x, y) => app.dragAt(x, y);
  window.__endDrag = () => app.endDrag();
  window.__hitTestAt = (x, y) => app.hitTestAt(x, y);
    // 采样 onUpdate 的 CPU 耗时分布
    window.__sampleCpu = (frames = 180) => new Promise(resolve => {
      const times = [];
      let n = 0;
      function tick() {
        const r = app.getRenderStats();
        if (r && r.lastFrameMs >= 0) times.push(r.lastFrameMs);
        if (++n >= frames) {
          const s = times.slice().sort((a,b)=>a-b);
          resolve({
            n: s.length,
            avg: +(s.reduce((a,b)=>a+b,0)/s.length).toFixed(3),
            p50: +s[Math.floor(s.length*0.5)].toFixed(3),
            p95: +s[Math.floor(s.length*0.95)].toFixed(3),
            max: +s[s.length-1].toFixed(3),
          });
          return;
        }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
    console.log('[SoulWeave] Live2D ready');
  } catch (e) {
    console.error('[SoulWeave] Live2D error', e);
    setStatus('错误: ' + (e?.message ?? String(e)));
  }
}

main();
