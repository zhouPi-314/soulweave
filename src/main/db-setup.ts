/**
 * SoulWeave S4-0：数据库连接配置与初始化
 *
 * 【设计原则】
 * 1. 不引入新的 npm 依赖 —— 用本机已装的 psql 命令行完成检测、测试、初始化。
 * 2. 密码**只通过环境变量 PGPASSWORD 传给子进程**，不出现在命令行参数里，
 *    因此不会在任务管理器/进程列表里被看到。
 * 3. 密码**不写入任何配置文件、不打印到日志**。
 * 4. 初始化（建库）是**显式操作**，必须由用户在界面上点击，不自动执行。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface DbConn {
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
}

export interface DetectResult {
  ok: boolean;
  psqlPath?: string;
  version?: string;
  serviceRunning?: boolean;
  portListening?: boolean;
  serverVersion?: string;
  error?: string;
}

/** 常见 psql 安装位置 */
const PSQL_CANDIDATES = [
  'D:\\PostgreSQL\\18\\bin\\psql.exe',
  'C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe',
  'C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe',
  'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe',
];

export function findPsql(): string | null {
  for (const c of PSQL_CANDIDATES) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ }
  }
  return null;
}

/** 跑一次 psql，返回 stdout/stderr 与退出码。密码走 env，不进参数。 */
function runPsql(psql: string, conn: DbConn | null, args: string[], timeoutMs = 15000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const base = conn
      ? ['-h', conn.host, '-p', String(conn.port), '-U', conn.user, '-w']
      : ['-w'];
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (conn && conn.password) env.PGPASSWORD = conn.password;
    // 不继承可能干扰的 psql 变量
    delete env.PGSERVICE;
    delete env.PGPASSFILE;

    let child: any;
    try {
      child = spawn(psql, [...base, ...args], { env, windowsHide: true });
    } catch (e) {
      resolve({ code: -1, out: '', err: String(e) });
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* ignore */ } }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    child.on('close', (code: number) => { clearTimeout(timer); resolve({ code: code === null ? -1 : code, out, err }); });
    child.on('error', (e: Error) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); });
  });
}

/** 把 psql 的错误信息转成用户能看懂的话（不泄漏密码） */
function humanize(err: string): string {
  const s = String(err || '');
  if (/no password supplied/i.test(s)) return '需要密码：请填写密码后重试';
  if (/password authentication failed/i.test(s)) return '密码错误，或该用户不允许密码登录';
  if (/could not connect|Connection refused|ECONNREFUSED/i.test(s)) return '连不上服务器：确认 PostgreSQL 服务已启动、端口正确';
  if (/database .* does not exist/i.test(s)) return '数据库不存在（下一步会创建）';
  if (/timeout|ETIMEDOUT/i.test(s)) return '连接超时：检查主机地址与防火墙';
  return s.split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 300);
}

/** 检测本机环境（不需要密码） */
export async function detect(port = 5432): Promise<DetectResult> {
  const psql = findPsql();
  if (!psql) {
    return { ok: false, error: '未找到 psql.exe。请先安装 PostgreSQL，或在下方手动指定连接信息。' };
  }
  const out: DetectResult = { ok: true, psqlPath: psql };

  const ver = await runPsql(psql, null, ['--version']);
  if (ver.code === 0) out.version = ver.out.trim();

  // 端口是否在监听（用 psql 连一下最直接，失败也能说明服务状态）
  const probe = await runPsql(psql, { host: '127.0.0.1', port, user: 'postgres', password: '' }, ['-c', 'SELECT 1'], 5000);
  out.portListening = !/could not connect|Connection refused|ECONNREFUSED/i.test(probe.err);
  return out;
}

/** 测试连接（需要密码） */
export async function testConnection(conn: DbConn): Promise<{ ok: boolean; serverVersion?: string; database?: string; error?: string }> {
  const psql = findPsql();
  if (!psql) return { ok: false, error: '未找到 psql.exe' };
  if (!conn.password) return { ok: false, error: '请填写密码' };

  const r = await runPsql(psql, conn, ['-tAc', "SELECT version() || '|' || current_database()"]);
  if (r.code !== 0) return { ok: false, error: humanize(r.err) };
  const [serverVersion, database] = r.out.trim().split('|');
  return { ok: true, serverVersion, database };
}

