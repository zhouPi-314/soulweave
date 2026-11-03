/*
 * SoulWeave S7：结构化视觉证据（借鉴 ModLens 的设计思路）
 *
 * 依据：用户决策「参考 ModLens 的设计思路添加你没有的：
 *       全文 OCR（逐行转录）、阅读顺序版面分区、不确定项自述、实体/关系抽取，
 *       学习借鉴它优秀的地方，优化不好的地方，避免它的缺点」。
 *
 * 【为什么不是把 ModLens 装进来】
 * 它是 CLI + Agent 技能（bin: dist/main.js），没有可编程 API；
 * 且部分 provider 会调外部 Agent CLI（agy 甚至带 --dangerously-skip-permissions）。
 * 对桌面应用来说过重，而且会和我们已经跑通的 vision-openai 重复。
 * 所以我们**只借鉴它的产物结构**，用自己的链路实现。
 *
 * 【借鉴了什么】
 *   1. 固定 JSON 形状：ocr / layout / semantics / visual / uncertainty
 *   2. 「证据而非想象」：要求逐行转录 + 阅读顺序，而不是一段散文
 *   3. 自述不确定：模型必须说出自己哪儿没把握
 *
 * 【改进了什么（它的缺点）】
 *   1. 它只靠提示词约束格式，模型经常不听话 → 我们做**严格解析 + 兜底降级**，
 *      解析失败就退回纯文本描述，绝不整条失败。
 *   2. 它要求模型一次吐出全部字段，长图容易截断 → 我们**分档**：
 *      quick（只要摘要+OCR）/ full（全部字段），让用户按需选择。
 *   3. 它没有对「模型编造 OCR」的防护 → 我们做**自检**：
 *      如果 ocr.lines 全空但 summary 里出现引号内容，标记为「可能有编造」。
 *
 * 【纯函数】
 * 提示词构造、响应解析、自检全部不碰 IO，可完整测试。
 */

// ─── 结果形状（与 ModLens 对齐，便于将来互通） ──────

export interface OcrLine {
  text: string;
  /** 置信度（模型给的，0–1；没有则 undefined） */
  confidence?: number;
}

export interface OcrBlock {
  full_text: string;
  lines: OcrLine[];
  /** 检测到的语言 */
  language?: string;
}

export interface LayoutRegion {
  /** 阅读顺序，从 1 开始 */
  reading_order: number;
  /** 区域类型：title / heading / paragraph / list / table / chart / form / code / image / icon / link / nav / button / search / other */
  type: string;
  text: string;
  /** 大致位置（可选，归一化 0–1） */
  bbox?: { x: number; y: number; w: number; h: number };
}

export interface LayoutBlock {
  regions: LayoutRegion[];
}

export interface Entity {
  name: string;
  type: string;
  evidence?: string;
}

export interface Relation {
  subject: string;
  predicate: string;
  object: string;
}

export interface SemanticsBlock {
  scene: string;
  intent?: string;
  entities: Entity[];
  relations: Relation[];
}

export interface VisualBlock {
  dominant_colors?: string[];
  style?: string;
  notes?: string[];
}

export interface VisionEvidence {
  summary: string;
  ocr: OcrBlock;
  layout: LayoutBlock;
  semantics: SemanticsBlock;
  visual: VisualBlock;
  /** 模型自述的不确定项 */
  uncertainty: string[];
  /** 我们自己的自检警告（不是模型说的） */
  selfChecks?: string[];
}

/** 详细程度：quick 只拿摘要+OCR，full 全字段 */
export type EvidenceDepth = 'quick' | 'full';

// ─── 提示词（纯函数） ───────────────────────────────

export const EVIDENCE_SYSTEM_PROMPT =
  '你是一个严谨的图像证据提取器。你只描述**图上真实可见**的内容，绝不推测、不补充常识、不编造看不见的文字。'
  + '如果某处看不清，就把它列进 uncertainty，不要猜。';

