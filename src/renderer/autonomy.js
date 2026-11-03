/**
 * SoulWeave S2-25：角色动作自主性
 *
 * 目标：让接入的 AI 模型可以**自主决定**角色做什么动作/表情，
 * 而不是只能由用户点面板按钮触发。
 *
 * 分两层，互不冲突：
 *
 *   1. **模型驱动（Model-driven）**
 *      模型输出的文本里可以内嵌指令，渲染层解析后执行，并把指令从显示文本里剔除。
 *      协议见 DIRECTIVE_DOC。这样模型可以「说到做到」——
 *      比如聊到开心的话题时自己笑一下，或沉吟时侧头。
 *
 *   2. **本地自主（Autonomous）**
 *      没有模型指令时，角色也不是木头：空闲一段时间后会自己做一些
 *      小动作（换姿势、侧头、眨眼），频率可调，可完全关闭。
 *
 * 安全约束（两层都遵守）：
 *   - 只用**模型自带**的动作组/表情，不凭空造
 *   - 动作冷却（最短间隔），避免抽搐式连发
 *   - 任何异常都不影响渲染主循环
 *   - 用户可一键关闭
 */

/** 指令协议（未来接入真实模型时，把这部分写进系统提示词） */
export const DIRECTIVE_DOC = `
可用指令（写在回复里即可，渲染层会执行并从显示文本中移除）：

  [[act:组名#序号]]   播放指定动作，例如 [[act:TapBody#0]]
  [[act:random]]      从当前模型的全部动作里随机挑一个
  [[act:idle]]        播放待机动作
  [[expr:表情名]]      切换表情，例如 [[expr:微笑]]
  [[expr:clear]]      清除程序化表情

示例：
  「今天天气真好呀[[expr:微笑]]，要不要一起出去走走？[[act:TapBody#0]]」
`.trim();

const STORE_KEY = 'soulweave.autonomy';

/** 频率档位：空闲多久后可能做动作 + 单次触发概率 */
const FREQUENCY = {
  off:    { label: '关闭', idleMs: Infinity, chance: 0,    minGapMs: Infinity },
  low:    { label: '少量', idleMs: 60000,    chance: 0.25, minGapMs: 25000 },
  medium: { label: '适中', idleMs: 30000,    chance: 0.35, minGapMs: 15000 },
  high:   { label: '活跃', idleMs: 15000,    chance: 0.5,  minGapMs: 9000  },
};

const DEFAULT_CFG = { frequency: 'medium', allowModel: true };

let cfg = { ...DEFAULT_CFG };
let lastActAt = 0;
let lastInteractionAt = Date.now();
let lastModelIndex = 0;
let timer = null;
const stats = { autonomous: 0, model: 0, acts: 0, skippedCooldown: 0, skippedInvalid: 0, lastError: null };

function loadCfg() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) cfg = { ...DEFAULT_CFG, ...JSON.parse(raw) };
  } catch (e) { /* ignore */ }
  return cfg;
}
function saveCfg(next) {
  cfg = { ...cfg, ...next };
  if (!FREQUENCY[cfg.frequency]) cfg.frequency = 'medium';
  try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
  return cfg;
}

/** 标记「用户刚有交互」，自主行为会因此推迟 */
export function noteInteraction() { lastInteractionAt = Date.now(); }

function canAct(minGapMs) {
  return Date.now() - Math.max(lastActAt, lastInteractionAt) >= minGapMs;
}

function caps() {
  try { return window.__modelCaps?.() || []; } catch (e) { return []; }
}

/** 选一个可用的模型（优先最后一个被激活的） */
function pickModel() {
  const list = caps().filter((c) => c && c.loaded);
  if (!list.length) return null;
  return list.find((c) => c.index === lastModelIndex) || list[0];
}

function allMotions(cap) {
  const out = [];
  for (const g of cap.motionGroups || []) {
    for (let i = 0; i < (g.count || 0); i++) out.push({ group: g.name, index: i });
  }
  return out;
}

/**
 * 执行一个动作意图。
 * @returns {boolean} 是否真的执行了
 */
