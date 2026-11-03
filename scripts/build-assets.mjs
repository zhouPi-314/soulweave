/**
 * 构建期静态资源拷贝。
 *
 * 【为什么需要】
 * 打包后 `src/` 不进安装包，但 preload 和 splash 是**运行时**要读的文件：
 *   - preload/index.cjs  —— BrowserWindow 的 preload，缺了 window.soulweave 就没了
 *   - main/splash.html   —— 启动页
 * 以前只在开发时跑得通，因为路径直接指向 src/。
 * 现在统一拷进 dist/，开发与打包读同一份。
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const jobs = [
  ['src/main/splash.html', 'dist/main/splash.html'],
  ['src/preload/index.cjs', 'dist/preload/index.cjs'],
  ['src/preload/setup-preload.cjs', 'dist/preload/setup-preload.cjs'],
];

for (const [from, to] of jobs) {
  const src = path.join(root, from);
  const dst = path.join(root, to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log('[build-assets] ' + from + ' -> ' + to);
}
