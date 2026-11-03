/*
 * SoulWeave S6：内置素材包 —— 索引加载 + 选图算法
 *
 * 依据：01 需求 6.3「虚拟相册：按角色、时间、事件分类」
 *      01 需求 6.2「明确区分虚构/AI 生成内容与真实经历」
 *
 * 【选图算法】
 *   score = 0.45 × 活动匹配
 *         + 0.25 × 新鲜度（越久没用分越高）
 *         + 0.20 × 心情匹配
 *         + 0.10 × 随机
 *
 * 【边界处理】
 *   该角色无图     → 用 shared
 *   shared 也无     → 用全部（标注告警）
 *   pack.json 损坏  → 返回空索引 + 告警（上层降级到占位图）
 *   文件缺失       → 加载时跳过并计数，不影响其他条目
 */

import fs from 'node:fs';
import path from 'node:path';

// ─── 类型 ───────────────────────────────────────────

export interface PackItem {
  id: string;
  /** '冰糖' | '小橘子' | 'shared' */
  character: string;
  /** 相对素材包根目录的路径 */
  file: string;
  width?: number;
  height?: number;
  /** 活动类型标签（wake/work/meal/rest/sleep/activity/custom） */
  tags: string[];
  /** 心情标签 */
  mood?: string[];
  scene?: string;
  isFictional: boolean;
  aiGenerated: boolean;
}

export interface PackIndex {
  version: number;
  generatedAt?: string;
  rootDir: string;
  items: PackItem[];
  /** 加载时跳过的条数（文件缺失等） */
  broken: number;
  /** 加载警告 */
  warnings: string[];
}

export interface LoadOptions {
  /** 是否校验文件存在（默认 true；文件多时可关掉换速度） */
  verifyFiles?: boolean;
}

export interface SelectInput {
  character: string;
  /** 当前活动类型 */
  activityKind?: string;
  /** 当前心情 */
  mood?: string;
  /** 最近用过的 id（时间倒序） */
  recentIds?: string[];
  /** 注入随机源（测试用） */
  rand?: () => number;
}

export interface SelectResult {
  item: PackItem | null;
  /** 从哪个池子里选的 */
  pool: 'character' | 'shared' | 'all' | 'none';
  /** 打分详情（调试用） */
  score?: number;
}

// ─── 常量 ───────────────────────────────────────────

export const SCORE_WEIGHTS = {
  activity: 0.45,
  fresh: 0.25,
  mood: 0.20,
  random: 0.10,
} as const;

/** 最近使用窗口：排除后至少剩这么多张才真的排除 */
export const FRESH_MIN_POOL = 5;

export const SHARED_CHARACTER = 'shared';

// ─── 路径安全 ───────────────────────────────────────

/** 拒绝绝对路径和 .. 逃逸 */
export function isSafeRelPath(p: string): boolean {
  if (!p || typeof p !== 'string') return false;
  if (/^[a-zA-Z]:/.test(p)) return false;   // C: ...
  if (p.startsWith('/') || p.startsWith('\\')) return false;
  const norm = p.replace(/\\/g, '/');
  return !norm.split('/').includes('..');
}

// ─── 加载 ───────────────────────────────────────────

/**
 * 加载素材包索引。
 *
 * 永不抛异常：任何错误都转成 warnings + 空/部分索引。
 */
