// The link between the GitHub runner and Apps Script: same results, signed requests, the lease, the schedule.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import test from 'node:test';
import {curlFetch} from '../runner/bridge.mjs';
import {OWNER, RUN, SECRET, SOURCE, VERSION, agrees, world} from './world.mjs';

function envelope(op, data, {clock, ts = clock.now, nonce = crypto.randomBytes(16).toString('hex'), secret = SECRET}) {
  const text = JSON.stringify(data);
  const sig = crypto.createHmac('sha256', secret).update(op + '\n' + ts + '\n' + nonce + '\n' + text).digest('hex');
  return JSON.stringify({op, ts, nonce, data: text, sig});
}

test('a run on GitHub leaves the same state, Sheet and emails as the same run inside Apps Script', () => {
  const [github, appsScript] = ['github', 'appsScript'].map((via) => {
    const w = world({via, balances: {INR: 5000}});
    w.setup();
    w.run(3 * 96);
    return w;
  });
  assert.ok(github.ex.orders.length >= 4, 'it traded');
  assert.deepEqual(github.state(), appsScript.state());
  const withoutOrderIds = (rows) => rows.map((r) => r.slice(0, 12));
  assert.deepEqual(withoutOrderIds(github.rows('Trades', 13)), withoutOrderIds(appsScript.rows('Trades', 13)));
  assert.deepEqual(github.rows('Value', 9), appsScript.rows('Value', 9));
  assert.deepEqual(github.rows('Log', 3), appsScript.rows('Log', 3));
  assert.deepEqual(github.control(), appsScript.control());
  assert.deepEqual(github.mails, appsScript.mails);
});

test('the web app turns away unsigned, tampered, replayed and stale requests', () => {
  const w = world();
  const post = (text) => JSON.parse(w.t.post(text));
  const signed = (op, data, options = {}) => envelope(op, data, {clock: w.clock, ...options});
  assert.equal(post(signed('status', {})).ok, true);
  assert.equal(post(signed('status', {}, {secret: 'f'.repeat(64)})).error, 'bad signature');
  const tampered = JSON.parse(signed('config', {OWNER_EMAIL: 'me@example.com'}));
  tampered.data = JSON.stringify({OWNER_EMAIL: 'thief@example.com'});
  assert.equal(post(JSON.stringify(tampered)).error, 'bad signature');
  assert.equal(w.props.getProperty('OWNER_EMAIL'), OWNER);
  const once = signed('status', {});
  assert.equal(post(once).ok, true);
  assert.equal(post(once).error, 'replayed request');
  assert.match(post(signed('status', {}, {ts: w.clock.now - 6 * 60000})).error, /too old/);
  assert.equal(post(signed('status', {}, {nonce: 'short'})).error, 'bad nonce');
  assert.equal(post(signed('launch', {})).error, 'unknown op');
  assert.equal(post('not json').ok, false);
  assert.equal(post(JSON.stringify({op: 'pair', secret: 'a'.repeat(64)})).error, 'already paired');
  assert.equal(w.props.getProperty('WEBAPP_SECRET'), SECRET);
});

test('pairing sets the shared secret once, and config changes only the GitHub token and the email address', () => {
  const w = world();
  w.props.deleteProperty('WEBAPP_SECRET');
  const post = (text) => JSON.parse(w.t.post(text));
  assert.equal(post(envelope('status', {}, {clock: w.clock})).error, 'not paired yet');
  assert.match(post(JSON.stringify({op: 'pair', secret: 'xyz'})).error, /64 hex/);
  assert.equal(post(JSON.stringify({op: 'pair', secret: SECRET})).ok, true);
  assert.equal(post(JSON.stringify({op: 'pair', secret: 'a'.repeat(64)})).error, 'already paired');
  const reply = w.call('config', {GITHUB_TOKEN: 'new-token', OWNER_EMAIL: 'new@example.com', COINDCX_API_KEY: 'x', WEBAPP_SECRET: 'y'});
  assert.deepEqual(reply.set, ['GITHUB_TOKEN', 'OWNER_EMAIL']);
  assert.equal(w.props.getProperty('GITHUB_TOKEN'), 'new-token');
  assert.equal(w.props.getProperty('COINDCX_API_KEY'), w.ex.key);
  assert.equal(w.props.getProperty('WEBAPP_SECRET'), SECRET);
  const status = JSON.stringify(w.call('status', {}));
  assert.match(status, new RegExp('"version":"' + VERSION + '"'));
  assert.ok(!status.includes(w.ex.secret) && !status.includes('new-token'), 'status shows no secrets');
});

