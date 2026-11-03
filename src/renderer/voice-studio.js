import { swCall, swOn } from './api.js';
/**
 * SoulWeave S3-1：音色工坊（Voice Studio V1）
 *
 * 目标（对应 S3 退出标准）：
 *   - **多角色声音独立**：每个角色可绑定不同音色
 *   - **失败可回滚**：所有设置先写内存再落盘，失败时回退到上一个可用音色
 *
 * 当前只实现 'system' provider（Windows SAPI，离线零成本）。
 * 在线 provider 需要密钥与授权，此处只留接口与状态提示，**不发起任何在线请求**。
 */
const KEY = 'soulweave.voice';

/** 每角色（按模型索引）一条配置 */
const DEFAULT = {
  perModel: {},          // { "0": { voiceId, rate, volume } }
  fallbackVoiceId: null, // 全局兜底音色
};

let cfg = { ...DEFAULT, perModel: {} };
let voices = [];
let voicesError = null;
let current = null;      // 正在播放的 Audio（用于语音打断）

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw);
      cfg = { perModel: p.perModel || {}, fallbackVoiceId: p.fallbackVoiceId || null };
    }
  } catch (e) { /* ignore */ }
  return cfg;
}

function save() {
  let localOk = false;
  try { localStorage.setItem(KEY, JSON.stringify(cfg)); localOk = true; } catch (e) { /* ignore */ }
  // S3-2：同步到主进程持久化文件（失败不阻塞本地，二者取其可用）
  try { swCall('setVoiceConfig', JSON.parse(JSON.stringify(cfg))); } catch (e) { /* ignore */ }
  return localOk;
}

export function getVoiceConfig() {
  return { ...cfg, perModel: { ...cfg.perModel } };
}

/** 取某个角色的音色（含回退） */
export function voiceForModel(index) {
  const c = cfg.perModel[String(index)];
  if (c && c.voiceId) return { ...c, source: 'character' };
  if (cfg.fallbackVoiceId) return { voiceId: cfg.fallbackVoiceId, rate: 0, volume: 100, source: 'fallback' };
  // 终极兜底：第一个可用音色，保证「失败可回滚」而不是没声音
  if (voices.length) return { voiceId: voices[0].id, rate: 0, volume: 100, source: 'auto' };
  return null;
}

export function setVoiceForModel(index, patch) {
  const key = String(index);
  const prev = cfg.perModel[key] ? { ...cfg.perModel[key] } : null;
  const next = { ...(prev || {}), ...patch };
  cfg.perModel[key] = next;
  if (!save()) {
    // 落盘失败 → 回滚内存，保证与磁盘一致
    if (prev) cfg.perModel[key] = prev; else delete cfg.perModel[key];
    return { ok: false, error: '保存失败' };
  }
  return { ok: true, value: next };
}

/** 语音打断：立即停止当前播放 */
export function stopSpeaking() {
  const node = current;
  if (!node) return false;
  current = null;
  try { node.onended = null; node.stop(); } catch (e) { /* ignore */ }
  return true;
}

export function isSpeaking() { return !!current; }

/**
 * 音频播放：**Web Audio API**，不用 <audio> 元素。
 *
 * 【为什么】
 * 最初用 data: URL → Chromium 报
 *   "Media load rejected by URL safety check"（拒绝 data: 作媒体源）。
 * 改用 blob: URL → **仍然报同一个错**。
 * 排查后确认 WAV 本身完全合法（RIFF/WAVE/fmt /PCM/22050Hz/mono/16bit），
 * 根因是**页面以 file:// 加载，Chromium 对媒体元素加载有额外安全限制**。
 *
 * Web Audio 走的是 decodeAudioData(ArrayBuffer) + BufferSource，
 * 完全不经过「URL 安全校验」这条路径，因此稳定可靠，也天生支持打断。
 */
/** S3-2：说话会话令牌。递增即代表「有新请求」，旧流水线据此退出（barge-in） */
let session = 0;

/**
 * S3-11：输出归一化目标。
 * −1.5 dBFS ≈ 0.8414。
 *
 * 【为什么需要】不同 provider 输出电平差异很大：
 *   SAPI 常到满量程、Piper 峰值 1.000、Kokoro 只有 0.71；
 *   不统一的话用户切换音色会忽大忽小。
 * 在 Web Audio 侧统一乘一个增益，比在各 provider 里分别处理更可靠。
 */
