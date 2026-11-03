/**
 * SoulWeave S3-12：设置中心（独立窗口）
 *
 * 与主窗口的角色面板（动作/表情）是**两套独立 UI**：
 *   - 主窗口：陪伴界面，浮层，透明背景
 *   - 本窗口：12 大功能模块，独立窗体，常规深/浅色
 *
 * 但二者**共享同一份配置与 IPC**（数据互通，界面分离）。
 */
import { MODULES, IMPLEMENTED } from './modules.js';
import * as QualityApi from './quality.js';
import * as ThemeApi from './theme.js';
import * as VoiceSetup from './voice-setup.js';
import * as Autonomy from './autonomy.js';
import { swCall, swOn } from './api.js';
import * as BackgroundApi from './background.js';
import { moduleIcon, brandIcon, agentIconId } from './icons.js';
import { renderCloudAgent, ensureCloudAgentStyles } from './cloud-agent.js';
import { renderRoster, ensureRosterStyles } from './roster.js';
import { renderQqInstances, ensureQqInstancesStyles } from './qq-instances.js';
import { renderWhitelist, ensureWhitelistStyles } from './qq-whitelist.js';
import { renderMultimedia, ensureMultimediaStyles } from './multimedia.js';
import { renderAsrSection, ensureAsrStyles } from './asr-panel.js';
import { renderVoiceInput, ensureVoiceInputStyles } from './voice-input.js';
import { renderDownloads, ensureDownloadStyles } from './download-center.js';
import { renderLifeStudio } from './life-studio.js';

const $ = (s) => document.querySelector(s);
let current = 'dashboard';
/** 上一次渲染的模块：用来判断「同板块重绘」还是「切板块」 */
let lastRendered = null;

// ── 保存反馈 ─────────────────────────────────────
//
// 【为什么需要它】
// 以前保存后统一走 onChange → select() → render()，整块内容清空重建：
//   · 滚动条回到顶部（用户正在页面中间改一个开关，一按就飞回顶端）
//   · 没有任何「已保存」反馈，用户不确定到底存没存
// 现在保存优先走 toast，页面不动；只有数据结构真的变了才重绘，
// 而且重绘也会把滚动位置还回去。
let toastTimer = 0;
export function toast(text, kind) {
  let box = document.getElementById('sw-toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'sw-toast';
    // 异步提示要让屏幕阅读器念出来（web-design-guidelines：toast 需要 aria-live）
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.appendChild(box);
    const st = document.createElement('style');
    st.id = 'sw-toast-styles';
    st.textContent = `
#sw-toast {
  position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%) translateY(8px);
  display: flex; align-items: center; gap: 8px;
  padding: 9px 16px; border-radius: 999px; z-index: 9999;
  font-size: 12px; font-weight: 600; letter-spacing: .2px;
  background: rgba(28,28,38,.96); color: #EDEAF6;
  border: 1px solid rgba(255,255,255,.12);
  box-shadow: 0 8px 28px rgba(0,0,0,.45);
  opacity: 0; pointer-events: none;
  transition: opacity .18s ease, transform .18s ease;
}
#sw-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
#sw-toast .sw-toast-dot { width: 6px; height: 6px; border-radius: 50%; background: #6EE7A8; flex: none; }
#sw-toast.bad .sw-toast-dot { background: #FF8E8E; }
#sw-toast.warn .sw-toast-dot { background: #FFC46B; }
`;
    document.head.appendChild(st);
  }
  box.className = 'show' + (kind ? ' ' + kind : '');
  box.textContent = '';
  const dot = document.createElement('span');
  dot.className = 'sw-toast-dot';
  box.appendChild(dot);
  box.appendChild(document.createTextNode(String(text || '已保存')));
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.className = ''; }, 2000);
}

// ── 基础工具 ─────────────────────────────────────
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function chip(label, on, onClick, title) {
  const b = el('button', 'chip' + (on ? ' on' : ''), label);
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function section(title, hint) {
  const s = el('div', 'sec');
  if (title) s.appendChild(el('div', 'sec-title', title));
  if (hint) s.appendChild(el('div', 'sec-hint', hint));
  return s;
}

// ── 导航 ─────────────────────────────────────────
function buildNav() {
  const nav = $('#sb-nav');
  nav.textContent = '';
  // 按用户任务分组，而不是按开发阶段堆一列。分组只影响视觉层次，
  // 14 个入口一个都没少、顺序也没变（同组的保持原顺序）。
  let lastGroup = null;
  for (const m of MODULES) {
    if (m.group && m.group !== lastGroup) {
      lastGroup = m.group;
      const g = el('div', 'nav-group', m.group);
      g.setAttribute('role', 'presentation');
      nav.appendChild(g);
    }
    const b = el('button', 'nav-item' + (m.id === current ? ' active' : ''));
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.dataset.id = m.id;
    // 窄窗会隐藏文字只留图标，名称必须挂在 aria-label 上，否则屏幕阅读器读不到
    b.setAttribute('aria-label', m.label + (m.stage ? '（' + m.stage + ' 阶段）' : ''));
    b.setAttribute('aria-selected', m.id === current ? 'true' : 'false');
    const ic = el('span', 'ni-icon');
    ic.innerHTML = moduleIcon(m.id, 16);   // 内联 SVG，跟随 currentColor
    b.appendChild(ic);
    b.appendChild(el('span', 'ni-label', m.label));
    if (m.stage) b.appendChild(el('span', 'ni-stage', m.stage));
    b.title = m.desc || m.label;
    b.addEventListener('click', () => select(m.id));
    nav.appendChild(b);
  }
}

function select(id) {
  current = id;
  window.__swSelect = select;   // 供下载中心等模块跳转
  const m = MODULES.find((x) => x.id === id);
  $('#sb-title').textContent = m ? m.label : id;
  $('#sb-desc').textContent = m ? m.desc : '';
  document.querySelectorAll('.nav-item').forEach((n) => {
    const on = n.dataset.id === id;
    n.classList.toggle('active', on);
    n.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  render(id);
}

// ── 各模块渲染 ───────────────────────────────────
/**
 * 无标签表单控件的可访问名称。
 *
 * 【为什么需要】
 * 面板里大量控件是「一个 label + 一个 input」手工拼的，没有 for/id 关联，
 * 屏幕阅读器和键盘用户拿不到名称。这里在渲染后统一补 aria-label：
 * 优先用已有 aria-label / label 文本 / placeholder，最后兜底。
 * 只补不覆盖，已有的 name 保持不动。
 */
/**
 * 过滤自检/测试残留角色。
 *
 * 【为什么不在数据库里删】
 * 这些行是 --self-test-memory / --self-test-vectors 跑出来的，删库属于破坏性操作，
 * 需要用户单独批准。UI 层先挡住，别让它们出现在下拉框和角色列表里；
 * 自检代码本身已经改成跑完自清理，新数据不会再产生。
 */
function isPlaceholderCharacter(name) {
  const n = String(name || '').trim();
  if (!n) return true;
  if (/^测试[A-Za-z0-9_-]*$/.test(n)) return true;
  if (/^(向量测试|向量检索[AB]?|基准测试|记忆中心测试|自检.*)$/.test(n)) return true;
  return false;
}


/** 指标条：k/v/u + 语气（默认/警告/危险） */
function statStrip(items) {
  const wrap = el('div', 'stat-strip');
  for (const it of items) {
    const c = el('div', 'stat-card' + (it.tone ? ' ' + it.tone : ''));
    c.appendChild(el('div', 'stat-k', it.k));
    const v = el('div', 'stat-v', String(it.v));
    if (it.u) v.appendChild(el('span', 'stat-u', it.u));
    c.appendChild(v);
    wrap.appendChild(c);
  }
  return wrap;
}

/** 可执行空状态：标题 + 说明 + 一个动作按钮 */
function emptyCta(title, hint, actionLabel, onAction) {
  const box = el('div', 'empty-cta');
  const txt = el('div', 'ec-text');
  txt.appendChild(el('div', 'ec-title', title));
  txt.appendChild(el('div', 'ec-hint', hint));
  box.appendChild(txt);
  const b = el('button', 'chip', actionLabel);
  b.type = 'button';
  b.addEventListener('click', onAction);
  const act = el('div', 'ec-act');
  act.appendChild(b);
  box.appendChild(act);
  return box;
}

function ensureA11yNames(root) {
  const ctrls = Array.from(root.querySelectorAll('input, select, textarea'));
  for (const c of ctrls) {
    if (c.getAttribute('aria-label') || c.getAttribute('aria-labelledby')) continue;
    if (c.id && root.querySelector('label[for="' + c.id + '"]')) continue;
    if (c.closest('label')) continue;
    let name = c.getAttribute('title') || c.getAttribute('placeholder') || '';
    if (!name) {
      // 往前找同一行里的 label 或文本
      const row = c.closest('.row, .ls-field, .cmp, .sec');
      const lab = row && row.querySelector('label');
      if (lab && lab.textContent.trim()) name = lab.textContent.trim();
    }
    if (!name) {
      const prev = c.previousElementSibling;
      if (prev && prev.textContent && prev.textContent.trim().length <= 24) name = prev.textContent.trim();
    }
    c.setAttribute('aria-label', name || '未命名输入');
  }
  // 图标按钮：没有文字内容的补 title
  for (const b of Array.from(root.querySelectorAll('button'))) {
    if (b.getAttribute('aria-label') || b.getAttribute('title')) continue;
    const txt = (b.textContent || '').trim();
    if (!txt) b.setAttribute('aria-label', '未命名按钮');
  }
}

async function render(id) {
  const host = $('#sb-content');
  // 同板块重绘要保住滚动位置；切板块才回到顶部。
  const keepScroll = (id === lastRendered && current === id) ? host.scrollTop : 0;
  lastRendered = id;
  host.textContent = '';
  const restore = () => {
    if (current !== id) return;
    try { ensureA11yNames(host); } catch (e) { /* 无障碍补名失败不影响功能 */ }
    const max = Math.max(0, host.scrollHeight - host.clientHeight);
    host.scrollTop = Math.min(keepScroll, max);
  };

  if (!IMPLEMENTED.has(id)) {
    const m = MODULES.find((x) => x.id === id);
    host.appendChild(el('div', 'placeholder',
      '「' + (m ? m.label : id) + '」模块将在 ' + (m ? m.stage : '') + ' 阶段实现。\n\n' +
      (m ? m.desc : '') + '\n\n当前模块的界面位置已预留，配置与数据与主窗口互通。'));
    return;
  }

  const done = (() => {
    switch (id) {
      case 'dashboard': return renderDashboard(host);
      case 'memory': return renderMemorySetup(host);
      case 'model': return renderModel(host);
      case 'live2d': return renderLive2D(host);
      case 'theme': return renderTheme(host);
      case 'voice': return renderVoice(host);
      case 'character': return renderCharacter(host);
      case 'resource': return renderResource(host);
      case 'permission': return renderPermission(host);
      case 'maintenance': return renderMaintenance(host);
      case 'extension': return renderExtension(host);
      case 'social': return renderSocial(host);
      case 'life': return renderLifeStudio(host);
      case 'multimedia': {
        ensureMultimediaStyles();
        return renderMultimedia(host, () => select('multimedia'));
      }
      case 'downloads': {
        ensureDownloadStyles();
        return renderDownloads(host, () => select('downloads'));
      }
      case 'roster': {
        ensureRosterStyles();
        return renderRoster(host, () => select('roster'));
      }
      default: return undefined;
    }
  })();
  // 内容可能是同步建的，也可能是异步补的：两种都要把滚动还回去。
  if (done && typeof done.then === 'function') {
    done.then(() => requestAnimationFrame(restore)).catch(() => requestAnimationFrame(restore));
  } else {
    requestAnimationFrame(restore);
  }
  return done;
}

async function renderDashboard(host) {
  const s = section('运行状态');
  const grid = el('div', 'kpi-grid');
  const api = window.soulweave;
  let fps = null, draw = null, modelCount = null;
  try {
    const r = await swCall('getSwitchStats', );
    void r;
  } catch (e) { console.error('[soulweave]', e); }
  s.appendChild(grid);
  host.appendChild(s);

  const add = (k, v, u) => {
    const c = el('div', 'kpi');
    c.appendChild(el('div', 'kpi-k', k));
    const val = el('div', 'kpi-v', String(v));
    if (u) val.appendChild(el('span', 'kpi-u', u));
    c.appendChild(val);
    grid.appendChild(c);
  };

  add('界面主题', document.documentElement.dataset.theme === 'light' ? '浅色' : '深色');
  add('画质档位', QualityApi.getQuality());
  add('窗口模式', '完整窗口');

  // 用已有接口补几条真实状态，避免看板只有三个静态值
  try {
    const qq = await swCall('qqSnapshot');
    const accs = (qq && qq.data && qq.data.accounts) || [];
    add('QQ 账号', String(accs.length), accs.length ? '个' : '未配置');
  } catch (e) { /* 忽略 */ }
  try {
    const ag = await swCall('agentStatus');
    if (ag && ag.budget) {
      add('本月花费', '¥' + Number(ag.budget.usedCny || 0).toFixed(2), '/ ¥' + Number(ag.budget.limitCny || 0).toFixed(0));
    }
  } catch (e) { /* 忽略 */ }
  try {
    const vc = await swCall('listVoiceComponents');
    const list = (vc && vc.components) || [];
    const ready = list.filter((c) => c && (c.ready || c.installed)).length;
    if (list.length) add('语音组件', ready + ' / ' + list.length, '就绪');
  } catch (e) { /* 忽略 */ }

  const s2 = section('关于');
  s2.appendChild(el('div', 'sec-hint',
    'SoulWeave · 奇点跃迁（Singulift）'));
  s2.appendChild(el('div', 'sec-hint',
    '本窗口是十四大功能的设置中心，与主窗口的角色面板相互独立。改版后同一套设计令牌覆盖全部面板。'));
  host.appendChild(s2);
}

async function renderModel(host) {
  await renderBackground(host);

  const s = section('画质档位', '不同档位只影响渲染开销，不减少任何功能。');
  // 先把"现在是什么档位、代价是什么"讲清楚，再给切换
  if (QualityApi) {
    const curKey = QualityApi.getQuality();
    const curDef = (QualityApi.listQualities() || []).find((x) => x.key === curKey) || {};
    s.appendChild(statStrip([
      { k: '当前档位', v: curDef.label || curKey },
      { k: '渲染倍率上限', v: curDef.dprCap && curDef.dprCap > 0 ? curDef.dprCap : '原生' },
      { k: '超采样', v: '×' + (curDef.superSample || 1) },
    ]));
  }
  const chips = el('div', 'chips');
  const q = QualityApi;
  if (q) {
    const cur = q.getQuality();
    q.listQualities().forEach((x) => {
      chips.appendChild(chip(x.label + (x.superSample > 1 ? ' ×' + x.superSample : ''), x.key === cur, () => {
        // quality.js 自身就实现了 applyQuality，不需要走 IPC（主进程也没有 quality:* 处理器）
        q.applyQuality(x.key);
        Array.from(chips.children).forEach((c) => c.classList.remove('on'));
        event?.target?.classList?.add('on');
        select('model');
      }, 'DPR 上限 ' + (x.dprCap || '原生') + '，超采样 ×' + (x.superSample || 1)));
    });
  }
  s.appendChild(chips);
  host.appendChild(s);

  // 主题已经有独立页面（多套主题 + 跟随系统），这里不再重复一套三选一按钮，
  // 否则同一个设置项在两个页面各有一份，改了这个那个不跟着变。
  const s2 = section('界面主题', '主题（含多套配色与跟随系统）已移到「主题」页统一管理。');
  const goTheme = el('button', 'chip', '前往「主题」');
  goTheme.type = 'button';
  goTheme.addEventListener('click', () => select('theme'));
  s2.appendChild(goTheme);
  s2.appendChild(el('div', 'cmp-w', '当前：' + (ThemeApi.getTheme().mode === 'auto' ? '跟随系统' : ThemeApi.getTheme().mode)));
  host.appendChild(s2);
}

/**
 * S3-23：窗口背景
 *
 * 【为什么在这里】S3-12 把角色面板的设置区整体搬进设置中心时，
 * 背景控件被漏掉了 —— 能力层（主进程 IPC、background.js）都还在，
 * 只是没了入口。这里补回来。
 *
 * 存储：localStorage['soulweave.background']，与主窗口同源共享。
 * 改动后通过 IPC 通知主窗口立刻重绘。
 */
async function renderBackground(host) {
  const sec = section('窗口背景',
    '默认是透明背景 + 数字生命角色（桌宠主形态）。背景图是可选装饰，不影响桌宠模式 —— 桌宠模式下强制透明。');
  host.appendChild(sec);

  const st = BackgroundApi.getBackground();
  const notify = () => {
    try { swCall('notifyBackgroundChanged', BackgroundApi.getBackground()); } catch (e) { console.error('[soulweave]', e); }
  };
  const apply = (patch) => {
    BackgroundApi.setBackground(patch);
    notify();
    select('model');
  };

  // 类型
  const types = [
    { key: 'transparent', label: '透明（推荐）' },
    { key: 'color', label: '纯色' },
    { key: 'image', label: '图片' },
  ];
  const tChips = el('div', 'chips');
  for (const t of types) {
    tChips.appendChild(chip(t.label, st.type === t.key, () => apply({ type: t.key })));
  }
  const rowType = el('div', 'row');
  rowType.appendChild(el('label', null, '类型'));
  const wrap = el('div');
  wrap.style.flex = '1';
  wrap.appendChild(tChips);
  rowType.appendChild(wrap);
  sec.appendChild(rowType);

  // 纯色
  if (st.type === 'color') {
    const r = el('div', 'row');
    r.appendChild(el('label', null, '颜色'));
    const pick = document.createElement('input');
    pick.type = 'color';
    pick.value = /^#[0-9a-f]{6}$/i.test(st.value) ? st.value : '#1a1a22';
    pick.addEventListener('input', () => apply({ value: pick.value }));
    r.appendChild(pick);
    sec.appendChild(r);
  }

  // 图片
  if (st.type === 'image') {
    const r = el('div', 'row');
    r.appendChild(el('label', null, '图片'));
    const btn = el('button', 'chip', st.value ? '更换图片' : '选择图片…');
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      let res = null;
      try { res = await swCall('pickBackgroundImage'); } catch (e) { console.error('[soulweave]', e); }
      if (!res) return;
      if (!res.ok) {
        if (res.reason !== 'canceled') console.error('[soulweave] 选图失败：', res.reason);
        return;
      }
      apply({ type: 'image', value: res.url });
    });
    r.appendChild(btn);
    if (st.value) {
      const clear = el('button', 'chip', '清除');
      clear.type = 'button';
      clear.addEventListener('click', () => apply({ type: 'transparent', value: '' }));
      r.appendChild(clear);
    }
    sec.appendChild(r);

    if (st.value) {
      const prev = el('div', 'sec-hint');
      prev.textContent = '当前：' + decodeURIComponent(String(st.value).slice(0, 120));
      sec.appendChild(prev);
    }
    sec.appendChild(el('div', 'sec-hint',
      '支持 png / jpg / webp / gif / bmp。图片按原比例铺满窗口，不会被拉伸。'));
  }

  // 透明度与模糊（仅非透明类型有意义）
  if (st.type !== 'transparent') {
    const r = el('div', 'row');
    r.appendChild(el('label', null, '不透明度'));
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.value = String(Math.round((st.opacity ?? 1) * 100));
    const val = el('span', 'sec-hint', slider.value + '%');
    slider.addEventListener('input', () => { val.textContent = slider.value + '%'; });
    slider.addEventListener('change', () => apply({ opacity: Number(slider.value) / 100 }));
    r.appendChild(slider);
    r.appendChild(val);
    sec.appendChild(r);

    const sw = el('label', 'switch');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!st.blur;
    cb.addEventListener('change', () => apply({ blur: cb.checked }));
    sw.appendChild(cb);
    sw.appendChild(el('span', null, '背景模糊（让角色更突出）'));
    const r2 = el('div', 'row');
    r2.appendChild(sw);
    sec.appendChild(r2);
  }
}

async function renderVoice(host) {
  // ── S7：语音输入（麦克风 → 文字）──
  ensureVoiceInputStyles();
  const viSec = section('语音输入', '点按钮说话，说完自动转成文字。录音只在本地处理，不会上传——除非你在下面选了云端识别。');
  const viHost = el('div');
  viSec.appendChild(viHost);
  host.appendChild(viSec);
  renderVoiceInput(viHost, () => select('voice'));

  // ── S7：语音识别（云端 ASR）──
  ensureAsrStyles();
  const asrSec = section('语音识别（ASR）', '把你说的话转成文字。默认用本地模型；云端是可选的加速方案，速度与本机性能无关。');
  const asrHost = el('div');
  asrSec.appendChild(asrHost);
  host.appendChild(asrSec);
  renderAsrSection(asrHost, () => select('voice'));

  const s = section('语音组件', '这些组件不随应用分发：espeak-ng 是 GPL-3.0，GPT-SoVITS / CosyVoice 是数 GB 运行时。请自行获取后在此指定位置。');
  const list = el('div');
  s.appendChild(list);
  host.appendChild(s);

  const api = window.soulweave;
  const setup = VoiceSetup;
  if (!setup) { s.appendChild(el('div', 'sec-hint', '语音模块未加载')); return; }

  await renderVoiceBinding(host);
  await renderOnlineTtsKey(host);
  await renderVoiceCatalog(host);

  await setup.refreshComponents();
  const comps = setup.getComponents();
  if (!comps.length) {
    list.appendChild(el('div', 'sec-hint',
      '未能读取组件状态。若在主窗口之外的页面打开，属正常（组件 IPC 由主进程提供）。'));
  }
  for (const c of comps) {
    const box = el('div', 'cmp');
    const h = el('div', 'cmp-h');
    h.appendChild(el('span', 'cmp-n', c.label));
    const cls = c.status === 'ready' ? 'ok' : (c.status === 'unconfigured' ? 'warn' : 'bad');
    h.appendChild(el('span', 'badge ' + cls, c.status === 'ready' ? '已就绪' : (c.status === 'unconfigured' ? '未配置' : c.detail || '异常')));
    box.appendChild(h);
    box.appendChild(el('div', 'cmp-w', c.why + ' · 许可：' + c.license));
    if (c.path) box.appendChild(el('div', 'cmp-p', c.path));

    const a = el('div', 'cmp-a');
    const up = chip('前往获取', false, async () => { await swCall('openComponentUpstream', c.id); });
    up.title = c.upstream;
    a.appendChild(up);

    if (c.kind !== 'service') {
      a.appendChild(chip('自动探测', false, async () => {
        const r = await swCall('autoDetectComponent', c.id);
        if (r && r.ok) select('voice'); else alert('未在常见位置找到，请手动指定');
      }));
      a.appendChild(chip('指定位置', false, async () => {
        const r = await swCall('pickComponentPath', );
        if (r && r.ok) { await swCall('setComponentPath', c.id, r.path); select('voice'); }
      }));
    } else {
      a.appendChild(chip('测试连接', false, async () => {
        const r = await swCall('probeComponent', c.id);
        alert(r && r.ok ? ('连接正常 · HTTP ' + r.status + ' · ' + r.ms + 'ms') : ('连接失败：' + ((r && r.error) || '未知')));
      }));
      a.appendChild(chip('填写地址', false, async () => {
        const url = prompt('服务地址', c.path || 'http://127.0.0.1:9880');
        if (!url) return;
        await swCall('setComponentPath', c.id, url.trim());
        select('voice');
      }));
    }
    box.appendChild(a);
    list.appendChild(box);
  }

  // S10：音色社区（导航 + 许可/兼容检查 + 一键应用）
  try { await renderVoiceCommunity(host); } catch (e) { host.appendChild(el('div', 'sec-hint', '音色社区加载失败：' + String(e).slice(0, 120))); }
}

/**
 * S3-14：音色目录（跨 provider）
 * 列出所有就绪 provider 的音色，支持试听。
 */
async function renderVoiceCatalog(host) {
  const sec = section('音色', '来自各已就绪 provider。点击「试听」用对应引擎合成一句示例。');
  host.appendChild(sec);

  const api = window.soulweave;
  const list = el('div');
  sec.appendChild(list);

  const SAMPLE = '你好呀，我是你的数字伙伴。';
  const busy = el('div', 'sec-hint', '');
  let playing = null;

  const addGroup = (title, voices) => {
    if (!voices.length) return;
    const g = el('div', 'sec');
    g.appendChild(el('div', 'sec-title', title + '（' + voices.length + '）'));
    const chips = el('div', 'chips');
    for (const v of voices) {
      const b = el('button', 'chip', v.label);
      b.type = 'button';
      b.title = v.id;
      b.addEventListener('click', async () => {
        if (playing) { try { playing.pause(); } catch (e) {} playing = null; }
        b.disabled = true;
        const old = b.textContent;
        b.textContent = '合成中…';
        busy.textContent = '正在用 ' + title + ' · ' + v.label + ' 合成…';
        try {
          let r = null;
          if (v.provider === 'piper') {
            r = await swCall('synthPiper', { text: SAMPLE, voiceId: v.id });
          } else if (v.provider === 'kokoro') {
            r = await swCall('synthKokoro', { text: SAMPLE, voiceId: v.id });
          } else if (v.provider === 'system') {
            r = await swCall('synthVoice', { text: SAMPLE, voiceId: v.id });
          }
          if (r && r.ok && (r.base64 || r.dataUrl)) {
            const b64 = r.base64 || String(r.dataUrl).split(',')[1];
            const bin = atob(b64);
            const u8 = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const buf = await ctx.decodeAudioData(u8.buffer);
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(ctx.destination);
            src.start();
            busy.textContent = '播放中 · ' + Math.round((r.ms || 0)) + 'ms';
            src.onended = () => { busy.textContent = ''; try { ctx.close(); } catch (e) {} };
            void playing;
          } else {
            busy.textContent = '失败：' + ((r && r.error) || '未知');
          }
        } catch (e) {
          busy.textContent = '失败：' + String(e).slice(0, 100);
        }
        b.disabled = false;
        b.textContent = old;
      });
      chips.appendChild(b);
    }
    g.appendChild(chips);
    list.appendChild(g);
  };

  // SAPI
  try {
    const r = await swCall('listVoices', );
    if (r && r.ok && r.voices?.length) {
      addGroup('系统音色 (SAPI)', r.voices.map((v) => ({ id: v.id, label: v.name + ' · ' + v.culture, provider: 'system' })));
    }
  } catch (e) {}

  // Piper
  try {
    const r = await swCall('listPiperVoices', );
    if (r && r.ok && r.voices?.length) {
      addGroup('Piper', r.voices.map((v) => ({ id: v.id, label: v.id, provider: 'piper' })));
      if (r.skipped?.length) {
        sec.appendChild(el('div', 'sec-hint', '已隐藏 ' + r.skipped.length + ' 个 Piper 音色（音素方案不受当前版本支持）'));
      }
    }
  } catch (e) {}

  // Kokoro
  try {
    const r = await swCall('listKokoroVoices', );
    if (r && r.ok && r.voices?.length) {
      const zh = r.voices.filter((v) => v.startsWith('z'));
      const other = r.voices.filter((v) => !v.startsWith('z'));
      addGroup('Kokoro · 中文', zh.map((v) => ({ id: v, label: v, provider: 'kokoro' })));
      addGroup('Kokoro · 其他语言', other.map((v) => ({ id: v, label: v, provider: 'kokoro' })));
    }
  } catch (e) {}

  sec.appendChild(busy);

  if (!list.childElementCount) {
    sec.appendChild(el('div', 'sec-hint', '尚无可用音色。请先在上方配置组件并指定安装位置。'));
  }
}

/**
 * S3-15：角色音色绑定（#4）
 * 把「音色目录」变成「角色实际用哪个」。
 * 存储结构：{ perModel: { "0": { provider, voiceId } }, fallbackVoiceId }
 */
const VOICE_KEY = 'soulweave.voice';

function loadVoiceCfg() {
  try {
    const raw = localStorage.getItem(VOICE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return { perModel: p.perModel || {}, fallbackVoiceId: p.fallbackVoiceId || null };
    }
  } catch (e) {}
  return { perModel: {}, fallbackVoiceId: null };
}

function saveVoiceCfg(cfg) {
  try { localStorage.setItem(VOICE_KEY, JSON.stringify(cfg)); } catch (e) {}
  try { swCall('setVoiceConfig', cfg); } catch (e) { console.error('[soulweave]', e); }
}

async function renderVoiceBinding(host) {
  const sec = section('角色音色绑定', '指定每个角色实际使用哪个音色。开发测试阶段建议统一用 Piper。');
  host.appendChild(sec);

  // 收集所有可用音色
  const api = window.soulweave;
  const all = [];
  try {
    const r = await swCall('listPiperVoices', );
    if (r && r.ok) for (const v of r.voices || []) all.push({ provider: 'piper', id: v.id, label: 'Piper · ' + v.id });
  } catch (e) {}
  try {
    const r = await swCall('listKokoroVoices', );
    if (r && r.ok) for (const v of r.voices || []) all.push({ provider: 'kokoro', id: v, label: 'Kokoro · ' + v });
  } catch (e) {}
  try {
    const r = await swCall('listVoices', );
    if (r && r.ok) for (const v of r.voices || []) all.push({ provider: 'system', id: v.id, label: 'SAPI · ' + v.name });
  } catch (e) {}

  if (!all.length) {
    sec.appendChild(el('div', 'sec-hint', '尚无可用音色，请先配置组件。'));
    return;
  }

  const cfg = loadVoiceCfg();
  const models = [0, 1, 2];
  // 注意：busy 必须在事件绑定前声明（否则点击时触发 TDZ 报错）
  const busy = el('div', 'sec-hint', '');

  for (const idx of models) {
    const row = el('div', 'row');
    row.appendChild(el('label', null, '角色 ' + (idx + 1)));

    const sel = document.createElement('select');
    sel.className = 'sel';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '（跟随兜底）';
    sel.appendChild(none);

    const cur = cfg.perModel[String(idx)];
    for (const v of all) {
      const o = document.createElement('option');
      o.value = v.provider + '::' + v.id;
      o.textContent = v.label;
      if (cur && cur.provider === v.provider && cur.voiceId === v.id) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      const [provider, ...rest] = sel.value.split('::');
      const voiceId = rest.join('::');
      const c = loadVoiceCfg();
      if (!sel.value) delete c.perModel[String(idx)];
      else c.perModel[String(idx)] = { provider, voiceId };
      saveVoiceCfg(c);
      busy.textContent = sel.value ? ('角色 ' + (idx + 1) + ' → ' + provider + ' · ' + voiceId) : ('角色 ' + (idx + 1) + ' 已清除');
    });
    row.appendChild(sel);
    sec.appendChild(row);
  }

  sec.appendChild(busy);

  // Piper 优先提示
  const hint = el('div', 'sec-hint');
  const piperReady = all.some((v) => v.provider === 'piper');
  hint.textContent = piperReady
    ? '开发测试建议：三个角色都选 Piper（中文 huayan），稳定且耗时最短。'
    : 'Piper 未就绪，请先在组件区配置。';
  sec.appendChild(hint);
}

