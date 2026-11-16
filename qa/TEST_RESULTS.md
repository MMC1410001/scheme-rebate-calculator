# Scheme Performance & Impact Calculator — test execution report

| | |
| --- | --- |
| Date | 29-10-2026 (first run of the QA suite) |
| Note | Sanitised public copy: scheme names are made up and business figures are removed or illustrative. Test counts and timings are as measured |
| Build | Commit `88e227c` (all of `main`, `dev`, `uat`, `prod`) plus the new `qa/` folder |
| Environment | Local: Apple laptop, 8 cores, 16 GB · Python 3.14.8, FastAPI 0.162, pandas 3.1, uvicorn 0.54 (one process, port 8010) · Vite dev server (port 5173) · Node.js 22.23.2 · Playwright 1.63.0 · Google Chrome 156 · k6 1.7.1 |
| Data | Live month October 2026, `extract_October_2026_v20_no_condonation.xlsx` (as of 28 Oct, day 28 of 31). The client's figures are withheld in this public copy |

> The performance numbers come from one laptop running k6, the API and the browser on the same 8 cores, with one
> uvicorn process. They show the behaviour and the relative limits, not the capacity of the deployed servers.

## Versions: limit, delete, retention — 06-11-2026

Live month November 2026; local API with login off, local database. Functional and security only (as agreed).

| Suite | Result |
| --- | --- |
| scripts/check.sh (pytest, ruff, frontend unit tests, lint, build, audits) | all passed (pytest 85, 1 skipped: the row-level-security test, since the local database login is a superuser) |
| API + security, login off | 95 passed, 5 skipped; COMMON_TC_12_SEC (16 MB body) flaky: the server may close the connection before the upload ends (2 of 3 reruns passed; not part of this change) |
| UI in Chrome, login off | 33 passed, 1 skipped (UI_TC_27); UI_TC_30 new |
| By hand on the API | 10th save 200, 11th 409 in plain words; archive frees a place; a restore past 10 is 409; DELETE without JSON 415, with `{}` 200, then 404, no rows left; retention dry run with November live keeps from 1 Sep and lists an August version |

Not run: a real (not dry-run) retention on a database, so its `VACUUM (ANALYZE)` step is untested.

## QA run and fixes — 05-11-2026

A full QA pass (functional, API, UI, code review of backend and frontend) on `26b5c9c`, live month November 2026 v7,
found 21 defects; all were fixed the same day. Functional and security only (as agreed); performance (k6) not run.

| Suite | Before the fixes | After the fixes |
| --- | --- | --- |
| scripts/check.sh --data (pytest, ruff, frontend unit tests, lint, build, audits) | all passed (pytest 68) | all passed (pytest 79) |
| API + security, login off | 92 passed, 5 skipped | 96 passed, 5 skipped (login cases; 4 new) |
| API + security, login on (ADMIN + VIEWER test users) | 96 passed, 1 skipped | 100 passed, 1 skipped (needs a saved version) |
| UI in Chrome, login off | 30 passed, 1 skipped | 32 passed, 1 skipped (UI_TC_27; 2 new) |
| UI_TC_27, login on | 1 passed | 1 passed |

Defects fixed (severity):

