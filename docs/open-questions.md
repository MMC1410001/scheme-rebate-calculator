# Open Questions for the Client

Gaps and conflicts found in BRD v1.0.1. Confirm these before design starts.

| # | Area | Question | BRD reference |
| --- | --- | --- | --- |
| 1 | Archetypes | Sections 14 and 16 say **seven** archetypes, but the taxonomy table lists **six**. Is "overlapping qualifying periods" a separate archetype, or part of Slab-Based CN? | §5, §14, §16 |
| 2 | Dashboard | §3 says the Dashboard is read-only for both months. §9 Step 1 calls the Current Month "open, editable". Is the Current Month editable only in the Simulator? | §3, §9 |
| 3 | CN % / Rebate position | Is the pan-India average rebate % a **weighted** figure (total CN ÷ total GSR) or a **simple average** of each scheme's CN %? | §4.2, BR-004 |
| 4 | GSR contribution | At pan-India level, GSR contribution is always 100%. Should BR-001 show it per category or per zone instead? | BR-001 |
| 5 | Direct GSR edit | When a user edits GSR directly and volume stays the same, how is the new GSR spread to dealers for re-bucketing — pro rata to each dealer's current GSR? Does the realization value change? | BR-014, §7 |
| 6 | Mix edit per dealer | When a category's mix share changes, how is the volume shift spread across dealers — pro rata to each dealer's category volume? Dealer-level values decide slabs. | BR-015, BR-019 |
| 7 | Mix edit with filters | Is a mix shift applied pan-India only, or can it apply within a zone / region / depot filter? | BR-029, BR-007 |
| 8 | Qualifying periods | Period assignment uses the transaction date. Will the extract carry transaction-level dates, or only monthly aggregates? | §7 |
| 9 | First-Occurrence CN | How much billing history is needed to decide "first billing" (all time, last 12 months)? Is it in the extract? | §7 |
| 10 | Exclusive choice | Is the choice made per dealer (dealer opts in) or per scheme / product group by the planner user? | §5, BR-021 |
| 11 | Secondary condition | What forms can a secondary qualifying condition take (minimum product count, minimum volume of a second product, etc.)? | §5, BR-017 |
| 12 | Threshold CN | Confirm that only the highest tier pays (not the sum of all tiers crossed). | §7 |
| 13 | Scenarios | Can users save, name, share or compare simulation / plan scenarios? Are edits persisted between sessions? | not stated |
| 14 | Users and roles | Who uses the tool? Is login / role-based access required (view-only vs planner)? | not stated |
| 15 | Data delivery | Format, frequency and transport of the sales extract and scheme config (CSV, DB view, API)? | §4.1, §11 |
| 16 | Reconciliation | What are "settled CN" figures reconciled against, and what is the tolerance? (Sign-off needed before go-live.) | §11, §20 |
| 17 | Performance | Expected dealer count, transaction rows per month, and number of schemes — needed to set load targets. | §13 |
| 18 | Platform | Any required tech stack or hosting (e.g. Frappe, cloud vs on-prem)? | not stated |
| 19 | Document header | "Prepared For: Acme Paints (" is cut off in the BRD. | cover |
| 20 | Scheme letter format | The first monthly proposal came as an email with tables. Can the approved letter be sent as structured data (Excel / CSV per scheme, slab and region) instead? | §4.1, §11 |
| 21 | South Early Bird | The letter calls the South EB rates a "reduction", but they are **above** the previous month's South rates. Reduction against what? | Scheme letter |
| 22 | "South zone" | The data's South zone holds only some southern regions; two others sit in East. Do the letter's South rates also apply to those two? | Scheme letter |
| 23 | Festival offer | Two rows of one regional festival offer break the pattern of the other rows. Are they typos? | Scheme letter |
| 24 | New products | Smooth Putty, Aluminium Paint, Duro, Fixa adhesive and wallpaper rolls have no scheme column in the extract. Will product-level volume for them be in the extract? | BRD product dimension |
| 25 | Region codes | The in-bill sheet names two regions differently from the data. Confirm the mapping. | In-bill sheet |
| 26 | New schemes | For a new scheme (BR-034), who enters it (scheme admin or the planner user), and does it go back into the scheme configuration once the letter is approved? For a new product, where does the assumed volume come from (sales target, launch plan)? | BR-034–036 |
