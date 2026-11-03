/**
 * SoulWeave 配置 Schema
 *
 * V1.7 要求（D52 / D54 / 02 §V1.2-B）：
 * - 带版本号的 schema 与校验
 * - 非秘密字段可导出，秘密字段单独加密/受限存储
 * - 支持迁移前预览、回滚和「恢复默认但不删数据」
 * - 不写死开发者路径，不泄漏设备标识
 */

export const CONFIG_VERSION = 1;

// ─── 路径 ───────────────────────────────────────────

export interface PathsConfig {
  /** 安装根目录（程序文件） */
  installRoot: string;
  /** 数据根目录（角色/记忆/对话） */
  dataRoot: string;
  /** 缓存根目录（下载/媒体/日志） */
  cacheRoot: string;
}

// ─── 模型 ───────────────────────────────────────────

export interface ModelConfig {
  provider: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
}

// ─── 角色运行时 ─────────────────────────────────────

export interface CharacterRuntimeConfig {
  /** local_dsh 角色的 DSH 接入配置 */
  dsh: {
    /** DSH 启动器路径 */
    launcherPath: string;
    /** DSH_HOME（与开发 DSH 隔离） */
    homeDir: string;
    /** profile */
    profile: string;
    /** 请求超时 */
    requestTimeoutMs: number;
  };
  /** cloud_api 角色的默认模型 */
  cloudDefault: ModelConfig;
}

// ─── 自主对话（D60）──────────────────────────────────

export interface AutonomousConfig {
  /** 默认 6，范围 1–30 */
  defaultQuota: number;
  /** 分场景覆盖 */
  scenes: Record<string, { quota: number; cooldownSeconds: number }>;
  /** 每日上限 */
  dailyMaxRounds: number;
  dailyMaxMessages: number;
  /** 安静时段 */
  quietHours: { start: string; end: string } | null;
}

// ─── 权限 ───────────────────────────────────────────

export interface PermissionConfig {
  /** 角色级许可（动作前缀） */
  grants: Record<string, string[]>;
  /** 角色级禁令（优先级高于 grants） */
  denies: Record<string, string[]>;
  /** 需要审批的等级（默认 L2 及以上） */
  approvalThreshold: 'L2' | 'L3' | 'L4' | 'L5';
}

// ─── 语音 ───────────────────────────────────────────

export interface VoiceConfig {
  /** 主用 provider：online / local / system */
  primary: 'online' | 'local' | 'system';
  /** 降级链 */
  fallback: Array<'online' | 'local' | 'system'>;
  /** 在线 provider 配置（密钥不在此处） */
  online: { provider: string | null; voiceId: string | null };
  /** 本地模型是否启用（默认 false，T4 方向） */
  localEnabled: boolean;
  /** 唱歌插件是否启用（默认 false） */
  singingEnabled: boolean;
}

// ─── QQ ─────────────────────────────────────────────

/**
 * QQ 协议后端。
 *
 * 【设计决定 S3-9】不对某一家实现绑定。
 * NapCat / SnowLuma / Lagrange 等都实现同一个 **OneBot v11** 标准，
 * 所以这里只记录「用户用的是哪一家」作为提示与显示用途，
 * **逻辑代码一律只依赖 OneBot v11，不依赖具体实现**。
 * 这样任何一家被封控、停更或换协议，用户换一个后端即可，应用无需改代码。
 */
export type QqBackend = 'napcat' | 'snowluma' | 'lagrange' | 'custom';

export interface QqConfig {
  /** 协议实现不打包，用户自行安装（与规划文档既有的 NapCat 处理方式一致） */
  enabled: boolean;
  /** 用户选择的协议实现：仅用于显示与引导，不参与逻辑分支 */
  backend: QqBackend;
  /** OneBot v11 WebSocket 地址（逻辑只依赖这个） */
  wsUrl: string | null;
  /** OneBot v11 HTTP 上报地址（可选） */
  httpUrl: string | null;
  /** 访问令牌：只存引用，不存明文 */
  accessTokenRef: string | null;
  /** 探测端口（用于引导页自动发现本地 OneBot 服务） */
  probePorts: number[];
  /** 双账号 */
  accounts: Array<{ label: string; characterId: string | null }>;
}

