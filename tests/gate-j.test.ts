/**
 * Gate J 验收测试
 *
 * 对应 03_SoulWeave_分阶段路线图与验收计划.md:119 的 11 个场景。
 * 这是 V1.7 的发布门禁，不是「已经通过」的证明。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskMachine, TaskMachineError } from '../dist/core/task-machine.js';
import type { TrustedTrigger } from '../dist/shared/types.js';

function trig(over: Partial<TrustedTrigger> = {}): TrustedTrigger {
  return {
    eventId: 'evt-' + Math.random().toString(36).slice(2),
    entry: 'desktop',
    sourceMessageId: 'msg-1',
    sessionBinding: 'sess-1',
    at: new Date(),
    ...over,
  };
}

// ① 用户指定两个角色分别答复，均免自主计数
test('Gate J ①: 直接任务中多角色分别答复不占自主额度', () => {
  const m = new TaskMachine();
  const t = m.createDirectTask({
    trigger: trig(),
    authorizedResponders: ['bingtang', 'xiaojuzi'],
  });

  assert.equal(m.authorizeSend(t.id, 'bingtang').kind, 'allow');
  m.commitSend(t.id, 'bingtang');
  assert.equal(m.authorizeSend(t.id, 'xiaojuzi').kind, 'allow');
  m.commitSend(t.id, 'xiaojuzi');

  // 直接任务的 globalQuota 是 Infinity，不受 1-30 限制
  assert.equal(t.globalQuota, Infinity);
  assert.equal(t.sentCount, 0); // 直接任务不计入自主计数
});

// ② 直接任务尚未结束时，第三角色 AI 自发插话必须计数
test('Gate J ②: 未授权角色插话被拒绝', () => {
  const m = new TaskMachine();
  const t = m.createDirectTask({
    trigger: trig(),
    authorizedResponders: ['bingtang', 'xiaojuzi'],
  });

  const r = m.authorizeSend(t.id, 'other-ai');
  assert.equal(r.kind, 'deny');
  assert.equal((r as any).code, 'NOT_AUTHORIZED_RESPONDER');
});

// ③ 模型伪造授权/任务状态无效
test('Gate J ③: 无触发来源不能创建任务', () => {
  const m = new TaskMachine();
  assert.throws(
    () => m.createDirectTask({
      trigger: { eventId: '', sourceMessageId: '', sessionBinding: '', entry: 'desktop', at: new Date() },
      authorizedResponders: ['bingtang'],
    }),
    (e: any) => e.code === 'NO_TRUSTED_TRIGGER'
  );
});

// ④ 讨论 N=1、6、30 边界正确，31 或 50 拒绝
test('Gate J ④: 讨论额度边界 1/6/30 通过，31/50 拒绝', () => {
  const m = new TaskMachine();

  for (const q of [1, 6, 30]) {
    const t = m.createDiscussionTask({ trigger: trig(), participants: ['a','b'], quota: q });
    assert.equal(t.globalQuota, q);
  }

  for (const q of [0, 31, 50]) {
    assert.throws(
      () => m.createDiscussionTask({ trigger: trig(), participants: ['a','b'], quota: q }),
      (e: any) => e.code === 'QUOTA_OUT_OF_RANGE'
    );
  }
});

// ⑤ 禁止自动拆成 30+20 或自动续轮
test('Gate J ⑤: 禁止自动拆分与自动续轮', () => {
  const m = new TaskMachine();
  const t = m.createDiscussionTask({ trigger: trig(), participants: ['a'], quota: 6 });

  // 用完额度
  for (let i = 0; i < 6; i++) {
    assert.equal(m.authorizeSend(t.id, 'a').kind, 'allow');
    m.commitSend(t.id, 'a');
  }
  assert.equal(t.state, 'completed');

  // 试图续轮
  assert.throws(
    () => m.attemptSelfExtend(t.id),
    (e: any) => e.code === 'CANNOT_SELF_EXTEND'
  );

  // 超限请求被拒
  assert.throws(
    () => m.createDiscussionTask({ trigger: trig(), participants: ['a'], quota: 50 }),
    (e: any) => e.code === 'QUOTA_OUT_OF_RANGE'
  );
});

// ⑥ 可信用户再次发起可创建新任务
test('Gate J ⑥: 用户再次发起可创建新任务', () => {
  const m = new TaskMachine();
  const t1 = m.createDiscussionTask({ trigger: trig(), participants: ['a'], quota: 6 });
  for (let i = 0; i < 6; i++) { m.commitSend(t1.id, 'a'); }
  assert.equal(t1.state, 'completed');

  // 新触发 → 新任务
  const t2 = m.createDiscussionTask({ trigger: trig(), participants: ['a'], quota: 6 });
  assert.notEqual(t1.id, t2.id);
  assert.equal(t2.state, 'active');
});

// ⑦ 串行重复提交不超额（注意：这不是并发测试）
test('Gate J ⑦: 同一任务串行重复提交不超额', () => {
  const m = new TaskMachine();
  const t = m.createDiscussionTask({ trigger: trig(), participants: ['a','b'], quota: 3 });

  m.commitSend(t.id, 'a');
  m.commitSend(t.id, 'b');
  m.commitSend(t.id, 'a');

  assert.equal(t.sentCount, 3);
  assert.equal(t.state, 'completed');
  const r = m.authorizeSend(t.id, 'b');
  assert.equal(r.kind, 'deny');
  assert.equal((r as any).code, 'QUOTA_EXHAUSTED');
});

// ⑧ 降低 N 立即停止未发送消息
test('Gate J ⑧: 降低额度立即阻止后续发送', () => {
  const m = new TaskMachine();
  const t = m.createDiscussionTask({ trigger: trig(), participants: ['a'], quota: 12 });

  for (let i = 0; i < 7; i++) { m.commitSend(t.id, 'a'); }
  assert.equal(t.sentCount, 7);

  // 模拟用户把上限从 12 降到 5
  t.globalQuota = 5;

  const r = m.authorizeSend(t.id, 'a');
  assert.equal(r.kind, 'deny');
  assert.equal((r as any).code, 'QUOTA_EXHAUSTED');
});

// ⑨ 用户普通直接问答不被 30 条讨论上限误限
test('Gate J ⑨: 普通问答不受讨论额度限制', () => {
  const m = new TaskMachine();
  const t = m.createDirectTask({
    trigger: trig(),
    authorizedResponders: ['bingtang'],
    stepsPerResponder: 50,   // 远超 30
  });

  // 50 次授权回复都应通过
  for (let i = 0; i < 50; i++) {
    assert.equal(m.authorizeSend(t.id, 'bingtang').kind, 'allow');
    m.commitSend(t.id, 'bingtang');
  }
  assert.equal(t.usedSteps['bingtang'], 50);
});

// ⑩ 人工停止/角色失败/任务过期有明确终态
test('Gate J ⑩: 停止/过期有确定终态', () => {
  const m = new TaskMachine();
  const t = m.createDiscussionTask({ trigger: trig(), participants: ['a'], quota: 6 });

  m.cancel(t.id);
  assert.equal(t.state, 'cancelled');
  assert.equal(m.authorizeSend(t.id, 'a').kind, 'deny');

  const t2 = m.createDiscussionTask({ trigger: trig(), participants: ['a'], quota: 6 });
  t2.expiresAt = new Date(Date.now() - 1000);  // 强制过期
  const r = m.authorizeSend(t2.id, 'a');
  assert.equal(r.kind, 'deny');
  assert.equal(t2.state, 'expired');
});

// ⑪ 复合指令：两个子目标分别归属
test('Gate J ⑪: 复合指令拆成直接+讨论两个子任务', () => {
  const m = new TaskMachine();
  const { direct, discussion, parentId } = m.createCompositeTask(
    trig(),
    { authorizedResponders: ['bingtang', 'xiaojuzi'] },
    { participants: ['bingtang', 'xiaojuzi'], quota: 6 }
  );

  // 两个子任务共享父 ID
  assert.equal(direct.parentTaskId, parentId);
  assert.equal(discussion.parentTaskId, parentId);

  // 归属不同
  assert.equal(direct.origin, 'user_direct');
  assert.equal(discussion.origin, 'user_requested_discussion');

  // 直接部分不占讨论额度
  m.commitSend(direct.id, 'bingtang');
  m.commitSend(direct.id, 'xiaojuzi');
  assert.equal(discussion.sentCount, 0);

  // 讨论部分单独计
  m.commitSend(discussion.id, 'bingtang');
  assert.equal(discussion.sentCount, 1);
});
