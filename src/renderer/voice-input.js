/**
 * SoulWeave S7：语音输入（麦克风 → 转写 → 文字）
 *
 * 依据：01 需求 §7.9「麦克风/扬声器、ASR/TTS 服务、连续语音/按键说话、打断/静音」
 *       「内置测试麦克风」
 *
 * 【录音用浏览器 API，不引第三方库】
 * MediaRecorder + getUserMedia 是 Chromium 原生能力，Electron 里直接可用。
 * 录音格式用 webm/opus（体积小），但 whisper 更爱 wav ——
 * 所以这里在渲染层用 OfflineAudioContext 转成 16 kHz 单声道 PCM WAV 再送后端，
 * 避免后端再依赖 ffmpeg。
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

/** Float32 PCM → 16-bit WAV（whisper 与云端都吃） */
export function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  w(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    off += 2;
  }
  return new Uint8Array(buf);
}

/** ArrayBuffer → base64（分块，避免大数组爆栈） */
export function toBase64(u8) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) {
    s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
  }
  return btoa(s);
}

/** 把任意音频 Blob 转成 16 kHz 单声道 WAV */
export async function blobToWav(blob) {
  const arr = await blob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  try {
    const decoded = await ctx.decodeAudioData(arr);
    const targetRate = 16000;
    const frames = Math.ceil(decoded.duration * targetRate);
    const off = new OfflineAudioContext(1, Math.max(1, frames), targetRate);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    return encodeWav(rendered.getChannelData(0), targetRate);
  } finally {
    try { ctx.close(); } catch (e) { /* ignore */ }
  }
}

