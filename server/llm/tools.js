import { SYMBOLS } from '../market/symbols.js';
import { deskOf, deskBrief, marketBrief, tradesSince, accountBrief } from './context.js';

// The tools Claude can use while it answers the boss in the Brain tab. Every one of them only
// reads: there is no tool that trades, arms, switches anything or sees a key or password.

const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });

export const CHAT_TOOLS = [
  {
    name: 'floor_overview',
    description: 'Every desk in one line each (market, session, stage, today\'s ideas and trades, why it did or didn\'t trade, open position, record), plus the markets that have no prices and why. Start here for "how is the floor doing" or "why no trades".',
    input_schema: obj({}),
  },
  {
    name: 'desk_detail',
    description: 'One desk in full: its top-down read, current setup and stage, today\'s story, open position, last trades and record. Pass the desk id or first name (e.g. "marcus").',
    input_schema: obj({ desk: { type: 'string' } }),
  },
  {
    name: 'market',
    description: 'One market as the desks read it: price, status, weekly/daily/4-hour bias, areas of interest near price, news ahead. Pass the floor symbol, e.g. NAS100, XAUUSD, EURUSD, BTCUSD.',
    input_schema: obj({ symbol: { type: 'string' } }),
  },
  {
    name: 'trades',
    description: 'Closed trades over the last N days (1-30), for one desk or all ("" for all), with R and exit reason, and your verdict on each where you gave one.',
    input_schema: obj({ desk: { type: 'string' }, days: { type: 'integer' } }),
  },
  {
    name: 'account',
    description: 'The FTMO account through MT5: connected or not, set up, armed, balance and equity, what reached the account today and what was held back and why, the FTMO tab\'s warnings, and how many days of price history each market has.',
    input_schema: obj({}),
  },
  {
    name: 'lessons',
    description: 'Your lesson book (with how often each lesson was right) and the desks\' own recent lessons from the floor memory.',
    input_schema: obj({}),
  },
  {
    name: 'my_reviews',
    description: 'Your recent verdicts on setups, how each turned out, and your record (whether your skips really lost and your takes really won).',
    input_schema: obj({ count: { type: 'integer' } }),
  },
];

export function runTool(name, input, { floor, brain }) {
  const fund = floor.fund;
  switch (name) {
    case 'floor_overview':
      return {
        desks: fund.agents.map(deskBrief),
        waitingForPrices: floor.feeds?.reasons?.() ?? [],
      };
    case 'desk_detail': {
      const a = deskOf(fund, input.desk);
      if (!a) return { error: `No desk called "${input.desk}". Desks: ${fund.agents.map((x) => `${x.id} (${x.profile.name})`).join(', ')}` };
      return {
        ...deskBrief(a),
        desk: a.profile.desk,
        marketRead: marketBrief(floor, a.symbol),
        setup: a.pb?.pending ? { side: a.pb.pending.side, entry: a.pb.pending.entry, stop: a.pb.pending.stop, target: a.pb.pending.target, reason: a.pb.pending.reason } : null,
        recentNotes: a.log.slice(-8).map((l) => l.text),
        lastTrades: tradesSince(fund, 0, { desk: a.id, max: 10 }),
      };
    }
    case 'market': {
      const symbol = String(input.symbol || '').toUpperCase();
      if (!SYMBOLS[symbol]) return { error: `Unknown market "${input.symbol}". Markets: ${Object.keys(SYMBOLS).join(', ')}` };
      return marketBrief(floor, symbol);
    }
    case 'trades': {
      const days = Math.max(1, Math.min(30, Number(input.days) || 1));
      const desk = input.desk ? deskOf(fund, input.desk)?.id ?? null : null;
      if (input.desk && !desk) return { error: `No desk called "${input.desk}"` };
      const since = (fund.clock?.now?.() ?? Date.now()) - days * 86_400_000;
      return { days, trades: tradesSince(fund, since, { desk, max: 80 }) };
    }
    case 'account':
      return accountBrief(floor.live) ?? { error: 'The FTMO connection isn\'t running.' };
    case 'lessons':
      return {
        lessonBook: brain.lessonsView(),
        deskLessons: (floor.memory?.state?.lessons || []).slice(-15).map((l) => ({ desk: l.agentId, lesson: l.title })),
      };
    case 'my_reviews':
      return { record: brain.record(), reviews: brain.reviewsView(Math.max(1, Math.min(40, Number(input.count) || 10))) };
    default:
      return { error: `Unknown tool ${name}` };
  }
}
