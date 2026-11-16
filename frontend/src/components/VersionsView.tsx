import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useUser } from "../userContext";
import {
  api,
  errorText,
  type Adjustment,
  type MovedDealers,
  type VersionDetail,
  type SavedVersionInput,
  type VersionScheme,
  type VersionSlab,
  type VersionSummary,
  type VersionTotals,
  type SlabLayout,
} from "../api/client";
import { fmtInr, fmtMoney, fmtRate, fmtSlab, fmtTarget } from "../api/computeImpact";
import { cnClass, pct as fmtPct, signedRupees } from "../format";
import { useConfirm, useFocusTrap, useToast } from "../hooks/useFeedback";
import { ErrorBanner } from "./Feedback";
import { HeldFixedNote } from "./MonthsView";
import { describe } from "./describeEdit";

/** Saved what-if versions, for senior management: the list, and each version's actual vs version figures for the
 *  current and next month (per scheme and slab, and the dealers who moved slab), live or as shown on a date.
 *
 *  A version is built on the Simulator (GSR / volume typed into the month table, slab and rate edits, deleted
 *  schemes, V) and saved there (SaveVersion). The server computes it from the actual month, which it never
 *  changes; after each daily file the live result is computed again while the dated snapshots stay as they were.
 *  Saving, archiving and the moved dealers need an ADMIN login; a VIEWER can list and open versions. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const pct = (n: number | null | undefined) => fmtPct(n, 2);
const share = (cn: number, gsr: number) => (gsr ? (100 * cn) / gsr : null);
const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

function change(a: number, b: number) {
  const d = b - a;
  if (Math.abs(d) < 1) return <span className="muted">—</span>;
  return <span className={`${cnClass(d)} sc-chg`}>{signedRupees(d)}</span>;
}

/** The API's reason for a failure, in plain words (api/client errorText). */
const reason = (e: unknown) => errorText(e);

/** A saved version opened in the Simulator: everything needed to rebuild it there. */
export interface OpenVersion {
  id: number;
  name: string;
  note: string | null;
  editable: boolean;
  /** This login may save changes to it (its own, or any for an ADMIN); else a save makes a new version. */
  canChange?: boolean;
  adjustments: Adjustment[];
  next_adjustments: Adjustment[];
  layouts: Record<string, SlabLayout>;
  /** Next month's own slab tables. */
  next_layouts?: Record<string, SlabLayout>;
  removed_schemes: string[];
  volume_growth_pct: number;
}

/** "Save version" on the Simulator: names what is on the table and saves it (or the changes to the one opened).
 *  A small form: Enter saves, Escape or a click outside closes it. A name is required (names are unique). */
/** Save, when this user cannot save: why, in plain words. */
function SaveOff() {
  const { user } = useUser();
  const why = user.role === "VIEWER" ? "Saving versions needs an administrator's or a scheme manager's login"
    : "Saving needs the database, which is not set up on this server";
  return <button className="btn sm" disabled title={why}>Save version</button>;
}

