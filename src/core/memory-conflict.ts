/**
 * SoulWeave S4：记忆冲突自动检测
 *
 * 【不调模型】用向量相似度 + 极性词判断，零成本。
 *
 * 判定规则：
 *   相似度 ≥ 0.95                        → duplicate（疑似重复）
 *   0.80 ≤ 相似度 < 0.95 且极性相反      → contradiction（互相矛盾）
 *   其他                                  → 不算冲突
 *
 * 【极性怎么判】
 * 中文里同一件事的正反表达，通常一边有否定词或反义动词。
 * 例如「我喜欢下雨天」vs「我讨厌下雨天」—— 向量很像，但极性相反。
 * 这是启发式，会有误报，所以只**建议**冲突，由用户裁决。
 *
 * 【为什么只跟「最近 N 条」比】
 * 全量两两比较是 O(N²)，2 万条要 2 亿次运算。
 * 新写入的记忆才是可能冲突的来源，所以只拿最近的去比。
 */

import type { MemoryRepository } from './memory-repository.js';

export const DUP_THRESHOLD = 0.95;
export const CONTRA_THRESHOLD = 0.80;

/** 否定词 / 反义动词 */
const NEGATIVE_RE = /(不|没|别|勿|讨厌|害怕|受不了|拒绝|不想|不喜欢|不爱|厌恶)/;
const POSITIVE_RE = /(喜欢|爱|想要|愿意|开心|高兴|期待|乐意)/;

function polarity(text: string): -1 | 0 | 1 {
  const s = String(text || '');
  const neg = NEGATIVE_RE.test(s);
  const pos = POSITIVE_RE.test(s);
  if (neg && !pos) return -1;
  if (pos && !neg) return 1;
  return 0;  // 混合或都没有 → 不判极性
}

// ── 槽位识别（识别「同一事实的不同值」）──────────────────
//
// 为什么需要：向量相似度对「我在北京」和「我搬到上海了」只有中等相似度
// （主语相同、地点不同），极性词也判不出来 —— 两句话没有任何否定词。
// 但语义上它们是**同一个人在不同时间的居住地**，后者应该取代前者。
//
// 做法：把「槽位 + 值」抽出来。同一槽位、不同值 → 冲突或过时。
// 这不需要模型，只需要一张槽位词典。

export type SlotName =
  | 'location' | 'job' | 'name' | 'age' | 'birthday' | 'pet'
  | 'school' | 'major' | 'hometown' | 'family' | 'diet'
  | 'allergy' | 'health' | 'bloodType' | 'zodiac'
  | 'partner' | 'income' | 'contact' | 'vehicle' | 'skill';

export interface SlotValue {
  slot: SlotName;
  value: string;
}

/**
 * 槽位模式。
 *
 * 【句式覆盖】正则前允许一些无意义的铺垫词（现在/目前/其实/最近/以前…），
 * 否则「我现在人在上海」这种说法会漏掉。
 * 每个槽位可以有多个模式，取第一个命中的。
 */
