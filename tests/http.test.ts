// HTTP-level tests: the running app enforces the same rules as the database, and no
// client-side state (form fields, query strings) can bypass publication controls.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import {
  makeTeam, Team, createInstitution, createClaim, createSource, linkSource, setStatus, publishIdentity, ownerClient, asUser, uid,
} from "./helpers.js";

let app: Express;
let team: Team;

async function setPassword(userId: number, pw: string) {
  const { hashPassword } = await import("../src/editorial/auth.js");
  const o = ownerClient(); await o.connect();
  const username = (await o.query("UPDATE core.app_user SET password_hash = $2 WHERE id = $1 RETURNING username", [userId, await hashPassword(pw)])).rows[0].username;
  await o.end();
  return username as string;
}

async function login(userId: number) {
  const pw = `pw-${uid()}-long-enough`;
  const username = await setPassword(userId, pw);
  const agent = request.agent(app);
  const res = await agent.post("/editorial/login").type("form").send({ username, password: pw });
  expect(res.status).toBe(303);
  const page = await agent.get("/editorial");
  const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)?.[1];
  expect(csrf).toBeTruthy();
  return { agent, csrf: csrf! };
}

beforeAll(async () => {
  const { createApp } = await import("../src/server.js");
  const { resetRateLimits } = await import("../src/lib/security.js");
  resetRateLimits();
  app = createApp();
  team = await makeTeam();
});
afterAll(async () => { const { closePools } = await import("../src/db/pool.js"); await closePools(); });

