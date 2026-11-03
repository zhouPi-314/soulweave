import fs from 'node:fs';
import path from 'node:path';

/**
 * D57.12 / D57.13 / D57.14：桌面端读取官网公告与版本信息
 *
 * 三条硬要求，决定了这里每一处写法：
 * 1. **失败要能降级**（D57.12）：网络断了就用本地缓存；缓存也没有就老实说"没拿到"，
 *    不能让首页因为官网挂了而白屏。
 * 2. **外部内容必须安全渲染**（D57.13）：只接受纯文本字段，主动剥掉 HTML 标签，
 *    限制长度，链接只允许 https 与站内相对路径。桌面端绝不 innerHTML 这段内容。
 * 3. **镜像/网络错误要给人话**（D57.14）：区分"没网""超时""返回格式不对"。
 */

export type AnnouncementLevel = 'dev' | 'fix' | 'release' | 'notice';
export interface Announcement { date: string; level: AnnouncementLevel; title: string; body: string; url?: string }
export interface LatestInfo { version: string; date?: string; sizeText?: string; notes?: string }

export const DEFAULT_SITE_URL = 'https://singulift.github.io/soulweave';

/** 站点地址：环境变量 > userData/site-feed.json > 发布默认 */
export function resolveSiteUrl(userDataDir: string): { url: string; source: 'env' | 'file' | 'default' } {
  const env = String(process.env.SOULWEAVE_SITE_URL || '').trim().replace(/\/+$/, '');
  if (env) return { url: env, source: 'env' };
  try {
    const f = path.join(userDataDir, 'site-feed.json');
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8') || '{}');
      const u = String(j && j.url || '').trim().replace(/\/+$/, '');
      if (u) return { url: u, source: 'file' };
    }
  } catch (e) { /* ignore */ }
  return { url: DEFAULT_SITE_URL, source: 'default' };
}

const MAX_TEXT = 500;

/** 外部文本 → 安全的纯文本：去标签、去控制字符、限长。 */
export function sanitizeText(input: unknown, max = MAX_TEXT): string {
  let s = String(input == null ? '' : input);
  // 去掉 <script>/<style> 整段，再剥掉其余标签 —— 顺序不能反
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<[^>]*>/g, ' ');
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, max);
}

/** 链接只允许 https 与站内相对路径，挡掉 javascript:/data:/file: */
export function sanitizeUrl(input: unknown): string | undefined {
  const s = String(input == null ? '' : input).trim();
  if (!s) return undefined;
  if (/^https:\/\/[^\s]+$/i.test(s)) return s;
  if (/^\/(?!\/)[^\s]*$/.test(s)) return s;
  if (/^[a-z0-9][a-z0-9._-]*\.html([?#][^\s]*)?$/i.test(s)) return s;
  return undefined;
}

function validDate(s: unknown): string {
  const v = sanitizeText(s, 20);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
}

export function parseAnnouncements(raw: any): Announcement[] {
  const items = raw && Array.isArray(raw.items) ? raw.items : [];
  const out: Announcement[] = [];
  for (const it of items.slice(0, 50)) {
    const title = sanitizeText(it && it.title, 120);
    if (!title) continue;
    const level = ['dev', 'fix', 'release', 'notice'].includes(String(it && it.level)) ? String(it.level) as AnnouncementLevel : 'notice';
    out.push({
      date: validDate(it && it.date),
      level,
      title,
      body: sanitizeText(it && it.body, 400),
      url: sanitizeUrl(it && it.url),
    });
  }
  return out;
}

export function parseLatest(raw: any): LatestInfo | null {
  const version = sanitizeText(raw && raw.version, 40);
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/.test(version)) return null;
  return {
    version,
    date: validDate(raw && raw.date) || undefined,
    sizeText: sanitizeText(raw && raw.sizeText, 40) || undefined,
    notes: sanitizeUrl(raw && raw.notes),
  };
}

function cachePath(userDataDir: string, kind: string): string {
  return path.join(userDataDir, 'site-cache', kind + '.json');
}

function readCache(userDataDir: string, kind: string): { data: any; fetchedAt: string } | null {
  try {
    const f = cachePath(userDataDir, kind);
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!j || typeof j.fetchedAt !== 'string') return null;
    return { data: j.data, fetchedAt: j.fetchedAt };
  } catch (e) { return null; }
}

function writeCache(userDataDir: string, kind: string, data: any): void {
  try {
    const f = cachePath(userDataDir, kind);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ fetchedAt: new Date().toISOString(), data }, null, 2), 'utf8');
  } catch (e) { /* 缓存写不进去不影响主流程 */ }
}

async function fetchJson(url: string, timeoutMs = 6000): Promise<{ ok: boolean; json?: any; error?: string; degraded?: 'network' | 'timeout' | 'http' | 'format' }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } } as any);
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status, degraded: 'http' };
    const txt = await r.text();
    try { return { ok: true, json: JSON.parse(txt) }; }
    catch (e) { return { ok: false, error: '返回内容不是 JSON', degraded: 'format' }; }
  } catch (e: any) {
    const aborted = String(e && e.name) === 'AbortError';
    return { ok: false, error: aborted ? '请求超时' : '网络不可用', degraded: aborted ? 'timeout' : 'network' };
  } finally { clearTimeout(timer); }
}

export interface FeedResult<T> {
  ok: boolean;
  data?: T;
  stale?: boolean;
  fetchedAt?: string;
  error?: string;
  degraded?: 'network' | 'timeout' | 'http' | 'format';
  siteUrl: string;
  siteSource: 'env' | 'file' | 'default';
}

export async function loadAnnouncements(userDataDir: string): Promise<FeedResult<Announcement[]>> {
  const site = resolveSiteUrl(userDataDir);
  const r = await fetchJson(site.url + '/data/announcements.json');
  if (r.ok) {
    const items = parseAnnouncements(r.json);
    if (items.length) {
      writeCache(userDataDir, 'announcements', r.json);
      return { ok: true, data: items, fetchedAt: new Date().toISOString(), siteUrl: site.url, siteSource: site.source };
    }
    return { ok: false, error: '公告格式无效', degraded: 'format', siteUrl: site.url, siteSource: site.source };
  }
  const cached = readCache(userDataDir, 'announcements');
  if (cached) {
    return { ok: true, data: parseAnnouncements(cached.data), stale: true, fetchedAt: cached.fetchedAt, error: r.error, degraded: r.degraded, siteUrl: site.url, siteSource: site.source };
  }
  return { ok: false, error: r.error, degraded: r.degraded, siteUrl: site.url, siteSource: site.source };
}

export async function loadLatest(userDataDir: string): Promise<FeedResult<LatestInfo>> {
  const site = resolveSiteUrl(userDataDir);
  const r = await fetchJson(site.url + '/data/latest.json');
  if (r.ok) {
    const latest = parseLatest(r.json);
    if (latest) {
      writeCache(userDataDir, 'latest', r.json);
      return { ok: true, data: latest, fetchedAt: new Date().toISOString(), siteUrl: site.url, siteSource: site.source };
    }
    return { ok: false, error: '版本信息格式无效', degraded: 'format', siteUrl: site.url, siteSource: site.source };
  }
  const cached = readCache(userDataDir, 'latest');
  if (cached) {
    const latest = parseLatest(cached.data);
    if (latest) return { ok: true, data: latest, stale: true, fetchedAt: cached.fetchedAt, error: r.error, degraded: r.degraded, siteUrl: site.url, siteSource: site.source };
  }
  return { ok: false, error: r.error, degraded: r.degraded, siteUrl: site.url, siteSource: site.source };
}
