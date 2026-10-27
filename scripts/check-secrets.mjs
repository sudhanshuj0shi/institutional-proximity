// Fails if likely secrets appear in source files. .env is ignored by git and excluded here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const SKIP = new Set(["node_modules", "dist", ".git", "test-results", "playwright-report", "public"]);
const PATTERNS = [
  [/postgres(ql)?:\/\/[^:\s"'`]+:(?!CHANGE_ME|test_|e2e_|devpublic|deveditor)[^@\s"'`$]{6,}@/i, "database URL with a password"],
  [/-----BEGIN (RSA |EC )?PRIVATE KEY-----/, "private key"],
  [/\b(sk|pk)_(live|test)_[A-Za-z0-9]{16,}/, "API key"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key"],
  [/SESSION_SECRET\s*=\s*(?!CHANGE_ME)[A-Za-z0-9]{32,}/, "session secret"],
];
const hits = [];
function walk(dir) {
  for (const f of readdirSync(dir)) {
    if (SKIP.has(f) || f === ".env") continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!/\.(ts|mjs|js|json|sql|md|example|yml|yaml)$/.test(f) && !f.startsWith(".env")) continue;
    const text = readFileSync(p, "utf8");
    for (const [re, what] of PATTERNS) if (re.test(text)) hits.push(`${p}: ${what}`);
  }
}
walk(".");
if (hits.length) { console.error("Possible secrets found:\n" + hits.join("\n")); process.exit(1); }
console.log("No secrets found in source files.");
