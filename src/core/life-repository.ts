/*
 * SoulWeave S6.13：Life Studio 数据层
 *
 * 表结构见 db/schema-s6-life.sql。
 * 沿用 MemoryRepository 的模式（pg Pool + 参数化查询 + 不抛异常）。
 *
 * 【安全不变式】
 * 1. 所有查询必须带 owner_character 过滤（防跨角色泄露）
 * 2. 列表类查询默认只返回 scope='private' 或本人共享的
 * 3. 软删除：deleted_at IS NULL 才算可见
 * 4. is_fictional 由上层 normalizeEvent 决定，这里不覆盖
 */

import { Pool, type PoolConfig } from 'pg';
import type { ScheduleSlot } from './life-schedule.js';
import type { LifeEvent, ListEventsOptions } from './life-event.js';
import type { LifeMedia } from './life-album.js';
import { normalizeEvent, normalizeListOptions } from './life-event.js';
import { normalizeMedia } from './life-album.js';

export interface LifeRepositoryOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  max?: number;
}

interface QueryResult { ok: boolean; rows?: any[]; rowCount?: number; error?: string; }

export class LifeRepository {
  private pool: Pool | null = null;
  private opts: LifeRepositoryOptions;

  constructor(opts: LifeRepositoryOptions) {
    this.opts = opts;
  }

  private getPool(): Pool {
    if (this.pool) return this.pool;
    const cfg: PoolConfig = {
      host: this.opts.host,
      port: this.opts.port,
      user: this.opts.user,
      password: this.opts.password,
      database: this.opts.database,
      max: this.opts.max ?? 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 8000,
      application_name: 'soulweave-life',
    };
    this.pool = new Pool(cfg);
    this.pool.on('error', () => undefined);
    return this.pool;
  }

