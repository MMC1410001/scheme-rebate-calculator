// The web app in a real browser (UI_TC_n). qa/README.md, Step 4.
//
// Env:
//   UI_BASE_URL    the web app, default http://localhost:5173 (npm --prefix frontend run dev)
//   API_BASE_URL   the API the app calls, default http://127.0.0.1:8010; the cases read it to know the expected figures
//
// The app shows aggregates only. No case reads or prints a dealer code or name.
const { test, expect } = require('@playwright/test');

// Version 1 of the API, as the web app calls it.
const API = `${(process.env.API_BASE_URL || 'http://127.0.0.1:8010').replace(/\/$/, '')}/v1`;
const inr = new Intl.NumberFormat('en-IN');

/** The whole book from the API, the source of truth for what the screen must show. */
async function apiBook(request, query = '') {
  const response = await request.get(`${API}/all-slabs${query}`);
  expect(response.status()).toBe(200);
  return response.json();
}

/** Opens the app and waits until the first load has drawn the book (the subtitle shows the dealer count). */
async function open(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Scheme Performance & Impact' })).toBeVisible();
  await expect(page.locator('.subtitle')).toContainText(/[1-9][\d,]* dealers/);
  return errors;
}

const tab = (page, name) => page.getByRole('tab', { name });
const multiSelect = (page, label) => page.locator('.ms').filter({ has: page.locator('.ms-label', { hasText: label }) });

async function pick(page, label, option) {
  const box = multiSelect(page, label);
  await box.locator('.ms-btn').click();
  await box.getByRole('checkbox', { name: option }).check();
  await box.getByRole('button', { name: 'Done' }).click();
}

/** Raises the first paying percentage rate under `root` by one point. Rates are click-to-type figures (3 Nov 2026):
 *  a button showing the rate, which becomes a text box when clicked. */
async function raiseFirstPercentRate(root) {
  const boxes = root.getByRole('button', { name: 'Edit new rebate rate' });
  await expect(boxes.first()).toBeVisible();
  for (let i = 0; i < await boxes.count(); i++) {
    const shown = (await boxes.nth(i).innerText()).trim();
    if (!shown.endsWith('%')) continue;
    const v = Number(shown.replace('%', ''));
    if (!(v > 0 && v < 100)) continue;
    await boxes.nth(i).click();
    const input = root.getByRole('textbox', { name: 'New rebate rate' });
    await input.fill(String(v + 1));
    await input.press('Enter');
    return;
  }
  throw new Error('no paying percentage rate found');
}

/** The page has no horizontal scroll at the current viewport. */
async function expectNoPageScroll(page) {
  const { sw, vw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth }));
  expect(sw).toBeLessThanOrEqual(vw + 1);
}

