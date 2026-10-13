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

async function visitAndWaitForSync(page, visitNumber) {
  console.log(`Browser visit ${visitNumber}/${maxVisits}: opening ${siteUrl}`);
  const responsePromise = page.waitForResponse(isSyncResponse, {
    timeout: responseTimeoutMs,
  });

  if (visitNumber === 1) {
    await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  } else {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
  }

  const response = await responsePromise;
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      `AJAX response was not JSON (HTTP ${response.status()}). The site may have returned a hosting challenge instead of WordPress JSON.`
    );
  }

  console.log(`Visit ${visitNumber}: HTTP ${response.status()}, response=${JSON.stringify(body)}`);
  if (!response.ok() || body?.success !== true) {
    throw new Error(`Browser sync endpoint failed on visit ${visitNumber}.`);
  }
  return body.data || {};
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1365, height: 900 },
    locale: 'fa-IR',
    timezoneId: 'Asia/Tehran',
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(120_000);

  let result;
  for (let visit = 1; visit <= maxVisits; visit++) {
    result = await visitAndWaitForSync(page, visit);

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
