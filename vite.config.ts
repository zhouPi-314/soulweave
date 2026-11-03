import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(__dirname, 'src', 'renderer'),
  base: './',
  publicDir: path.resolve(__dirname, 'public'),
  resolve: {
    alias: {
      '@framework': path.resolve(__dirname, 'vendor', 'cubism-framework', 'src'),
    },
    extensions: ['.ts', '.js'],
  },
  build: {
    outDir: path.resolve(__dirname, 'dist', 'renderer'),
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: false,
    rollupOptions: {
      // S3-12：多页 —— 主窗口（角色）与设置中心窗口是两个独立页面
      input: {
        main: path.resolve(__dirname, 'src', 'renderer', 'index.html'),
        settings: path.resolve(__dirname, 'src', 'renderer', 'settings.html'),
        setup: path.resolve(__dirname, 'src', 'renderer', 'setup.html'),
      },
    },
  },
});
