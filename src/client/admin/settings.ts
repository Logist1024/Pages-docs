/**
 * 站点设置弹窗（仅 admin）：
 * - 基本信息：站点名称、首页地址；
 * - 品牌形象：网站图标（浏览器标签页 favicon）与界面 LOGO（页眉品牌图），本地上传即时预览；
 * - 页眉公告：显示在站点头部下方的公告栏（支持内联 HTML，可带链接）；
 * - 页脚：全站页脚自定义 HTML（版权声明等，支持内联 HTML）；
 * - 导航栏链接：网站顶部一排导航，站内 / 路径、站外完整 URL。
 * 图片以 data URI 存入站点设置（≤300KB），无需对象存储即可生效。
 */
import type { NavLink, NoticeBar } from "../../shared/types";
import { api, errMessage } from "./api";
import { icon } from "./icons";
import { el, openModal, toast } from "./ui";

const MAX_NAV_LINKS = 20;
/** 上传图片的原始大小上限（base64 后约 ×4/3，仍低于服务端 400K 字符限制） */
const MAX_IMAGE_BYTES = 200 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "image/svg+xml", "image/x-icon"]);

/** 与服务端 validateHref 一致的客户端校验；合法返回 null */
function validateHref(href: string): string | null {
  if (/^https?:\/\//.test(href)) return null;
  if (href.startsWith("/") && !href.startsWith("//")) return null;
  return "站内路径需以 / 开头，站外填写完整 http(s):// URL";
}

interface NavRowHandle {
  root: HTMLElement;
  values(): NavLink | null; // 全空返回 null（视为删除）
}

function createNavRow(list: HTMLElement, initial?: NavLink): NavRowHandle {
  const labelInput = el("input", {
    className: "field-input nav-label-input",
    attrs: { type: "text", placeholder: "名称，如：使用指南", autocomplete: "off" },
  });
  const hrefInput = el("input", {
    className: "field-input field-mono nav-href-input",
    attrs: { type: "text", placeholder: "/intro 或 https://…", spellcheck: "false", autocomplete: "off" },
  });
  if (initial) {
    labelInput.value = initial.label;
    hrefInput.value = initial.href;
  }

  const removeBtn = el("button", {
    className: "btn-icon nav-row-remove",
    attrs: { type: "button", title: "移除该导航项", "aria-label": "移除该导航项" },
    onClick: () => row.root.remove(),
  });
  removeBtn.appendChild(icon("trash", 14));

  const row: NavRowHandle = {
    root: el("div", { className: "nav-link-row" }, [labelInput, hrefInput, removeBtn]),
    values: () => {
      const label = labelInput.value.trim();
      const href = hrefInput.value.trim();
      if (label.length === 0 && href.length === 0) return null;
      if (label.length === 0 || href.length === 0) return { label, href }; // 半空交由提交校验报错
      return { label, href };
    },
  };
  list.appendChild(row.root);
  return row;
}

/* ---------------- 图片上传控件（favicon / logo 共用） ---------------- */

interface ImageFieldHandle {
  root: HTMLElement;
  /** 当前值：null 表示恢复默认 */
  value(): string | null;
}

function createImageField(opts: {
  label: string;
  initial: string | null;
  hint: string;
  previewClass: string;
}): ImageFieldHandle {
  let currentValue: string | null = opts.initial;

  const preview = el("img", {
    className: `image-preview ${opts.previewClass}`,
    attrs: { alt: `${opts.label}预览` },
  });
  const emptyPreview = el("span", { className: "image-preview-empty", text: "默认" });
  const previewWrap = el("div", { className: "image-preview-wrap" }, [preview, emptyPreview]);

  const syncPreview = (): void => {
    if (currentValue) {
      preview.src = currentValue;
      preview.style.display = "";
      emptyPreview.style.display = "none";
    } else {
      preview.removeAttribute("src");
      preview.style.display = "none";
      emptyPreview.style.display = "";
    }
  };
  syncPreview();

  const statusLine = el("div", { className: "field-error" });

  const fileInput = el("input", {
    className: "image-file-input",
    attrs: { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml,image/x-icon" },
    onChange: () => {
      statusLine.textContent = "";
      const file = fileInput.files?.[0];
      fileInput.value = ""; // 允许重复选择同一文件
      if (!file) return;
      if (!IMAGE_TYPES.has(file.type)) {
        statusLine.textContent = "仅支持 PNG / JPEG / WebP / GIF / AVIF / SVG / ICO 图片";
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        statusLine.textContent = `图片不能超过 ${Math.round(MAX_IMAGE_BYTES / 1024)}KB`;
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        currentValue = String(reader.result ?? "");
        syncPreview();
      };
      reader.onerror = () => {
        statusLine.textContent = "读取文件失败，请重试";
      };
      reader.readAsDataURL(file);
    },
  });

  const uploadBtn = el("button", {
    className: "btn btn-sm",
    text: "上传图片…",
    attrs: { type: "button" },
    onClick: () => fileInput.click(),
  });
  uploadBtn.insertBefore(icon("image", 13), uploadBtn.firstChild);

  const resetBtn = el("button", {
    className: "btn btn-sm",
    text: "恢复默认",
    attrs: { type: "button" },
    onClick: () => {
      currentValue = null;
      syncPreview();
      statusLine.textContent = "";
    },
  });

  const root = el("div", { className: "field" }, [
    el("label", { className: "field-label", text: opts.label }),
    el("div", { className: "image-field-row" }, [previewWrap, el("div", { className: "image-field-actions" }, [uploadBtn, resetBtn])]),
    statusLine,
    el("div", { className: "field-hint", text: opts.hint }),
  ]);

  return { root, value: () => currentValue };
}

export function openSiteSettingsModal(): void {
  let submitting = false;

  const loading = el("div", { className: "loading-block", text: "正在加载站点设置…" });
  const formWrap = el("div", { className: "settings-form", attrs: { style: "display:none" } });

  const handle = openModal({
    title: "站点设置",
    content: el("div", {}, [loading, formWrap]),
    wide: true,
  });

  void api
    .getSiteSettings()
    .then((settings) => {
      /* ---- 基本信息 ---- */
      const nameInput = el("input", {
        className: "field-input",
        attrs: { type: "text", autocomplete: "off", placeholder: "默认 Pages Docs" },
      });
      nameInput.value = settings.site_name ?? "";

      const homeInput = el("input", {
        className: "field-input field-mono",
        attrs: { type: "text", spellcheck: "false", autocomplete: "off", placeholder: "默认 /" },
      });
      homeInput.value = settings.home_url ?? "";

      /* ---- 品牌：favicon / logo ---- */
      const faviconField = createImageField({
        label: "网站图标（Favicon）",
        initial: settings.favicon,
        hint: "显示在浏览器标签页与书签中。建议正方形 PNG/SVG/ICO，不超过 200KB。",
        previewClass: "image-preview-favicon",
      });
      const logoField = createImageField({
        label: "界面 LOGO",
        initial: settings.logo,
        hint: "显示在阅读站与管理后台左上角的品牌图。建议带圆角的方形图，不超过 200KB。",
        previewClass: "image-preview-logo",
      });

      /* ---- 页眉公告（支持内联 HTML） ---- */
      const noticeTextInput = el("textarea", {
        className: "field-input notice-input",
        attrs: { rows: "2", autocomplete: "off", placeholder: "留空则不显示公告栏；支持 HTML，如 <strong>重要</strong> 或 <a href=\"/changelog\">更新日志</a>" },
      });
      noticeTextInput.value = settings.notice?.text ?? "";
      const noticeLinkInput = el("input", {
        className: "field-input field-mono",
        attrs: { type: "text", spellcheck: "false", autocomplete: "off", placeholder: "可选链接：/changelog 或 https://…" },
      });
      noticeLinkInput.value = settings.notice?.link ?? "";

      /* ---- 页脚（支持内联 HTML） ---- */
      const footerInput = el("textarea", {
        className: "field-input footer-input",
        attrs: { rows: "3", spellcheck: "false", placeholder: "留空则不显示页脚。例如：\n<p>© 2026 My Company · <a href=\"https://example.com\">官网</a></p>" },
      });
      footerInput.value = settings.footer ?? "";

      /* ---- 导航栏 ---- */
      const navList = el("div", { className: "nav-links-list" });
      const rows: NavRowHandle[] = [];
      const addRow = (link?: NavLink): void => {
        if (rows.length >= MAX_NAV_LINKS) return;
        rows.push(createNavRow(navList, link));
      };
      for (const link of settings.nav_links) addRow(link);
      if (rows.length === 0) addRow();

      const addLinkBtn = el("button", {
        className: "btn btn-sm",
        text: "添加导航项",
        attrs: { type: "button" },
        onClick: () => addRow(),
      });
      addLinkBtn.insertBefore(icon("plus", 13), addLinkBtn.firstChild);

      const errorLine = el("div", { className: "field-error" });

      const confirmBtn = el("button", {
        className: "btn btn-primary",
        text: "保存设置",
        attrs: { type: "submit" },
      });
      const cancelBtn = el("button", {
        className: "btn",
        text: "取消",
        attrs: { type: "button" },
        onClick: () => handle.close(),
      });

      const form = el("form", {
        attrs: { id: "site-settings-form" },
        onSubmit: (ev) => {
          ev.preventDefault();
          if (submitting) return;
          errorLine.textContent = "";

          const siteName = nameInput.value.trim();
          if (siteName.length === 0) {
            errorLine.textContent = "站点名称不能为空";
            return;
          }
          if (siteName.length > 100) {
            errorLine.textContent = "站点名称不能超过 100 字";
            return;
          }
          const homeUrl = homeInput.value.trim();
          if (homeUrl.length > 0) {
            const err = validateHref(homeUrl);
            if (err !== null) {
              errorLine.textContent = `首页地址不合法：${err}`;
              return;
            }
          }

          const noticeText = noticeTextInput.value.trim();
          if (noticeText.length > 500) {
            errorLine.textContent = "公告内容不能超过 500 字符";
            return;
          }
          const noticeLink = noticeLinkInput.value.trim();
          if (noticeText.length > 0 && noticeLink.length > 0) {
            const err = validateHref(noticeLink);
            if (err !== null) {
              errorLine.textContent = `公告链接不合法：${err}`;
              return;
            }
          }

          const footerHtmlValue = footerInput.value.trim();
          if (footerHtmlValue.length > 4000) {
            errorLine.textContent = "页脚内容不能超过 4000 字符";
            return;
          }

          // 过滤掉已删除行后逐行校验
          const links: NavLink[] = [];
          for (const row of rows) {
            if (!row.root.isConnected) continue;
            const v = row.values();
            if (v === null) continue;
            if (v.label.length === 0) {
              errorLine.textContent = "导航项名称不能为空";
              return;
            }
            if (v.label.length > 60) {
              errorLine.textContent = "导航项名称不能超过 60 字";
              return;
            }
            const err = validateHref(v.href);
            if (err !== null) {
              errorLine.textContent = `导航「${v.label}」的地址不合法：${err}`;
              return;
            }
            links.push(v);
          }
          if (links.length > MAX_NAV_LINKS) {
            errorLine.textContent = `导航链接最多 ${MAX_NAV_LINKS} 个`;
            return;
          }

          submitting = true;
          confirmBtn.disabled = true;
          api.updateSiteSettings({
            site_name: siteName,
            home_url: homeUrl || null,
            favicon: faviconField.value(),
            logo: logoField.value(),
            notice: noticeText.length > 0 ? { text: noticeText, link: noticeLink } : null,
            footer: footerHtmlValue.length > 0 ? footerHtmlValue : null,
            nav_links: links,
          })
            .then(() => {
              handle.close();
              toast("站点设置已保存并应用到全站", "success");
            })
            .catch((e: unknown) => {
              submitting = false;
              confirmBtn.disabled = false;
              errorLine.textContent = errMessage(e);
            });
        },
      }, [
        el("div", { className: "field" }, [
          el("label", { className: "field-label", text: "站点名称" }),
          nameInput,
          el("div", { className: "field-hint", text: "显示在网站顶部、浏览器标签页与 RSS 中。" }),
        ]),
        el("div", { className: "field" }, [
          el("label", { className: "field-label", text: "首页地址" }),
          homeInput,
          el("div", {
            className: "field-hint",
            text: "点击左上角站点名称时跳转的目标。站内直接填「/路径」，站外填写完整 http(s):// URL。",
          }),
        ]),
        el("div", { className: "settings-section-title", text: "品牌形象" }),
        faviconField.root,
        logoField.root,
        el("div", { className: "settings-section-title", text: "页眉公告栏" }),
        el("div", { className: "field" }, [
          noticeTextInput,
          el("div", { className: "notice-link-row" }, [noticeLinkInput]),
          el("div", {
            className: "field-hint",
            text: "公告显示在阅读站页眉下方，支持内联 HTML（加粗 / 链接 / 代码等，脚本会被自动过滤）；填写链接时会在文案尾部出现「查看详情」。清空内容即关闭公告。",
          }),
        ]),
        el("div", { className: "settings-section-title", text: "页脚" }),
        el("div", { className: "field" }, [
          footerInput,
          el("div", {
            className: "field-hint",
            text: "显示在每个阅读页底部，适合放版权声明、备案号、联系方式等，同样支持内联 HTML。清空即不显示页脚。",
          }),
        ]),
        el("div", { className: "settings-section-title", text: "顶部导航栏" }),
        el("div", { className: "field" }, [
          navList,
          el("div", { className: "nav-add-row" }, [addLinkBtn]),
          el("div", {
            className: "field-hint",
            text: "按顺序展示在网站顶部。站内直接填「/路径」（如 /quick-start），站外输入完整 URL（如 https://example.com）。",
          }),
        ]),
        errorLine,
      ]);

      formWrap.appendChild(form);

      // 底部操作区（吸底，随内容滚动保持可见）。
      // 按钮在 <form> 之外，必须用 form 属性关联才能触发提交。
      confirmBtn.setAttribute("form", form.id);
      const actions = el("div", { className: "modal-actions settings-modal-actions" }, [cancelBtn, confirmBtn]);
      formWrap.appendChild(actions);

      loading.style.display = "none";
      formWrap.style.display = "";
    })
    .catch((e: unknown) => {
      loading.textContent = `加载失败：${errMessage(e)}`;
    });
}
