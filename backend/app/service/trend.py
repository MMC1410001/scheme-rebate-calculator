"""Month-on-month trend (GET /trend): complete months compared, partial months projected. Built from the monthly
files only (no live-month state), and cached by app.service.live.trend_payload."""
from __future__ import annotations

import logging

import pandas as pd

log = logging.getLogger("app.trend")


def build_trend():
    """Month-on-month movement, and what can honestly be said about next month.

    Only COMPLETE months are compared. September is a mid-month snapshot -- it
    carries roughly a third of a full month's payout uniformly across every
    scheme -- so including it would read as a collapse in demand rather than a
    partial file.
    """
    from app.core.months import complete_months, partial_months, unavailable_months
    from app.ingest.load_month import load_month

    out: list[dict] = []
    for m in complete_months():
        try:
            df = load_month(m.path, source_kind=m.source)
        except Exception:  # a month we cannot read should not break the view
            # The detail (file path, parser message) goes to the server log only: it names the server's folders.
            log.exception("trend: could not read %s", m.label)
            out.append({"month": m.label, "error": "The month's file could not be read."})
            continue
        cur = df[~df["scheme_label"].astype(str).str.lower().str.startswith("gift")]
        # Dealers carrying an overdue balance have their CN withheld, so the
        # settled figure excludes them. Verified against May's own summary:
        # settled vs gross, matching to the rupee.
        # What settles = clear cut + condonation, zeroed for dealers carrying an
        # overdue balance. Verified on 100% of May's rows against the file's own
        # summary. NOTE: the OD flag is only populated in some months (May, July);
        # April and August ship the column empty and the automated exports omit it
        # entirely, so settled figures are not strictly comparable month to month.
        has_settle = "settled_cn" in cur.columns
        cur = cur.assign(
            settled_cn=cur["settled_cn"] if has_settle
            else cur["current_cn"] + cur.get("condonation_amount", 0.0)
        )
        by_dealer = df.groupby("customer_code").agg(
            earned=("current_cn", "sum"),
            settled=("settled_cn", "sum") if has_settle else ("current_cn", "sum"),
        )
        earners = int((by_dealer["earned"] > 0).sum())
        paid = int((by_dealer["settled"] > 0).sum())
        forfeited = float(by_dealer.loc[(by_dealer["earned"] > 0) & (by_dealer["settled"] <= 0), "earned"].sum())
        g = (
            cur.groupby("scheme_label", as_index=False)
            .agg(cn=("settled_cn", "sum"), gsr=("gsr", "sum"),
                 dealers=("customer_code", "nunique"))
        )
        dealers = df.drop_duplicates("customer_code")
        out.append({
            "month": m.label,
            "complete": m.complete,
            "total_cn": float(cur["settled_cn"].sum()),
            "earned_cn": float(cur["current_cn"].sum()),
            "condonation": float(cur.get("condonation_amount", pd.Series(dtype=float)).sum()),
            "forfeited_cn": forfeited,
            "dealers_earning": earners,
            "dealers_paid": paid,
            "dealers_blocked": int(df["od_blocked"].groupby(df["customer_code"]).max().sum())
            if "od_blocked" in df.columns else 0,
            "has_od_flag": bool(has_settle and "od_blocked" in df.columns
                                and bool(df["od_blocked"].any())),
            # None, not 0, when the file has no full-month base. June's export
            # carries EB1-EB4 but no EB FULL MONTH block, and no other column
            # stands in for it -- Value Slab GSR was tested as a proxy and came
            # out at 1.84x the real base in September and 0.08x in August, so it
            # measures nothing usable. A zero here would draw as a collapse in
            # the business rather than as a gap in the file.
            "total_gsr": (float(dealers["total_gsr"].sum()) or None)
            if "total_gsr" in dealers else None,
            "dealers": int(cur["customer_code"].nunique()),
            "schemes": g.sort_values("cn", ascending=False).head(25).to_dict(orient="records"),
        })

    # Partial months: project rather than discard, now that an as-of date is known.
    from app.core.project import project_partial_month

    # partial_months() rather than MONTHS: an earlier snapshot of a month that a
    # later one supersedes is held back, or September is projected twice -- once
    # from day 18 and once from day 25 -- and reads as two different months.
    partial: list[dict] = []
    for m in partial_months():
        if m.elapsed_share is None:
            continue
        try:
            df = load_month(m.path)
        except Exception:
            log.exception("trend: could not read partial month %s", m.label)
            partial.append({"month": m.label, "error": "The month's file could not be read."})
            continue
        cur = df[~df["scheme_label"].astype(str).str.lower().str.startswith("gift")]
        dealers = df.drop_duplicates("customer_code")
        ref_full = out[-1] if out else None
        # An earlier snapshot of this same month, if one is held. Two readings
        # of one month measure the accrual curve directly, which beats importing
        # a payout rate from a different month.
        prior = None
        from app.core.months import snapshots_of

        earlier = [s for s in snapshots_of(m.label[:7])
                   if s.elapsed_days and s.elapsed_days < (m.elapsed_days or 0)]
        if earlier:
            src = earlier[-1]  # the closest one before this snapshot
            try:
                pdf = load_month(src.path, source_kind=src.source)
                pcur = pdf[~pdf["scheme_label"].astype(str).str.lower().str.startswith("gift")]
                pdl = pdf.drop_duplicates("customer_code")
                prior = {
                    "label": src.label,
                    "elapsed_days": src.elapsed_days,
                    "now_elapsed_days": m.elapsed_days,
                    "month_days": m.month_days,
                    "gsr": float(pdl["total_gsr"].sum()) if "total_gsr" in pdl else 0.0,
                    "cn": float(pcur["current_cn"].sum()),
                }
            except Exception:
                prior = None  # a snapshot we cannot read must not break the view

        proj = project_partial_month(
            partial_cn=float(cur["current_cn"].sum()),
            partial_gsr=float(dealers["total_gsr"].sum()) if "total_gsr" in dealers else 0.0,
            elapsed_share=m.elapsed_share,
            reference_cn=float(ref_full["total_cn"]) if ref_full else 0.0,
            reference_gsr=float(ref_full.get("total_gsr") or 0.0) if ref_full else 0.0,
            prior=prior,
        )
        partial.append({
            "month": m.label, "as_of": m.as_of,
            "elapsed_days": m.elapsed_days, "month_days": m.month_days,
            "note": m.note, "reference_month": ref_full["month"] if ref_full else None,
            **proj,
        })

    return {
        "months": out,
        "partial": partial,
        "excluded": [
            {"month": m.label, "reason": m.note} for m in partial_months()
        ] + [
            {"month": label, "reason": "Source file not available on this server."}
            for label in unavailable_months()
        ],
        # Stated explicitly so nobody mistakes a two-point delta for a forecast.
        "forecast_status": {
            "ready": False,
            "have": [m.label for m in complete_months()],
            "resolved": [
                "September's as-of date (18 Sep) is known, so the partial month is "
                "projected rather than discarded -- and it showed payout accrues "
                "late, not evenly.",
            ],
            "blockers": [
                "Only two complete months (Jul, Aug). Seasonality needs 24-36 months.",
                "Sep-Oct is the monsoon-to-festive inflection, the largest seasonal "
                "step of the year; nothing in Jul/Aug reveals its size.",
                "Diwali moves between Oct and Nov year to year, so the festive lift "
                "needs a festive calendar, not a month index.",
                "Payout schemes shape the very sales being forecast: dealers bunch "
                "just under slab thresholds at month end, so raw GSR is not a clean "
                "demand signal.",
            ],
            "unlocks": {
                "Sep 2025 + Oct 2025": "measures the actual Sep-to-Oct step, the single "
                                       "most valuable missing input",
                "24 months of history": "supports proper seasonality by region",
                "24 months by region": "separates a regional monsoon effect from a "
                                       "national one",
            },
        },
    }
