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
  { id: '01_storage_breakdown', prompt: 'show me a storage breakdown for this project', wait: 120000 },
  { id: '02_access_patterns', prompt: 'who has been querying my data in the last 30 days', wait: 120000 },
  { id: '03_cost_analysis', prompt: 'analyze my BigQuery query costs over the last month', wait: 120000 },
  { id: '04_freshness', prompt: 'which tables have not been updated recently', wait: 120000 },
  { id: '05_completeness', prompt: 'check the completeness of the order_items table in ecomm', wait: 120000 },
  { id: '06_range_validation', prompt: 'validate the sale_price column in ecomm.order_items is between 0 and 10000', wait: 120000 },
  { id: '07_schema_drift', prompt: 'check for schema drift on the order_items table in ecomm', wait: 120000 },
  { id: '08_er_diagram', prompt: 'show me an ER diagram of the ecomm dataset', wait: 120000 },
  { id: '09_lineage', prompt: 'show lineage for the order_items table in ecomm', wait: 120000 },
  { id: '10_comparison', prompt: 'compare the order_items and users tables in the ecomm dataset', wait: 120000 },
];

async function waitForResponse(page, timeoutMs) {
  // Strategy: wait until ACTUAL response content appears in the chat.
  // Response content includes: data tables, cards, headings, insight boxes, or alert views.
  // We also check that status/progress text has stopped appearing.
  const start = Date.now();
  let lastStatusText = '';
  let stableCount = 0;

  while (Date.now() - start < timeoutMs) {
    const state = await page.evaluate(() => {
      // Count real content elements that indicate a response has rendered
      const tables = document.querySelectorAll('table');
      const hasTable = tables.length > 0;

      // Check for response cards/containers (artifact cards, alert views, schema views, etc.)
      const cards = document.querySelectorAll(
        '[class*="artifact"], [class*="Artifact"], [class*="card"], [class*="Card"]'
      );
      const hasCards = cards.length > 0;

      // Check for response headings (h2, h3 inside chat area)
      const headings = document.querySelectorAll('h2, h3');
      const hasHeadings = headings.length > 0;

      // Check for action chips (pill buttons at bottom of responses)
      const chips = document.querySelectorAll('button');
      const actionChips = Array.from(chips).filter(
        btn => btn.textContent && (
          btn.textContent.includes('Save as check') ||
          btn.textContent.includes('Schedule') ||
          btn.textContent.includes('Fix nulls') ||
          btn.textContent.includes('Sample') ||
          btn.textContent.includes('Show most') ||
          btn.textContent.includes('Diagnose') ||
          btn.textContent.includes('View schema') ||
          btn.textContent.includes('Run it now') ||
          btn.textContent.includes('Show current') ||
          btn.textContent.includes('Suggest') ||
          btn.textContent.includes('Explore') ||
          btn.textContent.includes('Query') ||
          btn.textContent.includes('Compare') ||
          btn.textContent.includes('Profile') ||
          btn.textContent.includes('next step') ||
          btn.textContent.includes('details')
        )
      );
      const hasActionChips = actionChips.length > 0;

      // Get current status/progress text (the animated dots text)
      const allText = document.body.innerText || '';
      const statusMatch = allText.match(/(Classifying|Fetching|Running|Analyzing|Reviewing|Querying|Profiling|Checking|Saving|Creating|Matched skill)[^\n]*/i);
      const statusText = statusMatch ? statusMatch[0] : '';

      // Check for the send button being enabled (not disabled) -- indicates input ready
      const sendBtns = document.querySelectorAll('button[type="submit"], button[aria-label*="send"], button[aria-label*="Send"]');
      const sendEnabled = Array.from(sendBtns).some(btn => !btn.disabled);

      const hasContent = hasTable || hasCards || hasHeadings || hasActionChips;

      return { hasContent, statusText, sendEnabled, tableCount: tables.length, chipCount: actionChips.length };
    });

    // If we have real content AND no status text is changing, we're done
    if (state.hasContent && !state.statusText) {
      stableCount++;
      if (stableCount >= 2) {
        return true;
      }
    } else if (state.hasContent && state.statusText === lastStatusText) {
      // Status text stopped changing but content is there -- might be a lingering element
      stableCount++;
      if (stableCount >= 3) {
        return true;
      }
    } else {
      stableCount = 0;
    }

    lastStatusText = state.statusText;
    await page.waitForTimeout(3000);
  }
  return false;
}

