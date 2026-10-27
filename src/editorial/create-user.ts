// Bootstrap CLI: creates a human editorial user using the owner connection.
// Usage: npm run editor:create-user -- <username> "<Display Name>" <roles comma-separated>
// A random password is generated and printed once; it is never stored in plain text.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { config } from "../config.js";
import { hashPassword } from "./auth.js";

const [username, displayName, rolesArg] = process.argv.slice(2);
const ROLES = ["researcher", "reviewer", "publisher", "admin"];
if (!username || !displayName || !rolesArg) {
  console.error('Usage: npm run editor:create-user -- <username> "<Display Name>" researcher,reviewer,publisher,admin');
  process.exit(1);
}
const roles = rolesArg.split(",").map((r) => r.trim());
if (roles.some((r) => !ROLES.includes(r))) { console.error(`Roles must be among: ${ROLES.join(", ")}`); process.exit(1); }

const password = process.env.NEW_USER_PASSWORD ?? randomBytes(15).toString("base64url");
const client = new pg.Client({ connectionString: config.ownerUrl });
await client.connect();
try {
  await client.query(
    "INSERT INTO core.app_user (username, display_name, roles, password_hash, is_human) VALUES ($1, $2, $3::core.user_role[], $4, true)",
    [username.toLowerCase(), displayName, roles, await hashPassword(password)]);
  console.log(`Created ${username} with roles ${roles.join(", ")}.`);
  if (!process.env.NEW_USER_PASSWORD) console.log(`Password (shown once): ${password}`);
} finally {
  await client.end();
}
