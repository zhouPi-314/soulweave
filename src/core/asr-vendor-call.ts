/*
 * SoulWeave S7：大厂 ASR 实际调用
 *
 * 签名算法在 asr-vendors.ts（纯函数、可测），这里负责「发请求 + 轮询 + 取结果」。
 *
 * 【异步任务模式】
 * 腾讯 / 讯飞 / Gladia 都是「提交任务 → 拿 taskId → 轮询状态 → 取结果」，
 * 不是同步返回。所以这里统一做「提交 + 轮询」两步。
 */

import {
  signTencent, buildTencentPayload,
  signAliyun, buildAliyunParams, percentEncode,
  signXfyun, extractVendorText, isVendorTaskDone,
} from './asr-vendors.js';

export interface VendorResult {
  ok: boolean;
  text?: string;
  error?: string;
  code?: string;
  ms?: number;
  /** 异步任务 id（排障用） */
  taskId?: string;
}

export interface VendorDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** 轮询间隔（毫秒） */
  pollMs?: number;
  /** 最多轮询几次 */
  maxPolls?: number;
  /** 测试用：注入 sleep */
  sleep?: (ms: number) => Promise<void>;
}

function getFetch(d?: VendorDeps): typeof fetch { return (d && d.fetch) || fetch; }
function getNow(d?: VendorDeps): () => number { return (d && d.now) || (() => Date.now()); }
function getSleep(d?: VendorDeps): (ms: number) => Promise<void> {
  return (d && d.sleep) || ((ms: number) => new Promise((r) => setTimeout(r, ms)));
}

function explainHttp(status: number, body: any): { code: string; error: string } {
  const raw = typeof body === 'string' ? body : JSON.stringify(body || {});
  const msg = String(raw || '').slice(0, 240);
  if (status === 401 || status === 403) return { code: 'NO_CONFIG', error: '凭据无效或无权限（HTTP ' + status + '）：' + msg };
  if (status === 429) return { code: 'QUOTA', error: '额度或频率超限：' + msg };
  if (status >= 500) return { code: 'NETWORK', error: '服务端错误（HTTP ' + status + '）：' + msg };
  return { code: 'NETWORK', error: 'HTTP ' + status + '：' + msg };
}

// ─── 腾讯云 ─────────────────────────────────────────

export interface TencentCreds { secretId: string; secretKey: string; }

/** 提交录音识别任务，返回 taskId */
export async function tencentSubmit(
  creds: TencentCreds,
  audioBase64: string,
  audioBytes: number,
  opts: { engine?: string } = {},
  deps: VendorDeps = {},
): Promise<{ ok: boolean; taskId?: number; error?: string; code?: string }> {
  const f = getFetch(deps);
  const now = getNow(deps);
  const ts = Math.floor(now() / 1000);
  const payload = buildTencentPayload({
    engine: opts.engine || '16k_zh',
    data: audioBase64,
    dataLen: audioBytes,
  });
  const sign = signTencent({
    secretId: creds.secretId, secretKey: creds.secretKey,
    service: 'asr', action: 'CreateRecTask', version: '2019-06-14',
    region: 'ap-shanghai', payload, timestamp: ts,
  });
  try {
    const r = await f('https://asr.tencentcloudapi.com/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Host: 'asr.tencentcloudapi.com',
        Authorization: sign.authorization,
        'X-TC-Action': 'CreateRecTask',
        'X-TC-Version': '2019-06-14',
        'X-TC-Timestamp': String(ts),
        'X-TC-Region': 'ap-shanghai',
      },
      body: payload,
    } as any);
    const text = await r.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch (e) { body = text; }
    if (!r.ok) { const e = explainHttp(r.status, body); return { ok: false, ...e }; }
    const d = body && body.Response;
    if (d && d.Error) return { ok: false, code: 'NETWORK', error: d.Error.Message || d.Error.Code };
    const id = d && d.Data && d.Data.TaskId;
    if (!id) return { ok: false, code: 'NETWORK', error: '没有返回 TaskId' };
    return { ok: true, taskId: Number(id) };
  } catch (e: any) {
    return { ok: false, code: 'NETWORK', error: String(e && e.message ? e.message : e).slice(0, 200) };
  }
}

