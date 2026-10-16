// A fake CoinDCX: public prices from recorded candles, and a strict private API that checks what the real one checks.
import crypto from 'node:crypto';

const HOUR = 3600000;
export const MARKETS = {
  BTCINR: {pair: 'I-BTC_INR', coin: 'BTC', step: 1e-5, minQty: 1e-5, qtyDecimals: 5, priceDecimals: 1},
  ETHINR: {pair: 'I-ETH_INR', coin: 'ETH', step: 1e-4, minQty: 1e-7, qtyDecimals: 4, priceDecimals: 1},
  SOLINR: {pair: 'I-SOL_INR', coin: 'SOL', step: 1e-3, minQty: 0.01, qtyDecimals: 3, priceDecimals: 1},
  XRPINR: {pair: 'I-XRP_INR', coin: 'XRP', step: 0.1, minQty: 1, qtyDecimals: 1, priceDecimals: 3}
};
const BY_PAIR = Object.fromEntries(Object.entries(MARKETS).map(([symbol, m]) => [m.pair, {symbol, ...m}]));

const json = (code, data) => ({code, body: JSON.stringify(data)});
const hasDecimals = (x, d) => Math.abs(x * 10 ** d - Math.round(x * 10 ** d)) < 1e-6;

export class FakeExchange {
  constructor({clock, candles, key = 'test-key', secret = 'test-secret', balances = {INR: 10000}, halfSpread = 0.002,
               feeRate = 0.0059, feeIn = 'inr'}) {
    Object.assign(this, {clock, candles, key, secret, halfSpread, feeRate, feeIn});
    this.balances = {};
    for (const c of ['INR', 'BTC', 'ETH', 'SOL', 'XRP']) this.balances[c] = {free: balances[c] || 0, locked: 0};
    this.orders = [];
    this.clientIds = new Set();
    this.fillFraction = 1;
    this.priceFactor = 1;
    this.failures = [];
    this.privateCalls = [];
    this.times = Object.fromEntries(Object.entries(candles).map(([pair, rows]) => [pair, rows.map((r) => r[0])]));
    this.cache = new Map();
  }

  /** The next `times` matching calls fail: 'http500' and 'network' do nothing, 'lostReply' acts and then loses the reply. */
  inject(path, kind, times = 1) { this.failures.push({path, kind, times}); }

