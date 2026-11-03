/*
 * SoulWeave S6.16：图片生成诊断（确定性规则，不依赖 LLM）
 *
 * 【为什么需要】
 * 用户遇到「出不了图」时，界面只显示一句错误，不知道该怎么修。
 * 这个模块把常见故障翻译成「问题 + 原因 + 一键修」三件事。
 *
 * 【为什么不用 LLM】
 * 1. 诊断是本地的、可离线的，不该依赖 API Key
 * 2. 同样的输入必须得到同样的结论，才能测试
 * 3. 规则覆盖了 95% 的真实故障（都来自真机踩坑）
 *
 * 【为什么不自动执行修复】
 * 修复涉及改用户配置、下载文件。必须由用户点确认。
 * 这里只产出建议，执行交给 UI 的明确动作。
 */

import type { ImageSourceMode } from './image-provider.js';
import type { SystemProfile } from './image-device.js';

// ─── 类型 ───────────────────────────────────────────

export type Severity = 'error' | 'warn' | 'info';

export interface FixAction {
  /** 动作标识，UI 据此执行具体操作 */
  action: string;
  /** 按钮文案 */
  label: string;
  /** 附带参数 */
  payload?: Record<string, unknown>;
}

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  /** 建议的修复动作（可能有多个） */
  fixes?: FixAction[];
}

export interface DiagnoseInput {
  /** 当前图片配置 */
  config: {
    sourceMode?: ImageSourceMode;
    localSd?: { enabled?: boolean; width?: number; height?: number; steps?: number };
    cloud?: { provider?: string; accountId?: string; apiKey?: string; hasKey?: boolean };
    comfyui?: { endpoint?: string; enabled?: boolean };
  };
  /** 设备信息（可空） */
  profile?: SystemProfile | null;
  /** 本地 SD 资源是否就绪 */
  sdcpp?: { exeFound: boolean; modelFound: boolean; usable?: boolean };
  /** 素材包状态 */
  pack?: { total: number };
  /** ComfyUI 探测结果（可空） */
  comfyui?: { reachable: boolean; checkpointCount?: number; error?: string } | null;
}

export interface DiagnoseResult {
  ok: boolean;
  findings: Finding[];
  /** 总体结论 */
  summary: string;
  /** 可复制的纯文本报告 */
  report: string;
}

// ─── 规则 ───────────────────────────────────────────

/**
 * 把配置与探测结果翻译成问题清单。
 *
 * 顺序即优先级：error 在前，其次 warn，最后 info。
 */
