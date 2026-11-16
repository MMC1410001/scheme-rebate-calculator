# Requirements Traceability

Status values: `Not started` · `In progress` · `Done` · `Blocked`

## Dashboard — Previous Month & Current Month (read-only)

| ID | Requirement | Priority | Status |
| --- | --- | --- | --- |
| BR-001 | Pan-India totals for both months: volume, GSR, GSR contribution, CN, CN %, product mix, dealer count | Must | Not started |
| BR-002 | Sortable scheme-level table, same metrics, both months | Must | Not started |
| BR-003 | Sortable product-level table within a scheme, both months | Must | Not started |
| BR-004 | Each scheme's position above / below pan-India average rebate % | Must | Not started |
| BR-005 | Drill scheme → product → slab / tier | Must | Not started |
| BR-006 | Per-slab detail: dealers, volume, GSR, contribution, rate or amount, CN | Must | Not started |
| BR-007 | Zone, region, depot and scheme filters on all figures | Must | Not started |
| BR-008 | Scheme search and verified-only toggle | Should | Not started |
| BR-009 | Reconciliation status per scheme | Should | Not started |
| BR-010 | Read-only gift / contest qualification layer | Should | Not started |
| BR-011 | Period selector across all stored periods | Could | Not started |

## Simulator — Current Month (editable)

| ID | Requirement | Priority | Status |
| --- | --- | --- | --- |
| BR-012 | Edit slab / tier boundaries | Must | Not started |
| BR-013 | Edit CN %, fixed amount or per-unit rate per archetype | Must | Not started |
| BR-014 | Edit GSR directly, or through product mix | Must | Not started |
| BR-015 | Edit a category's mix share; others absorb proportionally | Must | Not started |
| BR-016 | Add and remove slabs / tiers | Should | Not started |
| BR-017 | Edit secondary qualifying condition | Should | Not started |
| BR-018 | CN recalculated from edited structure, never inherited | Must | Not started |
| BR-019 | Automatic dealer re-bucketing on boundary, condition, GSR or mix change | Must | Not started |
| BR-020 | Differential vs previous month (absolute and %) at scheme and product level | Must | Not started |
| BR-021 | Enforce mutually exclusive scheme choices | Must | Not started |
| BR-022 | Reset to previous month structure, per scheme and globally | Must | Not started |
| BR-023 | Refuse invalid edits with a stated reason | Must | Not started |

## Planner — Next Month (editable)

| ID | Requirement | Priority | Status |
| --- | --- | --- | --- |
| BR-024 | Seed from current month working estimate by default | Must | Not started |
| BR-025 | Option to seed from previous month closed structure | Must | Not started |
| BR-026 | Carry forward slabs, rates, conditions and mix | Must | Not started |
| BR-027 | Set pan-India GSR target (increase / decrease) | Must | Not started |
| BR-028 | Set pan-India CN % target (increase / decrease) | Must | Not started |
| BR-029 | Set pan-India product mix shift | Must | Not started |
| BR-030 | Show result vs target so user can close the gap manually | Must | Not started |
| BR-031 | Show resulting slabs, rates, GSR, CN, mix in Dashboard layout | Must | Not started |
| BR-032 | Differential vs seed period and vs current month estimate | Should | Not started |
| BR-033 | Reset plan to seeded structure | Must | Not started |

## Scheme set-up — Simulator and Planner (editable)

Added after BRD v1.0.1, at the user's request (29 Oct 2026). Monthly scheme letters bring schemes that did not run the month before. A typical letter adds new products, a festival offer for one region, a small-pack offer and launch offers for new products.

| ID | Requirement | Priority | Status |
| --- | --- | --- | --- |
| BR-034 | Add a new scheme: name, archetype, products or product group it covers, region / depot scope, period (dates and qualifying windows), slab basis (GSR, litres, kg, cartons), rate type (%, fixed ₹, ₹ per unit or block), and its slab / tier table. Exclusions and stacking or exclusivity with other schemes are declared, not inferred | Must | Not started |
| BR-035 | Calculate a new scheme's CN from the seed period's actual dealer volume and GSR for the products it covers, through the same engine and re-bucketing as existing schemes. Show it as a new row, labelled "new scheme", with no previous-month figure to compare | Must | Not started |
| BR-036 | When a covered product has no history (a new product launch), let the user enter an assumed volume or GSR (pan-India or per region) and label every figure that comes from it as assumed. Without it the scheme shows zero CN and says why (no qualifying volume) | Should | Not started |

## Added on request (29 Oct 2026)

| ID | Requirement | Priority | Status |
| --- | --- | --- | --- |
| BR-037 | Click a slab row's dealer count to list those dealers: code, name, region, depot, achievement (GSR (Q)), shortfall, next slab (= achievement + shortfall), GSR, rate, actual and simulated CN; search, 50 a page. The BRD put dealer-level drill-down out of scope; the user asked for it | Must | Done |
| BR-038 | Slab boundaries editable in every scheme: where regions run different rate cards each dealer keeps their region's card; per-dealer targets can get boundaries | Must | Done |
| BR-039 | Export to Excel: the view (summary, schemes, every slab row) with the user's edits | Must | Done |
| BR-040 | Two users at the same time never see each other's edits or impact | Must | Done (edits live in each browser; the API stores nothing per user) |

| BR-041 | Simulator shows Previous · Current · Next month side by side by product (whiteboard 29 Oct 2026), with the Book1 columns Dealers, Volume, Product mix, GSR, CN %, CN, Impact; a product opens its schemes in the same table, a scheme opens its slab tables inside each month's columns, and the Current column is the editor (no separate scheme list or editor); every dealer count lists that month's dealers; V sets next month's volume change | Must | Done |

**Totals:** 41 requirements — 34 Must, 6 Should, 1 Could.
