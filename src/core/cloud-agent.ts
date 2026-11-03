/*
 * SoulWeave S6.17：云端 Agent 接入（第二角色「小橘子」）
 *
 * 多角色设计：
 *   冰糖   → 本地 DSH（免费、离线、走本机模型）
 *   小橘子 → 云端 API（付费、在线、模型更强）
 *
 * 这里只负责「云端」这一半：服务商清单、官方获取入口、连通性测试。
 * 聊天调用本身复用 OpenAI 兼容协议（绝大多数国内服务都兼容）。
 */

// ─── 服务商清单 ─────────────────────────────────────

export interface CloudProvider {
  id: string;
  name: string;
  /** 一句话定位 */
  tagline: string;
  /** 控制台 / 获取 Key 的官方页面 */
  keyUrl: string;
  /** 文档 */
  docsUrl?: string;
  /** OpenAI 兼容的 base URL */
  baseUrl: string;
  /** 常用模型（第一个是默认） */
  models: string[];
  /** 是否需要额外配置（如账号 ID） */
  note?: string;
  /** 国内直连是否顺畅 */
  domestic?: boolean;
  /** 品牌图标 id（对应 renderer/icons.js 的 BRAND_ICONS / BRAND_FALLBACKS） */
  iconId?: string;
}

export const CLOUD_PROVIDERS: CloudProvider[] = [
  {
    id: 'deepseek', name: 'DeepSeek', iconId: 'deepseek', tagline: '便宜、中文好、推理强',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    docsUrl: 'https://platform.deepseek.com/api-docs/',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    domestic: true,
  },
  {
    id: 'zhipu', name: '智谱 GLM', iconId: 'zhipu', tagline: '国内老牌，GLM-4 系列',
    keyUrl: 'https://bigmodel.cn/usercenter/apikeys',
    docsUrl: 'https://bigmodel.cn/dev/api',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-flash', 'glm-4-air'],
    domestic: true,
  },
  {
    id: 'qwen', name: '通义千问', iconId: 'qwen', tagline: '阿里云百炼，额度友好',
    keyUrl: 'https://bailian.console.aliyun.com/',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
    domestic: true,
  },
  {
    id: 'moonshot', name: 'Kimi (Moonshot)', iconId: 'kimi', tagline: '长上下文见长',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    docsUrl: 'https://platform.moonshot.cn/docs',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    domestic: true,
  },
  {
    id: 'silicon', name: '硅基流动', iconId: 'siliconflow', tagline: '一个 Key 用几十种开源模型',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    docsUrl: 'https://docs.siliconflow.cn/',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['Qwen/Qwen2.5-7B-Instruct', 'deepseek-ai/DeepSeek-V3'],
    domestic: true,
  },
  {
    id: 'doubao', name: '豆包 (火山方舟)', iconId: 'bytedance', tagline: '字节，需要接入点 ID',
    keyUrl: 'https://console.volcengine.com/ark',
    docsUrl: 'https://www.volcengine.com/docs/82379',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-pro-32k'],
    note: '火山方舟需要在控制台先创建「推理接入点」，把接入点 ID 填进模型名。',
    domestic: true,
  },
  {
    id: 'minimax', name: 'MiniMax', iconId: 'minimax', tagline: '对话与角色扮演见长',
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    docsUrl: 'https://platform.minimaxi.com/document',
    baseUrl: 'https://api.minimax.chat/v1',
    models: ['abab6.5s-chat'],
    domestic: true,
  },
  {
    id: 'openai', name: 'OpenAI', iconId: 'openai', tagline: '需要海外网络',
    keyUrl: 'https://platform.openai.com/api-keys',
    docsUrl: 'https://platform.openai.com/docs',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o'],
    domestic: false,
  },
  {
    id: 'anthropic', name: 'Anthropic Claude', iconId: 'anthropic', tagline: '需要海外网络，性格细腻',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    docsUrl: 'https://docs.anthropic.com/',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-sonnet-4-20250514', 'claude-haiku-4-20250514'],
    note: 'Anthropic 不是标准 OpenAI 兼容协议，需要在服务端做转换；本应用按 OpenAI 兼容协议调用，可能不通。',
    domestic: false,
  },
  {
    id: 'gemini', name: 'Google Gemini', iconId: 'googlegemini', tagline: '需要海外网络，有免费额度',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-flash-lite-latest', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-flash-latest'],
    domestic: false,
  },
  {
    id: 'custom', name: '自定义', iconId: 'custom', tagline: '任何 OpenAI 兼容服务',
    keyUrl: '',
    baseUrl: '',
    models: [],
    note: '填服务地址和模型名。只要对方兼容 /chat/completions 就能用。',
  },
];

export function findByProvider(id: string): CloudProvider | null {
  return CLOUD_PROVIDERS.find((p) => p.id === id) || null;
}

// ─── 配置 ───────────────────────────────────────────

