import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = new Set();

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  }));
  return nested.flat().filter((file) => file.endsWith('.html'));
}

const pageNames = {
  'index.html': '首页',
  'features.html': '功能',
  'download.html': '下载',
  'releases.html': '版本',
  'announcements.html': '公告',
  'about.html': '关于',
  'privacy.html': '关于',
};

function header(prefix, active) {
  const links = [
    ['index.html', '首页'],
    ['features.html', '功能'],
    ['download.html', '下载'],
    ['docs/index.html', '文档'],
    ['releases.html', '版本'],
    ['announcements.html', '公告'],
    ['about.html', '关于'],
    ['https://github.com/zhouPi-314/soulweave', 'GitHub'],
  ].map(([href, label]) => {
    const target = href.startsWith('http') ? href : `${prefix}${href}`;
    const current = label === active ? ' aria-current="page"' : '';
    return `      <a href="${target}"${current}>${label}</a>`;
  }).join('\n');

  return `<header class="nav">
  <div class="wrap nav-in">
    <a class="brand" href="${prefix}index.html" aria-label="SoulWeave 首页">
      <svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="12" fill="#5baeff"/><circle cx="16" cy="16" r="4.5" fill="#fff"/><path d="M16 3v5M16 24v5M3 16h5M24 16h5" stroke="#267ac5" stroke-width="2" stroke-linecap="round"/></svg>
      <span>SoulWeave<small>奇点跃迁 · SINGULIFT</small></span>
    </a>
    <nav class="nav-links" aria-label="主导航">
${links}
    </nav>
  </div>
</header>`;
}

function footer(prefix) {
  return `<footer>
  <div class="wrap">
    <div class="footer-top">
      <div class="footer-brand">
        <a class="brand" href="${prefix}index.html">
          <svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="12" fill="#5baeff"/><circle cx="16" cy="16" r="4.5" fill="#fff"/><path d="M16 3v5M16 24v5M3 16h5M24 16h5" stroke="#267ac5" stroke-width="2" stroke-linecap="round"/></svg>
          <span>SoulWeave<small>奇点跃迁 · SINGULIFT</small></span>
        </a>
        <p>一个让数字生命真正鲜活起来的世界。Weave Memories. Shape Identity. Create Digital Life.</p>
      </div>
      <div class="footer-grid">
        <div><b>产品</b><a href="${prefix}features.html">功能能力</a><a href="${prefix}download.html">下载</a><a href="${prefix}releases.html">版本</a></div>
        <div><b>资源</b><a href="${prefix}docs/index.html">文档</a><a href="${prefix}releases.html">版本与校验</a><a href="${prefix}announcements.html">公告</a></div>
        <div><b>项目</b><a href="${prefix}about.html">关于</a><a href="${prefix}privacy.html">隐私</a><a href="https://github.com/zhouPi-314/soulweave">GitHub</a></div>
      </div>
    </div>
    <div class="footer-bottom">
      <span>A Singulift Project · 始于奇点，跃迁无限。</span>
      <span>Apache-2.0 · 本站无第三方统计 · 角色与模型素材遵循各自许可</span>
    </div>
  </div>
</footer>`;
}

function docsSidebar(current) {
  const item = (href, label) => `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<aside class="side" aria-label="文档目录">
    <span class="side-group">快速开始</span>
    ${item('index.html', '文档首页')}
    ${item('install.html', '安装')}
    ${item('first-run.html', '首次启动')}
    <span class="side-group">连接与配置</span>
    ${item('qq.html', 'QQ 接入')}
    ${item('api.html', '云端模型与 Key')}
    <span class="side-group">安全与支持</span>
    ${item('permissions.html', '权限与审批')}
    ${item('troubleshooting.html', '排障')}
    ${item('faq.html', 'FAQ')}
  </aside>`;
}

for (const file of await walk(root)) {
  if (skip.has(path.relative(root, file).replaceAll('\\', '/'))) continue;
  const inDocs = path.dirname(file).endsWith('docs');
  const prefix = inDocs ? '../' : '';
  const base = path.basename(file);
  const active = inDocs ? '文档' : (base === '404.html' ? '' : pageNames[base]);
  let source = await readFile(file, 'utf8');
  source = source.replace(/<header class="nav">[\s\S]*?<\/header>/, header(prefix, active));
  source = source.replace(/<footer>[\s\S]*?<\/footer>/, footer(prefix));
  if (inDocs) source = source.replace(/<aside class="side"[\s\S]*?<\/aside>/, docsSidebar(base));
  source = source.replace(/\sstyle="[^"]*"/g, '');
  source = source.replace(/<link rel="stylesheet" href="(?:\.\.\/)?assets\/site\.css">/g, '<link rel="stylesheet" href="assets/style.css">');
  await writeFile(file, source);
}
