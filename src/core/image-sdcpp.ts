/*
 * SoulWeave S6：本地 SD（stable-diffusion.cpp）Provider
 *
 * 依据：S6 设计文档「本地 SD」章节
 *      sd.cpp 是 MIT 许可、28 MB、无 Python 依赖的唯一可内置方案
 *
 * 【设计原则】
 * 1. 参数可配置 —— sd.cpp 的 CLI 在不同版本间会变，不能硬编码死
 * 2. 子进程 + 临时文件 —— 不走 HTTP，最可靠
 * 3. 显存自适应 —— 按可用显存选量化档位
 * 4. OOM 自动降档 —— 高精度失败就用低精度重试一次
 * 5. 依赖注入 spawn/fs —— 可单元测试（不需要真的 sd.exe）
 */

import fsNode from 'node:fs';
import pathNode from 'node:path';
import osNode from 'node:os';
import { spawn as nodeSpawn } from 'node:child_process';
import type { ImageProviderAdapter, ProviderProbe } from './image-provider.js';
import type { ImageGenRequest, ImageGenResult } from './life-album.js';

// ─── 类型 ───────────────────────────────────────────

export type SdcppQuant = 'f16' | 'f32' | 'q8_0' | 'q5_0' | 'q4_0';

export interface SdcppConfig {
  /** sd.exe 绝对路径 */
  exePath: string;
  /** 模型文件绝对路径（.gguf / .safetensors） */
  modelPath: string;
  /** 量化类型；不填按显存自动选 */
  type?: SdcppQuant;
  /** 可用显存（MB）；用于自动选档 */
  vramMb?: number;
  /** 默认尺寸 */
  width?: number;
  height?: number;
  /** 采样步数 */
  steps?: number;
  /** 采样器（不同版本名不同，默认 euler_a） */
  sampler?: string;
  /** 额外参数（用户自定义 / 适配新版本） */
  extraArgs?: string[];
  /**
   * 选哪块 GPU 做计算。
   *   'discrete' 优先独显（默认）—— 实测核显会崩
   *   'any'      不指定，交给 auto-fit
   *   数字       强制某个 Vulkan 索引
   */
  gpuPrefer?: 'discrete' | 'any' | number;
  /** 参数放哪：'vram' 更快但占显存；'ram' 省显存（默认） */
  paramsIn?: 'vram' | 'ram';
  /** 内部：探测到的设备参数（由 resolveDeviceArgs 填充） */
  resolvedDeviceArgs?: string[];
  /** 单次生成超时（毫秒），默认 180 秒 */
  timeoutMs?: number;
  /** 临时输出目录；不填用系统临时目录 */
  workDir?: string;
}

export interface SdcppRunParams {
  prompt: string;
  negative?: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
  sampler: string;
  type: SdcppQuant;
  flashAttn: boolean;
  vaeTiling: boolean;
  offloadToCpu: boolean;
  outputPath: string;
  /** 设备选择参数（--backend / --params-backend） */
  deviceArgs?: string[];
}

export interface SdcppTuning {
  type: SdcppQuant;
  flashAttn: boolean;
  vaeTiling: boolean;
  offloadToCpu: boolean;
}

// ─── 显存自适应 ─────────────────────────────────────

/**
 * 按可用显存选量化档位与优化开关。
 *
 * 依据 sd.cpp 官方显存表（SD1.5 512×512）：
 *   f16  2.3 GB / +flash-attn 1.9 GB
 *   q8_0 2.1 GB / +flash-attn 1.6 GB
 *   q4_0 2.0 GB / +flash-attn 1.5 GB
 */
export function tuningForVram(vramMb: number): SdcppTuning {
  const v = Number(vramMb) || 0;
  if (v >= 6000) {
    return { type: 'q8_0', flashAttn: true, vaeTiling: false, offloadToCpu: false };
  }
  if (v >= 4000) {
    return { type: 'q4_0', flashAttn: true, vaeTiling: true, offloadToCpu: false };
  }
  if (v > 0) {
    return { type: 'q4_0', flashAttn: false, vaeTiling: true, offloadToCpu: true };
  }
  // 未知显存 → 最保守（含 offload，宁慢不崩）
  return { type: 'q4_0', flashAttn: false, vaeTiling: true, offloadToCpu: true };
}

