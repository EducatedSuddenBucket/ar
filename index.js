const fs = require('fs');
const path = require('path');
const fetch = global.fetch || require('node-fetch');
const { chromium } = require('playwright');

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms)
    )
  ]);
}

(async () => {
  try {
    const { default: pLimit } = await import('p-limit');

    const jsonUrl = 'https://raw.githubusercontent.com/is-a-dev/raw-api/main/v2.json';
    const response = await fetch(jsonUrl);
    const records = await response.json();

    const eligible = records.filter(entry => {
      if (entry.reserved) return false;
      if (entry.domain && entry.domain.startsWith('_')) return false;
      if (entry.subdomain && entry.subdomain.startsWith('_')) return false;
      return true;
    });

    const currentDate = new Date().toISOString().slice(0, 10);

    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

    const limit = pLimit(10);

    const results = [];

    console.log(`Processing ${eligible.length} domains...`);

    await Promise.all(eligible.map(entry => limit(async () => {
      const domain = entry.domain;
      const targetUrl = `https://${domain}`;
      const dirPath = path.join(process.cwd(), domain, currentDate);
      fs.mkdirSync(dirPath, { recursive: true });
      const screenshotPath = path.join(dirPath, 'screenshot.png');

      let domainRecord = { domain, dates: [] };

      const context = await browser.newContext();
      const page = await context.newPage();
      console.log(`Capturing screenshot for ${domain} from ${targetUrl} ...`);

      let navError = null;
      try {
        try {
          await withTimeout(
            page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 7000 }),
            7000
          );
        } catch (error) {
          navError = error;
          console.warn(`Navigation error for ${domain}: ${error.message}`);
        }

        if (
          navError &&
          (navError.message.includes('ERR_NAME_NOT_RESOLVED') ||
           navError.message.includes('ERR_CERT') ||
           navError.message.includes('net::ERR'))
        ) {
          console.error(`Critical error for ${domain}: ${navError.message}. Skipping screenshot.`);
          await page.close();
          await context.close();
          return;
        }

        try {
          await withTimeout(
            page.screenshot({ path: screenshotPath, fullPage: true }),
            7000
          );
          console.log(`Saved screenshot for ${domain} at ${screenshotPath}`);
          domainRecord.dates.push({
            date: currentDate,
            screenshot: path.join(domain, currentDate, 'screenshot.png').replace(/\\/g, '/')
          });
        } catch (shotError) {
          console.error(`Screenshot capture failed for ${domain}: ${shotError.message}`);
        }
      } catch (err) {
        console.error(`Error processing ${domain}: ${err.message}`);
      }
      await page.close();
      await context.close();

      if (domainRecord.dates.length > 0) {
        results.push(domainRecord);
      }
    })));

    await browser.close();

    const apiDir = path.join(process.cwd(), 'api');
    fs.mkdirSync(apiDir, { recursive: true });
    const indexFilePath = path.join(apiDir, 'index.json');
    let existingData = { domains: [] };
    if (fs.existsSync(indexFilePath)) {
      try {
        existingData = JSON.parse(fs.readFileSync(indexFilePath, 'utf-8'));
      } catch (err) {
        console.error('Error parsing existing index.json, starting fresh:', err.message);
      }
    }

    results.forEach(newRecord => {
      const existingDomain = existingData.domains.find(d => d.domain === newRecord.domain);
      if (existingDomain) {
        newRecord.dates.forEach(newDate => {
          if (!existingDomain.dates.some(d => d.date === newDate.date)) {
            existingDomain.dates.push(newDate);
          }
        });
      } else {
        existingData.domains.push(newRecord);
      }
    });

    fs.writeFileSync(indexFilePath, JSON.stringify(existingData, null, 2));
    console.log('Generated api/index.json');

  } catch (error) {
    console.error('Error occurred:', error);
  }
})();