/** S3-15：在线 TTS 密钥（#3）——只写不读，永不明文落盘 */
/**
 * S3-18：在线 TTS 密钥 + 获取导航
 *
 * 【为什么要有导航】只给一个输入框，等于把用户丢在半路 ——
 * 他不知道自己该去哪家、去哪注册、密钥长什么样。
 * 这里把「有哪些可选」「各自在哪获取」「哪些已经能直接用」讲清楚。
 *
 * 【诚实标注实现状态】目前只有 Azure 的客户端是完整实现的，
 * 其余标为「规划中」，避免让用户以为填了就能用。
 */
/**
 * S3-19：六家在线 TTS（全部已实现）
 *
 * fields 描述每家需要的凭证字段，UI 据此动态生成输入框。
 * 顺序按「上手难度」排：Edge 免密钥 → Azure → 其他。
 */
const TTS_PROVIDERS = [
  {
    id: 'edge',
    name: 'Edge TTS（免密钥）',
    vendor: '微软 Edge 朗读接口（非官方）',
    implemented: true,
    fields: [],
    url: 'https://github.com/rany2/edge-tts',
    note: '无需任何凭证，选好音色即可合成。音色多、免费。属逆向使用的非官方接口，稳定性无保证，可能随时失效。',
    free: '免费，无 SLA。',
  },
  {
    id: 'azure',
    name: 'Azure 语音服务',
    vendor: 'Microsoft',
    implemented: true,
    fields: [
      { key: 'key', label: '密钥', type: 'password' },
      { key: 'region', label: '区域', type: 'text', placeholder: 'eastasia' },
    ],
    url: 'https://speech.microsoft.com/portal',
    consoleUrl: 'https://portal.azure.com',
    note: '国内可用，中文自然。门户 → 创建「语音服务」→ 在「密钥和终结点」取 Key 与区域。',
    free: '新账户通常有免费额度，以官网计费页为准。',
  },
  {
    id: 'ali',
    name: '阿里云 · 智能语音交互',
    vendor: '阿里云',
    implemented: true,
    fields: [
      { key: 'accessKeyId', label: 'AccessKeyId', type: 'text' },
      { key: 'accessKeySecret', label: 'AccessKeySecret', type: 'password' },
      { key: 'appKey', label: 'AppKey', type: 'text' },
    ],
    url: 'https://ai.aliyun.com/nls',
    note: '先访问产品页开通，控制台创建项目后取 AppKey；AccessKey 在「访问控制」里创建。',
    free: '以官网为准。',
  },
  {
    id: 'volc',
    name: '火山引擎 · 语音合成',
    vendor: '字节跳动',
    implemented: true,
    fields: [
      { key: 'appid', label: 'AppID', type: 'text' },
      { key: 'token', label: 'Access Token', type: 'password' },
    ],
    url: 'https://console.volcengine.com',
    note: '中文效果强，适合对话。控制台 → 智能语音 → 语音合成 → 创建应用后取 AppID / Token。',
    free: '以官网为准。',
  },
  {
    id: 'tencent',
    name: '腾讯云 · 语音合成',
    vendor: '腾讯云',
    implemented: true,
    fields: [
      { key: 'secretId', label: 'SecretId', type: 'text' },
      { key: 'secretKey', label: 'SecretKey', type: 'password' },
    ],
    url: 'https://cloud.tencent.com/product/tts',
    note: '控制台 → 语音合成 → 开通服务；SecretId/SecretKey 在「访问管理 → API 密钥管理」。',
    free: '以官网为准。',
  },
  {
    id: 'xfyun',
    name: '讯飞 · 在线语音合成',
    vendor: '科大讯飞',
    implemented: true,
    fields: [
      { key: 'appId', label: 'AppID', type: 'text' },
      { key: 'apiKey', label: 'APIKey', type: 'text' },
      { key: 'apiSecret', label: 'APISecret', type: 'password' },
    ],
    url: 'https://www.xfyun.cn/services/online_tts',
    note: '控制台创建应用 → 在线语音合成 → 取 AppID / APIKey / APISecret（三个都要）。',
    free: '以官网为准。',
  },
];

async function renderOnlineTtsKey(host) {
  const sec = section('在线 TTS 密钥',
    '凭证用系统加密（Windows DPAPI）保存，不写入配置文件、不回显。全部留空并保存表示清除。');
  host.appendChild(sec);

  const api = window.soulweave;
  let status = null;
  try { status = await swCall('voiceCredsStatus', ); } catch (e) { console.error('[soulweave]', e); }

  if (status && status.encryptionAvailable === false) {
    sec.appendChild(el('div', 'sec-hint', '⚠ 系统加密不可用，本应用拒绝以明文保存凭证。'));
    return;
  }

  const configured = (status && status.providers) || {};
  const open = async (url) => {
    try { await api.openExternal?.(url); } catch (e) {}
  };

  for (const pv of TTS_PROVIDERS) {
    const box = el('div', 'cmp');

    const h = el('div', 'cmp-h');
    // 服务商图标：语音/ASR 面板早就有，这里补上，避免同一页里两种观感
    const ttsMark = el('span', 'brand-mark');
    try { ttsMark.innerHTML = brandIcon(pv.iconId || pv.id, 18); } catch (e) { /* 图标失败不影响功能 */ }
    h.appendChild(ttsMark);
    h.appendChild(el('span', 'cmp-n', pv.name));
    const got = configured[pv.id];
    const ready = pv.fields.length === 0 || (Array.isArray(got) && got.length >= pv.fields.filter((f) => f.type === 'password').length);
    h.appendChild(el('span', 'badge ' + (pv.fields.length === 0 ? 'ok' : (ready ? 'ok' : 'warn')),
      pv.fields.length === 0 ? '免配置' : (ready ? '已就绪' : '未配置')));
    box.appendChild(h);

    box.appendChild(el('div', 'cmp-w', pv.vendor + ' · ' + pv.note));

    const a = el('div', 'cmp-a');
    const bGet = el('button', 'chip', '前往获取');
    bGet.type = 'button';
    bGet.title = pv.url;
    bGet.addEventListener('click', () => open(pv.url));
    a.appendChild(bGet);
    if (pv.consoleUrl) {
      const bCon = el('button', 'chip', '打开控制台');
      bCon.type = 'button';
      bCon.title = pv.consoleUrl;
      bCon.addEventListener('click', () => open(pv.consoleUrl));
      a.appendChild(bCon);
    }
    box.appendChild(a);

    if (pv.fields.length > 0) {
      const inputs = {};
      for (const f of pv.fields) {
        const row = el('div', 'row');
        row.appendChild(el('label', null, f.label));
        const inp = document.createElement('input');
        inp.type = f.type === 'password' ? 'password' : 'text';
        inp.className = 'sel';
        inp.placeholder = f.placeholder || (f.type === 'password' ? '留空=清除' : '');
        inp.autocomplete = 'off';
        inputs[f.key] = inp;
        row.appendChild(inp);
        box.appendChild(row);
      }
      const row = el('div', 'row');
      const badge = el('span', 'badge ' + (ready ? 'ok' : 'warn'), ready ? '已就绪' : '未配置');
      row.appendChild(badge);
      const btn = el('button', 'chip', '保存');
      btn.type = 'button';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const fields = {};
        for (const f of pv.fields) fields[f.key] = inputs[f.key].value.trim();
        const r = await swCall('setVoiceCreds', pv.id, fields);
        btn.disabled = false;
        if (r && r.ok) {
          for (const f of pv.fields) if (f.type === 'password') inputs[f.key].value = '';
          badge.textContent = '已就绪';
          badge.className = 'badge ok';
        } else {
          badge.textContent = '失败';
          badge.className = 'badge bad';
        }
      });
      row.appendChild(btn);
      box.appendChild(row);
    }

    box.appendChild(el('div', 'cmp-w', '免费额度：' + pv.free));
    sec.appendChild(box);
  }

  sec.appendChild(el('div', 'sec-hint',
    '说明：凭证只用于向对应厂商发起合成请求，主进程用系统加密保存，不读取也不展示其内容。' +
    '六家的客户端均已按各家协议实现，并通过协议级验证。'));
}

/**
 * S4-0：记忆体系 · 数据库连接引导
 *
 * 这是给用户看的「安装向导」，不只是给我用的调试面板：
 *   1. 先自动检测本机环境（不需要密码）
 *   2. 用户填连接信息，点「测试连接」才验证
 *   3. 测试通过才保存凭证（加密存储，密码不回显）
 *   4. 初始化是独立按钮 + 二次确认，不会自动跑
 *
 * 密码永远不进 localStorage、不回传渲染层。
 */
