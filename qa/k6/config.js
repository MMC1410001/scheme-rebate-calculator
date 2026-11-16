// Shared settings for every k6 script. Nothing secret lives here.
//
//   BASE_URL     default http://127.0.0.1:8010 (the API server; /v1 is added here)
//   SCOPES       "national" = only the All India book (every answer from the cache after the first);
//                "mixed" (default) = also zones and a few regions, so some requests build a new scope
//
// The API is one uvicorn process doing pandas work. Its first answer for a new filter scope or a new growth value
// takes about 1 s; repeats come from an in-process cache in milliseconds. The users are planners at Acme Paints
// (tens, not thousands), so the default VU counts are small and the stress run looks for where one process stops.
import http from 'k6/http';
import { check } from 'k6';

// The routes the web app calls are version 1 of the API (/v1).
export const BASE_URL = `${(__ENV.BASE_URL || 'http://127.0.0.1:8010').replace(/\/$/, '')}/v1`;
const MIXED = (__ENV.SCOPES || 'mixed') !== 'national';

export const ZONES = ['Central', 'East', 'North', 'South', 'West'];
export const REGIONS = ['Delhi', 'Kerala', 'Mumbai', 'TN North', 'UP East', 'West Bengal'];
export const SCHEMES = ['luxury', 'premium', 'early_bird', 'waterproofing', 'primer', 'enamel', 'roller'];
export const GROWTH = [0, 5, 10, 15, 20];

// One filter scope as a query string, or '' for All India.
export function pickScope() {
  if (!MIXED) return '';
  const roll = Math.random();
  if (roll < 0.5) return '';
  if (roll < 0.85) return `zone=${encodeURIComponent(ZONES[Math.floor(Math.random() * ZONES.length)])}`;
  return `region=${encodeURIComponent(REGIONS[Math.floor(Math.random() * REGIONS.length)])}`;
}

export const pick = (list) => list[Math.floor(Math.random() * list.length)];

export const params = (name) => ({
  headers: { 'Content-Type': 'application/json' },
  tags: { name }, // groups metrics per endpoint in the summary
  timeout: '30s',
});

// A timed-out or reset request has no body; treat that as a failed check, not a script error.
export function jsonBody(r) {
  try {
    return r.json();
  } catch (e) {
    return null;
  }
}

export function checkOk(res, name, shape) {
  const body = jsonBody(res);
  return check(res, {
    [`${name} is 200`]: (r) => r.status === 200,
    [`${name} has the expected shape`]: () => body !== null && shape(body),
  });
}

export const summaryTrendStats = ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'];

// Pass/fail criteria. Reads and rate edits must feel instant (BRD: "edits reflect near-instantly, including the
// server round trip"); a new growth value or a new filter scope is computed once, so its limit is wider.
export const thresholds = {
  http_req_failed: ['rate<0.01'],                                         // < 1% errors
  checks: ['rate>0.99'],                                                  // > 99% of checks pass
  'http_req_duration{name:all-slabs}': ['p(95)<1500'],
  'http_req_duration{name:slabs}': ['p(95)<800'],
  'http_req_duration{name:simulate}': ['p(95)<800'],
  'http_req_duration{name:simulate-slabs}': ['p(95)<800'],
  'http_req_duration{name:growth}': ['p(95)<2000'],
  'http_req_duration{name:reference}': ['p(95)<500'],
};

// Writes a JSON summary to reports/<script>-summary.json next to the console output.
export function summaryTo(name) {
  return (data) => ({
    [`reports/${name}-summary.json`]: JSON.stringify(data, null, 2),
    stdout: '\n' + textSummary(data),
  });
}

function textSummary(data) {
  const m = data.metrics;
  const fmt = (metric, stat) => (m[metric] && m[metric].values[stat] !== undefined ? m[metric].values[stat].toFixed(0) : 'n/a');
  const lines = [
    `requests:        ${m.http_reqs ? m.http_reqs.values.count : 0} (${m.http_reqs ? m.http_reqs.values.rate.toFixed(1) : 0}/s)`,
    `failed:          ${(m.http_req_failed ? m.http_req_failed.values.rate * 100 : 0).toFixed(2)}%`,
    `checks passed:   ${(m.checks ? m.checks.values.rate * 100 : 0).toFixed(2)}%`,
    `max VUs:         ${m.vus_max ? m.vus_max.values.max : 'n/a'}`,
    'latency (ms)              p50     p95     p99     max',
  ];
  for (const name of ['all-slabs', 'slabs', 'simulate', 'simulate-slabs', 'growth', 'reference']) {
    const key = `http_req_duration{name:${name}}`;
    lines.push(`  ${name.padEnd(20)} ${fmt(key, 'med').padStart(7)} ${fmt(key, 'p(95)').padStart(7)} ${fmt(key, 'p(99)').padStart(7)} ${fmt(key, 'max').padStart(7)}`);
  }
  const failed = Object.entries(data.metrics)
    .filter(([, v]) => v.thresholds && Object.values(v.thresholds).some((t) => !t.ok))
    .map(([k]) => k);
  lines.push(failed.length ? `THRESHOLDS FAILED: ${failed.join(', ')}` : 'all thresholds passed');
  return lines.join('\n') + '\n';
}
