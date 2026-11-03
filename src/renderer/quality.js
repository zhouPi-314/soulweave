/**
 * SoulWeave S2-10：画质预设
 *
 * 目标：**不减配**，而是让用户按自己设备在 低 / 中 / 高 / 极致 之间调节。
 * 任何档位都保留全部功能（双/多角色、表情、动作、聊天），
 * 只调整「渲染开销」这一维度：
 *
 *   - 渲染分辨率上限（devicePixelRatio 上限）
 *   - 高斯模糊等 CSS 特效开关
 *   - 阴影/光晕强度
 *
 * 不做的事：不删功能、不降交互精度、不减少角色数量上限。
 */

export const QUALITY_PRESETS = {
  // superSample：在 dprCap 之上再乘的倍数（>1 表示超采样，画面更锐利）
  // 借鉴 AIRI：其 live2d render-scale 默认 2，用超采样换清晰度而不是降分辨率。
  low:    { label: '低',   dprCap: 1.0,  superSample: 1.0, blur: false, glow: false },
  medium: { label: '中',   dprCap: 1.25, superSample: 1.0, blur: true,  glow: false },
  high:   { label: '高',   dprCap: 1.5,  superSample: 1.0, blur: true,  glow: true  },
  ultra:  { label: '极致', dprCap: 0,    superSample: 2.0, blur: true,  glow: true  }, // 0 = 系统原生 DPR
};

const KEY = 'soulweave.quality';

export function getQuality() {
  const fromUrl = new URLSearchParams(location.search).get('quality');
  if (fromUrl && QUALITY_PRESETS[fromUrl]) return fromUrl;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && QUALITY_PRESETS[saved]) return saved;
  } catch (e) { /* 隐私模式等 */ }
  return 'high';
}

export function applyQuality(name) {
  const key = QUALITY_PRESETS[name] ? name : 'high';
  const p = QUALITY_PRESETS[key];
  const el = document.documentElement;
  el.dataset.quality = key;
  el.dataset.blur = p.blur ? 'on' : 'off';
  el.dataset.glow = p.glow ? 'on' : 'off';
  try { localStorage.setItem(KEY, key); } catch (e) { /* ignore */ }
  return { key, ...p };
}

/** 当前画质允许的 DPR 上限（0 表示不限制） */
export function dprCapFor(name) {
  const p = QUALITY_PRESETS[name] || QUALITY_PRESETS.high;
  return p.dprCap;
}

/** 当前画质的超采样倍数（≥1） */
export function superSampleFor(name) {
  const p = QUALITY_PRESETS[name] || QUALITY_PRESETS.high;
  return p.superSample || 1;
}

export function listQualities() {
  return Object.entries(QUALITY_PRESETS).map(([k, v]) => ({ key: k, ...v }));
}
