import { chromium } from 'playwright';

const siteUrl = process.env.MPL_SITE_URL || 'https://mobarakehpl.ir/';
const responseTimeoutMs = 4 * 60 * 1000;
const responseBodyTimeoutMs = 30 * 1000;
const retryDelayMs = 5 * 60 * 1000;

function isSyncRequest(request) {
  const postData = request.postData() || '';
  return request.method() === 'POST'
    && request.url().includes('admin-ajax.php')
    && /(?:^|&)action=mpl_browser_sync(?:&|$)/.test(postData);
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
  const responsePromise = page.waitForResponse(isSyncRequestResponse, { timeout: responseTimeoutMs })
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
    console.error(`No matching mpl_browser_sync AJAX response within ${responseTimeoutMs / 1000}s: ${outcome.error.message}`);
    await logPageDiagnostics(page, label);
    throw new Error('Site did not return the expected WordPress browser-sync AJAX response.');
  }

  const response = outcome.response;
  console.log(`${label}: matched sync response headers received; HTTP ${response.status()} ${response.url()}`);
  let body;
  try {
    body = await withTimeout(response.text(), responseBodyTimeoutMs, 'Reading sync AJAX response body');
  } catch (error) {
    console.error(`${label}: response body could not be read: ${error.message}`);
    console.error(`${label}: response headers=${JSON.stringify(await response.allHeaders().catch(() => ({}))) }`);
    throw new Error('WordPress received the sync request but its response body did not finish in time; check PHP/server-side sync execution.');
  }

  console.log(`${label}: sync response body (${body.length} chars) = ${body.slice(0, 4000)}`);
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`Sync endpoint did not return valid JSON (HTTP ${response.status()}).`);
  }
  if (!response.ok() || json?.success !== true) {
    throw new Error(`WordPress browser-sync AJAX returned an error (HTTP ${response.status()}; success=${json?.success}).`);
  }
  return json.data || {};
}

// Match the response only when its originating request contains the expected action.
async function isSyncRequestResponse(response) {
  return isSyncRequest(response.request());
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
  page.on('requestfinished', request => {
    if (isSyncRequest(request)) console.log(`Sync AJAX request finished downloading: ${request.method()} ${request.url()}`);
  });
  page.on('pageerror', error => console.error(`Browser JavaScript error: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') console.error(`Browser console error: ${message.text()}`);
  });
  page.on('request', request => {
    if (request.url().includes('library-browser-sync') || request.url().includes('admin-ajax.php')) {
      const sync = isSyncRequest(request);
      console.log(`Relevant request${sync ? ' [MATCHED mpl_browser_sync]' : ''}: ${request.method()} ${request.url()}`);
      if (sync) console.log(`Sync AJAX POST data: ${(request.postData() || '').slice(0, 1000)}`);
    }
  });
  page.on('response', response => {
    if (response.url().includes('library-browser-sync') || response.url().includes('admin-ajax.php')) {
      const sync = isSyncRequest(response.request());
      console.log(`Relevant response${sync ? ' [MATCHED mpl_browser_sync]' : ''}: HTTP ${response.status()} ${response.url()}`);
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
