/**
 * SoulWeave S9：审计的数据库落地（可选镜像）
 *
 * 【为什么是「镜像」而不是唯一来源】
 * 数据库连不上时恰恰最需要留证据，所以文件（audit.log）永远是主路径，
 * 数据库只做长期留存与跨会话查询。写库失败绝不影响对话，也不影响文件记录。
 *
 * 表结构与文件字段一一对应，方便两边对账。
 */

export type AuditRow = {
  at: number;
  kind: string;
  actor?: string;
  tool?: string;
  level?: number;
  target?: string;
  result?: string;
  detail?: string;
};

const DDL = [
  'CREATE TABLE IF NOT EXISTS audit_log (',
  '  id BIGSERIAL PRIMARY KEY,',
  '  at_ms BIGINT NOT NULL,',
  '  kind TEXT NOT NULL,',
  '  actor TEXT,',
  '  tool TEXT,',
  '  level INT,',
  '  target TEXT,',
  '  result TEXT,',
  '  detail TEXT',
  ');',
  'CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at_ms DESC);',
].join('\n');

/** 建表（幂等）。失败只返回错误，不抛。 */
export async function ensureAuditTable(repo: { exec: (sql: string, params?: any) => Promise<any> }): Promise<{ ok: boolean; error?: string }> {
  try {
    const r: any = await repo.exec(DDL);
    return { ok: !!(r && r.ok), error: r && r.error };
  } catch (e) { return { ok: false, error: String(e).slice(0, 200) }; }
}

function sqlStr(v: string | undefined): string {
  if (v === undefined || v === null) return 'NULL';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

/** 插入一条。调用方应 fire-and-forget，不要 await 在对话主路径上。 */
export async function insertAudit(
  repo: { exec: (sql: string, params?: any) => Promise<any> },
  row: AuditRow
): Promise<{ ok: boolean; error?: string }> {
  try {
    const sql = 'INSERT INTO audit_log (at_ms, kind, actor, tool, level, target, result, detail) VALUES (' +
      [
        String(Math.trunc(row.at)),
        sqlStr(row.kind),
        sqlStr(row.actor),
        sqlStr(row.tool),
        row.level === undefined ? 'NULL' : String(Math.trunc(row.level)),
        sqlStr(row.target),
        sqlStr(row.result),
        sqlStr(row.detail),
      ].join(', ') + ')';
    const r: any = await repo.exec(sql);
    return { ok: !!(r && r.ok), error: r && r.error };
  } catch (e) { return { ok: false, error: String(e).slice(0, 200) }; }
}

/** 按条件查最近若干条（给维护/权限面板做跨会话回看） */
export async function queryAudit(
  repo: { exec: (sql: string, params?: any) => Promise<any> },
  opts: { limit?: number; kind?: string; sinceMs?: number } = {}
): Promise<{ ok: boolean; rows?: AuditRow[]; error?: string }> {
  try {
    const limit = Math.max(1, Math.min(2000, opts.limit ?? 100));
    const where: string[] = [];
    if (opts.kind) where.push('kind = ' + sqlStr(opts.kind));
    if (opts.sinceMs) where.push('at_ms >= ' + String(Math.trunc(opts.sinceMs)));
    const sql = 'SELECT at_ms, kind, actor, tool, level, target, result, detail FROM audit_log' +
      (where.length ? (' WHERE ' + where.join(' AND ')) : '') +
      ' ORDER BY at_ms DESC LIMIT ' + limit;
    const r: any = await repo.exec(sql);
    if (!r || !r.ok) return { ok: false, error: r && r.error };
    const rows: AuditRow[] = (r.rows || []).map((x: any) => ({
      at: Number(x.at_ms) || 0,
      kind: String(x.kind || ''),
      actor: x.actor == null ? undefined : String(x.actor),
      tool: x.tool == null ? undefined : String(x.tool),
      level: x.level == null ? undefined : Number(x.level),
      target: x.target == null ? undefined : String(x.target),
      result: x.result == null ? undefined : String(x.result),
      detail: x.detail == null ? undefined : String(x.detail),
    }));
    return { ok: true, rows };
  } catch (e) { return { ok: false, error: String(e).slice(0, 200) }; }
}
