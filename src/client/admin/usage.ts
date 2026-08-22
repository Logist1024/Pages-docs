/**
 * Cloudflare 服务用量看板（仅 admin，hash 路由 #/usage）：
 * - D1：各表行数 / 字节估算、文档状态分布、近 30 天版本增长柱状图、内容 TOP5；
 * - R2：对象数与总存储、按月聚合条形图；
 * - KV：页面缓存键数量；
 * - 免费额度参考进度条（额度数值为公开的 Free 套餐参考值，以控制台为准）。
 * 纯 CSS/SVG 可视化，零图表依赖。Workers 的请求量/CPU 属运行时指标，
 * Worker 内部无法读取，卡片中给出控制台 Analytics 入口提示。
 */
import type { UsageStats } from "../../shared/types";
import { api, errMessage } from "./api";
import { icon } from "./icons";
import { el, formatDateTime } from "./ui";

/* ---------------- 格式化工具 ---------------- */

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function fmtNum(n: number): string {
  return n.toLocaleString("zh-CN");
}

/** 最近 n 天的 YYYY-MM-DD 列表（今天在最后） */
function lastNDays(n: number): string[] {
  const days: string[] = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const p = (x: number) => String(x).padStart(2, "0");
    days.push(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
  }
  return days;
}

/* ---------------- 免费额度参考（以 Cloudflare 控制台为准） ---------------- */

const FREE_TIER = {
  d1Bytes: 5 * 1024 ** 3, // 5 GB 存储
  r2Bytes: 10 * 1024 ** 3, // 10 GB-月 存储
  kvKeysNote: "免费版 KV 存储 1 GB · 写 1,000 次/天",
} as const;

/* ---------------- 组件 ---------------- */

interface MeterOptions {
  label: string;
  valueText: string;
  /** 0–100 */
  percent: number;
  tone?: "primary" | "warning" | "danger";
  hint?: string;
}

function meter(opts: MeterOptions): HTMLElement {
  const pct = Math.max(0, Math.min(100, opts.percent));
  return el("div", { className: "meter" }, [
    el("div", { className: "meter-labels" }, [
      el("span", { text: opts.label }),
      el("span", { className: "meter-value mono", text: opts.valueText }),
    ]),
    el("div", { className: "meter-track" }, [
      el("div", {
        className: `meter-fill tone-${opts.tone ?? (pct >= 90 ? "danger" : pct >= 70 ? "warning" : "primary")}`,
        attrs: { style: `width:${pct.toFixed(1)}%` },
      }),
    ]),
    opts.hint ? el("div", { className: "field-hint", text: opts.hint }) : null,
  ]);
}

/** 竖向柱状图（纯 div） */
function barChart(days: string[], counts: Map<string, number>, valueFmt: (n: number) => string): HTMLElement {
  const max = Math.max(1, ...counts.values());
  const chart = el("div", { className: "bar-chart" });
  for (const day of days) {
    const count = counts.get(day) ?? 0;
    const hPct = (count / max) * 100;
    const bar = el("div", { className: "bar-chart-col", attrs: { title: `${day}：${valueFmt(count)}` } }, [
      el("span", { className: "bar-chart-count mono", text: count > 0 ? String(count) : "" }),
      el("div", { className: "bar-chart-bar-zone" }, [
        el("div", { className: "bar-chart-bar", attrs: { style: `height:${Math.max(count > 0 ? 6 : 1.5, hPct)}%` } }),
      ]),
    ]);
    chart.appendChild(bar);
  }
  return chart;
}

function statCard(title: string, children: Array<HTMLElement | null>, badge?: { text: string; ok: boolean }): HTMLElement {
  return el("div", { className: "stat-card" }, [
    el("div", { className: "stat-card-head" }, [
      el("span", { className: "stat-card-title", text: title }),
      badge ? el("span", { className: `badge ${badge.ok ? "badge-published" : "badge-draft"}`, text: badge.text }) : null,
    ]),
    ...children,
  ]);
}

/* ---------------- 视图 ---------------- */

let rootEl: HTMLElement | null = null;
/** 加载代际令牌：连续刷新 / 快速切换路由时，只有最后一次请求能落渲染 */
let loadToken = 0;

export function showUsageView(parent: HTMLElement, visible: boolean): void {
  if (!rootEl || !rootEl.isConnected) {
    rootEl = el("section", { className: "usage-view" });
    parent.appendChild(rootEl);
  }
  rootEl.style.display = visible ? "" : "none";
  if (visible) void load(rootEl);
}

