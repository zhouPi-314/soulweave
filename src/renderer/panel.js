import { swCall, swOn } from './api.js';
/**
 * SoulWeave S2-9：动作表情面板 + 文本流式演示
 *
 * 面板数据来自 Live2D 模型自带的 Expressions / Motions，
 * 点击直接调用 manager 播放，不做任何硬编码清单。
 *
 * 文本流：这里只驱动「流式渲染」UI。
 * A-12（真实 DSH prompt）未获授权，因此本文件**不发起任何网络或模型调用**，
 * 对话框上会显示「本地模拟」标记。
 */
const $ = (s) => document.querySelector(s);

const DEMO_TEXT =
  '下午好呀，今天想让我陪你做点什么？\n' +
  '（这段文字是本地生成的演示文本，用来验证流式渲染机制；' +
  '真实模型对话需要单独授权后才能接入。）';

function buildChips(label, items, onPick) {
  const g = document.createElement('div');
  g.className = 'cap-group';
  const t = document.createElement('div');
  t.className = 'cap-title';
  t.textContent = label;
  g.appendChild(t);
  const box = document.createElement('div');
  box.className = 'cap-chips';
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cap-chip';
    b.textContent = it.text;
    b.title = it.title || '';
    b.addEventListener('click', () => onPick(it));
    box.appendChild(b);
  }
  g.appendChild(box);
  return g;
}

function renderPanel() {
  const host = $('#panel-content');
  if (!host) return;
  const caps = (window.__modelCaps && window.__modelCaps()) || [];
  const loaded = caps.filter((c) => c && c.loaded);
  if (!loaded.length) {
    host.className = 'empty';
    host.textContent = '加载模型后可操作';
    return;
  }
  host.className = '';
  host.textContent = '';

  for (const c of loaded) {
    const head = document.createElement('div');
    head.className = 'cap-model';
    head.textContent = '角色 ' + (c.index + 1);
    host.appendChild(head);

    if (c.expressions && c.expressions.length) {
      const kindLabel = c.expressionKind === 'procedural' ? '程序化' : '内置';
      host.appendChild(buildChips(
        '表情 · ' + kindLabel + '（' + c.expressions.length + '）',
        [...c.expressions].sort().map((n) => ({ text: n, name: n })),
        (it) => flash(window.__playExpressionAt(c.index, it.name), '表情 ' + it.name)
      ));
    } else {
      const none = document.createElement('div');
      none.className = 'cap-title';
      none.textContent = '表情：该模型未提供';
      host.appendChild(none);
    }

    const groups = (c.motionGroups || []).filter((g) => g.count > 0);
    if (groups.length) {
      host.appendChild(buildChips(
        '动作组',
        [...groups].sort((a,b)=>a.name.localeCompare(b.name)).map((g) => ({ text: g.name + ' ×' + g.count, group: g.name, count: g.count })),
        (it) => {
          const idx = Math.floor(Math.random() * it.count);
          flash(window.__playMotionAt(c.index, it.group, idx), '动作 ' + it.group + '#' + idx);
        }
      ));
    }
  }
}

let flashTimer = null;
function flash(ok, label) {
  const hud = $('#status');
  if (!hud) return;
  const prev = '运行中';
  hud.textContent = (ok ? '▶ ' : '✕ ') + label;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { hud.textContent = prev; }, 1200);
}

