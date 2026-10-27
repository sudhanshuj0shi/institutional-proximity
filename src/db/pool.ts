import pg from "pg";
import { config } from "../config.js";

// Dates (not timestamps) come back as plain 'YYYY-MM-DD' strings so precision handling
// never shifts a day because of time zones.
pg.types.setTypeParser(1082, (v: string) => v);

let publicPool: pg.Pool | undefined;
let editorPool: pg.Pool | undefined;

/** Read-only pool. Its DB role can only SELECT from public_api views. */
export function getPublicPool(): pg.Pool {
  publicPool ??= new pg.Pool({ connectionString: config.publicUrl, max: 10 });
  return publicPool;
}

/** Editorial pool. Every write goes through withActor() so triggers know who acted. */
export function getEditorPool(): pg.Pool {
  editorPool ??= new pg.Pool({ connectionString: config.editorUrl, max: 5 });
  return editorPool;
}

export interface ActorContext {
  userId: number;
  reason?: string;
  reviewNotes?: string;
}

/**
 * Runs fn inside a transaction with app.user_id (and optional reason / review notes)
 * set locally, so audit and lifecycle triggers attribute the change correctly.
 */
export async function withActor<T>(ctx: ActorContext, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getEditorPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.user_id', $1, true), set_config('app.change_reason', $2, true), set_config('app.review_notes', $3, true)",
      [String(ctx.userId), ctx.reason ?? "", ctx.reviewNotes ?? ""],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function closePools(): Promise<void> {
  await Promise.all([publicPool?.end(), editorPool?.end()]);
  publicPool = undefined;
  editorPool = undefined;
}
