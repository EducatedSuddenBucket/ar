const fs = require('fs');
const path = require('path');
const fetch = global.fetch || require('node-fetch');
const { chromium } = require('playwright');
const pLimit = require('p-limit');

// Helper: Wraps a promise so that it rejects if not settled within ms milliseconds.
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
    // Fetch JSON data from the remote endpoint.
    const jsonUrl = 'https://raw.is-a.dev';
    const response = await fetch(jsonUrl);
    const records = await response.json();

    // Filter out entries that are reserved or have domains/subdomains starting with an underscore.
    const eligible = records.filter(entry => {
      if (entry.reserved) return false;
      if (entry.domain && entry.domain.startsWith('_')) return false;
      if (entry.subdomain && entry.subdomain.startsWith('_')) return false;
      return true;
    });

    // Use current date in "yyyy-mm-dd" format.
    const currentDate = new Date().toISOString().slice(0, 10);

    // Launch Playwright browser.
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

    // Limit concurrency to avoid overloading the system.
    const limit = pLimit(10);

    // This will collect JSON data for each domain.
    const results = [];

    console.log(`Processing ${eligible.length} domains...`);

    // Process each domain concurrently under the concurrency limit.
    await Promise.all(eligible.map(entry => limit(async () => {
      const domain = entry.domain;
      const targetUrl = `https://${domain}`;
      const dirPath = path.join(process.cwd(), domain, currentDate);
      fs.mkdirSync(dirPath, { recursive: true });
      const screenshotPath = path.join(dirPath, 'screenshot.png');

      // Prepare a record for JSON output.
      let domainRecord = { domain, dates: [] };

      // Create a new context and page for isolation.
      const context = await browser.newContext();
      const page = await context.newPage();
      console.log(`Capturing screenshot for ${domain} from ${targetUrl} ...`);

      let navError = null;
      try {
        // Attempt navigation with a 7-second timeout.
        try {
          await withTimeout(
            page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 7000 }),
            7000
          );
        } catch (error) {
          navError = error;
          console.warn(`Navigation error for ${domain}: ${error.message}`);
        }

        // If a critical error (like NXDOMAIN/SSL error) occurred, skip screenshot.
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

        // Take screenshot regardless of partial load (with a 7-second timeout).
        try {
          await withTimeout(
            page.screenshot({ path: screenshotPath, fullPage: true }),
            7000
          );
          console.log(`Saved screenshot for ${domain} at ${screenshotPath}`);
          // Add this capture to our JSON record.
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

      // Only include domains with at least one successful screenshot.
      if (domainRecord.dates.length > 0) {
        results.push(domainRecord);
      }
    })));

    await browser.close();

    // Generate api/index.json with archive data.
    const apiDir = path.join(process.cwd(), 'api');
    fs.mkdirSync(apiDir, { recursive: true });
    const jsonOutput = { domains: results };
    fs.writeFileSync(path.join(apiDir, 'index.json'), JSON.stringify(jsonOutput, null, 2));
    console.log('Generated api/index.json');

    // Generate index.html with a search bar and dynamic UI.
    const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Archive Index</title>
  <style>
    body { font-family: Arial, sans-serif; background-color: #0F0C19; color: #fff; margin: 20px; }
    .header { text-align: center; margin-bottom: 20px; }
    input[type="text"] { width: 300px; padding: 10px; border: none; border-radius: 5px; margin-bottom: 20px; }
    .domain { margin-bottom: 20px; }
    .domain h2 { cursor: pointer; background: #4E3AA3; padding: 10px; border-radius: 5px; }
    .date-list { display: none; margin-left: 20px; }
    .date-item { margin-bottom: 10px; }
    img { max-width: 100%; border: 1px solid #ccc; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Archive Index</h1>
    <input type="text" id="search" placeholder="Search domains..." onkeyup="filterDomains()" />
  </div>
  <div id="archive"></div>
  <script>
    async function loadData() {
      const response = await fetch('api/index.json');
      const data = await response.json();
      renderArchive(data);
    }
    function renderArchive(data) {
      const archiveDiv = document.getElementById('archive');
      archiveDiv.innerHTML = '';
      data.domains.forEach(domainData => {
        const domainDiv = document.createElement('div');
        domainDiv.className = 'domain';
        const header = document.createElement('h2');
        header.textContent = domainData.domain;
        header.onclick = () => {
          const list = domainDiv.querySelector('.date-list');
          list.style.display = list.style.display === 'none' ? 'block' : 'none';
        };
        domainDiv.appendChild(header);
        const dateList = document.createElement('div');
        dateList.className = 'date-list';
        domainData.dates.forEach(dateEntry => {
          const dateItem = document.createElement('div');
          dateItem.className = 'date-item';
          const dateHeader = document.createElement('h3');
          dateHeader.textContent = dateEntry.date;
          dateHeader.onclick = () => {
            const imgEl = dateItem.querySelector('img');
            imgEl.style.display = imgEl.style.display === 'none' ? 'block' : 'none';
          };
          const imgEl = document.createElement('img');
          imgEl.src = dateEntry.screenshot;
          imgEl.style.display = 'none';
          dateItem.appendChild(dateHeader);
          dateItem.appendChild(imgEl);
          dateList.appendChild(dateItem);
        });
        domainDiv.appendChild(dateList);
        archiveDiv.appendChild(domainDiv);
      });
    }
    function filterDomains() {
      const query = document.getElementById('search').value.toLowerCase();
      const domains = document.querySelectorAll('.domain');
      domains.forEach(domainDiv => {
        const header = domainDiv.querySelector('h2');
        domainDiv.style.display = header.textContent.toLowerCase().includes(query) ? '' : 'none';
      });
    }
    loadData();
  </script>
</body>
</html>`;
    fs.writeFileSync(path.join(process.cwd(), 'index.html'), htmlContent);
    console.log('Generated index.html');

  } catch (error) {
    console.error('Error occurred:', error);
  }
})();
