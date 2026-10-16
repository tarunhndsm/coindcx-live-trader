/**
 * CoinDCX trader for one INR spot wallet, controlled from its Google Sheet.
 *
 * Every 15 minutes a run checks prices, the loss brake and any unfinished order. Once an hour it
 * replays four slow trend rules, each in its own ₹5,000 paper "sleeve". The real wallet holds the
 * weighted blend of the sleeves' coins. Each Monday the weights move towards the sleeves that did better,
 * within 10% to 40% each. Spot BTC, ETH, SOL and XRP against INR only: no leverage, futures or margin.
 *
 * CoinDCX's firewall refuses Google's servers, so the runs execute this same file on GitHub Actions
 * (runner/run.mjs). Apps Script is the clock, holds the state and keys, and writes the Sheet and the emails.
 *
 * The rules lost a little after costs in testing (see README.md). Nothing here can promise a profit.
 * The brake sells everything and stops if the wallet falls to 80% of its start or of its peak.
 *
 * @OnlyCurrentDoc
 */

var CODE_VERSION = '2026-10-17.2';

var CONFIG = {
  capitalInr: 5000,
  repo: 'tarunhndsm/coindcx-live-trader',
  workflow: 'trade.yml',
  leaseMs: 9 * 60000,
  minGapMs: 10 * 60000,
  staleMs: 50 * 60000,
  maxSkewMs: 5 * 60000,
  pairs: ['I-BTC_INR', 'I-ETH_INR', 'I-SOL_INR', 'I-XRP_INR'],
  markets: {
    'I-BTC_INR': {symbol: 'BTCINR', coin: 'BTC', step: 1e-5, minQty: 1e-5, qtyDecimals: 5, priceDecimals: 1, halfSpread: 0.0025},
    'I-ETH_INR': {symbol: 'ETHINR', coin: 'ETH', step: 1e-4, minQty: 1e-7, qtyDecimals: 4, priceDecimals: 1, halfSpread: 0.0031},
    'I-SOL_INR': {symbol: 'SOLINR', coin: 'SOL', step: 1e-3, minQty: 0.01, qtyDecimals: 3, priceDecimals: 1, halfSpread: 0.0024},
    'I-XRP_INR': {symbol: 'XRPINR', coin: 'XRP', step: 0.1, minQty: 1, qtyDecimals: 1, priceDecimals: 3, halfSpread: 0.0023}
  },
  rules: ['btc_sma30', 'tsmom30', 'crossmom7', 'donchian20_10'],
  ruleLabels: {
    btc_sma30: 'BTC 30-day trend timing',
    tsmom30: 'Four-coin 30-day momentum',
    crossmom7: 'Four-coin 7-day relative momentum',
    donchian20_10: 'Four-coin 20/10-day breakout'
  },
  sleeveCapitalInr: 5000,
  spotFee: 0.005,
  gst: 0.18,
  taxRate: 0.312,
  tdsRate: 0.01,
  tdsThresholdInr: 50000,
  minNotionalInr: 100,
  minOrderInr: 150,
  rebalanceBand: 0.02,
  maxInvested: 0.98,
  limitSlack: 0.004,
  maxSpread: 0.02,
  brake: 0.8,
  learnRate: 3,
  minWeight: 0.1,
  maxWeight: 0.4,
  minStartInr: 500,
  reportHourIst: 9,
  maxCatchUpHours: 72,
  alertEveryMs: 6 * 3600000,
  orderPrefix: 'tb'
};

var HOUR_MS = 3600000;
var DAY_MS = 24 * HOUR_MS;
var WEEK_MS = 7 * DAY_MS;
var MONDAY_MS = 4 * DAY_MS;  // 1970-01-05 00:00 UTC was a Monday.
var IST_MS = 19800000;
var API_URL = 'https://api.coindcx.com';
var PUBLIC_URL = 'https://public.coindcx.com';
var OPEN_STATUSES = ['init', 'open', 'partially_filled'];
var CLOSED_STATUSES = ['filled', 'partially_cancelled', 'cancelled', 'rejected'];
var MODES = ['LIVE', 'PAUSE', 'SELL ALL', 'RESET'];

class DataError extends Error {
  constructor(message) { super(message); this.name = 'DataError'; }
}

class ApiError extends Error {
  constructor(message, code, body) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.body = body || '';
  }
}

// ---------------------------------------------------------------- entry points

/** Run this once from the editor: it installs the 15-minute schedule, builds the tabs and starts a first run. */
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (['runTrader', 'tick'].indexOf(trigger.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(15).create();
  prepareSheets();
  PropertiesService.getScriptProperties().setProperty('INSTALLED_AT', String(nowMs()));
  tick();
}

/** Every 15 minutes: starts a run on GitHub Actions, and warns if runs have stopped finishing. */
function tick() {
  var props = PropertiesService.getScriptProperties(), now = nowMs(), lease = readLease(props);
  if (!lease || lease.until <= now) dispatchRun(props, false);
  keepWorkflowEnabled(props, now);
  watchdog(props, now);
}

/** Runs a step inside Apps Script itself, which CoinDCX's firewall currently refuses; the schedule uses tick(). */
function runTrader() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    traderStep(nowMs());
  } catch (e) {
    reportCrash(e);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function reportCrash(e) {
  try {
    var props = PropertiesService.getScriptProperties(), last = Number(props.getProperty('CRASH_MAIL_AT') || 0);
    if (nowMs() - last < CONFIG.alertEveryMs) return;
    props.setProperty('CRASH_MAIL_AT', String(nowMs()));
    mailOwner('CoinDCX trader: a run failed',
              'The bot hit an error and tries again in 15 minutes.\n\n' + (e && e.stack || e) + '\n\n' + sheetUrl());
  } catch (ignored) {
    console.log('Could not email the crash report: ' + ignored);
  }
}

function mailOwner(subject, body) {
  var to = PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL');
  if (!to) throw new Error('No OWNER_EMAIL script property, so "' + subject + '" was not sent.');
  MailApp.sendEmail(to, subject, body);
}

function nowMs() { return Date.now(); }
function sleepMs(ms) { Utilities.sleep(ms); }
function feeRate() { return CONFIG.spotFee * (1 + CONFIG.gst); }

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Trader')
    .addItem('Set CoinDCX API key', 'menuSetKey')
    .addItem('Run now', 'menuRunNow')
    .addItem('Email a report now', 'menuReport')
    .addSeparator()
    .addItem('Install or repair the 15-minute schedule', 'setup')
    .addItem('Remove the API key', 'menuRemoveKey')
    .addToUi();
}

function menuSetKey() {
  var ui = SpreadsheetApp.getUi();
  var key = ui.prompt('CoinDCX API key', 'Paste the API key from coindcx.com > Profile > API dashboard.', ui.ButtonSet.OK_CANCEL);
  if (key.getSelectedButton() !== ui.Button.OK) return;
  var secret = ui.prompt('CoinDCX API secret', 'Paste the secret shown with that key.', ui.ButtonSet.OK_CANCEL);
  if (secret.getSelectedButton() !== ui.Button.OK) return;
  var keys = {key: key.getResponseText().trim(), secret: secret.getResponseText().trim()};
  if (keys.key.length < 16 || keys.secret.length < 16 || /\s/.test(keys.key + keys.secret)) {
    ui.alert('That does not look like a CoinDCX API key and secret, so nothing was saved.');
    return;
  }
  var props = PropertiesService.getScriptProperties();
  props.setProperties({COINDCX_API_KEY: keys.key, COINDCX_API_SECRET: keys.secret});
  var started = dispatchRun(props, true);
  ui.alert('Key saved. ' + (started ? 'A run has started; in about a minute' : 'Within 15 minutes') + ' it checks the key with CoinDCX. ' +
           'With Mode set to LIVE and at least ' + rupees(CONFIG.minStartInr) + ' of free INR it starts trading up to ' +
           rupees(CONFIG.capitalInr) + '. If CoinDCX rejects the key, the Control tab shows "API key problem" and you get an email.');
}

function menuRemoveKey() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('COINDCX_API_KEY');
  props.deleteProperty('COINDCX_API_SECRET');
  SpreadsheetApp.getUi().alert('API key removed. The bot can no longer place orders; anything it bought stays in your CoinDCX wallet.');
}

function menuRunNow() {
  var props = PropertiesService.getScriptProperties();
  SpreadsheetApp.getUi().alert(dispatchRun(props, true) ? 'A run has started on GitHub. The Control tab updates in about a minute.'
                                                        : 'GitHub did not start a run: ' + props.getProperty('DISPATCH_ERROR'));
}

function menuReport() {
  var props = PropertiesService.getScriptProperties();
  var state = loadState(props);
  if (!state) {
    SpreadsheetApp.getUi().alert('No runs yet. Choose "Run now" first.');
    return;
  }
  mailOwner('CoinDCX trader report', reportText(state, state.lastTicker || {}, nowMs()));
  SpreadsheetApp.getUi().alert('Report sent to ' + props.getProperty('OWNER_EMAIL') + '.');
}

