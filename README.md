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
| `import_batches`, `imports`, `import_rows`, `asset_field_sources`, `asset_conflicts`, `name_aliases` | Multi-spreadsheet import with per-field provenance, conflict review, and remembered name variants for facilities and teams. |
| `investigations` | Problem reports and undocumented-movement investigations. |
| `notifications`, `notification_preferences` | Per-user notifications and preferences. |

### Roles

| Role | Sees | Can |
|---|---|---|
| `admin` | Everything | Manage users, teams, facilities, plus everything below |
| `manager` | Everything | Imports, reports, resolve conflicts, link QR codes, investigations |
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

1. **Render Dashboard → New → Blueprint.** Connect GitHub if asked, give Render access to `chloejacks93/Arthroplasty-Hero`, select it, and choose branch **`main`**.
2. Render reads `render.yaml` and shows a **web service** and a **PostgreSQL 16 database**, both on the **free** plan in **Virginia**. `DATABASE_URL` is wired automatically; you never see or copy it.
3. It asks for two values:
   - `INITIAL_ADMIN_EMAIL`: your work email (you become the first administrator)
   - `INITIAL_ADMIN_NAME`: your name
4. Click **Apply**. The first build takes a few minutes. Each start runs database migrations first (transactional, locked, refuse edited migrations). If a migration fails, the new version doesn't start and the previous one keeps serving.
5. Open the web service → **Logs**, find the box that says **Initial administrator**, and copy the **temporary password**. It's printed once, only in your private Render logs.
6. Open the service URL (`https://arthroplasty-asset-control.onrender.com` or similar), sign in with your email and that temporary password, and set your own password.
7. **Imports → New import:** upload your spreadsheets. Then **People → Add person** for each rep, and assign trays from the Asset Registry (select → *Assign rep / team*).

**Plan: free (trial).** `render.yaml` uses Render's free web service and free PostgreSQL.
- **The free database expires about 30 days after creation and has no backups.** Before then, open the database in Render and **upgrade** it (e.g. *Basic-256mb*, about $6/month). The upgrade keeps all data. Set a calendar reminder for day 25.
- The free web service **sleeps after 15 minutes** without visitors; the next visit takes about a minute to wake it. Overdue-transfer reminders pause while it sleeps and catch up when it wakes.
- To move fully to production, change `plan: free` to `starter` (web) and `basic-256mb` (database) in `render.yaml`, or change the plans in the Render dashboard.

To recover admin access later (the **Shell** tab requires a paid web plan): `cd server && ADMIN_EMAIL=you@company.com ADMIN_NAME="Your Name" ADMIN_PASSWORD='a-long-password' node scripts/create-admin.js`.

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

### Phase 2: Master asset database and multi-spreadsheet importer ✅

**How an import works**
1. **Upload** one or more `.xlsx` or `.csv` files (up to 10 files, 10 MB each). The header row is found automatically, even below a report title, and every value is parsed from text: `$36,000.00`, `25.0`, `Overstocked⏎Understocked`. Optionally assign all rows of a file to a team.
2. **Preview.** Nothing is written yet. Every row is classified as New, Update, Duplicate, Conflict, Needs decision, Warning or Error.
3. **Map values.** Each *Warehouse* value maps to a team and each *Location* to a facility, either existing or created, with the facility type guessed from the name (HQ means warehouse, SURG CTR means surgery center, and so on). A name variant mapped to an existing facility is remembered for future imports.
4. **Decide** rows that share a Reference with an existing asset but differ in identifying details: same asset, different asset, or skip. Approval is blocked until every one is decided.
5. **Approve.** The import runs in one transaction under a lock, using the same analysis shown in the preview. Every change writes a permanent event.

**Matching priority.** Two rows are never merged on name alone.
1. Existing QR UUID (if a sheet has a QR/UUID column)
2. Catalog + serial **and** the same Reference
3. Reference + Lot, exactly
4. Reference only, which needs a human decision

The source data showed that a catalog + serial identifies an **instrument set, not a tray**. For example, SMS-REVERS INSTR #5A, #5B and #5C all carry AR-9501HS SN 642, and seven groups like this exist. A serial on its own is therefore never used as a tray identifier. Sibling trays stay separate records, and the preview notes the set they belong to.

