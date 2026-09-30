import fs from 'node:fs';
import path from 'node:path';

// Alerts on the boss's phone through their own Telegram bot. Set up in the FTMO tab:
//   1. create a bot with @BotFather and paste its token here;
//   2. send the bot any message ("hi") and press "Find my chat";
//   3. "Send a test message".
// The bot token is a secret: it is kept in data/telegram.json (readable only by you) and
// never sent back to the browser. Messages are plain text, one at a time, and a failing
// Telegram never affects trading.

const API = 'https://api.telegram.org';
const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
const CHAT_RE = /^-?\d{1,20}$/;
const GAP_MS = 1100; // Telegram allows about one message a second per chat
const QUEUE_MAX = 40;

export const ALERT_KINDS = {
  trade: 'Trades on the account (opened, closed, rejected)',
  guard: 'Risk guard and profit target',
  connection: 'MT5 disconnected / back',
  arming: 'Armed and disarmed',
  daily: 'Daily report at the end of the day',
};

const DEFAULT_KINDS = Object.fromEntries(Object.keys(ALERT_KINDS).map((k) => [k, true]));

export class TelegramNotifier {
  constructor({ dataDir, log = console, fetchImpl = (...a) => fetch(...a), gapMs = GAP_MS }) {
    this.file = path.join(dataDir, 'telegram.json');
    this.log = log;
    this.fetch = fetchImpl;
    this.gapMs = gapMs;
    this.queue = [];
    this.sending = false;
    this.lastError = null;
    this.lastSentAt = null;
    this.s = this.#load();
  }

