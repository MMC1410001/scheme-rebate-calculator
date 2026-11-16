import type { SlabRow } from "../api/client";

/** The main screen's tabs, sorts and shared shapes (App.tsx and its parts in src/app). */

export type SortKey = "payout" | "impact" | "name";
export type TabKey = "overview" | "trend" | "simulator" | "versions";
export const TABS: [TabKey, string][] = [["overview", "Overview"], ["trend", "Plan"], ["simulator", "Simulator"], ["versions", "Versions"]];
/** A tab named in the address bar, or Overview for a missing or unknown one. */
export const asTab = (t: string | null): TabKey => TABS.find(([k]) => k === t)?.[0] ?? "overview";

export const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                            "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Each scheme's slab rows, by scheme key. */
export type RowsByScheme = Record<string, SlabRow[]>;

/** The filters now on. */
export interface ScopeSel { zone: string[]; region: string[]; depot: string[] }
