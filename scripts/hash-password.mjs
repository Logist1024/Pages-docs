#!/usr/bin/env node
/**
 * 生成 PBKDF2 口令哈希，用于 ADMIN_CREDENTIALS 加固（PLAN 4.1 可选项）。
 *
 * 用法：
 *   pnpm hash-password            # 交互输入
 *   pnpm hash-password '口令'
 *
 * 输出形如：pbkdf2$210000$<salt-b64url>$<hash-b64url>
 * 把它作为 ADMIN_CREDENTIALS 中对应账号的 password 字段即可，
 * Worker 端会用 WebCrypto 重算比对（控制台里看不到明文）。
 */
import { pbkdf2Sync, randomBytes } from "node:crypto";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const ITERATIONS = 210_000;

function toB64Url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const argPassword = process.argv[2];
let password = argPassword;
if (!password) {
  const rl = readline.createInterface({ input, output });
  password = await rl.question("请输入要哈希的口令: ");
  rl.close();
}
if (!password) {
  console.error("口令不能为空");
  process.exit(1);
}

const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
console.log(`pbkdf2$${ITERATIONS}$${toB64Url(salt)}$${toB64Url(hash)}`);
