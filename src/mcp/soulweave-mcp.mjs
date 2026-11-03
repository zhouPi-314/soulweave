#!/usr/bin/env node
/**
 * SoulWeave MCP Server（stdio）
 *
 * 【方向】不是 SoulWeave 去调用你的 Agent，
 * 而是你的 Agent（DSH / Claude / 任意支持 MCP 的客户端）连上 SoulWeave 查状态。
 *
 * 理由：
 *   · 只读为主，权限最小
 *   · Agent 拿到结构化数据，比读日志准
 *   · 用户在自己熟悉的 Agent 里排查，不用来回切窗口
 *
 * 【运行】node src/mcp/soulweave-mcp.mjs
 * 【配置到 DSH / Claude Desktop】
 *   { "mcpServers": { "soulweave": {
 *       "command": "node",
 *       "args": ["D:/SoulWeave/01_project/soulweave/src/mcp/soulweave-mcp.mjs"]
 *   } } }
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnose } from '../../dist/core/image-diagnose.js';
import { detectProfile, recommendTier, profileSummary, toCapability } from '../../dist/core/image-device.js';
import { listAvailability } from '../../dist/core/image-model-manifest.js';
import { resolveBundledSdcpp, createSdcppProvider } from '../../dist/core/image-sdcpp.js';
import { loadPack } from '../../dist/core/image-bundled.js';
import { testComfyUI, listCheckpoints } from '../../dist/core/image-comfyui.js';
import { testCloud } from '../../dist/core/image-cloud.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const USER_DATA = path.join(ROOT, '.runtime-userdata');

// ─── 读配置 ─────────────────────────────────────────

function readJson(name, fallback) {
  try {
    const p = path.join(USER_DATA, name);
    if (!fs.existsSync(p)) return fallback;
    return { ...fallback, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch (e) { return fallback; }
}

function readImageCfg() {
  return readJson('image-gen.json', {
    sourceMode: 'bundled-then-local',
    localSd: { enabled: true, width: 512, height: 512, steps: 12 },
    cloud: { provider: 'cloudflare', accountId: '', apiKey: '' },
    comfyui: { endpoint: '', enabled: false },
  });
}

// ─── 工具实现 ───────────────────────────────────────

async function toolDiagnose() {
  const cfg = readImageCfg();
  const profile = detectProfile();
  const b = resolveBundledSdcpp({ projectRoot: ROOT });
  const pack = loadPack(path.join(ROOT, 'resources', 'assets', 'life'));

  let comfy = null;
  if (cfg.comfyui && cfg.comfyui.enabled && cfg.comfyui.endpoint) {
    const conn = await testComfyUI(cfg.comfyui.endpoint);
    comfy = { reachable: conn.ok, error: conn.error };
    if (conn.ok) {
      const cps = await listCheckpoints(cfg.comfyui.endpoint);
      comfy.checkpointCount = cps.checkpoints.length;
    }
  }

  const r = diagnose({
    config: {
      sourceMode: cfg.sourceMode,
      localSd: cfg.localSd,
      cloud: { ...cfg.cloud, hasKey: !!(cfg.cloud && cfg.cloud.apiKey) },
      comfyui: cfg.comfyui,
    },
    profile,
    sdcpp: { exeFound: !!b.exeDir, modelFound: !!b.modelPath },
    pack: { total: pack.items.length },
    comfyui: comfy,
  });

  return {
    summary: r.summary,
    findings: r.findings.map((f) => ({ id: f.id, severity: f.severity, title: f.title, detail: f.detail })),
    report: r.report,
  };
}

async function toolStatus() {
  const cfg = readImageCfg();
  const profile = detectProfile();
  const cap = toCapability(profile);
  const b = resolveBundledSdcpp({ projectRoot: ROOT });
  const pack = loadPack(path.join(ROOT, 'resources', 'assets', 'life'));
  const tiers = listAvailability(path.join(ROOT, 'resources', 'models'), cap);

  const cloudReady = !!(cfg.cloud && cfg.cloud.apiKey);
  const comfyReady = !!(cfg.comfyui && cfg.comfyui.enabled && cfg.comfyui.endpoint);
  const localReady = !!(b.exeDir && b.modelPath);

  return {
    device: {
      summary: profileSummary(profile),
      platform: profile.platform,
      cpuCores: profile.cpuCores,
      ramMb: profile.ramMb,
      gpu: profile.primaryGpu ? profile.primaryGpu.name : null,
      vramMb: profile.primaryGpu ? profile.primaryGpu.vramMb : 0,
      diskFreeGb: profile.disk ? profile.disk.freeGb : null,
    },
    recommendation: recommendTier(profile).tier,
    tiers: tiers.map((x) => ({ tier: x.entry.tier, label: x.entry.label, usable: x.usable })),
    providers: {
      bundled: { ready: pack.items.length > 0, count: pack.items.length },
      localSd: { ready: localReady, enabled: !!(cfg.localSd && cfg.localSd.enabled) },
      cloud: { ready: cloudReady, provider: cfg.cloud && cfg.cloud.provider },
      comfyui: { ready: comfyReady, endpoint: cfg.comfyui && cfg.comfyui.endpoint },
    },
    sourceMode: cfg.sourceMode,
  };
}

async function toolProbe() {
  const cfg = readImageCfg();
  const out = {};

  // 素材包
  const pack = loadPack(path.join(ROOT, 'resources', 'assets', 'life'));
  out.bundled = { available: pack.items.length > 0, count: pack.items.length };

  // 本地 SD
  const b = resolveBundledSdcpp({ projectRoot: ROOT });
  if (b.exeDir && b.modelPath) {
    const p = createSdcppProvider({ exePath: b.exeDir, modelPath: b.modelPath, vramMb: 6141 });
    out.localSd = await p.probe();
  } else {
    out.localSd = { available: false, reason: '缺少可执行文件或模型' };
  }

  // 云端
  if (cfg.cloud && cfg.cloud.apiKey) {
    const r = await testCloud({
      provider: cfg.cloud.provider || 'cloudflare',
      accountId: cfg.cloud.accountId, apiKey: cfg.cloud.apiKey,
      baseUrl: cfg.cloud.baseUrl, model: cfg.cloud.model,
      width: cfg.cloud.width, height: cfg.cloud.height, steps: cfg.cloud.steps,
    });
    out.cloud = { available: r.ok, error: r.error, freePerDay: r.freePerDay };
  } else {
    out.cloud = { available: false, reason: '未配置 API Key' };
  }

  // ComfyUI
  if (cfg.comfyui && cfg.comfyui.enabled && cfg.comfyui.endpoint) {
    const r = await testComfyUI(cfg.comfyui.endpoint);
    out.comfyui = { available: r.ok, error: r.error, version: r.version };
  } else {
    out.comfyui = { available: false, reason: '未启用或未填地址' };
  }

  return out;
}

// ─── 工具清单 ───────────────────────────────────────

const TOOLS = [
  {
    name: 'soulweave_diagnose',
    description: '诊断 SoulWeave 的图片生成配置：返回问题清单、严重度、修复建议和可读报告。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'soulweave_status',
    description: '查看设备信息、推荐档位、各图片来源是否就绪。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'soulweave_probe_providers',
    description: '逐个探测素材包 / 本地 SD / 云端 / ComfyUI 是否真的可用（会发起网络或进程调用）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// ─── JSON-RPC ───────────────────────────────────────

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg || {};

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'soulweave', version: '1.0.0' },
    });
  }

  if (method === 'notifications/initialized') return;  // 通知无需回复

  if (method === 'tools/list') {
    return reply(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    try {
      let data = null;
      if (name === 'soulweave_diagnose') data = await toolDiagnose();
      else if (name === 'soulweave_status') data = await toolStatus();
      else if (name === 'soulweave_probe_providers') data = await toolProbe();
      else return fail(id, -32601, '未知工具：' + name);

      return reply(id, {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      });
    } catch (e) {
      return reply(id, {
        content: [{ type: 'text', text: '执行失败：' + String(e).slice(0, 300) }],
        isError: true,
      });
    }
  }

  if (method === 'ping') return reply(id, {});

  // 未知方法：按协议应返回错误（但不影响连接）
  return fail(id, -32601, '未实现：' + method);
}

// ─── 主循环 ─────────────────────────────────────────

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg = null;
    try { msg = JSON.parse(line); } catch (e) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } });
      continue;
    }
    handle(msg).catch((e) => {
      if (msg && msg.id != null) fail(msg.id, -32603, String(e).slice(0, 200));
    });
  }
});

process.stdin.on('end', () => process.exit(0));
