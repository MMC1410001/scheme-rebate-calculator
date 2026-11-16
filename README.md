# Scheme Performance & Impact Calculator and Planner

A pan-India Dealer Rebate Scheme **Dashboard, Simulator and Planner** for a paint manufacturer (called "Acme Paints" here).

> **Sanitised reference implementation.** This is a public copy of a private client project. Client, product and
> scheme names and all figures are replaced with made-up values; no client data, screenshots or source files are
> included, and the code needs the client's (private) monthly extract to show real numbers. Git history starts fresh.

Source of truth: *Scheme Performance & Impact Calculator and Planner — Requirements Document v1.0.1*.

## What it does

The tool replaces three manual exercises with one web application:

| View | Periods | Mode | Purpose |
| --- | --- | --- | --- |
| **Dashboard** | Previous Month, Current Month | Read-only | See how each scheme and product performed, pan-India |
| **Current Month Simulator** | Current Month | Editable | Change slabs, rates, GSR or product mix and see the CN impact at once |
| **Next Month Planner** | Next Month | Editable | Plan next month from an actual period, against a GSR / CN % / mix target |

- The **Previous Month is always locked**. Its credit notes are already disbursed.
- The Current Month estimate opens as an exact copy of the Previous Month structure.
- The Next Month plan opens as a copy of the Current Month estimate (or, if the user selects it, the Previous Month).
- **No predictive or ML model** is used anywhere. Every planned figure traces to an actual period plus user edits.

## Core metrics

Volume (L) · GSR · GSR Contribution · CN · CN % · Product Mix · Dealer Count · Rebate Position (vs pan-India average rebate %)

All views filter by **zone, region, depot and scheme**.

## Scheme archetypes (calculation engine)

| Archetype | CN rule | Editable |
| --- | --- | --- |
| Threshold Value CN | Fixed lump sum for the highest threshold reached | Thresholds, amount per tier |
| Slab-Based CN | Slab rate × GSR (%) or × volume (per unit), per qualifying period | Boundaries, rates, rate type, secondary condition, periods |
| Stacking Incremental CN | Fixed amount × completed volume blocks, added to slab CN | Block size, amount per block |
| First-Occurrence CN | Fixed amount on a dealer's first billing of a product | Amount, first-occurrence rule |
| Mutually Exclusive Choice | Only the selected option earns CN | Selected option |
| Gift or Contest Reward | Non-monetary reward on threshold | Not editable (read-only layer) |

In-bill discounts are not CN schemes, but they set GSR: **GSR = DPL × (1 − in-bill %)**. An in-bill change therefore changes CN: the rate base of every % CN and, for rupee-slabbed schemes, the slab a dealer reaches.

## Data inputs (read-only)

1. Periodic sales / billing extract — volume, GSR, product category per dealer and transaction.
   Read from GCS: `gs://example-scheme-files/scheme-extracts/output/<YYYY>/<MM>/`, never its `daily/` folder
   (for example `extract_October_2026_v20_no_condonation.xlsx`). See [docs/data-sources.md](docs/data-sources.md).
2. Scheme letter configuration — entered as structured config by the scheme admin team (no document parsing)
3. Gift & contest qualification data

The application never writes back to source systems.

## Run locally

Needs Python 3.14, Node 22 and Docker (for Postgres; optional). Run every command from the repo root unless it says otherwise.
On Windows use `backend\.venv\Scripts\python.exe` in place of `backend/.venv/bin/python`.

**1. One-time setup**

```bash
# Backend dependencies
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt

# Frontend dependencies
npm --prefix frontend install

# Settings: copy the example, then fill in GCS_CREDENTIALS_JSON (base64 of the service-account key). Leave
# SPI_DATABASE_URL / SPI_OWNER_URL empty to run without Postgres, and the ADMIN_* keys empty for no login locally.
cp backend/.env.example backend/.env.local
```

**2. Postgres (optional: saved versions and the data store)**

The app's tables are in schema `spi`, in an existing database (user's choice, 5 Nov 2026: no new database). Locally
that is the Docker container `spc-pg` (port 5434, database `scheme_performance`); on dev the shared `app_db`. Point
`SPI_DATABASE_URL` and `SPI_OWNER_URL` at it (one login can be both), then `cd backend && .venv/bin/python -m
app.spi.migrate` creates the tables (the Docker image does this at start). Only schema `spi` is created or changed.
Details: [backend/db/scheme_performance_calculator/README.md](backend/db/scheme_performance_calculator/README.md).

**3. Get the data**

The daily sync does not run on `APP_ENV=local`, so download the newest file from GCS by hand the first time and whenever you need a newer one. With `SPI_DATABASE_URL` set it also loads the files into Postgres.

```bash
cd backend && APP_ENV=local .venv/bin/python -m app.ingest.gcs_sync && cd ..
# A given month: add --year 2026 --month 10
```

**4. Start the two servers** (one terminal each)

```bash
# API on http://127.0.0.1:8010: business routes under /v1 (e.g. /v1/schemes), /health at the root, API docs at
# /docs with APP_ENV=local; the web app reaches it at /api/v1
APP_ENV=local backend/.venv/bin/python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8010

# Web app on http://127.0.0.1:5173
npm --prefix frontend run dev
```

Open http://127.0.0.1:5173. The API needs about a minute to warm up after it starts. Until then the web app shows "0 schemes", which is expected; the month-on-month trend takes a few minutes more. Stop either server with Ctrl+C.

Before a push: `scripts/check.sh` (backend tests, lint, typecheck + build, dependency audits; `--data` adds the checks on the live month's file). The API and UI suites are in [qa/README.md](qa/README.md).

**Login.** Locally, with the `ADMIN_*` keys empty, there is no login. Everywhere else the app asks for one (as in
an earlier internal app): `ADMIN_USERNAME` / `ADMIN_PASSWORD` for the administrator, `ADMIN_USERS` for more users
(`python -m app.auth_user <name> [ADMIN|VIEWER]` from `backend/` makes one), and `ADMIN_SESSION_SECRET`. A VIEWER sees
every view and can simulate, but cannot open dealer lists or save versions.

## Repository layout

```
docs/
  data-sources.md              GCS input folder, file naming, and data questions
  brd-summary.md               Plain summary of the BRD: flow, archetypes, calculation rules, principles
  requirements-traceability.md BR-001 … BR-033 with priority and status
  open-questions.md            Gaps and conflicts in the BRD to confirm with the client
backend/                       FastAPI API: GCS sync, ingest, slab engine, simulator (see CLAUDE.md)
frontend/                      React + Vite web app
  logic.md, erd.md, technical-solution-document.md, user-guide.md   How it calculates, the data model, the design, the user guide
CLAUDE.md                      Commands, architecture and domain rules for working on the code
qa/                            Test cases, Playwright API and UI suites, k6 performance scripts, latest results
```

`backend/data/` (files synced from GCS, sample files, parquet caches) and the monthly source files read from `~/Downloads` are client data and are git-ignored.

## Status

In build: FastAPI backend and React / Vite frontend. The API runs from files (the synced Excel file plus its parquet cache), held in memory. When `SPI_DATABASE_URL` is set, each synced file is also loaded into Postgres (`backend/app/spi/`, schema `spi`), and saved versions are kept there; `DATA_SOURCE=spi` reads month data from it.
