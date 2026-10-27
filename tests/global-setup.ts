import pg from "pg";
import { migrate } from "../src/db/migrate.js";

// Creates a throwaway database for the test run. The admin URL defaults to a local
// trust-auth cluster; override with TEST_ADMIN_URL.
const ADMIN = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const DB = `ip_test_${process.pid}`;

function withDb(url: string, db: string) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

export async function setup() {
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();

  const owner = withDb(ADMIN, DB);
  await migrate(owner, { publicPassword: "test_public_pw", editorPassword: "test_editor_pw" });

  const host = new URL(ADMIN).host;
  process.env.DATABASE_URL_OWNER = owner;
  process.env.DATABASE_URL_PUBLIC = `postgres://ip_public:test_public_pw@${host}/${DB}`;
  process.env.DATABASE_URL_EDITOR = `postgres://ip_editor:test_editor_pw@${host}/${DB}`;
  process.env.SESSION_SECRET = "test-secret-test-secret-test-secret-0123456789";
  process.env.NODE_ENV = "test";
}

export async function teardown() {
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.end();
}