test('only the runner holding the lease can save or finish, and the lease of a runner that died expires', () => {
  const w = world();
  const begin = (runId) => w.call('begin', {runId, force: true, version: VERSION});
  assert.ok(!begin('A').skip);
  assert.match(begin('B').skip, /run A is still going/);
  assert.throws(() => w.call('save', {runId: 'B', values: {STATE_PARTS: '0'}}), /no longer holds the lease/);
  assert.throws(() => w.call('save', {runId: 'A', values: {OWNER_EMAIL: 'x'}}), /only STATE_/);
  assert.throws(() => w.call('finish', {runId: 'B', run: {}}), /no longer holds the lease/);
  w.clock.advance(10 * 60000);
  assert.ok(!begin('B').skip);
  assert.throws(() => w.call('save', {runId: 'A', values: {STATE_PARTS: '0'}}), /no longer holds the lease/);
});

test('a runner that loses its lease before its first order places nothing', () => {
  const w = world({balances: {INR: 5000}});
  w.t.evaluate('setup()');
  const callWith = (op, data, retries) => {
    if (op === 'save' && data.runId === 'slow') {
      w.clock.advance(10 * 60000);
      w.call('begin', {runId: 'other', force: true, version: VERSION});
    }
    return w.call(op, data, retries);
  };
  assert.throws(() => w.runner({runId: 'slow', callWith}), /no longer holds the lease/);
  assert.equal(w.ex.orders.length, 0);
  assert.equal(w.state(), null);
  assert.ok(w.mails.some((m) => /a run failed/.test(m.subject)));
});

test('a run that finished under ten minutes ago makes the next one skip, unless it was started by hand', () => {
  const w = world({keys: false});
  w.setup();
  w.clock.advance(5 * 60000);
  assert.match(w.step().skipped, /a run finished at/);
  assert.equal(w.step(true).skipped, undefined);
});

test('a finish repeated after a lost reply does not write the Sheet or email twice', () => {
  const w = world({balances: {INR: 5000}});
  w.t.evaluate('setup()');
  const callWith = (op, data, retries) => {
    const reply = w.call(op, data, retries);
    if (op === 'finish') assert.equal(w.call(op, data, retries).repeated, true);
    return reply;
  };
  const result = w.runner({callWith});
  assert.ok(result.trades >= 2);
  assert.equal(w.rows('Trades', 13).length, result.trades);
  assert.equal(w.mails.filter((m) => /Live trading started/.test(m.body)).length, 1);
});

test('the runner never sends the CoinDCX key back to Apps Script', () => {
  const w = world({balances: {INR: 5000}, key: 'key-' + 'k'.repeat(28), secret: 'secret-' + 's'.repeat(30)});
  w.t.evaluate('setup()');
  const sent = [];
  const callWith = (op, data, retries) => {
    sent.push(JSON.stringify(data));
    return w.call(op, data, retries);
  };
  w.runner({callWith});
  assert.ok(sent.length >= 3 && w.ex.orders.length >= 2);
  assert.ok(!sent.some((text) => text.includes(w.ex.key) || text.includes(w.ex.secret)));
});

test('a runner with different code stops before it calls CoinDCX', () => {
  const w = world({balances: {INR: 5000}});
  const older = SOURCE.replace(/var CODE_VERSION = '[^']+'/, "var CODE_VERSION = 'older'");
  assert.throws(() => w.runner({source: older}), /version/);
  assert.deepEqual(w.outside, []);
});

test('tick starts a GitHub run unless one is going, and the watchdog emails once when runs stop', () => {
  const w = world({keys: false});
  w.t.triggers.push({fn: 'runTrader', m: 15});
  w.t.evaluate('setup()');
  assert.deepEqual(w.t.triggers, [{fn: 'tick', m: 15}]);
  assert.equal(w.dispatches.length, 1);
  const {params} = w.dispatches[0];
  assert.equal(params.method, 'post');
  assert.equal(params.headers.Authorization, 'Bearer github-test-token');
  assert.deepEqual(JSON.parse(params.payload), {ref: 'main', inputs: {force: 'false'}});
  assert.match(w.health(), /^OK, no run has finished yet/);
  w.step();
  assert.match(w.health(), /^OK, last run finished/);
  w.call('begin', {runId: 'stuck', force: true, version: VERSION});
  w.t.evaluate('tick()');
  assert.equal(w.dispatches.length, 1, 'no new run while one holds the lease');
  w.githubCode = 401;
  for (let i = 0; i < 12; i++) {
    w.clock.advance(RUN);
    w.t.evaluate('tick()');
  }
  const alerts = w.mails.filter((m) => /no run has finished for/.test(m.subject));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].body, /GitHub answered HTTP 401/);
  assert.match(w.health(), /^PROBLEM: last run finished .*HTTP 401/);
  assert.match(w.props.getProperty('DISPATCH_ERROR'), /HTTP 401 .*; enabling the workflow answered HTTP 401 /);
  w.githubCode = 204;
  w.t.evaluate('tick()');
  assert.equal(w.props.getProperty('DISPATCH_ERROR'), null);
  w.step();
  assert.match(w.health(), /^OK, last run finished/);
});

