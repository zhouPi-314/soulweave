/**
 * SoulWeave 手机 Web
 *
 * 【设计取舍】
 * 不引框架。首屏要小、要在中低端手机上不卡，一个聊天页不值得 Vue/React。
 * 全部逻辑就在下面几个函数里，改起来也直接。
 *
 * 【凭证】
 * 设备令牌存 localStorage，只在本机浏览器；会话令牌只放内存，刷新即换新。
 * 会话 30 分钟不用就过期，届时自动用设备令牌静默续期。
 */

const LS_DEVICE = 'sw.device';

const $ = (s) => document.querySelector(s);
const state = {
  deviceToken: '',
  sessionToken: '',
  scopes: [],
  characters: [],
  current: '',
  busy: false,
  tier: 'eco',
  ws: null,
  wsReady: false,
  speaking: false,
  voiceReply: true,
};

// ── 设备能力 → 画质档位 ───────────────────────────────
//
// 需求 §8「按设备能力调整渲染质量，避免默认高负载」。
// 默认省电；只有明确是好设备才升级。
function detectTier() {
  const mem = navigator.deviceMemory || 2;
  const cores = navigator.hardwareConcurrency || 2;
  const conn = navigator.connection || {};
  const slowNet = /2g|slow-2g/.test(String(conn.effectiveType || ''));
  const saveData = conn.saveData === true;
  if (saveData || slowNet) return 'eco';
  if (mem >= 6 && cores >= 6) return 'rich';
  if (mem >= 4 && cores >= 4) return 'balanced';
  return 'eco';
}

