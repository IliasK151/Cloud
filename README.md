# Meridian Trading Floor

A 3D institutional trading floor that runs in your browser, served by a small server on your Mac. Twenty AI agents work the floor. Ten trading desks each run their own strategy and day-trade like an institutional book. A five-person **Quant Research Lab** builds strategies for the market's current conditions, backtests and validates them, and trades only what survives. A five-person **Scalping Desk** only takes fast trades, scalping the London and New York sessions the way AJ Currency trades: liquidity first, tight stops. Every desk respects the **economic calendar**: no new trades into big news, and flat before it. No desk trades on its own say-so: every trade idea is **argued by its department** and graded, and an **account brain** decides what, if anything, reaches your prop account. You watch them live at their multi-monitor workstations, click one to zoom in, and they turn around and say **"Hello boss!"**, then walk you through their current setup and P&L out loud.

![The trading floor](docs/floor.jpg)

| Click a trader → "Hello boss!" | Fund dashboard |
| --- | --- |
| ![Hello boss](docs/hello-boss.jpg) | ![Dashboard](docs/dashboard.jpg) |

> **Paper trading by default.** Real orders only happen on a MetaTrader 5 account (such as your FTMO Free Trial or Challenge) that you connect **and** arm yourself in the FTMO tab. This is a learning tool, not financial advice, and automated trading can lose money.

---

## Quick start (Mac)

1. Install **Node.js 18 or newer**, either from <https://nodejs.org> (LTS) or with `brew install node`.
2. Get the code and start it:

   ```bash
   git clone https://github.com/IliasK151/Cloud.git trading-floor
   cd trading-floor
   npm install
   npm start          # live market data
   # or
   npm run demo       # simulated markets at 20× speed, works offline
   ```

3. Your browser opens **http://localhost:3000**. That's the floor. The first time, a short welcome walks you through it: what you're looking at, how the traders should sound, and (optionally) connecting FTMO.

**Prefer double-clicking?** Open the folder in Finder and double-click **`start.command`** (live) or **`start-demo.command`** (simulation). If Node.js is missing it opens the download page for you; otherwise it installs everything on the first run, starts the server and opens your browser. Close the window or press `Ctrl+C` to stop. The desks flatten and the track record is saved to `data/`.

### Live vs demo

| | `npm start` (live) | `npm run demo` (simulation) |
| --- | --- | --- |
| Crypto (BTC, ETH, SOL) | Binance public market data, real time | Simulated |
| Index futures, gold, oil, FX | Yahoo Finance 1-minute bars (NQ, ES, GC, CL, EURUSD, GBPUSD, USDJPY) | Simulated |
| Clock | Real time; desks go flat 16:50–18:00 New York | 20× accelerated New York session, 09:30–16:00, then the next day |
| Best for | Watching the agents trade the real market | Non-stop action, weekends, offline |

**Live mode uses real prices only. Nothing is ever simulated.** If a market's live source can't be reached, that market has no prices (`WAITING`) until real ones arrive: its desks show **NO PRICES**, stand aside, say why in their briefing, and refuse TradingView alerts on it. No paper trades, no research on made-up history. Every price is labelled `LIVE`, `DELAYED`, `CLOSED` or `WAITING`, so you always know what you're looking at. Futures and FX desks go quiet on weekends in live mode, while crypto trades 24/7. (`npm run demo` is the only place prices are simulated.)

**"Yahoo … HTTP 429" at startup.** Yahoo Finance rate-limits some internet connections. The floor handles this politely:

- it opens a browser-like session;
- it sends one request at a time;
- after a 429 it pauses instead of retrying.

In the meantime those markets wait, with no prices. The floor keeps retrying in the background (Yahoo, and Binance for the coins), after about 1½, 3 and 6 minutes and then every 10 minutes, and each market gets real prices the moment its feed answers. With MT5 connected and the account set up in the FTMO tab, it doesn't matter: every mapped market (NAS100, SPX500, gold, oil, EURUSD, GBPUSD, USDJPY and the coins your broker lists) runs on **your broker's own prices** instead. It also gets about 6,000 of the broker's one-minute bars as research history. A market added to the floor after you set up the account (like GBPUSD) is mapped to your broker's symbol automatically on the next sync.

---

## The floor

- **A calm, modern floor:** polished concrete, walnut slat walls, linear pendants over every desk and floor-to-ceiling windows onto the city at dusk, with soft shadows and ambient occlusion.
- **20 desks in four tiers**: two trading rows; raised behind a glass rail, the Quant Research Lab; and at the very back, a step higher, the Scalping Desk. Each desk has a six-screen workstation. The screens are live: a TradingView-style chart with the desk's entry, stop and target drawn as a position box, the book and setup checklist, a DOM ladder with time & sales, a Bloomberg-style terminal with the desk's log, the intraday P&L curve, and market watch.
- **A name tag floats over every desk** with the trader, their desk, today's P&L and a status dot (scanning, armed, in trade, standing aside for news, researching, halted). Click it to talk to them.
- **The front wall** carries the LED video wall (NAV, day P&L, fund equity, the next market-moving news, desk P&L bars, markets), world clocks and a ticker tape.
- **The traders are real characters,** each with their own look: faces with eyes that blink and follow what they're reading, hairstyles, suits, blazers and knitwear, glasses and trading headsets. Their hands work the keyboard and mouse (the arms use inverse kinematics), and between trades they sit back to read, rest their chin on a hand, take calls on the headset or sip their coffee. They fist-pump a winner, put their hands on their head after a loser and slump when risk halts them. When they trade, a speech bubble pops up over their head.

**Controls:** click a trader, or press keys `1`–`0` for the ten trading desks, to zoom in (the research lab is marked `Q`: click them or use the arrow keys). Drag to orbit, scroll to zoom, right-drag to pan. `←`/`→` moves to the next trader, and `Esc` returns to the overview. `D` opens the dashboard, `B` the Brain, `T` the TradingView page, `L` the FTMO tab, `F` the floor. `V` turns voices on and off, and `Q` switches graphics quality. The gear icon (top right) holds the voice and graphics settings and can replay the welcome tour.

### "Hello boss!"

Selecting a trader flies the camera to their desk. They swivel their chair toward you, wave, and give a live briefing: their strategy, the current setup and key levels, any open position with stop, target and R-multiple, and their P&L for the day and since inception. The briefing is spoken aloud, each trader has their own voice, and their lips move with the words. The side panel shows the full setup checklist, levels, positions, performance, a live chart, the real **TradingView** chart for their market, and their trade history. From the panel you can also **flatten** or **pause** the desk.

### Voices

Choose how the traders sound in the welcome tour or under the gear icon:

- **Realistic** (recommended): natural, human-sounding AI voices from [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), an open (Apache-2.0) text-to-speech model. The floor's own server runs it on your Mac, in the background, so it works the same in Chrome and Safari. The first time you pick it, the floor installs its voice engine into `data/voice-engine` (about 400 MB, a minute or two) and downloads the voice model once from Hugging Face (about 90 MB); after that it starts in seconds, even offline. Progress shows under the gear icon and in the Terminal (lines starting with `[voices]`). Nothing you hear is sent anywhere. Mac voices fill in until it's ready, and if a sentence ever fails, the trader finishes in their Mac voice rather than going quiet; the gear icon says what went wrong.
- **Mac voices:** your computer's built-in voices. The floor picks the best installed English voices, matches each trader's gender and accent, gives everyone a different voice where it can, and never uses the novelty or old robotic ones. For much better Mac voices, open **System Settings → Accessibility → Spoken Content → System voice → Manage Voices** and download a few **Premium** or **Enhanced** voices (for example Zoe, Ava, Evan, Nathan, Serena or Daniel), then reload the floor.
- **Off:** traders answer in text only.

Tickers are read the way traders say them ("gold", "the Nasdaq", "dollar yen"), and P&L and R-multiples are spoken properly.

---

## The desks

| # | Trader | Desk | Market | Strategy |
| --- | --- | --- | --- | --- |
| 1 | Marcus Reid | Index Futures | NAS100 | **Opening Range Breakout**: marks the first 15 minutes of the London and New York opens and trades a volume-confirmed break, with the stop at the range midpoint |
| 2 | Sofia Laurent | Global Macro | USDJPY | **Top-down market structure**: 15-minute HH/HL bias, waits for a pullback into discount or premium, enters on a 1-minute break of structure |
| 3 | Kenji Tanaka | Quant Stat-Arb | ETH / BTC | **Statistical arbitrage**: rolling OLS hedge ratio, trades the spread z-score (±2 in, ±0.35 out), market-neutral |
| 4 | Amara Okafor | Metals | XAUUSD | **Liquidity sweep reversal**: maps resting liquidity at swing and session highs/lows, fades stop-run spikes that reject back inside |
| 5 | Viktor Petrov | Digital Assets | BTCUSD | **Trend momentum**: EMA 9/21 crosses with an EMA 50 filter and ADX confirmation, trailing chandelier stop |
| 6 | Isabella Cruz | Electronic MM | SOLUSD | **Market making**: two-sided quotes in clips, inventory skew, toxic-flow filter and an inventory stop |
| 7 | James Whitfield | Execution & VWAP | SPX500 | **VWAP mean reversion**: fades ±2σ session-VWAP stretches back to VWAP when the tape is rotational |
| 8 | Priya Sharma | FX G10 | EURUSD | **Volatility squeeze**: Bollinger inside Keltner for 6+ bars, trades the release with momentum |
| 9 | Lucas Meyer | Energy | USOIL | **Trend pullback**: buys dips to the EMA 20 in an EMA 20/50 uptrend after an RSI reset (and the mirror for shorts) |
| 0 | Chen Wei | TradingView Signals | ETHUSD + any | **Executes your TradingView alerts**, and runs Supertrend (10, 3) on ETH between alerts |

**The Quant Research Lab** (the raised back row, marked `Q`):

| Researcher | Desk | Researches |
| --- | --- | --- |
| Elena Vasquez | Head of Quant Research | All nine markets, and deploys where the team isn't already trading |
| Arjun Mehta | Index Research | NAS100, SPX500 |
| Hannah Berg | FX Research | EURUSD, USDJPY |
| Omar Haddad | Commodities Research | XAUUSD, USOIL |
| Mei Lin | Crypto Research | BTCUSD, ETHUSD, SOLUSD |