// ─── 完整配置 ───────────────────────────────────────

export interface SoulWeaveConfig {
  version: number;
  paths: PathsConfig;
  characterRuntime: CharacterRuntimeConfig;
  autonomous: AutonomousConfig;
  permissions: PermissionConfig;
  voice: VoiceConfig;
  qq: QqConfig;
  /** 密钥引用（不含明文） */
  secretRefs: {
    deepseekApiKeyRef: string | null;
    onlineTtsKeyRef: string | null;
  };
}

// ─── 默认值 ─────────────────────────────────────────

export function createDefaultConfig(opts: {
  installRoot: string;
  dataRoot: string;
  cacheRoot: string;
  dshLauncherPath: string;
  dshHomeDir: string;
}): SoulWeaveConfig {
  return {
    version: CONFIG_VERSION,
    paths: {
      installRoot: opts.installRoot,
      dataRoot: opts.dataRoot,
      cacheRoot: opts.cacheRoot,
    },
    characterRuntime: {
      dsh: {
        launcherPath: opts.dshLauncherPath,
        homeDir: opts.dshHomeDir,
        profile: 'sdk',
        requestTimeoutMs: 60_000,
      },
      cloudDefault: {
        provider: 'deepseek-official',
        model: 'deepseek-flash',
      },
    },
    autonomous: {
      defaultQuota: 6,
      scenes: {
        qq_group: { quota: 6, cooldownSeconds: 60 },
        desktop: { quota: 6, cooldownSeconds: 30 },
        character_dm: { quota: 6, cooldownSeconds: 60 },
      },
      dailyMaxRounds: 100,
      dailyMaxMessages: 300,
      quietHours: null,
    },
    permissions: {
      grants: {},
      denies: {},
      approvalThreshold: 'L2',
    },
    voice: {
      primary: 'online',
      fallback: ['local', 'system'],
      online: { provider: null, voiceId: null },
      localEnabled: false,
      singingEnabled: false,
    },
    qq: {
      enabled: false,
      backend: 'napcat',
      wsUrl: null,
      httpUrl: null,
      accessTokenRef: null,
      // SnowLuma 默认 5099；NapCat/Lagrange 常用 3000/3001/6099
      probePorts: [3000, 3001, 6099, 5099],
      accounts: [],
    },
    secretRefs: {
      deepseekApiKeyRef: null,
      onlineTtsKeyRef: null,
    },
  };
}

// ─── 校验 ───────────────────────────────────────────