async function main() {
  console.log('\n=== Live App Screenshot Capture (Headed) ===\n');
  console.log('A Chrome window will open. Please sign in with Google when prompted.');
  console.log('After sign-in, the script will run prompts automatically.\n');

  const userDataDir = join(ROOT, 'test-results', '.chrome-profile');
  if (!existsSync(userDataDir)) mkdirSync(userDataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
    ],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });

  // Persistent context may have an existing blank page; reuse or create
  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  await page.waitForTimeout(1000);
  console.log('Navigating to', APP_URL, '...');
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Wait for the user to sign in
  console.log('Waiting for sign-in (looking for chat textarea)...');
  console.log('>>> Please click "Sign in with Google" in the browser window <<<\n');

  try {
    await page.waitForSelector('textarea', { timeout: 600000 }); // 10 min max
    console.log('Sign-in complete. Chat interface detected.\n');
  } catch {
    console.log('Timed out waiting for sign-in. Exiting.');
    await context.close();
    process.exit(1);
  }

  await page.waitForTimeout(3000);

  // Select a project if none is active
  const needsProject = await page.evaluate(() => {
    const ta = document.querySelector('textarea');
    return ta && ta.disabled;
  });

  if (needsProject) {
    console.log('No project selected. Selecting project...');
    const projectBtn = await page.$('button.gc-env-chip');
    if (projectBtn) {
      await projectBtn.click();
      console.log('  Opened project dropdown.');
      await page.waitForTimeout(1000);

      // Type 'malloy-data' into the search field to trigger live search
      const searchInput = await page.$('.gc-project-search-input');
      if (searchInput) {
        await searchInput.click();
        await searchInput.fill('malloy-data');
        console.log('  Typed "malloy-data" in search field. Waiting for results...');

        // Wait for search results to appear (live search is debounced)
        try {
          await page.waitForSelector('.gc-project-option', { timeout: 20000 });
          console.log('  Search results loaded.');
        } catch {
          console.log('  No search results appeared. Retrying...');
          await page.waitForTimeout(5000);
        }
      }

      // Screenshot the dropdown state for debugging
      await page.screenshot({
        path: join(SCREENSHOTS_DIR, '00_dropdown_debug.png'),
        fullPage: false, type: 'png',
      });

      // Click the first project option
      const clicked = await page.evaluate(() => {
        const options = document.querySelectorAll('.gc-project-option');
        if (options.length > 0) {
          options[0].click();
          const label = options[0].querySelector('.gc-project-option-label');
          return (label ? label.textContent : options[0].textContent)?.trim() || 'first';
        }
        return null;
      });

      if (clicked) {
        console.log(`  Selected project: ${clicked}`);
      } else {
        console.log('  No project options found. Will try direct navigation.');
      }

      await page.waitForTimeout(3000);
    } else {
      console.log('  Could not find project picker button.');
    }

    // Wait for textarea to become enabled
    try {
      await page.waitForFunction(
        () => {
          const ta = document.querySelector('textarea');
          return ta && !ta.disabled;
        },
        { timeout: 30000 }
      );
      console.log('Project loaded. Textarea enabled.\n');
    } catch {
      console.log('WARNING: Textarea still disabled after project selection.\n');
    }
  }

  // Take auth state screenshot
  const authPath = join(SCREENSHOTS_DIR, '00_auth_state.png');
  await page.screenshot({ path: authPath, fullPage: false, type: 'png' });
  console.log(`Auth state saved: ${authPath}\n`);

  // Run each test on the same page
  for (let i = 0; i < TESTS.length; i++) {
    const test = TESTS[i];
    console.log(`[${test.id}] "${test.prompt}"`);

    try {
      // For tests after the first, click "+ New" to start fresh
      if (i > 0) {
        const newBtn = await page.$('text=New');
        if (newBtn) {
          await newBtn.click();
          await page.waitForTimeout(3000);
          console.log('  Started new conversation.');
        } else {
          await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 20000 });
          await page.waitForTimeout(3000);
        }
      }

      // Wait for textarea to be enabled (project must be loaded)
      await page.waitForFunction(
        () => {
          const ta = document.querySelector('textarea');
          return ta && !ta.disabled;
        },
        { timeout: 60000 }
      );
      console.log('  Textarea enabled (project loaded).');

      const ta = await page.$('textarea');
      if (!ta) {
        console.log('  No textarea found, skipping');
        continue;
      }

      // Use evaluate to set value and trigger React state update
      await page.evaluate((prompt) => {
        const ta = document.querySelector('textarea');
        if (!ta) return;
        // Set value via native setter to trigger React's onChange
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value'
        ).set;
        nativeInputValueSetter.call(ta, prompt);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
      }, test.prompt);

      await page.waitForTimeout(500);

      // Submit via Enter key
      await ta.focus();
      await page.keyboard.press('Enter');
      console.log('  Prompt submitted, waiting for response...');

      // Wait for response to complete
      const completed = await waitForResponse(page, test.wait);
      if (completed) {
        console.log('  Response complete.');
      } else {
        console.log('  Response timeout -- capturing current state.');
      }

      // Extra settle time for animations/rendering
      await page.waitForTimeout(4000);

      // Scroll to bottom of chat to capture the full response
      await page.evaluate(() => {
        const chatArea = document.querySelector('[class*="chatMessages"], [class*="ChatMessages"], main, [role="main"]');
        if (chatArea) chatArea.scrollTop = chatArea.scrollHeight;
      });
      await page.waitForTimeout(1000);

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

    // Pause between tests
    await new Promise(r => setTimeout(r, 3000));
  }

  await context.close();
  console.log(`\nAll done. Screenshots in:\n  ${SCREENSHOTS_DIR}\n`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
