/**
 * 管理后台内联 SVG 图标（与 src/server/icons.ts 同一套设计语言）：
 * 24 viewBox · 方角几何线条 · 单色 + 电光青点缀 · 无 emoji、无渐变。
 * 图标均为静态可信结构，可直接 innerHTML。
 */

interface IconDef {
  /** svg 内部标记（LOGO 为自带颜色的完整标记，其余为 currentColor 描边路径） */
  markup: string;
  /** 自带颜色、不套用 currentColor 描边属性 */
  full?: boolean;
}

const ICONS: Record<string, IconDef> = {
  // 品牌标志：深色方版 + 切角文档图形（与服务端 logoMark 同一图形）
  logo: {
    full: true,
    markup:
      '<rect x="0.5" y="0.5" width="23" height="23" rx="4.5" fill="#10141C" stroke="#2A3342"/>' +
      '<g fill="none" stroke="#F2F5FA" stroke-width="1.8"><path d="M7.5 5.5h6l3.5 3.5v9.5h-9.5Z"/><path d="M13.5 5.5V9H17"/></g>' +
      '<path d="M10 13h4.5" stroke="#38BDF8" stroke-width="1.8"/>',
  },
  menu: { markup: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>' },
  search: { markup: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/>' },
  refresh: { markup: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>' },
  plus: { markup: '<path d="M12 5v14"/><path d="M5 12h14"/>' },
  folder: { markup: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>' },
  doc: {
    markup:
      '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/>',
  },
  pencil: { markup: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>' },
  trash: {
    markup:
      '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  },
  x: { markup: '<path d="m6 6 12 12"/><path d="m18 6-12 12"/>' },
  check: { markup: '<path d="m5 13 4 4L19 7"/>' },
  chevronDown: { markup: '<path d="m6 9 6 6 6-6"/>' },
  arrowLeft: { markup: '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>' },
  history: { markup: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>' },
  external: {
    markup:
      '<path d="M14 4h6v6"/><path d="m20 4-9 9"/><path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"/>',
  },
  logout: {
    markup:
      '<path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  },
  upload: {
    markup:
      '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  },
  gear: {
    markup:
      '<circle cx="12" cy="12" r="3.2"/>' +
      '<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.88Z"/>',
  },
  link: {
    markup:
      '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
      '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  },
  sun: {
    markup:
      '<circle cx="12" cy="12" r="4"/>' +
      '<path d="M12 2.5v2"/><path d="M12 19.5v2"/><path d="m4.6 4.6 1.4 1.4"/>' +
      '<path d="m18 18 1.4 1.4"/><path d="M2.5 12h2"/><path d="M19.5 12h2"/>' +
      '<path d="m6 18-1.4 1.4"/><path d="m19.4 4.6-1.4 1.4"/>',
  },
  moon: { markup: '<path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z"/>' },
  chart: {
    markup: '<path d="M3 3v18h18"/><path d="M7 15v3"/><path d="M12 10v8"/><path d="M17 6v12"/>',
  },
  image: {
    markup:
      '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/>' +
      '<path d="m21 16-4.5-4.5L9 19"/>',
  },
  megaphone: {
    markup:
      '<path d="m3 11 14-6v14L3 13Z"/><path d="M3 11H2.5A1.5 1.5 0 0 0 1 12.5 1.5 1.5 0 0 0 2.5 14H3"/>' +
      '<path d="M7 14v4a2 2 0 0 0 2 2h1"/><path d="M17 8.5a4 4 0 0 1 0 7"/>',
  },
};

/** 返回一个图标元素；name 见 ICONS。size 单位 px，默认 16。 */
export function icon(name: keyof typeof ICONS | string, size = 16): HTMLElement {
  const def = ICONS[name] ?? ICONS.doc!;
  const span = document.createElement("span");
  span.className = "icon";
  span.setAttribute("aria-hidden", "true");
  if (def.full) {
    span.innerHTML =
      `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${def.markup}</svg>`;
  } else {
    span.innerHTML =
      `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"` +
      ` stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${def.markup}</svg>`;
  }
  return span;
}
