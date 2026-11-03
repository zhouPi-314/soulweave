/**
 * SoulWeave S10：音色社区目录与许可/兼容判定
 *
 * 【这一层的职责不是"找资源"，是"拦住不该用的资源"】
 * 需求里最硬的一句是：**不得将「可下载」视为「可合法再分发/可商用」**。
 * 社区里的音色授权链条通常是：配音演员 → 角色 IP → 数据集 → 模型权重，
 * 每一层都可能另有约束。所以每条资源都要把三件事拆开标：
 *
 *   redistributable  能不能随 SoulWeave 一起分发（打进安装包）
 *   personalUse      用户能不能在本机自己装来用
 *   commercial       能不能商用
 *
 * 判定分三档：ok / warn / blocked。**未知许可一律 blocked**（失败安全）。
 *
 * 本文件不联网、不读磁盘，是纯数据 + 纯函数。
 */

export type ResourceKind = 'engine' | 'model' | 'voice' | 'character-ip' | 'dataset' | 'site';

/** 常见的许可证标识（小写归一后比较） */
export type LicenseId =
  | 'MIT' | 'Apache-2.0' | 'BSD-3-Clause' | 'CC0-1.0' | 'OFL-1.1'
  | 'GPL-3.0' | 'AGPL-3.0' | 'CC-BY-4.0' | 'CC-BY-SA-4.0' | 'CC-BY-NC-4.0'
  | 'proprietary' | 'unknown' | 'per-resource';

export type CommunityResource = {
  id: string;
  name: string;
  kind: ResourceKind;
  /** 一句话说明，给用户看 */
  summary: string;
  /** 主页 / 获取页（应用只负责打开，不代下） */
  upstream: string;
  license: LicenseId;
  /** 许可证原文链接（能给就给） */
  licenseUrl?: string;
  /** 兼容的引擎 id（与 voice-components 的 provider 对齐） */
  engines: string[];
  /** 权重体积（MB），未知就不写 */
  sizeMB?: number;
  /** 运行时额外内存（MB） */
  ramMB?: number;
  /** 中文音色之类的中文标签 */
  tags?: string[];
  /** 需要额外说明的话（例如署名要求、IP 风险） */
  note?: string;
};

/** 判定结果 */
export type Verdict = 'ok' | 'warn' | 'blocked';

export type PolicyResult = {
  verdict: Verdict;
  /** 三条结论，逐条给理由 */
  redistribute: { allowed: boolean; reason: string };
  personalUse: { allowed: boolean; reason: string };
  commercial: { allowed: boolean; reason: string };
  /** 给界面显示的完整理由列表 */
  reasons: string[];
};

/** 允许再分发的许可证白名单 */
const REDISTRIBUTABLE: LicenseId[] = ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'CC0-1.0', 'OFL-1.1'];
/** 允许个人使用、但不能随应用分发的 */
const PERSONAL_ONLY: LicenseId[] = ['GPL-3.0', 'AGPL-3.0', 'CC-BY-4.0', 'CC-BY-SA-4.0'];
/** 个人使用也要提醒的 */
const PERSONAL_WARN: LicenseId[] = ['CC-BY-NC-4.0'];

/**
 * 判一个资源的授权结论。
 * @param r 资源条目
 */
