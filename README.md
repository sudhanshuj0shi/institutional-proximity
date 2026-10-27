# Institutional Proximity

An evidence-led public record of the structures, appointments and relationships surrounding
India's independent institutions. Every statement shown has a claim ID, its source, the
location of the support in that source, and the date it was last verified.

> **Current state (27 Oct 2026):** 48 of 49 researched claims about the Election Commission
> of India, the Comptroller and Auditor-General of India and the Central Information
> Commission are published **as AI-checked**. The site owner authorised this. Every such
> claim is labelled "Checked by AI, not yet by a person" on its claim page, in its margin
> note and in lists, and a site-wide banner gives the count. The methodology explains the
> two levels of checking. One sensitive claim (the Anoop Baranwal holding) is held for a
> person to check, because the database never lets an AI check sensitive claims.

## Quick start

Requirements: Node 22+, PostgreSQL 14+ (developed on 16).

```bash
npm install
cp .env.example .env          # fill in real values; generate SESSION_SECRET with:
                              # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
createdb institutional_proximity
npm run db:migrate            # creates schema, triggers, public views, and the ip_public / ip_editor roles
npm run db:seed-candidates    # optional: imports the 49 candidate claims as pending_review
npm run editor:create-user -- alice "Alice Example" researcher,reviewer,admin
npm run editor:create-user -- bob   "Bob Example"   reviewer,publisher
npm run build
npm start                     # http://localhost:3000, editorial desk at /editorial
```

Optional, owner-authorised: publish the AI-reviewed candidate set, labelled as AI-checked:

```bash
npm run db:ai-publish         # only ever acts on claims created by the research-import account
```

## Deploying to Railway

The repo includes a `Dockerfile` and `railway.json`. The release step (`node dist/db/release.js`)
runs migrations, imports the candidate set, and publishes the AI-checked claims when
`AI_PUBLISH_REVIEWED_CANDIDATES=true`. Every step is idempotent.

1. Create a project with a **PostgreSQL** service and a service from this repo.
2. On the app service, set:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `IP_PUBLIC_PASSWORD`, `IP_EDITOR_PASSWORD`, `SESSION_SECRET`: long random strings
   - `COOKIE_SECURE=true`, `TRUST_PROXY=true`, `NODE_ENV=production`
   - `AI_PUBLISH_REVIEWED_CANDIDATES=true` to publish the AI-checked set, or `false` to keep
     everything for human review
3. Generate a public domain. The health check is `/healthz`.
4. Create human editors with the user CLI pointed at the Railway database
   (`DATABASE_URL=… npm run editor:create-user -- …`).

The public and editor connections are derived from `DATABASE_URL` using the two
least-privilege roles that the migrations create.

`editor:create-user` prints a generated password once. You need **at least two human
editors**, because the database refuses to let anyone verify a claim they wrote. Imported
candidates were written by the automated import account, so any human reviewer can verify
them, but only after personally opening each source.

For development: `npm run dev` (watches server code; rerun `npm run build:client` after
changing `src/client/*`).

### Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL_OWNER` | Owner connection. Used only for migrations, seeding and the user CLI. |
| `DATABASE_URL_PUBLIC` | `ip_public` role. Can only `SELECT` from `public_api` views. |
| `DATABASE_URL_EDITOR` | `ip_editor` role. Works on internal tables, always under trigger rules. |
| `IP_PUBLIC_PASSWORD`, `IP_EDITOR_PASSWORD` | Assigned to those roles by `db:migrate`. |
| `SESSION_SECRET` | 32+ random characters; keys the HMAC of session tokens. |
| `COOKIE_SECURE` | `true` behind HTTPS. |
| `TRUST_PROXY` | `true` behind one reverse proxy, so rate limits see client IPs. |
| `PORT` | Default 3000. |

## Verifying and publishing a claim

To upgrade an AI-checked claim to "Checked by a person": take it down for re-verification,
resubmit it, re-confirm each source as a person, then verify and publish. The database
requires every source to be re-confirmed by a person before a person's verification counts.


1. Sign in at `/editorial`. The queue lists every claim and its status.
2. Open a claim. The **Readiness** panel lists exactly what blocks verification and publication.
3. For each supporting source: open it yourself, check the passage, correct the section,
   excerpt or description if needed, record the access date on the source, then tick
   *"I opened this source myself…"* and **Confirm check**.
4. A reviewer who did not write the claim selects **Verify**.
5. A publisher selects **Publish**. Entity identity claims must be published before
   anything about that entity can be.

Taking a claim down (**re-verification** or **disputed**) is always available to any
editor and hides it immediately. **Retract** needs a publisher and a public correction note.

## Architecture

