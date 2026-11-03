/*
 * SoulWeave S5：多实例端口自动分配
 *
 * 【为什么需要这个】
 * NapCat 的架构是「1 个 QQ 号 = 1 个 QQ 进程 = 1 个 NapCat 实例 = 1 套端口」。
 * 多角色（冰糖 + 小橘子）各绑一个 QQ，就需要 2 套端口，且不能冲突。
 *
 * 【端口约定】
 *   实例 0：HTTP 3000 / WS 3001
 *   实例 1：HTTP 3002 / WS 3003
 *   实例 N：HTTP 3000+2N / WS 3001+2N
 *
 * 【为什么按 +2 而不是 +1】
 * 每个实例要一对（HTTP + WS），+2 保证相邻实例不重叠，
 * 也留出了给人看的规律性（偶数 HTTP、奇数 WS）。
 *
 * 【WebUI 端口】
 * NapCat 的 WebUI 默认 6099，且是**全局单例**（同一份 NapCat 程序只有一个 WebUI）。
 * 多实例时只有第一个实例能占 6099，其余实例的 WebUI 需要不同端口。
 */

import net from 'node:net';

export interface PortPair {
  http: number;
  ws: number;
  webui: number;
}

export const PORT_BASE = { http: 3000, ws: 3001, webui: 6099 };

/** 第 index 个实例的默认端口（0 起） */
export function defaultPortsFor(index: number): PortPair {
  const i = Math.max(0, Math.floor(index));
  return {
    http: PORT_BASE.http + i * 2,
    ws: PORT_BASE.ws + i * 2,
    // WebUI 也是 +2，避免与 http/ws 撞
    webui: PORT_BASE.webui + i * 2,
  };
}

/** 检查一个端口是否空闲（能 bind 就说明空闲） */
export async function isPortFree(port: number, host = '127.0.0.1', timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    let done = false;
    const finish = (free: boolean) => {
      if (done) return;
      done = true;
      try { srv.close(); } catch (e) { void e; }
      resolve(free);
    };
    srv.once('error', () => finish(false));
    srv.once('listening', () => finish(true));
    const t = setTimeout(() => finish(false), timeoutMs);
    t.unref?.();
    try { srv.listen(port, host); } catch (e) { finish(false); }
  });
}

/**
 * 为一批实例分配端口。
 *
 * 策略：
 *   1. 优先用默认规则（3000+2i）
 *   2. 如果默认端口被占，往后找下一个空闲的（最多找 50 个）
 *   3. 已分配的端口不再分给别的实例（避免同批冲突）
 */
export async function allocatePorts(
  count: number,
  opts: { reserved?: number[]; host?: string } = {},
): Promise<PortPair[]> {
  const n = Math.max(0, Math.floor(count));
  const host = opts.host || '127.0.0.1';
  const used = new Set<number>(opts.reserved || []);
  const out: PortPair[] = [];

  const pickFree = async (start: number): Promise<number> => {
    for (let p = start; p < start + 100; p++) {
      if (used.has(p)) continue;
      if (p > 65535) break;
      if (await isPortFree(p, host)) {
        used.add(p);
        return p;
      }
    }
    // 实在找不到就返回 start（让上层报错，而不是静默用冲突端口）
    return start;
  };

  for (let i = 0; i < n; i++) {
    const d = defaultPortsFor(i);
    const http = await pickFree(d.http);
    const ws = await pickFree(Math.max(d.ws, http + 1));
    const webui = await pickFree(Math.max(d.webui, ws + 1));
    out.push({ http, ws, webui });
  }
  return out;
}

/** 给某个已存在的实例找下一个空闲端口（新增角色时用） */
export async function allocateNextPorts(
  existing: PortPair[],
  host = '127.0.0.1',
): Promise<PortPair> {
  const reserved: number[] = [];
  for (const p of existing) {
    reserved.push(p.http, p.ws, p.webui);
  }
  const [next] = await allocatePorts(1, { reserved, host });
  // 从已有实例的下一个索引开始试
  const startIdx = existing.length;
  const d = defaultPortsFor(startIdx);
  if (reserved.indexOf(d.http) < 0 && reserved.indexOf(d.ws) < 0 && reserved.indexOf(d.webui) < 0) {
    return next;
  }
  return next;
}

/**
 * 校验一组端口是否有冲突（给配置层用）。
 *
 * 纯函数，不探测实际占用，只查重复。
 */
export function validatePorts(list: PortPair[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const seen = new Map<number, string>();
  list.forEach((p, i) => {
    for (const [name, port] of [['HTTP', p.http], ['WS', p.ws], ['WebUI', p.webui]] as Array<[string, number]>) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        errors.push('实例 ' + i + ' 的 ' + name + ' 端口非法: ' + port);
        continue;
      }
      const key = String(port);
      if (seen.has(port)) {
        errors.push('端口 ' + port + ' 被 ' + seen.get(port) + ' 和 实例 ' + i + ' 的 ' + name + ' 同时占用');
      } else {
        seen.set(port, '实例 ' + i + ' 的 ' + name);
      }
    }
  });
  return { ok: errors.length === 0, errors };
}

/** 从 OneBot WS 地址反推实例序号（便于 UI 显示「这是第几个角色」） */
export function instanceIndexFromPort(wsPort: number): number {
  const delta = wsPort - PORT_BASE.ws;
  return delta >= 0 ? Math.floor(delta / 2) : -1;
}
