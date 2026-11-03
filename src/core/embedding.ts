/**
 * SoulWeave S4：本地文本向量化（bge-small-zh-v1.5 + onnxruntime-node）
 *
 * 【为什么是本地】
 * 用户决策：隐私优先，记忆文本不出本机（见 src/shared/memory-policy.json）。
 * 云端回退关闭；向量算不出来时退回关键词检索，**不静默上云**。
 *
 * 【与 Kokoro 的关系】
 * **无关**。Kokoro 是 TTS（文字→语音），本模块是文本嵌入（文字→向量）。
 * 唯一共同点是都复用 onnxruntime-node 这一个推理运行时，不需要新增依赖。
 *
 * 【模型】
 * BAAI/bge-small-zh-v1.5，hidden_size=512，4 层，vocab 21128。
 * 用的是 Xenova 导出的量化 ONNX（22.9 MB）。
 * 池化方式：CLS（BGE 系列的标准做法），然后 L2 归一化。
 */

import fs from 'node:fs';
import path from 'node:path';

export interface EmbeddingResult {
  ok: boolean;
  vector?: number[];
  dim?: number;
  /** 实际用了几号 token（排查用） */
  tokens?: string[];
  ms?: number;
  error?: string;
}

// ── BERT 分词器（中文按字切分）──────────────────────────

const CLS_ID = 101, SEP_ID = 102, PAD_ID = 0, UNK_ID = 100;

function isCJK(cp: number): boolean {
  return (cp >= 0x4E00 && cp <= 0x9FFF) ||   // CJK 统一表意
         (cp >= 0x3400 && cp <= 0x4DBF) ||   // 扩展 A
         (cp >= 0xF900 && cp <= 0xFAFF) ||   // 兼容表意
         (cp >= 0x20000 && cp <= 0x2A6DF);   // 扩展 B
}

function isPunct(cp: number): boolean {
  // ASCII 标点
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) ||
      (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
  // 中文标点与全角符号
  return (cp >= 0x3000 && cp <= 0x303F) ||   // CJK 标点
         (cp >= 0xFF00 && cp <= 0xFFEF) ||   // 全角
         (cp >= 0x2000 && cp <= 0x206F);     // 通用标点
}

function cleanText(s: string): string {
  return String(s || '')
    .replace(/[\u0000\uFFFD]/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 把文本切成「基本词」：中文逐字、标点单独、其余按空白 */
function basicTokens(text: string, doLower: boolean): string[] {
  const s = doLower ? text.toLowerCase() : text;
  const out: string[] = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  for (const ch of s) {
    const cp = ch.codePointAt(0) || 0;
    if (/\s/.test(ch)) { flush(); continue; }
    if (isCJK(cp) || isPunct(cp)) { flush(); out.push(ch); continue; }
    buf += ch;
  }
  flush();
  return out;
}

/** WordPiece 贪心最长匹配 */
function wordPiece(token: string, vocab: Map<string, number>): string[] {
  if (token.length > 100) return ['[UNK]'];
  const out: string[] = [];
  let start = 0;
  while (start < token.length) {
    let end = token.length;
    let cur: string | null = null;
    while (start < end) {
      let sub = token.slice(start, end);
      if (start > 0) sub = '##' + sub;
      if (vocab.has(sub)) { cur = sub; break; }
      end--;
    }
    if (cur === null) return ['[UNK]'];
    out.push(cur);
    start = end;
  }
  return out;
}

export interface TokenizerOptions { doLower?: boolean; maxLen?: number; }

export class BertTokenizer {
  private vocab = new Map<string, number>();
  private doLower: boolean;
  private maxLen: number;

  constructor(vocabPath: string, opts: TokenizerOptions = {}) {
    const lines = fs.readFileSync(vocabPath, 'utf8').split('\n');
    // 最后一行可能是空串（尾部换行），不建索引
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].replace(/\r$/, '');
      if (t === '' && i === lines.length - 1) continue;
      if (!this.vocab.has(t)) this.vocab.set(t, i);
    }
    this.doLower = opts.doLower !== false;
    this.maxLen = Math.min(opts.maxLen || 512, 512);
  }

  get size(): number { return this.vocab.size; }

  encode(text: string): { ids: number[]; tokens: string[] } {
    const words = basicTokens(cleanText(text), this.doLower);
    const pieces: string[] = [];
    for (const w of words) {
      for (const t of wordPiece(w, this.vocab)) pieces.push(t);
      if (pieces.length > this.maxLen - 2) break;
    }
    const trimmed = pieces.slice(0, this.maxLen - 2);
    const tokens = ['[CLS]', ...trimmed, '[SEP]'];
    const ids = tokens.map((t) => {
      if (t === '[CLS]') return CLS_ID;
      if (t === '[SEP]') return SEP_ID;
      const v = this.vocab.get(t);
      return v === undefined ? UNK_ID : v;
    });
    return { ids, tokens };
  }
}