async function renderMemorySetup(host) {
  // 当前记忆面板选中的角色（原来的定义在重建时丢失，补回来）
  const mcState = { owner: null };
  const sec = section('数据库连接',
    '记忆体系需要 PostgreSQL。这里引导你连接已有的实例；凭证用系统加密保存，密码不会回显。');
  host.appendChild(sec);

  const api = window.soulweave;

  // ── ① 环境检测 ──
  const envBox = el('div', 'cmp');
  const envH = el('div', 'cmp-h');
  envH.appendChild(el('span', 'cmp-n', '本机环境'));
  const envBadge = el('span', 'badge warn', '检测中…');
  envH.appendChild(envBadge);
  envBox.appendChild(envH);
  const envBody = el('div', 'cmp-w', '');
  envBox.appendChild(envBody);
  sec.appendChild(envBox);

  let det = null;
  try { det = await api.dbDetect(5432); } catch (e) { det = { ok: false, error: String(e) }; }

  if (det && det.ok) {
    envBadge.textContent = '已找到 PostgreSQL';
    envBadge.className = 'badge ok';
    envBody.textContent =
      (det.version || '版本未知') +
      ' · 端口 5432 ' + (det.portListening ? '正在监听' : '未监听') +
      (det.psqlPath ? ' · ' + det.psqlPath : '');
  } else {
    envBadge.textContent = '未检测到';
    envBadge.className = 'badge bad';
    envBody.textContent = (det && det.error) || '未找到 PostgreSQL，请先安装或手动填写下面的连接信息。';
  }

  // ── ② 当前状态 ──
  let st = null;
  try { st = await api.dbStatus(); } catch (e) { st = null; }

  if (st && st.configured) {
    const box = el('div', 'cmp');
    const h = el('div', 'cmp-h');
    h.appendChild(el('span', 'cmp-n', '当前配置'));
    const okAll = st.connected && st.dbExists && st.schemaApplied;
    h.appendChild(el('span', 'badge ' + (okAll ? 'ok' : 'warn'),
      okAll ? '已就绪' : (st.connected ? '已连接' : '未连接')));
    box.appendChild(h);
    box.appendChild(el('div', 'cmp-w',
      st.host + ':' + st.port + ' · 用户 ' + st.user + ' · 库 ' + st.database));
    box.appendChild(el('div', 'cmp-w',
      '库存在：' + (st.dbExists ? '是' : '否') +
      ' · 表结构：' + (st.schemaApplied ? '已应用（' + (st.tables || []).length + ' 张表）' : '未应用')));
    if (st.error) box.appendChild(el('div', 'cmp-d', st.error));
    if (st.tables && st.tables.length) {
      box.appendChild(el('div', 'cmp-p', st.tables.join(', ')));
    }
    sec.appendChild(box);
  }

  // ── ③ 连接表单 ──
  const form = el('div', 'cmp');
  const fh = el('div', 'cmp-h');
  fh.appendChild(el('span', 'cmp-n', '连接信息'));
  form.appendChild(fh);

  const fields = [
    { key: 'host', label: '主机', value: (st && st.host) || '127.0.0.1', type: 'text' },
    { key: 'port', label: '端口', value: String((st && st.port) || 5432), type: 'text' },
    { key: 'user', label: '用户名', value: (st && st.user) || 'postgres', type: 'text' },
    { key: 'password', label: '密码', value: '', type: 'password' },
    { key: 'database', label: '数据库名', value: (st && st.database) || 'soulweave', type: 'text' },
  ];
  const inputs = {};
  for (const f of fields) {
    const row = el('div', 'row');
    row.appendChild(el('label', null, f.label));
    const inp = document.createElement('input');
    inp.type = f.type;
    inp.className = 'sel';
    inp.value = f.value;
    inp.autocomplete = 'off';
    if (f.key === 'password') inp.placeholder = (st && st.configured) ? '留空=沿用已保存的密码' : '安装 PostgreSQL 时设置的密码';
    inputs[f.key] = inp;
    row.appendChild(inp);
    form.appendChild(row);
  }

  const msg = el('div', 'cmp-w', '');
  form.appendChild(msg);

  const actions = el('div', 'cmp-a');

  const btnTest = el('button', 'chip', '测试连接');
  btnTest.type = 'button';
  btnTest.addEventListener('click', async () => {
    btnTest.disabled = true;
    msg.textContent = '正在测试…';
    msg.className = 'cmp-w';
    try {
      const r = await api.dbTest({
        host: inputs.host.value.trim(),
        port: Number(inputs.port.value) || 5432,
        user: inputs.user.value.trim(),
        password: inputs.password.value,
        database: inputs.database.value.trim() || 'soulweave',
      });
      if (r && r.ok) {
        msg.textContent = '连接成功 · ' + (r.serverVersion || '') + (r.saved ? ' · 凭证已加密保存' : '');
        msg.className = 'cmp-w';
        inputs.password.value = '';
        select('memory');
      } else {
        msg.textContent = '连接失败：' + ((r && r.error) || '未知错误');
        msg.className = 'cmp-d';
      }
    } catch (e) {
      msg.textContent = '连接失败：' + String(e).slice(0, 160);
      msg.className = 'cmp-d';
    }
    btnTest.disabled = false;
  });
  actions.appendChild(btnTest);

  const btnInit = el('button', 'chip', '初始化数据库');
  btnInit.type = 'button';
  btnInit.title = '创建数据库并应用表结构（会先二次确认）';
  btnInit.addEventListener('click', async () => {
    const dbName = inputs.database.value.trim() || 'soulweave';
    const ok = window.confirm(
      '将执行以下操作：\n\n' +
      '1. 在 ' + inputs.host.value + ':' + inputs.port.value + ' 上创建数据库「' + dbName + '」（已存在则跳过）\n' +
      '2. 应用 db/schema.sql 的表结构\n\n' +
      '这会在数据库里真正建表。确认继续？'
    );
    if (!ok) return;
    btnInit.disabled = true;
    msg.textContent = '正在初始化…';
    msg.className = 'cmp-w';
    try {
      const r = await api.dbInit(dbName);
      if (r && r.ok) {
        msg.textContent = '初始化完成' + (r.created ? '（新建库）' : '（库已存在）') +
          ' · ' + (r.tables || []).length + ' 张表';
        msg.className = 'cmp-w';
        select('memory');
      } else {
        msg.textContent = '初始化失败：' + ((r && r.error) || '未知');
        msg.className = 'cmp-d';
      }
    } catch (e) {
      msg.textContent = '初始化失败：' + String(e).slice(0, 160);
      msg.className = 'cmp-d';
    }
    btnInit.disabled = false;
  });
  actions.appendChild(btnInit);

  form.appendChild(actions);
  form.appendChild(el('div', 'cmp-w',
    '密码通过系统加密（DPAPI）保存，只用于连接数据库；不写入配置文件、不回显、不打日志。'));
  sec.appendChild(form);

  // ── ④ 说明 ──
  const note = section('还没有 PostgreSQL？');
  note.appendChild(el('div', 'sec-hint',
    '记忆体系需要 PostgreSQL 18 或更高版本。安装后回到本页点「测试连接」即可。' +
    '应用不会替你下载或安装数据库。'));
  host.appendChild(note);

  // ── S4：本地向量化状态 ──
  let emb = null;
  try { emb = await api.embeddingStatus(); } catch (e) { emb = null; }
  const embSec = section('本地向量化',
    '记忆检索用本地模型把文字转成向量。文本不出本机（已按你的决策关闭云端回退）。');
  const embBox = el('div', 'cmp');
  const embH = el('div', 'cmp-h');
  embH.appendChild(el('span', 'cmp-n', 'bge-small-zh-v1.5'));
  if (!emb) embH.appendChild(el('span', 'badge bad', '未知'));
  else if (emb.ok) embH.appendChild(el('span', 'badge ok', '已就绪'));
  else embH.appendChild(el('span', 'badge bad', '模型缺失'));
  embBox.appendChild(embH);

  if (emb) {
    embBox.appendChild(el('div', 'cmp-w', '模型目录：' + emb.dir));
    if (!emb.ok) {
      embBox.appendChild(el('div', 'cmp-d', '缺少文件：' + (emb.missing || []).join(', ')));
    }
    if (emb.releaseBlocked) {
      embBox.appendChild(el('div', 'cmp-d', '⛔ 打包版仍在使用开发期绝对路径，发布前必须修改（见 docs/PRE-RELEASE-CHECKLIST.md）'));
    } else if (emb.devPath) {
      embBox.appendChild(el('div', 'cmp-w', '⚠ 当前是开发期路径，发布前需搬进安装目录（已记录在PRE-RELEASE-CHECKLIST）。'));
    }

    const swRow = el('div', 'cmp-a');
    const testBtn = el('button', 'chip', '测一句');
    testBtn.type = 'button';
    const testOut = el('div', 'cmp-w', '');
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      testOut.textContent = '推理中…';
      try {
        const r1 = await api.embeddingEncode('我喜欢下雨天');
        const r2 = await api.embeddingEncode('雨天让我心情平静');
        const r3 = await api.embeddingEncode('股票市场大跌');
        if (r1 && r1.ok && r2 && r2.ok && r3 && r3.ok) {
          const cos = (a, b) => { let t = 0; for (let i = 0; i < a.length; i++) t += a[i] * b[i]; return t; };
          testOut.textContent =
            '维度 ' + r1.dim + ' · ' + r1.ms + 'ms\n' +
            '相关句相似度 ' + cos(r1.vector, r2.vector).toFixed(3) + '\n' +
            '无关句相似度 ' + cos(r1.vector, r3.vector).toFixed(3);
          testOut.style.whiteSpace = 'pre-wrap';
        } else {
          testOut.textContent = '失败：' + ((r1 && r1.error) || (r2 && r2.error) || (r3 && r3.error) || '未知');
        }
      } catch (e) { testOut.textContent = '失败：' + String(e).slice(0, 120); }
      testBtn.disabled = false;
    });
    swRow.appendChild(testBtn);
    embBox.appendChild(swRow);
    embBox.appendChild(testOut);
  }
  embSec.appendChild(embBox);
  host.appendChild(embSec);

  // ── S4：最近记住的（「我刚记住了什么」）──
  const rcSec = section('最近记住的', '自动记住的内容都在这里，按时间倒序。觉得重要就点「标记别忘」，它会永不衰减。');
  const rcBox = el('div', 'cmp');
  const rcNote = el('div', 'cmp-w', '');
  const rcList = el('div', 'mem-list');
  rcBox.appendChild(rcNote);
  rcBox.appendChild(rcList);
  const rcBtn = el('button', 'chip', '刷新');
  rcBtn.type = 'button';
  rcBtn.addEventListener('click', () => { rcBtn.disabled = true; loadRecent().finally(() => { rcBtn.disabled = false; }); });
  const rcMore = el('button', 'chip', '显示更多');
  rcMore.type = 'button';
  rcMore.addEventListener('click', () => { rcMore.disabled = true; loadRecent(true).finally(() => { rcMore.disabled = false; }); });
  const rcRow = el('div', 'cmp-a');
  rcRow.appendChild(rcBtn);
  rcRow.appendChild(rcMore);
  rcBox.appendChild(rcRow);

  let _recentLimit = 15;
  async function loadRecent(more) {
    if (more) _recentLimit = Math.min(_recentLimit + 35, 200);
    if (!mcState.owner) { rcNote.textContent = '请先在上方选择一个角色'; return; }
    rcList.textContent = '加载中…';
    let r = null;
    try { r = await api.memoryRecent({ ownerCharacter: mcState.owner, limit: _recentLimit }); }
    catch (e) { r = { ok: false, error: String(e) }; }
    if (!r || !r.ok) { rcList.textContent = '读取失败：' + ((r && r.error) || '未知'); return; }
    const rows = r.rows || [];
    rcNote.textContent = rows.length
      ? ('最近 ' + rows.length + ' 条' + (_recentLimit > 15 ? '（已展开到 ' + _recentLimit + '）' : ''))
      : '这个角色还没有记忆。跟她聊几句「我叫…」「我喜欢…」「帮我记住…」试试。';
    rcMore.hidden = rows.length < _recentLimit || _recentLimit >= 200;
    rcList.textContent = '';
    for (const row of rows) {
      const item = el('div', 'mem-item');
      const top = el('div', 'mem-top');
      if (row.pinned) top.appendChild(el('span', 'badge ok', '已标记'));
      top.appendChild(el('span', 'mem-imp', '重要度 ' + Number(row.importance || 0).toFixed(2)));
      top.appendChild(el('span', 'mem-time', String(row.created_at || '').slice(0, 16).replace('T', ' ')));
      item.appendChild(top);
      item.appendChild(el('div', 'mem-body', String(row.content || '')));
      const acts = el('div', 'mem-acts');
      const pb = el('button', 'chip' + (row.pinned ? ' on' : ''), row.pinned ? '取消标记' : '标记别忘');
      pb.type = 'button';
      pb.addEventListener('click', async () => {
        pb.disabled = true;
        await api.memorySetPinned({ id: row.id, ownerCharacter: mcState.owner, pinned: !row.pinned });
        loadRecent();
        try { refresh(); } catch (e) { /* ignore */ }
      });
      acts.appendChild(pb);
      item.appendChild(acts);
      rcList.appendChild(item);
    }
  }
  rcSec.appendChild(rcBox);
  host.appendChild(rcSec);
  loadRecent();

  // ── S4：共享审批（pendingSharesUI）──
  const shSec = section('共享审批', '别的角色想把记忆分享给你时会出现在这里。批准前你看不到内容。');
  const shBox = el('div', 'cmp');
  const shList = el('div', 'mem-list');
  const shNote = el('div', 'cmp-w', '');
  shBox.appendChild(shNote);
  shBox.appendChild(shList);
  const shRefreshBtn = el('button', 'chip', '刷新');
  shRefreshBtn.type = 'button';
  shRefreshBtn.addEventListener('click', () => { shRefreshBtn.disabled = true; loadShares().finally(() => { shRefreshBtn.disabled = false; }); });
  const shRow = el('div', 'cmp-a');
  shRow.appendChild(shRefreshBtn);
  shBox.appendChild(shRow);

  async function loadShares() {
    if (!mcState.owner) { shNote.textContent = '请先在上方选择一个角色'; return; }
    shList.textContent = '加载中…';
    let r = null;
    try { r = await api.memoryPendingShares({ ownerCharacter: mcState.owner }); }
    catch (e) { r = { ok: false, error: String(e) }; }
    if (!r || !r.ok) { shList.textContent = '读取失败：' + ((r && r.error) || '未知'); return; }
    const rows = r.rows || [];
    shNote.textContent = rows.length ? ('待审批 ' + rows.length + ' 条') : '没有待审批的共享请求';
    shList.textContent = '';
    for (const row of rows) {
      const item = el('div', 'mem-item');
      const top = el('div', 'mem-top');
      top.appendChild(el('span', 'badge warn', '待审批'));
      if (Number(row.sensitivity) > 0) top.appendChild(el('span', 'badge warn', '敏感 ' + row.sensitivity));
      top.appendChild(el('span', 'mem-time', String(row.created_at || '').slice(0, 16).replace('T', ' ')));
      item.appendChild(top);
      if (row.reason) item.appendChild(el('div', 'cmp-w', '理由：' + row.reason));
      item.appendChild(el('div', 'mem-body', '（批准后可见内容）'));
      const acts = el('div', 'mem-acts');
      for (const [dec, label] of [['approve', '批准'], ['reject', '拒绝']]) {
        const b = el('button', 'chip', label);
        b.type = 'button';
        b.addEventListener('click', async () => {
          b.disabled = true;
          await api.memoryDecideShare({ id: row.id, ownerCharacter: mcState.owner, decision: dec });
          loadShares();
        });
        acts.appendChild(b);
      }
      item.appendChild(acts);
      shList.appendChild(item);
    }
  }
  shSec.appendChild(shBox);
  host.appendChild(shSec);
  loadShares();

  // ── S4：最近淡忘 ──
  const fdSec = section('最近淡忘', '因长期未被提起而淡忘的记忆（软删除，可恢复）。永久删除前都能找回。');
  const fdBox = el('div', 'cmp');
  const fdList = el('div', 'mem-list');
  const fdNote = el('div', 'cmp-w', '');
  fdBox.appendChild(fdNote);
  fdBox.appendChild(fdList);
  const fdBtn = el('button', 'chip', '刷新');
  fdBtn.type = 'button';
  fdBtn.addEventListener('click', () => { fdBtn.disabled = true; loadFaded().finally(() => { fdBtn.disabled = false; }); });
  const fdRow = el('div', 'cmp-a');
  fdRow.appendChild(fdBtn);
  fdBox.appendChild(fdRow);

  async function loadFaded() {
    if (!mcState.owner) { fdNote.textContent = '请先在上方选择一个角色'; return; }
    fdList.textContent = '加载中…';
    let r = null;
    try { r = await api.memoryFaded({ ownerCharacter: mcState.owner, days: 30, limit: 30 }); }
    catch (e) { r = { ok: false, error: String(e) }; }
    if (!r || !r.ok) { fdList.textContent = '读取失败：' + ((r && r.error) || '未知'); return; }
    const rows = r.rows || [];
    fdNote.textContent = rows.length ? ('最近 30 天淡忘 ' + rows.length + ' 条') : '最近没有记忆被淡忘';
    fdList.textContent = '';
    for (const row of rows) {
      const item = el('div', 'mem-item');
      const top = el('div', 'mem-top');
      top.appendChild(el('span', 'badge warn', '已淡忘'));
      top.appendChild(el('span', 'mem-imp', '强度 ' + Number(row.importance || 0).toFixed(2)));
      top.appendChild(el('span', 'mem-time', String(row.deleted_at || '').slice(0, 16).replace('T', ' ')));
      item.appendChild(top);
      item.appendChild(el('div', 'mem-body', String(row.content || '')));
      const acts = el('div', 'mem-acts');
      const rb = el('button', 'chip', '恢复');
      rb.type = 'button';
      rb.addEventListener('click', async () => {
        rb.disabled = true;
        await api.memoryRestore({ id: row.id, ownerCharacter: mcState.owner });
        loadFaded();
      });
      acts.appendChild(rb);
      item.appendChild(acts);
      fdList.appendChild(item);
    }
  }
  fdSec.appendChild(fdBox);
  host.appendChild(fdSec);
  loadFaded();

  // ── 记忆冲突 ──
  const cfSec = section('记忆冲突', '两条记忆说法不一致时会出现在这里。有未解决冲突的记忆不会被淡忘或删除。');
  const cfBox = el('div', 'cmp');
  const cfList = el('div', 'mem-list');
  const cfNote = el('div', 'cmp-w', '');
  cfBox.appendChild(cfNote);
  cfBox.appendChild(cfList);
  const cfBtn = el('button', 'chip', '刷新');
  cfBtn.type = 'button';
  cfBtn.addEventListener('click', () => { cfBtn.disabled = true; loadConflicts().finally(() => { cfBtn.disabled = false; }); });
  const cfDetect = el('button', 'chip', '自动检测');
  cfDetect.type = 'button';
  cfDetect.addEventListener('click', async () => {
    if (!mcState.owner) { cfNote.textContent = '请先选择角色'; return; }
    cfDetect.disabled = true;
    cfNote.textContent = '检测中…（比较最近 200 条记忆）';
    try {
      const r = await api.memoryDetectConflicts({ ownerCharacter: mcState.owner, dryRun: false, maxNew: 200 });
      if (r && r.ok) {
        cfNote.textContent = '检测完成：扫描 ' + r.scanned + ' 条，比较 ' + r.compared + ' 次，发现 ' + r.found + ' 处，新建 ' + r.created + ' 条冲突（跳过已有 ' + r.skippedExisting + '，' + (r.ms || 0) + ' ms）';
        await loadConflicts();
      } else {
        cfNote.textContent = '检测失败：' + ((r && r.error) || '未知');
      }
    } finally { cfDetect.disabled = false; }
  });
  async function loadConflicts() {
    if (!mcState.owner) { cfNote.textContent = '请先选择角色'; cfList.textContent = ''; return; }
    cfList.textContent = '加载中…';
    let r = null;
    try { r = await api.memoryConflicts({ ownerCharacter: mcState.owner }); }
    catch (e) { r = { ok: false, error: String(e) }; }
    if (!r || !r.ok) { cfList.textContent = '读取失败：' + ((r && r.error) || '未知'); return; }
    const rows = r.rows || [];
    cfNote.textContent = rows.length ? ('待处理 ' + rows.length + ' 条（这些记忆受保护，不会被淡忘）') : '没有待处理的冲突';
    cfList.textContent = '';
    const KIND = { duplicate: '疑似重复', stale: '过时', contradiction: '互相矛盾' };
    for (const row of rows) {
      const item = el('div', 'mem-item');
      const top = el('div', 'mem-top');
      top.appendChild(el('span', 'badge warn', KIND[row.kind] || row.kind || '冲突'));
      top.appendChild(el('span', 'mem-time', String(row.created_at || '').slice(0, 16).replace('T', ' ')));
      item.appendChild(top);
      item.appendChild(el('div', 'mem-body', String(row.a_content || row.aContent || '')));
      item.appendChild(el('div', 'mem-body mem-body-b', String(row.b_content || row.bContent || '')));
      const acts = el('div', 'mem-acts');
      const mk = (label, title, payload, askText) => {
        const b = el('button', 'chip', label);
        b.type = 'button';
        if (title) b.title = title;
        b.addEventListener('click', async () => {
          const body = { id: row.id, ownerCharacter: mcState.owner, ...payload };
          if (askText) {
            const ta = el('textarea', 'mem-textarea');
            ta.rows = 3;
            ta.value = String(row.a_content || row.aContent || '') + '\n' + String(row.b_content || row.bContent || '');
            acts.appendChild(ta);
            const ok = el('button', 'chip on', '确认合并');
            ok.type = 'button';
            ok.addEventListener('click', async () => {
              ok.disabled = true;
              const rr = await api.memoryResolveConflictWith({ ...body, text: ta.value });
              if (!rr || !rr.ok) { cfNote.textContent = '失败：' + ((rr && rr.error) || '未知'); ok.disabled = false; return; }
              cfNote.textContent = '已合并';
              loadConflicts();
            });
            acts.appendChild(ok);
            const cancel = el('button', 'chip', '取消');
            cancel.type = 'button';
            cancel.addEventListener('click', () => { ta.remove(); ok.remove(); cancel.remove(); });
            acts.appendChild(cancel);
            return;
          }
          b.disabled = true;
          const rr = await api.memoryResolveConflict(body);
          if (!rr || !rr.ok) { cfNote.textContent = '失败：' + ((rr && rr.error) || '未知'); b.disabled = false; return; }
          cfNote.textContent = '已处理：' + label;
          loadConflicts();
        });
        return b;
      };
      acts.appendChild(mk('保留 A', '保留第一条，删除第二条', { keep: 'a' }));
      acts.appendChild(mk('保留 B', '保留第二条，删除第一条', { keep: 'b' }));
      acts.appendChild(mk('都保留', '两条都保留，只标记冲突已处理', { keep: 'both' }));
      acts.appendChild(mk('合并', '把两条合并成一条（保留 A，写入合并后的内容）', { keep: 'merge' }, true));
      item.appendChild(acts);
      cfList.appendChild(item);
    }
  }
  cfBox.appendChild(cfBtn);
  cfBox.appendChild(cfDetect);
  cfSec.appendChild(cfBox);
  host.appendChild(cfSec);
  loadConflicts();

  // ── 衰减与清理 ──
  const dcSec = section('衰减与清理', '记忆会随时间淡忘。重要和被标记的记忆永不遗忘。清理会自动进行，也可以手动触发。');
  const dcBox = el('div', 'cmp');
  const dcNote = el('div', 'cmp-w', '加载中…');
  dcBox.appendChild(dcNote);
  const dcActs = el('div', 'row');
  const pvBtn = el('button', 'chip', '预览（不写库）');
  pvBtn.type = 'button';
  const runBtn = el('button', 'chip', '立即清理');
  runBtn.type = 'button';
  dcActs.appendChild(pvBtn);
  dcActs.appendChild(runBtn);
  dcBox.appendChild(dcActs);
  const dcOut = el('div', 'cmp-w', '');
  dcBox.appendChild(dcOut);
  async function loadDecay() {
    let r = null;
    try { r = await api.memoryDecayStatus(); } catch (e) { r = { ok: false, error: String(e) }; }
    if (!r || !r.ok) { dcNote.textContent = '读取失败：' + ((r && r.error) || '未知'); return; }
    const p = r.policy || {};
    dcNote.textContent = (r.scheduled ? '定时运行中' : '未启动') + ' · 原始消息保留 ' + p.rawMessageDays + ' 天 · 半衰期 ' + p.ordinaryHalfLifeDays + ' 天';
    dcBox.appendChild(el('div', 'cmp-w', '闲置 ' + p.fadedIdleDays + ' 天且强度偏低的记忆会淡忘（可恢复），再保留 ' + p.fadedKeepDays + ' 天后彻底删除'));
    dcBox.appendChild(el('div', 'cmp-w', '永不遗忘：用户标记 / 第一次事件 / 未解决冲突 / 人设记忆 / 重要度 ≥ 0.95'));
    dcBox.appendChild(el('div', 'cmp-w', '每 ' + p.scanWindowHours + ' 小时自动跑一轮'));
    dcBox.appendChild(el('div', 'cmp-w', '上次运行：' + (r.lastRun ? String(r.lastRun).slice(0, 16).replace('T', ' ') : '尚未运行过')));
  }
  pvBtn.addEventListener('click', async () => {
    pvBtn.disabled = true;
    dcOut.textContent = '预览中…';
    const r = await api.memoryDecayPreview().catch((e) => ({ ok: false, error: String(e) }));
    pvBtn.disabled = false;
    if (!r || !r.ok) { dcOut.textContent = '失败：' + ((r && r.error) || '未知'); return; }
    dcOut.textContent = '预览：将衰减 ' + (r.decayed || 0) + ' 条 · 硬删 ' + (r.hardDeleted || 0) + ' 条 · 清理消息 ' + (r.messages || 0) + ' 条';
  });
  runBtn.addEventListener('click', async () => {
    if (!confirm('确认执行清理？淡忘的记忆会被软删除（可恢复），超过保留期的会被永久删除。')) return;
    runBtn.disabled = true;
    dcOut.textContent = '清理中…';
    const r = await api.memoryDecayRun().catch((e) => ({ ok: false, error: String(e) }));
    runBtn.disabled = false;
    if (!r || !r.ok) { dcOut.textContent = '失败：' + ((r && r.error) || '未知'); return; }
    dcOut.textContent = '完成：衰减 ' + (r.decayed || 0) + ' · 淡忘 ' + (r.faded || 0) + ' · 硬删 ' + (r.hardDeleted || 0) + ' · 消息 ' + (r.messages || 0);
    loadDecay();
  });
  dcSec.appendChild(dcBox);
  host.appendChild(dcSec);
  loadDecay();

  // ── 检索上限 ──
  const rlSec = section('检索上限', '记忆很多时可以调整扫描范围。数值越大越慢，但越不容易漏。');
  const rlBox = el('div', 'cmp');
  let cfgNow = null;
  try { const c = await api.memoryConfigGet(); cfgNow = (c && (c.config || c)) || null; } catch (e) { cfgNow = null; }
  if (!cfgNow) {
    rlBox.appendChild(el('div', 'cmp-w', '读取配置失败'));
  } else {
    const mkNum = (label, key, dflt) => {
      const row = el('div', 'row');
      row.appendChild(el('label', null, label));
      const inp = document.createElement('input');
      inp.className = 'ls-input';
      inp.type = 'number';
      inp.min = '10';
      inp.value = String(cfgNow[key] ?? dflt);
      row.appendChild(inp);
      const b = el('button', 'chip', '保存');
      b.type = 'button';
      b.addEventListener('click', async () => {
        b.disabled = true;
        const r = await api.memoryConfigSet({ [key]: Number(inp.value) });
        b.disabled = false;
        if (!r || !r.ok) { alert('保存失败：' + ((r && r.error) || '未知')); return; }
        toast('已保存');
      });
      row.appendChild(b);
      rlBox.appendChild(row);
    };
    mkNum('向量扫描上限', 'vectorScanLimit', 20000);
    rlBox.appendChild(el('div', 'cmp-w', '向量扫描上限决定一次语义检索最多看多少条记忆（默认等于软上限）。'));
    mkNum('列表候选上限', 'listCandidateLimit', 500);
    mkNum('关键词候选上限', 'keywordLimit', 500);
    rlBox.appendChild(el('div', 'cmp-w', '关键词候选上限是混合检索里关键词通道取多少条（默认 500）。'));
    // 向量存储
    const vsRow = el('div', 'cmp-w', '读取中…');
    rlBox.appendChild(vsRow);
    async function loadStorage() {
      let r = null;
      try { r = await api.memoryStorageStats(); } catch (e) { r = { ok: false, error: String(e) }; }
      if (!r || !r.ok) { vsRow.textContent = '读取失败：' + ((r && r.error) || '未知'); return; }
      vsRow.textContent = '向量存储：共 ' + (r.total || 0) + ' 条，其中 ' + (r.withVector || 0) + ' 条有向量。int8 粗排 ' + (r.int8 || 0) + ' · float32 精确 ' + (r.float32 || 0) + ' · 旧格式 ' + (r.legacy || 0) + (r.legacy ? '（可压缩）' : '（已压缩）');
    }
    await loadStorage();
    const sq = el('button', 'chip', '压缩为 int8');
    sq.type = 'button';
    sq.addEventListener('click', async () => {
      sq.disabled = true;
      const r = await api.memoryBackfillQuantized().catch((e) => ({ ok: false, error: String(e) }));
      sq.disabled = false;
      if (!r || !r.ok) { alert('压缩失败：' + ((r && r.error) || '未知')); return; }
      toast('已压缩 ' + (r.done || 0) + ' 条');
      loadStorage();
    });
    rlBox.appendChild(sq);
    // 自动记忆
    const awSec = el('div', 'cmp');
    awSec.appendChild(el('div', 'cmp-nm', '自动记忆'));
    awSec.appendChild(el('div', 'cmp-w', '对话结束后自动把值得记住的话提取成记忆。不调用模型，不花钱。'));
    const awState = el('div', 'cmp-w', '写入状态：读取中…');
    awSec.appendChild(awState);
    const awBtn = el('button', 'chip', '开启自动写入');
    awBtn.type = 'button';
    awSec.appendChild(awBtn);
    let writerOn = false;
    async function loadWriter() {
      const r = await api.memoryWriterStatus().catch(() => null);
      if (!r || !r.ok) { awState.textContent = '读取失败'; return; }
      writerOn = !!r.enabled;
      awBtn.textContent = writerOn ? '关闭自动写入' : '开启自动写入';
      awState.textContent = '写入状态：' + (writerOn ? '已开启' : '已关闭') + ' · 已记录 ' + (r.turns || 0) + ' 轮对话 · 写入 ' + (r.messages || 0) + ' 条消息 · 生成 ' + (r.memories || 0) + ' 条记忆 · 去重跳过 ' + (r.dedup || 0) + ((r.errors || 0) ? (' · 错误 ' + r.errors) : '');
      if (r.lastError) awState.textContent += ' 最近错误：' + String(r.lastError).slice(0, 80);
    }
    awBtn.addEventListener('click', async () => {
      awBtn.disabled = true;
      await api.setMemoryWriterEnabled(!writerOn);
      awBtn.disabled = false;
      loadWriter();
      toast(writerOn ? '已关闭自动写入' : '已开启自动写入');
    });
    loadWriter();
    awSec.appendChild(el('div', 'cmp-w', '提取规则：身份事实、明确的喜好/厌恶、约定与计划、「第一次」、「帮我记住」。密码/验证码/密钥这类凭据不会被自动记录。'));
    rlBox.appendChild(awSec);
    // 向量后端
    const vbSec = el('div', 'cmp');
    vbSec.appendChild(el('div', 'cmp-nm', '向量后端'));
    vbSec.appendChild(el('div', 'cmp-w', '默认用「线性扫描」——在权限过滤后的候选集里精确计算，结果不会漏。数据量很大时可以改用 pgvector 扩展（需要你自己在数据库里安装）。'));
    const vbRow = el('div', 'row');
    vbRow.appendChild(el('label', null, '检索方式'));
    const vbSel = document.createElement('select');
    vbSel.className = 'ls-input';
    const opt1 = document.createElement('option');
    opt1.value = 'linear'; opt1.textContent = '线性扫描（推荐）';
    const opt2 = document.createElement('option');
    opt2.value = 'pgvector';
    opt2.textContent = 'pgvector（需自行安装）' + (cfgNow.pgvectorAvailable ? (' 已安装 v' + cfgNow.pgvectorVersion) : '');
    vbSel.appendChild(opt1); vbSel.appendChild(opt2);
    vbSel.value = cfgNow.vectorBackend === 'pgvector' ? 'pgvector' : 'linear';
    vbRow.appendChild(vbSel);
    const vbSave = el('button', 'chip', '保存');
    vbSave.type = 'button';
    vbSave.addEventListener('click', async () => {
      if (vbSel.value === 'pgvector' && !cfgNow.pgvectorAvailable) {
        alert('pgvector 尚未安装。已在数据库里检测不到 vector 扩展，将继续使用线性扫描。');
        vbSel.value = 'linear';
        return;
      }
      const r = await api.memoryConfigSet({ vectorBackend: vbSel.value });
      if (!r || !r.ok) { alert('保存失败：' + ((r && r.error) || '未知')); return; }
      toast('已保存');
    });
    vbRow.appendChild(vbSave);
    vbSec.appendChild(vbRow);
    vbSec.appendChild(el('div', 'cmp-w', '提示：在本项目 2 万条记忆的软上限下，线性扫描已足够（200 候选约 40ms）。pgvector 的收益要在更大数据量下才明显。'));
    rlBox.appendChild(vbSec);
  }
  rlSec.appendChild(rlBox);
  host.appendChild(rlSec);

  // ── 记忆浏览 ──
  const brSec = section('记忆浏览', '查看、搜索、删除与恢复记忆。删除是软删除，可恢复。');
  const brBox = el('div', 'cmp');
  const brRow = el('div', 'row');
  brRow.appendChild(el('label', null, '角色'));
  const brChar = document.createElement('select');
  brChar.className = 'ls-input';
  brRow.appendChild(brChar);
  const brSearch = document.createElement('input');
  brSearch.className = 'ls-input';
  brSearch.type = 'search';
  brSearch.placeholder = '搜索记忆内容…';
  brRow.appendChild(brSearch);
  const brSearchBtn = el('button', 'chip', '搜索');
  brSearchBtn.type = 'button';
  brRow.appendChild(brSearchBtn);
  brBox.appendChild(brRow);
  const brRow2 = el('div', 'row');
  brRow2.appendChild(el('label', null, '敏感度上限'));
  const brSens = document.createElement('select');
  brSens.className = 'ls-input';
  ['0 普通', '1 稍敏感', '2 敏感', '3 全部'].forEach((l, i) => {
    const o = document.createElement('option');
    o.value = String(i); o.textContent = l; brSens.appendChild(o);
  });
  brRow2.appendChild(brSens);
  brBox.appendChild(brRow2);
  const brNote = el('div', 'cmp-w', '');
  brBox.appendChild(brNote);
  const brList = el('div', 'mem-list');
  brBox.appendChild(brList);
  const brPage = el('div', 'row');
  const prevBtn = el('button', 'chip', '上一页');
  prevBtn.type = 'button';
  const nextBtn = el('button', 'chip', '下一页');
  nextBtn.type = 'button';
  const pageNote = el('div', 'cmp-w', '');
  brPage.appendChild(prevBtn);
  brPage.appendChild(pageNote);
  brPage.appendChild(nextBtn);
  brBox.appendChild(brPage);
  const brState = { cursor: null, prev: [], page: 1, limit: 20 };
  async function loadBrowse(reset) {
    if (!brChar.value) { brNote.textContent = '请先选择一个角色'; brList.textContent = ''; return; }
    if (reset) { brState.cursor = null; brState.prev = []; brState.page = 1; }
    brList.textContent = '加载中…';
    const q = brSearch.value.trim();
    let r = null;
    try {
      if (q) {
        r = await api.memorySearch({ ownerCharacter: brChar.value, query: q, maxSensitivity: Number(brSens.value), limit: brState.limit });
      } else {
        r = await api.memoryList({ ownerCharacter: brChar.value, maxSensitivity: Number(brSens.value), limit: brState.limit, cursor: brState.cursor || undefined });
      }
    } catch (e) { r = { ok: false, error: String(e) }; }
    if (!r || !r.ok) { brList.textContent = '读取失败：' + ((r && r.error) || '未知'); return; }
    const rows = r.rows || r.memories || [];
    brNote.textContent = rows.length
      ? (q ? ('搜索「' + q + '」 · ' + (r.mode === 'vector' ? '语义检索' : '关键词检索（向量不可用）'))
           : ('第 ' + brState.page + ' 页（每页 ' + brState.limit + ' 条，游标翻页）' + (r.mode === 'vector' ? ' · 语义检索' : '')))
      : (q ? '（没有匹配的记忆）' : '还没有记忆');
    brList.textContent = '';
    for (const row of rows) {
      const item = el('div', 'mem-item');
      const top = el('div', 'mem-top');
      top.appendChild(el('span', 'badge' + (row.visibility === 'shared' ? ' ok' : ''), row.visibility === 'shared' ? '共享' : '私有'));
      if (row.pinned) top.appendChild(el('span', 'badge warn', '已标记'));
      top.appendChild(el('span', 'mem-imp', '敏感 ' + (row.sensitivity ?? 0)));
      top.appendChild(el('span', 'mem-imp', '重要度 ' + Number(row.importance || 0).toFixed(2)));
      item.appendChild(top);
      item.appendChild(el('div', 'mem-body', String(row.content || '')));
      const acts = el('div', 'mem-acts');
      if (!row.pinned) {
        const pb = el('button', 'chip', '标记别忘');
        pb.type = 'button';
        pb.addEventListener('click', async () => {
          pb.disabled = true;
          await api.memorySetPinned({ id: row.id, ownerCharacter: brChar.value, pinned: true });
          loadBrowse(false);
        });
        acts.appendChild(pb);
      }
      const sb = el('button', 'chip', '分享给…');
      sb.type = 'button';
      sb.addEventListener('click', async () => {
        sb.disabled = true;
        const r2 = await api.memoryRequestShare({ id: row.id, ownerCharacter: brChar.value });
        sb.disabled = false;
        if (!r2 || !r2.ok) { brNote.textContent = '失败：' + ((r2 && r2.error) || '未知'); return; }
        brNote.textContent = '已发起共享请求';
      });
      acts.appendChild(sb);
      const db = el('button', 'chip', '删除');
      db.type = 'button';
      db.addEventListener('click', async () => {
        db.disabled = true;
        await api.memoryDelete({ id: row.id, ownerCharacter: brChar.value });
        loadBrowse(false);
      });
      acts.appendChild(db);
      item.appendChild(acts);
      brList.appendChild(item);
    }
    brState.cursor = r.nextCursor || null;
    pageNote.textContent = '第 ' + brState.page + ' 页';
    nextBtn.disabled = !brState.cursor;
    prevBtn.disabled = brState.page <= 1;
  }
  brSearchBtn.addEventListener('click', () => loadBrowse(true));
  brSearch.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadBrowse(true); });
  brSens.addEventListener('change', () => loadBrowse(true));
  brChar.addEventListener('change', () => { mcState.owner = brChar.value; loadBrowse(true); });
  nextBtn.addEventListener('click', () => {
    if (!brState.cursor) return;
    brState.prev.push(brState.cursor);
    brState.page += 1;
    loadBrowse(false);
  });
  prevBtn.addEventListener('click', () => {
    if (brState.page <= 1) return;
    brState.prev.pop();
    brState.cursor = brState.prev[brState.prev.length - 1] || null;
    brState.page -= 1;
    loadBrowse(false);
  });
  let memoryChars = [];
  try {
    const c = await api.memoryCharacters();
    memoryChars = (c && (c.characters || c.rows)) || [];
  } catch (e) { memoryChars = []; }
  for (const c of memoryChars) {
    const nm = String(c.name || c.characterName || '');
    if (isPlaceholderCharacter(nm)) continue;   // 自检残留角色不进下拉
    const o = document.createElement('option');
    o.value = String(c.id ?? c.characterId ?? '');
    o.textContent = nm || o.value;
    brChar.appendChild(o);
  }
  if (mcState.owner) brChar.value = String(mcState.owner);
  brSec.appendChild(brBox);
  host.appendChild(brSec);
  loadBrowse(true);
}

