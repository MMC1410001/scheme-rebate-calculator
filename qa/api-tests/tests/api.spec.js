// Scheme Performance & Impact Calculator API (backend/app/main.py). Settings are described in helpers.js.
// Cases are numbered SPC_TC_n and tagged @functional, @validation, @edge or @negative (qa/README.md).
// A case that asserts the correct behaviour of a known defect fails until the defect is fixed; the defect id is in
// the title ([SPC-n], qa/TEST_RESULTS.md).
const {
  test, expect, SCHEME_STATUSES, DATE, MONTH, expectRupees, getJson, postJson, expectError, book, percentScheme,
} = require('./helpers');

const SCHEME_KEYS = ['key', 'label', 'status', 'is_currency', 'rows', 'totals'];
const ROW_KEYS = ['component', 'formula', 'pack_size', 'slab_mode', 'slab_index', 'slab_lower', 'slab_upper', 'cn_rate',
  'dealer_count', 'achievement', 'volume', 'gsr', 'cn_units', 'current_cn', 'condonation_amount', 'row_id',
  'simulated_rate', 'simulated_cn', 'delta_cn', 'regions'];
const GRAND_KEYS = ['dealer_count', 'current_cn', 'gift_count', 'gsr', 'volume', 'gsr_is_proxy', 'scheme_count', 'verified_count'];
// Payouts the engine cannot place in a slab are kept in one "Other (unattributed)" row per scheme, so the scheme
// total still reconciles. Those rows carry no units or rate by design.
const attributed = (row) => !row.component.startsWith('Other (unattributed)');