// ── HTTP ───────────────────────────────────────────────
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.sessionToken) headers.authorization = 'Bearer ' + state.sessionToken;
  if (opts.body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
  const r = await fetch(path, {
    method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch { j = null; }
  if (r.status === 401) {
    // 会话过期：清掉内存令牌，让上层决定是重登还是回配对页
    state.sessionToken = '';
  }
  if (!r.ok) {
    const err = new Error((j && (j.error || j.reason)) || ('HTTP ' + r.status));
    err.status = r.status;
    throw err;
  }
  return j;
}

// ── 会话 ───────────────────────────────────────────────
async function openSession() {
  const dev = localStorage.getItem(LS_DEVICE) || '';
  if (!dev) return false;
  state.deviceToken = dev;
  try {
    const j = await api('/api/session', { body: { deviceToken: dev } });
    state.sessionToken = j.sessionToken;
    state.scopes = j.scopes || [];
    return true;
  } catch (e) {
    // 设备被撤销 / 令牌失效：别再拿它试了
    if (e.status === 401) localStorage.removeItem(LS_DEVICE);
    return false;
  }
}

function showGate(msg) {
  $('#app').hidden = true;
  $('#gate').hidden = false;
  $('#gate-err').textContent = msg || '';
  const inp = $('#pair-code');
  inp.value = '';
  setTimeout(() => inp.focus(), 60);
}

function showApp() {
  $('#gate').hidden = true;
  $('#app').hidden = false;
}

// ── 角色 ───────────────────────────────────────────────
function renderChars() {
  const box = $('#chars');
  box.textContent = '';
  for (const c of state.characters) {
    const b = document.createElement('button');
    b.type = 'button';
    const usable = c.canChat !== false;
    b.className = 'char' + (String(c.id) === String(state.current) ? ' on' : '') + (usable ? '' : ' off');
    b.disabled = !usable;
    b.title = usable ? '' : '这个角色还没有会话实现';
    const ava = document.createElement('span');
    ava.className = 'char-ava';
    ava.textContent = c.emoji || (c.name || '?').slice(0, 1);
    const nm = document.createElement('span');
    nm.textContent = c.name || ('角色 ' + c.id);
    b.append(ava, nm);
    b.addEventListener('click', () => { state.current = String(c.id); renderChars(); addMsg('sys', '已切换到 ' + (c.name || c.id)); });
    box.appendChild(b);
  }
}

/** DSH 的进度事件 → 用户看得懂的一句话 */
function progressText(p) {
  if (p === 'turn_start') return '正在思考…';
  if (p === 'step_start') return '正在思考…';
  if (p === 'thinking') return '正在整理思路…';
  if (p.indexOf('tool:') === 0) return '正在使用工具：' + p.slice(5);
  return '';
}

// ── 消息 ───────────────────────────────────────────────
function addMsg(kind, text, who) {
  const d = document.createElement('div');
  d.className = 'msg ' + kind;
  if (who) {
    const w = document.createElement('span');
    w.className = 'who';
    w.textContent = who;
    d.appendChild(w);
  }
  d.appendChild(document.createTextNode(text));
  const log = $('#log');
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}

function characterName(id) {
  const c = state.characters.find((x) => String(x.id) === String(id));
  return c ? (c.name || String(id)) : String(id);
}

/** 把气泡内容设成「角色名 + 正文」，流式时反复调用 */
function paintBubble(el, who, text) {
  el.textContent = '';
  const w = document.createElement('span');
  w.className = 'who';
  w.textContent = who;
  el.appendChild(w);
  el.appendChild(document.createTextNode(text));
}

async function send(text) {
  if (state.busy) return;
  const t = String(text || '').trim();
  if (!t) return;
  const cur = state.characters.find((x) => String(x.id) === String(state.current));
  if (cur && cur.canChat === false) {
    addMsg('sys', (cur.name || '这个角色') + ' 目前只有云端配置，还没有接入对话。换「冰糖」试试。');
    return;
  }
  state.busy = true;
  $('#send').disabled = true;
  addMsg('me', t);
  const who = characterName(state.current);
  const pending = addMsg('her', '……', who);
  let acc = '';

  const finishOk = (finalText) => {
    const reply = String(finalText || acc || '').trim();
    paintBubble(pending, who, reply || '（她没有说话）');
    if (state.voiceReply) speak(reply);
  };

  try {
    if (state.wsReady && state.ws) {
      // 流式：DSH 每提交一段就推一行，先让用户看到第一段
      const t0 = Date.now();
      let lastProgress = '正在思考…';
      const r = await wsChat(t, state.current, (chunk) => {
        acc += chunk;
        paintBubble(pending, who, acc);
        const log = $('#log');
        log.scrollTop = log.scrollHeight;
      }, (p) => {
        const txt = progressText(p);
        if (!txt || acc) return;
        lastProgress = txt;
        paintBubble(pending, who, txt + '（' + Math.round((Date.now() - t0) / 1000) + 's）');
      });
      if (r.ok) finishOk(r.text);
      else { pending.className = 'msg err'; pending.textContent = r.error || '出错了'; }
    } else {
      const j = await api('/api/chat', { body: { text: t, characterId: state.current } });
      const d = (j && j.data) || {};
      if (d.error || d.ok === false) { pending.className = 'msg err'; pending.textContent = String(d.error || '出错了'); }
      else finishOk(String(d.text || ''));
    }
  } catch (e) {
    pending.className = 'msg err';
    pending.textContent = '发送失败：' + (e.message || e);
    if (e.status === 401) {
      const ok = await openSession();
      if (!ok) showGate('会话已过期，请重新配对。');
    }
  } finally {
    state.busy = false;
    $('#send').disabled = false;
    const log = $('#log');
    log.scrollTop = log.scrollHeight;
  }
}

// ── WebSocket：流式聊天 ────────────────────────────────
let pendingChat = null;
let wsRetry = 0;

function connectWs() {
  if (!state.sessionToken) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let sock;
  try { sock = new WebSocket(proto + '//' + location.host + '/ws'); } catch (e) { return; }
  state.ws = sock;
  sock.addEventListener('open', () => {
    sock.send(JSON.stringify({ type: 'auth', token: state.sessionToken }));
  });
  sock.addEventListener('message', (ev) => {
    let m = null;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'ready') { state.wsReady = true; wsRetry = 0; return; }
    if (m.type === 'chat.delta') {
      if (pendingChat && m.id === pendingChat.id) pendingChat.onDelta(String(m.text || ''));
      return;
    }
    if (m.type === 'chat.progress') {
      if (pendingChat && m.id === pendingChat.id && pendingChat.onProgress) pendingChat.onProgress(String(m.text || ''));
      return;
    }
    if (m.type === 'chat.done') {
      if (pendingChat && m.id === pendingChat.id) {
        const p = pendingChat;
        pendingChat = null;
        p.resolve({ ok: m.ok === true, text: String(m.text || ''), error: String(m.error || '') });
      }
      return;
    }
    if (m.type === 'chat.error') {
      if (pendingChat && m.id === pendingChat.id) {
        const p = pendingChat;
        pendingChat = null;
        p.resolve({ ok: false, text: '', error: String(m.error || '出错了') });
      }
    }
  });
  sock.addEventListener('close', (ev) => {
    state.wsReady = false;
    if (pendingChat) { pendingChat.resolve({ ok: false, text: '', error: '连接断开' }); pendingChat = null; }
    // 4401 = 服务端判定认证失败。这时候无限重连只会：
    //   · 每 3 秒打一次服务端日志与审计
    //   · 还把失败计数堆到限速阈值
    // 正确做法是停下来，重新用设备令牌换会话；换不到就回配对页。
    if (ev && ev.code === 4401) {
      state.sessionToken = '';
      openSession().then((ok) => { if (ok) connectWs(); else showGate('会话已失效，请重新配对。'); });
      return;
    }
    wsRetry = Math.min(wsRetry + 1, 6);
    const wait = Math.min(3000 * Math.pow(1.6, wsRetry - 1), 30000);
    setTimeout(() => { if (state.sessionToken && !state.wsReady) connectWs(); }, wait);
  });
  sock.addEventListener('error', () => { state.wsReady = false; });
}

function wsChat(text, characterId, onDelta, onProgress) {
  return new Promise((resolve) => {
    const id = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 7);
    pendingChat = { id, onDelta, onProgress, resolve };
    try {
      state.ws.send(JSON.stringify({ type: 'chat', id, text, characterId }));
    } catch (e) {
      pendingChat = null;
      resolve({ ok: false, text: '', error: '发送失败' });
    }
  });
}