export function diagnose(input: DiagnoseInput): DiagnoseResult {
  const out: Finding[] = [];
  const cfg = input.config || {};
  const mode = cfg.sourceMode || 'bundled-then-local';
  const local = cfg.localSd || {};
  const cloud = cfg.cloud || {};
  const comfy = cfg.comfyui || {};
  const prof = input.profile || null;
  const sd = input.sdcpp || { exeFound: false, modelFound: false };
  const pack = input.pack || { total: 0 };

  // ── 1. 核显 ──
  const gpu = prof && prof.primaryGpu ? prof.primaryGpu : null;
  const hasDiscrete = !!(gpu && !gpu.integrated && gpu.vramMb > 0);
  const localEnabled = local.enabled !== false;
  const wantsLocal = mode === 'local-only' || mode === 'bundled-then-local' || mode === 'custom';

  if (wantsLocal && localEnabled && !hasDiscrete) {
    out.push({
      id: 'igpu-only',
      severity: 'error',
      title: '这台电脑没有可用独显',
      detail: 'stable-diffusion.cpp 在集成显卡上会稳定崩溃（0xC0000409），本地生成无法使用。' +
        (gpu ? '检测到的显卡：' + gpu.name : '未检测到独立显卡。'),
      fixes: [
        { action: 'set-source-mode', label: '改用「素材包优先」', payload: { sourceMode: 'bundled-then-local', disableLocalSd: true } },
        { action: 'set-source-mode', label: '只用素材包', payload: { sourceMode: 'bundled-only' } },
      ],
    });
  }

  // ── 2. 本地 SD 资源缺失 ──
  if (wantsLocal && localEnabled) {
    if (!sd.exeFound || !sd.modelFound) {
      out.push({
        id: 'sdcpp-missing',
        severity: 'warn',
        title: '本地 SD 组件不完整',
        detail: (!sd.exeFound ? '找不到 sd-cli.exe。' : '') +
          (!sd.modelFound ? '找不到 SD1.5 模型文件。' : '') +
          '这两样随安装包提供，如果缺失可能是安装不完整。',
        fixes: [{ action: 'disable-local-sd', label: '暂时关闭本地生成' }],
      });
    } else if (hasDiscrete && gpu && gpu.vramMb > 0 && gpu.vramMb < 4096) {
      out.push({
        id: 'low-vram',
        severity: 'warn',
        title: '显存偏小',
        detail: '当前 ' + Math.round(gpu.vramMb / 1024) + ' GB 显存，本地生成会很慢或失败。' +
          '建议 512×512、12 步以内。',
        fixes: [{ action: 'set-local-size', label: '设为 512×512 / 12 步', payload: { width: 512, height: 512, steps: 12 } }],
      });
    }
  }

  // ── 3. 配置自相矛盾 ──
  if (mode === 'local-only' && !localEnabled) {
    out.push({
      id: 'local-only-but-disabled',
      severity: 'error',
      title: '设置互相矛盾',
      detail: '来源选的是「只用本地 SD」，但本地生成是关闭的。这样一定出不了图。',
      fixes: [
        { action: 'set-source-mode', label: '改回「素材包优先」', payload: { sourceMode: 'bundled-then-local', disableLocalSd: true } },
        { action: 'enable-local-sd', label: '打开本地生成' },
      ],
    });
  }

  // ── 4. 云端配置 ──
  const wantCloud = mode === 'cloud-first';
  const hasKey = !!cloud.apiKey || !!cloud.hasKey;
  if (wantCloud || hasKey) {
    if (cloud.provider === 'cloudflare' || !cloud.provider) {
      if (!cloud.accountId) {
        out.push({
          id: 'cf-no-account',
          severity: 'warn',
          title: 'Cloudflare 缺少 Account ID',
          detail: 'Cloudflare Workers AI 需要 Account ID 和 API Token 两样。' +
            'Account ID 在 Cloudflare 控制台右下角。',
        });
      }
      if (!hasKey) {
        out.push({
          id: 'cf-no-key',
          severity: 'warn',
          title: 'Cloudflare 未配置 API Token',
          detail: '没有 Token 就不会走云端，会自动回落到素材包或本地生成。',
        });
      }
    } else if (!hasKey) {
      out.push({
        id: 'cloud-no-key',
        severity: 'warn',
        title: '云端未配置 API Key',
        detail: '当前云端服务需要 API Key 才能使用。',
      });
    }
  }

  // ── 5. ComfyUI ──
  if (comfy.enabled) {
    if (!comfy.endpoint) {
      out.push({
        id: 'comfy-no-endpoint',
        severity: 'warn',
        title: 'ComfyUI 已启用但没填地址',
        detail: '默认地址是 http://127.0.0.1:8188。',
        fixes: [{ action: 'set-comfy-endpoint', label: '填入默认地址', payload: { endpoint: 'http://127.0.0.1:8188' } }],
      });
    } else if (input.comfyui && !input.comfyui.reachable) {
      out.push({
        id: 'comfy-unreachable',
        severity: 'error',
        title: '连不上 ComfyUI',
        detail: '地址 ' + comfy.endpoint + ' 没有响应。' + (input.comfyui.error || '') +
          '请确认 ComfyUI 已启动，并且地址和端口正确。',
      });
    } else if (input.comfyui && input.comfyui.reachable && input.comfyui.checkpointCount === 0) {
      out.push({
        id: 'comfy-no-model',
        severity: 'error',
        title: 'ComfyUI 里没有模型',
        detail: '把 .safetensors 模型放进 ComfyUI/models/checkpoints 后重启 ComfyUI。',
      });
    }
  }

  // ── 6. 素材包 ──
  if (!pack.total) {
    out.push({
      id: 'pack-empty',
      severity: 'info',
      title: '内置素材包是空的',
      detail: '素材包未生成或丢失。不影响使用——本地 SD 和云端都能出图，最差会用占位图。',
    });
  }

  // ── 7. 磁盘 ──
  if (prof && prof.disk && prof.disk.freeGb < 6) {
    out.push({
      id: 'disk-low',
      severity: 'warn',
      title: '磁盘空间不足',
      detail: '剩余 ' + prof.disk.freeGb + ' GB。生成图片和模型都需要空间，建议清理到 10 GB 以上。',
    });
  }

  // ── 8. 一切正常 ──
  if (!out.length) {
    out.push({
      id: 'all-good',
      severity: 'info',
      title: '没有发现问题',
      detail: '配置和设备看起来都正常。如果还是出不了图，可以点「试生成一张」看具体报错。',
    });
  }

  // 排序：error → warn → info
  const rank: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity]);

  const errors = out.filter((f) => f.severity === 'error').length;
  const warns = out.filter((f) => f.severity === 'warn').length;
  const summary = errors ? ('发现 ' + errors + ' 个问题需要处理')
    : warns ? ('有 ' + warns + ' 条建议')
    : '一切正常';

  return { ok: true, findings: out, summary, report: buildReport(input, out, summary) };
}

