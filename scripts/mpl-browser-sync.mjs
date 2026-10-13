import { chromium } from 'playwright';

const siteUrl = process.env.MPL_SITE_URL || 'https://mobarakehpl.ir/';
const responseTimeoutMs = 6 * 60 * 1000;
const retryDelayMs = 5 * 60 * 1000;
const maxVisits = 5;

function isSyncResponse(response) {
  const request = response.request();
  const postData = request.postData() || '';
  return request.method() === 'POST'
    && response.url().includes('admin-ajax.php')
    && /(?:^|&)action=mpl_browser_sync(?:&|$)/.test(postData);
}

async function describePage(page) {
  const info = { url: page.url() };
  try { info.title = await page.title(); } catch (error) { info.title_error = error.message; }
  try {
    info.body = (await page.locator('body').innerText({ timeout: 3000 })).slice(0, 500);
  } catch (error) {
    info.body_error = error.message;
  }
  return info;
}

async function visitAndWaitForSync(page, visitNumber) {
  console.log(`Browser visit ${visitNumber}/${maxVisits}: opening ${siteUrl}`);

  // Attach a rejection handler immediately; navigation errors must not be
  // obscured by a secondary unhandled waitForResponse rejection.
  const responseOutcome = page.waitForResponse(isSyncResponse, {
    timeout: responseTimeoutMs,
  }).then(
    response => ({ response }),
    error => ({ error })
  );

  try {
    if (visitNumber === 1) {
      await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    } else {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
    }
  } catch (error) {
    console.error('Page navigation failed:', error.message);
    console.error('Page state:', JSON.stringify(await describePage(page)));
    throw new Error(`Could not load the site in Chromium: ${error.message}`);
  }

  const outcome = await responseOutcome;
  if (outcome.error) {
    console.error('No browser-sync AJAX response was observed:', outcome.error.message);
    console.error('Page state:', JSON.stringify(await describePage(page)));
    throw new Error('The site loaded but did not issue its mpl_browser_sync AJAX request. Check the hosting challenge or whether the browser-sync script was loaded.');
  }

  const response = outcome.response;
  let body;
  try {
    body = await response.json();
  } catch {
    console.error('Page state:', JSON.stringify(await describePage(page)));
    throw new Error(`AJAX response was not JSON (HTTP ${response.status()}). The host may have returned a challenge or block page.`);
  }

  console.log(`Visit ${visitNumber}: HTTP ${response.status()}, response=${JSON.stringify(body)}`);
  if (!response.ok() || body?.success !== true) {
    throw new Error(`Browser sync endpoint failed on visit ${visitNumber}.`);
  }
  return body.data || {};
}

const browser = await chromium.launch({ headless: false });
try {
  const context = await browser.newContext({
    viewport: { width: 1365, height: 900 },
    locale: 'fa-IR',
    timezoneId: 'Asia/Tehran',
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(120_000);
  page.on('requestfailed', request => {
    console.log(`Request failed: ${request.method()} ${request.url()} :: ${request.failure()?.errorText || 'unknown'}`);
  });

  for (let visit = 1; visit <= maxVisits; visit++) {
    const result = await visitAndWaitForSync(page, visit);

    if (result.started === true) {
      const updated = Number(result.updated);
      if (!Number.isFinite(updated) || updated < 1) {
        throw new Error(`The endpoint responded but reported an unexpected updated count: ${result.updated}`);
      }
      console.log(`SYNC_STARTED=true; UPDATED_LIBRARIES=${updated}; TIME_GMT=${result.time_gmt || 'unknown'}`);
      break;
    }

    if (result.reason !== 'not_due') {
      throw new Error(`The sync did not start (reason: ${result.reason || 'unknown'}).`);
    }

    if (visit === maxVisits) {
      throw new Error(`The six-hour window was still not due after ${maxVisits} browser visits.`);
    }

    console.log(`Six-hour window is not due yet. Waiting five minutes before visit ${visit + 1}.`);
    await page.waitForTimeout(retryDelayMs);
  }
} finally {
  await browser.close();
}
