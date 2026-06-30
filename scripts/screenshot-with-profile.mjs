#!/usr/bin/env node
// scripts/screenshot-with-profile.mjs
// Launches Playwright using the user's Chrome profile (already authenticated),
// sends prompts, waits for results, and captures screenshots.

import { mkdirSync, existsSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SCREENSHOTS_DIR = join(ROOT, 'test-results', 'new-features', 'screenshots');
if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const APP_URL = 'https://bigqueryaif.web.app';

// Copy Chrome profile to temp dir (Chrome locks its profile)
const CHROME_PROFILE = join(process.env.HOME, 'Library/Application Support/Google/Chrome');
const TEMP_PROFILE = join(ROOT, 'test-results', '.chrome-profile');

const TESTS = [
  { id: '01_dq_profile', prompt: 'profile the order_items table in ecomm', wait: 45000 },
  { id: '02_dq_nulls_clean', prompt: 'check null rates in the users table in ecomm', wait: 40000 },
  { id: '03_monitoring_jobs', prompt: 'show my recent BigQuery job history', wait: 40000 },
  { id: '04_discovery_search', prompt: 'search for tables related to orders in ecomm', wait: 40000 },
  { id: '05_data_loading', prompt: 'export the users table in ecomm to Google Sheets', wait: 45000 },
];

async function main() {
  console.log('\nPreparing Chrome profile copy...');
  
  // Copy Chrome profile (just Default dir for cookies/auth)
  if (existsSync(TEMP_PROFILE)) {
    // Clean up old copy
    const { execSync } = await import('child_process');
    execSync(`rm -rf "${TEMP_PROFILE}"`);
  }
  mkdirSync(TEMP_PROFILE, { recursive: true });
  
  // Copy just the essential auth files
  const defaultSrc = join(CHROME_PROFILE, 'Default');
  const defaultDst = join(TEMP_PROFILE, 'Default');
  mkdirSync(defaultDst, { recursive: true });
  
  // Copy critical files for auth persistence
  for (const subdir of ['IndexedDB', 'Local Storage', 'Session Storage', 'databases', 'Local Extension Settings']) {
    const src = join(defaultSrc, subdir);
    if (existsSync(src)) {
      try { cpSync(src, join(defaultDst, subdir), { recursive: true }); } catch (e) { console.log(`  Skipped ${subdir}: ${e.code}`); }
    }
  }
  // Copy preferences (skip cookies/login data which are OS-protected)
  for (const file of ['Preferences', 'Secure Preferences']) {
    const src = join(defaultSrc, file);
    if (existsSync(src)) {
      try { cpSync(src, join(defaultDst, file)); } catch (e) { console.log(`  Skipped ${file}: ${e.code}`); }
    }
  }
  // Copy Local State from parent
  const localStateSrc = join(CHROME_PROFILE, 'Local State');
  if (existsSync(localStateSrc)) {
    cpSync(localStateSrc, join(TEMP_PROFILE, 'Local State'));
  }

  console.log('Launching Chrome with copied profile...\n');
  
  const browser = await chromium.launchPersistentContext(TEMP_PROFILE, {
    channel: 'chrome',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
    ],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    ignoreDefaultArgs: ['--disable-extensions'],
  });

  try {
    // Check if auth works
    const testPage = await browser.newPage();
    await testPage.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });
    
    // Wait a bit for auth to initialize
    await testPage.waitForTimeout(5000);
    
    // Check if we see the chat textarea
    const textarea = await testPage.$('textarea');
    if (!textarea) {
      console.log('Auth failed - no textarea found. Taking screenshot of auth state...');
      await testPage.screenshot({ 
        path: join(SCREENSHOTS_DIR, '00_auth_state.png'),
        fullPage: false 
      });
      console.log('Saved auth state screenshot.');
      
      // Try to check what's on the page
      const bodyText = await testPage.evaluate(() => document.body?.innerText?.substring(0, 500));
      console.log('Page content:', bodyText);
      
      await testPage.close();
      await browser.close();
      return;
    }
    
    console.log('Auth OK - chat interface loaded\n');
    await testPage.close();

    // Run each test
    for (const test of TESTS) {
      process.stdout.write(`[${test.id}] "${test.prompt}"... `);
      
      const page = await browser.newPage();
      try {
        await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 20000 });
        await page.waitForTimeout(3000);
        
        const ta = await page.waitForSelector('textarea', { timeout: 10000 });
        if (!ta) {
          console.log('no textarea');
          await page.close();
          continue;
        }

        // Type prompt and submit
        await ta.click();
        await ta.fill(test.prompt);
        await page.keyboard.press('Enter');

        // Wait for artifact to render
        try {
          await page.waitForFunction(() => {
            // Look for any artifact card or result container
            const artifacts = document.querySelectorAll(
              '[class*="artifact"], [class*="Artifact"], [class*="result"], [class*="card"]'
            );
            // Also check that loading indicators are gone
            const spinners = document.querySelectorAll(
              '.spark-spinner, .crystal-ball-spinner, [class*="spinner"], [class*="loading"]'
            );
            // Check the status text is empty
            const statusEls = document.querySelectorAll('[class*="statusText"], [class*="status-text"]');
            const hasStatus = Array.from(statusEls).some(el => el.textContent && el.textContent.trim().length > 0);
            
            return artifacts.length > 0 && spinners.length === 0 && !hasStatus;
          }, { timeout: test.wait });
        } catch {
          console.log('(response timeout, capturing anyway) ');
        }

        // Extra settle time for animations
        await page.waitForTimeout(3000);

        // Take screenshot
        const path = join(SCREENSHOTS_DIR, `${test.id}.png`);
        await page.screenshot({ path, fullPage: false, type: 'png' });
        console.log('saved');
      } catch (err) {
        console.log(`error: ${err.message}`);
        // Save error state screenshot
        try {
          await page.screenshot({ 
            path: join(SCREENSHOTS_DIR, `${test.id}_error.png`),
            fullPage: false 
          });
        } catch {}
      } finally {
        await page.close();
      }

      // Brief pause between tests
      await new Promise(r => setTimeout(r, 2000));
    }

  } finally {
    await browser.close();
    // Clean up temp profile
    const { execSync } = await import('child_process');
    execSync(`rm -rf "${TEMP_PROFILE}"`);
  }

  console.log(`\nScreenshots saved to: ${SCREENSHOTS_DIR}\n`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