test.describe('Load and header @ui', () => {
  test('UI_TC_1 The app loads with the title, scheme and dealer counts from the API, and no console error', async ({ page, request }) => {
    const book = await apiBook(request);
    const errors = await open(page);
    const subtitle = page.locator('.subtitle');
    await expect(subtitle).toContainText(`${book.grand.scheme_count} schemes`);
    await expect(subtitle).toContainText(`${inr.format(book.grand.dealer_count)} dealers`);
    await expect(page.locator('.error')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('UI_TC_2 A part month is labelled with its day count; a settled month is not', async ({ page, request }) => {
    const { source } = await apiBook(request);
    await open(page);
    const badge = page.locator('.src-badge');
    if (source.complete) await expect(badge).toHaveCount(0);
    else await expect(badge).toHaveText(`part month · day ${source.elapsed_days} of ${source.month_days}`);
  });

  test('UI_TC_3 The readout shows Volume, GSR, Credit note and CN % of GSR with the API figures', async ({ page, request }) => {
    const { grand } = await apiBook(request);
    await open(page);
    const readout = page.locator('.readout');
    for (const label of ['Volume', 'GSR', 'Credit note', 'CN % of GSR']) await expect(readout).toContainText(label);
    await expect(readout).toContainText(`₹${(grand.gsr / 1e7).toFixed(2)} Cr`);
    await expect(readout).toContainText(`₹${(grand.current_cn / 1e7).toFixed(2)} Cr`);
    await expect(readout).toContainText(`${((grand.current_cn / grand.gsr) * 100).toFixed(2)}%`);
    // Nothing is edited yet, so no estimate or impact may show (a "-Rs 0" reads as a saving).
    await expect(readout.locator('.is-impact')).toHaveCount(0);
  });

  test('UI_TC_4 [UI-1] The three tabs switch views and only one is selected at a time', async ({ page }) => {
    await open(page);
    for (const name of ['Plan', 'Simulator', 'Overview']) {
      await tab(page, name).click();
      await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
      for (const other of ['Overview', 'Plan', 'Simulator'].filter((n) => n !== name)) {
        await expect(tab(page, other)).toHaveAttribute('aria-selected', 'false');
      }
    }
  });
});

test.describe('Filters @ui', () => {
  test('UI_TC_5 Selecting a zone shows that zone\'s dealer count; Clear filters restores All India', async ({ page, request }) => {
    const all = await apiBook(request);
    const south = await apiBook(request, '?zone=South');
    await open(page);
    await pick(page, 'Zone', 'South');
    await expect(page.locator('.subtitle')).toContainText(`${inr.format(south.grand.dealer_count)} dealers`);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.locator('.subtitle')).toContainText(`${inr.format(all.grand.dealer_count)} dealers`);
  });

  test('UI_TC_6 The Region list narrows to the regions of the selected zone', async ({ page, request }) => {
    const filters = await (await request.get(`${API}/filters`)).json();
    const southRegions = filters.hierarchy.filter((h) => h.zone === 'South').map((h) => h.region);
    await open(page);
    await pick(page, 'Zone', 'South');
    const region = multiSelect(page, 'Region');
    await region.locator('.ms-btn').click();
    const shown = await region.locator('.ms-opt').allInnerTexts();
    expect(shown.map((s) => s.trim()).sort()).toEqual([...new Set(southRegions)].sort());
  });

  test('UI_TC_7 Find scheme narrows the month table to matching schemes, their products opened', async ({ page }) => {
    await open(page);
    await tab(page, 'Simulator').click();
    await page.getByPlaceholder('e.g. Luxury, Primer…').fill('Luxury');
    const titles = page.locator('.months .mv-scheme-row .mv-name-link');
    await expect(titles.first()).toBeVisible();
    for (const title of await titles.allInnerTexts()) expect(title.toLowerCase()).toContain('luxury');
  });

  test('UI_TC_8 Verified only hides schemes that do not reconcile', async ({ page, request }) => {
    const book = await apiBook(request);
    await open(page);
    await tab(page, 'Simulator').click();
    await page.getByLabel('Verified only').check();
    await expect(page.locator('.months .mv-scheme-row')).toHaveCount(book.schemes.filter((s) => s.status === 'ok').length);
  });
});

test.describe('Simulator @ui', () => {
  test('UI_TC_9 Editing a rate shows Simulated CN and Impact, counts the edit, and Reset all (confirmed) clears it', async ({ page }) => {
    await open(page);
    await tab(page, 'Simulator').click();
    await page.getByPlaceholder('e.g. Luxury, Primer…').fill('Luxury');
    await page.getByRole('button', { name: 'Expand Luxury slabs here', exact: true }).click();
    // Raise the first paying percentage rate by one point (the 0 band pays nothing by rule).
    await raiseFirstPercentRate(page);
    const readout = page.locator('.readout');
    await expect(readout.locator('.is-est')).toContainText('Simulated CN');
    await expect(readout.locator('.is-impact')).toContainText(/\+₹/);
    await expect(tab(page, 'Simulator').locator('.pill')).toHaveText('1');
    await page.getByRole('button', { name: /Reset all/ }).click();
    // An in-app confirm, never window.confirm.
    await page.getByRole('alertdialog').getByRole('button', { name: 'Reset all' }).click();
    await expect(readout.locator('.is-impact')).toHaveCount(0);
    await expect(tab(page, 'Simulator').locator('.pill')).toHaveCount(0);
  });

  test('UI_TC_10 In the month table a product opens its schemes and a scheme its editor; Collapse all closes both', async ({ page }) => {
    await open(page);
    await tab(page, 'Simulator').click();
    const product = page.locator('.months .mv-cat .mv-toggle').first();
    await product.click();
    await expect(product).toHaveAttribute('aria-expanded', 'true');
    const scheme = page.locator('.months .mv-scheme-row .mv-toggle').first();
    await scheme.click();
    await expect(scheme).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.months [role=region]').first()).toBeVisible();
    await page.getByRole('button', { name: 'Collapse all' }).click();
    await expect(product).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.months .mv-scheme-row')).toHaveCount(0);
    await expect(page.locator('.months [role=region]')).toHaveCount(0);
  });
});

test.describe('Plan @ui', () => {
  test('UI_TC_11 [UI-1] The Plan tab opens without a page error, offers growth presets, and +10% selects it', async ({ page }) => {
    const errors = await open(page);
    await tab(page, 'Plan').click();
    const preset = page.getByRole('button', { name: '+10%', exact: true });
    await preset.click();
    await expect(preset).toHaveClass(/\bon\b/);
    await expect(page.getByLabel('Sales growth target slider')).toHaveValue('10');
    expect(errors).toEqual([]);
  });
});

test.describe('Resilience and layout @ui', () => {
  test('UI_TC_12 When the API fails, the app shows an error instead of an empty dashboard', async ({ page }) => {
    await page.route('**/all-slabs**', (route) => route.abort());
    await page.goto('/');
    await expect(page.locator('.error')).toBeVisible();
  });

  for (const width of [1280, 768, 390]) {
    test(`UI_TC_13 No horizontal page scroll at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      await expectNoPageScroll(page);
      await tab(page, 'Simulator').click();
      await expectNoPageScroll(page);
    });
  }
});

test.describe('Dealer list and slab editing @ui', () => {
  async function openPremium(page) {
    await open(page);
    await tab(page, 'Simulator').click();
    await page.getByPlaceholder('e.g. Luxury, Primer…').fill('Premium');
    await page.getByRole('button', { name: 'Expand Premium slabs here', exact: true }).click();
  }
  const component = (page, name) => page.locator('.component').filter({ has: page.locator('h3', { hasText: new RegExp(`^${name}$`) }) });

  test('UI_TC_14 Clicking a dealer count lists those dealers: same count, 50 a page, search, Escape closes', async ({ page }) => {
    await openPremium(page);
    const count = component(page, 'PREMIUM 01').locator('.link-num').first();
    const shown = (await count.innerText()).trim();
    await count.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('.dl-sub')).toContainText(`${shown} dealers`);
    await expect(dialog.locator('.dl-table tbody tr')).toHaveCount(Math.min(50, Number(shown.replace(/,/g, ''))));
    for (const h of ['Dealer code', 'Name', 'Region', 'Achievement (Q)', 'Shortfall', 'Next slab', 'Actual CN']) {
      await expect(dialog.locator('thead')).toContainText(h);
    }
    await dialog.getByPlaceholder('Search dealers…').fill('qa-no-such-dealer');
    await expect(dialog.locator('.hint')).toContainText('No dealer found');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('UI_TC_15 Boundaries are editable at All India where regions run different rate cards', async ({ page }) => {
    await openPremium(page);
    // PREMIUM 02 runs several regional cards in the Nov'26 file (PREMIUM 01 runs one).
    const comp = component(page, 'PREMIUM 02');
    await expect(comp.locator('.component-head')).toContainText('each region keeps its rate card');
    const end = comp.getByRole('button', { name: 'Edit slab end' }).first();
    const before = Number((await end.innerText()).replace(/[^\d.]/g, ''));
    await end.click();
    const box = comp.getByRole('textbox', { name: 'Slab end' });
    await box.fill(String(before + 1));   // inside the legal range (the next boundary may be close)
    await box.press('Enter');
    await expect(comp.locator('.component-head')).toContainText('boundaries moved');
    await expect(page.locator('.readout .is-impact')).toBeVisible();
  });

  test('UI_TC_16 A per-dealer target component gets a first boundary with no impact until a rate changes', async ({ page }) => {
    await openPremium(page);
    const comp = component(page, 'Zen Star Per 100 L');
    await comp.getByLabel('Add a slab boundary').first().click();
    await expect(comp.getByLabel('Slab end')).toHaveCount(1);
    await expect(comp.locator('tfoot td').nth(8)).toHaveText('—');
    await expect(page.locator('.readout .is-impact')).toHaveCount(0);
  });
});

test.describe('Two users and export @ui', () => {
  test('UI_TC_17 Two users at the same time: one user\'s edit never shows on the other\'s screen', async ({ browser }) => {
    const a = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const b = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pa = await a.newPage();
    const pb = await b.newPage();
    await open(pa);
    await open(pb);
    await tab(pa, 'Simulator').click();
    await pa.getByPlaceholder('e.g. Luxury, Primer…').fill('Luxury');
    await pa.getByRole('button', { name: 'Expand Luxury slabs here', exact: true }).click();
    await raiseFirstPercentRate(pa);
    await expect(pa.locator('.readout .is-impact')).toBeVisible();
    // User B: same app, same time -- no impact, no edit count; also after a reload.
    await expect(pb.locator('.readout .is-impact')).toHaveCount(0);
    await expect(tab(pb, 'Simulator').locator('.pill')).toHaveCount(0);
    await pb.reload();
    await expect(pb.locator('.subtitle')).toContainText(/[1-9][\d,]* dealers/);
    await expect(pb.locator('.readout .is-impact')).toHaveCount(0);
    await a.close();
    await b.close();
  });

  test('UI_TC_18 Export to Excel downloads the view as .xlsx named after the month', async ({ page, request }) => {
    const { source } = await apiBook(request);
    await open(page);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export to Excel' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(`scheme-performance_${source.month}_All-India.xlsx`);
  });
});

test.describe('Previous · Current · Next month @ui', () => {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const name = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
  const view = (page) => page.locator('section.months:not(.gifts)');

  test('UI_TC_19 The Simulator shows previous, current and next month side by side, with a Total row', async ({ page, request }) => {
    const { source } = await apiBook(request);
    await open(page);
    await tab(page, 'Simulator').click();
    const heads = view(page).locator('.mv-month');
    await expect(heads.nth(1)).toContainText(`Current · ${name(source.month)}`);
    await expect(heads.nth(0)).toContainText('Previous ·');
    await expect(heads.nth(2)).toContainText('Next ·');
    // Each header carries its unit on a second line (ColHead); Impact appears only once something is edited.
    for (const h of ['Dealers', 'Volume', 'litres', 'Mix', 'GSR', '₹', '% of GSR']) await expect(view(page).locator('thead')).toContainText(h);
    await expect(view(page).locator('thead')).not.toContainText('Impact');
    await expect(view(page).locator('tfoot')).toContainText('Total');
  });

  test('UI_TC_20 A rate edit shows its impact in the current and the next month of that product', async ({ page }) => {
    await open(page);
    await tab(page, 'Simulator').click();
    await page.getByPlaceholder('e.g. Luxury, Primer…').fill('Luxury');
    await page.getByRole('button', { name: 'Expand Luxury slabs here', exact: true }).click();
    await raiseFirstPercentRate(view(page));
    const row = view(page).locator('tbody tr').filter({ has: page.getByRole('button', { name: 'Luxury', exact: true }) });
    await expect(row.locator('.cost')).toHaveCount(2);   // current and next month impact
  });

  test('UI_TC_21 A scheme opens its slab tables inside the three month columns; the Current column is the editor', async ({ page }) => {
    await open(page);
    await tab(page, 'Simulator').click();
    await view(page).getByRole('button', { name: 'Premium', exact: true }).click();
    await view(page).getByRole('button', { name: 'Expand Premium slabs here', exact: true }).click();
    const comp = view(page).locator('.mv-comp-row').first();
    await expect(comp.locator('th.mv-product')).toHaveText('PREMIUM 01');
    await expect(comp.locator('.mv-slab-cell')).toHaveCount(3);
    await expect(comp.locator('.mv-slab-cell table')).toHaveCount(3);
    for (const h of ['Slab', 'Dealers', 'Volume', 'Mix', 'GSR', 'Rate', '% of GSR', 'Impact']) await expect(comp.locator('.mv-slab-cell').nth(1)).toContainText(h);
    // Edited in place: the rate boxes and boundary boxes sit in the Current column, not in a separate editor.
    const cur = comp.locator('.mv-slab-cell').nth(1);
    await expect(cur.getByLabel('New rebate rate').first()).toBeVisible();
    await expect(cur.getByLabel('Slab end').first()).toBeVisible();
    await expect(comp.locator('.mv-slab-cell').nth(0).getByLabel('New rebate rate')).toHaveCount(0);
    await expect(view(page).locator('.mv-edit-row')).toHaveCount(0);
    await expect(page.locator('.scheme-list')).toHaveCount(0);   // no separate scheme list any more
  });

  for (const [i, month] of [[0, 'Previous'], [1, 'Current'], [2, 'Next']]) {
    test(`UI_TC_23 A dealer count in the ${month.toLowerCase()} month's slab table lists those dealers`, async ({ page }) => {
      await open(page);
      await tab(page, 'Simulator').click();
      await view(page).getByRole('button', { name: 'Premium', exact: true }).click();
      await view(page).getByRole('button', { name: 'Expand Premium slabs here', exact: true }).click();
      const count = view(page).locator('.mv-comp-row').first().locator('.mv-slab-cell').nth(i).locator('.link-num').first();
      const shown = (await count.innerText()).trim();
      await count.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.locator('.dl-sub')).toContainText(`${shown} dealers`);
      if (month !== 'Current') await expect(dialog.locator('.dl-eyebrow')).toContainText(`${month} ·`);
      await expect(dialog.locator('.dl-table tbody tr')).toHaveCount(Math.min(50, Number(shown.replace(/,/g, ''))));
      await page.keyboard.press('Escape');
    });
  }

  test('UI_TC_22 V raises next month\'s GSR by that percentage', async ({ page }) => {
    await open(page);
    await tab(page, 'Simulator').click();
    const total = view(page).locator('tfoot td');
    // Footer cells, no edit yet: dealers 0, previous 1-5, current 6-10, next 11-15 (next GSR = 13). V is not an edit.
    // The cell's first line is the figure; the line under it is its change from the month before.
    const gsr = async () => { const s = (await total.nth(13).innerText()).split('\n')[0]; return Number(s.replace(/[^\d.]/g, '')) * (s.includes('Cr') ? 1e7 : 1e5); };
    await expect(total.nth(13)).toContainText('Cr');
    const before = await gsr();
    const v = view(page).getByLabel('Next month volume change, percent');
    await v.fill('10');
    await v.press('Enter');
    await expect.poll(gsr, { timeout: 20_000 }).toBeGreaterThan(before * 1.09);
    expect(await gsr()).toBeLessThan(before * 1.11);
  });

  test('UI_TC_24 Delete hides a scheme and takes its CN off the current and next month; Restore brings it back', async ({ page }) => {
    await open(page);
    await tab(page, 'Simulator').click();
    await page.getByPlaceholder('e.g. Luxury, Primer…').fill('Luxury');
    // Footer cells once edited: Impact 0 (current, next under it), dealers 1, previous 2-6, current 7-11, next 12-16.
    const total = view(page).locator('tfoot td');
    const impact = view(page).locator('tfoot td.mv-impact');
    await expect(view(page).locator('thead')).not.toContainText('Impact');
    await view(page).getByRole('button', { name: 'Delete Luxury', exact: true }).click();
    // Delete asks first (in-app confirm), then offers Undo.
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete scheme' }).click();
    await expect(view(page).getByRole('button', { name: 'Expand Luxury slabs here', exact: true })).toHaveCount(0);
    await expect(view(page).locator('.mv-removed')).toContainText('Luxury');
    await expect(impact.locator(':scope > .lower')).toBeVisible();   // lower CN: neutral blue, never a "saving"
    await expect(impact.locator('.mv-impact-next .lower')).toBeVisible({ timeout: 20_000 });
    await expect(total.nth(14)).not.toHaveText('—');   // GSR stays
    await view(page).getByRole('button', { name: 'Restore Luxury' }).click();
    await expect(view(page).getByRole('button', { name: 'Expand Luxury slabs here', exact: true })).toBeVisible();
    await expect(view(page).locator('.mv-removed')).toHaveCount(0);
    await expect(view(page).locator('thead')).not.toContainText('Impact', { timeout: 20_000 });
  });

  test('UI_TC_25 × on a slab drops its dealers to the slab below: impact is lower in the current and next month', async ({ page }) => {
    await open(page);
    await tab(page, 'Simulator').click();
    await page.getByPlaceholder('e.g. Luxury, Primer…').fill('Luxury');
    await view(page).getByRole('button', { name: 'Expand Luxury slabs here', exact: true }).click();
    const first = view(page).getByRole('button', { name: 'Remove this slab' }).first();
    await expect(first).toHaveAttribute('title', /no slab below, so its dealers earn nothing/);
    const below = view(page).locator('button[title="Remove this slab: its dealers drop to the slab below"]');
    await below.nth(1).click();
    const row = view(page).locator('tbody tr').filter({ has: page.getByRole('button', { name: 'Luxury', exact: true }) });
    await expect(row.locator('.lower')).toHaveCount(2, { timeout: 20_000 });   // current and next month impact
  });
});

