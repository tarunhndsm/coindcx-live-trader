# CoinDCX live trader

An automated trader for one CoinDCX INR spot wallet. It runs in the cloud without any laptop, is
controlled from a Google Sheet, and trades real money once you give it a CoinDCX API key. Until
then it trades on paper.

- Sheet (owner account t.a.bhagat@gmail.com): [CoinDCX trader](https://docs.google.com/spreadsheets/d/1vL_YJzGnkYXmYfVFTDnvAAoMlsTrsPcx-jeQJ3H6SgQ/edit)
- Runs: [GitHub Actions](https://github.com/tarunhndsm/coindcx-live-trader/actions)

## What to expect

This bot cannot promise a profit, and it will not make ₹10,000 a day. From a ₹5,000 wallet that
would be 200% a day; no tested strategy came close to that after costs.

- **Costs.** A round trip (a buy and its sale) costs about 2%. That is the 0.5% fee plus 18% GST on the
  fee, on each side, plus the spread. Tax takes 31.2% of each profitable sale, and losses can't be set
  off against gains. CoinDCX also holds back 1% TDS on sales, which you claim back in your tax return.
- **The 15-day paper test** (30 Sep to 15 Oct 2026, [coindcx-paper-bots](https://github.com/ttannu/coindcx-paper-bots)).
  976 of the 1,045 bots lost money, and the median bot ended at ₹3,849 from ₹5,000. Not one of the 22
  strategies made money after costs. The best bot reached ₹11,179, but it was all-in at 10x leverage and
  fell 85% along the way. The same strategy's median across 47 coins was -99.8%.
- **The rules this bot uses.** These are four slow trend rules, tested on 17 past 15-day windows. They
  averaged ₹4,917 from ₹5,000, a loss of 1.7%. Only 7 of the 68 results ended above ₹5,000. The best
  was ₹5,721 and the worst ₹4,372.

So the design aims to lose little: it trades rarely, follows only clear trends, and has hard limits.
When no rule sees a trend it holds cash. That was the case when it was set up on 17 Oct 2026.

## How it trades

There are four rules. Each runs its own ₹5,000 paper "sleeve":

| Rule | What it holds |
|---|---|
| BTC 30-day trend timing | BTC while it is above its 30-day average |
| Four-coin 30-day momentum | Each coin that rose over 30 days and is above its 30-day average |
| Four-coin 7-day relative momentum | Up to two coins that rose most over 7 days, chosen on Mondays |
| Four-coin 20/10-day breakout | A coin that closes above its 20-day high, until it falls below its 10-day low |

The real wallet holds the weighted blend of the four sleeves' coins, at most 98% invested. The rules
are checked daily at 05:30 IST. Each Monday the weights move towards the sleeves that did better,
within 10% to 40% each. The coins are BTC, ETH, SOL and XRP against INR, spot only.

## Safety limits

- Spot only: no leverage, futures or margin. It never withdraws.
- It uses at most ₹5,000, however much the wallet holds.
- **Loss brake.** If the bot's money falls to 80% of its start or of its peak, it sells everything and
  stops until you set Mode to RESET.
- Orders are limit orders at most 0.4% past the best price, and none are placed when the spread is
  over 2%.
- Every order is written down before it is placed. If CoinDCX's reply gets lost, the bot finds the
  order by its id, so it never buys twice. If a run dies mid-way, the next run finishes the job.
- If coins leave the wallet, the bot believes CoinDCX's balances and emails you.
- It stays on paper until there is a key and at least ₹500 of free INR. If CoinDCX rejects the key,
  it stays on paper and emails you why.

## Going live: what only you can do

1. On coindcx.com go to Profile > API dashboard and create a key. CoinDCX asks for an email and SMS
   code. If it offers to bind the key to an IP address, leave that off, because GitHub's servers change
   address on every run. If it offers withdrawal permission, leave that off as well.
2. In the Sheet choose **Trader > Set CoinDCX API key** and paste the key, then the secret.
3. Keep at least ₹500 of INR free in the CoinDCX spot wallet; the bot uses up to ₹5,000 of it.

Within about a minute, the Control tab shows "Running as: REAL MONEY on CoinDCX".

## The Sheet

- **Control.** Mode is in cell B3:
  - LIVE trades.
  - PAUSE places no orders.
  - SELL ALL sells what the bot bought, then pauses.
  - RESET restarts after the loss brake.

  Health in B5 says whether runs are finishing. Below it are the wallet's status and the four rules.
- **Trades.** Every real and paper order, with its fee, the TDS and the tax set aside.
- **Value.** The wallet's value each hour, next to what simply holding BTC would be worth.
- **Log.** Warnings and alerts.
- **Trader menu.**
  - Set CoinDCX API key.
  - Run now.
  - Email a report now.
  - Install or repair the 15-minute schedule.
  - Remove the API key.

A report email arrives daily after 09:00 IST. Alerts arrive when something needs you.

## How it runs

```
Apps Script (bound to the Sheet)            GitHub Actions (this repo)               CoinDCX
  tick() every 15 min ── start trade.yml ──▶  runner/run.mjs runs src/Code.gs  ──────▶  prices, orders
  web app doPost  ◀──── signed begin/save/finish ────┘
  state, key, Sheet, emails, watchdog
```

- **Why two parts.** CoinDCX's Cloudflare firewall refuses Google's servers with HTTP 403, but answers
  GitHub's. So Apps Script is the clock and keeps the state and the key, while GitHub runs the steps.
  The runner executes the same `src/Code.gs`, and a test checks that both paths give identical results.
  The repo is public so that Actions minutes are free; it holds no secrets.
- **The channel between them.** The runner reaches Apps Script only through the web app.
  - Every request is signed with a shared secret (HMAC-SHA256) and carries a timestamp and a one-time
    nonce.
  - A lease lets only one run act on the wallet at a time.
  - The state is saved before each order.
  - The key is masked in the logs and never sent back.
- **Fallbacks.**
  - `trade.yml` also runs hourly at :41 on GitHub's own schedule, in case the Apps Script trigger stops.
  - If no run finishes for 50 minutes, the Health line says PROBLEM and you get an email, at most every 6 hours.
  - GitHub disables a scheduled workflow after 60 days without commits. Apps Script therefore re-enables
    `trade.yml` daily, and again whenever GitHub refuses to start it.
- **A known risk.** CoinDCX could start refusing GitHub's servers too. Runs would then fail and you
  would get an email. `probe.yml`, run by hand, checks whether GitHub can still reach CoinDCX.

## Maintenance

- **Tests:** `node --test --test-reporter=tap test/trader.test.mjs test/bridge.test.mjs`.
- **Changing `src/Code.gs`.** Paste it into the Apps Script editor and save; the 15-minute trigger
  runs the saved code.
  - If the change affects the web app (`doPost`, the state format, the Sheet or the emails), also bump
    `CODE_VERSION`.
  - Then choose Deploy > Manage deployments > Edit > Version: New version > Deploy. The URL stays the same.
  - Push to `main` at the same time. A runner whose `CODE_VERSION` differs from the web app's stops
    before it calls CoinDCX.
- **`tools/admin.mjs`.** This is the owner tool for the web app: `status`, `install`,
  `config GITHUB_TOKEN|OWNER_EMAIL` (the value comes from stdin), `pair <url>` and `secret <name>`.
  It reads the web app URL and secret from `~/.config/coindcx-live-trader/webapp.json`. Running the
  bot doesn't need that file.
- **Secrets.**
  - The Apps Script project's Script Properties hold the CoinDCX key and secret, `WEBAPP_SECRET`,
    `GITHUB_TOKEN` and `OWNER_EMAIL`.
  - The repository secrets hold `WEBAPP_URL` and `WEBAPP_SECRET`.
  - `GITHUB_TOKEN` is the fine-grained token "coindcx-trader-dispatch". It allows Actions read and
    write on this repo only and never expires.
- **Stopping.**
  - To stop trading, set Mode to PAUSE or SELL ALL, or remove the API key from the menu.
  - To stop the runs as well, first delete the `tick` trigger in Apps Script (Triggers), since `tick`
    enables the workflow again every day. Then disable the `trade` workflow.
  - Finally, revoke the token at github.com/settings/personal-access-tokens.
