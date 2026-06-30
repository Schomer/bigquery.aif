#!/usr/bin/env node
// Quick test of the new features via the API (no browser auth needed).
// Calls localhost:5800/api/chat directly with a service-account access token.
//
// Usage:  node scripts/test-new-features.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
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
const RESULTS_DIR = join(ROOT, 'test-results', 'new-features');
if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });

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

function summarize(result, testName) {
  const envelopes = result.envelopes || [];
  const env0 = envelopes[0];
  console.log(`\n  [${ env0 ? 'OK' : 'EMPTY' }] ${testName}`);
  if (env0) {
    console.log(`       Skill: ${env0.skill}`);
    console.log(`       Artifact: ${env0.primaryArtifact?.type}`);
    console.log(`       Headline: ${env0.headline?.text}`);
    console.log(`       Tone: ${env0.headline?.tone}`);
    console.log(`       Requires Confirmation: ${env0.requiresConfirmation ?? false}`);
    const na = env0.nextActions || [];
    if (na.length > 0) {
      console.log(`       Next Actions: ${na.map(a => `"${a.label}" -> ${a.targetSkill}`).join(', ')}`);
    }
    // Show handoff context in chips
    for (const action of na) {
      if (action.context && Object.keys(action.context).length > 1) {
        console.log(`         Chip "${action.label}" context: ${JSON.stringify(action.context)}`);
      }
    }
  }
  return { testName, result, envelope: env0 };
}

async function main() {
  console.log('\n======================================================');
  console.log('  BigQuery AIF -- New Features Test');
  console.log('======================================================\n');

  await initTokenManager();

  const results = [];

  // Test 1: Data Quality Profile -- tests DQ handler + POSITIVE/ATTENTION tone
  console.log('\n--- Test 1: Data Quality Profile ---');
  try {
    const r = await callChat('profile the order_items table', [], { dataset: 'ecomm' });
    const s = summarize(r, 'DQ Profile');
    results.push(s);
  } catch (err) {
    console.log(`  [FAIL] DQ Profile: ${err.message}`);
  }

  // Test 2: Data Quality Null Check -- should produce POSITIVE tone if clean
  console.log('\n--- Test 2: Data Quality Null Check ---');
  try {
    const r = await callChat('check null rates in the users table', [], { dataset: 'ecomm' });
    const s = summarize(r, 'DQ Null Check');
    results.push(s);
  } catch (err) {
    console.log(`  [FAIL] DQ Null Check: ${err.message}`);
  }

  // Test 3: Data Quality Duplicate Check -- should produce handoff chips
  console.log('\n--- Test 3: Data Quality Duplicate Check ---');
  try {
    const r = await callChat('check for duplicates in inventory_items', [], { dataset: 'ecomm' });
    const s = summarize(r, 'DQ Duplicate Check');
    results.push(s);
    
    // Test 3b: Handoff chain -- simulate clicking "Remove duplicates" chip
    if (s.envelope?.nextActions) {
      const removeDupeChip = s.envelope.nextActions.find(a => a.label.toLowerCase().includes('remove'));
      if (removeDupeChip) {
        console.log('\n--- Test 3b: Handoff Chain (DQ -> DM Remove Dupes) ---');
        const r2 = await callChat(removeDupeChip.label, [], {
          dataset: 'ecomm',
          forcedSkill: removeDupeChip.targetSkill,
          handoffContext: removeDupeChip.context,
        });
        const s2 = summarize(r2, 'Handoff: Remove Duplicates');
        results.push(s2);
      }
    }
  } catch (err) {
    console.log(`  [FAIL] DQ Duplicate Check: ${err.message}`);
  }

  // Test 4: Monitoring Jobs -- should produce handoff chips for storage, cost
  console.log('\n--- Test 4: Monitoring Jobs ---');
  try {
    const r = await callChat('show my recent BigQuery job history');
    const s = summarize(r, 'Monitoring Jobs');
    results.push(s);
    
    // Test 4b: Handoff chain -- simulate clicking "Storage analysis" chip
    if (s.envelope?.nextActions) {
      const storageChip = s.envelope.nextActions.find(a => a.label.toLowerCase().includes('storage'));
      if (storageChip) {
        console.log('\n--- Test 4b: Handoff Chain (Monitoring -> Storage) ---');
        const r2 = await callChat(storageChip.label, [], {
          forcedSkill: storageChip.targetSkill,
          handoffContext: storageChip.context,
        });
        const s2 = summarize(r2, 'Handoff: Storage Analysis');
        results.push(s2);
      }
    }
  } catch (err) {
    console.log(`  [FAIL] Monitoring Jobs: ${err.message}`);
  }

  // Test 5: Discovery Search
  console.log('\n--- Test 5: Discovery Search ---');
  try {
    const r = await callChat('search for tables related to orders', [], { dataset: 'ecomm' });
    const s = summarize(r, 'Discovery Search');
    results.push(s);
  } catch (err) {
    console.log(`  [FAIL] Discovery Search: ${err.message}`);
  }

  // Test 6: Data Loading (export)
  console.log('\n--- Test 6: Data Loading Export ---');
  try {
    const r = await callChat('export the users table to Google Sheets', [], { dataset: 'ecomm' });
    const s = summarize(r, 'Data Loading Export');
    results.push(s);
  } catch (err) {
    console.log(`  [FAIL] Data Loading Export: ${err.message}`);
  }

  // Write results to JSON
  const outputPath = join(RESULTS_DIR, 'results.json');
  writeFileSync(outputPath, JSON.stringify(results.map(r => ({
    testName: r.testName,
    skill: r.envelope?.skill,
    artifactType: r.envelope?.primaryArtifact?.type,
    headline: r.envelope?.headline?.text,
    tone: r.envelope?.headline?.tone,
    requiresConfirmation: r.envelope?.requiresConfirmation ?? false,
    nextActions: (r.envelope?.nextActions || []).map(a => ({ label: a.label, targetSkill: a.targetSkill, context: a.context })),
  })), null, 2));
  
  console.log(`\n  Results saved to: ${outputPath}`);
  console.log('\n======================================================');
  console.log('  Test Complete');
  console.log('======================================================\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
