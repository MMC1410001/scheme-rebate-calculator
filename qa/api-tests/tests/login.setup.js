// Logs in once before the API suites when the API asks for a login (QA_USER / QA_PASSWORD set): the session cookie
// is saved to test-results/auth.json and every case's request context sends it (playwright.config.js). Without
// QA_USER the suites run as before, against an API without login (APP_ENV=local, no users).
const fs = require('fs');
const path = require('path');
const { request } = require('@playwright/test');

const STATE = path.join(__dirname, '..', 'test-results', 'auth.json');

module.exports = async () => {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  if (!process.env.QA_USER) {
    fs.writeFileSync(STATE, JSON.stringify({ cookies: [], origins: [] }));
    return;
  }
  const ctx = await request.newContext({ baseURL: process.env.API_BASE_URL || 'http://127.0.0.1:8010' });
  const response = await ctx.post('/v1/auth/login', { data: { username: process.env.QA_USER, password: process.env.QA_PASSWORD } });
  if (response.status() !== 200) throw new Error(`QA login failed: ${response.status()} ${await response.text()}`);
  await ctx.storageState({ path: STATE });
  await ctx.dispose();
};
module.exports.STATE = STATE;