test.describe('Address bar @ui', () => {
  test('UI_TC_26 The tab is in the address: a reload keeps it, Back returns to the tab before', async ({ page }) => {
    await page.goto('/?tab=simulator');
    await expect(page.locator('#tab-simulator')).toHaveAttribute('aria-selected', 'true');
    await page.reload();
    await expect(page.locator('#tab-simulator')).toHaveAttribute('aria-selected', 'true');
    await page.locator('#tab-versions').click();
    await expect(page).toHaveURL(/tab=versions/);
    await page.goBack();
    await expect(page.locator('#tab-simulator')).toHaveAttribute('aria-selected', 'true');
    await page.locator('#tab-overview').click();
    await expect(page).not.toHaveURL(/tab=/);    // Overview is the default: no tab in the address
  });

  test('UI_TC_28 Filters in the address survive a reload: the zone and region stay selected and are not cleared', async ({ page, request }) => {
    const filters = await (await request.get(`${API}/filters`)).json();
    const { zone, region } = filters.hierarchy[0];
    await page.goto(`/?tab=simulator&zone=${encodeURIComponent(zone)}&region=${encodeURIComponent(region)}`);
    await expect(page.locator('.subtitle')).toContainText(/[\d,]+ dealers/);
    await expect(multiSelect(page, 'Zone').locator('.ms-btn')).toContainText(zone);
    await expect(multiSelect(page, 'Region').locator('.ms-btn')).toContainText(region);
    await page.reload();
    await expect(page.locator('.subtitle')).toContainText(/[\d,]+ dealers/);
    expect(new URL(page.url()).searchParams.get('zone')).toBe(zone);
    expect(new URL(page.url()).searchParams.get('region')).toBe(region);
    await expect(multiSelect(page, 'Region').locator('.ms-btn')).toContainText(region);
  });
});