/** OOM 后降一档 */
export function downgrade(t: SdcppTuning): SdcppTuning | null {
  const order: SdcppQuant[] = ['f32', 'f16', 'q8_0', 'q5_0', 'q4_0'];
  const i = order.indexOf(t.type);
  if (i < order.length - 1) {
    return { ...t, type: order[i + 1], vaeTiling: true };
  }
  if (!t.offloadToCpu) return { ...t, offloadToCpu: true, vaeTiling: true };
  return null; // 已经最低
}

// ─── 参数构造（纯函数，可测试） ─────────────────────

export function buildSdcppArgs(cfg: SdcppConfig, p: SdcppRunParams): string[] {
  const args: string[] = [
    '-m', cfg.modelPath,
    '-p', p.prompt,
    '-o', p.outputPath,
    '-W', String(p.width),
    '-H', String(p.height),
    '-s', String(p.seed),
    '--steps', String(p.steps),
    '--type', p.type,
  ];
  if (p.negative) args.push('-n', p.negative);
  if (p.sampler) args.push('--sampling-method', p.sampler);
  if (p.flashAttn) args.push('--flash-attn', 'on');
  if (p.vaeTiling) args.push('--vae-tiling');
  if (p.offloadToCpu) args.push('--offload-to-cpu');
  // 设备选择（实测：不指定会选到核显然后崩溃）
  if (Array.isArray(p.deviceArgs) && p.deviceArgs.length) args.push(...p.deviceArgs);
  // 用户额外参数放最后，可覆盖前面
  if (Array.isArray(cfg.extraArgs) && cfg.extraArgs.length) args.push(...cfg.extraArgs);
  return args;
}

// ─── GPU 设备解析 ───────────────────────────────────

export interface VulkanDevice {
  /** Vulkan 索引（0 起） */
  index: number;
  name: string;
  /** 1 = 集成显卡（UMA） */
  uma: boolean;
}

/**
 * 从 sd.cpp 日志里解析 Vulkan 设备列表。
 *
 * 实测格式（2026-10-31）：
 *   ggml_vulkan: 0 = AMD Radeon 780M Graphics (AMD proprietary driver) | uma: 1 | fp16: 1 | ...
 *   ggml_vulkan: 1 = NVIDIA GeForce RTX 4050 Laptop GPU (NVIDIA) | uma: 0 | fp16: 1 | ...
 */
export function parseVulkanDevices(log: string): VulkanDevice[] {
  const out: VulkanDevice[] = [];
  const re = /ggml_vulkan:\s*(\d+)\s*=\s*([^|]+?)\s*\|\s*uma:\s*(\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(log || ''))) !== null) {
    out.push({ index: Number(m[1]), name: m[2].trim(), uma: m[3] === '1' });
  }
  return out;
}

/**
 * 按偏好挑设备。
 *
 * 为什么要挑：实测在 6 GB 机器上，
 * auto-fit 会选显存预算更大的核显（AMD 780M），
 * 然后 **稳定崩溃**（0xC0000409 STATUS_STACK_BUFFER_OVERRUN）。
 * 强制独显后一切正常。
 */
/**
 * 判断设备是否可用于本地 SD 生成。
 *
 * 实测教训（2026-10-31）：
 *   只有核显（uma: 1）时，sd.cpp 的 auto-fit 会在核显上跑，
 *   然后 **100% 稳定崩溃**（0xC0000409 STATUS_STACK_BUFFER_OVERRUN）。
 *   这不是偶发，是核显 Vulkan 路径的硬问题。
 *
 * 所以：只有核显 = 本地 SD 不可用，必须降级到素材包。
 */
export function isUsableForSdcpp(d: VulkanDevice | null): boolean {
  if (!d) return false;
  return !d.uma;   // 只认独显
}

