# Source File Structure

What is inside the monthly extract, how its columns relate, and what is still unknown. Where the file comes from is in [data-sources.md](data-sources.md).

> Public copy: scheme and product names are made up, and every count and amount below is illustrative. The real
> analysis was done on the client's file, which is not part of this repository.

Every rule below was tested on all rows of a month's file unless marked **(sample)**. Re-check when a new version or layout arrives: scheme blocks change between versions (see data-sources.md).

Status labels: **Confirmed**: holds on ~100% of rows. **Inferred**: fits the numbers, meaning not confirmed by the business. **Open**: not explained.

## 1. Layout

| Item | Value |
| --- | --- |
| Sheets | One: `Output` |
| Size | tens of thousands of rows × a few hundred columns |
| Header | Two rows. Row 1: scheme block (merged across its columns). Row 2: metric name |
| Data rows | One per dealer. `Customer` is unique (no duplicates, none blank) |
| Empty rows | A few dozen dealers have no GSR, volume or Clear Cut in any scheme |
| Identity columns | `Zone`, `Region`, `Depot Code`, `Customer`, `Customer Name` (columns 0-4) |
| Scheme blocks | A few dozen (columns 5 onwards) |
| Last column | `Total Clear Cut` |

**Not in the file:** the slab tables, which regions a scheme applies to, product category, and condonation (this is the no-condonation variant). Each row carries only the rate a dealer earned and the distance to their next slab.

## 2. Column types inside a scheme block

`X` is a component name, e.g. `PREMIUM 01`.

| Column | Meaning | Status |
| --- | --- | --- |
| `Volume Q X` | Achievement in litres (or kg / units); decides the slab | Inferred |
| `GSR(Q) X` | Achievement in rupees; decides the slab for value-slabbed schemes | Inferred |
| `GSR(B) X` | Rupees the % rate is paid on | Confirmed (see §3) |
| `X CN%` | The rate the dealer earned. **Unit depends on the component**: %, ₹ per pack, or a flat ₹ amount. The name always says `CN%` | Confirmed |
| `X Clear Cut` | Payout for that component | Confirmed |
| `Clear Cut` | Payout for the whole scheme | Confirmed (see §4) |
| `Next Slab Qty X` / `Next Slab Value X` | **The shortfall to the next slab**, not the slab boundary. Equal to `Short Fall X` on 100% of rows in almost every component | Confirmed |
| `Short Fall X` | Distance to the next slab | Confirmed |
| `Short Fall % X` | `Short Fall ÷ (achievement + Short Fall) × 100` | Confirmed (one component differs, see §8) |
| `No. of Shades ...` | Shade count for an enamel, probably a secondary condition | Open: effect on payout not tested |

**Next slab boundary = achievement + Short Fall.** The engine derives slab edges this way (`app/core/slab_engine.py`).

Q / B: in most rows `GSR(Q)` and `GSR(B)` are equal. Reading Q as "qualifying" (slab decision) and B as "billing" (rate base) fits the numbers. **Confirm with the business.**

## 3. Payout rules per component

| Rule | Formula | Example components | Status |
| --- | --- | --- | --- |
| % of GSR | `GSR(B) × CN% ÷ 100` | Value %, EB full month, LUXURY, PREMIUM 01/02, HUE BASIC & GLOW MAX, WATERPROOFING, primers, enamels, wood finishes, tools | Confirmed (99.8-100%) |
| Per 50 L | `floor(Volume Q ÷ 50) × ₹ rate` | Lux Interior / Exterior Per 50 L, Primer ... Per 50 L, Topguard Per 50 L | Confirmed |
| Per 100 L | `floor(Volume Q ÷ 100) × ₹ rate` | Aquaclear, Zen Star, Aquawash, HB, GM, CL, WN Per 100 L | Confirmed |
| Per 40 L | `floor(Volume Q ÷ 40) × ₹ rate` | Addn Vivid Life 40 | Confirmed |
| Per 25 L | `floor(Volume Q ÷ 25) × ₹ rate` | TERRA 15 (the name does not say so) | Confirmed **(sample)** |
| Per 50 L, named "Per L" | `floor(Volume Q ÷ 50) × ₹ rate` | Waterproofing Per L | Confirmed **(sample)** |
| Per 40 L above 80 L | `floor((Volume Q − 80) ÷ 40) × ₹ rate` | DAMP GUARD PER 40 | Inferred **(sample)** |
| Per litre | `Volume Q × ₹ rate` | Stainers Per L | Confirmed (few payers) |
| Flat amount | `Clear Cut = CN%` (the "rate" is rupees) | STAINERS, DAMP GUARD | Confirmed |
| Per 250 L | `floor(Volume Q ÷ 250) × ₹ rate` | Addn Texture Per 250 L | Fits most payers; see §8 |

### "FA" components (no Clear Cut column of their own)

`VALUE FA`, `Primer FA`, `VELVET TOUCH FA` and `TERRA 15 FA` have a `CN%` but no `Clear Cut`. Their `CN%` is a **flat rupee amount**, added straight into the scheme's `Clear Cut`: scheme Clear Cut − component Clear Cuts = FA amount, on 100% of rows. "FA" read as fixed amount: **Inferred**.

## 4. How totals roll up