export function SaveVersion({ canSave, opened, build, onSaved, hasEdits, dirty }: {
  canSave: boolean;
  opened: { id: number; name: string; note: string | null } | null;
  build: () => Omit<SavedVersionInput, "name" | "note">;
  onSaved: (s: { id: number; name: string; note: string | null }) => void;
  /** Anything to save at all. */
  hasEdits: boolean;
  /** Edits made since the version was last saved or opened. */
  dirty: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const start = () => { setName(opened?.name ?? ""); setNote(opened?.note ?? ""); setMsg(null); setOpen(true); };
  // Tab stays in the form; Escape closes it and gives focus back to the Save button. A click outside closes it too.
  useFocusTrap(form, open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  // "Saved" fades after a few seconds.
  useEffect(() => {
    if (!saved) return;
    const t = window.setTimeout(() => setSaved(null), 6000);
    return () => window.clearTimeout(t);
  }, [saved]);
  const save = (asNew: boolean) => {
    if (!name.trim()) { setMsg("Type a name for the version."); return; }
    setBusy(true);
    setMsg(null);
    const body = { ...build(), name: name.trim(), note: note.trim() || null };
    api.saveVersion(body, asNew ? undefined : opened?.id)
      .then((r) => {
        onSaved({ id: r.version_id, name: body.name, note: body.note });
        setSaved(`Saved "${body.name}". It is on the Versions tab.`);
        setOpen(false);
      })
      .catch((e) => setMsg(reason(e)))
      .finally(() => setBusy(false));
  };
  if (!canSave) return <SaveOff />;
  return (
    <span className="sc-save" ref={box}>
      <button className="btn sm btn-primary" aria-expanded={open} disabled={!hasEdits && !opened}
              title={!hasEdits && !opened ? "Edit a figure, slab or rate first" : undefined}
              onClick={() => (open ? setOpen(false) : start())}>
        {opened ? `Save · ${opened.name}` : "Save version"}
        {dirty && <span className="unsaved-dot" title="Changes not saved yet"> • unsaved</span>}
      </button>
      {saved && !open && <span className="muted" role="status">{saved}</span>}
      {open && (
        <form ref={form} className="sc-save-pop" role="dialog" aria-label="Save version"
              onSubmit={(e) => { e.preventDefault(); save(!opened); }}>
          <label className="f"><span>Name (required)</span>
            <input value={name} maxLength={200} autoFocus required onChange={(e) => { setName(e.target.value); setMsg(null); }}
                   placeholder="e.g. North +10% GSR" aria-invalid={msg && !name.trim() ? true : undefined} />
          </label>
          <label className="f"><span>Note</span>
            <input value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
          </label>
          <span className="sc-actions">
            {opened && <button type="submit" className="btn sm btn-primary" disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>}
            <button type={opened ? "button" : "submit"} className={`btn sm ${opened ? "" : "btn-primary"}`} disabled={busy}
                    onClick={opened ? () => save(true) : undefined}>
              {busy && !opened ? "Saving…" : opened ? "Save as new" : "Save"}
            </button>
            <button type="button" className="btn sm btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
          </span>
          <span className="muted">
            Saves the GSR / volume edits, slab and rate edits, deleted schemes and V, with the current and next month's
            results. Everyone who opens this app can see it.
          </span>
          {msg && <span className="error" role="alert">{msg}</span>}
        </form>
      )}
    </span>
  );
}

/** One month's figures, from a snapshot. */
type View = { month: string; totals: VersionTotals; warnings: string[]; schemes: VersionScheme[] };

export function VersionsView({ onOpen }: { onOpen: (s: OpenVersion) => void }) {
  /** The database is there (the list can be shown); canSave: this user may also archive and restore. */
  const [hasDb, setHasDb] = useState<boolean | null>(null);
  const [canSave, setCanSave] = useState(false);
  const [list, setList] = useState<VersionSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** A failed action (open, archive, a snapshot): shown above the list, which stays. */
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [status, setStatusMsg] = useState<string | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<VersionDetail | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [snapId, setSnapId] = useState<number | null>(null);
  const [snap, setSnap] = useState<View | null>(null);
  const [confirm, confirmNode] = useConfirm();
  const [showToast, toastNode] = useToast();
  /** Versions being deleted: hidden at once, deleted on the server after the 10 s Undo window. */
  const [deleting, setDeleting] = useState<Set<number>>(() => new Set());

  const refresh = useCallback(() => {
    api.versions().then((r) => { setList(r.versions); setErr(null); }).catch((e) => setErr(reason(e)));
  }, []);
  useEffect(() => {
    api.versionMeta().then((m) => {
      const db = m.has_db ?? m.can_save;
      setHasDb(db); setCanSave(m.can_save); setErr(null);
      if (db) refresh();
    })
      .catch((e) => setErr(reason(e)));
  }, [refresh, attempt]);

  useEffect(() => {
    if (!open || snapId == null) return;
    let live = true;
    api.versionSnapshot(open.version_id, snapId).then((s) => {
      if (!live) return;
      setSnap({
        month: s.month.slice(0, 7), warnings: s.warnings,
        totals: { dealers: s.dealers, dealers_moved: s.dealers_moved, actual_gsr: s.actual_gsr,
                  version_gsr: s.version_gsr, actual_cn: s.actual_cn, version_cn: s.version_cn },
        schemes: s.schemes.map((x) => ({ ...x, scheme: x.scheme_key })),
      });
    }).catch((e) => live && setActionErr(reason(e)));
    return () => { live = false; };
  }, [open, snapId]);

  const show = (d: VersionDetail, m: string) => {
    setMonth(m);
    setSnap(null);
    setSnapId(d.snapshots.find((n) => n.month === m && n.kind === "live")?.snapshot_id
      ?? d.snapshots.find((n) => n.month === m)?.snapshot_id ?? null);
  };
  const openVersion = (id: number) => {
    setOpening(id);
    setActionErr(null);
    api.version(id).then((d) => {
      setOpen(d);
      const months = [...new Set(d.snapshots.map((n) => n.month))].sort();
      show(d, months[0] ?? "");
    }).catch((e) => setActionErr(reason(e)))
      .finally(() => setOpening(null));
  };
  const changeStatus = (s: VersionSummary, archiving: boolean, undo = false) => {
    setActionErr(null);
    return api.setSavedVersionStatus(s.version_id, archiving ? "ARCHIVED" : "SAVED")
      .then(() => {
        refresh();
        if (open?.version_id === s.version_id) openVersion(s.version_id);
        setStatusMsg(archiving ? `"${s.name}" was archived. Restore brings it back; versions older than the live month and the two before it are deleted.`
                               : `"${s.name}" was restored.`);
        if (archiving && !undo) {
          showToast({ text: `"${s.name}" was archived.`,
                      action: { label: "Undo", run: () => { void changeStatus(s, false, true); } } });
        }
      })
      .catch((e) => setActionErr(reason(e)));
  };
  /** Archive asks first (it hides the version from everyone) and offers Undo; Restore needs neither. */
  const setStatus = async (s: VersionSummary) => {
    const archiving = s.status !== "ARCHIVED";
    if (archiving && !(await confirm({
      title: `Archive "${s.name}"?`,
      body: <p>The version is hidden from everyone's list of saved versions. Restore brings it back. An archived version
              no longer counts towards your 10 saved versions. You can undo this for 10 seconds.</p>,
      confirmLabel: "Archive", danger: true,
    }))) return;
    void changeStatus(s, archiving);
  };
  /** Delete asks first, then hides the version and offers Undo for 10 s; only then is it deleted on the server. */
  const unhide = (id: number) => setDeleting((cur) => { const n = new Set(cur); n.delete(id); return n; });
  const remove = async (s: VersionSummary) => {
    if (!(await confirm({
      title: `Delete "${s.name}"?`,
      body: <p>The version, its edits and its dated snapshots are deleted for everyone and cannot be brought back
              after 10 seconds. To keep it out of the list without losing it, archive it instead.</p>,
      confirmLabel: "Delete", danger: true,
    }))) return;
    setActionErr(null);
    setStatusMsg(null);
    setDeleting((cur) => new Set(cur).add(s.version_id));
    if (open?.version_id === s.version_id) setOpen(null);
    const timer = window.setTimeout(() => {
      api.deleteVersion(s.version_id)
        .then(() => { setStatusMsg(`"${s.name}" was deleted.`); refresh(); })
        .catch((e) => setActionErr(reason(e)))
        .finally(() => unhide(s.version_id));
    }, 10_000);
    showToast({ text: `"${s.name}" will be deleted.`,
                action: { label: "Undo", run: () => { window.clearTimeout(timer); unhide(s.version_id); } } });
  };
  const toSimulator = (d: VersionDetail) => onOpen({
    id: d.version_id, name: d.name, note: d.note, editable: d.editable, canChange: d.can_change ?? true,
    adjustments: d.adjustments.filter((a) => a.period === "current").map(strip),
    next_adjustments: d.adjustments.filter((a) => a.period === "next").map(strip),
    layouts: d.layouts, next_layouts: d.next_layouts ?? {}, removed_schemes: d.removed_schemes,
    volume_growth_pct: d.volume_growth_pct,
  });

  if (err && (hasDb === null || list === null)) {
    return <ErrorBanner text={err} onRetry={() => { setErr(null); setAttempt((n) => n + 1); }} />;
  }
  if (hasDb === null) return <p className="hint" role="status">Loading…</p>;
  const months = open ? [...new Set(open.snapshots.map((n) => n.month))].sort() : [];

  return (
    <div className="sc">
      <section className="sc-panel">
        <header className="sc-head">
          <div>
            <h2>Saved versions</h2>
            <p className="muted">
              Built and saved on the Simulator: type GSR, volume or mix into the month table, edit slabs and rates, then
              "Save version". Each is computed again on every new daily file of its month; the dated snapshots keep
              what was shown when it was saved. Shared with everyone who opens this app. Each person keeps at most 10
              saved versions (archived ones do not count). Versions saved before the live month and the two months
              before it are deleted, archived or not.
            </p>
          </div>
        </header>
        {actionErr && <ErrorBanner text={actionErr} onDismiss={() => setActionErr(null)} />}
        {status && <p className="sc-status" role="status">{status}</p>}
        {!hasDb ? <p className="hint">Saving is off: the database is not set up on this server (SPI_DATABASE_URL).</p>
          : list === null ? <p className="hint">Loading…</p>
          : list.filter((x) => !deleting.has(x.version_id)).length === 0 ? <p className="hint">No version saved yet.</p> : (
          <div className="dl-table-wrap">
            <table className="dl-table">
              <thead>
                <tr>
                  <th scope="col">Version</th><th scope="col" className="num" title="Figure edits · edited slab tables">Edits</th>
                  {["Current", "Next"].map((h) => (
                    <Fragment key={h}>
                      <th scope="col" className="num">{h} month: actual CN ₹</th><th scope="col" className="num">Version CN ₹</th>
                      <th scope="col" className="num" title="Version CN − actual CN">Change ₹</th>
                    </Fragment>
                  ))}
                  <th scope="col">Updated</th><th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {list.filter((x) => !deleting.has(x.version_id)).map((x) => (
                  <tr key={x.version_id} className={open?.version_id === x.version_id ? "sc-open" : undefined}>
                    <td>
                      <button className="link-num" onClick={() => openVersion(x.version_id)} aria-busy={opening === x.version_id || undefined}>
                        {x.name}{opening === x.version_id && <span className="muted"> · opening…</span>}
                      </button>
                      {x.status === "ARCHIVED" && <em className="sc-tag">archived</em>}
                      {!x.editable && x.status !== "ARCHIVED" && <em className="sc-tag" title="Its month is no longer live">kept as saved</em>}
                      <div className="muted">{monthName(x.base_month.slice(0, 7))}, V {x.volume_growth_pct}%{x.note ? ` · ${x.note}` : ""}</div>
                    </td>
                    <td className="num">{x.adjustments} · {x.slab_edits} slab</td>
                    {[0, 1].map((i) => {
                      const m = x.months[i];
                      return (
                        <Fragment key={i}>
                          <td className="num">{m ? fmtMoney(m.actual_cn) : "—"}</td>
                          <td className="num">{m ? fmtMoney(m.version_cn) : "—"}</td>
                          <td className="num">{m ? change(m.actual_cn, m.version_cn) : "—"}</td>
                        </Fragment>
                      );
                    })}
                    <td>{when(x.updated_at)}</td>
                    <td className="sc-row-actions">{canSave && x.can_change !== false && (<>
                      <button className="btn sm btn-ghost" onClick={() => { void setStatus(x); }}
                              aria-label={`${x.status === "ARCHIVED" ? "Restore" : "Archive"} ${x.name}`}>
                        {x.status === "ARCHIVED" ? "Restore" : "Archive"}</button>
                      <button className="btn sm btn-ghost sc-delete" onClick={() => { void remove(x); }}
                              aria-label={`Delete ${x.name}`}>Delete</button>
                    </>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {open && (
        <section className="sc-panel">
          <header className="sc-head">
            <div>
              <h2>{open.name}</h2>
              <p className="muted">
                Edits {monthName(open.base_month.slice(0, 7))} and plans the next month with V {open.volume_growth_pct}%.{" "}
                {open.adjustments.length} figure edit(s), {Object.keys(open.layouts).length} edited slab table(s)
                {Object.keys(open.next_layouts ?? {}).length ? `, ${Object.keys(open.next_layouts ?? {}).length} next-month-only slab table(s)` : ""}
                {open.removed_schemes.length ? `, ${open.removed_schemes.length} scheme(s) deleted` : ""}.
              </p>
            </div>
            <div className="sc-actions">
              <div className="tabs" role="tablist" aria-label="Month">
                {months.map((m) => (
                  <button key={m} role="tab" aria-selected={month === m} className={month === m ? "is-active" : ""}
                          onClick={() => show(open, m)}>{monthName(m)}</button>
                ))}
              </div>
              <label className="f"><span>Show</span>
                <select value={snapId ?? ""} onChange={(e) => setSnapId(Number(e.target.value))}>
                  {open.snapshots.filter((n) => n.month === month).map((n) => (
                    <option key={n.snapshot_id} value={n.snapshot_id}>
                      {n.kind === "live" ? `Live (on the file of ${n.as_of ?? n.source_file})` : `Saved ${when(n.taken_at)}`}
                    </option>
                  ))}
                </select>
              </label>
              <button className="btn sm btn-reset" onClick={() => toSimulator(open)}
                      title={open.editable ? "Load it into the Simulator to look at or change it" : "Load it into the Simulator (its month is no longer live: changes are saved as a new version)"}>
                Open in Simulator
              </button>
              <button className="btn sm btn-ghost" onClick={() => setOpen(null)}>Close</button>
            </div>
          </header>
          {open.adjustments.length > 0 && (
            <ul className="sc-list">
              {open.adjustments.map((a, i) => <li key={i}>{describe(a)}{a.reason ? ` — ${a.reason}` : ""}</li>)}
            </ul>
          )}
          <HeldFixedNote />
          {snap ? <Result view={snap} /> : <p className="hint" role="status">Loading…</p>}
          {month && open.snapshots.find((n) => n.snapshot_id === snapId)?.kind === "live" && (
            <Moved id={open.version_id} month={month} />
          )}
        </section>
      )}
      {confirmNode}
      {toastNode}
    </div>
  );
}

const strip = (a: Adjustment): Adjustment => {
  const { period: _period, ...rest } = a;
  return { ...rest, reason: rest.reason ?? null };
};

/** Totals, then schemes by product; a scheme opens its slab tables, actual beside version (rows not aligned). */
function Result({ view }: { view: View }) {
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const t = view.totals;
  const products = [...new Set(view.schemes.map((s) => s.product))];
  return (
    <div className="sc-result">
      <h3>Actual vs version · {monthName(view.month)}</h3>
      <div className="sc-kpis">
        <div><span>GSR</span><b>{fmtMoney(t.actual_gsr)} → {fmtMoney(t.version_gsr)}</b></div>
        <div><span>CN</span><b>{fmtMoney(t.actual_cn)} → {fmtMoney(t.version_cn)}</b> {change(t.actual_cn, t.version_cn)}</div>
        <div><span>CN % of GSR</span><b>{pct(share(t.actual_cn, t.actual_gsr))} → {pct(share(t.version_cn, t.version_gsr))}</b></div>
        <div><span>Dealers who moved slab</span><b>{fmtInr(t.dealers_moved)} of {fmtInr(t.dealers)}</b></div>
      </div>
      {view.warnings.length > 0 && (
        <ul className="sc-warn">{view.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
      )}
      <div className="dl-table-wrap">
        <table className="dl-table">
          <thead>
            <tr>
              <th>Scheme</th><th className="num">Dealers</th><th className="num">Moved</th>
              <th className="num">GSR actual</th><th className="num">GSR version</th>
              <th className="num">CN actual</th><th className="num">CN version</th><th className="num">Change</th>
              <th className="num">CN % actual</th><th className="num">CN % version</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <Fragment key={p}>
                <tr className="sc-product"><td colSpan={10}>{p}</td></tr>
                {view.schemes.filter((s) => s.product === p).map((s) => {
                  const isOpen = opened.has(s.scheme);
                  return (
                    <Fragment key={s.scheme}>
                      <tr>
                        <td>
                          <button className="link-num" aria-expanded={isOpen}
                                  onClick={() => setOpened((prev) => {
                                    const n = new Set(prev);
                                    if (n.has(s.scheme)) n.delete(s.scheme); else n.add(s.scheme);
                                    return n;
                                  })}>
                            {isOpen ? "▾" : "▸"} {s.label ?? s.scheme}
                          </button>
                          {!s.is_currency && <em className="sc-tag">gifts</em>}
                          {s.removed && <em className="sc-tag">deleted</em>}
                        </td>
                        <td className="num">{fmtInr(s.dealers)}</td>
                        <td className="num">{s.dealers_moved ? fmtInr(s.dealers_moved) : "—"}</td>
                        <td className="num">{fmtMoney(s.actual_gsr)}</td>
                        <td className="num">{fmtMoney(s.version_gsr)}</td>
                        <td className="num">{fmtMoney(s.actual_cn)}</td>
                        <td className="num">{fmtMoney(s.version_cn)}</td>
                        <td className="num">{change(s.actual_cn, s.version_cn)}</td>
                        <td className="num">{pct(share(s.actual_cn, s.actual_gsr))}</td>
                        <td className="num">{pct(share(s.version_cn, s.version_gsr))}</td>
                      </tr>
                      {isOpen && Object.entries(s.components).map(([c, sides]) => (
                        <tr key={c} className="sc-slabs">
                          <td colSpan={10}>
                            <div className="sc-comp">{c}</div>
                            <div className="sc-sides">
                              <Slabs title="Actual" rows={sides.actual} />
                              <Slabs title="Version" rows={sides.version} />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Slabs({ title, rows }: { title: string; rows: VersionSlab[] }) {
  return (
    <table className="mv-small">
      <caption>{title}</caption>
      <thead>
        <tr><th>Slab</th><th className="num">Dealers</th><th className="num">GSR ₹</th><th className="num">Rate</th>
          <th className="num">CN ₹</th><th className="num">CN %</th></tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{r.slab_mode === "unrated" ? "Not qualified"
              : r.slab_mode === "target" ? fmtTarget(r.slab_lower, r.slab_upper, r.rate, r.formula, r.pack_size)
                : fmtSlab(r.slab_lower ?? 0, r.slab_upper)}</td>
            <td className="num">{fmtInr(r.dealers)}</td>
            <td className="num">{fmtMoney(r.gsr)}</td>
            <td className="num">{fmtRate(r.rate, r.formula, r.pack_size)}</td>
            <td className="num">{fmtMoney(r.cn)}</td>
            <td className="num">{pct(share(r.cn, r.gsr))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Dealers whose slab or rate moved in one month's live result. Client data: a page at a time, nothing kept. */
function Moved({ id, month }: { id: number; month: string }) {
  const { canSeeDealers } = useUser();
  if (!canSeeDealers) {
    return <p className="hint">The dealers who moved slab are client data: an administrator's login can list them.</p>;
  }
  return <MovedList id={id} month={month} />;
}

function MovedList({ id, month }: { id: number; month: string }) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<MovedDealers | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      api.versionDealers(id, { month, q, page }).then((d) => { if (live) { setData(d); setErr(null); } }).catch((e) => live && setErr(reason(e)));
    }, 250);
    return () => { live = false; window.clearTimeout(t); };
  }, [id, month, q, page]);
  return (
    <div className="sc-result">
      <div className="sc-actions">
        <h3>Dealers who moved slab · {monthName(month)}{data ? ` (${fmtInr(data.total)} dealer-scheme rows)` : ""}</h3>
        <span className="sc-grow" />
        <label className="f"><span>Find</span>
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Code or name" />
        </label>
      </div>
      {err && <ErrorBanner text={err} />}
      {data && data.rows.length === 0 && <p className="hint">No dealer changed slab.</p>}
      {data && data.rows.length > 0 && (
        <div className="dl-table-wrap">
          <table className="dl-table">
            <thead>
              <tr><th>Dealer</th><th>Region</th><th>Scheme · component</th>
                <th className="num" title="What the slab is decided on (litres or rupees), actual → version">Achievement</th>
                <th className="num" title="The lower edge of the dealer's slab, actual → version">Slab from</th>
                <th className="num" title="Rate actual → version, in the scheme's own unit">Rate</th><th className="num">CN ₹</th></tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={`${r.customer_code}-${r.scheme_key}-${r.component}`}>
                  <td>{r.customer_code}<div className="muted">{r.customer_name ?? ""}</div></td>
                  <td>{r.region ?? "—"}</td>
                  <td>{r.scheme_key}<div className="muted">{r.component}</div></td>
                  <td className="num">{fmtInr(r.actual_basis)} → {fmtInr(r.version_basis)}</td>
                  <td className="num">{r.actual_lower == null ? <abbr title="Not qualified">n/q</abbr> : fmtInr(r.actual_lower)} → {r.version_lower == null ? <abbr title="Not qualified">n/q</abbr> : fmtInr(r.version_lower)}</td>
                  <td className="num">{r.actual_rate} → {r.version_rate}</td>
                  <td className="num">{fmtMoney(r.actual_cn)} → {fmtMoney(r.version_cn)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.pages > 1 && (
        <div className="sc-actions">
          <button className="btn sm" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>Previous</button>
          <span className="muted">Page {data.page} of {data.pages}</span>
          <button className="btn sm" disabled={data.page >= data.pages} onClick={() => setPage(data.page + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}
