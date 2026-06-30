#!/usr/bin/env node
// scripts/screenshot-headed.mjs
// Launches a VISIBLE Chrome window so the user can sign in via Google popup.
// After auth, the script sends prompts and captures screenshots automatically.
// Uses a single page -- clicks "+ New" for each fresh conversation.

import { mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SCREENSHOTS_DIR = join(ROOT, 'test-results', 'new-features', 'screenshots');
if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const APP_URL = 'https://bigqueryaif.web.app';

const TESTS = [
  { id: '01_dq_profile', prompt: 'profile the order_items table in ecomm', wait: 120000 },
  { id: '02_dq_nulls_clean', prompt: 'check null rates in the users table in ecomm', wait: 120000 },
  { id: '03_monitoring_jobs', prompt: 'show my recent BigQuery job history', wait: 120000 },
  { id: '04_discovery_search', prompt: 'search for tables related to orders in ecomm', wait: 120000 },
  { id: '05_data_loading', prompt: 'export the users table in ecomm to Google Sheets', wait: 120000 },
];

async function waitForResponse(page, timeoutMs) {
  // Wait until:
  // 1. The follow-up textarea placeholder says "Ask a follow-up..." (response done)
  // 2. OR a "Regenerate" button appears
  // 3. AND no spinners/status text visible
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const done = await page.evaluate(() => {
      // Check for follow-up textarea (appears after response is complete)
      const textareas = document.querySelectorAll('textarea');
      const hasFollowUp = Array.from(textareas).some(
        ta => ta.placeholder && ta.placeholder.toLowerCase().includes('follow')
      );

      // Check for Regenerate button
      const buttons = document.querySelectorAll('button');
      const hasRegen = Array.from(buttons).some(
        btn => btn.textContent && btn.textContent.includes('Regenerate')
      );

      // Check spinners are gone
      const hasSpinner = document.querySelector(
        '[class*="spinner"], [class*="Spinner"], [class*="loading"], [class*="Loading"]'
      );

      // Check status text is gone
      const statusEls = document.querySelectorAll('[class*="statusText"], [class*="StatusText"], [class*="status-text"]');
      const hasStatus = Array.from(statusEls).some(
        el => el.textContent && el.textContent.trim().length > 0
      );

      return (hasFollowUp || hasRegen) && !hasSpinner && !hasStatus;
    });

    if (done) return true;
    await page.waitForTimeout(2000);
  }
  return false;
}

async function main() {
  console.log('\n=== Live App Screenshot Capture (Headed) ===\n');
  console.log('A Chrome window will open. Please sign in with Google when prompted.');
  console.log('After sign-in, the script will run prompts automatically.\n');

  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });

  const page = await context.newPage();
  await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });

  // Wait for the user to sign in
  console.log('Waiting for sign-in (looking for chat textarea)...');
  console.log('>>> Please click "Sign in with Google" in the browser window <<<\n');

  try {
    await page.waitForSelector('textarea', { timeout: 600000 }); // 10 min max
    console.log('Sign-in complete. Chat interface detected.\n');
  } catch {
    console.log('Timed out waiting for sign-in. Exiting.');
    await browser.close();
    process.exit(1);
  }

  await page.waitForTimeout(2000);

  // Run each test on the same page
  for (let i = 0; i < TESTS.length; i++) {
    const test = TESTS[i];
    console.log(`[${test.id}] "${test.prompt}"`);

    try {
      // For tests after the first, click "+ New" to start fresh
      if (i > 0) {
        // Click the "+ New" button in the sidebar
        const newBtn = await page.$('text=New');
        if (newBtn) {
          await newBtn.click();
          await page.waitForTimeout(2000);
          console.log('  Started new conversation.');
        } else {
          // Fallback: navigate directly
          await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 20000 });
          await page.waitForTimeout(3000);
        }
      }

      // Find and fill textarea
      const ta = await page.waitForSelector('textarea', { timeout: 30000 });
      if (!ta) {
        console.log('  No textarea found, skipping');
        continue;
      }

      await ta.click();
      await ta.fill(test.prompt);
      await page.keyboard.press('Enter');
      console.log('  Prompt submitted, waiting for response...');

      // Wait for response to complete
      const completed = await waitForResponse(page, test.wait);
      if (completed) {
        console.log('  Response complete.');
      } else {
        console.log('  Response timeout -- capturing current state.');
      }

      // Extra time for animations
      await page.waitForTimeout(3000);

      // Take screenshot
      const path = join(SCREENSHOTS_DIR, `${test.id}.png`);
      await page.screenshot({ path, fullPage: false, type: 'png' });
      console.log(`  Saved: ${path}\n`);

    } catch (err) {
      console.log(`  Error: ${err.message}`);
      try {
        await page.screenshot({
          path: join(SCREENSHOTS_DIR, `${test.id}_error.png`),
          fullPage: false,
        });
      } catch {}
    }

    // Brief pause between tests
    await new Promise(r => setTimeout(r, 2000));
  }

  await browser.close();
  console.log(`\nAll done. Screenshots in:\n  ${SCREENSHOTS_DIR}\n`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

