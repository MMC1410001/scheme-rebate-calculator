// Browser suite for the web app (qa/README.md, Step 4). The API suite (playwright.config.js) stays browser-free.
// This suite uses the installed Google Chrome (channel "chrome"), so it needs no browser download. Set PW_CHANNEL=
// (empty) to use a downloaded Playwright Chromium instead.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './ui',
  timeout: 90_000,
  expect: { timeout: 30_000 },
  // One worker: every page load asks the one API process for the whole book.
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-ui' }]],
  use: {
    baseURL: process.env.UI_BASE_URL || 'http://localhost:5173',
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  // UI_BROWSERS=chrome,firefox,webkit runs the suite in each browser (default: chrome only). Firefox and WebKit
  // need `npx playwright install firefox webkit`.
  projects: (process.env.UI_BROWSERS || 'chrome').split(',').map((name) => name.trim()).map((name) => {
    if (name === 'firefox') return { name, use: { browserName: 'firefox' } };
    if (name === 'webkit') return { name, use: { browserName: 'webkit' } };
    return { name: 'chrome', use: { browserName: 'chromium', channel: process.env.PW_CHANNEL === undefined ? 'chrome' : process.env.PW_CHANNEL || undefined } };
  }),
});