  #load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { token: null, chatId: null, chatName: null, botName: null, enabled: false, ...s, kinds: { ...DEFAULT_KINDS, ...(s.kinds || {}) } };
    } catch {
      return { token: null, chatId: null, chatName: null, botName: null, enabled: false, kinds: { ...DEFAULT_KINDS } };
    }
  }

  #save() {
    try {
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.s, null, 1), { mode: 0o600 });
      fs.renameSync(`${this.file}.tmp`, this.file);
      fs.chmodSync(this.file, 0o600);
    } catch (err) {
      this.log.warn?.(`[telegram] could not save settings: ${err.message}`);
    }
  }

  async #call(method, body = null) {
    if (!this.s.token) throw new Error('No bot token yet');
    const url = `${API}/bot${this.s.token}/${method}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await this.fetch(url, body
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal }
        : { signal: ctrl.signal });
      let data = null;
      try {
        data = await res.json();
      } catch { /* not JSON */ }
      if (!res.ok || !data?.ok) {
        const err = new Error(data?.description || `Telegram answered HTTP ${res.status}`);
        err.status = res.status;
        err.retryAfter = data?.parameters?.retry_after;
        throw err;
      }
      return data.result;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Telegram did not answer (timed out)');
      if (!err.status && !/Telegram/.test(err.message)) throw new Error(`Could not reach Telegram (${err.message})`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- setup ------------------------------------------------------------------------------
  async setToken(token) {
    const t = String(token ?? '').trim();
    if (!TOKEN_RE.test(t)) return { ok: false, error: 'That doesn\'t look like a bot token. It looks like 123456789:AAH… and comes from @BotFather in Telegram.' };
    const prev = this.s.token;
    this.s.token = t;
    try {
      const me = await this.#call('getMe');
      this.s.botName = me.username ? `@${me.username}` : me.first_name || 'your bot';
      if (prev !== t) { this.s.chatId = null; this.s.chatName = null; }
      this.lastError = null;
      this.#save();
      return { ok: true, botName: this.s.botName };
    } catch (err) {
      this.s.token = prev;
      return { ok: false, error: err.status === 401 || err.status === 404 ? 'Telegram doesn\'t recognise that token. Copy it again from @BotFather.' : err.message };
    }
  }

  // The chat of whoever last messaged the bot (that's the boss, right after setting it up).
  async findChat() {
    if (!this.s.token) return { ok: false, error: 'Add your bot token first' };
    try {
      const updates = await this.#call('getUpdates', { limit: 50, timeout: 0 });
      const msgs = (updates || []).map((u) => u.message || u.edited_message || u.channel_post).filter((m) => m?.chat?.id != null);
      const m = msgs.at(-1);
      if (!m) return { ok: false, error: `No message found yet. Open ${this.s.botName || 'your bot'} in Telegram, press Start or send it "hi", then try again.` };
      this.s.chatId = String(m.chat.id);
      this.s.chatName = m.chat.title || [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ') || m.chat.username || 'your chat';
      this.s.enabled = true;
      this.lastError = null;
      this.#save();
      await this.#call('sendMessage', { chat_id: this.s.chatId, text: '👋 Meridian Capital here. Alerts from your trading floor will come to this chat.', disable_web_page_preview: true });
      return { ok: true, chatName: this.s.chatName };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async test() {
    if (!this.s.token || !this.s.chatId) return { ok: false, error: 'Finish the setup first (bot token and chat)' };
    try {
      await this.#call('sendMessage', { chat_id: this.s.chatId, text: '✅ Test from Meridian Capital: your trading floor alerts work.', disable_web_page_preview: true });
      this.lastSentAt = Date.now();
      this.lastError = null;
      return { ok: true };
    } catch (err) {
      this.lastError = { text: err.message, at: Date.now() };
      return { ok: false, error: err.message };
    }
  }

  settings(body = {}) {
    if (body.enabled != null) {
      if ((body.enabled === true || body.enabled === 'true') && (!this.s.token || !this.s.chatId)) return { ok: false, error: 'Finish the setup first (bot token and chat)' };
      this.s.enabled = body.enabled === true || body.enabled === 'true';
    }
    if (body.chatId != null) {
      const id = String(body.chatId).trim();
      if (!CHAT_RE.test(id)) return { ok: false, error: 'A chat id is a number, like 123456789' };
      this.s.chatId = id;
      this.s.chatName = null;
    }
    if (body.kinds && typeof body.kinds === 'object') {
      for (const k of Object.keys(ALERT_KINDS)) if (body.kinds[k] != null) this.s.kinds[k] = body.kinds[k] === true || body.kinds[k] === 'true';
    }
    this.#save();
    return { ok: true };
  }

  forget() {
    this.s = { token: null, chatId: null, chatName: null, botName: null, enabled: false, kinds: { ...DEFAULT_KINDS } };
    this.queue = [];
    this.#save();
    return { ok: true };
  }

  view() {
    const t = this.s.token;
    return {
      hasToken: !!t,
      token: t ? `${t.split(':')[0]}:…${t.slice(-4)}` : null,
      botName: this.s.botName,
      chatId: this.s.chatId,
      chatName: this.s.chatName,
      enabled: !!(this.s.enabled && t && this.s.chatId),
      kinds: this.s.kinds,
      kindLabels: ALERT_KINDS,
      lastError: this.lastError,
      lastSentAt: this.lastSentAt,
      queued: this.queue.length,
    };
  }

  // ---- sending ------------------------------------------------------------------------------
  // Queue an alert of `kind` if the boss wants that kind. Never throws, never blocks.
  notify({ kind, text }) {
    if (!this.s.enabled || !this.s.token || !this.s.chatId || !this.s.kinds[kind] || !text) return false;
    if (this.queue.length >= QUEUE_MAX) {
      // Flooded (a storm of trades): drop the oldest trade message, keep the important ones.
      const i = this.queue.findIndex((q) => q.kind === 'trade');
      if (i >= 0) this.queue.splice(i, 1);
      else return false;
    }
    this.queue.push({ kind, text: String(text).slice(0, 3500) });
    this.#pump();
    return true;
  }

  async #pump() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const msg = this.queue[0];
        try {
          await this.#call('sendMessage', { chat_id: this.s.chatId, text: msg.text, disable_web_page_preview: true });
          this.queue.shift();
          this.lastSentAt = Date.now();
          this.lastError = null;
        } catch (err) {
          this.lastError = { text: err.message, at: Date.now() };
          if (err.retryAfter) {
            await new Promise((r) => setTimeout(r, Math.min(60, err.retryAfter) * 1000));
            continue;
          }
          this.queue.shift(); // don't retry forever; the floor's own log still has it
          if (err.status === 401) {
            this.log.warn?.('[telegram] the bot token was revoked; alerts are paused until you add it again');
            this.s.enabled = false;
            this.#save();
            this.queue = [];
          }
        }
        if (this.queue.length) await new Promise((r) => setTimeout(r, this.gapMs));
      }
    } finally {
      this.sending = false;
    }
  }
}
