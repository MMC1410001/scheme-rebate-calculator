import type { SchemePayload, SlabRow } from "../api/client";
import { ContributionChart, type SchemeStat } from "./ContributionChart";
import { RateBars } from "./RateBars";
import { SchemeDrilldown } from "./SchemeDrilldown";

/** The Overview tab: each scheme's share of the payout and its CN % of GSR against the business's blended rate
 *  (`avgPct`); a scheme clicked on a chart opens its drill-down, which can open it in the Simulator. */
export function OverviewTab({ stats, avgPct, drill, onDrill, drilled, drilledRows, onOpenSimulator }: {
  stats: SchemeStat[];
  avgPct: number;
  drill: string | null;
  onDrill: (key: string | null) => void;
  drilled: SchemePayload | null;
  drilledRows: SlabRow[];
  onOpenSimulator: () => void;
}) {
  if (stats.length === 0) {
    return <p className="hint">No schemes match these filters. Clear the filters to see the whole book.</p>;
  }
  return (
    <>
      <div className="dash-grid">
        <ContributionChart stats={stats} avgPct={avgPct} selected={drill} onSelect={onDrill} />
        <RateBars stats={stats} avgPct={avgPct} selected={drill} onSelect={onDrill} />
      </div>
      {drill && drilled && (
        <SchemeDrilldown scheme={drilled} rows={drilledRows} onClose={() => onDrill(null)} onOpenSimulator={onOpenSimulator} />
      )}
    </>
  );
}
