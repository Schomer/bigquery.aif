#!/usr/bin/env node
// scripts/render-and-screenshot.mjs
// 1. Sends prompts to the API (localhost:5800) to get structured responses
// 2. Renders each response into a standalone HTML page styled to match the app
// 3. Screenshots each rendered page with Playwright (no auth needed)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { initTokenManager, getToken } from './token-manager.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SCREENSHOTS_DIR = join(ROOT, 'test-results', 'new-features', 'screenshots');
const HTML_DIR = join(ROOT, 'test-results', 'new-features', 'html');
if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true });
if (!existsSync(HTML_DIR)) mkdirSync(HTML_DIR, { recursive: true });

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

async function callChat(message, context = {}) {
  const accessToken = await getToken();
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      history: [],
      accessToken,
      context: { project: PROJECT, ...context },
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return await res.json();
}

function renderHTML(testId, prompt, result) {
  const env = result.envelopes?.[0];
  if (!env) return '<html><body><p>No response</p></body></html>';

  const headline = env.headline || {};
  const artifact = env.primaryArtifact || {};
  const data = artifact.data || {};
  const nextActions = env.nextActions || [];

  const toneColors = {
    POSITIVE: { bg: '#0d2818', border: '#22c55e', text: '#4ade80', icon: 'checkmark' },
    ATTENTION: { bg: '#2d1f00', border: '#f59e0b', text: '#fbbf24', icon: 'warning' },
    NEUTRAL: { bg: '#1a1a2e', border: '#6366f1', text: '#818cf8', icon: 'info' },
    ERROR: { bg: '#2d0a0a', border: '#ef4444', text: '#f87171', icon: 'error' },
  };
  const tone = toneColors[headline.tone] || toneColors.NEUTRAL;

  // Build data table if rows exist
  let dataTableHTML = '';
  if (data.rows && data.rows.length > 0) {
    const columns = data.columns || Object.keys(data.rows[0]);
    dataTableHTML = `
      <div class="data-table-container">
        <table class="data-table">
          <thead>
            <tr>${columns.map(c => `<th>${typeof c === 'object' ? c.name || c.field : c}</th>`).join('')}</tr>
          </thead>
          <tbody>
            ${data.rows.slice(0, 15).map(row => `
              <tr>${columns.map(c => {
                const key = typeof c === 'object' ? (c.name || c.field) : c;
                const val = row[key] ?? row[Object.keys(row).find(k => k.toLowerCase() === key.toLowerCase())] ?? '';
                return `<td>${val}</td>`;
              }).join('')}</tr>
            `).join('')}
          </tbody>
        </table>
        ${data.rows.length > 15 ? `<div class="row-count">${data.rows.length} total rows</div>` : ''}
      </div>
    `;
  }

  // Build findings list if present
  let findingsHTML = '';
  if (data.findings && data.findings.length > 0) {
    findingsHTML = `
      <div class="findings">
        <h4>Findings</h4>
        <div class="findings-grid">
          ${data.findings.map(f => `
            <div class="finding-card">
              <div class="finding-metric">${f.metric}</div>
              <div class="finding-value">${f.value}${f.column ? ` (${f.column})` : ''}</div>
              ${f.detail ? `<div class="finding-detail">${f.detail}</div>` : ''}
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // Build chips
  let chipsHTML = '';
  if (nextActions.length > 0) {
    chipsHTML = `
      <div class="chips">
        ${nextActions.map(a => {
          const ctx = a.context || {};
          const contextKeys = Object.keys(ctx).filter(k => k !== 'table');
          const contextBadge = contextKeys.length > 0 
            ? `<span class="chip-context" title="${JSON.stringify(ctx)}">${contextKeys.join(', ')}</span>` 
            : '';
          return `<button class="chip">${a.label} <span class="chip-skill">${a.targetSkill}</span>${contextBadge}</button>`;
        }).join('')}
      </div>
    `;
  }

  // Message text
  const messageText = data.message || data.summary || '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=1440">
  <title>${testId}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, sans-serif;
      background: #0a0a0f;
      color: #e2e8f0;
      padding: 32px;
      min-height: 100vh;
    }
    .app-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px 24px;
      background: #12121a;
      border-radius: 12px;
      margin-bottom: 24px;
      border: 1px solid #1e1e2e;
    }
    .app-logo {
      width: 32px; height: 32px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      border-radius: 8px;
    }
    .app-title { font-size: 16px; font-weight: 600; color: #94a3b8; }
    
    .user-prompt {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 24px;
    }
    .user-bubble {
      background: #1e293b;
      padding: 12px 20px;
      border-radius: 18px 18px 4px 18px;
      font-size: 15px;
      color: #f1f5f9;
      max-width: 70%;
    }
    
    .response-container {
      background: #12121a;
      border-radius: 16px;
      border: 1px solid #1e1e2e;
      overflow: hidden;
    }
    
    .headline-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px 24px;
      background: ${tone.bg};
      border-bottom: 1px solid ${tone.border}33;
    }
    .headline-icon {
      width: 24px; height: 24px;
      border-radius: 50%;
      background: ${tone.border};
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; color: #fff; flex-shrink: 0;
    }
    .headline-text {
      font-size: 15px;
      font-weight: 600;
      color: ${tone.text};
      flex: 1;
    }
    .headline-tone {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: ${tone.text}99;
      padding: 2px 8px;
      border-radius: 4px;
      border: 1px solid ${tone.border}44;
    }
    .headline-skill {
      font-size: 11px;
      color: #64748b;
      padding: 2px 8px;
      border-radius: 4px;
      background: #1e1e2e;
    }
    
    .response-body { padding: 20px 24px; }
    .response-message { font-size: 14px; line-height: 1.6; color: #94a3b8; margin-bottom: 16px; }
    
    .data-table-container { overflow-x: auto; margin: 16px 0; }
    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .data-table th {
      text-align: left;
      padding: 8px 12px;
      background: #1e1e2e;
      color: #94a3b8;
      font-weight: 600;
      border-bottom: 1px solid #2d2d3d;
      white-space: nowrap;
    }
    .data-table td {
      padding: 8px 12px;
      border-bottom: 1px solid #1e1e2e;
      color: #cbd5e1;
      white-space: nowrap;
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .data-table tr:hover td { background: #1a1a2a; }
    .row-count { font-size: 12px; color: #64748b; padding: 8px 12px; }
    
    .findings { margin: 16px 0; }
    .findings h4 { font-size: 13px; color: #64748b; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
    .findings-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
    .finding-card {
      background: #1a1a2a;
      padding: 12px 16px;
      border-radius: 8px;
      border: 1px solid #2d2d3d;
    }
    .finding-metric { font-size: 11px; color: #64748b; text-transform: uppercase; margin-bottom: 4px; }
    .finding-value { font-size: 18px; font-weight: 700; color: #e2e8f0; }
    .finding-detail { font-size: 12px; color: #94a3b8; margin-top: 4px; }
    
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding-top: 16px;
      border-top: 1px solid #1e1e2e;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      background: #1e1e2e;
      border: 1px solid #2d2d3d;
      border-radius: 20px;
      color: #cbd5e1;
      font-size: 13px;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.15s;
    }
    .chip:hover { background: #2d2d3d; border-color: #6366f1; }
    .chip-skill {
      font-size: 10px;
      color: #6366f1;
      background: #6366f122;
      padding: 1px 6px;
      border-radius: 4px;
    }
    .chip-context {
      font-size: 9px;
      color: #22c55e;
      background: #22c55e22;
      padding: 1px 6px;
      border-radius: 4px;
    }
    
    .artifact-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: #64748b;
      padding: 4px 8px;
      background: #1e1e2e;
      border-radius: 6px;
      margin-bottom: 12px;
    }
    
    .provenance {
      margin-top: 16px;
      padding: 12px 16px;
      background: #0d0d14;
      border-radius: 8px;
      border: 1px solid #1e1e2e;
    }
    .provenance-label { font-size: 11px; color: #475569; text-transform: uppercase; margin-bottom: 6px; }
    .provenance-sql {
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
      font-size: 12px;
      color: #94a3b8;
      white-space: pre-wrap;
      word-break: break-all;
    }
  </style>
</head>
<body>
  <div class="app-header">
    <div class="app-logo"></div>
    <div class="app-title">BigQuery AIF</div>
  </div>
  
  <div class="user-prompt">
    <div class="user-bubble">${prompt}</div>
  </div>
  
  <div class="response-container">
    <div class="headline-bar">
      <div class="headline-icon">${headline.tone === 'POSITIVE' ? 'OK' : headline.tone === 'ATTENTION' ? '!' : 'i'}</div>
      <div class="headline-text">${headline.text || 'Response'}</div>
      <div class="headline-tone">${headline.tone || 'NEUTRAL'}</div>
      <div class="headline-skill">${env.skill || 'unknown'}</div>
    </div>
    
    <div class="response-body">
      <div class="artifact-badge">Artifact: ${artifact.type || 'none'}</div>
      ${messageText ? `<div class="response-message">${messageText}</div>` : ''}
      ${findingsHTML}
      ${dataTableHTML}
      ${chipsHTML}
    </div>
    
    ${data.sql ? `
    <div class="provenance">
      <div class="provenance-label">SQL Executed</div>
      <div class="provenance-sql">${data.sql}</div>
    </div>
    ` : ''}
  </div>
</body>
</html>`;
}

const TESTS = [
  { id: '01_dq_profile', prompt: 'profile the order_items table in ecomm', context: { dataset: 'ecomm' } },
  { id: '02_dq_nulls_clean', prompt: 'check null rates in the users table in ecomm', context: { dataset: 'ecomm' } },
  { id: '03_monitoring_jobs', prompt: 'show my recent BigQuery job history', context: {} },
  { id: '04_discovery_search', prompt: 'search for tables related to orders in ecomm', context: { dataset: 'ecomm' } },
  { id: '05_data_loading', prompt: 'export the users table in ecomm to Google Sheets', context: { dataset: 'ecomm' } },
];

async function main() {
  console.log('\n=== Render + Screenshot Pipeline ===\n');

  await initTokenManager();

  // Phase 1: Get API responses
  console.log('Phase 1: Calling API...\n');
  const results = [];

  for (const test of TESTS) {
    process.stdout.write(`  [${test.id}] ${test.prompt}... `);
    try {
      const result = await callChat(test.prompt, test.context);
      results.push({ ...test, result });
      const env = result.envelopes?.[0];
      console.log(`OK (${env?.skill} / ${env?.headline?.tone})`);
    } catch (err) {
      console.log(`FAIL: ${err.message}`);
      results.push({ ...test, error: err.message });
    }
  }

  // Phase 2: Render HTML and screenshot
  console.log('\n\nPhase 2: Rendering + screenshots...\n');

  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });

  for (const r of results) {
    if (r.error) continue;

    const htmlPath = join(HTML_DIR, `${r.id}.html`);
    const html = renderHTML(r.id, r.prompt, r.result);
    writeFileSync(htmlPath, html);

    const page = await context.newPage();
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    const screenshotPath = join(SCREENSHOTS_DIR, `${r.id}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true, type: 'png' });
    console.log(`  [${r.id}] saved`);
    await page.close();
  }

  await browser.close();
  console.log(`\nScreenshots in: ${SCREENSHOTS_DIR}\n`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