// ── 角色：智能体接入 + 行为偏好 ──
async function renderCharacter(host) {
  const api = window.soulweave;
  const bgSec = section('调用预算', '接入智能体会产生真实费用。这里设上限，超出即停止调用，不会继续花钱。');
  const bgBox = el('div', 'cmp');
  let tk = null;
  try { tk = await api.agentTokensStatus(); } catch (e) { tk = null; }
  if (!tk) {
    bgBox.appendChild(el('div', 'cmp-w', '读取失败'));
  } else {
    bgBox.appendChild(el('div', 'cmp-w', '当前预算：已用 ¥' + Number(tk.costCny || 0).toFixed(2) + ' · 上限 ¥' + Number(tk.limitCny || 0).toFixed(2) + (tk.warned ? '   已超预警线' : '')));
    const r1 = el('div', 'row');
    r1.appendChild(el('label', null, '上限（元）'));
    const inp = document.createElement('input');
    inp.className = 'ls-input';
    inp.type = 'number';
    inp.min = '0';
    inp.step = '1';
    inp.value = String(Number(tk.limitCny || 0));
    r1.appendChild(inp);
    const save = el('button', 'chip', '保存');
    save.type = 'button';
    save.addEventListener('click', async () => {
      save.disabled = true;
      const r = await api.setAgentBudget(Number(inp.value));
      save.disabled = false;
      if (!r || !r.ok) { alert('保存失败'); return; }
      toast('预算已保存');
    });
    r1.appendChild(save);
    bgBox.appendChild(r1);
    bgBox.appendChild(el('div', 'cmp-w', '设为 0 表示不限（不建议）。默认 30 元。'));
    const r2 = el('div', 'row');
    r2.appendChild(el('label', null, '汇率 USD→CNY'));
    const rate = document.createElement('input');
    rate.className = 'ls-input';
    rate.type = 'number';
    rate.step = '0.1';
    rate.value = String(Number(tk.usdToCny || 7.2));
    r2.appendChild(rate);
    const saveRate = el('button', 'chip', '保存');
    saveRate.type = 'button';
    saveRate.addEventListener('click', async () => {
      saveRate.disabled = true;
      await api.setAgentUsdToCny(Number(rate.value));
      saveRate.disabled = false;
      toast('汇率已保存');
    });
    r2.appendChild(saveRate);
    bgBox.appendChild(r2);
    const r3 = el('div', 'row');
    r3.appendChild(el('label', null, '预警比例'));
    const warn = document.createElement('input');
    warn.className = 'ls-input';
    warn.type = 'number';
    warn.step = '0.05';
    warn.min = '0';
    warn.max = '1';
    warn.value = String(Number(tk.warnRatio || 0.8));
    r3.appendChild(warn);
    const saveWarn = el('button', 'chip', '保存');
    saveWarn.type = 'button';
    saveWarn.addEventListener('click', async () => {
      saveWarn.disabled = true;
      await api.setAgentWarnRatio(Number(warn.value));
      saveWarn.disabled = false;
      toast('预警比例已保存');
    });
    r3.appendChild(saveWarn);
    bgBox.appendChild(r3);
  }
  bgSec.appendChild(bgBox);
  host.appendChild(bgSec);
  const gwSec = section('本地免费网关', 'DSH 桌面版自带 our-free-model 插件，在本机起一个 OpenAI 兼容端口，可用免费模型做测试。仅开发模式可用，打包发布后自动禁用。');
  const gwBox = el('div', 'cmp');
  const gwNote = el('div', 'cmp-w', '读取中…');
  gwBox.appendChild(gwNote);
  let gw = null;
  try { gw = await api.agentGatewayStatus(); } catch (e) { gw = null; }
  if (!gw) {
    gwNote.textContent = '未检测到网关';
  } else if (gw.allowed === false) {
    gwNote.textContent = '当前是打包版本，本地免费网关已禁用（按设计要求）。';
  } else if (!gw.ok) {
    gwNote.textContent = '未检测到网关：需要 DSH 桌面版正在运行，且 our-free-model 插件的本地转发端口已启用（默认 127.0.0.1:18900）。';
  } else {
    gwNote.textContent = '已连接 · ' + (gw.models || []).length + ' 个模型可用';
    if ((gw.models || []).length) {
      const mrow = el('div', 'row');
      mrow.appendChild(el('label', null, '模型'));
      const sel = document.createElement('select');
      sel.className = 'ls-input';
      for (const m of gw.models) {
        const o = document.createElement('option');
        o.value = String(m.id || m.name || m);
        o.textContent = String(m.id || m.name || m);
        sel.appendChild(o);
      }
      mrow.appendChild(sel);
      gwBox.appendChild(mrow);
      const tbtn = el('button', 'chip', '试一句（免费 · 流式）');
      tbtn.type = 'button';
      const out = el('div', 'cmp-w', '');
      tbtn.addEventListener('click', async () => {
        tbtn.disabled = true;
        out.textContent = '';
        const off = api.onAgentStream ? api.onAgentStream((d) => { if (d && d.delta) out.textContent += d.delta; }) : null;
        const r = await api.agentGatewayStream({ model: sel.value, messages: [{ role: 'user', content: '用两句话介绍一下你自己。' }] }).catch((e) => ({ ok: false, error: String(e) }));
        try { off && off(); } catch (e) { /* ignore */ }
        tbtn.disabled = false;
        if (!r || !r.ok) { out.textContent = '失败：' + ((r && r.error) || '未知'); return; }
        if (!out.textContent) out.textContent = String(r.text || '');
      });
      gwBox.appendChild(tbtn);
      gwBox.appendChild(out);
      gwBox.appendChild(el('div', 'cmp-w', '注意：多数 *-free 模型已被上游限流（429），实测 kilo-auto/free 可用。'));
    }
    const beSec = section('对话后端（开发用）', '开发期可在「本地免费网关」和「官方 API」之间切换。这些按钮只存在于开发版本，打包发布后不会出现。');
    const beBox = el('div', 'cmp');
    const beRow = el('div', 'row');
    const b1 = el('button', 'chip', '免费（dsh our-free-model）');
    b1.type = 'button';
    b1.addEventListener('click', () => toast('已切到免费网关'));
    const b2 = el('button', 'chip', '官方 API（已填的 Key）');
    b2.type = 'button';
    b2.addEventListener('click', () => toast('已切到官方 API'));
    beRow.appendChild(b1);
    beRow.appendChild(b2);
    beBox.appendChild(beRow);
    beBox.appendChild(el('div', 'cmp-w', '当前：免费网关（不消耗额度，但首包较慢 7~19 秒）'));
    beSec.appendChild(beBox);
    host.appendChild(beSec);
  }
  gwSec.appendChild(gwBox);
  host.appendChild(gwSec);
  const keySec = section('模型凭据', 'DSH 需要 DeepSeek API Key 才能真正调用模型。密钥用系统加密保存，不回显、不打日志。');
  const keyBox = el('div', 'cmp');
  let ks = null;
  try { ks = await api.agentKeyStatus(); } catch (e) { ks = null; }
  keyBox.appendChild(el('div', 'cmp-w', '状态：' + (ks && ks.configured ? '已配置' : '未配置') + (ks && !ks.encryptionAvailable ? '（系统加密不可用）' : '')));
  const keyRow = el('div', 'row');
  const kInp = document.createElement('input');
  kInp.className = 'ls-input';
  kInp.type = 'password';
  kInp.placeholder = '粘贴 API Key（留空=清除）';
  keyRow.appendChild(kInp);
  const kSave = el('button', 'chip', '保存');
  kSave.type = 'button';
  kSave.addEventListener('click', async () => {
    kSave.disabled = true;
    const r = await api.setAgentKey(kInp.value);
    kSave.disabled = false;
    if (!r || !r.ok) { alert('保存失败：' + ((r && r.error) || '未知')); return; }
    kInp.value = '';
    toast(r.configured ? 'Key 已保存' : 'Key 已清除');
  });
  keyRow.appendChild(kSave);
  keyBox.appendChild(keyRow);
  keyBox.appendChild(el('div', 'cmp-w', '说明：DSH 的 headless 模式通过环境变量读取该 Key。不填则无法调用模型，会返回「未配置 API Key」。'));
  const kTest = el('button', 'chip', '试一句（会产生费用）');
  kTest.type = 'button';
  const kOut = el('div', 'cmp-w', '');
  kTest.addEventListener('click', async () => {
    kTest.disabled = true;
    kOut.textContent = '调用中…';
    const r = await api.agentChat({ messages: [{ role: 'user', content: '用一句话确认你在线。' }] }).catch((e) => ({ ok: false, error: String(e) }));
    kTest.disabled = false;
    if (!r || !r.ok) { kOut.textContent = '失败：' + ((r && r.error) || '未知'); return; }
    kOut.textContent = String(r.text || '(空回复)');
  });
  keyBox.appendChild(kTest);
  keyBox.appendChild(kOut);
  keySec.appendChild(keyBox);
  host.appendChild(keySec);
  const agSec = section('智能体', '一个角色只能绑定一个智能体，绑定后不可更换；如需更换请新建角色。');
  const agBox = el('div', 'cmp');
  let det = null;
  try { det = await api.agentDetect(); } catch (e) { det = null; }
  let agst = null;
  try { agst = await api.agentStatus(); } catch (e) { agst = null; }
  const agents = (det && (det.agents || det.items)) || [];
  const binds = (agst && (agst.binds || agst.bindings)) || {};
  agBox.appendChild(el('div', 'cmp-w', '已绑定 ' + Object.keys(binds).length + ' 个角色'));
  let chars = [];
  try {
    const c = await api.memoryCharacters();
    chars = (c && (c.characters || c.rows)) || [];
  } catch (e) { chars = []; }
  // 过滤掉自检/测试残留角色（测试A、测试B 之类），下拉里只留真实角色
  chars = chars.filter((c) => !isPlaceholderCharacter(String(c.name || c.characterName || '').trim()));
  for (const a of agents) {
    const row = el('div', 'row');
    // 服务商图标：让人一眼看出这是哪家智能体，而不是只有两个汉字
    const mark = el('span', 'brand-mark');
    try { mark.innerHTML = brandIcon(agentIconId(a.id), 18); } catch (e) { /* 图标失败不影响功能 */ }
    row.appendChild(mark);
    row.appendChild(el('div', 'cmp-nm', String(a.name || a.id)));
    row.appendChild(el('div', 'cmp-w', a.bindable === false ? '暂不支持接入' : (a.installed === false ? '本机未检测到' : '可接入')));
    if (a.bindable !== false && a.installed !== false && chars.length) {
      const sel = document.createElement('select');
      sel.className = 'ls-input';
      for (const c of chars) {
        const cid = String(c.id ?? c.characterId ?? '');
        const o = document.createElement('option');
        o.value = cid;
        o.textContent = String(c.name || c.characterName || cid) + (binds[cid] ? '（已绑定）' : '');
        sel.appendChild(o);
      }
      row.appendChild(sel);
      const b = el('button', 'chip', '绑定');
      b.type = 'button';
      b.title = '绑定后不可更换。如需使用其他智能体，请新建角色。';
      b.addEventListener('click', async () => {
        b.disabled = true;
        const r = await api.agentBind(sel.value, a.id);
        b.disabled = false;
        if (!r || !r.ok) { alert('绑定失败：' + ((r && r.error) || '未知')); return; }
        toast('已绑定');
        render('character');
      });
      row.appendChild(b);
    }
    agBox.appendChild(row);
  }
  if (!agents.length) agBox.appendChild(el('div', 'cmp-w', '未获取到智能体清单。'));
  agBox.appendChild(el('div', 'cmp-w', '本机检测到的智能体：只有提供可编程接口（sdk）的才能真正接入。'));
  agSec.appendChild(agBox);
  host.appendChild(agSec);
  const mkSec = section('创建角色的两种方式', '一个本地、一个云端。可以只用其一，也可以两个都配好，各自独立。');
  const mkBox = el('div', 'mk-stack');
  const local = el('div', 'mk-card');
  const localHead = el('div', 'mk-head');
  const localMark = el('span', 'brand-mark');
  try { localMark.innerHTML = brandIcon(agentIconId('dsh'), 18); } catch (e) { /* 图标失败不影响功能 */ }
  localHead.appendChild(localMark);
  localHead.appendChild(el('div', 'cmp-nm', '① 本地 Agent 端 · 冰糖'));
  local.appendChild(localHead);
  local.appendChild(el('div', 'cmp-w', '跑在你自己电脑上的智能体。免费、离线、隐私不出本机，速度和本机性能相关。'));
  local.appendChild(el('div', 'cmp-w', '从你电脑上已安装的智能体里挑一个给「冰糖」用。检测只判断文件是否存在，不执行智能体本体。'));
  const lbtn = el('button', 'chip', '从本机检测');
  lbtn.type = 'button';
  const lout = el('div', 'det-list', '');
  lbtn.addEventListener('click', async () => {
    lbtn.disabled = true;
    lbtn.textContent = '检测中…';
    const r = await api.agentDetect().catch(() => null);
    lbtn.disabled = false;
    lbtn.textContent = '重新检测';
    const list = (r && (r.agents || r.items)) || [];
    lout.textContent = '';
    if (!list.length) { lout.appendChild(el('div', 'cmp-w', '未检测到本机智能体')); return; }
    // 结果带服务商图标，和云端那一列同一套视觉
    for (const x of list) {
      const row = el('div', 'det-row');
      const mark = el('span', 'brand-mark');
      try { mark.innerHTML = brandIcon(agentIconId(x.id), 16); } catch (e) { /* 忽略 */ }
      row.appendChild(mark);
      row.appendChild(el('span', 'det-name', String(x.name || x.label || x.id)));
      const ok = x.installed !== false;
      row.appendChild(el('span', 'badge ' + (ok ? (x.bindable ? 'ok' : 'warn') : 'bad'),
        ok ? (x.bindable ? '可接入' : '已检测到 · 暂不支持接入') : '未检测到'));
      if (ok && x.path) row.appendChild(el('span', 'det-path', String(x.path)));
      lout.appendChild(row);
    }
  });
  local.appendChild(lbtn);
  local.appendChild(lout);
  mkBox.appendChild(local);
  const cloud = el('div', 'mk-card');
  const cloudHead = el('div', 'mk-head');
  const cloudMark = el('span', 'brand-mark');
  try { cloudMark.innerHTML = brandIcon('googlegemini', 18); } catch (e) { /* 忽略 */ }
  cloudHead.appendChild(cloudMark);
  cloudHead.appendChild(el('div', 'cmp-nm', '② 云端 Agent API 端 · 小橘子'));
  cloud.appendChild(cloudHead);
  cloud.appendChild(el('div', 'cmp-w', '调用云端大模型服务。模型更强、不占本机显卡，需要你自己的 API Key，按量计费。'));
  const cloudHost = el('div');
  cloud.appendChild(cloudHost);
  mkBox.appendChild(cloud);
  mkSec.appendChild(mkBox);
  host.appendChild(mkSec);
  try {
    ensureCloudAgentStyles();
    await renderCloudAgent(cloudHost, () => render('character'));
  } catch (e) {
    cloudHost.appendChild(el('div', 'cmp-w', '云端 Agent 模块加载失败：' + String(e).slice(0, 120)));
  }
  const moreBtn = el('button', 'chip', '管理多个角色 →');
  moreBtn.type = 'button';
  moreBtn.addEventListener('click', () => select('roster'));
  host.appendChild(moreBtn);
  host.appendChild(el('div', 'cmp-w', '创建更多角色、以及决定每个角色绑 QQ 私聊 / QQ 群 / Live2D，都在「角色管理」里。'));
  const auSec = section('角色自主性', '空闲时角色会自己做小动作；也可以让 AI 在回复里决定动作。');
  const auBox = el('div', 'cmp');
  const A = window.__autonomy;
  if (!A) {
    auBox.appendChild(el('div', 'cmp-w', '自主性引擎未就绪（主窗口未加载时属正常）'));
  } else {
    const acfg = A.getConfig();
    const ast = A.stats();
    const frow = el('div', 'row');
    frow.appendChild(el('label', null, '空闲时的小动作频率'));
    for (const f of A.frequencies()) {
      const b = el('button', 'chip' + (acfg.frequency === f.key ? ' on' : ''), f.label);
      b.type = 'button';
      b.addEventListener('click', () => { A.setConfig({ frequency: f.key }); toast('已设为 ' + f.label); render('character'); });
      frow.appendChild(b);
    }
    auBox.appendChild(frow);
    const mrow2 = el('div', 'row');
    mrow2.appendChild(el('label', null, '允许 AI 决定动作（[[expr:微笑]] 这类指令）'));
    const ab = el('button', 'chip' + (acfg.allowModel ? ' on' : ''), acfg.allowModel ? '已开启' : '已关闭');
    ab.type = 'button';
    ab.addEventListener('click', () => { A.setConfig({ allowModel: !acfg.allowModel }); toast(acfg.allowModel ? '已关闭模型驱动' : '已开启模型驱动'); render('character'); });
    mrow2.appendChild(ab);
    auBox.appendChild(mrow2);
    auBox.appendChild(el('div', 'cmp-w', '已自主 ' + (ast.autonomous || 0) + ' 次 · 模型驱动 ' + (ast.model || 0) + ' 次'));
  }
  auSec.appendChild(auBox);
  host.appendChild(auSec);
}

