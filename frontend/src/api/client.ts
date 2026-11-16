// The API is at /api on the web app's own address: nginx forwards it in Docker (frontend/nginx.conf), Vite in
// `npm run dev` (vite.config.ts). This app speaks version 1 of the API (/v1). VITE_API_BASE_URL (build time, the
// full base including /v1) only for an API at another address, which then must list this app's origin in
// CORS_ORIGINS and be allowed by the page's Content-Security-Policy (connect-src).
export const BASE_URL = (import.meta.env.VITE_API_BASE_URL || "/api/v1").replace(/\/$/, "");

export type Formula = "percent" | "per_unit" | "per_pack" | "fixed";
export type SchemeStatus = "ok" | "needs_review" | "no_data" | "unknown";

export interface SlabRow {
  /** Set by the client on rows returned from a slab re-bucket. Those rows'
      current_cn belongs to dealers who earned it in a different band, so a rate
      edit on them must use cn_units rather than scale from it. */
  rebucketed?: boolean;
  component: string;
  formula: Formula;
  pack_size: number;
  // "target"  = per-dealer targets, no common slab table
  // "unrated" = dealers inside paying bands who earn nothing (failed qualification)
  slab_mode: "slab" | "target" | "unrated";
  slab_index: number;
  slab_lower: number;
  slab_upper: number | null; // null = open-ended top slab
  cn_rate: number;
  dealer_count: number;
  achievement: number;
  volume: number; // litres
  gsr: number; // rupees
  cn_units: number;
  current_cn: number;
  condonation_amount: number;
  /** Regions whose dealers sit in this row; a band splits into one row per regional rate. */
  regions?: string[];
  row_id: string;
  simulated_rate?: number;
  simulated_cn?: number;
  delta_cn?: number;
}

export interface Totals {
  dealer_count: number;
  current_cn: number;
  simulated_cn: number;
  delta_cn: number;
  gsr: number;
  volume: number;
}

export interface SchemePayload {
  key: string;
  label: string;
  status: SchemeStatus;
  /** false for GIFT schemes, whose payout is a count of gifts rather than rupees */
  is_currency: boolean;
  rows: SlabRow[];
  totals: Totals;
}

export interface AllSlabsResponse {
  filters: { zone: string | null; region: string | null; depot_code: string | null };
  schemes: SchemePayload[];
  /** Which export these figures came from, and whether it is a whole month. */
  source?: {
    month: string;
    file?: string;
    /** The GCS file's v<N>, for a synced month. */
    version?: number | null;
    as_of: string | null;
    elapsed_days: number | null;
    month_days: number | null;
    complete: boolean;
  };
  grand: {
    dealer_count: number;
    current_cn: number;
    gift_count: number;
    gsr: number;
    volume: number;
    scheme_count: number;
    verified_count: number;
  };
}

export interface Filters {
  zones: string[];
  regions: string[];
  depots: string[];
  hierarchy: { zone: string; region: string; depot_code: string }[];
}

/** A failed request, with a message a person can read (user's request, 3 Nov 2026: no status codes, JSON or stack
 *  text on screen). The server's own reason is kept where it wrote one for people. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Who is logged in (GET /auth/me). `login_required` false: a developer machine without users (no Log out). */
export interface Me {
  username: string;
  role: "ADMIN" | "SCHEME_MANAGER" | "VIEWER";
  login_required: boolean;
  /** The schemes this login may edit; null: every scheme (ADMIN). A VIEWER has none. */
  edit_schemes?: string[] | null;
  can_save?: boolean;
  can_see_dealers?: boolean;
}

/** Told when the server says the session is over (401 outside the login itself): the app asks to log in again,
 *  keeping everything on screen. */
const sessionEnded = new Set<() => void>();
export function onSessionEnded(fn: () => void): () => void {
  sessionEnded.add(fn);
  return () => { sessionEnded.delete(fn); };
}

