# Test cases — Scheme Performance & Impact Calculator

Every case below has an ID. The automated ones carry the same ID in their test title, so a failed run points
straight back here. Results of the latest run: [TEST_RESULTS.md](TEST_RESULTS.md). How to run: [README.md](README.md).

| Prefix | Area | Where |
| --- | --- | --- |
| `SPC_TC_n` | API: functional, data validation, edge, negative | `api-tests/tests/api.spec.js` |
| `COMMON_TC_n` | API: docs, routes, security | `api-tests/tests/common.spec.js` |
| `UI_TC_n` | Web app in Chrome | `api-tests/ui/ui_smoke.spec.js` |
| `PERF_TC_n` | Performance | `k6/*.js` |
| `MAN_TC_n` | Manual (not automated yet) | this file |

Priority: **P1** wrong numbers, a crash or a blocked user · **P2** a rule or validation gap · **P3** polish.
A defect id in brackets, for example [SPC-1], means the case fails today because of that defect.

## 1. Functional — API

| ID | Test case | Expected result | Priority |
| --- | --- | --- | --- |
| SPC_TC_1 | GET /schemes | Every scheme once, with key, label, type and a known status (ok, needs_review, no_data, qualifier) | P1 |
| SPC_TC_2 | GET /filters | Zones, regions and depots non-empty and sorted. Each region sits in exactly one zone | P1 |
| SPC_TC_3 | GET /all-slabs, no filter | filters, schemes, grand, source. scheme_count = number of schemes; every scheme has dealers; rows carry all 19 fields | P1 |
| SPC_TC_4 | Scheme order in /all-slabs | Largest payout first | P3 |
| SPC_TC_5 | source block | Month YYYY-MM, as-of date, 0 < elapsed days ≤ month days; a part month is never marked complete | P1 |
| SPC_TC_6 | GET /slabs for a scheme | Same rows, CN and dealers as that scheme inside /all-slabs | P1 |
| SPC_TC_7 | POST /simulate, no overrides | Delta 0; simulated = current on every row | P1 |
| SPC_TC_8 | POST /simulate, one rate doubled | That row pays cn_units × new rate; every other row unchanged; delta = the extra on that row | P1 |
| SPC_TC_9 | POST /simulate-slabs with new boundaries | Rows fall into exactly the bands given; percent rows pay cn_units × new rate; delta = simulated − current | P1 |
| SPC_TC_10 | Move the same component's boundaries twice | Dealer count and actual CN unchanged: re-bucketing never loses a dealer | P1 |
| SPC_TC_11 | POST /growth +10% | GSR × 1.10 exactly; CN not lower; some dealers move up a slab | P1 |
| SPC_TC_12 | /growth with per_scheme | The named scheme uses its own growth %; the rest use the default | P2 |
| SPC_TC_13 | /growth with rate_multipliers | Grown CN at new rates = grown CN × multiplier; rates_edited true | P2 |
| SPC_TC_14 | GET /reconciliation | One row per scheme; diff % = (computed − file) ÷ file; "ok" only within ±2% | P1 |
| SPC_TC_15 | GET /trend | Month-on-month data with no failed month [SPC-6] | P1 |

## 2. Data validation — the domain rules (CLAUDE.md)

| ID | Test case | Expected result | Priority |
| --- | --- | --- | --- |
| SPC_TC_16 | CN on every slab row | CN = cn_units × rate (the "Other (unattributed)" rows are excluded by design) | P1 |
| SPC_TC_17 | Untouched book | Reproduces what was paid: simulated = current, delta 0, on every row of every scheme | P1 |
| SPC_TC_18 | Grand CN | Sum of the rupee schemes; gift schemes counted apart | P1 |
| SPC_TC_19 | Zones partition the book | Dealers, GSR and CN of the five zones add up exactly to All India | P1 |
| SPC_TC_20 | GSR in every zone | Every zone has GSR > 0 and a payout of 1–25% of it (catches South GSR being dropped) | P1 |
| SPC_TC_21 | Slab edges under a filter | A zone shows only the national slab edges (edges belong to the scheme, not the region) | P1 |
| SPC_TC_22 | verified_count | Equals the number of schemes with status ok | P2 |
| SPC_TC_23 | Region inside its zone | Never more dealers, GSR or CN than the zone | P1 |
| SPC_TC_24 | Status agreement | /schemes, /reconciliation and /all-slabs give each scheme the same status | P2 |
| SPC_TC_25 | Grand GSR per dealer | Below the sum of per-scheme GSR (no double count) and within ₹100–2,000 Cr | P1 |

