/**
 * SoulWeave S2-13：窗口背景自定义
 *
 * 定位：**主推仍是「透明背景 + 数字生命角色」**（AIRI 式桌面宠物体验）。
 * 背景图是可选项，给喜欢「有底图」的用户，不改变主形态。
 *
 * 三种类型：
 *   transparent  透明（默认，桌宠模式强制此值）
 *   color        纯色
 *   image        用户自选图片（本地文件路径，经 IPC 选择）
 */
const KEY = 'soulweave.background';

let state = { type: 'transparent', value: '', opacity: 1, blur: false };

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) state = Object.assign(state, JSON.parse(raw));
  } catch (e) { /* ignore */ }
  return state;
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
}

function apply() {
  const el = document.getElementById('bg-layer');
  if (!el) return null;

  const isPet = document.body.classList.contains('pet-mode');
  const effectiveType = isPet ? 'transparent' : state.type;

  el.classList.toggle('bg-blurred', !!state.blur);
  el.style.opacity = String(state.opacity ?? 1);

  if (effectiveType === 'color' && state.value) {
    el.style.backgroundImage = 'none';
    el.style.backgroundColor = state.value;
  } else if (effectiveType === 'image' && state.value) {
    el.style.backgroundColor = '#0E0E12';
    el.style.backgroundImage = 'url("' + state.value + '")';
  } else {
    el.style.backgroundImage = 'none';
    el.style.backgroundColor = 'transparent';
  }
  return { ...state, type: effectiveType };
}

export function getBackground() { return { ...state }; }

export function setBackground(next) {
  state = Object.assign({}, state, next || {});
  if (!['transparent', 'color', 'image'].includes(state.type)) state.type = 'transparent';
  state.opacity = Math.min(1, Math.max(0, Number(state.opacity ?? 1)));
  save();
  return apply();
}

export function initBackground() {
  load();
  return apply();
}
