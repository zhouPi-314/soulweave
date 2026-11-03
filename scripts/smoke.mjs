/**
 * S1 冒烟测试：启动 → 等待 Live2D → 截图 → 读诊断 → 退出
 */
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = (process.env.SOULWEAVE_TMP || '.');

const logs = [];
const t0 = Date.now();

// 与生产 main 保持一致：userData 必须在 whenReady 之前设置
app.setPath('userData', path.join(ROOT, '.runtime-userdata'));
app.setPath('sessionData', path.join(ROOT, '.runtime-userdata', 'session'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900, height: 700, show: true,
    backgroundColor: '#1a1a1f',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.webContents.on('console-message', (_e, lvl, msg) => logs.push('[c] ' + msg));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => logs.push('[fail] ' + code + ' ' + desc + ' ' + url));

  await win.loadFile(path.join(ROOT, 'dist', 'renderer', 'index.html'));

  // 等 Live2D 就绪
  let ready = null;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      ready = await win.webContents.executeJavaScript(`(() => {
        const s = document.getElementById('status');
        const f = document.getElementById('fps');
        return {
          status: s ? s.textContent : null,
          fps: f ? f.textContent : null,
          hasApp: typeof window.__soulweaveLive2D !== 'undefined',
          hasCore: typeof window.Live2DCubismCore !== 'undefined',
          canvas: (() => { const c = document.getElementById('live2d-canvas');
            return c ? [c.width, c.height] : null; })(),
        };
      })()`);
    } catch (e) { ready = { err: String(e) }; }
    if (ready && ready.status === '运行中') break;
  }

  // 再等 3 秒让帧率稳定
  await new Promise(r => setTimeout(r, 3000));

  const final = await win.webContents.executeJavaScript(`(() => {
    const s = document.getElementById('status');
    const f = document.getElementById('fps');
    return { status: s?.textContent, fps: f?.textContent };
  })()`).catch(e => ({ err: String(e) }));

  // 截图
  const img = await win.webContents.capturePage();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'soulweave-s1.png'), img.toPNG());

  fs.writeFileSync(path.join(OUT, 'soulweave-smoke.json'), JSON.stringify({
    elapsedMs: Date.now() - t0,
    ready, final, logs,
    electron: process.versions.electron,
  }, null, 2));

  console.log('SMOKE_DONE');
  app.quit();
}).catch(e => { console.error('FATAL', e); app.quit(); });
