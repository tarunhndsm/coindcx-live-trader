// A test world: Apps Script (Sheet, state, keys, emails), a fake CoinDCX, and the GitHub runner between them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runOnce, webApp} from '../runner/bridge.mjs';
import {FakeExchange, MARKETS} from './exchange.mjs';
import {Clock, Properties, SOURCE_PATH, loadTrader} from './gas.mjs';

const read = (name) => JSON.parse(fs.readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8'));
export const candles = read('candles.json');
export const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');
export const VERSION = SOURCE.match(/var CODE_VERSION = '([^']+)'/)[1];
export const HOUR = 3600000, DAY = 24 * HOUR, RUN = 15 * 60000;
export const START = Date.UTC(2026, 3, 28, 23, 50);  // 29 Apr 2026 05:20 IST, when all four rules wanted coins
export const OWNER = 'owner@example.com';
export const SECRET = 'c0ffee'.repeat(10) + 'beef';
export const WEBAPP_URL = 'https://script.google.com/macros/s/test-deployment/exec';
const WORKFLOW_URL = 'https://api.github.com/repos/tarunhndsm/coindcx-live-trader/actions/workflows/trade.yml';
export const DISPATCH_URL = WORKFLOW_URL + '/dispatches';
export const ENABLE_URL = WORKFLOW_URL + '/enable';
const COINS = Object.values(MARKETS).map((m) => m.coin);
const STEP = Object.fromEntries(Object.values(MARKETS).map((m) => [m.coin, m.step]));

/**
 * `via: 'github'` runs each step the way production does: the runner calls CoinDCX and the Apps Script web app.
 * `via: 'appsScript'` runs it inside Apps Script, as if CoinDCX accepted Google's servers.
 */
export function world({keys = true, start = START, via = 'github', ...options} = {}) {
  const clock = new Clock(start);
  const ex = new FakeExchange({clock, candles, ...options});
  const props = new Properties();
  props.setProperties({OWNER_EMAIL: OWNER, GITHUB_TOKEN: 'github-test-token', WEBAPP_SECRET: SECRET});
  if (keys) {
    props.setProperty('COINDCX_API_KEY', ex.key);
    props.setProperty('COINDCX_API_SECRET', keys === 'wrong' ? 'not-the-secret' : ex.secret);
  }
  const dispatches = [], enables = [];
  const refused = () => w.githubCode === 204 ? null : {code: w.githubCode, body: '{"message":"Bad credentials"}'};
  const appsScriptFetch = (url, params) => {
    if (url === DISPATCH_URL) {
      dispatches.push({url, params: JSON.parse(JSON.stringify(params))});
      if (w.workflowDisabled && !refused()) return {code: 422, body: '{"message":"Cannot trigger a \'workflow_dispatch\' on a disabled workflow"}'};
      return refused() || {code: 204, body: ''};
    }
    if (url === ENABLE_URL) {
      enables.push({method: params.method, payload: params.payload});
      if (refused()) return refused();
      w.workflowDisabled = false;
      return {code: 204, body: ''};
    }
    if (via === 'github') throw new Error('Apps Script must not call ' + url);
    return ex.handle(url, params);
  };
  const t = loadTrader({handler: appsScriptFetch, clock, props});
  const outside = [];
  const http = (url, params) => {
    if (url === WEBAPP_URL) return {code: 200, body: t.post(params.payload)};
    outside.push(url);
    return ex.handle(url, params);
  };
  const sleep = (ms) => clock.advance(ms);
  const call = webApp({url: WEBAPP_URL, secret: SECRET, http, now: () => clock.now, sleep});
  let runs = 0, ids = 0;
  const w = {
    t, ex, clock, props, mails: t.mails, dispatches, enables, outside, call, http, githubCode: 204, workflowDisabled: false,
    runner({runId = 'run-' + ++ids, force = false, source = SOURCE, callWith = call} = {}) {
      return runOnce({source, call: callWith, http, runId, force, now: () => clock.now, sleep});
    },
    step(force = false) {
      if (via === 'appsScript') return t.evaluate('runTrader()');
      return w.runner({force});
    },
    setup() { runs = 1; t.evaluate('setup()'); w.step(); },
    run(n = 1, check) {
      for (let i = 0; i < n; i++) {
        clock.now = Math.max(clock.now + 1000, start + runs++ * RUN);
        w.step();
        if (check) check(w);
      }
    },
    state() { return JSON.parse(t.evaluate('JSON.stringify(loadState(PropertiesService.getScriptProperties()))')); },
    mode(value) {
      const control = t.spreadsheet.getSheetByName('Control');
      if (value !== undefined) control.getRange('B3').setValue(value);
      return control.getRange('B3').getValue();
    },
    health() { return t.spreadsheet.getSheetByName('Control').getRange('B5').getValue(); },
    rows(name, width) {
      const sheet = t.spreadsheet.getSheetByName(name);
      return Array.from({length: sheet.getLastRow() - 1}, (_, i) => sheet.rowValues(i + 2, width));
    },
    control() {
      const sheet = t.spreadsheet.getSheetByName('Control');
      return Object.fromEntries(Array.from({length: 40}, (_, i) => sheet.rowValues(i + 6, 2)).filter((r) => r[0]));
    },
    logText() { return w.rows('Log', 3).map((r) => r.join(' | ')).join('\n'); }
  };
  return w;
}

/** The bot's own figures must agree with the exchange: it owns `reserve` less of the INR than CoinDCX holds. */
export function agrees(reserve) {
  return (w) => {
    const book = w.state().book;
    if (book.kind !== 'live') return;
    if (!book.pending.length) assert.equal(w.ex.openOrders().length, 0, 'an order was left open\n' + w.logText());
    for (const coin of COINS) {
      const pos = book.positions['I-' + coin + '_INR'];
      const diff = w.ex.total(coin) - (pos ? pos.qty : 0);
      assert.ok(diff > -1e-9 && diff < STEP[coin], coin + ': exchange ' + w.ex.total(coin) + ', bot ' + (pos && pos.qty) + '\n' + w.logText());
    }
    assert.ok(Math.abs(w.ex.total('INR') - reserve - book.cash) < 0.5,
              'INR: exchange ' + w.ex.total('INR') + ', bot cash ' + book.cash + '\n' + w.logText());
  };
}

export {Clock, Properties, loadTrader};
