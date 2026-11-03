/**
 * SoulWeave S3-19：Edge TTS（微软 Edge 朗读接口，非官方）
 *
 * 协议：wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1
 * 流程：
 *   1) 连接时带 TrustedClientToken 与 ConnectionId
 *   2) 先发 speech.config（JSON，声明输出格式）
 *   3) 再发 ssml 帧
 *   4) 接收二进制帧：前 2 字节是大端头长度，头文本里 Path:audio，其后是音频
 *
 * 【重要限制】微软在 2024 年后加入了 Sec-MS-GEC 时效性签名校验，
 * 仅靠 TrustedClientToken 可能被 403 拒绝。这里实现了基础流程，
 * 若被拒绝会明确报错而不是静默失败。
 * 该接口属逆向使用，无官方 SLA，稳定性无保证。
 */

import type { OnlineResult } from './voice-online-volc.js';

export const EDGE_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓（女，通用）' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊（女，活泼）' },
  { id: 'zh-CN-YunxiNeural', label: '云希（男）' },
  { id: 'zh-CN-YunjianNeural', label: '云健（男）' },
];

const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

/** 生成连接 URL（导出以便单测） */
export function buildEdgeUrl(connectionId: string, host?: string): string {
  const h = host || 'speech.platform.bing.com';
  return 'wss://' + h + '/consumer/speech/synthesize/readaloud/edge/v1' +
    '?TrustedClientToken=' + TRUSTED_TOKEN + '&ConnectionId=' + connectionId;
}

/** 生成 speech.config 帧（导出以便单测） */
export function buildEdgeConfig(): string {
  const ts = new Date().toISOString();
  const json = JSON.stringify({
    context: {
      synthesis: {
        audio: {
          metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
          outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        },
      },
    },
  });
  return 'X-Timestamp:' + ts + '\\r\\n' + 'Content-Type:application/json; charset=utf-8\\r\\n' + 'Path:speech.config\\r\\n\\r\\n' + json;
}

/** 生成 ssml 帧（导出以便单测） */
export function buildEdgeSsmlFrame(requestId: string, text: string, voice = 'zh-CN-XiaoxiaoNeural', rate = '+0%'): string {
  const ts = new Date().toISOString();
  const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">' +
    '<voice name="' + esc(voice) + '"><prosody rate="' + esc(rate) + '" pitch="+0Hz">' +
    esc(text) + '</prosody></voice></speak>';
  return 'X-RequestId:' + requestId + '\\r\\n' + 'Content-Type:application/ssml+xml\\r\\n' +
    'X-Timestamp:' + ts + '\\r\\n' + 'Path:ssml\\r\\n\\r\\n' + ssml;
}

export async function synthesizeEdge(o: { text: string; voice?: string; rate?: number; timeoutMs?: number; host?: string }): Promise<OnlineResult> {
  const t0 = Date.now();
  const text = String(o.text || '').trim();
  if (!text) return { ok: false, error: '文本为空' };
  if (text.length > 2000) return { ok: false, error: '单次上限 2000 字' };

  const connId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
  const reqId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())).replace(/-/g, '');
  const ratePct = Math.round(((o.rate ?? 1.0) - 1) * 100);
  const rateStr = (ratePct >= 0 ? '+' : '') + ratePct + '%';
  const url = buildEdgeUrl(connId, o.host);

  return new Promise<OnlineResult>((resolve) => {
    let done = false;
    const parts: Buffer[] = [];
    const finish = (r: OnlineResult) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch (e) { /* ignore */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: '超时', ms: Date.now() - t0 }), o.timeoutMs ?? 30000);
    let ws: any;
    try { ws = new (globalThis as any).WebSocket(url); }
    catch (e) { clearTimeout(timer); resolve({ ok: false, error: 'WebSocket 创建失败: ' + String(e).slice(0, 120) }); return; }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      try {
        ws.send(buildEdgeConfig());
        ws.send(buildEdgeSsmlFrame(reqId, text, o.voice || 'zh-CN-XiaoxiaoNeural', rateStr));
      } catch (e) { finish({ ok: false, error: String(e).slice(0, 120) }); }
    };
    ws.onmessage = (ev: any) => {
      if (typeof ev.data === 'string') {
        // 文本帧：可能含 turn.end
        if (ev.data.indexOf('Path:turn.end') >= 0) {
          clearTimeout(timer);
          const buf = Buffer.concat(parts);
          finish({ ok: buf.length > 0, base64: buf.toString('base64'), bytes: buf.length, ms: Date.now() - t0, contentType: 'audio/mpeg', error: buf.length ? undefined : '未收到音频' });
        }
        return;
      }
      const buf = Buffer.from(ev.data);
      if (buf.length < 2) return;
      const headLen = buf.readUInt16BE(0);
      const head = buf.slice(2, 2 + headLen).toString('utf8');
      if (head.indexOf('Path:audio') >= 0) parts.push(buf.slice(2 + headLen));
    };
    ws.onerror = () => { clearTimeout(timer); finish({ ok: false, error: 'WebSocket 错误（Edge 可能因 Sec-MS-GEC 校验拒绝，属已知限制）', ms: Date.now() - t0 }); };
    ws.onclose = () => { clearTimeout(timer); const buf = Buffer.concat(parts); if (!done) finish({ ok: buf.length > 0, base64: buf.toString('base64'), bytes: buf.length, ms: Date.now() - t0, contentType: 'audio/mpeg', error: buf.length ? undefined : '连接关闭且无音频' }); };
  });
}