  lastClosed(pair) {
    const times = this.times[pair], now = this.clock.now;
    let lo = 0, hi = times.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] + HOUR <= now) lo = mid + 1; else hi = mid; }
    return this.candles[pair][lo - 1];
  }

  quote(pair) {
    const mid = this.lastClosed(pair)[4] * this.priceFactor;
    const d = BY_PAIR[pair].priceDecimals;
    return {bid: Number((mid * (1 - this.halfSpread)).toFixed(d)), ask: Number((mid * (1 + this.halfSpread)).toFixed(d))};
  }

  handle(url, params) {
    const u = new URL(url);
    const failure = this.failures.find((f) => f.times > 0 && u.pathname.endsWith(f.path));
    if (failure) {
      failure.times--;
      if (failure.kind === 'http500') return {code: 500, body: '<html>Internal Server Error</html>'};
      if (failure.kind === 'network') throw new Error('Address unavailable: ' + url);
      if (failure.kind === 'http429') return json(429, {message: 'Too many requests'});
    }
    const reply = this.route(u, params);
    if (failure && failure.kind === 'lostReply') throw new Error('Timeout: ' + url);
    return reply;
  }

  route(u, params) {
    if (u.host === 'public.coindcx.com' && u.pathname === '/market_data/candles') return this.candleReply(u.searchParams.get('pair'));
    if (u.pathname === '/exchange/ticker') {
      return json(200, Object.entries(MARKETS).map(([symbol, m]) => {
        const q = this.quote(m.pair);
        return {market: symbol, bid: String(q.bid), ask: String(q.ask), last_price: String(q.bid), timestamp: Math.floor(this.clock.now / 1000)};
      }));
    }
    if (u.pathname === '/exchange/v1/markets_details') {
      return json(200, Object.entries(MARKETS).map(([symbol, m]) => ({
        symbol, pair: m.pair, status: 'active', order_types: ['limit_order', 'market_order'], step: m.step, min_quantity: m.minQty,
        max_quantity: 1e9, min_notional: 100, target_currency_precision: m.qtyDecimals, base_currency_precision: m.priceDecimals,
        min_price: 0.001, max_price: 1e12
      })));
    }
    return this.privateRoute(u, params);
  }

  candleReply(pair) {
    const hour = Math.floor(this.clock.now / HOUR) * HOUR, key = pair + hour;
    if (!this.cache.has(key)) {
      const rows = this.candles[pair].filter((r) => r[0] <= hour).slice(-1000).reverse()
        .map(([time, open, high, low, close, volume]) => ({open, high, low, close, volume, time}));
      this.cache.set(key, JSON.stringify(rows));
    }
    return {code: 200, body: this.cache.get(key)};
  }

  privateRoute(u, params) {
    if ((params.method || 'get').toLowerCase() !== 'post') return json(404, {message: 'Not found'});
    const headers = params.headers || {}, payload = params.payload;
    this.privateCalls.push({path: u.pathname, payload});
    if (headers['X-AUTH-APIKEY'] !== this.key) return json(401, {code: 401, message: 'Invalid API key'});
    const signature = crypto.createHmac('sha256', this.secret).update(payload).digest('hex');
    if (headers['X-AUTH-SIGNATURE'] !== signature) return json(401, {code: 401, message: 'Invalid signature'});
    const body = JSON.parse(payload);
    if (!(Math.abs(body.timestamp - this.clock.now) <= 10000)) return json(401, {code: 401, message: 'Timestamp outside the allowed window'});
    switch (u.pathname) {
      case '/exchange/v1/users/balances':
        return json(200, Object.entries(this.balances).map(([currency, b]) => ({currency, balance: String(b.free), locked_balance: String(b.locked)})));
      case '/exchange/v1/orders/create': return this.create(body);
      case '/exchange/v1/orders/status': {
        const order = this.find(body);
        return order ? json(200, this.view(order)) : json(400, {code: 400, message: 'Order not found', status: 'error'});
      }
      case '/exchange/v1/orders/cancel': {
        const order = this.find(body);
        if (!order) return json(400, {code: 400, message: 'Order not found', status: 'error'});
        if (!['open', 'partially_filled'].includes(order.status)) return json(422, {code: 422, message: 'Order is not open'});
        this.cancel(order);
        return json(200, {message: 'success', status: 200, code: 200});
      }
      default: return json(404, {message: 'Not found'});
    }
  }

  find(body) { return this.orders.find((o) => (body.id ? o.id === body.id : o.client_order_id === body.client_order_id)); }

  create(body) {
    const m = MARKETS[body.market];
    if (!m) return json(400, {code: 400, message: 'Invalid market'});
    if (body.order_type !== 'limit_order') return json(400, {code: 400, message: 'Only limit orders are expected from this bot'});
    if (!['buy', 'sell'].includes(body.side)) return json(400, {code: 400, message: 'Invalid side'});
    const qty = Number(body.total_quantity), price = Number(body.price_per_unit);
    if (!body.client_order_id) return json(400, {code: 400, message: 'client_order_id missing'});
    if (this.clientIds.has(body.client_order_id)) return json(400, {code: 400, message: 'Duplicate client_order_id'});
    if (!hasDecimals(qty, m.qtyDecimals) || !hasDecimals(qty / m.step, 0)) return json(400, {code: 400, message: 'Quantity precision is invalid'});
    if (!hasDecimals(price, m.priceDecimals)) return json(400, {code: 400, message: 'Price precision is invalid'});
    if (qty < m.minQty) return json(400, {code: 400, message: 'Quantity below minimum'});
    if (qty * price < 100) return json(400, {code: 400, message: 'Order value below the ₹100 minimum'});
    const reserve = body.side === 'buy' ? qty * price * (1 + (this.feeIn === 'inr' ? this.feeRate : 0)) : qty;
    const wallet = this.balances[body.side === 'buy' ? 'INR' : m.coin];
    if (wallet.free + 1e-9 < reserve) return json(422, {code: 422, message: 'Insufficient funds'});
    wallet.free -= reserve;
    wallet.locked += reserve;
    this.clientIds.add(body.client_order_id);
    const order = {id: crypto.randomUUID(), client_order_id: body.client_order_id, market: body.market, side: body.side, price, qty,
                   filled: 0, value: 0, fee: 0, status: 'open', reserve, created: this.clock.now};
    this.orders.push(order);
    this.fill(order);
    return json(200, {orders: [this.view(order)]});
  }

  fill(order) {
    const m = MARKETS[order.market], q = this.quote(m.pair);
    const touch = order.side === 'buy' ? q.ask : q.bid;
    if (order.side === 'buy' ? order.price < touch : order.price > touch) return;
    const qty = Number((Math.floor(order.qty * this.fillFraction / m.step + 1e-9) * m.step).toFixed(m.qtyDecimals));
    if (qty <= 0) return;
    const value = qty * touch, fee = value * this.feeRate;
    const inr = this.balances.INR, coin = this.balances[m.coin];
    if (order.side === 'buy') {
      const released = order.reserve * qty / order.qty;
      inr.locked -= released;
      inr.free += released - value - (this.feeIn === 'inr' ? fee : 0);
      coin.free += this.feeIn === 'inr' ? qty : qty * (1 - this.feeRate);
    } else {
      coin.locked -= qty;
      inr.free += value - fee;
    }
    order.reserve -= order.side === 'buy' ? order.reserve * qty / order.qty : qty;
    order.filled = qty;
    order.value = value;
    order.fee = this.feeIn === 'inr' || order.side === 'sell' ? fee : qty * this.feeRate;
    order.status = qty >= order.qty - 1e-12 ? 'filled' : 'partially_filled';
  }

  cancel(order) {
    const m = MARKETS[order.market], wallet = this.balances[order.side === 'buy' ? 'INR' : m.coin];
    wallet.locked -= order.reserve;
    wallet.free += order.reserve;
    order.reserve = 0;
    order.status = order.filled > 0 ? 'partially_cancelled' : 'cancelled';
  }

  view(o) {
    return {id: o.id, client_order_id: o.client_order_id, market: o.market, order_type: 'limit_order', side: o.side, status: o.status,
            fee_amount: o.fee, fee: this.feeRate * 100, total_quantity: o.qty, remaining_quantity: Number((o.qty - o.filled).toFixed(10)),
            avg_price: o.filled ? o.value / o.filled : 0, price_per_unit: o.price, created_at: new Date(o.created).toISOString()};
  }

  openOrders() { return this.orders.filter((o) => ['open', 'partially_filled', 'init'].includes(o.status)); }
  total(currency) { return this.balances[currency].free + this.balances[currency].locked; }
}