## 3. Edge cases

| ID | Test case | Expected result | Priority |
| --- | --- | --- | --- |
| SPC_TC_26 | Unknown region | 422 with a plain sentence naming the region; nothing built or cached (review, 5 Nov 2026) | P2 |
| SPC_TC_27 | Zone with a region of another zone | Empty scope | P2 |
| SPC_TC_28 | Filter order and repeats | A+B = B+A; A+A = A | P2 |
| SPC_TC_29 | /growth at 0% | Grown CN = base CN, delta 0 [SPC-1] | P1 |
| SPC_TC_30 | /growth at −100% | No server error [SPC-2] | P2 |
| SPC_TC_31 | /growth at +1000% | Finite numbers; GSR × 11 | P3 |
| SPC_TC_32 | /simulate with an unknown row id | Ignored; delta 0 | P3 |
| SPC_TC_33 | /growth with a zone | Base GSR = that zone's GSR | P1 |

## 4. Negative

| ID | Test case | Expected result | Priority |
| --- | --- | --- | --- |
| SPC_TC_34 | /slabs, unknown scheme | 404 naming the scheme | P2 |
| SPC_TC_35 | /slabs without scheme | 422 | P2 |
| SPC_TC_36 | /simulate, /simulate-slabs, unknown scheme | 404 | P2 |
| SPC_TC_37 | Missing fields or a body that is not JSON | 422 | P2 |
| SPC_TC_38 | Wrong types (growth_pct as text, rates as text) | 422 | P2 |
| SPC_TC_39 | Wrong method (GET /simulate, POST /schemes) | 405 | P3 |
| SPC_TC_40 | Negative rate in /simulate | 422 [SPC-3] | P2 |
| SPC_TC_41 | /simulate-slabs, rates ≠ boundaries + 1 | 422 [SPC-4] | P2 |
| SPC_TC_42 | /simulate-slabs, boundaries not ascending | 422 [SPC-4] | P2 |
| SPC_TC_43 | /simulate-slabs, unknown component | 404 [SPC-5] | P3 |

## 5. Platform and security

| ID | Test case | Expected result | Priority |
| --- | --- | --- | --- |
| COMMON_TC_1 | /openapi.json | Lists all 9 endpoints | P3 |
| COMMON_TC_2 | /docs | Swagger page served | P3 |
| COMMON_TC_3 | Unknown route | 404 `{"detail": "Not Found"}` | P3 |
| COMMON_TC_4 | Read endpoints | 200 with JSON content type | P2 |
| COMMON_TC_5_SEC | CORS, web app origin | Allow-origin header echoes the web app | P1 |
| COMMON_TC_6_SEC | CORS, other origin | No allow-origin header | P1 |
| COMMON_TC_7_SEC | Preflight from another origin | Refused (400) | P1 |
| COMMON_TC_8_SEC | Preflight from the web app, POST + JSON | Allowed | P1 |
| COMMON_TC_9_SEC | Dealer data in aggregate answers | No dealer code or dealer name anywhere | P1 |
| COMMON_TC_10_SEC | Error bodies | No server file path or stack trace [SPC-6] | P2 |
| COMMON_TC_11_SEC | Security headers | `X-Content-Type-Options: nosniff` [SPC-7] | P3 |
| COMMON_TC_12_SEC | Request size | A body over 16 MB -> 413 "too large" (nginx refuses it too) | P1 |
| COMMON_TC_13 | /health | 200 with status, ready (views warm) and the live month; used by Docker's health check | P2 |
| COMMON_TC_14_SEC | PATCH /scenarios/{id} | Archiving a scenario that does not exist -> 404, nothing written | P2 |
| COMMON_TC_15 | API version | Business routes answer under /v1; the unversioned path is 404; /health says api_version v1 | P2 |
| COMMON_TC_16_SEC | Login: who am I | /auth/me gives the user and role; login_required is true when the API asks for a login | P1 |
| COMMON_TC_17_SEC | Login: no session | Without the session cookie /schemes, /all-slabs and /saved-versions answer 401 "Please log in to continue." (needs QA_USER) | P1 |
| COMMON_TC_18_SEC | Login: wrong password | 401 "The username or password is not correct.", no cookie set, no hint which part was wrong (needs QA_USER) | P1 |
| COMMON_TC_19_SEC | Login: cookie flags | The session cookie is HttpOnly and SameSite=Strict (needs QA_USER) | P1 |
| COMMON_TC_20_SEC | JSON only | A POST sent as a form is refused with 415 (with the SameSite cookie: no cross-site form post) | P2 |
| COMMON_TC_21_SEC | VIEWER role | A VIEWER gets 403 on the dealer list, saving and archiving; a slab's dealer codes (no names) are still served (needs QA_VIEWER_USER) | P1 |

