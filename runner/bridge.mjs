// Runs one trader step from src/Code.gs on this machine. CoinDCX is called directly; the state, the API key,
// the Mode cell, the Sheet and the emails stay with the Apps Script web app, reached through signed requests.
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

export class BridgeError extends Error {
  constructor(message) { super(message); this.name = 'BridgeError'; }
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
export function sleepSync(ms) {
  if (ms > 0) Atomics.wait(sleepCell, 0, 0, ms);
}

/** A blocking HTTP call through curl, since Code.gs expects UrlFetchApp to block. Returns {code, body}. */
export function curlFetch(url, params = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-'));
  const bodyFile = path.join(dir, 'body'), headerFile = path.join(dir, 'headers'), payloadFile = path.join(dir, 'payload');
  const seconds = params.timeoutSec || 30;
  try {
    const headers = {'User-Agent': 'coindcx-live-trader', ...(params.headers || {})};
    if (params.contentType) headers['Content-Type'] = params.contentType;
    // Headers and payload go through files so the API key never appears in the process list.
    fs.writeFileSync(headerFile, Object.entries(headers).map(([k, v]) => k + ': ' + v).join('\n') + '\n', {mode: 0o600});
    const args = ['-sS', '--connect-timeout', '10', '--max-time', String(seconds), '-H', '@' + headerFile, '-o', bodyFile,
                  '-w', '%{http_code}'];
    const method = String(params.method || 'get').toUpperCase();
    if (params.payload !== undefined && params.payload !== null) {
      fs.writeFileSync(payloadFile, String(params.payload), {mode: 0o600});
      args.push('--data-binary', '@' + payloadFile);
      if (method !== 'POST') args.push('-X', method);
    } else if (method !== 'GET') {
      args.push('-X', method);
    }
    // Without -X, curl turns the POST into a GET on a 302, which is what an Apps Script web app reply needs.
    if (params.followRedirects) args.push('-L', '--max-redirs', '5');
    args.push(url);
    let out;
    try {
      out = execFileSync('curl', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: (seconds + 15) * 1000});
    } catch (e) {
      throw new Error('network error: ' + String(e.stderr || e.message).trim().split('\n').pop().slice(0, 200));
    }
    return {code: Number(out.trim()), body: fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, 'utf8') : ''};
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

const asciiJson = (value) => JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

/** Returns call(op, data): a signed request to the web app, retried only when it may not have arrived. */
export function webApp({url, secret, http, now = Date.now, sleep = sleepSync}) {
  return function call(op, data, retries = 2) {
    let last = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt) sleep(3000 * attempt);
      const ts = now(), nonce = crypto.randomBytes(16).toString('hex'), text = asciiJson(data);
      const sig = crypto.createHmac('sha256', secret).update(op + '\n' + ts + '\n' + nonce + '\n' + text).digest('hex');
      let reply;
      try {
        reply = http(url, {method: 'post', contentType: 'text/plain', payload: JSON.stringify({op, ts, nonce, data: text, sig}),
                           followRedirects: true, timeoutSec: 120});
      } catch (e) {
        last = new BridgeError(op + ': ' + e.message);
        continue;
      }
      let out = null;
      try {
        out = JSON.parse(reply.body);
      } catch (e) {
        last = new BridgeError(op + ': HTTP ' + reply.code + ', not JSON');
        continue;
      }
      if (out && out.ok) return out;
      last = new BridgeError(op + ': ' + (out && out.error || 'HTTP ' + reply.code));
      if (!out || out.error !== 'busy') throw last;
    }
    throw last;
  };
}