function readable(status: number, detail: unknown): string {
  const text = typeof detail === "string" ? detail
    : Array.isArray(detail) ? detail.map((d) => String((d as { msg?: unknown })?.msg ?? d).replace(/^Value error, /, "")).join("; ")
      : "";
  const said = text ? text.charAt(0).toUpperCase() + text.slice(1).replace(/\.?$/, ".") : "";
  // FastAPI's own "Not Found" means the route is missing: a server older than this app.
  if (status === 404 && (!text || text === "Not Found"))
    return "This is not available on the server yet. The server needs to be updated to the latest version.";
  if (status === 404) return said;
  if (status === 422) return said ? `That value cannot be used. ${said}` : "That value cannot be used.";
  if (status === 409) return said || "That conflicts with something already saved.";
  if (status === 401) return said || "Please log in to continue.";
  if (status === 403) return said || "Your login cannot do this. Ask an administrator.";
  if (status === 429) return said || "Too many requests right now. Please wait a moment and try again.";
  // A 503 with the API's own sentence (login or the database not set up) says what is wrong; nginx's 502 / 504
  // and a bare 503 mean the server is starting up or overloaded.
  if (status === 503 && said) return said;
  if (status === 502 || status === 503 || status === 504)
    return "The server is starting up or busy. Please try again in a minute.";
  if (status >= 500) return "The server ran into a problem. Please try again in a moment.";
  return said || "The request could not be completed. Please try again.";
}

async function fail(res: Response): Promise<never> {
  let detail: unknown = null;
  try { detail = (await res.json()).detail; } catch { /* no JSON body */ }
  if (res.status === 401 && !res.url.endsWith("/auth/login") && !res.url.endsWith("/auth/me"))
    for (const fn of sessionEnded) fn();
  throw new ApiError(res.status, readable(res.status, detail));
}

/** What to show for any failure: the readable reason, or plain words when the server could not be reached. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof TypeError) return "Cannot reach the server. Check your connection, or that the server is running, and try again.";
  return "Something went wrong. Please try again.";
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) await fail(res);
  return res.json();
}

export interface SlabSimResponse {
  scheme: string;
  component: string;
  rows: SlabRow[];
  totals: Totals;
}

export interface GrowthScheme {
  scheme: string;
  label: string;
  growth_pct: number;
  base_cn: number;
  grown_cn: number;
  delta_cn: number;
  base_gsr: number;
  grown_gsr: number;
  dealers_moved_up: number;
  elasticity: number;
  rate_multiplier: number;
  grown_cn_at_new_rates: number;
}

export interface GrowthResponse {
  default_growth_pct: number;
  grown_cn_at_new_rates: number;
  rates_edited: boolean;
  base_cn: number;
  grown_cn: number;
  delta_cn: number;
  base_gsr: number;
  grown_gsr: number;
  base_rate_pct: number;
  grown_rate_pct: number;
  elasticity: number;
  dealers_moved_up: number;
  schemes: GrowthScheme[];
}

/** A slab table sent to the API (see backend SlabLayout). Either `rates`, one per band (one rate card), or
    `sources`, one per band: the original band [lower, upper|null] it comes from -- each dealer keeps their region's
    rate card. `rate_overrides` are rate edits: in band `band`, dealers paid `rate` are paid `new_rate`. */
export interface SlabLayout {
  edges: number[];
  rates?: number[] | null;
  sources?: [number, number | null][] | null;
  rate_overrides?: { band: number; rate: number; new_rate: number }[];
}

/** One dealer behind a slab row (client data). */
export interface DealerLine {
  customer_code: string;
  customer_name: string | null;
  zone: string;
  region: string;
  depot_code: string;
  /** GSR (Q), or volume (Q) where the slab is decided in litres. */
  achievement: number;
  /** Shortfall to the next slab, as the file's "Next Slab" column holds it; 0 in the top slab. */
  shortfall: number;
  /** The next slab: achievement + shortfall. null in the top slab. */
  next_slab: number | null;
  /** Share of the next slab already reached: achievement / next slab, in percent. null in the top slab. */
  reached_pct: number | null;
  volume: number;
  gsr: number;
  cn_rate: number;
  simulated_rate: number;
  current_cn: number;
  simulated_cn: number;
  od_blocked: boolean;
}