// ===========================================================================
// FUNCTIONAL — SPC_TC_1 to SPC_TC_15
// ===========================================================================
test.describe('Functional @functional', () => {
  test('SPC_TC_1 /schemes lists every scheme once with key, label, type and a known status', async ({ request }) => {
    const schemes = await getJson(request, '/v1/schemes');
    expect(schemes.length).toBeGreaterThan(0);
    for (const s of schemes) {
      expect(Object.keys(s).sort()).toEqual(['key', 'label', 'status', 'type']);
      expect(SCHEME_STATUSES).toContain(s.status);
    }
    expect(new Set(schemes.map((s) => s.key)).size).toBe(schemes.length);
  });

  test('SPC_TC_2 /filters returns sorted zones, regions and depots, and a zone-region-depot hierarchy', async ({ request }) => {
    const f = await getJson(request, '/v1/filters');
    for (const key of ['zones', 'regions', 'depots']) {
      expect(f[key].length, key).toBeGreaterThan(0);
      expect(f[key], `${key} sorted`).toEqual([...f[key]].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    const zoneOf = {};
    for (const h of f.hierarchy) {
      expect(f.zones).toContain(h.zone);
      expect(f.regions).toContain(h.region);
      expect(f.depots).toContain(h.depot_code);
      // A region belongs to exactly one zone, or the Region list cannot narrow to the selected Zone.
      expect(zoneOf[h.region] ?? h.zone, `region ${h.region}`).toBe(h.zone);
      zoneOf[h.region] = h.zone;
    }
  });

  test('SPC_TC_3 /all-slabs returns filters, schemes, grand totals and source for the whole book', async ({ request }) => {
    const all = await getJson(request, '/v1/all-slabs');
    expect(Object.keys(all).sort()).toEqual(['filters', 'grand', 'schemes', 'source']);
    expect(Object.keys(all.grand).sort()).toEqual([...GRAND_KEYS].sort());
    expect(all.grand.scheme_count).toBe(all.schemes.length);
    expect(all.grand.dealer_count).toBeGreaterThan(0);
    expect(all.grand.gsr).toBeGreaterThan(0);
    for (const s of all.schemes) {
      expect(Object.keys(s).sort()).toEqual([...SCHEME_KEYS].sort());
      expect(s.totals.dealer_count, s.key).toBeGreaterThan(0);
    }
    expect(Object.keys(all.schemes[0].rows[0]).sort()).toEqual([...ROW_KEYS].sort());
  });

  test('SPC_TC_4 Schemes in /all-slabs are sorted by payout, largest first', async ({ request }) => {
    const { all } = await book(request);
    const cn = all.schemes.map((s) => s.totals.current_cn);
    expect(cn).toEqual([...cn].sort((a, b) => b - a));
  });

  test('SPC_TC_5 source names the live month, its as-of date and how many days it covers', async ({ request }) => {
    const { source } = (await book(request)).all;
    expect(source.month).toMatch(MONTH);
    expect(source.as_of).toMatch(DATE);
    expect(source.month_days).toBeGreaterThanOrEqual(28);
    expect(source.elapsed_days).toBeGreaterThan(0);
    expect(source.elapsed_days).toBeLessThanOrEqual(source.month_days);
    // A part month must never be presented as settled.
    if (!source.complete) expect(source.elapsed_days).toBeLessThan(source.month_days);
  });

  test('SPC_TC_6 /slabs for one scheme equals that scheme inside /all-slabs', async ({ request }) => {
    const { all } = await book(request);
    for (const s of all.schemes.slice(0, 6)) {
      const one = await getJson(request, '/v1/slabs', { scheme: s.key });
      expect(one.key).toBe(s.key);
      expect(one.rows.length, s.key).toBe(s.rows.length);
      expectRupees(one.totals.current_cn, s.totals.current_cn, `${s.key} current_cn`);
      expect(one.totals.dealer_count, s.key).toBe(s.totals.dealer_count);
    }
  });

  test('SPC_TC_7 /simulate with no overrides changes nothing (delta 0, simulated = current)', async ({ request }) => {
    const scheme = percentScheme((await book(request)).all);
    const sim = await postJson(request, '/v1/simulate', { scheme: scheme.key });
    expect(sim.totals.delta_cn).toBe(0);
    expectRupees(sim.totals.simulated_cn, sim.totals.current_cn, 'simulated vs current');
    for (const r of sim.rows) expectRupees(r.simulated_cn, r.current_cn, r.row_id);
  });

  test('SPC_TC_8 /simulate with one rate doubled pays cn_units x new rate on that row only', async ({ request }) => {
    const scheme = percentScheme((await book(request)).all);
    const row = scheme.rows.find((r) => r.formula === 'percent' && r.cn_rate > 0 && r.cn_units > 0);
    const sim = await postJson(request, '/v1/simulate', { scheme: scheme.key, overrides: { [row.row_id]: row.cn_rate * 2 } });
    for (const r of sim.rows) {
      if (r.row_id === row.row_id) {
        expect(r.simulated_rate).toBe(row.cn_rate * 2);
        expectRupees(r.simulated_cn, row.cn_units * row.cn_rate * 2, 'edited row');
      } else {
        expectRupees(r.simulated_cn, r.current_cn, `untouched ${r.row_id}`);
      }
    }
    expectRupees(sim.totals.delta_cn, row.cn_units * row.cn_rate, 'delta = the extra on the edited row');
  });

  test('SPC_TC_9 /simulate-slabs re-buckets a component into exactly the bands given', async ({ request }) => {
    const edges = [40, 100, 250, 400];
    const rates = [0, 1, 2, 3, 4];
    const res = await postJson(request, '/v1/simulate-slabs', { scheme: 'luxury', component: 'LUXURY', edges, rates });
    expect(res.rows.length).toBeGreaterThan(0);
    const bands = [...new Set(res.rows.map((r) => `${r.slab_lower}-${r.slab_upper}`))];
    for (const band of bands) {
      const [lower, upper] = band.split('-').map(Number);
      expect([0, ...edges], band).toContain(lower);
      if (Number.isFinite(upper) && upper !== 0) expect([...edges, Infinity, null], band).toContain(upper);
    }
    for (const r of res.rows) {
      if (r.formula === 'percent') expectRupees(r.simulated_cn, r.cn_units * r.simulated_rate, `band ${r.slab_index}`);
    }
    expectRupees(res.totals.delta_cn, res.totals.simulated_cn - res.totals.current_cn, 'delta');
  });

  test('SPC_TC_10 /simulate-slabs keeps every dealer: moving boundaries does not change the dealer count', async ({ request }) => {
    const a = await postJson(request, '/v1/simulate-slabs', { scheme: 'luxury', component: 'LUXURY', edges: [40, 100, 250], rates: [0, 1, 2, 3] });
    const b = await postJson(request, '/v1/simulate-slabs', { scheme: 'luxury', component: 'LUXURY', edges: [60, 300, 900], rates: [0, 1, 2, 3] });
    expect(b.totals.dealer_count).toBe(a.totals.dealer_count);
    expectRupees(b.totals.current_cn, a.totals.current_cn, 'actual CN is the same dealers whatever the boundaries');
  });

  test('SPC_TC_11 /growth +10% grows GSR by exactly 10% and never lowers CN', async ({ request }) => {
    const g = await postJson(request, '/v1/growth', { growth_pct: 10 });
    expect(g.default_growth_pct).toBe(10);
    expectRupees(g.grown_gsr, g.base_gsr * 1.1, 'grown GSR');
    expect(g.grown_cn).toBeGreaterThanOrEqual(g.base_cn);
    expect(g.dealers_moved_up).toBeGreaterThan(0);
    expect(g.rates_edited).toBe(false);
    expectRupees(g.delta_cn, g.grown_cn - g.base_cn, 'delta');
  });

  test('SPC_TC_12 /growth per_scheme overrides the default growth for that scheme only', async ({ request }) => {
    const g = await postJson(request, '/v1/growth', { growth_pct: 5, per_scheme: { luxury: 20 } });
    const lux = g.schemes.find((s) => s.scheme === 'luxury');
    expect(lux.growth_pct).toBe(20);
    for (const s of g.schemes.filter((x) => x.scheme !== 'luxury')) expect(s.growth_pct, s.scheme).toBe(5);
  });

  test('SPC_TC_13 /growth rate_multipliers scale the grown payout and flag rates_edited', async ({ request }) => {
    const base = await postJson(request, '/v1/growth', { growth_pct: 5 });
    const edited = await postJson(request, '/v1/growth', { growth_pct: 5, rate_multipliers: { luxury: 1.5 } });
    expect(edited.rates_edited).toBe(true);
    const a = base.schemes.find((s) => s.scheme === 'luxury');
    const b = edited.schemes.find((s) => s.scheme === 'luxury');
    expectRupees(b.grown_cn_at_new_rates, a.grown_cn * 1.5, 'luxury at 1.5x rates');
  });

  test('SPC_TC_14 /reconciliation: one row per scheme, diff % computed from the file total, status follows the 2% rule', async ({ request }) => {
    const rec = await getJson(request, '/v1/reconciliation');
    const { schemes } = await book(request);
    expect(new Set(rec.map((r) => r.scheme))).toEqual(new Set(schemes.map((s) => s.key)));
    for (const r of rec) {
      if (r.raw_total_cn) {
        expect(r.diff_pct, r.scheme).toBeCloseTo((100 * (r.computed_cn - r.raw_total_cn)) / r.raw_total_cn, 1);
      }
      if (r.status === 'ok') expect(Math.abs(r.diff_pct), r.scheme).toBeLessThanOrEqual(2);
      if (r.status === 'needs_review' && r.diff_pct !== null) expect(Math.abs(r.diff_pct), r.scheme).toBeGreaterThan(2);
    }
  });

  test('SPC_TC_15 [SPC-6] /trend returns month-on-month data without a failed month', async ({ request }) => {
    const t = await getJson(request, '/v1/trend');
    expect(Object.keys(t).sort()).toEqual(['excluded', 'forecast_status', 'months', 'partial']);
    const failed = t.months.filter((m) => m.error).map((m) => m.month);
    expect(failed, 'months that could not be read').toEqual([]);
  });
});

// ===========================================================================
// DATA VALIDATION — SPC_TC_16 to SPC_TC_25 (the domain rules of CLAUDE.md)
// ===========================================================================
test.describe('Data Validation @validation', () => {
  test('SPC_TC_16 CN = cn_units x rate on every attributed slab row of every scheme', async ({ request }) => {
    const { all } = await book(request);
    let checked = 0;
    for (const s of all.schemes) {
      for (const r of s.rows.filter(attributed)) {
        expectRupees(r.current_cn, r.cn_units * r.cn_rate, `${s.key} ${r.row_id}`);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  test('SPC_TC_17 An untouched book reproduces what was paid: simulated = current, delta 0, on every row', async ({ request }) => {
    const { all } = await book(request);
    for (const s of all.schemes) {
      expect(s.totals.delta_cn, s.key).toBe(0);
      for (const r of s.rows) expectRupees(r.simulated_cn, r.current_cn, `${s.key} ${r.row_id}`);
    }
  });

  test('SPC_TC_18 Grand CN is the sum of rupee schemes; gifts are counted apart', async ({ request }) => {
    const { all } = await book(request);
    const rupees = all.schemes.filter((s) => s.is_currency).reduce((t, s) => t + s.totals.current_cn, 0);
    const gifts = all.schemes.filter((s) => !s.is_currency).reduce((t, s) => t + s.totals.current_cn, 0);
    expectRupees(all.grand.current_cn, rupees, 'grand CN');
    expect(all.grand.gift_count).toBeCloseTo(gifts, 6);
  });

  test('SPC_TC_19 Zones partition the book: dealers, GSR and CN of the zones add up to All India', async ({ request }) => {
    const { all, filters } = await book(request);
    const sum = { dealer_count: 0, gsr: 0, current_cn: 0 };
    for (const zone of filters.zones) {
      const g = (await getJson(request, '/v1/all-slabs', { zone })).grand;
      sum.dealer_count += g.dealer_count;
      sum.gsr += g.gsr;
      sum.current_cn += g.current_cn;
    }
    expect(sum.dealer_count).toBe(all.grand.dealer_count);
    expectRupees(sum.gsr, all.grand.gsr, 'GSR');
    expectRupees(sum.current_cn, all.grand.current_cn, 'CN');
  });

  test('SPC_TC_20 Every zone has GSR, and a payout rate between 1% and 25% of it (South counted in GSR)', async ({ request }) => {
    const { filters } = await book(request);
    for (const zone of filters.zones) {
      const g = (await getJson(request, '/v1/all-slabs', { zone })).grand;
      expect(g.gsr, `${zone} GSR`).toBeGreaterThan(0);
      const rate = (100 * g.current_cn) / g.gsr;
      expect(rate, `${zone} CN % of GSR`).toBeGreaterThan(1);
      expect(rate, `${zone} CN % of GSR`).toBeLessThan(25);
    }
  });

  test('SPC_TC_21 Slab edges belong to the scheme, not the filter: a zone shows only national edges', async ({ request }) => {
    const { all } = await book(request);
    const scheme = all.schemes.find((s) => s.key === 'luxury') || all.schemes[0];
    // Only published slab tables have edges. "target" rows (per-dealer targets, per-50 L add-ons) show the range of
    // the dealers' own achievement in scope, which rightly differs by filter.
    const slabRows = (rows) => rows.filter((r) => r.slab_mode === 'slab');
    const national = new Set(slabRows(scheme.rows).flatMap((r) => [r.slab_lower, r.slab_upper]));
    const south = await getJson(request, '/v1/slabs', { scheme: scheme.key, zone: 'South' });
    expect(slabRows(south.rows).length).toBeGreaterThan(0);
    for (const r of slabRows(south.rows)) {
      expect(national.has(r.slab_lower), `lower ${r.slab_lower}`).toBe(true);
      expect(national.has(r.slab_upper), `upper ${r.slab_upper}`).toBe(true);
    }
  });

  test('SPC_TC_22 verified_count counts the schemes with status ok', async ({ request }) => {
    const { all } = await book(request);
    expect(all.grand.verified_count).toBe(all.schemes.filter((s) => s.status === 'ok').length);
  });

  test('SPC_TC_23 A region inside a zone never has more dealers, GSR or CN than its zone', async ({ request }) => {
    const { filters } = await book(request);
    const { zone, region } = filters.hierarchy[0];
    const z = (await getJson(request, '/v1/all-slabs', { zone })).grand;
    const r = (await getJson(request, '/v1/all-slabs', { region })).grand;
    expect(r.dealer_count).toBeLessThanOrEqual(z.dealer_count);
    expect(r.gsr).toBeLessThanOrEqual(z.gsr + 1);
    expect(r.current_cn).toBeLessThanOrEqual(z.current_cn + 1);
  });

  test('SPC_TC_24 Scheme status in /schemes matches /reconciliation and /all-slabs', async ({ request }) => {
    const { schemes, all } = await book(request);
    const rec = await getJson(request, '/v1/reconciliation');
    const recStatus = Object.fromEntries(rec.map((r) => [r.scheme, r.status]));
    for (const s of schemes) expect(s.status, s.key).toBe(recStatus[s.key]);
    for (const s of all.schemes) expect(s.status, s.key).toBe(recStatus[s.key]);
  });

  test('SPC_TC_25 Grand GSR is per dealer, not the sum of per-scheme GSR (no double counting)', async ({ request }) => {
    const { all } = await book(request);
    const perSchemeSum = all.schemes.reduce((t, s) => t + (s.totals.gsr || 0), 0);
    expect(all.grand.gsr).toBeLessThan(perSchemeSum);
    // Rs 100 Cr to Rs 2,000 Cr a month: a wide plausibility range for a month's business.
    expect(all.grand.gsr).toBeGreaterThan(1e9);
    expect(all.grand.gsr).toBeLessThan(2e10);
  });
});

// ===========================================================================
// EDGE CASES — SPC_TC_26 to SPC_TC_33
// ===========================================================================
test.describe('Edge Cases @edge', () => {
  test('SPC_TC_26 An unknown region is refused (422) in plain words, before anything is built or cached', async ({ request }) => {
    // Review of 5 Nov 2026: every filtered view is cached by its filters, so made-up values were refused to keep
    // them from pushing the warm views out of the cache. The web app only offers values from /filters.
    const response = await request.get('/v1/all-slabs?region=QA-Nowhere');
    expect(response.status()).toBe(422);
    const { detail } = await response.json();
    expect(detail).toContain('region');
    expect(detail).toContain('not in the current data');
  });

  test('SPC_TC_27 A zone with a region of another zone returns an empty scope', async ({ request }) => {
    const { filters } = await book(request);
    const h = filters.hierarchy.find((x) => x.zone !== filters.hierarchy[0].zone);
    const all = await getJson(request, '/v1/all-slabs', { zone: filters.hierarchy[0].zone, region: h.region });
    expect(all.grand.dealer_count).toBe(0);
  });

  test('SPC_TC_28 Filter order and repeats do not matter (A+B = B+A, A+A = A)', async ({ request }) => {
    const { filters } = await book(request);
    const [a, b] = filters.regions;
    const ab = (await getJson(request, '/v1/all-slabs', { region: [a, b] })).grand;
    const ba = (await getJson(request, '/v1/all-slabs', { region: [b, a] })).grand;
    const aa = (await getJson(request, '/v1/all-slabs', { region: [a, a] })).grand;
    const one = (await getJson(request, '/v1/all-slabs', { region: a })).grand;
    expect(ba).toEqual(ab);
    expect(aa).toEqual(one);
  });

  test('SPC_TC_29 [SPC-1] /growth at 0% costs nothing: grown CN = base CN', async ({ request }) => {
    const g = await postJson(request, '/v1/growth', { growth_pct: 0 });
    expectRupees(g.grown_gsr, g.base_gsr, 'GSR');
    expectRupees(g.grown_cn, g.base_cn, 'CN at 0% growth');
    expect(g.delta_cn).toBeCloseTo(0, 0);
  });

  test('SPC_TC_30 [SPC-2] /growth at -100% answers without a server error', async ({ request }) => {
    const response = await request.post('/v1/growth', { data: { growth_pct: -100 } });
    expect(response.status(), await response.text()).toBeLessThan(500);
  });

  test('SPC_TC_31 /growth at +1000% returns finite numbers', async ({ request }) => {
    const g = await postJson(request, '/v1/growth', { growth_pct: 1000 });
    for (const key of ['grown_cn', 'grown_gsr', 'delta_cn']) expect(Number.isFinite(g[key]), key).toBe(true);
    expectRupees(g.grown_gsr, g.base_gsr * 11, 'GSR x 11');
  });

  test('SPC_TC_32 /simulate ignores an override for a row that does not exist', async ({ request }) => {
    const sim = await postJson(request, '/v1/simulate', { scheme: 'luxury', overrides: { 'QA::9::9': 5 } });
    expect(sim.totals.delta_cn).toBe(0);
  });

  test('SPC_TC_33 /growth with a filter grows only that scope', async ({ request }) => {
    const { filters } = await book(request);
    const zone = filters.zones[0];
    const z = (await getJson(request, '/v1/all-slabs', { zone })).grand;
    const g = await postJson(request, '/v1/growth', { growth_pct: 10, zone });
    expectRupees(g.base_gsr, z.gsr, `${zone} base GSR`);
  });
});

// ===========================================================================
// NEGATIVE — SPC_TC_34 to SPC_TC_43
// ===========================================================================
test.describe('Negative @negative', () => {
  test('SPC_TC_34 /slabs with an unknown scheme returns 404 naming it', async ({ request }) => {
    await expectError(await request.get('/v1/slabs?scheme=qa-nope'), 404, "The scheme 'qa-nope' is not in the current data");
  });

  test('SPC_TC_35 /slabs without a scheme returns 422', async ({ request }) => {
    await expectError(await request.get('/v1/slabs'), 422, 'scheme');
  });

  test('SPC_TC_36 /simulate and /simulate-slabs with an unknown scheme return 404', async ({ request }) => {
    await expectError(await request.post('/v1/simulate', { data: { scheme: 'qa-nope' } }), 404, 'qa-nope');
    await expectError(await request.post('/v1/simulate-slabs', {
      data: { scheme: 'qa-nope', component: 'X', edges: [1], rates: [0, 1] },
    }), 404, 'qa-nope');
  });

  test('SPC_TC_37 A body without required fields, or not JSON, returns 422', async ({ request }) => {
    await expectError(await request.post('/v1/simulate', { data: {} }), 422, 'scheme');
    await expectError(await request.post('/v1/simulate-slabs', { data: { scheme: 'luxury' } }), 422, 'component');
    await expectError(await request.post('/v1/simulate', {
      data: Buffer.from('not json'), headers: { 'Content-Type': 'application/json' },
    }), 422);
  });

  test('SPC_TC_38 Wrong types return 422 (growth_pct as text, rates as text)', async ({ request }) => {
    await expectError(await request.post('/v1/growth', { data: { growth_pct: 'ten' } }), 422, 'growth_pct');
    await expectError(await request.post('/v1/simulate-slabs', {
      data: { scheme: 'luxury', component: 'LUXURY', edges: [40], rates: ['a', 'b'] },
    }), 422, 'rates');
  });

  test('SPC_TC_39 A wrong method returns 405 (GET /simulate, POST /schemes)', async ({ request }) => {
    expect((await request.get('/v1/simulate')).status()).toBe(405);
    expect((await request.post('/v1/schemes', { data: {} })).status()).toBe(405);
  });

  test('SPC_TC_40 [SPC-3] /simulate refuses a negative rate', async ({ request }) => {
    const { all } = await book(request);
    const row = percentScheme(all).rows.find((r) => r.cn_rate > 0);
    const response = await request.post('/v1/simulate', { data: { scheme: percentScheme(all).key, overrides: { [row.row_id]: -5 } } });
    expect(response.status()).toBe(422);
  });

  test('SPC_TC_41 [SPC-4] /simulate-slabs refuses rates that are not one per band (edges + 1)', async ({ request }) => {
    const response = await request.post('/v1/simulate-slabs', {
      data: { scheme: 'luxury', component: 'LUXURY', edges: [40, 100], rates: [0, 1] },
    });
    expect(response.status()).toBe(422);
  });

  test('SPC_TC_42 [SPC-4] /simulate-slabs refuses boundaries that are not ascending', async ({ request }) => {
    const response = await request.post('/v1/simulate-slabs', {
      data: { scheme: 'luxury', component: 'LUXURY', edges: [250, 100, 40], rates: [0, 1, 2, 3] },
    });
    expect(response.status()).toBe(422);
  });

  test('SPC_TC_43 [SPC-5] /simulate-slabs with an unknown component returns 404', async ({ request }) => {
    const response = await request.post('/v1/simulate-slabs', {
      data: { scheme: 'luxury', component: 'QA-NOPE', edges: [40], rates: [0, 1] },
    });
    expect(response.status()).toBe(404);
  });
});

// ===========================================================================
// DEALER LIST AND SLAB EDITING — SPC_TC_44 to SPC_TC_51
// /dealers answers with dealer codes and names (client data): the cases read them but never print them.
// ===========================================================================
test.describe('Dealer list and slab editing @functional', () => {
  const dealers = (request, body) => postJson(request, '/v1/dealers', { page_size: 50, ...body });
  const rowOf = (r) => ({ slab_mode: r.slab_mode, slab_lower: r.slab_lower, slab_upper: r.slab_upper, cn_rate: r.cn_rate, slab_index: r.slab_index });
  /** The served table re-applied as it is, each band its own source (what the web app sends for mixed rate cards). */
  const unchangedLayout = (rows) => {
    const slab = rows.filter((r) => r.slab_mode === 'slab');
    const cuts = [...new Set(slab.flatMap((r) => [r.slab_lower, r.slab_upper]).filter((v) => v != null && v > 0))].sort((a, b) => a - b);
    const bounds = [0, ...cuts];
    return { edges: cuts, sources: bounds.map((lo, i) => [lo, i + 1 < bounds.length ? bounds[i + 1] : null]) };
  };

  test('SPC_TC_44 For every row of Premium and Luxury, the dealer list holds exactly the row\'s dealer count (All India and South)', async ({ request }) => {
    for (const zone of [undefined, 'South']) {
      for (const scheme of ['premium', 'luxury']) {
        const table = await getJson(request, '/v1/slabs', zone ? { scheme, zone } : { scheme });
        for (const r of table.rows) {
          const res = await dealers(request, { scheme, component: r.component, row: rowOf(r), zone, page_size: 1 });
          expect(res.dealers_in_row, `${scheme} ${r.row_id} ${zone ?? 'All India'}`).toBe(r.dealer_count);
        }
      }
    }
  });

  test('SPC_TC_45 Pages of 50: page count, no dealer on two pages, highest achievement first', async ({ request }) => {
    const table = await getJson(request, '/v1/slabs', { scheme: 'premium' });
    const r = [...table.rows].sort((a, b) => b.dealer_count - a.dealer_count)[0];
    const p1 = await dealers(request, { scheme: 'premium', component: r.component, row: rowOf(r), page: 1 });
    const p2 = await dealers(request, { scheme: 'premium', component: r.component, row: rowOf(r), page: 2 });
    expect(p1.pages).toBe(Math.ceil(p1.total / 50));
    expect(p1.rows.length).toBe(Math.min(50, p1.total));
    const codes = new Set(p1.rows.map((d) => d.customer_code));
    for (const d of p2.rows) expect(codes.has(d.customer_code)).toBe(false);
    const ach = [...p1.rows, ...p2.rows].map((d) => d.achievement);
    expect(ach).toEqual([...ach].sort((a, b) => b - a));
  });

  test('SPC_TC_46 Search by dealer code finds the dealer; a search with no match returns none and keeps the row count', async ({ request }) => {
    const table = await getJson(request, '/v1/slabs', { scheme: 'luxury' });
    const r = table.rows.find((x) => x.dealer_count > 5);
    const base = { scheme: 'luxury', component: r.component, row: rowOf(r) };
    const code = (await dealers(request, base)).rows[0].customer_code;
    const hit = await dealers(request, { ...base, q: code });
    expect(hit.rows.map((d) => d.customer_code)).toContain(code);
    const none = await dealers(request, { ...base, q: 'qa-no-such-dealer' });
    expect(none.total).toBe(0);
    expect(none.dealers_in_row).toBe(r.dealer_count);
  });

  test('SPC_TC_47 Next slab = achievement (GSR (Q)) + shortfall; the top slab has no next slab', async ({ request }) => {
    const table = await getJson(request, '/v1/slabs', { scheme: 'early_bird' });
    let checked = 0;
    for (const r of table.rows.filter((x) => x.slab_mode === 'slab').slice(0, 6)) {
      const res = await dealers(request, { scheme: 'early_bird', component: r.component, row: rowOf(r) });
      for (const d of res.rows) {
        if (d.shortfall > 0) expect(d.next_slab, d.customer_code ? 'next slab' : '').toBeCloseTo(d.achievement + d.shortfall, 2);
        else expect(d.next_slab).toBeNull();
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  test('SPC_TC_48 Mixed rate cards at All India: the served table re-applied unchanged moves no money and keeps every dealer', async ({ request }) => {
    const table = await getJson(request, '/v1/slabs', { scheme: 'premium' });
    const rows = table.rows.filter((r) => r.component === 'PREMIUM 01');
    const res = await postJson(request, '/v1/simulate-slabs', { scheme: 'premium', component: 'PREMIUM 01', ...unchangedLayout(rows) });
    expect(Math.abs(res.totals.delta_cn)).toBeLessThan(1);
    expect(res.totals.dealer_count).toBe(rows.reduce((t, r) => t + r.dealer_count, 0));
  });

  test('SPC_TC_49 Moving a boundary up: dealers who fall below it earn the lower band\'s rate, and the lists follow the edited table', async ({ request }) => {
    const table = await getJson(request, '/v1/slabs', { scheme: 'premium' });
    const rows = table.rows.filter((r) => r.component === 'PREMIUM 01');
    const layout = unchangedLayout(rows);
    const moved = { ...layout, edges: [...layout.edges] };
    moved.edges[0] = layout.edges[0] + 20;   // first paying edge up by 20 L
    const res = await postJson(request, '/v1/simulate-slabs', { scheme: 'premium', component: 'PREMIUM 01', ...moved });
    expect(res.totals.delta_cn).toBeLessThan(0);
    const first = res.rows.filter((r) => r.slab_index === 0);
    for (const r of first) expect(r.simulated_rate, 'below the first paying edge').toBe(0);
    for (const r of res.rows) {
      const list = await dealers(request, { scheme: 'premium', component: 'PREMIUM 01', row: rowOf(r), layout: moved, page_size: 1 });
      expect(list.dealers_in_row, r.row_id).toBe(r.dealer_count);
    }
  });

  test('SPC_TC_50 Per-dealer targets: a first boundary changes nothing; a rate edit on one band pays only that band', async ({ request }) => {
    const table = await getJson(request, '/v1/slabs', { scheme: 'premium' });
    const rows = table.rows.filter((r) => r.component === 'Zen Star Per 100 L');
    expect(rows.every((r) => r.slab_mode === 'target')).toBe(true);
    const top = Math.max(...rows.map((r) => r.slab_upper ?? r.slab_lower));
    const layout = { edges: [Math.round(top / 2)], sources: [[0, null], [0, null]] };
    const same = await postJson(request, '/v1/simulate-slabs', { scheme: 'premium', component: 'Zen Star Per 100 L', ...layout });
    expect(Math.abs(same.totals.delta_cn)).toBeLessThan(1);
    const band1 = same.rows.find((r) => r.slab_index === 1 && r.cn_rate > 0);
    const edited = await postJson(request, '/v1/simulate-slabs', {
      scheme: 'premium', component: 'Zen Star Per 100 L', ...layout,
      rate_overrides: [{ band: 1, rate: band1.cn_rate, new_rate: band1.cn_rate * 2 }],
    });
    expectRupees(edited.totals.delta_cn, band1.cn_units * band1.cn_rate, 'the edited band only');
  });

  test('SPC_TC_51 Invalid layouts and dealer requests are refused (422 / 404)', async ({ request }) => {
    const sim = (body) => request.post('/v1/simulate-slabs', { data: { scheme: 'premium', component: 'PREMIUM 01', ...body } });
    await expectError(await sim({ edges: [40] }), 422, 'rates');
    await expectError(await sim({ edges: [40], sources: [[0, 40]] }), 422, 'sources');
    await expectError(await sim({ edges: [40], sources: [[0, 40], [40, null]], rate_overrides: [{ band: 5, rate: 1, new_rate: 2 }] }), 422, 'band');
    await expectError(await sim({ edges: [40], sources: [[0, 40], [40, null]], rate_overrides: [{ band: 1, rate: 1, new_rate: -1 }] }), 422);
    const row = { slab_mode: 'slab', slab_lower: 0, slab_upper: 40, cn_rate: 0, slab_index: 0 };
    await expectError(await request.post('/v1/dealers', { data: { scheme: 'premium', component: 'PREMIUM 01', row, page_size: 500 } }), 422, 'page_size');
    await expectError(await request.post('/v1/dealers', { data: { scheme: 'premium', component: 'QA-NOPE', row } }), 404, 'QA-NOPE');
  });
});

// ===========================================================================
// EXPORT AND TWO USERS — SPC_TC_52, SPC_TC_53
// ===========================================================================
test.describe('Export and isolation @functional', () => {
  test('SPC_TC_52 /export returns an Excel workbook named after the month and scope', async ({ request }) => {
    const { all } = await book(request);
    const s = percentScheme(all);
    const rows = s.rows.map((r) => ({ ...r, simulated_rate: r.cn_rate, simulated_cn: r.current_cn }));
    rows[0] = { ...rows[0], simulated_rate: rows[0].cn_rate + 1, simulated_cn: rows[0].current_cn + 1000 };
    const response = await request.post('/v1/export', { data: {
      scope_label: 'All India', moved: [],
      schemes: [{ key: s.key, label: s.label, status: s.status, is_currency: true, dealer_count: s.totals.dealer_count,
                  volume: s.totals.volume, gsr: s.totals.gsr, rows }],
    } });
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('spreadsheetml');
    expect(response.headers()['content-disposition']).toContain(`scheme-performance_${all.source.month}_All-India.xlsx`);
    const body = await response.body();
    expect(body.subarray(0, 2).toString()).toBe('PK');   // an .xlsx is a zip
    // Three worksheets (sheet1-3). Their names and cells are checked by opening a real export (qa/TEST_RESULTS.md).
    const text = body.toString('latin1');
    for (const n of [1, 2, 3]) expect(text).toContain(`xl/worksheets/sheet${n}.xml`);
    expect(body.length).toBeGreaterThan(4000);
  });

  test('SPC_TC_53 Two users editing at once each get their own answer, and the served table never changes', async ({ request }) => {
    const { all } = await book(request);
    const s = percentScheme(all);
    const row = s.rows.find((r) => r.formula === 'percent' && r.cn_rate > 0 && r.cn_units > 0);
    const [a, b] = await Promise.all([
      postJson(request, '/v1/simulate', { scheme: s.key, overrides: { [row.row_id]: row.cn_rate * 2 } }),
      postJson(request, '/v1/simulate', { scheme: s.key, overrides: { [row.row_id]: 0 } }),
    ]);
    expectRupees(a.totals.delta_cn, row.cn_units * row.cn_rate, 'user A: rate doubled');
    expectRupees(b.totals.delta_cn, -row.cn_units * row.cn_rate, 'user B: rate set to 0');
    const after = await getJson(request, '/v1/slabs', { scheme: s.key });
    expect(after.totals.delta_cn).toBe(0);
    expectRupees(after.totals.current_cn, s.totals.current_cn, 'served table unchanged');
  });
});

// ===========================================================================
// PREVIOUS · CURRENT · NEXT MONTH — SPC_TC_54 to SPC_TC_61
// ===========================================================================
test.describe('Month view @functional', () => {
  const luxuryEdit = async (request) => {
    // Luxury's 0.75% rows doubled, as the web app sends it (every boundary, each band its own source).
    const lux = await getJson(request, '/v1/slabs', { scheme: 'luxury' });
    const rows = lux.rows.filter((r) => r.component === 'LUXURY' && r.slab_mode === 'slab');
    const cuts = [...new Set(rows.flatMap((r) => [r.slab_lower, r.slab_upper]).filter((v) => v != null && v > 0))].sort((a, b) => a - b);
    const bounds = [0, ...cuts];
    return { 'luxury::LUXURY': {
      edges: cuts,
      sources: bounds.map((lo, i) => [lo, i + 1 < bounds.length ? bounds[i + 1] : null]),
      rate_overrides: bounds.map((lo, band) => ({ lo, band })).filter(({ lo }) => lo >= 40 && lo < 100)
        .map(({ band }) => ({ band, rate: 0.75, new_rate: 1.5 })),
    } };
  };

  test('SPC_TC_54 /months: current month equals the dashboard; categories add up to the total; mix adds to 100%', async ({ request }) => {
    const { all } = await book(request);
    const m = await getJson(request, '/v1/months');
    expect(m.current.month).toBe(all.source.month);
    expectRupees(m.current.total.gsr, all.grand.gsr, 'GSR');
    expectRupees(m.current.total.cn, all.grand.current_cn, 'CN');
    expect(m.current.total.dealers).toBe(all.grand.dealer_count);
    for (const block of [m.previous, m.current].filter(Boolean)) {
      expectRupees(block.rows.reduce((t, r) => t + r.cn, 0), block.total.cn, `${block.month} CN by category`);
      const mix = block.rows.reduce((t, r) => t + (r.mix_pct ?? 0), 0);
      expect(mix, `${block.month} mix`).toBeCloseTo(100, 6);
    }
    if (m.previous) expect(m.previous.month < m.current.month).toBe(true);
  });

  // No pace by days elapsed since 4 Nov 2026 (user's choice): next month = the current month as shown x (1 + V).
  test('SPC_TC_55 /months/next with no edits: zero impact; GSR = current month x (1 + V)', async ({ request }) => {
    const { all } = await book(request);
    for (const v of [0, 10]) {
      const n = await postJson(request, '/v1/months/next', { volume_growth_pct: v });
      expect(n.factor).toBeCloseTo(1 + v / 100, 5);
      expect(n.pace_factor).toBeCloseTo(1, 9);
      expectRupees(n.total.gsr, all.grand.gsr * n.factor, `GSR at ${v}%`);
      for (const r of n.rows) expect(Math.abs(r.simulated_cn - r.cn), `${r.category} impact at ${v}%`).toBeLessThan(1);
    }
  });

  test('SPC_TC_56 /months/next with a Luxury rate edit: impact in Luxury only, and positive', async ({ request }) => {
    const n = await postJson(request, '/v1/months/next', { volume_growth_pct: 0, layouts: await luxuryEdit(request) });
    expect(n.edited).toBe(true);
    for (const r of n.rows) {
      const impact = r.simulated_cn - r.cn;
      if (r.category === 'Luxury') expect(impact).toBeGreaterThan(0);
      else expect(Math.abs(impact), r.category).toBeLessThan(1);
    }
  });

  test('SPC_TC_57 /months/scheme: previous and next slab tables; next keeps every dealer; slab mix adds to 100%', async ({ request }) => {
    const res = await postJson(request, '/v1/months/scheme', { scheme: 'premium', volume_growth_pct: 0 });
    const cur = await getJson(request, '/v1/slabs', { scheme: 'premium' });
    const comp = cur.rows.filter((r) => r.component === 'PREMIUM 01');
    const next = res.next.components['PREMIUM 01'];
    expect(next.rows.reduce((t, r) => t + r.dealers, 0)).toBe(comp.reduce((t, r) => t + r.dealer_count, 0));
    expect(next.rows.reduce((t, r) => t + (r.mix_pct ?? 0), 0)).toBeCloseTo(100, 6);
    expect(next.rows.some((r) => r.slab_mode === 'unrated')).toBe(false);
    expect(Math.abs(next.impact)).toBeLessThan(1);
    if (res.previous) {
      for (const [name, rows] of Object.entries(res.previous.components)) {
        expect(rows.reduce((t, r) => t + (r.mix_pct ?? 0), 0), name).toBeCloseTo(rows.some((r) => r.volume) ? 100 : 0, 6);
      }
    }
  });

  test('SPC_TC_58 Month view refuses a volume change of -100% or less, and an unknown scheme', async ({ request }) => {
    await expectError(await request.post('/v1/months/next', { data: { volume_growth_pct: -100 } }), 422, 'volume_growth_pct');
    await expectError(await request.post('/v1/months/scheme', { data: { scheme: 'qa-nope' } }), 404, 'qa-nope');
  });

  test('SPC_TC_59 Scheme rows under each product: every scheme once; CN adds to the product; own schemes add to its volume', async ({ request }) => {
    const m = await getJson(request, '/v1/months');
    const n = await postJson(request, '/v1/months/next', { volume_growth_pct: 0 });
    for (const block of [m.previous, m.current, n].filter(Boolean)) {
      for (const r of block.rows) {
        expect(r.scheme_rows.map((s) => s.scheme), `${block.month} ${r.category}`).toEqual(r.schemes);
        expectRupees(r.scheme_rows.reduce((t, s) => t + s.cn, 0), r.cn, `${block.month} ${r.category} CN`);
        if (r.volume != null) {
          const own = r.scheme_rows.filter((s) => s.counts).reduce((t, s) => t + (s.volume ?? 0), 0);
          expect(own, `${block.month} ${r.category} volume`).toBeCloseTo(r.volume, 3);
        }
      }
    }
  });

  // The month table's dealer counts open the same list the scheme editor does, for that month.
  const dealersOf = (scheme, component, r, extra) => ({
    scheme, component, page_size: 1, ...extra,
    row: { slab_mode: r.slab_mode, slab_lower: r.slab_lower, slab_upper: r.slab_upper, cn_rate: r.cn_rate, slab_index: r.slab_index },
  });

  test('SPC_TC_60 /dealers month=previous and month=next: the list equals every slab row\'s dealer count', async ({ request }) => {
    const v = 10;
    for (const scheme of ['premium', 'luxury']) {
      const res = await postJson(request, '/v1/months/scheme', { scheme, volume_growth_pct: v });
      const tables = [
        ...Object.entries(res.previous?.components ?? {}).map(([c, rows]) => ['previous', c, rows]),
        ...Object.entries(res.next.components).map(([c, x]) => ['next', c, x.rows]),
      ];
      expect(tables.length).toBeGreaterThan(0);
      for (const [month, component, rows] of tables) {
        for (const r of rows) {
          const d = await postJson(request, '/v1/dealers', dealersOf(scheme, component, r, { month, volume_growth_pct: v }));
          expect(d.dealers_in_row, `${month} ${scheme} / ${component} / ${r.slab_lower}-${r.slab_upper} @ ${r.cn_rate}`).toBe(r.dealers);
        }
      }
    }
  });

  test('SPC_TC_61 /dealers month=next follows the edited structure; an unknown month is refused', async ({ request }) => {
    const layouts = await luxuryEdit(request);
    const res = await postJson(request, '/v1/months/scheme', { scheme: 'luxury', volume_growth_pct: 0, layouts });
    for (const r of res.next.components.LUXURY.rows) {
      const d = await postJson(request, '/v1/dealers', dealersOf('luxury', 'LUXURY', r, { month: 'next', layout: layouts['luxury::LUXURY'] }));
      expect(d.dealers_in_row).toBe(r.dealers);
    }
    const bad = await request.post('/v1/dealers', { data: dealersOf('luxury', 'LUXURY', res.next.components.LUXURY.rows[0], { month: 'later' }) });
    await expectError(bad, 422, 'month');
  });
  test('SPC_TC_62 /months/next with a deleted scheme: it pays nothing next month; volume, GSR and every other scheme stay', async ({ request }) => {
    const base = await postJson(request, '/v1/months/next', { volume_growth_pct: 0 });
    const n = await postJson(request, '/v1/months/next', { volume_growth_pct: 0, removed_schemes: ['luxury'] });
    expect(n.edited).toBe(true);
    const lux = (block) => block.rows.flatMap((r) => r.scheme_rows).find((s) => s.scheme === 'luxury');
    expect(lux(n).simulated_cn).toBe(0);
    expectRupees(n.total.simulated_cn, base.total.simulated_cn - lux(base).simulated_cn, 'total CN');
    expect(n.total.gsr).toBe(base.total.gsr);
    expect(n.total.volume).toBe(base.total.volume);
    for (const r of n.rows) {
      const b = base.rows.find((x) => x.category === r.category);
      const own = r.scheme_rows.find((s) => s.scheme === 'luxury');
      expectRupees(r.simulated_cn, b.simulated_cn - (own ? lux(base).simulated_cn : 0), r.category);
    }
    await expectError(await request.post('/v1/months/next', { data: { removed_schemes: 'luxury' } }), 422, 'removed_schemes');
  });
});

test.describe('Removing a slab @functional', () => {
  /** The served table as the web app sends it: every boundary, each band its own source. */
  const fullLayout = (rows) => {
    const slab = rows.filter((r) => r.slab_mode === 'slab');
    const cuts = [...new Set(slab.flatMap((r) => [r.slab_lower, r.slab_upper]).filter((v) => v != null && v > 0))].sort((a, b) => a - b);
    const bounds = [0, ...cuts];
    return { edges: cuts, sources: bounds.map((lo, i) => [lo, i + 1 < bounds.length ? bounds[i + 1] : null]) };
  };

  test('SPC_TC_63 Removing a slab drops its dealers to the slab below: no dealer lost, rates from the lower slab, CN not higher', async ({ request }) => {
    const table = await getJson(request, '/v1/slabs', { scheme: 'luxury' });
    const rows = table.rows.filter((r) => r.component === 'LUXURY');
    const layout = fullLayout(rows);
    // Remove the band that starts at edges[1]: its lower edge goes, and the merged band keeps the lower band's source.
    const lower = layout.sources[1];
    const removed = { edges: layout.edges.filter((_, i) => i !== 1), sources: layout.sources.filter((_, i) => i !== 2) };
    const res = await postJson(request, '/v1/simulate-slabs', { scheme: 'luxury', component: 'LUXURY', ...removed });
    const count = (rs) => rs.reduce((t, r) => t + r.dealer_count, 0);
    expect(count(res.rows)).toBe(count(rows));
    expect(res.totals.delta_cn).toBeLessThanOrEqual(0);
    const lowerRates = new Set([0, ...rows.filter((r) => r.slab_mode === 'slab' && r.slab_lower < lower[1] && (r.slab_upper ?? Infinity) > lower[0]).map((r) => r.cn_rate)]);
    const merged = res.rows.filter((r) => r.slab_mode === 'slab' && r.slab_lower === lower[0]);
    expect(merged.length).toBeGreaterThan(0);
    for (const r of merged) {
      expect(r.slab_upper, 'merged band ends where the removed one ended').toBe(layout.edges[2]);
      expect(lowerRates.has(r.simulated_rate), `rate ${r.simulated_rate} is one of the lower slab's`).toBe(true);
    }
  });

  test('SPC_TC_64 Removing the first slab: there is no slab below, so it pays nothing and the other slabs do not move', async ({ request }) => {
    const table = await getJson(request, '/v1/slabs', { scheme: 'stainers' });
    const rows = table.rows.filter((r) => r.component === 'STAINERS');
    const first = rows.filter((r) => r.slab_mode === 'slab' && r.slab_lower <= 0);
    expect(first.every((r) => r.cn_rate > 0), 'the first slab pays today').toBe(true);
    const layout = fullLayout(rows);
    const res = await postJson(request, '/v1/simulate-slabs', {
      scheme: 'stainers', component: 'STAINERS', ...layout,
      rate_overrides: [...new Set(first.map((r) => r.cn_rate))].map((rate) => ({ band: 0, rate, new_rate: 0 })),
    });
    for (const r of res.rows.filter((r) => r.slab_index === 0)) expect(r.simulated_cn).toBe(0);
    const others = (rs, cn) => rs.filter((r) => r.slab_mode === 'slab' && r.slab_lower > 0).reduce((t, r) => t + r[cn], 0);
    expectRupees(others(res.rows, 'simulated_cn'), others(rows, 'current_cn'), 'other slabs');
    expectRupees(res.totals.delta_cn, -first.reduce((t, r) => t + r.current_cn, 0), 'impact = the first slab\'s CN');
  });
});


// ===========================================================================
// WHAT-IF EDITS AND VERSIONS — SPC_TC_65 to SPC_TC_72 (backend app/core/scenario.py)
// GSR / volume typed into the month table travel as `adjustments` (current month) and `next_adjustments`. Nothing
// here saves, so the suite writes nothing to a shared database; saving is checked by hand (qa/TEST_CASES.md, 5e).
// ===========================================================================
test.describe('What-if edits @functional', () => {
  const base = { name: 'qa', volume_growth_pct: 0, adjustments: [], next_adjustments: [], layouts: {}, removed_schemes: [] };
  const edit = (over) => ({ scope_kind: 'all', scope_value: '', product: '*', metric: 'gsr', mode: 'B', adjust_type: 'pct', value: 10, ...over });
  const cat = (block, name) => block.rows.find((r) => r.category === name);

  test('SPC_TC_65 /saved-versions/meta lists the products that can be edited and the months a version covers', async ({ request }) => {
    const meta = await getJson(request, '/v1/saved-versions/meta');
    expect(meta.products.length).toBeGreaterThan(5);
    expect(meta.products).toContain('Luxury');
    expect(meta.live_month).toMatch(MONTH);
    expect(meta.next_month).toMatch(MONTH);
    expect(typeof meta.can_save).toBe('boolean');
  });

  test('SPC_TC_66 No edit reproduces the actual month: preview equals actual, adjusted slabs equal /all-slabs', async ({ request }) => {
    const r = await postJson(request, '/v1/saved-versions/preview', base);
    for (const month of ['current', 'next']) {
      expectRupees(r[month].totals.version_gsr, r[month].totals.actual_gsr, `${month} GSR`);
      expectRupees(r[month].totals.version_cn, r[month].totals.actual_cn, `${month} CN`);
      expect(r[month].totals.dealers_moved).toBe(0);
    }
    const plain = await getJson(request, '/v1/all-slabs');
    const adjusted = await postJson(request, '/v1/all-slabs/adjusted', { adjustments: [] });
    expect(adjusted.grand).toEqual(plain.grand);
  });

  test('SPC_TC_67 An edit made for one region shows in All India, and an All India edit in the region', async ({ request }) => {
    const { regions } = await getJson(request, '/v1/filters');
    const actual = await getJson(request, '/v1/months');
    const actualRegion = await getJson(request, '/v1/months', { region: regions[0] });
    const regional = [edit({ scope_kind: 'region', scope_value: regions[0] })];
    const india = await postJson(request, '/v1/months', { adjustments: regional });
    const region = await postJson(request, '/v1/months', { region: [regions[0]], adjustments: regional });
    const added = region.current.total.gsr - actualRegion.current.total.gsr;
    expect(added).toBeGreaterThan(0);
    expectRupees(india.current.total.gsr - actual.current.total.gsr, added, 'All India moves by the region\'s change');
    const all = await postJson(request, '/v1/months', { region: [regions[0]], adjustments: [edit()] });
    expectRupees(all.current.total.gsr, actualRegion.current.total.gsr * 1.1, 'All India +10% inside the region');
  });

  test('SPC_TC_68 Each cell: product GSR moves only that product; Mix holds the total and lands on its target', async ({ request }) => {
    const actual = await getJson(request, '/v1/months');
    const p = await postJson(request, '/v1/months', { adjustments: [edit({ mode: 'P', product: 'Luxury' })] });
    expectRupees(cat(p.current, 'Luxury').gsr, cat(actual.current, 'Luxury').gsr * 1.1, 'Luxury +10%');
    expectRupees(cat(p.current, 'Premium').gsr, cat(actual.current, 'Premium').gsr, 'Premium unchanged');
    const target = Math.round(cat(actual.current, 'Luxury').mix_pct + 1);
    const a = await postJson(request, '/v1/months', { adjustments: [edit({ mode: 'A', product: 'Luxury', metric: 'volume', adjust_type: 'share', value: target })] });
    expectRupees(a.current.total.gsr, actual.current.total.gsr, 'total GSR held');
    expect(Math.abs(cat(a.current, 'Luxury').mix_pct - target)).toBeLessThan(0.01);
    const slabs = await postJson(request, '/v1/all-slabs/adjusted', { adjustments: [edit({ mode: 'P', product: 'Luxury' })] });
    const plain = await getJson(request, '/v1/all-slabs');
    const premium = (v) => v.schemes.find((x) => x.key === 'premium').totals;
    expectRupees(premium(slabs).simulated_cn, premium(plain).current_cn, 'Premium CN unchanged by a Luxury edit');
  });

  test('SPC_TC_69 Under edits a slab row\'s dealer list equals its dealer count', async ({ request }) => {
    const adjustments = [edit()];
    const view = await postJson(request, '/v1/all-slabs/adjusted', { adjustments });
    const row = view.schemes.find((x) => x.key === 'luxury').rows.find((r) => r.slab_mode === 'slab' && r.dealer_count > 0);
    const res = await postJson(request, '/v1/dealers', {
      scheme: 'luxury', component: row.component, adjustments,
      row: { slab_mode: row.slab_mode, slab_lower: row.slab_lower, slab_upper: row.slab_upper, cn_rate: row.cn_rate, slab_index: row.slab_index },
    });
    expect(res.dealers_in_row).toBe(row.dealer_count);
  });

  test('SPC_TC_70 Next month starts from the edited current month, then adds its own edits', async ({ request }) => {
    const plain = await postJson(request, '/v1/months/next', { volume_growth_pct: 0 });
    const inherited = await postJson(request, '/v1/months/next', { volume_growth_pct: 0, adjustments: [edit()] });
    expectRupees(inherited.total.gsr, plain.total.gsr * 1.1, 'current +10% carried into next');
    const own = await postJson(request, '/v1/months/next', { volume_growth_pct: 0, adjustments: [edit()],
      next_adjustments: [edit({ mode: 'P', product: 'Luxury', value: 20 })] });
    expectRupees(cat(own, 'Luxury').gsr, cat(inherited, 'Luxury').gsr * 1.2, 'next month\'s own Luxury +20%');
    expect(own.edited).toBe(true);
  });

  test('SPC_TC_71 /saved-versions/preview returns both months with the edits applied', async ({ request }) => {
    const r = await postJson(request, '/v1/saved-versions/preview', { ...base, adjustments: [edit()] });
    for (const month of ['current', 'next']) {
      expect(r[month].month).toMatch(MONTH);
      expect(r[month].totals.version_gsr).toBeGreaterThan(r[month].totals.actual_gsr);
      expect(r[month].totals.dealers_moved).toBeGreaterThan(0);
    }
  });

  test('SPC_TC_73 A product\'s GSR as a price change: same litres, GSR on the figure; CN % scales its rates exactly', async ({ request }) => {
    const actual = await getJson(request, '/v1/months');
    const lux = cat(actual.current, 'Luxury');
    const price = await postJson(request, '/v1/months', { adjustments: [edit({ mode: 'Q', product: 'Luxury' })] });
    expectRupees(cat(price.current, 'Luxury').volume, lux.volume, 'litres unchanged');
    expectRupees(cat(price.current, 'Luxury').gsr, lux.gsr * 1.1, 'GSR +10%');
    const plan = (adjustments) => postJson(request, '/v1/months/next', { volume_growth_pct: 0, adjustments });
    const before = cat(await plan([]), 'Luxury');
    const after = cat(await plan([edit({ mode: 'R', product: 'Luxury', value: 25 })]), 'Luxury');
    expectRupees(after.simulated_cn, before.simulated_cn * 1.25, 'Luxury CN x1.25');
    expectRupees(after.gsr, before.gsr, 'GSR unchanged by a CN % edit');
  });

  test('SPC_TC_72 Edit input is refused with its reason @negative', async ({ request }) => {
    const post = (adjustments) => request.post('/v1/months', { data: { adjustments } });
    await expectError(await post([edit({ scope_kind: 'region', scope_value: 'X', adjust_type: 'delta' })]), 422, 'one dealer');
    await expectError(await post([edit({ mode: 'P' })]), 422, 'needs one product');
    await expectError(await post([edit({ product: 'Luxury' })]), 422, 'every product');
    await expectError(await post([edit({ mode: 'S', product: '*' })]), 422, 'needs the scheme');
    await expectError(await post([edit({ mode: 'A', product: 'Luxury', adjust_type: 'share', value: 120 })]), 422, 'between 0 and 100');
    await expectError(await post([edit({ value: -100 })]), 422, 'nothing to sell');
    await expectError(await post([edit({ mode: 'X' })]), 422);
    await expectError(await post([edit({ mode: 'R', product: 'Luxury', adjust_type: 'share', value: 5 })]), 422, 'stored as a %');
    await expectError(await request.post('/v1/saved-versions/preview', { data: { ...base, adjustments: [edit(), edit()] } }), 422, 'edited twice');
    await expectError(await request.post('/v1/saved-versions/preview', { data: { ...base, layouts: { 'luxury::NOPE': { edges: [], sources: [[0, null]] } } } }), 404, 'no component');
  });

  test('SPC_TC_74 /gifts: gift schemes per month, apart from CN; counts are whole gifts, no dealer identity', async ({ request }) => {
    const gifts = await getJson(request, '/v1/gifts');
    const { all } = await book(request);
    expect(gifts.current.month).toBe(all.source.month);
    for (const block of [gifts.previous, gifts.current].filter(Boolean)) {
      expect(block.month).toMatch(MONTH);
      if (block.schemes.length) expect(block.as_of).toMatch(DATE);
      for (const r of block.schemes) {
        expect(['gifts', 'rupees']).toContain(r.unit);
        if (r.unit === 'gifts') expect(Number.isInteger(r.earned), r.scheme).toBe(true);
        // Kept apart from CN: no gift scheme is a scheme of the CN book.
        expect(all.schemes.map((s) => s.label.toUpperCase())).not.toContain(r.scheme.toUpperCase());
      }
    }
    const text = JSON.stringify(gifts);
    for (const key of ['customer_code', 'customer_name']) expect(text, key).not.toContain(`"${key}"`);
    const none = await request.get('/v1/gifts?region=NO_SUCH_REGION');
    expect(none.status()).toBe(422);   // an unknown region is refused, as in SPC_TC_26
  });

  test('SPC_TC_75 A version name is unique: blank refused, a used name refused in any case @negative', async ({ request }) => {
    // Writes nothing: both requests are refused before anything is saved.
    const meta = await getJson(request, '/v1/saved-versions/meta');
    test.skip(!meta.can_save, 'saving needs the database');
    await expectError(await request.post('/v1/saved-versions', { data: { name: '   ' } }), 422, 'needs a name');
    const { versions } = await getJson(request, '/v1/saved-versions');
    test.skip(versions.length === 0, 'no saved version to reuse the name of');
    const used = ` ${versions[0].name.toUpperCase()} `;
    await expectError(await request.post('/v1/saved-versions', { data: { name: used } }), 409, 'already exists');
  });

  test('SPC_TC_76 /months/edited answers the current and next month (it once failed every call with a 500)', async ({ request }) => {
    const out = await postJson(request, '/v1/months/edited', { current: {}, next: {} });
    expect(out.current.rows.length).toBeGreaterThan(0);
    expect(out.next.month).toMatch(/^\d{4}-\d{2}$/);
    expect(out.next.edited).toBe(true);
  });

  // QA run of 5 Nov 2026: defects found and fixed the same day.
  const raw = (request, path, body) => request.post(path, { data: body, headers: { 'Content-Type': 'application/json' } });

  test('SPC_TC_77 NaN, Infinity and overflowing numbers are refused (422) in plain words, never a 500 @negative', async ({ request }) => {
    for (const [path, body] of [
      ['/v1/growth', '{"growth_pct": NaN}'], ['/v1/growth', '{"growth_pct": Infinity}'], ['/v1/growth', '{"growth_pct": 1e300}'],
      ['/v1/months/next', '{"volume_growth_pct": NaN}'],
      ['/v1/simulate', '{"scheme": "luxury", "overrides": {"x": NaN}}'],
    ]) {
      const response = await raw(request, path, body);
      expect(response.status(), `${path} ${body}`).toBe(422);
      const { detail } = await response.json();
      expect(typeof detail).toBe('string');
      expect(detail).toContain('This request was refused');
    }
  });

  test('SPC_TC_78 A slab boundary of NaN is refused, not priced into a wrong total @negative', async ({ request }) => {
    const response = await raw(request, '/v1/simulate-slabs',
      '{"scheme": "luxury", "component": "x", "edges": [NaN, 5], "sources": [[0, 1], [1, 2], [2, null]]}');
    expect(response.status()).toBe(422);
  });

  test('SPC_TC_79 A filter value with spaces around it is the same filter @edge', async ({ request }) => {
    const { filters } = await book(request);
    const region = filters.regions[0];
    const plain = await getJson(request, `/v1/all-slabs?region=${encodeURIComponent(region)}`);
    const padded = await postJson(request, '/v1/all-slabs/adjusted', { region: [` ${region} `, region] });
    expect(padded.grand.dealer_count).toBe(plain.grand.dealer_count);
    expect(padded.grand.dealer_count).toBeGreaterThan(0);
  });

  test('SPC_TC_80 Export with an open lower bound builds the workbook (it was a 500) @edge', async ({ request }) => {
    const response = await request.post('/v1/export', { data: { schemes: [{ key: 'k', label: 'K', rows: [
      { component: 'c', formula: 'percent', slab_mode: 'band', slab_lower: null, slab_upper: 10 }] }] } });
    expect(response.status()).toBe(200);
  });
});