/** Script properties as the runner sees them: a copy from "begin", where every change is saved remotely first. */
class RemoteProps {
  constructor(values, keys, save) {
    this.map = new Map(Object.entries(values || {}));
    if (keys) {
      this.map.set('COINDCX_API_KEY', keys.key);
      this.map.set('COINDCX_API_SECRET', keys.secret);
    }
    this.save = save;
  }
  getProperty(key) { return this.map.has(key) ? this.map.get(key) : null; }
  getProperties() { return Object.fromEntries(this.map); }
  setProperty(key, value) { return this.setProperties({[key]: value}); }
  setProperties(values) {
    const changed = {};
    for (const [key, value] of Object.entries(values)) if (this.map.get(key) !== String(value)) changed[key] = String(value);
    if (Object.keys(changed).length) {
      this.save(changed);
      for (const [key, value] of Object.entries(changed)) this.map.set(key, value);
    }
    return this;
  }
  deleteProperty(key) { throw new Error('the runner cannot delete ' + key); }
}

const RUNNER_OVERRIDES = `
  nowMs = function () { return __now(); };
  sendMail = function () {};
  reportCrash = function () {};
  Dashboard.prototype.update = function () {};
  function __step() {
    var run = traderStep(nowMs());
    return JSON.stringify({now: run.now, mode: run.mode, newMode: run.newMode, events: run.events, trades: run.trades,
                           ticker: run.ticker, errorThisRun: run.errorThisRun, waiting: run.waiting || null,
                           keyProblem: run.keyProblem || null, hasKeys: !!run.keys});
  }`;

const scripts = new Map();
function compiled(source) {
  if (!scripts.has(source)) scripts.set(source, [new vm.Script(source, {filename: 'Code.gs'}), new vm.Script(RUNNER_OVERRIDES)]);
  return scripts.get(source);
}

function describe(e) {
  if (!e || !e.message) return String(e).slice(0, 2000);
  const frames = String(e.stack || '').split('\n').filter((line) => /^\s+at /.test(line)).slice(0, 8);
  return [(e.name || 'Error') + ': ' + e.message, ...frames].join('\n').slice(0, 2000);
}

export function codeVersion(source) {
  const m = source.match(/var CODE_VERSION = '([^']+)'/);
  if (!m) throw new Error('Code.gs has no CODE_VERSION');
  return m[1];
}

/**
 * One run: "begin" hands over the state, key and Mode; the step trades on CoinDCX and saves its state through
 * "save" before each order; "finish" lets Apps Script write the Sheet and send the emails.
 */
export function runOnce({source, call, http, runId, force = false, now = Date.now, sleep = sleepSync, log = () => {}, mask = () => {}}) {
  const begin = call('begin', {runId, force, version: codeVersion(source)});
  if (begin.skip) return {skipped: begin.skip};
  if (begin.keys) {
    mask(begin.keys.key);
    mask(begin.keys.secret);
  }
  const props = new RemoteProps(begin.props, begin.keys, (values) => call('save', {runId, values}));
  const control = {getRange: () => ({getValue: () => begin.modeCell})};
  const ctx = vm.createContext({
    console: {log: (message) => log(String(message))},
    UrlFetchApp: {
      fetch(url, params) {
        const reply = http(url, params || {});
        return {getResponseCode: () => reply.code, getContentText: () => reply.body, getAllHeaders: () => ({})};
      }
    },
    Utilities: {
      computeHmacSha256Signature(value, key) {
        return Array.from(crypto.createHmac('sha256', key).update(value, 'utf8').digest(), (b) => (b > 127 ? b - 256 : b));
      },
      sleep
    },
    PropertiesService: {getScriptProperties: () => props},
    LockService: {getScriptLock: () => ({tryLock: () => true, releaseLock() {}})},
    SpreadsheetApp: {getActiveSpreadsheet: () => ({getSheetByName: (name) => (name === 'Control' ? control : null), getUrl: () => ''})},
    MailApp: {sendEmail() { throw new Error('the runner does not send email'); }},
    __now: now
  });
  const [code, overrides] = compiled(source);
  code.runInContext(ctx);
  overrides.runInContext(ctx);
  let run;
  try {
    run = JSON.parse(vm.runInContext('__step()', ctx));
  } catch (e) {
    try {
      call('crash', {runId, message: describe(e)});
    } catch (ignored) {
      log('Could not report the failure: ' + ignored.message);
    }
    throw e;
  }
  call('finish', {runId, run}, 4);
  return {events: run.events.length, trades: run.trades.length};
}
