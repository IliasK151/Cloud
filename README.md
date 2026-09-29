# Meridian Trading Floor

A 3D institutional trading floor that runs in your browser, served by a small server on your Mac. Ten AI trading agents each run their own desk and day-trade like an institutional book. You watch them live at their multi-monitor workstations, click one to zoom in, and they turn around and say **"Hello boss!"**, then walk you through their current setup and P&L out loud.

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

3. Your browser opens **http://localhost:3000**. That's the floor.

Prefer double-clicking? Use **`start.command`** (live) or **`start-demo.command`** (simulation) in Finder. They install dependencies on the first run and then start the server. Stop the server with `Ctrl+C`. The desks flatten and the track record is saved to `data/`.

### Live vs demo

| | `npm start` (live) | `npm run demo` (simulation) |
| --- | --- | --- |
| Crypto (BTC, ETH, SOL) | Binance public market data, real time | Simulated |
| Index futures, gold, oil, FX | Yahoo Finance 1-minute bars (NQ, ES, GC, CL, EURUSD, USDJPY) | Simulated |
| Clock | Real time; desks go flat 16:50–18:00 New York | 20× accelerated New York session, 09:30–16:00, then the next day |
| Best for | Watching the agents trade the real market | Non-stop action, weekends, offline |

If a live source can't be reached, that market automatically falls back to a real-time simulation. Every price is labelled `LIVE`, `DELAYED`, `CLOSED` or `SIM`, so you always know what you're looking at. Futures and FX desks go quiet on weekends in live mode, while crypto trades 24/7.

---

## The floor

- **10 desks in two tiers**, each with a six-screen workstation. The screens are live: a TradingView-style chart with the desk's entry, stop and target drawn as a position box, the book and setup checklist, a DOM ladder with time & sales, a Bloomberg-style terminal with the desk's log, the intraday P&L curve, and market watch.
- **A hanging sign over every desk** shows its live day P&L. A status tag over each trader shows `SCANNING`, `ARMED`, `IN TRADE`, `COOLDOWN` or `HALTED`.
- **The front wall** carries the LED video wall (NAV, day P&L, fund equity, desk P&L bars, markets), world clocks, and scrolling ticker tapes. Night-time city skyline windows run down both sides.
- **The traders are animated.** They type, glance between screens, fist-pump a winner, facepalm a loser and slump when risk halts them. When they trade, a speech bubble pops up over their head.

**Controls:** click a trader, or press keys `1`–`0`, to zoom in. Drag to orbit, scroll to zoom, right-drag to pan. `←`/`→` moves to the next trader, and `Esc` returns to the overview. `D` opens the dashboard, `T` the TradingView page, `L` the FTMO tab, `F` the floor. `V` toggles voices and `Q` toggles glow effects.

### "Hello boss!"

Selecting a trader flies the camera to their desk. They swivel their chair toward you, wave, and give a live briefing: their strategy, the current setup and key levels, any open position with stop, target and R-multiple, and their P&L for the day and since inception. The briefing is spoken using your Mac's built-in voices, and each trader has their own voice. The side panel shows the full setup checklist, levels, positions, performance, a live chart, the real **TradingView** chart for their market, and their trade history. From the panel you can also **flatten** or **pause** the desk.

---

## The ten desks

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

### Institutional risk framework

- A **$100M fund** with $10M allocated to each desk. Every trade is sized so that a stop-out costs **0.5% of the desk's allocation**, capped at **4× leverage**.
- **Trade management:** half the position is taken off at +1R and the stop moves to breakeven. After that the runner is trailed with an ATR chandelier stop, and some strategies use time stops.
- **Desk daily loss limit (2%):** when it's hit, the CRO flattens and halts the desk until the next trading day.
- **Fund daily loss limit (1.2% of NAV):** when it's hit, the whole floor goes risk-off.
- Other controls: cooldown bars after a loss, daily trade caps, and every desk flat into the close. Execution is modelled with spreads, slippage, commissions and maker rebates. USDJPY P&L is converted from yen.

All limits are configurable in `.env` (copy `.env.example`).

---

## TradingView integration