/** 查询任务结果 */
export async function tencentQuery(
  creds: TencentCreds,
  taskId: number,
  deps: VendorDeps = {},
): Promise<{ ok: boolean; done?: boolean; text?: string; error?: string; code?: string }> {
  const f = getFetch(deps);
  const ts = Math.floor(getNow(deps)() / 1000);
  const payload = JSON.stringify({ TaskId: taskId });
  const sign = signTencent({
    secretId: creds.secretId, secretKey: creds.secretKey,
    service: 'asr', action: 'DescribeTaskStatus', version: '2019-06-14',
    region: 'ap-shanghai', payload, timestamp: ts,
  });
  try {
    const r = await f('https://asr.tencentcloudapi.com/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Host: 'asr.tencentcloudapi.com',
        Authorization: sign.authorization,
        'X-TC-Action': 'DescribeTaskStatus',
        'X-TC-Version': '2019-06-14',
        'X-TC-Timestamp': String(ts),
        'X-TC-Region': 'ap-shanghai',
      },
      body: payload,
    } as any);
    const text = await r.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch (e) { body = text; }
    if (!r.ok) { const e = explainHttp(r.status, body); return { ok: false, ...e }; }
    const d = body && body.Response;
    if (d && d.Error) return { ok: false, code: 'NETWORK', error: d.Error.Message || d.Error.Code };
    const done = isVendorTaskDone('tencent', body);
    return { ok: true, done, text: done ? extractVendorText('tencent', body) : undefined };
  } catch (e: any) {
    return { ok: false, code: 'NETWORK', error: String(e && e.message ? e.message : e).slice(0, 200) };
  }
}

/** 提交 + 轮询，一步到位 */
export async function transcribeTencent(
  creds: TencentCreds,
  audio: Uint8Array,
  opts: { engine?: string } = {},
  deps: VendorDeps = {},
): Promise<VendorResult> {
  const t0 = getNow(deps)();
  const b64 = Buffer.from(audio).toString('base64');
  const sub = await tencentSubmit(creds, b64, audio.length, opts, deps);
  if (!sub.ok) return { ok: false, code: sub.code, error: sub.error, ms: getNow(deps)() - t0 };

  const sleep = getSleep(deps);
  const pollMs = (deps.pollMs != null ? deps.pollMs : 2000);
  const maxPolls = deps.maxPolls != null ? deps.maxPolls : 60;
  for (let i = 0; i < maxPolls; i++) {
    await sleep(pollMs);
    const q = await tencentQuery(creds, sub.taskId!, deps);
    if (!q.ok) return { ok: false, code: q.code, error: q.error, taskId: String(sub.taskId), ms: getNow(deps)() - t0 };
    if (q.done) return { ok: true, text: q.text, taskId: String(sub.taskId), ms: getNow(deps)() - t0 };
  }
  return { ok: false, code: 'TIMEOUT', error: '任务超时（轮询 ' + maxPolls + ' 次仍未完成）', taskId: String(sub.taskId), ms: getNow(deps)() - t0 };
}

// ─── 阿里云 ─────────────────────────────────────────

export interface AliyunCreds { accessKeyId: string; accessKeySecret: string; appKey: string; }

/** 阿里云 NLS 录音识别：提交任务 */
export async function aliyunSubmit(
  creds: AliyunCreds,
  fileUrl: string,
  deps: VendorDeps = {},
): Promise<{ ok: boolean; taskId?: string; error?: string; code?: string }> {
  const f = getFetch(deps);
  const params = buildAliyunParams({
    action: 'SubmitTask',
    version: '2019-08-13',
    accessKeyId: creds.accessKeyId,
    extra: {
      AppKey: creds.appKey,
      FileLink: fileUrl,
      Version: '4.0',
      EnableWords: 'false',
      EnableInverseTextNormalization: 'true',
    },
  });
  const sign = signAliyun({ accessKeyId: creds.accessKeyId, accessKeySecret: creds.accessKeySecret, method: 'POST', params });
  const all: Record<string, string> = { ...params, Signature: sign.signature };
  const body = Object.keys(all).map((k) => percentEncode(k) + '=' + percentEncode(all[k])).join('&');
  try {
    const r = await f('https://nls-gateway-cn-shanghai.aliyuncs.com/stream/v1/asr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    } as any);
    const text = await r.text();
    let j: any = null;
    try { j = JSON.parse(text); } catch (e) { j = text; }
    if (!r.ok) { const e = explainHttp(r.status, j); return { ok: false, ...e }; }
    const id = j && (j.TaskId || j.taskId || (j.data && j.data.TaskId));
    if (!id) return { ok: false, code: 'NETWORK', error: '没有返回 TaskId：' + text.slice(0, 160) };
    return { ok: true, taskId: String(id) };
  } catch (e: any) {
    return { ok: false, code: 'NETWORK', error: String(e && e.message ? e.message : e).slice(0, 200) };
  }
}

// ─── 讯飞 ───────────────────────────────────────────

export interface XfyunCreds { appId: string; apiKey: string; apiSecret: string; }

/** 讯飞录音文件转写：提交 */
export async function xfyunSubmit(
  creds: XfyunCreds,
  audioBase64: string,
  fileName: string,
  opts: { language?: string } = {},
  deps: VendorDeps = {},
): Promise<{ ok: boolean; taskId?: string; error?: string; code?: string }> {
  const f = getFetch(deps);
  const host = 'raasr.xfyun.cn';
  const path = '/v2/upload';
  const sign = signXfyun({ apiKey: creds.apiKey, apiSecret: creds.apiSecret, path, method: 'POST', host });
  const params = {
    app_id: creds.appId,
    signa: sign.authorization,
    ts: String(Math.floor(getNow(deps)() / 1000)),
    file_name: fileName,
    file_size: String(Buffer.from(audioBase64, 'base64').length),
    language: String(opts.language || 'zh_cn'),
    duration: '20000',
  };
  const body = Object.keys(params).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent((params as any)[k])).join('&');
  try {
    const r = await f('https://' + host + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: sign.authorization,
        Date: sign.date,
        Host: host,
      },
      body,
    } as any);
    const text = await r.text();
    let j: any = null;
    try { j = JSON.parse(text); } catch (e) { j = text; }
    if (!r.ok) { const e = explainHttp(r.status, j); return { ok: false, ...e }; }
    const id = j && (j.data || j.taskId);
    if (!id) return { ok: false, code: 'NETWORK', error: '没有返回任务 id：' + text.slice(0, 160) };
    return { ok: true, taskId: String(id) };
  } catch (e: any) {
    return { ok: false, code: 'NETWORK', error: String(e && e.message ? e.message : e).slice(0, 200) };
  }
}

