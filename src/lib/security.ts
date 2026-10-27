import type { Request, Response, NextFunction } from "express";

/** Strict security headers. No inline scripts or styles are permitted anywhere. */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'",
    "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join("; "));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  next();
}

interface Bucket { count: number; reset: number; }
const buckets = new Map<string, Bucket>();

/**
 * In-memory fixed-window rate limiter keyed by client IP. IPs are held only in memory
 * for the window and never written to the database or logs.
 */
export function rateLimit(opts: { windowMs: number; max: number; key: string }) {
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const k = `${opts.key}:${req.ip}`;
    let b = buckets.get(k);
    if (!b || b.reset <= now) { b = { count: 0, reset: now + opts.windowMs }; buckets.set(k, b); }
    b.count++;
    if (b.count > opts.max) {
      res.setHeader("Retry-After", String(Math.ceil((b.reset - now) / 1000)));
      res.status(429).type("text").send("Too many requests. Try again later.");
      return;
    }
    if (buckets.size > 50000) for (const [key, v] of buckets) if (v.reset <= now) buckets.delete(key);
    next();
  };
}

export function resetRateLimits() { buckets.clear(); }
