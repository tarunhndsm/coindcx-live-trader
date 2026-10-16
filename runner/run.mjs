// Entry point for the GitHub Actions job: one trader run. The logs are public, so it prints only the outcome.
import fs from 'node:fs';
import {curlFetch, runOnce, webApp} from './bridge.mjs';

const url = process.env.WEBAPP_URL, secret = process.env.WEBAPP_SECRET;
if (!url || !secret) {
  console.error('WEBAPP_URL and WEBAPP_SECRET must be set.');
  process.exit(2);
}
const inActions = process.env.GITHUB_ACTIONS === 'true';
const source = fs.readFileSync(new URL('../src/Code.gs', import.meta.url), 'utf8');
try {
  const result = runOnce({
    source,
    call: webApp({url, secret, http: curlFetch}),
    http: curlFetch,
    runId: process.env.RUN_ID || 'local-' + Date.now(),
    force: process.env.FORCE === 'true',
    log: (message) => console.error(message.slice(0, 300)),
    mask: (value) => { if (inActions && value) console.log('::add-mask::' + value); }
  });
  console.log(result.skipped ? 'Skipped: ' + result.skipped : 'Run finished: ' + result.events + ' event(s), ' + result.trades + ' trade(s).');
} catch (e) {
  console.error('Run failed: ' + String(e && e.message || e).slice(0, 300));
  process.exit(1);
}