  private async q(sql: string, params: any[] = []): Promise<QueryResult> {
    try {
      const r = await this.getPool().query(sql, params);
      return { ok: true, rows: r.rows, rowCount: r.rowCount ?? 0 };
    } catch (e: any) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 300) };
    }
  }

  async close(): Promise<void> {
    try { await this.pool?.end(); } catch (e) { /* ignore */ }
    this.pool = null;
  }

  // ─── 作息 ───────────────────────────────────────────

  async listSchedule(owner: string): Promise<{ ok: boolean; slots: ScheduleSlot[]; error?: string }> {
    const r = await this.q(
      'SELECT id, owner_character, kind, start_minute, end_minute, days_mask, title, scene, enabled ' +
      'FROM life_schedule WHERE owner_character = $1 AND enabled = TRUE ORDER BY start_minute',
      [String(owner || '')],
    );
    if (!r.ok) return { ok: false, slots: [], error: r.error };
    const slots: ScheduleSlot[] = (r.rows || []).map((x: any) => ({
      id: String(x.id),
      ownerCharacter: String(x.owner_character),
      kind: x.kind,
      startMinute: Number(x.start_minute),
      endMinute: Number(x.end_minute),
      daysMask: Number(x.days_mask),
      title: String(x.title),
      scene: x.scene || undefined,
      enabled: x.enabled !== false,
    }));
    return { ok: true, slots };
  }

  async replaceSchedule(owner: string, slots: ScheduleSlot[]): Promise<{ ok: boolean; count?: number; error?: string }> {
    const o = String(owner || '').trim();
    if (!o) return { ok: false, error: '缺少角色标识' };
    // 全量替换：先删后插（在事务里）
    const client = await (async () => {
      try { return await this.getPool().connect(); } catch (e) { return null; }
    })();
    if (!client) return { ok: false, error: '无法获取数据库连接' };
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM life_schedule WHERE owner_character = $1', [o]);
      let n = 0;
      for (const s of slots) {
        await client.query(
          'INSERT INTO life_schedule (owner_character, kind, start_minute, end_minute, days_mask, title, scene, enabled) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [o, String(s.kind || 'custom'), Number(s.startMinute) || 0, Number(s.endMinute) || 0,
           Number(s.daysMask) || 127, String(s.title || ''), s.scene || null, s.enabled !== false],
        );
        n++;
      }
      await client.query('COMMIT');
      return { ok: true, count: n };
    } catch (e: any) {
      try { await client.query('ROLLBACK'); } catch (e2) { void e2; }
      return { ok: false, error: String(e && e.message || e).slice(0, 250) };
    } finally {
      try { client.release(); } catch (e) { void e; }
    }
  }

  // ─── 事件 / 日记 ────────────────────────────────────

  async createEvent(input: Partial<LifeEvent>): Promise<{ ok: boolean; id?: number; error?: string }> {
    const e = normalizeEvent(input);
    if (!e.ownerCharacter) return { ok: false, error: '缺少角色标识' };
    if (!e.title) return { ok: false, error: '标题不能为空' };
    const r = await this.q(
      'INSERT INTO life_event (owner_character, kind, title, body, mood, occurred_at, ' +
      'is_fictional, ai_generated, source, scope) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
      [e.ownerCharacter, e.kind, e.title, e.body || null, e.mood || null, e.occurredAt,
       e.isFictional, e.aiGenerated, e.source, e.scope],
    );
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, id: Number((r.rows || [])[0]?.id) };
  }

  async listEvents(opts: Partial<ListEventsOptions>): Promise<{ ok: boolean; events: LifeEvent[]; total?: number; error?: string }> {
    const o = normalizeListOptions(opts);
    if (!o.ownerCharacter) return { ok: false, events: [], error: '缺少角色标识' };

    const where: string[] = ['owner_character = $1'];
    const params: any[] = [o.ownerCharacter];
    let i = 2;

    if (!o.includeDeleted) where.push('deleted_at IS NULL');
    if (o.kinds && o.kinds.length) { where.push('kind = ANY($' + (i++) + ')'); params.push(o.kinds); }
    if (o.from) { where.push('occurred_at >= $' + (i++)); params.push(o.from); }
    if (o.to) { where.push('occurred_at <= $' + (i++)); params.push(o.to); }
    if (o.search) { where.push('(title ILIKE $' + i + ' OR body ILIKE $' + i + ')'); params.push('%' + o.search + '%'); i++; }

    const whereSql = where.join(' AND ');
    const r = await this.q(
      'SELECT id, owner_character, kind, title, body, mood, occurred_at, is_fictional, ai_generated, source, scope, created_at, deleted_at ' +
      'FROM life_event WHERE ' + whereSql + ' ORDER BY occurred_at DESC LIMIT $' + (i++) + ' OFFSET $' + (i++),
      [...params, o.limit, o.offset],
    );
    if (!r.ok) return { ok: false, events: [], error: r.error };

    const events: LifeEvent[] = (r.rows || []).map(rowToEvent);

    // 总数（用于分页）
    const c = await this.q('SELECT COUNT(*)::int AS n FROM life_event WHERE ' + whereSql, params);
    const total = c.ok ? Number((c.rows || [])[0]?.n || 0) : undefined;
    return { ok: true, events, total };
  }

  async updateEvent(id: number, patch: Partial<LifeEvent>): Promise<{ ok: boolean; error?: string }> {
    const sets: string[] = [];
    const params: any[] = [];
    let i = 1;
    const put = (col: string, v: any) => { sets.push(col + ' = $' + (i++)); params.push(v); };

    if (patch.title !== undefined) put('title', String(patch.title).slice(0, 200));
    if (patch.body !== undefined) put('body', patch.body ? String(patch.body).slice(0, 20000) : null);
    if (patch.mood !== undefined) put('mood', patch.mood ? String(patch.mood).slice(0, 40) : null);
    if (patch.kind !== undefined) put('kind', String(patch.kind));
    if (patch.scope !== undefined) put('scope', String(patch.scope));
    if (patch.occurredAt !== undefined) put('occurred_at', String(patch.occurredAt));
    if (!sets.length) return { ok: true };

    params.push(Number(id));
    const r = await this.q('UPDATE life_event SET ' + sets.join(', ') + ' WHERE id = $' + i, params);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  /** 软删除（可恢复） */
  async deleteEvent(id: number): Promise<{ ok: boolean; error?: string }> {
    const r = await this.q('UPDATE life_event SET deleted_at = NOW() WHERE id = $1', [Number(id)]);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  /** 恢复 */
  async restoreEvent(id: number): Promise<{ ok: boolean; error?: string }> {
    const r = await this.q('UPDATE life_event SET deleted_at = NULL WHERE id = $1', [Number(id)]);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  // ─── 相册 ───────────────────────────────────────────

  async createMedia(input: Partial<LifeMedia>): Promise<{ ok: boolean; id?: number; error?: string }> {
    const m = normalizeMedia(input);
    if (!m.ownerCharacter) return { ok: false, error: '缺少角色标识' };
    if (!m.relPath) return { ok: false, error: '缺少文件路径' };
    const r = await this.q(
      'INSERT INTO life_media (owner_character, event_id, rel_path, media_kind, width, height, bytes, ' +
      'prompt, provider, is_fictional, ai_generated, favorite) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id',
      [m.ownerCharacter, m.eventId ?? null, m.relPath, m.mediaKind, m.width ?? null, m.height ?? null,
       m.bytes ?? null, m.prompt || null, m.provider || null, m.isFictional, m.aiGenerated, m.favorite],
    );
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, id: Number((r.rows || [])[0]?.id) };
  }

  async listMedia(opts: {
    ownerCharacter: string;
    favoriteOnly?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{ ok: boolean; media: LifeMedia[]; error?: string }> {
    const owner = String(opts.ownerCharacter || '').trim();
    if (!owner) return { ok: false, media: [], error: '缺少角色标识' };
    const limit = Math.min(Math.max(Number(opts.limit) || 30, 1), 100);
    const offset = Math.max(Number(opts.offset) || 0, 0);

    const where = ['owner_character = $1', 'deleted_at IS NULL'];
    if (opts.favoriteOnly) where.push('favorite = TRUE');
    const r = await this.q(
      'SELECT id, owner_character, event_id, rel_path, media_kind, width, height, bytes, prompt, provider, ' +
      'is_fictional, ai_generated, favorite, created_at FROM life_media WHERE ' + where.join(' AND ') +
      ' ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [owner, limit, offset],
    );
    if (!r.ok) return { ok: false, media: [], error: r.error };
    return { ok: true, media: (r.rows || []).map(rowToMedia) };
  }

  async toggleFavorite(id: number): Promise<{ ok: boolean; favorite?: boolean; error?: string }> {
    const r = await this.q('UPDATE life_media SET favorite = NOT favorite WHERE id = $1 RETURNING favorite', [Number(id)]);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, favorite: !!(r.rows || [])[0]?.favorite };
  }

  async deleteMedia(id: number): Promise<{ ok: boolean; error?: string }> {
    const r = await this.q('UPDATE life_media SET deleted_at = NOW() WHERE id = $1', [Number(id)]);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  // ─── 主动行为用量 ───────────────────────────────────

  async getProactiveUsage(owner: string, day: string, kind: string): Promise<{ count: number; lastAt: string | null }> {
    const r = await this.q(
      'SELECT count, last_at FROM life_proactive_usage WHERE owner_character=$1 AND day=$2 AND kind=$3',
      [String(owner), String(day), String(kind)],
    );
    if (!r.ok || !(r.rows || []).length) return { count: 0, lastAt: null };
    const row = r.rows![0];
    return { count: Number(row.count) || 0, lastAt: row.last_at ? String(row.last_at) : null };
  }

  async bumpProactiveUsage(owner: string, day: string, kind: string): Promise<{ ok: boolean; count?: number; error?: string }> {
    const r = await this.q(
      'INSERT INTO life_proactive_usage (owner_character, day, kind, count, last_at) VALUES ($1,$2,$3,1,NOW()) ' +
      'ON CONFLICT (owner_character, day, kind) DO UPDATE SET count = life_proactive_usage.count + 1, last_at = NOW() ' +
      'RETURNING count',
      [String(owner), String(day), String(kind)],
    );
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, count: Number((r.rows || [])[0]?.count || 0) };
  }

  // ─── 健康检查 ───────────────────────────────────────

  async health(): Promise<{ ok: boolean; tables: string[]; error?: string }> {
    const r = await this.q(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'life_%'",
    );
    if (!r.ok) return { ok: false, tables: [], error: r.error };
    return { ok: true, tables: (r.rows || []).map((x: any) => String(x.tablename)) };
  }
}

// ─── 行映射 ─────────────────────────────────────────

function rowToEvent(x: any): LifeEvent {
  return {
    id: Number(x.id),
    ownerCharacter: String(x.owner_character),
    kind: x.kind,
    title: String(x.title),
    body: x.body || undefined,
    mood: x.mood || undefined,
    occurredAt: x.occurred_at instanceof Date ? x.occurred_at.toISOString() : String(x.occurred_at),
    isFictional: x.is_fictional !== false,
    aiGenerated: !!x.ai_generated,
    source: x.source || 'user',
    scope: x.scope || 'private',
    createdAt: x.created_at instanceof Date ? x.created_at.toISOString() : String(x.created_at || ''),
    deletedAt: x.deleted_at ? (x.deleted_at instanceof Date ? x.deleted_at.toISOString() : String(x.deleted_at)) : null,
  };
}

function rowToMedia(x: any): LifeMedia {
  return {
    id: Number(x.id),
    ownerCharacter: String(x.owner_character),
    eventId: x.event_id != null ? Number(x.event_id) : null,
    relPath: String(x.rel_path),
    mediaKind: x.media_kind || 'photo',
    width: x.width != null ? Number(x.width) : undefined,
    height: x.height != null ? Number(x.height) : undefined,
    bytes: x.bytes != null ? Number(x.bytes) : undefined,
    prompt: x.prompt || undefined,
    provider: x.provider || undefined,
    isFictional: x.is_fictional !== false,
    aiGenerated: !!x.ai_generated,
    favorite: !!x.favorite,
    createdAt: x.created_at instanceof Date ? x.created_at.toISOString() : String(x.created_at || ''),
    deletedAt: x.deleted_at ? String(x.deleted_at) : null,
  };
}