const TARGET_PEAK = 0.8414;

/** 计算 AudioBuffer 的峰值（只看前 30 秒，避免长音频遍历过久） */
function peakOf(audioBuffer) {
  let peak = 0;
  const chs = Math.min(audioBuffer.numberOfChannels, 2);
  const limit = Math.min(audioBuffer.length, Math.floor(audioBuffer.sampleRate * 30));
  for (let c = 0; c < chs; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < limit; i++) {
      const v = data[i] < 0 ? -data[i] : data[i];
      if (v > peak) peak = v;
      if (peak >= 1) break;
    }
  }
  return peak;
}

/** 建一条「源 → 增益 → 输出」的链；增益按峰值归一化 */
function connectNormalized(ac, src, audioBuffer) {
  const peak = peakOf(audioBuffer);
  const gainValue = peak > 0.0001 ? TARGET_PEAK / peak : 1;
  // 峰值过大时不要放大（只压低），避免把噪声抬起来
  const g = Math.min(gainValue, 1.0);
  const gain = ac.createGain();
  gain.gain.value = g;
  src.connect(gain);
  gain.connect(ac.destination);
  return { gain, peak, applied: g };
}

let audioCtx = null;
function getCtx() {
  if (!audioCtx) {
    const C = window.AudioContext || window.webkitAudioContext;
    audioCtx = new C();
  }
  // 某些情况下上下文会被挂起（无用户手势/系统休眠），确保恢复
  if (audioCtx.state === 'suspended') { audioCtx.resume().catch(() => {}); }
  return audioCtx;
}

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** 播放一段 WAV 的 ArrayBuffer；会先打断上一段 */
async function playArrayBuffer(arrayBuffer) {
  stopSpeaking();
  try {
    const ac = getCtx();
    const audioBuf = await ac.decodeAudioData(arrayBuffer);
    const src = ac.createBufferSource();
    src.buffer = audioBuf;
    connectNormalized(ac, src, audioBuf);
    current = src;
    src.onended = () => { if (current === src) current = null; };
    src.start();
    return true;
  } catch (e) {
    current = null;
    return false;
  }
}

/**
 * 说话：合成 + 播放（会先打断上一段）。
 * @returns {Promise<{ok:boolean, ms?:number, error?:string}>}
 */
export async function speak(text, modelIndex = 0) {
  const v = voiceForModel(modelIndex);
  if (!v) return { ok: false, error: '没有可用音色' };
  const api = window.soulweave;
  if (!api?.synthVoice) return { ok: false, error: '语音接口不可用' };

  stopSpeaking();   // 语音打断
  let r;
  try {
    r = await swCall('synthVoice', {
      text,
      voiceId: v.voiceId,
      rate: v.rate ?? 0,
      volume: v.volume == null ? 100 : v.volume,
    });
  } catch (e) {
    return { ok: false, error: '调用失败：' + String(e).slice(0, 120) };
  }
  if (!r || !r.ok) return { ok: false, error: r?.error || '合成失败' };

  const b64 = r.base64 || (r.dataUrl ? String(r.dataUrl).split(',')[1] : '') || '';
  if (!b64) return { ok: false, error: '音频数据无效' };

  let ab = null;
  try { ab = base64ToArrayBuffer(b64); } catch (e) { return { ok: false, error: '音频转换失败' }; }
  const played = await playArrayBuffer(ab);
  return { ok: played, ms: r.ms, error: played ? undefined : '播放失败' };
}

/**
 * 按句切分。中文/英文句末标点都要照顾，长句再按逗号兜底切短。
 * 目的：把「整段合成」变成「逐句流水线」，压低语音首包延迟。
 */
