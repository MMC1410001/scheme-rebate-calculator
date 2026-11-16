// Smoke: 1 VU for 30 s. Run it before any heavier test; it must pass cleanly.
//   k6 run smoke.js
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, thresholds, summaryTrendStats, summaryTo } from './config.js';
import { userIteration } from './traffic.js';

export const options = {
  vus: 1,
  duration: __ENV.DURATION || '30s',
  thresholds,
  summaryTrendStats,
};

export function setup() {
  const res = http.get(`${BASE_URL}/schemes`);
  if (!check(res, { 'API is up': (r) => r.status === 200 })) {
    throw new Error(`API not reachable at ${BASE_URL}/schemes (status ${res.status})`);
  }
}

export default userIteration;
export const handleSummary = summaryTo('smoke');
