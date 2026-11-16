import { ColHead } from "./ColHead";
import { useEffect, useState } from "react";
import { api, type GiftBlock, type GiftRow, errorText, isAbort } from "../api/client";
import { ErrorBanner } from "./Feedback";
import { fmtAsOf } from "../api/computeImpact";
import { fmtInr, rupees as money } from "../format";

/** Gift schemes of the previous and current month, from the gift / contest file (Shine On Gift, Glossa Gift,
 *  Wallpaper Roll, 5% Nova Prime ...). Kept apart from CN (user's decision, 2 Nov 2026): nothing here is in any CN
 *  figure, and nothing here can be edited. Gifts are counts; a rupee scheme in the same file is shown in rupees. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;


// Gifts (a count) and rupees (5% Nova Prime) are separate columns, so no figure can be read in the wrong unit.
const gifts = (r: GiftRow | undefined) => (!r ? "—" : r.unit === "gifts" ? fmtInr(r.earned) : "—");
const paid = (r: GiftRow | undefined) => (!r ? "—" : r.unit === "rupees" ? money(r.earned) : "—");

export function GiftsView({ scope, onOpenDetail }: {
  scope: { zone: string[]; region: string[]; depot_code: string[] };
  /** A gift scheme's name: its card in Scheme detail. */
  onOpenDetail: (scheme: string) => void;
}) {
  const [data, setData] = useState<{ previous: GiftBlock | null; current: GiftBlock } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const scopeKey = `${scope.zone.join("|")}#${scope.region.join("|")}#${scope.depot_code.join("|")}`;

  useEffect(() => {
    const ctrl = new AbortController();
    setErr(null);
    api.gifts(scope, ctrl.signal).then(setData).catch((e) => { if (!isAbort(e)) setErr(errorText(e)); });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, attempt]);

  if (err) {
    return (
      <section className="months gifts" aria-label="Gift schemes">
        <ErrorBanner text={`Gift schemes could not be loaded. ${err}`} onRetry={() => setAttempt((n) => n + 1)} />
      </section>
    );
  }
  if (!data) return null;
  const blocks = [data.previous, data.current].filter((b): b is GiftBlock => b != null);
  if (blocks.every((b) => b.schemes.length === 0)) return null;

  const names: string[] = [];
  for (const b of blocks) for (const r of b.schemes) if (!names.includes(r.scheme)) names.push(r.scheme);
  const row = (b: GiftBlock, name: string) => b.schemes.find((r) => r.scheme === name);
  const sub = (b: GiftBlock) => (b.as_of ? fmtAsOf(b.as_of, b.version) : "no gift file for this month yet");

  return (
    <section className="months gifts card-viz" aria-label="Gift schemes">
      <header className="mv-head">
        <div>
          <h2>Gift schemes</h2>
          <p className="muted">
            From the separate gift file. <b>Not part of CN</b>: none of these figures is in any CN total above.
            Gifts is the number of gifts dealers earned (a count); Paid is what a rupee scheme in the same file
            (5% Nova Prime) pays, in ₹.
            Qualified = dealers who reached the scheme's first level.
          </p>
        </div>
      </header>
      <div className="mv-scroll">
        <table className="mv-table">
          <thead>
            <tr>
              <th rowSpan={2} scope="col">Scheme</th>
              {blocks.map((b, i) => (
                <th key={b.month} colSpan={5} scope="colgroup"
                    className={`mv-month ${i === blocks.length - 1 ? "is-cur" : "is-prev"}`}>
                  <span>{i === blocks.length - 1 ? "Current" : "Previous"} · {monthName(b.month)}</span>
                  <em>{sub(b)}</em>
                </th>
              ))}
            </tr>
            <tr>
              {blocks.map((b) => (
                <FragmentHeads key={b.month} />
              ))}
            </tr>
          </thead>
          <tbody>
            {names.map((name) => (
              <tr key={name} id={`mv-gift-${name}`}>
                <th scope="row">
                  <button type="button" className="mv-toggle mv-name-link" title="Open this gift scheme in Scheme detail"
                          onClick={() => onOpenDetail(name)}>
                    {name}
                  </button>
                </th>
                {blocks.map((b) => {
                  const r = row(b, name);
                  return [
                    <td key="d" className="num mv-first">{r ? fmtInr(r.dealers) : "—"}</td>,
                    <td key="q" className="num">{r ? fmtInr(r.qualified) : "—"}</td>,
                    <td key="e" className="num">{gifts(r)}</td>,
                    <td key="p" className="num" title={r?.unit === "rupees" && r.rate != null ? `${r.rate}% of GSR, paid in rupees, not in CN` : undefined}>
                      {paid(r)}
                    </td>,
                    <td key="g" className="num">{r ? money(r.gsr) : "—"}</td>,
                  ];
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FragmentHeads() {
  return (
    <>
      <th className="num mv-first" title="Dealers with sales in the scheme"><ColHead name="Dealers" unit="count" /></th>
      <th className="num" title="Dealers who reached the first level"><ColHead name="Qualified" unit="count" /></th>
      <th className="num" title="Gifts earned: a count of gifts"><ColHead name="Gifts" unit="count" /></th>
      <th className="num" title="Paid in rupees by a rupee scheme in the gift file (5% Nova Prime); not part of CN"><ColHead name="Paid" unit="₹" /></th>
      <th className="num" title="GSR of the scheme's products"><ColHead name="GSR" unit="₹" /></th>
    </>
  );
}