export interface DealersResponse {
  scheme: string;
  component: string;
  dealers_in_row: number;
  total: number;
  page: number;
  pages: number;
  page_size: number;
  rows: DealerLine[];
}

/** One scheme's own figures under its product. An add-on's (counts = false) volume and GSR are its base scheme's
 *  sales again, so they are never added to the product. */
export interface SchemeMonthRow {
  scheme: string;
  counts: boolean;
  dealers: number | null;
  volume: number | null;
  gsr: number | null;
  cn: number;
  simulated_cn: number;
  cn_pct: number | null;
  simulated_cn_pct: number | null;
}

/** One product category of a month (backend app/core/categories.py). */
export interface CategoryRow {
  category: string;
  schemes: string[];
  scheme_rows: SchemeMonthRow[];
  dealers: number | null;
  volume: number | null;
  gsr: number | null;
  mix_pct: number | null;
  cn: number;
  simulated_cn: number;
  cn_pct: number | null;
  simulated_cn_pct: number | null;
}

export interface MonthTable {
  rows: CategoryRow[];
  total: { dealers: number; volume: number; gsr: number; cn: number; simulated_cn: number; cn_pct: number | null; simulated_cn_pct: number | null };
}

/** A product's edit: volume and price as factors (Volume / Mix and GSR edits), CN % as the target itself. */
export interface ProductEdit {
  volume: number;
  price: number;
  cn_pct: number | null;
}

export interface MonthBlock extends MonthTable {
  month: string;
  /** Every scheme's litres, as the header's Volume counts them (the table's total counts products only). */
  book_volume?: number;
  as_of: string | null;
  version?: number | null;
  complete: boolean;
  elapsed_days: number | null;
  month_days: number | null;
  dealers: number;
}

export interface NextMonthBlock extends MonthTable {
  warnings?: string[];
  month: string;
  from_month: string;
  volume_growth_pct: number;
  factor: number;
  pace_factor: number;
  edited: boolean;
}

/** A slab row in the Book1 shape: slab, dealers, volume, product mix, GSR, CN %, CN. */
export interface MonthSlabRow {
  component: string;
  formula: Formula;
  pack_size: number;
  slab_mode: "slab" | "target" | "unrated";
  slab_index: number;
  slab_lower: number | null;
  slab_upper: number | null;
  dealers: number;
  volume: number;
  mix_pct: number | null;
  gsr: number;
  rate: number;
  /** The band's rate before edits (picks the row's dealers). */
  cn_rate: number;
  cn: number;
  cn_pct: number | null;
  regions?: string[];
}

export interface SchemeMonths {
  scheme: string;
  previous: { month: string; components: Record<string, MonthSlabRow[]> } | null;
  next: { month: string; factor: number; components: Record<string, { rows: MonthSlabRow[]; impact: number }> };
}

/** One edited cell of the month table (backend AdjustmentIn). The cell decides the mode: B the total (every product
    in proportion), P one product, A one product's mix with the total held ("share" = target % of volume), S one
    scheme (product = the scheme key), Q one product's GSR as a price change, R one product's CN % or CN (its rates;
    product "*" = every rate, the total's CN), C one scheme's CN (its rates). The scope is the filters the edit was made through ("A|B" for several);
    every view applies every edit, so a region's edit shows in All India and the other way round. */
export interface Adjustment {
  scope_kind: "all" | "zone" | "region" | "depot" | "dealer";
  scope_value: string;
  product: string;
  metric: "gsr" | "volume";
  mode: "A" | "B" | "C" | "P" | "Q" | "R" | "S";
  adjust_type: "delta" | "pct" | "share";
  value: number;
  reason?: string | null;
  /** As stored in a saved version. */
  period?: "current" | "next";
}

