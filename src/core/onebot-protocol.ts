/**
 * SoulWeave S5：OneBot v11 协议层（纯函数，无网络、无副作用）
 *
 * 【为什么单独一层】
 * 协议解析和连接管理必须分开：
 *   - 协议层是纯函数 → 可以脱离 QQ 后端完整单测
 *   - 连接层只负责收发字节 → 换后端不影响解析
 *
 * 【为什么只依赖 OneBot v11】
 * NapCat / SnowLuma / Lagrange 都实现同一套 OneBot v11。
 * 任何一家被封控、停更，用户换一个后端即可，应用代码不用动。
 * 所以这里**不出现任何具体实现的名字**。
 */

// ─── 消息段 ────────────────────────────────────────────

export type MessageSegment =
  | { type: 'text'; data: { text: string } }
  | { type: 'image'; data: { file: string; url?: string; summary?: string } }
  | { type: 'face'; data: { id: string } }
  | { type: 'record'; data: { file: string; url?: string } }
  | { type: 'at'; data: { qq: string } }
  | { type: 'reply'; data: { id: string } }
  | { type: 'unknown'; data: { rawType: string } };

export interface Message {
  segments: MessageSegment[];
}

/** 把 OneBot 的 message 字段（数组或 CQ 码字符串）统一成消息段数组 */
export function normalizeMessage(raw: unknown): MessageSegment[] {
  if (raw === null || raw === undefined) return [];

  // 数组形式（推荐）
  if (Array.isArray(raw)) {
    const out: MessageSegment[] = [];
    for (const seg of raw) {
      if (!seg || typeof seg !== 'object') continue;
      const s = seg as { type?: unknown; data?: unknown };
      const type = typeof s.type === 'string' ? s.type : '';
      const data = (s.data && typeof s.data === 'object' ? s.data : {}) as Record<string, unknown>;
      const str = (k: string): string => (typeof data[k] === 'string' ? String(data[k]) : '');
      switch (type) {
        case 'text': out.push({ type: 'text', data: { text: str('text') } }); break;
        case 'image': out.push({ type: 'image', data: { file: str('file'), url: str('url') || undefined, summary: str('summary') || undefined } }); break;
        case 'face': out.push({ type: 'face', data: { id: str('id') } }); break;
        case 'record': out.push({ type: 'record', data: { file: str('file'), url: str('url') || undefined } }); break;
        case 'at': out.push({ type: 'at', data: { qq: str('qq') } }); break;
        case 'reply': out.push({ type: 'reply', data: { id: str('id') } }); break;
        default: out.push({ type: 'unknown', data: { rawType: type } }); break;
      }
    }
    return out;
  }

  // 字符串形式（CQ 码）
  if (typeof raw === 'string') return parseCqCode(raw);
  return [];
}

/**
 * 解析 CQ 码字符串。
 *
 * 转义规则（OneBot v11 规范）：
 *   &#91; → [   &#93; → ]   &#44; → ,   &amp; → &
 * 必须先反转义再解析，否则含逗号的文本会被错误切分。
 */
export function parseCqCode(text: string): MessageSegment[] {
  const s = String(text || '');
  if (!s) return [];

  const out: MessageSegment[] = [];
  const re = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(s)) !== null) {
    if (m.index > last) {
      const plain = unescapeCq(s.slice(last, m.index));
      if (plain) out.push({ type: 'text', data: { text: plain } });
    }
    const type = m[1];
    const data = parseCqParams(m[2]);
    const str = (k: string) => (typeof data[k] === 'string' ? String(data[k]) : '');
    switch (type) {
      case 'text': out.push({ type: 'text', data: { text: unescapeCq(str('text')) } }); break;
      case 'image': out.push({ type: 'image', data: { file: str('file'), url: str('url') || undefined } }); break;
      case 'face': out.push({ type: 'face', data: { id: str('id') } }); break;
      case 'record': out.push({ type: 'record', data: { file: str('file'), url: str('url') || undefined } }); break;
      case 'at': out.push({ type: 'at', data: { qq: str('qq') } }); break;
      case 'reply': out.push({ type: 'reply', data: { id: str('id') } }); break;
      default: out.push({ type: 'unknown', data: { rawType: type } }); break;
    }
    last = m.index + m[0].length;
  }

  if (last < s.length) {
    const plain = unescapeCq(s.slice(last));
    if (plain) out.push({ type: 'text', data: { text: plain } });
  }
  return out;
}