export function pickDevice(
  devices: VulkanDevice[],
  prefer: 'discrete' | 'any' | number = 'discrete',
): VulkanDevice | null {
  if (!devices.length) return null;
  if (typeof prefer === 'number') {
    return devices.find((d) => d.index === prefer) || null;
  }
  if (prefer === 'any') return devices[0];
  // discrete：优先非 UMA
  const disc = devices.filter((d) => !d.uma);
  if (disc.length) return disc[0];
  return devices[0];  // 只有核显时也只能用它
}

/** 构造 --backend / --params-backend 参数 */
export function buildDeviceArgs(
  device: VulkanDevice | null,
  paramsIn: 'vram' | 'ram' = 'ram',
): string[] {
  if (!device) return [];
  const dev = 'Vulkan' + device.index;
  const args = ['--backend', 'diffusion=' + dev + ',te=' + dev + ',vae=' + dev];
  if (paramsIn === 'vram') {
    args.push('--params-backend', 'diffusion=' + dev + ',te=' + dev + ',vae=' + dev);
  }
  return args;
}

// ─── 输出解析 ───────────────────────────────────────

export interface ParsedLine {
  /** 进度 0-1（能解析到时） */
  progress?: number;
  /** 步数文本，如 '5/20' */
  stepText?: string;
  /** 是否内存不足 */
  oom?: boolean;
  /** 是否致命错误 */
  fatal?: boolean;
}

const OOM_PATTERNS = [
  /out of memory/i,
  /OOM/i,
  /CUDA error/i,
  /VK_ERROR_OUT_OF_DEVICE_MEMORY/i,
  /failed to allocate/i,
  /alloc.*failed/i,
  /not enough memory/i,
];

const FATAL_PATTERNS = [
  /error:/i,
  /failed to load/i,
  /invalid model/i,
  /unknown argument/i,
  /assertion/i,
];

/** 解析 sd.cpp 的一行 stderr/stdout */
export function parseSdcppLine(line: string): ParsedLine {
  const s = String(line || '');
  const out: ParsedLine = {};

  // 进度：常见格式 'step 5/20' 或 '5/20'
  const m = /(\d+)\s*\/\s*(\d+)/.exec(s);
  if (m) {
    const cur = Number(m[1]);
    const total = Number(m[2]);
    if (total > 0 && cur >= 0 && cur <= total) {
      out.stepText = cur + '/' + total;
      out.progress = cur / total;
    }
  }

  for (const re of OOM_PATTERNS) {
    if (re.test(s)) { out.oom = true; break; }
  }
  if (!out.oom) {
    for (const re of FATAL_PATTERNS) {
      if (re.test(s)) { out.fatal = true; break; }
    }
  }
  return out;
}

// ─── 依赖注入 ───────────────────────────────────────

/**
 * 生成阶段事件。
 *
 * 【为什么要区分阶段】
 * 实测：第一次生成 45.93 秒，第二次 5.27 秒 —— 差 7 倍。
 * 原因是 Vulkan 着色器编译，之后走磁盘缓存。
 * 如果 UI 不告诉用户「首次准备中」，第一张图会被以为卡死。
 */
export type SdcppPhase =
  | 'preparing'   // 首次准备（着色器编译 / 模型加载）
  | 'sampling'    // 采样出图中
  | 'decoding'    // VAE 解码
  | 'done';

export interface SdcppProgress {
  phase: SdcppPhase;
  stepText?: string;
  progress?: number;
  /** 是否可能是首次运行（慢） */
  firstRunHint?: boolean;
  /** 已耗时（毫秒） */
  elapsedMs?: number;
}

export interface SdcppDeps {
  exists?: (p: string) => boolean;
  spawn?: typeof nodeSpawn;
  readFile?: (p: string) => Buffer;
  writeFile?: (p: string, data: string | Buffer) => void;
  unlink?: (p: string) => void;
  mkdir?: (p: string) => void;
  tmpName?: () => string;
  onProgress?: (ev: SdcppProgress) => void;
  log?: (msg: string) => void;
}

