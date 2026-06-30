#!/usr/bin/env node
// scripts/quick-screenshot.mjs
// Quick Playwright screenshots of key features.
// Injects auth token and sends prompts directly.

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Load .env.local
const envPath = join(ROOT, '.env.local');
const envLines = readFileSync(envPath, 'utf-8').split('\n');
const env = {};
for (const line of envLines) {
  const [k, ...v] = line.split('=');
  if (k && !k.startsWith('#') && k.trim()) env[k.trim()] = v.join('=').trim();
}

const BASE_URL = 'http://localhost:5800';
const ACCESS_TOKEN = process.env.GOOGLE_ACCESS_TOKEN || env.GOOGLE_ACCESS_TOKEN || '';
const SCREENSHOTS_DIR = join(ROOT, 'test-results', 'new-features', 'screenshots');
if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const TESTS = [
  { id: '01_dq_profile', prompt: 'profile the order_items table in ecomm' },
  { id: '02_dq_nulls_clean', prompt: 'check null rates in the users table in ecomm' },
  { id: '03_monitoring_jobs', prompt: 'show my recent BigQuery job history' },
  { id: '04_discovery_search', prompt: 'search for tables related to orders in ecomm' },
  { id: '05_data_loading', prompt: 'export the users table in ecomm to Google Sheets' },
];

async function main() {
  console.log('\nLaunching Playwright...');
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--no-sandbox', '--disable-gpu'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });

  // Auth injection
  const authPage = await context.newPage();
  await authPage.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await authPage.evaluate((token) => {
    sessionStorage.setItem('bq_access_token', token);
  }, ACCESS_TOKEN);
  await authPage.evaluate(async (token) => {
    await fetch('/api/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  }, ACCESS_TOKEN);
  await authPage.reload({ waitUntil: 'networkidle', timeout: 20000 });
  
  try {
    await authPage.waitForSelector('textarea[placeholder]', { timeout: 10000 });
    console.log('Auth injected, chat interface loaded\n');
  } catch {
    console.log('Warning: Chat interface not detected after auth injection\n');
  }
  await authPage.close();

  for (const test of TESTS) {
    process.stdout.write(`[${test.id}] "${test.prompt}"... `);
    const page = await context.newPage();
    try {
      await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 20000 });
      await page.evaluate((token) => {
        sessionStorage.setItem('bq_access_token', token);
      }, ACCESS_TOKEN);

      const textarea = await page.waitForSelector('textarea[placeholder]', { timeout: 12000 }).catch(() => null);
      if (!textarea) {
        console.log('no textarea found');
        await page.close();
        continue;
      }

      await textarea.click();
      await textarea.fill(test.prompt);
      await page.keyboard.press('Enter');

      // Wait for response
      await page.waitForFunction(() => {
        const spinners = document.querySelectorAll('.spark-spinner, .crystal-ball-spinner');
        const statusEl = document.querySelector('[class*="statusText"]');
        const hasStatus = statusEl && statusEl.textContent && statusEl.textContent.trim().length > 0;
        const artifacts = document.querySelectorAll('[class*="artifact"], [class*="Artifact"]');
        // Wait until: no spinners, no status text, and at least one artifact
        return spinners.length === 0 && !hasStatus && artifacts.length > 0;
      }, { timeout: 90000 }).catch(async () => {
        console.log('(timeout, capturing anyway) ');
        await page.waitForTimeout(10000);
      });

      await page.waitForTimeout(2000);

      const path = join(SCREENSHOTS_DIR, `${test.id}.png`);
      await page.screenshot({ path, fullPage: false, type: 'png' });
      console.log('saved');
    } catch (err) {
      console.log(`failed: ${err.message}`);
    } finally {
      await page.close();
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  await browser.close();
  console.log(`\nScreenshots in: ${SCREENSHOTS_DIR}\n`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