/** Reports whether this server can reach each CoinDCX host. A dummy-key private call should get a JSON 401. */
function checkConnection() {
  var payload = JSON.stringify({timestamp: nowMs()});
  var probes = [
    [API_URL + '/exchange/ticker', {method: 'get'}],
    [API_URL + '/exchange/v1/markets_details', {method: 'get'}],
    [PUBLIC_URL + '/market_data/candles?pair=I-BTC_INR&interval=1h&limit=2', {method: 'get'}],
    [API_URL + '/exchange/v1/users/balances', {method: 'post', contentType: 'application/json', payload: payload,
      headers: {'X-AUTH-APIKEY': 'connection-check', 'X-AUTH-SIGNATURE': hmacHex(payload, 'connection-check')}}]
  ];
  var lines = probes.map(function (probe) {
    try {
      var r = UrlFetchApp.fetch(probe[0], Object.assign({muteHttpExceptions: true}, probe[1]));
      var body = r.getContentText(), headers = r.getAllHeaders();
      var title = (body.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
      var cf = (body.match(/error code:?\s*(?:<[^>]*>\s*)*(\d{4})/i) || [])[1] || '';
      return probe[0].replace(/\?.*$/, '') + ': HTTP ' + r.getResponseCode() + (title ? ' "' + title.replace(/\s+/g, ' ').trim() + '"' : '') +
             (cf ? ', Cloudflare error ' + cf : '') + (headers['cf-ray'] ? ', ray ' + headers['cf-ray'] : '') +
             (title ? '' : ', ' + body.slice(0, 80).replace(/\s+/g, ' '));
    } catch (e) {
      return probe[0] + ': ' + e.message;
    }
  });
  var result = lines.join('\n');
  console.log(result);
  return result;
}

// ---------------------------------------------------------------- GitHub runs
//
// The runner (runner/run.mjs) gets in only through doPost: signed requests to begin a run, save its state before
// every order, and finish. A lease keeps a second runner from acting on the same wallet at the same time.

function dispatchRun(props, force) {
  var token = props.getProperty('GITHUB_TOKEN'), problem;
  if (!token) {
    problem = 'no GITHUB_TOKEN script property';
  } else {
    try {
      var payload = {ref: 'main', inputs: {force: force ? 'true' : 'false'}};
      var response = workflowCall(token, 'post', '/dispatches', payload), enableProblem = '';
      if (response.getResponseCode() !== 204) {
        enableProblem = enableWorkflow(props, token);
        if (!enableProblem) response = workflowCall(token, 'post', '/dispatches', payload);
      }
      if (response.getResponseCode() === 204) {
        if (props.getProperty('DISPATCH_ERROR')) props.deleteProperty('DISPATCH_ERROR');
        return true;
      }
      problem = 'GitHub answered HTTP ' + response.getResponseCode() + ' ' + briefBody(response.getContentText()).slice(0, 150) +
                (enableProblem ? '; ' + enableProblem : '');
    } catch (e) {
      problem = String(e && e.message || e).slice(0, 200);
    }
  }
  props.setProperty('DISPATCH_ERROR', ist(nowMs()) + ': ' + problem);
  return false;
}

/** Once a day, so that GitHub's hourly fallback schedule stays on as well. */
function keepWorkflowEnabled(props, now) {
  var token = props.getProperty('GITHUB_TOKEN');
  if (!token || now - Number(props.getProperty('WORKFLOW_ENABLED_AT') || 0) < DAY_MS) return;
  var problem;
  try {
    problem = enableWorkflow(props, token);
  } catch (e) {
    problem = String(e && e.message || e);
  }
  if (problem) console.log('Could not enable the workflow: ' + problem);
}

/**
 * GitHub disables a workflow that has a schedule after 60 days without commits, and then refuses to start it.
 * Returns '' once the workflow is enabled, otherwise what went wrong.
 */
function enableWorkflow(props, token) {
  var response = workflowCall(token, 'put', '/enable');
  if (response.getResponseCode() !== 204) {
    return 'enabling the workflow answered HTTP ' + response.getResponseCode() + ' ' + briefBody(response.getContentText()).slice(0, 100);
  }
  props.setProperty('WORKFLOW_ENABLED_AT', String(nowMs()));
  return '';
}

function workflowCall(token, method, path, payload) {
  var options = {method: method, muteHttpExceptions: true,
                 headers: {Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}};
  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  return UrlFetchApp.fetch('https://api.github.com/repos/' + CONFIG.repo + '/actions/workflows/' + CONFIG.workflow + path, options);
}

function watchdog(props, now) {
  var last = Number(props.getProperty('LAST_OK_AT') || 0), problem = props.getProperty('DISPATCH_ERROR');
  var quiet = now - Math.max(last, Number(props.getProperty('INSTALLED_AT') || 0));
  var text = (last ? 'last run finished ' + ist(last) : 'no run has finished yet') + (problem ? '; starting a run failed at ' + problem : '');
  setHealth(quiet < CONFIG.staleMs ? 'OK, ' + text : 'PROBLEM: ' + text);
  if (quiet < CONFIG.staleMs || now - Number(props.getProperty('WATCHDOG_MAIL_AT') || 0) < CONFIG.alertEveryMs) return;
  props.setProperty('WATCHDOG_MAIL_AT', String(now));
  mailOwner('CoinDCX trader: no run has finished for ' + Math.round(quiet / 60000) + ' minutes',
            'The bot runs on GitHub Actions every 15 minutes. Until a run finishes it neither trades nor watches its loss brake.\n\n' +
            text + '.\n\nRuns: https://github.com/' + CONFIG.repo + '/actions\n' + sheetUrl());
}

function setHealth(text) {
  try {
    new Dashboard().sheet('Control').getRange('A5:B5').setValues([['Health', text]]);
  } catch (e) {
    console.log('Could not write the health line: ' + e);
  }
}

function readLease(props) {
  try {
    return JSON.parse(props.getProperty('RUN_LEASE') || 'null');
  } catch (e) {
    return null;
  }
}

function isStateKey(key) { return /^STATE_(\d+|PARTS)$/.test(key); }

function sameText(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The web app the runner calls. Every request except the one-time "pair" must be signed with WEBAPP_SECRET. */
function doPost(e) {
  var reply;
  try {
    reply = handleBridge(JSON.parse(e && e.postData && e.postData.contents || '{}'), nowMs());
  } catch (err) {
    reply = {ok: false, error: String(err && err.message || err).slice(0, 300)};
  }
  return ContentService.createTextOutput(JSON.stringify(reply)).setMimeType(ContentService.MimeType.JSON);
}

function handleBridge(req, now) {
  var props = PropertiesService.getScriptProperties(), lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return {ok: false, error: 'busy'};
  try {
    if (req.op === 'pair') return bridgePair(props, req);
    var secret = props.getProperty('WEBAPP_SECRET'), data = typeof req.data === 'string' ? req.data : '';
    if (!secret) return {ok: false, error: 'not paired yet'};
    if (!(Math.abs(now - Number(req.ts)) <= CONFIG.maxSkewMs)) return {ok: false, error: 'request too old, or the clocks disagree'};
    if (!/^[0-9a-f]{32}$/.test(String(req.nonce))) return {ok: false, error: 'bad nonce'};
    if (!sameText(String(req.sig), hmacHex(req.op + '\n' + req.ts + '\n' + req.nonce + '\n' + data, secret))) {
      return {ok: false, error: 'bad signature'};
    }
    var cache = CacheService.getScriptCache();
    if (cache.get('nonce-' + req.nonce)) return {ok: false, error: 'replayed request'};
    cache.put('nonce-' + req.nonce, '1', 900);
    var body = JSON.parse(data || '{}');
    if (req.op === 'begin') return bridgeBegin(props, body, now);
    if (req.op === 'save') return bridgeSave(props, body);
    if (req.op === 'finish') return bridgeFinish(props, body, now);
    if (req.op === 'crash') return bridgeCrash(props, body, now);
    if (req.op === 'config') return bridgeConfig(props, body);
    if (req.op === 'status') return bridgeStatus(props, now);
    if (req.op === 'install') {
      setup();
      return {ok: true};
    }
    return {ok: false, error: 'unknown op'};
  } finally {
    lock.releaseLock();
  }
}

function bridgePair(props, req) {
  if (props.getProperty('WEBAPP_SECRET')) return {ok: false, error: 'already paired'};
  if (!/^[0-9a-f]{64}$/.test(String(req.secret))) return {ok: false, error: 'the secret must be 64 hex characters'};
  props.setProperty('WEBAPP_SECRET', req.secret);
  return {ok: true};
}

function bridgeBegin(props, body, now) {
  if (body.version !== CODE_VERSION) {
    return {ok: false, error: 'Apps Script has version ' + CODE_VERSION + ' and GitHub has ' + body.version + '; deploy the same Code.gs to both.'};
  }
  var last = Number(props.getProperty('LAST_OK_AT') || 0), lease = readLease(props);
  if (!body.force && now - last < CONFIG.minGapMs) return {ok: true, skip: 'a run finished at ' + ist(last)};
  if (lease && lease.until > now && lease.id !== String(body.runId)) return {ok: true, skip: 'run ' + lease.id + ' is still going'};
  props.setProperty('RUN_LEASE', JSON.stringify({id: String(body.runId), until: now + CONFIG.leaseMs}));
  var all = props.getProperties(), state = {};
  Object.keys(all).forEach(function (key) { if (isStateKey(key)) state[key] = all[key]; });
  var control = new Dashboard().ss.getSheetByName('Control');
  return {ok: true, props: state, keys: readKeys(props), modeCell: control ? String(control.getRange('B3').getValue()) : ''};
}

function holdsLease(props, body) {
  var lease = readLease(props);
  return !!lease && lease.id === String(body.runId);
}

function bridgeSave(props, body) {
  var values = body.values || {}, keys = Object.keys(values);
  if (!holdsLease(props, body)) return {ok: false, error: 'this run no longer holds the lease'};
  if (!keys.length || !keys.every(isStateKey)) return {ok: false, error: 'only STATE_ properties can be saved'};
  props.setProperties(values);
  return {ok: true};
}

function bridgeFinish(props, body, now) {
  if (props.getProperty('LAST_RUN_ID') === String(body.runId)) return {ok: true, repeated: true};
  if (!holdsLease(props, body)) return {ok: false, error: 'this run no longer holds the lease'};
  var state = loadState(props), r = body.run || {};
  if (!state) return {ok: false, error: 'no saved state'};
  var run = {now: Number(r.now), props: props, state: state, events: r.events || [], trades: r.trades || [],
             keys: r.hasKeys ? {} : null, mode: r.mode, newMode: r.newMode || null, ticker: r.ticker || null,
             errorThisRun: !!r.errorThisRun, waiting: r.waiting || null, keyProblem: r.keyProblem || null};
  try {
    new Dashboard().update(run);
  } catch (e) {
    console.log('Sheet update failed: ' + (e && e.stack || e));
  }
  try {
    sendMail(run);
  } catch (e) {
    console.log('Email failed: ' + (e && e.message || e));
  }
  saveState(props, state);
  props.setProperties({LAST_OK_AT: String(now), LAST_RUN_ID: String(body.runId)});
  props.deleteProperty('RUN_LEASE');
  watchdog(props, now);
  return {ok: true};
}

function bridgeCrash(props, body, now) {
  var message = String(body.message || 'unknown error').slice(0, 2000);
  if (holdsLease(props, body)) props.deleteProperty('RUN_LEASE');
  try {
    new Dashboard().sheet('Log', ['Time (IST)', 'Level', 'Message']).appendRow([ist(now), 'alert', 'The run failed: ' + message.slice(0, 500)]);
  } catch (e) {
    console.log('Could not log the failed run: ' + e);
  }
  reportCrash(message);
  return {ok: true};
}

function bridgeConfig(props, body) {
  var set = [];
  ['GITHUB_TOKEN', 'OWNER_EMAIL'].forEach(function (key) {
    if (!(key in body)) return;
    var value = String(body[key] || '').trim();
    if (value) props.setProperty(key, value); else props.deleteProperty(key);
    set.push(key);
  });
  return {ok: true, set: set};
}

function bridgeStatus(props, now) {
  var state = loadState(props), book = state && state.book;
  return {ok: true, version: CODE_VERSION, now: now, lastOkAt: Number(props.getProperty('LAST_OK_AT') || 0) || null,
          lease: readLease(props), dispatchError: props.getProperty('DISPATCH_ERROR'),
          triggers: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }),
          hasKeys: !!readKeys(props), hasGithubToken: !!props.getProperty('GITHUB_TOKEN'), hasOwnerEmail: !!props.getProperty('OWNER_EMAIL'),
          mode: new Dashboard().mode(), runs: state ? state.runs : 0, errors: state ? state.errors : null,
          book: book ? {kind: book.kind, value: book.lastValue, cash: book.cash, coins: Object.keys(book.positions), halted: !!book.halted} : null};
}

