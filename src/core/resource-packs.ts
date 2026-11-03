/**
 * SoulWeave：资源包（按需下载）
 *
 * 【为什么要有这个】
 * 4.07 GB 的 SD1.5 权重不可能塞进 NSIS 安装包（32 位安装器上限 ~2 GB）。
 * 所以改为"安装包只带引擎，大资源首启/按需下载"，下载走下载中心，支持进度、断点、校验。
 *
 * 下载源：优先 SOULWEAVE_PACK_BASE（自建镜像），否则用 manifest 里的 URL。
 * 校验：下载后比对 sha256，不匹配就删文件并报错 —— 不把坏文件留给运行时。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface ResourcePack {
  id: 'sd15-model' | 'sdcpp' | 'whisper-base';
  name: string;
  hint: string;
  /** 相对 resources/ 的落点 */
  target: string;
  /** 期望字节数（用于进度与完整性检查） */
  bytes: number;
  sha256?: string;
  /** 文件名（单文件包）或 null（目录包） */
  file?: string;
}

export const PACKS: ResourcePack[] = [
  {
    id: 'sd15-model', name: '本地出图模型 SD1.5', hint: '4.07 GB · 离线出图，不消耗云端额度',
    target: 'models/sd15', bytes: 4_067_000_000, file: 'sd15-pruned-emaonly.safetensors',
  },
  {
    id: 'sdcpp', name: '本地出图引擎', hint: '84.7 MB · stable-diffusion.cpp + Vulkan 后端',
    target: 'sdcpp', bytes: 84_700_000,
  },
  {
    id: 'whisper-base', name: '语音识别模型（base）', hint: '约 142 MB · 离线转写',
    target: 'whisper-models', bytes: 142_000_000, file: 'ggml-base.bin',
  },
];

/** 打包版本的默认镜像地址（发布时换成真实域名即可，运行期可被覆盖） */
export const DEFAULT_PACK_BASE = 'https://download.singulift.dev/soulweave/packs';

/**
 * 解析资源包下载源。优先级：
 *   1. SOULWEAVE_PACK_BASE 环境变量（运维/CI 临时指向内网镜像）
 *   2. userData/pack-feed.json 的 url（用户或运维可改，不用重装）
 *   3. DEFAULT_PACK_BASE（发布默认值）
 * 返回值带 source，便于界面如实显示"当前用的是哪一级"。
 */
export function resolvePackBase(userDataDir: string, env: NodeJS.ProcessEnv = process.env): { url: string; source: 'env' | 'file' | 'default'; overridden: boolean } {
  const e = String(env.SOULWEAVE_PACK_BASE || '').trim().replace(/\/+$/, '');
  if (e) return { url: e, source: 'env', overridden: true };
  try {
    const f = path.join(userDataDir, 'pack-feed.json');
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8') || '{}');
      const u = String(j && j.url || '').trim().replace(/\/+$/, '');
      if (u) return { url: u, source: 'file', overridden: true };
    }
  } catch (e) { /* ignore */ }
  return { url: DEFAULT_PACK_BASE, source: 'default', overridden: false };
}

export function packInstalled(resourcesRoot: string, p: ResourcePack): boolean {
  const base = path.join(resourcesRoot, p.target);
  if (!p.file) return fs.existsSync(base) && fs.readdirSync(base).length > 0;
  const f = path.join(base, p.file);
  try { const st = fs.statSync(f); return st.size > 0; } catch (e) { return false; }
}

export interface DownloadProgress { received: number; total: number; done: boolean; error?: string }

/**
 * 流式下载到 .part，完成后校验并改名（断点：已存在 .part 时用 Range 续传）。
 */
export async function downloadPack(opts: {
  url: string; destFile: string; expectedBytes?: number; sha256?: string;
  onProgress?: (p: DownloadProgress) => void; signal?: AbortSignal;
}): Promise<{ ok: boolean; error?: string }> {
  const { url, destFile, expectedBytes, sha256, onProgress, signal } = opts;
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  const part = destFile + '.part';
  let start = 0;
  try { start = fs.statSync(part).size; } catch (e) { start = 0; }
  try {
    const r = await fetch(url, { headers: start ? { Range: 'bytes=' + start + '-' } : {}, signal } as any);
    if (!r.ok && r.status !== 206) return { ok: false, error: 'HTTP ' + r.status };
    const total = Number(r.headers.get('content-length') || 0) + start || (expectedBytes || 0);
    const stream = r.body as any;
    if (!stream || typeof stream.getReader !== 'function') return { ok: false, error: '响应不是流式数据' };
    const out = fs.createWriteStream(part, { flags: start ? 'a' : 'w' });
    const reader = stream.getReader();
    let received = start;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.write(Buffer.from(value));
      received += value.length;
      onProgress?.({ received, total, done: false });
    }
    await new Promise((res, rej) => out.end((e: any) => (e ? rej(e) : res(null))));
    if (expectedBytes && received < expectedBytes * 0.98) {
      return { ok: false, error: '下载不完整（' + received + '/' + expectedBytes + ' 字节），可重试续传' };
    }
    if (sha256) {
      const h = crypto.createHash('sha256');
      await new Promise((res, rej) => {
        const rs = fs.createReadStream(part);
        rs.on('data', (c) => h.update(c));
        rs.on('end', () => res(null));
        rs.on('error', rej);
      });
      if (h.digest('hex').toLowerCase() !== sha256.toLowerCase()) {
        try { fs.unlinkSync(part); } catch (e) { /* ignore */ }
        return { ok: false, error: '校验失败：文件损坏，已删除，请重试' };
      }
    }
    fs.renameSync(part, destFile);
    onProgress?.({ received, total, done: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}