**The Scalping Desk** (the top tier at the back, marked `S`): five scalpers who only take fast trades, all with the same method, modelled on how [AJ Currency](https://www.youtube.com/@aj.currency) (Adrian Mudronja) describes his trading in public. He started with smart-money concepts and moved to a purely liquidity-based approach. He reads the higher timeframes for context even though he scalps, trades the London session (his signals come at 8am London) on GBPUSD, EURUSD and gold, and keeps a tight fixed stop (he quotes 20 pips on gold) for a high reward to risk. His exact entry rules aren't public; the rules below are the floor's version of that approach.

| Scalper | Desk | Market | Killzone |
| --- | --- | --- | --- |
| Jake Morrison | Scalping · GBPUSD London | GBPUSD | 07:00–10:00 London |
| Layla Nasser | Scalping · EURUSD London | EURUSD | 07:00–10:00 London |
| Ryan Cole | Scalping · Gold London | XAUUSD | 07:00–10:00 London |
| Mia Torres | Scalping · Gold New York | XAUUSD | 08:00–11:00 New York |
| Nico Rossi | Scalping · Nasdaq New York | NAS100 | 08:00–11:00 New York |

AJ is known for the first three. The Nasdaq desk applies the same method to the New York open, the most popular fast market on FTMO.

How each scalper trades, on the 1-minute chart, inside its killzone only:

1. **Higher timeframe first.** The hourly trend (15-minute while history is short). With it, any pool of liquidity will do; against it, only a run of *major* liquidity (below), and the committee weighs the trend too.
2. **Mark the liquidity.** The Asia range (19:00–02:00 New York), the previous day's high and low, the London range (for the New York desks), the killzone's opening range, and equal highs and lows. These are the pools it trades. The 5- and 1-minute swings are mapped too, but on real history trading them lost, so they're only the small stops a scalp trades through.
3. **The run and the trap.** Price trades through a pool (the stops get run), then closes back inside: the breakout traders are trapped.
4. **The shift.** A 1-minute close back through the candle that made the run's extreme, with displacement (a big body, a big range or a fair value gap).
5. **Entry and stop.** A limit on the pullback to the middle of the move off the sweep, given up after 8 minutes or if price jumps through it. The stop goes just beyond the run, never tighter than 10 spreads (so costs stay small) and never wider than the **scalp stop:** 20 pips on gold (AJ's number), 10 on GBPUSD, 8 on EURUSD, 20 points on the Nasdaq, stretched to at most 1.5× the 1-minute ATR when the market is fast. A deeper run is skipped, never chased.
6. **Target and exits.** The liquidity on the other side, at least 2R away (2.5R when there's none within 6R). Half comes off at 1R with the stop to breakeven. Out after 30 minutes if it isn't working (below +0.5R), and after 45 minutes regardless. At most three scalps per killzone.

**How the committee judges a scalp.** Like every idea, a scalp is argued by its department, but on scalping terms: room is measured to the scalp's liquidity target (the small swings on the way are the stops it trades through), and high volatility counts as the moment liquidity runs happen, so scalps are exempt from the extreme-volatility veto. The news, dead-market and reward-smaller-than-risk vetoes still apply, and the desk's measured edge on real prices still counts most: a scalper that keeps losing on paper stays on paper.

**Tested on real history.** `npm run scalp-test` replays each scalper minute by minute through the floor's own code (strategy, broker costs, risk desk and committee) on real 1-minute bars and prints the funnel (killzones, liquidity runs, traps, shifts, setups, what stopped each one) and the results. On your Mac it uses the real bars the floor saves in `data/history/` (your MT5 broker's prices once MT5 is connected), so run it after the floor has been connected for a few days. `--desk jake` tests one scalper; `--file bars.json --symbol EURUSD` tests your own data; `--set entry=auto,pools=all` tries other settings; `--committee shadow` grades every idea without blocking.

The first version was tested on the real 1-minute data available here (QuantConnect Lean's samples: OANDA gold and EURUSD, 1–15 May 2014; CME S&P futures, 12 days in late 2013), with trading costs:

| Version | Scalps | Average | Win rate |
| --- | --- | --- | --- |
| At market right after the shift, all pools | 117 | −0.27R | 40% |
| Pullback entry, major liquidity only, stop ≥ 10 spreads, 30-minute time stop (now the default) | 45 | +0.05R | 60% |

45% of the first version's scalps never went half a risk-unit in their favour and lost almost 1R each: entering right after the shift candle meant buying the top of the move. The committee also vetoed nearly every setup for "extreme volatility" and graded the rest C (paper only), which is why the scalpers weren't reaching the account. Both are fixed. It's a small sample, about breakeven: treat the scalpers' first weeks as the real test and watch their numbers on the daily report card.

In demo mode the clock only runs New York's cash session, so there the London scalpers work its first two hours (09:30–11:30) and the New York scalpers 11:00–13:00. On the FTMO account the scalpers follow the same rules as every desk: they need a proven edge (or **Proven desks only** off for half risk), and one position per correlated group, so Jake and Layla share the FX slot and Ryan and Mia the gold one.

### Weekends: crypto day trading

From Friday 18:00 to Sunday 18:00 New York, forex, gold, oil and the indices are closed, so every trading desk switches to crypto and day-trades it with its own strategy. Bitcoin goes to Marcus, James, Priya, Layla, Ryan and Nico; Ether to Sofia, Amara, Lucas, Jake and Mia. Two desks running the same strategy get different coins, so they don't take the same trade twice. Viktor, Chen, Kenji and Isabella trade crypto all week anyway. Every day still ends flat at 16:50 New York. On Sunday at 18:00 New York each desk goes back to its own market. The desk chips, the floor's screens and the desk's log show the switch ("Weekend: … I'm day trading BTCUSD").

Each desk was first replayed on 98 real Bitcoin weekends (Bitstamp 2017 and Kraken 2018 1-minute bars, `npm run weekend`), and that record ships with the floor (`server/research/weekend.json`):

| Desk | Weekend trades | Per trade (90% range) | Verdict |
|---|---|---|---|
| Marcus | 190 | −0.10R (−0.24 to +0.03) | no edge |
| Sofia | 801 | −0.34R (−0.41 to −0.28) | loses |
| Amara | 374 | −0.38R (−0.47 to −0.28) | loses |
| James | 355 | −0.16R (−0.24 to −0.07) | loses |
| Priya | 343 | −0.27R (−0.37 to −0.17) | loses |
| Lucas | 1,318 | −0.31R (−0.36 to −0.27) | loses |
| Jake, Layla | 50 each | +0.14R (−0.12 to +0.39) | too few trades |
| Ryan | 63 | +0.12R (−0.12 to +0.35) | too few trades |
| Mia | 62 | −0.11R (−0.33 to +0.13) | too few trades |
| Nico | 34 | +0.08R (−0.23 to +0.37) | too few trades |

Viktor, who trades Bitcoin all week, lost too on those weekends: −0.54R a trade in 2017 and −0.32R in 2018. Only Bitcoin was tested, because that was the only real crypto history available here. The record stands in for the Ether desks too.

On the account, at the weekend a desk's weekend record counts the way its long-run record counts during the week:
- **loses:** paper only, unless practice is on (the Free Trial, at 0.25%);
- **no edge, or too few trades:** half size.

At most **3 crypto positions** are on the account at once, training and practice included, because Bitcoin and Ether move together and every desk on crypto would otherwise add up to one big bet. FTMO's guard, stops and the daily loss limits apply as always. The account only trades crypto at the weekend if your FTMO account offers it then.

### Institutional risk framework

- A **$100M fund** split evenly across the 20 desks ($5M each). Every trade is sized so that a stop-out costs **0.5% of the desk's allocation**, capped at **4× leverage**.
- **Trade management:** half the position is taken off at +1R and the stop moves to breakeven. After that the runner is trailed with an ATR chandelier stop, and some strategies use time stops. The scalpers don't trail: the runner goes for the liquidity target, with a 30-minute time stop and a 45-minute limit.
- **Desk daily loss limit (2%):** when it's hit, the CRO flattens and halts the desk until the next trading day.
- **Fund daily loss limit (1.2% of NAV):** when it's hit, the whole floor goes risk-off.
- **News:** no new trades around high and medium-impact releases for the markets they move, and every desk goes flat 5 minutes before high-impact news (below).
- Other controls: cooldown bars after a loss, daily trade caps, and every desk flat into the close. Execution is modelled with spreads, slippage, commissions and maker rebates. USDJPY P&L is converted from yen.

All limits are configurable in `.env` (copy `.env.example`).

---

## Economic news calendar

Real traders don't open a trade into CPI, payrolls or a Fed decision, and they're flat before the number hits. Neither are the desks.

- **The calendar.** In live mode the floor reads this week's [Forex Factory](https://www.forexfactory.com/calendar) calendar (high, medium and low impact, with forecast and previous), saves it in `data/calendar.json` and refreshes it every few hours. If it can't be reached, the desks stand aside around the usual US release times (08:30 and 10:00 New York, and the Wednesday oil report) rather than trade blind. In demo mode the floor generates a realistic calendar, and the simulator moves the markets when each number comes out: a jump in the direction of the surprise and a burst of volatility that fades.
- **Which markets care.** Each release is matched to the markets it moves: US data moves everything, euro data moves EURUSD, UK data moves GBPUSD, Japanese data moves USDJPY, and the oil inventories report moves oil (as high impact). Crypto reacts only to high-impact US news.
- **What the desks do.** No new trades from **15 minutes before to 15 minutes after** high-impact news for their market, and 5 minutes either side of medium impact. **Every position in a market with high-impact news is closed 5 minutes before the release.** TradingView alerts are held to the same rule. The desk's status turns **NEWS**, and its briefing says what's coming and when it's back.
- **FTMO.** Funded FTMO accounts may not open or close trades within 2 minutes of high-impact news on the affected instrument. Closing 5 minutes early and standing aside for 15 keeps the floor well outside that window, and the live router refuses to send any trade during a blackout.
- **Where to see it.** A pill in the top bar counts down to the next high-impact release (or shows who is standing aside), the dashboard has the full calendar with actual, forecast and previous, and the video wall shows the next release. Under the gear icon you can switch news protection off, or let trades already 1R in profit ride through the release with the stop locked at +0.5R (never on desks trading your FTMO account).

---

## The Quant Research Lab

The five researchers don't come to work with a fixed strategy. Each research round goes like this, for each of their markets:

1. **Read the market.** Classify its condition on 5-minute bars: trending up or down, ranging, a volatility squeeze or volatile.
2. **Generate ideas that suit it.** A few hundred strategies are built from six families (channel breakouts, trend pullbacks, band mean reversion, squeeze breakouts, VWAP reversion and momentum impulses) on 1, 3, 5 and 15-minute charts. Each has a market-condition filter (trend only, range only and so on), a long/short filter, and an exit plan: ATR stop, R target or trailing exit, partial profits and a time stop. Ideas that fit the current condition are tried more often.
3. **In-sample search** on the first 60% of the history, then the best ideas are refined. Every backtest uses the desk's real trade management, with spread, slippage and commission, stop-before-target inside every bar, gaps through stops, news blackouts, the session close, cooldowns and the daily loss limit. The signal code is shared with the live desk: the backtest and the desk compute exactly the same signals (tested bar by bar).
4. **Out-of-sample test** on the next 25%, which the search never saw. The edge has to hold up (positive after costs, profit factor ≥ 1.2, keeping at least 30% of its in-sample edge, limited drawdown).
5. **Robustness:** neighbouring parameter settings must also be profitable, it must survive **double trading costs**, and a **Monte Carlo** reshuffle of its trades must stay profitable with a tolerable worst-case drawdown.
6. **Final holdout:** the last 15%, looked at once. On all the unseen data together, the edge must be **statistically significant** (t ≥ 2) over at least 20 trades.

Only a strategy that passes every gate trades. If nothing passes, the researcher doesn't trade and says so. **Deployed strategies start on probation at half size** until they have 5 live trades and are in profit. After every trade, live results are compared with what validation promised, and the strategy is **retired automatically** if it does clearly worse, or if its drawdown goes beyond anything the Monte Carlo expected. Research runs again when the market's condition changes, every 4 hours of market time (walk-forward on fresh data), and 45 minutes after a round that found nothing.

**How strict is it?** On 200 runs of pure random-walk data, where no real edge exists, the lab wrongly accepted a strategy 5 times (2.5%). Without these gates the same search "found" an edge a third of the time. Probation and the live kill-switch are there to catch the rare lucky strategy cheaply.

**History.** In live mode the lab loads about two weeks of real 1-minute bars (Binance, Yahoo Finance), keeps them in `data/history/` and extends them with every new bar, so research gets better the longer the floor runs. Once MT5 prices a market, the broker's own bars are used, and older history is shifted onto the broker's price level. Only real data is ever saved there. Caches from older versions are ignored because they could contain generated bars. A feed that doesn't answer within 90 seconds is skipped, so one stalled request (Yahoo can leave an answer hanging halfway) never keeps the research desks waiting: they start on the saved bars and MT5's own (6,000 one-minute bars per market), and the store keeps growing with every new bar. In demo mode the lab generates 30 past sessions with the same simulator and calendar.

**Months of your broker's prices.** Two weeks is too little to tell an edge from luck. Run every week across 22 months of real 1-minute history with two weeks to search on, the lab deployed only a handful of strategies, validated at +0.3R to +0.4R a trade, and on gold and the Nasdaq they lost in the weeks after (−0.37R and −0.18R a trade). With ten weeks to search on, what it deployed roughly broke even instead. So once MT5 prices a market, the floor pages back through MT5's own history, 10,000 minutes at a time, until it holds 100,000 one-minute bars of your broker's prices per market (about ten weeks of a 24-hour market). It stops early when MT5 has nothing older. It keeps them in `data/history/`, so a restart doesn't download them again. Paging needs the MeridianBridge EA 1.3 (the FTMO tab offers the update) and MT5's *Max bars in chart* at 100000 (Tools → Options → Charts; the FTMO tab warns when it's lower). The nightly review and `npm run edge` use the same bars. A research desk's new strategy still trades paper first: it reaches the account after 10 live trades on real prices that haven't lost money in total.

| A researcher's Research tab | Lab and economic calendar on the dashboard |
| --- | --- |
| ![Research tab](docs/research.jpg) | ![Research lab and calendar](docs/research-lab.jpg) |

**Where to see it.** A researcher's panel has a **Research** tab: the market conditions, the strategy's rules in plain English, in-sample / out-of-sample / holdout results, the equity curve in R across the three periods, every robustness check, the live tracking against expectations, what was rejected and why, and a **Research now** button. The dashboard's **Quant Research Lab** card shows all five at a glance. Research runs in a background thread, so the floor never stutters.

**What this is, honestly.** No process can guarantee winning trades or "no mistakes". Markets change, and a real edge can be small and noisy. This lab makes it hard to fool ourselves: strategies must prove themselves on data they have never seen, survive stress, start small and get retired when they stop working. In demo mode the simulator has real structure (trends, ranges, squeezes), so the lab finds edges often. Real markets are harder, and you should expect it to say "no edge" more often there, which is the point.

---

## The Brain: every trade is argued before it's taken

![The Brain](docs/brain.jpg)

**Departments.** The twenty agents work in four departments, each covering its markets with at least two traders and a researcher: **Equity Indices** (Marcus, James, Arjun, and Nico from the Scalping Desk), **FX & Macro** (Sofia, Priya, Hannah, Jake, Layla), **Metals & Energy** (Amara, Lucas, Omar, Ryan, Mia) and **Digital Assets** (Viktor, Isabella, Kenji, Chen, Mei). Elena, head of research, chairs every decision as the risk manager. Scalpers review scalps; a trading desk's idea goes to the department's other trading desks.

**The market brain.** One shared, multi-timeframe read of every market that everybody reasons from: the higher-timeframe and 15-minute trend, swing structure (higher highs and lows or not), momentum, distance from session VWAP, the levels that matter (session high/low, prior day, 5 and 15-minute swings, VWAP), the volatility regime, the market condition and the news clock. Each piece of evidence comes with a sentence explaining it.

**Each agent's own brain.** Every agent weighs that evidence their own way: a trend follower lives by the trend, a mean-reversion trader cares about location and hates chasing, a quant trusts measured edge and the regime, and the risk manager watches news, volatility and room. Everyone weighs the **measured edge** first: the desk's real track record, shrunk toward zero until there's enough of it (for a research desk, its validated results). The same market therefore gets genuinely different opinions.

**The debate.** When a desk wants to trade, it pitches the idea with its thesis, entry, stop, target and the evidence behind it. Two colleagues from the department that covers the market answer honestly ("Not here: price is 2.9σ below VWAP, which is chasing, and the swing low is only 0.4R away"), and Elena decides. You can watch it: the debate plays out in speech bubbles on the floor, and live in the **Brain** tab.

**The decision.**
- **Vetoed, never traded:** high-impact news within 45 minutes (medium within 20), extreme or dead-quiet volatility, or a target smaller than the risk.
- **A-grade:** full size, and the only grade that can reach your prop account.
- **B-grade:** smaller, paper only.
- **C-grade:** the committee isn't convinced, so a quarter size on paper only, just to keep measuring. That's how a desk earns its way back.

Every trade keeps its thesis and grade: in the trader's Trades tab, the FTMO blotter and the briefing ("Why I'm in: …").

**Does the logic actually help? It was tested, not assumed.** Every rule was checked against simulated trades before it was kept:
- Entries shortly before news averaged −0.30R.
- Entries in extreme volatility averaged −0.24R.
- Entries in a dead-quiet market averaged −0.21R.
- Everything else averaged −0.05R.

Rules that only *sound* smart were left out. "Always trade with the hourly trend" and "only with 1R of room" made no measurable difference, so they stay as opinions and never block a trade. With the committee switched on, across 72 simulated sessions on nine random seeds:
- The fund's worst drawdown was **29–36% smaller**.
- Fund profit was **18–62% higher**.
- A-grade trades averaged about **+0.07 to +0.08R** each.

Run `npm run backtest -- 5` to fast-forward five sessions and see the results yourself.

**The live brain.** The **Brain** tab shows each department as a live graph. The market evidence (green bullish, red bearish) feeds each agent's own brain, and each brain feeds the department's call (BUY, SELL or WAIT). Beneath the graph are every agent's current thinking in plain English and the latest debates, with lines lighting up between agents while they argue. A trader's panel has a **Brain** tab too: what they weigh, how their market looks to them right now, their measured edge and the debates they took part in.

![A department debate](docs/brain-debate.jpg)

**The floor memory: one knowledge graph the whole floor shares.** Each desk's learner only remembers its own trades. The floor memory remembers every trade any desk closes on real prices, filed by its **situation**: the market, with or against the trend, quiet, normal or wild, and the session (Asia, London, the New York open, midday or afternoon). It also keeps the lessons each desk learned and who reviewed whose ideas in the committee. Recent trades count more (each new trade in a situation outweighs the old ones), so the memory follows the market as it changes. It's kept in `data/memory.json` (demo mode has its own file, so made-up prices never mix in), and on its first start it fills itself from the trades the desks' learners already remember.

The committee asks it before every trade: *how did trades like this go, across the floor?* Once a situation has about six trades behind it, that answer becomes one more piece of evidence everyone weighs ("the floor's memory: 14 trades like this (XAUUSD, with the trend, wild, London) averaged +0.42R, 64% won"). Quants and the risk manager weigh it most, the scalpers and the market maker least. Until then it stays out of the vote, so a handful of trades can't sway anything.

The **Brain** tab shows it as a live 3D graph:
- **Nodes:** desks (in their own colour), markets (gold), situations (green if trades like that made money, red if they lost, grey while there's too little evidence) and lessons (purple).
- **Live:** when a trade closes, the line from the desk to its situation flashes green or red. When the committee meets, the reviewers' lines to the desk flash. A new lesson grows out of the desk that learned it.
- **Use it:** drag to turn, scroll to zoom, hover anything for its numbers, and click a desk to open it.
- **Beside it:** what the floor remembers best, and a live feed of trades, lessons and committee meetings.

The graph draws only while something moves, so a still graph costs no battery.

(The idea comes from [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp), which keeps a knowledge graph of a codebase for AI coding assistants and shows it in 3D. The floor's memory is the same idea for trading: a graph of situations and outcomes instead of functions and calls.)

### The neural brain: a network that learns from every trade

Every desk asks one neural network before it trades. It's a real network, written out in full in `server/neural/` (no outside library):

- **What it senses:** about 50 facts about the idea, each between −1 and +1 and signed in the trade's favour. They cover the hourly and 15-minute trend, structure, momentum, the moves of the last 5, 15, 60 and 240 minutes, distance from VWAP, levels behind and ahead, where price sits in today's and yesterday's range, volatility for the time of day, the regime, the stop, target and costs, the time of day and week, the desk's form, losing streak and trades so far today, the market and the desk's style.
- **How it thinks:** two hidden layers of 24 and 12 neurons, then the chance the trade ends in profit. It turns that chance into the R it expects after costs, from the desk's own average win and loss.
- **How it learned:** every trading desk was replayed through the floor's own code on 22 months of real 1-minute prices, 15,296 trades with the desks' current rules. The senses at each entry and how each trade ended are what it learned from.

**The honest test, on months it never saw.** Every month from the tenth on, the brain was retrained on the months before and then judged that month's trades, as the floor will do every night:

| | Trades | Every trade | Brain's picks | It passed on | Ranking skill |
|---|---|---|---|---|---|
| All desks | 12,898 | −0.15R | −0.11R (10%) | −0.15R | 0.519 |
| 1st half | 6,449 | −0.16R | −0.14R | −0.17R | 0.512 |
| 2nd half | 6,449 | −0.13R | −0.07R | −0.13R | 0.527 |

Ranking skill is the AUC: the chance that a random winner gets a higher score than a random loser, where 0.5 is a coin. At 0.519, **the brain can barely tell these desks' winners from their losers.** No single sense can either: the best of them scores 0.520, and that one only says which kind of market it is. What is real is small. Trades whose costs are high do worse (−0.21R against −0.08R), and trades with the hourly trend do a little better (−0.14R against −0.17R). The desks' entries carry almost no information about how their trades will end, so no filter on them can make them profitable. The brain's picks did better than every trade in both halves, but by too little, and with too little ranking skill, to trust yet. (The final network stopped improving on held-back trades after 2 passes: there was little to learn that held up.)

**So the brain earns its say.**
- **Learning (now):** it judges every idea, lights up in the Brain tab and learns from every trade on real prices, but decides nothing. Every idea still trades on paper as the desk wants, so the desks trade all the time and every trade is a lesson.
- **Has a say:** only once its record on trades it hadn't learned from shows real skill. That needs 300 or more trades, each judged at entry before anyone knew how it would end; a ranking skill of 0.55 or better; and picks at least 0.05R better than taking every trade. Its own record on your prices decides once it has 300 trades; until then the long-history test above does. With a say, ideas it expects to lose are passed, except a quarter of them that still trade at a quarter size on paper. Those *explorations* let it learn whether passing was right, and its skill is measured with them standing in for all the ideas it passed on. If its record slips below the bar, it loses the say again.
- **Never on FTMO by itself.** The brain can only hold trades back, never send one the account's rules hold back. An exploration never goes to the account, training or not (the Today card counts them as *Neural brain's paper experiment*).

**It learns every night.** After the New York close (or with **Learn now**), once it has 30 new trades on real prices, a challenger brain learns in the background. It uses the long history plus the floor's own trades, which count three times as much because they're your broker and today's market, and leaves out the newest half of the trades the current brain hasn't learned from. Both brains then judge those held-back trades, which neither has seen. The challenger becomes the next version only if its chances fit what happened better and its picks did at least as well. If it doesn't win, the next try has more new trades to work with. Demo mode never teaches it. Everything it learns stays in `data/neural/`, and a new version sends a message to your phone.

**The Brain tab** shows the network in 3D: the senses on the left (coloured by group), the two hidden layers, and one output neuron. Every line is one learned connection: green pushes up, red pushes down, brighter is stronger.
- **A desk asks:** the idea flows left to right along the connections that carried most of it. The neurons light with what they computed, and the answer appears at the end ("LEARNING · would take", or TAKE, PASS or EXPLORE once it has a say).
- **A trade closes:** its result flows back right to left, green for a win and red for a loss.
- **It learns:** the connections it changed flash gold and settle into their new colours, a banner says what it learned, and the version history shows when.
- **Beside it:** the latest thoughts, how it did on months it never saw, desk by desk, and **what each desk's brain learned**: the situations that raise or lower its chance most, and its best and worst hours. Until the brain has a say, these are marked as hunches, and nothing trades on them.

To retrain it from your own long history (a folder of `<SYMBOL>.json` 1-minute bars), about 12 minutes:

```bash
npm run brain -- --dir path/to/history --source "where the bars came from"
npm run brain -- --examples server/research/brain-examples.json.gz   # retrain on the saved trades, no replays
```

It writes `server/research/brain.json`, the brain that ships with the floor, with its test on unseen months, and `brain-examples.json.gz`, the trades it learned from.

## The Obsidian vault: everything the desks know

The floor writes everything its desks know into an [Obsidian](https://obsidian.md) vault, live, as linked Markdown notes:

- **Home:** the floor today, desk by desk, and the latest trades.
- **Now:** what every desk is doing this minute (its market, what it's watching for or holding, its day so far), rewritten every minute.
- **Journal/** (one folder per desk, one note per trading day): each desk keeps its own diary, written the moment things happen. 📈 when it goes in and why, ✅/❌ when it wins or loses, 🚫 the ideas it turned down and why, 💡 what it learned, 👀 what it's watching for (when that changes), ⛔ when a risk rule stops it. At the session close it writes its **End of day** review: ideas taken and turned down, wins and losses, its best and worst trade, and how it trades now.
- **Desks/** (one note per desk): its strategy and entry rules, where it stands with the FTMO account, its long-run and weekend records, the nightly review, its form and numbers, the rules it learned from its own trades, what its neural brain noticed, the situations it has traded and its recent trades.
- **Trades/** (one note per closed trade): why it was taken, the committee's grade, the neural brain's chance, how it ended, win or loss, with tags for searching (`#win`, `#loss`, `#desk/marcus`, `#market/XAUUSD`) and front matter that Dataview can query.
- **Ideas/** (one note per day): every idea each desk had, the ones it took and the ones it turned down, and why, written as it happens.
- **Daily/** (one note per day): the day per desk, the wins and the losses, the lessons learned, and the FTMO account's day.
- **Lessons/:** every lesson a desk learned from its own trades, with the evidence and whether it's still in use.
- **Markets/:** each market, with the situations the floor remembers there and who trades it.
- **Playbook/:** *What works* and *What loses* (situations with enough trades behind them, recent ones counting most), and *Rules the desks follow* (each desk's learned rules and the account plan).
- **Brain/:** the neural brain, the long-run record, the nightly review and the FTMO account.

It's the same knowledge the desks trade on (their learners, the floor memory, the neural brain and the evidence), so what you read in Obsidian is what they know. Open it with Obsidian → **Open folder as vault**, choosing `data/vault` in the floor's folder (the Brain tab shows the exact folder, with a copy button). Start from **Home**. In the graph view, wins are green, losses red, desks blue, markets gold and lessons purple.

**How live it is.** The desks write to the vault the whole time the floor runs, every day of the week (crypto at the weekend):

| What | When it's written |
| --- | --- |
| A desk's journal line, and the day's idea log | The moment it happens: an idea taken or turned down, a win, a loss, a lesson, a risk stop |
| A trade's note, and its desk's, market's and day's notes | A few seconds after the trade closes |
| Now | Every minute |
| Home, desks, Playbook, Brain, Lessons, Markets | Every 5 minutes, and straight away when a desk learns, the brain retrains or the nightly review lands |
| Each desk's End of day review | At the session close (16:50 New York) |

Obsidian picks up the changes as they're written, so you can keep it open next to the floor. The Brain tab shows **● live** and when the vault was last written.

**Non-stop.** The vault is written while the floor runs, so to have the desks in it all the time, run the floor as a background service (`npm run service -- install`, see [Run it non-stop](#run-it-non-stop)) and keep the Mac awake: plugged in, lid open, and *Prevent automatic sleeping on power adapter* on. While the floor is stopped or the Mac sleeps, nothing is written; when it starts again, the vault catches up from the floor's records (any trade in the desks' books without a note gets one).

- **Your notes are kept.** Anything you write under *Your notes* at the bottom of a note stays: the floor only rewrites what's above it. That includes the desks' journals, so you can add your own thoughts to their day.
- **It's kept tidy.** Unchanged notes aren't rewritten. Trade notes older than 180 days, journals older than 90 and idea logs older than 60 go, because the desk notes keep the numbers.
- **It's kept separate and private.** Demo mode writes its own vault (`data/vault-demo`), so made-up prices never mix in. Nothing secret is ever written: no tokens, keys or passwords.
- **It can live anywhere you like, except Desktop, Documents, Downloads and iCloud Drive.** Set `VAULT_DIR` in `.env` (for example `VAULT_DIR=~/Meridian Vault`). macOS doesn't let the non-stop service write in those four folders, so a vault there would stop updating (`npm run service -- status` and the Brain tab say so if it happens). `VAULT=0` turns it off.

## Protecting the prop account (the account brain)

The paper desks can experiment; the account only gets the best ideas, sized by where the account stands. This is the plan a professional prop trader follows to pass a challenge and keep getting paid:

- **Only A-grade trades from proven desks.** A desk needs 10+ paper trades **on real market prices** and a positive measured edge before it risks real money. For a research desk, a strategy validated on real history counts instead. Demo-mode trades never count, and live mode never simulates a market: one without real prices simply isn't traded. The Brain tab lists who is cleared and who is still proving themselves.
- **Your own TradingView alerts are your decision.** They go to the account without the proven-desk and grade checks. The committee can still veto them (news, extreme volatility, poor reward), and every risk rule below applies. Test alerts from the TradingView tab's button never trade the account.
- **Switched on is not the same as trading.** A desk's own trades reach MT5 only once it's cleared. Everywhere the floor shows where each desk really stands, and never claims a paper trade is on FTMO:
  - desk list chips: **FTMO LIVE**, **FTMO**, or **FTMO · PAPER** while it's proving itself;
  - the "Status on the account" column in the FTMO tab;
  - the dashboard;
  - the desk's own briefing, which gives the reason when a trade wasn't sent.
- **Starting fresh.** The real-only record began with this version. Your desks' earlier paper records can't be split into real and simulated trades, so every desk earns its 10 real trades again before it risks the account. Crypto desks on Binance get there fastest.
- **Drawdown shrinks risk.** Below the starting balance, risk scales down (for example −$100 on a $10,000 trial: 0.25% → 0.20% per trade) until the loss is won back: to 0.4× by halfway to the max loss, and to a quarter once the account is 60% of the way there (6% down on a 10% max loss). Replayed on 22 months of every desk's real trades, the quarter-size step took about a quarter off the losses of a losing run. Risk never grows past the base risk you set.
- **Daily stop at −1.5%**, far before FTMO's 5%. At half of that, risk halves for the rest of the day.
- **Losing streaks:** two in a row halve the risk until the next winner; three in a row end the day.
- **At most 6 trades a day.** Overtrading is how accounts die. Only trades MT5 actually confirmed count; an order it never confirmed doesn't.
- **Training on FTMO (Free Trial, on by default).** Every trade a switched-on desk takes goes to your FTMO account, so the desks train on FTMO itself instead of on paper. The committee grade, proven-desk, one-per-group and daily-plan holds below are paused. What stays:
  - real prices only;
  - a stop-loss on every order;
  - no new trades in a news blackout;
  - FTMO's loss guard: it closes everything at 80% of a limit, and no trade goes in whose stop, together with every open and in-flight stop, could breach it;
  - the risk limits (below): a 2-hour cool-off after 3 losses in a row instead of the rest of the day, each desk's loss limit, no flipping, the cost check and capital following results;
  - the evidence, unless practice is on (next point): a desk that lost money over the long run (22 months of real prices, see *The long run* below) or in the nightly review on your own prices trades paper only, and a research desk's new strategy trades paper until 10 live trades haven't lost money in total.
- **Practice: every desk trades the trial (Free Trial, on by default while training).** The desks the evidence holds back still trade your Free Trial, at 0.25% a trade (or your risk per trade, if that's lower). That covers desks losing over the long run, with no edge on your prices, out of form, or running a new research strategy. You see every desk trade on MT5, not just the two or three the evidence clears. Everything in the list above still applies: the loss guard, stops, news blackouts, the cool-off, each desk's loss limit and the drawdown cut. Expect the trial to drift down slowly. Replayed on the 22 months at 0.25% a trade, training as it ran lost about 0.6% a month, because these desks lose a little on average. Their desk chips read *Practice · loses long-term* and so on. Switch it off on the FTMO or Brain tab to keep those desks on paper. A paid challenge or funded account never practises: the switch isn't there.

  Sizes still follow the committee's grade: A full, B 60%, C 25% of the risk per trade. Below the broker's minimum lot, the minimum is used if it still risks no more than your risk per trade. They still halve after a −0.75% day or two losses in a row, and shrink in drawdown. Up to 8 positions can be open at once (the EA's own cap; raise *Max floor positions* in the EA's inputs for more). Kenji's pairs trades and Isabella's market making can't be copied onto one account, so those two stay paper. Switching training on puts every other desk on the account. It's for the Free Trial only: on a paid challenge or a funded account the switch isn't there and the full plan applies. Switch it off on the FTMO or Brain tab to go back to the plan below.
- **Every rule that can hold trades back has its own switch** on the Brain and FTMO tabs, for when you want to let the desks run and watch the performance:
  - **Daily stop:** when it's off, desks keep trading after −1.5%. Risk still halves.
  - **Trade cap:** when it's off, there's no daily limit on trades.
  - **Losing-streak stop:** when it's off, desks keep trading after 3 losses in a row. Risk still halves after 2. While training it's the switch for the 2-hour cool-off.
  - **Proven desks only:** when it's off, unproven desks send their committee-approved A and B-grade trades to the account at half risk.

  FTMO's own loss guard (80% of each limit) always stays on.

  While switched-on desks are still proving themselves, the desk list and the FTMO tab say so, with a **Let them trade FTMO now (half risk)** button. The desk chips show where each desk stands:
  - **PROVING**: its trades stay on paper;
  - **FTMO ½**: unproven, trades the account at half risk;
  - **FTMO**: cleared;
  - **FTMO LIVE**: has a position on MT5 right now.
- **The broker's minimum lot.** When a trade sizes below MT5's minimum lot, it goes at the minimum only if that still risks no more than your base risk per trade. Otherwise it stays on paper and says why.
- **One position per correlated group.** NAS100 and SPX500 are one bet, EURUSD, GBPUSD and USDJPY are one FX bet, and so are the three coins.
- **Near the target, smaller risk**, so one loss can't undo the progress. **Funded accounts trade 20% lighter** to protect the payouts.
- The FTMO rule guard, news blackouts and stop-losses on every order still apply underneath.

### Run like an institutional trading desk

Bank trading floors and multi-manager funds don't rely on a trader's judgement alone. Risk limits, costs and capital allocation are set from outside the trade. These are well-known industry practices, not any one bank's internal playbook. The floor runs them on the account, during training too. None of them stops the paper trading the desks learn from.

- **Transaction costs come first, on paper and on the account.** Every desk works out what a trade will cost before it takes it, in R: the spread, slippage and the broker's commission both ways. Then:
  - costs up to **0.25R**: the trade goes as planned;
  - between 0.25R and **0.4R**: the desk widens its stop until the costs are 0.25R of it, the target moves out by the same factor (the same reward-to-risk) and the size shrinks, so the money at risk stays the same;
  - above 0.4R: the trade isn't taken, because the stop would have to move too far from the setup. The desk says what stop it would need.

  On the account, the floor checks again with the real numbers: the spread from MT5's live quote, and the commission it learns from the account's own fills (MT5 books it on the entry deal, per symbol). A trade costing over 0.4R there, like a spread spike at the daily rollover, doesn't go. Every entry alert on your phone says what the trade costs. Your own TradingView alerts are your call and aren't held back by either check.
- **Paper pays what FTMO charges.** Each market has its own typical spread and commission, as on FTMO's raw-spread accounts:
  - FX: a few tenths of a pip, plus $2.50 a lot each way;
  - gold: about 20 cents;
  - indices: the spread only;
  - crypto: 0.0325% of the trade each way, plus a CFD spread much wider than an exchange's.

  The paper broker and the research lab's backtests both use these numbers. Before, every market paid the same small fee: FX scalps paid about twice what FTMO charges, and crypto about a sixth. So paper results didn't match the account. On real 1-minute history (EURUSD, gold and the S&P 500), the same desks went from −0.51R a trade (−107R over 211 trades) to about −0.1R a trade with these costs and the cost check. Most of what they lost was trades too small for their costs.
- **A cool-off after a losing streak.** While training, 3 losses in a row on the account pause it for 2 hours, instead of the plan's stop for the rest of the day. The *Stop after 3 losses in a row* switch turns it off.
- **Each desk has a daily loss limit**, like a trader at a bank: a desk that has lost twice its full risk per trade on the account today ($100 at 0.5% of $10,000) is off the account until tomorrow. The other desks trade on.
- **No flipping.** After the account loses on one side of a market, nothing the other way on that market for 30 minutes, from any desk. Selling oil, getting stopped out, then buying it and getting stopped again is how a choppy market takes both sides.
- **Desks earn their place on the account.** Once a desk has 3 or more trades on real prices, the average of its last 20 must be 0R or better for it to trade the account. Below that it trades paper only, where it keeps learning, and it's back as soon as its paper trades lift the average again. The desk list says *Paper · out of form*. Replayed on real 1-minute history (EURUSD, gold, S&P 500, with the costs above), the trades it let onto the account came out about even: −1.5R to +2.8R over about 80 trades, depending on the run, because the paper broker's slippage is random. The paper total was clearly negative in every run. Most of what it kept off came from two desks whose method didn't suit those markets: the opening-range breakouts at the London open on a US index, and the London gold scalps. That's a small sample from 2013–2014, so treat it as a sensible filter, not a promise.
- **Capital follows results.** A desk whose last 8 to 12 trades on the account lost money after costs, measured on what MT5 actually paid, trades at half size until its record turns positive again. The desk list says *half size* and why.
- **Volatility is judged against the same time of day.** Markets are always busier at the London and New York opens than overnight. The committee used to compare volatility with the last 17 hours, which made every New York open look "extreme" and vetoed good trades. Now it compares with the same hour (±1 hour) on earlier days, and falls back to the recent range only without that history. A real spike, like news, still reads as extreme.

The FTMO tab's *Today on the account* card counts each of these when it holds a trade back and says what it means.

The Brain tab shows the account's phase and goal, its status (NORMAL, CAUTIOUS or STOPPED FOR TODAY), the risk per trade right now and why, how many clean 2R winners it is from the target, trading days (FTMO asks for at least 4) and every rule. All of it is editable under **Edit setup → The account plan** in the FTMO tab.

To rehearse a drawdown without risking anything, use **two Terminal windows**, because the floor has to keep running while the mock connects to it:

```bash
# Terminal window 1: start the floor and leave it running
cd ~/Desktop/trading-floor && npm start

# Terminal window 2 (⌘N in Terminal): a pretend FTMO terminal that is $100 down
cd ~/Desktop/trading-floor && MOCK_PNL=-100 npm run mock-mt5
```

Close your real MT5 first (or use another floor port), so two terminals don't feed the same floor. `npm run demo` in window 1 works too, but the FTMO tab only arms in live mode.

**Honestly:** none of this can guarantee a pass or a payout. What it does is make every trade explain itself, keep the account out of the situations that measurably lose, and size the account down exactly when losses tempt people to size up.

---

## TradingView integration

1. **Charts.** Every trader's panel has a **TradingView** tab with the official TradingView Advanced Chart for their market (for example `OANDA:XAUUSD` or `BINANCE:BTCUSDT`), plus an "Open on TradingView" link. The floor's own charts are drawn with TradingView Lightweight Charts™.
2. **Alerts → orders.** Your TradingView alerts can be sent to any desk. They trade on paper, and on your FTMO account too for desks you've switched on and armed in the FTMO tab.

### Set up TradingView alerts (about 3 minutes)

Open the **TradingView** tab. A checklist at the top ticks itself off as you go:

1. **Public address.** TradingView sends alerts from its servers on the internet, so the floor needs a public web address. Press **Create public address**. The floor opens a free [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) (no account needed). The first time, it downloads Cloudflare's `cloudflared` app from Cloudflare's official GitHub releases into `data/bin`, unless you already have it (`brew install cloudflared`). The tunnel only reaches the webhook-only port, so the dashboard and its controls stay private on your Mac. It turns itself back on whenever you start the floor.
2. **Connection test.** The floor sends a harmless test ping through the public address to check that it works from the internet. The ping never places a trade.
3. **Alert in TradingView.** Create an alert, paste the **message** the tab writes for you (pick the desk and buy / sell / close / strategy) into the alert's Message box, then tick **Webhook URL** under Notifications and paste the address. This step ticks itself off when the first alert arrives.

Webhook alerts need a paid TradingView plan (Essential or higher), and TradingView asks you to turn on two-factor authentication before it will send them.

**An address that never changes.** The free Cloudflare address changes each time the floor starts, so you'd have to update the Webhook URL in your alerts after every restart (the tab warns you when that happens). For a permanent address, sign up for a free [ngrok](https://ngrok.com) account and paste your **authtoken** and free **static domain** under *Want an address that never changes?* in the tab. That's set once (the token stays on your Mac in `data/tradingview.json`), and the address stays the same for good.

**The alert message** looks like this (the tab fills in your secret):

```json
{"secret":"<your secret>","agent":"amara","symbol":"{{ticker}}","action":"buy","price":{{close}}}
```

- `action`: `buy` / `sell` / `close`. Strategy alerts also work with `"action":"{{strategy.order.action}}","position":"{{strategy.market_position}}"`.
- Optional fields: `stop`, `target` and `comment`. Without them the desk uses a 1.5 ATR stop and a 2R target, sized by the risk desk.
- `agent` picks the desk (`marcus`, `sofia`, `kenji`, `amara`, `viktor`, `isabella`, `james`, `priya`, `lucas`, `chen`). Without it, the alert goes to Chen's TradingView Signals desk.
- Tickers such as `OANDA:XAUUSD`, `NQ1!`, `BINANCE:BTCUSDT` and `ES1!` are mapped automatically.
- The secret is created on first run in `data/webhook-secret.txt`, or you can set `WEBHOOK_SECRET` yourself. Alerts with a wrong secret are rejected, and the endpoint is rate-limited.

**No indicator of your own?** [`tradingview/institutional_agents_alerts.pine`](tradingview/institutional_agents_alerts.pine) is a ready-made indicator that sends Supertrend-flip alerts with stop and target levels to the desk you choose. The tab has **Copy script** and step-by-step instructions.

You can try the whole pipeline without TradingView using **Send test alert** on the tab. Prefer your own tunnel? Point any HTTPS tunnel at `http://localhost:3001` and use `https://<your-address>/webhook`.

![TradingView tab](docs/tradingview.jpg)

---

## How the desks learn

Every desk studies its own trades and gets better at avoiding its own mistakes. The pair-trading and market-making desks manage their books as a whole, so they sit this out.

**What each trade teaches.** When a trade closes, the desk journals the situation it was taken in and how it played out:

- **The situation:** time of day (Asia, London, the New York open, midday, afternoon), whether the market was quiet or wild, with or against the trend, how good the setup looked, whether it came right after a loss, which trade of the day it was, and long or short.
- **How it played out:** the result in R, how far it went for and against the desk, and, after a stop-out, whether the market then went the desk's way.

**What the desk changes**, only when the evidence is clear and always within safe limits:

- **Sizing.** A bit bigger where the desk has a proven edge, and smaller in situations that do worse than its other trades, or while it's in a losing streak (×0.5 to ×1.25 overall).
- **Sitting out** a situation that keeps losing compared with the desk's other trades, after at least a dozen trades of evidence. The desk still takes an occasional small test trade there, so it can notice when things change and go back.
- **Fixing management mistakes:**
  - Giving back winners → it takes partial profits sooner and trails tighter.
  - Getting stopped out right before the move → it gives trades more room. The size shrinks, so the money at risk stays the same.
  - Stops wider than needed → it tightens them.
  - Targets that are rarely reached → it brings them closer.
- **Behaviour:** a longer break after a loss if revenge trades lose, and fewer trades per day if late-day trades lose.
- **Checking its own changes.** After about 15 more trades, the desk compares results before and after each change. It keeps what helped and rolls back what didn't, and tells you so.

**Where to see it.** Each trader's panel has a **Learning** tab: what they do differently now, every lesson with its evidence, and their results in each situation. New lessons pop up on the floor, traders mention the latest one in their briefing, and the dashboard lists what every desk has learned. Everything is saved with the track record and survives restarts. **Forget what they learned** in the tab starts a desk fresh.

**Safety.** On your FTMO account, learning can only make a trade smaller, never bigger, and every FTMO rule and limit still applies. Your own TradingView alerts are studied but never skipped or changed. This is adaptive risk management from a desk's own history, not a guarantee of profits: patterns from a few dozen trades can be noise, which is why every change is limited, reviewed and reversible.

---

## Trade your FTMO account (MetaTrader 5)

The desks can trade your **FTMO Free Trial, Challenge, Verification or FTMO Account** through MetaTrader 5. A small Expert Advisor, [`mt5/MeridianBridge.mq5`](mt5/MeridianBridge.mq5), runs inside your MT5 terminal and links it to the floor on the same Mac. Your FTMO password stays in MT5; the floor never sees it.

![FTMO tab](docs/ftmo.jpg)

**How it works**

- **The floor stays the brain.** When a desk you've enabled opens, scales out, moves its stop or closes a trade, the same action is sent to MT5.
- **Every order carries a stop-loss.** Positions stay protected in MT5 even if the floor, the EA or your Mac stops.
- **Your own risk sizing, not the paper desk's.** The default is **0.25% of balance per trade**, with at most 1.5% open risk and 5 live positions, all editable.
- **Priced from MT5.** Once connected, the floor switches each mapped market to your broker's prices (US100.cash, XAUUSD, EURUSD and so on). The desks then analyse exactly the prices they trade.
- **Your TradingView alerts can trade the account too.** Enable Chen's TradingView Signals desk (or any desk named in the alert). Each alert is debated by the committee like any other idea and executed on FTMO with the same sizing and stop rules (only A-grade alerts reach the account).
- **FTMO rule guard.** It watches the daily and maximum loss using FTMO's method (equity against the day's starting balance, and against the account size, or on 1-Step against the best end-of-day balance). At 80% of a limit it closes the floor's positions and stops trading: until the next server day for the daily limit, and until you clear it for the max loss. It can also stop when the profit target is hit, which is on by default.
- **2-Step or 1-Step** (below): the FTMO tab asks which program the account is on, and follows that program's limits.
- **Arming is always your decision.** The floor starts disarmed after a restart, unless you switch on **Stay armed after a restart** (below). Paid accounts need you to type the account number to arm. **Close all & disarm** is always one click away.
- **Two desks stay paper-only.** The stat-arb and market-making desks don't mirror onto a single prop account.
- **Research desks can trade it too,** once you switch them on: they trade only validated strategies, at half size while a new strategy is on probation.
- **The account brain decides what reaches the account** (above): only committee A-grade trades from desks with a proven edge, sized down in drawdown and after losses, with a daily stop, a daily trade cap and one position per correlated group.
- **News.** Nothing is sent to MT5 inside a news blackout, and the floor's positions are closed 5 minutes before high-impact news.

**Set it up (once, about 5 minutes)**

1. Start the floor with `npm start` (live mode; demo mode never trades live).
2. In the FTMO Client Area, start a **Free Trial** on **MetaTrader 5**. Install MT5 and log in with the credentials FTMO shows you.
3. In MT5, go to **Tools → Options → Expert Advisors**. Tick **Allow algorithmic trading** and **Allow WebRequest for listed URL**, then add `http://127.0.0.1:3000`.
4. Install the **MeridianBridge** Expert Advisor. On a Mac, MT5's folders usually don't accept drag-and-drop from Finder, so use one of these:
   - **MetaEditor (easiest):** in MT5 press **F4**, then **File → New → Expert Advisor (template)** and name it `MeridianBridge`. Delete the template code, click **Copy EA code** in the floor's FTMO tab, paste it in (Cmd+V, or Ctrl+V / right-click → Paste) and press **Compile**.
   - **One command:** quit MT5 and run `npm run install-ea` in the trading-floor folder. It finds MT5's hidden `MQL5/Experts` folder and copies the file in. Reopen MT5, right-click **Expert Advisors → Refresh** in the Navigator, then right-click MeridianBridge → **Modify** → **Compile**.
5. Drag **MeridianBridge** onto any chart. Paste the **bridge token** from the FTMO tab into the inputs, tick **Allow Algo Trading**, and switch on **Algo Trading** in the toolbar.
6. The floor pops up **"New FTMO account detected"**. Pick the program (2-Step or 1-Step) and the account type (Free Trial, Challenge, Verification or FTMO Account), check the limits against your Client Area, and save.
7. Switch on the desks that may trade the account, then press **Arm live trading**.

![New FTMO account detected](docs/ftmo-connect.jpg)

**Which P&L you're looking at.** Every desk also keeps paper trading with the fund's practice money, which runs to millions per desk. Once an FTMO account is connected, the top bar, desk list, desk signs, video wall and trader panels show **your FTMO account**: its equity, today's P&L and each desk's P&L on it. A desk that isn't switched on for the account says **paper**. The **FTMO / Paper** switch at the top flips the floor (and the dashboard) back to the paper fund, and the paper dashboard has a **Reset paper P&L** button.

**Why a desk hasn't traded yet.** A desk only trades when its setup appears, and some setups only appear at certain times (the opening-range breakout needs the New York open). No new trades open between 16:50 and 18:00 New York time, around the daily roll-over.

**No MT5 handy?** Run `npm run mock-mt5` in a **second** Terminal window while `npm start` runs in the first. It pretends to be an FTMO Free Trial terminal, so you can try the whole connect → set up → arm → trade flow. ("Floor not reachable" means the floor isn't running in the other window.)

**Before you arm a paid Challenge, read this**

- Run it on the **Free Trial** first and watch it for a few days. The strategies were built and tuned on simulated markets and have no real-money track record.
- **Check FTMO's current rules on algorithmic trading yourself.** FTMO generally allows Expert Advisors but prohibits some trading practices, and their terms change. Complying with them on your account is your responsibility.
- **A stop-loss is not a guarantee.** Gaps, news spikes and slippage can fill beyond it. The guard acts at 80% of each limit to leave a buffer, but it cannot promise you'll never breach one. The floor stands aside for news using a public calendar; FTMO's own list of restricted releases is what counts, so check it for funded accounts.
- MT5 must stay open, and your Mac awake, while the desks trade. The floor keeps the Mac awake by itself while it runs (on a MacBook, keep the lid open: a closed lid sleeps it anyway).

### FTMO's rules: 2-Step or 1-Step

FTMO runs two programs, and a Free Trial comes in both. Their limits differ, so the FTMO tab asks once which one the account is on (**Which FTMO program is this account?**, or *FTMO program* in Edit setup). Not sure? In the FTMO Client Area open the account's **MetriX**: a *Max Daily Loss* of 5% of the account means 2-Step, 3% means 1-Step. **Until you choose, the guard follows the stricter one (1-Step)**, so nothing can breach either.

| | 2-Step | 1-Step |
| --- | --- | --- |
| Max daily loss | 5% of the starting balance, below the day's starting balance | 3% |
| Max loss | 10%, fixed at the starting balance | 10%, trailing the best end-of-day balance. The line moves up with new highs and never goes above the starting balance |
| Best Day rule | none | Before the account passes, no single day may be more than 50% of the profit from all winning days. Not a breach: more winning days fix it |
| Minimum trading days | 4 (Challenge and Verification) | none |

What the floor does on 1-Step:

- **The max-loss line trails.** The guard measures the max loss from the best end-of-day balance it has seen (from the daily report cards and every sync, remembered so it never goes down), and the FTMO tab shows the line: *equity must stay above $X*.
- **The Best Day rule.** The desks call it a day once a day's profit reaches **half the profit target** ($500 on a $10,000 account), even while training on FTMO, so no single day can be "too good" at the finish line. The trades already open run to their exits. If the target is reached while the best day is still over 50%, the floor doesn't stop at the target: it says how much more profit on other days passes the rule, and trades on at half risk until it's met.
- The Today card shows both loss lines, the Best Day share and the day's order actions in one line.

**Fast trades are allowed.** FTMO bans high-frequency and tick scalping (dozens of trades a minute, trades held for seconds), latency arbitrage, copying the same trades onto another FTMO account, and hedging one account against another. Ordinary scalping that holds for minutes is fine, and so are Expert Advisors. The floor's scalpers decide on 1-minute candles, cut a scalp that isn't working after 30 minutes and close every scalp by 45 minutes.

**Order actions.** FTMO allows 2,000 order actions a day (every open, close, stop move and partial close counts). The floor sends about 3 to 5 per trade, so a busy day is around a hundred. As a seatbelt it counts them per FTMO day (through restarts) and stops new trades at 1,000 and stop moves at 1,500; closing positions is always allowed.

**Always check FTMO's own Trading Objectives page and FAQ** for your program: their rules change, and they are what counts.

### The long run: every desk on 22 months of real prices

A few weeks of your own prices can't tell an edge from luck, so every trading desk was also replayed minute by minute through the floor's own code on Oanda's real 1-minute bars: July 2018 to mid-May 2020 (EURUSD and GBPUSD from January 2018), 15,296 trades in all with the desks' current rules (see *More setups* below). The replay includes the committee (whose market brain reads days of history, as on the floor), FTMO's costs and the desk's learning.

| Desk | Market | Trades | Per trade (90% range) | Quarters up | Verdict |
|---|---|---|---|---|---|
| Marcus | NAS100 | 865 | −0.08R (−0.14 to −0.02) | 1 of 8 | loses |
| Amara | XAUUSD | 1,999 | −0.14R (−0.18 to −0.10) | 0 of 8 | loses |
| James | SPX500 | 1,996 | −0.14R (−0.18 to −0.10) | 1 of 8 | loses |
| Priya | EURUSD | 1,279 | −0.23R (−0.28 to −0.18) | 0 of 10 | loses |
| Lucas | USOIL | 4,207 | −0.15R (−0.17 to −0.12) | 0 of 8 | loses |
| Jake | GBPUSD | 1,193 | −0.19R (−0.24 to −0.14) | 0 of 10 | loses |
| Layla | EURUSD | 1,242 | −0.17R (−0.22 to −0.13) | 1 of 10 | loses |
| Ryan | XAUUSD | 914 | −0.20R (−0.25 to −0.13) | 0 of 8 | loses |
| Mia | XAUUSD | 1,017 | −0.21R (−0.27 to −0.15) | 0 of 8 | loses |
| Nico | NAS100 | 584 | +0.03R (−0.04 to +0.10) | 4 of 8 | unclear |

The record ships with the floor (`server/research/baseline.json`), and the account brain uses it with the nightly review:

- **loses** (the whole 90% range below zero): paper only, in training too. The exception is a nightly review that finds a real edge on your own prices (its whole 90% range above zero); then the desk trades half size until that edge lasts. A few promising weeks aren't enough against thousands of losing trades.
- **no edge** or **unclear** (not significant either way, a hair below or above zero, like Nico): half size, until the nightly review says more.
- **No long-run record** (Sofia on USDJPY, Viktor and Chen on crypto, and the research desks): the nightly review decides, as before.
- Your own TradingView alerts are your call.

The desk table, the Today card (*Loses over the long run*), the account's rule list and the Nightly review card's **Long run** column show it.

**What it does to the account.** The account was replayed with every desk's trades in time order, 0.5% risk a trade, FTMO 1-Step $10,000:
- **Training as it ran:** −27.3% over the 22 months, with a 27.5% drawdown, past FTMO's 10% max loss. It wasn't stacked risk: the worst day was −0.9%. It was a steady bleed from desks that lose a little on every trade.
- **Rules that change almost nothing here:** one position per correlated group, a 1.5% open-risk cap, a −1.5% daily stop and 5 positions at most.
- **The committee's grade:** it didn't separate winners from losers (A −0.11R, B −0.10R, C −0.16R a trade, and only 2% of trades got an A or a B).
- **With the long-run record and the quarter size deep in drawdown:** +0.7%, with a 1.9% drawdown (only Nico, at half size, is left on the account).

To check that this isn't hindsight, the desks were judged on the first half only (to May 2019, where the same nine come out as losers). The account was then replayed on the second half, which the judging never saw: −9.9% with a 10.1% drawdown as it ran, +1.2% with a 1.5% drawdown with the record.

**What it doesn't do: make the desks profitable.** None of them has an edge on these markets. The research lab didn't find one either:
- **Its searches on the same 22 months:** 18,000 strategy ideas across the six markets. One passed every gate and lost money in the months after.
- **The published index intraday momentum effect:** not significant after costs here.

The protection stops the account paying for desks that lose. The desks keep trading on paper, and a desk that finds an edge on your own prices gets back on the account through the nightly review. Until a desk shows a real edge, don't pay for a challenge.

To rebuild the record from your own long history (a folder of `<SYMBOL>.json` 1-minute bars):

```bash
npm run baseline -- --dir path/to/history --source "where the bars came from"
```

It replays the desks in parallel (`--jobs 4`), about 12 minutes for 22 months, and writes `server/research/baseline.json`.

### More setups: looser entry rules, tested first

Each strategy's entry filters are settings now (`static RULES` in its file; a desk's `rules` in `server/engine/roster.js` override them), so a desk can be loosened to find more setups. Looser versions were replayed on the same 22 months. One was kept only if the desk got at least 10% more trades and its average per trade got no more than 0.03R worse. In other words, only if the extra trades are about as good as the ones it already took:

| Desk | Looser rule | Trades | Per trade |
|---|---|---|---|
| Marcus | ORB range 1–12 ATR (was 1.5–9), no volume filter | 775 → 865 | −0.082R → −0.083R |
| James | fades the ±1.5σ VWAP band (was 2σ), RSI ±12 (was ±18), ADX under 32 (was 28) | 1,154 → 1,996 | −0.115R → −0.140R |
| Priya | squeezes of 4 bars (was 6) | 918 → 1,279 | −0.214R → −0.235R |
| Jake | the 5- and 1-minute swings as liquidity too | 580 → 1,193 | −0.179R → −0.189R |
| Layla | the same | 687 → 1,242 | −0.146R → −0.174R |
| Ryan | the same, and London's killzone an hour longer (to 11:00 London) | 393 → 914 | −0.174R → −0.195R |
| Mia | the same, and New York's an hour longer (to 12:00 New York) | 364 → 1,017 | −0.190R → −0.211R |
| Nico | New York's killzone an hour longer (to 12:00 New York) | 505 → 584 | +0.004R → +0.028R |

Nico keeps his liquidity map. The wider one doubled his trades (1,022) but turned them slightly negative (−0.026R). He is the one desk the account still takes with practice off, so only the change that made him better was kept. Amara and Lucas keep their rules. Amara's looser sweeps added trades that lost about 0.29R each. Lucas already trades about 7 times a day, and a flatter trend filter added only 4% more trades, and worse ones. More scalps per killzone added nothing for any scalper. In all, the trading desks take about 32% more trades. Keep in mind that more trades from desks that lose means more losses, in proportion. On paper that costs nothing. On the Free Trial with practice on, it's a faster drift down. On a paid challenge these desks stay off the account until the evidence changes.

To try other values on your own history: `scripts/scalp-test.js` replays one desk with any profile, for example `replay({ profile: { ...desk, rules: { volume: 1.3 } }, bars })`.

### Ready for a paid challenge? `npm run edge`

```bash
cd ~/trading-floor && npm run edge
```

It answers the two questions that decide whether a challenge passes:

1. **Which desks make money on your market?** Every trading desk is replayed minute by minute through the floor's own code on the real 1-minute bars saved in `data/history/`, which are your MT5 broker's prices once MT5 prices a market. The replay includes the committee, FTMO's costs and the desk's learning. Each desk gets its trades, win rate, average R after costs with a 90% confidence range, and both halves of the history, then a verdict:
   - **EDGE:** the whole confidence range is above zero.
   - **promising:** positive in both halves, not proven yet.
   - **unclear** or **no edge.**
   - **too few trades to tell:** under 15.
2. **What are the chances of passing?** Thousands of FTMO challenges are played out with the trades of the desks that show an edge, under your program's rules (1-Step or 2-Step, from your FTMO setup) and the floor's loss guard, at 0.25% to 1.5% risk a trade. You get the pass rate, the fail rate and the typical days to pass. It ends with a plain verdict, and the result is saved to `data/edge-report.json`.

It takes a few minutes and only reads market data. The more history the floor has saved (keep it running with MT5 connected), the sharper it gets. `--desk nico` tests one desk; `--seeds 1` is faster.

**The floor runs it by itself every night, and acts on it.** After the New York close (17:00, when the desks are flat), or at the weekend, it runs this review in a background thread, so trading isn't slowed down. The first review runs about 10 minutes after the floor first starts. The verdicts decide who trades the account, while training on FTMO too:
- **no edge** on your prices: paper only until a later review finds one;
- **unclear:** half size;
- **EDGE** and **promising:** normal size;
- **too few trades to tell:** unchanged.

The latest review keeps deciding until a newer one replaces it, so a desk it took off the account never drifts back by itself. If the reviews stop (the Mac asleep after the close, a failing review), the card and the account's rule list say so after 4 days. A nightly review that fails is retried 30 minutes later, even once the evening window has passed (twice as long each time it fails again, up to 6 hours), and messages your phone, at most once a day. Your own TradingView alerts are your call. The summary goes to your phone with the daily report. Running `npm run edge` while the floor runs updates the floor's verdicts within a minute.

The FTMO tab's **Nightly review** card shows every desk's verdict and what it means on the account. It also shows the chance of passing at each risk size, with **Run now**. When desks have an edge and another risk size passes clearly more often than yours, there's a **Use X% risk** button.

**How to use it:** pay for a challenge only when the report shows desks with an edge passing most simulated challenges at a sensible risk, and the Free Trial confirms it over a couple of weeks with the same desks and the same risk. Trading more doesn't raise the pass rate. On the replays so far, all desks together averaged about −0.13R a trade, which passes a 1-Step challenge only 2–5% of the time at any risk. A desk with a real +0.4R edge passes about 99% of the time at 0.5% risk.

### Run it non-stop

```bash
npm run service -- install
```

That turns the floor into a background service on your Mac: it starts right away, starts again at every login, restarts by itself within 30 seconds if it ever stops, and keeps the Mac awake. It also adds MetaTrader 5 to your Login Items, so MT5 (with the EA on its chart) comes back after a restart too. After that you don't use `npm start`: the floor is always on at http://localhost:3000, and double-clicking **Start Trading Floor** just opens it.

Run every command from inside the floor's folder (`cd ~/Desktop/trading-floor` first; from anywhere else npm says *Could not read package.json*).

**The floor can't run as a service from your Desktop, Documents, Downloads or iCloud Drive:** macOS doesn't let background services read those folders, so the floor would never start and MT5 would have nothing to connect to. If the floor is in one of them, `install` moves it to your home folder (`~/trading-floor`, with its data, bridge token and track record) and leaves a link with the same name where it was, so the folder, **Start Trading Floor** and `cd ~/Desktop/trading-floor` work as before. Nothing changes in MT5: same address, same token.

| Command | What it does |
| --- | --- |
| `npm run service -- status` | Is it running, and is the floor answering? If not, it says why |
| `npm run service -- restart` | Restart it, e.g. after `git pull` (a service set up by an older version is set up again) |
| `npm run service -- logs` | The floor's latest output (kept in `data/logs/`) |
| `npm run service -- uninstall` | Stop it and remove the service |

To make it truly non-stop, once:

- **FTMO tab:** switch on **Stay armed after a restart**, so a restart doesn't leave it disarmed.
- **System Settings → Battery (or Energy) → Options:** turn on *Prevent automatic sleeping on power adapter when the display is off*, and on a desktop Mac *Start up automatically after a power failure*.
- **System Settings → Users & Groups:** automatic login, so the service starts after a reboot without anyone logging in (not available with FileVault on).
- **Software Update:** don't let macOS install updates by itself during the week; it restarts the Mac.
- **Telegram alerts** tell you if MT5 goes quiet (Mac asleep, MT5 closed, internet down) and when it's back.

A stop (uninstall, logging out, shutting down) closes the floor's FTMO positions on the way out, as Ctrl+C does.

**Battery and heat.** The trading itself is light: the floor's server uses about 1% of one CPU core most of the time. What drains a MacBook is drawing the 3D floor and MetaTrader 5.
- **Battery saver** (Settings → Graphics, on by default): the floor draws at most 30 frames a second while you use it and 15 when nobody touches it, instead of the display's 60 to 120. Nothing is drawn while another tab is open. The blinking lights stop, because each one kept the browser redrawing 60 times a second on every tab. On battery it drops to 24 and 6 frames a second and turns the shadows and glow off until the charger is back. The desks trade exactly the same.
- **Close the browser tab when you're not watching.** The floor trades without it. Only the floor (`npm start` or the service) and MT5 have to run, and Telegram tells you what happens.
- **MT5 on a Mac runs through a Windows layer and is heavy** (macOS lists it under *Using Significant Energy*). The MeridianBridge EA 1.2 does its part: MT5 syncs with the floor every 2 seconds when nothing is happening instead of twice a second, once a second while positions are open or a desk is about to trade, and twice a second only while orders go through. It re-reads the account history only after a trade, and redraws its chart comment only when something changes, not twice a second. Update it from the FTMO tab (*Put the update into MT5*, then *Compile* in MetaEditor). Also keep one chart open (the one with the EA) and minimise the window. Leave *Max bars in chart* at 100000 (Tools → Options → Charts): it's how far back MT5 can hand the floor your broker's history, and with one chart open it costs little. Untick *Enable news* (Tools → Options → Server).
- **macOS:** let the display sleep: the floor keeps the Mac awake but not the screen, and it trades on with the display off. Use Low Power Mode on battery (System Settings → Battery). For running all day, keep the MacBook on its charger, on a hard surface.

**Truly 24/7: a VPS.** A Mac at home still depends on your power, internet and macOS updates. For zero downtime, run MT5 and the floor on a Windows VPS near the broker's servers (from about $15–30 a month; FTMO allows it). Install Node.js and MT5 there, copy this folder, run `npm start` from a Task Scheduler task set to start at boot and restart on failure, and open the dashboard over Remote Desktop.

### Stay armed after a restart

A switch in the FTMO tab's Connection card, off until you switch it on. When it's on and the floor, the Mac or MT5 restarts while live trading is armed, the floor arms again by itself as soon as MT5 syncs, but only if every check that **Arm** makes still passes: the same account, live mode, MT5 connected with Algo Trading on, and no risk-guard stop. It never undoes your own decision: after **Disarm**, **Close all & disarm** or a risk-guard stop, it stays disarmed until you arm again yourself. The live log (and your phone, below) says when it re-armed.

### Today on the account: are they trading, and if not, why not?

The first card on the FTMO tab answers that in one sentence (while training on FTMO, trades are rarely held back: the card then mostly tells you what the desks are watching and when the busy hours start), for example *"No trades on FTMO yet today. Everything is connected and armed, and the desks are working: 3 trades were held back from the account, mostly: committee grade too low."* Below it:

- **The market hours in your own time:** where New York is now (the Asia session overnight is the quietest; the London open and the New York open are the busy windows), when those open in your time zone, and whether the scalpers' killzones are open.
- **The day's funnel, for the desks on the account:** trade ideas the desks found → turned down (by the committee, or by what a desk has learned) → paper trades → held back from the account → sent to FTMO.
- **Why trades stayed on paper today,** counted by reason, with what each reason means. The usual one: the committee grades every idea A, B or C, and only A and B-grade trades go to the account. A C ("not convinced") stays on paper, so the desk keeps measuring.
- **Every desk on the account:** what it's doing right now, its ideas, paper trades and FTMO trades today, and the latest reason it didn't trade the account.

The floor's desk rail shows the same in one line (*No trades on FTMO yet today. 1 held back (committee grade too low)*) with a button to the FTMO tab. Counts start at the beginning of the trading day (18:00 New York).

### Daily report card

The Dashboard shows a report card for each FTMO server day (the day FTMO's daily loss limit resets with), updated through the day and final once the day rolls over. It shows:

- **the account:** starting balance to equity, day P&L, daily and max loss used;
- **each desk switched on for the account:** its trades on FTMO, won and lost, P&L, average R, and how many of its trades stayed on paper, next to its paper trades that day;
- **why trades stayed on paper**, counted by reason (committee grade too low, a correlated position already open, max open positions, news blackout, desk not proven yet and so on), with the latest examples;
- **account events:** arming, disarming, risk-guard stops, MT5 dropping out and coming back, orders MT5 rejected.

Pick any earlier day from the list. Each day is saved in `data/reports/` (one JSON file per day), so you can compare days and see which strategies earn their place.

### Alerts on your phone (Telegram)

The FTMO tab's **Alerts on your phone** card sends Telegram messages from your own free bot:

- a trade opened on the account, **with a picture of the setup and why the desk took it**:
  - **The picture:** the chart the desk traded on, drawn TradingView style. It shows the last two hours of 1-minute candles, an arrow on the entry candle, and the long/short position tool (entry, the stop with its dollar risk, the target with its dollar gain and R). It also shows the desk's own setup levels in amber (the swept liquidity pool, the opening range, the Supertrend and so on) and the market's nearest support and resistance in grey.
  - **The caption:**
    - the desk's reason (*Why: London scalp: ran the Asia low, trapped and shifted*);
    - the evidence behind it (*The case: the higher-timeframe trend is up, with the trade; structure agrees*);
    - the checklist it ticked;
    - what the committee said (*Mia agrees · Lucas is cautious · Elena: Approved, full size*);
    - the floor's memory of trades like it;
    - a link that opens the market on TradingView.

  The floor draws the chart itself, from the same MT5 prices the desk traded on. It can't screenshot TradingView's own site: that needs your TradingView login and a browser running, and TradingView doesn't let programs draw on its charts. The pictures are also kept in `data/charts/` for two weeks, and the **📈 Setup** button next to the trade on the Dashboard and in the FTMO tab opens them. Drawing needs the small `@resvg/resvg-js` package, which `npm run service -- restart` (or Start Trading Floor) installs. Without it, the alert comes as text;
- a trade rejected by MT5;
- a trade closed, with its P&L to the cent and in R, then every trade closed on the account today, one per line, like MT5's history:

  ```
  ✅ Lucas closed USOIL.cash +$8.57 (+0.5R) · stop, target or manual on MT5

  Today on FTMO · 7 closed trades, 5 won:
  🟢 Lucas USOIL.cash +$10.11
  🔴 Chen ETHUSD -$1.01
  …
  🟢 Lucas USOIL.cash +$8.57
  Closed trades: +$34.51 · account today +$31.20 (with open trades)
  ```

  A trade's P&L is counted the way MT5 counts it: every deal of the position, the commission on the way in included. "Account today" also counts the trades still open.
- the daily report also lists the day's trades when the FTMO server day ends;
- the risk guard or profit target stopping trading;
- MT5 silent for a minute (Mac asleep, MT5 closed, internet down), and back again;
- armed, disarmed, re-armed after a restart;
- the day's report card when the FTMO server day ends.

Some brokers report a market order's fill price as 0. The floor then waits for the next sync, under 2 seconds later, and sends the position's real open price instead.

Setup takes about 2 minutes: in Telegram open **@BotFather**, send `/newbot` and pick a name. Paste the token it gives you into the card, press **Start** in your new bot, then **Find my chat** and **Send a test message**. Each kind of alert has its own switch. The bot token is kept in `data/telegram.json`, readable only by you, and is never sent back to the browser.

**Troubleshooting**

**Something won't connect? Run `npm run doctor`** in a second Terminal window while the floor runs. It checks:
- the floor itself;
- the dashboard's live feed;
- MT5 (including the exact reason it's being refused, such as a wrong bridge token);
- the TradingView address.

It then prints what to fix. It only reads; it never trades. The FTMO tab shows the same MT5 reason at the top, and the dashboard shows what to do when it loses the floor. After the floor restarts, open dashboard tabs reload themselves.

| MT5 shows… | Fix |
| --- | --- |
| "WebRequest is blocked" (error 4014) | Add `http://127.0.0.1:3000` under Tools → Options → Expert Advisors → Allow WebRequest |
| "Floor not reachable" | Start the floor (`npm start`). With the background service installed: `npm run service -- status` says why it isn't up (a floor in your Desktop can't run as a service: `npm run service -- install` moves it out). On a different port, set the EA's *Floor bridge URL* input to match. MT5 in a Windows VM or on another PC: set `HOST=0.0.0.0` in `.env` and use the Mac's address in the URL |
| "Invalid account" or "No connection" at the bottom right of MT5 | MT5 itself isn't logged in to FTMO, so the floor can't be either. Log in again (File → Login to Trade Account) with the login, password and server from FTMO's Client Area. A Free Trial ends after 14 days: start a new one there and log in with its details |
| "Floor refused the sync (HTTP 401)" | The bridge token is wrong: copy it again from the FTMO tab (it lives in `data/bridge-token.txt`) |
| The FTMO tab says "Algo Trading is off" | Turn on the Algo Trading toolbar button and tick *Allow Algo Trading* in the EA's settings |
| Can't drag the file into the Experts folder | Use the MetaEditor paste method or `npm run install-ea` (step 4 above) |
| A market shows "not mapped" | Pick the matching MT5 symbol in **Edit setup → Symbols on your account** |
| A desk says **NO PRICES** / the FTMO tab says "No real prices for …" | That market's live feed isn't answering (e.g. Yahoo HTTP 429) and nothing is simulated. Map it to your MT5 symbol in **Edit setup** and your broker's prices take over within seconds |

---

## Dashboard

The **Dashboard** tab follows the **FTMO / Paper** switch (in the top bar, or on the dashboard itself once an FTMO account is connected).

- **Daily report card** for any FTMO day (above).
- **FTMO account:** equity and balance, today's P&L (from the day's starting balance, FTMO's way), P&L since the start, open P&L and open risk, the floor's trades today and win rate, daily loss used and profit-target progress. Also the account equity curve, each desk's P&L on the account, a desk table with the live MT5 positions, FTMO rule meters, a blotter of the floor's trades on the account and a **Close all & disarm** button.
- **Paper fund:** NAV, day P&L, P&L since inception, unrealized P&L, gross exposure, trades and win rate, the fund equity curve, desk P&L bars, a desk table with sparklines, positions and flatten/pause buttons, loss-limit usage per desk, the trade blotter and floor-wide controls.
- Both show the **Quant Research Lab** (each researcher's market condition, strategy, unseen-data results and live record), the **economic calendar** with who is standing aside, the market board, received TradingView alerts and **what the desks have learned**.

---

## Security

The floor can trade a real account, so it's built like a small trading firm's network. Each layer holds even if another one fails.

**What's reachable from where**

| From | Can reach | Protection |
| --- | --- | --- |
| The internet | Only the TradingView webhook, through the tunnel | The webhook firewall (below) |
| Web pages in your browser | Nothing | Other sites can't read the page, so they never get the floor key |
| Devices on your Wi-Fi | Nothing, unless you set `HOST=0.0.0.0` | Then only the MT5 bridge (its token), and the dashboard only with `FLOOR_PASSWORD` |
| This Mac | The dashboard | Every request carries a floor key that changes each launch |

**The webhook firewall.** This is the only part of the floor on the internet. Every request passes through it in this order:
- Banned addresses are refused. Five wrong secrets from one address means a one-hour ban.
- Flood limits apply per address and overall.
- Bodies are small and treated as data only. Crafted fields are ignored.
- The secret is checked first, in constant time, before anything in the alert is looked at.
- Trade alerts are only accepted from **TradingView's own servers**. The addresses come from TradingView's published list; the tunnel reports the real sender, and outsiders can't fake it. Connection tests work from anywhere.
- If your correct secret arrives from anywhere else, it has leaked. The alert is refused, an alarm shows on the floor, and **Rotate webhook secret** issues a new one in one click.

The **Firewall** card in the TradingView tab shows all of this live, with the security log and the bans. The webhook listener only accepts connections from this Mac, where the tunnel app runs.

**The dashboard.** Every request is checked:
- **Floor key:** every API call and the live feed need the key, which only the dashboard page receives. Cross-site requests are refused, which stops a malicious web page from placing or closing trades.
- **Host check:** only localhost, 127.0.0.1 and this Mac's own names are accepted. This blocks DNS rebinding.
- **Page security headers:** a strict Content-Security-Policy (no inline or third-party scripts), no framing (blocks clickjacking), and no referrer.
- **TradingView chart:** it runs isolated on its own origin, so its code can never see your account.

**MT5 is the last line of defence.** The bridge EA (version 1.1) enforces its own limits, whatever the floor asks for:
- every order needs a stop-loss;
- risk per order is capped (**Max risk per order**, default 1% of balance);
- floor positions are capped (**Max floor positions**, default 8);
- a stop-loss can only be tightened, never removed;
- it only ever touches the floor's own positions, never your manual trades.

While MT5 runs an older EA, the FTMO tab shows an **Update the MT5 bridge EA** box:
1. **Put the update into MT5** copies the new EA into MT5's Expert Advisors folder on this Mac.
2. In MT5's Navigator, right-click **MeridianBridge → Modify**.
3. Press **Compile** in MetaEditor.

MT5 reloads the EA on the chart with your token, and the box turns green. If MT5 runs in Parallels or on another PC, use **Copy EA code** and paste it in MetaEditor instead.

**Secrets:**
- Your FTMO password never leaves MT5.
- The webhook secret, bridge token, account setup and track record live in `data/`. That folder is readable by your macOS user only (0700/0600), and git never commits it.
- The terminal shows only the first characters of the webhook secret.
- The cloudflared download is checked against the SHA-256 checksum published for that release. A mismatched file is deleted and never run.

**What you should do**

- Keep **Trade alerts only from TradingView's servers** on.
- Turn on two-factor authentication for TradingView and FTMO.
- Never share your alert message: it contains the webhook secret. If you think it leaked, rotate it.
- Use `HOST=0.0.0.0` only on your home Wi-Fi, with a strong `FLOOR_PASSWORD`. Wi-Fi access is plain HTTP, so it isn't meant for public networks.
- Keep macOS updated, turn on FileVault (encrypts `data/` on disk) and lock your screen.

`npm test` includes the attacks themselves:
- cross-site trade requests;
- WebSocket hijacking;
- DNS rebinding;
- brute-forced and leaked secrets;
- crafted alerts and oversized bodies;
- a tampered cloudflared download.

Every one of them is refused.

## Configuration

Copy `.env.example` to `.env`. The most useful settings:

| Variable | Default | What it does |
| --- | --- | --- |
| `FEED` | `live` | `live` or `sim` |
| `SIM_SPEED` | `20` | Simulation speed (market seconds per real second) |
| `PORT` / `WEBHOOK_PORT` / `WIDGET_PORT` | `3000` / `3001` / `3002` | Dashboard, webhook-only port (this Mac only, for the tunnel), isolated TradingView chart |
| `HOST` | `127.0.0.1` | Set `0.0.0.0` when MT5 runs in a Windows VM (Parallels) or on another PC: the MT5 bridge becomes reachable on your network (token required) and the dashboard stays on this Mac. Add `FLOOR_PASSWORD` to also open the dashboard from an iPad |
| `FLOOR_PASSWORD` | — | Password for other devices on your Wi-Fi (at least 10 characters). This Mac never needs it |
| `ALLOWED_HOSTS` | — | Extra host names allowed to open the dashboard (comma-separated), e.g. a custom local DNS name |
| `WEBHOOK_SECRET` | auto | TradingView webhook secret (auto: random, in `data/webhook-secret.txt`, rotatable from the TradingView tab) |
| `STARTING_CAPITAL` | `100000000` | Fund size, split evenly across the 20 desks |
| `KEEP_AWAKE` | `1` | macOS: keep the Mac awake while the floor runs (`0` turns it off) |
| `RISK_PER_TRADE_PCT`, `DESK_DAILY_LOSS_PCT`, `FUND_DAILY_LOSS_PCT`, `MAX_LEVERAGE` | 0.5 / 2 / 1.2 / 4 | Risk framework |
| `VAULT_DIR` | `data/vault` | Where the Obsidian vault is written, e.g. `~/Documents/Meridian Vault` (demo mode always uses `data/vault-demo`) |
| `VAULT` | `1` | `0` turns the Obsidian vault off |

Other commands:

```bash
npm test               # tests: indicators, broker, risk, webhooks, FTMO, news calendar, backtester (no look-ahead),
                       # research validation (rejects pure noise), research desks, committee + account brain,
                       # a full floor session
npm run doctor         # checks every connection (floor, dashboard, MT5, TradingView) and says what to fix
npm run service -- install  # run the floor non-stop as a background service (status / restart / logs / uninstall)
npm run mock-mt5       # pretend FTMO MT5 terminal for trying the live flow (MOCK_PNL=-100 rehearses a drawdown)
npm run install-ea     # copy the MT5 bridge EA into MetaTrader 5 on this Mac
npm run backtest -- 5  # fast-forward 5 simulated sessions (news + research lab included) and print each desk's results
npm run scalp-test     # replay the Scalping Desk on the real 1-minute bars saved in data/history
npm run edge           # every desk on your saved history: who has an edge, and the odds of passing a challenge
npm run baseline -- --dir path/to/history   # every desk on months of real 1-minute bars: the long-run record the floor ships with
npm run weekend -- --dir path/to/crypto     # every switching desk on real crypto weekends: the weekend record
npm run brain -- --dir path/to/history      # train and test the neural brain on long history
npm run reset          # wipe the saved track record (keeps your webhook secret)
```

## How it's built

```
server/
  index.js              Express + WebSocket server, webhook-only listener, persistence
  market/               Binance + Yahoo live feeds, regime-switching simulator, 1-min bars,
                        indicators, New York session clock, calendar.js (economic news)
  engine/               paper broker, risk manager (CRO), agent base class,
                        11 strategies incl. research desks, fund orchestration, learning.js
  research/             strategy grammar, backtester, walk-forward validation search,
                        long history store, research lab (worker thread)
  brain/                market brain (shared analysis), personas (each agent's own brain),
                        committee (department debates, vetoes, grades, live thoughts)
  tradingview/          alert parsing + authentication, one-click public address (tunnel)
  live/                 MT5 bridge protocol, FTMO rules + guard, account brain, live execution router
  voices/               realistic voices: Kokoro text-to-speech in a worker thread
mt5/                    MeridianBridge.mq5 Expert Advisor for MetaTrader 5
public/
  js/floor/             Three.js floor: room, desks, six-screen workstations,
                        animated traders (avatar/: head, hair, body, IK), video wall, camera
  js/ui/                HUD, trader panel + briefing + learning + research + brain, dashboard,
                        Brain view (live department graphs), economic calendar, TradingView, FTMO
  js/voice.js           voices: realistic (from the server) or system, lip-sync level
tradingview/            Pine Script alert bridge
```

No build step. The server serves ES modules straight to the browser (Three.js, TradingView Lightweight Charts). Everything runs locally, and the track record persists in `data/`.

---

TradingView and Lightweight Charts are trademarks of TradingView, Inc. FTMO is a trademark of FTMO. MetaTrader is a trademark of MetaQuotes. This project is not affiliated with TradingView, FTMO, MetaQuotes, Binance or Yahoo. Market data from free public endpoints may be delayed or unavailable.
