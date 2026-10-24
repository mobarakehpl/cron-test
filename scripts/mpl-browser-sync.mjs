import { chromium } from 'playwright';

const siteUrl = process.env.MPL_SITE_URL || 'https://mobarakehpl.ir/';
const responseTimeoutMs = 4 * 60 * 1000;
const retryDelayMs = 5 * 60 * 1000;

function isSyncResponse(response) {
  const request = response.request();
  const postData = request.postData() || '';
  return request.method() === 'POST'
    && response.url().includes('admin-ajax.php')
    && /(?:^|&)action=mpl_browser_sync(?:&|$)/.test(postData);
}

async function logPageDiagnostics(page, label) {
  console.error(`${label}: URL=${page.url()}`);
  try { console.error(`${label}: title=${await page.title()}`); } catch {}
  try {
    const state = await page.evaluate(() => ({
      scripts: Array.from(document.scripts).map(script => script.src).filter(Boolean),
      syncScripts: Array.from(document.scripts).map(script => script.src)
        .filter(src => src.includes('library-browser-sync')),
      resources: performance.getEntriesByType('resource')
        .map(entry => entry.name)
        .filter(url => url.includes('library-browser-sync') || url.includes('admin-ajax.php')),
      excerpt: (document.body?.innerText || '').slice(0, 800),
    }));
    console.error(`${label}: page diagnostics=${JSON.stringify(state)}`);
  } catch (error) {
    console.error(`${label}: could not collect page diagnostics: ${error.message}`);
  }
}

async function browserVisit(page, label, reload = false) {
  console.log(`${label}: opening ${siteUrl}`);
  const responsePromise = page.waitForResponse(isSyncResponse, { timeout: responseTimeoutMs })
    .then(response => ({ response }), error => ({ error }));

  try {
    if (reload) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
    } else {
      await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    }
  } catch (error) {
    console.error(`Navigation error: ${error.message}`);
    await logPageDiagnostics(page, label);
    throw error;
  }

  const outcome = await responsePromise;
  if (outcome.error) {
    console.error(`No sync AJAX response within ${responseTimeoutMs / 1000}s: ${outcome.error.message}`);
    await logPageDiagnostics(page, label);
    throw new Error('Site did not issue the expected WordPress browser-sync AJAX request.');
  }

  const response = outcome.response;
  let json;
  try {
    json = await response.json();
  } catch {
    throw new Error(`Sync endpoint did not return JSON (HTTP ${response.status()}).`);
  }
  console.log(`${label}: HTTP ${response.status()}, JSON=${JSON.stringify(json)}`);
  if (!response.ok() || json?.success !== true) {
    throw new Error('WordPress browser-sync AJAX returned an error.');
  }
  return json.data || {};
}

const browser = await chromium.launch({ headless: false, channel: 'chromium' });
try {
  // Temporary diagnostic workaround for the hosting certificate error.
  // This public-page-only browser does not sign in; certificate authenticity
  // is not verified, so this is not a secure long-term fix.
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1365, height: 900 },
    locale: 'fa-IR',
    timezoneId: 'Asia/Tehran',
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(120_000);
  page.on('requestfailed', request => {
    console.log(`Request failed: ${request.method()} ${request.url()} :: ${request.failure()?.errorText || 'unknown'}`);
  });
  page.on('pageerror', error => console.error(`Browser JavaScript error: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') console.error(`Browser console error: ${message.text()}`);
  });
  page.on('request', request => {
    if (request.url().includes('library-browser-sync') || request.url().includes('admin-ajax.php')) {
      console.log(`Relevant request: ${request.method()} ${request.url()}`);
    }
  });
  page.on('response', response => {
    if (response.url().includes('library-browser-sync') || response.url().includes('admin-ajax.php')) {
      console.log(`Relevant response: HTTP ${response.status()} ${response.url()}`);
    }
  });

  let result = await browserVisit(page, 'Browser visit 1');
  if (result.started === false && result.reason === 'not_due') {
    console.log('Six-hour window not due; retrying once after five minutes.');
    await page.waitForTimeout(retryDelayMs);
    result = await browserVisit(page, 'Browser visit 2', true);
  }

  if (result.started !== true) {
    throw new Error(`Sync did not start: ${result.reason || 'unknown reason'}`);
  }
  const updated = Number(result.updated);
  if (!Number.isFinite(updated) || updated < 1) {
    throw new Error(`Expected updated library count >= 1; got ${result.updated}`);
  }
  console.log(`SYNC_STARTED=true; UPDATED_LIBRARIES=${updated}; TIME_GMT=${result.time_gmt || 'unknown'}`);
} finally {
  await browser.close();
}
