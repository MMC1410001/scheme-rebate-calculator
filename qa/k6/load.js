// Load: a busy planning day. Ramps to TARGET_VUS planners (default 25), holds for HOLD (default 3m), ramps down.
//   k6 run load.js
//   TARGET_VUS=50 HOLD=10m k6 run load.js
import { thresholds, summaryTrendStats, summaryTo } from './config.js';
import { userIteration } from './traffic.js';

const TARGET = parseInt(__ENV.TARGET_VUS || '25');

export const options = {
  versions: {
    load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: TARGET },
        { duration: __ENV.HOLD || '3m', target: TARGET },
        { duration: '15s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds,
  summaryTrendStats,
};

export default userIteration;
export const handleSummary = summaryTo('load');
