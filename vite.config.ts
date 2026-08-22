import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// 说明：
// - Worker 入口与绑定见 wrangler.jsonc（main = src/server/index.ts）。
// - 客户端两个入口：
//     admin.html  → /admin 管理端 SPA（由 Worker 路由转发到该静态文件）
//     src/client/read/main.ts → 阅读页渐进增强脚本（SSR HTML 引用 /assets/read.js）
//   入口产物使用稳定（不带 hash）的文件名，便于服务端 SSR 直接引用；
//   动态 import 的 chunk（如 mermaid）保留 hash 以避免重名冲突。
// - rollupOptions 只作用于 client 环境，避免污染 Worker 构建。
export default defineConfig({
  plugins: [cloudflare()],
  server: {
    watch: {
      // 沙箱/特殊环境下避免监听缓存目录（pnpm store 等）
      ignored: ["**/.cache/**", "**/.wrangler/**", "**/node_modules/**"],
    },
  },
  environments: {
    client: {
      build: {
        sourcemap: false,
        rollupOptions: {
          input: {
            admin: "admin.html",
            read: "src/client/read/main.ts",
          },
          output: {
            entryFileNames: "assets/[name].js",
            chunkFileNames: "assets/[name]-[hash].js",
            assetFileNames: "assets/[name][extname]",
          },
        },
      },
    },
  },
});