function d(deps: SdcppDeps) {
  return {
    exists: deps.exists || ((p: string) => { try { return fsNode.existsSync(p); } catch (e) { return false; } }),
    spawn: deps.spawn || nodeSpawn,
    readFile: deps.readFile || ((p: string) => fsNode.readFileSync(p)),
    unlink: deps.unlink || ((p: string) => { try { fsNode.unlinkSync(p); } catch (e) { void e; } }),
    mkdir: deps.mkdir || ((p: string) => { try { fsNode.mkdirSync(p, { recursive: true }); } catch (e) { void e; } }),
    tmpName: deps.tmpName || (() => pathNode.join(osNode.tmpdir(), 'sw-sd-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.png')),
    onProgress: deps.onProgress,
    log: deps.log || (() => {}),
  };
}

// ─── 内置资源定位 ───────────────────────────────────

/**
 * 定位内置的 sd.cpp 资源。
 *
 * 开发时： <项目根>/resources/sdcpp/
 * 打包后： <resources>/resources/sdcpp/（electron-builder extraResources）
 *
 * 也支持用户自备（设置里指定路径）。
 */
export function resolveBundledSdcpp(opts: {
  /** 项目根（开发时） */
  projectRoot?: string;
  /** process.resourcesPath（打包后） */
  resourcesPath?: string;
  exists?: (p: string) => boolean;
}): { exeDir: string | null; modelPath: string | null } {
  const exists = opts.exists || ((p: string) => { try { return fsNode.existsSync(p); } catch (e) { return false; } });
  const bases: string[] = [];
  if (opts.resourcesPath) {
    bases.push(pathNode.join(opts.resourcesPath, 'resources'));
    bases.push(pathNode.join(opts.resourcesPath, 'app', 'resources'));
  }
  if (opts.projectRoot) bases.push(pathNode.join(opts.projectRoot, 'resources'));

  let exeDir: string | null = null;
  let modelPath: string | null = null;

  for (const base of bases) {
    if (!exeDir) {
      const dir = pathNode.join(base, 'sdcpp');
      if (resolveSdcppExe(dir, exists)) exeDir = dir;
    }
    if (!modelPath) {
      for (const rel of [
        ['models', 'sd15', 'sd15-pruned-emaonly.safetensors'],
        ['models', 'sd15', 'sd15.safetensors'],
        ['models', 'sd15-q8.gguf'],
      ]) {
        const f = pathNode.join(base, ...rel);
        if (exists(f)) { modelPath = f; break; }
      }
    }
    if (exeDir && modelPath) break;
  }

  return { exeDir, modelPath };
}

// ─── 设备探测 ───────────────────────────────────────

/**
 * 探测本机 Vulkan 设备。
 *
 * 做法：跑一次极小生成（8×8, 1 步），从 stderr 解析设备列表。
 * 耗时约 3-8 秒（含模型加载），只在首次或用户点「重新检测」时调用。
 *
 * 说明：sd.cpp 没有独立的「列出设备」命令，
 * 但这个极小生成足够触发 ggml_vulkan 的设备枚举日志。
 */
