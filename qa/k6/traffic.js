// One planner session, the same mix every script runs: open the book for a scope, open a scheme, edit a rate,
// move slab boundaries, try a growth target, and now and then reload the reference lists.
import http from 'k6/http';
import { sleep } from 'k6';
import { BASE_URL, GROWTH, SCHEMES, checkOk, params, pick, pickScope } from './config.js';

export function userIteration() {
  const scope = pickScope();
  const all = http.get(`${BASE_URL}/all-slabs${scope ? `?${scope}` : ''}`, params('all-slabs'));
  checkOk(all, 'all-slabs', (b) => b.grand && Array.isArray(b.schemes));
  sleep(1 + Math.random());

  const scheme = pick(SCHEMES);
  const slabs = http.get(`${BASE_URL}/slabs?scheme=${scheme}${scope ? `&${scope}` : ''}`, params('slabs'));
  const ok = checkOk(slabs, 'slabs', (b) => b.key === scheme && Array.isArray(b.rows));
  sleep(1 + Math.random());

  // Edit one rate of the scheme just opened: +0.5 on its first paying row.
  const body = ok ? slabs.json() : null;
  const row = body && body.rows.find((r) => r.cn_rate > 0);
  if (row) {
    const sim = http.post(`${BASE_URL}/simulate`, JSON.stringify({ scheme, overrides: { [row.row_id]: row.cn_rate + 0.5 } }), params('simulate'));
    checkOk(sim, 'simulate', (b) => b.totals && b.totals.delta_cn >= 0);
  }
  sleep(1 + Math.random());

  const moved = http.post(`${BASE_URL}/simulate-slabs`, JSON.stringify({
    scheme: 'luxury', component: 'LUXURY', edges: [40, 100 + Math.floor(Math.random() * 50), 250, 400], rates: [0, 1, 2, 3, 4],
  }), params('simulate-slabs'));
  checkOk(moved, 'simulate-slabs', (b) => Array.isArray(b.rows) && b.totals);
  sleep(1 + Math.random());

  const growth = http.post(`${BASE_URL}/growth`, JSON.stringify({ growth_pct: pick(GROWTH) }), params('growth'));
  checkOk(growth, 'growth', (b) => typeof b.base_cn === 'number' && Array.isArray(b.schemes));
  sleep(1 + Math.random());

  if (Math.random() < 0.2) {
    for (const path of ['/schemes', '/filters', '/reconciliation']) {
      checkOk(http.get(`${BASE_URL}${path}`, params('reference')), path, (b) => b !== null);
    }
  }
}
