// Runs one paper step of Code.gs against CoinDCX's real public API and prints what it would do. No key, no orders.
//   node tools/dry_run.mjs
import {Clock, loadTrader} from '../test/gas.mjs';

const PAIRS = ['I-BTC_INR', 'I-ETH_INR', 'I-SOL_INR', 'I-XRP_INR'];
const urls = ['https://api.coindcx.com/exchange/ticker', 'https://api.coindcx.com/exchange/v1/markets_details',
  ...PAIRS.map((p) => `https://public.coindcx.com/market_data/candles?pair=${p}&interval=1h&limit=1000`)];
const replies = new Map();
await Promise.all(urls.map(async (url) => {
  const res = await fetch(url, {headers: {'User-Agent': 'coindcx-live-trader dry run'}});
  replies.set(url, {code: res.status, body: await res.text()});
}));

const now = Date.now();
const H = 3600000;
for (const pair of PAIRS) {
  const rows = JSON.parse(replies.get(urls[2 + PAIRS.indexOf(pair)]).body);
  const times = rows.map((r) => r.time).sort((a, b) => a - b);
  let gaps = 0, misaligned = 0;
  for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] !== H) gaps++;
  for (const t of times) if (t % H) misaligned++;
  console.log(`${pair}: ${rows.length} candles, newest first: ${rows[0].time > rows.at(-1).time}, ` +
              `${new Date(times[0]).toISOString()} .. ${new Date(times.at(-1)).toISOString()}, gaps ${gaps}, off-hour ${misaligned}`);
}
const ticker = JSON.parse(replies.get(urls[0]).body).filter((r) => ['BTCINR', 'ETHINR', 'SOLINR', 'XRPINR'].includes(r.market));
for (const r of ticker) {
  const t = r.timestamp < 1e12 ? r.timestamp * 1000 : r.timestamp;
  console.log(`${r.market}: bid ${r.bid} ask ${r.ask} spread ${((r.ask - r.bid) / r.bid * 100).toFixed(3)}%, timestamp ${Math.round((now - t) / 1000)} s old`);
}
const details = JSON.parse(replies.get(urls[1]).body).filter((r) => ['BTCINR', 'ETHINR', 'SOLINR', 'XRPINR'].includes(r.symbol));
for (const r of details) {
  console.log(`${r.symbol}: ${r.status}, step ${r.step}, min qty ${r.min_quantity}, min notional ${r.min_notional}, ` +
              `qty decimals ${r.target_currency_precision}, price decimals ${r.base_currency_precision}, types ${r.order_types}`);
}

const t = loadTrader({
  clock: new Clock(now),
  handler: (url) => {
    if (!replies.has(url)) throw new Error('dry run has no reply for ' + url);
    return replies.get(url);
  }
});
t.evaluate('prepareSheets()');
const run = JSON.parse(t.evaluate(`JSON.stringify((function () {
  var run = traderStep(nowMs()), state = run.state;
  return {events: run.events, trades: run.trades, weights: state.weights, lastHour: state.lastHour,
          sleeves: CONFIG.rules.map(function (rule) {
            var s = state.sleeves[rule];
            return {rule: rule, holds: Object.keys(s.acct.positions), pending: s.pending, retryAt: s.retryAt, lastReview: s.lastReview};
          }),
          blend: blendedWeights(state, currentPrices(state, run.ticker)), book: state.book};
})())`));
console.log('\nRules processed up to', new Date(run.lastHour).toISOString());
for (const s of run.sleeves) console.log(`${s.rule}: holds ${s.holds.join(', ') || 'cash'}${s.retryAt ? ' (data problem, retrying)' : ''}`);
console.log('Wallet weights:', Object.fromEntries(Object.entries(run.blend).map(([p, w]) => [p.slice(2, 5), (w * 100).toFixed(1) + '%'])));
console.log('Paper orders this run:', run.trades.map((tr) => `${tr.side} ${tr.qty} ${tr.pair.slice(2, 5)} ≈ ₹${Math.round(tr.value)}`).join('; ') || 'none');
console.log('Events:', run.events.length ? run.events.map((e) => e.level + ': ' + e.message.split('\n')[0]).join('\n') : 'none');
