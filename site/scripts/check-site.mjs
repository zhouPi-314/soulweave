import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  }));
  return nested.flat();
}

function relative(file) {
  return path.relative(root, file).replaceAll('\\', '/');
}

function requireText(file, source, tests) {
  for (const [description, pattern] of tests) {
    if (!pattern.test(source)) failures.push(`${relative(file)}: ${description}`);
  }
}

const files = await walk(root);
const htmlFiles = files.filter((file) => file.endsWith('.html'));
const canonicalNav = ['首页', '功能', '下载', '文档', '版本', '公告', '关于', 'GitHub'];

for (const file of htmlFiles) {
  const source = await readFile(file, 'utf8');
  const stylesheet = source.match(/<link rel="stylesheet" href="([^"]+)">/g) || [];
  if (stylesheet.length !== 1 || !stylesheet[0].endsWith('assets/style.css">')) {
    failures.push(`${relative(file)}: must load only the canonical assets/style.css`);
  }
  if (/\sstyle="/.test(source)) failures.push(`${relative(file)}: inline style attribute found`);
  if (/https:\/\/github\.com\/["']/.test(source)) {
    failures.push(`${relative(file)}: generic GitHub placeholder link found`);
  }

  const nav = source.match(/<nav class="nav-links"[^>]*>([\s\S]*?)<\/nav>/);
  if (!nav) {
    failures.push(`${relative(file)}: shared navigation not found`);
  } else {
    const labels = [...nav[1].matchAll(/<a\b[^>]*>([^<]+)<\/a>/g)].map((match) => match[1].trim());
    if (labels.join('|') !== canonicalNav.join('|')) {
      failures.push(`${relative(file)}: navigation order is ${labels.join(' / ') || 'empty'}`);
    }
    if (path.basename(file) !== '404.html' && !nav[1].includes('aria-current="page"')) {
      failures.push(`${relative(file)}: navigation lacks aria-current="page"`);
    }
  }

  for (const match of source.matchAll(/<img\b([^>]*)>/g)) {
    if (!/\balt="[^"]*"/.test(match[1])) failures.push(`${relative(file)}: image without alt`);
    if (!/\bwidth="\d+"/.test(match[1]) || !/\bheight="\d+"/.test(match[1])) {
      failures.push(`${relative(file)}: image without intrinsic width and height`);
    }
  }

  for (const match of source.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const link = match[1];
    if (/^(?:https?:|#|mailto:|data:)/.test(link)) continue;
    const target = path.resolve(path.dirname(file), link.split(/[?#]/)[0]);
    try {
      await stat(target);
    } catch {
      failures.push(`${relative(file)}: missing local target ${link}`);
    }
  }
}

const index = await readFile(path.join(root, 'index.html'), 'utf8');
requireText(path.join(root, 'index.html'), index, [
  ['hero must use the single brand banner', /assets\/brand\/soulweave-hero-20261104\.webp/],
  ['hero must explain Windows digital life', /Windows 数字生命桌面软件/],
  ['multi-character positioning missing', /多角色数字生命体验/],
  ['product screenshots section missing', /id="inside"/],
  ['local first section missing', /id="local-first"/],
  ['screenshot gallery marker missing', /data-gallery/],
]);

const download = await readFile(path.join(root, 'download.html'), 'utf8');
requireText(path.join(root, 'download.html'), download, [
  ['public candidate release status missing', /公开候选版/],
  ['minimum requirements missing', /最低配置/],
  ['recommended requirements missing', /推荐配置/],
  ['SHA-256 verification missing', /SHA-256/],
  ['installation flow missing', /安装流程/],
]);

const releases = await readFile(path.join(root, 'releases.html'), 'utf8');
requireText(path.join(root, 'releases.html'), releases, [
  ['current candidate version missing', /0\.1\.0-s1/],
  ['development milestone missing', /0\.1\.0-s0/],
  ['planning baseline missing', /V1\.7（规划基线）/],
  ['publication status missing', /公开候选版/],
]);

const app = await readFile(path.join(root, 'assets/app.js'), 'utf8');
requireText(path.join(root, 'assets/app.js'), app, [
  ['mobile navigation toggle missing', /nav-toggle/],
  ['code copy interaction missing', /copy/i],
  ['image lightbox interaction missing', /dialog/],
]);

if (failures.length) {
  console.error(`Site check failed with ${failures.length} issue(s):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log(`Site check passed: ${htmlFiles.length} HTML pages, canonical navigation and assets verified.`);
}