// ── 模型会话（懒加载，全局单例）──────────────────────────

export interface EmbedderOptions {
  /** 模型目录（含 model.onnx + vocab.txt） */
  modelDir: string;
  /** 是否查询输入名（默认 true） */
  maxLen?: number;
}

let _session: any = null;
let _tokenizer: BertTokenizer | null = null;
let _loadedKey = '';
let _inputNames: string[] = [];
let _outputName = '';

/** 检查模型文件是否齐备 */
export function inspectModel(modelDir: string): { ok: boolean; missing?: string[]; files?: string[] } {
  const need = ['model.onnx', 'vocab.txt'];
  const missing = need.filter((f) => !fs.existsSync(path.join(modelDir, f)));
  return { ok: missing.length === 0, missing, files: need };
}

/** 余弦相似度（两个已归一化向量的点积） */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function l2normalize(v: number[]): number[] {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/**
 * 把一段文本编码成向量。
 * 首次调用会加载模型（约 300–800 ms），之后复用 session。
 */
export async function embed(text: string, opts: EmbedderOptions): Promise<EmbeddingResult> {
  const t0 = Date.now();
  const dir = opts.modelDir;
  const chk = inspectModel(dir);
  if (!chk.ok) return { ok: false, error: '模型文件缺失：' + (chk.missing || []).join(', ') };

  const key = path.resolve(dir) + '|' + (opts.maxLen || 512);
  try {
    if (!_session || _loadedKey !== key) {
      const ort = await import('onnxruntime-node');
      _tokenizer = new BertTokenizer(path.join(dir, 'vocab.txt'), { maxLen: opts.maxLen || 512 });
      _session = await (ort as any).InferenceSession.create(path.join(dir, 'model.onnx'));
      _inputNames = (_session.inputNames || []).slice();
      _outputName = (_session.outputNames || [])[0];
      _loadedKey = key;
    }
  } catch (e) {
    _session = null;
    return { ok: false, error: '模型加载失败：' + String(e).slice(0, 200) };
  }
  if (!_tokenizer) return { ok: false, error: '分词器未初始化' };

  try {
    const ort = await import('onnxruntime-node');
    const { ids, tokens } = _tokenizer.encode(text);
    const len = ids.length;

    const feeds: Record<string, any> = {};
    const makeI64 = (arr: number[]) => new (ort as any).Tensor('int64', BigInt64Array.from(arr.map((x) => BigInt(x))), [1, arr.length]);

    // 按模型实际输入名喂数据（不同导出的名字可能略有差异）
    for (const name of _inputNames) {
      if (name === 'input_ids') feeds[name] = makeI64(ids);
      else if (name === 'attention_mask') feeds[name] = makeI64(new Array(len).fill(1));
      else if (name === 'token_type_ids') feeds[name] = makeI64(new Array(len).fill(0));
    }
    // 兜底：如果 inputNames 为空，按标准三种喂
    if (!Object.keys(feeds).length) {
      feeds.input_ids = makeI64(ids);
      feeds.attention_mask = makeI64(new Array(len).fill(1));
      feeds.token_type_ids = makeI64(new Array(len).fill(0));
    }

    const out = await _session.run(feeds);
    const tensor = out[_outputName] || out[Object.keys(out)[0]];
    if (!tensor || !tensor.dims) return { ok: false, error: '模型没有输出张量' };

    const dims: number[] = tensor.dims;              // [1, seq, hidden]
    const hidden = dims[dims.length - 1];
    const seq = dims[dims.length - 2];
    const data = tensor.data as Float32Array;

    // CLS 池化：取第 0 个 token 的 hidden 向量
    const cls: number[] = new Array(hidden);
    for (let i = 0; i < hidden; i++) cls[i] = data[i];
    const vec = l2normalize(cls);

    return { ok: true, vector: vec, dim: hidden, tokens, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: '推理失败：' + String(e).slice(0, 250), ms: Date.now() - t0 };
  }
}

/** 释放模型（测试或切换模型时用） */
export async function releaseEmbedder(): Promise<void> {
  try { if (_session && _session.release) await _session.release(); } catch (e) { /* ignore */ }
  _session = null; _tokenizer = null; _loadedKey = ''; _inputNames = []; _outputName = '';
}