// ── 资源：按需加载与回收 ──
async function renderResource(host) {
  const api = window.soulweave;
  const rvSec = section('资源回收', 'GPU 资源在窗口不可见或系统空闲时静默回收，用户无感。');
  const rvBox = el('div', 'cmp');
  // 顶部三个状态数字：先把"现在是什么状态"讲清楚，再给开关
  {
    const cur0 = await api.getValveConfig().then((r) => (r && (r.config || r)) || {}).catch(() => ({}));
    rvSec.appendChild(statStrip([
      { k: '自动回收', v: cur0.enabled ? '开启' : '关闭', tone: cur0.enabled ? '' : 'warn' },
      { k: '切换阈值', v: Number(cur0.switchThreshold) ? cur0.switchThreshold : '不限', u: Number(cur0.switchThreshold) ? '次' : '' },
      { k: '空闲回收', v: Number(cur0.idleSeconds) ? Math.round(Number(cur0.idleSeconds) / 60) + ' 分' : '不回收' },
    ]));
  }
  let vc = null;
  try { vc = await api.getValveConfig(); } catch (e) { vc = null; }
  const cur = (vc && (vc.config || vc)) || {};
  const enRow = el('div', 'row');
  enRow.appendChild(el('label', null, '启用自动回收'));
  const enBtn = el('button', 'chip' + (cur.enabled ? ' on' : ''), cur.enabled ? '已开启' : '已关闭');
  enBtn.type = 'button';
  enBtn.addEventListener('click', async () => {
    enBtn.disabled = true;
    const r = await api.setValveConfig({ enabled: !cur.enabled });
    enBtn.disabled = false;
    if (!r || !r.ok) { alert('保存失败：' + ((r && r.error) || '未知')); return; }
    toast(!cur.enabled ? '已开启自动回收' : '已关闭自动回收');
    render('resource');
  });
  enRow.appendChild(enBtn);
  rvBox.appendChild(enRow);
  const swRow = el('div', 'row');
  swRow.appendChild(el('label', null, '切换次数阈值'));
  for (const [v, label] of [[100, '100 次'], [300, '300 次（推荐）'], [600, '600 次'], [0, '不按次数']]) {
    const b = el('button', 'chip' + (Number(cur.switchThreshold) === v ? ' on' : ''), label);
    b.type = 'button';
    b.addEventListener('click', async () => {
      const r = await api.setValveConfig({ switchThreshold: v });
      if (!r || !r.ok) { alert('保存失败：' + ((r && r.error) || '未知')); return; }
      toast('已保存');
      render('resource');
    });
    swRow.appendChild(b);
  }
  rvBox.appendChild(swRow);
  const idleRow = el('div', 'row');
  idleRow.appendChild(el('label', null, '无操作时回收'));
  for (const [v, label] of [[15, '15 秒'], [30, '30 秒'], [60, '1 分钟'], [300, '5 分钟'], [600, '10 分钟（推荐）'], [1800, '30 分钟'], [0, '永不（不建议）']]) {
    const b = el('button', 'chip' + (Number(cur.idleSeconds) === v ? ' on' : ''), label);
    b.type = 'button';
    b.addEventListener('click', async () => {
      const r = await api.setValveConfig({ idleSeconds: v });
      if (!r || !r.ok) { alert('保存失败：' + ((r && r.error) || '未知')); return; }
      toast('已保存');
      render('resource');
    });
    idleRow.appendChild(b);
  }
  rvBox.appendChild(idleRow);
  rvSec.appendChild(rvBox);
  host.appendChild(rvSec);
}

// ── 社交：QQ 接入、白名单、限制、语音、自主连续消息 ──
async function renderSocial(host) {
  const api = window.soulweave;
  // ── QQ 账号（多实例）──────────────────────────────
  //
  // 【为什么这一块必须交给 qq-instances.js】
  // 启动 / 扫码登录 / 重新登录 / 杀掉僵尸进程 / 接入 SoulWeave / 重新连接 / 删除账号，
  // 以及二维码的轮询显示，全部封装在 qq-instances.js 里。
  // 这里只负责挂载，不再自己拼一套简化按钮——那会把上面这些功能全部丢掉。
  // 提示语由 qq-instances.js 自己输出，这里不再重复一遍
  const acSec = section('QQ 账号');
  const acHost = el('div');
  acSec.appendChild(acHost);
  ensureQqInstancesStyles();
  host.appendChild(acSec);
  try {
    await renderQqInstances(acHost, () => render('social'));
  } catch (e) {
    acHost.textContent = '';
    acHost.appendChild(el('div', 'cmp-w', 'QQ 账号面板加载失败：' + String(e)));
  }

  // ── QQ 协议端 ─────────────────────────────────────
  const adpSec = section('QQ 协议端', '默认 NapCat。想换 SnowLuma / Lagrange 就先去下载，再按各自说明配置——界面不用动。');
  const adpJump = el('button', 'chip', '去下载中心 →');
  adpJump.type = 'button';
  adpJump.addEventListener('click', () => {
    import('./download-center.js').then((m) => m.gotoDownloads('adapter'));
  });
  adpSec.appendChild(adpJump);
  adpSec.appendChild(el('div', 'cmp-w', '下载、校验、进度都在下载中心统一管理。SoulWeave 不代你安装，也不执行第三方程序。'));

  // 高级：默认自动探测，只有探测不到时才需要手动指路
  let loginStatus = null;
  try { loginStatus = await api.qqLoginStatus(); } catch (e) { loginStatus = null; }
  const advBtn = el('button', 'chip', '手动指定路径与令牌');
  advBtn.type = 'button';
  advBtn.addEventListener('click', () => {
    if (adpSec.querySelector('.qq-adv')) return;
    const box = el('div', 'cmp-p qq-adv');
    const mk = (label, key, ph) => {
      const row = el('div', 'row');
      row.appendChild(el('label', null, label));
      const i = document.createElement('input');
      i.className = 'ls-input';
      i.placeholder = ph || '';
      i.value = String((loginStatus && loginStatus[key]) || '');
      row.appendChild(i);
      return { row: row, input: i };
    };
    const a1 = mk('NapCat 安装目录', 'napCatRoot', 'NapCat 安装目录');
    const a2 = mk('QQ 程序路径', 'qqPath', 'QQ.exe 路径');
    const a3 = mk('WebUI 令牌', 'webuiToken', '从 WebUI 复制');
    box.appendChild(a1.row);
    box.appendChild(a2.row);
    box.appendChild(a3.row);
    const save = el('button', 'chip on', '保存');
    save.type = 'button';
    save.addEventListener('click', async () => {
      save.disabled = true;
      const r = await api.qqLoginConfig({ napCatRoot: a1.input.value.trim(), qqPath: a2.input.value.trim(), webuiToken: a3.input.value.trim() });
      save.disabled = false;
      if (!r || !r.ok) { alert('保存失败：' + ((r && r.error) || '未知')); return; }
      toast('已保存');
    });
    box.appendChild(save);
    adpSec.appendChild(box);
  });
  adpSec.appendChild(advBtn);
  host.appendChild(adpSec);

  // ── 状态快照（供端口 / 发送限制 / 自主连续 / 群与好友使用）──
  let snap = null;
  try { snap = await api.qqSnapshot(); } catch (e) { snap = null; }
  const data = snap && snap.ok ? snap.data : null;

  // ── 多实例端口 ────────────────────────────────────
  const ptSec = section('多实例端口', '每个 QQ 账号需要一套独立端口（HTTP + WS）。添加账号时会自动分配，不冲突。');
  const ptBox = el('div', 'cmp');
  const ptNote = el('div', 'cmp-w', '');
  ptBox.appendChild(ptNote);
  const ptList = el('div', 'cmp');
  ptBox.appendChild(ptList);
  const ptOut = el('div', 'cmp-w', '');
  const ptProbe = el('button', 'chip', '探测');
  ptProbe.type = 'button';
  ptProbe.addEventListener('click', async () => {
    ptProbe.disabled = true;
    ptOut.textContent = '探测中…';
    const r = await api.qqPortsPreview().catch((e) => ({ ok: false, error: String(e) }));
    ptProbe.disabled = false;
    if (!r || !r.ok) { ptOut.textContent = '失败：' + ((r && r.error) || '未知'); return; }
    const nx = (r.ports && r.ports[0]) || null;
    ptOut.textContent = nx ? ('下一个可用：HTTP ' + (nx.http || '?') + ' · WS ' + (nx.ws || '?')) : '';
    loadPorts();
  });
  ptBox.appendChild(ptProbe);
  ptBox.appendChild(ptOut);
  async function loadPorts() {
    const r = await api.qqPortsList().catch(() => null);
    ptList.textContent = '';
    const rows = (r && (r.ports || r.rows)) || [];
    if (!rows.length) { ptNote.textContent = '还没有分配端口（添加账号时自动分配）'; return; }
    ptNote.textContent = '';
    for (const x of rows) {
      const pp = x.ports || {};
      ptList.appendChild(el('div', 'cmp-w',
        String(x.label || x.account || '') + ' · HTTP ' + (pp.http || '?') + ' · WS ' + (pp.ws || '?')));
    }
  }
  loadPorts();
  ptSec.appendChild(ptBox);
  host.appendChild(ptSec);

  const wlSec = section('谁能触发', '不在白名单里的人，AI 一律不回复，也不计入任何额度。这是安全默认值，不是配置错误。');
  const wlHost = el('div');
  wlSec.appendChild(wlHost);
  ensureWhitelistStyles();
  await renderWhitelist(wlHost, () => render('social'));
  host.appendChild(wlSec);
  const liSec = section('发送限制', '冷却按会话计算；每日上限按账号计算，跨天自动清零。');
  const liBox = el('div', 'cmp');
  const limits = (data && data.limits) || {};
  const mkLimit = (label, key, dflt) => {
    const row = el('div', 'row');
    row.appendChild(el('label', null, label));
    const i = document.createElement('input');
    i.className = 'ls-input';
    i.type = 'number';
    i.min = '0';
    i.value = String(limits[key] ?? dflt);
    row.appendChild(i);
    return { row: row, input: i, key: key };
  };
  const L1 = mkLimit('会话冷却（秒）', 'cooldownSeconds', 60);
  const L2 = mkLimit('每日消息上限', 'dailyMaxMessages', 300);
  const L3 = mkLimit('每日轮次上限', 'dailyMaxRounds', 100);
  liBox.appendChild(L1.row);
  liBox.appendChild(L2.row);
  liBox.appendChild(L3.row);
  const lSave = el('button', 'chip', '保存');
  lSave.type = 'button';
  lSave.addEventListener('click', async () => {
    lSave.disabled = true;
    const r = await api.qqLimitsSet({ cooldownSeconds: Number(L1.input.value), dailyMaxMessages: Number(L2.input.value), dailyMaxRounds: Number(L3.input.value) });
    lSave.disabled = false;
    if (!r || !r.ok) { alert('保存失败：' + ((r && r.error) || '未知')); return; }
    toast('已保存');
  });
  liBox.appendChild(lSave);
  liSec.appendChild(liBox);
  host.appendChild(liSec);
  const vcSec = section('语音消息', 'QQ 语音的线上格式是 SILK（腾讯自有），没有纯 JS 的可靠实现，需要外部工具。');
  const vcBox = el('div', 'cmp');
  const vcState = el('div', 'cmp-w', '当前状态：未探测');
  vcBox.appendChild(vcState);
  let codec = null;
  try { codec = await api.qqCodecStatus(); } catch (e) { codec = null; }
  if (codec && codec.probed) vcState.textContent = '当前状态：' + ((codec.canDecode && codec.canEncode) ? '完成' : '未安装工具');
  const vcProbe = el('button', 'chip', '探测');
  vcProbe.type = 'button';
  const vcOut = el('div', 'cmp-w', '');
  vcProbe.addEventListener('click', async () => {
    vcProbe.disabled = true;
    vcOut.textContent = '探测中…';
    const r = await api.qqCodecProbe({}).catch((e) => ({ ok: false, error: String(e) }));
    vcProbe.disabled = false;
    if (!r || !r.ok) { vcOut.textContent = '探测失败：' + ((r && r.error) || '未知'); return; }
    vcState.textContent = '当前状态：' + ((r.canEncode && r.canDecode) ? '完成' : '部分可用');
    vcOut.textContent = r.hint || '';
  });
  vcBox.appendChild(vcProbe);
  vcBox.appendChild(vcOut);
  vcBox.appendChild(el('div', 'cmp-w', '没装工具时：QQ 语音收发不可用，但文字消息完全不受影响。装了之后在这里填路径点「探测」即可，不需要重启。'));
  const pathInputs = {};
  for (const [label, key] of [['ffmpeg 路径', 'ffmpegPath'], ['SILK 编码器', 'silkEncoderPath'], ['SILK 解码器', 'silkDecoderPath']]) {
    const row = el('div', 'row');
    row.appendChild(el('label', null, label));
    const i = document.createElement('input');
    i.className = 'ls-input';
    i.placeholder = key;
    i.value = String((codec && codec[key]) || '');
    row.appendChild(i);
    pathInputs[key] = i;
    vcBox.appendChild(row);
  }
  const pathSave = el('button', 'chip', '保存路径');
  pathSave.type = 'button';
  pathSave.addEventListener('click', async () => {
    pathSave.disabled = true;
    await api.qqCodecProbe({ ffmpegPath: pathInputs.ffmpegPath.value.trim(), silkEncoderPath: pathInputs.silkEncoderPath.value.trim(), silkDecoderPath: pathInputs.silkDecoderPath.value.trim() }).catch(() => null);
    pathSave.disabled = false;
    toast('已保存');
  });
  vcBox.appendChild(pathSave);
  vcSec.appendChild(vcBox);
  host.appendChild(vcSec);
  const auSec = section('自主连续消息', 'AI 主动连续说话。默认每轮 6 条，可配 1–30（D60）。发完一轮就停，不会自动开新轮。');
  const auBox = el('div', 'cmp');
  const auto = (data && data.autonomous) || {};
  const auRow = el('div', 'row');
  auRow.appendChild(el('label', null, '每轮条数（1–30）'));
  const auInp = document.createElement('input');
  auInp.className = 'ls-input';
  auInp.type = 'number';
  auInp.min = '1';
  auInp.max = '30';
  auInp.value = String(auto.perRound ?? 6);
  auRow.appendChild(auInp);
  const auSave = el('button', 'chip', '保存');
  auSave.type = 'button';
  auSave.addEventListener('click', async () => {
    auSave.disabled = true;
    const r = await api.qqAutoSet({ perRound: Number(auInp.value) });
    auSave.disabled = false;
    if (!r || !r.ok) { alert('保存失败：' + ((r && r.error) || '未知')); return; }
    toast('已保存');
  });
  auRow.appendChild(auSave);
  auBox.appendChild(auRow);
  const chRow = el('div', 'row');
  chRow.appendChild(el('label', null, '接力深度（0–3）'));
  const chInp = document.createElement('input');
  chInp.className = 'ls-input';
  chInp.type = 'number';
  chInp.min = '0';
  chInp.max = '3';
  chInp.value = String(auto.maxDepth ?? 1);
  chRow.appendChild(chInp);
  const chSave = el('button', 'chip', '保存');
  chSave.type = 'button';
  chSave.addEventListener('click', async () => {
    chSave.disabled = true;
    const r = await api.qqAutoSet({ maxDepth: Number(chInp.value) });
    chSave.disabled = false;
    if (!r || !r.ok) { alert('保存失败：' + ((r && r.error) || '未知')); return; }
    toast('已保存');
  });
  chRow.appendChild(chSave);
  auBox.appendChild(chRow);
  auBox.appendChild(el('div', 'cmp-w', '接力深度 = 一条消息最多引发几代 AI 发言。0 表示 AI 不会因为别的 AI 说话而开口。这是防止两个角色互相刷屏的关键。'));
  auSec.appendChild(auBox);
  host.appendChild(auSec);
  const gfSec = section('群与好友', '连接成功后可以拉取列表，方便把群号填进白名单。');
  const gfBox = el('div', 'cmp');
  for (const a of ((data && data.accounts) || [])) {
    const gs = (data.groups && data.groups[a.label]) || [];
    const fs2 = (data.friends && data.friends[a.label]) || [];
    const row = el('div', 'row');
    row.appendChild(el('div', 'cmp-nm', a.label + ' · 群 ' + gs.length + ' · 好友 ' + fs2.length));
    const gb = el('button', 'chip', '刷新群');
    gb.type = 'button';
    gb.addEventListener('click', async () => {
      gb.disabled = true;
      const r = await api.qqRefreshGroups({ label: a.label });
      gb.disabled = false;
      if (!r || !r.ok) { alert('需要先连接：' + ((r && r.error) || '未连接')); return; }
      toast('已刷新');
      render('social');
    });
    row.appendChild(gb);
    const fb = el('button', 'chip', '刷新好友');
    fb.type = 'button';
    fb.addEventListener('click', async () => {
      fb.disabled = true;
      const r = await api.qqRefreshFriends({ label: a.label });
      fb.disabled = false;
      if (!r || !r.ok) { alert('需要先连接：' + ((r && r.error) || '未连接')); return; }
      toast('已刷新');
      render('social');
    });
    row.appendChild(fb);
    gfBox.appendChild(row);
    if (gs.length) gfBox.appendChild(el('div', 'cmp-w', '群：' + gs.map((g) => g.groupName + '(' + g.groupId + ')').join('、')));
  }
  gfSec.appendChild(gfBox);
  host.appendChild(gfSec);

// ── 姐妹活动（S11）：确定性回合制 ──
async function renderSisterActivity(host) {
  const api = window.soulweave;
  const sec = section('姐妹活动', '实验功能，默认关闭。两个角色一起做点事：谁说话、说几轮都由程序定，模型不能自己决定，避免互相刷屏烧钱。');
  host.appendChild(sec);

  let data = null;
  try { data = await api.sisterState(); } catch (e) { data = null; }
  if (!data || !data.ok) {
    sec.appendChild(el('div', 'sec-hint', '读取失败：' + ((data && data.error) || '未知')));
    return;
  }
  const store = data.store || {};
  const policy = store.policy || {};
  const sum = data.summary || {};

  sec.appendChild(el('div', 'sec-hint',
    '今日 ' + (sum.today || 0) + ' / ' + (sum.limit || 0) + ' 场　'
    + '进行中 ' + (sum.running || 0) + '　已结束 ' + (sum.done || 0) + '　提前结束 ' + (sum.aborted || 0)
    + '　每场最多 ' + (policy.maxRounds || 0) + ' 轮'));

  const box = el('div', 'cmp');
  const toggle = el('button', policy.enabled ? 'chip on' : 'chip', policy.enabled ? '总开关：开' : '总开关：关');
  toggle.type = 'button';
  toggle.addEventListener('click', async () => {
    const r = await api.sisterSetPolicy({ enabled: !policy.enabled });
    if (!r || !r.ok) { alert('保存失败：' + ((r && r.error) || '未知')); return; }
    toast('已保存');
    render('social');
  });
  const toggRow = el('div', 'row');
  toggRow.appendChild(toggle);
  toggRow.appendChild(el('div', 'cmp-w', '关闭时不会产生任何活动'));
  box.appendChild(toggRow);

  const numRow = el('div', 'row');
  const mkNum = (label, key) => {
    const w = el('div', 'row');
    w.appendChild(el('label', null, label));
    const inp = document.createElement('input');
    inp.className = 'inp';
    inp.type = 'number';
    inp.value = String(policy[key] ?? '');
    inp.style.width = '80px';
    w.appendChild(inp);
    const b = el('button', 'chip', '保存');
    b.type = 'button';
    b.addEventListener('click', async () => {
      const r = await api.sisterSetPolicy({ [key]: Number(inp.value) });
      if (!r || !r.ok) { alert('保存失败：' + ((r && r.error) || '未知')); return; }
      toast('已保存');
      render('social');
    });
    w.appendChild(b);
    return w;
  };
  numRow.appendChild(mkNum('每场轮数', 'maxRounds'));
  numRow.appendChild(mkNum('每日场次', 'dailyLimit'));
  numRow.appendChild(mkNum('冷却（分钟）', 'cooldownMin'));
  box.appendChild(numRow);
  sec.appendChild(box);

  // 进行中的活动
  const running = (store.activities || []).find((a) => a.state === 'running');
  if (running) {
    const card = el('div', 'cmp-p');
    card.appendChild(el('div', 'cmp-nm', '进行中：' + running.topic));
    card.appendChild(el('div', 'cmp-w', '参与者：' + (running.participants || []).join(' 与 ')));
    for (const turn of running.turns || []) {
      card.appendChild(el('div', 'cmp-w', '#' + turn.round + ' ' + turn.speakerId.replace('char-', '') + '：' + turn.text));
    }
    const acts = el('div', 'row');
    const nextBtn = el('button', 'chip on', '让下一位说一句（会产生 API 费用）');
    nextBtn.type = 'button';
    nextBtn.addEventListener('click', async () => {
      nextBtn.disabled = true;
      nextBtn.textContent = '生成中…';
      try {
        const r = await api.sisterTurn(running.id);
        if (!r || !r.ok) { alert('失败：' + ((r && r.error) || '未知')); return; }
        if (r.finished) toast('这一场结束了');
        render('social');
      } finally {
        nextBtn.disabled = false;
        nextBtn.textContent = '让下一位说一句（会产生 API 费用）';
      }
    });
    acts.appendChild(nextBtn);
    const stopBtn = el('button', 'chip', '结束这场');
    stopBtn.type = 'button';
    stopBtn.addEventListener('click', async () => {
      const r = await api.sisterAbort(running.id, '人工结束');
      if (!r || !r.ok) { alert('失败：' + ((r && r.error) || '未知')); return; }
      toast('已结束');
      render('social');
    });
    acts.appendChild(stopBtn);
    card.appendChild(acts);
    sec.appendChild(card);
  } else {
    // 开场
    const startBox = el('div', 'cmp');
    const inp = document.createElement('input');
    inp.className = 'inp';
    inp.placeholder = '这场一起做什么？例如「一起整理书桌」「一起看窗外下雨」';
    inp.style.width = '100%';
    startBox.appendChild(inp);
    const b = el('button', 'chip on', '开始一场');
    b.type = 'button';
    b.addEventListener('click', async () => {
      if (!inp.value.trim()) { alert('先写一个主题'); return; }
      const r = await api.sisterStart({ topic: inp.value.trim() });
      if (!r || !r.ok) { alert('失败：' + ((r && r.error) || '未知')); return; }
      toast('开始了');
      render('social');
    });
    const row = el('div', 'row');
    row.appendChild(b);
    startBox.appendChild(row);
    sec.appendChild(startBox);
  }

  // 最近几场
  const history = (store.activities || []).slice(-3).reverse().filter((a) => a.state !== 'running');
  if (history.length) {
    const h = el('div', 'cmp');
    h.appendChild(el('div', 'cmp-nm', '最近的活动'));
    for (const a of history) {
      h.appendChild(el('div', 'cmp-w',
        '[' + (a.state === 'done' ? '正常结束' : '提前结束') + '] ' + a.topic
        + ' · ' + (a.turns || []).length + ' 轮' + (a.reason ? ' · ' + a.reason : '')));
    }
    sec.appendChild(h);
  }
}

// ── 姐妹私聊（S11）：角色之间互发 QQ 私聊 ──
async function renderSisterDm(host) {
  const api = window.soulweave;
  const sec = section('姐妹私聊', '实验功能，默认关闭。两个角色各用各的 QQ 号互相发私聊；带防回环：AI 发来的消息不会自动再回。');
  host.appendChild(sec);

  let data = null;
  try { data = await api.sisterDmState(); } catch (e) { data = null; }
  if (!data || !data.ok) {
    sec.appendChild(el('div', 'sec-hint', '读取失败：' + ((data && data.error) || '未知')));
    return;
  }
  const store = data.store || {};
  const policy = store.policy || {};
  const sum = data.summary || {};
  const acc = data.accounts || {};

  sec.appendChild(el('div', 'sec-hint',
    '本小时 ' + (sum.hour || 0) + ' / ' + (sum.hourLimit || 0) + ' 条　'
    + '今天 ' + (sum.day || 0) + ' / ' + (sum.dayLimit || 0) + ' 条　'
    + '链路深度上限 ' + (policy.maxChainDepth ?? 0) + ' 层'));

  const accText = Object.entries(acc).map(([id, a]) => {
    const nm = id === 'char-bingtang' ? '冰糖' : '小橘子';
    if (!a) return nm + '：未绑定 QQ';
    return nm + '：' + (a.online ? '在线' : '离线') + (a.selfId ? ' · ' + a.selfId : ' · 未登录');
  }).join('　');
  sec.appendChild(el('div', 'cmp-w', accText));

  const box = el('div', 'cmp');
  const toggle = el('button', policy.enabled ? 'chip on' : 'chip', policy.enabled ? '总开关：开' : '总开关：关');
  toggle.type = 'button';
  toggle.addEventListener('click', async () => {
    const r = await api.sisterDmSetPolicy({ enabled: !policy.enabled });
    if (!r || !r.ok) { alert('保存失败：' + ((r && r.error) || '未知')); return; }
    toast('已保存');
    render('social');
  });
  const row0 = el('div', 'row');
  row0.appendChild(toggle);
  row0.appendChild(el('div', 'cmp-w', '关闭时不会发任何私聊'));
  box.appendChild(row0);

  const numRow = el('div', 'row');
  const mkNum = (label, key) => {
    const w = el('div', 'row');
    w.appendChild(el('label', null, label));
    const inp = document.createElement('input');
    inp.className = 'inp';
    inp.type = 'number';
    inp.value = String(policy[key] ?? '');
    inp.style.width = '80px';
    w.appendChild(inp);
    const b = el('button', 'chip', '保存');
    b.type = 'button';
    b.addEventListener('click', async () => {
      const r = await api.sisterDmSetPolicy({ [key]: Number(inp.value) });
      if (!r || !r.ok) { alert('保存失败：' + ((r && r.error) || '未知')); return; }
      toast('已保存');
      render('social');
    });
    w.appendChild(b);
    return w;
  };
  numRow.appendChild(mkNum('每小时', 'maxPerHour'));
  numRow.appendChild(mkNum('每天', 'maxPerDay'));
  numRow.appendChild(mkNum('间隔(分)', 'minIntervalMin'));
  numRow.appendChild(mkNum('回环深度', 'maxChainDepth'));
  box.appendChild(numRow);
  sec.appendChild(box);

  // 发送
  const sendBox = el('div', 'cmp');
  const ta = document.createElement('input');
  ta.className = 'inp';
  ta.placeholder = '让冰糖给小橘子发一句……（关闭时会被拦下）';
  ta.style.width = '100%';
  sendBox.appendChild(ta);
  const row = el('div', 'row');
  const sel = document.createElement('select');
  sel.className = 'sel';
  for (const [v, label] of [['char-bingtang', '冰糖 → 小橘子'], ['char-xiaojuzi', '小橘子 → 冰糖']]) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    sel.appendChild(o);
  }
  row.appendChild(sel);
  const sendBtn = el('button', 'chip on', '发送（会真的发 QQ 私聊）');
  sendBtn.type = 'button';
  sendBtn.addEventListener('click', async () => {
    if (!ta.value.trim()) { alert('先写点内容'); return; }
    sendBtn.disabled = true;
    try {
      const r = await api.sisterDmSend({ fromCharacterId: sel.value, text: ta.value.trim(), depth: 0 });
      if (!r || !r.ok) { alert('未发送：' + ((r && r.error) || '未知')); return; }
      toast('已发送');
      render('social');
    } finally { sendBtn.disabled = false; }
  });
  row.appendChild(sendBtn);
  sendBox.appendChild(row);
  sec.appendChild(sendBox);

  const log = (store.log || []).slice(0, 5);
  if (log.length) {
    const h = el('div', 'cmp');
    h.appendChild(el('div', 'cmp-nm', '最近发送'));
    for (const e of log) {
      h.appendChild(el('div', 'cmp-w', new Date(e.at).toLocaleString() + '　' + (e.from === 'char-bingtang' ? '冰糖' : '小橘子') + '：' + e.text));
    }
    sec.appendChild(h);
  }
}

  // S11：姐妹活动 + QQ 空间（都是实验功能，默认关闭）
  try { await renderSisterDm(host); } catch (e) { host.appendChild(el('div', 'sec-hint', '姐妹私聊加载失败：' + String(e).slice(0, 120))); }
  try { await renderSisterActivity(host); } catch (e) { host.appendChild(el('div', 'sec-hint', '姐妹活动加载失败：' + String(e).slice(0, 120))); }
  try { await renderQzone(host); } catch (e) { host.appendChild(el('div', 'sec-hint', 'QQ 空间分区加载失败：' + String(e).slice(0, 120))); }
}