// ---------------------------------------------------------------- one run

function traderStep(now) {
  var props = PropertiesService.getScriptProperties();
  var state = loadState(props) || freshState(now);
  var dash = new Dashboard();
  var run = {now: now, props: props, state: state, events: [], trades: [], keys: readKeys(props),
             mode: dash.mode(), newMode: null, blocked: false, ticker: null, errorThisRun: false};
  if (run.mode === null) {
    run.mode = 'PAUSE';
    run.events.push({level: 'warning', message: 'The Mode cell is not LIVE, PAUSE, SELL ALL or RESET, so the bot is treating it as PAUSE.'});
  }
  state.runs += 1;
  state.lastRunAt = now;
  if (guarded(run, 'prices', function () { run.ticker = fetchTicker(now); })) {
    state.lastTicker = run.ticker;
    CONFIG.pairs.forEach(function (pair) { if (run.ticker[pair]) state.lastPrices[pair] = run.ticker[pair].mid; });
    guarded(run, 'market rules', function () { refreshMarkets(state, now); });
    guarded(run, 'live start', chooseBook);
    if (state.book.kind === 'live' && !run.keys) {
      run.events.push({level: 'alert', message: 'The CoinDCX API key was removed, so the bot can neither trade nor use its loss brake. ' +
                       'Its coins stay in your CoinDCX wallet.'});
    }
    if (state.book.kind === 'live' && run.keys) {
      if (!guarded(run, 'unfinished orders', settlePending) || !guarded(run, 'balances', reconcile)) run.blocked = true;
    }
    guarded(run, 'rules', function () { advanceSleeves(run, Math.floor(now / HOUR_MS) * HOUR_MS); });
    applyMode(run);
    checkBrake(run);
    if (run.mode !== 'PAUSE' && !run.blocked) guarded(run, 'orders', rebalance);
    markBook(state, run.ticker);
  }
  if (!run.errorThisRun) state.errors.consecutive = 0;
  saveState(props, state);
  try {
    dash.update(run);
  } catch (e) {
    console.log('Sheet update failed: ' + (e && e.stack || e));
  }
  try {
    sendMail(run);
  } catch (e) {
    console.log('Email failed: ' + (e && e.message || e));
  }
  saveState(props, state);
  return run;
}

function guarded(run, what, fn) {
  try {
    fn(run);
    return true;
  } catch (e) {
    noteError(run, what, e);
    return false;
  }
}

function noteError(run, what, e) {
  var errors = run.state.errors;
  if (!run.errorThisRun) errors.consecutive += 1;
  run.errorThisRun = true;
  errors.total += 1;
  errors.lastAt = run.now;
  errors.lastMessage = (what + ': ' + (e && e.message || e)).slice(0, 300);
  var known = e instanceof ApiError || e instanceof DataError;
  run.events.push({level: !known || errors.consecutive >= 3 ? 'alert' : 'warning',
                   message: (known ? '' : 'Unexpected error in ') + errors.lastMessage +
                            (known ? '' : '\n' + String(e && e.stack || '').slice(0, 1500))});
}

// ---------------------------------------------------------------- state

function freshState(now) {
  var weights = {}, sleeves = {};
  CONFIG.rules.forEach(function (rule) {
    weights[rule] = 1 / CONFIG.rules.length;
    sleeves[rule] = {acct: freshAccount(CONFIG.sleeveCapitalInr, now), lastReview: null, retryAt: null, pending: null,
                     halted: null, weekStartValue: null};
  });
  return {v: 1, createdAt: now, runs: 0, lastRunAt: null, lastHour: null, seq: 0, valueRowHour: null,
          errors: {consecutive: 0, total: 0, lastAt: null, lastMessage: ''},
          markets: {fetchedAt: 0, info: {}}, weights: weights, weightsAt: null, sleeves: sleeves,
          book: freshBook('paper', CONFIG.capitalInr, now), paperArchive: null,
          mail: {dailyDate: '', sent: {}}, lastPrices: {}, lastTicker: null};
}

function freshAccount(capital, now) {
  return {capital: capital, cash: capital, positions: {}, fees: 0, spread: 0, tdsCredit: 0, taxDue: 0, sellVolume: 0,
          trades: 0, wins: 0, losses: 0, lastValue: capital, peak: capital, maxDd: 0, startedAt: now};
}

function freshBook(kind, capital, now) {
  var book = freshAccount(capital, now);
  book.kind = kind;
  book.halted = null;
  book.flags = allFlags();
  book.pending = [];
  book.refusals = {};
  book.btcStart = null;
  book.lastTradeAt = null;
  return book;
}

function allFlags() {
  var flags = {};
  CONFIG.pairs.forEach(function (pair) { flags[pair] = true; });
  return flags;
}

function loadState(props) {
  var parts = Number(props.getProperty('STATE_PARTS') || 0);
  if (!parts) return null;
  var text = '';
  for (var i = 0; i < parts; i++) text += props.getProperty('STATE_' + i) || '';
  return JSON.parse(text);
}

function saveState(props, state) {
  var text = JSON.stringify(state), values = {}, n = 0;
  for (var i = 0; i < text.length; i += 7000) values['STATE_' + n++] = text.slice(i, i + 7000);
  values.STATE_PARTS = String(n);
  props.setProperties(values);
}

function readKeys(props) {
  var key = props.getProperty('COINDCX_API_KEY'), secret = props.getProperty('COINDCX_API_SECRET');
  return key && secret ? {key: key, secret: secret} : null;
}

// ---------------------------------------------------------------- CoinDCX

function request(url, options, what, retries) {
  var lastError = null;
  for (var attempt = 0; attempt <= retries; attempt++) {
    if (attempt) sleepMs(1500 * attempt);
    var response;
    try {
      response = UrlFetchApp.fetch(url, Object.assign({muteHttpExceptions: true},
                                                      typeof options === 'function' ? options() : options));
    } catch (e) {
      lastError = new ApiError(what + ': ' + (e && e.message || e), 0, '');
      continue;
    }
    var code = response.getResponseCode(), body = response.getContentText();
    if (code === 429 || code >= 500) {
      lastError = new ApiError(what + ': HTTP ' + code + ' ' + briefBody(body), code, body);
      continue;
    }
    var data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      throw new ApiError(what + ': HTTP ' + code + ' and not JSON: ' + briefBody(body), code, body);
    }
    if (code !== 200) {
      throw new ApiError(what + ': HTTP ' + code + ' ' + (data && data.message ? data.message : body.slice(0, 200)), code, body);
    }
    return data;
  }
  throw lastError;
}

/** A reply body short enough for a message: an HTML page, such as a firewall's block page, becomes its title. */
function briefBody(body) {
  var text = String(body || '');
  if (!/^\s*</.test(text)) return text.slice(0, 200);
  var title = (text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1];
  var words = title || text.replace(/<!--[\s\S]*?-->|<(script|style)[\s\S]*?<\/\1>|<[^>]*>/gi, ' ');
  return 'HTML page "' + words.replace(/\s+/g, ' ').trim().slice(0, 120) + '"';
}

function privateCall(keys, path, body, retries) {
  return request(API_URL + path, function () {
    var payload = JSON.stringify(Object.assign({}, body, {timestamp: nowMs()}));
    return {method: 'post', contentType: 'application/json', payload: payload,
            headers: {'X-AUTH-APIKEY': keys.key, 'X-AUTH-SIGNATURE': hmacHex(payload, keys.secret)}};
  }, path, retries);
}

function hmacHex(text, secret) {
  return Utilities.computeHmacSha256Signature(text, secret).map(function (b) {
    return ('0' + (b & 255).toString(16)).slice(-2);
  }).join('');
}