/** quick 档：只要摘要 + 逐行文字 */
export function buildQuickPrompt(extra?: string): string {
  const e = String(extra || '').trim();
  const schema = [
    '{',
    '  "summary": "一句话说明这张图是什么",',
    '  "ocr": { "full_text": "图上所有文字，按阅读顺序拼接", "lines": ["逐行文字1", "逐行文字2"], "language": "zh" },',
    '  "uncertainty": ["哪里看不清或不确定"]',
    '}',
  ].join('\n');
  return [
    '请提取这张图的证据，严格按下面的 JSON 输出，不要输出任何其它文字：',
    schema,
    '要求：lines 必须逐行给出，不要合并成一段。没有文字就给空数组。',
    e ? ('额外关注：' + e) : '',
  ].filter(Boolean).join('\n');
}

/** full 档：全部字段 */
export function buildFullPrompt(extra?: string): string {
  const e = String(extra || '').trim();
  const schema = [
    '{',
    '  "summary": "一句话说明这张图是什么",',
    '  "ocr": { "full_text": "所有文字按阅读顺序拼接", "lines": ["逐行文字"], "language": "zh" },',
    '  "layout": { "regions": [',
    '    { "reading_order": 1, "type": "title", "text": "该区域文字" }',
    '  ] },',
    '  "semantics": {',
    '    "scene": "场景描述",',
    '    "intent": "这张图想表达什么（可省略）",',
    '    "entities": [ { "name": "实体名", "type": "person|org|product|place|other", "evidence": "依据" } ],',
    '    "relations": [ { "subject": "A", "predicate": "关系", "object": "B" } ]',
    '  },',
    '  "visual": { "dominant_colors": ["主色"], "style": "风格", "notes": ["视觉细节"] },',
    '  "uncertainty": ["哪里看不清或不确定"]',
    '}',
  ].join('\n');
  return [
    '请提取这张图的完整证据，严格按下面的 JSON 输出，不要输出任何其它文字：',
    schema,
    'type 只能用：title / heading / paragraph / list / table / chart / form / code / image / icon / link / nav / button / search / other。',
    'reading_order 从 1 开始，按人的阅读顺序排。',
    e ? ('额外关注：' + e) : '',
  ].filter(Boolean).join('\n');
}


export function buildEvidencePrompt(depth: EvidenceDepth, extra?: string): string {
  return depth === 'quick' ? buildQuickPrompt(extra) : buildFullPrompt(extra);
}

// ─── 解析（纯函数，核心） ───────────────────────────

const FENCE_RE = /\u0060\u0060\u0060(?:json)?\s*([\s\S]*?)\u0060\u0060\u0060/i;

/**
 * 从模型回复里抠出 JSON。
 *
 * 模型经常这样：先来一句「好的，以下是结果：」，再给 JSON，最后还补一句解释。
 * 也可能用三反引号围栏。三种都要能吃下。
 */
export function extractJsonBlock(text: string): any | null {
  const t = String(text || '');
  if (!t.trim()) return null;

  const candidates: string[] = [];
  const fence = t.match(FENCE_RE);
  if (fence) candidates.push(fence[1]);

  // 找最外层 { ... }（括号配对，能跳过字符串里的括号）
  const start = t.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { candidates.push(t.slice(start, i + 1)); break; }
      }
    }
  }

  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object') return v;
    } catch (e) {
      // 常见毛病：中文引号、尾逗号
      try {
        const fixed = c.replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, '$1');
        const v = JSON.parse(fixed);
        if (v && typeof v === 'object') return v;
      } catch (e2) { /* 继续试下一个 */ }
    }
  }
  return null;
}

const LAYOUT_TYPES = new Set([
  'title', 'heading', 'paragraph', 'list', 'table', 'chart', 'form',
  'code', 'image', 'icon', 'link', 'nav', 'button', 'search', 'other',
]);