export function splitSentences(text, maxLen = 60) {
  const raw = String(text || '').replace(/\r/g, '');
  const coarse = raw.match(/[^。！？!?；;\n]+[。！？!?；;\n]?/g) || [raw];
  const out = [];
  for (const c of coarse) {
    const t = c.trim();
    if (!t) continue;
    if (t.length <= maxLen) { out.push(t); continue; }
    // 超长句按逗号再切
    const subs = t.match(/[^，,、]+[，,、]?/g) || [t];
    let buf = '';
    for (const sub of subs) {
      if ((buf + sub).length > maxLen && buf) { out.push(buf); buf = sub; }
      else buf += sub;
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out.length ? out : [raw];
}

/**
 * 播放并等待结束；被新的会话取消时立即 resolve。
 *
 * 【为什么必须有超时兜底】
 * 原本只靠 onended 决定完成。但实测发现：当 AudioContext 处于 suspended
 * 或音频设备未就绪时，createBufferSource().start() 不会真正推进播放，
 * onended **永远不触发** —— 调用方 await 会一直挂着，
 * 表现为「流式朗读卡住、连日志都打不出来」（S3-14 自测就是这么挂的）。
 *
 * 因此按音频时长 + 余量设定超时，到点即视为完成（返回 false 表示未确认播放完毕）。
 */
function playAndWait(arrayBuffer, token) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(ok);
    };
    try {
      const ac = getCtx();
      ac.decodeAudioData(arrayBuffer).then((buf) => {
        if (token !== session) { finish(false); return; }
        const node = ac.createBufferSource();
        node.buffer = buf;
        connectNormalized(ac, node, buf);
        current = node;
        node.onended = () => { if (current === node) current = null; finish(true); };
        // 兜底：时长 + 1.2s（含 20ms 起播抖动与设备缓冲）
        const ms = Math.max(600, Math.round((buf.duration + 1.2) * 1000));
        timer = setTimeout(() => {
          if (current === node) current = null;
          finish(false);
        }, ms);
        node.start();
      }).catch(() => finish(false));
    } catch (e) {
      finish(false);
    }
  });
}

/**
 * 流式说话：逐句「合成下一句」与「播放当前句」重叠执行。
 *
 * 为什么不是真·流式：SAPI 只能整句合成到文件，做不到逐字吐音频流。
 * 但把「整段合成」拆成「逐句流水线」后，首包延迟从「整段合成时间」
 * 降到「第一句合成时间」，多句回复的体感提升明显。
 *
 * barge-in：session 令牌递增即代表「有新的说话请求」，旧流水线在下一个
 * 检查点立刻退出，并停掉正在播的音频。
 */
export async function speakStreaming(text, modelIndex = 0) {
  const my = ++session;
  stopSpeaking();

  const segs = splitSentences(text).slice(0, 24);
  if (!segs.length) return { ok: false, error: '没有可朗读的内容' };

  const api = window.soulweave;
  if (!api?.synthVoice) return { ok: false, error: '语音接口不可用' };

  const v = voiceForModel(modelIndex);
  if (!v) return { ok: false, error: '没有可用音色' };

  const synth = (t) => swCall('synthVoice', {
    text: t, voiceId: v.voiceId, rate: v.rate ?? 0,
    volume: v.volume == null ? 100 : v.volume,
  }).catch((e) => ({ ok: false, error: String(e) }));

  const t0 = performance.now();
  let firstPacketMs = null;
  let played = 0;
  const segErrors = [];   // S3-2 诊断：记录每句失败原因
  let pending = synth(segs[0]);

  for (let i = 0; i < segs.length; i++) {
    if (my !== session) return { ok: false, cancelled: true, played, firstPacketMs };

    const r = await pending;
    if (my !== session) return { ok: false, cancelled: true, played, firstPacketMs };
    if (!r || !r.ok) {
      // 单句失败不整体失败：跳过继续，保证「失败可回滚」而不是没声音
      segErrors.push({ i, err: (r && r.error) || 'synth-failed', ms: r && r.ms });
      pending = (i + 1 < segs.length) ? synth(segs[i + 1]) : null;
      continue;
    }

    // 先发起下一句的合成，再去播放当前句 → 合成与播放重叠
    pending = (i + 1 < segs.length) ? synth(segs[i + 1]) : null;

    const b64 = r.base64 || (r.dataUrl ? String(r.dataUrl).split(',')[1] : '');
    if (!b64) { segErrors.push({ i, err: 'no-base64' }); continue; }
    let ab = null;
    try { ab = base64ToArrayBuffer(b64); } catch (e) { continue; }

    if (firstPacketMs == null) firstPacketMs = Math.round(performance.now() - t0);
    const done = await playAndWait(ab, my);
    played++;
    if (!done) segErrors.push({ i, err: 'play-not-done' });
    if (!done || my !== session) {
      return { ok: false, cancelled: true, played, firstPacketMs };
    }
  }

  return { ok: played > 0, played, segments: segs.length, firstPacketMs, segErrors };
}