test.describe('Typing figures @ui', () => {
  const months = (page) => page.locator('section.months:not(.gifts)');
  test('UI_TC_29 Escape cancels a typed figure: V and a month-table figure go back, nothing is counted as an edit', async ({ page }) => {
    await open(page);
    await tab(page, 'Simulator').click();
    const v = months(page).getByLabel('Next month volume change, percent');
    await expect(v).toHaveValue('0');
    await v.click();
    await v.fill('25');
    await v.press('Escape');
    await expect(v).toHaveValue('0');
    // A click-to-type figure in the Current column (a GSR): typed over, then Escape.
    await months(page).getByRole('button', { name: /edit .*gsr/i }).first().click();
    const box = months(page).getByRole('textbox', { name: /new .*gsr/i });
    await box.fill('1');
    await box.press('Escape');
    await expect(box).toHaveCount(0);
    await page.waitForTimeout(1000);
    await expect(page.getByRole('button', { name: /^Edits \(/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Reset all/ })).toHaveCount(0);
  });
});

// Needs an API that asks for a login: QA_USER / QA_PASSWORD (an ADMIN) and QA_VIEWER_USER / QA_VIEWER_PASSWORD.
// Run with `npm run test:ui -- -g UI_TC_27` then; the other UI cases expect an API without login.
test.describe('Login @ui', () => {
  test('UI_TC_27 The login screen: a wrong password is refused in plain words; a VIEWER sees no dealer list; Log out', async ({ page }) => {
    test.skip(!process.env.QA_VIEWER_USER, 'the API runs without login');
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
    await page.getByLabel('Username').fill(process.env.QA_VIEWER_USER);
    await page.getByLabel('Password').fill('qa-wrong-password');
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('alert')).toHaveText('The username or password is not correct.');
    await page.getByLabel('Password').fill(process.env.QA_VIEWER_PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.locator('.subtitle')).toContainText(/[1-9][\d,]* dealers/);
    await expect(page.locator('.user-badge')).toContainText('viewer');
    // A VIEWER sees dealer counts as plain figures: no button opens a dealer list anywhere on the Simulator.
    await page.getByRole('tab', { name: 'Simulator' }).click();
    await expect(page.locator('table').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /dealers.*show/i })).toHaveCount(0);
    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  });
});

