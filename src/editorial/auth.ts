import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Request, Response, NextFunction } from "express";
import { getEditorPool } from "../db/pool.js";
import { config } from "../config.js";
import type { EditorSession } from "../types.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const N = 16384, R = 8, P = 1, LEN = 32;
export const SESSION_COOKIE = "ip_session";
const SESSION_HOURS = 8;

export async function hashPassword(pw: string): Promise<string> {
  if (pw.length < 12) throw new Error("Passwords must be at least 12 characters.");
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, LEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  // Always spend the same work, even for unknown users, to avoid a timing oracle.
  const parts = (stored ?? "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, "base64");
  const got = await scrypt(pw, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return stored !== null && got.length === expected.length && timingSafeEqual(got, expected);
}

/** Session tokens are random; only an HMAC of the token (keyed by SESSION_SECRET) is stored. */
function tokenHash(token: string): string {
  return createHmac("sha256", config.sessionSecret).update(token).digest("hex");
}

export async function createSession(res: Response, userId: number) {
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(24).toString("base64url");
  await getEditorPool().query(
    "INSERT INTO core.session (token_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4))",
    [tokenHash(token), userId, csrf, SESSION_HOURS]);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "strict", secure: config.cookieSecure, path: "/", maxAge: SESSION_HOURS * 3600 * 1000,
  });
}

export async function destroySession(req: Request, res: Response) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token === "string") await getEditorPool().query("DELETE FROM core.session WHERE token_hash = $1", [tokenHash(token)]);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export async function loadSession(req: Request, _res: Response, next: NextFunction) {
  req.editor = null;
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== "string" || token.length > 100) return next();
  try {
    const r = await getEditorPool().query(
      `SELECT u.id, u.username, u.display_name, u.roles::text[] AS roles, u.is_human, s.csrf_token
       FROM core.session s JOIN core.app_user u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`, [tokenHash(token)]);
    const row = r.rows[0];
    if (row) {
      req.editor = { id: row.id, username: row.username, displayName: row.display_name, roles: row.roles, isHuman: row.is_human, csrf: row.csrf_token } satisfies EditorSession;
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function requireEditor(req: Request, res: Response, next: NextFunction) {
  if (req.editor) return next();
  if (req.method === "GET") return res.redirect(303, `/editorial/login?next=${encodeURIComponent(req.originalUrl)}`);
  res.status(401).type("text").send("Sign in to the editorial desk first.");
}

export function hasRole(req: Request, role: string) {
  return !!req.editor && req.editor.roles.includes(role);
}

export function requireRole(role: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (hasRole(req, role)) return next();
    res.status(403).type("text").send(`This action needs the ${role} role.`);
  };
}

/** Synchroniser-token CSRF check for every state-changing editorial request. */
export function requireCsrf(req: Request, res: Response, next: NextFunction) {
  if (req.method === "GET" || req.method === "HEAD") return next();
  const sent = typeof req.body?._csrf === "string" ? Buffer.from(req.body._csrf) : Buffer.alloc(0);
  const expected = Buffer.from(req.editor?.csrf ?? "");
  if (expected.length === 0 || sent.length !== expected.length || !timingSafeEqual(sent, expected)) {
    res.status(403).type("text").send("This form has expired. Go back, reload the page and try again.");
    return;
  }
  next();
}

export async function purgeExpiredSessions() {
  await getEditorPool().query("DELETE FROM core.session WHERE expires_at < now()");
}