export function evaluateLicense(r: CommunityResource): PolicyResult {
  const reasons: string[] = [];
  const lic = r.license;

  // 角色 IP 单独一票否决：不管许可证写什么
  if (r.kind === 'character-ip') {
    reasons.push('这是动漫/游戏角色的音色，权利链包含角色 IP 与配音演员；应用不提供、不导航到具体下载，也不建议再分发');
    return {
      verdict: 'blocked',
      redistribute: { allowed: false, reason: '角色 IP 不可再分发' },
      personalUse: { allowed: false, reason: '请自行确认角色 IP 与配音授权后再考虑' },
      commercial: { allowed: false, reason: '角色 IP 不适用商用' },
      reasons,
    };
  }

  // 站点：自己不下发许可，内容以站内每条资源为准
  if (lic === 'per-resource') {
    reasons.push('这是资源站入口，站点本身不授权其中任何音色或模型，许可以每个资源的说明为准');
    return {
      verdict: 'warn',
      redistribute: { allowed: false, reason: '站点不涉及再分发' },
      personalUse: { allowed: true, reason: '站点可访问，具体资源需逐个确认' },
      commercial: { allowed: false, reason: '需逐个资源确认' },
      reasons,
    };
  }

  // 许可证不明的，一律拦下
  if (!lic || lic === 'unknown' || lic === 'proprietary') {
    reasons.push('许可证未标明或为专有许可，无法判断能否使用');
    return {
      verdict: 'blocked',
      redistribute: { allowed: false, reason: '许可不明' },
      personalUse: { allowed: false, reason: '许可不明' },
      commercial: { allowed: false, reason: '许可不明' },
      reasons,
    };
  }

  const canRedistribute = REDISTRIBUTABLE.includes(lic);
  const personalOnly = PERSONAL_ONLY.includes(lic);
  const ncWarn = PERSONAL_WARN.includes(lic);

  if (canRedistribute) reasons.push('许可证 ' + lic + '：可随应用分发，需保留版权与许可声明');
  else if (personalOnly) reasons.push('许可证 ' + lic + '：可以自己装来用，但不能随应用分发');
  else if (ncWarn) reasons.push('许可证 ' + lic + '：仅限非商业用途，商用请另行取得授权');

  if (lic === 'CC-BY-4.0' || lic === 'CC-BY-SA-4.0') {
    reasons.push('使用时需署名原作者；CC-BY-SA 还有传染性条款，二次分发要注意');
  }
  if (lic === 'GPL-3.0') {
    reasons.push('GPL-3.0：作为独立外置组件由你自行安装，应用不打包、不修改、不再分发');
  }
  if (lic === 'AGPL-3.0') {
    reasons.push('AGPL-3.0：作为独立外置组件由你自行安装，应用不打包、不修改、不再分发；AGPL 还额外约束通过网络提供服务');
  }
  if (r.kind === 'site') {
    reasons.push('这是一个站点入口，内容授权以站点内每个资源各自的声明为准');
  }
  if (r.kind === 'dataset') {
    reasons.push('这是训练数据集，仅作说明；应用不下载、不再分发');
  }

  const personalAllowed = canRedistribute || personalOnly || ncWarn;
  const verdict: Verdict = canRedistribute ? 'ok' : (personalAllowed ? 'warn' : 'blocked');

  return {
    verdict,
    redistribute: { allowed: canRedistribute, reason: canRedistribute ? lic + ' 允许再分发' : lic + ' 不允许随应用分发' },
    personalUse: { allowed: personalAllowed, reason: personalAllowed ? '可以本机自行安装使用' : '不建议使用' },
    commercial: { allowed: canRedistribute && !ncWarn, reason: (canRedistribute && !ncWarn) ? '许可证允许商用' : '商用需另行确认' },
    reasons,
  };
}

export type InstalledState = {
  /** 已就绪的引擎 id（piper / kokoro / espeak / gptsovits / cosyvoice / system） */
  readyEngines: string[];
  /** 已安装的音色：provider → voiceId[] */
  installedVoices: Record<string, string[]>;
};

export type CompatResult = {
  compatible: boolean;
  verdict: Verdict;
  reasons: string[];
};

/**
 * 判一个资源在当前机器上能不能用。
 * 不是「许可允许」就够，还要引擎在、音色在。
 */
export function evaluateCompat(r: CommunityResource, state: InstalledState): CompatResult {
  const reasons: string[] = [];
  let verdict: Verdict = 'ok';

  if (!r.engines || !r.engines.length) {
    // 站点/数据集不需要引擎
    if (r.kind === 'site' || r.kind === 'dataset' || r.kind === 'character-ip') {
      return { compatible: false, verdict: 'warn', reasons: ['不涉及本机引擎'] };
    }
    return { compatible: false, verdict: 'blocked', reasons: ['没有声明兼容引擎'] };
  }

  const ready = r.engines.filter((e) => state.readyEngines.includes(e));
  if (!ready.length) {
    return {
      compatible: false,
      verdict: 'blocked',
      reasons: ['需要引擎 ' + r.engines.join(' / ') + '，但本机都没就绪'],
    };
  }
  reasons.push('引擎就绪：' + ready.join(' / '));

  // 具体音色：看它是不是已经装了
  if (r.kind === 'voice') {
    const ids = r.tags || [];
    const installed = ready.some((e) => (state.installedVoices[e] || []).length > 0);
    if (!installed) {
      verdict = 'warn';
      reasons.push('引擎在，但还没检测到任何已安装音色，需要你先安装音色文件');
    } else {
      reasons.push('已检测到该引擎下的音色');
    }
    void ids;
  }

  if (r.kind === 'engine' && ready.length === r.engines.length) {
    reasons.push('引擎已就绪');
  }

  return { compatible: ready.length > 0, verdict, reasons };
}

