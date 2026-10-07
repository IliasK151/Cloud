import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Vault, VAULT, NOTES_MARK, safeName, nyStamp } from '../server/vault/vault.js';
import { FloorMemory } from '../server/brain/memory.js';
import { Fund, isWeekendDay } from '../server/engine/fund.js';
import { ROSTER } from '../server/engine/roster.js';
import { MarketClock, Session, nyWallToMs } from '../server/market/session.js';
import { MarketData } from '../server/market/marketData.js';
import { Broker } from '../server/engine/broker.js';
import { RiskManager } from '../server/engine/risk.js';
import { AccountBrain, LIMITS } from '../server/live/accountBrain.js';
import { normalizeProfile, guardMetrics } from '../server/live/rules.js';
import { Baseline, loadBaseline, WEEKEND_FILE } from '../server/live/baseline.js';
import { skipCategory } from '../server/live/dailyReport.js';
import { config } from '../server/config.js';
import { protectedFolder, folderName } from '../server/util/macFolders.js';

function floor(mode = 'sim') {
  const clock = new MarketClock(mode, 1);
  const session = new Session(clock);
  const md = new MarketData(clock);
  const broker = new Broker(md, clock);
  const risk = new RiskManager(config.risk, session);
  const fund = new Fund({ config: { ...config, feed: mode }, md, clock, session, broker, risk, committee: 'off' });
  return { fund, clock, md, session };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const SECRET = 'bridge-token-must-never-leak-1234';

// A floor with a closed winning and losing trade, a lesson, and memory of them.
function setup({ mode = 'sim' } = {}) {
  const { fund, md } = floor(mode);
  const dir = tmp();
  const memory = new FloorMemory({ mode });
  const marcus = fund.byId.get('marcus');
  fund.env.memory = memory;
  const live = { token: SECRET, bridge: { token: SECRET }, profile: null, review: null, baseline: null, reports: null };
  const vault = new Vault({ dir, mode, fund, memory, live, log: { warn() {}, info() {} } });
  return { fund, md, dir, vault, marcus, memory };
}

function trade(fund, md, agent, { from = 20_000, to = 20_100, side = 'LONG' } = {}) {
  md.applyTick('NAS100', from, 1, fund.clock.now());
  agent.cooldownBars = 0;
  assert.equal(agent.openTrade({ side, stop: side === 'LONG' ? from - 50 : from + 50, target: side === 'LONG' ? from + 150 : from - 150, reason: 'ORB test' }), true);
  md.applyTick('NAS100', to, 1, fund.clock.now());
  agent.closeTrade('NAS100', to > from === (side === 'LONG') ? 'Target hit' : 'Stop loss');
  return fund.broker.book(agent.id).trades.at(-1);
}

test('the vault: a note per desk, trade, day, market and lesson, linked for Obsidian, and nothing secret', () => {
  const { fund, md, dir, vault, marcus } = setup();
  const win = trade(fund, md, marcus, { from: 20_000, to: 20_120 });
  const loss = trade(fund, md, marcus, { from: 20_120, to: 20_060 });
  marcus.learner.state.lessons.push({ id: 'l1', key: 'avoid:asia', time: fund.clock.now(), title: 'Sit out the Asian session', text: 'My trades in Asia averaged −0.4R.', evidence: { n: 12, avgR: -0.4 }, status: 'active' });
  assert.equal(vault.start(), true);
  vault.stop();
  const files = (sub) => fs.readdirSync(path.join(dir, sub), { recursive: true }).filter((f) => String(f).endsWith('.md'));
  assert.ok(fs.existsSync(path.join(dir, 'Home.md')));
  assert.ok(files('Desks').includes('Marcus Reid.md'));
  assert.equal(files('Desks').length, ROSTER.length);
  const tradeFiles = files('Trades');
  assert.equal(tradeFiles.length, 2);
  assert.ok(files('Lessons').includes('Marcus - Sit out the Asian session.md'));
  assert.ok(files('Markets').includes('NAS100.md'));
  for (const f of ['What works.md', 'What loses.md', 'Rules the desks follow.md']) assert.ok(files('Playbook').includes(f), f);
  assert.equal(files('Daily').length, 1);

  // A trade note: front matter for search and Dataview, links to the desk, market and day.
  const winNote = read(dir, path.join('Trades', tradeFiles.find((f) => read(dir, path.join('Trades', f)).includes('result: "win"'))));
  assert.match(winNote, /^---\ndesk: "marcus"\nsymbol: "NAS100"\nside: "long"/);
  assert.match(winNote, /tags: \["trade", "win", "desk\/marcus", "market\/NAS100"\]/);
  assert.match(winNote, /\[\[Marcus Reid\]\] · Market: \[\[NAS100\]\]/);
  assert.match(winNote, /# Marcus · NAS100 long · \+\d\.\d\dR ✅/);
  assert.match(winNote, /Why: ORB test/);
  assert.match(winNote, /Exit: Target hit/);
  assert.ok(win.r > 0 && loss.r < 0);

  // The desk note: numbers, the rules it learned, its trades.
  const desk = read(dir, path.join('Desks', 'Marcus Reid.md'));
  assert.match(desk, /# Marcus Reid · Index Futures/);
  assert.match(desk, /\*\*Opening Range Breakout\*\* on \[\[NAS100\]\], and \[\[BTCUSD\]\] at the weekend/);
  assert.match(desk, /\| Kept in the book \| 2 \| 1 \| 50% \|/);
  assert.match(desk, /\[\[Marcus - Sit out the Asian session\]\] · active/);
  assert.match(desk, /## Recent trades\n- \[\[/);
  assert.match(desk, /Entry rules: minWidth 1 · maxWidth 12 · volume 0/);
  const home = read(dir, 'Home.md');
  assert.match(home, /\| \[\[Marcus Reid\]\] \| NAS100 \| 2 \| 1 \|/);
  assert.match(home, /\[\[What works\]\] · \[\[What loses\]\]/);
  // Never a secret, anywhere.
  for (const f of fs.readdirSync(dir, { recursive: true })) {
    const p = path.join(dir, String(f));
    if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p, 'utf8').includes(SECRET), `${f} leaks a secret`);
  }
  // Obsidian's graph in the floor's colours.
  const graph = JSON.parse(read(dir, path.join('.obsidian', 'graph.json')));
  assert.ok(graph.colorGroups.some((g) => g.query === 'tag:#win'));
  assert.ok(graph.colorGroups.some((g) => g.query === 'tag:#loss'));
});

test('the vault keeps what you write, rewrites only what changed, and leaves your Obsidian settings alone', () => {
  const { fund, md, dir, vault, marcus } = setup();
  trade(fund, md, marcus);
  vault.start();
  const rel = path.join('Desks', 'Marcus Reid.md');
  const file = path.join(dir, rel);
  fs.appendFileSync(file, '\nMarcus overtrades on Fridays. Watch him.\n');
  const before = vault.written;
  vault.refresh();
  assert.equal(vault.written, before, 'nothing changed, nothing written');
  trade(fund, md, marcus, { from: 20_100, to: 20_040 });
  vault.refresh();
  const after = fs.readFileSync(file, 'utf8');
  assert.match(after, /\| Kept in the book \| 2 \|/, 'the numbers moved');
  assert.match(after, /Marcus overtrades on Fridays\. Watch him\./, 'your notes stayed');
  assert.equal(after.split(NOTES_MARK).length, 2, 'one notes section');
  // Your Obsidian settings win.
  fs.writeFileSync(path.join(dir, '.obsidian', 'graph.json'), '{"mine":true}');
  vault.stop();
  const again = new Vault({ dir, mode: 'sim', fund, log: { warn() {} } });
  again.start();
  again.stop();
  assert.equal(read(dir, path.join('.obsidian', 'graph.json')), '{"mine":true}');
  assert.ok(again.view().notes > 20);
  assert.equal(again.view().dir, dir);
});

test('the vault logs every idea, taken or turned down, and only real prices count in live mode', () => {
  const { fund, dir, vault, marcus } = setup({ mode: 'live' });
  vault.start();
  const day = nyStamp(fund.clock.now()).day;
  fund.pushEvent({ agentId: 'marcus', kind: 'entry', text: 'Bought 2 NAS100 @ 20,000' });
  fund.pushEvent({ agentId: 'marcus', kind: 'setup', text: 'Committee said no: volatility is extreme' });
  fund.pushEvent({ agentId: 'marcus', kind: 'info', text: 'Just chatting' });
  const ideas = read(dir, path.join('Ideas', `${day}.md`));
  assert.match(ideas, /\[\[Marcus Reid\]\] · NAS100 · \*\*took it\*\*: Bought 2 NAS100 @ 20,000/);
  assert.match(ideas, /turned down: Committee said no: volatility is extreme/);
  assert.doesNotMatch(ideas, /Just chatting/);
  // A trade decided on a simulated stand-in feed never reaches the live vault.
  const t = { id: 'x1', agentId: 'marcus', symbol: 'NAS100', side: 'LONG', entry: 1, exit: 2, openTime: fund.clock.now(), closeTime: fund.clock.now(), pnl: 10, r: 1, simFeed: true };
  fund.broker.emit('trade', t);
  vault.stop();
  assert.equal(fs.existsSync(path.join(dir, 'Trades')) ? fs.readdirSync(path.join(dir, 'Trades'), { recursive: true }).filter((f) => String(f).endsWith('.md')).length : 0, 0);
  assert.equal(marcus.id, 'marcus');
});

test('the desks keep their own journals live: what they watch, take, turn down, win, lose and learn, and a review at the close', () => {
  const { fund, md, dir, vault, marcus } = setup();
  // What it's watching, noted when it changes (not every minute).
  marcus.setup.stage = 'Armed: long above 20,105, short below 20,050';
  marcus.setup.thesis = 'New York range 20,050–20,105.';
  vault.start();
  assert.equal(vault.view().live, true);
  const day = fund.session.tradingDay(fund.clock.now());
  const journal = () => read(dir, path.join('Journal', 'Marcus Reid', `${day}.md`));
  vault.tick();
  vault.tick();
  assert.equal(journal().split('👀 Armed: long above 20,105').length, 2, 'noted once, not every minute');
  assert.match(journal(), /👀 Armed: long above 20,105, short below 20,050\. New York range 20,050–20,105\./);
  marcus.setup.stage = 'Range forming';
  vault.tick();
  assert.doesNotMatch(journal(), /👀 Range forming/, 'and not more than every 20 minutes');
  const t = trade(fund, md, marcus, { from: 20_000, to: 20_120 });
  fund.pushEvent({ agentId: 'marcus', kind: 'setup', text: 'Committee said no: volatility is extreme' });
  fund.pushEvent({ agentId: 'marcus', kind: 'committee', text: 'Committee APPROVED Marcus\'s NAS100 long (grade A): trend and room agree' });
  marcus.note('Lesson learned — Sit out the Asian session. My trades there lose.', 'learn');
  let j = journal();
  assert.match(j, /^---\ndesk: "marcus"/);
  assert.match(j, /# Marcus's journal · /);
  assert.match(j, /📈 \*\*In:\*\* Bought .* NAS100/);
  assert.match(j, /✅ \*\*Won:\*\* Closed for a win on NAS100/);
  assert.match(j, /🚫 \*\*Turned down:\*\* Committee said no: volatility is extreme/);
  assert.match(j, /🏛️ \*\*Committee:\*\* Committee APPROVED/);
  assert.match(j, /💡 \*\*Learned:\*\* Sit out the Asian session/);
  assert.ok(t.r > 0);
  // The close: a review of the day, once.
  fund.pushEvent({ kind: 'session', text: 'Session close: all desks flat into the close' });
  fund.pushEvent({ kind: 'session', text: 'Session close: all desks flat into the close' });
  j = journal();
  assert.equal(j.split('## End of day').length, 2, 'written once');
  assert.match(j, /## End of day\n- \d+ ideas?: \d+ taken, \d+ turned down\n- 1 trade: 1 won, 0 lost, \+\d\.\d\dR/);
  assert.match(j, /- How I trade now: /);
  // Now.md: the floor right now.
  const now = read(dir, 'Now.md');
  assert.match(now, /# The floor right now\n\n\*\*Live\*\*: \d{4}-\d{2}-\d{2} \d{2}:\d{2} New York \(rewritten every minute while the floor runs\)/);
  assert.match(now, /\| \[\[Marcus Reid\]\] \| NAS100 \| /);
  assert.match(now, /\[\[Journal\/Marcus Reid\/\d{4}-\d{2}-\d{2}\|journal\]\]/);
  assert.match(read(dir, 'Home.md'), /Right now: \[\[Now\|what every desk is doing\]\]/);
  vault.stop();
  assert.equal(vault.view().live, false);
});

test('old trade notes are pruned; names are safe for every OS', () => {
  const { dir, vault } = setup();
  const old = path.join(dir, 'Trades', '2019-01');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'x.md'), 'old');
  vault.start();
  vault.stop();
  assert.equal(fs.existsSync(old), false);
  assert.ok(VAULT.tradesKeptDays >= 90);
  assert.equal(safeName('a/b:c*d?"e<f>g|h#i^[j]'), 'a-b-c-d--e-f-g-h-i--j-');
});

test('a vault in a folder macOS keeps the non-stop service out of says so, in plain words', () => {
  const home = path.join(os.tmpdir(), 'home');
  assert.equal(protectedFolder(path.join(home, 'Documents', 'Meridian Vault'), home), 'Documents');
  assert.equal(protectedFolder(path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Vault'), home), 'Mobile Documents');
  assert.equal(folderName('Mobile Documents'), 'iCloud Drive');
  assert.equal(protectedFolder(path.join(home, 'Meridian Vault'), home), null);
  assert.equal(protectedFolder(path.join(home, 'trading-floor', 'data', 'vault'), home), null);
  // A write the service isn't allowed to make: the Brain tab and the log say why and what to do.
  const { fund, memory } = setup();
  const warned = [];
  const vault = new Vault({ dir: path.join(os.homedir(), 'Documents', 'Meridian Vault'), mode: 'sim', fund, memory, log: { warn: (s) => warned.push(s) } });
  const realMkdir = fs.mkdirSync;
  fs.mkdirSync = () => { throw Object.assign(new Error('EPERM: operation not permitted, mkdir'), { code: 'EPERM' }); };
  try {
    assert.equal(vault.start(), false);
  } finally {
    fs.mkdirSync = realMkdir;
  }
  assert.match(vault.view().lastError.text, /can't be written in your Documents: macOS doesn't let the floor's background service write there\. Set VAULT_DIR in \.env to a folder outside it \(e\.g\. VAULT_DIR=~\/Meridian Vault\)/);
  assert.equal(warned.length, 1);
  assert.equal(vault.view().live, false);
});

// ---- the weekend ---------------------------------------------------------------------------
test('at the weekend the desks day-trade crypto, Friday 18:00 to Sunday 18:00 New York, then go back', () => {
  assert.equal(isWeekendDay('2026-10-17'), true); // Saturday
  assert.equal(isWeekendDay('2026-10-18'), true); // Sunday
  assert.equal(isWeekendDay('2026-10-16'), false); // Friday
  const { fund } = floor('live');
  let now = nyWallToMs(2026, 10, 16, 12, 0); // Friday noon
  fund.clock.now = () => now;
  fund.housekeeping();
  const marcus = fund.byId.get('marcus');
  const viktor = fund.byId.get('viktor');
  assert.equal(marcus.symbol, 'NAS100');
  now = nyWallToMs(2026, 10, 16, 18, 5); // Friday 18:05: Saturday's trading day
  fund.housekeeping();
  assert.equal(marcus.symbol, 'BTCUSD');
  assert.equal(marcus.weekend, true);
  assert.deepEqual(marcus.symbols, ['BTCUSD']);
  assert.equal(marcus.snapshot().symbol, 'BTCUSD');
  assert.match(marcus.log.at(-1).text, /Weekend: .* day trading BTCUSD with my Opening Range Breakout until Sunday 18:00 New York/);
  assert.equal(fund.byId.get('amara').symbol, 'ETHUSD');
  assert.equal(viktor.symbol, 'BTCUSD', 'a crypto desk stays where it is');
  assert.ok(fund.events.some((e) => /Weekend: 6 desks day-trade crypto/.test(e.text)));
  for (const a of fund.agents.filter((x) => x.profile.weekendSymbol)) assert.ok(['BTCUSD', 'ETHUSD'].includes(a.symbol), a.id);
  // The day traders rest at the weekend: their playbook was tested on their own markets.
  assert.equal(fund.agents.filter((x) => !x.profile.lab && !x.profile.dayTrader && !x.profile.weekendSymbol && !/USD$/.test(x.symbol)).length, 0, 'no desk left on a closed market');
  now = nyWallToMs(2026, 10, 18, 17, 0); // Sunday 17:00: still the weekend
  fund.housekeeping();
  assert.equal(marcus.symbol, 'BTCUSD');
  now = nyWallToMs(2026, 10, 18, 18, 1); // Sunday 18:01: Monday's trading day
  fund.housekeeping();
  assert.equal(marcus.symbol, 'NAS100');
  assert.equal(marcus.weekend, false);
  assert.ok(fund.events.some((e) => /Weekend over/.test(e.text)));
  // The demo clock never runs at the weekend: nothing switches there.
  const demo = floor('sim').fund;
  demo.clock.now = () => nyWallToMs(2026, 10, 17, 12, 0);
  demo.housekeeping();
  assert.equal(demo.byId.get('marcus').symbol, 'NAS100');
});

function account({ weekendOn = true, links = [], weekendRecord = null, practice = false } = {}) {
  const p = { ...normalizeProfile({ program: '2-step', type: 'trial', size: 10_000, practiceAll: practice }, {}), symbolMap: {} };
  const live = {
    login: '1', profile: p, account: { equity: 10_000, balance: 10_000 }, halt: null, bridge: { serverDay: '2026.10.17' },
    links: new Map(links.map((l, i) => [String(i), { login: '1', createdAt: Date.now(), ...l }])),
    metrics: () => guardMetrics(p, { balance: 10_000, equity: 10_000, closedToday: 0 }, 0, {}),
    consistency: () => null,
    weekendRecord: weekendRecord ? new Baseline(weekendRecord) : null,
    fund: { weekendOn, agents: [], env: {} },
  };
  return { brain: new AccountBrain(live), live };
}

test('the account at the weekend: each desk\'s weekend crypto record decides, and one crypto trade at a time', () => {
  const { fund } = floor('live');
  const marcus = fund.byId.get('marcus');
  marcus.switchMarket('BTCUSD', { weekend: true });
  const pos = { symbol: 'BTCUSD', qty: 1 };
  const rec = { v: 1, desks: [{ id: 'marcus', name: 'Marcus Reid', symbol: 'BTCUSD', verdict: 'loses', n: 190, avgR: -0.3, ci: [-0.4, -0.2], from: 1483228800, to: 1543842000, label: '90 Bitcoin weekends (Jan 2017 – Dec 2018)' }] };
  const no = account({ weekendRecord: rec }).brain.allow(marcus, pos, {});
  assert.equal(no.ok, false);
  assert.match(no.reason, /^Marcus lost money day-trading crypto at the weekend over the long run: −0\.30R a trade over 190 trades on 90 Bitcoin weekends \(Jan 2017 – Dec 2018\) of real 1-minute prices/);
  assert.equal(skipCategory(no.reason), 'Loses over the long run');
  // Practice on the Free Trial: it trades anyway, small.
  assert.equal(account({ weekendRecord: rec, practice: true }).brain.allow(marcus, pos, {}).practice, true);
  // What the desk list says matches what happens: practice trades the trial (no "paper only"),
  // and with FTMO only on there's no paper at all.
  const status = (practice) => {
    const a = account({ weekendRecord: rec, practice });
    Object.assign(a.live, { eligible: () => true, armed: true, ftmoOnly: true, mode: 'live' });
    a.live.profile.desks = { marcus: true };
    return a.brain.deskStatus(marcus);
  };
  const practising = status(true);
  assert.match(practising.text, /^Practises on the Free Trial at 0\.25% a trade \(practice is on\)\. Marcus lost money day-trading crypto at the weekend over the long run: −0\.30R a trade over 190 trades on 90 Bitcoin weekends \(Jan 2017 – Dec 2018\) of real 1-minute prices \(90% range −0\.40R to −0\.20R\)\.$/);
  assert.doesNotMatch(practising.text, /paper only|off the account/i);
  const held = status(false);
  assert.equal(held.label, 'Off · loses on weekend crypto');
  assert.match(held.text, /Off the account at the weekend\.$/);
  assert.match(account({ weekendRecord: rec }).brain.allow(marcus, pos, {}).reason, /Paper only at the weekend$/, 'paper when FTMO only is off');
  // Too short a weekend record: half size.
  const short = account({ weekendRecord: { v: 1, desks: [] } }).brain.allow(marcus, pos, {});
  assert.equal(short.ok, true);
  assert.ok(short.reasons.some((r) => /too short a record day-trading crypto at the weekend/.test(r)));
  // Crypto moves together: one crypto trade on the account at a time (no pile-ups).
  const open = (sym, i) => ({ floorSymbol: sym, state: 'open', ticket: i, agentId: 'chen' });
  const full = account({ weekendRecord: { v: 1, desks: [] }, links: [open('ETHUSD', 1)] }).brain.allow(marcus, pos, {});
  assert.equal(full.ok, false);
  assert.match(full.reason, /^one trade per correlated group: chen's ETHUSD trade is already on, and the coins move together/);
  assert.equal(skipCategory(full.reason), 'Correlated position already open');
  assert.equal(LIMITS.together, 3);
  // The same during the week.
  assert.match(account({ weekendOn: false, links: [open('ETHUSD', 1)] }).brain.allow(fund.byId.get('viktor'), pos, {}).reason, /one trade per correlated group/);
  // The plan says so.
  const st = account({ weekendRecord: { v: 1, desks: [] } }).brain.state();
  assert.ok(st.rules.some((r) => /^Weekend: the desks day-trade crypto \(Bitcoin and Ether\) until Sunday 18:00 New York/.test(r.text)));
});

test('the weekend record ships with the floor: every desk that switches, replayed on real Bitcoin weekends', () => {
  const data = loadBaseline(WEEKEND_FILE, { warn: (m) => assert.fail(m) });
  assert.ok(data);
  const b = new Baseline(data);
  const switching = ROSTER.filter((p) => p.weekendSymbol);
  assert.equal(switching.length, 6);
  for (const p of switching) {
    const d = data.desks.find((x) => x.id === p.id);
    assert.ok(d, p.id);
    assert.equal(d.market, p.weekendSymbol);
    assert.match(d.label, /^\d+ Bitcoin weekends \(Jan 2017 – (Nov|Dec) 2018\)$/);
  }
  const judged = switching.map((p) => b.forDesk(p.id)).filter(Boolean);
  assert.ok(judged.length >= 6);
  assert.match(b.recordText(judged[0]), /Bitcoin weekends/);
});
