/**
 * 配置 Schema 测试
 *
 * 覆盖 V1.7 D52 / D54 的配置要求。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultConfig, validateConfig, exportSafeConfig, CONFIG_VERSION,
} from '../dist/shared/config-schema.js';

const base = () => createDefaultConfig({
  installRoot: 'C:\\Program Files\\SoulWeave',
  dataRoot: 'C:\\ProgramData\\SoulWeaveData',
  cacheRoot: 'C:\\ProgramData\\SoulWeaveCache',
  dshLauncherPath: 'C:\\DSH\\dsh.cmd',
  dshHomeDir: 'C:\\ProgramData\\SoulWeaveData\\.dsh',
});

test('默认配置通过校验', () => {
  const issues = validateConfig(base());
  const errors = issues.filter(i => i.severity === 'error');
  assert.deepEqual(errors, []);
});

test('默认自主额度是 6', () => {
  const c = base();
  assert.equal(c.autonomous.defaultQuota, 6);
});

test('自主额度超范围被拒绝', () => {
  const c = base();
  (c.autonomous as any).defaultQuota = 31;
  const errors = validateConfig(c).filter(i => i.severity === 'error');
  assert.ok(errors.some(e => e.path === 'autonomous.defaultQuota'));
});

test('自主额度 0 被拒绝', () => {
  const c = base();
  (c.autonomous as any).defaultQuota = 0;
  const errors = validateConfig(c).filter(i => i.severity === 'error');
  assert.ok(errors.some(e => e.path === 'autonomous.defaultQuota'));
});

test('场景额度超范围被拒绝', () => {
  const c = base();
  (c.autonomous.scenes as any).qq_group.quota = 50;
  const errors = validateConfig(c).filter(i => i.severity === 'error');
  assert.ok(errors.some(e => e.path.includes('qq_group')));
});

test('版本不匹配被拒绝', () => {
  const c = base();
  (c as any).version = 999;
  const errors = validateConfig(c).filter(i => i.severity === 'error');
  assert.ok(errors.some(e => e.path === 'version'));
});

test('缺少必填路径被拒绝', () => {
  const c = base();
  (c.paths as any).dataRoot = '';
  const errors = validateConfig(c).filter(i => i.severity === 'error');
  assert.ok(errors.some(e => e.path === 'paths.dataRoot'));
});

test('开发者路径触发警告而非错误', () => {
  const c = base();
  (c.paths as any).dataRoot = 'C:\\01_project\\soulweave\\data';
  const issues = validateConfig(c);
  const warns = issues.filter(i => i.severity === 'warning');
  assert.ok(warns.some(w => w.path === 'paths.dataRoot'));
  // 不应是 error
  assert.ok(!issues.some(i => i.severity === 'error' && i.path === 'paths.dataRoot'));
});

test('明文密钥被拒绝', () => {
  const c = base();
  (c as any).someKey = 'sk-abcdefghijklmnopqrstuvwxyz123456';
  const errors = validateConfig(c).filter(i => i.severity === 'error');
  assert.ok(errors.some(e => e.message.includes('明文 API 密钥')));
});

test('primary=local 但 localEnabled=false 触发警告', () => {
  const c = base();
  c.voice.primary = 'local';
  c.voice.localEnabled = false;
  const warns = validateConfig(c).filter(i => i.severity === 'warning');
  assert.ok(warns.some(w => w.path === 'voice.primary'));
});

test('唱歌开启但本地未启用触发警告', () => {
  const c = base();
  c.voice.singingEnabled = true;
  c.voice.localEnabled = false;
  const warns = validateConfig(c).filter(i => i.severity === 'warning');
  assert.ok(warns.some(w => w.path === 'voice.singingEnabled'));
});

test('QQ 启用但无 wsUrl 触发警告', () => {
  const c = base();
  c.qq.enabled = true;
  c.qq.wsUrl = null;
  const warns = validateConfig(c).filter(i => i.severity === 'warning');
  assert.ok(warns.some(w => w.path === 'qq.wsUrl'));
});

test('导出时清除密钥引用', () => {
  const c = base();
  c.secretRefs.deepseekApiKeyRef = 'keychain://soulweave/deepseek';
  const safe = exportSafeConfig(c);
  assert.equal(safe.secretRefs.deepseekApiKeyRef, null);
  assert.equal(safe.secretRefs.onlineTtsKeyRef, null);
  // 其他字段保留
  assert.equal(safe.autonomous.defaultQuota, 6);
});

test('默认不启用本地语音与唱歌（T4 方向）', () => {
  const c = base();
  assert.equal(c.voice.localEnabled, false);
  assert.equal(c.voice.singingEnabled, false);
  assert.equal(c.voice.primary, 'online');
});

test('默认不启用 QQ', () => {
  const c = base();
  assert.equal(c.qq.enabled, false);
});

// ─── S3-9：QQ 协议后端改为 OneBot v11 抽象 ───────────────
//
// 背景：NapCat / SnowLuma / Lagrange 都实现 OneBot v11，
// 应用只依赖该标准，不绑定具体实现（见 S3_09 评估）。

test('QQ 默认 backend 为 napcat，且默认端口包含 SnowLuma 的 5099', () => {
  const c = base();
  assert.equal(c.qq.backend, 'napcat');
  assert.ok(c.qq.probePorts.includes(5099));
  assert.equal(c.qq.httpUrl, null);
  assert.equal(c.qq.accessTokenRef, null);
});

test('QQ backend 非法值报错', () => {
  const c = base();
  (c.qq as any).backend = 'not-a-backend';
  const errs = validateConfig(c).filter(i => i.severity === 'error');
  assert.ok(errs.some(e => e.path === 'qq.backend'));
});

test('QQ wsUrl 协议不合法报错', () => {
  const c = base();
  c.qq.enabled = true;
  c.qq.wsUrl = 'http://127.0.0.1:3000';
  const errs = validateConfig(c).filter(i => i.severity === 'error');
  assert.ok(errs.some(e => e.path === 'qq.wsUrl'));
});

test('QQ httpUrl 合法值与非法值', () => {
  const ok = base();
  ok.qq.httpUrl = 'http://127.0.0.1:5700';
  assert.equal(validateConfig(ok).filter(i => i.path === 'qq.httpUrl' && i.severity === 'error').length, 0);

  const bad = base();
  bad.qq.httpUrl = 'ftp://x';
  assert.ok(validateConfig(bad).some(i => i.path === 'qq.httpUrl' && i.severity === 'error'));
});

test('QQ accessTokenRef 空字符串报错（未使用应为 null）', () => {
  const c = base();
  c.qq.accessTokenRef = '';
  const errs = validateConfig(c).filter(i => i.severity === 'error');
  assert.ok(errs.some(e => e.path === 'qq.accessTokenRef'));
});

test('QQ 三种后端都能通过校验（不绑定实现）', () => {
  for (const b of ['napcat', 'snowluma', 'lagrange'] as const) {
    const c = base();
    c.qq.enabled = true;
    c.qq.backend = b;
    c.qq.wsUrl = 'ws://127.0.0.1:3000';
    const errs = validateConfig(c).filter(i => i.severity === 'error');
    assert.equal(errs.filter(e => e.path.startsWith('qq.') && e.path !== 'qq.httpUrl').length, 0,
      'backend=' + b + ' 不应产生错误');
  }
});

test('QQ custom 后端指向非本地地址给出警告', () => {
  const c = base();
  c.qq.enabled = true;
  c.qq.backend = 'custom';
  c.qq.wsUrl = 'ws://10.0.0.5:3000';
  const warns = validateConfig(c).filter(i => i.severity === 'warning');
  assert.ok(warns.some(w => w.path === 'qq.wsUrl'));
});
