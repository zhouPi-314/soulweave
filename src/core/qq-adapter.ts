/*
 * SoulWeave S5：QQ 适配器下载与校验
 *
 * 【为什么不是「一键安装」】
 * 三个适配器（NapCat / SnowLuma / Lagrange）的许可证都限制再分发；
 * 更关键的是 NapCat 的一键包内含腾讯 QQ 客户端本身（307MB），
 * 那部分没有任何再分发授权。
 *
 * 所以这里做的是**用户批准的范围**：
 *   下载（官方源）+ 校验（哈希）+ 打开目录，但**不代装**。
 * 许可证文本会展示给用户，由用户自己决定是否使用。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export type AdapterId = 'napcat' | 'snowluma' | 'lagrange';

export interface AdapterDef {
  id: AdapterId;
  name: string;
  repo: string;
  /** 从 release assets 里挑哪个文件 */
  assetPattern: RegExp;
  /** 是否需要本机已装 QQ 客户端 */
  needsQqClient: boolean;
  /** 许可证一句话说明 */
  license: string;
  /** 给用户看的注意事项 */
  caution: string;
}

export const ADAPTERS: AdapterDef[] = [
  {
    id: 'napcat',
    name: 'NapCatQQ',
    repo: 'NapNeko/NapCatQQ',
    assetPattern: /NapCat\.Shell\.Windows\.OneKey\.zip$/i,
    needsQqClient: true,
    license: 'Limited Redistribution License（禁止商业使用）',
    caution: '非商业可再分发，需附完整许可；一键包内含 QQ 客户端，那部分不可再分发。',
  },
  {
    id: 'snowluma',
    name: 'SnowLuma',
    repo: 'SnowLuma/SnowLuma',
    assetPattern: /\.zip$/i,
    needsQqClient: true,
    license: 'Source-Available Non-Commercial（禁止商业使用，原生组件专有）',
    caution: '明确禁止并入付费产品；核心原生组件是专有的，不在开源许可范围。',
  },
  {
    id: 'lagrange',
    name: 'Lagrange.OneBot',
    repo: 'LagrangeDev/Lagrange.Core',
    assetPattern: /\.zip$/i,
    needsQqClient: false,
    license: '仓库未声明许可（默认保留所有权利）',
    caution: '纯协议实现，不需要 QQ 客户端；但仓库没有许可证文件，使用前请自行确认。',
  },
];

export interface ReleaseInfo {
  id: AdapterId;
  name: string;
  version: string;
  publishedAt: string;
  assetName: string;
  sizeBytes: number;
  downloadUrl: string;
  license: string;
  caution: string;
  needsQqClient: boolean;
  /** 上游是否提供校验文件 */
  hasChecksums: boolean;
}

const UA = { 'User-Agent': 'SoulWeave/1.7 (+https://github.com/)' };

/** 查某适配器的最新 release */
export async function fetchLatestRelease(id: AdapterId): Promise<{ ok: boolean; info?: ReleaseInfo; error?: string }> {
  const def = ADAPTERS.find((a) => a.id === id);
  if (!def) return { ok: false, error: '未知适配器: ' + id };
  try {
    const r = await fetch('https://api.github.com/repos/' + def.repo + '/releases/latest', {
      headers: UA, signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return { ok: false, error: 'GitHub API ' + r.status };
    const j: any = await r.json();
    const assets: any[] = Array.isArray(j.assets) ? j.assets : [];
    const pick = assets.find((a) => def.assetPattern.test(String(a.name || '')));
    if (!pick) return { ok: false, error: '这个版本没有可下载的包' };
    return {
      ok: true,
      info: {
        id: def.id, name: def.name,
        version: String(j.tag_name || ''),
        publishedAt: String(j.published_at || ''),
        assetName: String(pick.name),
        sizeBytes: Number(pick.size) || 0,
        downloadUrl: String(pick.browser_download_url),
        license: def.license,
        caution: def.caution,
        needsQqClient: def.needsQqClient,
        hasChecksums: assets.some((a) => /checksum|sha256/i.test(String(a.name || ''))),
      },
    };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 150) };
  }
}

/** 列出三个适配器的当前版本 */
export async function listAdapters(): Promise<ReleaseInfo[]> {
  const out: ReleaseInfo[] = [];
  for (const a of ADAPTERS) {
    const r = await fetchLatestRelease(a.id);
    if (r.ok && r.info) out.push(r.info);
  }
  return out;
}

export interface DownloadResult {
  ok: boolean;
  path?: string;
  sha256?: string;
  bytes?: number;
  error?: string;
}

/**
 * 下载适配器并计算 SHA-256。
 *
 * 只下载，不解压、不执行、不安装 —— 这是与「代装」的边界。
 */
export async function downloadAdapter(
  info: ReleaseInfo,
  destDir: string,
  onProgress?: (got: number, total: number) => void,
): Promise<DownloadResult> {
  try {
    fs.mkdirSync(destDir, { recursive: true });
    const target = path.join(destDir, info.assetName);
    const r = await fetch(info.downloadUrl, { headers: UA, signal: AbortSignal.timeout(600000) });
    if (!r.ok || !r.body) return { ok: false, error: '下载失败 HTTP ' + r.status };

    const total = Number(r.headers.get('content-length')) || info.sizeBytes || 0;
    const chunks: Buffer[] = [];
    let got = 0;
    const reader = (r.body as any).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const b = Buffer.from(value);
      chunks.push(b);
      got += b.length;
      onProgress?.(got, total);
    }
    const buf = Buffer.concat(chunks);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    fs.writeFileSync(target, buf);
    return { ok: true, path: target, sha256: sha, bytes: buf.length };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 180) };
  }
}

/** 校验一个已存在文件的哈希 */
export function verifyFile(filePath: string, expectedSha256: string): { ok: boolean; actual?: string; error?: string } {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在' };
    const h = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    return { ok: h.toLowerCase() === String(expectedSha256).toLowerCase(), actual: h };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 120) };
  }
}

/** 在系统文件管理器里打开所在目录（不执行任何文件） */
export function openFolder(dir: string): { ok: boolean; error?: string } {
  try {
    if (!fs.existsSync(dir)) return { ok: false, error: '目录不存在' };
    const child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 120) };
  }
}
