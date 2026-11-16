// Spike: a sudden burst (the whole team opens the tool after the monthly scheme meeting), then back to normal.
// Checks that the API survives and recovers without errors.
//   k6 run spike.js
//   SPIKE_VUS=150 k6 run spike.js
import { thresholds, summaryTrendStats, summaryTo } from './config.js';
import { userIteration } from './traffic.js';

const BASE = parseInt(__ENV.BASE_VUS || '5');
const SPIKE = parseInt(__ENV.SPIKE_VUS || '60');

export const options = {
  versions: {
    spike: {
      executor: 'ramping-vus',
      startVUs: BASE,
      stages: [
        { duration: '30s', target: BASE },
        { duration: '10s', target: SPIKE }, // burst
        { duration: '1m', target: SPIKE },
        { duration: '10s', target: BASE },  // recovery
        { duration: '30s', target: BASE },
        { duration: '5s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds,
  summaryTrendStats,
};

export default userIteration;
export const handleSummary = summaryTo('spike');
