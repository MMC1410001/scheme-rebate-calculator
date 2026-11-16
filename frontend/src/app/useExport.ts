import { useState } from "react";
import type { AllSlabsResponse } from "../api/client";
import { api, errorText } from "../api/client";
import type { RowsByScheme, ScopeSel } from "./constants";

/** Download the view as Excel: the scope, every scheme and every slab row as on screen, with this user's edits.
 *  Edits exist only in this browser, so the rows are sent with the request; the server builds the file and keeps
 *  nothing, so another user's export (or screen) never sees them. */
export function useExport(data: AllSlabsResponse | null, simRows: RowsByScheme, movedSlabs: Set<string>,
                          scope: ScopeSel, scopeLabel: string, setError: (text: string | null) => void) {
  const [exporting, setExporting] = useState(false);
  const exportView = () => {
    if (!data) return;
    setExporting(true);
    api
      .exportXlsx({
        scope_label: scopeLabel,
        zone: scope.zone, region: scope.region, depot_code: scope.depot,
        moved: [...movedSlabs],
        schemes: data.schemes.map((s) => ({
          key: s.key, label: s.label, status: s.status, is_currency: s.is_currency,
          dealer_count: s.totals.dealer_count, volume: s.totals.volume ?? 0, gsr: s.totals.gsr ?? 0,
          rows: (simRows[s.key] ?? []).map((r) => ({
            component: r.component, formula: r.formula, slab_mode: r.slab_mode,
            slab_lower: r.slab_lower, slab_upper: r.slab_upper, dealer_count: r.dealer_count,
            volume: r.volume ?? 0, gsr: r.gsr ?? 0, cn_rate: r.cn_rate,
            simulated_rate: r.simulated_rate ?? r.cn_rate, current_cn: r.current_cn,
            simulated_cn: r.simulated_cn ?? r.current_cn, regions: r.regions ?? [],
          })),
        })),
      })
      .then(({ blob, name }) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        // Freed a minute later: freeing it at once can cancel the download in Safari and Firefox.
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setExporting(false));
  };
  return { exporting, exportView };
}