function init() {
  const toggle = $('#panel-toggle');
  const body = $('#panel-body');
  if (toggle && body) {
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      body.hidden = open;
      if (!open) renderPanel();
    });
    body.addEventListener('click', () => { /* 点击面板内不穿透到 canvas */ });
  }

  // 面板数据随模型加载变化，定期刷新（模型加载是异步的）
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
    if (ticks > 40) { clearInterval(timer); return; }
    if (body && !body.hidden) renderPanel();
    renderSettings();
  }, 500);

  // ── S2-10：语音 / 文字切换 ──
  const tabs = Array.from(document.querySelectorAll('.dlg-tab'));
  const voicePanel = $('#voice-panel');
  const voiceBtn = $('#voice-btn');
  const voiceLevel = $('#voice-level');

  function setChatMode(mode) {
    for (const t of tabs) {
      const on = t.dataset.mode === mode;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    }
    if (voicePanel) voicePanel.hidden = mode !== 'voice';
    if (mode === 'voice') {
      const dlg = $('#dialog');
      if (dlg) dlg.classList.remove('hidden');
      // S3-1：渲染音色工坊
      try { window.__voiceStudio?.renderVoiceStudio(document.getElementById('voice-studio')); } catch (e) {}
    }
    try { localStorage.setItem('soulweave.chatMode', mode); } catch (e) {}
    return mode;
  }
  for (const t of tabs) {
    t.addEventListener('click', () => setChatMode(t.dataset.mode));
  }
  let saved = 'text';
  try { saved = localStorage.getItem('soulweave.chatMode') || 'text'; } catch (e) {}
  setChatMode(saved);

  // S3-12：打开设置中心（独立窗口）
  document.getElementById('open-settings-center')?.addEventListener('click', async () => {
    try { await swCall('openSettings', ); } catch (e) { console.error('[soulweave]', e); }
  });

  // S3-11：语音组件引导页
  document.getElementById('voice-onboard-close')?.addEventListener('click', () => {
    try { window.__voiceSetup?.closeOnboard(); } catch (e) {}
  });
  document.getElementById('voice-onboard')?.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'voice-onboard') {
      try { window.__voiceSetup?.closeOnboard(); } catch (e2) {}
    }
  });
  document.getElementById('voice-onboard-open')?.addEventListener('click', () => {
    try { window.__voiceSetup?.openOnboard(true); } catch (e) {}
  });

  // S3-2：朗读示例（走分句流水线，便于验证首包与打断）
  document.getElementById('voice-speak-demo')?.addEventListener('click', async () => {
    const btn = document.getElementById('voice-speak-demo');
    if (!btn) return;
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = '合成中…';
    const text = '你好呀。我是冰糖，今天想陪你一起做点什么？如果累了就先休息一下，我会安静地待在这里。';
    const r = await window.__voiceStudio?.speakStreaming(text, 0);
    btn.disabled = false;
    btn.textContent = old;
    if (r && r.ok) btn.title = '首包 ' + r.firstPacketMs + 'ms，共 ' + r.played + ' 句';
    else btn.title = r?.cancelled ? '已被打断' : (r?.error || '失败');
  });

  // S3-1：停止播放（语音打断的手动入口）
  document.getElementById('voice-stop')?.addEventListener('click', () => {
    try { window.__voiceStudio?.stopSpeaking(); } catch (e) {}
  });

  // 语音按钮：按住说话 → 真实录音 → 转写 → 直接发出去
  //
  // 以前这里只做「按下变亮 + 假电平」，不采集麦克风；用户点了没反应。
  // 现在复用 voice-input.js 里的录音与 WAV 转换（同一套 16 kHz 单声道，whisper 与云端都吃）。
  if (voiceBtn) {
    let micStream = null;
    let recorder = null;
    let chunks = [];
    let audioCtx = null;
    let analyser = null;
    let rafId = 0;
    let startedAt = 0;
    let busy = false;
    const hintEl = document.getElementById('voice-hint');
    const setHint = (s) => { if (hintEl) hintEl.textContent = s; };
    const setLevel = (pct) => { if (voiceLevel) voiceLevel.style.width = Math.max(0, Math.min(100, pct)) + '%'; };

    const stopMeter = () => {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      try { if (audioCtx) audioCtx.close(); } catch (e) { /* ignore */ }
      audioCtx = null; analyser = null;
      setLevel(0);
    };

    const startMeter = (stream) => {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AC();
        const src = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          if (!analyser) return;
          analyser.getByteTimeDomainData(data);
          let peak = 0;
          for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128));
          setLevel(peak / 128 * 100);
          rafId = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) { /* 没有电平也不影响录音 */ }
    };

    const releaseMic = () => {
      try { if (micStream) micStream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
      micStream = null;
    };

    const startRec = async () => {
      if (busy) return;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        setHint('拿不到麦克风：' + String(e && e.message ? e.message : e).slice(0, 90));
        return;
      }
      chunks = [];
      try {
        recorder = new MediaRecorder(micStream);
      } catch (e) {
        setHint('这台机器不支持录音（MediaRecorder 不可用）');
        releaseMic();
        return;
      }
      recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
      recorder.onstop = async () => {
        stopMeter();
        releaseMic();
        const blob = new Blob(chunks, { type: chunks[0] ? chunks[0].type : 'audio/webm' });
        if (!blob.size) { setHint('没有录到声音'); return; }
        busy = true;
        setHint('正在识别…');
        try {
          const mod = await import('./voice-input.js');
          const wav = await mod.blobToWav(blob);
          const b64 = mod.toBase64(wav);
          const res = await swCall('asrTranscribe', { base64: b64, engine: 'local', language: 'zh' });
          const text = String((res && res.text) || '').trim();
          if (!res || !res.ok) { setHint('识别失败：' + ((res && res.error) || '未知')); return; }
          if (!text) { setHint('这段里没识别到语音'); return; }
          setHint('识别到：' + text.slice(0, 40));
          const input = document.getElementById('dialog-input');
          if (input) input.value = text;
          const dlg = document.getElementById('dialog');
          if (dlg) dlg.classList.remove('hidden');
          if (window.__chatReal) await window.__chatReal(text);
        } catch (e) {
          setHint('处理失败：' + String(e && e.message ? e.message : e).slice(0, 90));
        } finally {
          busy = false;
          if (input) input.value = '';
        }
      };
      recorder.start();
      startedAt = Date.now();
      startMeter(micStream);
      voiceBtn.setAttribute('aria-pressed', 'true');
      setHint('正在录音…松开发送');
    };

    const stopRec = () => {
      voiceBtn.setAttribute('aria-pressed', 'false');
      if (recorder && recorder.state !== 'inactive') {
        const secs = Math.round((Date.now() - startedAt) / 1000);
        if (secs < 1) { setHint('太短了，再按久一点'); try { recorder.stop(); } catch (e) {} return; }
        setHint('录音 ' + secs + ' 秒，正在处理…');
        try { recorder.stop(); } catch (e) { /* ignore */ }
      } else {
        stopMeter();
        releaseMic();
      }
    };

    voiceBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); startRec(); });
    voiceBtn.addEventListener('pointerup', (e) => { e.preventDefault(); stopRec(); });
    voiceBtn.addEventListener('pointerleave', () => { if (recorder && recorder.state === 'recording') stopRec(); });
    // 键盘可达：空格/回车按住也能用
    voiceBtn.addEventListener('keydown', (e) => { if (!e.repeat && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); startRec(); } });
    voiceBtn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); stopRec(); } });
  }

  window.__setChatMode = setChatMode;

  // ── S2-10：画质切换（供主进程/设置界面调用）──
  window.__applyQuality = (name) => {
    if (!window.__qualityApi) return null;
    const r = window.__qualityApi.applyQuality(name);
    window.__dprCap = window.__qualityApi.dprCapFor(name);
    window.__superSample = window.__qualityApi.superSampleFor
      ? window.__qualityApi.superSampleFor(name) : 1;
    if (window.__soulweaveLive2D) window.__soulweaveLive2D.syncSize(true);
    return r;
  };
  window.__listQualities = () => (window.__qualityApi ? window.__qualityApi.listQualities() : []);
  if (window.__qualityApi) {
    const cur = window.__qualityApi.getQuality();
    window.__qualityApi.applyQuality(cur);
    window.__dprCap = window.__qualityApi.dprCapFor(cur);
  }

  // ── S2-18：设置区（画质 / 背景 / 安全阀）──
  const VALVE_KEY = 'soulweave.valve';
  const DEFAULT_VALVE = { enabled: true, threshold: 300, idleSeconds: 600 };

  function loadValve() {
    try {
      const raw = localStorage.getItem(VALVE_KEY);
      if (raw) return Object.assign({}, DEFAULT_VALVE, JSON.parse(raw));
    } catch (e) {}
    return Object.assign({}, DEFAULT_VALVE);
  }
  function saveValve(v) {
    try { localStorage.setItem(VALVE_KEY, JSON.stringify(v)); } catch (e) {}
    // 同步到主进程
    swCall('setValveConfig', v);
    return v;
  }

  function renderSettings() {
    // 画质
    const qHost = $('#set-quality');
    // 未就绪（__qualityApi 还没加载）时不要标记 built，等下一轮重试
    const qList = window.__listQualities?.() || [];
    if (qHost && !qHost.dataset.built && qList.length > 0) {
      qHost.dataset.built = '1';
      const cur = window.__qualityApi ? window.__qualityApi.getQuality() : 'high';
      qList.forEach((q) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cap-chip' + (q.key === cur ? ' on' : '');
        b.textContent = q.label;
        b.title = '渲染缩放 ×' + (q.superSample || 1) + '，DPR 上限 ' + (q.dprCap || '原生');
        b.addEventListener('click', () => {
          window.__applyQuality?.(q.key);
          Array.from(qHost.children).forEach((c) => c.classList.remove('on'));
          b.classList.add('on');
        });
        qHost.appendChild(b);
      });
    }

    // 背景
    const bHost = $('#set-bg');
    if (bHost && !bHost.dataset.built) {
      bHost.dataset.built = '1';
      const cur = (window.__getBackground?.() || {}).type || 'transparent';
      const opts = [
        { k: 'transparent', t: '透明' },
        { k: 'color', t: '纯色' },
        { k: 'image', t: '图片…' },
      ];
      opts.forEach((o) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cap-chip' + (o.k === cur ? ' on' : '');
        b.textContent = o.t;
        b.addEventListener('click', async () => {
          const colorWrap = document.getElementById('set-bg-color-wrap');
          const colorInput = document.getElementById('set-bg-color');
          if (o.k === 'image') {
            const r = await window.__pickBackgroundImage?.();
            if (!r || r.type !== 'image') return;
            if (colorWrap) colorWrap.hidden = true;
          } else if (o.k === 'color') {
            // 不再用 window.prompt —— Electron 渲染进程不支持它，调用即失败
            const c = (colorInput && colorInput.value) || '#1E2233';
            window.__setBackground?.({ type: 'color', value: c });
            if (colorWrap) colorWrap.hidden = false;
          } else {
            window.__setBackground?.({ type: 'transparent' });
            if (colorWrap) colorWrap.hidden = true;
          }
          Array.from(bHost.children).forEach((c) => c.classList.remove('on'));
          b.classList.add('on');
        });
        bHost.appendChild(b);
      });
    }

    // ── S3-8：语音组件引导 ──
    const cmpHost = document.getElementById('set-voice-components');
    if (cmpHost && window.__voiceSetup && !cmpHost.dataset.built) {
      cmpHost.dataset.built = '1';
      window.__voiceSetup.refreshComponents().then(() => {
        window.__voiceSetup.renderSetup(cmpHost);
      }).catch(() => {});
      // 「指定位置」需要目录选择器
      window.__pickComponentPath = async () => {
        try {
          const r = await swCall('pickComponentPath', );
          return r && r.ok ? r.path : null;
        } catch (e) { return null; }
      };
    }

    // ── S2-26：主题 ──
    const thHost = document.getElementById('set-theme');
    if (thHost && window.__theme && !thHost.dataset.built) {
      thHost.dataset.built = '1';
      const cur = window.__theme.getTheme().mode;
      [['auto','自动'],['dark','深色'],['light','浅色']].forEach(([k,label]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cap-chip' + (k === cur ? ' on' : '');
        b.textContent = label;
        b.addEventListener('click', () => {
          window.__theme.setTheme(k);
          Array.from(thHost.children).forEach((c) => c.classList.remove('on'));
          b.classList.add('on');
        });
        thHost.appendChild(b);
      });
    }

    // ── S2-25：角色自主性 ──
    const au = window.__autonomy;
    const auFreqHost = document.getElementById('set-autonomy-freq');
    const auModel = document.getElementById('set-autonomy-model');
    const auStatus = document.getElementById('set-autonomy-status');

    if (auModel && au && !auModel.dataset.built) {
      auModel.dataset.built = '1';
      auModel.checked = !!au.getConfig().allowModel;
      auModel.addEventListener('change', () => {
        au.setConfig({ allowModel: auModel.checked });
        updateAuStatus();
      });
    }

    if (auFreqHost && au && !auFreqHost.dataset.built) {
      auFreqHost.dataset.built = '1';
      const cur = au.getConfig().frequency;
      au.frequencies().forEach((f) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cap-chip' + (f.key === cur ? ' on' : '');
        b.textContent = f.label;
        b.addEventListener('click', () => {
          au.setConfig({ frequency: f.key });
          Array.from(auFreqHost.children).forEach((c) => c.classList.remove('on'));
          b.classList.add('on');
          updateAuStatus();
        });
        auFreqHost.appendChild(b);
      });
    }

    function updateAuStatus() {
      if (!auStatus || !au) return;
      const c = au.getConfig();
      const s = au.stats();
      auStatus.textContent = (c.allowModel ? 'AI 可自主' : '仅本地自主') +
        ' · 已自主 ' + s.autonomous + ' 次 / 模型驱动 ' + s.model + ' 次';
    }
    if (au && !window.__auTimer) {
      window.__auTimer = true;
      setInterval(updateAuStatus, 3000);
    }
    updateAuStatus();

    // 安全阀
    const v = loadValve();
    const en = $('#set-valve-enabled');
    const th = $('#set-valve-threshold');
    const id = $('#set-valve-idle');
    const cuWrap = $('#set-valve-custom-wrap');
    const cu = $('#set-valve-custom');
    const status = $('#set-valve-status');

    if (en && !en.dataset.built) {
      en.dataset.built = '1';
      en.checked = v.enabled;
      en.addEventListener('change', () => {
        const nv = loadValve(); nv.enabled = en.checked; saveValve(nv); updateStatus();
      });
    }
    if (th && !th.dataset.built) {
      th.dataset.built = '1';
      th.value = String(v.threshold);
      th.addEventListener('change', () => {
        const nv = loadValve(); nv.threshold = Number(th.value); saveValve(nv); updateStatus();
      });
    }
    if (id && !id.dataset.built) {
      id.dataset.built = '1';
      const known = ['15','30','60','300','600','1800','0'];
      const isCustom = !known.includes(String(v.idleSeconds));
      id.value = isCustom ? '-1' : String(v.idleSeconds);
      if (cu && cuWrap) { cuWrap.hidden = !isCustom; if (isCustom) cu.value = String(v.idleSeconds); }
      id.addEventListener('change', () => {
        const val = id.value;
        if (val === '-1') { if (cuWrap) cuWrap.hidden = false; if (cu) cu.focus(); return; }
        if (cuWrap) cuWrap.hidden = true;
        const nv = loadValve(); nv.idleSeconds = Number(val); saveValve(nv); updateStatus();
      });
    }
    if (cu && !cu.dataset.built) {
      cu.dataset.built = '1';
      cu.addEventListener('change', () => {
        const n = Math.max(15, Number(cu.value) || 600);
        cu.value = String(n);
        const nv = loadValve(); nv.idleSeconds = n; saveValve(nv); updateStatus();
      });
    }

    function updateStatus() {
      if (!status) return;
      const cur = loadValve();
      const idleTxt = cur.idleSeconds === 0 ? '不按空闲回收' : ('空闲 ' + fmt(cur.idleSeconds));
      status.textContent = (cur.enabled ? '已启用' : '已停用') + ' · ' + idleTxt;
    }
    function fmt(s) {
      if (s >= 60) return (s / 60) + ' 分钟';
      return s + ' 秒';
    }
    updateStatus();
    return v;
  }

  window.__getValveConfig = () => loadValve();
  window.__setValveConfig = (v) => saveValve(Object.assign(loadValve(), v));

  // ── S2-13：背景设置 ──
  window.__getBackground = () => (window.__backgroundApi ? window.__backgroundApi.getBackground() : null);
  window.__setBackground = (cfg) => {
    const r = window.__backgroundApi ? window.__backgroundApi.setBackground(cfg) : null;
    // 背景变了要重新同步尺寸（避免残留拉伸）
    return r;
  };
  /** 通过主进程文件对话框选一张本地图片作为背景 */
  window.__pickBackgroundImage = async () => {
    const api = window.soulweave;
    if (!api || !api.pickBackgroundImage) return { ok: false, reason: 'ipc-unavailable' };
    const r = await swCall('pickBackgroundImage', );
    if (r && r.ok && r.path) {
      return window.__setBackground({ type: 'image', value: r.url || r.path });
    }
    return r;
  };

  // 立即渲染设置（不依赖面板展开）
  try { renderSettings(); } catch (e) { /* ignore */ }

  /**
   * S4-0：微信/QQ 式对话
   *
   * · 每条消息气泡进入列表，输入框发送后清空
   * · 带上下文历史（最近 12 条）
   * · 空回复明确报错，不静默
   * · 语音按句流式朗读（边收边读，不等全文）
   */
  const CHAT_HISTORY_MAX = 12;
  let _chatHistory = [];   // [{role:'user'|'assistant', content}]
  let _lastSessionId = null;
  let _busy = false;

  window.__getChatHistory = () => _chatHistory.slice();
  window.__resetChat = () => { _chatHistory = []; _lastSessionId = null; window.__clearMessages?.(); };

  window.__chatReal = async (text) => {
    const dlg = document.getElementById('dialog');
    if (dlg) dlg.classList.remove('hidden');
    const input = document.getElementById('dialog-input');
    const send = document.getElementById('dialog-send');
    const badge = document.getElementById('dialog-badge');

    const say = String(text == null ? '' : text).trim();
    if (!say) return { ok: false, err: '内容为空' };
    if (_busy) return { ok: false, err: '上一条还没回复完' };
    _busy = true;
    if (send) send.disabled = true;

    // 1) 自己的气泡 + 清空输入框
    window.__appendMessage?.('me', say);
    if (input) input.value = '';
    _chatHistory.push({ role: 'user', content: say });
    if (_chatHistory.length > CHAT_HISTORY_MAX * 2) {
      _chatHistory = _chatHistory.slice(-CHAT_HISTORY_MAX * 2);
    }

    // 2) AI 气泡（流式写入）
    window.__streamBegin?.();
    if (badge) { badge.textContent = '思考中…'; badge.title = ''; }

    let acc = '';
    let off = null;
    let spokeUpTo = 0;   // 已经朗读到的字符位置

    const speakReady = () => {
      // 按句切分：把已收到的、还没读的完整句子读掉
      const pending = acc.slice(spokeUpTo);
      const m = pending.match(/^[\s\S]*?[。！？!?\n]/);
      if (!m) return;
      const sentence = m[0].trim();
      if (!sentence) { spokeUpTo += m[0].length; return; }
      spokeUpTo += m[0].length;
      try { window.__voiceStudio?.speak?.(sentence, 0); } catch (e) { /* ignore */ }
    };

    try { off = swOn('onAgentStream', (ev) => {
      if (!ev || ev.type !== 'delta' || typeof ev.delta !== 'string') return;
      acc += ev.delta;
      window.__streamAppend?.(ev.delta);
      speakReady();
    }); } catch (e) { /* ignore */ }

    let ok = false;
    let err = '';
    let tokens = null;
    let useFree = false;
    try {
      const gw = await swCall('agentGatewayStatus');
      let want = 'free';
      try { want = localStorage.getItem('soulweave.agentBackend') || 'free'; } catch (e) { /* ignore */ }
      useFree = want === 'free' && gw && gw.allowed && gw.ok;

      if (useFree) {
        const r = await swCall('agentGatewayStream', {
          model: 'kilo-auto/free',
          messages: _chatHistory.slice(-CHAT_HISTORY_MAX).map((m) => ({ role: m.role, content: m.content })),
        });
        ok = !!(r && r.ok);
        err = (r && r.error) || '';
        tokens = (r && r.tokens) || null;
        if (ok && !acc && r.text) { acc = r.text; window.__streamAppend?.(r.text); }
      } else {
        const payload = { characterId: '0', text: say };
        if (_lastSessionId) payload.sessionId = _lastSessionId;
        const r = await swCall('agentChat', payload);
        ok = !!(r && r.ok);
        err = (r && r.error) || '';
        tokens = (r && r.tokens) || null;
        if (r && r.sessionId) _lastSessionId = r.sessionId;
        if (ok && r.text) { acc = r.text; window.__streamAppend?.(r.text); speakReady(); }
      }
    } catch (e) {
      err = String(e).slice(0, 160);
    }
    try { off && off(); } catch (e) { /* ignore */ }

    // 3) 收尾（成功 = 调用成功且有实际内容）
    const finalText = window.__streamEnd?.() || acc;
    const finalOk = ok && !!String(finalText || '').trim();
    if (!finalOk) {
      // 空回复或失败：明确显示为系统提示，不留在 AI 气泡里装成功
      if (!String(finalText || '').trim()) {
        const row = _msgsBoxLastRow();
        if (row) row.remove();
      }
      window.__appendMessage?.('sys', '⚠ ' + (err || '模型没有返回内容（可重试）'));
      if (badge) { badge.textContent = '调用失败'; badge.title = err || '空回复'; }
    } else {
      _chatHistory.push({ role: 'assistant', content: String(finalText) });
      if (badge) {
        badge.textContent = useFree ? '免费网关' : '官方 API';
        badge.title = tokens && tokens.tokensUsed != null ? '累计 token ' + tokens.tokensUsed : '';
      }
      // 剩余未朗读的尾巴
      const rest = acc.slice(spokeUpTo).trim();
      if (rest) { try { window.__voiceStudio?.speak?.(rest, 0); } catch (e) { /* ignore */ } }
      window.__updateTokenBadge?.(tokens, useFree ? '免费网关' : '官方 API');
    }

    _busy = false;
    if (send) send.disabled = false;
    if (input) { try { input.focus(); } catch (e) { /* ignore */ } }
    return { ok: finalOk, err: finalOk ? '' : (err || '模型没有返回内容（可重试）'), chars: String(finalText || '').length, tokens };
  };

  function _msgsBoxLastRow() {
    const box = document.getElementById('dialog-messages');
    return box ? box.lastElementChild : null;
  }

  /**
   * 对话框底部状态栏：后端名 + token 可见计数。
   *
   * 之前只写了 badge.title（悬停才显示），用户根本看不到 —— 这是缺陷。
   * 现在写到 #dialog-foot 里的可见文本。
   */
  let _warnedAt = 0;
  window.__updateTokenBadge = (st, backendLabel) => {
    const backEl = document.getElementById('dialog-backend');
    const tokEl = document.getElementById('dialog-tokens');
    if (backendLabel && backEl) backEl.textContent = backendLabel;

    if (!st) {
      if (tokEl) { tokEl.textContent = '¥ —'; tokEl.className = ''; }
      return;
    }
    // 没拿到 usage 时（费用为 0 但无 last）显示横线
    if (!st.last) {
      if (tokEl) {
        tokEl.textContent = '¥ ' + (st.costCny || 0).toFixed(2) + ' / ¥' + (st.limitCny || 0);
        tokEl.className = '';
        tokEl.title = st.note || '本轮未返回 usage';
      }
      return;
    }
    const cost = Number(st.costCny) || 0;
    const limit = Number(st.limitCny) || 0;
    const ratio = Number(st.warnRatio) || 0.8;
    const over = limit > 0 && cost >= limit;
    const near = !over && limit > 0 && cost >= limit * ratio;
    if (tokEl) {
      tokEl.textContent = '¥ ' + cost.toFixed(3) + (limit > 0 ? ' / ¥' + limit.toFixed(0) : '');
      tokEl.className = over ? 'over' : (near ? 'warn' : '');
      const L = st.last || {};
      tokEl.title =
        '累计 token ' + (st.tokensUsed || 0).toLocaleString() +
        '\n未命中输入 ' + (L.prompt ?? '-') + ' · 缓存命中 ' + (L.cacheRead ?? '-') +
        ' · 输出 ' + (L.completion ?? '-') +
        (st.lastCostCny != null ? '\n本轮费用 ¥' + Number(st.lastCostCny).toFixed(4) + (st.peak ? '（高峰价）' : '（低谷价）') : '') +
        '\n汇率 1 USD = ¥' + (st.usdToCny || 7.2) + '（可在设置修改）';
    }
    if (over && _warnedAt !== limit) {
      _warnedAt = limit;
      window.__appendMessage?.('sys', '⚠ 已达费用上限 ¥' + limit.toFixed(0) + '，后续调用会被拒绝。当前 ¥' + cost.toFixed(3));
    } else if (near && _warnedAt !== limit * ratio) {
      _warnedAt = limit * ratio;
      window.__appendMessage?.('sys', '⚠ 费用已达预算 ' + Math.round(ratio * 100) + '%：¥' + cost.toFixed(3) + ' / ¥' + limit.toFixed(0));
    }
  };

  /** 打开对话时立刻显示当前计数（不必等一轮对话） */
  window.__refreshTokenBar = async () => {
    try {
      const st = await swCall('agentTokensStatus');
      let label = '官方 API';
      try {
        const gw = await swCall('agentGatewayStatus');
        let want = 'free';
        try { want = localStorage.getItem('soulweave.agentBackend') || 'free'; } catch (e) { /* ignore */ }
        label = (want === 'free' && gw && gw.allowed && gw.ok) ? '免费网关' : '官方 API';
      } catch (e) { /* ignore */ }
      window.__updateTokenBadge(st, label);
    } catch (e) { /* ignore */ }
  };

  // 聊天入口：面板按钮 / 双击角色 / 关闭按钮
  const openChat = () => {
    const dlg = document.getElementById('dialog');
    if (dlg) dlg.classList.remove('hidden');
    try { window.__refreshTokenBar?.(); } catch (e) { /* ignore */ }
    const el = document.getElementById('dialog-input');
    if (el) { try { el.focus(); } catch (e) { /* ignore */ } }
  };
  const closeChat = () => {
    const dlg = document.getElementById('dialog');
    if (dlg) dlg.classList.add('hidden');
  };
  document.getElementById('open-chat')?.addEventListener('click', openChat);
  document.getElementById('dialog-close')?.addEventListener('click', closeChat);
  // 双击画布（角色）也能唤起
  const _cv = document.getElementById('live2d-canvas');
  if (_cv) {
    _cv.addEventListener('dblclick', openChat);
  }
  window.__openChat = openChat;
  window.__closeChat = closeChat;

  // 输入行接线
  const _sendBtn = document.getElementById('dialog-send');
  const _inputEl = document.getElementById('dialog-input');
  if (_sendBtn && _inputEl) {
    const doSend = async () => {
      const v = _inputEl.value.trim();
      if (!v) return;
      await window.__chatReal(v);
    };
    _sendBtn.addEventListener('click', doSend);
    _inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); doSend(); }
    });
  }

  // IPC：主进程可触发演示流（用于自动化验收）
  window.__showDemoStream = async () => {
    const dlg = $('#dialog');
    if (dlg) dlg.classList.remove('hidden');
    return window.__streamText ? window.__streamText(DEMO_TEXT) : false;
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
