/**
 * SoulWeave S3-19：腾讯云语音合成客户端
 *
 * 协议：POST https://tts.tencentcloudapi.com
 *   签名 TC3-HMAC-SHA256（腾讯云 API 3.0 通用签名）
 *   Body { Text, SessionId, VoiceType, Codec, Speed }
 *   返回 { Response: { Audio: "<base64>" } }
 *
 * 签名算法：
 *   CanonicalRequest = POST\\n/\\n\\ncontent-type:application/json; charset=utf-8\\nhost:...\\n\\ncontent-type;host\\n<sha256(body)>
 *   StringToSign     = TC3-HMAC-SHA256\\n<ts>\\n<date>/tts/tc3_request\\n<sha256(CanonicalRequest)>
 *   SecretSigning    = HMAC(HMAC(HMAC("TC3"+SecretKey, date), service), "tc3_request")
 *   Signature        = HexHMAC(SecretSigning, StringToSign)
 */

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { OnlineResult } from './voice-online-volc.js';

export interface TencentOptions {
  secretId: string;
  secretKey: string;
  text: string;
  /** 音色 ID，默认 101001（智瑜，女） */
  voiceType?: number;
  /** 语速 -2~6，默认 0 */
  speed?: number;
  codec?: 'mp3' | 'wav' | 'pcm';
  region?: string;
  timeoutMs?: number;
  endpointHost?: string;
  endpointProtocol?: 'http:' | 'https:';
  endpointPort?: number;
  /** 固定时间戳（仅测试用，保证签名可复现） */
  fixedTimestamp?: number;
}

export const TENCENT_ZH_VOICES = [
  { id: '101001', label: '智瑜（女，标准）' },
  { id: '101002', label: '智聆（女，通用）' },
  { id: '101003', label: '智美（女，客服）' },
  { id: '101010', label: '智华（男）' },
];

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, msg: string): Buffer {
  return crypto.createHmac('sha256', key).update(msg, 'utf8').digest();
}

/** 生成 TC3-HMAC-SHA256 授权头与时间戳（导出以便单测） */
export function signTencent(o: {
  secretId: string; secretKey: string; host: string; payload: string;
  timestamp: number; service?: string; action?: string; version?: string; region?: string;
}): { authorization: string; timestamp: number; contentType: string } {
  const service = o.service || 'tts';
  const action = o.action || 'TextToVoice';
  const version = o.version || '2019-08-23';
  const region = o.region || 'ap-guangzhou';
  const ts = o.timestamp;
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  const contentType = 'application/json; charset=utf-8';

  const canonicalHeaders = 'content-type:' + contentType + '\\n' + 'host:' + o.host + '\\n';
  const signedHeaders = 'content-type;host';
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256Hex(o.payload)].join('\\n');
  const credentialScope = date + '/' + service + '/tc3_request';
  const stringToSign = ['TC3-HMAC-SHA256', String(ts), credentialScope, sha256Hex(canonicalRequest)].join('\\n');
  const kDate = hmac('TC3' + o.secretKey, date);
  const kService = hmac(kDate, service);
  const kSigning = hmac(kService, 'tc3_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  const authorization = 'TC3-HMAC-SHA256 Credential=' + o.secretId + '/' + credentialScope +
    ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
  return { authorization, timestamp: ts, contentType };
}

export async function synthesizeTencent(o: TencentOptions): Promise<OnlineResult> {
  const t0 = Date.now();
  const text = String(o.text || '').trim();
  if (!text) return { ok: false, error: '文本为空' };
  if (text.length > 150) return { ok: false, error: '腾讯云单次上限 150 字，请分段' };
  if (!o.secretId || !o.secretKey) return { ok: false, error: '未配置 SecretId 或 SecretKey' };

  const host = o.endpointHost || 'tts.tencentcloudapi.com';
  const protocol = o.endpointProtocol || 'https:';
  const port = o.endpointPort || (protocol === 'https:' ? 443 : 80);
  const payload = JSON.stringify({
    Text: text,
    SessionId: 'sw-' + Date.now(),
    VoiceType: o.voiceType || 101001,
    Codec: o.codec || 'mp3',
    Speed: typeof o.speed === 'number' ? o.speed : 0,
  });
  const ts = o.fixedTimestamp || Math.floor(Date.now() / 1000);
  const { authorization, contentType } = signTencent({
    secretId: o.secretId, secretKey: o.secretKey, host, payload, timestamp: ts, region: o.region,
  });

  return new Promise<OnlineResult>((resolve) => {
    const mod = protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol, hostname: host, port, path: '/', method: 'POST', timeout: o.timeoutMs ?? 30000,
      headers: {
        Authorization: authorization,
        'Content-Type': contentType,
        Host: host,
        'X-TC-Action': 'TextToVoice',
        'X-TC-Version': '2019-08-23',
        'X-TC-Timestamp': String(ts),
        'X-TC-Region': o.region || 'ap-guangzhou',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      let n = 0;
      res.on('data', (c: Buffer) => { n += c.length; if (n > 16 * 1024 * 1024) { try { req.destroy(); } catch (e) { /* ignore */ } resolve({ ok: false, error: '响应过大' }); return; } chunks.push(c); });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let j: any = null;
        try { j = JSON.parse(raw); } catch (e) { resolve({ ok: false, error: '响应不是 JSON：' + raw.slice(0, 160) }); return; }
        const r = j.Response || {};
        if (r.Error) { resolve({ ok: false, error: r.Error.Code + ': ' + r.Error.Message, ms: Date.now() - t0 }); return; }
        if (!r.Audio) { resolve({ ok: false, error: '响应缺少 Audio 字段', ms: Date.now() - t0 }); return; }
        resolve({ ok: true, base64: r.Audio, bytes: Buffer.from(r.Audio, 'base64').length, ms: Date.now() - t0, contentType: 'audio/' + (o.codec || 'mp3') });
      });
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } resolve({ ok: false, error: '超时', ms: Date.now() - t0 }); });
    req.on('error', (e) => resolve({ ok: false, error: String(e).slice(0, 200), ms: Date.now() - t0 }));
    req.write(payload);
    req.end();
  });
}
