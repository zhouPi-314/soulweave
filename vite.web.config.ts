import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 手机 Web 的构建配置（S8）
 *
 * 和桌面 renderer 分开构建：
 *   - 目标定 chrome100 / safari15，比桌面（chrome120）保守，因为手机系统更新慢
 *   - 不做 sourcemap，产物要能直接给局域网里的浏览器
 *   - base './' 让 index.html 用相对路径引用 assets，挂在任何子路径下都能跑
 */
export default defineConfig({
  root: path.resolve(__dirname, 'src', 'web'),
  base: './',
  resolve: { extensions: ['.ts', '.js'] },
  build: {
    outDir: path.resolve(__dirname, 'dist', 'web'),
    emptyOutDir: true,
    target: ['chrome100', 'safari15'],
    sourcemap: false,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