/** GSR / volume edits: the current month's (they carry into next month) and next month's own. */
export interface Edits {
  adjustments: Adjustment[];
  next_adjustments: Adjustment[];
}

export interface SavedVersionInput extends Edits {
  name: string;
  note?: string | null;
  volume_growth_pct: number;
  layouts: Record<string, SlabLayout>;
  /** Next month's own slab tables: they replace `layouts` for next month only. */
  next_layouts?: Record<string, SlabLayout>;
  removed_schemes: string[];
}

export interface VersionTotals {
  dealers: number;
  dealers_moved: number;
  actual_gsr: number;
  version_gsr: number;
  actual_cn: number;
  version_cn: number;
}

/** A slab row of one side of a version (actual or version). */
export interface VersionSlab {
  slab_mode: string;
  formula: Formula;
  pack_size: number;
  slab_lower: number | null;
  slab_upper: number | null;
  rate: number;
  dealers: number;
  volume: number;
  gsr: number;
  cn: number;
}

export interface VersionScheme {
  scheme: string;
  label: string;
  product: string;
  is_currency: boolean;
  removed: boolean;
  dealers: number;
  dealers_moved: number;
  actual_volume: number;
  version_volume: number;
  actual_gsr: number;
  version_gsr: number;
  actual_cn: number;
  version_cn: number;
  components: Record<string, { actual: VersionSlab[]; version: VersionSlab[] }>;
}

export interface VersionResult {
  period: "current" | "next";
  month: string;
  factor: number;
  totals: VersionTotals;
  warnings: string[];
  schemes: VersionScheme[];
}

export type VersionResults = { current: VersionResult; next: VersionResult };

export interface VersionMeta {
  products: string[];
  /** The server has the database: saved versions can be listed and opened. */
  has_db?: boolean;
  /** A database, and the ADMIN role: versions can be saved, archived and restored. */
  can_save: boolean;
  role?: Me["role"];
  live_month: string;
  next_month: string;
  as_of: string | null;
}

export interface VersionSummary {
  version_id: number;
  name: string;
  note: string | null;
  base_month: string;
  volume_growth_pct: number;
  status: "DRAFT" | "SAVED" | "ARCHIVED";
  created_by: string | null;
  updated_by?: string | null;
  created_at: string;
  updated_at: string;
  computed_source: string | null;
  computed_at: string | null;
  adjustments: number;
  slab_edits: number;
  saves: number;
  /** The live result of each month (current and next). */
  months: { month: string; dealers_moved: number; actual_cn: number; version_cn: number; actual_gsr: number; version_gsr: number }[];
  editable: boolean;
  /** This login may change, archive or restore it (its own, or any for an ADMIN). */
  can_change?: boolean;
}

export interface SnapshotInfo {
  snapshot_id: number;
  kind: "live" | "save";
  taken_at: string;
  source_file: string;
  as_of: string | null;
  month: string;
  dealers_moved: number;
  actual_cn: number;
  version_cn: number;
}

export interface VersionDetail {
  version_id: number;
  name: string;
  note: string | null;
  base_month: string;
  volume_growth_pct: number;
  removed_schemes: string[];
  status: "DRAFT" | "SAVED" | "ARCHIVED";
  created_at: string;
  updated_at: string;
  computed_source: string | null;
  adjustments: Adjustment[];
  layouts: Record<string, SlabLayout>;
  next_layouts?: Record<string, SlabLayout>;
  snapshots: SnapshotInfo[];
  editable: boolean;
  created_by?: string | null;
  can_change?: boolean;
}

export interface VersionSnapshot extends VersionTotals {
  snapshot_id: number;
  kind: "live" | "save";
  taken_at: string;
  source_file: string;
  as_of: string | null;
  month: string;
  factor: number;
  warnings: string[];
  schemes: (Omit<VersionScheme, "scheme"> & { scheme_key: string })[];
}