// ── 语音：朗读 ─────────────────────────────────────────
//
// 用后端 SAPI 合成（和桌面同一个 synthesize），返回裸 base64 wav。
// 失败一律静默：语音是锦上添花，不能因为它把文字聊天搞坏。
async function speak(text) {
  const t = String(text || '').trim();
  if (!t) return;
  try {
    // 长回复只读前 200 字，否则手机要等一长段才出声
    const j = await api('/api/tts', { body: { text: t.slice(0, 200), characterId: state.current } });
    if (!j || !j.ok || !j.audioBase64) return;
    const bin = atob(j.audioBase64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const blob = new Blob([buf], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.addEventListener('ended', () => URL.revokeObjectURL(url));
    audio.addEventListener('error', () => URL.revokeObjectURL(url));
    await audio.play();
  } catch (e) { /* 静默 */ }
}

// ── 语音：按住说话 ─────────────────────────────────────
let recorder = null;
let recChunks = [];
let recStream = null;

/** float32 → 16 kHz 单声道 WAV（whisper 只吃 wav） */
function encodeWav(float32, sampleRate) {
  const len = float32.length;
  const buf = new ArrayBuffer(44 + len * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  v.setUint32(4, 36 + len * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, len * 2, true);
  let o = 44;
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return new Uint8Array(buf);
}

function toBase64(bytes) {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}

/** 把录到的音频解码并重采样到 16 kHz 单声道 */
async function toWav16k(blob) {
  const arr = await blob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  let audio;
  try {
    audio = await ctx.decodeAudioData(arr);
  } finally {
    try { await ctx.close(); } catch (e) { /* ignore */ }
  }
  const target = 16000;
  const frames = Math.max(1, Math.ceil(audio.duration * target));
  const off = new OfflineAudioContext(1, frames, target);
  const src = off.createBufferSource();
  src.buffer = audio;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return encodeWav(rendered.getChannelData(0), target);
}

async function startRec() {
  if (recorder) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('这个浏览器不支持录音');
    return;
  }
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    alert('拿不到麦克风权限：' + (e && e.message ? e.message : e));
    return;
  }
  recChunks = [];
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
  recorder = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
  recorder.addEventListener('dataavailable', (ev) => { if (ev.data && ev.data.size) recChunks.push(ev.data); });
  recorder.start();
  const btn = $('#mic');
  btn.classList.add('rec');
  btn.textContent = '松开发送';
}

async function stopRec() {
  const btn = $('#mic');
  const rec = recorder;
  if (!rec) return;
  const stopped = new Promise((resolve) => rec.addEventListener('stop', resolve, { once: true }));
  try { rec.stop(); } catch (e) { /* ignore */ }
  await stopped;
  recorder = null;
  if (recStream) { for (const tr of recStream.getTracks()) { try { tr.stop(); } catch (e) { /* ignore */ } } recStream = null; }
  btn.classList.remove('rec');
  btn.textContent = '按住说话';

  const blob = new Blob(recChunks, { type: recChunks[0] ? recChunks[0].type : 'audio/webm' });
  recChunks = [];
  if (!blob.size) { addMsg('sys', '没有录到声音'); return; }
  if (blob.size < 2000) { addMsg('sys', '说话时间太短了'); return; }

  addMsg('sys', '正在识别…');
  try {
    const wav = await toWav16k(blob);
    const j = await api('/api/asr', { body: { audioBase64: toBase64(wav), mime: 'audio/wav' } });
    if (!j || !j.ok) {
      if (j && j.code === 'NO_SPEECH') addMsg('sys', '没听清，再说一次？');
      else if (j && j.code === 'NO_MODEL') addMsg('err', '还没有下载语音模型：电脑上「下载中心 → 语音识别」装一个。');
      else if (j && j.code === 'NO_BINARY') addMsg('err', '这台电脑上没找到 whisper 运行文件。');
      else addMsg('err', '识别失败：' + ((j && (j.error || j.code)) || '未知'));
      return;
    }
    const text = String(j.text || '').trim();
    if (!text) { addMsg('sys', '没听清，再说一次？'); return; }
    addMsg('sys', '识别为：' + text);
    await send(text);
  } catch (e) {
    addMsg('err', '录音处理失败：' + (e && e.message ? e.message : e));
  }
}

// ── 抽屉 ───────────────────────────────────────────────
function openSheet(title, build) {
  $('#sheet-title').textContent = title;
  const body = $('#sheet-body');
  body.textContent = '';
  build(body);
  $('#sheet').hidden = false;
}
function closeSheet() { $('#sheet').hidden = true; }

function row(parent, k, v, cls) {
  const d = document.createElement('div');
  d.className = 'row';
  const a = document.createElement('span'); a.className = 'k'; a.textContent = k;
  const b = document.createElement('span'); b.className = 'v' + (cls ? ' ' + cls : ''); b.textContent = v;
  d.append(a, b);
  parent.appendChild(d);
}

async function showStatus() {
  openSheet('状态', async (body) => {
    body.textContent = '读取中…';
    try {
      const j = await api('/api/status');
      const d = (j && j.data) || {};
      body.textContent = '';
      row(body, '服务', d.version ? ('v' + d.version) : '在线');
      row(body, '角色', d.characterCount != null ? String(d.characterCount) : String(state.characters.length));
      row(body, '当前角色', characterName(state.current));
      row(body, '画质档位', state.tier === 'eco' ? '省电' : state.tier === 'balanced' ? '平衡' : '精致');
      row(body, '我的权限', state.scopes.join(' · ') || '—');
      if (Array.isArray(d.services)) {
        for (const s of d.services) row(body, String(s.name || ''), String(s.state || ''), s.state === 'ok' ? '' : 'warn');
      }
    } catch (e) {
      body.textContent = '读取失败：' + (e.message || e);
    }
  });
}

/** 记忆：只读检索。写操作永远在电脑上。 */
function showMemory() {
  openSheet('记忆', (body) => {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = '可以标记「别忘」；改写、删除、共享申请仍需回到电脑上的「记忆」面板。';
    body.appendChild(hint);

    const row = document.createElement('div');
    row.className = 'search-row';
    const inp = document.createElement('input');
    inp.className = 'search-input';
    inp.placeholder = '搜点什么，比如「早饭」';
    inp.setAttribute('aria-label', '搜索记忆');
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'btn';
    go.textContent = '搜索';
    row.append(inp, go);
    body.appendChild(row);

    const list = document.createElement('div');
    list.className = 'mem-list';
    body.appendChild(list);

    const doSearch = async () => {
      const q = inp.value.trim();
      list.textContent = '';
      if (!q) { list.appendChild(elText('div', 'hint', '先输入关键词')); return; }
      go.disabled = true;
      list.appendChild(elText('div', 'hint', '搜索中…'));
      try {
        const j = await api('/api/memory/search?q=' + encodeURIComponent(q) + '&limit=20&character=' + encodeURIComponent(state.current));
        list.textContent = '';
        const rows = (j && j.data && j.data.rows) || [];
        if (!j || !j.data || j.data.ok === false) {
          list.appendChild(elText('div', 'hint', '检索失败：' + ((j && j.data && j.data.error) || '未知')));
          return;
        }
        if (!rows.length) { list.appendChild(elText('div', 'hint', '没有找到相关的记忆')); return; }
        for (const r of rows) {
          const item = document.createElement('div');
          item.className = 'mem-item';
          const txt = document.createElement('div');
          txt.className = 'mem-text';
          txt.textContent = String(r.text || '').slice(0, 240);
          const meta = document.createElement('div');
          meta.className = 'mem-meta';
          const when = r.at ? new Date(r.at) : null;
          meta.textContent = [when && !isNaN(when) ? when.toLocaleDateString('zh-CN') : '', r.source || ''].filter(Boolean).join(' · ');
          item.append(txt, meta);

          // 「别忘」是唯一允许在手机上做的写操作：
          // 不改内容、不删除，最坏情况也只是多一个标记。
          // 需要 memory:write 作用域 —— 默认不给，得回电脑批准。
          if (r.id) {
            const pin = document.createElement('button');
            pin.type = 'button';
            pin.className = 'mem-pin' + (r.pinned ? ' on' : '');
            pin.textContent = r.pinned ? '★ 别忘' : '☆ 别忘';
            pin.title = r.pinned ? '取消「别忘」' : '标记为「别忘」';
            pin.addEventListener('click', async () => {
              pin.disabled = true;
              try {
                const j = await api('/api/memory/pin', { body: { id: r.id, pinned: !r.pinned, ownerCharacter: state.current } });
                if (!j || !j.ok) { alert('操作失败：' + ((j && j.error) || '未知')); return; }
                r.pinned = !r.pinned;
                pin.className = 'mem-pin' + (r.pinned ? ' on' : '');
                pin.textContent = r.pinned ? '★ 别忘' : '☆ 别忘';
              } catch (e) {
                if (String(e.message || '').indexOf('forbidden') >= 0 || e.status === 401) {
                  alert('需要电脑授权。到「更多 → 申请修改记忆」，电脑上点批准后再试。');
                } else {
                  alert('操作失败：' + (e.message || e));
                }
              } finally {
                pin.disabled = false;
              }
            });
            item.appendChild(pin);
          }
          list.appendChild(item);
        }
      } catch (e) {
        list.textContent = '';
        list.appendChild(elText('div', 'hint', '检索失败：' + (e.message || e)));
      } finally {
        go.disabled = false;
      }
    };
    go.addEventListener('click', doSearch);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
  });
}

/** 社交：只读状态。加好友、改白名单都要在电脑上。 */
async function showSocial() {
  openSheet('社交', (body) => {
    body.textContent = '读取中…';
    api('/api/social/status').then((j) => {
      body.textContent = '';
      const d = (j && j.data) || {};
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = '只显示连接状态与人数，不显示 QQ 号。改白名单请到电脑上的「社交」面板。';
      body.appendChild(hint);
      const accounts = d.accounts || [];
      if (!accounts.length) body.appendChild(elText('div', 'hint', '还没有配置 QQ 账号'));
      for (const a of accounts) {
        const line = document.createElement('div');
        line.className = 'row';
        line.appendChild(elText('span', 'k', String(a.label || '')));
        const stMap = { online: '已连接', connecting: '连接中', logged_in: '已登录（未接入）', offline: '未连接', reconnecting: '重连中', stopped: '已停止', error: '失败', failed: '失败' };
        line.appendChild(elText('span', 'v', stMap[a.state] || a.state || '未知'));
        body.appendChild(line);
      }
      const wl = d.whitelist || [];
      if (wl.length) {
        body.appendChild(elText('div', 'sheet-sub', '白名单'));
        for (const w of wl) {
          const line = document.createElement('div');
          line.className = 'row';
          line.appendChild(elText('span', 'k', String(w.account || '')));
          line.appendChild(elText('span', 'v', '主人 ' + (w.owners || 0) + ' · 好友 ' + (w.friends || 0) + ' · 群 ' + (w.groups || 0)));
          body.appendChild(line);
        }
      }
    }).catch((e) => { body.textContent = '读取失败：' + (e.message || e); });
  });
}

function elText(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.textContent = text;
  return e;
}

function showMore() {
  openSheet('更多', (body) => {
    const mk = (label, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.style.width = '100%';
      b.style.marginTop = '10px';
      b.textContent = label;
      b.addEventListener('click', fn);
      body.appendChild(b);
      return b;
    };
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '高风险操作（改记忆、改设置、撤销设备）只能在电脑上完成。这里可以发起申请，电脑端会弹窗确认。';
    body.appendChild(p);

    mk('查看记忆', () => { closeSheet(); showMemory(); });
    mk('查看社交状态', () => { closeSheet(); showSocial(); });

    mk('申请修改记忆', async () => {
      try {
        await api('/api/admin/request', { body: { scopes: ['memory:write'] } });
        alert('已提交申请，请到电脑上确认。批准后就能在记忆里标「别忘」了。');
      } catch (e) {
        alert('申请失败：' + (e.message || e));
      }
    });

    mk('申请管理员权限', async () => {
      try {
        await api('/api/admin/request', { body: { scopes: ['admin'] } });
        alert('已提交申请，请到电脑上确认。');
      } catch (e) {
        alert('申请失败：' + (e.message || e));
      }
    });

    mk('查看已授权设备', async () => {
      try {
        const j = await api('/api/devices');
        const list = (j && j.data) || [];
        body.querySelectorAll('.dev').forEach((x) => x.remove());
        for (const d of list) {
          const el = document.createElement('div');
          el.className = 'dev';
          const left = document.createElement('div');
          const n = document.createElement('div'); n.className = 'dev-name'; n.textContent = d.label;
          const s = document.createElement('div'); s.className = 'dev-sub';
          s.textContent = (d.revokedAt ? '已撤销 · ' : '') + (d.scopes || []).join(', ');
          left.append(n, s);
          el.appendChild(left);
          body.appendChild(el);
        }
      } catch (e) {
        alert('需要管理员权限：' + (e.message || e));
      }
    });

    mk('退出这台设备', () => {
      localStorage.removeItem(LS_DEVICE);
      state.deviceToken = '';
      state.sessionToken = '';
      showGate('已退出。想再连需要重新输入配对码。');
      closeSheet();
    });
  });
}

// ── 启动 ───────────────────────────────────────────────
async function boot() {
  state.tier = detectTier();
  document.documentElement.dataset.tier = state.tier;

  $('#pair-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = ($('#pair-code').value || '').trim();
    if (code.length !== 6) { $('#gate-err').textContent = '请输入 6 位配对码'; return; }
    $('#pair-btn').disabled = true;
    $('#gate-err').textContent = '';
    try {
      const j = await api('/api/pair', { body: { code, label: deviceLabel() } });
      localStorage.setItem(LS_DEVICE, j.deviceToken);
      state.deviceToken = j.deviceToken;
      const ok = await openSession();
      if (!ok) throw new Error('配对成功但换会话失败');
      await enterApp();
    } catch (err) {
      const map = {
        code_wrong: '配对码不对',
        code_expired: '配对码已过期，请在电脑上重新生成',
        code_locked: '错误次数太多，配对码已作废，请重新生成',
        no_code: '电脑上没有待用的配对码',
        rate_limited: '尝试太频繁，等一会儿再试',
      };
      $('#gate-err').textContent = map[err.message] || ('连接失败：' + (err.message || err));
    } finally {
      $('#pair-btn').disabled = false;
    }
  });

  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('#input');
    const v = inp.value;
    inp.value = '';
    inp.style.height = 'auto';
    send(v);
  });
  $('#input').addEventListener('input', (e) => {
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(120, el.scrollHeight) + 'px';
  });
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#chat-form').requestSubmit();
    }
  });
  // 语音：按住说话（pointer 事件同时覆盖鼠标与触屏）
  const mic = $('#mic');
  mic.addEventListener('pointerdown', (e) => { e.preventDefault(); startRec(); });
  mic.addEventListener('pointerup', (e) => { e.preventDefault(); stopRec(); });
  mic.addEventListener('pointercancel', () => { stopRec(); });
  mic.addEventListener('pointerleave', () => { if (recorder) stopRec(); });

  const vb = $('#btn-voice');
  vb.addEventListener('click', () => {
    state.voiceReply = !state.voiceReply;
    vb.classList.toggle('on', state.voiceReply);
    vb.textContent = state.voiceReply ? '朗读' : '静音';
  });

  $('#btn-status').addEventListener('click', showStatus);
  $('#btn-more').addEventListener('click', showMore);
  $('#sheet-close').addEventListener('click', closeSheet);
  $('#sheet').addEventListener('click', (e) => { if (e.target === $('#sheet')) closeSheet(); });

  if (await openSession()) await enterApp();
  else showGate('');
}

async function enterApp() {
  showApp();
  try {
    const j = await api('/api/characters');
    state.characters = (j && j.data) || [];
  } catch (e) {
    state.characters = [];
  }
  if (!state.characters.length) state.characters = [{ id: '0', name: '冰糖', emoji: '🍬' }, { id: '1', name: '小橘子', emoji: '🍊' }];
  const firstUsable = state.characters.find((x) => x.canChat !== false) || state.characters[0];
  state.current = String(firstUsable.id);
  renderChars();
  connectWs();
  $('#log').textContent = '';
  addMsg('sys', '已连接 · ' + (state.tier === 'eco' ? '省电模式' : state.tier === 'balanced' ? '平衡模式' : '精致模式'));
}

function deviceLabel() {
  const ua = navigator.userAgent || '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android 手机';
  if (/Macintosh/.test(ua)) return 'Mac 浏览器';
  if (/Windows/.test(ua)) return 'Windows 浏览器';
  return '浏览器';
}

boot();