1. **Charts.** Every trader's panel has a **TradingView** tab with the official TradingView Advanced Chart for their market (for example `OANDA:XAUUSD` or `BINANCE:BTCUSDT`), plus an "Open on TradingView" link. The floor's own charts are drawn with TradingView Lightweight Charts™.
2. **Alerts → orders.** TradingView alerts can be sent to any desk through a webhook. The in-app **TradingView** tab walks you through it and generates the alert message for you:

   ```bash
   brew install cloudflared
   cloudflared tunnel --url http://localhost:3001     # webhook-only port, never the dashboard
   ```

   In TradingView, set the alert's **Webhook URL** to `https://<your-tunnel>.trycloudflare.com/webhook` and put this in the **Message** box:

   ```json
   {"secret":"<your secret>","agent":"amara","symbol":"{{ticker}}","action":"buy","price":{{close}}}
   ```

   - `action`: `buy` / `sell` / `close`. Strategy alerts also work with `"action":"{{strategy.order.action}}","position":"{{strategy.market_position}}"`.
   - Optional fields: `stop`, `target` and `comment`. Without them the desk uses a 1.5 ATR stop and a 2R target, sized by the risk desk.
   - `agent` picks the desk (`marcus`, `sofia`, `kenji`, `amara`, `viktor`, `isabella`, `james`, `priya`, `lucas`, `chen`). Without it, the alert goes to Chen's TradingView Signals desk.
   - Tickers such as `OANDA:XAUUSD`, `NQ1!`, `BINANCE:BTCUSDT` and `ES1!` are mapped automatically.
   - The secret is created on first run in `data/webhook-secret.txt`, or you can set `WEBHOOK_SECRET` yourself. Alerts with a wrong secret are rejected, and the endpoint is rate-limited.
3. **Pine Script bridge.** [`tradingview/institutional_agents_alerts.pine`](tradingview/institutional_agents_alerts.pine) is a ready-made indicator that sends Supertrend-flip alerts with stop and target levels to the desk you choose.

Webhook alerts need a TradingView plan that includes webhooks. You can try the whole pipeline without TradingView using **Send test alert** on the TradingView tab.

![TradingView tab](docs/tradingview.jpg)

---

## Trade your FTMO account (MetaTrader 5)

The desks can trade your **FTMO Free Trial, Challenge, Verification or FTMO Account** through MetaTrader 5. A small Expert Advisor, [`mt5/MeridianBridge.mq5`](mt5/MeridianBridge.mq5), runs inside your MT5 terminal and links it to the floor on the same Mac. Your FTMO password stays in MT5; the floor never sees it.

![FTMO tab](docs/ftmo.jpg)

**How it works**

- **The floor stays the brain.** When a desk you've enabled opens, scales out, moves its stop or closes a trade, the same action is sent to MT5.
- **Every order carries a stop-loss.** Positions stay protected in MT5 even if the floor, the EA or your Mac stops.
- **Your own risk sizing, not the paper desk's.** The default is **0.25% of balance per trade**, with at most 1.5% open risk and 5 live positions, all editable.
- **Priced from MT5.** Once connected, the floor switches each mapped market to your broker's prices (US100.cash, XAUUSD, EURUSD and so on). The desks then analyse exactly the prices they trade.
- **Your TradingView alerts can trade the account too.** Enable Chen's TradingView Signals desk (or any desk named in the alert). Each alert is executed on FTMO with the same sizing and stop rules.
- **FTMO rule guard.** It watches the daily and maximum loss using FTMO's method (equity against the day's starting balance, and against the account size). At 80% of a limit it closes the floor's positions and stops trading: until the next server day for the daily limit, and until you clear it for the max loss. It can also stop when the profit target is hit, which is on by default.
- **Arming is always your decision.** The floor starts disarmed after every restart. Paid accounts need you to type the account number to arm. **Close all & disarm** is always one click away.
- **Two desks stay paper-only.** The stat-arb and market-making desks don't mirror onto a single prop account.

**Set it up (once, about 5 minutes)**

1. Start the floor with `npm start` (live mode; demo mode never trades live).
2. In the FTMO Client Area, start a **Free Trial** on **MetaTrader 5**. Install MT5 and log in with the credentials FTMO shows you.
3. In MT5, go to **Tools → Options → Expert Advisors**. Tick **Allow algorithmic trading** and **Allow WebRequest for listed URL**, then add `http://127.0.0.1:3000`.
4. Install the **MeridianBridge** Expert Advisor. On a Mac, MT5's folders usually don't accept drag-and-drop from Finder, so use one of these:
   - **MetaEditor (easiest):** in MT5 press **F4**, then **File → New → Expert Advisor (template)** and name it `MeridianBridge`. Delete the template code, click **Copy EA code** in the floor's FTMO tab, paste it in (Cmd+V, or Ctrl+V / right-click → Paste) and press **Compile**.
   - **One command:** quit MT5 and run `npm run install-ea` in the trading-floor folder. It finds MT5's hidden `MQL5/Experts` folder and copies the file in. Reopen MT5, right-click **Expert Advisors → Refresh** in the Navigator, then right-click MeridianBridge → **Modify** → **Compile**.
5. Drag **MeridianBridge** onto any chart. Paste the **bridge token** from the FTMO tab into the inputs, tick **Allow Algo Trading**, and switch on **Algo Trading** in the toolbar.
6. The floor pops up **"New FTMO account detected"**. Pick the account type (Free Trial, Challenge, Verification or FTMO Account), check the limits against your Client Area, and save.
7. Switch on the desks that may trade the account, then press **Arm live trading**.

