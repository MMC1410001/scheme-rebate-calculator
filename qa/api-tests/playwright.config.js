// API-only suite: no browsers are launched (request contexts only). See qa/README.md.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  // A cold filter scope or a new growth value is computed on first request (about 1 s each); the whole
  // invariant sweep over every scheme takes longer, so the timeout is generous.
  timeout: 120_000,
  fullyParallel: true,
  // The API is one uvicorn process doing pandas work; more workers only queue behind each other.
  workers: Number(process.env.PW_WORKERS || 4),
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]],
  // With QA_USER / QA_PASSWORD (an API that asks for a login), one login before the run; its cookie goes with every case.
  globalSetup: require.resolve('./tests/login.setup.js'),
  use: {
    baseURL: process.env.API_BASE_URL || 'http://127.0.0.1:8010',
    storageState: require('./tests/login.setup.js').STATE,
  },
});