function parseCqParams(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const s = String(raw || '').replace(/^,/, '');
  if (!s) return out;
  for (const part of s.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/** CQ 码反转义（注意 & 必须最后处理，否则会二次转义） */
export function unescapeCq(s: string): string {
  return String(s || '')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&');
}

/** 转义成 CQ 码安全文本 */
export function escapeCq(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/,/g, '&#44;');
}

/** 消息段数组 → 纯文本（用于喂给模型 / 存记忆） */
export function segmentsToText(segs: MessageSegment[]): string {
  const parts: string[] = [];
  for (const s of segs) {
    switch (s.type) {
      case 'text': parts.push(s.data.text); break;
      case 'image': parts.push(s.data.summary ? '[图片:' + s.data.summary + ']' : '[图片]'); break;
      case 'face': parts.push('[表情]'); break;
      case 'record': parts.push('[语音]'); break;
      case 'at': parts.push('@' + s.data.qq); break;
      case 'reply': break;      // 引用不进入文本
      default: break;
    }
  }
  return parts.join('').trim();
}

/** 纯文本 → 消息段（发消息用） */
export function textToSegments(text: string): MessageSegment[] {
  const t = String(text || '');
  return t ? [{ type: 'text', data: { text: t } }] : [];
}

// ─── 事件 ──────────────────────────────────────────────

export type OneBotEventKind =
  | 'message_private' | 'message_group' | 'notice' | 'request' | 'meta' | 'unknown';

export interface OneBotEventBase {
  kind: OneBotEventKind;
  /** 事件唯一 ID（用于幂等去重） */
  eventId: string;
  time: number;
  selfId: string;
}

/** 从消息段里数图片张数（纯函数） */
export function countImages(segs: MessageSegment[] | null | undefined): number {
  if (!Array.isArray(segs)) return 0;
  return segs.filter((s) => s && s.type === 'image').length;
}

export interface OneBotMessageEvent extends OneBotEventBase {
  kind: 'message_private' | 'message_group';
  messageId: string;
  userId: string;
  /** 群消息才有 */
  groupId: string | null;
  segments: MessageSegment[];
  text: string;
  rawMessage: string;
  sender: { userId: string; nickname: string; card: string; role: 'owner' | 'admin' | 'member' | null };
  /** 是否 @ 了机器人自己 */
  atSelf: boolean;
  /**
   * 图片理解的结果（S7）。
   *
   * 为什么挂在事件上而不是 decision 上：
   * 图片理解是异步的、可能失败的，而 decision 在它之前就定下来了。
   * 挂事件上，上层随时能读，读不到就是没识别。
   */
  imageDescription?: string;
  /** 这条消息里有几张图 */
  imageCount?: number;
}

export interface OneBotOtherEvent extends OneBotEventBase {
  kind: 'notice' | 'request' | 'meta' | 'unknown';
  postType: string;
  subType: string;
}

export type OneBotEvent = OneBotMessageEvent | OneBotOtherEvent;

/** 判断一个原始对象是不是消息事件 */
export function isMessageEvent(raw: any): boolean {
  return !!raw && raw.post_type === 'message' &&
    (raw.message_type === 'private' || raw.message_type === 'group');
}

/**
 * 把原始事件对象规范化。
 *
 * 注意 eventId 的取法：
 *   OneBot 的 message_id 在不同后端类型不一（数字/字符串），且私聊可能重复，
 *   所以幂等键用 message_id + 会话键，见 messageDedupKey()。
 */
export function normalizeEvent(raw: any, selfIdHint = ''): OneBotEvent | null {
  if (!raw || typeof raw !== 'object') return null;

  const selfId = String(raw.self_id ?? selfIdHint ?? '');
  const time = Number(raw.time) || Math.floor(Date.now() / 1000);

  if (isMessageEvent(raw)) {
    const isGroup = raw.message_type === 'group';
    const segments = normalizeMessage(raw.message);
    const text = segmentsToText(segments);
    const senderRaw = raw.sender && typeof raw.sender === 'object' ? raw.sender : {};
    const sender = {
      userId: String(raw.user_id ?? ''),
      nickname: String(senderRaw.nickname ?? ''),
      card: String(senderRaw.card ?? ''),
      role: (['owner', 'admin', 'member'].includes(String(senderRaw.role))
        ? String(senderRaw.role) : null) as 'owner' | 'admin' | 'member' | null,
    };
    const messageId = String(raw.message_id ?? '');
    return {
      kind: isGroup ? 'message_group' : 'message_private',
      eventId: messageId || (String(raw.user_id ?? '') + ':' + time),
      time,
      selfId,
      messageId,
      userId: sender.userId,
      groupId: isGroup ? String(raw.group_id ?? '') : null,
      segments,
      text,
      rawMessage: typeof raw.raw_message === 'string' ? raw.raw_message : text,
      sender,
      atSelf: segments.some(s => s.type === 'at' && s.data.qq === selfId),
      imageCount: countImages(segments),
    };
  }

  const postType = String(raw.post_type ?? '');
  const kind: OneBotEventKind =
    postType === 'notice' ? 'notice' :
    postType === 'request' ? 'request' :
    postType === 'meta_event' ? 'meta' : 'unknown';

  return {
    kind,
    eventId: String(raw.notice_type ?? raw.request_type ?? postType) + ':' + String(raw.user_id ?? '') + ':' + time,
    time,
    selfId,
    postType,
    subType: String(raw.sub_type ?? raw.notice_type ?? ''),
  };
}

/**
 * 幂等去重键。
 *
 * 断线重连后 OneBot 可能重投同一事件，必须能识别出来。
 * 群消息：群号 + 消息 ID 已唯一；私聊：消息 ID 在不同后端可能不唯一，
 * 所以带上用户 ID 与时间。
 */
export function messageDedupKey(ev: OneBotMessageEvent): string {
  const conv = ev.kind === 'message_group' ? 'g:' + ev.groupId : 'p:' + ev.userId;
  return conv + ':' + ev.messageId + ':' + ev.time;
}

// ─── 动作（出站）─────────────────────────────────────────

export interface ActionRequest {
  action: string;
  params: Record<string, unknown>;
  echo?: string;
}

export function buildSendPrivateMsg(userId: string, segments: MessageSegment[]): ActionRequest {
  return { action: 'send_private_msg', params: { user_id: Number(userId) || userId, message: segments } };
}

export function buildSendGroupMsg(groupId: string, segments: MessageSegment[]): ActionRequest {
  return { action: 'send_group_msg', params: { group_id: Number(groupId) || groupId, message: segments } };
}

/**
 * 构造 send_msg：让 OneBot 按 message_type 自动选私聊/群聊。
 *
 * 相比分别调 send_private_msg / send_group_msg，
 * 少一个分支就少一处「群号传成用户号」的错。
 */
export function buildSendMsg(
  target: { kind: 'private' | 'group'; id: string },
  segments: MessageSegment[],
): ActionRequest {
  const params: Record<string, unknown> = { message_type: target.kind, message: segments };
  if (target.kind === 'group') params.group_id = Number(target.id) || target.id;
  else params.user_id = Number(target.id) || target.id;
  return { action: 'send_msg', params };
}

export interface ActionResponse {
  status: 'ok' | 'failed' | 'async' | 'unknown';
  retcode: number;
  data: any;
  echo?: string;
}

export function parseActionResponse(raw: any, echo?: string): ActionResponse {
  if (!raw || typeof raw !== 'object') {
    return { status: 'unknown', retcode: -1, data: null, echo };
  }
  const st = String(raw.status ?? '');
  const status: ActionResponse['status'] =
    st === 'ok' ? 'ok' : st === 'failed' ? 'failed' : st === 'async' ? 'async' : 'unknown';
  return {
    status,
    retcode: Number(raw.retcode) || 0,
    data: raw.data ?? null,
    echo,
  };
}

// ─── 群/好友信息 ─────────────────────────────────────────

export interface GroupInfo { groupId: string; groupName: string; }
export interface FriendInfo { userId: string; nickname: string; remark: string; }

export function normalizeGroupList(raw: any): GroupInfo[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((g: any) => ({
    groupId: String(g?.group_id ?? ''),
    groupName: String(g?.group_name ?? ''),
  })).filter(g => g.groupId);
}

export function normalizeFriendList(raw: any): FriendInfo[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((f: any) => ({
    userId: String(f?.user_id ?? ''),
    nickname: String(f?.nickname ?? ''),
    remark: String(f?.remark ?? ''),
  })).filter(f => f.userId);
}

// ─── 安全 ──────────────────────────────────────────────

/**
 * 日志脱敏：访问令牌绝不能被写进日志。
 *
 * 规划里的发布阻断条件明确写着「QQ 登录凭据泄漏到日志或 Git」。
 * 所以所有 URL 在落日志前必须过这一层。
 */
export function redactUrl(url: string): string {
  const s = String(url || '');
  return s.replace(/([?&](?:access_token|token|key|ticket)=)[^&]*/gi, '$1***');
}

/** 掩码 QQ 号：日志里只留首尾 */
export function maskQq(qq: string): string {
  const s = String(qq || '');
  if (s.length <= 4) return '***';
  return s.slice(0, 2) + '*'.repeat(Math.max(1, s.length - 4)) + s.slice(-2);
}
