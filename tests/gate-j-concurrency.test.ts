/**
 * Gate J 真并发测试
 *
 * 对应 03_SoulWeave_分阶段路线图与验收计划.md:119 Gate J ⑦：
 *   「三端并发、重试、重复消息与拆分不超额」
 *
 * 与 gate-j.test.ts ⑦ 的区别：
 *   旧 ⑦ = 串行 3 次调用（无竞争）
 *   本文件 = 并发 + 异步间隙（真竞争）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskMachine } from '../dist/core/task-machine.js';
import type { TrustedTrigger } from '../dist/shared/types.js';

function trig(): TrustedTrigger {
  return {
    eventId: 'evt-' + Math.random().toString(36).slice(2),
    entry: 'desktop',
    sourceMessageId: 'msg-1',
    sessionBinding: 'sess-1',
    at: new Date(),
  };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── 两段式在并发下的真实行为（修正了我原先的假设）──────
//
// 我原本假设 authorize()+await+commit() 会 TOCTOU 超额。
// 实测证明【不会】：commitSend() 内部会重新调用 authorizeSend() 校验，
// 超额时抛 TaskMachineError('QUOTA_EXHAUSTED')。
//
// 所以两段式是安全的，但缺点是把「额度不足」表达成异常，
// 调用方必须 try/catch；而 reserve() 用返回值表达，更适合并发批量调用。

test('两段式并发：不会超额，但用异常表达失败', async () => {
  const m = new TaskMachine();
  const t = m.createDiscussionTask({ trigger: trig(), participants: ['a'], quota: 3 });

  async function twoPhaseSend(): Promise<'ok' | 'denied' | 'threw'> {
    const v = m.authorizeSend(t.id, 'a');
    if (v.kind === 'deny') return 'denied';
    await sleep(5);                       // I/O 间隙
    try {
      m.commitSend(t.id, 'a');            // ← 内部会再次校验
      return 'ok';
    } catch {
      return 'threw';                     // 超额时抛错，不是静默超额
    }
  }

  const results = await Promise.all(
    Array.from({ length: 10 }, () => twoPhaseSend())
  );
  const ok = results.filter(r => r === 'ok').length;
  const threw = results.filter(r => r === 'threw').length;

  // 关键：成功数严格等于配额，绝不超额
  assert.equal(ok, 3, '两段式成功数必须等于配额（实际 ' + ok + '）');
  assert.ok(threw > 0, '超额请求应以异常形式暴露，而不是静默通过');
  assert.equal(t.sentCount, 3);
  console.log('    → 两段式：成功 ' + ok + ' / 抛错 ' + threw + '，未超额 ✅（失败以异常表达）');
});

// ── 正例：reserve 原子预留在并发下不超额 ──────────────

test('并发正例：reserve 原子预留严格不超额', async () => {
  const m = new TaskMachine();
  const t = m.createDiscussionTask({ trigger: trig(), participants: ['a','b'], quota: 3 });

  async function atomicSend(charId: string) {
    const r = m.reserve(t.id, charId);       // 检查+扣减，无 await 间隙
    if (!r.ok) return false;
    await sleep(5);                          // 之后才做真正的发送 I/O
    return true;
  }

  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => atomicSend(i % 2 ? 'a' : 'b'))
  );
  const succeeded = results.filter(Boolean).length;

  assert.equal(succeeded, 3, '原子预留必须严格等于配额');
  assert.equal(t.sentCount, 3);
  assert.equal(t.state, 'completed');
  console.log('    → reserve 并发成功 ' + succeeded + ' 次，配额 3，未超额 ✅');
});

// ── 重复投递幂等 ──────────────────────────────────────

// 【C4 口径纠正 2026-10-27】原名「并发重复投递：同一 character 大量并发只消耗配额」。
// 该名称容易被读成「重复消息幂等」，但本用例并未使用任何外部消息 ID / 幂等键，
// 只证明并发预留不会突破额度。故改名，并在断言旁注明边界。
// 外部消息幂等（相同 external_msg_id 只发一次）尚未实现，归入 S5。
test('并发预留不超额（非幂等验证）', async () => {
  const m = new TaskMachine();
  const t = m.createDiscussionTask({ trigger: trig(), participants: ['a'], quota: 5 });

  const results = await Promise.all(
    Array.from({ length: 50 }, async () => {
      const r = m.reserve(t.id, 'a');
      if (!r.ok) return false;
      await sleep(2);
      return true;
    })
  );

  assert.equal(results.filter(Boolean).length, 5);
  assert.equal(t.sentCount, 5);

  // 【边界】本用例不验证幂等：未传入任何幂等键，无法证明「同一外部消息只发一次」。
  // 幂等实现与 QQ 端到端重复消息防护归入 S5 集成验收。
});

// ── 跨任务不互相影响 ──────────────────────────────────

test('并发多任务：各自额度独立结算', async () => {
  const m = new TaskMachine();
  const tasks = [
    m.createDiscussionTask({ trigger: trig(), participants: ['a'], quota: 2 }),
    m.createDiscussionTask({ trigger: trig(), participants: ['a'], quota: 3 }),
    m.createDiscussionTask({ trigger: trig(), participants: ['a'], quota: 4 }),
  ];

  await Promise.all(
    tasks.flatMap((tk, ti) =>
      Array.from({ length: 10 }, async () => {
        const r = m.reserve(tk.id, 'a');
        if (!r.ok) return;
        await sleep(3);
      })
    )
  );

  assert.equal(tasks[0].sentCount, 2);
  assert.equal(tasks[1].sentCount, 3);
  assert.equal(tasks[2].sentCount, 4);
});

// ── 动态降额在并发中生效 ──────────────────────────────

test('并发中动态降额：降额后未发送的不再放行', async () => {
  const m = new TaskMachine();
  const t = m.createDiscussionTask({ trigger: trig(), participants: ['a'], quota: 10 });

  // 先预留 4 个
  for (let i = 0; i < 4; i++) assert.equal(m.reserve(t.id, 'a').ok, true);
  assert.equal(t.sentCount, 4);

  // 降到 3
  t.globalQuota = 3;

  // 再并发请求 10 次，应该全部被拒
  const results = await Promise.all(
    Array.from({ length: 10 }, async () => {
      const r = m.reserve(t.id, 'a');
      if (!r.ok) return false;
      await sleep(2);
      return true;
    })
  );
  assert.equal(results.filter(Boolean).length, 0, '降额后不应再放行');
});

// ── 直接任务并发不互相挤占 ────────────────────────────

test('直接任务并发：每个角色独立步数', async () => {
  const m = new TaskMachine();
  const t = m.createDirectTask({
    trigger: trig(),
    authorizedResponders: ['bingtang', 'xiaojuzi'],
    stepsPerResponder: 2,
  });

  const results = await Promise.all(
    Array.from({ length: 20 }, async (_, i) => {
      const who = i % 2 ? 'bingtang' : 'xiaojuzi';
      const r = m.reserve(t.id, who);
      if (!r.ok) return false;
      await sleep(2);
      return true;
    })
  );

  assert.equal(results.filter(Boolean).length, 4, '两个角色各 2 步 = 4');
  assert.equal(t.usedSteps['bingtang'], 2);
  assert.equal(t.usedSteps['xiaojuzi'], 2);
  assert.equal(t.sentCount, 0, '直接任务不计入自主计数');
});

// ── 复核 3：更严苛的两段式交错（authorize 全部先跑完，再统一 commit）──
//
// 这是最坏情况的 TOCTOU 排列：N 个调用者同时通过检查，然后各自提交。
// 如果 commit 不再校验，就会超额。

test('复核3：N 个 authorize 全通过后再统一 commit，仍不超额', async () => {
  const m = new TaskMachine();
  const t = m.createDiscussionTask({ trigger: trig(), participants: ['a'], quota: 4 });

  // 阶段一：20 个调用者全部通过检查（此时 sentCount 还是 0）
  const passed: string[] = [];
  for (let i = 0; i < 20; i++) {
    const v = m.authorizeSend(t.id, 'a');
    if (v.kind === 'allow') passed.push('c' + i);
  }
  // 最坏情况：20 个都拿到 allow
  assert.equal(passed.length, 20, '授权检查阶段应全部通过（配额尚未消耗）');

  // 阶段二：统一提交
  let ok = 0, threw = 0;
  await Promise.all(passed.map(async () => {
    await sleep(1);
    try { m.commitSend(t.id, 'a'); ok++; } catch { threw++; }
  }));

  assert.equal(ok, 4, '最终只能成功 4 次（配额）');
  assert.equal(threw, 16, '其余必须以异常拒绝');
  assert.equal(t.sentCount, 4, '计数器不得超过配额');
  console.log('    → 20 个预授权 → 提交阶段 4 成功 / 16 拒绝，未超额 ✅');
});

test('复核3b：authorize 结果不能替代 commit 校验', async () => {
  const m = new TaskMachine();
  const t = m.createDiscussionTask({ trigger: trig(), participants: ['a'], quota: 2 });

  // 拿到两个 allow
  assert.equal(m.authorizeSend(t.id, 'a').kind, 'allow');
  assert.equal(m.authorizeSend(t.id, 'a').kind, 'allow');

  // 提交两次 → 用满
  m.commitSend(t.id, 'a');
  m.commitSend(t.id, 'a');
  assert.equal(t.sentCount, 2);

  // 再用之前"看似合法"的授权去提交，必须被拒
  assert.throws(() => m.commitSend(t.id, 'a'));
  console.log('    → 旧的 authorize 结果不能重复使用 ✅');
});

// ═══════════════════════════════════════════════════════════════
// G2-C1 回归测试（2026-10-27 授权 A-2）
//
// 覆盖：讨论任务的参与角色授权校验
// 缺陷背景：authorizeSend() 的讨论分支曾只判额度、不判 authorizedResponders
// ═══════════════════════════════════════════════════════════════

test('C1-1: 两名授权角色均可参与讨论并各自计入额度', async () => {
  const m = new TaskMachine();
  const t = m.createDiscussionTask({ trigger: trig(), participants: ['a', 'b'], quota: 4 });

  assert.equal(m.authorizeSend(t.id, 'a').kind, 'allow');
  m.commitSend(t.id, 'a');
  assert.equal(m.authorizeSend(t.id, 'b').kind, 'allow');
  m.commitSend(t.id, 'b');

  assert.equal(t.sentCount, 2, '两名授权角色各发一次，合计 2');
  assert.equal(t.state, 'active', '额度未用完，任务仍 active');
  console.log('    → 授权角色 a/b 均可发言，sentCount=2 ✅');
});

test('C1-2: 未授权第三角色被拒，且不消耗额度、不改变任务状态', async () => {
  const m = new TaskMachine();
  const t = m.createDiscussionTask({ trigger: trig(), participants: ['a', 'b'], quota: 4 });

  const before = { sentCount: t.sentCount, state: t.state };

  const v = m.authorizeSend(t.id, 'intruder');
  assert.equal(v.kind, 'deny');
  assert.equal(v.kind === 'deny' ? v.code : '', 'NOT_AUTHORIZED_RESPONDER');

  // 额度与状态未变
  assert.equal(t.sentCount, before.sentCount, '未授权发送不得消耗额度');
  assert.equal(t.state, before.state, '未授权发送不得改变任务状态');

  // reserve 也必须拒绝，且不扣减
  const r = m.reserve(t.id, 'intruder');
  assert.equal(r.ok, false);
  assert.equal(t.sentCount, 0, 'reserve 被拒后额度仍为 0');

  // commitSend 必须抛错，且不扣减
  assert.throws(() => m.commitSend(t.id, 'intruder'));
  assert.equal(t.sentCount, 0, 'commitSend 被拒后额度仍为 0');

  console.log('    → 未授权角色在 authorizeSend / reserve / commitSend 三条路径均被拒，额度保持 0 ✅');
});

test('C1-3: 授权角色仍受全局总额度限制（错误码不得混淆）', async () => {
  const m = new TaskMachine();
  const t = m.createDiscussionTask({ trigger: trig(), participants: ['a', 'b'], quota: 2 });

  m.commitSend(t.id, 'a');
  m.commitSend(t.id, 'b');
  assert.equal(t.sentCount, 2);
  assert.equal(t.state, 'completed');

  // 授权角色：额度耗尽
  const vAuth = m.authorizeSend(t.id, 'a');
  assert.equal(vAuth.kind, 'deny');
  assert.equal(vAuth.kind === 'deny' ? vAuth.code : '', 'QUOTA_EXHAUSTED', '授权角色应为额度错误');

  // 未授权角色：即使额度已耗尽，也必须报授权错误而非额度错误
  const vUnauth = m.authorizeSend(t.id, 'intruder');
  assert.equal(vUnauth.kind, 'deny');
  assert.equal(vUnauth.kind === 'deny' ? vUnauth.code : '', 'NOT_AUTHORIZED_RESPONDER',
    '未授权角色不得被误报为额度耗尽');

  console.log('    → 授权角色报 QUOTA_EXHAUSTED，未授权角色报 NOT_AUTHORIZED_RESPONDER，归因正确 ✅');
});

test('C1-4: 并发未授权路径不扣额度，随后授权角色仍可发满配额', async () => {
  const m = new TaskMachine();
  const t = m.createDiscussionTask({ trigger: trig(), participants: ['a'], quota: 3 });

  // 20 个未授权角色并发尝试
  const rs = await Promise.all(
    Array.from({ length: 20 }, async (_, i) => {
      await sleep(1);
      return m.reserve(t.id, 'intruder' + i);
    })
  );
  assert.equal(rs.filter(r => r.ok).length, 0, '未授权者全部失败');
  assert.equal(t.sentCount, 0, '额度未被消耗');

  // 授权角色仍可发满 3 次
  let ok = 0;
  for (let i = 0; i < 5; i++) {
    if (m.reserve(t.id, 'a').ok) ok++;
  }
  assert.equal(ok, 3, '授权角色仍可用满配额 3');
  assert.equal(t.sentCount, 3);

  console.log('    → 20 次未授权并发 0 成功、额度 0；随后授权角色恰好发满 3 ✅');
});

test('C1-5: 同一角色在直接任务与讨论任务的授权互不影响', async () => {
  const m = new TaskMachine();
  const direct = m.createDirectTask({
    trigger: trig(),
    authorizedResponders: ['a'],
    authorizedSteps: { a: 2 },
  });
  // b 未获直接任务授权
  const disc = m.createDiscussionTask({ trigger: trig(), participants: ['b'], quota: 3 });

  // a 在直接任务可发
  assert.equal(m.authorizeSend(direct.id, 'a').kind, 'allow');
  // a 在讨论任务（只邀请了 b）不可发
  const v = m.authorizeSend(disc.id, 'a');
  assert.equal(v.kind, 'deny');
  assert.equal(v.kind === 'deny' ? v.code : '', 'NOT_AUTHORIZED_RESPONDER');

  // b 在讨论任务可发
  assert.equal(m.authorizeSend(disc.id, 'b').kind, 'allow');

  assert.equal(disc.sentCount, 0, '讨论任务额度未被未授权者消耗');
  console.log('    → 直接任务授权与讨论任务授权相互独立 ✅');
});