![New FTMO account detected](docs/ftmo-connect.jpg)

**No MT5 handy?** Run `npm run mock-mt5` next to `npm start`. It pretends to be an FTMO Free Trial terminal, so you can try the whole connect → set up → arm → trade flow.

**Before you arm a paid Challenge, read this**

- Run it on the **Free Trial** first and watch it for a few days. The strategies were built and tuned on simulated markets and have no real-money track record.
- **Check FTMO's current rules on algorithmic trading yourself.** FTMO generally allows Expert Advisors but prohibits some trading practices, and their terms change. Complying with them on your account is your responsibility.
- **A stop-loss is not a guarantee.** Gaps, news spikes and slippage can fill beyond it. The guard acts at 80% of each limit to leave a buffer, but it cannot promise you'll never breach one. FTMO's funded accounts also have news-trading restrictions, which the floor doesn't track.
- MT5 must stay open, and your Mac awake, while the desks trade.

**Troubleshooting**

| MT5 shows… | Fix |
| --- | --- |
| "WebRequest is blocked" (error 4014) | Add `http://127.0.0.1:3000` under Tools → Options → Expert Advisors → Allow WebRequest |
| "Floor not reachable" | Start the floor (`npm start`). On a different port, set the EA's *Floor bridge URL* input to match |
| "Floor refused the sync (HTTP 401)" | The bridge token is wrong: copy it again from the FTMO tab (it lives in `data/bridge-token.txt`) |
| The FTMO tab says "Algo Trading is off" | Turn on the Algo Trading toolbar button and tick *Allow Algo Trading* in the EA's settings |
| Can't drag the file into the Experts folder | Use the MetaEditor paste method or `npm run install-ea` (step 4 above) |
| A market shows "not mapped" | Pick the matching MT5 symbol in **Edit setup → Symbols on your account** |

---

## Dashboard

The **Dashboard** tab shows:

- NAV, day P&L, P&L since inception, unrealized P&L, gross exposure, trades and win rate
- The fund equity curve and desk P&L bars
- A desk table with sparklines, positions and flatten/pause buttons
- Loss-limit usage per desk, the market board with feed status, the trade blotter, floor-wide controls and received TradingView alerts

---

## Configuration

Copy `.env.example` to `.env`. The most useful settings:

| Variable | Default | What it does |
| --- | --- | --- |
| `FEED` | `live` | `live` or `sim` |
| `SIM_SPEED` | `20` | Simulation speed (market seconds per real second) |
| `PORT` / `WEBHOOK_PORT` | `3000` / `3001` | Dashboard port and webhook-only port |
| `HOST` | `127.0.0.1` | Set `0.0.0.0` to open the floor from an iPad on your Wi-Fi |
| `WEBHOOK_SECRET` | auto | TradingView webhook secret |
| `STARTING_CAPITAL` | `100000000` | Fund size, split evenly across the 10 desks |
| `RISK_PER_TRADE_PCT`, `DESK_DAILY_LOSS_PCT`, `FUND_DAILY_LOSS_PCT`, `MAX_LEVERAGE` | 0.5 / 2 / 1.2 / 4 | Risk framework |

Other commands:

```bash
npm test               # unit tests: indicators, broker, risk, webhooks, FTMO bridge + guard, a full simulated session
npm run mock-mt5       # pretend FTMO MT5 terminal for trying the live flow
npm run install-ea     # copy the MT5 bridge EA into MetaTrader 5 on this Mac
npm run backtest -- 5  # fast-forward 5 simulated sessions and print each desk's results
npm run reset          # wipe the saved track record (keeps your webhook secret)
```

## How it's built

```
server/
  index.js              Express + WebSocket server, webhook-only listener, persistence
  market/               Binance + Yahoo live feeds, regime-switching simulator, 1-min bars,
                        indicators, New York session clock
  engine/               paper broker, risk manager (CRO), agent base class,
                        10 strategies, fund orchestration
  tradingview/          alert parsing + authentication
  live/                 MT5 bridge protocol, FTMO rules + guard, live execution router
mt5/                    MeridianBridge.mq5 Expert Advisor for MetaTrader 5
public/
  js/floor/             Three.js floor: room, desks, six-screen workstations,
                        animated traders, video wall, camera director
  js/ui/                HUD, trader panel + voice briefing, dashboard, TradingView page
tradingview/            Pine Script alert bridge
```

No build step. The server serves ES modules straight to the browser (Three.js, TradingView Lightweight Charts). Everything runs locally, and the track record persists in `data/`.

---

TradingView and Lightweight Charts are trademarks of TradingView, Inc. FTMO is a trademark of FTMO. MetaTrader is a trademark of MetaQuotes. This project is not affiliated with TradingView, FTMO, MetaQuotes, Binance or Yahoo. Market data from free public endpoints may be delayed or unavailable.