// ─── 文本报告（供复制给 Agent） ────────────────────

export function buildReport(input: DiagnoseInput, findings: Finding[], summary: string): string {
  const cfg = input.config || {};
  const prof = input.profile || null;
  const gpu = prof && prof.primaryGpu ? prof.primaryGpu : null;
  const lines: string[] = [];

  lines.push('=== SoulWeave 图片生成诊断报告 ===');
  lines.push('时间: ' + new Date().toISOString());
  lines.push('');
  lines.push('【结论】' + summary);
  lines.push('');
  lines.push('【设备】');
  if (prof) {
    lines.push('  平台: ' + prof.platform);
    lines.push('  CPU: ' + (prof.cpu || '未知') + ' (' + prof.cpuCores + ' 核)');
    lines.push('  内存: ' + Math.round(prof.ramMb / 1024) + ' GB');
    lines.push('  显卡: ' + (gpu ? gpu.name + ' / ' + gpu.vramMb + ' MB' + (gpu.integrated ? '（核显）' : '（独显）') : '未检测到'));
    if (prof.disk) lines.push('  磁盘: ' + prof.disk.freeGb + ' GB 可用 / ' + prof.disk.totalGb + ' GB');
  } else {
    lines.push('  （设备信息未采集）');
  }
  lines.push('');
  lines.push('【配置】');
  lines.push('  来源模式: ' + (cfg.sourceMode || 'bundled-then-local'));
  const local = cfg.localSd || {};
  lines.push('  本地 SD: ' + (local.enabled === false ? '关闭' : '开启') +
    ' / ' + (local.width || 512) + '×' + (local.height || 512) + ' / ' + (local.steps || 12) + ' 步');
  const sd = input.sdcpp || { exeFound: false, modelFound: false };
  lines.push('  本地资源: 程序=' + (sd.exeFound ? '有' : '缺') + ' 模型=' + (sd.modelFound ? '有' : '缺'));
  const cloud = cfg.cloud || {};
  lines.push('  云端: ' + (cloud.provider || 'cloudflare') + ' / Key=' + ((cloud.apiKey || cloud.hasKey) ? '已配置' : '未配置'));
  const comfy = cfg.comfyui || {};
  lines.push('  ComfyUI: ' + (comfy.enabled ? (comfy.endpoint || '未填地址') : '未启用'));
  const pack = input.pack || { total: 0 };
  lines.push('  素材包: ' + pack.total + ' 张');
  lines.push('');
  lines.push('【问题清单】');
  if (!findings.length) {
    lines.push('  （无）');
  } else {
    for (const f of findings) {
      lines.push('  [' + f.severity.toUpperCase() + '] ' + f.title);
      lines.push('    ' + f.detail);
      if (f.fixes && f.fixes.length) {
        lines.push('    建议: ' + f.fixes.map((x) => x.label).join(' / '));
      }
    }
  }

  return lines.join('\n');
}