/** A dealer whose slab or rate moved in a version (client data). */
export interface MovedDealer {
  month: string;
  customer_code: string;
  customer_name: string | null;
  zone: string | null;
  region: string | null;
  scheme_key: string;
  component: string;
  actual_basis: number;
  actual_lower: number | null;
  actual_rate: number;
  actual_cn: number;
  version_basis: number;
  version_lower: number | null;
  version_rate: number;
  version_cn: number;
}

export interface MovedDealers {
  total: number;
  page: number;
  pages: number;
  page_size: number;
  rows: MovedDealer[];
}

type Scope = { zone?: string[]; region?: string[]; depot_code?: string[] };

/** One gift scheme of a month (the gift / contest file; never part of CN). */
export interface GiftRow {
  scheme: string;
  /** "gifts": earned is a count of gifts; "rupees": a rupee scheme in the gift file (5% Nova Prime), still not CN. */
  unit: "gifts" | "rupees";
  dealers: number;
  qualified: number;
  earned: number;
  rate: number | null;
  volume: number;
  gsr: number;
}

/** A gift scheme's figures in Scheme detail; the edited_* figures only with edits. */
export interface GiftFigures {
  dealers: number;
  qualified: number;
  earned: number;
  volume: number;
  gsr: number;
  edited_qualified?: number;
  edited_earned?: number;
  edited_volume?: number;
  edited_gsr?: number;
}

/** One gift scheme in depth (POST /gifts/detail). `rule` only where it reproduces the file (then it can be edited). */
export interface GiftDetail {
  month: string;
  as_of: string | null;
  version: number | null;
  scheme: string;
  unit: "gifts" | "rupees";
  rule: { kind: "per_litre" | "pct_gsr"; value: number; match: number } | null;
  edited: boolean;
  rule_value: number | null;
  volume_pct: number;
  totals: GiftFigures;
  levels: (GiftFigures & { label: string })[];
  regions: (GiftFigures & { region: string })[];
}

/** A gift scheme's what-if edit, kept in this browser only: a new rule value and / or its volume moved by %. */
export interface GiftEdit {
  rule_value?: number;
  volume_pct?: number;
}

export interface GiftBlock {
  month: string;
  as_of: string | null;
  version: number | null;
  schemes: GiftRow[];
}
/** A request the browser no longer needs (a newer scope or edit replaced it) was cancelled: show nothing for it. */
export const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/** Query string of a scope: each dimension repeats once per selected value (?region=Delhi&region=Haryana). */
function scopeQs(p: Scope, qs = new URLSearchParams()): URLSearchParams {
  for (const key of ["zone", "region", "depot_code"] as const) for (const v of p[key] ?? []) if (v) qs.append(key, v);
  return qs;
}

// The session cookie goes with every request ("include": also to an API at another address, VITE_API_BASE_URL).
const get = <T,>(path: string, qs?: URLSearchParams, signal?: AbortSignal) =>
  fetch(`${BASE_URL}${path}${qs && qs.size ? `?${qs}` : ""}`, { signal, credentials: "include" }).then((r) => json<T>(r));

/** The saved version open in the Simulator: its own edits may be calculated by any login (backend app/access.py). */
let openedVersion: number | null = null;
export const setOpenedVersion = (id: number | null) => { openedVersion = id; };

const send = <T,>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body: unknown, signal?: AbortSignal) =>
  fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(openedVersion != null ? { "X-Version-Id": String(openedVersion) } : {}) },
    body: JSON.stringify(body),
    credentials: "include",
    signal,
  }).then((r) => json<T>(r));

const post = <T,>(path: string, body: unknown, signal?: AbortSignal) => send<T>("POST", path, body, signal);

type DealerRowRef = { slab_mode: string; slab_lower: number | null; slab_upper: number | null; cn_rate: number; slab_index: number };