async function load(root: HTMLElement): Promise<void> {
  const token = ++loadToken;
  root.innerHTML = "";
  root.appendChild(
    el("div", { className: "usage-loading" }, [
      el("span", { className: "loading-block", text: "正在统计用量…" }),
    ]),
  );
  let stats: UsageStats | null = null;
  let errorText: string | null = null;
  try {
    stats = await api.getUsage();
  } catch (e) {
    errorText = errMessage(e);
  }
  if (token !== loadToken || !root.isConnected) return; // 已被新请求取代或已切走

  root.innerHTML = "";
  if (errorText !== null || stats === null) {
    root.appendChild(
      el("div", { className: "error-block" }, [
        el("span", { text: `加载用量数据失败：${errorText ?? "未知错误"}` }),
        el("button", {
          className: "btn btn-sm",
          text: "重试",
          attrs: { type: "button" },
          onClick: () => void load(root),
        }),
      ]),
    );
    return;
  }

  /* ---- 头部 ---- */
  const backBtn = el("button", {
    className: "btn btn-sm",
    text: "返回编辑器",
    attrs: { type: "button" },
    onClick: () => {
      location.hash = "#/";
    },
  });
  backBtn.insertBefore(icon("arrowLeft", 13), backBtn.firstChild);
  const refreshBtn = el("button", {
    className: "btn btn-sm",
    text: "刷新",
    attrs: { type: "button" },
    onClick: () => void load(root),
  });
  refreshBtn.insertBefore(icon("refresh", 13), refreshBtn.firstChild);

  root.appendChild(
    el("div", { className: "usage-head" }, [
      el("div", {}, [
        el("h1", { className: "usage-title", text: "Cloudflare 用量看板" }),
        el("div", { className: "usage-subtitle", text: `统计于本地时间 ${formatDateTime(stats.generated_at)} · 数据来自项目自身的 D1 / R2 / KV` }),
      ]),
      el("div", { className: "spacer" }),
      refreshBtn,
      backBtn,
    ]),
  );

  /* ---- D1 卡片 ---- */
  const d1Rows = fmtNum(stats.d1.tables.reduce((a, t) => a + t.rows, 0));
  const dayMap = new Map(stats.d1.revisions_by_day.map((d) => [d.day, d.count]));
  const d1Card = statCard("D1 数据库", [
    meter({
      label: "存储用量 / 免费额度 5 GB",
      valueText: `${fmtBytes(stats.d1.total_bytes)} (${((stats.d1.total_bytes / FREE_TIER.d1Bytes) * 100).toFixed(2)}%)`,
      percent: (stats.d1.total_bytes / FREE_TIER.d1Bytes) * 100,
    }),
    el("div", { className: "kv-grid" }, [
      el("div", { className: "kv-item" }, [
        el("span", { className: "kv-item-value mono", text: fmtNum(stats.d1.doc_status.published + stats.d1.doc_status.draft) }),
        el("span", { className: "kv-item-label", text: "文档总数" }),
      ]),
      el("div", { className: "kv-item" }, [
        el("span", { className: "kv-item-value mono success-text", text: fmtNum(stats.d1.doc_status.published) }),
        el("span", { className: "kv-item-label", text: "已发布" }),
      ]),
      el("div", { className: "kv-item" }, [
        el("span", { className: "kv-item-value mono", text: fmtNum(stats.d1.doc_status.draft) }),
        el("span", { className: "kv-item-label", text: "草稿" }),
      ]),
      el("div", { className: "kv-item" }, [
        el("span", { className: "kv-item-value mono", text: d1Rows }),
        el("span", { className: "kv-item-label", text: "全表行数" }),
      ]),
    ]),
    el("div", { className: "chart-block" }, [
      el("div", { className: "chart-title", text: "近 30 天每日新增版本" }),
      barChart(lastNDays(30), dayMap, (n) => `${n} 个版本`),
    ]),
    el("div", { className: "chart-block" }, [
      el("div", { className: "chart-title", text: "各表行数 / 估算体积" }),
      (() => {
        const tbody = el("tbody");
        for (const t of stats.d1.tables) {
          tbody.appendChild(
            el("tr", {}, [
              el("td", { className: "mono", text: t.name }),
              el("td", { className: "mono", text: fmtNum(t.rows) }),
              el("td", { className: "mono", text: fmtBytes(t.bytes) }),
            ]),
          );
        }
        return el("table", { className: "session-table usage-table" }, [
          el("thead", {}, [el("tr", {}, [el("th", { text: "表" }), el("th", { text: "行数" }), el("th", { text: "估算体积" })])]),
          tbody,
        ]);
      })(),
    ]),
    stats.d1.largest_docs.length > 0
      ? el("div", { className: "chart-block" }, [
          el("div", { className: "chart-title", text: "内容最大的文档 TOP5" }),
          (() => {
            const tbody = el("tbody");
            for (const d of stats.d1.largest_docs) {
              tbody.appendChild(
                el("tr", {}, [
                  el("td", {}, [
                    el("span", { text: d.title }),
                    el("span", { className: "search-hit-path", attrs: { style: "margin-left:8px" }, text: `/${d.path}` }),
                  ]),
                  el("td", { className: "mono", text: fmtBytes(d.bytes) }),
                ]),
              );
            }
            return el("table", { className: "session-table usage-table" }, [
              el("thead", {}, [el("tr", {}, [el("th", { text: "文档" }), el("th", { text: "正文大小" })])]),
              tbody,
            ]);
          })(),
        ])
      : null,
  ], { text: "已绑定", ok: true });

  /* ---- R2 卡片 ---- */
  const r2Children: HTMLElement[] = [];
  if (stats.r2.configured) {
    r2Children.push(
      meter({
        label: "存储用量 / 免费额度 10 GB·月",
        valueText: `${fmtBytes(stats.r2.total_bytes)} (${((stats.r2.total_bytes / FREE_TIER.r2Bytes) * 100).toFixed(2)}%)`,
        percent: (stats.r2.total_bytes / FREE_TIER.r2Bytes) * 100,
      }),
      el("div", { className: "kv-grid" }, [
        el("div", { className: "kv-item" }, [
          el("span", { className: "kv-item-value mono", text: fmtNum(stats.r2.object_count) }),
          el("span", { className: "kv-item-label", text: "对象总数（≤5000 扫描）" }),
        ]),
        el("div", { className: "kv-item" }, [
          el("span", { className: "kv-item-value mono", text: fmtBytes(stats.r2.total_bytes) }),
          el("span", { className: "kv-item-label", text: "总存储" }),
        ]),
      ]),
    );
    if (stats.r2.by_month.length > 0) {
      const monthMap = new Map(stats.r2.by_month.map((m) => [m.month, m.bytes]));
      const months = [...monthMap.keys()].sort().slice(-12);
      r2Children.push(
        el("div", { className: "chart-block" }, [
          el("div", { className: "chart-title", text: "近 12 个月上传存储量" }),
          barChart(months, monthMap, (n) => fmtBytes(n)),
        ]),
      );
    }
  } else {
    r2Children.push(
      el("div", { className: "usage-empty-hint", text: "未绑定 R2（MEDIA）：图片上传不可用，不影响其他功能。" }),
    );
  }
  const r2Card = statCard("R2 对象存储", r2Children, {
    text: stats.r2.configured ? "已绑定" : "未绑定",
    ok: stats.r2.configured,
  });

  /* ---- KV 卡片 ---- */
  const kvChildren: HTMLElement[] = [];
  if (stats.kv.configured) {
    kvChildren.push(
      el("div", { className: "kv-grid" }, [
        el("div", { className: "kv-item" }, [
          el("span", { className: "kv-item-value mono", text: fmtNum(stats.kv.page_cache_keys) }),
          el("span", { className: "kv-item-label", text: "页面缓存键（html:*）" }),
        ]),
      ]),
      el("div", { className: "field-hint", text: `${FREE_TIER.kvKeysNote}；键数量不含大小（KV list 不返回体积）。发布时精准失效，键数 ≈ 已发布页数 + 首页。` }),
    );
  } else {
    kvChildren.push(
      el("div", { className: "usage-empty-hint", text: "未绑定 KV（PAGE_CACHE）：已自动降级 Cache API 短 TTL 缓存。" }),
    );
  }
  const kvCard = statCard("KV 页面缓存", kvChildren, {
    text: stats.kv.configured ? "已绑定" : "Cache API 降级",
    ok: stats.kv.configured,
  });

  /* ---- Workers 说明卡 ---- */
  const workersCard = statCard("Workers 运行时", [
    el("div", { className: "usage-empty-hint", text: "请求量、CPU 时间等运行时指标无法从 Worker 内部读取。" }),
    el("a", {
      className: "btn btn-sm usage-link",
      text: "前往 Cloudflare 控制台查看 Workers Analytics",
      attrs: { href: "https://dash.cloudflare.com/?to=/:account/workers", target: "_blank", rel: "noopener noreferrer" },
    }),
    el("div", { className: "field-hint", text: "免费版额度参考：100,000 请求/天 · 每次 10ms CPU。备份 Cron 每天 03:00 UTC 自动执行。" }),
  ], { text: "运行中", ok: true });

  root.appendChild(el("div", { className: "stat-cards" }, [d1Card, r2Card, kvCard, workersCard]));

  root.appendChild(
    el("p", { className: "usage-footnote", text: "额度数值为 Cloudflare Free 套餐公开参考值，实际以控制台 Metrics / Billing 为准。" }),
  );
}