export interface CloudAgentConfig {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 绑定到哪个角色 */
  character: string;
  /** 温度 */
  temperature?: number;
  /** 单次回复最大 token */
  maxTokens?: number;
  /**
   * 网络出口。
   *
   *   system  跟随系统代理（默认，最省事）
   *   direct  强制直连，忽略系统代理（国内服务 + 开了代理反而更慢时用）
   *   custom  指定代理地址
   *
   * 【为什么需要这个】
   * 原来只能「跟随系统代理」：用户一关代理客户端，境外服务立刻不通，
   * 而报错只是一句 fetch failed，看不出是代理没了。
   * 现在出口是显式配置，测试连接还会回报实际解析出的代理，一眼能对账。
   */
  proxyMode?: 'system' | 'direct' | 'custom';
  /** custom 模式下的代理地址，如 http://127.0.0.1:10090 */
  proxyUrl?: string;
}

export const DEFAULT_CLOUD_AGENT: CloudAgentConfig = {
  providerId: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  character: '小橘子',
  temperature: 0.8,
  maxTokens: 800,
  proxyMode: 'system',
  proxyUrl: '',
};

/** 选了服务商后，把它的默认值填进来（不覆盖用户已填的自定义值） */
export function applyProviderDefaults(cfg: CloudAgentConfig, providerId: string): CloudAgentConfig {
  const p = findByProvider(providerId);
  if (!p) return { ...cfg, providerId };
  return {
    ...cfg,
    providerId,
    baseUrl: p.baseUrl || cfg.baseUrl,
    model: p.models[0] || cfg.model,
  };
}

// ─── 错误翻译 ───────────────────────────────────────

/**
 * 把底层网络错误翻译成用户能看懂的话。
 *
 * 典型：TypeError: fetch failed —— 这句话对用户毫无帮助，
 * 真正的原因通常是「连不上」（超时/DNS/被墙）或「证书问题」。
 */
export function explainFetchError(e: unknown): { message: string; hint?: string } {
  const raw = String((e as any)?.message || e || '');
  const code = String((e as any)?.cause?.code || (e as any)?.code || '');
  const detail = raw + ' ' + code;

  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(detail)) {
    return { message: '域名解析失败', hint: '检查网络或 DNS；如果是境外服务，可能需要开启代理。' };
  }
  if (/ECONNREFUSED/i.test(detail)) {
    return { message: '连接被拒绝', hint: '服务地址或端口不对，或者对方没启动。' };
  }
  if (/ETIMEDOUT|timeout|aborted|ABORT_ERR/i.test(detail)) {
    return { message: '连接超时', hint: '网络不通。境外服务（如 Gemini / OpenAI）通常需要代理。' };
  }
  if (/CERT|SSL|TLS|self.signed/i.test(detail)) {
    return { message: '证书校验失败', hint: '可能是代理或防火墙中间人证书，或系统时间不对。' };
  }
  if (/fetch failed/i.test(detail)) {
    return { message: '网络请求失败', hint: '连不上这个地址。确认能上网，境外服务需要代理。' };
  }
  return { message: raw.slice(0, 180) || '未知错误' };
}

// ─── 连通性测试 ─────────────────────────────────────

export interface CloudAgentTestResult {
  ok: boolean;
  error?: string;
  /** 模型回的第一句话（用于确认真的通了） */
  reply?: string;
  ms?: number;
}

/**
 * 发一条最小请求验证 Key 和模型是否可用。
 *
 * 用 /chat/completions 而不是 /models：
 * 有些服务不暴露 /models，但一定支持对话；
 * 而且这样能顺便验证模型名是否正确。
 */
export async function testCloudAgent(
  cfg: CloudAgentConfig,
  deps: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<CloudAgentTestResult> {
  const f = deps.fetch || fetch;
  const now = deps.now || (() => Date.now());

  if (!cfg.baseUrl) return { ok: false, error: '缺少服务地址' };
  if (!cfg.apiKey) return { ok: false, error: '缺少 API Key' };
  if (!cfg.model) return { ok: false, error: '缺少模型名' };

  const url = String(cfg.baseUrl).replace(/\/+$/, '') + '/chat/completions';
  const t0 = now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30_000);
    const r = await f(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: '说一句「连接成功」即可，不要多说。' }],
        max_tokens: 32,
        temperature: 0,
      }),
      signal: ctl.signal,
    } as any);
    clearTimeout(timer);
    const ms = now() - t0;

    if (!r.ok) {
      const txt = await (r as any).text().catch(() => '');
      let hint = '';
      if (r.status === 401) hint = 'API Key 无效';
      else if (r.status === 403) hint = 'Key 没有权限或已停用';
      else if (r.status === 404) hint = '服务地址或模型名不对';
      else if (r.status === 429) hint = '超出速率或额度限制';
      return { ok: false, error: 'HTTP ' + r.status + (hint ? '：' + hint : '') + ' ' + String(txt).slice(0, 160), ms };
    }

    let j: any = null;
    try { j = await (r as any).json(); } catch (e) { void e; }
    const reply = j && j.choices && j.choices[0] && j.choices[0].message
      ? String(j.choices[0].message.content || '').slice(0, 80) : '';
    return { ok: true, reply, ms };
  } catch (e) {
    const ex = explainFetchError(e);
    const text = ex.message + (ex.hint ? '：' + ex.hint : '');
    return { ok: false, error: text, ms: now() - t0 };
  }
}