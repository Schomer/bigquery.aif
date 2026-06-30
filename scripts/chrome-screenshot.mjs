#!/usr/bin/env node
// scripts/chrome-screenshot.mjs
// Takes screenshots by controlling the already-authenticated Chrome browser
// via AppleScript + CDP (Chrome DevTools Protocol).
//
// This avoids the Firebase auth issue by using the user's existing session.

import { execSync } from 'child_process';
import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SCREENSHOTS_DIR = join(ROOT, 'test-results', 'new-features', 'screenshots');
if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const APP_URL = 'https://bigqueryaif.web.app';

const TESTS = [
  { id: '01_dq_profile', prompt: 'profile the order_items table in ecomm' },
  { id: '02_dq_nulls_clean', prompt: 'check null rates in the users table in ecomm' },
  { id: '03_monitoring_jobs', prompt: 'show my recent BigQuery job history' },
  { id: '04_discovery_search', prompt: 'search for tables related to orders in ecomm' },
  { id: '05_data_loading', prompt: 'export the users table in ecomm to Google Sheets' },
];

function sleep(ms) {
  execSync(`sleep ${ms / 1000}`);
}

function runAppleScript(script) {
  try {
    return execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { encoding: 'utf-8' }).trim();
  } catch (err) {
    console.log(`  AppleScript error: ${err.message}`);
    return '';
  }
}

function captureWindow(filename) {
  const path = join(SCREENSHOTS_DIR, filename);
  // Capture the frontmost Chrome window
  try {
    execSync(`screencapture -l $(osascript -e 'tell application "Google Chrome" to id of window 1') "${path}" 2>/dev/null || screencapture -w "${path}"`);
    return path;
  } catch {
    // Fallback: capture entire screen
    execSync(`screencapture -x "${path}"`);
    return path;
  }
}

async function main() {
  console.log('\nChrome Screenshot Capture');
  console.log('========================\n');

  // First, navigate Chrome to the app
  console.log('Navigating to app...');
  runAppleScript(`tell application "Google Chrome" to set URL of active tab of front window to "${APP_URL}"`);
  sleep(5000);

  for (const test of TESTS) {
    console.log(`\n[${test.id}] "${test.prompt}"`);
    
    // Navigate to fresh chat (new conversation)
    runAppleScript(`tell application "Google Chrome" to set URL of active tab of front window to "${APP_URL}"`);
    sleep(4000);
    
    // Use JavaScript injection to type the prompt and submit
    const jsCode = `
      (function() {
        const textarea = document.querySelector('textarea');
        if (!textarea) return 'NO_TEXTAREA';
        
        // Set value using React's synthetic event system
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        nativeInputValueSetter.call(textarea, '${test.prompt.replace(/'/g, "\\'")}');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        
        // Trigger form submit
        setTimeout(() => {
          const form = textarea.closest('form');
          if (form) {
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          } else {
            // Try pressing Enter
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
          }
        }, 500);
        
        return 'OK';
      })();
    `.replace(/\n/g, ' ').replace(/"/g, '\\"');
    
    runAppleScript(`tell application "Google Chrome" to execute active tab of front window javascript "${jsCode}"`);
    
    // Wait for response to render
    console.log('  Waiting for response...');
    sleep(30000); // 30 seconds for BigQuery + Gemini round-trip
    
    // Take screenshot
    const path = captureWindow(`${test.id}.png`);
    console.log(`  Screenshot: ${path}`);
  }

  console.log('\n\nDone! Screenshots in: ' + SCREENSHOTS_DIR);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