test('the workflow is enabled again daily, and at once when GitHub refuses to start it because it is disabled', () => {
  const w = world({keys: false});
  w.t.evaluate('setup()');
  assert.deepEqual(w.enables, [{method: 'put', payload: undefined}]);
  for (let i = 1; i < 96; i++) {
    w.clock.advance(RUN);
    w.t.evaluate('tick()');
  }
  assert.equal(w.enables.length, 1, 'at most once a day');
  w.clock.advance(RUN);
  w.t.evaluate('tick()');
  assert.equal(w.enables.length, 2);
  w.workflowDisabled = true;
  const tried = w.dispatches.length;
  w.clock.advance(RUN);
  w.t.evaluate('tick()');
  assert.equal(w.dispatches.length, tried + 2, 'refused once, then started');
  assert.equal(w.workflowDisabled, false);
  assert.equal(w.props.getProperty('DISPATCH_ERROR'), null);
  w.step();
  assert.match(w.health(), /^OK, last run finished/);
});

test('an HTML page from CoinDCX, such as a firewall block, is reported by its title', () => {
  const w = world({keys: false});
  w.setup();
  w.ex.inject('/exchange/ticker', 'blocked');
  w.run();
  assert.match(w.control()['Last problem'], /IST: prices: ticker: HTTP 403 and not JSON: HTML page "Attention Required! \| Cloudflare"$/);
  assert.equal(w.t.evaluate('briefBody("<html>Internal Server Error</html>")'), 'HTML page "Internal Server Error"');
  assert.equal(w.t.evaluate('briefBody(\'{"message":"Bad credentials"}\')'), '{"message":"Bad credentials"}');
  const saved = 'prices: ticker: HTTP 403 and not JSON: <!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->\n' +
                '<!--[if IE 7]>    <html class="no-js ie7 oldie" lang="en-US"> <![endif]-->\n<!--[if IE 8]>    <html class="no-';
  assert.equal(w.t.evaluate('readableProblem(' + JSON.stringify(saved) + ')'), 'prices: ticker: HTTP 403 and not JSON: an HTML page');
});

test('saving a CoinDCX key from the menu starts a run, which starts live trading', () => {
  const key = 'k'.repeat(32), secret = 's'.repeat(40);
  const w = world({keys: false, balances: {INR: 5000}, key, secret});
  w.t.evaluate('prepareSheets()');
  w.t.ui.answers.push('short', 'also short');
  w.t.evaluate('menuSetKey()');
  assert.match(w.t.ui.alerts.pop(), /does not look like/);
  assert.equal(w.props.getProperty('COINDCX_API_KEY'), null);
  w.t.ui.answers.push(' ' + key + ' ', secret);
  w.t.evaluate('menuSetKey()');
  assert.match(w.t.ui.alerts.pop(), /Key saved\. A run has started/);
  assert.equal(w.props.getProperty('COINDCX_API_KEY'), key);
  assert.deepEqual(JSON.parse(w.dispatches.pop().params.payload).inputs, {force: 'true'});
  w.step(true);
  assert.equal(w.state().book.kind, 'live');
  agrees(0)(w);
});

test('curl calls: headers and payload arrive intact, a POST follows a 302 as a GET, and failures are reported', async (t) => {
  const server = spawn(process.execPath, [new URL('./http_server.mjs', import.meta.url).pathname], {stdio: ['ignore', 'pipe', 'inherit']});
  t.after(() => server.kill());
  const port = await new Promise((resolve) => server.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
  const base = 'http://127.0.0.1:' + port;
  const echo = curlFetch(base + '/echo', {method: 'post', contentType: 'application/json', payload: '{"price":"₹1"}',
                                          headers: {'X-AUTH-APIKEY': 'key-123'}});
  assert.equal(echo.code, 200);
  const seen = JSON.parse(echo.body);
  assert.equal(seen.method, 'POST');
  assert.equal(seen.headers['x-auth-apikey'], 'key-123');
  assert.equal(seen.headers['content-type'], 'application/json');
  assert.equal(seen.body, '{"price":"₹1"}');
  assert.equal(JSON.parse(curlFetch(base + '/echo', {method: 'get'}).body).method, 'GET');
  const followed = curlFetch(base + '/redirect', {method: 'post', payload: 'x', followRedirects: true});
  assert.deepEqual([followed.code, JSON.parse(followed.body).method], [200, 'GET']);
  assert.deepEqual(curlFetch(base + '/fail'), {code: 500, body: 'oops'});
  server.kill();
  await new Promise((resolve) => server.once('exit', resolve));
  assert.throws(() => curlFetch(base + '/echo', {timeoutSec: 5}), /network error/);
});
