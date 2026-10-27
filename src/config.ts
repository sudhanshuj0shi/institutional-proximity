import { existsSync } from "node:fs";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}. See .env.example.`);
  return v;
}

/**
 * Hosts like Railway provide one DATABASE_URL (the owner). When the role-specific URLs are
 * not set, derive them by swapping in the least-privilege roles and their passwords.
 */
function derived(role: "ip_public" | "ip_editor", pwVar: string): string | undefined {
  const base = process.env.DATABASE_URL;
  const pw = process.env[pwVar];
  if (!base || !pw) return undefined;
  const u = new URL(base);
  u.username = role;
  u.password = encodeURIComponent(pw);
  return u.toString();
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  env: process.env.NODE_ENV ?? "development",
  get ownerUrl() { return process.env.DATABASE_URL_OWNER ?? required("DATABASE_URL"); },
  get publicUrl() { return process.env.DATABASE_URL_PUBLIC ?? derived("ip_public", "IP_PUBLIC_PASSWORD") ?? required("DATABASE_URL_PUBLIC"); },
  get editorUrl() { return process.env.DATABASE_URL_EDITOR ?? derived("ip_editor", "IP_EDITOR_PASSWORD") ?? required("DATABASE_URL_EDITOR"); },
  get sessionSecret() {
    const s = required("SESSION_SECRET");
    if (s.length < 32 || s.startsWith("CHANGE_ME")) {
      throw new Error("SESSION_SECRET must be a random string of at least 32 characters.");
    }
    return s;
  },
  cookieSecure: process.env.COOKIE_SECURE === "true",
};
