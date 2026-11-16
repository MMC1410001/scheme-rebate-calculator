# Scheme Performance & Impact Calculator — QA suite

This folder holds the functional, UI and performance tests of the Scheme Performance & Impact Calculator. The layout
follows the QA approach of an earlier internal project (Playwright for the API and the browser, k6 for performance).

- Test cases with IDs, expected results and priorities: [TEST_CASES.md](TEST_CASES.md)
- Latest run and the open defects: [TEST_RESULTS.md](TEST_RESULTS.md)

| Suite | Files | Cases |
| --- | --- | --- |
| API | `api-tests/tests/api.spec.js` | `SPC_TC_1`–`43`, tagged `@functional`, `@validation`, `@edge`, `@negative` |
| Platform and security | `api-tests/tests/common.spec.js` | `COMMON_TC_1`–`11` (`_SEC` = security) |
| UI (Chrome) | `api-tests/ui/ui_smoke.spec.js` | `UI_TC_1`–`13` |
| Performance | `k6/smoke.js`, `load.js`, `spike.js`, `stress.js` | `PERF_TC_1`–`4` |

The API serves aggregates only (zone, region, depot, scheme, slab). No test reads, prints or stores a dealer code
or name: those are client data.

## Step 0 — Install the tools (one time)

| Tool | Used for | Install on a Mac |
| --- | --- | --- |
| Python 3, Node.js 22 | The backend and the web app | See the [main README](../README.md) and [CLAUDE.md](../CLAUDE.md) |
| Google Chrome | The UI suite (uses the installed Chrome, no browser download) | chrome.google.com |
| k6 | Performance tests | `brew install k6` |

Then, once: `cd qa/api-tests && npm install`.

## Step 1 — Start the app

From the repo root:

```bash
APP_ENV=local backend/.venv/bin/python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8010
npm --prefix frontend run dev        # http://localhost:5173
```

The API needs synced data in `backend/data/gcs/` (`python -m app.ingest.gcs_sync`, run from `backend/`). Wait for
`warm: all-slabs` in the API log (or `"ready": true` from `GET /health`) before testing: until then the first requests wait for the warm-up.

## Step 2 — API suites (Playwright, no browser)

```bash
cd qa/api-tests
npm test                     # api.spec.js + common.spec.js
npm run test:functional      # or :validation, :edge, :negative, :security
npm run report               # opens the HTML report
```

**An API with login** (every server except a local one without `ADMIN_*` keys): set `QA_USER` / `QA_PASSWORD` (an
ADMIN; the suite logs in once, `tests/login.setup.js`) and, for the role cases, `QA_VIEWER_USER` /
`QA_VIEWER_PASSWORD`. Without them the login cases (`COMMON_TC_17`–`21`, `UI_TC_27`) are skipped. The other UI cases
expect an API without login; with one, run only `npm run test:ui -- -g UI_TC_27`.

`API_BASE_URL` points the suite at another server (default `http://127.0.0.1:8010`; the cases call the business routes under `/v1`). `UI_ORIGIN` is the web app
origin that CORS must allow (default `http://localhost:5173`).

## Step 3 — UI suite (Chrome)

```bash
cd qa/api-tests
npm run test:ui              # headless Chrome, one worker
npm run report:ui
UI_BROWSERS=chrome,firefox,webkit npm run test:ui   # after: npx playwright install firefox webkit
```

`UI_BASE_URL` is the web app (default `http://localhost:5173`); `API_BASE_URL` the API the cases read the expected
figures from.

## Step 4 — Performance (k6)

Run the smoke test first; it must pass cleanly. Then the others, one at a time, with nothing else using the API.

```bash
cd qa/k6
k6 run smoke.js              # 1 user, 30 s
k6 run load.js               # 25 users, 3 min   (TARGET_VUS, HOLD)
k6 run spike.js              # 5 -> 60 -> 5 users (BASE_VUS, SPIKE_VUS)
k6 run stress.js             # 25 -> 50 -> 100 users (MAX_VUS)
```

`BASE_URL` points at another server. `SCOPES=national` keeps every request on the All India book (cache only);
the default `mixed` also uses zones and regions, so some requests build a new scope. Each run writes
`k6/reports/<script>-summary.json`.

The numbers depend on the machine. A laptop running k6, the API and the browser on the same cores shows the
behaviour and the relative limits, not the capacity of the deployed server. Run k6 again against dev / uat.

## Step 5 — Report

Update [TEST_RESULTS.md](TEST_RESULTS.md) with the date, the build (commit), the environment, the pass / fail counts
and the k6 table. A failing case whose title carries a defect id ([SPC-n], [UI-n]) is a known defect; any other
failure is new and needs a defect entry.
