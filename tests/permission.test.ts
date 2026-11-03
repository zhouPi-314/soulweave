/**
 * 权限引擎测试
 *
 * 核心验证：deny-by-default、L0–L5 分级、角色许可边界
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionEngine } from '../dist/core/permission-engine.js';

test('未知动作默认拒绝（deny-by-default）', () => {
  const e = new PermissionEngine();
  const d = e.evaluate({ action: 'totally.unknown.action', actorId: 'bingtang' });

  assert.equal(d.allowed, false);
  assert.equal(d.level, 'L5');
  assert.match(d.reason, /deny-by-default/);
});

test('L0 纯读动作无需审批', () => {
  const e = new PermissionEngine();
  for (const a of ['config.read', 'character.read', 'live2d.render']) {
    const d = e.evaluate({ action: a, actorId: 'bingtang' });
    assert.equal(d.allowed, true, a);
    assert.equal(d.level, 'L0', a);
    assert.equal(d.requiresApproval, false, a);
  }
});

test('L1 本机低风险无需审批', () => {
  const e = new PermissionEngine();
  const d = e.evaluate({ action: 'memory.write.private', actorId: 'bingtang' });
  assert.equal(d.allowed, true);
  assert.equal(d.level, 'L1');
  assert.equal(d.requiresApproval, false);
});

test('L2 共享记忆需要审批', () => {
  const e = new PermissionEngine();
  const d = e.evaluate({ action: 'memory.write.shared', actorId: 'bingtang' });
  assert.equal(d.allowed, true);
  assert.equal(d.level, 'L2');
  assert.equal(d.requiresApproval, true);
});

test('L3 shell 执行需要审批', () => {
  const e = new PermissionEngine();
  const d = e.evaluate({ action: 'shell.execute', actorId: 'bingtang' });
  assert.equal(d.allowed, true);
  assert.equal(d.level, 'L3');
  assert.equal(d.requiresApproval, true);
});

test('L4 QQ 发消息需要审批', () => {
  const e = new PermissionEngine();
  const d = e.evaluate({ action: 'qq.send.message', actorId: 'xiaojuzi' });
  assert.equal(d.allowed, true);
  assert.equal(d.level, 'L4');
  assert.equal(d.requiresApproval, true);
});

test('L5 密钥读取需要审批', () => {
  const e = new PermissionEngine();
  const d = e.evaluate({ action: 'secret.read', actorId: 'bingtang' });
  assert.equal(d.allowed, true);
  assert.equal(d.level, 'L5');
  assert.equal(d.requiresApproval, true);
});

test('最长前缀匹配：memory.write.shared 不会被 memory.write.private 抢走', () => {
  const e = new PermissionEngine();
  assert.equal(e.levelOf('memory.write.private'), 'L1');
  assert.equal(e.levelOf('memory.write.shared'), 'L2');
});

test('角色禁令优先于规则', () => {
  const e = new PermissionEngine({
    denies: { bingtang: ['qq.send'] },
  });
  const d = e.evaluate({ action: 'qq.send.message', actorId: 'bingtang' });
  assert.equal(d.allowed, false);
  assert.match(d.reason, /明确禁止/);
});

test('角色许可可豁免 L0-L3 的审批', () => {
  const e = new PermissionEngine({
    grants: { xiaojuzi: ['memory.write.shared'] },
  });
  const d = e.evaluate({ action: 'memory.write.shared', actorId: 'xiaojuzi' });
  assert.equal(d.allowed, true);
  assert.equal(d.requiresApproval, false);
});

test('角色许可不能豁免 L4/L5 审批', () => {
  const e = new PermissionEngine({
    grants: { bingtang: ['secret.read', 'qq.send.message'] },
  });

  const a = e.evaluate({ action: 'secret.read', actorId: 'bingtang' });
  assert.equal(a.requiresApproval, true, 'L5 不应被豁免');

  const b = e.evaluate({ action: 'qq.send.message', actorId: 'bingtang' });
  assert.equal(b.requiresApproval, true, 'L4 不应被豁免');
});

test('动作层级单调性：子动作不会比父动作更宽松', () => {
  const e = new PermissionEngine();
  const parent = e.levelOf('shell');
  const child = e.levelOf('shell.execute');
  // 父未定义 → L5；子定义为 L3
  assert.equal(parent, 'L5');
  assert.equal(child, 'L3');
});

test('规则表可列出（供 UI）', () => {
  const e = new PermissionEngine();
  const rules = e.listRules();
  assert.ok(rules.length > 15);
  assert.ok(rules.every(r => ['L0','L1','L2','L3','L4','L5'].includes(r.level)));
});
