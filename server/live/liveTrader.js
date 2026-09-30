import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ACCOUNT_TYPES, DEFAULTS, normalizeProfile, guardMetrics, lotsForRisk, positionRisk } from './rules.js';
import { autoMap, candidatesFor } from './symbolMap.js';
import { SYMBOL_IDS } from '../market/symbols.js';
import { fmtUsd } from '../util/format.js';

export const MAGIC_BASE = 771000;
const ENTRY_WINDOW_MS = 90_000; // never chase a desk's paper entry older than this
const MISSING_SYNCS_TO_CLOSE = 3;

// Desks whose trades can't be mirrored 1:1 onto a single prop account.
const INELIGIBLE = {
  kenji: 'Pairs trades need two hedged legs without a single stop-loss — paper only.',
  isabella: 'Market making relies on passive maker fills an FTMO account can’t reproduce — paper only.',
};

// Mirrors the floor's paper desks onto a real MT5 account (e.g. FTMO) through the bridge EA.
// Paper stays the "brain": when an enabled desk opens, scales out, trails or closes a trade,
// the same action is sent to MT5 with lots sized for the prop account's risk rules.
export class LiveTrader extends EventEmitter {
  constructor({ fund, md, bridge, clock, mode, dataDir, token, log = console }) {
    super();
    this.fund = fund;
    this.md = md;
    this.bridge = bridge;
    this.clock = clock;
    this.mode = mode;
    this.token = token;
    this.log = log;
    this.file = path.join(dataDir, 'live.json');
    this.state = this.#load();
    this.sessionId = crypto.randomBytes(3).toString('hex');
    this.armed = false;
    this.armedAt = null;
    this.events = [];
    this.links = new Map((this.state.links || []).map((l) => [l.key, { ...l, previousSession: true }]));
    this.agentIndex = new Map(fund.agents.map((a, i) => [a.id, i + 1]));

    bridge.on('account', (acc) => this.#onAccount(acc));
    bridge.on('ack', (ack) => this.#onAck(ack));
    bridge.on('history', (sym, bars) => this.#onHistory(sym, bars));
    bridge.on('sync', () => this.#onSync());
    fund.broker.on('fill', () => setImmediate(() => this.reconcile()));
    fund.env.liveDescribe = (id) => this.describeFor(id);
    fund.env.liveBook = (id) => (this.profile && this.account ? this.deskBook(id) : null);
    // A data-feed switch shifts the desks' paper levels; keep the live stop mapping aligned.
    md.on('rebase', (symbol, offset) => {
      for (const l of this.links.values()) if (l.floorSymbol === symbol && !l.previousSession && Number.isFinite(l.paperEntry)) l.paperEntry += offset;
    });
    this.equityHistory = [];
    this.timer = setInterval(() => this.tick(), 1000);
  }

  // ---- persistence ---------------------------------------------------------------------
  #load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return { profiles: {}, links: [], halts: {} };
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const links = [...this.links.values()].slice(-200).map(({ previousSession, ...l }) => l);
      const data = { profiles: this.state.profiles, halts: this.state.halts, links };
      try {
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(data, null, 1));
        fs.renameSync(`${this.file}.tmp`, this.file);
      } catch (err) {
        this.log.warn?.(`[live] save failed: ${err.message}`);
      }
    }, 200);
  }

  // ---- accessors --------------------------------------------------------------------------
  get account() {
    return this.bridge.account;
  }

  get login() {
    return this.account ? String(this.account.login) : null;
  }

  get profile() {
    return this.login ? this.state.profiles[this.login] || null : null;
  }

  get halt() {
    return this.login ? this.state.halts?.[this.login] || null : null;
  }

  eligible(agentId) {
    return !INELIGIBLE[agentId];
  }

  magicFor(agentId) {
    return MAGIC_BASE + (this.agentIndex.get(agentId) || 0);
  }

  agentForMagic(magic) {
    const idx = magic - MAGIC_BASE;
    return this.fund.agents[idx - 1]?.id ?? null;
  }