```
src/
  server.ts                 Express app, security headers, error handling
  config.ts                 env loading and validation
  db/migrate.ts             migration runner (owner connection)
  db/pool.ts                ip_public pool, ip_editor pool, withActor() transaction helper
  db/candidates.ts          researched candidate claims (data)
  db/seed-candidates.ts     imports them as pending_review under a non-human account
  lib/html.ts               auto-escaping html`` templates, safeHref, safe JSON embedding
  lib/dates.ts              precision-aware date formatting
  lib/validate.ts           input coercion, URL and date parsing
  lib/security.ts           CSP and headers, in-memory rate limiting
  lib/labels.ts             controlled vocabulary and neutral explanations
  public/                   public pages and /api/public (reads ip_public only)
  editorial/                auth (scrypt, server sessions, CSRF), desk routes, record specs, language checker
  client/map.ts             D3 relationship map (progressive enhancement)
  client/enhance.ts         in-page safeguard filter
migrations/                 001 schema, 002 publication rules, 003 public API + roles
public/css/site.css         design system
tests/                      vitest (DB rules, HTTP, unit) and Playwright (tests/e2e)
docs/PLAN.md                Stage 1 technical plan
```

**Key decisions**

- **The publication gate is in PostgreSQL.** Triggers enforce the lifecycle, role
  requirements, four-eyes verification, evidence completeness, content locking and audit
  logging. The public site connects as a role that can only read views already filtered to
  published records whose referenced entities are also public. Application checks only make
  error messages friendlier; they are never the sole safeguard.
- **Every factual record is backed by exactly one claim**, and its visibility comes from that
  claim. Status is never duplicated on records, so it can't drift.
- **Polymorphic references use paired foreign keys** with `num_nonnulls` checks, so every
  reference is a real foreign key.
- **Dates are `(date, precision)` pairs**, with a check constraint that rejects stored
  precision a source doesn't support.
- **Withdrawn claims are listed without their text**, so a retracted statement is never
  republished as fact.
- **Server-rendered HTML** works without JavaScript. The map is drawn over a list that is
  always present.
- **Strict CSP** (`script-src 'self'; style-src 'self'`) with no inline scripts or styles.
  Fonts are self-hosted, so there are no third-party requests.

## Tests (actually executed on 27 Oct 2026)

The AI-checked tier adds tests showing that: an AI reviewer can publish a non-sensitive claim
and the public views label it; an AI reviewer can never check a sensitive claim, retract,
or publish a claim a person verified; a person can't hold the AI role; a person's
verification requires sources re-confirmed by a person and upgrades the label; the label
and banner render; and the publish script never touches claims written by people. An axe
accessibility and overflow check of 8 published pages at desktop and mobile size found
no serious issues.


| Command | Result |
|---|---|
| `npm run test` (vitest, real PostgreSQL) | **54 passed**, 0 failed, across 3 files |
| `npm run test:e2e` (Playwright, desktop and Pixel 7) | **36 passed**, 0 failed |
| `npm run lint` | 0 problems |
| `npm run typecheck` (server and client) | 0 errors |
| `npm run build` then `npm start` | builds; pages, JS, CSS and fonts serve with 200 |
| `npm run secrets:check` | no secrets in source files |

What they cover:

- **Publication controls:** drafts never in public views; a client can't insert a
  published claim; no skipping states; verification needs a human reviewer who isn't the
  author; automated accounts can't hold review roles; a researcher forging the publish form
  gets 409; disputed, re-verification and retracted claims are hidden; retraction needs a
  public note; retracted text is not exposed; retraction is terminal.
- **Source integrity:** no source, unchecked link, tier-3-only source, missing section or
  missing access date each block verification; sensitive claims need tier 1; contradictory
  evidence is kept and must be acknowledged; malformed URLs are rejected; a source becoming
  unavailable flags claims without hiding or deleting them.
- **Relationship integrity:** invalid entity references, unsupported relationship types and
  self-loops are rejected; record kind and subject must match the claim; a position can't be
  published before its endpoints are public; the graph builder never draws an edge without a
  record or to a non-public entity.
- **Security:** editorial routes require auth; CSRF is enforced; only admins manage users;
  the public role can't read or write internal tables; the public API omits internal notes;
  stored content is HTML-escaped (XSS fixture); the audit log is append-only.
- **User experience:** axe-core finds no serious or critical WCAG 2.1 AA violations on 8
  pages at desktop and mobile size; there is no horizontal overflow on mobile; map edge and
  node selection work by mouse, touch tap and keyboard (Enter/Escape); filters update both
  the graph and the list; the list works with JavaScript disabled; the pipeline, safeguard
  filter and date precision render correctly.

Playwright tests use a throwaway database of clearly fictional "Fixture …" records published
through the real workflow by test accounts. The unit and HTTP tests use their own throwaway
database. Neither touches application data.