function fetchTicker(now) {
  var rows = request(API_URL + '/exchange/ticker', {method: 'get'}, 'ticker', 2);
  if (!Array.isArray(rows)) throw new ApiError('ticker: unexpected reply', 200, '');
  var out = {};
  CONFIG.pairs.forEach(function (pair) {
    var symbol = CONFIG.markets[pair].symbol;
    var row = rows.find(function (r) { return r && r.market === symbol; });
    if (!row) return;
    var bid = Number(row.bid), ask = Number(row.ask), t = Number(row.timestamp);
    if (!(bid > 0) || !(ask >= bid) || !isFinite(ask)) return;
    if (t < 1e12) t *= 1000;
    out[pair] = {bid: bid, ask: ask, mid: (bid + ask) / 2, spread: (ask - bid) / ((ask + bid) / 2), t: t,
                 fresh: !(Math.abs(now - t) > 15 * 60000)};
  });
  if (!Object.keys(out).length) throw new ApiError('ticker: none of the four markets were listed', 200, '');
  return out;
}

function refreshMarkets(state, now) {
  if (now - state.markets.fetchedAt < DAY_MS && Object.keys(state.markets.info).length) return;
  var rows = request(API_URL + '/exchange/v1/markets_details', {method: 'get'}, 'market rules', 1);
  var info = {};
  CONFIG.pairs.forEach(function (pair) {
    var row = (rows || []).find(function (r) { return r && r.symbol === CONFIG.markets[pair].symbol; });
    if (!row) return;
    info[pair] = {active: row.status === 'active' && (row.order_types || []).indexOf('limit_order') >= 0,
                  step: Number(row.step), minQty: Number(row.min_quantity), maxQty: Number(row.max_quantity),
                  minNotional: Number(row.min_notional), qtyDecimals: Number(row.target_currency_precision),
                  priceDecimals: Number(row.base_currency_precision), minPrice: Number(row.min_price),
                  maxPrice: Number(row.max_price)};
  });
  state.markets = {fetchedAt: now, info: info};
}

function market(state, pair) {
  var base = CONFIG.markets[pair], live = state.markets.info[pair] || {};
  var pick = function (value, fallback) { return Number.isFinite(value) && value > 0 ? value : fallback; };
  return {symbol: base.symbol, coin: base.coin, halfSpread: base.halfSpread, active: live.active !== false,
          step: pick(live.step, base.step), minQty: pick(live.minQty, base.minQty), maxQty: pick(live.maxQty, Infinity),
          minNotional: Math.max(pick(live.minNotional, 0), CONFIG.minNotionalInr),
          qtyDecimals: Number.isFinite(live.qtyDecimals) ? live.qtyDecimals : base.qtyDecimals,
          priceDecimals: Number.isFinite(live.priceDecimals) ? live.priceDecimals : base.priceDecimals,
          minPrice: pick(live.minPrice, 0), maxPrice: pick(live.maxPrice, Infinity)};
}

function fetchBalances(keys) {
  var rows = privateCall(keys, '/exchange/v1/users/balances', {}, 2);
  if (!Array.isArray(rows)) throw new ApiError('balances: unexpected reply', 200, JSON.stringify(rows).slice(0, 200));
  var out = {};
  rows.forEach(function (row) {
    var free = Number(row.balance) || 0, locked = Number(row.locked_balance) || 0;
    out[row.currency] = {free: free, locked: locked, total: free + locked};
  });
  return out;
}

function balanceOf(balances, currency) {
  return balances && balances[currency] ? balances[currency].total : 0;
}

function fetchHistories(now) {
  var histories = {};
  CONFIG.pairs.forEach(function (pair) {
    var rows = request(PUBLIC_URL + '/market_data/candles?pair=' + encodeURIComponent(pair) + '&interval=1h&limit=1000',
                       {method: 'get'}, pair + ' candles', 2);
    histories[pair] = new History(pair, contiguousTail(parseCandles(rows, now), now, pair));
  });
  return histories;
}

function parseCandles(rows, now) {
  if (!Array.isArray(rows)) throw new DataError('candles: expected a list');
  var byTime = {};
  rows.forEach(function (row) {
    var t = Number(row && row.time), o = Number(row && row.open), h = Number(row && row.high);
    var l = Number(row && row.low), c = Number(row && row.close), v = Number(row && row.volume || 0);
    if (!(t >= 0) || ![o, h, l, c].every(function (p) { return isFinite(p) && p > 0; }) || !isFinite(v) || v < 0 ||
        h < Math.max(o, c) || l > Math.min(o, c) || h < l || t + HOUR_MS > now) return;
    byTime[t] = {t: t, o: o, h: h, l: l, c: c, v: v};
  });
  var out = [];
  Object.keys(byTime).map(Number).sort(function (a, b) { return a - b; }).forEach(function (t) {
    var prev = out[out.length - 1];
    if (prev && t - prev.t > HOUR_MS && t - prev.t <= 7 * HOUR_MS) {
      for (var gap = prev.t + HOUR_MS; gap < t; gap += HOUR_MS) out.push({t: gap, o: prev.c, h: prev.c, l: prev.c, c: prev.c, v: 0});
    }
    out.push(byTime[t]);
  });
  return out;
}

function contiguousTail(rows, now, pair) {
  if (!rows.length) throw new DataError(pair + ': no closed candles');
  var i = rows.length - 1;
  while (i > 0 && rows[i - 1].t + HOUR_MS === rows[i].t) i--;
  var tail = rows.slice(i);
  if (now - (tail[tail.length - 1].t + HOUR_MS) > 3 * HOUR_MS) throw new DataError(pair + ': no candle closed in the last 3 hours');
  return tail;
}

// ---------------------------------------------------------------- the four rules (ported from sim/slow_signals.py)