## 5b. Dealer list, slab editing, export, two users

| ID | Test case | Expected result | Priority |
| --- | --- | --- | --- |
| SPC_TC_44 | /dealers for every row of Premium and Luxury, All India and South | dealers_in_row = the row's dealer count | P1 |
| SPC_TC_45 | /dealers paging | ceil(total ÷ 50) pages; no dealer on two pages; highest achievement first | P2 |
| SPC_TC_46 | /dealers search | A dealer code finds that dealer; no match returns none and keeps the row count | P2 |
| SPC_TC_47 | Next slab | next slab = achievement (GSR (Q)) + shortfall; none in the top slab | P1 |
| SPC_TC_48 | Mixed rate cards, served table re-applied unchanged | No money moves, no dealer lost | P1 |
| SPC_TC_49 | First paying boundary moved up | Dealers below it earn the lower band's rate; each edited row's list matches its count | P1 |
| SPC_TC_50 | Per-dealer targets, first boundary | No change until a rate is edited; a band's rate edit pays only that band | P1 |
| SPC_TC_51 | Invalid layouts and dealer requests | 422 (no rates/sources, wrong length, band out of range, negative rate, page size 500); 404 unknown component | P2 |
| SPC_TC_52 | /export | .xlsx (zip, three worksheets), named `scheme-performance_<month>_<scope>.xlsx` | P1 |
| SPC_TC_53 | Two users' edits at the same time | Each gets their own answer; the served table never changes | P1 |
| UI_TC_14 | Click a dealer count | Dialog with the same count, 50 a page, columns incl. Achievement (Q), Shortfall, Next slab; search; Escape closes | P1 |
| UI_TC_15 | Mixed rate cards at All India | Boundaries editable ("each region keeps its rate card"); moving one shows an impact | P1 |
| UI_TC_16 | Per-dealer target component | "+" adds a first boundary with no impact | P1 |
| UI_TC_17 | Two users in two browsers | One user's edit never appears on the other's screen, also after a reload | P1 |
| UI_TC_18 | Export to Excel | Downloads `scheme-performance_<month>_All-India.xlsx` | P1 |

## 5c. Previous · Current · Next month (Simulator)