// ─── 简单 REST 型（ElevenLabs / Deepgram / Gladia） ──

/** ElevenLabs Scribe：同步返回，最简单 */
export async function transcribeElevenLabs(
  apiKey: string,
  audio: Uint8Array,
  opts: { model?: string; language?: string; filename?: string } = {},
  deps: VendorDeps = {},
): Promise<VendorResult> {
  const f = getFetch(deps);
  const t0 = getNow(deps)();
  const form = new FormData();
  form.append('file', new Blob([audio as any], { type: 'audio/wav' }), opts.filename || 'audio.wav');
  form.append('model_id', opts.model || 'scribe_v2');
  if (opts.language) form.append('language_code', opts.language);
  try {
    const r = await f('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
    } as any);
    const text = await r.text();
    let j: any = null;
    try { j = JSON.parse(text); } catch (e) { j = text; }
    if (!r.ok) { const e = explainHttp(r.status, j); return { ok: false, ...e, ms: getNow(deps)() - t0 }; }
    return { ok: true, text: extractVendorText('elevenlabs', j), ms: getNow(deps)() - t0 };
  } catch (e: any) {
    return { ok: false, code: 'NETWORK', error: String(e && e.message ? e.message : e).slice(0, 200), ms: getNow(deps)() - t0 };
  }
}

/** Deepgram：同步返回 */
export async function transcribeDeepgram(
  apiKey: string,
  audio: Uint8Array,
  opts: { model?: string; language?: string } = {},
  deps: VendorDeps = {},
): Promise<VendorResult> {
  const f = getFetch(deps);
  const t0 = getNow(deps)();
  const model = opts.model || 'nova-3';
  const lang = opts.language || 'zh';
  const url = 'https://api.deepgram.com/v1/listen?model=' + encodeURIComponent(model) + '&language=' + encodeURIComponent(lang) + '&smart_format=true';
  try {
    const r = await f(url, {
      method: 'POST',
      headers: { Authorization: 'Token ' + apiKey, 'Content-Type': 'audio/wav' },
      body: audio,
    } as any);
    const text = await r.text();
    let j: any = null;
    try { j = JSON.parse(text); } catch (e) { j = text; }
    if (!r.ok) { const e = explainHttp(r.status, j); return { ok: false, ...e, ms: getNow(deps)() - t0 }; }
    return { ok: true, text: extractVendorText('deepgram', j), ms: getNow(deps)() - t0 };
  } catch (e: any) {
    return { ok: false, code: 'NETWORK', error: String(e && e.message ? e.message : e).slice(0, 200), ms: getNow(deps)() - t0 };
  }
}