// ── QQ 空间（S11）：草稿 → 审批 → 发布 ──
async function renderQzone(host) {
  const api = window.soulweave;
  const sec = section('QQ 空间', '实验功能：默认关闭，且默认每条都要你确认。发布走 NapCat 的空间接口，失败会退回草稿箱，不会丢内容。');
  host.appendChild(sec);

  let data = null;
  try { data = await api.qzoneState(); } catch (e) { data = null; }
  if (!data || !data.ok) {
    sec.appendChild(el('div', 'sec-hint', '读取失败：' + ((data && data.error) || '未知')));
    return;
  }
  const store = data.store || {};
  const policy = store.policy || {};
  const sum = data.summary || {};

  // 总状态
  sec.appendChild(el('div', 'sec-hint',
    '今日已发 ' + (sum.usage ? sum.usage.today : 0) + ' / ' + (sum.usage ? sum.usage.limit : 0) + ' 条'
    + '　草稿 ' + (sum.draft || 0) + '　待审 ' + (sum.pending || 0) + '　已发 ' + (sum.published || 0)
    + '　默认公开范围：' + (sum.rightLabel || '—')));

  // 策略表单
  const box = el('div', 'cmp');
  const mkToggle = (label, key, hint) => {
    const row = el('div', 'row');
    const b = el('button', policy[key] ? 'chip on' : 'chip', label + (policy[key] ? '：开' : '：关'));
    b.type = 'button';
    b.addEventListener('click', async () => {
      const r = await api.qzoneSetPolicy({ [key]: !policy[key] });
      if (!r || !r.ok) { alert('保存失败：' + ((r && r.error) || '未知')); return; }
      toast('已保存');
      render('social');
    });
    row.appendChild(b);
    if (hint) row.appendChild(el('div', 'cmp-w', hint));
    box.appendChild(row);
  };
  mkToggle('总开关', 'enabled', '关闭后任何提交都会被拦下');
  mkToggle('每次发布需确认', 'requireConfirm', '开启时，提交后必须你在下面点「批准」才会真的发出去');

  const numRow = el('div', 'row');
  const mkNum = (label, key, min, max) => {
    const w = el('div', 'row');
    w.appendChild(el('label', null, label));
    const inp = document.createElement('input');
    inp.className = 'inp';
    inp.type = 'number';
    inp.value = String(policy[key] ?? '');
    inp.style.width = '90px';
    w.appendChild(inp);
    const b = el('button', 'chip', '保存');
    b.type = 'button';
    b.addEventListener('click', async () => {
      const v = Number(inp.value);
      const r = await api.qzoneSetPolicy({ [key]: v });
      if (!r || !r.ok) { alert('保存失败：' + ((r && r.error) || '未知')); return; }
      toast('已保存');
      render('social');
    });
    w.appendChild(b);
    return w;
  };
  numRow.appendChild(mkNum('每日上限', 'dailyLimit', 0, 20));
  numRow.appendChild(mkNum('最小间隔（分钟）', 'minIntervalMin', 0, 1440));
  box.appendChild(numRow);

  // 公开范围
  const rightRow = el('div', 'row');
  rightRow.appendChild(el('label', null, '公开范围'));
  const sel = document.createElement('select');
  sel.className = 'sel';
  const rights = [[1, '所有人可见'], [4, '好友可见'], [16, '部分好友可见'], [64, '仅自己可见'], [128, '部分好友不可见']];
  for (const [v, label] of rights) {
    const o = document.createElement('option');
    o.value = String(v);
    o.textContent = label;
    if (Number(policy.defaultRight) === v) o.selected = true;
    sel.appendChild(o);
  }
  rightRow.appendChild(sel);
  const saveRight = el('button', 'chip', '保存');
  saveRight.type = 'button';
  saveRight.addEventListener('click', async () => {
    const r = await api.qzoneSetPolicy({ defaultRight: Number(sel.value) });
    if (!r || !r.ok) { alert('保存失败：' + ((r && r.error) || '未知')); return; }
    toast('已保存');
    render('social');
  });
  rightRow.appendChild(saveRight);
  box.appendChild(rightRow);
  box.appendChild(el('div', 'cmp-w', '时段：' + ((policy.windows || []).map((w) => w.start + '–' + w.end).join('、') || '不限')
    + '　允许类型：' + ((policy.allowedKinds || []).join(' / ') || '—')));
  sec.appendChild(box);

  // 新建草稿
  const draftBox = el('div', 'cmp');
  const ta = document.createElement('textarea');
  ta.className = 'inp';
  ta.placeholder = '写点今天发生的事……（默认进草稿箱，不会直接发出去）';
  ta.style.width = '100%';
  ta.style.minHeight = '70px';
  // 文本域没走 .inp 的样式，手工对齐深色主题，否则是一块白底
  ta.style.background = 'var(--panel-2, #1f1f2a)';
  ta.style.color = 'var(--fg, #EDEAF6)';
  ta.style.border = '1px solid var(--line, rgba(255,255,255,.08))';
  ta.style.borderRadius = '10px';
  ta.style.padding = '10px 12px';
  ta.style.font = 'inherit';
  ta.style.resize = 'vertical';
  draftBox.appendChild(ta);
  const btnRow = el('div', 'row');
  const kindSel = document.createElement('select');
  kindSel.className = 'sel';
  for (const [v, label] of [['life', '生活动态'], ['art', '绘画'], ['fiction', '虚构照片']]) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    kindSel.appendChild(o);
  }
  btnRow.appendChild(kindSel);
  const addBtn = el('button', 'chip on', '存为草稿');
  addBtn.type = 'button';
  addBtn.addEventListener('click', async () => {
    if (!ta.value.trim()) { alert('先写点内容'); return; }
    if (!ta.value.trim() && !picked.length) { alert('写点内容或选张图片'); return; }
    const r = await api.qzoneCreateDraft({ kind: kindSel.value, content: ta.value.trim(), images: picked.slice() });
    if (!r || !r.ok) { alert('失败：' + ((r && r.error) || '未知')); return; }
    toast('已存入草稿箱');
    render('social');
  });
  btnRow.appendChild(addBtn);
  draftBox.appendChild(btnRow);

  // 配图（QQ 空间单条最多 9 张，入草稿时就校验格式与存在性）
  const picked = [];
  const imgRow = el('div', 'row');
  const pickBtn = el('button', 'chip', '添加图片');
  pickBtn.type = 'button';
  const imgInfo = el('div', 'cmp-w', '未选择图片');
  pickBtn.addEventListener('click', async () => {
    const r = await api.qzonePickImages();
    if (!r || !r.ok) { alert('图片不可用：' + ((r && r.errors && r.errors.join('；')) || (r && r.error) || '未知')); return; }
    picked.length = 0;
    for (const p of (r.images || [])) picked.push(p);
    imgInfo.textContent = picked.length ? ('已选 ' + picked.length + ' 张：' + picked.map((x) => x.split(/[\\/]/).pop()).join('、')) : '未选择图片';
  });
  imgRow.appendChild(pickBtn);
  imgRow.appendChild(imgInfo);
  draftBox.appendChild(imgRow);
  sec.appendChild(draftBox);

  // 草稿列表
  const list = el('div', 'cmp');
  const drafts = (store.drafts || []).slice().reverse();
  if (!drafts.length) list.appendChild(el('div', 'sec-hint', '草稿箱是空的。'));
  const stateLabel = { draft: '草稿', pending: '待审', published: '已发', rejected: '已驳回', failed: '失败' };
  for (const d of drafts) {
    const card = el('div', 'cmp-p');
    const head = el('div', 'row');
    head.appendChild(el('div', 'cmp-nm', stateLabel[d.state] || d.state));
    head.appendChild(el('div', 'cmp-w', (d.kind === 'life' ? '生活' : d.kind === 'art' ? '绘画' : '虚构') + ' · ' + new Date(d.createdAt).toLocaleString()));
    card.appendChild(head);
    card.appendChild(el('div', 'cmp-w', String(d.content || '').slice(0, 200)));
    if ((d.images || []).length) {
      card.appendChild(el('div', 'cmp-w', '配图 ' + d.images.length + ' 张：' + d.images.map((x) => String(x).split(/[\\/]/).pop()).join('、')));
    }
    if (d.reason) card.appendChild(el('div', 'cmp-w', '原因：' + d.reason));
    if (d.tid) card.appendChild(el('div', 'cmp-w', 'tid：' + d.tid));

    const acts = el('div', 'row');
    const call = async (fn, okText) => {
      const r = await fn();
      if (!r || !r.ok) { alert('失败：' + ((r && r.error) || '未知') + (r && r.degraded ? '（内容已保留在草稿箱）' : '')); return; }
      toast(okText);
      render('social');
    };
    if (d.state === 'draft' || d.state === 'failed' || d.state === 'rejected') {
      const b = el('button', 'chip on', d.state === 'draft' ? '提交' : '重新提交');
      b.type = 'button';
      b.addEventListener('click', () => call(() => api.qzoneSubmit(d.id), '已提交'));
      acts.appendChild(b);
    }
    if (d.state === 'pending') {
      const a = el('button', 'chip on', '批准并发布');
      a.type = 'button';
      a.addEventListener('click', () => call(() => api.qzoneApprove(d.id), '已发布'));
      acts.appendChild(a);
      const rj = el('button', 'chip', '驳回');
      rj.type = 'button';
      rj.addEventListener('click', () => call(() => api.qzoneReject(d.id, '人工驳回'), '已驳回'));
      acts.appendChild(rj);
    }
    if (d.state === 'failed' || d.state === 'rejected') {
      const rq = el('button', 'chip', '退回草稿');
      rq.type = 'button';
      rq.addEventListener('click', () => call(() => api.qzoneRequeue(d.id), '已退回'));
      acts.appendChild(rq);
    }
    if (d.state === 'published') {
      acts.appendChild(el('div', 'cmp-w', '已发布，tid 如上'));
    }
    // 人工发布降级：复制正文 / 打开空间（PRD：接口不可用时退化为草稿、复制或人工发布）
    const copyBtn = el('button', 'chip', '复制正文');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', async () => {
      const r = await api.copyText(String(d.content || ''));
      if (!r || !r.ok) { alert('复制失败：' + ((r && r.error) || '未知')); return; }
      toast('已复制，可去空间手动发布');
    });
    acts.appendChild(copyBtn);
    if (d.state !== 'published') {
      const openQz = el('button', 'chip', '打开我的空间');
      openQz.type = 'button';
      openQz.addEventListener('click', () => api.openExternal('https://user.qzone.qq.com/').catch(() => null));
      acts.appendChild(openQz);
    }
    if (d.state === 'draft' || d.state === 'failed' || d.state === 'rejected') {
      const editBtn = el('button', 'chip', '编辑');
      editBtn.type = 'button';
      editBtn.addEventListener('click', async () => {
        const next = prompt('修改正文', String(d.content || ''));
        if (next === null) return;
        const r = await api.qzoneUpdateDraft({ id: d.id, content: next });
        if (!r || !r.ok) { alert('修改失败：' + ((r && r.error) || '未知')); return; }
        toast('已修改');
        render('social');
      });
      acts.appendChild(editBtn);
    }
    card.appendChild(acts);
    list.appendChild(card);
  }
  sec.appendChild(list);

  sec.appendChild(el('div', 'sec-hint',
    '说明：QQ 原生语音电话没有可用的程序接口（已核查 NapCat 全部 action），'
    + '需要实时语音请用「扩展」里的网页语音。空间内容默认只在「所有人可见」以外的范围需要额外填 QQ 号。'));
}

// ── 音色社区（S10）：导航 + 许可/兼容检查 + 一键应用 ──
async function renderVoiceCommunity(host) {
  const api = window.soulweave;
  const sec = section('音色社区', '只做导航与检查，应用不代你下载任何音色文件。每一条都要先过许可与兼容才能应用。');
  host.appendChild(sec);

  let data = null;
  try { data = await api.communityVoiceList(); } catch (e) { data = null; }
  if (!data || !data.ok) {
    sec.appendChild(el('div', 'sec-hint', '读取音色社区失败：' + ((data && data.error) || '未知')));
    return;
  }
  const state = data.state || {};
  sec.appendChild(el('div', 'sec-hint',
    '本机已就绪引擎：' + (state.readyEngines || []).join(' / ') + '。' +
    '未就绪的引擎对应资源会标为不可用，并说明缺什么。'));

  // 可选角色（与「角色音色绑定」一致：0/1/2）
  const models = [0, 1, 2];
  const cfg = data.current || { perModel: {} };

  const badge = (v) => (v === 'ok' ? '可用' : v === 'warn' ? '需注意' : '不可用');
  const badgeCls = (v) => (v === 'ok' ? 'chip on' : 'chip');

  for (const it of data.items || []) {
    const r = it.resource;
    const card = el('div', 'cmp-p');

    // 标题行：名称 + 类型 + 结论
    const head = el('div', 'row');
    head.appendChild(el('div', 'cmp-nm', r.name));
    head.appendChild(el('div', 'cmp-w', ({ engine: '引擎', model: '模型', voice: '音色', 'character-ip': '角色 IP', dataset: '数据集', site: '站点' })[r.kind] || r.kind));
    const b = el('span', badgeCls(it.final), badge(it.final));
    head.appendChild(b);
    card.appendChild(head);

    card.appendChild(el('div', 'cmp-w', r.summary));

    // 许可
    const lic = it.license;
    card.appendChild(el('div', 'cmp-w',
      '许可：' + r.license +
      '　可再分发：' + (lic.redistribute.allowed ? '是' : '否') +
      '　可商用：' + (lic.commercial.allowed ? '是' : '否')));

    // 占用
    if (r.sizeMB || r.ramMB) {
      card.appendChild(el('div', 'cmp-w', '预计占用：磁盘 ' + (r.sizeMB || 0) + ' MB · 内存 ' + (r.ramMB || 0) + ' MB'));
    }

    // 理由
    for (const reason of (it.reasons || []).slice(0, 4)) {
      card.appendChild(el('div', 'cmp-w', '· ' + reason));
    }
    if (r.note) card.appendChild(el('div', 'cmp-w', '注意：' + r.note));

    // 操作行
    const acts = el('div', 'row');
    if (r.upstream) {
      const open = el('button', 'chip', '打开获取页');
      open.type = 'button';
      open.addEventListener('click', () => api.openExternal(r.upstream).catch(() => null));
      acts.appendChild(open);
    }

    // 只有「已安装且许可允许」的音色才能一键应用
    const canApply = it.final !== 'blocked' && r.kind === 'voice' && (r.engines || []).length > 0;
    if (canApply) {
      const provider = r.engines[0];
      const installed = (state.installedVoices || {})[provider] || [];
      if (!installed.length) {
        acts.appendChild(el('div', 'cmp-w', '该引擎下还没装音色，装完再来应用'));
      } else {
        const selVoice = document.createElement('select');
        selVoice.className = 'sel';
        for (const v of installed) {
          const o = document.createElement('option');
          o.value = v; o.textContent = v;
          selVoice.appendChild(o);
        }
        acts.appendChild(selVoice);

        const selModel = document.createElement('select');
        selModel.className = 'sel';
        for (const idx of models) {
          const o = document.createElement('option');
          o.value = String(idx);
          const cur = cfg.perModel ? cfg.perModel[String(idx)] : null;
          o.textContent = '角色 ' + (idx + 1) + (cur ? ('（当前 ' + cur.voiceId + '）') : '（未绑）');
          selModel.appendChild(o);
        }
        acts.appendChild(selModel);

        const apply = el('button', 'chip on', '一键应用（含试音）');
        apply.type = 'button';
        apply.addEventListener('click', async () => {
          apply.disabled = true;
          apply.textContent = '应用中…';
          try {
            const res = await api.communityVoiceApply({
              characterId: selModel.value,
              provider,
              voiceId: selVoice.value,
              sourceId: r.id,
              probe: true,
            });
            if (!res || !res.ok) {
              // 回滚信息很关键：告诉用户原来的配置有没有被破坏
              const extra = res && res.rolledBack ? '（已回滚到原音色）' : '';
              alert('应用失败：' + ((res && res.error) || '未知') + extra);
              return;
            }
            toast('已应用到角色 ' + (Number(selModel.value) + 1) + (res.probed ? '（试音通过）' : ''));
            render('voice');
          } finally {
            apply.disabled = false;
            apply.textContent = '一键应用（含试音）';
          }
        });
        acts.appendChild(apply);
      }
    } else if (it.final === 'blocked') {
      acts.appendChild(el('div', 'cmp-w', '不可用：' + ((it.reasons || [])[0] || '见上方原因')));
    }
    card.appendChild(acts);
    sec.appendChild(card);
  }

  const foot = el('div', 'sec-hint',
    '说明：社区里的音色授权链条通常是「配音演员 → 角色 IP → 数据集 → 模型权重」，' +
    '应用无法替你核实，所以只标注、不代下；「可下载」不等于「可合法再分发或商用」。');
  sec.appendChild(foot);
}

// ── 权限：工具审批中心（S9）──────────────────────────

