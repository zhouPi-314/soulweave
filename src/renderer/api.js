/**
 * SoulWeave 渲染层：严格访问 preload 暴露的 API
 *
 * 【为什么需要这个文件】
 * 以前到处写 window.soulweave?.method?.() —— 双可选链。
 * 方法不存在时它**静默什么都不做**，不报错不提示。
 * 「打开设置中心」按钮点不动就是这么来的：preload 漏了 openSettings，
 * 调用变成 undefined?.()，静默吞掉，排查了很久（S3-21）。
 *
 * 现在统一走 swCall()：方法缺失时抛出**带方法名的明确错误**，
 * 让人一眼看出是 preload 漏导出，而不是怀疑界面坏了。
 *
 * 配套：scripts/check-preload.mjs 在 npm test 里静态断言三方对齐，
 * 所以正常情况下这个运行时错误不该出现；它只是最后一道防线。
 */

/** 取 preload 暴露的 API，缺失时立刻报错 */
export function sw() {
  const a = typeof window !== 'undefined' ? window.soulweave : null;
  if (!a) {
    throw new Error('[soulweave] preload 未加载：window.soulweave 不存在');
  }
  return a;
}

/**
 * 调用一个 preload 方法。
 * 方法不存在时抛错，并在错误信息里指明排查方向。
 */
export function swCall(name, ...args) {
  const a = sw();
  const fn = a[name];
  if (typeof fn !== 'function') {
    throw new Error(
      '[soulweave] 方法不存在：' + name +
      '。请检查 preload 是否导出，并运行 npm run test:preload'
    );
  }
  return fn.apply(a, args);
}

/**
 * 订阅事件（onThemeChanged / onWindowStateChanged 这类）。
 * 返回取消订阅函数；方法不存在时抛错。
 */
export function swOn(name, cb) {
  const a = sw();
  const fn = a[name];
  if (typeof fn !== 'function') {
    throw new Error('[soulweave] 事件订阅方法不存在：' + name);
  }
  const off = fn.call(a, cb);
  return typeof off === 'function' ? off : () => {};
}

/**
 * 给事件处理器加保护：出错时打印到控制台，不让异常悄悄消失。
 * 用于那些「不能让整个界面崩掉、但也绝不能静默失败」的交互。
 */
export function guard(label, fn) {
  return function guarded(...args) {
    try {
      const r = fn.apply(this, args);
      if (r && typeof r.catch === 'function') {
        return r.catch((e) => report(label, e));
      }
      return r;
    } catch (e) {
      report(label, e);
    }
  };
}

function report(label, e) {
  // eslint-disable-next-line no-console
  console.error('[soulweave] ' + label + ' 失败：', e);
}
