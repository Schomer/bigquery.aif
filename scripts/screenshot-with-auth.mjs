#!/usr/bin/env node
// scripts/screenshot-with-auth.mjs
// Takes screenshots by signing into Firebase via signInWithCredential
// using the app's own bundled Firebase SDK (exposed on window.__test__).
//
// Strategy:
// 1. Temporarily add a <script> tag that the app exposes firebase.auth on window
// 2. Use signInWithCredential with the Google OAuth id_token
// 3. Set the BQ access token in sessionStorage
// 4. Reload and capture screenshots

import { readFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SCREENSHOTS_DIR = join(ROOT, 'test-results', 'new-features', 'screenshots');
if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const APP_URL = 'https://bigqueryaif.web.app';
const OAUTH_CREDS_PATH = join(ROOT, '.oauth-credentials.json');

function loadOAuthCreds() {
  if (!existsSync(OAUTH_CREDS_PATH)) throw new Error('.oauth-credentials.json not found');
  return JSON.parse(readFileSync(OAUTH_CREDS_PATH, 'utf-8'));
}

async function refreshTokens(creds) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Refresh failed: ${data.error}`);
  return { accessToken: data.access_token, idToken: data.id_token };
}

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBAmqEk0uffrau95ArrczJCmC7e3YBfONM",
  authDomain: "malloy-data.firebaseapp.com",
  projectId: "malloy-data",
};

const TESTS = [
  { id: '01_dq_profile', prompt: 'profile the order_items table in ecomm', wait: 60000 },
  { id: '02_dq_nulls_clean', prompt: 'check null rates in the users table in ecomm', wait: 50000 },
  { id: '03_monitoring_jobs', prompt: 'show my recent BigQuery job history', wait: 50000 },
  { id: '04_discovery_search', prompt: 'search for tables related to orders in ecomm', wait: 50000 },
  { id: '05_data_loading', prompt: 'export the users table in ecomm to Google Sheets', wait: 55000 },
];

async function main() {
  console.log('\n=== Screenshot Capture ===\n');

  const creds = loadOAuthCreds();
  const { accessToken, idToken } = await refreshTokens(creds);
  console.log(`Access token: ${accessToken.substring(0, 20)}...`);
  console.log(`ID token: ${idToken ? 'present' : 'MISSING'}\n`);

  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });

  try {
    // ── Auth injection ──────────────────────────────────────────────────────
    const page = await context.newPage();

    // Intercept the page load to inject auth BEFORE React hydrates
    await page.addInitScript(({ config, idToken, accessToken }) => {
      // This runs before any page JS.
      // We'll use Firebase compat SDK loaded from CDN in the page head.
      window.__INJECT_AUTH__ = { config, idToken, accessToken };
    }, { config: FIREBASE_CONFIG, idToken, accessToken });

    // Route: inject a Firebase compat script before the page loads
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (request.resourceType() === 'document' && request.url().includes('bigqueryaif.web.app')) {
        const response = await route.fetch();
        let body = await response.text();

        // Inject the Firebase compat SDK and auth script into <head>
        const injection = `
          <script src="https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js"></script>
          <script src="https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js"></script>
          <script>
            (async function() {
              try {
                const cfg = ${JSON.stringify(FIREBASE_CONFIG)};
                const idToken = "${idToken}";
                const accessToken = "${accessToken}";
                
                // Initialize compat Firebase
                const app = firebase.initializeApp(cfg, 'test-auth');
                const auth = app.auth();
                
                // Sign in with Google credential
                const credential = firebase.auth.GoogleAuthProvider.credential(idToken);
                const result = await auth.signInWithCredential(credential);
                console.log('[test-auth] Signed in as:', result.user.email);
                
                // Now the main app's Firebase (modular SDK) shares the same project,
                // so IndexedDB auth state is shared. But modular vs compat have
                // separate persistence. We need to also sign in the modular SDK.
                // 
                // Alternative: directly write to IndexedDB for the modular SDK.
                // The modular SDK stores auth in: firebaseLocalStorageDb -> firebaseLocalStorage
                
                // Write auth state to both sessionStorage and indexedDB
                sessionStorage.setItem('bqaif_access_token', accessToken);
                
                // Signal to our waiting code
                window.__AUTH_INJECTED__ = { 
                  success: true, 
                  uid: result.user.uid, 
                  email: result.user.email 
                };
              } catch (err) {
                console.error('[test-auth] Auth injection failed:', err);
                window.__AUTH_INJECTED__ = { success: false, error: err.message };
              }
            })();
          </script>
        `;

        body = body.replace('<head>', '<head>' + injection);

        await route.fulfill({
          response,
          body,
          headers: {
            ...response.headers(),
            'content-type': 'text/html; charset=utf-8',
          },
        });
      } else {
        await route.continue();
      }
    });

    console.log('Loading app with auth injection...');
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(5000);

    // Check injection result
    const authResult = await page.evaluate(() => window.__AUTH_INJECTED__);
    console.log('Auth injection result:', JSON.stringify(authResult));

    // The compat and modular SDKs have separate IndexedDB stores.
    // The modular SDK (which the app uses) stores auth in a different DB.
    // We need to also write the auth state for the modular SDK.
    // 
    // The modular SDK stores auth in IndexedDB: 
    //   DB: firebase-heartbeat-database, firebaseLocalStorageDb
    //   Store: firebaseLocalStorage
    //   Key: firebase:authUser:<apiKey>:[DEFAULT]
    
    if (authResult?.success) {
      console.log('Compat auth succeeded. Syncing to modular SDK via IndexedDB...');
      
      const syncResult = await page.evaluate(async ({ apiKey, uid, email }) => {
        try {
          // The modular SDK reads auth from IndexedDB
          // DB name: firebase-auth-<apiKey>-<appname>
          // But the actual format varies. Let's try the standard format.
          
          // Actually, both compat and modular SDKs from the same version share persistence.
          // But we're using compat v10 while the app uses modular v11 -- different persistence format.
          
          // Let's try to get the user data from our compat auth and inject it into 
          // the format the modular v11 expects.
          
          // The v11 modular SDK uses: firebaseLocalStorageDb
          return new Promise((resolve, reject) => {
            const request = indexedDB.open('firebaseLocalStorageDb', 1);
            request.onupgradeneeded = () => {
              const db = request.result;
              if (!db.objectStoreNames.contains('firebaseLocalStorage')) {
                db.createObjectStore('firebaseLocalStorage');
              }
            };
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction('firebaseLocalStorage', 'readwrite');
              const store = tx.objectStore('firebaseLocalStorage');
              
              // Read what the compat SDK wrote
              const getAllReq = store.getAll();
              getAllReq.onsuccess = () => {
                resolve({ existing: getAllReq.result?.length || 0, entries: getAllReq.result?.map(e => typeof e === 'object' ? Object.keys(e) : typeof e) });
              };
              getAllReq.onerror = () => resolve({ error: 'getAll failed' });
            };
            request.onerror = () => resolve({ error: 'open failed' });
          });
        } catch (err) {
          return { error: err.message };
        }
      }, { apiKey: FIREBASE_CONFIG.apiKey, uid: authResult.uid, email: authResult.email });
      
      console.log('IndexedDB state:', JSON.stringify(syncResult));
    }

    // Reload and check for textarea
    await page.reload({ waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(5000);

    const textarea = await page.$('textarea');
    if (!textarea) {
      console.log('\nChat not available. Saving auth state screenshot...');
      await page.screenshot({ path: join(SCREENSHOTS_DIR, '00_auth_state.png'), fullPage: false });
      
      // Try one more thing: check if the modular SDK has auth state
      const dbCheck = await page.evaluate(async () => {
        const dbs = await indexedDB.databases();
        return dbs.map(d => ({ name: d.name, version: d.version }));
      });
      console.log('IndexedDB databases:', JSON.stringify(dbCheck));
      
      await page.close();
      await browser.close();
      return;
    }

    console.log('\nChat interface loaded! Starting screenshots...\n');
    await page.close();

    // ── Take screenshots ────────────────────────────────────────────────────
    for (const test of TESTS) {
      process.stdout.write(`[${test.id}] "${test.prompt}"... `);
      const p = await context.newPage();
      try {
        await p.goto(APP_URL, { waitUntil: 'networkidle', timeout: 20000 });
        await p.waitForTimeout(2000);
        
        const ta = await p.waitForSelector('textarea', { timeout: 10000 });
        await ta.click();
        await ta.fill(test.prompt);
        await p.keyboard.press('Enter');
        
        try {
          await p.waitForFunction(() => {
            const spinners = document.querySelectorAll('.spark-spinner, .crystal-ball-spinner');
            const artifacts = document.querySelectorAll('[class*="artifact"], [class*="Artifact"]');
            return spinners.length === 0 && artifacts.length > 0;
          }, { timeout: test.wait });
        } catch {}
        
        await p.waitForTimeout(3000);
        await p.screenshot({ path: join(SCREENSHOTS_DIR, `${test.id}.png`), fullPage: false, type: 'png' });
        console.log('saved');
      } catch (err) {
        console.log(`error: ${err.message}`);
      } finally {
        await p.close();
      }
      await new Promise(r => setTimeout(r, 2000));
    }

  } finally {
    await browser.close();
  }

  console.log(`\nScreenshots in: ${SCREENSHOTS_DIR}\n`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
