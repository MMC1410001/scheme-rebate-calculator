# BRD Summary

Source: Scheme Performance & Impact Calculator and Planner — Requirements Document v1.0.1 (for Acme Paints).

## 1. Problem

- Last-month review, this-month tracking and next-month planning are three separate manual exercises.
- No single place shows GSR, GSR contribution, CN, CN %, and product mix together per scheme and product.
- One scheme letter contains several structurally different scheme types. Spreadsheets cannot keep their calculations consistent or comparable.
- Product mix (for example, Luxury vs Economy emulsions) moves GSR without changing total volume. There is no way to see or plan this lever.

## 2. Process flow

1. **Dashboard review** — Previous Month (locked) and Current Month figures, pan-India, scheme and product level, with filters.
2. **Current Month simulation** — starts as a copy of the Previous Month structure. User edits boundaries, rates, amounts, GSR or mix share.
3. **Recalculation and re-bucketing** — each archetype uses its own method. Dealers move into the correct slab automatically. Totals roll up row → product → scheme → pan-India.
4. **Next Month planning** — seed from Current Month (default) or Previous Month. User sets a GSR target, CN % target or mix shift, then adjusts by hand until the plan meets it. The tool shows the gap; it does not solve for it. *Added after v1.0.1:* the user can also **add a new scheme** that the seed period did not have (BR-034 to BR-036).
5. **Reconciliation and reset** — unreconciled schemes stay flagged. Superseded scheme letters are kept for audit. Reset per scheme or globally; a round trip returns the original figure exactly.

## 3. Calculation rules

| Rule | Detail |
| --- | --- |
| Threshold Value CN | CN = fixed amount of the **highest** threshold reached. Lump sum, not a rate. |
| Slab-Based CN | Evaluate GSR or volume against the slab table for the applicable qualifying period. CN = GSR × slab % **or** volume × per-unit amount (L / kg / bag), subject to any secondary condition. |
| Overlapping qualifying periods | Use the period active on the **transaction date**. |
| Product mix edit | Recalculate each category's volume and GSR first, then apply slab logic. |
| Stacking Incremental CN | CN = amount per block × completed blocks. Added to the product's slab CN. |
| First-Occurrence CN | Paid once, on the first transaction for that product in the dealer's billing history. |
| Mutually Exclusive Choice | CN only for the selected option. The alternative contributes zero. |
| Untouched rows | Return exactly the recorded value. Only edited rows recalculate. |
| No qualifying GSR / volume | No slab, no block, no payout — even if a rate is raised. |

Stacking and exclusivity relationships are **declared in scheme configuration**, never inferred.

## 4. Product mix model

- Mix share = category volume / total volume. Shares always sum to 100%.
- Each category has a realization value (GSR per unit), derived from achieved data.
- Category volume = mix share × total volume. Category GSR = category volume × realization.
- Overall GSR = total volume × weighted average realization.
- When the user changes one category's share, the other categories absorb the change **proportionally**. Total volume does not change.
- Mix is read-only in the Previous Month view.

## 5. Data integrity and presentation principles

- A closed month's CN is disbursed and non-recoverable. A simulated reduction is shown as the cost of a future structure, never as a saving.
- Simulations assume dealer volumes do not change (except the shift that a mix edit causes). When a rate is reduced, the UI states that sales may also fall and the tool cannot quantify it.
- Every assumed or simulated figure is labelled on screen.
- Actual and simulated figures are visually different and never share a column heading.
- Every figure is traceable to a source field or a stated calculation rule.

## 6. Non-functional requirements

| Category | Requirement |
| --- | --- |
| Performance | Target to be agreed once data volume is known; precompute or progressive load if needed |
| Responsiveness | Edits reflect near-instantly, including server round trip |
| Accessibility | WCAG AA |
| Motion | Respect reduced-motion preference |
| Data freshness | Show source extract and its as-of date on screen |
| Scalability | Pan-India dealer volume, more scheme types and product mappings without redesign |
| Auditability | Every figure traceable |

## 7. Out of scope (this phase)

In-bill discounts · gift fulfilment · dealer behaviour modelling · forecasting / ML · data platform migration · write-back to source · dealer-level drill-down below slab · automated scheme letter parsing · automatic target solver · filters below depot or by SKU · additional UI changes.

## 8. Dependencies

- Sales / billing extract with volume, GSR and product category per dealer and transaction
- Gift and contest qualification data
- Scheme admin team enters each scheme letter as structured config
- **Business sign-off on reconciliation variance tolerance before go-live**
