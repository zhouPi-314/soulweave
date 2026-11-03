/* SoulWeave progressive enhancements. The site remains readable without JS. */
(() => {
  'use strict';

  const scriptUrl = document.currentScript ? new URL(document.currentScript.src) : new URL('./assets/app.js', location.href);
  const siteRoot = new URL('../', scriptUrl);

  const escapeHtml = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

  const safeUrl = (value) => {
    if (!value) return '';
    if (/^https:\/\//i.test(value)) return value;
    if (/^\/(?!\/)/.test(value) || /^[a-z0-9._-]+\.html/i.test(value)) return value;
    return '';
  };

  function setupNavigation() {
    const nav = document.querySelector('.nav');
    const links = nav?.querySelector('.nav-links');
    if (!nav || !links) return;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'nav-toggle';
    toggle.setAttribute('aria-label', '打开导航');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = '<span></span>';
    links.id ||= 'site-navigation';
    toggle.setAttribute('aria-controls', links.id);
    nav.classList.add('has-toggle');
    links.parentElement.insertBefore(toggle, links);

    const setOpen = (open) => {
      nav.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? '关闭导航' : '打开导航');
    };

    toggle.addEventListener('click', () => setOpen(!nav.classList.contains('open')));
    links.addEventListener('click', (event) => {
      if (event.target.closest('a')) setOpen(false);
    });
    document.addEventListener('click', (event) => {
      if (nav.classList.contains('open') && !nav.contains(event.target)) setOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setOpen(false);
    });
    window.matchMedia('(min-width: 901px)').addEventListener('change', (event) => {
      if (event.matches) setOpen(false);
    });
  }

  function setupDocNavigation() {
    const side = document.querySelector('.side');
    if (!side) return;
    const article = document.querySelector('.article');
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'doc-nav-toggle';
    toggle.textContent = '展开文档目录';
    toggle.setAttribute('aria-expanded', 'false');
    side.dataset.enhanced = 'true';
    side.id ||= 'document-navigation';
    toggle.setAttribute('aria-controls', side.id);
    side.parentElement.insertBefore(toggle, side);
    toggle.addEventListener('click', () => {
      const open = !side.classList.contains('open');
      side.classList.toggle('open', open);
      toggle.textContent = open ? '收起文档目录' : '展开文档目录';
      toggle.setAttribute('aria-expanded', String(open));
    });
    side.addEventListener('click', (event) => {
      if (event.target.closest('a') && window.matchMedia('(max-width: 900px)').matches) {
        side.classList.remove('open');
        toggle.textContent = '展开文档目录';
        toggle.setAttribute('aria-expanded', 'false');
      }
    });

    if (!article) return;
    const headings = [...article.querySelectorAll('h2[id], h3[id]')];
    if (!headings.length || !('IntersectionObserver' in window)) return;
    const anchors = new Map([...side.querySelectorAll('a[href^="#"]')].map((anchor) => [anchor.getAttribute('href').slice(1), anchor]));
    if (!anchors.size) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      anchors.forEach((anchor) => anchor.removeAttribute('aria-current'));
      anchors.get(visible.target.id)?.setAttribute('aria-current', 'location');
    }, { rootMargin: '-16% 0px -70% 0px' });
    headings.forEach((heading) => observer.observe(heading));
  }

  function setupAnnouncements() {
    const box = document.getElementById('ann-list');
    if (!box) return;
    fetch(new URL('data/announcements.json', siteRoot), { cache: 'no-cache' })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => {
        if (!Array.isArray(data.items) || !data.items.length) {
          box.innerHTML = '<p class="toc-note">暂时没有公告。</p>';
          return;
        }
        const labels = { dev: '开发', fix: '修复', release: '发布', notice: '公告' };
        box.innerHTML = data.items.slice(0, 12).map((item) => {
          const level = Object.hasOwn(labels, item.level) ? item.level : 'notice';
          const link = safeUrl(item.url);
          return `<article class="ann">
            <time datetime="${escapeHtml(item.date)}">${escapeHtml(item.date)}</time>
            <div><span class="lv ${level}">${labels[level]}</span>
              <h3>${escapeHtml(item.title)}</h3>
              <p>${escapeHtml(item.body)}</p>
              ${link ? `<p><a href="${escapeHtml(link)}">查看详情</a></p>` : ''}
            </div>
          </article>`;
        }).join('');
      })
      .catch(() => {
        box.innerHTML = '<p class="toc-note">公告加载失败，请稍后重试。</p>';
      });
  }

  function setupLatestVersion() {
    if (!document.querySelector('[data-latest-version], [data-latest-size], [data-latest-date]')) return;
    fetch(new URL('data/latest.json', siteRoot), { cache: 'no-cache' })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => {
        const set = (selector, value, fallback) => {
          document.querySelectorAll(selector).forEach((element) => {
            element.textContent = value || fallback;
          });
        };
        set('[data-latest-version]', data.version, '查看版本页');
        set('[data-latest-date]', data.date, '以版本页为准');
        set('[data-latest-size]', data.sizeText, '约 255 MB');
      })
      .catch(() => {
        document.querySelectorAll('[data-latest-version]').forEach((element) => {
          element.textContent = '查看版本页';
        });
      });
  }

  function setupCodeCopy() {
    document.querySelectorAll('pre code').forEach((code) => {
      const pre = code.closest('pre');
      if (!pre) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'copy-button';
      button.textContent = '复制';
      button.setAttribute('aria-label', '复制代码');
      pre.classList.add('has-copy');
      button.addEventListener('click', async () => {
        const text = code.textContent || '';
        try {
          await navigator.clipboard.writeText(text);
          button.textContent = '已复制';
        } catch {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(code);
          selection?.removeAllRanges();
          selection?.addRange(range);
          button.textContent = '请按 Ctrl+C';
        }
        window.setTimeout(() => { button.textContent = '复制'; }, 1800);
      });
      pre.append(button);
    });
  }

  function setupGallery() {
    const gallery = document.querySelector('[data-gallery]');
    if (!gallery || !('HTMLDialogElement' in window)) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'gallery-dialog';
    dialog.setAttribute('aria-label', '产品截图预览');
    dialog.innerHTML = '<button type="button" class="gallery-close" aria-label="关闭图片预览">×</button><img alt="">';
    document.body.append(dialog);
    const image = dialog.querySelector('img');
    const close = dialog.querySelector('button');

    gallery.querySelectorAll('img').forEach((source) => {
      const trigger = source.closest('button') || source;
      trigger.addEventListener('click', () => {
        image.src = source.currentSrc || source.src;
        image.alt = source.alt;
        dialog.showModal();
      });
    });
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  setupNavigation();
  setupDocNavigation();
  setupAnnouncements();
  setupLatestVersion();
  setupCodeCopy();
  setupGallery();
})();
