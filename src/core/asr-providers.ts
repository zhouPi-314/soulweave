/*
 * SoulWeave S7：语音识别（ASR）Provider 清单与两层适配
 *
 * 依据：01 需求 §7.9「麦克风/扬声器、ASR/TTS 服务…内置测试麦克风」
 *      用户决策：「第一层 OpenAI 兼容通用接口」与「第二层协议不兼容的大厂」
 *                都要放在同一个「云端 ASR」区，并带官方图标。
 *
 * 【为什么分两层】
 * 第一层是**一个实现接一大片**：只要对方支持 audio/transcriptions 协议，
 * 填个 Base URL 就能用（OpenAI / Groq / 硅基流动 / 自建 / 中转站…）。
 * 第二层是**协议真的不一样**的大厂（腾讯 TC3 签名、讯飞 HMAC、阿里签名），
 * 每家要单独写适配，所以只做用户最可能用的那几家。
 *
 * 【本文件只放清单与纯函数】
 * 真正的网络调用在 asr-openai.ts / asr-aliyun.ts 等，便于分开测试。
 */

// ─── 类型 ───────────────────────────────────────────

/** 适配层：决定用哪个实现去调 */
export type AsrProtocol =
  | 'openai-compatible'   // POST {base}/audio/transcriptions（multipart）
  | 'tencent'             // 腾讯云 TC3-HMAC-SHA256 签名 + 异步任务
  | 'aliyun'              // 阿里云 NLS（签名）
  | 'xfyun'               // 讯飞（HMAC + 轮询）
  | 'elevenlabs'          // ElevenLabs Scribe（REST，简单）
  | 'deepgram'            // Deepgram（REST，简单）
  | 'gladia';             // Gladia（REST + 轮询）

export type AsrLayer = 'universal' | 'vendor';

export interface AsrProvider {
  id: string;
  /** 显示名 */
  name: string;
  /** 品牌图标 id（对应 renderer/icons.js） */
  iconId: string;
  /** 一句话定位 */
  tagline: string;
  layer: AsrLayer;
  protocol: AsrProtocol;
  /** 申请 Key 的官方页面 */
  keyUrl: string;
  docsUrl?: string;
  /** 预填的 Base URL（通用层用；厂商层为空） */
  baseUrl?: string;
  /** 常用模型（第一个是默认） */
  models: string[];
  /** 免费额度说明（给用户看） */
  freeTier?: string;
  /** 计费说明 */
  pricing?: string;
  /** 国内是否直连顺畅 */
  domestic?: boolean;
  /** 需要哪些凭据字段 */
  credentials: AsrCredentialField[];
  /** 需要用户额外注意的 */
  note?: string;
}

export interface AsrCredentialField {
  /** 字段键，如 apiKey / secretId */
  key: string;
  /** 显示名 */
  label: string;
  /** 是否密码型（不回显） */
  secret?: boolean;
  placeholder?: string;
  /** 必填 */
  required?: boolean;
}

// ─── 第一层：OpenAI 兼容 ────────────────────────────

const OPENAI_CREDS: AsrCredentialField[] = [
  { key: 'apiKey', label: 'API Key', secret: true, required: true, placeholder: 'sk-…' },
];

