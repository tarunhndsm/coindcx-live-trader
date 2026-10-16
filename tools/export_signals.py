"""Export reference signals from the tested Python rules, for the JavaScript port's tests.

    python3 tools/export_signals.py ~/coindcx-paper-bots

Writes test/fixtures/candles.json (compact hourly candles for the four coins) and
test/fixtures/signals.json (targets from sim.slow_signals at daily and random hours).
"""

import json
import os
import random
import sys

paper_repo = os.path.abspath(os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "~/coindcx-paper-bots"))
sys.path.insert(0, paper_repo)

from sim.slow_signals import HOUR_MS, PAIRS, History, targets  # noqa: E402

here = os.path.dirname(os.path.abspath(__file__))
fixtures = os.path.join(here, "..", "test", "fixtures")
os.makedirs(fixtures, exist_ok=True)

rows = {}
for pair in PAIRS:
    with open(os.path.join(paper_repo, ".scratch", "history", "%s_1h.json" % pair)) as f:
        rows[pair] = json.load(f)
histories = {pair: History(pair, rows[pair]) for pair in PAIRS}

with open(os.path.join(fixtures, "candles.json"), "w") as f:
    json.dump({pair: [[r["t"], r["o"], r["h"], r["l"], r["c"], r["v"]] for r in rows[pair]] for pair in PAIRS},
              f, separators=(",", ":"))

times = histories[PAIRS[0]].times
first = times[0] + 722 * HOUR_MS
last = times[-1] + HOUR_MS
rng = random.Random(7)
decision_times = list(range(first, last + 1, 24 * HOUR_MS))
decision_times += [rng.randrange(first // HOUR_MS, last // HOUR_MS + 1) * HOUR_MS for _ in range(300)]

out = []
for policy in ("btc_sma30", "tsmom30", "crossmom7", "donchian20_10"):
    held = {}
    for t in sorted(set(decision_times)):
        desired = targets(policy, histories, t, held)
        out.append({"policy": policy, "t": t, "held": list(held), "targets": desired})
        held = {pair: {} for pair in desired}

with open(os.path.join(fixtures, "signals.json"), "w") as f:
    json.dump(out, f, separators=(",", ":"))

entries = sum(1 for o in out if o["targets"])
print("wrote %d signals (%d with a position) over %d decision times" % (len(out), entries, len(set(decision_times))))