const SLOT_PATTERNS: Array<{ slot: SlotName; re: RegExp }> = [
  // 地点
  // 值用惰性 + 短上限：城市名一般 2-4 字。贪婪会把「北京很久了而」整段吞掉，
  // 导致「旧句是否还有额外信息」的判断失效。
  { slot: 'location', re: /(?:现在|目前|最近|已经)?(?:我)?(?:人)?在([\u4e00-\u9fa5A-Za-z]{2,6}?)(?:工作|上班|生活|读书|上学|住)/ },
  { slot: 'location', re: /(?:我)?(?:现在|目前|最近|已经)?(?:住在|搬到|搬去|搬家到|搬到了|家住|定居在|人在)([\u4e00-\u9fa5A-Za-z]{2,6}?)/ },
  // 老家
  { slot: 'hometown', re: /(?:我)?(?:老家|籍贯|出生于|来自)(?:是|在)?([\u4e00-\u9fa5]{2,6}?)/ },
  // 工作
  { slot: 'job', re: /(?:我)?(?:现在|目前)?(?:的)?(?:职业|工作)是([\u4e00-\u9fa5A-Za-z]{2,12})/ },
  // 职业：直接用名词表捕获。之前写成「(前缀)(X)(后缀)」，遇到「程序员」这种
  // 本身就在后缀表里的词，会把「一名」当值抓走。
  { slot: 'job', re: /(?:我)?(?:现在|目前)?(?:是|当|做)(?:一|两|三)?(?:名|位)?(程序员|工程师|老师|教师|医生|护士|律师|会计|设计师|编辑|记者|销售|司机|厨师|警察|军人|学生|研究生|博士生|经理|主管|老板|创业者|自由职业者)/ },
  // 名字
  { slot: 'name', re: /(?:我)?(?:叫|名字是|名叫|昵称是)([\u4e00-\u9fa5A-Za-z]{2,4})/ },
  // 年龄
  { slot: 'age', re: /(?:我)?(?:今年)?(\d{1,3})\s*(?:岁|周岁)/ },
  // 生日 / 星座 / 血型
  { slot: 'birthday', re: /(?:我)?(?:的)?生日(?:是|在)?([\u4e00-\u9fa5\d]{2,12})/ },
  { slot: 'zodiac', re: /(?:我)?(?:是|星座是)([\u4e00-\u9fa5]{2,4})(?:座)/ },
  { slot: 'bloodType', re: /(?:我)?(?:是)?(A|B|AB|O)型血/i },
  // 学校 / 专业
  { slot: 'school', re: /(?:我)?(?:在|读|毕业于)([\u4e00-\u9fa5]{1,12}(?:大学|学院|中学|高中|小学))/ },
  { slot: 'major', re: /(?:我)?(?:的)?专业(?:是)([\u4e00-\u9fa5]{2,10})/ },
  // 家庭 / 伴侣
  { slot: 'family', re: /(?:我)?(?:有|养了)?(\d+)\s*个(?:孩子|儿子|女儿|兄弟|姐妹)/ },
  { slot: 'partner', re: /(?:我)?(?:的)?(?:老婆|老公|妻子|丈夫|男朋友|女朋友|对象)(?:是|叫)?([\u4e00-\u9fa5]{1,10})/ },
  // 饮食 / 过敏
  { slot: 'diet', re: /(?:我)?(?:是)?(素食|吃素|清真|不吃辣|吃辣|忌口)/ },
  { slot: 'allergy', re: /(?:我)?(?:对)?([\u4e00-\u9fa5]{1,8})(?:过敏)/ },
  // 健康
  { slot: 'health', re: /(?:我)?(?:有|患有)([\u4e00-\u9fa5]{2,10})(?:病|症|高血压|糖尿病)/ },
  // 收入
  { slot: 'income', re: /(?:我)?(?:月薪|年薪|工资|收入)(?:是|有)?(\d+[\u4e00-\u9fa5]{0,3})/ },
  // 联系方式
  { slot: 'contact', re: /(?:我)?(?:的)?(?:手机|电话|微信|QQ)(?:号|号码)?(?:是|为)?(\d{5,15})/ },
  // 交通工具
  { slot: 'vehicle', re: /(?:我)?(?:开|买了|有)([\u4e00-\u9fa5A-Za-z]{1,10})(?:车|汽车)/ },
  // 技能 / 语言
  // 技能：后缀（语/编程…）属于值本身，要一起捕获，否则「我会日语」只得到「日」
  { slot: 'skill', re: /(?:我)?(?:会|懂|擅长)([\u4e00-\u9fa5]{1,9}(?:语|文|编程|画画|跳舞|唱歌|书法|摄影))/ },
  // 宠物
  { slot: 'pet', re: /(?:我)?(?:养了|养着|有一只|有一只叫)([\u4e00-\u9fa5]{1,8})/ },

  // ── 值在前的语序（中文里很常见，倒装句）──────────────
  // 「上海那边我住惯了」「北京我待过几年」
  { slot: 'location', re: /([\u4e00-\u9fa5]{2,6}?)(?:那边|那儿|这边|这儿).{0,6}(?:住|生活|工作|待|呆|定居)/ },
  // 「我是上海人」——籍贯
  { slot: 'hometown', re: /(?:我)?(?:是)?([\u4e00-\u9fa5]{2,6}?)人(?![们民])/ },
];

/**
 * 停用词：宽松模式抓到这些值一定是错的（它们不是实体名）。
 * 没有这层过滤，宽松模式会产生大量垃圾槽位。
 */
const STOPWORD_RE = /^(了|的|是|我|你|他|她|它|在|和|就|都|也|很|太|不|没|有|这个|那个|什么|怎么|现在|以前|一下|一点|一会|时候)$/;