// ── 形象：Live2D 管理（与角色解耦，形象可独立命名）──
async function renderLive2D(host) {
  const api = window.soulweave;
  let models = [];
  try { const r = await api.live2dList(); models = (r && r.models) || []; } catch (e) { models = []; }
  // 绑定下拉需要角色列表；顺便存成缓存供页面内多次使用
  try {
    const rr = await api.rosterList();
    window.__rosterCache = (rr && (rr.characters || rr.list)) || [];
  } catch (e) { window.__rosterCache = []; }

  const listSec = section('形象库', '一个形象可以给多个角色用；形象名独立于角色名，随便叫什么都行。');
  if (!models.length) {
    listSec.appendChild(emptyCta('还没有形象', '导入一个 Live2D 模型目录（里面有 .model3.json），再给它起个名字。',
      '导入形象', () => doImport()));
  } else {
    for (const m of models) {
      const card = el('div', 'cmp');
      const head = el('div', 'cmp-h');
      head.appendChild(el('span', 'cmp-n', m.name));
      head.appendChild(el('span', 'badge ' + (m.visible ? 'ok' : 'warn'), m.visible ? '显示中' : '已隐藏'));
      if (m.usedBy && m.usedBy.length) head.appendChild(el('span', 'badge', '用于 ' + m.usedBy.join('、')));
      card.appendChild(head);
      card.appendChild(el('div', 'cmp-w', m.source === 'builtin' ? '内置形象' : '导入形象'));
      if (m.path) card.appendChild(el('div', 'cmp-p', m.path));
      const acts = el('div', 'cmp-a');
      const b1 = el('button', 'chip', '重命名'); b1.type = 'button';
      b1.addEventListener('click', () => {
        const name = prompt('给这个形象起个名字', m.name);
        if (name === null) return;
        api.live2dUpdate({ id: m.id, name }).then((r) => {
          if (!r || !r.ok) { alert('改名失败：' + ((r && r.error) || '未知')); return; }
          toast('已改名'); render('live2d');
        });
      });
      const b2 = el('button', 'chip' + (m.visible ? ' on' : ''), m.visible ? '隐藏' : '显示'); b2.type = 'button';
      b2.addEventListener('click', async () => {
        const r = await api.live2dUpdate({ id: m.id, visible: !m.visible });
        if (!r || !r.ok) { alert('操作失败：' + ((r && r.error) || '未知')); return; }
        toast(!m.visible ? '已显示' : '已隐藏'); render('live2d');
      });
      const b3 = el('button', 'chip', '删除'); b3.type = 'button';
      b3.addEventListener('click', async () => {
        if (!confirm('删除形象「' + m.name + '」？已绑定它的角色会回到「不显示形象」。')) return;
        const r = await api.live2dRemove({ id: m.id });
        if (!r || !r.ok) { alert('删除失败：' + ((r && r.error) || '未知')); return; }
        toast('已删除'); render('live2d');
      });
      acts.appendChild(b1); acts.appendChild(b2); acts.appendChild(b3);
      card.appendChild(acts);
      listSec.appendChild(card);
    }
  }
  host.appendChild(listSec);

  // ── 内置形象 ──
  //
  // 【为什么要这一段】
  // 形象库默认是空的，所以用户第一次进来只看到一个"导入形象"按钮，
  // 以为这个模块只有导入功能。随应用附带的三个内置模型本来就存在，
  // 直接列出来，用户点一下就能进库、改名、设显隐。
  const BUILTINS = [
    { key: 'Hiyori', name: '日和', hint: '自带，浅色，动作最全' },
    { key: 'Haru',   name: '春',   hint: '自带，暖色' },
    { key: 'Mark',   name: '马克', hint: '自带，配色最简单' },
  ];
  const bSec = section('内置形象', '随应用自带，不用下载。加入形象库后可以改名、设显隐，也可以绑定给角色。');
  for (const b of BUILTINS) {
    const inLib = models.find((m) => m.source === 'builtin' && String(m.path).includes(b.key));
    const card = el('div', 'cmp');
    const head = el('div', 'cmp-h');
    head.appendChild(el('span', 'cmp-n', b.name));
    head.appendChild(el('span', 'badge', b.hint));
    if (inLib) head.appendChild(el('span', 'badge ' + (inLib.visible ? 'ok' : 'warn'), inLib.visible ? '显示中' : '已隐藏'));
    card.appendChild(head);
    const acts = el('div', 'cmp-a');
    if (inLib) {
      const rn = el('button', 'chip', '重命名'); rn.type = 'button';
      rn.addEventListener('click', () => {
        const name = prompt('给这个形象起个名字', inLib.name);
        if (name === null) return;
        api.live2dUpdate({ id: inLib.id, name }).then((r) => {
          if (!r || !r.ok) { alert('改名失败：' + ((r && r.error) || '未知')); return; }
          toast('已改名'); render('live2d');
        });
      });
      const tg = el('button', 'chip' + (inLib.visible ? ' on' : ''), inLib.visible ? '隐藏' : '显示'); tg.type = 'button';
      tg.addEventListener('click', async () => {
        const r = await api.live2dUpdate({ id: inLib.id, visible: !inLib.visible });
        if (!r || !r.ok) { alert('操作失败：' + ((r && r.error) || '未知')); return; }
        toast(!inLib.visible ? '已显示' : '已隐藏'); render('live2d');
      });
      const del = el('button', 'chip', '移出库'); del.type = 'button';
      del.addEventListener('click', async () => {
        if (!confirm('把「' + inLib.name + '」移出形象库？绑定它的角色会回到不显示形象。')) return;
        const r = await api.live2dRemove({ id: inLib.id });
        if (!r || !r.ok) { alert('操作失败：' + ((r && r.error) || '未知')); return; }
        toast('已移出'); render('live2d');
      });
      acts.appendChild(rn); acts.appendChild(tg); acts.appendChild(del);
    } else {
      const add = el('button', 'chip', '加入形象库'); add.type = 'button';
      add.addEventListener('click', async () => {
        const r = await api.live2dCreate({ name: b.name, path: 'builtin:' + b.key });
        if (!r || !r.ok) { alert('加入失败：' + ((r && r.error) || '未知')); return; }
        toast('已加入「' + b.name + '」'); render('live2d');
      });
      acts.appendChild(add);
    }
    card.appendChild(acts);
    bSec.appendChild(card);
  }
  host.appendChild(bSec);

  const importSec = section('导入新形象', '选模型目录；里面的 .model3.json 会被自动识别。导入后到「角色档案」里决定哪个角色用它。');
  importSec.appendChild(emptyCta('从本机导入', '支持 Live2D Cubism 3/4 的模型目录。',
    '选择模型目录', () => doImport()));
  host.appendChild(importSec);

  async function doImport() {
    const pick = await api.live2dPickFolder().catch(() => null);
    if (!pick || !pick.ok) { if (pick && !pick.canceled) alert('选择失败：' + ((pick && pick.error) || '未知')); return; }
    const name = prompt('给这个形象起个名字（独立于角色名）', '新形象');
    if (name === null) return;
    const r = await api.live2dCreate({ name, path: pick.model3 || pick.dir });
    if (!r || !r.ok) { alert('导入失败：' + ((r && r.error) || '未知')); return; }
    toast('已导入「' + name + '」');
    render('live2d');
  }
}

// ── 主题：多套主题 + 跟随系统 ──
const THEMES = [
  { id: 'auto',    name: '跟随系统', hint: '随 Windows 深浅色自动切换', swatch: ['#101016', '#EDEAF6'] },
  { id: 'midnight', name: '深夜',   hint: '默认深色，低亮舒适', swatch: ['#0E0E14', '#7FB0FF'] },
  { id: 'graphite', name: '石墨',   hint: '更中性的灰黑，长时间看不累', swatch: ['#15151A', '#9AA3B2'] },
  { id: 'dawn',     name: '晨光',   hint: '浅色，白天办公更清爽', swatch: ['#F4F4F8', '#2F63D0'] },
  { id: 'sakura',   name: '樱',     hint: '浅色偏粉，柔和一点', swatch: ['#FBF4F6', '#C2547E'] },
];

async function renderTheme(host) {
  const api = window.soulweave;
  const cur = (ThemeApi.getTheme() || {}).mode || 'auto';
  const sec = section('界面主题', '选一套顺眼的配色。所有主题都通过对比度检查，换主题不会影响功能。');
  const grid = el('div', 'theme-grid');
  for (const t of THEMES) {
    const card = el('div', 'theme-card' + (cur === t.id ? ' on' : ''));
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    const sw = el('div', 'theme-swatch');
    sw.style.background = 'linear-gradient(135deg, ' + t.swatch[0] + ' 0 55%, ' + t.swatch[1] + ' 55% 100%)';
    card.appendChild(sw);
    card.appendChild(el('div', 'theme-nm', t.name));
    card.appendChild(el('div', 'theme-hint', t.hint));
    const pick = () => { ThemeApi.setTheme(t.id); toast('已切换到「' + t.name + '」'); render('theme'); };
    card.addEventListener('click', pick);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    grid.appendChild(card);
  }
  sec.appendChild(grid);
  host.appendChild(sec);

  const info = section('当前生效', '');
  info.appendChild(el('div', 'cmp-w', '当前：' + ((THEMES.find((x) => x.id === cur) || THEMES[0]).name)
    + '　·　系统深浅色：' + (((ThemeApi.getTheme() || {}).systemDark) ? '深色' : '浅色')));
  host.appendChild(info);
}

async function renderPermission(host) {
  const api = window.soulweave;
  let data = null;
  try { data = await api.toolGrants(); } catch (e) { data = null; }
  if (!data || !data.ok) {
    host.appendChild(section('工具审批'));
    host.appendChild(el('div', 'cmp-w', '读取授权状态失败：' + ((data && data.error) || '未知')));
    return;
  }
  const lvName = (n) => ({ 0: 'L0 只读', 1: 'L1 网络', 2: 'L2 写文件', 4: 'L4 执行命令', 5: 'L5 高风险' }[n] || ('L' + n));

  // ── 1. 概览 ──
  let stats = { total: 0, allowed: 0, denied: 0 };
  try { const s = await api.auditStats(); if (s && s.ok) stats = s.stats; } catch (e) { /* ignore */ }
  const ovSec = section('工具治理', '角色想用本机工具时，必须在这里授权。没授权的一律拦下，并中止那一轮。');
  // 把一个长句拆成三个可扫读的数字，比"调用 362 次 · 放行 58 · 拦截 48"更快看懂
  ovSec.appendChild(statStrip([
    { k: '近 24 小时调用', v: stats.total, u: '次' },
    { k: '放行', v: stats.allowed, u: '次' },
    { k: '拦截', v: stats.denied, u: '次', tone: stats.denied > 0 ? 'warn' : '' },
  ]));
  const pol = el('div', 'policy');
  for (const row of [
    { lv: 'L0 只读', rule: '读文件、查状态 —— 默认放行', cls: 'allow' },
    { lv: 'L1 网络', rule: '访问网络 —— 默认放行', cls: 'allow' },
    { lv: 'L2 写文件', rule: '改文件、写目录 —— 需要授权', cls: 'ask' },
    { lv: 'L4 执行命令', rule: '跑外部命令 —— 需要授权', cls: 'ask' },
    { lv: 'L5 高风险', rule: '路径越出工作区、未知工具 —— 只允许「批准一次」', cls: 'high' },
  ]) {
    const r = el('div', 'policy-row ' + row.cls);
    r.appendChild(el('div', 'lv', row.lv));
    r.appendChild(el('div', 'rule', row.rule));
    pol.appendChild(r);
  }
  ovSec.appendChild(pol);
  host.appendChild(ovSec);

  // ── 2. 待处理 ──
  const pdSec = section('待处理请求', '这些是被拦下来的调用。10 分钟不处理自动作废，按拒绝记账。');
  const pdBox = el('div', 'cmp');
  const pending = data.pending || [];
  if (!pending.length) {
    pdBox.appendChild(emptyCta('没有待处理的请求', '被拦下的调用会出现在这里，10 分钟内不处理就自动作废。', '刷新', () => render('permission')));
  } else {
    for (const p of pending) {
      const card = el('div', 'cmp-p');
      const head = el('div', 'row');
      head.appendChild(el('div', 'cmp-nm', p.actor + ' 想用 ' + p.tool));
      head.appendChild(el('div', 'cmp-w', lvName(p.level)));
      card.appendChild(head);
      if (p.target) card.appendChild(el('div', 'cmp-w', '对象：' + p.target));
      card.appendChild(el('div', 'cmp-w', '原因：' + p.reason));
      if (p.inputSummary) card.appendChild(el('div', 'cmp-w', '参数：' + p.inputSummary));
      const left = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
      card.appendChild(el('div', 'cmp-w', '剩余 ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0')));

      const acts = el('div', 'row');
      const once = el('button', 'chip on', '批准一次');
      once.type = 'button';
      once.addEventListener('click', async () => {
        const r = await api.toolApprove(p.id, 'once');
        if (!r || !r.ok) { alert('批准失败：' + ((r && r.error) || '未知')); return; }
        toast('已批准一次');
        render('permission');
      });
      acts.appendChild(once);
      if (p.level !== 5) {
        const scope = el('button', 'chip', '批准到该等级');
        scope.type = 'button';
        scope.title = '之后同类操作不再询问，直到撤销';
        scope.addEventListener('click', async () => {
          const r = await api.toolApprove(p.id, 'scope');
          if (!r || !r.ok) { alert('批准失败：' + ((r && r.error) || '未知')); return; }
          toast('已授权该等级');
          render('permission');
        });
        acts.appendChild(scope);
      }
      const no = el('button', 'chip', '拒绝');
      no.type = 'button';
      no.addEventListener('click', async () => {
        await api.toolDeny(p.id).catch(() => null);
        toast('已拒绝');
        render('permission');
      });
      acts.appendChild(no);
      card.appendChild(acts);
      pdBox.appendChild(card);
    }
  }
  pdSec.appendChild(pdBox);
  host.appendChild(pdSec);

  // ── 3. 有效授权 ──
  const grSec = section('有效授权', '撤销后立即失效，正在跑的那一轮不会被追回。');
  const grBox = el('div', 'cmp');
  const grants = data.grants || [];
  if (!grants.length) {
    grBox.appendChild(emptyCta('还没有任何授权', '在「角色」里给角色接入智能体后，它申请的工具权限会出现在这里。', '前往「角色」', () => select('character')));
  } else {
    for (const g of grants) {
      const row = el('div', 'row');
      const kindText = g.kind === 'once' ? '一次性' : g.kind === 'ttl' ? '限时' : '长期';
      row.appendChild(el('div', 'cmp-nm', kindText + (g.tool ? ' · ' + g.tool : '') + (g.level !== undefined ? ' · ' + lvName(g.level) : '')));
      if (g.pathPrefix) row.appendChild(el('div', 'cmp-w', '范围：' + g.pathPrefix));
      if (g.expiresAt) {
        const left = Math.max(0, Math.round((g.expiresAt - Date.now()) / 1000));
        row.appendChild(el('div', 'cmp-w', left > 0 ? ('剩 ' + Math.ceil(left / 60) + ' 分钟') : '已过期'));
      }
      const rev = el('button', 'chip', '撤销');
      rev.type = 'button';
      rev.addEventListener('click', async () => {
        const r = await api.toolGrantRevoke(g.id);
        if (!r || !r.ok) { alert('撤销失败'); return; }
        toast('已撤销');
        render('permission');
      });
      row.appendChild(rev);
      grBox.appendChild(row);
    }
  }
  grSec.appendChild(grBox);
  host.appendChild(grSec);

  // ── 4. 审计 ──
  const auSec = section('最近审计', '只记录工具名、等级、对象与结果；命令内容已脱敏并截断。');
  const auBox = el('div', 'cmp');
  let rows = [];
  try { const r = await api.auditList({ limit: 50 }); rows = (r && r.ok ? r.rows : []) || []; } catch (e) { rows = []; }
  if (!rows.length) {
    auBox.appendChild(el('div', 'cmp-w', '还没有记录。'));
  } else {
    const kindName = {
      'tool.allow': '放行', 'tool.deny': '拦截', 'tool.error': '出错',
      'grant.create': '新建授权', 'grant.revoke': '撤销授权', 'grant.expire': '授权过期',
      'approval.request': '请求审批', 'approval.approve': '批准', 'approval.deny': '拒绝',
      'approval.expire': '审批超时',
    };
    for (const r of rows.slice().reverse()) {
      const row = el('div', 'row');
      const t = new Date(r.at);
      row.appendChild(el('div', 'cmp-w', t.toLocaleTimeString('zh-CN')));
      row.appendChild(el('div', 'cmp-nm', kindName[r.kind] || r.kind));
      row.appendChild(el('div', 'cmp-w',
        (r.actor ? r.actor + ' · ' : '') + (r.tool || '') + (r.level !== undefined ? ' ' + lvName(r.level) : '') +
        (r.target ? ' · ' + r.target : '') + (r.detail ? ' · ' + r.detail : '')));
      auBox.appendChild(row);
    }
  }
  auSec.appendChild(auBox);
  host.appendChild(auSec);
}

// ── 维护：只读诊断与备份恢复（S9.4）──────────────────
async function renderMaintenance(host) {
  const api = window.soulweave;

  // ── 1. 一键只读诊断 ──
  const dgSec = section('环境诊断', '只读检查：不写文件、不改配置、不发起安装。任何修复都要你另行确认。');
  const dgBox = el('div', 'cmp');
  const dgOut = el('div', 'cmp');
  const dgBtn = el('button', 'chip on', '一键诊断');
  dgBtn.type = 'button';
  const dgRow = el('div', 'row');
  dgRow.appendChild(dgBtn);
  dgBox.appendChild(dgRow);
  dgBox.appendChild(dgOut);
  dgBtn.addEventListener('click', async () => {
    dgBtn.disabled = true;
    dgOut.textContent = '';
    dgOut.appendChild(el('div', 'cmp-w', '诊断中…'));
    try {
      const r = await api.maintDiag();
      dgOut.textContent = '';
      if (!r || !r.ok) { dgOut.appendChild(el('div', 'cmp-w', '诊断失败：' + ((r && r.error) || '未知'))); return; }
      const icon = { ok: '✓', warn: '!', fail: '✕' };
      for (const it of r.items) {
        const row = el('div', 'row');
        row.appendChild(el('div', 'cmp-w', icon[it.status] || '·'));
        row.appendChild(el('div', 'cmp-nm', it.name));
        row.appendChild(el('div', 'cmp-w', it.detail));
        dgOut.appendChild(row);
      }
      const bad = r.items.filter((x) => x.status === 'fail').length;
      const warn = r.items.filter((x) => x.status === 'warn').length;
      dgOut.appendChild(el('div', 'cmp-w', bad ? ('有 ' + bad + ' 项失败，' + warn + ' 项需要注意') : (warn ? ('没有失败，' + warn + ' 项需要注意') : '全部正常')));
      toast('诊断完成');
    } catch (e) {
      dgOut.textContent = '';
      dgOut.appendChild(el('div', 'cmp-w', '诊断失败：' + (e.message || e)));
    } finally {
      dgBtn.disabled = false;
    }
  });
  dgSec.appendChild(dgBox);
  host.appendChild(dgSec);

  // ── 1.5 版本与更新（D56.19/20）──────────────────
  const upSec = section('版本与更新', '检查新版本 → 看更新说明 → 你确认后才下载安装。安装前会自动备份配置，安装后做启动健康检查，失败可回滚。');
  const upBox = el('div', 'cmp');
  const upVer = el('div', 'cmp-w', '当前版本：读取中…');
  const upMsg = el('div', 'cmp-w', '');
  const upRow = el('div', 'row');
  const upCheck = el('button', 'chip on', '检查更新');
  upCheck.type = 'button';
  const upInstall = el('button', 'chip', '下载并安装');
  upInstall.type = 'button';
  upInstall.disabled = true;
  upRow.appendChild(upCheck);
  upRow.appendChild(upInstall);
  upBox.appendChild(upVer);
  upBox.appendChild(upRow);
  upBox.appendChild(upMsg);

  const setMsg = (t) => { upMsg.textContent = t; };

  (async () => {
    try {
      const r = await api.updateState();
      upVer.textContent = '当前版本：' + ((r && r.version) || '未知') + (r && r.packaged ? '' : '（开发模式）');
    } catch (e) { upVer.textContent = '当前版本：读取失败'; }
    // 上次更新如果没起来、已被自动回滚，这里必须明说，不能当没发生
    try {
      const rb = await api.updateRollbackInfo();
      const rep = rb && rb.report;
      if (rep) {
        const n = new Date(rep.at);
        setMsg('⚠ 上次更新（' + (rep.from || '旧版本') + ' → ' + (rep.to || '新版本') + '）连续 ' + rep.attempts +
          ' 次启动失败，已自动回滚：还原 ' + ((rep.restored || []).join('、') || '无文件') +
          '，自动更新已暂停。时间：' + (isNaN(n.getTime()) ? rep.at : n.toLocaleString()) +
          (rep.error ? '；' + rep.error : ''));
      }
    } catch (e) { /* ignore */ }
  })();

  upCheck.addEventListener('click', async () => {
    upCheck.disabled = true;
    setMsg('检查中…');
    try {
      const r = await api.updateCheck();
      const st = (r && r.state) || {};
      if (st.phase === 'available') {
        setMsg('发现新版本 ' + st.version + (st.notes ? '\n\n更新说明：\n' + st.notes : '') + '\n\n点「下载并安装」继续（会先备份配置）。');
        upInstall.disabled = false;
      } else if (st.phase === 'none') {
        setMsg('已是最新版本（' + st.version + '）。');
      } else if (st.phase === 'error') {
        setMsg('检查失败：' + (st.error || '未知') + (st.hint ? '（' + st.hint + '）' : ''));
      } else {
        setMsg('状态：' + (st.phase || '未知'));
      }
    } catch (e) { setMsg('检查失败：' + (e.message || e)); }
    finally { upCheck.disabled = false; }
  });

  upInstall.addEventListener('click', async () => {
    const ok = window.confirm('现在下载并安装更新？\n\n安装前会自动备份配置；安装完成后应用会重启。');
    if (!ok) return;
    upInstall.disabled = true;
    setMsg('下载中…');
    try {
      const d = await api.updateDownload();
      if (!d || !d.ok || (d.state && d.state.phase === 'error')) {
        setMsg('下载失败：' + ((d && d.state && d.state.error) || (d && d.error) || '未知'));
        return;
      }
      setMsg('下载完成，准备安装…');
      const i = await api.updateInstall();
      if (!i || !i.ok) setMsg('安装未执行：' + ((i && i.error) || '未知'));
      else setMsg('正在重启安装…');
    } catch (e) { setMsg('安装失败：' + (e.message || e)); }
    finally { upInstall.disabled = false; }
  });

  upSec.appendChild(upBox);
  host.appendChild(upSec);

  // ── 1.4 官网与文档（D57 官网导航）────────────────
  const siteSec = section('官网与文档', '在浏览器里打开官网：功能说明、安装指引、版本与公告、许可信息。');
  const siteBox = el('div', 'cmp');
  const siteUrl = 'https://soulweave.pages.dev';
  const siteRow = el('div', 'row');
  const siteOpen = el('button', 'chip on', '打开官网');
  siteOpen.type = 'button';
  const siteDocs = el('button', 'chip', '安装与排障文档');
  siteDocs.type = 'button';
  const siteReleases = el('button', 'chip', '版本与校验');
  siteReleases.type = 'button';
  siteRow.appendChild(siteOpen); siteRow.appendChild(siteDocs); siteRow.appendChild(siteReleases);
  siteBox.appendChild(el('div', 'cmp-w', 'https://soulweave.pages.dev'));
  siteBox.appendChild(siteRow);
  siteSec.appendChild(siteBox);
  host.appendChild(siteSec);
  siteOpen.addEventListener('click', () => { try { api.openExternal(siteUrl); } catch (e) { toast('打开失败：' + (e.message || e)); } });
  siteDocs.addEventListener('click', () => { try { api.openExternal(siteUrl + '/docs/index.html'); } catch (e) { toast('打开失败：' + (e.message || e)); } });
  siteReleases.addEventListener('click', () => { try { api.openExternal(siteUrl + '/releases.html'); } catch (e) { toast('打开失败：' + (e.message || e)); } });

  // ── 1.45 内置 QQ 协议端（D59.02）──────────────────
  const ncSec = section('内置 QQ 协议端', '安装包自带 NapCat（原样分发，未修改）。它注入你已安装的 QQ，因此需要管理员权限，账号风险由你承担。');
  const ncBox = el('div', 'cmp');
  const ncState = el('div', 'cmp-w', '读取中…');
  const ncRow = el('div', 'row');
  const ncStart = el('button', 'chip on', '启动协议端');
  ncStart.type = 'button';
  const ncStop = el('button', 'chip', '停止');
  ncStop.type = 'button';
  const ncRefresh = el('button', 'chip', '刷新状态');
  ncRefresh.type = 'button';
  ncRow.appendChild(ncStart);
  ncRow.appendChild(ncStop);
  ncRow.appendChild(ncRefresh);
  ncBox.appendChild(ncState);
  ncBox.appendChild(ncRow);
  ncSec.appendChild(ncBox);
  host.appendChild(ncSec);

  async function ncLoad() {
    ncRefresh.disabled = true;
    try {
      const r = await api.napcatStatus();
      if (!r || !r.ok) { ncState.textContent = '读取失败：' + ((r && r.error) || '未知'); return; }
      if (!r.bundled) { ncState.textContent = '当前安装包不含内置协议端（安装的是精简版），请在「社交」里手动配置外部协议端。'; return; }
      const v = (r.info && r.info.version) || '';
      ncState.textContent = r.running
        ? ('运行中 · OneBot 端口 ' + r.port + ' · ' + v)
        : ('未运行 · 已内置 ' + v + '（需要管理员权限，且本机需已安装 QQ）');
    } catch (e) { ncState.textContent = '读取失败：' + (e.message || e); }
    finally { ncRefresh.disabled = false; }
  }
  ncRefresh.addEventListener('click', ncLoad);
  ncStart.addEventListener('click', async () => {
    const ok = window.confirm('启动内置 NapCat？\n\n· 它会注入你本机已安装的 QQ，需要管理员权限（会弹 UAC）\n· 使用第三方协议端可能导致 QQ 账号被限制或封禁，风险由你自行承担\n· NapCat 按其自身许可（仅限非商业）随包分发，应用不对其行为负责');
    if (!ok) return;
    const r = await api.napcatStart();
    if (!r || !r.ok) { toast('启动失败：' + ((r && r.error) || '未知')); return; }
    toast('已启动，等待端口就绪…');
    setTimeout(ncLoad, 6000);
  });
  ncStop.addEventListener('click', async () => {
    const r = await api.napcatStop();
    if (!r || !r.ok) toast('停止失败：' + ((r && r.error) || '未知'));
    setTimeout(ncLoad, 1500);
  });
  ncLoad();

  // ── 1.55 公告与版本（D57.12/13/14）────────────────
  const annSec = section('公告与版本', '来自官网的静态数据。断网时显示上次缓存的内容；外部内容只按纯文本渲染，不执行任何 HTML。');
  const annBox = el('div', 'cmp');
  const annState = el('div', 'cmp-w', '读取中…');
  const annRow = el('div', 'row');
  const annBtn = el('button', 'chip on', '刷新');
  annBtn.type = 'button';
  annRow.appendChild(annBtn);
  const annList = el('div', 'cmp');
  annBox.appendChild(annState);
  annBox.appendChild(annRow);
  annBox.appendChild(annList);
  annSec.appendChild(annBox);
  host.appendChild(annSec);

  async function loadSite() {
    annBtn.disabled = true;
    annList.textContent = '';
    try {
      const [a, l] = await Promise.all([api.siteAnnouncements(), api.siteLatest()]);
      const parts = [];
      if (l && l.ok && l.data) parts.push('官网最新版：' + l.data.version + (l.data.date ? '（' + l.data.date + '）' : '') + (l.stale ? ' · 来自缓存' : ''));
      if (a && a.ok && Array.isArray(a.data)) {
        for (const it of a.data.slice(0, 4)) {
          const row = el('div', 'cmp-w');
          // textContent 赋值：公告里的任何标记都只会当文字显示
          row.textContent = '· [' + it.date + '] ' + it.title + (it.body ? ' — ' + it.body : '');
          annList.appendChild(row);
        }
        if (a.stale) parts.push('公告来自缓存（' + (a.fetchedAt || '') + '），联网后会自动更新');
        if (!a.data.length) parts.push('官网暂时没有公告');
      } else if (a && !a.ok) {
        parts.push('公告加载失败：' + (a.error || '未知') + (a.degraded === 'network' ? '（网络不可用，可稍后重试）' : a.degraded === 'timeout' ? '（请求超时）' : ''));
      }
      annState.textContent = parts.join(' · ') || '已是最新';
    } catch (e) {
      annState.textContent = '公告加载失败：' + (e.message || e);
    } finally { annBtn.disabled = false; }
  }
  annBtn.addEventListener('click', loadSite);
  loadSite();

  // ── 1.6 资源下载源 ────────────────────────────────
  const srcSec = section('资源下载源', '大文件（本地出图模型、语音模型）从这里下载。优先级：环境变量 SOULWEAVE_PACK_BASE > 本地配置 pack-feed.json > 发布默认镜像。');
  const srcBox = el('div', 'cmp');
  const srcLine = el('div', 'cmp-w', '读取中…');
  srcBox.appendChild(srcLine);
  srcSec.appendChild(srcBox);
  host.appendChild(srcSec);
  (async () => {
    try {
      const r = await api.packsSource();
      if (!r || !r.ok) { srcLine.textContent = '读取失败：' + ((r && r.error) || '未知'); return; }
      const kind = r.kind === 'env' ? '环境变量' : r.kind === 'file' ? '本地配置' : '发布默认';
      srcLine.textContent = '当前：' + r.url + '（来源：' + kind + (r.overridden ? '，已覆盖默认' : '') + '）';
    } catch (e) { srcLine.textContent = '读取失败：' + (e.message || e); }
  })();

  // ── 2. 备份与导出 ──
  const bkSec = section('备份与导出', '备份只包含配置与角色名单；不含任何密钥，也不含记忆数据库本身。');
  const bkBox = el('div', 'cmp');

  const bkRow = el('div', 'row');
  const bkBtn = el('button', 'chip on', '备份到文件…');
  bkBtn.type = 'button';
  bkBtn.addEventListener('click', async () => {
    bkBtn.disabled = true;
    try {
      const r = await api.maintBackup();
      if (!r || !r.ok) {
        if (r && r.reason === 'canceled') toast('已取消');
        else alert('备份失败：' + ((r && r.error) || '未知'));
        return;
      }
      toast('已备份 ' + r.fileCount + ' 个文件');
      bkNote.textContent = '最近一次备份：' + r.file;
      if (r.warnings && r.warnings.length) bkNote.textContent += '（有 ' + r.warnings.length + ' 条告警）';
    } finally { bkBtn.disabled = false; }
  });
  bkRow.appendChild(bkBtn);
  bkBox.appendChild(bkRow);

  const exRow = el('div', 'row');
  const exBtn = el('button', 'chip', '导出配置 JSON');
  exBtn.type = 'button';
  exBtn.addEventListener('click', async () => {
    exBtn.disabled = true;
    try {
      const r = await api.maintExport();
      if (!r || !r.ok) { alert('导出失败：' + ((r && r.error) || '未知')); return; }
      // 直接在界面里给出可复制的文本，不偷偷写盘
      exArea.value = r.json;
      exWrap.style.display = 'block';
      toast('已导出 ' + r.fileCount + ' 个文件（密钥已清空）');
    } finally { exBtn.disabled = false; }
  });
  exRow.appendChild(exBtn);
  bkBox.appendChild(exRow);

  const bkNote = el('div', 'cmp-w', '');
  bkBox.appendChild(bkNote);

  const exWrap = el('div', 'cmp');
  exWrap.style.display = 'none';
  const exArea = document.createElement('textarea');
  exArea.className = 'ls-input';
  exArea.rows = 8;
  exArea.readOnly = true;
  exWrap.appendChild(exArea);
  bkBox.appendChild(exWrap);
  bkSec.appendChild(bkBox);
  host.appendChild(bkSec);

  // ── 3. 恢复 ──
  const rsSec = section('从备份恢复', '会覆盖同名配置文件。恢复前会自动留一份安全副本，出问题可以手工找回。');
  const rsBox = el('div', 'cmp');
  const rsRow = el('div', 'row');
  const rsBtn = el('button', 'chip', '选择备份文件…');
  rsBtn.type = 'button';
  rsBtn.addEventListener('click', async () => {
    const picked = await api.pickFile({ title: '选择 SoulWeave 备份', filters: [{ name: 'SoulWeave 备份', extensions: ['json'] }] }).catch((e) => ({ ok: false, reason: String(e) }));
    if (!picked || !picked.ok) { if (picked && picked.reason === 'canceled') toast('已取消'); return; }
    // 先不带 confirm 调一次，拿校验结果
    const probe = await api.maintRestore({ file: picked.path });
    if (!probe || !probe.ok) {
      if (probe && probe.reason === 'need-confirm') {
        const when = new Date(probe.createdAt || Date.now()).toLocaleString('zh-CN');
        if (!confirm('备份时间：' + when + '\n包含 ' + probe.fileCount + ' 个文件。\n\n恢复会覆盖当前同名配置，继续？')) return;
        const r = await api.maintRestore({ file: picked.path, confirm: true });
        if (!r || !r.ok) { alert('恢复失败：' + ((r && r.error) || '未知')); return; }
        toast('已恢复 ' + r.written.length + ' 个文件');
        rsNote.textContent = '已恢复：' + r.written.join('、') + '；安全副本在 ' + r.safetyDir;
        setTimeout(() => render('maintenance'), 800);
      } else {
        alert('这个文件不能用：' + ((probe && probe.error) || '未知'));
      }
    }
  });
  rsRow.appendChild(rsBtn);
  rsBox.appendChild(rsRow);
  const rsNote = el('div', 'cmp-w', '只接受 SoulWeave 自己导出的备份；含密钥文件或路径异常的包会被拒绝。');
  rsBox.appendChild(rsNote);
  rsSec.appendChild(rsBox);
  host.appendChild(rsSec);

  // ── 4. 缓存 ──
  const caSec = section('缓存清理', '只清会话缓存与脚本缓存，不碰配置、记忆与密钥。');
  const caBox = el('div', 'cmp');
  const caRow = el('div', 'row');
  const caBtn = el('button', 'chip', '清理缓存');
  caBtn.type = 'button';
  caBtn.addEventListener('click', async () => {
    if (!confirm('清理会话缓存与脚本缓存？\n（不会删除配置与记忆）')) return;
    caBtn.disabled = true;
    try {
      const r = await api.maintClearCache(true);
      if (!r || !r.ok) { alert('清理失败：' + ((r && r.error) || '未知')); return; }
      toast('已释放 ' + (r.freed / 1024 / 1024).toFixed(1) + ' MB');
      caNote.textContent = r.removed.length ? ('已清理：' + r.removed.join('、')) : '没有可清理的缓存';
    } finally { caBtn.disabled = false; }
  });
  caRow.appendChild(caBtn);
  caBox.appendChild(caRow);
  const caNote = el('div', 'cmp-w', '');
  caBox.appendChild(caNote);
  caSec.appendChild(caBox);
  host.appendChild(caSec);

  // ── 5. 审计概览 ──
  const auSec = section('审计概览', '审计写入 data 目录的 audit.log，按大小轮转。');
  const auBox = el('div', 'cmp');
  let st = { total: 0, allowed: 0, denied: 0 };
  try { const r = await api.auditStats(); if (r && r.ok) st = r.stats; } catch (e) { /* ignore */ }
  const auRow = el('div', 'row');
  auRow.appendChild(el('div', 'cmp-nm', '近 24 小时'));
  auRow.appendChild(el('div', 'cmp-w', '共 ' + st.total + ' 条 · 放行 ' + st.allowed + ' · 拦截 ' + st.denied));
  auBox.appendChild(auRow);
  auBox.appendChild(el('div', 'cmp-w', '查看明细请到「权限」面板。'));
  auSec.appendChild(auBox);
  host.appendChild(auSec);
}

