/**
 * SoulWeave S3-19：火山引擎语音合成客户端
 *
 * 协议（官方 v1）：
 *   POST https://openspeech.bytedance.com/api/v1/tts
 *   Header  Authorization: Bearer; <token>
 *   Body    JSON { app:{appid,token,cluster}, user, audio, request }
 *   返回    JSON { code:3000, data:"<base64 音频>" }
 *
 * 注意：Authorization 头里是分号（Bearer;）而不是空格，这是火山特有的写法。
 */

import http from 'node:http';
import https from 'node:https';

export interface VolcOptions {
  appid: string;
  token: string;
  text: string;
  /** 集群，默认 volcano_tts */
  cluster?: string;
  /** 音色类型，如 zh_female_shuangkuaisisi_moon_bigtts */
  voiceType?: string;
  /** 语速 0.2~3.0，默认 1.0 */
  speedRatio?: number;
  encoding?: 'mp3' | 'wav' | 'pcm';
  timeoutMs?: number;
  /** 仅测试：覆盖端点 */
  endpointHost?: string;
  endpointProtocol?: 'http:' | 'https:';
  endpointPort?: number;
}

export interface OnlineResult {
  ok: boolean;
  base64?: string;
  bytes?: number;
  ms?: number;
  contentType?: string;
  error?: string;
}

export const VOLC_ZH_VOICES = [
  { id: 'zh_female_shuangkuaisisi_moon_bigtts', label: '爽快思思（女）' },
  { id: 'zh_female_tianmeixiaoyuan_moon_bigtts', label: '甜美小源（女）' },
  { id: 'zh_male_yangguangqingnian_moon_bigtts', label: '阳光青年（男）' },
  { id: 'zh_male_jingqiangkanye_moon_bigtts', label: '京腔侃爷（男）' },
];

/** 构造请求体（导出以便单测） */
export function buildVolcBody(o: { appid: string; token: string; text: string; cluster?: string; voiceType?: string; speedRatio?: number; encoding?: string; reqid: string }) {
  return {
    app: {
      appid: o.appid,
      token: o.token,
      cluster: o.cluster || 'volcano_tts',
    },
    user: { uid: 'soulweave' },
    audio: {
      voice_type: o.voiceType || 'zh_female_shuangkuaisisi_moon_bigtts',
      encoding: o.encoding || 'mp3',
      speed_ratio: typeof o.speedRatio === 'number' ? o.speedRatio : 1.0,
    },
    request: {
      reqid: o.reqid,
      text: o.text,
      operation: 'query',
    },
  };
}

export async function synthesizeVolc(o: VolcOptions): Promise<OnlineResult> {
  const t0 = Date.now();
  const text = String(o.text || '').trim();
  if (!text) return { ok: false, error: '文本为空' };
  if (text.length > 1000) return { ok: false, error: '单次上限 1000 字' };
  if (!o.appid || !o.token) return { ok: false, error: '未配置 AppID 或 Token' };

  const reqid = 'sw-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const body = buildVolcBody({ ...o, text, reqid, encoding: o.encoding });
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const host = o.endpointHost || 'openspeech.bytedance.com';
  const protocol = o.endpointProtocol || 'https:';
  const port = o.endpointPort || (protocol === 'https:' ? 443 : 80);

  return new Promise<OnlineResult>((resolve) => {
    const mod = protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol, hostname: host, port, path: '/api/v1/tts', method: 'POST', timeout: o.timeoutMs ?? 30000,
      headers: {
        // 火山特有：分号而非空格
        Authorization: 'Bearer; ' + o.token,
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      let n = 0;
      res.on('data', (c: Buffer) => { n += c.length; if (n > 16 * 1024 * 1024) { try { req.destroy(); } catch (e) { /* ignore */ } resolve({ ok: false, error: '响应过大' }); return; } chunks.push(c); });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let j: any = null;
        try { j = JSON.parse(raw); } catch (e) { resolve({ ok: false, error: '响应不是 JSON：' + raw.slice(0, 160) }); return; }
        if (j.code !== 3000) {
          resolve({ ok: false, error: 'code=' + j.code + ' ' + (j.message || '') + ' ' + raw.slice(0, 160), ms: Date.now() - t0 });
          return;
        }
        if (!j.data) { resolve({ ok: false, error: '响应缺少 data 字段', ms: Date.now() - t0 }); return; }
        const buf = Buffer.from(j.data, 'base64');
        resolve({ ok: true, base64: j.data, bytes: buf.length, ms: Date.now() - t0, contentType: 'audio/' + (o.encoding || 'mp3') });
      });
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } resolve({ ok: false, error: '超时', ms: Date.now() - t0 }); });
    req.on('error', (e) => resolve({ ok: false, error: String(e).slice(0, 200), ms: Date.now() - t0 }));
    req.write(payload);
    req.end();
  });
}