  #ours(pos) {
    return pos.magic > MAGIC_BASE && pos.magic <= MAGIC_BASE + 99;
  }

  #note(text, kind = 'live', agentId = null) {
    const ev = { time: Date.now(), text, kind, agentId };
    this.events.push(ev);
    if (this.events.length > 120) this.events.shift();
    // The floor tape already prints the trader's name, so drop it from the start of the line.
    const first = agentId ? this.fund.byId.get(agentId)?.profile.name.split(' ')[0] : null;
    const floorText = first && text.startsWith(`${first} `) ? text.slice(first.length + 1) : text;
    this.fund.pushEvent({ agentId, kind: 'live', text: `FTMO · ${floorText}` });
    this.emit('change');
  }

  // ---- setup & controls -----------------------------------------------------------------
  #onAccount(acc) {
    this.armed = false;
    this.equityHistory = [];
    const known = !!this.state.profiles[String(acc.login)];
    this.#note(`MT5 connected: account ${acc.login} on ${acc.server}${known ? '' : ' — new account, set it up in the FTMO tab'}`);
    this.bridge.requestSymbols();
  }

  setup(body = {}) {
    if (!this.account) return { ok: false, error: 'No MT5 account connected yet' };
    const prev = this.profile;
    const profile = normalizeProfile(body, this.account);
    const suggested = autoMap(this.bridge.symbols);
    const symbolMap = {};
    for (const id of SYMBOL_IDS) {
      const wanted = body.symbolMap?.[id];
      if (wanted === '' || wanted === null) symbolMap[id] = null;
      else if (wanted && (this.bridge.symbols.includes(wanted) || !this.bridge.symbols.length)) symbolMap[id] = wanted;
      else symbolMap[id] = prev?.symbolMap?.[id] ?? suggested[id] ?? null;
    }
    this.state.profiles[this.login] = {
      ...profile,
      symbolMap,
      desks: prev?.desks || {},
      server: this.account.server,
      createdAt: prev?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    this.save();
    this.#note(`${prev ? 'Updated' : 'Saved'} setup for ${ACCOUNT_TYPES[profile.type].label} ${this.login} (${fmtUsd(profile.size)})`);
    return { ok: true };
  }

  setDesk(agentId, enabled) {
    const p = this.profile;
    if (!p) return { ok: false, error: 'Set up the account first' };
    if (!this.fund.byId.has(agentId)) return { ok: false, error: 'Unknown desk' };
    if (enabled && !this.eligible(agentId)) return { ok: false, error: INELIGIBLE[agentId] };
    p.desks[agentId] = !!enabled;
    this.save();
    const name = this.fund.byId.get(agentId).profile.name;
    this.#note(`${name} ${enabled ? 'may now trade' : 'no longer trades'} the FTMO account`, 'live', agentId);
    return { ok: true };
  }

  arm({ confirm } = {}) {
    const acc = this.account;
    const p = this.profile;
    if (this.mode !== 'live') return { ok: false, error: 'Live execution needs live market data. Restart with npm start (not npm run demo).' };
    if (!this.bridge.connected || !acc) return { ok: false, error: 'MT5 bridge is not connected' };
    if (!p) return { ok: false, error: 'Set up the account first' };
    if (this.halt) return { ok: false, error: `Trading is halted: ${this.halt.reason}` };
    if (acc.connected === false) return { ok: false, error: 'MT5 is not connected to its trade server. Log in again in MT5 (File → Login to Trade Account).' };
    if (!acc.tradeAllowed || !acc.expertAllowed) return { ok: false, error: 'This MT5 account does not allow (automated) trading right now.' };
    if (!acc.algoAllowed) return { ok: false, error: 'Algo Trading is off in MT5. Turn on the "Algo Trading" button and tick "Allow Algo Trading" in the EA settings.' };
    if (!Object.values(p.desks).some(Boolean)) return { ok: false, error: 'Enable at least one desk first' };
    if (p.type !== 'trial' && String(confirm ?? '').trim() !== this.login) {
      return { ok: false, error: `Type the account number ${this.login} to confirm live trading on a ${ACCOUNT_TYPES[p.type].label}` };
    }
    this.armed = true;
    this.armedAt = Date.now();
    this.#note(`ARMED — desks now trade ${ACCOUNT_TYPES[p.type].label} ${this.login}`, 'risk');
    return { ok: true };
  }

  disarm(reason = 'Disarmed by the boss') {
    if (!this.armed) return { ok: true };
    this.armed = false;
    this.#note(`DISARMED — ${reason}. Open FTMO positions keep their stop-loss.`, 'risk');
    return { ok: true };
  }

  kill() {
    this.armed = false;
    if (!this.bridge.connected) return { ok: false, error: 'MT5 bridge is not connected' };
    this.bridge.closeAll({ kind: 'kill' });
    for (const l of this.links.values()) if (l.state === 'open' || l.state === 'pending') l.state = 'closing';
    this.#note('KILL SWITCH — closing every floor position on the FTMO account and disarming', 'risk');
    return { ok: true };
  }

  closeTicket(ticket) {
    if (!this.bridge.connected) return { ok: false, error: 'MT5 bridge is not connected' };
    this.bridge.close(Number(ticket), 1, { manual: true, ticket: Number(ticket) });
    this.#note(`Closing position #${ticket} on request`);
    return { ok: true };
  }

  resetHalt() {
    if (!this.halt) return { ok: true };
    delete this.state.halts[this.login];
    this.save();
    this.#note('Halt cleared by the boss (still disarmed — arm again when ready)', 'risk');
    return { ok: true };
  }

  // ---- bridge events -----------------------------------------------------------------------
  #onAck(ack) {
    const meta = ack.meta || {};
    const link = meta.linkKey ? this.links.get(meta.linkKey) : null;
    if (ack.kind === 'open' && link) {
      if (ack.ok) {
        link.state = 'open';
        link.ticket = ack.ticket;
        link.liveEntry = ack.price || link.liveEntry;
        if (ack.volume) link.volume0 = link.volumeNow = ack.volume;
        this.#note(`${this.#who(link)} filled ${link.side} ${link.volume0} ${link.brokerSymbol} @ ${ack.price}`, 'live', link.agentId);
      } else {
        link.state = 'failed';
        link.reason = ack.msg;
        this.#note(`${this.#who(link)} order rejected by MT5: ${ack.msg}`, 'risk', link.agentId);
      }
      this.save();
    } else if (ack.kind === 'close' && !ack.ok && link) {
      if (!meta.partial && link.state === 'closing') {
        link.state = 'open'; // try again shortly (e.g. market was closed)
        link.retryAt = Date.now() + 30_000;
      }
      this.#note(`${this.#who(link)} close failed on MT5: ${ack.msg}`, 'risk', link.agentId);
    } else if (ack.kind === 'modify' && link) {
      if (ack.ok) link.sl = ack.price;
      else link.modifyFailures = (link.modifyFailures || 0) + 1;
    } else if (ack.kind === 'closeall') {
      this.#note(`Close-all on MT5: ${ack.msg}`, ack.ok ? 'live' : 'risk');
    }
    this.emit('change');
  }

  #who(link) {
    return this.fund.byId.get(link.agentId)?.profile.name.split(' ')[0] ?? link.agentId;
  }

  #mappedFloorIds(brokerSymbol) {
    const map = this.profile?.symbolMap || {};
    return Object.keys(map).filter((id) => map[id] === brokerSymbol);
  }

  // The broker's own 1-minute history replaces the public feed for that instrument.
  #onHistory(brokerSymbol, bars) {
    if (this.mode !== 'live' || bars.length < 30) return;
    for (const id of this.#mappedFloorIds(brokerSymbol)) {
      this.md.claim(id, 'mt5', bars, 'LIVE');
      this.#note(`${id} is now priced from your broker feed (${brokerSymbol})`);
    }
  }

  #onSync() {
    const p = this.profile;
    const map = p?.symbolMap || autoMap(this.bridge.symbols);
    this.bridge.watch(Object.values(map).filter(Boolean));
    if (!p) return this.emit('change');

    // Market data from MT5
    if (this.mode === 'live') {
      for (const [id, brokerSym] of Object.entries(p.symbolMap)) {
        if (!brokerSym) continue;
        if (this.md.ownerOf(id) !== 'mt5') {
          this.bridge.requestHistory(brokerSym, 600);
          continue;
        }
        const q = this.bridge.quotes[brokerSym];
        if (!q?.bars) continue;
        for (const bar of this.bridge.toBars(q.bars)) this.md.applyBar(id, bar, { source: 'mt5' });
        this.md.setStatus(id, 'LIVE', 'ftmo');
      }
    }

    // Track our live positions
    const positions = this.bridge.positions;
    const byTicket = new Map(positions.map((x) => [x.ticket, x]));
    const byComment = new Map(positions.map((x) => [x.comment, x]));
    for (const link of this.links.values()) {
      if (!['open', 'pending', 'closing'].includes(link.state)) continue;
      const pos = byTicket.get(link.ticket) || byComment.get(link.comment);
      if (pos) {
        if (link.state === 'pending') link.state = 'open';
        link.ticket = pos.ticket;
        link.volumeNow = pos.volume;
        link.sl = pos.sl;
        link.tp = pos.tp;
        link.liveEntry = pos.open;
        link.profit = pos.profit;
        link.missing = 0;
      } else if (link.state !== 'pending') {
        link.missing = (link.missing || 0) + 1;
        if (link.missing >= MISSING_SYNCS_TO_CLOSE) {
          const pnl = this.bridge.deals.filter((d) => d.position === link.ticket && d.entry !== 0).reduce((s, d) => s + d.pnl, 0);
          link.state = 'closed';
          link.closedAt = Date.now();
          link.closedDay = this.bridge.serverDay;
          link.pnl = pnl;
          const how = link.closeRequested ? 'closed' : 'closed on MT5 (stop, target or manual)';
          this.#note(`${this.#who(link)} ${link.brokerSymbol} ${how}: ${fmtUsd(pnl, { sign: true })}`, 'live', link.agentId);
          this.save();
        }
      }
    }
    this.#guard();
    this.emit('change');
  }

  // ---- FTMO rule guard -----------------------------------------------------------------------
  openRisk() {
    let total = 0;
    for (const pos of this.bridge.positions) {
      if (!this.#ours(pos)) continue;
      total += positionRisk(pos, this.bridge.quotes[pos.symbol]);
    }
    return total;
  }

  metrics() {
    const p = this.profile;
    const acc = this.account;
    if (!p || !acc) return null;
    return guardMetrics(p, acc, this.openRisk());
  }

  #guard() {
    const p = this.profile;
    const acc = this.account;
    if (!p || !acc) return;
    const h = this.halt;
    if (h?.kind === 'daily' && this.bridge.serverDay && h.day !== this.bridge.serverDay) {
      delete this.state.halts[this.login];
      this.save();
      this.#note('New trading day on the FTMO server — daily loss guard reset (arm again to trade)', 'risk');
    }
    if (this.halt) return;
    const m = guardMetrics(p, acc, 0);
    let kind = null;
    let reason = null;
    if (m.maxBreach) {
      kind = 'max';
      reason = `Loss reached ${p.guardPct}% of the ${p.maxLossPct}% max-loss limit (${fmtUsd(-m.totalLoss)})`;
    } else if (m.dailyBreach) {
      kind = 'daily';
      reason = `Today's loss reached ${p.guardPct}% of the ${p.dailyLossPct}% daily limit (${fmtUsd(-m.dailyLoss)})`;
    } else if (p.stopAtTarget && m.targetHit) {
      kind = 'target';
      reason = `Profit target of ${p.targetPct}% reached (${fmtUsd(m.profit, { sign: true })}) — locking it in`;
    }
    if (!kind) return;
    this.state.halts[this.login] = { kind, reason, day: this.bridge.serverDay, at: Date.now() };
    this.save();
    this.armed = false;
    if (this.bridge.positions.some((x) => this.#ours(x))) this.bridge.closeAll({ kind: 'guard' });
    this.#note(`${kind === 'target' ? 'TARGET HIT' : 'RISK GUARD'} — ${reason}. Floor positions closed and trading stopped.`, 'risk');
  }

  // ---- execution ------------------------------------------------------------------------------
  #busy(link) {
    return this.bridge.hasPending((c) => c.meta?.linkKey === link.key);
  }

  #paperKey(agent, pos) {
    return `${this.sessionId}:${agent.id}:${pos.trade.id}`;
  }

  tick() {
    if (this.profile && !this.bridge.connected) {
      for (const id of SYMBOL_IDS) if (this.md.ownerOf(id) === 'mt5') this.md.setStatus(id, 'STALE', 'ftmo');
    }
    // Account equity once a minute, for the floor's equity charts in FTMO view.
    const acc = this.account;
    if (this.profile && acc && this.bridge.connected) {
      const t = Math.floor(Date.now() / 60_000) * 60;
      const last = this.equityHistory[this.equityHistory.length - 1];
      if (!last || t > last.time) this.equityHistory.push({ time: t, value: acc.equity });
      else last.value = acc.equity;
      if (this.equityHistory.length > 1440) this.equityHistory.shift();
    }
    this.reconcile();
  }

  // One desk's results on the connected account (floor trades only).
  deskBook(agentId) {
    const login = this.login;
    const mine = [...this.links.values()].filter((l) => l.agentId === agentId && l.login === login);
    const openLink = mine.find((l) => !l.previousSession && (l.state === 'open' || l.state === 'closing'));
    const closed = mine.filter((l) => l.state === 'closed');
    const isToday = (l) => (l.closedDay ? l.closedDay === this.bridge.serverDay : l.closedAt >= Date.now() - 86_400_000);
    const closedToday = closed.filter(isToday);
    const openProfit = openLink?.profit ?? 0;
    return {
      enabled: !!this.profile?.desks?.[agentId] && this.eligible(agentId),
      day: closedToday.reduce((s, l) => s + (l.pnl || 0), 0) + openProfit,
      total: closed.reduce((s, l) => s + (l.pnl || 0), 0) + openProfit,
      trades: closedToday.length + (openLink ? 1 : 0),
      open: openLink ? { side: openLink.side, volume: openLink.volumeNow, symbol: openLink.brokerSymbol, profit: openProfit, sl: openLink.sl, tp: openLink.tp } : null,
    };
  }

  reconcile() {
    const p = this.profile;
    if (!this.armed || !p || !this.bridge.connected) return;
    if (this.halt) {
      this.armed = false;
      return;
    }
    const now = this.clock.now();
    const liveKeys = new Set();
    for (const agent of this.fund.agents) {
      const enabled = this.eligible(agent.id) && p.desks[agent.id];
      for (const pos of agent.book.positions.values()) {
        const key = this.#paperKey(agent, pos);
        liveKeys.add(key);
        const link = this.links.get(key);
        if (!link) {
          if (enabled && now - pos.trade.openTime <= ENTRY_WINDOW_MS) this.#openLive(agent, pos, key);
          continue;
        }
        if (link.state !== 'open' || this.#busy(link)) continue;
        this.#followScaleOut(link, pos);
        this.#followStop(link, agent.plans.get(pos.symbol));
      }
    }
    // Desk closed its paper trade → close the live one.
    for (const link of this.links.values()) {
      if (link.previousSession || link.state !== 'open' || liveKeys.has(link.key) || this.#busy(link)) continue;
      if (link.retryAt && Date.now() < link.retryAt) continue;
      link.state = 'closing';
      link.closeRequested = true;
      this.bridge.close(link.ticket, 1, { linkKey: link.key });
      this.#note(`${this.#who(link)} closing ${link.side} ${link.volumeNow} ${link.brokerSymbol} — desk exited`, 'live', link.agentId);
    }
  }

  #skip(agent, pos, key, reason) {
    this.links.set(key, {
      key, agentId: agent.id, floorSymbol: pos.symbol, brokerSymbol: this.profile.symbolMap[pos.symbol],
      side: pos.qty > 0 ? 'BUY' : 'SELL', state: 'skipped', reason, createdAt: Date.now(), login: this.login,
    });
    this.#note(`${agent.profile.name.split(' ')[0]} ${pos.symbol} trade not sent to FTMO: ${reason}`, 'live', agent.id);
  }

  #openLive(agent, pos, key) {
    const p = this.profile;
    const acc = this.account;
    const plan = agent.plans.get(pos.symbol);
    const brokerSymbol = p.symbolMap[pos.symbol];
    const spec = brokerSymbol ? this.bridge.quotes[brokerSymbol] : null;
    if (!brokerSymbol) return this.#skip(agent, pos, key, `no FTMO symbol mapped for ${pos.symbol}`);
    if (!plan || !(plan.risk > 0)) return this.#skip(agent, pos, key, 'no stop-loss on the desk trade');
    if (!spec) return this.#skip(agent, pos, key, `no MT5 price for ${brokerSymbol} yet`);
    if (!acc.algoAllowed || !acc.tradeAllowed) return this.#skip(agent, pos, key, 'Algo Trading is switched off in MT5');
    const ours = this.bridge.positions.filter((x) => this.#ours(x)).length
      + [...this.links.values()].filter((l) => l.state === 'pending').length;
    if (ours >= p.maxPositions) return this.#skip(agent, pos, key, `already ${ours} live positions (max ${p.maxPositions})`);

    // Learning (or a new strategy on probation) may size a desk's trade down on the account, never up.
    const news = this.fund.env.news?.blackout(pos.symbol);
    if (news) return this.#skip(agent, pos, key, `news blackout (${news.event.title})`);
    const riskMoney = acc.balance * (p.riskPerTradePct / 100) * (agent.profile.riskScale ?? 1) * Math.min(1, plan.riskMult ?? plan.learnMult ?? 1);
    const lots = lotsForRisk(riskMoney, plan.risk, spec);
    if (!lots) return this.#skip(agent, pos, key, `position would be below the ${spec.volMin} lot minimum`);
    const actualRisk = (plan.risk / (spec.tickSize || spec.point)) * (spec.tickValueLoss || spec.tickValue) * lots;
    const openRisk = this.openRisk();
    const m = guardMetrics(p, acc, openRisk);
    if (actualRisk > m.dailyRoom) return this.#skip(agent, pos, key, `not enough room under the daily loss guard (${fmtUsd(Math.max(0, m.dailyRoom))} left)`);
    if (actualRisk > m.maxRoom) return this.#skip(agent, pos, key, `not enough room under the max loss guard (${fmtUsd(Math.max(0, m.maxRoom))} left)`);
    if (openRisk + actualRisk > acc.balance * (p.maxOpenRiskPct / 100)) {
      return this.#skip(agent, pos, key, `open-risk budget of ${p.maxOpenRiskPct}% is full`);
    }

    const side = pos.qty > 0 ? 'BUY' : 'SELL';
    const comment = `MF-${agent.id}-${Date.now().toString(36).slice(-5)}`;
    const tpDistance = plan.target != null ? Math.abs(plan.target - plan.entry) : 0;
    const link = {
      key, agentId: agent.id, floorSymbol: pos.symbol, brokerSymbol, side, state: 'pending', login: this.login,
      comment, magic: this.magicFor(agent.id), paperEntry: plan.entry, paperQty0: Math.abs(pos.qty),
      stopDistance: plan.risk, volume0: lots, volumeNow: lots, liveEntry: side === 'BUY' ? spec.ask : spec.bid,
      risk: actualRisk, createdAt: Date.now(), reason: plan.reason,
    };
    this.links.set(key, link);
    link.cmdId = this.bridge.open({
      symbol: brokerSymbol, side, volume: lots, slDistance: plan.risk, tpDistance, magic: link.magic, comment,
    }, { linkKey: key });
    this.#note(`${agent.profile.name.split(' ')[0]} sending ${side} ${lots} ${brokerSymbol} to MT5, stop ${plan.risk.toPrecision(5)} away (risk ${fmtUsd(actualRisk)})`, 'live', agent.id);
    this.save();
  }

  // Desk took partial profits → take the same fraction off the live position.
  #followScaleOut(link, pos) {
    const paperFrac = Math.abs(pos.qty) / link.paperQty0;
    const liveFrac = link.volumeNow / link.volume0;
    if (liveFrac - paperFrac < 0.2 || link.scaledOut) return;
    const fraction = 1 - paperFrac / liveFrac;
    this.bridge.close(link.ticket, Number(fraction.toFixed(4)), { linkKey: link.key, partial: true });
    link.scaledOut = true; // one attempt; if the lot size can't be split we keep the full runner
    this.#note(`${this.#who(link)} scaling out ${Math.round(fraction * 100)}% of ${link.brokerSymbol}`, 'live', link.agentId);
  }

  // Desk moved its stop (breakeven / trailing) → tighten the live stop by the same amount.
  #followStop(link, plan) {
    if (!plan || !Number.isFinite(plan.stop) || !link.sl) return;
    const desired = plan.stop + (link.liveEntry - link.paperEntry);
    const spec = this.bridge.quotes[link.brokerSymbol];
    if (!spec) return;
    const minMove = Math.max(link.stopDistance * 0.1, (spec.point || 0) * 5);
    const long = link.side === 'BUY';
    const tighter = long ? desired > link.sl + minMove : desired < link.sl - minMove;
    if (!tighter || (link.modifyFailures || 0) >= 3) return;
    const price = long ? spec.bid : spec.ask;
    if (long ? desired >= price : desired <= price) return; // the desk's own exit logic will close it
    const digits = spec.digits ?? 5;
    this.bridge.modify(link.ticket, desired.toFixed(digits), 'keep', { linkKey: link.key });
  }

  async shutdown() {
    this.armed = false;
    if (!this.bridge.connected || !this.bridge.positions.some((x) => this.#ours(x))) return null;
    this.bridge.closeAll({ kind: 'shutdown' });
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && this.bridge.hasPending((c) => c.kind === 'closeall')) {
      await new Promise((r) => setTimeout(r, 200));
    }
    // true = MT5 confirmed the close; false = no answer (positions keep their stop-loss).
    return !this.bridge.hasPending((c) => c.kind === 'closeall');
  }

  // ---- presentation -----------------------------------------------------------------------------
  describeFor(agentId) {
    const p = this.profile;
    if (!p?.desks?.[agentId] || !this.eligible(agentId)) return null;
    const open = [...this.links.values()].find((l) => l.agentId === agentId && l.state === 'open' && !l.previousSession);
    if (open) {
      const pnl = open.profit ?? 0;
      return `I'm also live on your FTMO account: ${open.side === 'BUY' ? 'long' : 'short'} ${open.volumeNow} lots of ${open.brokerSymbol}, ${pnl >= 0 ? 'up' : 'down'} ${fmtUsd(Math.abs(pnl))}.`;
    }
    if (this.halt) return `Your FTMO account is on hold: ${this.halt.reason}.`;
    return this.armed ? `I'm cleared to trade your FTMO account and flat there right now.` : `I'm set up for your FTMO account, waiting for you to arm live trading.`;
  }

  // Floor trades on this account for the dashboard: blotter rows and simple stats.
  #tradesView(links) {
    const mine = links.filter((l) => l.login === this.login && !l.previousSession && ['open', 'closing', 'closed'].includes(l.state));
    const isToday = (l) => (l.closedDay ? l.closedDay === this.bridge.serverDay : l.closedAt >= Date.now() - 86_400_000);
    const closed = mine.filter((l) => l.state === 'closed');
    const today = closed.filter(isToday);
    const floating = this.bridge.positions.filter((x) => this.#ours(x)).reduce((sum, x) => sum + (x.profit || 0), 0);
    return {
      stats: {
        closedToday: today.length,
        winsToday: today.filter((l) => l.pnl > 0).length,
        realizedToday: today.reduce((sum, l) => sum + (l.pnl || 0), 0),
        closedTotal: closed.length,
        winsTotal: closed.filter((l) => l.pnl > 0).length,
        realizedTotal: closed.reduce((sum, l) => sum + (l.pnl || 0), 0),
        floating,
      },
      trades: mine
        .sort((a, b) => (b.closedAt || b.createdAt) - (a.closedAt || a.createdAt))
        .slice(0, 40)
        .map((l) => ({
          agentId: l.agentId, symbol: l.brokerSymbol, side: l.side, volume: l.volume0, state: l.state,
          pnl: l.state === 'closed' ? l.pnl : l.profit ?? 0, entry: l.liveEntry, openedAt: l.createdAt, closedAt: l.closedAt || null, reason: l.reason || '',
        })),
    };
  }

  view() {
    const acc = this.account;
    const p = this.profile;
    const brokerSymbols = this.bridge.symbols;
    const links = [...this.links.values()];
    const warnings = [];
    if (this.mode !== 'live') warnings.push('You are in demo mode (simulated prices). Live FTMO trading needs npm start.');
    const isFtmo = !!acc && /ftmo/i.test(`${acc.server} ${acc.company}`);
    if (acc && !isFtmo) warnings.push(`MT5 is logged into ${acc.server} (${acc.company || 'another broker'}), which doesn't look like an FTMO account. In MT5 use File → Login to Trade Account with the login, password and server from your FTMO Client Area.`);
    if (acc && acc.connected === false) warnings.push('MT5 is not connected to its trade server (bottom-right of MT5 shows "No connection" or 0 / 0 Kb). Log in again via File → Login to Trade Account and check the password and server.');
    else if (acc && !acc.tradeAllowed) warnings.push('This account does not allow trading right now: logged in with the investor (read-only) password, or the account is disabled or expired.');
    if (acc && acc.connected !== false && !acc.expertAllowed) warnings.push('The broker has disabled Expert Advisor trading on this account.');
    if (acc && !acc.algoAllowed) warnings.push('Algo Trading is off in MT5 — turn on the "Algo Trading" toolbar button, and tick "Allow Algo Trading" in the EA settings (click the chart, press F7).');
    if (acc && acc.marginMode === 0) warnings.push('This is a netting account: desks trading the same symbol will net against each other.');
    const orphans = this.bridge.positions.filter((x) => this.#ours(x) && !links.some((l) => l.ticket === x.ticket && !l.previousSession && ['open', 'closing'].includes(l.state)));
    if (orphans.length) warnings.push(`${orphans.length} floor position(s) on MT5 are from a previous session. They keep their stop-loss; close them below if you like.`);
    return {
      mode: this.mode,
      connected: this.bridge.connected,
      lastSync: this.bridge.lastSync || null,
      eaVersion: this.bridge.version,
      token: this.token,
      account: acc,
      isFtmo,
      serverDay: this.bridge.serverDay,
      profile: p,
      armed: this.armed,
      armedAt: this.armedAt,
      halt: this.halt,
      metrics: this.metrics(),
      openRisk: this.openRisk(),
      types: ACCOUNT_TYPES,
      defaults: DEFAULTS,
      brokerSymbolCount: brokerSymbols.length,
      suggestedMap: autoMap(brokerSymbols),
      candidates: Object.fromEntries(SYMBOL_IDS.map((id) => [id, candidatesFor(id, brokerSymbols).slice(0, 12)])),
      desks: this.fund.agents.map((a) => {
        const b = this.deskBook(a.id);
        return {
          id: a.id, name: a.profile.name, desk: a.profile.desk, symbols: a.symbols,
          eligible: this.eligible(a.id), reason: INELIGIBLE[a.id] || null,
          enabled: !!p?.desks?.[a.id],
          brokerSymbol: p?.symbolMap?.[a.symbol] ?? null,
          live: b.open,
          pnlToday: b.day,
          pnlTotal: b.total,
          tradesToday: b.trades,
        };
      }),
      equityHistory: this.equityHistory.slice(-240),
      ...this.#tradesView(links),
      positions: this.bridge.positions.map((x) => ({ ...x, agentId: this.#ours(x) ? this.agentForMagic(x.magic) : null, floor: this.#ours(x) })),
      links: links.filter((l) => !l.previousSession).slice(-25).reverse(),
      events: this.events.slice(-40).reverse(),
      warnings,
    };
  }
}