/** 单项的完整结论（许可 + 兼容合并） */
export type ItemVerdict = {
  resource: CommunityResource;
  license: PolicyResult;
  compat: CompatResult;
  /** 最终给用户的结论 */
  final: Verdict;
  /** 展示用的理由（许可理由 + 兼容理由） */
  reasons: string[];
  /** 预计占用 */
  estimate: { diskMB: number; ramMB: number };
};

/** 取两者中更严重的 */
function worst(a: Verdict, b: Verdict): Verdict {
  const rank: Record<Verdict, number> = { ok: 0, warn: 1, blocked: 2 };
  return rank[a] >= rank[b] ? a : b;
}

export function evaluateResource(r: CommunityResource, state: InstalledState): ItemVerdict {
  const license = evaluateLicense(r);
  const compat = evaluateCompat(r, state);
  const reasons = [...license.reasons, ...compat.reasons];
  // 许可 blocked 就别管兼容了；否则取较严重的
  const final = license.verdict === 'blocked' ? 'blocked' : worst(license.verdict, compat.verdict);
  return {
    resource: r,
    license,
    compat,
    final,
    reasons,
    estimate: { diskMB: r.sizeMB || 0, ramMB: r.ramMB || 0 },
  };
}

/** 目录：只做导航，不代下。顺序按「推荐先用」排 */
export const COMMUNITY_RESOURCES: CommunityResource[] = [
  {
    id: 'kokoro-model',
    name: 'Kokoro-82M 模型',
    kind: 'model',
    summary: '轻量 TTS 模型（82M），含 8 个中文音色；CPU 可跑，Apache-2.0。',
    upstream: 'https://github.com/thewh1teagle/kokoro-onnx/releases',
    license: 'Apache-2.0',
    licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    engines: ['kokoro'],
    sizeMB: 310,
    ramMB: 700,
    tags: ['中文', '轻量'],
  },
  {
    id: 'kokoro-zh-voices',
    name: 'Kokoro 中文音色',
    kind: 'voice',
    summary: '随 Kokoro 权重一起提供的 8 个中文音色（zf_xiaobei 等），Apache-2.0。',
    upstream: 'https://huggingface.co/hexgrad/Kokoro-82M',
    license: 'Apache-2.0',
    engines: ['kokoro'],
    sizeMB: 0,
    ramMB: 0,
    tags: ['zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi'],
  },
  {
    id: 'piper-engine',
    name: 'Piper 引擎',
    kind: 'engine',
    summary: '离线 TTS 引擎，纯 CPU，MIT。',
    upstream: 'https://github.com/rhasspy/piper/releases',
    license: 'MIT',
    engines: ['piper'],
    sizeMB: 60,
    ramMB: 200,
  },
  {
    id: 'piper-zh-huayan',
    name: 'Piper 中文音色（huayan）',
    kind: 'voice',
    summary: '中文女声。模型来自公开数据集，授权随数据集而定，商用前请自行核实。',
    upstream: 'https://huggingface.co/rhasspy/piper-voices',
    license: 'CC-BY-4.0',
    engines: ['piper'],
    sizeMB: 60,
    ramMB: 0,
    tags: ['zh_CN-huayan-medium'],
    note: '数据集许可需署名；不同音色可能条款不同，逐条核实。',
  },
  {
    id: 'espeak-ng',
    name: 'espeak-ng 语音数据',
    kind: 'engine',
    summary: 'Piper / Kokoro 的中文音素化依赖。GPL-3.0，应用不打包，需你自行安装。',
    upstream: 'https://github.com/espeak-ng/espeak-ng/releases',
    license: 'GPL-3.0',
    engines: ['piper', 'kokoro'],
    sizeMB: 30,
    ramMB: 80,
  },
  {
    id: 'gptsovits',
    name: 'GPT-SoVITS',
    kind: 'engine',
    summary: '少样本音色克隆。代码 MIT，但权重与克隆出的音色另计；需自行部署本地服务。',
    upstream: 'https://github.com/RVC-Boss/GPT-SoVITS',
    license: 'MIT',
    engines: ['gptsovits'],
    sizeMB: 2000,
    ramMB: 6000,
    note: '克隆他人音色前必须取得本人授权 —— 这是法律要求，不是建议。',
  },
  {
    id: 'cosyvoice',
    name: 'CosyVoice',
    kind: 'engine',
    summary: '中文零样本克隆，Apache-2.0；需自行部署本地服务。',
    upstream: 'https://github.com/FunAudioLLM/CosyVoice',
    license: 'Apache-2.0',
    engines: ['cosyvoice'],
    sizeMB: 3000,
    ramMB: 8000,
  },
  {
    id: 'hf-hub',
    name: 'Hugging Face',
    kind: 'site',
    summary: '音色与模型资源站。每个模型有独立许可证，以下载页为准。',
    upstream: 'https://huggingface.co/models?pipeline_tag=text-to-speech',
    license: 'per-resource',
    engines: [],
    note: '站点本身不授权其中任何资源，必须逐个看模型卡。',
  },
  {
    id: 'modelscope',
    name: 'ModelScope（魔搭）',
    kind: 'site',
    summary: '国内模型社区，中文音色与克隆模型较多。',
    upstream: 'https://modelscope.cn/models?task=text-to-speech',
    license: 'per-resource',
    engines: [],
  },
  {
    id: 'ai-hobbyist',
    name: 'AI Hobbyist（AI 爱好者）',
    kind: 'site',
    summary: '中文 TTS 模型与教程聚合站，收录较多二次元风格音色与整合包。',
    upstream: 'https://www.ai-hobbyist.com/',
    license: 'per-resource',
    engines: [],
    note: '聚合站常二次上传，原始许可链条容易断。本站已在条款层面核实可达，但每个模型仍需追到原作者与许可证。',
  },
  {
    id: 'bert-vits2',
    name: 'Bert-VITS2',
    kind: 'engine',
    summary: '中文二次元风格 TTS 引擎，社区音色最多的一支。',
    upstream: 'https://github.com/fishaudio/Bert-VITS2',
    license: 'AGPL-3.0',
    licenseUrl: 'https://www.gnu.org/licenses/agpl-3.0.html',
    engines: ['bertvits2'],
    sizeMB: 1500,
    ramMB: 4000,
    note: '代码 AGPL-3.0；预训练模型与角色音色另有许可，角色音色涉角色 IP，应用只收引擎、不收音色。',
  },
  {
    id: 'so-vits-svc',
    name: 'so-vits-svc',
    kind: 'engine',
    summary: '声音转换（歌声/说话）引擎，社区音色模型极多。',
    upstream: 'https://github.com/svc-develop-team/so-vits-svc',
    license: 'AGPL-3.0',
    licenseUrl: 'https://www.gnu.org/licenses/agpl-3.0.html',
    engines: ['sovits'],
    sizeMB: 2000,
    ramMB: 6000,
    note: '仓库已归档（archived）；人物音色模型几乎都来自动漫/游戏角色，属角色 IP，应用只收引擎。',
  },
  {
    id: 'vits-fast-fine-tuning',
    name: 'VITS-fast-fine-tuning',
    kind: 'engine',
    summary: '少量样本微调 VITS，带中文预训练底模。',
    upstream: 'https://github.com/Plachtaa/VITS-fast-fine-tuning',
    license: 'Apache-2.0',
    licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    engines: ['vits'],
    sizeMB: 2500,
    ramMB: 6000,
    note: '仓库已归档；底模与其衍生音色的授权需逐个确认。',
  },
  {
    id: 'character-voice',
    name: '二次元角色音色（社区）',
    kind: 'character-ip',
    summary: '各类动漫/游戏角色音色。权利链最长：配音演员、角色 IP、数据集、权重层层叠加。',
    upstream: '',
    license: 'unknown',
    engines: [],
    note: '应用不提供、不导航到具体下载，也不建议再分发。个人使用请自行取得授权。',
  },
];
