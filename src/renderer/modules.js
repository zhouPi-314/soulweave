/**
 * SoulWeave S3-12：十二大功能模块
 *
 * 来源：需求矩阵 D55.01 的模块划分
 *   Character / Model / Social / Permission / Memory / Voice /
 *   Life / Multimedia / Resource / Maintenance / Extension / Dashboard
 *
 * 【界面独立性】这 12 个模块属于「设置中心」窗口，
 * 与主窗口的角色面板（动作/表情）是两套独立 UI，
 * 但共享同一份配置与 IPC —— 数据互通、界面分离。
 */
export const MODULES = [
  { id: 'dashboard',   label: '看板',     icon: '▤', stage: 'S2', group: '数字生活',  desc: '运行状态、性能与资源概览' },
  { id: 'life',        label: '虚拟生活', icon: '☀', stage: 'S6', group: '数字生活',  desc: '日程、主动私聊与日记' },
  { id: 'character',   label: '智能体绑定', icon: '◈', stage: 'S1', group: '角色与声音',  desc: '谁来思考：把智能体接到角色上，并设置预算与自主性' },
  { id: 'roster',      label: '角色档案', icon: '☰', stage: 'S6', group: '角色与声音',  desc: '每个角色是谁：人格卡、外形、QQ 与形象绑定' },
  { id: 'live2d',      label: '形象管理', icon: '❖', stage: 'S6', group: '角色与声音',  desc: 'Live2D 形象库：导入、命名、显隐，以及哪个角色用它' },
  { id: 'theme',       label: '主题',     icon: '◑', stage: 'S2', group: '角色与声音',  desc: '界面主题：多套配色与跟随系统' },
  { id: 'voice',       label: '语音',     icon: '♪', stage: 'S3', group: '角色与声音',  desc: '音色、组件与语音服务' },
  { id: 'model',       label: '模型',     icon: '◇', stage: 'S2', group: '角色与声音',  desc: '画质档位与渲染参数' },
  { id: 'social',      label: '社交',     icon: '◎', stage: 'S5', group: '连接与社交',  desc: 'QQ 与 OneBot v11 后端' },
  { id: 'memory',      label: '记忆',     icon: '❖', stage: 'S4', group: '记忆与权限',  desc: '长期记忆与检索权限' },
  { id: 'permission',  label: '权限',     icon: '⚿', stage: 'S9', group: '记忆与权限',  desc: 'L0–L5 工具审批与审计' },
  { id: 'multimedia',  label: '多媒体',   icon: '▣', stage: 'S7', group: '资源与维护',  desc: '图片理解与生成' },
  { id: 'resource',    label: '资源',     icon: '▦', stage: 'S6', group: '资源与维护',  desc: '按需下载与资源回收' },
  { id: 'downloads',   label: '下载中心', icon: '⤓', stage: 'S7', group: '资源与维护',  desc: '所有资源与更新的下载进度' },
  { id: 'maintenance', label: '维护',     icon: '⚙', stage: 'S9', group: '资源与维护',  desc: '环境诊断、备份恢复与缓存' },
  { id: 'extension',   label: '扩展',     icon: '⊕', stage: 'S8', group: '资源与维护',  desc: '手机 Web、远程访问与插件' },
];

/** 已实现内容的模块（其余显示阶段提示） */
export const IMPLEMENTED = new Set(['dashboard', 'character', 'roster', 'model', 'voice', 'resource', 'downloads', 'social', 'memory', 'life', 'multimedia', 'extension', 'permission', 'maintenance', 'live2d', 'theme']);
