# Arthroplasty Asset Control

A single system of record for every Arthroplasty tray, implant tote and set: where it is, who is responsible for it, where it has been, and who moved it.

Internal operational tool. **Do not store patient-identifying information.**

---

## Architecture

| Layer | Choice | Why |
|---|---|---|
| Server | Node 22 · Express 5 | Runs natively on Render, one deployable service |
| Database | PostgreSQL 16 (Render managed) | Relational integrity, unique constraints, triggers for permanent history, managed backups |
| Client | React 18 · Vite 7 · React Router 7 | Fast SPA served by the same Express process; installable as a PWA (Phase 7) |
| Design | Hand-built design system (`client/src/styles/app.css`) | Inter (self-hosted, works offline), midnight-navy chrome, restrained semantic colours |
| Auth | Server-side sessions in Postgres, bcrypt | Revocable sessions, no tokens in browser storage |

```
client/            React app (pages, components, design system)
server/
  migrations/      Ordered SQL migrations (never edited once applied)
  src/             Express app, routes, auth, migration runner
  scripts/         create-admin, seed-dev (development only)
  test/            Integration tests against a real PostgreSQL database
render.yaml        Render Blueprint (web service + database)
```

### Data model

| Table | Purpose |
|---|---|
| `assets` | One row per physical asset. Mutable fields: facility, rep, custodian, status. Preserves all spreadsheet columns (Reference, Type, Description, Agency, Warehouse, Location, Lot, Consignment Fee, Return Date, Items, Flags, Notes, utilization fields, Top HCP…) plus an `extra` JSON column so no source column is ever lost. Permanent ID `AH-000001`. |
| `asset_qr_codes` | The **existing** Arthrex QR value (UUID/random string). Unique among active links, so one QR can never belong to two assets, and each asset has at most one active QR. |
| `asset_events` | **Append-only ledger** of every movement and change, each with a user and timestamp. UPDATE, DELETE and TRUNCATE are blocked by database triggers. |
| `transfers`, `transfer_confirmations` | Custody transfers. Only one open transfer per asset. A transfer can't be marked received without a receiver and time, and confirmations are immutable. |
| `facilities`, `teams`, `users`, `user_teams` | Configurable directory. Nothing is hard-coded. Records are deactivated, never deleted. |
| `cases`, `case_assets` | Case assignments kept **separate** from physical movement. No patient fields. |
| `audits`, `audit_scans` | Physical inventory reconciliation. |
| `import_batches`, `imports`, `import_rows`, `asset_field_sources`, `asset_conflicts` | Multi-spreadsheet import with per-field provenance and conflict review. |
| `investigations` | Problem reports and undocumented-movement investigations. |
| `notifications`, `notification_preferences` | Per-user notifications and preferences. |

### Roles

| Role | Sees | Can |
|---|---|---|
| `admin` | Everything | Manage users, teams, facilities, plus everything below |
| `manager` | Everything | Reports, resolve conflicts, link QR codes, investigations |
| `inventory` | Everything | Imports, audits, link QR codes, investigations |
| `rep` | Assets in their teams, assigned to them, in their custody, or in a transfer they're part of | Scan, transfer, receive, report problems |

Row visibility is enforced in SQL on the server (`server/src/lib/roles.js`), not just hidden in the UI.

---

## Local development

Requires Node 22+ and PostgreSQL 14+.

```bash
cp .env.example server/.env        # then edit DATABASE_URL
npm ci --prefix server && npm ci --prefix client
npm run migrate --prefix server
npm run seed:dev --prefix server   # optional: clearly-labelled SAMPLE data, refuses to run in production
npm run dev --prefix server        # API on :3000
npm run dev --prefix client        # UI on :5173 (proxies /api)
```

Tests (need a disposable database whose name ends in `_test`):

```bash
TEST_DATABASE_URL=postgres://USER:PASS@localhost:5432/asset_control_test npm test --prefix server
```

## Deploying to Render

1. Render Dashboard → **New → Blueprint** → select this repository. `render.yaml` creates the web service and a PostgreSQL database and wires `DATABASE_URL` automatically.
2. Plans are set to paid tiers (`starter` web, `basic-256mb` Postgres). Render's free Postgres expires after 30 days and has no backups. Paid Postgres includes automated daily backups and point-in-time recovery.
3. Each deploy runs migrations before the server starts. Migrations are transactional, advisory-locked, and refuse to run if an applied migration file was edited. If a migration fails, the new version doesn't start and the previous deploy keeps serving.
4. Create the first administrator once, from the service's **Shell** tab:
   ```bash
   cd server && ADMIN_EMAIL=you@company.com ADMIN_NAME="Your Name" ADMIN_PASSWORD='a-long-password' node scripts/create-admin.js
   ```
   The password is never logged. Change it after first sign-in if you typed it on a shared screen.

No secrets live in this repository. All credentials come from Render environment variables.

---

## Build progress

### Phase 1: Inspection and foundation ✅

**Inspection findings:** `chloejacks93/Arthroplasty-Hero` was an empty repository (no commits, branches, Render config or database), so there was no existing code, schema or integration to preserve. The foundation below was built new.

**Completed**
- Full relational schema for every entity in the spec (above), with constraints that make bad data impossible at the database level: QR uniqueness, serial uniqueness, one open transfer per asset, required actor on every event, permanent history, no hard deletes.
- Migration runner (checksummed, transactional, advisory-locked) wired into Render start-up.
- Authentication: bcrypt, server-side revocable sessions, HttpOnly/Secure/SameSite cookies, account lockout after 5 failures, login rate-limiting, timing-safe unknown-user handling, CSRF header guard, Helmet security headers and CSP.
- Role-based access with row-level asset scoping for representatives.
- Enterprise UI shell: navy sidebar, top bar with global search (⌘K / `/`), responsive drawer navigation on phones and tablets.
- Operations dashboard: KPI strip (total, trays/totes, at facilities, warehouse, in transit, awaiting receipt, missing, overdue, investigations), requires-attention table, assets by location, activity ledger, data quality.
- Asset registry: server-side search (name, QR UUID, lot, serial, facility, rep, `AH-` code), filters (status, type, location, team, rep), sortable sticky-header table, pagination, stacked rows on phones.
- Asset detail: full record, utilization, custody and location, linked QR, permanent movement timeline, transfers, per-field import provenance, open-conflict warning.
- Render Blueprint, admin bootstrap script, dev-only sample seeder.

**Tested**
- 22 automated integration tests against real PostgreSQL. They cover QR duplicate prevention (case- and whitespace-insensitive), one QR per asset, serial uniqueness, append-only ledger (UPDATE, DELETE and TRUNCATE all blocked), no hard deletes, one open transfer per asset, migration idempotency and tamper detection, auth (bad password, lockout, logout revocation, system user can't sign in, CSRF guard), rep vs manager visibility on list, detail and dashboard, search by QR, code and lot, and input validation returning 400 rather than 500.
- Production build and start simulated locally with the exact Render commands, with migrations running at boot.
- UI checked in Chromium at desktop (1440×900) and iPhone 14 sizes.

**Not yet built (later phases):** spreadsheet import (Phase 2), QR camera scanning and linking (3), transfer and receipt workflows (4), admin screens for users, teams and facilities (5), audits, reports and Excel export (6), notifications and PWA (7). The schema for all of these is already in place.
