// The trading scenarios. Each runs the production way: a GitHub runner between the fake CoinDCX and Apps Script.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {Clock, HOUR, OWNER, RUN, START, agrees, candles, loadTrader, world} from './world.mjs';

const read = (name) => JSON.parse(fs.readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8'));
const signals = read('signals.json');
const windows = read('windows.json');

function withHistories(t) {
  t.ctx.__candles = candles;
  t.evaluate(`var __h = {};
    CONFIG.pairs.forEach(function (p) {
      __h[p] = new History(p, __candles[p].map(function (r) { return {t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5]}; }));
    });`);
  return t;
}

function offline() {
  return loadTrader({handler: () => { throw new Error('offline'); }, clock: new Clock(START)});
}

const buys = (ex) => ex.orders.filter((o) => o.side === 'buy');
const sells = (ex) => ex.orders.filter((o) => o.side === 'sell');

test('the four rules give the same targets as the tested Python rules', () => {
  const t = withHistories(offline());
  assert.ok(signals.length > 2000);
  for (const s of signals) {
    t.ctx.__s = s;
    const got = JSON.parse(t.evaluate('JSON.stringify(targets(__s.policy, __h, __s.t, __s.held))'));
    assert.deepEqual(got, s.targets, s.policy + ' at ' + new Date(s.t).toISOString());
  }
});

test('paper fills, fees and tax match the Python backtest in all 17 windows', () => {
  const t = withHistories(offline());
  t.evaluate(`function __replay(rule, start, days) {
    var hours = {btc_sma30: 24, tsmom30: 24, crossmom7: 168, donchian20_10: 24}[rule];
    var acct = freshAccount(5000, start), orders = 0, price = {};
    CONFIG.pairs.forEach(function (p) { price[p] = __h[p].closed(start, 1)[0].c; });
    for (var t = start; t < start + days * DAY_MS; t += HOUR_MS) {
      var bars = {};
      CONFIG.pairs.forEach(function (p) {
        var row = __h[p].rows[__h[p].index(t)];
        if (!row || row.t !== t) throw new Error('no bar at ' + t);
        bars[p] = row;
      });
      if (t === start || (t - start) % (hours * HOUR_MS) === 0) {
        var desired = targets(rule, __h, t, Object.keys(acct.positions));
        Object.keys(acct.positions).filter(function (p) { return !(p in desired); }).sort().forEach(function (p) {
          if (paperSell(acct, p, bars[p].o, t, '')) orders++;
        });
        Object.keys(desired).filter(function (p) { return !(p in acct.positions); }).sort().forEach(function (p) {
          var equity = liquidationValue(acct, price);
          var budget = Math.min(desired[p] * Math.max(0, equity), Math.max(0, acct.cash - acct.taxDue));
          if (paperBuy(acct, p, budget, bars[p].o, t, '')) orders++;
        });
      }
      CONFIG.pairs.forEach(function (p) { price[p] = bars[p].c; });
      markAccount(acct, liquidationValue(acct, price));
    }
    return JSON.stringify({value: acct.lastValue, orders: orders, fees: acct.fees, tax: acct.taxDue});
  }`);
  assert.equal(windows.results.length, 68);
  for (const r of windows.results) {
    const got = JSON.parse(t.evaluate(`__replay(${JSON.stringify(r.rule)}, ${r.start}, ${windows.window_days})`));
    const where = r.rule + ' from ' + new Date(r.start).toISOString().slice(0, 10);
    assert.ok(Math.abs(got.value - r.value) <= 0.006, where + ': value ' + got.value + ' vs ' + r.value);
    assert.ok(Math.abs(got.fees - r.fees) <= 0.006, where + ': fees ' + got.fees + ' vs ' + r.fees);
    assert.ok(Math.abs(got.tax - r.tax) <= 0.006, where + ': tax ' + got.tax + ' vs ' + r.tax);
    assert.equal(got.orders, r.orders, where + ': orders');
  }
});

test('without a key it paper trades for two weeks and never calls the private API', () => {
  const w = world({keys: false});
  w.setup();
  w.run(14 * 96);
  const s = w.state();
  assert.equal(w.ex.privateCalls.length, 0);
  assert.equal(s.book.kind, 'paper');
  assert.equal(s.errors.total, 0, w.logText());
  assert.ok(s.book.trades + Object.keys(s.book.positions).length > 0, 'the paper book followed the rules');
  const reports = w.mails.filter((m) => m.subject.startsWith('CoinDCX trader daily report'));
  assert.ok(reports.length >= 14 && reports.length <= 15, 'one report a day, got ' + reports.length);
  assert.ok(w.mails.every((m) => m.to === OWNER));
  assert.ok(!w.mails.some((m) => /error|failed|Unexpected/i.test(m.subject + m.body)), w.mails.map((m) => m.subject).join('\n'));
  assert.ok(w.rows('Trades', 13).every((r) => r[1] === 'Paper'));
  const valueRows = w.rows('Value', 9).length;
  assert.ok(valueRows >= 14 * 24 && valueRows <= 14 * 24 + 2, 'hourly value rows, got ' + valueRows);
  const weights = Object.values(s.weights);
  assert.ok(s.weightsAt !== null, 'the weights were reviewed on a Monday');
  assert.ok(Math.abs(weights.reduce((a, b) => a + b, 0) - 1) < 1e-9 && weights.every((x) => x >= 0.1 - 1e-12 && x <= 0.4 + 1e-12));
  assert.ok(Object.keys(w.props.getProperties()).filter((k) => k.startsWith('STATE_')).length >= 2);
  assert.match(w.control()['Running as'], /^Paper/);
});

test('with a key and INR it trades real money, capped at ₹5,000, and its books match CoinDCX', () => {
  const w = world({balances: {INR: 12000}});
  w.setup();
  const check = agrees(7000);
  check(w);
  const s0 = w.state();
  assert.equal(s0.book.kind, 'live');
  assert.equal(s0.book.capital, 5000);
  assert.ok(buys(w.ex).length >= 2, 'it bought on the first run\n' + w.logText());
  w.run(6 * 96, check);
  const s = w.state();
  assert.ok(w.ex.orders.every((o) => ['filled', 'partially_cancelled', 'cancelled'].includes(o.status)));
  assert.ok(w.ex.orders.every((o) => o.qty * o.price <= 1.05 * 5000));
  assert.ok(w.ex.total('INR') >= 7000 - 0.5, 'never touched the INR above ₹5,000');
  assert.equal(s.errors.total, 0, w.logText());
  assert.ok(!/refused|Unexpected/.test(w.logText()), w.logText());
  assert.ok(w.mails.some((m) => /Live trading started with ₹5,000/.test(m.body)));
  const tradeMails = w.mails.filter((m) => /Bought|Sold/.test(m.body)).length;
  assert.ok(tradeMails >= 1);
  assert.ok(w.rows('Trades', 13).some((r) => r[1] === 'Real'));
  assert.equal(w.control()['Running as'], 'REAL MONEY on CoinDCX');
  assert.equal(s.paperArchive.capital, 5000);
});

test('fees taken in coin instead of INR are booked from the balances', () => {
  const w = world({balances: {INR: 5000}, feeIn: 'coin'});
  w.setup();
  w.run(3 * 96, agrees(0));
  assert.ok(buys(w.ex).length >= 2);
  assert.ok(!/unexpectedly/.test(w.logText()), w.logText());
});

test('a partly filled order has the rest cancelled and bought on the next run', () => {
  const w = world({balances: {INR: 5000}});
  w.ex.fillFraction = 0.5;
  w.setup();
  agrees(0)(w);
  assert.ok(w.ex.orders.length >= 2 && w.ex.orders.every((o) => o.status === 'partially_cancelled'));
  const first = w.state();
  assert.ok(Object.keys(first.book.positions).every((pair) => first.book.flags[pair]), 'still flagged for more');
  w.ex.fillFraction = 1;
  const before = w.ex.orders.length;
  w.run(1, agrees(0));
  assert.ok(w.ex.orders.length > before, 'bought the rest');
  const s = w.state();
  assert.ok(Object.keys(s.book.flags).length === 0 || Object.keys(s.book.flags).every((p) => !s.book.positions[p]), JSON.stringify(s.book.flags));
});

test('a lost reply to a placed order is found by its id, so nothing is bought twice', () => {
  const w = world({balances: {INR: 5000}});
  w.ex.inject('/orders/create', 'lostReply');
  w.setup();
  agrees(0)(w);
  const markets = buys(w.ex).map((o) => o.market);
  assert.equal(new Set(markets).size, markets.length, 'one buy per coin: ' + markets);
  assert.match(w.logText(), /No clear reply/);
  w.run(4, agrees(0));
  assert.equal(new Set(buys(w.ex).map((o) => o.market)).size, buys(w.ex).length);
});

test('an order that never reached CoinDCX blocks trading for a run, then is dropped and placed again', () => {
  const w = world({balances: {INR: 5000}});
  w.ex.inject('/orders/create', 'network');
  w.setup();
  assert.equal(w.ex.orders.length, 0);
  assert.equal(w.state().book.pending.length, 1);
  w.run(1);
  const s = w.state();
  assert.equal(s.book.pending.length, 0);
  assert.ok(w.ex.orders.length >= 2, w.logText());
  agrees(0)(w);
  assert.match(w.logText(), /no record of order/);
});

test('a CoinDCX outage stops new orders, emails an alert after three runs, and recovers', () => {
  const w = world({balances: {INR: 5000}});
  w.setup();
  const placed = w.ex.orders.length;
  w.ex.inject('/users/balances', 'http500', 1000);
  w.run(4);
  assert.equal(w.ex.orders.length, placed);
  let s = w.state();
  assert.ok(s.errors.consecutive >= 3);
  const alerts = w.mails.filter((m) => /balances/.test(m.subject));
  assert.equal(alerts.length, 1, w.mails.map((m) => m.subject).join('\n'));
  w.ex.failures = [];
  w.run(1, agrees(0));
  s = w.state();
  assert.equal(s.errors.consecutive, 0);
});

test('the loss brake sells everything and stops until Mode is set to RESET', () => {
  const w = world({balances: {INR: 5000}});
  w.setup();
  w.run(2);
  assert.ok(Object.keys(w.state().book.positions).length > 0);
  w.ex.priceFactor = 0.5;
  w.run(1, agrees(0));
  let s = w.state();
  assert.ok(s.book.halted, w.logText());
  assert.equal(Object.keys(s.book.positions).length, 0);
  assert.ok(w.mails.some((m) => /Loss brake/.test(m.subject)));
  const ordersAfterBrake = w.ex.orders.length;
  w.run(8);
  assert.equal(w.ex.orders.length, ordersAfterBrake, 'no orders while stopped');
  w.mode('RESET');
  w.run(1, agrees(0));
  s = w.state();
  assert.equal(s.book.halted, null);
  assert.equal(w.mode(), 'LIVE');
  assert.ok(w.ex.orders.length > ordersAfterBrake, 'trading again after RESET');
  assert.ok(s.book.capital < 4000 && s.book.capital > 3000, 'the brake resets from the current value: ' + s.book.capital);
});

test('SELL ALL sells what the bot bought, then PAUSE places no orders for a day', () => {
  const w = world({balances: {INR: 5000, BTC: 0.01}});
  w.setup();
  w.mode('SELL ALL');
  w.run(1);
  const s = w.state();
  assert.equal(Object.keys(s.book.positions).length, 0);
  assert.equal(w.mode(), 'PAUSE');
  assert.ok(w.ex.total('BTC') >= 0.01 - 1e-12, 'your own BTC was not sold');
  const count = w.ex.orders.length;
  w.run(96);
  assert.equal(w.ex.orders.length, count);
});

test('coins moved out of the wallet: it believes CoinDCX and emails an alert', () => {
  const w = world({balances: {INR: 5000}});
  w.setup();
  const pair = Object.keys(w.state().book.positions)[0], coin = pair.slice(2, 5);
  w.ex.balances[coin].free /= 2;
  w.run(1);
  const pos = w.state().book.positions[pair];
  assert.ok(Math.abs(pos.qty - w.ex.total(coin)) < 1e-9 || pos.qty < w.ex.total(coin) + 1e-9);
  assert.ok(w.mails.some((m) => /Was some sold or moved outside the bot/.test(m.body)));
});

test('a rejected key keeps it on paper and emails why', () => {
  const w = world({keys: 'wrong'});
  w.setup();
  assert.equal(w.state().book.kind, 'paper');
  assert.ok(w.mails.some((m) => /rejected the saved API key/.test(m.body)));
  assert.match(w.control()['API key problem'], /Invalid signature/);
  assert.equal(w.ex.orders.length, 0);
});

test('with under ₹500 of INR it waits on paper', () => {
  const w = world({balances: {INR: 300}});
  w.setup();
  assert.equal(w.state().book.kind, 'paper');
  assert.match(w.control().Waiting, /Deposit at least ₹500/);
  assert.equal(w.ex.orders.length, 0);
});

test('an unknown Mode is treated as PAUSE', () => {
  const w = world({balances: {INR: 5000}});
  w.t.evaluate('prepareSheets()');
  w.mode('GO');
  w.setup();
  assert.equal(w.ex.orders.length, 0);
  assert.match(w.logText(), /treating it as PAUSE/);
});

test('short candle gaps are filled and long ones cut the history', () => {
  const t = offline();
  const base = Date.UTC(2026, 0, 1);
  const rows = [0, 1, 4, 5, 15, 16].map((h) => ({time: base + h * HOUR, open: 10, high: 100, low: 1, close: 10 + h, volume: 1}));
  t.ctx.__rows = rows;
  const filled = JSON.parse(t.evaluate(`JSON.stringify(parseCandles(__rows, ${base + 17 * HOUR}))`));
  assert.deepEqual(filled.map((r) => (r.t - base) / HOUR), [0, 1, 2, 3, 4, 5, 15, 16]);
  assert.deepEqual(filled.slice(2, 4).map((r) => [r.c, r.v]), [[11, 0], [11, 0]]);
  const tail = JSON.parse(t.evaluate(`JSON.stringify(contiguousTail(parseCandles(__rows, ${base + 17 * HOUR}), ${base + 17 * HOUR}, 'X'))`));
  assert.deepEqual(tail.map((r) => (r.t - base) / HOUR), [15, 16]);
  assert.throws(() => t.evaluate(`contiguousTail(parseCandles(__rows, ${base + 17 * HOUR}), ${base + 21 * HOUR}, 'X')`), /last 3 hours/);
});

test('bounded weights stay between 10% and 40% and add up to 100%', () => {
  const t = offline();
  for (let i = 0; i < 500; i++) {
    const raw = Array.from({length: 4}, () => Math.random() ** 4 * 10);
    t.ctx.__raw = raw;
    const w = JSON.parse(t.evaluate('JSON.stringify(boundWeights(__raw, 0.1, 0.4))'));
    assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9, String(w));
    assert.ok(w.every((x) => x >= 0.1 - 1e-12 && x <= 0.4 + 1e-12), String(w));
  }
});

test('a crashed run emails once and then waits six hours before emailing again', () => {
  const w = world({balances: {INR: 5000}});
  w.t.evaluate('prepareSheets()');
  w.props.setProperty('STATE_PARTS', '1');
  w.props.setProperty('STATE_0', '{not json');
  assert.throws(() => w.step());
  w.clock.advance(RUN);
  assert.throws(() => w.step());
  assert.equal(w.mails.filter((m) => /a run failed/.test(m.subject)).length, 1);
  assert.match(w.logText(), /The run failed: SyntaxError/);
  assert.equal(w.props.getProperty('RUN_LEASE'), null, 'a failed run gives up its lease');
});
