#!/usr/bin/env node
// scripts/test-and-capture.mjs
// Combined test + screenshot capture for new features.
// Sends prompts via the API, then renders results in Playwright for screenshots.
//
// Usage:  node scripts/test-and-capture.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { initTokenManager, getToken } from './token-manager.mjs';

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

const PROJECT = env.GOOGLE_PROJECT_ID || 'malloy-data';
const BASE_URL = 'http://localhost:5800';
const ACCESS_TOKEN_ENV = process.env.GOOGLE_ACCESS_TOKEN || env.GOOGLE_ACCESS_TOKEN || '';
const SCREENSHOTS_DIR = join(ROOT, 'test-results', 'new-features', 'screenshots');

if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// ── Test scenarios ────────────────────────────────────────────────────────────

const TESTS = [
  {
    id: '01_dq_profile',
    name: 'Data Quality Profile (tone + handoff chips)',
    prompt: 'profile the order_items table',
    context: { dataset: 'ecomm' },
  },
  {
    id: '02_dq_nulls',
    name: 'Data Quality Null Check',
    prompt: 'check null rates in the users table',
    context: { dataset: 'ecomm' },
  },
  {
    id: '03_dq_duplicates',
    name: 'Data Quality Duplicate Check',
    prompt: 'check for duplicates in inventory_items',
    context: { dataset: 'ecomm' },
  },
  {
    id: '04_monitoring_jobs',
    name: 'Monitoring Job History',
    prompt: 'show my recent BigQuery job history',
    context: {},
  },
  {
    id: '05_discovery_search',
    name: 'Discovery Table Search',
    prompt: 'search for tables related to orders',
    context: { dataset: 'ecomm' },
  },
  {
    id: '06_data_loading',
    name: 'Data Loading Export',
    prompt: 'export the users table to Google Sheets',
    context: { dataset: 'ecomm' },
  },
];

// ── API call ──────────────────────────────────────────────────────────────────

async function callChat(message, history = [], context = {}) {
  const accessToken = await getToken();
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      history,
      accessToken,
      context: { project: PROJECT, ...context },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return await res.json();
}

// ── Screenshot via Playwright ─────────────────────────────────────────────────