export async function renderVoiceInput(host, onChange) {
  host.textContent = '';
  host.appendChild(loading('正在检测麦克风…'));

  const [probe, cfgRes] = await Promise.all([
    window.soulweave.asrWhisperProbe().catch(() => null),
    window.soulweave.asrConfigGet().catch(() => null),
  ]);
  host.textContent = '';

  const cfg = (cfgRes && cfgRes.config) || {};
  const reload = () => (onChange ? onChange() : renderVoiceInput(host, onChange));

  // ── 运行时状态 ──
  const statRow = el('div', 'vi-stat');
  const ready = !!(probe && probe.ready);
  statRow.appendChild(el('span', 'vi-dot ' + (ready ? 'on' : 'off')));
  statRow.appendChild(el('span', 'vi-stat-t', ready
    ? ('本地识别就绪 · ' + probe.modelsInstalled + ' 个模型')
    : (probe && probe.exeFound ? '有运行时但没模型，去下载中心下一个' : '缺少 whisper 运行时')));
  host.appendChild(statRow);

  // 没模型时给一个直接跳转的按钮：下载统一在下载中心，其他板块不自己开下载
  if (!ready) {
    host.appendChild(tip('本地语音识别还不能用，需要先下载一个模型（base 约 82 MB）。', 'warn'));
  }
  const dlRow = el('div', 'vi-file');
  dlRow.appendChild(btn(ready ? '管理模型' : '去下载模型', 'sm ghost', () => {
    import('./download-center.js').then((m) => m.gotoDownloads('whisper'));
  }));
  host.appendChild(dlRow);

  // ── 引擎与模型选择 ──
  const pickRow = el('div', 'vi-pick');
  const engineSel = document.createElement('select');
  engineSel.className = 'ls-input';
  [['local', '本地 whisper（离线、免费）'], ['cloud', '云端 ASR（需配置）']].forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    if ((cfg.engine || 'local') === v) o.selected = true;
    engineSel.appendChild(o);
  });
  pickRow.appendChild(engineSel);

  const models = (probe && probe.models) || [];
  const installed = models.filter((m) => m.installed);
  const modelSel = document.createElement('select');
  modelSel.className = 'ls-input';
  if (!installed.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = '还没有已下载的模型';
    modelSel.appendChild(o);
  }
  for (const m of installed) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.id + (m.id === 'base-q8_0' ? '（推荐）' : '');
    if ((cfg.modelId || 'base-q8_0') === m.id) o.selected = true;
    modelSel.appendChild(o);
  }
  pickRow.appendChild(modelSel);

  const langSel = document.createElement('select');
  langSel.className = 'ls-input';
  [['zh', '中文'], ['en', 'English'], ['ja', '日本語'], ['auto', '自动检测']].forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    if ((cfg.language || 'zh') === v) o.selected = true;
    langSel.appendChild(o);
  });
  pickRow.appendChild(langSel);
  host.appendChild(pickRow);

  const savePick = async () => {
    await window.soulweave.asrConfigSet({
      engine: engineSel.value,
      modelId: modelSel.value,
      language: langSel.value,
    }).catch(() => null);
    cfg.engine = engineSel.value;
    cfg.modelId = modelSel.value;
    cfg.language = langSel.value;
  };
  engineSel.addEventListener('change', savePick);
  modelSel.addEventListener('change', savePick);
  langSel.addEventListener('change', savePick);

  // 云端模式提示
  const cloudHint = el('div');
  host.appendChild(cloudHint);
  const refreshCloudHint = () => {
    cloudHint.textContent = '';
    if (engineSel.value === 'cloud') {
      cloudHint.appendChild(tip('云端模式：录音会上传到你选的服务商。没配置过就去下面「语音识别（ASR）」配一个。', 'warn'));
    }
  };
  engineSel.addEventListener('change', refreshCloudHint);
  refreshCloudHint();

  // ── 录音区 ──
  const recBox = el('div', 'vi-rec');
  const wave = el('div', 'vi-wave');
  for (let i = 0; i < 24; i++) {
    const bar = el('span', 'vi-bar');
    bar.style.height = '6px';
    wave.appendChild(bar);
  }
  recBox.appendChild(wave);

  const hint = el('div', 'vi-hint', '点下面的按钮开始说话');
  recBox.appendChild(hint);
  host.appendChild(recBox);

  const out = el('div');
  let recorder = null;
  let chunks = [];
  let startedAt = 0;
  let rafId = 0;
  let audioCtx = null;
  let analyser = null;
  let stream = null;
  let timer = 0;

  const stopMeter = () => {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (timer) { clearInterval(timer); timer = 0; }
    for (const b of wave.children) b.style.height = '6px';
    try { if (audioCtx) audioCtx.close(); } catch (e) { /* ignore */ }
    audioCtx = null; analyser = null;
  };

  const startMeter = (s) => {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
    const src = audioCtx.createMediaStreamSource(s);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (!analyser) return;
      analyser.getByteFrequencyData(data);
      const bars = wave.children;
      for (let i = 0; i < bars.length; i++) {
        const v = data[Math.floor(i * data.length / bars.length)] || 0;
        bars[i].style.height = Math.max(6, Math.round(v / 255 * 40)) + 'px';
      }
      rafId = requestAnimationFrame(tick);
    };
    tick();
  };

  const startRec = async () => {
    out.textContent = '';
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      out.appendChild(tip('拿不到麦克风：' + String(e && e.message ? e.message : e).slice(0, 120), 'bad'));
      return;
    }
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    recorder.onstop = async () => {
      stopMeter();
      try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
      stream = null;
      const blob = new Blob(chunks, { type: chunks[0] ? chunks[0].type : 'audio/webm' });
      await transcribe(blob);
    };
    recorder.start();
    startedAt = Date.now();
    startMeter(stream);
    hint.textContent = '正在录音…再点一次结束';
    recBtn.textContent = '■ 停止并识别';
    recBtn.classList.add('recording');
    timer = setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      hint.textContent = '正在录音… ' + s + ' 秒（再点一次结束）';
      if (s >= 60) { try { recorder.stop(); } catch (e) { /* ignore */ } }
    }, 500);
  };

  const stopRec = () => {
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch (e) { /* ignore */ }
    }
    recBtn.textContent = '● 开始说话';
    recBtn.classList.remove('recording');
    hint.textContent = '正在识别…';
  };

  const recBtn = btn('● 开始说话', 'primary', () => {
    if (recorder && recorder.state === 'recording') stopRec();
    else startRec();
  });
  recBox.appendChild(recBtn);

  // ── 文件上传（不录音也能测） ──
  const fileRow = el('div', 'vi-file');
  fileRow.appendChild(btn('或选一个音频文件', 'sm ghost', async () => {
    const r = await window.soulweave.pickFile({
      filters: [{ name: '音频', extensions: ['wav', 'mp3', 'm4a', 'ogg', 'webm', 'flac'] }],
    }).catch(() => null);
    if (!r || !r.ok || !r.path) return;
    out.textContent = '';
    out.appendChild(loading('正在识别文件…'));
    const res = await window.soulweave.asrTranscribe({
      path: r.path,
      engine: 'local',
      language: cfg.language || 'zh',
    }).catch((e) => ({ ok: false, error: String(e) }));
    out.textContent = '';
    out.appendChild(resultView(res));
  }));
  host.appendChild(fileRow);

  async function transcribe(blob) {
    out.textContent = '';
    out.appendChild(loading('正在转成 16 kHz WAV…'));
    let wav;
    try {
      wav = await blobToWav(blob);
    } catch (e) {
      out.textContent = '';
      out.appendChild(tip('音频解码失败：' + String(e && e.message ? e.message : e).slice(0, 120), 'bad'));
      return;
    }
    out.textContent = '';
    out.appendChild(loading('正在识别…（本地模型首次会慢一点）'));
    const b64 = toBase64(wav);
    const res = await window.soulweave.asrTranscribe({
      base64: b64,
      engine: engineSel.value,
      language: langSel.value,
      modelId: modelSel.value || undefined,
    }).catch((e) => ({ ok: false, error: String(e) }));
    out.textContent = '';
    out.appendChild(resultView(res, wav.length));
  }

  host.appendChild(out);
}

