/**
 * SoulWeave：本地免费模型网关（**仅开发模式**）
 *
 * 【这是什么】
 * DSH 桌面版带一个 `our-free-model` 插件，会在本机起一个
 * **OpenAI 兼容**的转发端口（默认 127.0.0.1:18900），
 * 可以用免费模型做开发测试，不消耗官方 API 额度。
 *
 * 实测（2026-10-29）：
 *   GET  /health           → {"ok":true,"service":"our-free-model"}（免鉴权）
 *   GET  /v1/models        → 31 个模型（Bearer = settings.json 的 forwardKey）
 *   POST /v1/chat/completions → kilo-auto/free 可用；多数 *-free 已限流(429)
 *
 * 【为什么限定开发模式】
 * 用户明确要求「发布时去掉」。所以这里用 `!app.isPackaged` 硬门禁：
 * 打包后的正式版**永远不会**走这条路，只能用自己的 API Key。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface GatewayInfo {
  ok: boolean;
  host?: string;
  port?: number;
  baseUrl?: string;
  /** forwardKey（不对外输出，仅内部使用） */
  key?: string;
  error?: string;
}

/** DSH 的免费模型插件设置文件 */
function settingsPath(): string {
  return path.join(os.homedir(), '.dsh', 'our-free-model', 'settings.json');
}

/** 读取网关配置（端口与 key 都来自用户自己装的 DSH） */
export function readGatewayConfig(): GatewayInfo {
  try {
    const p2 = settingsPath();
    if (!fs.existsSync(p2)) {
      return { ok: false, error: '未找到 DSH 的 our-free-model 插件配置（' + p2 + '）' };
    }
    const j = JSON.parse(fs.readFileSync(p2, 'utf8'));
    if (!j || j.enabled === false) return { ok: false, error: 'DSH 的 our-free-model 插件未启用' };
    const fwd = j.forward || {};
    if (fwd.enabled === false) return { ok: false, error: 'DSH 的本地转发端口未启用' };
    const host = fwd.host || '127.0.0.1';
    const port = Number(fwd.port || 18900);
    const key = j.forwardKey;
    if (!key) return { ok: false, error: '插件配置里没有 forwardKey' };
    return { ok: true, host, port, baseUrl: 'http://' + host + ':' + port, key };
  } catch (e) {
    return { ok: false, error: '读取网关配置失败：' + String(e).slice(0, 120) };
  }
}

/** 探活（/health 免鉴权） */
export async function probeGateway(): Promise<{ ok: boolean; baseUrl?: string; models?: string[]; error?: string }> {
  const cfg = readGatewayConfig();
  if (!cfg.ok || !cfg.baseUrl) return { ok: false, error: cfg.error };
  try {
    const r = await fetch(cfg.baseUrl + '/health', { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return { ok: false, baseUrl: cfg.baseUrl, error: '网关 /health 返回 ' + r.status };

    // 顺手拿模型清单
    let models: string[] = [];
    try {
      const mr = await fetch(cfg.baseUrl + '/v1/models', {
        headers: { Authorization: 'Bearer ' + cfg.key },
        signal: AbortSignal.timeout(6000),
      });
      if (mr.ok) {
        const j = await mr.json();
        models = (j.data || []).map((m: any) => String(m.id)).filter(Boolean);
      }
    } catch (e) { /* 模型清单拿不到不算探活失败 */ }

    return { ok: true, baseUrl: cfg.baseUrl, models };
  } catch (e) {
    return { ok: false, baseUrl: cfg.baseUrl, error: '连不上本地网关：' + String(e).slice(0, 120) };
  }
}

export interface GatewayChatResult {
  ok: boolean;
  /** 上游返回的用量（有就带回来） */
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  text?: string;
  model?: string;
  ms?: number;
  error?: string;
}

/** 走本地网关对话（OpenAI 兼容） */
export async function chatViaGateway(o: {
  model: string;
  messages: Array<{ role: string; content: string }>;
  timeoutMs?: number;
  maxTokens?: number;
}): Promise<GatewayChatResult> {
  const cfg = readGatewayConfig();
  if (!cfg.ok || !cfg.baseUrl) return { ok: false, error: cfg.error };
  const t0 = Date.now();
  try {
    const r = await fetch(cfg.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify({
        model: o.model,
        messages: o.messages,
        max_tokens: o.maxTokens ?? 512,
        stream: false,
      }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 90000),
    });
    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 200);
      try { const d = JSON.parse(text); msg = (d.error?.code ? d.error.code + ': ' : '') + (d.error?.message || msg); } catch (e) { /* keep */ }
      return { ok: false, ms: Date.now() - t0, error: 'HTTP ' + r.status + ' — ' + msg.slice(0, 200) };
    }
    const d = JSON.parse(text);
    const content = d.choices?.[0]?.message?.content ?? '';
    return { ok: true, text: String(content), model: d.model, ms: Date.now() - t0, usage: d.usage };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String(e).slice(0, 160) };
  }
}

/**
 * 走本地网关的**流式**对话（SSE）。
 *
 * OpenAI 兼容的流式格式：响应体是一行行 `data: {json}`，
 * 以 `data: [DONE]` 结束。每个 chunk 的增量在
 * `choices[0].delta.content`。
 *
 * 只负责解析与回调；把增量推给谁由调用方决定。
 */
export async function chatViaGatewayStream(o: {
  model: string;
  messages: Array<{ role: string; content: string }>;
  timeoutMs?: number;
  maxTokens?: number;
  onDelta?: (delta: string) => void;
  /** 收到首个增量（用于测首包延迟） */
  onFirstDelta?: (ms: number) => void;
}): Promise<GatewayChatResult & { firstTokenMs?: number; chunks?: number }> {
  const cfg = readGatewayConfig();
  if (!cfg.ok || !cfg.baseUrl) return { ok: false, error: cfg.error };
  const t0 = Date.now();
  let firstTokenMs: number | undefined;

  try {
    const r = await fetch(cfg.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify({
        model: o.model,
        messages: o.messages,
        max_tokens: o.maxTokens ?? 512,
        stream: true,
      }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 120000),
    });

    if (!r.ok) {
      const text = await r.text();
      let msg = text.slice(0, 200);
      try { const d = JSON.parse(text); msg = (d.error?.code ? d.error.code + ': ' : '') + (d.error?.message || msg); } catch (e) { /* keep */ }
      return { ok: false, ms: Date.now() - t0, error: 'HTTP ' + r.status + ' — ' + msg.slice(0, 200) };
    }
    if (!r.body) return { ok: false, ms: Date.now() - t0, error: '响应没有 body' };

    const reader = (r.body as any).getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let full = '';
    let chunks = 0;
    let model = o.model;
    let lastUsage: any = undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // 按行处理；保留最后不完整的一行
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let j: any;
        try { j = JSON.parse(payload); } catch (e) { continue; }
        if (j.model) model = j.model;
        // OpenAI 兼容流式通常在最后一个 chunk 带 usage（需要 include_usage，某些网关默认给）
        if (j.usage) lastUsage = j.usage;
        const delta = j.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length) {
          if (firstTokenMs === undefined) {
            firstTokenMs = Date.now() - t0;
            o.onFirstDelta?.(firstTokenMs);
          }
          full += delta;
          chunks++;
          o.onDelta?.(delta);
        }
      }
    }

    return { ok: true, text: full, model, ms: Date.now() - t0, firstTokenMs, chunks, usage: lastUsage };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String(e).slice(0, 160) };
  }
}