/** 宽松兜底：抓「动词/介词 + 短实体」，用停用词挡掉垃圾 */
const LOOSE_PATTERNS: Array<{ slot: SlotName; re: RegExp }> = [
  { slot: 'location', re: /(?:住在|搬到|搬去|去过|去了|到了|回到)([\u4e00-\u9fa5]{2,6})/ },
  { slot: 'hometown', re: /(?:老家|籍贯|祖籍|出生在|生在)(?:是|在)?([\u4e00-\u9fa5]{2,6})/ },
  { slot: 'job', re: /(?:干|做|当|搞)([\u4e00-\u9fa5]{2,6})(?:的|工作|这行)?/ },
  { slot: 'name', re: /(?:叫|称呼)(?:我)?([\u4e00-\u9fa5A-Za-z]{2,4})/ },
  { slot: 'age', re: /(\d{1,3})\s*(?:岁|周岁)/ },
  { slot: 'birthday', re: /(?:生日|出生)(?:是|在)?([\u4e00-\u9fa5\d]{2,12})/ },
  { slot: 'school', re: /(?:上|念|读|考)(?:了|上)?([\u4e00-\u9fa5]{2,10}(?:大学|学院|中学|高中))/ },
  { slot: 'major', re: /(?:学|念|读)([\u4e00-\u9fa5]{2,8})(?:专业)?/ },
  { slot: 'family', re: /(\d+)\s*个(?:孩子|儿子|女儿|兄弟|姐妹)/ },
  { slot: 'partner', re: /(?:老婆|老公|妻子|丈夫|对象|另一半)(?:是|叫)?([\u4e00-\u9fa5]{1,6})/ },
  { slot: 'diet', re: /(素食|吃素|清真|不吃辣|吃辣|忌口)/ },
  { slot: 'allergy', re: /([\u4e00-\u9fa5]{1,8})过敏/ },
  { slot: 'health', re: /(?:得|患)(?:了)?([\u4e00-\u9fa5]{2,8}(?:病|症))/ },
  { slot: 'bloodType', re: /(A|B|AB|O)型血/i },
  { slot: 'zodiac', re: /([\u4e00-\u9fa5]{2,4})座/ },
  { slot: 'income', re: /(?:月薪|年薪|工资|收入)(?:是|有)?(\d+)/ },
  { slot: 'contact', re: /(?:手机|电话|微信|QQ)(?:号)?(?:是)?(\d{5,15})/ },
  { slot: 'vehicle', re: /(?:开|买)(?:了)?([\u4e00-\u9fa5A-Za-z]{1,8})(?:车)?/ },
  { slot: 'skill', re: /(?:会|懂|能)([\u4e00-\u9fa5]{1,9}(?:语|文|编程|画画|唱歌))/ },
  { slot: 'pet', re: /(?:养|喂)(?:了|着)?([\u4e00-\u9fa5]{1,6})/ },
];

/** 「变化」信号：出现这些词说明是新状态，应该取代旧状态 */
const CHANGE_RE = /(搬到|搬去|搬家|现在|已经|改成|换了|不再是|改为|变成|不再)/;

/**
 * 中文口语归一化：把同一句话的不同说法收敛成一种形态。
 *
 * 正则漏的很大一部分不是「句式没想到」，而是「同一句话有十种口语写法」。
 * 归一化比继续堆正则更有效。
 */
/**
 * 只用于**槽位抽取前**的归一化。
 *
 * ⚠️ 绝对不要用它去写库：它删掉口语填充词、替换人称，
 * 存进去就不是用户原话了。原文必须保持一字不差。
 */
