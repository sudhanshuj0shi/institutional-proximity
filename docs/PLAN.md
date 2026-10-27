# Institutional Proximity — Technical Plan (Stage 1)

## Repository investigation

There was no existing repository: the workspace was empty. Nothing was overwritten. The
environment provides Node 22, npm 10 and PostgreSQL 16, so the stack below is chosen
from scratch to fit the specification rather than to fit prior code.

## Recommended architecture

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node 22 + TypeScript (strict) | One language across server, client and tests; type checks are a QA gate. |
| Web server | Express 4, **server-rendered HTML** | Every page works without JavaScript (spec §10). The graph is a progressive enhancement over a list. |
| Templating | A tiny auto-escaping tagged template (`html\`\``) | Escaping is the default; raw HTML needs an explicit `raw()` call that is easy to audit. |
| Database | PostgreSQL 16, plain SQL migrations | Relational, constraint-rich, no graph DB needed. |
| Publication gate | **Inside the database** (triggers + `public_api` views + a read-only `ip_public` role) | The public site connects as a role that can only `SELECT` from views that already filter to `published`. A bug in a public route cannot leak a draft. |
| Visualisation | D3 (force layout with structural columns), bundled by esbuild | Custom network layout; SVG for small/medium graphs. |
| Fonts | Self-hosted via @fontsource | No third-party font requests (privacy, no tracking). |
| Tests | Vitest + Supertest against a real Postgres DB; Playwright + axe-core for UX/a11y | Invariants are tested at the layer that enforces them. |

## Main components

```
src/
  server.ts            – app wiring, security headers, rate limits
  db/                  – pools (public / editor), migration runner
  lib/html.ts          – escaping template, layout
  lib/dates.ts         – precision-aware date formatting (never invents precision)
  lib/validate.ts      – input validation (URLs, enums, lengths)
  public/              – public routes: home, directory, institution, person, map, claim, methodology, corrections
  editorial/           – login, queue, record forms, source attachment, review actions, audit view
  client/map.ts        – D3 graph (receives already-public data only)
migrations/            – numbered SQL files
seed/candidates.sql    – researched candidate claims, all `pending_review`
tests/                 – vitest (publication, integrity, security) + playwright (UX)
```

## Data model

Every factual record (institution identity, person identity, position, relationship,
appointment process and stage, safeguard, legal event, institutional facet) points to
exactly one **claim**. A claim carries the status lifecycle and has one or more
**sources** through `claim_source`. A record is publicly visible only if its claim is
`published` — status is never duplicated on the record, so it can't drift.

Polymorphic references (relationship endpoints, claim subjects) use paired nullable
foreign keys with `CHECK (num_nonnulls(...) = 1)`, so every reference is a real FK.

Dates are `(date, precision)` pairs with precision ∈ `day | month | year | unknown`.
A year-only date is stored as YYYY-01-01 with precision `year` and is displayed as "2019",
never "1 January 2019".

## Verification workflow

```
draft ⇄ researching → pending_review → verified → published
                                         ↓            ↓
                               needs_reverification / disputed → retracted
```

Database-enforced rules:

1. Only listed transitions are allowed.
2. `→ verified` requires: a supporting source of tier 1 or 2 (tier 1 if the claim is
   flagged sensitive); every supporting link records a section and an excerpt or
   passage description; each source has an access date and a valid http(s) URL; a
   `verify` review by a **human** user holding the reviewer role who did **not** author
   the claim (four-eyes).
3. `→ published` requires `verified` plus a `publish` review by a human user with the
   publisher role.
4. Only `verified_fact` and `official_finding` categories can be published in the MVP.
   Allegations and analytical interpretations are stored but blocked.
5. Content of a `verified`/`published` claim, and its source links, is locked;
   to change it, an editor must first move it to `needs_reverification` (which
   hides it).
6. The AI import account is flagged `is_human = false` and cannot verify or publish.

## Security boundaries

| Zone | Access |
|---|---|
| Public pages + `/api/public/*` | `ip_public` DB role → `public_api` views only. No notes, no reviewer identities beyond role labels. |
| Correction form | Public write to a single table via a narrow `SECURITY DEFINER` function; rate-limited; never auto-published. |
| Editorial (`/editorial/*`) | Session cookie (HttpOnly, SameSite=Strict), CSRF tokens, scrypt password hashes, RBAC: researcher, reviewer, publisher, admin. Uses `ip_editor` role. |
| Admin/migrations | Owner role from env, never used by the running app's public pool. |

## Milestones

1. Scaffold + plan (this file).
2. Schema, triggers, views, roles, audit log, tests for publication controls.
3. Design system, public pages with designed empty states.
4. Map (graph + list), appointment pipeline, safeguards explorer, timelines.
5. Editorial workflow UI.
6. Research candidate claims from primary sources → seeded as `pending_review` only.
7. QA: tests, lint, typecheck, build, Playwright responsive + axe checks.

## Trade-offs and assumptions

- **No content will be published by this build.** I can research and attach sources,
  but the spec forbids AI verification. Candidate claims are imported as
  `pending_review` under a non-human account; a human reviewer and publisher must act.
  The public site will therefore show designed empty states until that happens.
- Server-rendered pages instead of an SPA: less client complexity and works without JS;
  richer client interactivity is confined to the map and pipeline.
- Excerpts captured during research came through an automated fetcher and are flagged
  for reviewers to confirm word-for-word against the original document.
- The legal review recommended by the spec (§3) is outside what software can do and is
  listed as a launch blocker in the README.