**Field policy when a row matches an existing asset**
- Live custody fields (current facility, team, assigned rep) are **never silently overwritten**. A difference becomes a critical conflict. Empty fields are filled.
- The asset name (Reference) is never changed by an import.
- Descriptive and utilization fields take the newer spreadsheet value, recorded in history.
- When two files in the same batch disagree, the first file's value is kept and the other becomes a conflict.
- Re-importing the same change doesn't create duplicate conflicts. Re-uploading an identical file is flagged as already imported.

**Lot parsing.** The original Lot text is preserved verbatim. Catalog, batch and serial are parsed from 12 observed formats (e.g. `AR-9501HS BATCH# 14919754 SN# 808`, `(AR-9615CGS) BATCH/SN# 15483773/59`, `AR-9226CS - 10597429/275`). When the Lot column and Notes disagree, the row is flagged for verification rather than guessed.

**Also built:** import history (file, date, uploader, new, updated, duplicates, conflicts with live open count); a Conflicts screen with keep-current or use-spreadsheet decisions, individually or in bulk, where accepting a location writes a `location_corrected` event; per-field provenance on each asset (which spreadsheet supplied which value); a navigation badge for open conflicts and an in-app notification to managers when an import creates conflicts; and a **master Excel export** (36 columns, frozen header, filters, respects the registry's current filters and the user's visibility).

