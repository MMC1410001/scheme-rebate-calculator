// Shared settings and helpers for the API suites. Nothing secret lives here.
//
// Env:
//   API_BASE_URL   default http://127.0.0.1:8010 (the backend's local port; the cases add /v1 to business routes)
//   UI_ORIGIN      the web app's origin that CORS must allow (default http://localhost:5173)
//
// The API serves aggregates only (zone / region / depot / scheme / slab). No test reads or prints a dealer code or
// name: those are client data.
const { test, expect } = require('@playwright/test');

const UI_ORIGIN = process.env.UI_ORIGIN || 'http://localhost:5173';
const SCHEME_STATUSES = ['ok', 'needs_review', 'no_data', 'qualifier', 'unknown'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

/** Rupee comparison: equal within Rs 1 or 0.0001% of the larger value, whichever is bigger (float sums). */
function expectRupees(actual, expected, label = '') {
  const tolerance = Math.max(1, Math.abs(expected) * 1e-6);
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);
}

/** Query string with repeated keys: {region: ['A', 'B']} -> region=A&region=B. */
function qs(params = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    for (const v of [].concat(value)) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

async function getJson(request, path, params) {
  const response = await request.get(`${path}${qs(params)}`);
  expect(response.status(), `GET ${path}${qs(params)}`).toBe(200);
  return response.json();
}

async function postJson(request, path, body) {
  const response = await request.post(path, { data: body });
  expect(response.status(), `POST ${path} ${JSON.stringify(body)}`).toBe(200);
  return response.json();
}

/** FastAPI error body: {"detail": "..."} for 404, {"detail": [{loc, msg, type}]} for 422. */
async function expectError(response, status, detailIncludes) {
  expect(response.status()).toBe(status);
  const body = await response.json();
  expect(body).toHaveProperty('detail');
  if (detailIncludes) expect(JSON.stringify(body.detail)).toContain(detailIncludes);
  return body;
}

// The whole book and the filter lists are read by many cases; fetch them once per worker.
let cache = null;
async function book(request) {
  if (!cache) {
    const [schemes, filters, all] = await Promise.all([
      getJson(request, '/v1/schemes'), getJson(request, '/v1/filters'), getJson(request, '/v1/all-slabs'),
    ]);
    cache = { schemes, filters, all };
  }
  return cache;
}

/** A scheme with slab rows that pay a percentage, used where a case needs one concrete scheme. */
function percentScheme(all) {
  return all.schemes.find((s) => s.key === 'luxury' && s.rows.some((r) => r.formula === 'percent' && r.cn_rate > 0))
    || all.schemes.find((s) => s.is_currency && s.rows.some((r) => r.formula === 'percent' && r.cn_rate > 0));
}

module.exports = {
  test, expect, UI_ORIGIN, SCHEME_STATUSES, DATE, MONTH,
  expectRupees, qs, getJson, postJson, expectError, book, percentScheme,
};
