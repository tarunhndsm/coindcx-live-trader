"""Export the tested Python backtest's results for the JavaScript port's tests.

    python3 tools/export_windows.py ~/coindcx-paper-bots

Runs research.strategy_screen.run_window (next-hour open fills, normal costs) for the four rules over
the 17 historical 15-day windows and writes test/fixtures/windows.json.
"""

import json
import os
import sys

paper_repo = os.path.abspath(os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "~/coindcx-paper-bots"))
sys.path.insert(0, paper_repo)

from research.strategy_screen import DAY_MS, START, WINDOW_COUNT, WINDOW_DAYS, run_window  # noqa: E402
from sim.slow_signals import PAIRS, History  # noqa: E402

with open(os.path.join(paper_repo, "config.json")) as f:
    config = json.load(f)
histories = {}
for pair in PAIRS:
    with open(os.path.join(paper_repo, ".scratch", "history", "%s_1h.json" % pair)) as f:
        histories[pair] = History(pair, json.load(f))

out = []
for k in range(WINDOW_COUNT):
    start = START + k * WINDOW_DAYS * DAY_MS
    for rule in ("btc_sma30", "tsmom30", "crossmom7", "donchian20_10"):
        result = run_window(rule, histories, config, start)
        out.append({"rule": rule, "start": start, "value": result["value"], "orders": result["orders"],
                    "fees": result["fees_inr"], "tax": result["estimated_tax_inr"]})

here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "..", "test", "fixtures", "windows.json"), "w") as f:
    json.dump({"window_days": WINDOW_DAYS, "results": out}, f, indent=1)
print("wrote %d window results; mean value %.2f" % (len(out), sum(r["value"] for r in out) / len(out)))