class History {
  constructor(pair, rows) {
    if (!rows.length) throw new DataError(pair + ' has no candles');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var ok = r.t % HOUR_MS === 0 && Math.min(r.o, r.h, r.l, r.c) > 0 && r.v >= 0 &&
               [r.o, r.h, r.l, r.c, r.v].every(isFinite) && r.h >= Math.max(r.o, r.c) && r.l <= Math.min(r.o, r.c) &&
               (i === 0 || r.t === rows[i - 1].t + HOUR_MS);
      if (!ok) throw new DataError(pair + ' candle ' + i + ' is malformed or the series has a gap');
    }
    this.pair = pair;
    this.rows = rows;
    this.times = rows.map(function (row) { return row.t; });
  }

  index(t) {
    var lo = 0, hi = this.times.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (this.times[mid] < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  closed(t, hours) {
    var i = this.index(t);
    if (i < hours || this.rows[i - 1].t + HOUR_MS !== t) throw new DataError(this.pair + ' lacks ' + hours + ' completed hours at ' + t);
    return this.rows.slice(i - hours, i);
  }

  returnOver(t, hours) {
    var bars = this.closed(t, hours + 1);
    return bars[bars.length - 1].c / bars[0].c - 1;
  }
}

function fsum(values) {
  var sum = 0, carry = 0;
  values.forEach(function (x) {
    var t = sum + x;
    carry += Math.abs(sum) >= Math.abs(x) ? (sum - t) + x : (x - t) + sum;
    sum = t;
  });
  return sum + carry;
}

function mean(values) { return fsum(values) / values.length; }

function median(values) {
  var a = values.slice().sort(function (p, q) { return p - q; }), m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function isLiquid(history, t) {
  return median(history.closed(t, 24).map(function (r) { return r.v * r.c; })) >= 50000;
}

function isTrending(history, t) {
  var closes = history.closed(t, 30 * 24).map(function (r) { return r.c; });
  return history.returnOver(t, 30 * 24) > 0 && closes[closes.length - 1] >= mean(closes) && isLiquid(history, t);
}

/** Target weights for one sleeve at decision time t, from candles closed at or before t only. */
function targets(rule, histories, t, held) {
  var pairs = CONFIG.pairs, out = {};
  if (rule === 'btc_sma30') {
    var btc = histories[pairs[0]], closes = btc.closed(t, 30 * 24).map(function (r) { return r.c; });
    if (closes[closes.length - 1] >= mean(closes) && isLiquid(btc, t)) out[pairs[0]] = 0.95;
    return out;
  }
  if (rule === 'tsmom30') {
    pairs.forEach(function (pair) { if (isTrending(histories[pair], t)) out[pair] = 0.25; });
    return out;
  }
  if (rule === 'crossmom7') {
    var ranked = pairs.filter(function (pair) { return isLiquid(histories[pair], t); })
      .map(function (pair) { return [histories[pair].returnOver(t, 7 * 24), pair]; })
      .sort(function (a, b) { return (b[0] - a[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0); });
    var positive = ranked.filter(function (x) { return x[0] > 0; }).map(function (x) { return x[1]; });
    var top = positive.slice(0, 3);
    var chosen = held.filter(function (pair) { return top.indexOf(pair) >= 0; });
    for (var i = 0; i < positive.length && chosen.length < 2; i++) {
      if (chosen.indexOf(positive[i]) < 0) chosen.push(positive[i]);
    }
    chosen.slice(0, 2).forEach(function (pair) { out[pair] = 0.45; });
    return out;
  }
  if (rule === 'donchian20_10') {
    pairs.forEach(function (pair) {
      var history = histories[pair], bars = history.closed(t, 20 * 24 + 1), latest = bars[bars.length - 1];
      var high = -Infinity, low = Infinity, j;
      for (j = 0; j < bars.length - 1; j++) high = Math.max(high, bars[j].h);
      for (j = bars.length - (10 * 24 + 1); j < bars.length - 1; j++) low = Math.min(low, bars[j].l);
      if (held.indexOf(pair) >= 0) {
        if (latest.c >= low) out[pair] = 0.25;
      } else if (latest.c > high && isLiquid(history, t)) {
        out[pair] = 0.25;
      }
    });
    return out;
  }
  throw new Error('unknown rule ' + rule);
}

function isWeekStart(t) { return (t - MONDAY_MS) % WEEK_MS === 0; }
function isReviewTime(rule, t) { return rule === 'crossmom7' ? isWeekStart(t) : t % DAY_MS === 0; }

// ---------------------------------------------------------------- paper accounts (ported from sim/accounts.py)

function floorStep(qty, step, decimals) {
  var value = Math.floor(qty / step + 1e-9) * step;
  return Number(value.toFixed(decimals === undefined ? 12 : decimals));
}

function round12(x) { return Number(x.toFixed(12)); }

function paperBuy(acct, pair, budget, price, t, reason) {
  var m = CONFIG.markets[pair];
  budget = Math.min(budget, acct.cash);
  var fill = price * (1 + m.halfSpread);
  var qty = floorStep(budget / (fill * (1 + feeRate())), m.step);
  var value = qty * fill;
  if (qty <= 0 || qty < m.minQty || value < CONFIG.minNotionalInr) return 0;
  var fee = value * feeRate();
  acct.cash -= value + fee;
  acct.fees += fee;
  acct.spread += qty * Math.abs(fill - price);
  var pos = acct.positions[pair] || (acct.positions[pair] = {qty: 0, cost: 0, fee: 0, t: t});
  pos.qty += qty;
  pos.cost += value;
  pos.fee += fee;
  return qty;
}

function paperSell(acct, pair, price, t, reason) {
  var pos = acct.positions[pair];
  if (!pos) return 0;
  var m = CONFIG.markets[pair];
  var qty = pos.qty, fill = price * (1 - m.halfSpread), value = qty * fill, fee = value * feeRate();
  var gain = value - pos.cost, tax = gain > 0 ? gain * CONFIG.taxRate : 0;
  acct.sellVolume += value;
  var tds = acct.sellVolume > CONFIG.tdsThresholdInr ? value * CONFIG.tdsRate : 0;
  acct.cash += value - fee - tds;
  acct.fees += fee;
  acct.spread += qty * Math.abs(fill - price);
  acct.tdsCredit += tds;
  acct.taxDue += tax;
  var pnl = value - pos.cost - pos.fee - fee - tax;
  acct.trades += 1;
  if (pnl > 0) acct.wins += 1; else acct.losses += 1;
  delete acct.positions[pair];
  return qty;
}

function liquidationValue(acct, prices) {
  var value = acct.cash + acct.tdsCredit - acct.taxDue;
  Object.keys(acct.positions).forEach(function (pair) {
    var pos = acct.positions[pair];
    var proceeds = pos.qty * prices[pair] * (1 - CONFIG.markets[pair].halfSpread);
    var gain = proceeds - pos.cost;
    value += proceeds * (1 - feeRate()) - (gain > 0 ? gain * CONFIG.taxRate : 0);
  });
  return value;
}

function markAccount(acct, value) {
  acct.lastValue = value;
  acct.peak = Math.max(acct.peak, value);
  if (acct.peak > 0) acct.maxDd = Math.min(1, Math.max(acct.maxDd, 1 - value / acct.peak));
  return value;
}

// ---------------------------------------------------------------- sleeves

function advanceSleeves(run, hour) {
  var state = run.state;
  if (state.lastHour !== null && state.lastHour >= hour) return;
  var histories = fetchHistories(run.now);
  var pricesNow = currentPrices(state, run.ticker);
  var before = blendedWeights(state, pricesNow);
  var changed = {};
  var t = state.lastHour === null ? hour : Math.max(state.lastHour + HOUR_MS, hour - CONFIG.maxCatchUpHours * HOUR_MS);
  for (; t <= hour; t += HOUR_MS) {
    var prices = closesAt(histories, t);
    if (!prices) break;
    if (isWeekStart(t) && state.weightsAt !== t) learnWeights(state, prices, t);
    CONFIG.rules.forEach(function (rule) { sleeveStep(state.sleeves[rule], rule, histories, t, prices, changed); });
    state.lastHour = t;
  }
  var after = blendedWeights(state, pricesNow);
  CONFIG.pairs.forEach(function (pair) {
    if (changed[pair] || Math.abs(after[pair] - before[pair]) >= 0.01) state.book.flags[pair] = true;
  });
}

function closesAt(histories, t) {
  var prices = {};
  try {
    CONFIG.pairs.forEach(function (pair) { prices[pair] = histories[pair].closed(t, 1)[0].c; });
  } catch (e) {
    if (e instanceof DataError) return null;
    throw e;
  }
  return prices;
}

function sleeveStep(sleeve, rule, histories, t, prices, changed) {
  var acct = sleeve.acct;
  var value = markAccount(acct, liquidationValue(acct, prices));
  if (!sleeve.halted && (value <= CONFIG.brake * acct.capital || value <= CONFIG.brake * acct.peak)) {
    sleeve.halted = t;
    sleeve.pending = {};
  }
  var due = !sleeve.halted && (sleeve.lastReview === null || isReviewTime(rule, t) ||
                               (sleeve.retryAt !== null && t >= sleeve.retryAt));
  if (due) {
    try {
      sleeve.pending = targets(rule, histories, t, Object.keys(acct.positions));
      sleeve.lastReview = t;
      sleeve.retryAt = null;
    } catch (e) {
      if (!(e instanceof DataError)) throw e;
      sleeve.retryAt = t + HOUR_MS;
    }
  }
  if (sleeve.pending && executeSleeve(acct, sleeve.pending, histories, t, prices, rule, changed)) sleeve.pending = null;
}

function executeSleeve(acct, desired, histories, t, prices, rule, changed) {
  var bars = {};
  CONFIG.pairs.forEach(function (pair) { bars[pair] = histories[pair].closed(t, 1)[0]; });
  var liquidEnough = function (pair, value) { return bars[pair].v * bars[pair].c >= 10 * value; };
  var deferredExit = false;
  Object.keys(acct.positions).filter(function (pair) { return !(pair in desired); }).sort().forEach(function (pair) {
    if (liquidEnough(pair, acct.positions[pair].qty * prices[pair])) {
      paperSell(acct, pair, prices[pair], t, rule + ' exit');
      changed[pair] = true;
    } else {
      deferredExit = true;
    }
  });
  if (deferredExit) return false;
  var deferredEntry = false;
  Object.keys(desired).filter(function (pair) { return !(pair in acct.positions); }).sort().forEach(function (pair) {
    var equity = Math.max(0, liquidationValue(acct, prices));
    if (!liquidEnough(pair, desired[pair] * equity)) {
      deferredEntry = true;
      return;
    }
    var budget = Math.min(desired[pair] * equity, Math.max(0, acct.cash - acct.taxDue));
    if (paperBuy(acct, pair, budget, prices[pair], t, rule + ' entry') > 0) changed[pair] = true;
  });
  return !deferredEntry;
}

function learnWeights(state, prices, t) {
  var raw = CONFIG.rules.map(function (rule) {
    var sleeve = state.sleeves[rule], value = liquidationValue(sleeve.acct, prices), weight = state.weights[rule];
    if (sleeve.weekStartValue > 0 && value > 0) weight *= Math.pow(value / sleeve.weekStartValue, CONFIG.learnRate);
    sleeve.weekStartValue = value;
    return weight;
  });
  var bounded = boundWeights(raw, CONFIG.minWeight, CONFIG.maxWeight);
  CONFIG.rules.forEach(function (rule, i) { state.weights[rule] = bounded[i]; });
  state.weightsAt = t;
}

function boundWeights(raw, lo, hi) {
  var total = fsum(raw);
  var w = raw.map(function (x) { return total > 0 ? x / total : 1 / raw.length; });
  for (var iter = 0; iter < 100; iter++) {
    w = w.map(function (x) { return Math.min(hi, Math.max(lo, x)); });
    var sum = fsum(w);
    if (Math.abs(sum - 1) < 1e-12) break;
    var movable = w.map(function (x) { return sum > 1 ? x > lo : x < hi; });
    var movableSum = fsum(w.filter(function (x, i) { return movable[i]; }));
    if (!(movableSum > 0)) break;
    w = w.map(function (x, i) { return movable[i] ? x + (1 - sum) * x / movableSum : x; });
  }
  return w;
}

function blendedWeights(state, prices) {
  var out = {}, total = 0;
  CONFIG.pairs.forEach(function (pair) { out[pair] = 0; });
  CONFIG.rules.forEach(function (rule) {
    var acct = state.sleeves[rule].acct, value = liquidationValue(acct, prices);
    if (!(value > 0)) return;
    Object.keys(acct.positions).forEach(function (pair) {
      out[pair] += state.weights[rule] * acct.positions[pair].qty * prices[pair] / value;
    });
  });
  CONFIG.pairs.forEach(function (pair) { total += out[pair]; });
  if (total > CONFIG.maxInvested) CONFIG.pairs.forEach(function (pair) { out[pair] *= CONFIG.maxInvested / total; });
  return out;
}

function currentPrices(state, ticker) {
  var prices = {};
  CONFIG.pairs.forEach(function (pair) {
    prices[pair] = ticker && ticker[pair] ? ticker[pair].mid : state.lastPrices[pair];
  });
  return prices;
}

// ---------------------------------------------------------------- the real wallet

function chooseBook(run) {
  var state = run.state;
  if (state.book.kind === 'live' || !run.keys || run.mode !== 'LIVE') return;
  var balances;
  try {
    balances = fetchBalances(run.keys);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    run.keyProblem = e.message;
    run.events.push({level: 'alert', message: 'CoinDCX rejected the saved API key, so the bot keeps paper trading: ' + e.message});
    return;
  }
  var inr = balances.INR ? balances.INR.free : 0;
  if (inr < CONFIG.minStartInr) {
    run.waiting = 'CoinDCX shows ' + rupees(inr) + ' of free INR. Deposit at least ' + rupees(CONFIG.minStartInr) +
                  ' and live trading starts on the next run.';
    return;
  }
  state.paperArchive = {startedAt: state.book.startedAt, endedAt: run.now, capital: state.book.capital,
                        value: bookValue(state, state.book, run.ticker), trades: state.book.trades};
  state.book = freshBook('live', Math.min(inr, CONFIG.capitalInr), run.now);
  state.book.btcStart = run.ticker['I-BTC_INR'] ? run.ticker['I-BTC_INR'].ask : null;
  run.events.push({level: 'notice', message: 'Live trading started with ' + rupees(state.book.capital) + ' of your CoinDCX INR.'});
}

function settlePending(run) {
  run.state.book.pending.slice().forEach(function (order) {
    if (!finishOrder(run, order)) throw new ApiError('an earlier order is still unresolved; no new orders this run', 0, '');
  });
}

function reconcile(run) {
  var book = run.state.book, balances = fetchBalances(run.keys);
  Object.keys(book.positions).forEach(function (pair) {
    var pos = book.positions[pair], coin = CONFIG.markets[pair].coin, held = balanceOf(balances, coin);
    var step = market(run.state, pair).step;
    if (pos.qty <= held + step * 0.01) return;
    if (pos.qty - held >= step) {
      run.events.push({level: 'alert', message: 'CoinDCX holds ' + held + ' ' + coin + ' but the bot expected ' + pos.qty +
                       '. Using the CoinDCX figure. Was some sold or moved outside the bot?'});
    }
    if (held <= 0) {
      delete book.positions[pair];
    } else {
      var share = held / pos.qty;
      pos.qty = held;
      pos.cost *= share;
      pos.fee *= share;
    }
  });
  var inr = balanceOf(balances, 'INR');
  if (book.cash > inr + 1) {
    run.events.push({level: 'alert', message: 'CoinDCX holds ' + rupees(inr) + ' INR but the bot expected ' + rupees(book.cash) +
                     '. Using the CoinDCX figure.'});
    book.cash = inr;
  }
}

function applyMode(run) {
  var book = run.state.book;
  if (run.mode !== 'RESET') return;
  if (book.halted) {
    var value = bookValue(run.state, book, run.ticker);
    book.halted = null;
    book.capital = value;
    book.peak = value;
    book.flags = allFlags();
    run.events.push({level: 'notice', message: 'Loss brake reset. Trading again from ' + rupees(value) + '.'});
  }
  run.mode = 'LIVE';
  run.newMode = 'LIVE';
}

function checkBrake(run) {
  var book = run.state.book;
  if (book.halted || run.mode === 'PAUSE') return;
  var value = bookValue(run.state, book, run.ticker);
  book.peak = Math.max(book.peak, value);
  var fromStart = value <= CONFIG.brake * book.capital, fromPeak = value <= CONFIG.brake * book.peak;
  if (!fromStart && !fromPeak) return;
  book.halted = {at: run.now, value: value, reason: fromStart ? 'fell to 80% of its starting money' : 'fell 20% from its peak'};
  book.flags = allFlags();
  run.events.push({level: 'notice', message: 'Loss brake: the wallet ' + book.halted.reason + ' (' + rupees(value) +
                   '). Selling everything and stopping. Set Mode to RESET to start again.'});
}

function bookValue(state, book, ticker) {
  var value = book.cash + book.tdsCredit - book.taxDue;
  Object.keys(book.positions).forEach(function (pair) {
    var pos = book.positions[pair];
    var bid = ticker && ticker[pair] ? ticker[pair].bid : state.lastPrices[pair] || 0;
    var proceeds = pos.qty * bid, gain = proceeds - pos.cost;
    value += proceeds * (1 - feeRate()) - (gain > 0 ? gain * CONFIG.taxRate : 0);
  });
  return value;
}

function markBook(state, ticker) {
  markAccount(state.book, bookValue(state, state.book, ticker));
}

function rebalance(run) {
  var state = run.state, book = state.book;
  if (book.kind === 'live' && !run.keys) return;
  var sellAll = run.mode === 'SELL ALL' || !!book.halted;
  var prices = currentPrices(state, run.ticker);
  var target = blendedWeights(state, prices);
  if (sellAll) CONFIG.pairs.forEach(function (pair) { target[pair] = 0; });
  var equity = book.cash - book.taxDue;
  Object.keys(book.positions).forEach(function (pair) {
    equity += book.positions[pair].qty * (run.ticker[pair] ? run.ticker[pair].bid : prices[pair]);
  });
  var band = Math.max(CONFIG.minOrderInr, CONFIG.rebalanceBand * equity);
  var sells = [], buys = [];
  CONFIG.pairs.forEach(function (pair) {
    if (!book.flags[pair] && !(sellAll && book.positions[pair])) return;
    var quote = run.ticker[pair], m = market(state, pair);
    var pos = book.positions[pair], held = pos ? pos.qty : 0;
    if (!quote || !quote.fresh || quote.spread > CONFIG.maxSpread || !m.active) {
      run.events.push({level: 'warning', message: m.coin + ': no fresh price, the spread is too wide or the market is closed; trying again next run.'});
      return;
    }
    var heldValue = held * quote.bid;
    if (target[pair] <= 0) {
      if (held >= m.minQty && heldValue >= m.minNotional) sells.push({pair: pair, qty: held, why: sellAll ? 'sell everything' : 'rules left ' + m.coin});
      else delete book.flags[pair];
      return;
    }
    var diff = target[pair] * equity - heldValue;
    if (diff <= -band) sells.push({pair: pair, qty: -diff / quote.bid, why: 'trim to the rules\' weight'});
    else if (diff >= band) buys.push({pair: pair, inr: diff, why: 'rules hold ' + m.coin});
    else delete book.flags[pair];
  });
  for (var i = 0; i < sells.length && !run.blocked; i++) placeOrder(run, 'sell', sells[i], target, equity, band);
  for (var j = 0; j < buys.length && !run.blocked && !sellAll; j++) placeOrder(run, 'buy', buys[j], target, equity, band);
  if (run.mode === 'SELL ALL' && !run.blocked && !Object.keys(book.positions).some(function (pair) {
    var m = market(state, pair), quote = run.ticker[pair], pos = book.positions[pair];
    return pos.qty >= m.minQty && pos.qty * (quote ? quote.bid : prices[pair]) >= m.minNotional;
  })) {
    run.newMode = 'PAUSE';
    run.events.push({level: 'notice', message: 'Sold everything the bot held. Mode is now PAUSE.'});
  }
}

function placeOrder(run, side, plan, target, equity, band) {
  var state = run.state, book = state.book, pair = plan.pair, m = market(state, pair), quote = run.ticker[pair];
  var live = book.kind === 'live', price, qty;
  if (side === 'buy') {
    price = roundUp(quote.ask * (live ? 1 + CONFIG.limitSlack : 1), m.priceDecimals);
    var budget = Math.min(plan.inr, book.cash - book.taxDue - 1);
    qty = floorStep(budget / (price * (1 + feeRate())), m.step, m.qtyDecimals);
  } else {
    price = roundDown(quote.bid * (live ? 1 - CONFIG.limitSlack : 1), m.priceDecimals);
    qty = floorStep(Math.min(plan.qty, book.positions[pair] ? book.positions[pair].qty : 0), m.step, m.qtyDecimals);
  }
  var value = qty * price, cap = 1.05 * Math.max(CONFIG.capitalInr, book.capital, book.peak);
  if (!(qty >= m.minQty) || qty > m.maxQty || value < m.minNotional || price < m.minPrice || price > m.maxPrice) {
    delete book.flags[pair];
    return;
  }
  if (value > cap) {
    run.blocked = true;
    run.events.push({level: 'alert', message: 'Refused an order worth ' + rupees(value) + ', above the ' + rupees(cap) + ' safety cap. Please check the bot.'});
    return;
  }
  if (live) liveOrder(run, side, pair, qty, price, plan.why); else paperOrder(run, side, pair, qty, quote, plan.why);
  var after = book.positions[pair] ? book.positions[pair].qty * quote.bid : 0;
  var remaining = target[pair] * equity - after;
  if (target[pair] <= 0 ? !book.positions[pair] || book.positions[pair].qty < m.minQty || after < m.minNotional
                        : Math.abs(remaining) < band) delete book.flags[pair];
}

function roundUp(x, decimals) {
  var f = Math.pow(10, decimals);
  return Number((Math.ceil(x * f - 1e-9) / f).toFixed(decimals));
}

function roundDown(x, decimals) {
  var f = Math.pow(10, decimals);
  return Number((Math.floor(x * f + 1e-9) / f).toFixed(decimals));
}

function paperOrder(run, side, pair, qty, quote, why) {
  var book = run.state.book;
  if (side === 'buy') {
    var price = quote.ask, value = qty * price, fee = value * feeRate();
    applyBuy(run, pair, qty, price, value + fee, qty, why, 'paper');
  } else {
    var bid = quote.bid, proceeds = qty * bid, sellFee = proceeds * feeRate();
    var tds = book.sellVolume + proceeds > CONFIG.tdsThresholdInr ? proceeds * CONFIG.tdsRate : 0;
    applySell(run, pair, qty, bid, proceeds - sellFee - tds, sellFee, tds, why, 'paper');
  }
}

function liveOrder(run, side, pair, qty, price, why) {
  var state = run.state, book = state.book, m = market(state, pair);
  var before = fetchBalances(run.keys);
  var order = {clientId: CONFIG.orderPrefix + '-' + run.now.toString(36) + '-' + (++state.seq), id: null, side: side, pair: pair,
               qty: qty, price: price, at: nowMs(), why: why,
               before: {inr: balanceOf(before, 'INR'), coin: balanceOf(before, m.coin)}};
  book.pending.push(order);
  saveState(run.props, state);
  var reply = null;
  try {
    reply = privateCall(run.keys, '/exchange/v1/orders/create',
                        {side: side, order_type: 'limit_order', market: m.symbol, price_per_unit: price,
                         total_quantity: qty, client_order_id: order.clientId}, 0);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    if (e.code >= 400 && e.code < 500 && e.code !== 408 && e.code !== 429) {
      removePending(book, order);
      book.refusals = book.refusals || {};
      var refused = book.refusals[pair] = (book.refusals[pair] || 0) + 1;
      if (refused >= 3) delete book.flags[pair];
      saveState(run.props, state);
      run.events.push({level: refused >= 3 ? 'alert' : 'warning',
                       message: 'CoinDCX refused to ' + side + ' ' + m.coin + ' (' + refused + ' times in a row): ' + e.message +
                                (refused >= 3 ? ' The bot stops trying until the rules change.' : '')});
      return;
    }
    run.events.push({level: 'warning', message: 'No clear reply placing an order to ' + side + ' ' + m.coin + '; checking it by its id. ' + e.message});
  }
  var placed = reply && reply.orders && reply.orders[0];
  if (placed && placed.id) {
    order.id = String(placed.id);
    saveState(run.props, state);
  }
  if (!finishOrder(run, order)) {
    run.blocked = true;
    run.events.push({level: 'warning', message: 'An order to ' + side + ' ' + m.coin + ' is not settled yet; the next run finishes it.'});
  }
}

function removePending(book, order) {
  book.pending = book.pending.filter(function (o) { return o.clientId !== order.clientId; });
}

function orderStatus(keys, order) {
  try {
    var reply = privateCall(keys, '/exchange/v1/orders/status', order.id ? {id: order.id} : {client_order_id: order.clientId}, 2);
    if (reply && typeof reply.status === 'string') {
      if (!order.id && reply.id) order.id = String(reply.id);
      return reply;
    }
    return null;
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    if (e.code === 404 || (e.code >= 400 && e.code < 500 && /not\s*found|no order|does not exist/i.test(e.body + ' ' + e.message))) return {missing: true};
    return null;
  }
}

function isClosed(status) { return !!status && !status.missing && CLOSED_STATUSES.indexOf(status.status) >= 0; }
function isOpen(status) { return !!status && !status.missing && OPEN_STATUSES.indexOf(status.status) >= 0; }

/** Settles one order: waits briefly, cancels any unfilled rest, and books the fill. False if still unresolved. */
function finishOrder(run, order) {
  var book = run.state.book, status = null, i;
  for (i = 0; i < 6 && !isClosed(status); i++) {
    if (i) sleepMs(2000);
    status = orderStatus(run.keys, order);
    if (status && status.missing) break;
  }
  if (status && status.missing) {
    // Without an id the create reply was lost; wait a few runs before believing CoinDCX has no such order.
    if (nowMs() - order.at > (order.id ? DAY_MS : 10 * 60000)) {
      removePending(book, order);
      saveState(run.props, run.state);
      run.events.push({level: order.id ? 'alert' : 'warning', message: 'CoinDCX has no record of order ' + order.clientId + '; dropping it.'});
      return true;
    }
    return false;
  }
  if (isOpen(status)) {
    try {
      privateCall(run.keys, '/exchange/v1/orders/cancel', order.id ? {id: order.id} : {client_order_id: order.clientId}, 2);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
    }
    for (i = 0; i < 5 && !isClosed(status); i++) {
      sleepMs(1500);
      status = orderStatus(run.keys, order);
    }
  }
  if (!isClosed(status)) return false;
  bookLiveFill(run, order, status);
  removePending(book, order);
  saveState(run.props, run.state);
  return true;
}

function bookLiveFill(run, order, status) {
  var m = market(run.state, order.pair);
  var executed = round12(Number(status.total_quantity) - Number(status.remaining_quantity));
  if (!(executed > 0)) return;
  if (run.state.book.refusals) run.state.book.refusals[order.pair] = 0;
  var avg = Number(status.avg_price) > 0 ? Number(status.avg_price) : order.price;
  var value = executed * avg, expectedFee = value * feeRate(), reportedFee = Number(status.fee_amount) || 0;
  var fee = reportedFee >= 0.2 * expectedFee && reportedFee <= 3 * expectedFee ? reportedFee
          : reportedFee * avg >= 0.2 * expectedFee && reportedFee * avg <= 3 * expectedFee ? reportedFee * avg : expectedFee;
  var after = null;
  try {
    after = fetchBalances(run.keys);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
  }
  var inrDelta = after ? balanceOf(after, 'INR') - order.before.inr : null;
  var coinDelta = after ? balanceOf(after, m.coin) - order.before.coin : null;
  if (order.side === 'buy') {
    var spent = value + fee, got = executed;
    if (inrDelta !== null && -inrDelta >= 0.98 * value && -inrDelta <= value * (1 + 3 * feeRate()) + 1 &&
        coinDelta >= 0.98 * executed && coinDelta <= executed * 1.0001) {
      spent = -inrDelta;
      got = coinDelta;
    } else if (after) {
      run.events.push({level: 'warning', message: 'Balances moved unexpectedly around a ' + m.coin + ' buy; using the order\'s own figures.'});
    }
    applyBuy(run, order.pair, executed, avg, spent, got, order.why, order.id || order.clientId);
  } else {
    var received = value - fee, tds = 0;
    if (inrDelta !== null && inrDelta >= value * (1 - feeRate() - CONFIG.tdsRate) * 0.99 - 1 &&
        inrDelta <= value * (1 - feeRate()) * 1.01 + 1 && -coinDelta >= 0.98 * executed && -coinDelta <= executed * 1.0001) {
      received = inrDelta;
      tds = Math.max(0, value - fee - received);
    } else if (after) {
      run.events.push({level: 'warning', message: 'Balances moved unexpectedly around a ' + m.coin + ' sale; using the order\'s own figures.'});
    }
    applySell(run, order.pair, executed, avg, received, fee, tds, order.why, order.id || order.clientId);
  }
}

function applyBuy(run, pair, executed, price, spent, got, why, ref) {
  var book = run.state.book, value = executed * price, fee = spent - value + (executed - got) * price;
  book.cash -= spent;
  book.fees += fee;
  var pos = book.positions[pair] || (book.positions[pair] = {qty: 0, cost: 0, fee: 0, t: run.now});
  pos.qty = round12(pos.qty + got);
  pos.cost += value;
  pos.fee += fee;
  book.lastTradeAt = run.now;
  run.trades.push({t: run.now, kind: book.kind, side: 'BUY', pair: pair, qty: got, price: price, value: value, fee: fee,
                   tds: 0, tax: 0, pnl: null, why: why, ref: ref});
}

function applySell(run, pair, executed, price, received, fee, tds, why, ref) {
  var book = run.state.book, pos = book.positions[pair];
  var share = pos && pos.qty > 0 ? Math.min(1, executed / pos.qty) : 1;
  var cost = pos ? pos.cost * share : 0, buyFee = pos ? pos.fee * share : 0, value = executed * price;
  var gain = value - cost, tax = gain > 0 ? gain * CONFIG.taxRate : 0, pnl = value - cost - buyFee - fee - tax;
  book.cash += received;
  book.fees += fee;
  book.tdsCredit += tds;
  book.taxDue += tax;
  book.sellVolume += value;
  book.trades += 1;
  if (pnl > 0) book.wins += 1; else book.losses += 1;
  if (pos) {
    var m = market(run.state, pair), left = round12(pos.qty - executed);
    if (left < m.minQty * 0.5 || share >= 0.999999) {
      delete book.positions[pair];
    } else {
      pos.qty = left;
      pos.cost -= cost;
      pos.fee -= buyFee;
    }
  }
  book.lastTradeAt = run.now;
  run.trades.push({t: run.now, kind: book.kind, side: 'SELL', pair: pair, qty: executed, price: price, value: value, fee: fee,
                   tds: tds, tax: tax, pnl: pnl, why: why, ref: ref});
}

// ---------------------------------------------------------------- sheet

function prepareSheets() {
  var dash = new Dashboard();
  var control = dash.sheet('Control');
  if (!String(control.getRange('B3').getValue()).trim()) {
    control.getRange('A1').setValue('CoinDCX trader').setFontWeight('bold').setFontSize(14);
    control.getRange('A3:B3').setValues([['Mode', 'LIVE']]);
    control.getRange('A3').setFontWeight('bold');
    control.getRange('A4').setValue('LIVE trades real money once an API key is set (menu: Trader > Set CoinDCX API key), ' +
                                     'otherwise paper. PAUSE places no orders. SELL ALL sells what the bot bought, then pauses. ' +
                                     'RESET restarts after the loss brake.');
  }
  control.getRange('B3').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(MODES, true).build());
  control.setColumnWidth(1, 230);
  control.setColumnWidth(2, 520);
  dash.sheet('Trades', ['Time (IST)', 'Book', 'Side', 'Coin', 'Quantity', 'Price ₹', 'Value ₹', 'Fee ₹', 'TDS ₹',
                        'Tax set aside ₹', 'Result ₹', 'Why', 'Order']);
  dash.sheet('Value', ['Time (IST)', 'Book', 'Value if sold ₹', 'Cash ₹', 'BTC ₹', 'ETH ₹', 'SOL ₹', 'XRP ₹', 'Holding BTC instead ₹']);
  dash.sheet('Log', ['Time (IST)', 'Level', 'Message']);
}

class Dashboard {
  constructor() {
    this.ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!this.ss) throw new Error('This script must be bound to its Google Sheet.');
  }

  sheet(name, header) {
    var sheet = this.ss.getSheetByName(name);
    if (!sheet) {
      sheet = this.ss.insertSheet(name);
      if (header) {
        sheet.appendRow(header);
        sheet.setFrozenRows(1);
        sheet.getRange(1, 1, 1, header.length).setFontWeight('bold');
      }
    }
    return sheet;
  }

  mode() {
    var control = this.ss.getSheetByName('Control');
    var value = control ? String(control.getRange('B3').getValue()).trim().toUpperCase() : '';
    if (!value) return 'LIVE';
    return MODES.indexOf(value) >= 0 ? value : null;
  }

  update(run) {
    var state = run.state, book = state.book, control = this.sheet('Control');
    if (run.newMode) control.getRange('B3').setValue(run.newMode);
    var rows = statusRows(run);
    control.getRange(6, 1, 40, 6).clearContent();
    control.getRange(6, 1, rows.length, 2).setValues(rows);
    var sleeveRows = [['Rule', 'Weight in wallet', 'Paper value', 'Change', 'Holding', 'Trades']];
    var prices = currentPrices(state, run.ticker);
    CONFIG.rules.forEach(function (rule) {
      var sleeve = state.sleeves[rule], value = liquidationValue(sleeve.acct, prices);
      sleeveRows.push([CONFIG.ruleLabels[rule], pct(state.weights[rule], 0), rupees(value), signedPct(value / sleeve.acct.capital - 1),
                       holdingText(sleeve.acct.positions) + (sleeve.halted ? ' (loss brake)' : ''), sleeve.acct.trades]);
    });
    var at = 6 + rows.length + 1;
    control.getRange(at, 1, sleeveRows.length, 6).setValues(sleeveRows);
    control.getRange(at, 1, 1, 6).setFontWeight('bold');
    var trades = this.sheet('Trades');
    run.trades.forEach(function (tr) {
      trades.appendRow([ist(tr.t), tr.kind === 'live' ? 'Real' : 'Paper', tr.side, CONFIG.markets[tr.pair].coin, tr.qty, round2(tr.price),
                        round2(tr.value), round2(tr.fee), round2(tr.tds), round2(tr.tax), tr.pnl === null ? '' : round2(tr.pnl), tr.why, tr.ref]);
    });
    var hour = Math.floor(run.now / HOUR_MS) * HOUR_MS;
    if (state.valueRowHour !== hour) {
      state.valueRowHour = hour;
      var row = [ist(run.now), book.kind === 'live' ? 'Real' : 'Paper', round2(book.lastValue), round2(book.cash)];
      CONFIG.pairs.forEach(function (pair) {
        var pos = book.positions[pair];
        row.push(pos ? round2(pos.qty * (run.ticker && run.ticker[pair] ? run.ticker[pair].bid : prices[pair])) : 0);
      });
      row.push(book.btcStart && run.ticker && run.ticker['I-BTC_INR'] ? round2(benchmarkValue(book, run.ticker)) : '');
      this.sheet('Value').appendRow(row);
    }
    var log = this.sheet('Log');
    run.events.forEach(function (e) { log.appendRow([ist(run.now), e.level, e.message]); });
    if (log.getLastRow() > 3000) log.deleteRows(2, log.getLastRow() - 2500);
  }
}

function statusRows(run) {
  var state = run.state, book = state.book, live = book.kind === 'live';
  var prices = currentPrices(state, run.ticker);
  var rows = [
    ['Running as', live ? 'REAL MONEY on CoinDCX' : 'Paper (no real orders)' + (run.keys ? '' : ': add an API key to trade for real')],
    ['Mode in effect', run.mode + (book.halted ? ' (stopped by the loss brake on ' + ist(book.halted.at) + ')' : '')],
    ['Last run', ist(run.now) + (run.errorThisRun ? ' (with a problem, see Log)' : '')],
    ['Value if sold now', rupees(book.lastValue) + ' (' + signedPct(book.lastValue / book.capital - 1) + ' since ' + ist(book.startedAt).slice(0, 10) + ')'],
    ['Started with', rupees(book.capital)],
    ['Cash', rupees(book.cash)],
    ['Coins', holdingText(book.positions, prices) || 'none'],
    ['Estimated tax set aside', rupees(book.taxDue) + ' (31.2% of each profitable sale)'],
    ['TDS held by CoinDCX', rupees(book.tdsCredit) + ' (claimable when you file your return)'],
    ['Fees paid', rupees(book.fees)],
    ['Loss brake', 'sells everything at ' + rupees(CONFIG.brake * Math.max(book.capital, 0)) + ' or 20% below the peak of ' + rupees(book.peak)],
    ['Holding BTC instead', book.btcStart && run.ticker && run.ticker['I-BTC_INR'] ? rupees(benchmarkValue(book, run.ticker)) : 'n/a'],
    ['Trades', book.trades + ' sales, ' + book.wins + ' at a profit'],
    ['Last trade', book.lastTradeAt ? ist(book.lastTradeAt) : 'none yet'],
    ['Next rule check', 'daily at 05:30 IST; relative momentum on Mondays'],
    ['Last problem', state.errors.lastMessage ? ist(state.errors.lastAt) + ': ' + state.errors.lastMessage : 'none']
  ];
  if (run.waiting) rows.splice(1, 0, ['Waiting', run.waiting]);
  if (run.keyProblem) rows.splice(1, 0, ['API key problem', run.keyProblem]);
  if (state.paperArchive) rows.push(['Paper run before going live', rupees(state.paperArchive.value) + ' from ' + rupees(state.paperArchive.capital)]);
  return rows;
}

function benchmarkValue(book, ticker) {
  var fee = feeRate();
  return book.capital * (1 - fee) * (ticker['I-BTC_INR'].bid / book.btcStart) * (1 - fee);
}

function holdingText(positions, prices) {
  return Object.keys(positions).map(function (pair) {
    var pos = positions[pair], coin = CONFIG.markets[pair].coin;
    return prices && prices[pair] ? coin + ' ' + rupees(pos.qty * prices[pair]) : coin;
  }).join(', ') || 'cash';
}

// ---------------------------------------------------------------- email

function sendMail(run) {
  var state = run.state, mail = state.mail, now = run.now;
  var urgent = run.events.filter(function (e) {
    if (e.level === 'notice') return true;
    if (e.level !== 'alert') return false;
    var key = e.message.slice(0, 60);
    if (mail.sent[key] && now - mail.sent[key] < CONFIG.alertEveryMs) return false;
    mail.sent[key] = now;
    return true;
  });
  Object.keys(mail.sent).forEach(function (key) { if (now - mail.sent[key] > DAY_MS) delete mail.sent[key]; });
  var liveTrades = run.trades.filter(function (tr) { return tr.kind === 'live'; });
  if (urgent.length || liveTrades.length) {
    var lines = urgent.map(function (e) { return e.message; });
    liveTrades.forEach(function (tr) { lines.push(tradeText(tr)); });
    lines.push('', 'Value if sold now: ' + rupees(state.book.lastValue), sheetUrl());
    mailOwner('CoinDCX trader: ' + (urgent.length ? urgent[0].message.slice(0, 70) : liveTrades.length + ' trade(s)'), lines.join('\n'));
  }
  var local = new Date(now + IST_MS), date = local.toISOString().slice(0, 10);
  if (local.getUTCHours() >= CONFIG.reportHourIst && mail.dailyDate !== date) {
    mail.dailyDate = date;
    mailOwner('CoinDCX trader daily report, ' + date, reportText(state, run.ticker || {}, now));
  }
}

function tradeText(tr) {
  return (tr.side === 'BUY' ? 'Bought ' : 'Sold ') + tr.qty + ' ' + CONFIG.markets[tr.pair].coin + ' at ' + rupees(tr.price) +
         ' (' + rupees(tr.value) + ', fee ' + rupees(tr.fee) + (tr.tds ? ', TDS ' + rupees(tr.tds) : '') +
         (tr.pnl !== null ? ', result ' + signedRupees(tr.pnl) : '') + '): ' + tr.why;
}

function reportText(state, ticker, now) {
  var book = state.book, prices = currentPrices(state, ticker), live = book.kind === 'live';
  var lines = ['CoinDCX trader, ' + ist(now), '',
               (live ? 'Real money' : 'Paper only (no API key yet, or waiting for INR)') + ': value if sold now ' + rupees(book.lastValue) +
               ', ' + signedPct(book.lastValue / book.capital - 1) + ' since ' + ist(book.startedAt).slice(0, 10) + ' (started with ' + rupees(book.capital) + ').',
               'Cash ' + rupees(book.cash) + '; coins: ' + (holdingText(book.positions, prices) || 'none') + '.',
               'Fees paid ' + rupees(book.fees) + ', TDS held ' + rupees(book.tdsCredit) + ', estimated tax set aside ' + rupees(book.taxDue) + '.',
               'Loss brake: sells everything at ' + rupees(CONFIG.brake * book.capital) + ' or 20% below the peak of ' + rupees(book.peak) + '.' +
               (book.halted ? ' STOPPED on ' + ist(book.halted.at) + ': set Mode to RESET to trade again.' : '')];
  if (book.btcStart && ticker['I-BTC_INR']) lines.push('Holding BTC instead would be worth ' + rupees(benchmarkValue(book, ticker)) + '.');
  lines.push('', 'The four rules, each with ₹5,000 of paper money (weight = its share of the real wallet):');
  CONFIG.rules.forEach(function (rule) {
    var sleeve = state.sleeves[rule], value = liquidationValue(sleeve.acct, prices);
    lines.push('- ' + CONFIG.ruleLabels[rule] + ': ' + rupees(value) + ' (' + signedPct(value / sleeve.acct.capital - 1) + '), weight ' +
               pct(state.weights[rule], 0) + ', ' + holdingText(sleeve.acct.positions) + (sleeve.halted ? ', stopped by its brake' : ''));
  });
  lines.push('', 'Problems: ' + (state.errors.lastMessage ? ist(state.errors.lastAt) + ' ' + state.errors.lastMessage : 'none') + '.',
             'Dashboard and controls: ' + sheetUrl(),
             '', 'These rules lost a little after costs in testing; a profit is not guaranteed.');
  return lines.join('\n');
}

function sheetUrl() {
  try {
    return SpreadsheetApp.getActiveSpreadsheet().getUrl();
  } catch (e) {
    return '';
  }
}

// ---------------------------------------------------------------- formatting

function ist(ms) { return new Date(ms + IST_MS).toISOString().slice(0, 16).replace('T', ' ') + ' IST'; }
function round2(x) { return Math.round(x * 100) / 100; }
function pct(x, digits) { return (x * 100).toFixed(digits === undefined ? 1 : digits) + '%'; }
function signedPct(x) { return (x >= 0 ? '+' : '-') + Math.abs(x * 100).toFixed(1) + '%'; }
function signedRupees(x) { return (x >= 0 ? '+' : '-') + rupees(Math.abs(x)); }

function rupees(x) {
  var negative = x < 0, digits = String(Math.round(Math.abs(x)));
  if (digits.length > 3) digits = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + digits.slice(-3);
  return (negative ? '-' : '') + '₹' + digits;
}