| ID | Test case | Expected result | Priority |
| --- | --- | --- | --- |
| SPC_TC_54 | /months | Current month equals the dashboard (GSR, CN, dealers); categories add up to the total CN; product mix adds to 100% | P1 |
| SPC_TC_55 | /months/next, no edits, V = 0% and 10% | Zero impact in every category; factor = 1 + V (no pace by days since 4 Nov 2026); GSR = current × factor | P1 |
| SPC_TC_56 | /months/next with a Luxury rate edit | Impact in Luxury only, positive | P1 |
| SPC_TC_57 | /months/scheme (Premium) | Next month keeps every dealer, no false "Not qualified"; slab mix adds to 100%; zero impact without edits | P1 |
| SPC_TC_58 | Invalid month-view requests | V ≤ −100% → 422; unknown scheme → 404 | P2 |
| SPC_TC_59 | Scheme rows under each product (previous, current, next) | Every scheme of the product once; their CN adds to the product's CN; the product's own schemes add to its volume | P1 |
| SPC_TC_60 | /dealers with month = previous and next (Premium, Luxury; V = 10%) | The list equals the dealer count of every slab row of both months | P1 |
| SPC_TC_61 | /dealers month = next with a Luxury rate edit; an unknown month | The list follows the edited structure; month "later" → 422 | P2 |
| UI_TC_19 | Simulator month view | Previous, Current, Next side by side with Dealers, Volume, Mix, GSR ₹, CN %, CN ₹, Impact ₹ and a Total row | P1 |
| UI_TC_20 | A rate edit | Impact shows in the current and the next month of that product | P1 |
| UI_TC_21 | Click a product, then a scheme | The scheme's slab tables open inside the Previous, Current and Next columns (main table first, Book1 columns); the Current column is the editor (rate and boundary boxes in place); no separate scheme list or editor | P1 |
| UI_TC_22 | V = 10% | Next month's GSR rises by 10% | P1 |
| UI_TC_23 | Click a dealer count in the previous, current and next month's slab table | The dealer list for that month opens with the same count (previous / next labelled), 50 a page | P1 |

## 5d. Remove a slab, delete a scheme (Simulator)