/** Gladia：提交 + 轮询 */
export async function transcribeGladia(
  apiKey: string,
  audio: Uint8Array,
  opts: { language?: string; filename?: string } = {},
  deps: VendorDeps = {},
): Promise<VendorResult> {
  const f = getFetch(deps);
  const t0 = getNow(deps)();
  const form = new FormData();
  form.append('audio', new Blob([audio as any], { type: 'audio/wav' }), opts.filename || 'audio.wav');
  try {
    const up = await f('https://api.gladia.io/v2/upload', {
      method: 'POST',
      headers: { 'x-gladia-key': apiKey },
      body: form,
    } as any);
    const upText = await up.text();
    let upJ: any = null;
    try { upJ = JSON.parse(upText); } catch (e) { upJ = upText; }
    if (!up.ok) { const e = explainHttp(up.status, upJ); return { ok: false, ...e, ms: getNow(deps)() - t0 }; }
    const audioUrl = upJ && upJ.audio_url;
    if (!audioUrl) return { ok: false, code: 'NETWORK', error: '上传后没拿到 audio_url', ms: getNow(deps)() - t0 };

    const sub = await f('https://api.gladia.io/v2/transcription', {
      method: 'POST',
      headers: { 'x-gladia-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_url: audioUrl, language_config: { languages: [opts.language || 'zh'], code_switching: false } }),
    } as any);
    const subText = await sub.text();
    let subJ: any = null;
    try { subJ = JSON.parse(subText); } catch (e) { subJ = subText; }
    if (!sub.ok) { const e = explainHttp(sub.status, subJ); return { ok: false, ...e, ms: getNow(deps)() - t0 }; }
    const resultUrl = subJ && subJ.result_url;
    if (!resultUrl) return { ok: false, code: 'NETWORK', error: '提交后没拿到 result_url', ms: getNow(deps)() - t0 };

    const sleep = getSleep(deps);
    const pollMs = deps.pollMs != null ? deps.pollMs : 2000;
    const maxPolls = deps.maxPolls != null ? deps.maxPolls : 60;
    for (let i = 0; i < maxPolls; i++) {
      await sleep(pollMs);
      const q = await f(resultUrl, { headers: { 'x-gladia-key': apiKey } } as any);
      const qText = await q.text();
      let qJ: any = null;
      try { qJ = JSON.parse(qText); } catch (e) { qJ = qText; }
      if (isVendorTaskDone('gladia', qJ)) {
        return { ok: true, text: extractVendorText('gladia', qJ), ms: getNow(deps)() - t0 };
      }
    }
    return { ok: false, code: 'TIMEOUT', error: '任务超时', ms: getNow(deps)() - t0 };
  } catch (e: any) {
    return { ok: false, code: 'NETWORK', error: String(e && e.message ? e.message : e).slice(0, 200), ms: getNow(deps)() - t0 };
  }
}
/** 讯飞：提交 + 轮询（异步订单制） */
export async function transcribeXfyun(
  creds: XfyunCreds,
  audio: Uint8Array,
  fileName: string,
  opts: { language?: string } = {},
  deps: VendorDeps = {},
): Promise<VendorResult> {
  const t0 = getNow(deps)();
  const b64 = Buffer.from(audio).toString('base64');
  const sub = await xfyunSubmit(creds, b64, fileName, opts, deps);
  if (!sub.ok) return { ok: false, code: sub.code, error: sub.error, ms: getNow(deps)() - t0 };

  const f = getFetch(deps);
  const sleep = getSleep(deps);
  const pollMs = deps.pollMs != null ? deps.pollMs : 3000;
  const maxPolls = deps.maxPolls != null ? deps.maxPolls : 60;
  const host = 'raasr.xfyun.cn';
  const path = '/v2/getResult';

  for (let i = 0; i < maxPolls; i++) {
    await sleep(pollMs);
    const sign = signXfyun({ apiKey: creds.apiKey, apiSecret: creds.apiSecret, path, method: 'POST', host });
    const params = {
      app_id: creds.appId,
      signa: sign.authorization,
      ts: String(Math.floor(getNow(deps)() / 1000)),
      task_id: sub.taskId!,
    };
    const body = Object.keys(params).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent((params as any)[k])).join('&');
    try {
      const r = await f('https://' + host + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: sign.authorization,
          Date: sign.date,
          Host: host,
        },
        body,
      } as any);
      const text = await r.text();
      let j: any = null;
      try { j = JSON.parse(text); } catch (e) { j = text; }
      if (!r.ok) { const e = explainHttp(r.status, j); return { ok: false, code: e.code, error: e.error, taskId: sub.taskId, ms: getNow(deps)() - t0 }; }
      if (isVendorTaskDone('xfyun', j)) {
        return { ok: true, text: extractVendorText('xfyun', j), taskId: sub.taskId, ms: getNow(deps)() - t0 };
      }
    } catch (e: any) {
      return { ok: false, code: 'NETWORK', error: String(e && e.message ? e.message : e).slice(0, 200), taskId: sub.taskId, ms: getNow(deps)() - t0 };
    }
  }
  return { ok: false, code: 'TIMEOUT', error: '任务超时', taskId: sub.taskId, ms: getNow(deps)() - t0 };
}