// Every call that a newer scope or edit can replace takes an optional AbortSignal, so the browser drops the old
// request instead of keeping one of its few connections busy with it.
export const api = {
  // ---- Login (backend app/auth.py) --------------------------------------------------------------------------------
  me: () => get<Me>("/auth/me"),
  login: (username: string, password: string) => post<Me>("/auth/login", { username, password }),
  logout: async () => {
    const res = await fetch(`${BASE_URL}/auth/logout`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", credentials: "include",
    });
    if (!res.ok) await fail(res);
  },

  // ---- Saved what-if versions (backend app/service/saved_versions.py). Computed on the server; saved ones are shared. --
  versionMeta: () => get<VersionMeta>("/saved-versions/meta"),
  previewVersion: (body: SavedVersionInput) => post<VersionResults>("/saved-versions/preview", body),
  saveVersion: (body: SavedVersionInput, id?: number) =>
    send<VersionResults & { version_id: number }>(id ? "PUT" : "POST", `/saved-versions${id ? `/${id}` : ""}`, body),
  versions: () => get<{ live_month: string; versions: VersionSummary[] }>("/saved-versions"),
  version: (id: number) => get<VersionDetail>(`/saved-versions/${id}`),
  versionSnapshot: (id: number, snapshotId: number) => get<VersionSnapshot>(`/saved-versions/${id}/snapshots/${snapshotId}`),
  versionDealers: (id: number, p: { month?: string; scheme?: string; q?: string; page?: number; page_size?: number },
                    signal?: AbortSignal) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== "") qs.set(k, String(v));
    return get<MovedDealers>(`/saved-versions/${id}/dealers`, qs, signal);
  },
  setSavedVersionStatus: (id: number, status: "SAVED" | "ARCHIVED") =>
    send<{ version_id: number; status: string }>("PATCH", `/saved-versions/${id}`, { status }),
  /** Delete a version for good (its owner or an ADMIN). A body, as every unsafe request must be JSON. */
  deleteVersion: (id: number) => send<{ version_id: number; deleted: boolean }>("DELETE", `/saved-versions/${id}`, {}),

  /** Gift schemes of the previous and current month, kept apart from CN. */
  gifts: (p: Scope, signal?: AbortSignal) =>
    get<{ previous: GiftBlock | null; current: GiftBlock }>("/gifts", scopeQs(p), signal),
  /** One gift scheme in depth, with what-if edits of its rule (outside CN). */
  giftDetail: (body: Scope & { scheme: string } & GiftEdit, signal?: AbortSignal) =>
    post<GiftDetail>("/gifts/detail", body, signal),
  /** Previous (settled) and current month by product category. */
  months: (p: Scope, signal?: AbortSignal) =>
    get<{ previous: MonthBlock | null; current: MonthBlock }>("/months", scopeQs(p), signal),
  /** The same with the current month's GSR / volume edits applied (CN stays actual; the browser adds its slab rows). */
  monthsEdited: (body: Scope & { adjustments: Adjustment[] }, signal?: AbortSignal) =>
    post<{ previous: MonthBlock | null; current: MonthBlock; warnings?: string[] }>("/months", body, signal),
  /** Next month by product category, under the structure and edits being planned. */
  nextMonth: (body: Scope & Edits & { volume_growth_pct: number; layouts: Record<string, SlabLayout>;
                                       next_layouts?: Record<string, SlabLayout>; removed_schemes: string[] },
              signal?: AbortSignal) =>
    post<NextMonthBlock>("/months/next", body, signal),
  /** Current and next month with product edits (Volume, Mix, GSR, CN %) applied, per product multipliers. */
  editedMonths: (body: Scope & {
    volume_growth_pct: number; layouts: Record<string, SlabLayout>; removed_schemes: string[];
    current: Record<string, ProductEdit>; next: Record<string, ProductEdit>;
  }, signal?: AbortSignal) => post<{ current: MonthTable; next: NextMonthBlock }>("/months/edited", body, signal),
  /** One scheme's slab tables: previous month as settled, next month as planned. */
  schemeMonths: (body: Scope & Edits & { scheme: string; volume_growth_pct: number; layouts: Record<string, SlabLayout>;
                                         next_layouts?: Record<string, SlabLayout> }, signal?: AbortSignal) =>
    post<SchemeMonths>("/months/scheme", body, signal),
  /** /all-slabs with GSR / volume edits: every component re-bucketed on the edited month (one scheme with `scheme`). */
  allSlabsAdjusted: (body: Scope & { adjustments: Adjustment[]; scheme?: string }, signal?: AbortSignal) =>
    post<AllSlabsResponse & { warnings: string[] }>("/all-slabs/adjusted", body, signal),

  filters: () => get<Filters>("/filters"),

  /** Move slab boundaries: re-buckets dealers, so counts/volume/GSR/CN all shift. */
  simulateSlabs: (body: { scheme: string; component: string; adjustments?: Adjustment[] } & Scope & SlabLayout,
                  signal?: AbortSignal) =>
    post<SlabSimResponse>("/simulate-slabs", body, signal),

  /** One scheme's slab table for a scope, as the server holds it. Used to undo slab edits: boundaries live on the
      server, so the only way to restore them is to ask for them again. */
  slabs: (p: { scheme: string } & Scope, signal?: AbortSignal) =>
    get<SchemePayload>("/slabs", scopeQs(p, new URLSearchParams({ scheme: p.scheme })), signal),

  /** What a sales target costs: grows each dealer and re-buckets them. */
  growth: (body: { growth_pct: number; per_scheme?: Record<string, number>; rate_multipliers?: Record<string, number> }
                 & Scope, signal?: AbortSignal) =>
    post<GrowthResponse>("/growth", body, signal),

  /** The dealers behind one slab row, a page at a time. `layout` only when the boundaries were moved. */
  dealers: (body: {
    scheme: string;
    component: string;
    row: DealerRowRef;
    layout?: SlabLayout;
    q?: string;
    page?: number;
    page_size?: number;
    /** A row of the month table: previous (as settled) or next (the plan, grown by volume_growth_pct). */
    month?: "previous" | "current" | "next";
    volume_growth_pct?: number;
    adjustments?: Adjustment[];
    next_adjustments?: Adjustment[];
  } & Scope, signal?: AbortSignal) =>
    post<DealersResponse>("/dealers", body, signal),

  /** Every dealer code of one slab row (no paging): a slab's Volume / GSR edit is scoped to these dealers. */
  dealerCodes: (body: {
    scheme: string;
    component: string;
    row: DealerRowRef;
    layout?: SlabLayout;
    /** current, or next (the plan: grown by volume_growth_pct, under `layout`) for a Next slab row's edit. */
    month?: "current" | "next";
    volume_growth_pct?: number;
    adjustments?: Adjustment[];
    next_adjustments?: Adjustment[];
    /** Every dealer of the component in the scope, not only the row's. */
    whole_component?: boolean;
  } & Scope) =>
    post<{ dealers_in_row: number; codes: string[] }>("/dealers", { ...body, codes_only: true }),

  /** The view as an Excel workbook (Summary, Schemes, Slabs), edits included. Built on the server, stored nowhere. */
  exportXlsx: async (body: unknown): Promise<{ blob: Blob; name: string }> => {
    const res = await fetch(`${BASE_URL}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "include",
    });
    if (!res.ok) await fail(res);
    const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "scheme-performance.xlsx";
    return { blob: await res.blob(), name };
  },

  /** Every scheme's slab tables for a scope. */
  allSlabs: (p: Scope, signal?: AbortSignal) => get<AllSlabsResponse>("/all-slabs", scopeQs(p), signal),
  /** Month-on-month figures (the Plan tab); its shape is TrendView's. */
  trend: <T,>(signal?: AbortSignal) => get<T>("/trend", undefined, signal),
};