function str(v: any, max = 4000): string {
  return v == null ? '' : String(v).slice(0, max);
}

function strArr(v: any, maxItems = 40, maxLen = 300): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x, maxLen)).filter(Boolean).slice(0, maxItems);
}

/** 把任意对象规范成 VisionEvidence（永不抛异常） */
export function normalizeEvidence(raw: any): VisionEvidence {
  const o = raw && typeof raw === 'object' ? raw : {};

  const ocrRaw = o.ocr && typeof o.ocr === 'object' ? o.ocr : {};
  const linesRaw = Array.isArray(ocrRaw.lines) ? ocrRaw.lines : [];
  const lines: OcrLine[] = [];
  for (const l of linesRaw) {
    if (typeof l === 'string') {
      const t = l.trim();
      if (t) lines.push({ text: t.slice(0, 500) });
    } else if (l && typeof l === 'object') {
      const t = str(l.text, 500).trim();
      if (!t) continue;
      const conf = Number(l.confidence);
      lines.push(Number.isFinite(conf) ? { text: t, confidence: Math.max(0, Math.min(1, conf)) } : { text: t });
    }
  }
  const fullText = str(ocrRaw.full_text, 20000).trim() || lines.map((l) => l.text).join('\n');

  const layoutRaw = o.layout && typeof o.layout === 'object' ? o.layout : {};
  const regionsRaw = Array.isArray(layoutRaw.regions) ? layoutRaw.regions : [];
  const regions: LayoutRegion[] = [];
  for (const r of regionsRaw) {
    if (!r || typeof r !== 'object') continue;
    const text = str(r.text, 2000).trim();
    if (!text) continue;
    const type = LAYOUT_TYPES.has(String(r.type)) ? String(r.type) : 'other';
    const order = Number(r.reading_order);
    const region: LayoutRegion = {
      reading_order: Number.isFinite(order) && order > 0 ? Math.floor(order) : regions.length + 1,
      type,
      text,
    };
    if (r.bbox && typeof r.bbox === 'object') {
      const b = { x: Number(r.bbox.x), y: Number(r.bbox.y), w: Number(r.bbox.w), h: Number(r.bbox.h) };
      if (Object.values(b).every((n) => Number.isFinite(n))) region.bbox = b;
    }
    regions.push(region);
  }
  regions.sort((a, b) => a.reading_order - b.reading_order);

  const semRaw = o.semantics && typeof o.semantics === 'object' ? o.semantics : {};
  const entities: Entity[] = [];
  for (const e of (Array.isArray(semRaw.entities) ? semRaw.entities : [])) {
    if (!e) continue;
    if (typeof e === 'string') { const n = e.trim(); if (n) entities.push({ name: n.slice(0, 120), type: 'other' }); continue; }
    const name = str(e.name, 120).trim();
    if (!name) continue;
    entities.push({
      name,
      type: str(e.type, 30).trim() || 'other',
      evidence: e.evidence ? str(e.evidence, 300) : undefined,
    });
  }
  const relations: Relation[] = [];
  for (const r of (Array.isArray(semRaw.relations) ? semRaw.relations : [])) {
    if (!r || typeof r !== 'object') continue;
    const s = str(r.subject, 120).trim();
    const p = str(r.predicate, 120).trim();
    const ob = str(r.object, 120).trim();
    if (s && p && ob) relations.push({ subject: s, predicate: p, object: ob });
  }

  const visRaw = o.visual && typeof o.visual === 'object' ? o.visual : {};

  return {
    summary: str(o.summary, 2000).trim(),
    ocr: {
      full_text: fullText,
      lines,
      language: ocrRaw.language ? str(ocrRaw.language, 20) : undefined,
    },
    layout: { regions },
    semantics: {
      scene: str(semRaw.scene, 1000).trim(),
      intent: semRaw.intent ? str(semRaw.intent, 500) : undefined,
      entities: entities.slice(0, 60),
      relations: relations.slice(0, 60),
    },
    visual: {
      dominant_colors: strArr(visRaw.dominant_colors, 12, 40),
      style: visRaw.style ? str(visRaw.style, 120) : undefined,
      notes: strArr(visRaw.notes, 20, 300),
    },
    uncertainty: strArr(o.uncertainty, 20, 300),
  };
}

