/**
 * SoulWeave S8.4：语音识别结果的后处理
 *
 * 【为什么需要】
 * whisper 在**没有人声**的音频上不会老老实实返回空，它会「编」：
 * 纯音调会被听成「(記憶)(記憶)」，静音段常出现
 * 「请不吝点赞、订阅、转发、打赏」「字幕由…提供」这类训练数据残留。
 *
 * 实测（2026-11-01，假麦克风的 440 Hz 音调）：
 *   返回 text = "(記憶)(記憶)"，长度 8。
 * 如果直接就把这段发给角色，等于让用户莫名其妙被回一句无关的话。
 *
 * 所以：把括号里的音效标记剥掉；剥完什么都不剩，就判定「这段里没有人声」，
 * 由调用方返回 NO_SPEECH，界面提示「没听清」，而不是硬发。
 */

/** 纯音效/语气标记：() （） [] 【】 里 0–12 个字符的内容 */
const BRACKET_RE = /[（(【\[][^）)】\]]{0,12}[）)】\]]/g;

/** whisper 在静音/噪声上常见的「幻觉」开头 */
const HALLUCINATION_PREFIXES = [
  '字幕', '请不吝点赞', '订阅', '转发', '打赏', '明镜与点点',
  '谢谢观看', '感谢观看', '感谢您的观看', 'amara.org', 'subtitle',
];

/** 去掉标点与空白，只留「有没有实义字符」 */
function compact(text: string): string {
  return String(text || '')
    .replace(BRACKET_RE, '')
    .replace(/[\s.,!?;:~\-–—…、，。！？；：（）()《》<>【】\[\]]/g, '');
}

/**
 * 这段识别结果是不是「没有人声」。
 * 返回 true 时调用方应回 NO_SPEECH，不要把内容发给角色。
 */
export function looksLikeNoSpeech(text: string): boolean {
  const c = compact(text);
  if (!c) return true;
  // 短且是已知幻觉短语 → 判定无语音
  if (c.length <= 24) {
    const lower = c.toLowerCase();
    for (const p of HALLUCINATION_PREFIXES) {
      if (lower.startsWith(p.toLowerCase())) return true;
    }
  }
  // 全是重复的同一个片段（如「啊啊啊啊」「记忆记忆记忆」）也算没有内容
  if (c.length >= 4) {
    const first2 = c.slice(0, 2);
    if (c.split(first2).join('').length === 0) return true;
  }
  return false;
}

/** 去掉括号标记与多余空白，用于展示 */
export function cleanTranscript(text: string): string {
  return String(text || '').replace(BRACKET_RE, '').replace(/\s+/g, ' ').trim();
}