| # | Sev | Defect | Fix |
| --- | --- | --- | --- |
| 1 | High | NaN / Infinity / 1e300 in a body: 500, or a 200 with a wrong total (NaN slab edge, NaN rate override) | Request models refuse NaN and Infinity (`Body`, `app/schemas.py`); `/growth` capped at 10,000% |
| 2 | High | The served ("actual") slab table was overwritten by a simulation when no figure was edited | `refreshRows` works on a copy (`useScopeData.ts`) |
| 3 | High | Filters in the address were cleared on reload | `MultiSelect` waits for its options (`UI_TC_28`) |
| 4 | High | An old slab answer could overwrite a newer one, or bring an edit back after Reset | Cancel + sequence per component; Reset cancels (`useSlabEdits.ts`) |
| 5 | Med | Escape in a figure box committed the typed value; Enter committed twice | `NumericInput`, `EditNum`, V box (`UI_TC_29`) |
| 6 | Med | Log out dropped unsaved edits without asking | In-app confirm |
| 7 | Med | Delete scheme / per-scheme Reset without confirm (Reset also without Undo) | Confirm + Undo |
| 8 | Med | 500 mix-share edits held a heavy-build slot for minutes (others got "busy") | At most 40 mix edits a request; the search stops at 1e-7 |
| 9 | Med | POST filter lists unbounded and not de-duplicated (cache / memory) | At most 500 values, trimmed, repeats once |
| 10 | Med | Wrong passwords from elsewhere locked the real user out | Limit per username and address (user's choice) |
| 11 | Med | Logging in as another user over an ended session kept the previous user's screen | A different user restarts the app; the same user keeps edits and re-runs |
| 12 | Low | Export with an open lower bound: 500 | `_slab` handles it (`SPC_TC_80`) |
| 13 | Low | `" 41 "` or `"41.0"` as a region: 0 dealers | Values trimmed and matched to the frame's spelling (`SPC_TC_79`) |
| 14 | Low | Chunked body over 16 MB: 400 | 413 in plain words |
| 15 | Low | A non-ASCII session cookie: 500 | Compared as bytes |
| 16 | Low | 422 bodies were pydantic lists | One sentence naming the field, never echoing the value |
| 17 | Low | Negatives with "-"; gift errors hidden or without Retry | `format.ts` everywhere; errors with Retry |
| 18 | Low | `APP_ENV` not set meant login off | Fails closed (user's choice) |
| 19 | Low | Warm-up and version recalculation not pinned to one month | Pinned; a replaced month is not written |
| 20 | Low | `/months/edited` ignored the edits and next month's tables | Uses the edited frames and `next_layouts` |
| 21 | Low | Two dialogs both handled Escape; page could stay unscrollable | Dialog stack in `useFocusTrap` |
| — | Low | Parallel logins could pass the limit; a bad `month` on version dealers was a 500; Save form / Edits panel without focus trap; archive without confirm; export link freed too early | Fixed |

## App.tsx split into hooks and components — 05-11-2026

Refactor only (no behaviour change). UI suite in Chrome run before and after on the same API (login off), and
UI_TC_27 with login on after. Four flows the suite does not cover were also checked once in Chrome with a temporary
Playwright file (deleted after): a typed total Volume, Reset all and Undo; a scheme name to Scheme detail and back;
an Overview chart drill-down to the Simulator; a rate edit kept across a filter change. No console error in any.

| Suite | Before | After |
| --- | --- | --- |
| UI in Chrome, login off | 30 passed, 1 skipped (UI_TC_27) | 30 passed, 1 skipped (UI_TC_27) |
| UI_TC_27, login on | — | 1 passed |
| Extra flows (temporary) | — | 4 passed |
| Frontend unit tests | 10 passed | 20 passed (10 new, src/app) |
| scripts/check.sh | all passed | all passed |

## Senior review fixes (security, capacity, routing) — 05-11-2026

Live month November 2026 v7. API on port 8010 (login off, then login on with throwaway users made in the shell and
deleted after), web app on the Vite server. Functional and security only (as agreed); performance (k6) not run.

| Suite | Cases | Passed | Failed | Skipped |
| --- | --- | --- | --- | --- |
| Backend unit tests (pytest, live-file checks included) | 68 | 68 | 0 | 0 |
| Frontend unit tests (`npm --prefix frontend test`, new) | 10 | 10 | 0 | 0 |
| API + platform and security, login off | 97 | 92 | 0 | 5 (login cases) |
| Login and security cases, login on (`COMMON_TC_17`-`21`, `_SEC`) | 15 | 15 | 0 | 0 |
| UI in Chrome, login off | 31 | 30 | 0 | 1 (UI_TC_27) |
| UI in Chrome, login on (UI_TC_27) | 1 | 1 | 0 | 0 |

Changed on purpose: an unknown filter value is now refused with 422 (it was 200 with nothing). SPC_TC_26 and the
last check of SPC_TC_74 failed on the first run for that reason; both were updated and pass. The web image was built
and checked: nginx runs as uid 101 and sends HSTS and the CSP.

## Code review fixes: login, one month per request — 05-11-2026

Live month November 2026 v7 (4 Nov). API on port 8010, run twice: login off (local, no users) and login on (an ADMIN
and a VIEWER made with `python -m app.auth_user`, in the shell only). Web app on the Vite server. Functional and
security only (as agreed); performance (k6) not run.

| Suite | Cases | Passed | Failed | Skipped |
| --- | --- | --- | --- | --- |
| Backend unit tests (pytest, live-file checks included) | 57 | 57 | 0 | 0 |
| API + platform and security, login off | 97 | 91 | 0 | 6 (login cases) |
| API + platform and security, login on | 97 | 95 | 0 | 2 (database cases) |
| UI in Chrome, login off | 30 | 30 | 0 | — |
| UI in Chrome, login on (UI_TC_27) | 1 | 1 | 0 | — |

New: COMMON_TC_16–21 (login, cookie flags, JSON only, VIEWER role) and UI_TC_27 (login screen); 36 pytest cases
(login and roles, the engine and every edit mode on a made-up month, one month per request, cache keys, export name).
SPC_TC_55 was stale (it expected the day pace removed on 4 Nov) and now checks factor = 1 + V. Also checked: the main
outputs (All India and one region, month table, next month at 0 and 5 %, an edited month with modes B, A, Q and R, a
moved boundary, a saved version) are identical before and after the change, figure by figure. API memory with every
cache warm levels off at about 1.5 GB (the container limit is set to 3 GB). SPC_TC_5 and SPC_TC_16, failing on the
faulty v5 demo file on 4 Nov, pass on v7.

## Faster edits; slab ranges from 0 — 04-11-2026

Same data (live month November 2026 v1). API restarted on port 8010 with the new build, web app on the Vite server.
Functional and security only (as agreed).

| Suite | Cases | Passed | Failed |
| --- | --- | --- | --- |
| Backend unit tests (pytest) | 21 | 21 | 0 |
| API + platform and security | 91 | 89 | 2 |
| UI in Chrome | 30 | 30 | 0 |

New pytest cases: an edit changes few (scheme, component) pairs; `/all-slabs/adjusted` and next month with reused
tables equal a full recompute. Also checked: 113 golden requests (every edit mode, three scopes, slab moves, scenario
preview) answer the same before and after the speed-up. Warm, All India: `/months` 1.15 → 0.24 s,
`/all-slabs/adjusted` 1.5 → 0.2–0.7 s, `/months/next` 2.3–2.8 → 0.4–1.2 s. Slab ranges: 21 target rows started below
0 (e.g. Zen Star Per 100 L below zero), now 0; VALUE FA's 0 – 0 rows show their rate tier (checked in Chrome). The two
failures are the known ones from November's demo file (SPC_TC_5, SPC_TC_16).

## API version /v1 and httpx2 — 03-11-2026

Same data and set-up as the run below (new build on port 8011, web app on a Vite server forwarding `/api`). Business
routes are now under `/v1` (the web app calls `/api/v1`; `/health` stays at the root); the TestClient uses `httpx2`
(no deprecation warning).

| Suite | Cases | Passed | Failed |
| --- | --- | --- | --- |
| Backend unit tests (pytest) | 18 | 18 | 0 |
| API + platform and security | 91 | 89 | 2 |
| UI in Chrome | 30 | 30 | 0 |

New: COMMON_TC_15 (routes under `/v1`, the unversioned path 404) and a pytest check that every route but `/health` is
versioned. The two failures are the known ones from November's demo file (SPC_TC_5, SPC_TC_16).

## Code review fixes — 03-11-2026 (security, caching, routing, structure)

Data: live month November 2026 v1; previous month October 2026. Run against the new build on port 8011 (the API on
8010 was left running), the web app on a Vite server forwarding `/api` to it. Performance tests not run (functional and
security only, as agreed).

| Suite | Cases | Passed | Failed |
| --- | --- | --- | --- |
| Backend unit tests (pytest, `backend/tests`, new) | 17 | 17 | 0 |
| API + platform and security | 90 | 88 | 2 |
| UI in Chrome | 30 | 30 | 0 |

New cases: COMMON_TC_12_SEC (16 MB body limit), COMMON_TC_13 (`/health`), COMMON_TC_14_SEC (`PATCH /scenarios/{id}`),
SPC_TC_76 (`/months/edited`, a 500 on every call before), UI_TC_26 (tab in the address bar). COMMON_TC_1 lists
`/health` and `/gifts/detail`. The same two failures as on 02-11 (also on the previous build, from November's demo
file): SPC_TC_5 (day 30 of 30, not complete) and SPC_TC_16 (Luxury: a handful of dealers in one region below the first slab
earned a few hundred rupees in the file; the engine pays nothing below the first slab). Also checked by hand: a scenario save writes
its definition, both months' live results and saved snapshots in one transaction; a duplicate name is 409; nginx
config passes `nginx -t`; `docker compose config` passes.

## Feature run — 02-11-2026 (gift file kept apart from CN, as-of date on every month)

Data: live month November 2026 v1 (extracted 30 Oct); previous month October 2026 main v22 (1 Nov, complete) and gift
file v24 (1 Nov). Run against the new build on port 8011. Performance and UI tests not run.

| Suite | Cases | Passed | Failed |
| --- | --- | --- | --- |
| API + platform and security | 85 | 83 | 2 |

New case SPC_TC_74 (`/gifts`); COMMON_TC_1 now lists `/gifts` and `/months/edited`. The two failures also fail on
the previous build with the same data, and come from November's demo file: SPC_TC_5 (extracted 30 Oct, so day 30 of
30 while not complete) and SPC_TC_16 (a Luxury row's CN is not cn_units × rate).

## Feature run — 30-10-2026 (remove a slab, delete a scheme)

Same environment and data. Performance tests not run (on request).

| Suite | Cases | Passed | Failed |
| --- | --- | --- | --- |
| API + platform and security | 75 | 75 | 0 |
| UI in Chrome | 29 | 29 | 0 |

New cases SPC_TC_62–64 and UI_TC_24–25. Checked by hand in Chrome: deleting Luxury lowered the current and next month's CN
by Luxury's CN, GSR unchanged; removing one of Luxury's slabs moved its dealers into the slab below and lowered
Luxury's CN.

## Feature run — 29-10-2026 (schemes and slabs inside the month table)

Same environment and data. Performance tests not run (on request).

| Suite | Cases | Passed | Failed |
| --- | --- | --- | --- |
| API + platform and security | 72 | 72 | 0 |
| UI in Chrome | 27 | 27 | 0 |

The scheme list now lives in the month table: product → scheme → slab tables in the three month columns; the
Current column is the editor (rates and boundaries typed in place). UI re-run after that change: 27 / 27. Outside the suites: the dealer list of every previous- and next-month slab row of every scheme
(V = 5%) returned exactly the row's dealer count. The current month's dealer list, every served row: same
count, codes, regions and depots present; a few dealers have no name in the source file.

## Feature run — 29-10-2026 (Previous · Current · Next month in the Simulator)

Same environment and data. Performance tests not run (on request).

| Suite | Cases | Passed | Failed |
| --- | --- | --- | --- |
| API + platform and security | 69 | 69 | 0 |
| UI in Chrome | 24 | 24 | 0 |

Checked by hand in Chrome at 1,600 px: the three months fit side by side; a Premium rate edit moved Premium's current
and next month by a few lakh and nothing else. Defect found and fixed during the build: in a grown
month, dealers who were below the first slab and grew past it were read as non-qualifiers (hundreds of dealers in one
component showed as "Not qualified"); qualification is now decided on the actual month's achievement.

## Feature run — 29-10-2026 (dealer list, slab editing everywhere, export, two users)

Same environment and data. Performance tests not run (on request).

| Suite | Cases | Passed | Failed |
| --- | --- | --- | --- |
| API + platform and security | 64 | 64 | 0 |
| UI in Chrome | 20 | 20 | 0 |

Engine checks outside the suites (the live month, All India, one zone and one region):

- Every served slab row: the dealer list returns exactly the row's dealer count.
- Every component re-applied unchanged with each region's own rate card: ₹0 moved, no dealer lost.
  Two defects were found and fixed on the way: the top band's open upper bound read as NaN (its list was empty),
  and dealers with negative achievement (returns above purchases) read as "moved" into the first band and were
  paid on negative units.
- A real export opened with openpyxl: sheets Summary, Schemes, Slabs; totals equal to the API (GSR
  and CN); every scheme and every slab row; the one edited row flagged; impact = that edit.

**Security finding SEC-1 (high, before any deployment beyond a laptop):** the API has no login. `/dealers` returns
dealer codes and names, so anyone who can reach the API can read them. Add authentication (and restrict who may
list dealers) before dev / uat / prod are opened to users.

## Fix run — 29-10-2026 (after the defect fixes)

Same environment and data. API restarted with the fixes; web app on the Vite dev server. Performance tests were
**not** run again (on request): PERF-1 is fixed in code and checked for correct answers only, not for timings.

| Suite | Cases | Passed | Failed |
| --- | --- | --- | --- |
| API (`api.spec.js`) | 43 | 43 | 0 |
| Platform and security (`common.spec.js`) | 11 | 11 | 0 |
| UI in Chrome (`ui_smoke.spec.js`) | 15 | 15 | 0 |

| Defect | Status | Fix |
| --- | --- | --- |
| UI-1 Plan tab crash | Fixed | `TrendView.tsx` shows a message when fewer than two months are available, instead of reading an empty list |
| SPC-6 `/trend` months and paths | Fixed | Months whose file is not on the server are listed under `excluded` ("Source file not available on this server"); complete months synced from GCS fill the gap (September v25), and the live month is projected (October, day 28). Read errors are logged on the server; the answer carries a generic message, no path |
| SPC-1 growth at 0% | Fixed | Payout that units × rate cannot explain ("Other (unattributed)") is carried through growth unchanged; per-pack growth adds whole packs to the published count instead of recounting. At 0%: base = grown, to the rupee |
| UI-2 hardcoded API address | Fixed in code; **needs values per environment** | Web app reads `VITE_API_BASE_URL` at build time (both `client.ts` and `TrendView.tsx`); API reads `CORS_ORIGINS`. Both are empty in `.env.dev`, `.env.uat` and `.env.prod` until the hosts are known |
| PERF-1 uncached `/slabs`, `/simulate`, `/reconciliation` | Fixed in code; not re-measured | The slab table is cached per scheme and scope and reused by `/simulate`; `/slabs` and `/reconciliation` answers are cached; all are cleared when a new file is loaded |
| SPC-2 growth at −100% | Fixed | `growth_pct` and per-scheme growth must be above −100 (422); rate multipliers cannot be negative |
| SPC-3 negative rate | Fixed | `/simulate` refuses a negative rate (422, names the row) |
| SPC-4 invalid slab structure | Fixed | `/simulate-slabs` refuses rates that are not one per band, boundaries that are not ascending, and negative rates (422 with the reason) |
| SPC-5 unknown component | Fixed | 404 `scheme '<key>' has no component '<name>'` |
| SPC-7 security headers | Fixed | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` on every response |

## First run — summary

| Suite | Cases | Passed | Failed | Notes |
| --- | --- | --- | --- | --- |
| API (`api.spec.js`) | 43 | 36 | 7 | All 7 failures are known defects SPC-1 to SPC-6 |
| Platform and security (`common.spec.js`) | 11 | 9 | 2 | SPC-6, SPC-7 |
| UI in Chrome (`ui_smoke.spec.js`) | 15 | 13 | 2 | Both from UI-1 (Plan tab crash) |
| Performance (k6) | 4 runs | 1 | 3 | 0% errors in every run; latency thresholds missed (PERF-1) |

## Defects

| # | Severity | Defect | Found by | Detail |
| --- | --- | --- | --- | --- |
| UI-1 | **Critical** | Clicking the **Plan** tab blanks the whole app | UI_TC_4, UI_TC_11 | `TypeError: Cannot read properties of undefined (reading 'month')`. `/trend` returns no readable month (SPC-6), and `frontend/src/components/TrendView.tsx:415` reads `months[0].month` with no empty-list guard. React unmounts the page; only a reload recovers. |
| SPC-6 | **High** | `/trend` cannot read any month, and its error text exposes server file paths | SPC_TC_15, COMMON_TC_10_SEC | Months April–September are read from fixed paths under `~/Downloads` (`backend/app/core/months.py`), which no server has. Each month's `error` field holds the full local path (`/Users/…/Downloads/…xlsx`). The synced GCS months (`backend/data/gcs/`) are not used by the trend. |
| SPC-1 | **High** | `/growth` at 0% reports a CN change of tens of lakhs | SPC_TC_29 | `grown_cn` about 1% below `base_cn` at 0% growth; GSR unchanged. Zero growth must cost exactly zero, so every growth answer carries this offset. |
| UI-2 | **High** | The web app calls `http://127.0.0.1:8010` on every environment | MAN_TC_6 (code review) | `frontend/src/api/client.ts:1` hardcodes `BASE_URL`, and the API's CORS allows only `localhost:5173`. On dev / uat / prod the browser calls the user's own machine. Needs a build-time API URL and per-environment CORS origins. |
| PERF-1 | **High** | `/slabs`, `/simulate` and `/reconciliation` slow down sharply with concurrent users | PERF_TC_2–4 | Each request rebuilds the slab table (about 120 ms of CPU) with no cache, in one process. 25 users: p95 850–870 ms; 60 users: p95 about 7 s; 100 users: p95 8–9 s. `/all-slabs` and `/growth`, which are cached, stay fast. |
| SPC-2 | Medium | `/growth` at −100% returns 500 and drops the connection | SPC_TC_30 | `ZeroDivisionError: division by zero`. Should be refused with 422 (growth must be above −100%) or answered. |
| SPC-3 | Medium | `/simulate` accepts a negative rate | SPC_TC_40 | A rate of −5% is applied and gives negative CN. BR-023: invalid edits must be refused with a reason. |
| SPC-4 | Medium | `/simulate-slabs` accepts an invalid slab structure | SPC_TC_41, SPC_TC_42 | Rates of the wrong length (2 boundaries, 2 rates) and boundaries in descending order both return 200 with numbers. BR-023. |
| SPC-5 | Low | `/simulate-slabs` with an unknown component returns 200 with empty rows | SPC_TC_43 | An unknown scheme returns 404; an unknown component should too. |
| SPC-7 | Low | No `X-Content-Type-Options: nosniff` header | COMMON_TC_11_SEC | No security headers on any response; the `server: uvicorn` header names the server. |

Not a defect: rows with `slab_mode: "target"` (per-dealer targets, the per-50 L add-ons) show each dealer's own
achievement range in scope, including negative lower bounds where returns exceed purchases. Only `"slab"` rows have
published edges (SPC_TC_21 checks those).

Observation, not tested as a defect: a later October version has far fewer scheme blocks than an earlier one (add-ons, trips
and gifts missing, one new block not recognised). See [docs/data-sources.md](../docs/data-sources.md).

## API suites — 54 cases, 45 passed, 9 failed

Run: `cd qa/api-tests && npm test` (4 workers, 3.6 s once the API is warm).

| Group | Cases | Passed | Failed |
| --- | --- | --- | --- |
| Functional (SPC_TC_1–15) | 15 | 14 | SPC_TC_15 [SPC-6] |
| Data validation (SPC_TC_16–25) | 10 | 10 | — |
| Edge (SPC_TC_26–33) | 8 | 6 | SPC_TC_29 [SPC-1], SPC_TC_30 [SPC-2] |
| Negative (SPC_TC_34–43) | 10 | 6 | SPC_TC_40 [SPC-3], SPC_TC_41 / 42 [SPC-4], SPC_TC_43 [SPC-5] |
| Platform and security (COMMON_TC_1–11) | 11 | 9 | COMMON_TC_10_SEC [SPC-6], COMMON_TC_11_SEC [SPC-7] |

All the domain rules hold on the live month's data: CN = units × rate on every attributed row; an untouched book
reproduces what was paid; the five zones add up exactly to All India (dealers, GSR and CN);
every zone, South included, has GSR and a plausible payout rate; slab edges stay national under a zone filter.

## UI suite — 15 cases, 13 passed, 2 failed

Run: `npm run test:ui` (headless Chrome 156, one worker, 2.3 min).

| Case | Result |
| --- | --- |
| UI_TC_1–3 Load, part-month badge, readout figures | Passed: schemes, dealers and GSR shown, "part month · day 28 of 31", no console error |
| UI_TC_4 Tabs | **Failed [UI-1]**: the page goes blank on Plan |
| UI_TC_5–8 Zone, region, find, verified only | Passed |
| UI_TC_9–10 Rate edit, impact, reset, expand / collapse | Passed |
| UI_TC_11 Plan tab presets | **Failed [UI-1]** |
| UI_TC_12 API down shows an error | Passed |
| UI_TC_13 No horizontal scroll at 1280, 768, 390 px | Passed |

## Performance (k6) — 0% errors in every run

Run from `qa/k6`, one script at a time, `SCOPES=mixed` (half All India, the rest zones and regions). Each run's JSON
summary is in `k6/reports/`.

| Run | Users | Requests | Errors | p95 all-slabs | p95 slabs | p95 simulate | p95 simulate-slabs | p95 growth | p95 lists | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PERF_TC_1 smoke | 1 | 21 | 0% | 35 ms | 142 ms | 126 ms | 33 ms | 313 ms | — | **Pass** |
| PERF_TC_2 load | 25 for 3 min | 3,524 (15.4/s) | 0% | 42 ms | **848 ms** | **873 ms** | 144 ms | 28 ms | **602 ms** | Fail (just over 800 / 500 ms) |
| PERF_TC_3 spike | 5 → 60 → 5 | 2,052 (13.5/s) | 0% | 68 ms | **7.1 s** | **7.0 s** | 729 ms | 52 ms | **3.7 s** | Fail; recovered after the burst |
| PERF_TC_4 stress | 25 → 50 → 100 | 6,028 (19.7/s) | 0% | **1.8 s** | **8.2 s** | **9.4 s** | **2.5 s** | 1.8 s | **5.5 s** | Fail (reported only) |

Thresholds (p95): all-slabs < 1.5 s, slabs / simulate / simulate-slabs < 800 ms, growth < 2 s, lists < 500 ms.

Reading: the API never failed a request, even at 100 users, but it serves one heavy request at a time. The cached
endpoints (`/all-slabs` for a known scope, `/growth` for a known value) stay in tens of milliseconds until the CPU
is saturated by the uncached ones. Up to about 25 planners at once, the uncached `/slabs` and `/simulate` take just
under a second at p95. Above that, waits grow linearly. Fixes to consider (PERF-1): cache the slab table per scheme
and scope as `/all-slabs` already does, reuse it in `/simulate`, cache `/reconciliation`, and run more than one
worker process.