export function loadPack(rootDir: string, opts: LoadOptions = {}): PackIndex {
  const warnings: string[] = [];
  const verify = opts.verifyFiles !== false;
  const empty: PackIndex = { version: 0, rootDir, items: [], broken: 0, warnings };

  if (!rootDir) { warnings.push('未指定素材包目录'); return empty; }
  const manifest = path.join(rootDir, 'pack.json');
  if (!fs.existsSync(manifest)) {
    warnings.push('pack.json 不存在：' + manifest);
    return empty;
  }

  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  } catch (e) {
    warnings.push('pack.json 解析失败：' + String(e).slice(0, 120));
    return empty;
  }

  if (!raw || !Array.isArray(raw.items)) {
    warnings.push('pack.json 缺少 items 数组');
    return empty;
  }

  const items: PackItem[] = [];
  let broken = 0;
  const seen = new Set<string>();

  for (const r of raw.items) {
    if (!r || typeof r !== 'object') { broken++; continue; }
    const id = String(r.id || '').trim();
    const file = String(r.file || '').trim();
    if (!id || !file) { broken++; continue; }
    if (seen.has(id)) { warnings.push('重复 id：' + id); broken++; continue; }
    if (!isSafeRelPath(file)) { warnings.push('非法路径：' + file); broken++; continue; }

    if (verify) {
      const full = path.join(rootDir, file.replace(/\//g, path.sep));
      if (!fs.existsSync(full)) { warnings.push('文件缺失：' + file); broken++; continue; }
    }

    seen.add(id);
    items.push({
      id,
      character: String(r.character || SHARED_CHARACTER),
      file,
      width: r.width ? Number(r.width) : undefined,
      height: r.height ? Number(r.height) : undefined,
      tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
      mood: Array.isArray(r.mood) ? r.mood.map(String) : undefined,
      scene: r.scene ? String(r.scene) : undefined,
      // D46：默认虚构
      isFictional: r.isFictional === false ? false : true,
      aiGenerated: !!r.aiGenerated,
    });
  }

  if (broken > 0) warnings.push('跳过 ' + broken + ' 条无效记录');

  return {
    version: Number(raw.version) || 1,
    generatedAt: raw.generatedAt ? String(raw.generatedAt) : undefined,
    rootDir,
    items,
    broken,
    warnings,
  };
}

// ─── 分组 ───────────────────────────────────────────

export function groupByCharacter(index: PackIndex): Map<string, PackItem[]> {
  const m = new Map<string, PackItem[]>();
  for (const it of index.items) {
    const arr = m.get(it.character) || [];
    arr.push(it);
    m.set(it.character, arr);
  }
  return m;
}

export interface PackStats {
  total: number;
  byCharacter: Record<string, number>;
  broken: number;
  warnings: number;
}

export function packStats(index: PackIndex): PackStats {
  const byCharacter: Record<string, number> = {};
  for (const it of index.items) byCharacter[it.character] = (byCharacter[it.character] || 0) + 1;
  return { total: index.items.length, byCharacter, broken: index.broken, warnings: index.warnings.length };
}

// ─── 打分 ───────────────────────────────────────────

export interface ScoreDetail {
  activity: number;
  fresh: number;
  mood: number;
  random: number;
  total: number;
}

/** 单张图打分（导出便于测试） */
export function scoreItem(
  item: PackItem,
  input: SelectInput,
  randVal: number,
): ScoreDetail {
  const activity = input.activityKind && item.tags.includes(input.activityKind) ? 1 : 0;

  const recent = input.recentIds || [];
  const idx = recent.indexOf(item.id);
  const fresh = idx < 0 ? 1 : Math.max(0, 1 - (idx + 1) / 20);

  const mood = input.mood && item.mood && item.mood.includes(input.mood) ? 1 : 0;

  const total =
    SCORE_WEIGHTS.activity * activity +
    SCORE_WEIGHTS.fresh * fresh +
    SCORE_WEIGHTS.mood * mood +
    SCORE_WEIGHTS.random * randVal;

  return { activity, fresh, mood, random: randVal, total };
}

// ─── 选图 ───────────────────────────────────────────

/**
 * 按算法选一张图。
 *
 * 池子优先级：本角色 → shared → 全部。
 * 最近用过的在不影响可选性的前提下排除。
 */
export function selectImage(index: PackIndex, input: SelectInput): SelectResult {
  const rand = input.rand || Math.random;

  if (!index.items.length) {
    return { item: null, pool: 'none' };
  }

  // 池子退化
  let pool = index.items.filter((i) => i.character === input.character);
  let poolKind: SelectResult['pool'] = 'character';

  if (!pool.length) {
    pool = index.items.filter((i) => i.character === SHARED_CHARACTER);
    poolKind = 'shared';
  }
  if (!pool.length) {
    pool = index.items.slice();
    poolKind = 'all';
  }

  // 排除最近用过的（仅当剩余足够）
  const recent = new Set(input.recentIds || []);
  if (recent.size > 0) {
    const fresh = pool.filter((i) => !recent.has(i.id));
    if (fresh.length >= FRESH_MIN_POOL) pool = fresh;
  }

  if (!pool.length) {
    return { item: null, pool: poolKind };
  }

  // 打分取最高
  let best: PackItem | null = null;
  let bestScore = -1;
  for (const it of pool) {
    const s = scoreItem(it, input, rand());
    if (s.total > bestScore) { bestScore = s.total; best = it; }
  }

  return { item: best, pool: poolKind, score: bestScore };
}

// ─── 读取 ───────────────────────────────────────────

export interface ReadResult {
  ok: boolean;
  data?: Uint8Array;
  mime?: string;
  error?: string;
}

function mimeOf(file: string): string {
  const e = path.extname(file).toLowerCase();
  if (e === '.webp') return 'image/webp';
  if (e === '.png') return 'image/png';
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  if (e === '.gif') return 'image/gif';
  if (e === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

/** 读取素材文件内容。永不抛异常。 */
export function readPackItem(index: PackIndex, item: PackItem): ReadResult {
  try {
    if (!item || !item.file) return { ok: false, error: '条目为空' };
    if (!isSafeRelPath(item.file)) return { ok: false, error: '路径非法：' + item.file };
    const full = path.join(index.rootDir, item.file.replace(/\//g, path.sep));
    if (!fs.existsSync(full)) return { ok: false, error: '文件不存在：' + item.file };
    const buf = fs.readFileSync(full);
    if (!buf.length) return { ok: false, error: '文件为空：' + item.file };
    return { ok: true, data: new Uint8Array(buf), mime: mimeOf(item.file) };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 150) };
  }
}

// ─── 与 Provider 对接 ───────────────────────────────

/** 把 PackIndex 适配成 S6.7 的 bundled provider 的 pick 回调 */
export function makePicker(index: PackIndex) {
  return async (req: { prompt?: string }) => {
    // 从 prompt 里解析不出角色时用 shared
    const character = (req as any)?.character || SHARED_CHARACTER;
    const r = selectImage(index, {
      character,
      activityKind: (req as any)?.activityKind,
      mood: (req as any)?.mood,
      recentIds: (req as any)?.recentIds,
    });
    if (!r.item) return null;
    const item = r.item;
    return {
      id: item.id,
      mime: mimeOf(item.file),
      read: async () => {
        const rr = readPackItem(index, item);
        return rr.ok && rr.data ? rr.data : null;
      },
    };
  };
}
