/**
 * D58 角色保护测试
 *
 * 对应 03:119 Gate G：冰糖不可删、小橘子无永久删除入口、其他云端角色可删。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CharacterRegistry, CharacterError } from '../dist/core/character-registry.js';

test('D58-1: 只能有一个 local_dsh 角色', () => {
  const r = new CharacterRegistry();
  r.create({ kind: 'local_dsh', name: '冰糖' });

  assert.throws(
    () => r.create({ kind: 'local_dsh', name: '第二个本地角色' }),
    (e: any) => e.code === 'LOCAL_DSH_LIMIT'
  );
});

test('D58-1: local_dsh 必须是 fixed_protected', () => {
  const r = new CharacterRegistry();
  assert.throws(
    () => r.create({ kind: 'local_dsh', name: '冰糖', protection: 'normal' }),
    (e: any) => e.code === 'INVALID_KIND'
  );
});

test('D58-1: 冰糖不可移入回收站', () => {
  const r = new CharacterRegistry();
  const { bingtang } = r.ensureDefaults();

  assert.equal(bingtang.protection, 'fixed_protected');
  assert.throws(
    () => r.trash(bingtang.id),
    (e: any) => e.code === 'PROTECTED_CANNOT_DELETE'
  );
});

test('D58-1: 冰糖不可永久删除', () => {
  const r = new CharacterRegistry();
  const { bingtang } = r.ensureDefaults();

  assert.throws(
    () => r.purge(bingtang.id),
    (e: any) => e.code === 'PROTECTED_CANNOT_DELETE'
  );
});

test('D58-2: 小橘子是 default_protected', () => {
  const r = new CharacterRegistry();
  const { xiaojuzi } = r.ensureDefaults();

  assert.equal(xiaojuzi.protection, 'default_protected');
  assert.equal(xiaojuzi.kind, 'cloud_api');
});

test('D58-2: 小橘子可移入回收站', () => {
  const r = new CharacterRegistry();
  const { xiaojuzi } = r.ensureDefaults();

  r.trash(xiaojuzi.id);
  assert.equal(r.get(xiaojuzi.id)!.state, 'trashed');

  // 可恢复
  r.restore(xiaojuzi.id);
  assert.equal(r.get(xiaojuzi.id)!.state, 'active');
});

test('D58-2: 小橘子首期无永久删除入口', () => {
  const r = new CharacterRegistry();
  const { xiaojuzi } = r.ensureDefaults();

  assert.throws(
    () => r.purge(xiaojuzi.id),
    (e: any) => e.code === 'PROTECTED_CANNOT_DELETE'
  );
});

test('D58-3: 其他云端角色可正常创建与删除', () => {
  const r = new CharacterRegistry();
  r.ensureDefaults();

  const c = r.create({ kind: 'cloud_api', name: '测试角色' });
  assert.equal(c.protection, 'normal');

  r.trash(c.id);
  assert.equal(r.get(c.id)!.state, 'trashed');

  r.purge(c.id);
  assert.equal(r.get(c.id), undefined);
});

test('D58: 停用/隐藏不等于删除', () => {
  const r = new CharacterRegistry();
  const { xiaojuzi } = r.ensureDefaults();

  r.sleep(xiaojuzi.id);
  assert.equal(r.get(xiaojuzi.id)!.state, 'sleeping');

  r.wake(xiaojuzi.id);
  assert.equal(r.get(xiaojuzi.id)!.state, 'active');

  // 数据仍在
  assert.ok(r.get(xiaojuzi.id));
});

test('D55: ensureDefaults 幂等', () => {
  const r = new CharacterRegistry();
  const a = r.ensureDefaults();
  const b = r.ensureDefaults();

  assert.equal(a.bingtang.id, b.bingtang.id);
  assert.equal(a.xiaojuzi.id, b.xiaojuzi.id);
  assert.equal(r.list().length, 2);
});