**Tested**
- **Real data:** all four supplied spreadsheets (123 rows) through the API and in the browser. Result: **112 unique assets, 11 cross-file duplicates combined, 0 false merges**, 4 teams and 9 facilities proposed. Seven multi-tray sets were kept separate, and two real Lot/Notes discrepancies were flagged (SMS-REVERS INSTR #6C and SMS-AUGMENTED MGS INSTR #1).
- **Edited copy of a real sheet:** moved location → critical conflict, live location unchanged, newer utilization applied. Changed lot → blocked for decision. Changed team → conflict. New kit → created. Conflict resolution → location moved, with the event in history.
- **36 automated tests:** 14 new for the importer (parser formats, value parsing, overlapping files, sibling trays, re-import, conflict and resolution, review decisions, remembered aliases, per-file team, permissions, .xls rejection, Excel export) plus the 22 from Phase 1. The test fixtures are synthetic. The real spreadsheets are **not** in the repository because they contain surgeon names and business data.
- **Migration 002** applied on top of a Phase 1 database containing data.
- **Desktop (1440 px) and iPhone 14** layouts for upload, review, conflicts and history.

**Known limitations**
- **Legacy `.xls` (Excel 97–2003) is not accepted yet.** The library that reads it safely is published only on a download site this build environment can't reach, and the npm copy has known vulnerabilities. Uploading an `.xls` explains how to re-save it as `.xlsx` in a few seconds. The supplied files are all `.xlsx`.
- `npm audit` reports a build-time-only ReDoS advisory in `picomatch` (used by Vite). No fixed version has been published yet. It doesn't affect the deployed app. Recheck when a patch is released.

### Phase 3: Asset registry and existing-QR scanning ✅

**Confirmed data mapping:** *Warehouse* = team, *Chattanooga Main HQ* = warehouse, *Tub* = tote.

**Scanning**
- **Scan Asset** (sidebar, top-bar button, and the first tile on the representative home screen) opens the phone's rear camera in the browser. There's no app to install and no relabeling. Codes are decoded on the device with jsQR, which works in iPhone Safari (Safari doesn't provide the built-in barcode API).
- The scanned value is the permanent identifier. Bare UUIDs are lower-cased; a URL that contains a UUID resolves to the UUID; any other random string is kept as-is. Matching is case- and whitespace-insensitive.
- **A linked label** shows the asset (location, rep, team, status, previous scan). The scan is recorded on the asset and in a permanent scan log. Repeated reads by the same person within 2 minutes add only one history entry.
- **A rep scanning another team's tray** still sees what it is, so physical possession is never a dead end. The scan is recorded, but the full record stays within team permissions.
- **An unrecognized label** opens a matching screen: search unlinked assets by name, lot or location and pick one. Inventory, management and admins link it immediately. Reps send a **link request** that an inventory lead approves or rejects on **QR Link Requests**, which has a nav badge and an in-app notification. Anyone scanning a code with a pending request sees who proposed which asset.
- **Enter code manually** is always available, for damaged labels or when the camera is blocked.
- The camera shuts off whenever a result is showing, when you leave the page, or when the app goes to the background. Blocked-camera, no-camera and camera-in-use states each explain what to do. On iPhone, the result replaces the camera view so it's on screen immediately.

**Linking rules (enforced in the database and API)**
- One active code per asset, and one asset per code. Linking a code that's already in use names the asset it belongs to.
- Replacing or unlinking a code requires a reason. The old link is kept, inactive, in permanent history (`qr_linked` / `qr_unlinked` events).
- **Scan to link** on an asset page walks an inventory lead through linking that specific asset. Registry filter **QR linked / No QR yet** shows what's left to link.

**Representative home:** large *Scan asset*, *Find a tray* and *My assets* tiles above their scoped figures. *Transfer*, *Receive* and *Report a problem* arrive with Phase 4, when those workflows exist.

**Tested**
- **44 automated tests** (8 new): code normalization, matching and scan logging, de-duplication, cross-team scans, link/replace/unlink rules, the request → approve/reject flow, duplicate-request prevention, permissions, and the registry QR filter.
- **Real camera decoding in Chromium,** with a generated video of a QR label as the camera feed (decoded in under 1 s). Tested: link via *Scan to link* on SMS-REVERS INSTR #5A, re-scan to the asset card, a rep on an iPhone 14 viewport scanning an unknown label, matching it to SMS-AUGMENTED MGS INSTR #1 and sending a request, admin approval, and manual entry lookup.
- **Migration 003** applied on top of the database holding your 113 imported assets.
- **Not yet tested on a physical iPhone.** This environment has no real device. The code follows Safari's requirements (inline, muted video, rear camera, HTTPS), but the first scans on a real phone after deploying are the real check. Camera access needs HTTPS, which Render provides.

### Phase 4: Transfers and receiving ✅

**Transfer** (*Transfer asset* tile, *Transfer* on a scan result or asset page): scan or search for the tray, then choose **destination facility**, **receiving rep** (or "Me, I'm taking it there") and an optional reason (one-tap chips). The system records asset, origin facility, destination, sender, recipient, time and status automatically.
- The asset becomes **In Transit**. Its recorded location and custodian **do not change until receipt is confirmed**, so the system never claims a move nobody has verified.
- One open transfer per asset (database-enforced). Reps can only transfer assets in their scope; anyone holding another team's tray uses *Report a problem*.
- The recipient gets an in-app notification immediately.

**Receive** (*Receive asset* tile with a waiting count, *Receive* in the sidebar, or simply scanning the tray):
- **Only the named recipient can confirm.** Managers can't confirm on someone's behalf; they cancel and re-send instead.
- **If the tray has a linked QR label, receipt requires scanning that exact label.** A different label is refused. Trays with no label yet can be confirmed without a scan, and the record says so.
- On confirmation, the location, custodian, status (warehouse or facility), last-transferred time and an immutable confirmation record update in one transaction. The sender is notified.
- If it arrived somewhere other than planned, the recipient picks the actual facility and must add a note, and management is alerted.
- **Not received** closes the transfer, marks the tray **Under Investigation**, opens an investigation linked to the transfer, and notifies the sender and management.

**Cancel:** sender or management, with a required reason, before receipt. The asset returns to its previous status and the recipient is notified.

**Overdue:** each transfer has a receipt deadline (`TRANSFER_ACCEPT_HOURS`, default 24). A background sweep every 15 minutes sends one reminder per day to the recipient, the sender and management. Overdue transfers are flagged across the app and counted on the dashboard.

**Report a problem** (anyone, including for another team's tray). Choose from *Can't find it*, *Moved without a transfer*, *Wrong location on record*, *Damaged*, *Incomplete* or *Something else*, with an optional "where is it actually?" facility. Missing assets become **Missing**, and undocumented movement or location errors become **Under Investigation**. Damaged and incomplete reports leave the status alone. Management is notified.

**Investigations** (management, inventory and admin; reporters see their own): take ownership, add notes, resolve or dismiss with a required outcome, and optionally **correct the live location** on resolution (writes `location_corrected`). Status is restored to what it was before the report unless changed. Every action goes into a permanent, append-only investigation log.

**Notifications:** a bell in the top bar with unread count, a list and mark-as-read. Counts refresh every minute. Preferences, email and push follow in Phase 7.

**Tested**
- **53 automated tests** (9 new) covering:
  - **Transfer and receipt rules:** the scope rule; In Transit without moving location or custodian; recipient notification; duplicate open transfers refused; recipient-only receipt (managers refused); label required and wrong label refused; no-label receipt; status and location after receipt; immutable confirmations and undeletable transfers.
  - **Cancel and failure paths:** cancel permissions, reason and status restore; not received → investigation → manager resolves with location correction.
  - **Overdue reminders:** one per day, to the recipient, sender and managers.
  - **Report a problem:** list visibility, report kinds and status effects, the ownership → resolve log, and closed-investigation protection.
- **Browser end-to-end on your imported data,** with the simulated camera showing the real linked label of SMS-AUGMENTED MGS INSTR #1:
  - **Transfer:** Test Rep (iPhone) scans the tray and transfers it to Park Ridge Medical Center → Second Rep.
  - **Receive:** Second Rep sees the bell and tile count, opens the notification, scans the tray, and confirms receipt. The asset shows Park Ridge in Second Rep's custody, with the full history in order.
  - **Not received:** a no-label transfer of MGS INSTR #10 is reported not received; the admin resolves it, correcting the location to Chattanooga Main HQ.
  - **Report:** a damage report is created from a scan.
  - No page errors.

### Phase 5: Facility, team and representative management ✅

**Facilities** (everyone; sidebar → Directory):
- **Directory:** every warehouse, hospital and surgery center with assets, trays/totes, reps, incoming transfers and exceptions. Search, type and status filters.
- **Facility page:** address and phone, and figures for assets here, incoming and outgoing in-transit, on cases, missing, overdue and consignment fees. Tabs:
  - **Assets:** filter by type, status, team and rep.
  - **Incoming / outgoing transfers.**
  - **Representatives:** tap-to-call phone numbers.
- **Visibility:** reps see counts for their own scope only (stated on the page).
- **Admins:** add, edit and deactivate facilities. A facility that still holds assets or has transfers heading to it can't be deactivated.

**Teams** (management): members, assets, trays/totes, in transit and exceptions per team. Admins add, rename and deactivate teams; deactivated teams keep their assets but disappear from pickers. Team names are unique (case-insensitive) and nothing is hard-coded.

**People** (management views; administrators change):
- **Add a person** with name, email, role (with a plain-language description), mobile, title and teams. A **temporary password** (e.g. `bbqx-udnz-msmq`) is generated and shown **once**, with a *Copy sign-in details* button. The person **must set their own password at first sign-in**; nothing else works until they do.
- **Edit, reset password, deactivate and reactivate.** Deactivating or changing someone's role signs them out on every device.
- **Guardrails:**
  - You can't deactivate or demote yourself.
  - You can't remove the last active administrator.
  - You can't deactivate someone who still has transfers in transit to them.
- **Your account:** click your name in the sidebar to change your password (other devices are signed out).

**Asset responsibility** (management): *Edit assignment* on an asset sets its assigned rep, team and home warehouse. **Bulk assignment:** tick rows in the Asset Registry (or select all on a page) and assign a rep and/or team in one step. Every changed asset gets its own history entry and note. Locations are never edited here; they change only through a transfer or an investigation.

**Permanent change log:** every user, team, facility and assignment change is written to an append-only `admin_audit` table (who, what changed from → to, when). Updates, deletes and truncation are blocked by triggers.

**Tested**
- **62 automated tests** (9 new) covering:
  - **Accounts:** creation with a one-time temporary password, duplicate email, the forced password change gate (every API refused until changed; the new password must differ), the edit and team-membership history, and the immutable change log.
  - **Guardrails:** self, last admin and open-transfer deactivation, plus sign-out everywhere on deactivation; password reset; team uniqueness and deactivation hiding.
  - **Facilities:** scoped counts and detail, and deactivation guarded by assets.
  - **Permissions:** managers view, only admins change.
  - **Assignment:** single (with home-warehouse validation) and bulk (rolls back entirely on any bad ID).
- **Browser end-to-end on your imported data:**
  - **Directory and editing:** facility directory (9 facilities) and Park Ridge Medical Center's detail; editing its address; Teams.
  - **New rep:** adding Jamie Rivera to CHATT-LOOKOUT LEGENDS with a temporary password. On an iPhone viewport, Jamie is forced to set a password, then lands on the six-button home screen.
  - **Assignment:** reassigning SMS-AUGMENTED MGS INSTR #12 to Jamie (it appears in Jamie's *My assets*), then bulk-assigning all 14 Park Ridge trays to one rep.
  - **Deactivation:** deactivating Jamie immediately signs them out.

**Imported data note:** the source spreadsheets have no representative column, so all imported assets start **Unassigned**. Use bulk assignment (filter by facility or team, select, assign) to set reps once their accounts exist.

**Not yet built (later phases):** audits, case assignments and utilization reports (6), notification preferences, email/push and installable PWA (7).