export async function probeDevices(
  cfg: SdcppConfig,
  deps: SdcppDeps = {},
): Promise<{
  ok: boolean;
  devices: VulkanDevice[];
  /** 是否有可用的独显（只有核显 = false） */
  usable: boolean;
  error?: string;
}> {
  const x = d(deps);
  const exe = resolveSdcppExe(cfg.exePath, x.exists);
  if (!exe || !cfg.modelPath || !x.exists(cfg.modelPath)) {
    return { ok: false, devices: [], usable: false, error: '可执行文件或模型缺失' };
  }

  return new Promise((resolve) => {
    const tn = x.tmpName();
    const outPath = pathNode.isAbsolute(tn) ? tn : pathNode.join(cfg.workDir || '', tn);
    let log = '';
    let settled = false;
    let proc: any;

    const finish = (r: { ok: boolean; devices: VulkanDevice[]; usable: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { x.unlink(outPath); } catch (e) { void e; }
      resolve(r);
    };

    const timer = setTimeout(() => {
      try { proc && proc.kill && proc.kill(); } catch (e) { void e; }
      // 超时也尝试从已有日志解析
      const devs = parseVulkanDevices(log);
      const ok = devs.length > 0;
      finish({ ok, devices: devs, usable: ok && devs.some(isUsableForSdcpp), error: ok ? undefined : '探测超时' });
    }, 90_000);

    try {
      proc = x.spawn(exe, [
        '-m', cfg.modelPath, '-p', 'x', '-o', outPath,
        '-W', '64', '-H', '64', '--steps', '1', '--log-level', 'info',
      ], { windowsHide: true });
    } catch (e) {
      finish({ ok: false, devices: [], usable: false, error: '启动失败：' + String(e).slice(0, 120) });
      return;
    }

    const onData = (chunk: any) => { log += String(chunk); };
    proc.stdout?.on?.('data', onData);
    proc.stderr?.on?.('data', onData);
    proc.on?.('error', (e: Error) => finish({ ok: false, devices: [], usable: false, error: String(e).slice(0, 120) }));
    proc.on?.('close', () => {
      const devs = parseVulkanDevices(log);
      if (!devs.length) {
        finish({ ok: false, devices: [], usable: false, error: '日志中未找到 Vulkan 设备' });
        return;
      }
      finish({ ok: true, devices: devs, usable: devs.some(isUsableForSdcpp) });
    });
  });
}

// ─── 探测 ───────────────────────────────────────────

/**
 * 已知的可执行文件名。
 *
 * 实测（2026-10-31，sd.cpp master-1028-37bc88b）：
 *   可执行文件叫 **sd-cli.exe**，不是 sd.exe。
 *   同目录还有 sd-server.exe（HTTP 服务模式）。
 * 早期版本叫 sd.exe，所以两种都认。
 */
export const SDCPP_EXE_NAMES = ['sd-cli.exe', 'sd.exe', 'sd', 'sd-cli'] as const;

/**
 * 在给定目录下自动找 sd.cpp 可执行文件。
 *
 * cfg.exePath 可以是：
 *   · 具体的 exe 路径 → 直接用
 *   · 一个目录         → 在里面按 SDCPP_EXE_NAMES 找
 */
export function resolveSdcppExe(
  exePathOrDir: string,
  exists: (p: string) => boolean,
): string | null {
  if (!exePathOrDir) return null;
  const lower = exePathOrDir.toLowerCase();
  // 看起来像文件（有扩展名）→ 直接检查
  if (/\.(exe|bin)$/i.test(lower) || lower.endsWith('sd')) {
    return exists(exePathOrDir) ? exePathOrDir : null;
  }
  // 当作目录处理
  for (const name of SDCPP_EXE_NAMES) {
    const cand = pathNode.join(exePathOrDir, name);
    if (exists(cand)) return cand;
  }
  return null;
}

export async function probeSdcpp(cfg: SdcppConfig, deps: SdcppDeps = {}): Promise<ProviderProbe> {
  const x = d(deps);
  if (!cfg || !cfg.exePath) {
    return { available: false, reason: '未配置 sd.cpp 路径', missing: 'config' };
  }
  // 自动解析（支持目录或具体文件）
  const resolved = resolveSdcppExe(cfg.exePath, x.exists);
  if (!resolved) {
    return {
      available: false,
      reason: '找不到 sd.cpp 可执行文件（期望 sd-cli.exe / sd.exe）：' + cfg.exePath,
      missing: 'config',
    };
  }
  if (!cfg.modelPath) {
    return { available: false, reason: '未配置模型文件', missing: 'model' };
  }
  if (!x.exists(cfg.modelPath)) {
    return { available: false, reason: '模型文件不存在：' + pathNode.basename(cfg.modelPath), missing: 'model' };
  }
  return { available: true };
}

// ─── 生成 ───────────────────────────────────────────

/** 单次执行（一次尝试，不含降档） */
export function runOnce(
  cfg: SdcppConfig,
  req: ImageGenRequest,
  tuning: SdcppTuning,
  deps: SdcppDeps = {},
): Promise<ImageGenResult> {
  return new Promise<ImageGenResult>((resolve) => {
    const x = d(deps);
    const width = Number(req.width) || cfg.width || 768;
    const height = Number(req.height) || cfg.height || 768;
    const steps = cfg.steps || 12;
    const sampler = cfg.sampler || 'euler_a';
    const seed = typeof req.seed === 'number' ? req.seed : Math.floor(Math.random() * 2147483647);

    if (cfg.workDir) x.mkdir(cfg.workDir);
    // tmpName 可能已是绝对路径，不能盲目 join（会把 D:\a 拼成 D:\b\D:\a）
    const tn = x.tmpName();
    const outputPath = pathNode.isAbsolute(tn)
      ? tn
      : pathNode.join(cfg.workDir || '', tn);

    const params: SdcppRunParams = {
      prompt: String(req.prompt || ''),
      negative: req.negative,
      width, height, seed, steps, sampler,
      type: tuning.type,
      flashAttn: tuning.flashAttn,
      vaeTiling: tuning.vaeTiling,
      offloadToCpu: tuning.offloadToCpu,
      outputPath,
    };
    // 设备参数：用户显式给的优先，否则按 gpuPrefer 自动选
    if (!params.deviceArgs && cfg.resolvedDeviceArgs) {
      params.deviceArgs = cfg.resolvedDeviceArgs;
    }
    const args = buildSdcppArgs(cfg, params);

    let settled = false;
    let oom = false;
    let lastErr = '';
    let proc: any;

    const finish = (r: ImageGenResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { x.unlink(outputPath); } catch (e) { void e; }
      resolve(r);
    };

    const timeoutMs = Number(cfg.timeoutMs) || 180_000;
    const timer = setTimeout(() => {
      try { proc && proc.kill && proc.kill(); } catch (e) { void e; }
      finish({ ok: false, error: '生成超时（' + Math.round(timeoutMs / 1000) + ' 秒）' });
    }, timeoutMs);

    // 保留最近几行非进度输出，失败时能给出有用信息
    const tail: string[] = [];
    const startedAt = Date.now();
    let phase: SdcppPhase = 'preparing';
    let sawOom = false;

    const handleLine = (chunk: Buffer | string) => {
      const text = String(chunk);
      for (const raw of text.split(/\r?\n/)) {
        if (!raw.trim()) continue;
        const p = parseSdcppLine(raw);

        // 阶段切换（基于 sd.cpp 的真实日志关键字）
        if (/generate_image \d+x\d+/.test(raw) || /sampling using/.test(raw)) {
          if (phase !== 'sampling') {
            phase = 'sampling';
            x.onProgress?.({ phase, elapsedMs: Date.now() - startedAt });
          }
        } else if (/decoding \d+ latents/i.test(raw)) {
          if (phase !== 'decoding') {
            phase = 'decoding';
            x.onProgress?.({ phase, elapsedMs: Date.now() - startedAt });
          }
        }

        if (p.progress !== undefined) {
          x.onProgress?.({
            phase, stepText: p.stepText, progress: p.progress,
            elapsedMs: Date.now() - startedAt,
          });
        }
        if (p.oom) oom = true;
        if (p.oom || p.fatal) lastErr = raw.trim().slice(0, 300);
        // 进度条（含 it/s 或 |###|）不入 tail，避免噪声
        const isProgressBar = /\|#+\||it\/s|ETA/.test(raw);
        if (!isProgressBar) {
          tail.push(raw.trim());
          if (tail.length > 8) tail.shift();
        }
      }
    };

    try {
      const exe = resolveSdcppExe(cfg.exePath, x.exists) || cfg.exePath;
      proc = x.spawn(exe, args, { windowsHide: true });
    } catch (e) {
      finish({ ok: false, error: '启动失败：' + String(e).slice(0, 150) });
      return;
    }

    proc.stdout?.on?.('data', handleLine);
    proc.stderr?.on?.('data', handleLine);
    proc.on?.('error', (e: Error) => {
      finish({ ok: false, error: '进程错误：' + String(e).slice(0, 150) });
    });
    proc.on?.('close', (code: number) => {
      if (settled) return;
      // 读输出文件
      try {
        if (x.exists(outputPath)) {
          const buf = x.readFile(outputPath);
          if (buf && buf.length > 0) {
            const elapsedMs = Date.now() - startedAt;
            // 首次运行会慢 7 倍（着色器编译），用耗时判断并提示
            const firstRunHint = elapsedMs > 20_000;
            x.onProgress?.({ phase: 'done', elapsedMs, firstRunHint });
            finish({
              ok: true, data: new Uint8Array(buf), mime: 'image/png', provider: 'sdcpp',
            });
            return;
          }
        }
      } catch (e) { void e; }
      const detail = lastErr || tail.filter(Boolean).slice(-3).join(' | ') || ('退出码 ' + code);
      finish({ ok: false, error: (oom ? '显存不足：' : '') + detail.slice(0, 400) });
    });
  });
}

/**
 * 带自动降档的生成。
 *
 * 首次用按显存选的档位；如果 OOM，降一档重试；
 * 最多降档 2 次，避免无限重试。
 */
export async function generateWithSdcpp(
  cfg: SdcppConfig,
  req: ImageGenRequest,
  deps: SdcppDeps = {},
): Promise<ImageGenResult> {
  // ── 自动探测 GPU 设备 ──
  // 实测教训：不指定 --backend 时 sd.cpp 的 auto-fit 会选到核显，
  // 然后 100% 稳定崩溃（0xC0000409）。所以这里必须给出设备参数。
  // 调用方没传 resolvedDeviceArgs 时，自动探测一次并回填到 cfg。
  if (!Array.isArray(cfg.resolvedDeviceArgs)) {
    const probe = await probeDevices(cfg, deps);
    if (!probe.ok) {
      return { ok: false, code: 'NO_MODEL', error: 'GPU 探测失败：' + (probe.error || '未知') };
    }
    if (!probe.usable) {
      return {
        ok: false,
        code: 'IGPU_ONLY',
        error: '本机只有集成显卡。sd.cpp 在核显上会稳定崩溃，因此本地生成不可用。',
      };
    }
    const dev = pickDevice(probe.devices, cfg.gpuPrefer || 'discrete');
    cfg.resolvedDeviceArgs = buildDeviceArgs(dev, cfg.paramsIn || 'ram');
    deps.log?.('已选定 GPU：' + (dev ? dev.name + ' (index ' + dev.index + ')' : '无'));
  }

  let tuning = cfg.type
    ? { ...tuningForVram(cfg.vramMb || 0), type: cfg.type }
    : tuningForVram(cfg.vramMb || 0);

  let attempt = 0;
  let last: ImageGenResult = { ok: false, error: '未执行' };
  while (attempt < 3) {
    attempt++;
    const r = await runOnce(cfg, req, tuning, deps);
    if (r.ok) return r;
    last = r;
    const isOom = /显存不足|out of memory|OOM/i.test(r.error || '');
    if (!isOom) return r;  // 非 OOM 不降档
    const next = downgrade(tuning);
    if (!next) break;
    deps.log?.('显存不足，降档重试：' + tuning.type + ' → ' + next.type);
    tuning = next;
  }
  return last;
}

// ─── Provider 适配 ──────────────────────────────────

export function createSdcppProvider(cfg: SdcppConfig, deps: SdcppDeps = {}): ImageProviderAdapter {
  const timeout = Number(cfg.timeoutMs) || 180_000;
  return {
    id: 'sdcpp',
    label: '本地 SD',
    requiresConfig: false,
    requiresNetwork: false,
    requiresModel: true,
    // 本地生成慢，超时要比云端长
    timeoutMs: timeout + 10_000,
    async probe() { return probeSdcpp(cfg, deps); },
    async generate(req) { return generateWithSdcpp(cfg, req, deps); },
  };
}