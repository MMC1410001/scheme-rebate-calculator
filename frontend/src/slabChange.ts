/** When a slab row counts as changed, and which of its figures can be typed over. Shared by App and SchemeCard. */
import type { SlabRow } from "./api/client";

/**
 * Below this, a change is not a change.
 *
 * Rates are floats and cn_units are sums over tens of thousands of dealers, so
 * re-deriving an untouched band rarely lands on exactly the same double. A band
 * left alone came back as +0.0000001 and rendered as a red "+Rs 0" -- flagging
 * a cost that did not exist, on a row nobody had edited. Half a rupee is below
 * anything the business settles on, so anything under it reads as unchanged.
 */
export const MONEY_EPS = 0.5;
export const isMoved = (d: number) => Math.abs(d) >= MONEY_EPS;

/**
 * Has this row been changed by anything the user did?
 *
 * Testing the RATE alone was wrong, and quietly so. Moving a slab boundary
 * re-buckets dealers: counts, volume, GSR and payout all shift, while every
 * rate stays exactly as it was. So a slab edit changed real money and the app
 * reported "no edits yet", hid the estimate and the impact, and offered no way
 * to reset. An edit is anything that moved the money, however it was made.
 */
export const rowMoved = (r: SlabRow) =>
  r.simulated_rate !== r.cn_rate || isMoved((r.simulated_cn ?? r.current_cn) - r.current_cn);

/** A slab row's figures that can be typed over (Current month). */
export type SlabField = "volume" | "gsr" | "cn" | "mix" | "cn_pct";
