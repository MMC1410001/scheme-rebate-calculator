// Platform and security cases for every endpoint (COMMON_TC_n): API docs, unknown routes, CORS, error bodies and
// response headers. Tagged @security where the case is about exposure. A case for a known defect carries its id.
const { test, expect, UI_ORIGIN, getJson, book } = require('./helpers');

// Business routes are versioned (/v1); /health stays at the root.
const ENDPOINTS = ['/health', '/v1/auth/login', '/v1/auth/logout', '/v1/auth/me', '/v1/all-slabs', '/v1/all-slabs/adjusted', '/v1/dealers', '/v1/export', '/v1/filters',
  '/v1/gifts', '/v1/gifts/detail', '/v1/growth', '/v1/months', '/v1/months/edited', '/v1/months/next',
  '/v1/months/scheme', '/v1/reconciliation', '/v1/saved-versions', '/v1/saved-versions/meta', '/v1/saved-versions/preview',
  '/v1/saved-versions/{version_id}', '/v1/saved-versions/{version_id}/dealers',
  '/v1/saved-versions/{version_id}/snapshots/{snapshot_id}', '/v1/saved-versions/{version_id}/status', '/v1/schemes',
  '/v1/simulate', '/v1/simulate-slabs', '/v1/slabs', '/v1/trend'];
const FOREIGN_ORIGIN = 'https://qa-not-allowed.example';
// Words that only appear in a body when the server leaks its internals.
const LEAKS = [/\/Users\//, /\/home\//, /[A-Z]:\\\\/, /Traceback/, /site-packages/, /\.py\b/];

test.describe('API docs and routes', () => {
  test('COMMON_TC_15 Business routes are under /v1: the unversioned path answers 404', async ({ request }) => {
    expect((await request.get('/v1/schemes')).status()).toBe(200);
    expect((await request.get('/schemes')).status()).toBe(404);
  });

  test('COMMON_TC_1 /openapi.json documents every endpoint the web app calls', async ({ request }) => {
    const spec = await getJson(request, '/openapi.json');
    expect(Object.keys(spec.paths).sort()).toEqual([...ENDPOINTS].sort());
  });

  test('COMMON_TC_2 /docs serves the Swagger page', async ({ request }) => {
    const response = await request.get('/docs');
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain('swagger');
  });

  test('COMMON_TC_3 An unknown route returns 404 JSON {"detail": "Not Found"}', async ({ request }) => {
    const response = await request.get('/qa-no-such-route');
    expect(response.status()).toBe(404);
    expect(await response.json()).toEqual({ detail: 'Not Found' });
  });

  test('COMMON_TC_4 Every read endpoint answers JSON', async ({ request }) => {
    for (const path of ['/v1/schemes', '/v1/filters', '/v1/all-slabs', '/v1/reconciliation', '/v1/trend', '/v1/slabs?scheme=luxury']) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      expect(response.headers()['content-type'], path).toContain('application/json');
    }
  });
});