test.describe('Versions @ui', () => {
  test('UI_TC_30 Delete a version asks first; Undo keeps it; without Undo it is gone after 10 s', async ({ page, request }) => {
    const name = `qa-delete-${Date.now()}`;
    const saved = await request.post('/api/v1/saved-versions', { data: { name }, timeout: 300_000 });
    test.skip(saved.status() === 503, 'saving needs the database');
    expect(saved.ok()).toBeTruthy();
    const { version_id: id } = await saved.json();
    try {
      await page.goto('/?tab=versions');
      const row = page.getByRole('row').filter({ hasText: name });
      await expect(row).toBeVisible();
      // Asks first (in-app confirm); Cancel keeps it.
      await row.getByRole('button', { name: `Delete ${name}` }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
      await expect(row).toBeVisible();
      // Delete, then Undo within 10 s: the row comes back and the version is still on the server.
      await row.getByRole('button', { name: `Delete ${name}` }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
      await expect(row).toHaveCount(0);
      await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
      await expect(row).toBeVisible();
      await page.waitForTimeout(11_000);
      expect((await request.get(`/api/v1/saved-versions/${id}`)).status()).toBe(200);
      // Delete without Undo: gone on the server after 10 s, and after a reload.
      await row.getByRole('button', { name: `Delete ${name}` }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
      await expect(page.locator('.sc-status')).toHaveText(`"${name}" was deleted.`, { timeout: 20_000 });
      expect((await request.get(`/api/v1/saved-versions/${id}`)).status()).toBe(404);
      await page.reload();
      await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(0);
    } finally {
      await request.delete(`/api/v1/saved-versions/${id}`, { data: {} });
    }
  });
});