export const UNIVERSAL_ASR_PROVIDERS: AsrProvider[] = [
  {
    id: 'openai', name: 'OpenAI', iconId: 'openai', layer: 'universal',
    protocol: 'openai-compatible',
    tagline: '基准实现，最稳',
    keyUrl: 'https://platform.openai.com/api-keys',
    docsUrl: 'https://platform.openai.com/docs/guides/speech-to-text',
    baseUrl: 'https://api.openai.com/v1',
    models: ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'],
    freeTier: '无免费额度',
    pricing: '约 $0.006 / 分钟（whisper-1）',
    domestic: false,
    credentials: OPENAI_CREDS,
  },
  {
    id: 'groq', name: 'Groq', iconId: 'groq', layer: 'universal',
    protocol: 'openai-compatible',
    tagline: '自研芯片，极快，有免费档',
    keyUrl: 'https://console.groq.com/keys',
    docsUrl: 'https://console.groq.com/docs/speech-to-text',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['whisper-large-v3', 'whisper-large-v3-turbo'],
    freeTier: '有慷慨免费档（按分钟限额）',
    pricing: '超出免费档按时长计费',
    domestic: false,
    credentials: OPENAI_CREDS,
    note: '国内部分网络环境需要代理。',
  },
  {
    id: 'siliconflow', name: '硅基流动', iconId: 'siliconflow', layer: 'universal',
    protocol: 'openai-compatible',
    tagline: '国内直连，中文强',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    docsUrl: 'https://docs.siliconflow.cn/',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['FunAudioLLM/SenseVoiceSmall'],
    freeTier: '注册送额度，部分模型免费',
    pricing: '按用量计费，价格低',
    domestic: true,
    credentials: OPENAI_CREDS,
  },
  {
    id: 'deepinfra', name: 'DeepInfra', iconId: 'deepinfra', layer: 'universal',
    protocol: 'openai-compatible',
    tagline: '便宜，按量付费',
    keyUrl: 'https://deepinfra.com/dash/api_keys',
    docsUrl: 'https://deepinfra.com/docs',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    models: ['openai/whisper-large-v3', 'openai/whisper-large-v3-turbo'],
    freeTier: '有试用额度',
    pricing: '按音频时长计费',
    domestic: false,
    credentials: OPENAI_CREDS,
  },
  {
    id: 'fireworks', name: 'Fireworks', iconId: 'fireworks', layer: 'universal',
    protocol: 'openai-compatible',
    tagline: '推理快',
    keyUrl: 'https://fireworks.ai/account/api-keys',
    docsUrl: 'https://docs.fireworks.ai/',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    models: ['whisper-v3', 'whisper-v3-turbo'],
    freeTier: '有试用额度',
    pricing: '按时长计费',
    domestic: false,
    credentials: OPENAI_CREDS,
  },
  {
    id: 'together', name: 'Together AI', iconId: 'together', layer: 'universal',
    protocol: 'openai-compatible',
    tagline: '聚合多家模型',
    keyUrl: 'https://api.together.xyz/settings/api-keys',
    docsUrl: 'https://docs.together.ai/',
    baseUrl: 'https://api.together.xyz/v1',
    models: ['openai/whisper-large-v3'],
    freeTier: '有试用额度',
    pricing: '按时长计费',
    domestic: false,
    credentials: OPENAI_CREDS,
  },
  {
    id: 'openrouter', name: 'OpenRouter', iconId: 'openrouter', layer: 'universal',
    protocol: 'openai-compatible',
    tagline: '一个 Key 走很多家',
    keyUrl: 'https://openrouter.ai/keys',
    docsUrl: 'https://openrouter.ai/docs',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openai/whisper-large-v3'],
    freeTier: '视具体模型',
    pricing: '按模型计费',
    domestic: false,
    credentials: OPENAI_CREDS,
  },
  {
    id: 'custom', name: '自定义 / 自建', iconId: 'custom', layer: 'universal',
    protocol: 'openai-compatible',
    tagline: '任何 OpenAI 兼容端点',
    keyUrl: '',
    baseUrl: '',
    models: [],
    freeTier: '—',
    pricing: '你自己决定',
    credentials: OPENAI_CREDS,
    note: '填 Base URL + Key + 模型名。自建 whisper 服务、API 中转站、LM Studio 都能接。',
  },
];

// ─── 第二层：协议不兼容的大厂 ───────────────────────