export function normalizeForExtraction(input: string): string {
  let s = String(input || '');
  // 全角 ASCII → 半角（ＡＢＣ１２３ → ABC123）
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  // 人称归一：俺/咱/咱们/本人 → 我
  s = s.replace(/(俺|咱|咱们|本人|我自己)/g, '我');
  // 口语填充词
  s = s.replace(/(嗯+|啊+|呃+|那个|就是说|然后呢|其实呢|反正吧?|大概吧?)/g, '');
  // 重复空格
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

export function extractSlots(text: string): SlotValue[] {
  const s = normalizeForExtraction(text);
  const out: SlotValue[] = [];
  for (const { slot, re } of SLOT_PATTERNS) {
    const m = s.match(re);
    if (m && m[1]) {
      const v = m[1].trim();
      if (v.length >= 1 && !STOPWORD_RE.test(v) && !out.some((x) => x.slot === slot)) {
        out.push({ slot, value: v });
      }
    }
  }
  // 兜底：严格模式一个槽位都没抓到，或某个常见槽位缺了，才用宽松模式
  for (const { slot, re } of LOOSE_PATTERNS) {
    if (out.some((x) => x.slot === slot)) continue;
    const m = s.match(re);
    if (m && m[1]) {
      const v = m[1].trim();
      if (v.length >= 1 && !STOPWORD_RE.test(v)) out.push({ slot, value: v });
    }
  }
  return out;
}

/** 两个值的字面相似度（简单包含判断，够用） */
function valueSimilar(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  return false;
}

/**
 * 槽位级冲突判定。
 * 同一槽位、不同值：
 *   · 其中一条含「变化」词 → stale（新的取代旧的）
 *   · 都不含变化词       → contradiction（真的矛盾）
 */
export function slotConflict(rawA: string, rawB: string):
  { kind: 'contradiction' | 'stale'; slot: SlotName; a: string; b: string } | null {
  const sa = extractSlots(rawA);
  const sb = extractSlots(rawB);
  for (const x of sa) {
    for (const y of sb) {
      if (x.slot !== y.slot) continue;
      if (valueSimilar(x.value, y.value)) continue;
      const aChanged = CHANGE_RE.test(rawA);
      const bChanged = CHANGE_RE.test(rawB);
      return {
        kind: (aChanged || bChanged) ? 'stale' : 'contradiction',
        slot: x.slot, a: x.value, b: y.value,
      };
    }
  }
  return null;
}

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += Number(a[i]) * Number(b[i]);
  return s;
}

function slotLabel(s: SlotName): string {
  switch (s) {
    case 'location': return '地点';
    case 'job': return '工作';
    case 'name': return '名字';
    case 'age': return '年龄';
    case 'birthday': return '生日';
    case 'pet': return '宠物';
    case 'school': return '学校';
    case 'major': return '专业';
    case 'hometown': return '老家';
    case 'family': return '家庭';
    case 'diet': return '饮食';
    case 'allergy': return '过敏';
    case 'health': return '健康';
    case 'bloodType': return '血型';
    case 'zodiac': return '星座';
    case 'partner': return '伴侣';
    case 'income': return '收入';
    case 'contact': return '联系方式';
    case 'vehicle': return '车辆';
    case 'skill': return '技能';
    default: return '事实';
  }
}


// ── 结构化合并 ──────────────────────────────────────────
//
// 「合并」不该是简单把两句话拼起来 —— 那会得到「我住在北京 / 我搬到上海了」
// 这种自相矛盾的记忆。真正该做的是：
//   · 槽位冲突时保留**新**的那个值（有变化词的一方）
//   · 只补充对方独有的信息（不同槽位 / 不重叠的句子）
//   · 完全重复的句子去掉

/**
 * 复杂语义标记：因果 / 条件 / 转折。
 *
 * 含这些词的句子**永远不整句丢弃** —— 丢掉「如果下雨我就不出门」，
 * 剩下的「我喜欢雨天」意思就变了。这类句子保留下来最多是冗余，
 * 删掉却会产生错误记忆。
 */
const KEEP_ALWAYS_RE = /(因为|所以|因此|如果|假如|要是|否则|但是|不过|虽然|即使|只有|除非|一旦)/;

/**
 * 隐含因果/条件：没有连接词，但用逗号把「情况」和「结果」并在一起。
 * 例：「下雨了，我不去」「太贵了，算了」。
 * 判据：句中出现逗号（，或,）且逗号后还有内容 —— 这种句子有前后依赖，
 * 合并时不能整句丢弃，否则会丢掉半句逻辑。
 */
function hasImplicitLogic(s: string): boolean {
  // 全角/半角逗号、分号、冒号、破折号都算「前后依赖」的分隔
  const m = String(s || '').match(/[，,；;：:—–]/);
  if (!m || m.index === undefined) return false;
  const after = s.slice(m.index + 1).replace(/[\s\p{P}]/gu, '');
  return after.length >= 2;
}

