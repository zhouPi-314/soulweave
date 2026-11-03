/*
 * SoulWeave S7：大厂 ASR 签名算法
 *
 * 依据：用户决策「第二层：协议不兼容的大厂（需单独适配）」
 *
 * 【为什么签名要单独一个文件】
 * 腾讯 TC3、阿里 HMAC、讯飞 HMAC 三家的签名算法**完全不同**，
 * 而且都是「算错一个字节就 401」的类型。
 * 抽成纯函数才能用固定测试向量验证 —— 否则只能靠真机撞运气。
 *
 * 【这些算法从哪来】
 * 全部来自各家官方文档的公开算法，不是逆向。
 */

import crypto from 'node:crypto';

// ─── 腾讯云 TC3-HMAC-SHA256 ─────────────────────────

export interface TencentSignInput {
  secretId: string;
  secretKey: string;
  /** 服务名，ASR 用 'asr' */
  service: string;
  /** 动作名，如 'CreateRecTask' */
  action: string;
  /** 接口版本，ASR 用 '2019-06-14' */
  version: string;
  /** 地域，如 'ap-shanghai' */
  region: string;
  /** 请求体 JSON 字符串 */
  payload: string;
  /** 时间戳（秒） */
  timestamp: number;
}

export interface TencentSignResult {
  authorization: string;
  timestamp: number;
  /** 便于测试断言 */
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

function sha256Hex(s: string | Buffer): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function hmac(key: Buffer | string, msg: string): Buffer {
  return crypto.createHmac('sha256', key).update(msg).digest();
}

/**
 * 腾讯云 TC3-HMAC-SHA256 签名。
 *
 * 步骤（官方文档）：
 *   1. 拼 CanonicalRequest
 *   2. 拼 StringToSign
 *   3. 逐层派生签名密钥：SecretDate → SecretService → SecretSigning
 *   4. 最终签名 = HMAC(SecretSigning, StringToSign)
 */
export function signTencent(i: TencentSignInput): TencentSignResult {
  const ts = Math.floor(Number(i.timestamp) || 0);
  const date = new Date(ts * 1000).toISOString().slice(0, 10);

  // 1. CanonicalRequest
  const httpMethod = 'POST';
  const canonicalUri = '/';
  const canonicalQuery = '';
  const canonicalHeaders = 'content-type:application/json; charset=utf-8\nhost:asr.tencentcloudapi.com\n';
  const signedHeaders = 'content-type;host';
  const hashedPayload = sha256Hex(i.payload || '');
  const canonicalRequest = [
    httpMethod, canonicalUri, canonicalQuery,
    canonicalHeaders, signedHeaders, hashedPayload,
  ].join('\n');

  // 2. StringToSign
  const credentialScope = date + '/' + i.service + '/tc3_request';
  const stringToSign = [
    'TC3-HMAC-SHA256', String(ts), credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  // 3. 派生密钥
  const secretDate = hmac('TC3' + i.secretKey, date);
  const secretService = hmac(secretDate, i.service);
  const secretSigning = hmac(secretService, 'tc3_request');

  // 4. 最终签名
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign).digest('hex');

  const authorization =
    'TC3-HMAC-SHA256 Credential=' + i.secretId + '/' + credentialScope + ', ' +
    'SignedHeaders=' + signedHeaders + ', ' +
    'Signature=' + signature;

  return { authorization, timestamp: ts, canonicalRequest, stringToSign, signature };
}

/** 腾讯 ASR 请求体（录音文件识别·极速版） */
export function buildTencentPayload(o: {
  engine: string;
  channelNum?: number;
  resTextFormat?: number;
  sourceType?: number;
  data: string;
  dataLen: number;
  hotwordList?: string;
}): string {
  return JSON.stringify({
    EngineModelType: String(o.engine || '16k_zh'),
    ChannelNum: Number(o.channelNum) || 1,
    ResTextFormat: Number(o.resTextFormat) || 0,
    SourceType: Number(o.sourceType) || 1,
    Data: o.data,
    DataLen: Number(o.dataLen) || 0,
    ...(o.hotwordList ? { HotwordList: o.hotwordList } : {}),
  });
}

// ─── 阿里云 NLS ─────────────────────────────────────

export interface AliyunSignInput {
  accessKeyId: string;
  accessKeySecret: string;
  /** 请求方法 */
  method: string;
  /** 参数（含公共参数） */
  params: Record<string, string>;
}

/**
 * 阿里云 RPC 签名（HMAC-SHA1）。
 *
 * 步骤：
 *   1. 参数按 key 字典序排列
 *   2. 每个 key/value 做 RFC3986 编码
 *   3. 拼成 key=value&key=value
 *   4. StringToSign = METHOD + '&' + encode('/') + '&' + encode(canonicalized)
 *   5. 签名 = Base64(HMAC-SHA1(AccessKeySecret + '&', StringToSign))
 */
export function percentEncode(s: string): string {
  return encodeURIComponent(String(s))
    .replace(/\!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

export function signAliyun(i: AliyunSignInput): { signature: string; stringToSign: string; canonicalized: string } {
  const keys = Object.keys(i.params || {}).sort();
  const canonicalized = keys
    .map((k) => percentEncode(k) + '=' + percentEncode(String(i.params[k])))
    .join('&');
  const stringToSign = String(i.method || 'POST').toUpperCase() + '&' +
    percentEncode('/') + '&' + percentEncode(canonicalized);
  const signature = crypto.createHmac('sha1', i.accessKeySecret + '&')
    .update(stringToSign).digest('base64');
  return { signature, stringToSign, canonicalized };
}

/**
 * 阿里云公共参数。
 *
 * 注意：不同产品的 version 不同，录音识别是 2019-08-13。
 */
export function buildAliyunParams(o: {
  action: string;
  version?: string;
  regionId?: string;
  accessKeyId: string;
  extra?: Record<string, string>;
  nonce?: string;
  timestamp?: string;
}): Record<string, string> {
  return {
    AccessKeyId: o.accessKeyId,
    Action: o.action,
    Format: 'JSON',
    RegionId: o.regionId || 'cn-shanghai',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: o.nonce || crypto.randomBytes(16).toString('hex'),
    SignatureVersion: '1.0',
    Timestamp: o.timestamp || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: o.version || '2019-08-13',
    ...(o.extra || {}),
  };
}

// ─── 讯飞 ───────────────────────────────────────────

export interface XfyunSignInput {
  apiKey: string;
  apiSecret: string;
  /** 请求路径，如 '/v2/upload' */
  path: string;
  /** 请求方法，通常是 POST */
  method?: string;
  /** 日期 RFC1123（GMT），可注入便于测试 */
  date?: string;
  /** 主机 */
  host?: string;
}

/**
 * 讯飞 WebAPI 签名。
 *
 * 步骤：
 *   1. signature_origin = 'host: xxx\ndate: xxx\n' + METHOD + ' ' + path + ' HTTP/1.1'
 *   2. signature_sha = Base64(HMAC-SHA256(apiSecret, signature_origin))
 *   3. authorization_origin = 'api_key="...", algorithm="hmac-sha256", headers="host date request-line", signature="..."'
 *   4. authorization = Base64(authorization_origin)
 */
export function signXfyun(i: XfyunSignInput): { authorization: string; date: string; host: string; signatureOrigin: string } {
  const host = i.host || 'raasr.xfyun.cn';
  const date = i.date || new Date().toUTCString();
  const method = String(i.method || 'POST').toUpperCase();
  const signatureOrigin = 'host: ' + host + '\ndate: ' + date + '\n' + method + ' ' + i.path + ' HTTP/1.1';
  const signatureSha = crypto.createHmac('sha256', i.apiSecret).update(signatureOrigin).digest('base64');
  const authorizationOrigin =
    'api_key="' + i.apiKey + '", algorithm="hmac-sha256", ' +
    'headers="host date request-line", signature="' + signatureSha + '"';
  const authorization = Buffer.from(authorizationOrigin, 'utf8').toString('base64');
  return { authorization, date, host, signatureOrigin };
}

// ─── 通用小工具 ─────────────────────────────────────

/** 从各家的响应里抠出转写文本（兼容常见形状） */
export function extractVendorText(vendor: string, body: any): string {
  if (!body) return '';
  // 腾讯：Data.Result（JSON 字符串）里 result[].text
  if (vendor === 'tencent') {
    const d = body.Response || body;
    if (d && d.Data && d.Data.Result) {
      try {
        const r = typeof d.Data.Result === 'string' ? JSON.parse(d.Data.Result) : d.Data.Result;
        if (Array.isArray(r)) return r.map((x: any) => String(x.text || '')).join('').trim();
      } catch (e) { return String(d.Data.Result).trim(); }
    }
    return '';
  }
  // 阿里：result 或 sentences
  if (vendor === 'aliyun') {
    if (body.result) return String(body.result).trim();
    if (Array.isArray(body.sentences)) return body.sentences.map((s: any) => String(s.text || '')).join('').trim();
    return '';
  }
  // 讯飞：data.orderResult（JSON 字符串）里 lattice
  if (vendor === 'xfyun') {
    const ord = body.data && body.data.orderResult;
    if (ord) {
      try {
        const r = typeof ord === 'string' ? JSON.parse(ord) : ord;
        const lat = r && r.lattice;
        if (Array.isArray(lat)) {
          return lat.map((x: any) => String((x.json_1best && x.json_1best.st && x.json_1best.st.rt) || '')).join('').trim();
        }
      } catch (e) { /* ignore */ }
    }
    return '';
  }
  // ElevenLabs / Deepgram / Gladia
  if (typeof body.text === 'string') return body.text.trim();
  if (body.result && typeof body.result.transcript === 'string') return body.result.transcript.trim();
  if (body.result && body.result.transcription && typeof body.result.transcription.full_transcript === 'string') {
    return body.result.transcription.full_transcript.trim();
  }
  if (body.results && body.results.channels && body.results.channels[0]) {
    const alt = body.results.channels[0].alternatives && body.results.channels[0].alternatives[0];
    if (alt && typeof alt.transcript === 'string') return alt.transcript.trim();
  }
  return '';
}

/** 各家的「任务完成」判定 */
export function isVendorTaskDone(vendor: string, body: any): boolean {
  if (vendor === 'tencent') {
    const d = body && (body.Response || body);
    if (!d) return false;
    if (d.Error) return false;
    return !!(d.Data && d.Data.Status === 2);
  }
  if (vendor === 'xfyun') {
    return !!(body && body.data && String(body.data.status) === '9');
  }
  if (vendor === 'gladia') {
    return !!(body && body.status === 'done');
  }
  return true;
}