export const VENDOR_ASR_PROVIDERS: AsrProvider[] = [
  {
    id: 'tencent', name: '腾讯云', iconId: 'tencentcloud', layer: 'vendor',
    protocol: 'tencent',
    tagline: '每月赠 5 小时，中文质量好',
    keyUrl: 'https://console.cloud.tencent.com/asr',
    docsUrl: 'https://cloud.tencent.com/document/product/1093',
    models: ['standard', 'large'],
    freeTier: '每月赠送 5 小时（按月刷新）',
    pricing: '超出后按转写时长计费',
    domestic: true,
    credentials: [
      { key: 'appId', label: 'AppID', required: true, placeholder: '纯数字' },
      { key: 'secretId', label: 'SecretId', required: true },
      { key: 'secretKey', label: 'SecretKey', secret: true, required: true },
    ],
    note: 'standard 是普通版（并发 20），large 是大模型版（更准但并发仅 5）。',
  },
  {
    id: 'aliyun', name: '阿里云', iconId: 'alibabacloud', layer: 'vendor',
    protocol: 'aliyun',
    tagline: '录音识别极速版',
    keyUrl: 'https://nls-portal.console.aliyun.com/applist',
    docsUrl: 'https://help.aliyun.com/zh/isi/',
    models: ['default'],
    freeTier: '无（仅商用版）',
    pricing: '按时长计费',
    domestic: true,
    credentials: [
      { key: 'appKey', label: 'AppKey', required: true },
      { key: 'accessKeyId', label: 'AccessKey ID', required: true },
      { key: 'accessKeySecret', label: 'AccessKey Secret', secret: true, required: true },
    ],
  },
  {
    id: 'xfyun', name: '讯飞', iconId: 'iflytek', layer: 'vendor',
    protocol: 'xfyun',
    tagline: '中文方言强，异步订单制',
    keyUrl: 'https://console.xfyun.cn/services/lfasr',
    docsUrl: 'https://www.xfyun.cn/doc/asr/lfasr/API.html',
    models: ['lfasr'],
    freeTier: '视活动而定',
    pricing: '按时长计费',
    domestic: true,
    credentials: [
      { key: 'appId', label: 'APPID', required: true },
      { key: 'apiKey', label: 'APIKey', required: true },
      { key: 'apiSecret', label: 'APISecret', secret: true, required: true },
    ],
    note: '异步订单制：提交后轮询结果，退出应用不丢任务。',
  },
  {
    id: 'elevenlabs', name: 'ElevenLabs Scribe', iconId: 'elevenlabs', layer: 'vendor',
    protocol: 'elevenlabs',
    tagline: '90+ 语种，词级时间戳',
    keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
    docsUrl: 'https://elevenlabs.io/docs/api-reference/speech-to-text',
    models: ['scribe_v2'],
    freeTier: '有免费档',
    pricing: '按时长计费',
    domestic: false,
    credentials: OPENAI_CREDS,
  },
  {
    id: 'deepgram', name: 'Deepgram', iconId: 'deepgram', layer: 'vendor',
    protocol: 'deepgram',
    tagline: 'nova-2/3，速度快',
    keyUrl: 'https://console.deepgram.com/',
    docsUrl: 'https://developers.deepgram.com/docs',
    models: ['nova-3', 'nova-2'],
    freeTier: '新用户赠额度',
    pricing: '按时长计费',
    domestic: false,
    credentials: OPENAI_CREDS,
  },
  {
    id: 'gladia', name: 'Gladia', iconId: 'gladia', layer: 'vendor',
    protocol: 'gladia',
    tagline: '100+ 语种，小语种最强',
    keyUrl: 'https://app.gladia.io/',
    docsUrl: 'https://docs.gladia.io/',
    models: ['solaria-1'],
    freeTier: '每月赠送 10 小时',
    pricing: '超出后按时长计费',
    domestic: false,
    credentials: OPENAI_CREDS,
    note: '免费档的音频会用于其模型训练，敏感内容请勿使用免费档。',
  },
];

export const ALL_ASR_PROVIDERS: AsrProvider[] = [...UNIVERSAL_ASR_PROVIDERS, ...VENDOR_ASR_PROVIDERS];

// ─── 查询与校验（纯函数） ───────────────────────────

export function findAsrProvider(id: string): AsrProvider | null {
  return ALL_ASR_PROVIDERS.find((p) => p.id === String(id || '')) || null;
}

export function providersByLayer(layer: AsrLayer): AsrProvider[] {
  return ALL_ASR_PROVIDERS.filter((p) => p.layer === layer);
}

/** 凭据是否齐全（缺哪个就点名） */
export function validateCredentials(
  provider: AsrProvider,
  creds: Record<string, string> | null | undefined,
): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const f of provider.credentials) {
    if (!f.required) continue;
    const v = creds ? creds[f.key] : '';
    if (!v || !String(v).trim()) missing.push(f.label);
  }
  return { ok: missing.length === 0, missing };
}

/** 组装最终的 Base URL（自定义实例必须自己填） */
export function resolveBaseUrl(provider: AsrProvider, override?: string): string {
  const o = String(override || '').trim();
  if (o) return o.replace(/\/+$/, '');
  return String(provider.baseUrl || '').replace(/\/+$/, '');
}

/** 语音识别的动作名（配合 permission-engine，走 L2 网络请求） */
export const ASR_ACTION = 'media.transcribe';

/** 一次转写的超时建议 */
export const ASR_TIMEOUT_MS = 120_000;
