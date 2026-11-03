/**
 * SoulWeave S3-8：语音组件管理器
 *
 * 背景
 * ────
 * Piper / Kokoro 的中文音素化依赖 espeak-ng（GPL-3.0），GPT-SoVITS / CosyVoice
 * 需要完整的 Python + CUDA 运行时。这些**都不适合塞进安装包**：
 *   - 体积（3–5 GB）
 *   - 许可（GPL 分发义务）
 *   - 驱动/版本耦合
 *
 * 因此采用「组件外置 + 应用编排」：
 *   安装包只含 MIT/Apache 的引擎本体；
 *   需要 GPL 或重型运行时的部分，由用户在**引导页**里自行获取，
 *   再让应用自动探测或由用户指定安装位置。
 *
 * 这与规划文档对 NapCat 的处理一致：「不打包，用户自行安装」。
 */

import fs from 'node:fs';
import path from 'node:path';

export type ComponentKind = 'dir' | 'file' | 'service';
export type ComponentStatus = 'ready' | 'missing' | 'invalid' | 'unconfigured';

export interface ComponentSpec {
  id: string;
  label: string;
  kind: ComponentKind;
  /** 为什么需要它（显示给用户） */
  why: string;
  /** 上游获取页面（应用只负责打开，不代下） */
  upstream: string;
  /** 许可证提示 */
  license: string;
  /** 相关 provider */
  providers: string[];
  /** 缺失时是否阻塞对应 provider */
  required: boolean;
}

export interface ComponentState {
  id: string;
  path: string | null;
  status: ComponentStatus;
  detail?: string;
}

/** 组件清单：这是「引导页」要展示的全部内容 */
export const COMPONENT_SPECS: ComponentSpec[] = [
  {
    id: 'piper',
    label: 'Piper 引擎',
    kind: 'dir',
    why: '离线语音合成引擎（MIT）。Pure CPU，不占显存。',
    upstream: 'https://github.com/rhasspy/piper/releases',
    license: 'MIT',
    providers: ['piper'],
    required: false,
  },
  {
    id: 'espeak',
    label: 'espeak-ng 语音数据',
    kind: 'dir',
    why: 'Piper / Kokoro 的中文音素化依赖。因是 GPL-3.0，不随应用分发，需你自行获取。',
    upstream: 'https://github.com/espeak-ng/espeak-ng/releases',
    license: 'GPL-3.0',
    providers: ['piper', 'kokoro'],
    required: true,
  },
  {
    id: 'kokoro',
    label: 'Kokoro 模型',
    kind: 'dir',
    why: '54 个音色（含 8 个中文）的轻量 TTS 模型（Apache-2.0）。需 kokoro-v1.0.onnx + voices-v1.0.bin + config.json 三个文件。',
    upstream: 'https://github.com/thewh1teagle/kokoro-onnx/releases',
    license: 'Apache-2.0',
    providers: ['kokoro'],
    required: false,
  },
  {
    id: 'gptsovits',
    label: 'GPT-SoVITS 服务',
    kind: 'service',
    why: '少样本音色克隆（5 秒–1 分钟素材）。需你自行部署本地服务。',
    upstream: 'https://github.com/RVC-Boss/GPT-SoVITS',
    license: 'MIT（代码）/ 权重许可另计',
    providers: ['gptsovits'],
    required: false,
  },
  {
    id: 'cosyvoice',
    label: 'CosyVoice 服务',
    kind: 'service',
    why: '中文零样本克隆（Apache-2.0）。需你自行部署本地服务。',
    upstream: 'https://github.com/FunAudioLLM/CosyVoice',
    license: 'Apache-2.0',
    providers: ['cosyvoice'],
    required: false,
  },
];

/** 探测靠文件名/目录特征，不执行任何内容 */
const DETECTORS: Record<string, (p: string) => boolean> = {
  piper: (p) => fs.existsSync(path.join(p, 'piper.exe')),
  // espeak 数据目录可能嵌套在 piper 目录里，也可能独立安装
  espeak: (p) =>
    fs.existsSync(path.join(p, 'espeak-ng-data')) ||
    (fs.existsSync(path.join(p, 'espeak-ng-data', 'phondata')) ) ,
  kokoro: (p) =>
    fs.existsSync(path.join(p, 'kokoro-v1.0.onnx')) &&
    fs.existsSync(path.join(p, 'voices-v1.0.bin')) &&
    // S3-13：config.json 里的 vocab 是 tokenize 的必需项
    fs.existsSync(path.join(p, 'config.json')),
  gptsovits: () => true,   // service 类型只校验 URL，不校验路径
  cosyvoice: () => true,
};

export function specOf(id: string): ComponentSpec | undefined {
  return COMPONENT_SPECS.find((s) => s.id === id);
}

/**
 * 检测一个组件。
 * service 类型只检查 URL 可达性由上层负责，这里只做格式校验。
 */
export function detect(id: string, configuredPath: string | null): ComponentState {
  const spec = specOf(id);
  if (!spec) return { id, path: configuredPath, status: 'invalid', detail: '未知组件' };

  if (spec.kind === 'service') {
    if (!configuredPath) return { id, path: null, status: 'unconfigured', detail: '未填写服务地址' };
    const ok = /^https?:\/\/[^\s]+$/.test(configuredPath);
    return { id, path: configuredPath, status: ok ? 'ready' : 'invalid', detail: ok ? '已配置（未探活）' : '地址格式不正确' };
  }

  if (!configuredPath) return { id, path: null, status: 'unconfigured', detail: '未指定安装位置' };

  try {
    if (!fs.existsSync(configuredPath)) {
      return { id, path: configuredPath, status: 'missing', detail: '路径不存在' };
    }
    const det = DETECTORS[id];
    if (det && !det(configuredPath)) {
      return { id, path: configuredPath, status: 'invalid', detail: '目录里找不到该组件的特征文件' };
    }
    return { id, path: configuredPath, status: 'ready', detail: '已就绪' };
  } catch (e) {
    return { id, path: configuredPath, status: 'invalid', detail: String(e) };
  }
}

/**
 * 常见安装位置候选（引导页可直接「一键探测」）。
 * 只读检查，不写系统任何位置。
 */
export function candidatePaths(id: string, appRoot: string, userDataDir: string): string[] {
  const out: string[] = [];
  const push = (p: string) => { if (p && !out.includes(p)) out.push(p); };
  const vendorDir = path.join(appRoot, 'vendor-voice');

  switch (id) {
    case 'piper':
      push(path.join(vendorDir, 'piper'));
      push(path.join(appRoot, 'resources', 'piper'));
      push(path.join(userDataDir, 'components', 'piper'));
      break;
    case 'espeak':
      push(path.join(vendorDir, 'piper'));                 // 与 piper 同目录
      push(path.join(appRoot, 'resources', 'piper'));
      push(path.join(userDataDir, 'components', 'espeak'));
      push('C:\\Program Files\\eSpeak NG');
      push('C:\\Program Files (x86)\\eSpeak NG');
      break;
    case 'kokoro':
      push(path.join(vendorDir, 'kokoro'));
      push(path.join(appRoot, 'resources', 'kokoro'));
      push(path.join(userDataDir, 'components', 'kokoro'));
      break;
    default:
      break;
  }
  return out;
}

/** 自动探测：返回第一个命中的候选路径 */
export function autoDetectPath(id: string, candidates: string[]): string | null {
  const spec = specOf(id);
  if (!spec || spec.kind === 'service') return null;
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    const det = DETECTORS[id];
    if (!det || det(c)) return c;
  }
  return null;
}