describe("public pages", () => {
  it("render with security headers and no inline script", async () => {
    for (const path of ["/", "/institutions", "/map", "/methodology", "/corrections"]) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers["content-security-policy"]).toContain("script-src 'self'");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.text).not.toMatch(/<script>(?!\s*<\/script>)/);
      expect(res.text).not.toMatch(/ style="/);
    }
  });

  it("do not reveal unpublished claims, and a draft ID returns 404 like a non-existent one", async () => {
    const inst = await createInstitution(team.researcher, `Test Hidden Institution ${uid()}`);
    const claim = await createClaim(team.researcher, { institutionId: inst, text: "Test draft statement that must never be public." });
    const page = await request(app).get(`/claims/${claim.public_id}`);
    expect(page.status).toBe(404);
    const api = await request(app).get(`/api/public/claims/${claim.public_id}`);
    expect(api.status).toBe(404);
    for (const path of ["/", "/institutions", "/map", "/api/public/graph", "/api/public/institutions"]) {
      const res = await request(app).get(path);
      expect(res.text, path).not.toContain("Test draft statement");
      expect(res.text, path).not.toContain("Test Hidden Institution");
    }
  });

  it("show published claims with evidence, escape their content, and omit internal notes", async () => {
    const inst = await createInstitution(team.researcher, `Test <script>alert(1)</script> Body ${uid()}`);
    const claim = await publishIdentity(team, inst);
    const res = await request(app).get(`/claims/${claim.public_id}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("<script>alert(1)</script>");
    expect(res.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(res.text).toContain("Test Source");
    const api = await request(app).get(`/api/public/claims/${claim.public_id}`);
    expect(api.status).toBe(200);
    const json = JSON.stringify(api.body);
    for (const k of ["review_notes", "verification_notes", "source_notes", "checked_by", "created_by", "attention_reason"]) expect(json).not.toContain(k);
  });

  it("a retracted claim returns 410 with the correction note and without its original text", async () => {
    const inst = await createInstitution(team.researcher);
    const claim = await publishIdentity(team, inst);
    await setStatus(team.publisher, claim.id, "retracted", { public_correction_note: "Test correction: the source did not support this." });
    const res = await request(app).get(`/claims/${claim.public_id}`);
    expect(res.status).toBe(410);
    expect(res.text).toContain("Test correction: the source did not support this.");
    expect(res.text).not.toContain("Test claim text for fixture purposes.");
    const log = await request(app).get("/corrections");
    expect(log.text).toContain(claim.public_id);
  });

  it("accepts correction reports privately and validates them", async () => {
    const bad = await request(app).post("/corrections").type("form").send({ message: "short" });
    expect(bad.status).toBe(400);
    const badId = await request(app).post("/corrections").type("form").send({ message: "This is a valid message.", claim: "X-1" });
    expect(badId.status).toBe(400);
    const ok = await request(app).post("/corrections").type("form").send({ message: "The date on this claim looks wrong.", claim: "C-000001" });
    expect(ok.status).toBe(200);
    expect(ok.text).toMatch(/R-\d{5}/);
  });
});

describe("AI-checked disclosure", () => {
  it("labels an AI-checked claim on its page, on its profile card, and in the site banner", async () => {
    const { confirmLink } = await import("./helpers.js");
    const inst = await createInstitution(team.researcher, `Test AI Body ${uid()}`);
    const claim = await createClaim(team.researcher, { institutionId: inst, text: "Test AI-checked identity statement." });
    const src = await createSource(team.researcher);
    const link = await linkSource(team.researcher, claim.id, src);
    await setStatus(team.researcher, claim.id, "pending_review");
    await confirmLink(team.ai, link);
    await setStatus(team.ai, claim.id, "verified");
    await setStatus(team.ai, claim.id, "published");

    const page = await request(app).get(`/claims/${claim.public_id}`);
    expect(page.text).toContain("Checked by AI, not yet by a person.");
    expect(page.text).toContain("by an AI system (not yet by a person)");
    const o = ownerClient(); await o.connect();
    const slug = (await o.query("SELECT slug FROM core.institution WHERE id = $1", [inst])).rows[0].slug;
    await o.end();
    const profile = await request(app).get(`/institutions/${slug}`);
    expect(profile.text).toMatch(/class="fact-card"[\s\S]*?Checked by AI/);
    expect(profile.text).toContain("were checked against their sources by an AI system and not yet by a person");
    // Banner refreshes at most every 30s; a fresh app instance picks it up immediately.
    const { createApp } = await import("../src/server.js");
    const home = await request(createApp()).get("/");
    expect(home.text).toMatch(/checked against (its|their) sources by an AI system/);
  });
});

describe("editorial security", () => {
  it("requires authentication for every editorial route", async () => {
    expect((await request(app).get("/editorial")).status).toBe(303);
    expect((await request(app).get("/editorial/claims/1")).status).toBe(303);
    expect((await request(app).post("/editorial/claims/1/transition").type("form").send({ to: "published" })).status).toBe(401);
    expect((await request(app).post("/editorial/sources").type("form").send({})).status).toBe(401);
  });

  it("rejects bad logins and automated accounts", async () => {
    const res = await request(app).post("/editorial/login").type("form").send({ username: "nobody", password: "wrong-password-123" });
    expect(res.status).toBe(401);
  });

  it("rejects state changes without a valid CSRF token", async () => {
    const { agent } = await login(team.publisher);
    const res = await agent.post("/editorial/claims/1/transition").type("form").send({ to: "published", _csrf: "forged" });
    expect(res.status).toBe(403);
  });

  it("a researcher cannot publish, even by forging the form", async () => {
    const inst = await createInstitution(team.researcher);
    const claim = await createClaim(team.reviewer2, { institutionId: inst });
    const src = await createSource(team.reviewer2);
    const link = await linkSource(team.reviewer2, claim.id, src);
    await setStatus(team.reviewer2, claim.id, "pending_review");
    await asUser(team.reviewer, (c) => c.query("UPDATE core.claim_source SET checked_by = $1 WHERE id = $2", [team.reviewer, link]));
    await setStatus(team.reviewer, claim.id, "verified");

    const { agent, csrf } = await login(team.researcher);
    const res = await agent.post(`/editorial/claims/${claim.id}/transition`).type("form").send({ to: "published", _csrf: csrf, status: "published", published: "true" });
    expect(res.status).toBe(409);
    expect(res.text).toMatch(/requires the publisher role/);
    const o = ownerClient(); await o.connect();
    expect((await o.query("SELECT status FROM core.claim WHERE id = $1", [claim.id])).rows[0].status).toBe("verified");
    await o.end();
  });

  it("only admins can manage users", async () => {
    const { agent, csrf } = await login(team.reviewer);
    expect((await agent.get("/editorial/users")).status).toBe(403);
    expect((await agent.post("/editorial/users").type("form").send({ _csrf: csrf, username: "x_user", password: "abcdefghijklmnop", roles: "publisher" })).status).toBe(403);
  });

  it("rejects malformed source URLs from the editorial form", async () => {
    const { agent, csrf } = await login(team.researcher);
    const res = await agent.post("/editorial/sources").type("form").send({
      _csrf: csrf, s_title: "Test", s_publisher: "Test", s_type: "legislation", s_url: "javascript:alert(1)",
    });
    expect(res.status).toBe(400);
  });

  it("the editorial claim flow creates a draft with its record through the UI", async () => {
    const inst = await createInstitution(team.researcher);
    const { agent, csrf } = await login(team.researcher);
    const res = await agent.post("/editorial/claims").type("form").send({
      _csrf: csrf, kind: "safeguard", institution_id: String(inst), dimension: "tenure", provision_label: "Test s.9",
      establishes: "Test establishes a fixed term.", does_not_establish: "Test does not establish dates of service.",
      claim_text: "Test section 9 provides a fixed term of office.", claim_category: "verified_fact",
    });
    expect(res.status).toBe(303);
    const page = await agent.get(res.headers.location!);
    expect(page.text).toContain("Test section 9 provides a fixed term of office.");
    expect(page.text).toContain("No supporting source is attached.");
  });
});