export async function loadVoices(force = false) {
  const api = window.soulweave;
  if (!api?.listVoices) { voicesError = '接口不可用'; return []; }
  try {
    const r = await swCall('listVoices', );
    if (r && r.ok && Array.isArray(r.voices)) {
      voices = r.voices;
      voicesError = r.voices.length ? null : '系统未安装可用音色';
    } else {
      voicesError = r?.error || '读取失败';
    }
  } catch (e) {
    // 例如主进程未注册 handler（测试环境）→ 必须显式报错，不能静默为空
    voices = [];
    voicesError = '调用失败：' + String(e).slice(0, 120);
  }
  void force;
  return voices;
}

export function getVoices() { return voices; }
export function getVoicesError() { return voicesError; }

// ── UI ──────────────────────────────────────────────

const SAMPLE = '你好，我是你的数字伙伴。今天想聊点什么？';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function renderVoiceStudio(host) {
  if (!host) return;
  host.textContent = '';

  if (voicesError) {
    const err = el('div', 'set-hint', '系统音色读取失败：' + voicesError);
    host.appendChild(err);
  }
  if (!voices.length) {
    host.appendChild(el('div', 'set-hint', '没有检测到系统音色。'));
    return;
  }

  const models = (window.__modelCaps?.() || []).filter((c) => c && c.loaded);
  const list = models.length ? models : [{ index: 0 }];

  for (const m of list) {
    const row = el('div', 'vs-row');
    row.appendChild(el('span', 'vs-label', '角色 ' + (m.index + 1)));

    const sel = document.createElement('select');
    sel.className = 'set-select vs-select';
    const cur = voiceForModel(m.index);
    voices.forEach((v) => {
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = v.name + ' · ' + v.culture;
      if (cur && cur.voiceId === v.id) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      const r = setVoiceForModel(m.index, { voiceId: sel.value });
      if (!r.ok) { sel.value = cur?.voiceId || voices[0].id; }
    });
    row.appendChild(sel);

    const btn = el('button', 'cap-chip', '试听');
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '合成中…';
      const r = await speak(SAMPLE, m.index);
      btn.disabled = false;
      btn.textContent = r.ok ? '试听' : '重试';
      if (!r.ok) btn.title = r.error || '';
    });
    row.appendChild(btn);
    host.appendChild(row);
  }

  // 全局兜底音色
  const fb = el('div', 'vs-row');
  fb.appendChild(el('span', 'vs-label', '兜底'));
  const fsel = document.createElement('select');
  fsel.className = 'set-select vs-select';
  const optAuto = document.createElement('option');
  optAuto.value = '';
  optAuto.textContent = '自动（第一个可用）';
  fsel.appendChild(optAuto);
  voices.forEach((v) => {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = v.name;
    if (cfg.fallbackVoiceId === v.id) o.selected = true;
    fsel.appendChild(o);
  });
  fsel.addEventListener('change', () => {
    cfg.fallbackVoiceId = fsel.value || null;
    save();
  });
  fb.appendChild(fsel);
  host.appendChild(fb);

  // 语速
  const rateRow = el('div', 'vs-row');
  rateRow.appendChild(el('span', 'vs-label', '语速'));
  const rate = document.createElement('input');
  rate.type = 'range';
  rate.min = '-10'; rate.max = '10'; rate.step = '1';
  rate.className = 'vs-range';
  const first = voiceForModel(list[0].index);
  rate.value = String(first?.rate ?? 0);
  const rateVal = el('span', 'vs-val', rate.value);
  rate.addEventListener('input', () => {
    rateVal.textContent = rate.value;
    for (const m of list) setVoiceForModel(m.index, { rate: Number(rate.value) });
  });
  rateRow.appendChild(rate);
  rateRow.appendChild(rateVal);
  host.appendChild(rateRow);

  host.appendChild(el('div', 'set-hint',
    '系统音色：离线可用、零成本。在线 TTS 需要配置密钥（未接入）。'));
}

export async function initVoiceStudio() {
  // 先读主进程持久化配置（userData/voice-config.json）
  try {
    const remote = await swCall('getVoiceConfig', );
    if (remote && typeof remote === 'object') {
      cfg = { perModel: remote.perModel || {}, fallbackVoiceId: remote.fallbackVoiceId || null };
      try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
    } else {
      load();   // 主进程没有则回落本地缓存
    }
  } catch (e) {
    load();     // 接口不可用（如测试环境）也要能用
  }
  await loadVoices();
  return getVoiceConfig();
}
