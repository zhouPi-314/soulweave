/**
 * Preload：把主进程能力安全地暴露给渲染层
 *
 * 注意：本项目 main 是 ESM，但 preload 必须以 CJS（.cjs 后缀显式声明）加载。
 *
 * 【约定】这里每暴露一个方法，主进程就必须有对应的 ipcMain.handle/send 注册，
 * 否则渲染层用 window.soulweave?.xxx?.() 调用时会**静默失效**。
 * 这个约定由 scripts/check-preload.mjs 在 npm test 里强制检查。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('soulweave', {
  // ── 应用信息与自启
  getVersions: () => ipcRenderer.invoke('app:version'),
  getTrayState: () => ipcRenderer.invoke('app:tray'),
  getAutoStart: () => ipcRenderer.invoke('app:autostart:get'),
  setAutoStart: (v) => ipcRenderer.invoke('app:autostart:set', v),
  getSwitchStats: () => ipcRenderer.invoke('app:switch-stats'),
  notifyModelSwitch: (payload) => ipcRenderer.send('renderer:model-switch', payload),

  // ── S11：姐妹活动 ──
  sisterState: () => ipcRenderer.invoke('sister:state'),
  sisterSetPolicy: (patch) => ipcRenderer.invoke('sister:policy:set', patch || {}),
  sisterStart: (payload) => ipcRenderer.invoke('sister:start', payload || {}),
  sisterTurn: (id) => ipcRenderer.invoke('sister:turn', { id }),
  sisterAbort: (id, reason) => ipcRenderer.invoke('sister:abort', { id, reason }),

  // ── S11：姐妹私聊 ──
  sisterDmState: () => ipcRenderer.invoke('sisterdm:state'),
  sisterDmSetPolicy: (patch) => ipcRenderer.invoke('sisterdm:policy:set', patch || {}),
  sisterDmSend: (payload) => ipcRenderer.invoke('sisterdm:send', payload || {}),
  sisterDmAutoReply: (payload) => ipcRenderer.invoke('sisterdm:autoReply', payload || {}),

  // ── S11：QQ 空间 ──
  qzoneState: () => ipcRenderer.invoke('qzone:state'),
  qzoneSetPolicy: (patch) => ipcRenderer.invoke('qzone:policy:set', patch || {}),
  qzoneCreateDraft: (payload) => ipcRenderer.invoke('qzone:draft:create', payload || {}),
  qzoneUpdateDraft: (payload) => ipcRenderer.invoke('qzone:draft:update', payload || {}),
  qzoneSubmit: (id) => ipcRenderer.invoke('qzone:submit', { id }),
  qzoneApprove: (id) => ipcRenderer.invoke('qzone:approve', { id }),
  qzoneReject: (id, reason) => ipcRenderer.invoke('qzone:reject', { id, reason }),
  qzonePublish: (id) => ipcRenderer.invoke('qzone:publish', { id }),
  qzoneRequeue: (id) => ipcRenderer.invoke('qzone:requeue', { id }),
  copyText: (text) => ipcRenderer.invoke('shell:copyText', { text }),
  qzonePickImages: () => ipcRenderer.invoke('qzone:pickImages'),
  qzoneProbe: () => ipcRenderer.invoke('qzone:probe'),
  qzoneDelete: (tid) => ipcRenderer.invoke('qzone:delete', { tid }),

  // ── S10：音色社区 ──
  communityVoiceList: () => ipcRenderer.invoke('community:voice:list'),
  communityVoiceApply: (payload) => ipcRenderer.invoke('community:voice:apply', payload || {}),
  characterVoiceGet: (characterId) => ipcRenderer.invoke('character:voice:get', { characterId }),

  // ── S9.4：维护中心 ──
  maintDiag: () => ipcRenderer.invoke('maint:diag'),
  maintBackup: () => ipcRenderer.invoke('maint:backup'),
  maintRestore: (payload) => ipcRenderer.invoke('maint:restore', payload || {}),
  maintExport: () => ipcRenderer.invoke('maint:export'),
  maintClearCache: (confirm) => ipcRenderer.invoke('maint:cache:clear', { confirm: confirm === true }),

  // ── S9：工具审批与审计 ──
  toolGrants: () => ipcRenderer.invoke('tool:grants'),
  toolGrantAdd: (payload) => ipcRenderer.invoke('tool:grant:add', payload || {}),
  toolGrantRevoke: (id) => ipcRenderer.invoke('tool:grant:revoke', { id }),
  toolApprove: (id, mode) => ipcRenderer.invoke('tool:approve', { id, mode }),
  toolDeny: (id) => ipcRenderer.invoke('tool:deny', { id }),
  auditList: (payload) => ipcRenderer.invoke('audit:list', payload || {}),
  auditStats: () => ipcRenderer.invoke('audit:stats'),
  auditDb: (payload) => ipcRenderer.invoke('audit:db', payload || {}),

  // ── S8：手机 Web 与远程访问 ──
  webState: () => ipcRenderer.invoke('web:state'),
  webConfigSet: (patch) => ipcRenderer.invoke('web:config:set', patch),
  webPairingNew: () => ipcRenderer.invoke('web:pairing:new'),
  webPairingCancel: () => ipcRenderer.invoke('web:pairing:cancel'),
  webDeviceRevoke: (id) => ipcRenderer.invoke('web:device:revoke', { id }),
  webApprovalApprove: (id) => ipcRenderer.invoke('web:approval:approve', { id }),
  webApprovalDeny: (id) => ipcRenderer.invoke('web:approval:deny', { id }),
  webAudit: (limit) => ipcRenderer.invoke('web:audit', { limit }),
  webLanAddresses: () => ipcRenderer.invoke('web:lan:addresses'),

  // ── 设置中心（S3-12：独立窗口）
  openSettings: () => ipcRenderer.invoke('settings:open'),
  settingsWindowControl: (action) => ipcRenderer.invoke('settings:control', action),
  /** 当前设置窗口状态（最大化/全屏） */
  settingsWindowState: () => ipcRenderer.invoke('settings:window:state'),
  /** 订阅窗口状态变化；返回取消订阅函数 */
  onSettingsWindowState: (cb) => {
    const h = (_e, st) => { try { cb(st); } catch (err) { /* ignore */ } };
    ipcRenderer.on('settings:window:state', h);
    return () => ipcRenderer.removeListener('settings:window:state', h);
  },

  // ── 主窗口控制
  getWindowMode: () => ipcRenderer.invoke('window:mode:get'),
  setWindowMode: (m) => ipcRenderer.invoke('window:mode:set', m),
  windowControl: (a) => ipcRenderer.invoke('window:control', a),
  getWindowState: () => ipcRenderer.invoke('window:state'),
  onWindowStateChanged: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on('window:state', h);
    return () => ipcRenderer.removeListener('window:state', h);
  },

  // ── 主题
  getTheme: () => ipcRenderer.invoke('theme:get'),
  onThemeChanged: (cb) => {
    const h = (_e, t) => cb(t);
    ipcRenderer.on('theme:changed', h);
    return () => ipcRenderer.removeListener('theme:changed', h);
  },

  // ── 系统音色（SAPI）
  listVoices: () => ipcRenderer.invoke('voice:list'),
  synthVoice: (payload) => ipcRenderer.invoke('voice:synth', payload),
  getVoiceConfig: () => ipcRenderer.invoke('voice:config:get'),
  setVoiceConfig: (cfg) => ipcRenderer.invoke('voice:config:set', cfg),

  // ── 在线 TTS 凭证（安全存储，只写不读）
  voiceKeyStatus: () => ipcRenderer.invoke('voice:key:status'),
  setVoiceKey: (id, key) => ipcRenderer.invoke('voice:key:set', { id, key }),
  voiceCredsStatus: () => ipcRenderer.invoke('voice:creds:status'),
  setVoiceCreds: (id, fields) => ipcRenderer.invoke('voice:creds:set', { id, fields }),

  // ── 外链（主进程校验只允许 https）
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', { url }),

  // ── 语音组件管理
  listVoiceComponents: () => ipcRenderer.invoke('voice:components:list'),
  setComponentPath: (id, p) => ipcRenderer.invoke('voice:components:setPath', { id, path: p }),
  autoDetectComponent: (id) => ipcRenderer.invoke('voice:components:autoDetect', { id }),
  pickComponentPath: (id) => ipcRenderer.invoke('voice:components:pickPath', { id }),
  openComponentUpstream: (id) => ipcRenderer.invoke('voice:components:openUpstream', { id }),
  probeComponent: (id) => ipcRenderer.invoke('voice:components:probe', { id }),

  // ── 各 TTS provider
  listPiperVoices: () => ipcRenderer.invoke('voice:piper:voices'),
  synthPiper: (payload) => ipcRenderer.invoke('voice:piper:synth', payload),
  listKokoroVoices: () => ipcRenderer.invoke('voice:kokoro:voices'),
  synthKokoro: (payload) => ipcRenderer.invoke('voice:kokoro:synth', payload),
  listAzureVoices: () => ipcRenderer.invoke('voice:azure:voices'),
  synthAzure: (payload) => ipcRenderer.invoke('voice:azure:synth', payload),
  onlineVoices: () => ipcRenderer.invoke('voice:online:voices'),
  synthOnline: (payload) => ipcRenderer.invoke('voice:online:synth', payload),
  synthServiceVoice: (payload) => ipcRenderer.invoke('voice:service:synth', payload),

  // ── 资源回收
  setValveConfig: (cfg) => ipcRenderer.invoke('valve:config:set', cfg),
  getValveConfig: () => ipcRenderer.invoke('valve:config:get'),

  // ── 背景与桌宠
  pickBackgroundImage: () => ipcRenderer.invoke('background:pick'),

  // S4-0：数据库连接配置（密码只进不出，不返回给渲染层）
  dbDetect: (port) => ipcRenderer.invoke('db:detect', { port }),
  dbTest: (payload) => ipcRenderer.invoke('db:test', payload),
  dbStatus: () => ipcRenderer.invoke('db:status'),
  dbDebug: () => ipcRenderer.invoke('db:debug'),
  dbSchema: () => ipcRenderer.invoke('db:schema'),
  dbSyncChars: () => ipcRenderer.invoke('db:syncChars'),
  // D56：安装状态机 + 自动更新
  installSummary: () => ipcRenderer.invoke('install:summary'),
  installRepair: () => ipcRenderer.invoke('install:repair'),
  updateState: () => ipcRenderer.invoke('update:state'),
  updateRollbackInfo: () => ipcRenderer.invoke('update:rollbackInfo'),
  packsSource: () => ipcRenderer.invoke('packs:source'),
  // 官网公告与版本（只读、纯文本，失败降级到本地缓存）
  // 内置协议端
  napcatInfo: () => ipcRenderer.invoke('napcat:info'),
  napcatStatus: () => ipcRenderer.invoke('napcat:status'),
  napcatStart: () => ipcRenderer.invoke('napcat:start'),
  napcatStop: () => ipcRenderer.invoke('napcat:stop'),
  siteInfo: () => ipcRenderer.invoke('site:info'),
  siteAnnouncements: () => ipcRenderer.invoke('site:announcements'),
  siteLatest: () => ipcRenderer.invoke('site:latest'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateBackup: () => ipcRenderer.invoke('update:backup'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  dbInit: (database) => ipcRenderer.invoke('db:init', { database }),

  // S4-0：智能体接入（一个角色只绑一个，绑定后不可更换）
  agentDetect: () => ipcRenderer.invoke('agent:detect'),
  agentStatus: () => ipcRenderer.invoke('agent:status'),
  agentBind: (characterId, agentId) => ipcRenderer.invoke('agent:bind', { characterId, agentId }),
  setAgentBudget: (limitCny) => ipcRenderer.invoke('agent:budget:set', { limitCny }),
  agentChat: (payload) => ipcRenderer.invoke('agent:chat', payload),
  agentKeyStatus: () => ipcRenderer.invoke('agent:key:status'),
  setAgentKey: (key) => ipcRenderer.invoke('agent:key:set', { key }),
  agentGatewayStatus: () => ipcRenderer.invoke('agent:gateway:status'),
  agentGatewayChat: (payload) => ipcRenderer.invoke('agent:gateway:chat', payload),
  agentGatewayStream: (payload) => ipcRenderer.invoke('agent:gateway:stream', payload),
  embeddingStatus: () => ipcRenderer.invoke('embedding:status'),
  setEmbeddingDir: (dir) => ipcRenderer.invoke('embedding:setDir', { dir }),
  embeddingEncode: (text) => ipcRenderer.invoke('embedding:encode', { text }),
  memoryList: (payload) => ipcRenderer.invoke('memory:list', payload),

  // ── S6：Life Studio ──
  lifeScheduleGet: (p) => ipcRenderer.invoke('life:schedule:get', p),
  lifeScheduleSave: (p) => ipcRenderer.invoke('life:schedule:save', p),
  lifeActivityNow: (p) => ipcRenderer.invoke('life:activity:now', p),
  lifeEventCreate: (p) => ipcRenderer.invoke('life:event:create', p),
  lifeEventList: (p) => ipcRenderer.invoke('life:event:list', p),
  lifeEventUpdate: (p) => ipcRenderer.invoke('life:event:update', p),
  lifeEventDelete: (p) => ipcRenderer.invoke('life:event:delete', p),
  lifeEventRestore: (p) => ipcRenderer.invoke('life:event:restore', p),
  lifeAlbumList: (p) => ipcRenderer.invoke('life:album:list', p),
  lifeAlbumFavorite: (p) => ipcRenderer.invoke('life:album:favorite', p),
  lifeAlbumDelete: (p) => ipcRenderer.invoke('life:album:delete', p),
  lifeHealth: () => ipcRenderer.invoke('life:health'),
  lifeProactiveStatus: (p) => ipcRenderer.invoke('life:proactive:status', p),
  lifeProactiveResetPlan: (p) => ipcRenderer.invoke('life:proactive:resetPlan', p),
  lifeProactiveRun: (p) => ipcRenderer.invoke('life:proactive:run', p),
  lifeProactiveLoop: () => ipcRenderer.invoke('life:proactive:loop'),
  lifeProactiveTickNow: () => ipcRenderer.invoke('life:proactive:tickNow'),
  lifePushGet: () => ipcRenderer.invoke('life:push:get'),
  lifePushSet: (p) => ipcRenderer.invoke('life:push:set', p),
  lifePushTest: (p) => ipcRenderer.invoke('life:push:test', p),
  cloudAgentGet: () => ipcRenderer.invoke('cloud:agent:get'),
  cloudAgentSet: (p) => ipcRenderer.invoke('cloud:agent:set', p),
  cloudAgentTest: (p) => ipcRenderer.invoke('cloud:agent:test', p),
  cloudAgentOpenKeyPage: (p) => ipcRenderer.invoke('cloud:agent:openKeyPage', p),
  cloudAgentProxyInfo: () => ipcRenderer.invoke('cloud:agent:proxyInfo'),
  rosterList: () => ipcRenderer.invoke('roster:list'),
  // Live2D 形象（独立于角色：可命名、可显隐、可换绑）
  live2dList: () => ipcRenderer.invoke('live2d:list'),
  live2dCreate: (p) => ipcRenderer.invoke('live2d:create', p),
  live2dUpdate: (p) => ipcRenderer.invoke('live2d:update', p),
  live2dRemove: (p) => ipcRenderer.invoke('live2d:remove', p),
  live2dBind: (p) => ipcRenderer.invoke('live2d:bind', p),
  live2dPickFolder: () => ipcRenderer.invoke('live2d:pickFolder'),
  live2dActive: () => ipcRenderer.invoke('live2d:active'),
  rosterCreate: (p) => ipcRenderer.invoke('roster:create', p),
  rosterUpdate: (p) => ipcRenderer.invoke('roster:update', p),
  rosterBind: (p) => ipcRenderer.invoke('roster:bind', p),
  rosterUnbindAll: (p) => ipcRenderer.invoke('roster:unbindAll', p),
  rosterSetState: (p) => ipcRenderer.invoke('roster:setState', p),
  rosterTrash: (p) => ipcRenderer.invoke('roster:trash', p),
  rosterRestore: (p) => ipcRenderer.invoke('roster:restore', p),
  // QQ 账号 ↔ 角色 绑定（第 13 个功能的核心面板）
  rosterAccounts: () => ipcRenderer.invoke('roster:accounts'),
  rosterTargets: (p) => ipcRenderer.invoke('roster:targets', p),
  rosterBindChannel: (p) => ipcRenderer.invoke('roster:bindChannel', p),
  rosterUnbindChannel: (p) => ipcRenderer.invoke('roster:unbindChannel', p),
  rosterPushTest: (p) => ipcRenderer.invoke('roster:pushTest', p),
  // 每个角色独立的云端密钥
  rosterCloudGet: (p) => ipcRenderer.invoke('roster:cloud:get', p),
  rosterCloudSet: (p) => ipcRenderer.invoke('roster:cloud:set', p),
  rosterCloudClearKey: (p) => ipcRenderer.invoke('roster:cloud:clearKey', p),
  rosterCloudTest: (p) => ipcRenderer.invoke('roster:cloud:test', p),

  // ── S7：视觉与媒体 ──
  pickFile: (p) => ipcRenderer.invoke('dialog:pickFile', p),

  // ── S7：语音识别（云端 ASR）──
  asrConfigGet: () => ipcRenderer.invoke('asr:config:get'),
  asrConfigSet: (p) => ipcRenderer.invoke('asr:config:set', p),
  asrTest: (p) => ipcRenderer.invoke('asr:test', p),
  asrOpenUrl: (p) => ipcRenderer.invoke('asr:openUrl', p),
  asrWhisperProbe: () => ipcRenderer.invoke('asr:whisper:probe'),
  asrTranscribe: (p) => ipcRenderer.invoke('asr:transcribe', p),
  asrTranscribeLocal: (p) => ipcRenderer.invoke('asr:transcribe:local', p),

  // ── S7：资源下载中心 ──
  downloadList: () => ipcRenderer.invoke('download:list'),
  downloadEnqueue: (p) => ipcRenderer.invoke('download:enqueue', p),
  downloadPause: (p) => ipcRenderer.invoke('download:pause', p),
  downloadResume: (p) => ipcRenderer.invoke('download:resume', p),
  downloadCancel: (p) => ipcRenderer.invoke('download:cancel', p),
  downloadRemove: (p) => ipcRenderer.invoke('download:remove', p),
  downloadClearFinished: () => ipcRenderer.invoke('download:clearFinished'),
  downloadWhisperModels: () => ipcRenderer.invoke('download:whisperModels'),
  downloadWhisperModel: (p) => ipcRenderer.invoke('download:whisperModel', p),
  onDownloadChanged: (cb) => {
    const h = (_e, tasks) => { try { cb(tasks); } catch (e) { /* ignore */ } };
    ipcRenderer.on('download:changed', h);
    return () => ipcRenderer.removeListener('download:changed', h);
  },
  visionConfigGet: () => ipcRenderer.invoke('vision:config:get'),
  visionConfigSet: (p) => ipcRenderer.invoke('vision:config:set', p),
  visionTest: (p) => ipcRenderer.invoke('vision:test', p),
  visionDescribe: (p) => ipcRenderer.invoke('vision:describe', p),
  visionEvidence: (p) => ipcRenderer.invoke('vision:evidence', p),
  captureSources: () => ipcRenderer.invoke('capture:sources'),
  captureGrants: () => ipcRenderer.invoke('capture:grants'),
  captureGrant: (p) => ipcRenderer.invoke('capture:grant', p),
  captureRevoke: (p) => ipcRenderer.invoke('capture:revoke', p),
  captureTake: (p) => ipcRenderer.invoke('capture:take', p),

  // ── S6：图片生成 ──
  imageConfigGet: () => ipcRenderer.invoke('image:config:get'),
  imageConfigSet: (p) => ipcRenderer.invoke('image:config:set', p),
  imageDevice: () => ipcRenderer.invoke('image:device'),
  imageDeviceRefresh: () => ipcRenderer.invoke('image:device:refresh'),
  imageTiers: () => ipcRenderer.invoke('image:tiers'),
  imageProbe: () => ipcRenderer.invoke('image:probe'),
  imageGenerate: (p) => ipcRenderer.invoke('image:generate', p),
  imageQuota: () => ipcRenderer.invoke('image:quota'),
  imageCloudTest: () => ipcRenderer.invoke('image:cloud:test'),
  imageComfyuiTest: (p) => ipcRenderer.invoke('image:comfyui:test', p),
  imageComfyuiGuide: () => ipcRenderer.invoke('image:comfyui:guide'),
  imageDiagnose: () => ipcRenderer.invoke('image:diagnose'),
  imageFix: (p) => ipcRenderer.invoke('image:fix', p),

  qqSnapshot: () => ipcRenderer.invoke('qq:snapshot'),
  qqAccountAdd: (p) => ipcRenderer.invoke('qq:account:add', p),
  qqAccountRemove: (p) => ipcRenderer.invoke('qq:account:remove', p),
  qqAccountStart: (p) => ipcRenderer.invoke('qq:account:start', p),
  qqAccountStop: (p) => ipcRenderer.invoke('qq:account:stop', p),
  qqPolicySet: (p) => ipcRenderer.invoke('qq:policy:set', p),
  qqLimitsSet: (p) => ipcRenderer.invoke('qq:limits:set', p),
  qqPortsList: () => ipcRenderer.invoke('qq:ports:list'),
  qqPortsPreview: (p) => ipcRenderer.invoke('qq:ports:preview', p),
  qqPortsCheck: (p) => ipcRenderer.invoke('qq:ports:check', p),
  qqAccountAddAuto: (p) => ipcRenderer.invoke('qq:account:addAuto', p),
  qqNapCatConfig: (p) => ipcRenderer.invoke('qq:napcat:config', p),
  qqAdapterList: () => ipcRenderer.invoke('qq:adapter:list'),
  qqAdapterLatest: (p) => ipcRenderer.invoke('qq:adapter:latest', p),
  qqAdapterDownload: (p) => ipcRenderer.invoke('qq:adapter:download', p),
  qqAdapterVerify: (p) => ipcRenderer.invoke('qq:adapter:verify', p),
  qqAdapterOpenFolder: () => ipcRenderer.invoke('qq:adapter:openFolder'),
  onQqAdapterProgress: (cb) => {
    const h = (_e, ev) => cb(ev);
    ipcRenderer.on('qq:adapter:progress', h);
    return () => ipcRenderer.removeListener('qq:adapter:progress', h);
  },
  qqStateKill: () => ipcRenderer.invoke('qq:state:kill'),
  qqStateProbe: () => ipcRenderer.invoke('qq:state:probe'),
  qqLoginQrcode: () => ipcRenderer.invoke('qq:login:qrcode'),
  qqLoginRefreshQr: () => ipcRenderer.invoke('qq:login:refreshQr'),
  qqLoginProbe: () => ipcRenderer.invoke('qq:login:probe'),
  qqLoginStatus: () => ipcRenderer.invoke('qq:login:status'),
  qqLoginLaunch: () => ipcRenderer.invoke('qq:login:launch'),
  qqLoginConfig: (p) => ipcRenderer.invoke('qq:login:config', p),
  // 多 QQ 账号：NapCat 多实例
  qqEnsureSelfId: (label) => ipcRenderer.invoke('qq:selfId', { label }),
  qqInstancesList: () => ipcRenderer.invoke('qq:instances:list'),
  qqInstancesAdd: (p) => ipcRenderer.invoke('qq:instances:add', p),
  qqInstancesRemove: (p) => ipcRenderer.invoke('qq:instances:remove', p),
  qqInstancesLaunch: (p) => ipcRenderer.invoke('qq:instances:launch', p),
  qqInstancesQrcode: (p) => ipcRenderer.invoke('qq:instances:qrcode', p),
  qqInstancesStatus: (p) => ipcRenderer.invoke('qq:instances:status', p),
  qqInstancesBindAccount: (p) => ipcRenderer.invoke('qq:instances:bindAccount', p),
  qqInstancesDiag: (p) => ipcRenderer.invoke('qq:instances:diag', p),
  qqInstancesKill: (p) => ipcRenderer.invoke('qq:instances:kill', p),
  qqInstancesHideWindow: (p) => ipcRenderer.invoke('qq:instances:hideWindow', p),
  qqInstancesRelogin: (p) => ipcRenderer.invoke('qq:instances:relogin', p),
  qqPolicyGet: (p) => ipcRenderer.invoke('qq:policy:get', p),
  qqCodecProbe: (p) => ipcRenderer.invoke('qq:codec:probe', p),
  qqCodecStatus: () => ipcRenderer.invoke('qq:codec:status'),
  qqAutoSet: (p) => ipcRenderer.invoke('qq:auto:set', p),
  qqAutoStop: (p) => ipcRenderer.invoke('qq:auto:stop', p),
  qqProbe: (p) => ipcRenderer.invoke('qq:probe', p),
  qqRefreshGroups: (p) => ipcRenderer.invoke('qq:refresh:groups', p),
  qqRefreshFriends: (p) => ipcRenderer.invoke('qq:refresh:friends', p),
  memoryStorageStats: () => ipcRenderer.invoke('memory:storage:stats'),
  memoryDropLegacyColumn: () => ipcRenderer.invoke('memory:dropLegacyEmbeddingColumn'),
  memoryBackfillQuantized: (batch) => ipcRenderer.invoke('memory:quantize:backfill', { batch }),
  memoryConfigGet: () => ipcRenderer.invoke('memory:config:get'),
  memoryConfigSet: (cfg) => ipcRenderer.invoke('memory:config:set', cfg),
  memoryDecayStatus: () => ipcRenderer.invoke('memory:decay:status'),
  memoryDecayPreview: () => ipcRenderer.invoke('memory:decay:preview'),
  memoryDecayRun: () => ipcRenderer.invoke('memory:decay:run'),
  memoryWriterStatus: () => ipcRenderer.invoke('memory:writer:status'),
  setMemoryWriterEnabled: (enabled) => ipcRenderer.invoke('memory:writer:setEnabled', { enabled }),
  vectorStatus: () => ipcRenderer.invoke('vector:status'),
  setVectorMode: (mode) => ipcRenderer.invoke('vector:setMode', { mode }),
  memorySetPinned: (payload) => ipcRenderer.invoke('memory:setPinned', payload),
  memoryFaded: (payload) => ipcRenderer.invoke('memory:faded', payload),
  memoryConflicts: (payload) => ipcRenderer.invoke('memory:conflicts', payload),
  memoryDetectConflicts: (payload) => ipcRenderer.invoke('memory:conflicts:detect', payload),
  memoryRecent: (payload) => ipcRenderer.invoke('memory:recent', payload),
  memoryCreateConflict: (payload) => ipcRenderer.invoke('memory:conflict:create', payload),
  memoryResolveConflict: (payload) => ipcRenderer.invoke('memory:conflict:resolve', payload),
  memoryResolveConflictWith: (payload) => ipcRenderer.invoke('memory:conflict:resolveWith', payload),
  memoryPendingShares: (payload) => ipcRenderer.invoke('memory:pendingShares', payload),
  memoryDecideShare: (payload) => ipcRenderer.invoke('memory:share:decide', payload),
  memoryRequestShare: (payload) => ipcRenderer.invoke('memory:share:request', payload),
  memorySearch: (payload) => ipcRenderer.invoke('memory:search', payload),
  memoryStats: (payload) => ipcRenderer.invoke('memory:stats', payload),
  memoryDelete: (payload) => ipcRenderer.invoke('memory:delete', payload),
  memoryRestore: (payload) => ipcRenderer.invoke('memory:restore', payload),
  memoryCreate: (payload) => ipcRenderer.invoke('memory:create', payload),
  memoryCharacters: () => ipcRenderer.invoke('memory:characters'),
  agentTokensStatus: () => ipcRenderer.invoke('agent:tokens:status'),
  setAgentUsdToCny: (value) => ipcRenderer.invoke('agent:rate:set', { value }),
  setAgentWarnRatio: (value) => ipcRenderer.invoke('agent:warn:set', { value }),
  onAgentStream: (cb) => {
    const h = (_e, ev) => cb(ev);
    ipcRenderer.on('agent:stream', h);
    return () => ipcRenderer.removeListener('agent:stream', h);
  },
  notifyBackgroundChanged: (state) => ipcRenderer.invoke('background:notify', state),
  onBackgroundChanged: (cb) => {
    const h = (_e, state) => cb(state);
    ipcRenderer.on('background:changed', h);
    return () => ipcRenderer.removeListener('background:changed', h);
  },
  petDragStart: (p2) => ipcRenderer.send('pet:drag:start', p2),
  petDragEnd: () => ipcRenderer.send('pet:drag:end'),
});