export function act(intent) {
  if (!intent || typeof intent !== 'object') return false;
  const cap = pickModel();
  if (!cap) { stats.skippedInvalid++; return false; }
  lastModelIndex = cap.index;

  try {
    if (intent.type === 'expression') {
      const name = String(intent.name || '');
      if (!name) return false;
      if (name === 'clear') {
        // 清除由模型侧决定，这里不强制
        return true;
      }
      if (!(cap.expressions || []).includes(name)) { stats.skippedInvalid++; return false; }
      const ok = !!window.__playExpressionAt?.(cap.index, name);
      if (ok) { lastActAt = Date.now(); stats.acts++; }
      return ok;
    }

    // motion
    const motions = allMotions(cap);
    if (!motions.length) { stats.skippedInvalid++; return false; }

    let target = null;
    if (intent.type === 'motion') {
      const m = motions.find((x) => x.group === intent.group && x.index === intent.index);
      if (!m) { stats.skippedInvalid++; return false; }
      target = m;
    } else if (intent.type === 'random') {
      target = motions[Math.floor(Math.random() * motions.length)];
    } else if (intent.type === 'idle') {
      const idle = motions.filter((x) => /idle/i.test(x.group));
      target = idle.length ? idle[Math.floor(Math.random() * idle.length)]
                           : motions[Math.floor(Math.random() * motions.length)];
    }
    if (!target) return false;

    const ok = !!window.__playMotionAt?.(cap.index, target.group, target.index);
    if (ok) { lastActAt = Date.now(); stats.acts++; }
    return ok;
  } catch (e) {
    stats.lastError = String(e);
    return false;
  }
}

/**
 * 解析文本里的动作指令。
 *
 * @param {string} text 模型/模拟源输出的原文
 * @returns {{ text: string, intents: Array }} 去掉指令后的展示文本 + 要执行的动作
 */
export function parseDirectives(text) {
  const intents = [];
  if (typeof text !== 'string' || !text) return { text: text || '', intents };

  const re = /\[\[(act|expr):([^\]]+)\]\]/g;
  let cleanPos = 0;      // 已产出的干净文本长度
  let lastEnd = 0;       // 上一段原文结束位置
  let out = '';
  let m;
  while ((m = re.exec(text)) !== null) {
    out += text.slice(lastEnd, m.index);
    // 该指令在**干净文本**里的位置：流式播到这里时触发最自然
    const at = out.length;
    lastEnd = m.index + m[0].length;

    const kind = m[1];
    const raw = String(m[2] || '').trim();
    if (kind === 'expr') {
      intents.push({ type: 'expression', name: raw, at });
    } else if (raw === 'random') {
      intents.push({ type: 'random', at });
    } else if (raw === 'idle') {
      intents.push({ type: 'idle', at });
    } else {
      const mm = raw.match(/^(.+?)#(\d+)$/);
      if (mm) intents.push({ type: 'motion', group: mm[1], index: Number(mm[2]), at });
    }
  }
  out += text.slice(lastEnd);
  cleanPos = out.length;
  void cleanPos;

  return { text: out, intents };
}

/**
 * 模型驱动：根据一段（流式/完整）文本，执行其中的动作指令。
 * 返回去掉指令后的文本。
 */
export function applyModelText(text) {
  if (!cfg.allowModel) return text;
  const { text: clean, intents } = parseDirectives(text);
  let applied = 0;
  for (const it of intents) {
    if (act(it)) applied++;
  }
  stats.model += applied;
  return clean;
}

/** 本地自主：空闲时自己做小动作 */
function tick() {
  const f = FREQUENCY[cfg.frequency] || FREQUENCY.medium;
  if (f.idleMs === Infinity) return;
  if (!canAct(f.minGapMs)) { return; }

  const idleFor = Date.now() - Math.max(lastActAt, lastInteractionAt);
  if (idleFor < f.idleMs) return;
  if (Math.random() > f.chance) return;

  // 主要做待机类动作；偶尔切表情增加「活着」的感觉
  if (Math.random() < 0.22) {
    const cap = pickModel();
    const exprs = cap?.expressions || [];
    if (exprs.length) {
      const soft = exprs.filter((n) => /^(微笑|眨眼|侧头|害羞)/.test(n));
      const pick = (soft.length ? soft : exprs)[Math.floor(Math.random() * (soft.length || exprs.length))];
      if (act({ type: 'expression', name: pick })) { stats.autonomous++; }
      return;
    }
  }
  if (act({ type: 'idle' })) stats.autonomous++;
}

export function initAutonomy() {
  loadCfg();

  // 用户交互 → 推迟自主行为
  const mark = () => noteInteraction();
  for (const ev of ['pointerdown', 'keydown', 'wheel']) {
    window.addEventListener(ev, mark, { passive: true });
  }

  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    try { tick(); } catch (e) { stats.lastError = String(e); }
  }, 3000);

  // 对外 API（未来接入真实模型时由主进程/预加载调用）
  window.__autonomyParse = (text) => parseDirectives(text);
  window.__aiAct = (intent) => act(intent);
  window.__aiApplyText = (text) => applyModelText(text);
  window.__autonomy = {
    getConfig: () => ({ ...cfg }),
    setConfig: (next) => saveCfg(next),
    stats: () => ({ ...stats }),
    frequencies: () => Object.entries(FREQUENCY).map(([k, v]) => ({ key: k, label: v.label })),
    directiveDoc: () => DIRECTIVE_DOC,
    noteInteraction,
  };

  return { ...cfg };
}