// ── 扩展：手机 Web 与远程访问（S8）──────────────────
async function renderExtension(host) {
  const api = window.soulweave;
  let st = null;
  try { const r = await api.webState(); st = r && r.ok ? r.state : null; } catch (e) { st = null; }
  if (!st) {
    host.appendChild(section('手机 Web 与远程'));
    host.appendChild(el('div', 'cmp-w', '读取 Web 访问状态失败。'));
    return;
  }
  const cfg = st.config || {};
  const info = st.info || {};
  const isLan = !info.loopbackOnly;

  // ── 1. 开关 ──
  const swSec = section('手机 Web', '在手机上打开浏览器，输入下面的地址即可和角色对话。默认只监听本机，局域网需要你明确开启。');
  const swBox = el('div', 'cmp');
  const swRow = el('div', 'row');
  swRow.appendChild(el('label', null, '启用手机 Web'));
  const swBtn = el('button', 'chip' + (cfg.enabled ? ' on' : ''), cfg.enabled ? '已开启' : '已关闭');
  swBtn.type = 'button';
  swBtn.addEventListener('click', async () => {
    swBtn.disabled = true;
    const r = await api.webConfigSet({ enabled: !cfg.enabled });
    swBtn.disabled = false;
    if (!r || !r.ok) { alert('操作失败：' + ((r && r.error) || '未知')); return; }
    toast(!cfg.enabled ? '已开启手机 Web' : '已关闭手机 Web');
    render('extension');
  });
  swRow.appendChild(swBtn);
  swBox.appendChild(swRow);

  const stRow = el('div', 'row');
  stRow.appendChild(el('label', null, '当前状态'));
  stRow.appendChild(el('div', 'cmp-w',
    info.running ? ('运行中 · ' + info.url) : '未运行'));
  swBox.appendChild(stRow);

  if (st.transportWarning) {
    swBox.appendChild(el('div', 'cmp-w', '⚠ ' + st.transportWarning));
  }
  swSec.appendChild(swBox);
  host.appendChild(swSec);

  // ── 2. 监听范围与端口 ──
  const bindSec = section('监听范围', '只监听本机最安全。要让手机连，必须选一个局域网地址，并确认明文传输的风险。');
  const bindBox = el('div', 'cmp');

  let addrs = [];
  try { const r = await api.webLanAddresses(); addrs = (r && r.ok ? r.addresses : []) || []; } catch (e) { addrs = []; }

  const scopeRow = el('div', 'row');
  scopeRow.appendChild(el('label', null, '允许谁访问'));
  const onlyMe = el('button', 'chip' + (info.loopbackOnly ? ' on' : ''), '仅本机');
  onlyMe.type = 'button';
  onlyMe.addEventListener('click', async () => {
    onlyMe.disabled = true;
    const r = await api.webConfigSet({ bindHost: '127.0.0.1', lanAcknowledged: false });
    onlyMe.disabled = false;
    if (!r || !r.ok) { alert('保存失败：' + ((r && r.error) || '未知')); return; }
    toast('已切回仅本机');
    render('extension');
  });
  scopeRow.appendChild(onlyMe);
  for (const a of addrs) {
    const label = a.kind === 'tailscale' ? ('Tailscale ' + a.address) : ('局域网 ' + a.address);
    const b = el('button', 'chip' + (!info.loopbackOnly && cfg.bindHost === a.address ? ' on' : ''), label);
    b.type = 'button';
    b.addEventListener('click', async () => {
      if (!cfg.lanAcknowledged) {
        if (!confirm('开启后，同一网络内的设备都能访问这个页面（明文 HTTP）。\n只有在可信网络里才这样做。继续？')) return;
      }
      b.disabled = true;
      const r = await api.webConfigSet({ bindHost: a.address, lanAcknowledged: true });
      b.disabled = false;
      if (!r || !r.ok) { alert('保存失败：' + ((r && r.error) || '未知')); return; }
      toast('已允许局域网访问');
      render('extension');
    });
    scopeRow.appendChild(b);
  }
  bindBox.appendChild(scopeRow);

  const portRow = el('div', 'row');
  portRow.appendChild(el('label', null, '端口'));
  const portInp = document.createElement('input');
  portInp.className = 'ls-input';
  portInp.type = 'number';
  portInp.min = '1024';
  portInp.max = '65535';
  portInp.value = String(cfg.port || 8930);
  portRow.appendChild(portInp);
  const portSave = el('button', 'chip', '保存');
  portSave.type = 'button';
  portSave.addEventListener('click', async () => {
    portSave.disabled = true;
    const r = await api.webConfigSet({ port: Number(portInp.value) });
    portSave.disabled = false;
    if (!r || !r.ok) { alert('保存失败：' + ((r && r.error) || '未知')); return; }
    toast('端口已保存');
    render('extension');
  });
  portRow.appendChild(portSave);
  bindBox.appendChild(portRow);

  if (isLan) {
    bindBox.appendChild(el('div', 'cmp-w', '手机访问地址：' + info.url + '（同一网络内）'));
  } else {
    bindBox.appendChild(el('div', 'cmp-w', '当前只在本机可访问：' + info.url));
  }
  bindSec.appendChild(bindBox);
  host.appendChild(bindSec);

  // ── 2b. 远程访问（局域网 / Tailscale）──
  const rmSec = section('远程访问', '同一个 Wi-Fi 用局域网地址就够。要从外面连，不要做端口映射，装 Tailscale。');
  const rmBox = el('div', 'cmp');
  const tsAddrs = addrs.filter((a) => a.kind === 'tailscale');
  const lanAddrs = addrs.filter((a) => a.kind === 'lan');
  if (isLan) {
    rmBox.appendChild(el('div', 'cmp-w', '当前地址：' + info.url + (tsAddrs.some((a) => a.address === cfg.bindHost) ? '（经 Tailscale，链路本身加密）' : '（局域网明文）')));
    const copy = el('button', 'chip', '复制地址');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(info.url); toast('已复制'); }
      catch (e) { alert('复制失败，请手动选中：' + info.url); }
    });
    rmBox.appendChild(copy);
  } else {
    rmBox.appendChild(el('div', 'cmp-w', '现在只监听本机，手机连不上。选一个上面的局域网地址才能跨设备访问。'));
  }
  rmBox.appendChild(el('div', 'cmp-w',
    'Tailscale：' + (tsAddrs.length ? ('已检测到 ' + tsAddrs.map((a) => a.address).join('、')) : '未检测到（100.64.0.0/10 网段）') +
    '。要跨公网就装 Tailscale 后用它的地址访问 —— 隧道自己加密，不需要在这里开 HTTPS，也不要给路由器做端口映射。'));
  rmBox.appendChild(el('div', 'cmp-w',
    '局域网是明文 HTTP：同一网络里的其他人只要拿到地址就能打开登录页（仍然需要配对码才能进去），所以只在可信网络使用。'));
  rmSec.appendChild(rmBox);
  host.appendChild(rmSec);

  // ── 3. 配对码 ──
  const pairSec = section('连接手机', '在手机上打开上面的地址，输入这里的 6 位配对码。配对码 5 分钟有效、只能用一次。');
  const pairBox = el('div', 'cmp');
  const codeOut = el('div', 'cmp-w', cfg.enabled ? '还没有生成配对码。' : '请先开启手机 Web。');
  const paintCode = (code, expiresAt) => {
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    if (left <= 0) { codeOut.textContent = '配对码已过期，请重新生成。'; return false; }
    codeOut.textContent = '配对码：' + String(code).split('').join(' ') +
      '　（' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') + ' 后失效）';
    return true;
  };
  const pairBtn = el('button', 'chip on', '生成配对码');
  pairBtn.type = 'button';
  if (!cfg.enabled) pairBtn.disabled = true;
  let tickTimer = null;
  pairBtn.addEventListener('click', async () => {
    pairBtn.disabled = true;
    const r = await api.webPairingNew();
    pairBtn.disabled = false;
    if (!r || !r.ok) { alert('生成失败：' + ((r && r.error) || '未知')); return; }
    const show = () => {
      if (!paintCode(r.code, r.expiresAt) && tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    };
    show();
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(show, 1000);
  });
  pairBox.appendChild(pairBtn);
  pairBox.appendChild(codeOut);
  if (st.pairing && st.pairing.active && st.pairing.code) {
    paintCode(st.pairing.code, st.pairing.expiresAt);
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(() => {
      if (!document.body.contains(codeOut)) { clearInterval(tickTimer); tickTimer = null; return; }
      if (!paintCode(st.pairing.code, st.pairing.expiresAt) && tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    }, 1000);
  }
  pairSec.appendChild(pairBox);
  host.appendChild(pairSec);

  // ── 4. 已授权设备 ──
  const devSec = section('已授权设备', '撤销后，那台设备上的页面会立刻断开，需要重新配对。');
  const devBox = el('div', 'cmp');
  const devs = (st.devices || []).filter((d) => !d.revokedAt);
  if (!devs.length) {
    devBox.appendChild(el('div', 'cmp-w', '还没有设备连接过。'));
  } else {
    for (const d of devs) {
      const row = el('div', 'row');
      row.appendChild(el('div', 'cmp-nm', d.label));
      row.appendChild(el('div', 'cmp-w', (d.scopes || []).join(' · ')));
      const dt = new Date(d.createdAt || Date.now());
      row.appendChild(el('div', 'cmp-w', dt.toLocaleString('zh-CN')));
      const rev = el('button', 'chip', '撤销');
      rev.type = 'button';
      rev.addEventListener('click', async () => {
        if (!confirm('撤销「' + d.label + '」？该设备需要重新配对。')) return;
        const r = await api.webDeviceRevoke(d.id);
        if (!r || !r.ok) { alert('撤销失败：' + ((r && r.error) || '未知')); return; }
        toast('已撤销');
        render('extension');
      });
      row.appendChild(rev);
      devBox.appendChild(row);
    }
  }
  devSec.appendChild(devBox);
  host.appendChild(devSec);

  // ── 5. 待批准（高风险作用域）──
  const apSec = section('待批准的授权申请', '手机端只能「申请」管理员权限；批准动作只能在电脑上完成。');
  const apBox = el('div', 'cmp');
  const aps = st.approvals || [];
  if (!aps.length) {
    apBox.appendChild(el('div', 'cmp-w', '没有待批准的申请。'));
  } else {
    for (const a of aps) {
      const row = el('div', 'row');
      row.appendChild(el('div', 'cmp-nm', a.label));
      row.appendChild(el('div', 'cmp-w', '申请：' + (a.scopes || []).join(' · ')));
      const okB = el('button', 'chip on', '批准');
      okB.type = 'button';
      okB.addEventListener('click', async () => {
        const r = await api.webApprovalApprove(a.id);
        if (!r || !r.ok) { alert('批准失败：' + ((r && r.error) || '未知')); return; }
        toast('已批准');
        render('extension');
      });
      row.appendChild(okB);
      const noB = el('button', 'chip', '拒绝');
      noB.type = 'button';
      noB.addEventListener('click', async () => {
        const r = await api.webApprovalDeny(a.id);
        if (!r || !r.ok) { alert('操作失败：' + ((r && r.error) || '未知')); return; }
        toast('已拒绝');
        render('extension');
      });
      row.appendChild(noB);
      apBox.appendChild(row);
    }
  }
  apSec.appendChild(apBox);
  host.appendChild(apSec);

  // ── 6. 审计 ──
  const auSec = section('最近访问记录', '只记录时间、类型与来源 IP，不记录任何令牌明文。');
  const auBox = el('div', 'cmp');
  let entries = [];
  try { const r = await api.webAudit(20); entries = (r && r.ok ? r.entries : []) || []; } catch (e) { entries = []; }
  if (!entries.length) {
    auBox.appendChild(el('div', 'cmp-w', '暂无记录。'));
  } else {
    const kindName = {
      'pair.ok': '配对成功', 'pair.bad': '配对码错误', 'pair.expired': '配对码过期', 'pair.locked': '配对锁定',
      'session.ok': '登录', 'session.bad': '登录失败', 'session.expired': '会话过期',
      'auth.ok': '访问', 'auth.deny': '拒绝', 'device.revoke': '撤销设备',
      'scope.grant': '授权', 'approval.request': '申请权限', 'approval.approve': '批准权限',
      'approval.deny': '拒绝权限', 'ratelimit.lock': '触发限速',
    };
    for (const e of entries.slice().reverse()) {
      const row = el('div', 'row');
      const t = new Date(e.at || Date.now());
      row.appendChild(el('div', 'cmp-w', t.toLocaleTimeString('zh-CN')));
      row.appendChild(el('div', 'cmp-nm', kindName[e.kind] || e.kind));
      row.appendChild(el('div', 'cmp-w', (e.ip || '') + (e.detail ? (' · ' + e.detail) : '')));
      auBox.appendChild(row);
    }
  }
  auSec.appendChild(auBox);
  host.appendChild(auSec);
}

// ── 窗口控制与启动 ──
function setupWindowControls() {
  const min = $('#sb-min');
  const max = $('#sb-max');
  const cls = $('#sb-close');
  const call = (a) => { try { window.soulweave.settingsWindowControl(a); } catch (e) { /* ignore */ } };
  if (min) min.addEventListener('click', () => call('minimize'));
  if (max) max.addEventListener('click', () => call('maximize'));
  if (cls) cls.addEventListener('click', () => call('close'));

  // 双击标题栏最大化/还原 —— Windows 窗口的通用习惯
  const bar = $('#sb-titlebar');
  if (bar) bar.addEventListener('dblclick', (e) => {
    if (e.target && e.target.closest('button')) return;
    call('maximize');
  });

  // 按钮图标跟着窗口状态走：最大化后显示"还原"，标题/读屏名称同步
  const sync = (isMax) => {
    if (!max) return;
    max.textContent = isMax ? String.fromCharCode(0xE923) : String.fromCharCode(0xE922);
    const label = isMax ? '还原' : '最大化';
    max.title = label;
    max.setAttribute('aria-label', label);
  };
  try { window.soulweave.onSettingsWindowState((st) => sync(!!(st && st.isMaximized))); } catch (e) { /* 旧版 preload 没有这个事件时忽略 */ }
  try { window.soulweave.settingsWindowState().then((st) => sync(!!(st && st.isMaximized))).catch(() => {}); } catch (e) { /* ignore */ }
}

async function boot() {
  try { if (VoiceSetup && VoiceSetup.initVoiceSetup) await VoiceSetup.initVoiceSetup(); } catch (e) { /* ignore */ }
  buildNav();
  setupWindowControls();
  try {
    const saved = localStorage.getItem('soulweave.theme');
    const t = await window.soulweave.getTheme();
    const mode = saved || 'auto';
    const resolved = mode === 'auto' ? (t && t.dark ? 'dark' : 'light') : mode;
    document.documentElement.dataset.theme = resolved;
  } catch (e) { console.error('[soulweave]', e); }
  select('dashboard');
}
boot();