/**
 * 服务端内联 SVG 图标（与 src/client/admin/icons.ts 同一套设计语言）：
 * 24 viewBox · 方角几何线条 · 单色 + 电光青点缀 · 无 emoji、无渐变。
 * 仅用于可信静态结构，业务数据一律经 esc() 后插入。
 */

const STROKE_ATTRS = `fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"`;

function svg(inner: string, cls: string, size = 16): string {
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" ${STROKE_ATTRS} aria-hidden="true">${inner}</svg>`;
}

/** 品牌标志：深色方版 + 切角文档图形（硬核几何风）。 */
export function logoMark(size = 20, cls = "icon icon-logo"): string {
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><rect x="0.5" y="0.5" width="23" height="23" rx="4.5" fill="#10141C" stroke="#2A3342"/><g fill="none" stroke="#F2F5FA" stroke-width="1.8"><path d="M7.5 5.5h6l3.5 3.5v9.5h-9.5Z"/><path d="M13.5 5.5V9H17"/></g><path d="M10 13h4.5" stroke="#38BDF8" stroke-width="1.8"/></svg>`;
}

export function iconPencil(size = 14, cls = "icon"): string {
  return svg(`<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>`, cls, size);
}

export function iconCheck(size = 14, cls = "icon"): string {
  return svg(`<path d="M5 13l4 4L19 7"/>`, cls, size);
}

/** 主题切换：太阳（当前深色时显示，点击切浅色） */
export function iconSun(size = 16, cls = "icon"): string {
  return svg(
    '<circle cx="12" cy="12" r="4"/>' +
      '<path d="M12 2.5v2"/><path d="M12 19.5v2"/><path d="m4.6 4.6 1.4 1.4"/>' +
      '<path d="m18 18 1.4 1.4"/><path d="M2.5 12h2"/><path d="M19.5 12h2"/>' +
      '<path d="m6 18-1.4 1.4"/><path d="m19.4 4.6-1.4 1.4"/>',
    cls,
    size
  );
}

/** 主题切换：月亮（当前浅色时显示，点击切深色） */
export function iconMoon(size = 16, cls = "icon"): string {
  return svg('<path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z"/>', cls, size);
}

/** 状态图标（/setup 自检页）：通过 / 警告 / 失败 —— 方角对勾 / 实心三角 / 叉 */
export function statusIcon(state: "ok" | "warn" | "fail", size = 16): string {
  if (state === "ok") {
    return `<svg class="icon icon-status-ok" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5 9.5 18 20 6.5" ${STROKE_ATTRS} stroke-width="2"/></svg>`;
  }
  if (state === "warn") {
    return `<svg class="icon icon-status-warn" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 2.8 20h18.4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10v4.5" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="17.2" r="0.5" fill="currentColor" stroke="currentColor"/></svg>`;
  }
  return `<svg class="icon icon-status-fail" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 5 14 14M19 5 5 19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
}