/** 字符二元组 Jaccard 相似度（判断两句话是不是在说同一件事） */
function textSim(a: string, b: string): number {
  const grams = (s: string) => {
    const out = new Set<string>();
    const x = s.replace(/[\s\p{P}]/gu, '');
    for (let i = 0; i < x.length - 1; i++) out.add(x.slice(i, i + 2));
    return out;
  };
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

function splitSentences(text: string): string[] {
  return String(text || '')
    .split(/[。！？!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

export interface MergeResult {
  content: string;
  /** 保留了哪一方的新状态 */
  keptNewer: 'a' | 'b' | 'none';
  /** 去掉了多少重复句 */
  droppedDuplicates: number;
  /** 因槽位冲突被丢弃的旧值 */
  superseded: Array<{ slot: SlotName; old: string; kept: string }>;
}

/**
 * 结构化合并两条记忆。
 * @param preferNewer 都没有变化词时，倾向保留哪一方（默认 a）
 */
export function smartMerge(a: string, b: string, preferNewer: 'a' | 'b' = 'a'): MergeResult {
  const aChanged = CHANGE_RE.test(a);
  const bChanged = CHANGE_RE.test(b);
  let newer: 'a' | 'b' = 'none' as any;
  if (aChanged && !bChanged) newer = 'a';
  else if (bChanged && !aChanged) newer = 'b';
  else newer = preferNewer;

  const newerText = newer === 'a' ? a : b;
  const olderText = newer === 'a' ? b : a;

  const newerSentences = splitSentences(newerText);
  const olderSentences = splitSentences(olderText);

  // 新的一方已经覆盖的槽位
  const covered = new Set<SlotName>();
  for (const s of newerSentences) for (const sv of extractSlots(s)) covered.add(sv.slot);

  const kept: string[] = [...newerSentences];
  const superseded: Array<{ slot: SlotName; old: string; kept: string }> = [];
  let dropped = 0;

  for (const s of olderSentences) {
    // 重复句丢弃 —— 但含因果/条件/转折的句子即使高度相似也不丢，
    // 它们的连接词承载了不同的意义
    if (kept.some((k) => textSim(k, s) >= 0.85)) {
      if (KEEP_ALWAYS_RE.test(s) || hasImplicitLogic(s)) { kept.push(s); continue; }
      dropped++;
      continue;
    }
    // 槽位已被新的一方占用的，旧值作废
    const slots = extractSlots(s);
    if (slots.length && slots.some((sv) => covered.has(sv.slot))) {
      const sc = slotConflict(newerText, s);
      if (sc) {
        // 注意：slotConflict 的第一个参数是 newerText，所以 sc.a 来自新的一方
        superseded.push({ slot: sc.slot, old: sc.b, kept: sc.a });
        // 复杂语义句不能整句丢 —— 改成保留为「以前：…」，信息不丢但明确标为历史
        // 「旧句还有额外信息」= 去掉槽位值后仍剩 ≥6 个字
        // （不能只比长度：值被贪婪匹配时长度会虚高）
        const restLen = s.split(sc.b).join('').replace(/[\s\p{P}]/gu, '').length;
        if (KEEP_ALWAYS_RE.test(s) || hasImplicitLogic(s) || restLen >= 6) {
          kept.push('（以前：' + s + '）');
        } else {
          dropped++;
        }
        continue;
      }
    }
    kept.push(s);
  }

  return {
    content: kept.join('。') + '。',
    keptNewer: newer,
    droppedDuplicates: dropped,
    superseded,
  };
}

// ── LSH：把 O(新×全) 降到 O(新×桶内) ──────────────────
//
// 随机超平面 LSH：用 k 个随机向量，按点积符号取位，得到 k 位签名。
// 余弦越高的两条记忆，签名相同的概率越大。
// 只比较「签名汉明距离 ≤ 2」的对，把候选量压下去。

/**
 * LSH 位数：自适应。
 * 记忆越多需要越多位来避免桶变大 —— 桶越大，桶内两两比较越接近全扫。
 * 粗糙但有效的经验值：2^bits ≈ N/4。
 */
const LSH_BITS_TIERS: Array<{ maxN: number; bits: number }> = [
  { maxN: 2000, bits: 12 },
  { maxN: 10000, bits: 14 },
  { maxN: 50000, bits: 16 },
  { maxN: Infinity, bits: 18 },
];

export function lshBitsFor(n: number): number {
  for (const tier of LSH_BITS_TIERS) if (n <= tier.maxN) return tier.bits;
  return 18;
}

function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const _planeCache = new Map<string, Float32Array[]>();

function hyperplanes(dim: number, bits: number): Float32Array[] {
  const key = dim + ':' + bits;
  const hit = _planeCache.get(key);
  if (hit) return hit;
  const rnd = seededRandom(20261030);
  const planes: Float32Array[] = [];
  for (let k = 0; k < bits; k++) {
    const v = new Float32Array(dim);
    for (let i = 0; i < dim; i++) v[i] = rnd() * 2 - 1;
    planes.push(v);
  }
  _planeCache.set(key, planes);
  return planes;
}

export function lshSignature(vec: number[], bits?: number, center?: number[] | null): number {
  const planes = hyperplanes(vec.length, bits || 14);
  let sig = 0;
  for (let k = 0; k < planes.length; k++) {
    const pl = planes[k];
    let dot = 0;
    for (let i = 0; i < pl.length; i++) {
      // 去中心化：减掉数据集的均值向量。
      // bge 这类模型的向量有一个很大的共同分量，不减去的话
      // 任意两句话的夹角都很小，签名几乎一样，LSH 就失效了。
      const v = center && i < center.length ? vec[i] - center[i] : vec[i];
      dot += pl[i] * v;
    }
    if (dot > 0) sig |= (1 << k);
  }
  return sig;
}

/**
 * 中心向量缓存。
 *
 * 每次检测都重算均值会让桶边界随数据集漂移 —— 同一对记忆这次落同桶、
 * 下次落不同桶，检测结果不稳定。
 * 所以按「角色」缓存，只有在记忆条数变化超过 20% 时才重算。
 */
const _centerCache = new Map<string, { center: number[]; count: number; at: number }>();
/** 中心向量的最长复用时间（毫秒）。超过就重算，避免长期漂移。 */
const CENTER_TTL_MS = 5 * 60 * 1000;

export function cachedCenter(ownerKey: string, vecs: number[][]): number[] | null {
  const count = vecs.length;
  const now = Date.now();
  const hit = _centerCache.get(ownerKey);
  if (hit) {
    const fresh = hit.at > 0 && now - hit.at < CENTER_TTL_MS;
    const closeEnough = Math.abs(hit.count - count) <= Math.max(5, count * 0.1);
    // 两个条件都满足才复用：条数变化小 **且** 没过期
    if (fresh && closeEnough) return hit.center;
  }
  const center = meanVector(vecs);
  if (center) _centerCache.set(ownerKey, { center, count, at: now });
  return center;
}

/** 清空缓存（配置变更 / 手动刷新时调用） */
export function clearConflictCaches(): void {
  _centerCache.clear();
}

/**
 * 标记某个角色的中心向量已过期。
 *
 * 记忆增删后条数/分布会变，但如果只靠 TTL 和「条数变化 10%」判断，
 * 小规模变动（比如删掉最相似的 3 条）在 TTL 内仍会用旧中心。
 * 所以写操作直接打脏标记，下一次检测必然重算。
 */
export function markCenterDirty(ownerKey: string): void {
  const hit = _centerCache.get(ownerKey);
  if (hit) _centerCache.set(ownerKey, { ...hit, at: 0 });
}

/** 计算一组向量的均值（用于 LSH 去中心化） */
export function meanVector(vecs: number[][]): number[] | null {
  const nonEmpty = vecs.filter((v) => Array.isArray(v) && v.length);
  if (!nonEmpty.length) return null;
  const dim = nonEmpty[0].length;
  const sum = new Float64Array(dim);
  for (const v of nonEmpty) {
    const n = Math.min(dim, v.length);
    for (let i = 0; i < n; i++) sum[i] += v[i];
  }
  const out: number[] = new Array(dim);
  for (let i = 0; i < dim; i++) out[i] = sum[i] / nonEmpty.length;
  return out;
}

function hamming(a: number, b: number): number {
  let x = a ^ b;
  let n = 0;
  while (x) { x &= (x - 1); n++; }
  return n;
}

export interface DetectStats {
  /** LSH 预筛后实际比较的次数 */
  compared: number;
  /** 如果不预筛要比较多少次 */
  bruteForce: number;
  /** 跳过比例 */
  savedRatio: number;
}

/**
 * 槽位触发词：只有含这些词的记忆才可能产生槽位冲突。
 * 用于在 SQL 侧先缩小候选，避免对上万条记忆做正则。
 */
export const SLOT_TRIGGER_RE =
  '(住|搬|老家|籍贯|职业|工作|叫|名字|岁|生日|星座|型血|大学|学院|专业|孩子|老婆|老公|对象|素食|清真|过敏|月薪|年薪|工资|收入|手机|微信|养了|那边|这儿|擅长|懂)';

export interface ConflictCandidate {
  aId: string;
  bId: string;
  aContent: string;
  bContent: string;
  score: number;
  kind: 'duplicate' | 'contradiction' | 'stale';
  reason: string;
}

export interface DetectResult {
  ok: boolean;
  scanned: number;
  compared: number;
  found: number;
  created: number;
  skippedExisting: number;
  /** LSH 预筛统计 */
  bruteForceCompared?: number;
  savedRatio?: number;
  /** 本次用的 LSH 位数（随记忆量自适应） */
  lshBits?: number;
  /** 槽位扫描的候选行数（SQL 预筛后） */
  slotScanned?: number;
  ms?: number;
  candidates?: ConflictCandidate[];
  error?: string;
}

export interface DetectOptions {
  /** 只检查最近多少条新记忆（默认 200） */
  maxNew?: number;
  /** true 只返回候选，不写库 */
  dryRun?: boolean;
  /** 每条的候选上限（默认 20，避免 O(N²)） */
  topK?: number;
  /** 槽位扫描候选上限（默认 2000，SQL 预筛后） */
  maxSlotScan?: number;
}

/**
 * 检测某个角色的记忆冲突。
 * 拿「最近 maxNew 条」去和「该角色全部记忆」比。
 */
export async function detectConflicts(
  repo: MemoryRepository,
  ownerCharacter: string,
  opts: DetectOptions = {}
): Promise<DetectResult> {
  const t0 = Date.now();
  const maxNew = Math.min(Math.max(opts.maxNew || 200, 1), 2000);
  const topK = Math.min(Math.max(opts.topK || 20, 1), 100);
  const dry = opts.dryRun === true;

  // 取该角色全部未删记忆（带向量）
  // 向量可能存于三处：f32（精确）、q（int8）、旧 real[]。
  // 只要任意一个非空就算有向量 —— 不能只判 embedding，它已被压缩清空。
  const all = await repo.exec(
    "SELECT id, content, importance, embedding_q, embedding_f32, created_at FROM memories " +
    "WHERE owner_character = :'owner'::uuid AND deleted_at IS NULL " +
    "AND (embedding_q IS NOT NULL OR embedding_f32 IS NOT NULL) " +
    "ORDER BY created_at DESC",
    { owner: ownerCharacter });
  if (!all.ok) return { ok: false, scanned: 0, compared: 0, found: 0, created: 0, skippedExisting: 0, error: all.error };

  const rows = (all.rows || []).map((x: any, i: number) => {
    // 优先 float32（精确）；没有就退 int8；再没有才用旧 real[]
    let vec: number[] = [];
    if (x.embedding_f32) {
      const b: Buffer = Buffer.isBuffer(x.embedding_f32) ? x.embedding_f32 : Buffer.from(x.embedding_f32);
      if (b.length % 4 === 0) {
        vec = new Array(b.length / 4);
        for (let k = 0; k < vec.length; k++) vec[k] = b.readFloatLE(k * 4);
      }
    }
    if (!vec.length && x.embedding_q) {
      const b: Buffer = Buffer.isBuffer(x.embedding_q) ? x.embedding_q : Buffer.from(x.embedding_q);
      vec = new Array(b.length);
      for (let k = 0; k < b.length; k++) vec[k] = (b[k] - 128) / 127;
    }
    return { id: x.id as string, content: String(x.content || ''), vec, order: i };
  }).filter((x) => x.vec.length > 0);

  const news = rows.slice(0, maxNew);
  const found: ConflictCandidate[] = [];
  let compared = 0;

  // ── 槽位扫描：SQL 预筛 + 按槽位分组，只在组内两两比较 ──
  //
  // 旧做法是「每条新记忆 × 全部记忆」做正则，记忆上万时是 O(新×全) 次正则。
  // 现在：
  //   1. SQL 用触发词先缩小候选（大部分闲聊记忆直接被排除）
  //   2. 每条只做一次正则抽出槽位
  //   3. 按槽位名分组，**只在同组内**比较（同槽位才可能冲突）
  // 复杂度：O(候选) 次正则 + O(Σ 组内对数)。
  const maxSlotScan = Math.min(Math.max(opts.maxSlotScan || 2000, 1), 20000);
  const slotQ = await repo.exec(
    "SELECT id, content FROM memories " +
    "WHERE owner_character = :'owner'::uuid AND deleted_at IS NULL " +
    "  AND content ~ :'trigger' " +
    "ORDER BY created_at DESC LIMIT " + maxSlotScan,
    { owner: ownerCharacter, trigger: SLOT_TRIGGER_RE });
  const slotRows = (slotQ.rows || []).map((x: any) => ({
    id: x.id as string,
    content: String(x.content || ''),
  }));

  const groups = new Map<SlotName, Array<{ id: string; content: string; value: string }>>();
  for (const r of slotRows) {
    for (const sv of extractSlots(r.content)) {
      const arr = groups.get(sv.slot) || [];
      arr.push({ id: r.id, content: r.content, value: sv.value });
      groups.set(sv.slot, arr);
    }
  }

  const newIds = new Set(news.map((x) => x.id));
  const vecById = new Map(rows.map((x) => [x.id, x.vec]));

  for (const [slot, arr] of groups) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const A = arr[i], B = arr[j];
        if (!newIds.has(A.id) && !newIds.has(B.id)) continue;
        if (valueSimilar(A.value, B.value)) continue;
        if (found.some((f) => (f.aId === A.id && f.bId === B.id) || (f.aId === B.id && f.bId === A.id))) continue;
        const aChanged = CHANGE_RE.test(A.content);
        const bChanged = CHANGE_RE.test(B.content);
        const kind: 'stale' | 'contradiction' = (aChanged || bChanged) ? 'stale' : 'contradiction';
        const va = vecById.get(A.id) || [], vb = vecById.get(B.id) || [];
        const sc = va.length && vb.length ? cosine(va, vb) : 0;
        found.push({
          aId: A.id, bId: B.id, aContent: A.content, bContent: B.content,
          score: sc, kind,
          reason: '同一' + slotLabel(slot) + '：' + A.value + ' / ' + B.value +
                  (kind === 'stale' ? '（含变化词，可能是新状态）' : ''),
        });
      }
    }
  }
  const slotScanned = slotRows.length;

  // 先算所有记忆的 LSH 签名（一次性，O(N×bits)）
  const sigs = new Map<string, number>();
  const bits = lshBitsFor(rows.length);
  // 去中心化：用缓存的数据集均值（避免桶边界随每次查询漂移）
  const center = cachedCenter(ownerCharacter, rows.map((r) => r.vec));
  for (const r of rows) sigs.set(r.id, lshSignature(r.vec, bits, center));
  const bruteForce = news.length * Math.max(0, rows.length - 1);
  const HAMMING_MAX = 2;

  for (const a of news) {
    const pa = polarity(a.content);
    // 算所有相似度，取 topK
    const scored: Array<{ b: typeof rows[0]; s: number }> = [];
    const sigA = sigs.get(a.id) || 0;
    for (const b of rows) {
      if (b.id === a.id) continue;
      // LSH 预筛：签名差距太大直接跳过
      if (hamming(sigA, sigs.get(b.id) || 0) > HAMMING_MAX) continue;
      compared++;
      const s = cosine(a.vec, b.vec);
      if (s >= CONTRA_THRESHOLD) scored.push({ b, s });
    }
    scored.sort((x, y) => y.s - x.s);

    for (const { b, s } of scored.slice(0, topK)) {
      // 同一条冲突只报一次（用 id 排序去重）
      if (found.some((f) => (f.aId === a.id && f.bId === b.id) || (f.aId === b.id && f.bId === a.id))) continue;
      if (s >= DUP_THRESHOLD) {
        found.push({ aId: a.id, bId: b.id, aContent: a.content, bContent: b.content, score: s, kind: 'duplicate', reason: '相似度 ' + s.toFixed(3) + '，内容几乎相同' });
        continue;
      }
      const pb = polarity(b.content);
      if (pa !== 0 && pb !== 0 && pa !== pb) {
        found.push({ aId: a.id, bId: b.id, aContent: a.content, bContent: b.content, score: s, kind: 'contradiction', reason: '相似度 ' + s.toFixed(3) + ' 但极性相反' });
      }
    }
  }

  const result: DetectResult = {
    ok: true, scanned: news.length, compared,
    found: found.length, created: 0, skippedExisting: 0,
    bruteForceCompared: bruteForce,
    lshBits: bits,
    slotScanned,
    savedRatio: bruteForce > 0 ? Math.round((1 - compared / bruteForce) * 1000) / 1000 : 0,
    ms: Date.now() - t0,
    candidates: found.slice(0, 50),
  };

  if (dry) return result;

  // 已有未解决冲突的不重复建
  const existing = await repo.pendingConflictMemoryIds(ownerCharacter);
  for (const c of found) {
    if (existing.has(c.aId) && existing.has(c.bId)) { result.skippedExisting++; continue; }
    const r = await repo.createConflict(c.aId, c.bId, c.kind, c.reason);
    if (r.ok) result.created++;
  }
  result.ms = Date.now() - t0;
  return result;
}