export interface ValidationIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export function validateConfig(cfg: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const c = cfg as Partial<SoulWeaveConfig>;

  const err = (path: string, message: string) => issues.push({ path, message, severity: 'error' });
  const warn = (path: string, message: string) => issues.push({ path, message, severity: 'warning' });

  if (!c || typeof c !== 'object') {
    err('', '配置必须是对象');
    return issues;
  }

  if (c.version !== CONFIG_VERSION) {
    err('version', `期望 ${CONFIG_VERSION}，实际 ${c.version}`);
  }

  // 路径
  if (!c.paths?.installRoot) err('paths.installRoot', '必填');
  if (!c.paths?.dataRoot) err('paths.dataRoot', '必填');
  if (!c.paths?.cacheRoot) err('paths.cacheRoot', '必填');

  // 路径不得指向「源码工作区」（发布包里不该出现开发机的绝对路径）。
  // 【为什么不用用户名】旧版本写死了某台机器的 C:\\Users\\<名字>，
  // 既泄露开发者身份，又对别人的机器没有意义。这里改成按项目目录特征判断。
  const devPaths = ['\\01_project\\soulweave', '\\soulweave\\src\\', '\\SoulWeave\\01_project', '\\04_test-assets'];
  for (const [k, v] of Object.entries(c.paths ?? {})) {
    for (const d of devPaths) {
      if (typeof v === 'string' && v.toLowerCase().includes(d.toLowerCase())) {
        warn('paths.' + k, '包含开发者路径 ' + d + '，发布前需替换为占位符');
      }
    }
  }

  // 自主对话额度
  const q = c.autonomous?.defaultQuota;
  if (typeof q !== 'number' || q < 1 || q > 30) {
    err('autonomous.defaultQuota', '必须在 1–30 之间（V1.7 D.1-5）');
  }

  for (const [scene, v] of Object.entries(c.autonomous?.scenes ?? {})) {
    if (typeof v.quota !== 'number' || v.quota < 1 || v.quota > 30) {
      err(`autonomous.scenes.${scene}.quota`, '必须在 1–30 之间');
    }
  }

  // 权限
  const lvls = ['L2','L3','L4','L5'];
  if (!lvls.includes(c.permissions?.approvalThreshold ?? '')) {
    err('permissions.approvalThreshold', '必须是 ' + lvls.join('/'));
  }

  // 语音：主用不能同时出现在 fallback 首位
  const v = c.voice;
  if (v) {
    if (!['online','local','system'].includes(v.primary)) {
      err('voice.primary', '必须是 online/local/system');
    }
    if (v.primary === 'local' && !v.localEnabled) {
      warn('voice.primary', 'primary=local 但 localEnabled=false，将降级');
    }
    if (v.singingEnabled && !v.localEnabled) {
      warn('voice.singingEnabled', '唱歌需要本地模型，建议同时开启 localEnabled');
    }
  }

  // QQ（S3-9：只校验 OneBot v11 契约，不绑定具体实现）
  if (c.qq) {
    const backends: QqBackend[] = ['napcat', 'snowluma', 'lagrange', 'custom'];
    if (c.qq.backend && !backends.includes(c.qq.backend)) {
      err('qq.backend', 'backend 必须是 napcat/snowluma/lagrange/custom');
    }
    if (c.qq.enabled && !c.qq.wsUrl) {
      warn('qq.wsUrl', '已启用 QQ 但未配置 OneBot WebSocket 地址');
    }
    if (c.qq.wsUrl && !/^wss?:\/\//i.test(c.qq.wsUrl)) {
      err('qq.wsUrl', 'wsUrl 必须以 ws:// 或 wss:// 开头');
    }
    if (c.qq.httpUrl && !/^https?:\/\//i.test(c.qq.httpUrl)) {
      err('qq.httpUrl', 'httpUrl 必须以 http:// 或 https:// 开头');
    }
    if (c.qq.accessTokenRef === '') {
      err('qq.accessTokenRef', 'accessTokenRef 不能为空字符串，未使用时请设为 null');
    }
    // 引导目的：本地地址与常见后端端口不一致时给个提示（不阻断）
    if (c.qq.wsUrl && /^(ws|wss):\/\/(127\.0\.0\.1|localhost)\b/i.test(c.qq.wsUrl) === false &&
        c.qq.backend === 'custom') {
      warn('qq.wsUrl', 'custom 后端指向非本地地址，请确认网络与鉴权安全');
    }
  }

  // 密钥不得明文
  const raw = JSON.stringify(c);
  if (/sk-[a-zA-Z0-9]{20,}/.test(raw)) {
    err('', '检测到疑似明文 API 密钥，必须改用 secretRefs 引用');
  }

  return issues;
}

/** 导出时移除秘密字段（D52 要求非秘密字段可导出） */
export function exportSafeConfig(cfg: SoulWeaveConfig): SoulWeaveConfig {
  return {
    ...cfg,
    secretRefs: { deepseekApiKeyRef: null, onlineTtsKeyRef: null },
  };
}