/** 库是否已存在 */
export async function databaseExists(conn: DbConn, dbName: string): Promise<{ ok: boolean; exists: boolean; error?: string }> {
  const psql = findPsql();
  if (!psql) return { ok: false, exists: false, error: '未找到 psql.exe' };
  const r = await runPsql(psql, conn, ['-tAc', `SELECT 1 FROM pg_database WHERE datname = '${dbName.replace(/'/g, "''")}'`]);
  if (r.code !== 0) return { ok: false, exists: false, error: humanize(r.err) };
  return { ok: true, exists: r.out.trim() === '1' };
}

/** 表是否已建（判断 schema 是否已应用） */
export async function schemaApplied(conn: DbConn, dbName: string): Promise<{ ok: boolean; applied: boolean; tables?: string[]; error?: string }> {
  const psql = findPsql();
  if (!psql) return { ok: false, applied: false, error: '未找到 psql.exe' };
  const c = { ...conn, database: dbName };
  const r = await runPsql(psql, c, ['-d', dbName, '-tAc', "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"]);
  if (r.code !== 0) return { ok: false, applied: false, error: humanize(r.err) };
  const tables = r.out.split('\n').map((s) => s.trim()).filter(Boolean);
  return { ok: true, applied: tables.length > 0, tables };
}

/**
 * 初始化：建库 + 应用 schema。
 * **只在用户界面上显式点击时调用**，不自动执行。
 */
export async function initialize(conn: DbConn, dbName: string, schemaPath: string): Promise<{
  ok: boolean;
  created?: boolean;
  schemaApplied?: boolean;
  tables?: string[];
  error?: string;
}> {
  const psql = findPsql();
  if (!psql) return { ok: false, error: '未找到 psql.exe' };
  if (!conn.password) return { ok: false, error: '请先填写密码并测试连接' };

  // 1) 建库（幂等）
  const exists = await databaseExists(conn, dbName);
  if (!exists.ok) return { ok: false, error: exists.error };
  let created = false;
  if (!exists.exists) {
    const r = await runPsql(psql, conn, ['-c', `CREATE DATABASE "${dbName}"`]);
    if (r.code !== 0) return { ok: false, error: '建库失败：' + humanize(r.err) };
    created = true;
  }

  // 2) 应用 schema
  if (!fs.existsSync(schemaPath)) return { ok: false, created, error: 'schema.sql 不存在：' + schemaPath };
  const c2 = { ...conn, database: dbName };
  const r2 = await runPsql(psql, c2, ['-d', dbName, '-v', 'ON_ERROR_STOP=1', '-f', schemaPath], 60000);
  if (r2.code !== 0) return { ok: false, created, error: '应用 schema 失败：' + humanize(r2.err) };

  // 3) 回读表清单
  const after = await schemaApplied(conn, dbName);
  return { ok: true, created, schemaApplied: after.applied, tables: after.tables };
}

/**
 * 执行一个 SQL 文件（迁移用）。
 * 用 ON_ERROR_STOP=1，一旦出错立刻中止，不做部分应用。
 */
export async function applySqlFile(
  conn: DbConn,
  dbName: string,
  sqlPath: string
): Promise<{ ok: boolean; error?: string }> {
  const psql = findPsql();
  if (!psql) return { ok: false, error: '未找到 psql.exe' };
  if (!conn.password) return { ok: false, error: '缺少密码' };
  if (!fs.existsSync(sqlPath)) return { ok: false, error: 'SQL 文件不存在：' + sqlPath };
  const c = { ...conn, database: dbName };
  const r = await runPsql(psql, c, ['-d', dbName, '-v', 'ON_ERROR_STOP=1', '-f', sqlPath], 120000);
  if (r.code !== 0) return { ok: false, error: humanize(r.err) };
  return { ok: true };
}

/** 读某张表的列名（校验迁移结果用） */
export async function tableColumns(
  conn: DbConn, dbName: string, table: string
): Promise<{ ok: boolean; columns?: string[]; error?: string }> {
  const psql = findPsql();
  if (!psql) return { ok: false, error: '未找到 psql.exe' };
  const c = { ...conn, database: dbName };
  const r = await runPsql(psql, c, ['-d', dbName, '-tAc',
    "SELECT column_name FROM information_schema.columns WHERE table_name='" + table.replace(/'/g, "''") + "' ORDER BY ordinal_position"]);
  if (r.code !== 0) return { ok: false, error: humanize(r.err) };
  return { ok: true, columns: r.out.split('\n').map((s) => s.trim()).filter(Boolean) };
}