function resultView(r, bytes) {
  const ok = !!(r && r.ok);
  const box = el('div', 'vi-result ' + (ok ? 'ok' : 'bad'));
  const head = el('div', 'vi-result-h');
  head.appendChild(el('span', 'vi-result-dot'));
  head.appendChild(el('span', null, ok ? '识别完成' : '识别失败'));
  box.appendChild(head);

  if (ok) {
    const text = String(r.text || '').trim();
    const body = el('div', 'vi-result-text');
    body.textContent = text || '（这段音频里没有识别到语音）';
    box.appendChild(body);

    const meta = [];
    if (r.model) meta.push('模型 ' + r.model);
    if (r.ms) meta.push((r.ms / 1000).toFixed(1) + ' 秒');
    if (r.language) meta.push('语言 ' + r.language);
    if (bytes) meta.push((bytes / 1024).toFixed(0) + ' KB');
    if (meta.length) box.appendChild(el('div', 'vi-result-meta', meta.join(' · ')));

    if (text) {
      const row = el('div', 'vi-acts');
      row.appendChild(btn('复制', 'sm', async () => {
        try { await navigator.clipboard.writeText(text); row.appendChild(el('span', 'vi-copied', '已复制')); }
        catch (e) { /* ignore */ }
      }));
      box.appendChild(row);
    }
  } else {
    box.appendChild(el('div', 'vi-result-text', (r && r.error) || '未知错误'));
    if (r && r.code) box.appendChild(el('div', 'vi-result-meta', '错误码：' + r.code));
    if (r && r.code === 'NO_MODEL') {
      box.appendChild(el('div', 'vi-result-meta', '去「下载中心 → 语音识别模型」下载一个即可。'));
    }
  }
  return box;
}

export function ensureVoiceInputStyles() {
  if (document.getElementById('vi-styles')) return;
  const st = document.createElement('style');
  st.id = 'vi-styles';
  st.textContent = `
.vi-stat {
  display: flex; align-items: center; gap: 9px;
  padding: 9px 12px; border-radius: 9px; margin-bottom: 12px;
  border: 1px solid var(--sb-line); background: rgba(127,127,127,.04);
}
.vi-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.vi-dot.on { background: #6EE7A8; box-shadow: 0 0 6px rgba(110,231,168,.6); }
.vi-dot.off { background: #8E8A9C; }
.vi-stat-t { font-size: 11.5px; color: var(--sb-dim); }
.vi-rec {
  display: flex; flex-direction: column; align-items: center; gap: 12px;
  padding: 20px 16px; border-radius: 12px;
  border: 1px solid var(--sb-line); background: rgba(127,127,127,.04);
}
.vi-wave { display: flex; align-items: center; gap: 3px; height: 44px; }
.vi-bar {
  width: 4px; height: 6px; border-radius: 2px;
  background: linear-gradient(180deg, #6EA8FE, #C9A7FF);
  transition: height .08s ease-out;
}
.vi-hint { font-size: 11.5px; color: var(--sb-dim); text-align: center; }
.vi-pick { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.vi-pick > * { flex: 1; min-width: 150px; }
.vi-btn.recording, button.recording {
  background: rgba(255,120,120,.2) !important;
  border-color: rgba(255,120,120,.6) !important;
  color: #FF8E8E !important;
}
.vi-file { margin-top: 10px; }
.vi-result {
  margin-top: 12px; padding: 12px 14px; border-radius: 11px;
  border: 1px solid var(--sb-line); background: rgba(127,127,127,.05);
}
.vi-result.ok { border-color: rgba(110,231,168,.4); background: rgba(110,231,168,.06); }
.vi-result.bad { border-color: rgba(255,120,120,.4); background: rgba(255,120,120,.06); }
.vi-result-h { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 650; }
.vi-result.ok .vi-result-h { color: #6EE7A8; }
.vi-result.bad .vi-result-h { color: #FF8E8E; }
.vi-result-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.vi-result-text {
  margin-top: 8px; font-size: 12.5px; line-height: 1.75; color: var(--sb-fg);
  white-space: pre-wrap; word-break: break-word;
  max-height: 240px; overflow: auto;
}
.vi-result-meta { margin-top: 6px; font-size: 11.5px; color: var(--sb-dim); font-variant-numeric: tabular-nums; }
.vi-acts { display: flex; gap: 7px; margin-top: 9px; align-items: center; }
.vi-copied { font-size: 11.5px; color: #6EE7A8; }
`;
  document.head.appendChild(st);
}