// ─── 自检（我们比 ModLens 多做的一层） ──────────────

/**
 * 检查证据是否可能被编造。
 *
 * 真实场景：模型没认出文字，却在 summary 里写「图中写着『恭喜中奖』」。
 * 这种「引号里出现具体内容、但 ocr 是空的」的情况，八成是脑补。
 */
export function selfCheckEvidence(ev: VisionEvidence): string[] {
  const warns: string[] = [];
  const ocrText = (ev.ocr.full_text || '').trim();
  const summary = ev.summary || '';

  if (!ocrText && ev.ocr.lines.length === 0) {
    const quoted = summary.match(/[「『“\"]([^」』”\"]{2,40})[」』”\"]/);
    if (quoted) {
      warns.push('摘要里引用了具体文字（' + quoted[1] + '），但没有提取到任何 OCR 文字，可能是在猜测。');
    }
  }

  if (ev.layout.regions.length > 0 && !ocrText) {
    warns.push('识别到版面分区，但没有任何文字内容，版面判断可能不准。');
  }

  const maxOrder = ev.layout.regions.reduce((m, r) => Math.max(m, r.reading_order), 0);
  if (maxOrder > ev.layout.regions.length + 5) {
    warns.push('阅读顺序编号跳跃较大，版面排序可能有问题。');
  }

  if (!ev.summary && ev.ocr.lines.length === 0 && ev.semantics.entities.length === 0) {
    warns.push('几乎没有提取到任何内容，这张图可能太小、太模糊，或模型没有正常工作。');
  }

  if (ev.uncertainty.length === 0 && ev.ocr.lines.length > 15) {
    warns.push('提取了大量文字却没有列出任何不确定项，值得复核。');
  }

  return warns;
}

/**
 * 把证据压成一段可读文本（给聊天回复 / 记忆用）。
 *
 * 为什么需要：结构化 JSON 不适合直接塞进对话，
 * 但用户问「图里写了啥」时，他最想看的正是 OCR 那几行。
 */
export function evidenceToText(ev: VisionEvidence, opts: { maxLines?: number } = {}): string {
  const maxLines = opts.maxLines ?? 30;
  const out: string[] = [];
  if (ev.summary) out.push(ev.summary);
  if (ev.ocr.lines.length) {
    const lines = ev.ocr.lines.slice(0, maxLines).map((l) => l.text);
    out.push('图中文字：\n' + lines.join('\n') + (ev.ocr.lines.length > maxLines ? ('\n…（共 ' + ev.ocr.lines.length + ' 行）') : ''));
  } else if (ev.ocr.full_text) {
    out.push('图中文字：' + ev.ocr.full_text.slice(0, 800));
  }
  if (ev.layout.regions.length) {
    const titles = ev.layout.regions.filter((r) => r.type === 'title' || r.type === 'heading').map((r) => r.text);
    if (titles.length) out.push('标题：' + titles.slice(0, 5).join(' / '));
  }
  if (ev.semantics.entities.length) {
    out.push('实体：' + ev.semantics.entities.slice(0, 10).map((e) => e.name).join('、'));
  }
  if (ev.uncertainty.length) {
    out.push('不确定：' + ev.uncertainty.slice(0, 5).join('；'));
  }
  return out.join('\n\n');
}

/** 证据是否「空」（什么都没提取到） */
export function isEvidenceEmpty(ev: VisionEvidence): boolean {
  return !ev.summary
    && ev.ocr.lines.length === 0
    && !ev.ocr.full_text
    && ev.layout.regions.length === 0
    && ev.semantics.entities.length === 0;
}