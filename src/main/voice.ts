/**
 * SoulWeave S3-1：系统语音 provider（Windows SAPI）
 *
 * 为什么从这里开始
 * ─────────────────
 * config-schema 里 voice.primary 已预留 'system' 分支，但一直没实现。
 * 相比 online TTS，system 有三个决定性好处：
 *   - **离线可用**：不依赖网络与密钥，符合「未配置 API 可进入离线界面」
 *   - **零成本**：不产生任何费用
 *   - **能立刻做出真音色**：本机自带中文女声，多角色可以马上分开
 *
 * 代价：音质不如云端、不跨平台。所以它是**降级链的一环**，不是终局。
 * 在线 provider 的实现留作后续，需要用户提供密钥与授权。
 *
 * 架构位置：放在主进程，避免将来把 API 密钥暴露给渲染层。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface SystemVoice {
  id: string;        // SAPI 的 VoiceInfo.Name，用作稳定 ID
  name: string;      // 显示名
  culture: string;   // zh-CN / en-US …
  gender: string;
  age: string;
}

export interface SynthOptions {
  voiceId?: string | null;
  rate?: number;     // -10..10，SAPI 区间
  volume?: number;   // 0..100
}

export interface SynthResult {
  ok: boolean;
  /** data:audio/wav;base64,...（保留兼容；注意 Chromium 拒绝把它作为媒体源） */
  dataUrl?: string;
  /**
   * 裸 base64（不含 data: 前缀）。
   * 渲染层应把它转成 Blob URL 再播放 ——
   * Chromium 的 URL safety check 会拒绝 data: 作为媒体源（实测
   * "Media load rejected by URL safety check"），blob: 才允许。
   */
  base64?: string;
  bytes?: number;
  voiceId?: string | null;
  ms?: number;
  error?: string;
}

const IS_WIN = process.platform === 'win32';

/** 跑一段 PowerShell 并收集 stdout（不弹窗） */
function runPs(script: string, timeoutMs = 20000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { windowsHide: true });

    let out = '';
    let err = '';
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      resolve({ code, out, err });
    };
    const timer = setTimeout(() => {
      try { ps.kill(); } catch (e) { /* ignore */ }
      finish(-1);
    }, timeoutMs);

    ps.stdout.on('data', (d) => { out += d.toString('utf8'); });
    ps.stderr.on('data', (d) => { err += d.toString('utf8'); });
    ps.on('close', (c) => { clearTimeout(timer); finish(c ?? -1); });
    ps.on('error', (e) => { clearTimeout(timer); err += String(e); finish(-1); });
  });
}

let voiceCache: SystemVoice[] | null = null;

/**
 * 列出系统可用音色。
 * 结果缓存：SAPI 音色只在安装/卸载语音包时变化，不必每次都查。
 */
export async function listSystemVoices(force = false): Promise<SystemVoice[]> {
  if (!IS_WIN) return [];
  if (voiceCache && !force) return voiceCache;

  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$s.GetInstalledVoices() | ForEach-Object {',
    '  $i = $_.VoiceInfo',
    '  if ($_.Enabled) { $i.Name + "|" + $i.Culture.Name + "|" + $i.Gender + "|" + $i.Age + "|" + $i.DisplayName }',
    '}',
  ].join('; ');

  const r = await runPs(script, 15000);
  const list: SystemVoice[] = [];
  for (const line of r.out.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || !s.includes('|')) continue;
    const [id, culture, gender, age, display] = s.split('|');
    if (!id) continue;
    list.push({
      id: id.trim(),
      name: (display || id).trim(),
      culture: (culture || '').trim(),
      gender: (gender || '').trim(),
      age: (age || '').trim(),
    });
  }
  if (list.length) voiceCache = list;
  return list;
}

/**
 * 合成语音，返回可直接播放的 data URL。
 *
 * 实现说明：SAPI 只能写文件，所以走「临时 WAV → 读回调 base64 → 立即删除」。
 * 每次合成都起一个 PowerShell 进程，约 0.6~1.5 秒延迟；
 * 后续可优化为常驻进程或进程池，但不影响正确性。
 */
export async function synthesize(text: string, opts: SynthOptions = {}): Promise<SynthResult> {
  const t0 = Date.now();
  if (!IS_WIN) return { ok: false, error: 'system provider 仅支持 Windows' };

  const body = String(text || '').trim();
  if (!body) return { ok: false, error: '文本为空' };
  if (body.length > 2000) return { ok: false, error: '单次合成文本过长（上限 2000 字）' };

  const rate = Math.max(-10, Math.min(10, Number(opts.rate ?? 0)));
  const volume = Math.max(0, Math.min(100, Number(opts.volume ?? 100)));
  const voiceId = opts.voiceId ? String(opts.voiceId) : '';

  const tmp = path.join(os.tmpdir(), 'soulweave-tts-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.wav');

  // 文本通过 Base64 传给 PowerShell，避免引号/特殊字符注入
  const textB64 = Buffer.from(body, 'utf8').toString('base64');

  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$vid = ' + JSON.stringify(voiceId),
    'if ($vid -ne "") { try { $s.SelectVoice($vid) } catch { } }',
    '$s.Rate = ' + rate,
    '$s.Volume = ' + volume,
    '$txt = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(' + JSON.stringify(textB64) + '))',
    '$s.SetOutputToWaveFile(' + JSON.stringify(tmp) + ')',
    '$s.Speak($txt)',
    '$s.Dispose()',
    'Write-Output "OK"',
  ].join('; ');

  try {
    const r = await runPs(script, 25000);
    if (!fs.existsSync(tmp)) {
      return { ok: false, error: (r.err || r.out || '合成失败').slice(0, 300), ms: Date.now() - t0 };
    }
    const buf = fs.readFileSync(tmp);
    if (!buf.length) return { ok: false, error: '合成结果为空', ms: Date.now() - t0 };
    return {
      ok: true,
      dataUrl: 'data:audio/wav;base64,' + buf.toString('base64'),
      base64: buf.toString('base64'),
      bytes: buf.length,
      voiceId: voiceId || null,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, error: String(e), ms: Date.now() - t0 };
  } finally {
    // 尽力清理临时文件，失败不影响结果
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  }
}