## Candidate data awaiting verification

`src/db/candidates.ts` holds 49 claims, 21 sources, 7 institutions/bodies and 2 people,
researched on 27 October 2026 and given a second AI review pass the same day. Each claim's
internal notes carry an "AI review" line that says what was opened and what to check.

- **Published as AI-checked (48):** everything except the item below. Originally 46 were ready;
  two more were unblocked by opening reputable secondary sources (a law review for the
  2023 Act's commencement, a news report quoting the CEC notification).
- **Before the second pass, 46 claims were READY for human check:** every supporting source was opened by an automated
  tool and the cited passage located. A human must still open each one and confirm it.
- **3 claims are BLOCKED:** a supporting primary source refused automated access. These are
  the 2023 Act process (India Code PDF footnote), the Anoop Baranwal holding (judgment PDF),
  and the CEC appointment (Gazette S.O. 860(E)). Open the source, record the access date, then
  review as normal.

- **Election Commission of India (25 claims, including people and committees):** Article 324 identity, mandate and
  composition; the 2023 Act's appointment process (Search Committee, Selection Committee,
  President) and its tenure and removal provisions; the Anoop Baranwal interim arrangement
  (an official finding, marked sensitive so it can't be verified until the judgment text
  is attached); legal events; the March 2024 Election Commissioner appointments from
  Gazette notification S.O. 1358(E); the February 2025 Chief Election Commissioner
  appointment (news sources only so far).
- **CAG (11 claims):** Article 148 appointment, oath, removal, conditions of service,
  post-tenure bar, charged expenditure; the Article 151 reporting channel.
- **CIC (12 claims, including the section 12(3) committee):** RTI Act section 12 identity, composition, appointment committee,
  autonomy and disqualifications; the 2019 amendment to section 13 (third-party copy only).
- **Shared (1 claim):** the President of India's identity as the appointing authority.

Resolved in the second pass:

- **Commencement of Act No. 49 of 2023:** recorded as 2 January 2024 (S.O. 35(E)), from India
  Code's own text. The catalogue date "2-02-2024" is attached as contradicting evidence.
- **Election Commissioners' start date:** 15 March 2024, from News On AIR citing an ECI
  statement. The 14 March 2024 date in some sources is the notification date, so it was not used.
- **CEC appointment:** now cites Gazette S.O. 860(E) of 17 February 2025.
- **CIC claims:** now rest on the CIC's official consolidated RTI Act (as on 18 Nov 2025) and
  the Gazette copy of the 2019 Amendment Act. The 2019 amendment is in force from 24 October 2019.

Still open for reviewers:

- **Excerpts came through automated tools** that summarise and limit quotation. Every excerpt
  must be confirmed word for word.
- **Edition of the Constitution copy.** The MEA Part XV PDF has no edition date; the Lok Sabha
  2024 edition could not be read past Article 35 by the tools used.
- **Search Committee head:** enacted text names the Minister of Law and Justice; the Bill named
  the Cabinet Secretary.
- **Pending litigation:** W.P.(C) No. 14 of 2024 is recorded only as listed on 12 January 2024.
  A 2025 petition challenging the appointments has been reported; it is not recorded.
- **Not researched:** CAG term of office; current CAG and CIC officeholders; CIC term rules.

### Suggested publishing order

Identity claims must be published before anything about that entity. Publish in this order:
1. Identity claims: ECI, CAG, CIC, President of India, the three committees, and the two people.
2. Facets (mandate, composition, accountability) and safeguards.
3. Appointment processes, then their stages.
4. Positions, relationships, legal events.

## Not yet built, and known limitations

- **Legal review has not happened.** The spec asks for review by an Indian lawyer of the
  publication policy, methodology and sensitive claims. Software can't do that.
- **No archive integration.** `archived_url` exists but nothing creates archives automatically.
- **No ingestion automation** beyond the one-off candidate import (spec §8 says manual first).
- **Correction reports have an editorial inbox but no email notifications.** Submitters'
  optional contact details are stored only for follow-up.
- **Rate limiting is in-memory per process.** Use a shared store if you run several instances.
- **Language checks are advisory.** The inflammatory-label checker warns reviewers but doesn't
  block, because an official finding may quote such words.
- **The map uses a static force layout.** It is sized for small and medium graphs (SVG);
  very large graphs would need Canvas rendering and clustering.
- **No public "sources" index page.** Sources appear on claim and institution pages.
- **Editorial forms are functional rather than polished.** They have not had the same
  accessibility audit as the public pages.
- **`public_biography` from the suggested schema was deliberately left out.** Unsourced prose
  about people conflicts with the evidence policy; biographical facts are claims instead.