| ID | Test case | Expected result | Priority |
| --- | --- | --- | --- |
| SPC_TC_62 | /months/next with `removed_schemes: ["luxury"]` | Luxury pays 0 next month; total CN falls by exactly Luxury's planned CN; volume, GSR and other categories unchanged; a non-list → 422 | P1 |
| SPC_TC_63 | Luxury: remove a slab (its lower edge goes, the merged band keeps the lower band's source) | No dealer lost; CN not higher; the merged band ends where the removed one ended and pays only rates of the lower slab | P1 |
| SPC_TC_64 | Stainers: remove the first slab (band 0 paid 0) | Band 0 pays 0; the other slabs do not move; impact = minus the first slab's CN | P1 |
| UI_TC_24 | Delete a scheme (asks first), then Restore | The confirm names the scheme; the row goes and is listed under Deleted schemes; current and next impact show lower CN (class `lower`, never green), GSR stays; a toast offers Undo; Restore brings the row back and the impact goes | P1 |
| UI_TC_25 | × on a slab | The first slab's × says its dealers earn nothing; another slab's × drops its dealers to the slab below; the scheme shows lower CN in the current and next month | P1 |
| UI_TC_26 | Address bar | `?tab=simulator` opens the Simulator; a reload keeps it; a tab click adds a history step and Back returns; Overview needs no `tab` | P2 |
| UI_TC_28 | Filters in the address | `?zone=...&region=...` survives a reload (they were cleared before the lists loaded) | P1 |
| UI_TC_29 | Escape in a figure box | Escape in V and in a month-table figure puts the old figure back; nothing counts as an edit | P1 |
| UI_TC_30 | Delete a version (Versions tab) | Delete asks first (Cancel keeps it); Undo within 10 s keeps it on the server; without Undo it is deleted after 10 s and stays gone on reload | P1 |

## 5e. Edits typed into the month table, and saved scenarios

GSR / volume / mix / CN % typed into the Current and Next columns travel as `adjustments` and `next_adjustments`
(modes B total, P product, A mix, Q price, R CN %, S scheme). The API suite never saves; saving is checked by hand.

| ID | Test case | Expected result | Priority |
| --- | --- | --- | --- |
| SPC_TC_65 | GET /scenarios/meta | Editable products, live and next month, whether saving is on | P2 |
| SPC_TC_66 | No edit | Preview equals actual in both months, 0 dealers moved; /all-slabs/adjusted with no edits equals /all-slabs | P1 |
| SPC_TC_67 | Region +10% GSR | All India GSR moves by exactly the region's change; an All India +10% shows as +10% inside the region | P1 |
| SPC_TC_68 | Product GSR +10% (P); Luxury mix target (A) | Only Luxury moves (Premium GSR and CN unchanged); a mix target lands within 0.01 pp with total GSR held | P1 |
| SPC_TC_69 | Dealer list under edits | A re-bucketed row's dealer list equals its dealer count | P1 |
| SPC_TC_70 | Next month | Inherits the current month's +10%; its own Luxury +20% applies on top | P1 |
| SPC_TC_71 | /scenarios/preview | Both months returned with the edit applied and dealers moved | P2 |
| SPC_TC_73 | Price (Q) and CN % (R) | A price edit keeps litres and moves GSR by the %; a CN % (rates x1.25) moves CN by exactly x1.25 and leaves GSR | P1 |
| SPC_TC_72 | Refusals | Rupee change on a region, a product edit without product, B with a product, S without scheme, a mix outside 0-100, -100%, an unknown mode, a non-% price / CN % edit, the same key twice, an unknown component -> 422 / 404 with the reason | P1 |
| SPC_TC_74 | /gifts (gift file, apart from CN) | Previous and current month blocks; each scheme is gifts or rupees; gift counts are whole numbers; no gift scheme is in the CN book; no dealer code or name; an unknown region is refused (422) | P1 |
| SPC_TC_75 | Scenario names | A blank name -> 422; a name already used (archived included), in another case or with spaces -> 409; writes nothing | P1 |
| SPC_TC_76 | /months/edited | Current and next month answered with no edits (was a 500 on every call) | P1 |
| SPC_TC_77 | NaN, Infinity, 1e300 in a body | 422 with one plain sentence ("This request was refused: ..."), never a 500 (QA run 5 Nov 2026) | P1 |
| SPC_TC_78 | A NaN slab boundary | 422, not a 200 with a wrong total | P1 |
| SPC_TC_79 | A filter value with spaces, or repeated | Same dealers as the plain value (was 0 dealers) | P2 |
| SPC_TC_80 | Export with no lower bound on a row | 200 and a workbook (was a 500) | P2 |
| MAN_TC_7 | Save, reopen, change | Save on the Simulator stores both months; the Scenarios tab lists current and next CN; "Open in Simulator" restores the edits, slab edits and V. Passed 2 Nov 2026 | P1 |
| MAN_TC_8 | Actual tables after saves | Exact (numeric) checksum and write counters of `dealer_component_month` / `dealer_month` unchanged. Passed 2 Nov 2026 | P1 |
| MAN_TC_10 | New file for the live month (`recalculate_scenarios()`) | Open scenarios recomputed; saved snapshots unchanged; a second run does nothing. Passed 2 Nov 2026 | P1 |
| MAN_TC_11 | Retention dry run (`prune(live_month, dry_run=True)`) | Versions saved before the live month and the two before it listed, saved and archived alike; the kept months untouched; nothing deleted (6 Nov 2026: was archived only, after 12 months) | P2 |
| SPC_TC_81 | 10 versions per login | An 11th save, or a restore past 10, -> 409 "You already have 10 saved versions ..."; archived ones do not count; case of the username ignored | P1 |
| SPC_TC_82 | Delete a version | `DELETE /saved-versions/{id}` with `{}`: owner or ADMIN -> 200, another manager -> 403, unknown -> 404, without JSON -> 415; edits and snapshots go with it | P1 |
| MAN_TC_13 | Month table in Chrome | Typing a new Luxury GSR (as sales, then as price) updates Current and Next, CN, impact and the header; price keeps the litres. Passed 2 Nov 2026 | P1 |

## 6. UI — web app in Chrome

| ID | Test case | Expected result | Priority |
| --- | --- | --- | --- |
| UI_TC_1 | Open the app | Title, scheme count and dealer count equal to the API; no error; no console error | P1 |
| UI_TC_2 | Part-month badge | "part month · day N of M" for a part month; none for a settled month | P1 |
| UI_TC_3 | Readout | Volume, GSR, Credit note and CN % of GSR, with the API figures; no Impact before an edit | P1 |
| UI_TC_4 | Tabs | Overview, Plan and Simulator switch; one selected at a time [UI-1] | P1 |
| UI_TC_5 | Zone filter | South shows South's dealer count; Clear filters restores All India | P1 |
| UI_TC_6 | Region list | Narrows to the selected zone's regions | P2 |
| UI_TC_7 | Find scheme | The month table shows only matching schemes, their products opened | P2 |
| UI_TC_8 | Verified only | Only schemes with status ok remain in the month table | P2 |
| UI_TC_9 | Edit a rate | Simulated CN and Impact appear (+ for a raise); Simulator tab counts 1 edit; Reset all asks in an in-app dialog, then clears both | P1 |
| UI_TC_10 | Open a product, then a scheme, in the month table | aria-expanded follows; the editor shows; Collapse all closes both | P3 |
| UI_TC_11 | Plan tab | Opens without a page error; +10% preset selects 10% [UI-1] | P1 |
| UI_TC_12 | API down | An error message with Retry (and an automatic retry), not an empty dashboard | P2 |
| UI_TC_13 | Layout at 1280, 768 and 390 px | No horizontal page scroll on Overview and Simulator | P3 |

## 7. Performance — k6 (one API process)

The traffic of every script is one planner session (`k6/traffic.js`): open the book for a scope (All India, a zone
or a region), open a scheme, edit one rate, move a slab boundary, try a growth target, sometimes reload the lists.
Think time 1–2 s between steps.

| ID | Script | Load | Pass criteria |
| --- | --- | --- | --- |
| PERF_TC_1 | `smoke.js` | 1 user, 30 s | No errors; all thresholds below |
| PERF_TC_2 | `load.js` | 25 users for 3 min (a busy planning day) | Errors < 1%; checks > 99%; p95: all-slabs < 1.5 s, slabs / simulate / simulate-slabs < 800 ms, growth < 2 s, lists < 500 ms |
| PERF_TC_3 | `spike.js` | 5 users, burst to 60 for 1 min, back to 5 | Same criteria; the API recovers after the burst |
| PERF_TC_4 | `stress.js` | 25 → 50 → 100 users | Reported, not pass / fail: where latency or errors break down |

## 8. Manual (not automated yet)

| ID | Test case | Expected result | Priority |
| --- | --- | --- | --- |
| MAN_TC_1 | Numbers on screen | Indian grouping (27,07,209), ₹ with Cr / L, two decimals on CN % | P2 |
| MAN_TC_2 | Keyboard only | Tabs, filters, scheme cards and rate boxes reachable and usable with Tab / Enter / arrows | P2 |
| MAN_TC_3 | Firefox and Safari | `UI_BROWSERS=chrome,firefox,webkit` passes the UI suite | P3 |
| MAN_TC_4 | Overview charts | Clicking a scheme in the contribution chart opens its drill-down; "Open in simulator" expands it there | P2 |
| MAN_TC_5 | Lowered rate wording | A reduction is never shown as a saving; the screen says volumes are held fixed | P1 |
| MAN_TC_6 | Deployed web app | Calls its own environment's API, not 127.0.0.1 [UI-2] | P1 |
| MAN_TC_7 | Undo and confirm | Reset all and Delete ask / offer Undo for 10 s; Undo brings the edits back; closing the tab with edits asks first | P1 |
| MAN_TC_8 | Edits list | "Edits (n)" lists every edit; × on one undoes only that edit | P2 |
| MAN_TC_9 | Filters keep slab edits | A rate or boundary edit made in one region is still there after changing the filters, and a toast says so | P1 |
| MAN_TC_11 | Next month's own slabs | A rate, boundary or slab Volume typed in the Next column moves next month only (Current impact stays "—"); the table says "next month's own slabs"; "Use current month's" drops it; a saved scenario keeps it | P1 |
| MAN_TC_10 | Refused figure | Typing "abc" or a negative figure shows the reason under the box, which stays open | P2 |