async function captureScreenshot(page, prompt, filename) {
  // Navigate fresh
  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 20000 });

  // Inject token
  await page.evaluate((token) => {
    sessionStorage.setItem('bq_access_token', token);
  }, ACCESS_TOKEN_ENV);

  // Wait for textarea
  const textarea = await page.waitForSelector('textarea[placeholder]', { timeout: 12000 }).catch(() => null);
  if (!textarea) {
    console.log('    Chat input not found, skipping screenshot');
    return null;
  }

  // Type and send
  await textarea.click();
  await textarea.fill(prompt);
  await page.keyboard.press('Enter');

  // Wait for response (artifact card appears and loading ends)
  await page.waitForFunction(() => {
    const loadingDots = document.querySelector('[style*="pulse"]');
    const sparkSpinner = document.querySelector('.spark-spinner, .crystal-ball-spinner');
    const artifactCard = document.querySelector('[class*="artifact"], [data-testid*="artifact"]');
    return !loadingDots && !sparkSpinner && artifactCard;
  }, { timeout: 90000 }).catch(async () => {
    // Fallback wait
    await page.waitForTimeout(15000);
  });

  // Extra settle time
  await page.waitForTimeout(2000);

  const screenshotPath = join(SCREENSHOTS_DIR, `${filename}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false, type: 'png' });
  return screenshotPath;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n======================================================');
  console.log('  BigQuery AIF -- New Features Test + Screenshots');
  console.log('======================================================\n');

  await initTokenManager();

  // Phase 1: API tests
  console.log('Phase 1: Running API tests...\n');
  const apiResults = [];

  for (const test of TESTS) {
    process.stdout.write(`  [${test.id}] ${test.name}... `);
    try {
      const result = await callChat(test.prompt, [], test.context);
      const envelopes = result.envelopes || [];
      const env0 = envelopes[0];

      if (env0) {
        console.log(`OK (${env0.skill} / ${env0.primaryArtifact?.type} / tone=${env0.headline?.tone})`);
        const na = env0.nextActions || [];
        if (na.length > 0) {
          console.log(`       Chips: ${na.map(a => `"${a.label}"`).join(', ')}`);
          for (const action of na) {
            const ctx = action.context;
            if (ctx && (ctx.operationHint || ctx.checkType || ctx.monitoringHint || ctx.keyColumn)) {
              console.log(`         "${action.label}" -> ${JSON.stringify(ctx)}`);
            }
          }
        }
      } else {
        console.log('EMPTY (no envelopes)');
      }

      apiResults.push({ ...test, result, envelope: env0 });
    } catch (err) {
      console.log(`FAIL: ${err.message}`);
      apiResults.push({ ...test, error: err.message });
    }
  }

  // Test handoff chains
  console.log('\n  --- Handoff Chain Tests ---');

  // DQ -> DM handoff
  const dupeTest = apiResults.find(r => r.id === '03_dq_duplicates');
  if (dupeTest?.envelope?.nextActions) {
    const removeDupeChip = dupeTest.envelope.nextActions.find(a => a.label.toLowerCase().includes('remove'));
    if (removeDupeChip) {
      process.stdout.write('  [07_handoff_dq_dm] DQ->DM Remove Duplicates... ');
      try {
        const r = await callChat(removeDupeChip.label, [], {
          dataset: 'ecomm',
          forcedSkill: removeDupeChip.targetSkill,
          handoffContext: removeDupeChip.context,
        });
        const env0 = r.envelopes?.[0];
        console.log(`OK (${env0?.skill} / ${env0?.primaryArtifact?.type})`);
        apiResults.push({ id: '07_handoff_dq_dm', name: 'Handoff: DQ->DM Remove Dupes', result: r, envelope: env0 });
      } catch (err) {
        console.log(`FAIL: ${err.message}`);
      }
    }
  }

  // Monitoring -> Storage handoff
  const monTest = apiResults.find(r => r.id === '04_monitoring_jobs');
  if (monTest?.envelope?.nextActions) {
    const storageChip = monTest.envelope.nextActions.find(a => a.label.toLowerCase().includes('storage'));
    if (storageChip) {
      process.stdout.write('  [08_handoff_mon_storage] Monitoring->Storage... ');
      try {
        const r = await callChat(storageChip.label, [], {
          forcedSkill: storageChip.targetSkill,
          handoffContext: storageChip.context,
        });
        const env0 = r.envelopes?.[0];
        console.log(`OK (${env0?.skill} / ${env0?.primaryArtifact?.type})`);
        apiResults.push({ id: '08_handoff_mon_storage', name: 'Handoff: Monitoring->Storage', result: r, envelope: env0 });
      } catch (err) {
        console.log(`FAIL: ${err.message}`);
      }
    }
  }

  // Phase 2: Playwright screenshots
  console.log('\n\nPhase 2: Capturing screenshots...\n');

  let browser;
  try {
    browser = await chromium.launch({
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
    }, ACCESS_TOKEN_ENV);
    await authPage.reload({ waitUntil: 'networkidle', timeout: 20000 });
    try {
      await authPage.waitForSelector('textarea[placeholder]', { timeout: 10000 });
      console.log('  Auth injected, chat interface loaded\n');
    } catch {
      console.log('  Warning: Chat interface not detected after auth injection\n');
    }
    await authPage.close();

    // Capture each test
    for (const test of TESTS) {
      process.stdout.write(`  [${test.id}] Capturing "${test.prompt}"... `);
      const page = await context.newPage();
      try {
        const path = await captureScreenshot(page, test.prompt, test.id);
        if (path) {
          console.log('saved');
          const result = apiResults.find(r => r.id === test.id);
          if (result) result.screenshotPath = path;
        }
      } catch (err) {
        console.log(`failed: ${err.message}`);
      } finally {
        await page.close();
      }
      await new Promise(r => setTimeout(r, 1000));
    }

  } catch (err) {
    console.log(`  Playwright error: ${err.message}`);
    console.log('  (Playwright may not be installed. Run: npx playwright install chromium)');
  } finally {
    if (browser) await browser.close();
  }

  // Write summary
  const summaryPath = join(SCREENSHOTS_DIR, '..', 'summary.json');
  writeFileSync(summaryPath, JSON.stringify(apiResults.map(r => ({
    id: r.id,
    name: r.name,
    skill: r.envelope?.skill,
    artifactType: r.envelope?.primaryArtifact?.type,
    headline: r.envelope?.headline?.text,
    tone: r.envelope?.headline?.tone,
    requiresConfirmation: r.envelope?.requiresConfirmation ?? false,
    nextActions: (r.envelope?.nextActions || []).map(a => ({ label: a.label, targetSkill: a.targetSkill, context: a.context })),
    error: r.error,
    screenshotPath: r.screenshotPath,
  })), null, 2));

  console.log(`\n  Summary saved to: ${summaryPath}`);
  console.log('\n======================================================');
  console.log('  All done');
  console.log('======================================================\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
