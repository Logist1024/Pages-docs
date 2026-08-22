import { describe, expect, it } from "vitest";
import { parseAdminCredentials, timingSafeEqualStr, verifyPassword, CredentialConfigError } from "./auth";

describe("parseAdminCredentials", () => {
  it("解析 JSON 数组格式，第一条为 admin", () => {
    const accounts = parseAdminCredentials(
      '[{"name":"alice","password":"p1"},{"name":"bob","password":"p2"}]'
    );
    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toMatchObject({ name: "alice", isAdmin: true });
    expect(accounts[1]).toMatchObject({ name: "bob", isAdmin: false });
  });

  it("解析每行 name:password 文本格式（含注释与空行）", () => {
    const accounts = parseAdminCredentials(
      "# 注释\nalice:p1\n\nbob:p2:with:colons\n"
    );
    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toMatchObject({ name: "alice", password: "p1", isAdmin: true });
    expect(accounts[1]).toMatchObject({ name: "bob", password: "p2:with:colons", isAdmin: false });
  });

  it("拒绝空配置 / 非法 JSON / 重复名 / 空字段", () => {
    expect(() => parseAdminCredentials(undefined)).toThrow(CredentialConfigError);
    expect(() => parseAdminCredentials("")).toThrow(CredentialConfigError);
    expect(() => parseAdminCredentials("[{bad json]")).toThrow(CredentialConfigError);
    expect(() => parseAdminCredentials("[]")).toThrow(CredentialConfigError);
    expect(() => parseAdminCredentials("alice:p1\nalice:p2")).toThrow(/重复/);
    expect(() => parseAdminCredentials("alice:")).toThrow(CredentialConfigError);
    expect(() => parseAdminCredentials("no-colon-line")).toThrow(CredentialConfigError);
  });
});

describe("timingSafeEqualStr", () => {
  it("相同返回 true，不同返回 false", () => {
    expect(timingSafeEqualStr("abc", "abc")).toBe(true);
    expect(timingSafeEqualStr("abc", "abd")).toBe(false);
    expect(timingSafeEqualStr("abc", "abcd")).toBe(false);
    expect(timingSafeEqualStr("", "")).toBe(true);
  });
});

describe("verifyPassword", () => {
  it("明文口令直接比较", async () => {
    expect(await verifyPassword({ name: "a", password: "s3cret", isAdmin: true }, "s3cret")).toBe(true);
    expect(await verifyPassword({ name: "a", password: "s3cret", isAdmin: true }, "wrong")).toBe(false);
  });

  it("pbkdf2 哈希口令可重算比对", async () => {
    // 用 WebCrypto 生成与 scripts/hash-password.mjs 相同格式的哈希
    const b64url = (bytes: Uint8Array) =>
      btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("my-password"),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const bits = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 1000 }, key, 256)
    );
    const stored = `pbkdf2$1000$${b64url(salt)}$${b64url(bits)}`;
    const account = { name: "a", password: stored, isAdmin: false };
    expect(await verifyPassword(account, "my-password")).toBe(true);
    expect(await verifyPassword(account, "bad")).toBe(false);
  });

  it("畸形 pbkdf2 串安全返回 false", async () => {
    const account = { name: "a", password: "pbkdf2$notanumber$x$y", isAdmin: false };
    expect(await verifyPassword(account, "x")).toBe(false);
  });
});
