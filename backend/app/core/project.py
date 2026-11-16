"""
Projecting a part-month file to its full-month figure.

The naive approach -- scale the payout by elapsed days -- is badly wrong for
slab schemes, and the September file shows why:

    18 of 30 days elapsed   = 60% of the month
    GSR at 58% of August    -> sales ARE tracking pro-rata
    CN  at 35% of August    -> payout is nowhere near pro-rata

Sales accrue linearly; payout does not. A dealer earns nothing until they cross
a slab threshold, so CN is back-loaded: it accelerates through the final third
as dealers tip into paying bands. Scaling CN by elapsed days therefore
understates the month by a wide margin.

What holds steady month to month is the FULL-MONTH payout rate. So the defensible
route is: project GSR (which is linear) to the full month, then apply the payout
rate a comparable complete month actually settled at.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Projection:
    method: str
    label: str
    cn: float
    note: str
    recommended: bool = False
    # The GSR this method implies, and the payout rate that follows from it, so
    # the trend chart can carry all three series rather than payout alone.
    gsr: float = 0.0
    rate_pct: float = 0.0


def project_partial_month(
    partial_cn: float,
    partial_gsr: float,
    elapsed_share: float,
    reference_cn: float,
    reference_gsr: float,
    prior: dict | None = None,
) -> dict:
    """Project a part-month to full month, showing the naive routes alongside.

    The alternatives are kept rather than hidden: the gap between them IS the
    finding, and a single number with no context invites the pro-rata assumption
    it is trying to correct.
    """
    if elapsed_share <= 0 or partial_gsr <= 0 or reference_gsr <= 0:
        return {"projections": [], "observed": {}}

    reference_rate = reference_cn / reference_gsr           # full-month payout rate
    partial_rate = partial_cn / partial_gsr                 # rate so far, mid-month
    projected_gsr = partial_gsr / elapsed_share             # GSR is linear -> safe to scale
    gsr_pace = partial_gsr / reference_gsr

    projections: list[Projection] = []

    # When an EARLIER snapshot of this same month exists, the two readings give
    # the accrual curve directly, and nothing has to be borrowed from another
    # month. This is the only method here that measures rather than assumes:
    #
    #   the payout rate is observed climbing, so its slope is extrapolated;
    #   GSR is observed ACCELERATING, so the recent daily pace is used rather
    #   than the month's average -- Sep ran 14.92 Cr/day to day 18 and
    #   18.77 Cr/day over days 19-25, and treating that as linear understates
    #   the close.
    #
    # Both are straight-line extrapolations of a short window, so they are
    # honest about the near term and get shakier the further out they reach.
    if prior and prior.get("elapsed_days") and prior.get("gsr", 0) > 0:
        d0, g0, c0 = prior["elapsed_days"], prior["gsr"], prior["cn"]
        d1 = prior["now_elapsed_days"]
        total_days = prior["month_days"]
        span = d1 - d0
        left = total_days - d1
        if span > 0 and left >= 0 and g0 > 0 and partial_gsr > g0:
            # MARGINAL rate, not the average one.
            #
            # The first version of this extrapolated the AVERAGE payout rate in
            # a straight line, and September showed that to be wrong in
            # direction, not just degree. Three snapshots of that month:
            #
            #     day 18   GSR 100 Cr   CN  6.5 Cr   rate 6.5%     (illustrative figures)
            #     day 25   GSR 150 Cr   CN 14.0 Cr   rate 9.3%
            #     day 30   GSR 210 Cr   CN 18.0 Cr   rate 8.6%
            #
            # The rate rises, peaks, and TURNS OVER. Extending the 18->25 slope
            # predicted about 11% at close against an actual 8.6%, a large error.
            #
            # The mechanism is that late sales are cheap to pay for: a dealer
            # who has already cleared their slab earns the same rate on extra
            # volume, and dealers activating in the last few days sit in low or
            # unrated bands. The marginal rate was far higher over days
            # 19-25 than over days 26-30. So new GSR is costed at the
            # marginal rate observed between the snapshots, and the rate at
            # close is an OUTPUT rather than an assumption.
            marginal = (partial_cn - c0) / (partial_gsr - g0)
            late_pace = (partial_gsr - g0) / span
            close_gsr = partial_gsr + late_pace * left
            close_cn = partial_cn + marginal * (close_gsr - partial_gsr)
            projections.append(Projection(
                method="measured_accrual",
                label="Measured from two snapshots",
                cn=close_cn,
                note=(
                    f"Sales so far are running at Rs {late_pace / 1e7:.2f} Cr/day and "
                    f"are projected forward at that pace. New sales are costed at the "
                    f"{marginal * 100:.2f}% MARGINAL payout rate observed between day "
                    f"{d0} and day {d1}, not the {partial_cn / partial_gsr * 100:.2f}% "
                    f"average -- late volume is cheaper, because dealers past their "
                    f"slab earn the same rate on more litres. Calibrated on September, "
                    f"where this still ran about 3% high and the sales pace itself "
                    f"nearly doubled in the final five days."
                ),
                recommended=True,
                gsr=close_gsr,
                rate_pct=(close_cn / close_gsr * 100) if close_gsr else 0.0,
            ))

    projections += [
        Projection(
            method="pro_rata_cn",
            label="Pro-rata on days",
            cn=partial_cn / elapsed_share,
            note="Scales payout by elapsed days. Assumes CN accrues evenly, which "
                 "slab schemes do not -- understates the month.",
            gsr=projected_gsr,
            rate_pct=(partial_cn / elapsed_share) / projected_gsr * 100 if projected_gsr else 0.0,
        ),
        Projection(
            method="gsr_paced_cn",
            label="Paced to GSR",
            cn=partial_cn / gsr_pace if gsr_pace else 0.0,
            gsr=projected_gsr,
            rate_pct=((partial_cn / gsr_pace) / projected_gsr * 100)
            if gsr_pace and projected_gsr else 0.0,
            note="Scales payout by how far GSR has got. Same flaw: it still assumes "
                 "the payout rate stays where it is today.",
        ),
        Projection(
            method="rate_at_close",
            label="GSR projected at full-month rate",
            cn=projected_gsr * reference_rate,
            gsr=projected_gsr,
            rate_pct=reference_rate * 100,
            note="Projects GSR on elapsed days, then applies the payout rate a "
                 "complete month settled at. Handles the rate climbing as dealers "
                 "cross thresholds, but imports that rate from another month and "
                 "assumes sales accrue evenly.",
            recommended=not projections,
        ),
    ]

    return {
        "observed": {
            "elapsed_share": elapsed_share,
            "partial_cn": partial_cn,
            "partial_gsr": partial_gsr,
            "partial_rate_pct": partial_rate * 100,
            "reference_rate_pct": reference_rate * 100,
            "gsr_pace": gsr_pace,
            "cn_pace": partial_cn / reference_cn if reference_cn else 0.0,
            "projected_gsr": projected_gsr,
        },
        "projections": [p.__dict__ for p in projections],
    }
