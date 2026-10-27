import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "migrations");

/** Applies pending migrations using the owner connection, then configures runtime role logins. */
export async function migrate(ownerUrl: string, opts: { publicPassword?: string; editorPassword?: string; log?: boolean } = {}) {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query("SELECT name FROM public.schema_migrations")).rows.map((r) => r.name));
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO public.schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        if (opts.log) console.log(`applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
    // Runtime roles get LOGIN only when a password is supplied (never hard-coded in SQL).
    for (const [role, pw] of [["ip_public", opts.publicPassword], ["ip_editor", opts.editorPassword]] as const) {
      if (pw) await client.query(`ALTER ROLE ${role} LOGIN PASSWORD ${client.escapeLiteral(pw)}`);
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { config } = await import("../config.js");
  await migrate(config.ownerUrl, {
    publicPassword: process.env.IP_PUBLIC_PASSWORD,
    editorPassword: process.env.IP_EDITOR_PASSWORD,
    log: true,
  });
  console.log("migrations complete");
}
