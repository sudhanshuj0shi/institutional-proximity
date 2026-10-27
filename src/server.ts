import express, { type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "./types.js";
import { config } from "./config.js";
import { securityHeaders } from "./lib/security.js";
import { publicRouter, notFound } from "./public/routes.js";
import { editorialRouter } from "./editorial/routes.js";
import { html } from "./lib/html.js";
import { page } from "./lib/layout.js";

const here = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(here, "..", "public");

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : false);
  app.use(securityHeaders);
  app.use("/static", express.static(STATIC_DIR, { maxAge: config.env === "production" ? "7d" : 0, index: false, dotfiles: "deny" }));
  app.use(express.urlencoded({ extended: false, limit: "100kb", parameterLimit: 200 }));
  app.use(cookieParser());
  app.use((req, _res, next) => { req.editor = null; next(); });
  app.get("/healthz", (_req, res) => { res.type("text").send("ok"); });
  app.get("/robots.txt", (_req, res) => { res.type("text").send("User-agent: *\nDisallow: /editorial\nDisallow: /api/\n"); });
  app.use("/editorial", editorialRouter());
  app.use(publicRouter());
  app.use((req, res) => notFound(res, req.editor));

  // Errors: log the message server-side only (no request bodies, no connection strings); show a generic page.
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    const safe = (err?.message ?? "error").replace(/postgres(ql)?:\/\/[^\s]+/gi, "[redacted-url]");
    console.error(`[error] ${req.method} ${req.path}: ${safe}`);
    if (res.headersSent) return;
    if (req.path.startsWith("/api/")) { res.status(500).json({ error: "internal_error" }); return; }
    res.status(500).type("html").send(page({
      title: "Something went wrong", description: "Server error", path: req.path, noindex: true,
      body: html`<div class="wrap"><h1>Something went wrong</h1><p class="lede">The page could not be loaded. Nothing was changed. Try again in a moment.</p></div>`,
    }).value);
  });
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void config.sessionSecret; // fail fast on a missing or weak secret
  createApp().listen(config.port, () => console.log(`Institutional Proximity listening on http://localhost:${config.port}`));
}