test.describe('Security @security', () => {
  test('COMMON_TC_5_SEC CORS allows the web app origin', async ({ request }) => {
    const response = await request.get('/v1/schemes', { headers: { Origin: UI_ORIGIN } });
    expect(response.headers()['access-control-allow-origin']).toBe(UI_ORIGIN);
  });

  test('COMMON_TC_6_SEC CORS gives no allow-origin header to another origin', async ({ request }) => {
    const response = await request.get('/v1/schemes', { headers: { Origin: FOREIGN_ORIGIN } });
    expect(response.headers()['access-control-allow-origin']).toBeUndefined();
  });

  test('COMMON_TC_7_SEC A CORS preflight from another origin is refused', async ({ request }) => {
    const response = await request.fetch('/v1/simulate', {
      method: 'OPTIONS',
      headers: { Origin: FOREIGN_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    expect(response.status()).toBe(400);
    expect(response.headers()['access-control-allow-origin']).toBeUndefined();
  });

  test('COMMON_TC_8_SEC A CORS preflight from the web app is allowed for POST with JSON', async ({ request }) => {
    const response = await request.fetch('/v1/simulate', {
      method: 'OPTIONS',
      headers: { Origin: UI_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()['access-control-allow-origin']).toBe(UI_ORIGIN);
  });

  test('COMMON_TC_9_SEC Aggregate answers carry no dealer code or dealer name', async ({ request }) => {
    const { all } = await book(request);
    const text = JSON.stringify(all);
    for (const key of ['customer_code', 'customer_name', 'dealer_code', 'dealer_name']) expect(text, key).not.toContain(`"${key}"`);
  });

  test('COMMON_TC_10_SEC [SPC-6] No answer exposes server file paths or a stack trace', async ({ request }) => {
    // "Connection: close" on each request: the server drops the connection after a 500, and a reused socket would
    // fail the next request instead of this check.
    const close = { headers: { Connection: 'close' } };
    const bodies = {
      '/trend': await (await request.get('/v1/trend', close)).text(),
      '/slabs unknown': await (await request.get('/v1/slabs?scheme=qa-nope', close)).text(),
      '/growth -100': await (await request.post('/v1/growth', { data: { growth_pct: -100 }, ...close })).text(),
    };
    for (const [name, body] of Object.entries(bodies)) {
      for (const leak of LEAKS) expect(body, `${name} matches ${leak}`).not.toMatch(leak);
    }
  });

  test('COMMON_TC_11_SEC [SPC-7] Responses send X-Content-Type-Options: nosniff', async ({ request }) => {
    const response = await request.get('/v1/schemes');
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
  });

  test('COMMON_TC_12_SEC A request body over 16 MB is refused with 413 in plain words', async ({ request }) => {
    const response = await request.post('/v1/months', {
      data: 'x'.repeat(16 * 1024 * 1024 + 1), headers: { 'Content-Type': 'application/json', Connection: 'close' },
    });
    expect(response.status()).toBe(413);
    expect((await response.json()).detail).toContain('too large');
  });

  test('COMMON_TC_13 /health answers with the live month and whether the views are warm', async ({ request }) => {
    const body = await getJson(request, '/health');
    expect(body.status).toBe('ok');
    expect(body.api_version).toBe('v1');
    expect(typeof body.ready).toBe('boolean');
    expect(body.live_month).toMatch(/^\d{4}-\d{2}$/);
  });

  test('COMMON_TC_14_SEC Archiving a version that does not exist (PATCH) is 404 and writes nothing', async ({ request }) => {
    const meta = await getJson(request, '/v1/saved-versions/meta');
    test.skip(!meta.can_save, 'saving needs the database');
    const response = await request.patch('/v1/saved-versions/999999999', { data: { status: 'ARCHIVED' } });
    expect(response.status()).toBe(404);
  });
});

// ---- Login and roles (backend app/auth.py). With QA_USER / QA_PASSWORD the API asks for a login; without them the
// cases that need one are skipped. QA_VIEWER_USER / QA_VIEWER_PASSWORD: a VIEWER login, for the role cases.
const LOGIN_ON = Boolean(process.env.QA_USER);
// A context without the run's saved session (playwright.config.js gives every context that one by default).
const NO_SESSION = { cookies: [], origins: [] };
const VIEWER = process.env.QA_VIEWER_USER ? { username: process.env.QA_VIEWER_USER, password: process.env.QA_VIEWER_PASSWORD } : null;

test.describe('Login and roles', () => {
  test('COMMON_TC_16_SEC /auth/me says who is logged in', async ({ request }) => {
    const me = await getJson(request, '/v1/auth/me');
    expect(['ADMIN', 'VIEWER']).toContain(me.role);
    expect(me.login_required).toBe(LOGIN_ON);
  });

  test('COMMON_TC_17_SEC Without the session cookie a business route answers 401 in plain words', async ({ playwright }) => {
    test.skip(!LOGIN_ON, 'the API runs without login');
    const anon = await playwright.request.newContext({ baseURL: process.env.API_BASE_URL || 'http://127.0.0.1:8010', storageState: NO_SESSION });
    for (const path of ['/v1/schemes', '/v1/all-slabs', '/v1/saved-versions']) {
      const response = await anon.get(path);
      expect(response.status(), path).toBe(401);
      expect((await response.json()).detail).toBe('Please log in to continue.');
    }
    await anon.dispose();
  });

  test('COMMON_TC_18_SEC A wrong password is refused, sets no cookie and names no user', async ({ playwright }) => {
    test.skip(!LOGIN_ON, 'the API runs without login');
    const anon = await playwright.request.newContext({ baseURL: process.env.API_BASE_URL || 'http://127.0.0.1:8010', storageState: NO_SESSION });
    const response = await anon.post('/v1/auth/login', { data: { username: process.env.QA_USER, password: 'qa-wrong-password' } });
    expect(response.status()).toBe(401);
    expect((await response.json()).detail).toBe('The username or password is not correct.');
    expect(response.headers()['set-cookie']).toBeUndefined();
    await anon.dispose();
  });

  test('COMMON_TC_19_SEC The session cookie is HttpOnly and SameSite=Strict', async ({ playwright }) => {
    test.skip(!LOGIN_ON, 'the API runs without login');
    const ctx = await playwright.request.newContext({ baseURL: process.env.API_BASE_URL || 'http://127.0.0.1:8010', storageState: NO_SESSION });
    const response = await ctx.post('/v1/auth/login', { data: { username: process.env.QA_USER, password: process.env.QA_PASSWORD } });
    expect(response.status()).toBe(200);
    const cookie = response.headers()['set-cookie'].toLowerCase();
    expect(cookie).toContain('httponly');
    expect(cookie).toContain('samesite=strict');
    await ctx.dispose();
  });

  test('COMMON_TC_20_SEC A request that is not JSON is refused with 415', async ({ request }) => {
    const response = await request.post('/v1/months', { data: 'adjustments=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(response.status()).toBe(415);
  });

  test('COMMON_TC_21_SEC A VIEWER cannot list dealer names or change versions', async ({ playwright }) => {
    test.skip(!VIEWER, 'no VIEWER login given (QA_VIEWER_USER)');
    const ctx = await playwright.request.newContext({ baseURL: process.env.API_BASE_URL || 'http://127.0.0.1:8010', storageState: NO_SESSION });
    expect((await ctx.post('/v1/auth/login', { data: VIEWER })).status()).toBe(200);
    const { all } = await book(ctx);
    const scheme = all.schemes[0];
    const row = scheme.rows[0];
    const dealers = await ctx.post('/v1/dealers', { data: { scheme: scheme.key, component: row.component, row } });
    expect(dealers.status()).toBe(403);
    expect((await ctx.post('/v1/saved-versions', { data: { name: 'qa-viewer' } })).status()).toBe(403);
    expect((await ctx.patch('/v1/saved-versions/1', { data: { status: 'ARCHIVED' } })).status()).toBe(403);
    // The codes of a slab (no names) are still served: any user may make a slab's Volume / GSR edit.
    const codes = await ctx.post('/v1/dealers', { data: { scheme: scheme.key, component: row.component, row, codes_only: true } });
    expect(codes.status()).toBe(200);
    await ctx.dispose();
  });
});
