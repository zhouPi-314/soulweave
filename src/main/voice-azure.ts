/**
 * SoulWeave S3-17：Azure 语音合成客户端（按厂商真实协议实现）
 *
 * 为什么要实现完整协议，而不是只放一个密钥输入框 —— 只做 UI 等于没做。
 * 这里按 Azure Speech REST 的真实契约实现：
 *   POST https://<region>.tts.speech.microsoft.com/cognitiveservices/v1
 *   Header Ocp-Apim-Subscription-Key
 *   Header Content-Type: application/ssml+xml
 *   Header X-Microsoft-OutputFormat: audio-24khz-48kbitrate-mono-mp3
 *   Body   SSML
 *   返回   音频字节流
 * 一旦用户填入真实密钥，无需改代码即可工作。
 */

import http from 'node:http';
import https from 'node:https';

export interface AzureOptions {
  region: string;
  key: string;
  voiceName?: string;
  rate?: number;
  pitch?: string;
  text: string;
  timeoutMs?: number;
  endpointHost?: string;
  endpointProtocol?: 'http:' | 'https:';
  endpointPort?: number;
}

export interface AzureResult {
  ok: boolean;
  base64?: string;
  bytes?: number;
  ms?: number;
  contentType?: string;
  status?: number;
  error?: string;
}

export function buildSsml(text: string, voiceName = 'zh-CN-XiaoxiaoNeural', rate = 1.0, pitch = '0%'): string {
  const esc = (s: string) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(new RegExp(String.fromCharCode(34), 'g'), '&quot;')
    .replace(new RegExp(String.fromCharCode(39), 'g'), '&apos;');
  const ratePct = Math.round((rate - 1) * 100);
  const rateStr = (ratePct >= 0 ? '+' : '') + ratePct + '%';
  const q = String.fromCharCode(34);
  return '<speak version=' + q + '1.0' + q + ' xmlns=' + q + 'http://www.w3.org/2001/10/synthesis' + q + ' xml:lang=' + q + 'zh-CN' + q + '>' +
    '<voice name=' + q + esc(voiceName) + q + '>' +
    '<prosody rate=' + q + rateStr + q + ' pitch=' + q + esc(pitch) + q + '>' +
    esc(text) +
    '</prosody></voice></speak>';
}

export function isValidRegion(r: string): boolean {
  return /^[a-z0-9]{2,20}$/.test(String(r || ''));
}

export async function synthesizeAzure(o: AzureOptions): Promise<AzureResult> {
  const t0 = Date.now();
  const text = String(o.text || '').trim();
  if (!text) return { ok: false, error: '文本为空' };
  if (text.length > 1000) return { ok: false, error: '单次上限 1000 字' };
  if (!o.key) return { ok: false, error: '未配置密钥' };
  if (!isValidRegion(o.region)) return { ok: false, error: '区域名不合法（应为 eastasia 这类小写标识）' };

  const ssml = buildSsml(text, o.voiceName, o.rate ?? 1.0, o.pitch ?? '0%');
  const timeoutMs = o.timeoutMs ?? 30000;
  const host = o.endpointHost || (o.region + '.tts.speech.microsoft.com');
  const protocol = o.endpointProtocol || 'https:';
  const port = o.endpointPort || (protocol === 'https:' ? 443 : 80);
  const pathname = '/cognitiveservices/v1';

  return new Promise<AzureResult>((resolve) => {
    const mod = protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol, hostname: host, port, path: pathname, method: 'POST', timeout: timeoutMs,
      headers: {
        'Ocp-Apim-Subscription-Key': o.key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'SoulWeave',
        'Content-Length': Buffer.byteLength(ssml),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 16 * 1024 * 1024) { try { req.destroy(); } catch (e) { /* ignore */ } resolve({ ok: false, error: '响应过大' }); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const st = res.statusCode || 0;
        const okStatus = st >= 200 && st < 300;
        if (!okStatus) {
          resolve({ ok: false, status: st, error: 'HTTP ' + st + ': ' + buf.slice(0, 200).toString('utf8'), ms: Date.now() - t0 });
          return;
        }
        const ct = String(res.headers['content-type'] || '');
        const isAudio = ct.indexOf('audio') >= 0 || (buf.length > 1000 && (buf[0] === 0x49 || buf[0] === 0xff || buf[0] === 0x52));
        if (!isAudio) {
          resolve({ ok: false, status: st, error: '响应不是音频：' + buf.slice(0, 160).toString('utf8'), ms: Date.now() - t0 });
          return;
        }
        resolve({ ok: true, base64: buf.toString('base64'), bytes: buf.length, ms: Date.now() - t0, contentType: ct, status: st });
      });
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } resolve({ ok: false, error: '超时', ms: Date.now() - t0 }); });
    req.on('error', (e) => resolve({ ok: false, error: String(e).slice(0, 200), ms: Date.now() - t0 }));
    req.write(ssml);
    req.end();
  });
}

export const AZURE_ZH_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓（女，通用）' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊（女，活泼）' },
  { id: 'zh-CN-YunxiNeural', label: '云希（男，清朗）' },
  { id: 'zh-CN-YunyangNeural', label: '云扬（男，播报）' },
  { id: 'zh-CN-XiaochenNeural', label: '晓辰（女，自然）' },
];