| Level | Rule | Status |
| --- | --- | --- |
| Scheme | `Clear Cut` = sum of its component `Clear Cut`s + FA amounts | Confirmed in every multi-component scheme |
| Single-component scheme | No scheme `Clear Cut`; the component's own `Clear Cut` is the scheme total | Confirmed |
| Dealer | `Total Clear Cut` = sum of all scheme Clear Cuts | Confirmed (100% of rows) |

## 5. Early Bird

Three time windows (EB 1, EB 2, EB 3), each with `GSR(Q)`, `GSR(B)`, `CN%`, `Next Slab Value`, `Short Fall`, `Short Fall %`, plus a full-month section (`GSR(B) EB FULL MONTH`, `EB FULL MONTH CN%`, `Clear Cut EB FULL MONTH`).

Two payout regimes, split by zone:

| Zone | Rule |
| --- | --- |
| North, East, West, Central | `Clear Cut = GSR(B) EB FULL MONTH × EB FULL MONTH CN% ÷ 100` |
| South | `Clear Cut = Σ (GSR(B) EB i × EB i CN% ÷ 100)` over the three windows; full-month columns are 0 |

Confirmed on every paid row (one South row unexplained).

- The full-month rate usually equals the EB 1 rate. **How it is chosen is Open.**
- `GSR(Q)` usually rises EB 1 ≤ EB 2 ≤ EB 3, so the windows are mostly cumulative, but not always. **Open.**
- `TMBR Early Bird` has the same shape (windows TMBR EB1/EB2/EB3 + full month).

## 6. Geography

| Item | Value |
| --- | --- |
| Zones | 5: Central, East, North, South, West |
| Regions | A few dozen; each region belongs to one zone |
| Depots | Over a hundred |
| Depots under two regions | Some, so region is a per-dealer attribute, not derived from the depot |
| Coded regions | One region appeared as a bare number on depots that also map to a named region: most likely mis-coded |

Rates follow **region**, not depot: within one region, each slab of a component pays one rate in almost every case (see the regional rate rows in the Simulator).

## 7. How the engine reads this file

| File | Engine (`backend/app/ingest/`, tidy frame) |
| --- | --- |
| Scheme blocks | Schemes (a block with no payouts is dropped) |
| Dealer rows | Dealers with at least one scheme row |
| One wide row per dealer | One row per dealer × component |
| `Total Clear Cut` | CN: the file total less any anomaly excluded by decision |

Every scheme matches the file to the rupee except where an excluded anomaly sits.

### Engine fixes (`CONFIG_VERSION` 13)

| Scheme | Cause | Fix |
| --- | --- | --- |
| Early Bird | South's per-window payout (§5) not read: every EB component was paid on the full-month GSR, which South does not have | Per-window components for dealers with no full-month GSR (`core/scheme_config.py`) |
| Primer, Velvetouch | FA amount counted twice: as its own line and again in "Other (unattributed)" | The residual subtracts components with no Clear Cut of their own (`ingest/parse_raw.py`) |
| Terra 15 | `TERRA 15 FA` was matched by name prefix to `TERRA 15 Clear Cut`, so that column was subtracted twice and the FA amounts were lost | FA lines only take a Clear Cut column with their exact name (`ingest/discover_schemes.py`); each Clear Cut column is subtracted once |
| Value Slab | `VALUE FA` matched to `Value Clear Cut`; its money sat in "Other (unattributed)" | Same fix: now shown as `VALUE FA` |

Reconciliation (`ingest/reconcile.py`) now tests what the components explain: a scheme needs review when its "Other (unattributed)" line exceeds 2% of its total. The old test compared rows with the Clear Cut they had been set to, so it could not fail. That is how Early Bird and Terra 15 showed "ok" while wrong.

Total GSR in the engine = `GSR(B) Value` + `GSR(B) Value %` + `GSR(B) TMBR Value Slab` per dealer (data-sources.md).

## 8. Kinds of anomaly found

| # | What | Status |
| --- | --- | --- |
| A1 | An add-on paid the same lump sum to every dealer of one region with **zero** volume in that product | Likely a file error. **Excluded from the app** by decision; ask the file owner |
| A2 | A region given as a bare number, on depots that also map to a named region | **Shown as given** until confirmed |
| A3 | One component's `Short Fall %` does not follow `Short Fall ÷ (achievement + Short Fall)` like every other component | Open |
| A4 | A new product's block present but empty | Expected for a new product |
| A5 | A few dozen dealer rows entirely empty | Harmless; confirm whether expected |

## 9. Questions for the file owner

1. **Lump sums with no volume (A1):** a fill or formula error, or a regional amount that should sit somewhere else?
2. **Numbered region (A2):** which named region is it?
3. **GSR(Q) vs GSR(B):** is Q the amount that decides the slab and B the amount the rate is paid on?
4. **"FA" columns:** is FA a fixed amount per dealer? What decides who gets it?
5. **Early Bird full-month rate:** how is the full-month rate chosen from the three windows? Why are South dealers paid per window?
6. **Hidden pack sizes:** please confirm TERRA 15 is paid per 25 L, Waterproofing Per L per 50 L, and Damp Guard Per 40 per 40 L above the first 80 L.
7. **`Short Fall %` (A3):** what formula does that component use?
8. **Secondary conditions:** does `No. of Shades` change the payout?
