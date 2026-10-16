// Checks that this machine can reach every CoinDCX endpoint the trader uses.
// The private call is signed with a dummy key, so the expected answer is a JSON 401, not a Cloudflare page.
import crypto from 'node:crypto';

const checks = [
  ['ticker', 'https://api.coindcx.com/exchange/ticker'],
  ['markets_details', 'https://api.coindcx.com/exchange/v1/markets_details'],
  ['candles', 'https://public.coindcx.com/market_data/candles?pair=B-BTC_INR&interval=1h&limit=3'],
  ['balances (dummy key)', 'https://api.coindcx.com/exchange/v1/users/balances', true],
];

let blocked = 0;
for (const [name, url, signed] of checks) {
  const init = {headers: {'User-Agent': 'coindcx-live-trader'}};
  if (signed) {
    const body = JSON.stringify({timestamp: Date.now()});
    init.method = 'POST';
    init.body = body;
    init.headers['Content-Type'] = 'application/json';
    init.headers['X-AUTH-APIKEY'] = 'probe-dummy-key';
    init.headers['X-AUTH-SIGNATURE'] = crypto.createHmac('sha256', 'probe-dummy-secret').update(body).digest('hex');
  }
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    const cloudflare = /Attention Required|cf-error|Cloudflare Ray ID/i.test(text);
    const json = /^\s*[[{]/.test(text);
    if (cloudflare) blocked++;
    console.log(`${name}: HTTP ${res.status}, ${json ? 'JSON' : 'not JSON'}${cloudflare ? ', CLOUDFLARE BLOCK' : ''}, ${text.length} bytes` +
                (signed ? `, says: ${text.slice(0, 120).replace(/\s+/g, ' ')}` : ''));
  } catch (e) {
    blocked++;
    console.log(`${name}: network error ${e.message}`);
  }
}
if (blocked) {
  console.log(`${blocked} endpoint(s) unreachable from here`);
  process.exit(1);
}
console.log('All CoinDCX endpoints reachable');
