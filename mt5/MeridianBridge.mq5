//+------------------------------------------------------------------+
//|                                              MeridianBridge.mq5  |
//|  Links this MetaTrader 5 account (e.g. an FTMO Free Trial,       |
//|  Challenge or FTMO Account) to the Meridian Trading Floor that   |
//|  runs on the same computer.                                      |
//|                                                                  |
//|  Every sync it sends the floor: account balance/equity, open     |
//|  positions, today's deals, prices and 1-minute bars for the      |
//|  markets the floor trades. It receives orders back (open, close, |
//|  partial close, move stop, close all) and executes them here.    |
//|  Every order is sent with a stop-loss attached.                  |
//|                                                                  |
//|  Setup: Tools > Options > Expert Advisors                        |
//|    [x] Allow algorithmic trading                                 |
//|    [x] Allow WebRequest for listed URL:  http://127.0.0.1:3000   |
//|  Attach to any chart, paste the bridge token from the floor's    |
//|  FTMO tab into the inputs, and switch on "Algo Trading".         |
//+------------------------------------------------------------------+
#property copyright   "Meridian Trading Floor"
#property version     "1.20"
#property description "Bridge between this MT5 account and the Meridian Trading Floor (http://127.0.0.1:3000)."

#include <Trade\Trade.mqh>

input string InpUrl    = "http://127.0.0.1:3000/api/bridge/sync"; // Floor bridge URL
input string InpToken  = "";                                      // Bridge token (copy it from the floor's FTMO tab)
input int    InpSyncMs = 500;                                     // Fastest sync interval in milliseconds (the floor slows it down when nothing is happening)
// Safety caps enforced here in MT5, whatever the floor sends (the last line of defence):
input double InpMaxRiskPct   = 1.0;                                 // Max risk per order, % of balance (stop-loss distance x volume)
input int    InpMaxPositions = 8;                                   // Max floor positions open at the same time

#define EA_VERSION  "1.2.0"
#define MAGIC_MIN   771000
#define MAGIC_MAX   771099
#define DONE_SLOTS  256

CTrade   g_trade;
string   g_watch[];               // broker symbols the floor wants prices for
string   g_historyReq[];          // "SYMBOL|COUNT" history requests to answer
bool     g_sendSymbols = true;    // send the full symbol list on the next sync
string   g_acks        = "";      // JSON acknowledgements waiting to be delivered
string   g_done[];                // ids of commands already executed (dedupe)
int      g_doneNext    = 0;
long     g_login       = 0;
double   g_initialDeposit = 0;
string   g_lastError   = "";
datetime g_lastOk      = 0;
int      g_timerMs     = 0;       // current sync interval (the floor sets the pace, EA 1.2+)
string   g_comment     = "";      // what the chart shows now (redrawn only when it changes)
string   g_dealsJson   = "[]";    // today's deals, re-read only after a trade (OnTrade) or every 30 s
double   g_closedToday = 0;
bool     g_dealsDirty  = true;
long     g_dealsDay    = -1;
datetime g_dealsAt     = 0;

//+------------------------------------------------------------------+
int OnInit()
  {
   if(MQLInfoInteger(MQL_TESTER))
     {
      Print("MeridianBridge does not run in the Strategy Tester.");
      return(INIT_FAILED);
     }
   if(StringLen(InpToken) < 8)
     {
      Alert("MeridianBridge: paste the bridge token from the floor's FTMO tab into the EA inputs.");
      return(INIT_PARAMETERS_INCORRECT);
     }
   ArrayResize(g_done, DONE_SLOTS);
   for(int i = 0; i < DONE_SLOTS; i++)
      g_done[i] = "";
   g_trade.SetDeviationInPoints(30);
   g_trade.SetAsyncMode(false);
   SetPace(InpSyncMs);
   Comment("Meridian Bridge: connecting to the floor...");
   return(INIT_SUCCEEDED);
  }

// How often to sync. The floor asks for fast syncs only while orders are on their way or a
// desk is about to trade, and slow ones when nothing is happening: far fewer wake-ups for
// MT5, which saves a lot of a MacBook's battery. Never faster than InpSyncMs.
void SetPace(const int ms)
  {
   int want = (int)MathMax(MathMax(200, InpSyncMs), MathMin(5000, ms));
   if(want == g_timerMs)
      return;
   EventKillTimer();
   EventSetMillisecondTimer(want);
   g_timerMs = want;
  }

// A trade happened (an order filled, a stop or target hit): read today's deals again.
void OnTrade()
  {
   g_dealsDirty = true;
  }

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   EventKillTimer();
   g_timerMs = 0;   // a chart change keeps the globals: OnInit must start the timer again
   g_comment = "";
   Comment("");
  }

//+------------------------------------------------------------------+
void OnTimer()
  {
   Sync();
  }

//+------------------------------------------------------------------+
//| JSON helpers                                                     |
//+------------------------------------------------------------------+
string Esc(string s)
  {
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   StringReplace(s, "\n", " ");
   StringReplace(s, "\r", " ");
   return(s);
  }

string Q(const string s)
  {
   return("\"" + Esc(s) + "\"");
  }

string D(const double v, const int digits = 8)
  {
   if(!MathIsValidNumber(v))
      return("0");
   return(DoubleToString(v, digits));
  }

string B(const bool v)
  {
   return(v ? "true" : "false");
  }

//+------------------------------------------------------------------+
//| Account and history                                              |
//+------------------------------------------------------------------+
double InitialDeposit()
  {
   if(!HistorySelect(0, TimeCurrent() + 86400))
      return(0);
   int n = HistoryDealsTotal();
   for(int i = 0; i < n; i++)
     {
      ulong t = HistoryDealGetTicket(i);
      if(t == 0)
         continue;
      if(HistoryDealGetInteger(t, DEAL_TYPE) == DEAL_TYPE_BALANCE)
         return(HistoryDealGetDouble(t, DEAL_PROFIT));
     }
   return(0);
  }

// Deals since the start of the trading server's day. FTMO measures the daily loss
// from the balance at the start of the server day.
string DealsJson(double &closedToday)
  {
   closedToday = 0;
   datetime now = TimeTradeServer();
   datetime dayStart = (datetime)(((long)now / 86400) * 86400);
   if(!HistorySelect(dayStart, now + 3600))
      return("[]");
   int n = HistoryDealsTotal();
   int from = (int)MathMax(0, n - 40);
   string out = "[";
   int written = 0;
   for(int i = 0; i < n; i++)
     {
      ulong t = HistoryDealGetTicket(i);
      if(t == 0)
         continue;
      long type = HistoryDealGetInteger(t, DEAL_TYPE);
      if(type != DEAL_TYPE_BUY && type != DEAL_TYPE_SELL)
         continue;
      double pnl = HistoryDealGetDouble(t, DEAL_PROFIT) + HistoryDealGetDouble(t, DEAL_SWAP)
                   + HistoryDealGetDouble(t, DEAL_COMMISSION) + HistoryDealGetDouble(t, DEAL_FEE);
      closedToday += pnl;
      if(i < from)
         continue;
      if(written > 0)
         out += ",";
      written++;
      out += "{\"ticket\":" + IntegerToString((long)t)
             + ",\"position\":" + IntegerToString(HistoryDealGetInteger(t, DEAL_POSITION_ID))
             + ",\"symbol\":" + Q(HistoryDealGetString(t, DEAL_SYMBOL))
             + ",\"type\":" + IntegerToString(type)
             + ",\"entry\":" + IntegerToString(HistoryDealGetInteger(t, DEAL_ENTRY))
             + ",\"volume\":" + D(HistoryDealGetDouble(t, DEAL_VOLUME), 2)
             + ",\"price\":" + D(HistoryDealGetDouble(t, DEAL_PRICE))
             + ",\"pnl\":" + D(pnl, 2)
             + ",\"magic\":" + IntegerToString(HistoryDealGetInteger(t, DEAL_MAGIC))
             + ",\"comment\":" + Q(HistoryDealGetString(t, DEAL_COMMENT))
             + ",\"time\":" + IntegerToString(HistoryDealGetInteger(t, DEAL_TIME))
             + "}";
     }
   return(out + "]");
  }

string AccountJson(const double closedToday)
  {
   bool algo = (TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) != 0) && (MQLInfoInteger(MQL_TRADE_ALLOWED) != 0);
   return("{\"login\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))
          + ",\"server\":" + Q(AccountInfoString(ACCOUNT_SERVER))
          + ",\"company\":" + Q(AccountInfoString(ACCOUNT_COMPANY))
          + ",\"name\":" + Q(AccountInfoString(ACCOUNT_NAME))
          + ",\"currency\":" + Q(AccountInfoString(ACCOUNT_CURRENCY))
          + ",\"balance\":" + D(AccountInfoDouble(ACCOUNT_BALANCE), 2)
          + ",\"equity\":" + D(AccountInfoDouble(ACCOUNT_EQUITY), 2)
          + ",\"margin\":" + D(AccountInfoDouble(ACCOUNT_MARGIN), 2)
          + ",\"freeMargin\":" + D(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2)
          + ",\"leverage\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LEVERAGE))
          + ",\"tradeMode\":" + IntegerToString(AccountInfoInteger(ACCOUNT_TRADE_MODE))
          + ",\"marginMode\":" + IntegerToString(AccountInfoInteger(ACCOUNT_MARGIN_MODE))
          + ",\"tradeAllowed\":" + B(AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) != 0)
          + ",\"expertAllowed\":" + B(AccountInfoInteger(ACCOUNT_TRADE_EXPERT) != 0)
          + ",\"algoAllowed\":" + B(algo)
          + ",\"connected\":" + B(TerminalInfoInteger(TERMINAL_CONNECTED) != 0)
          + ",\"initialDeposit\":" + D(g_initialDeposit, 2)
          + ",\"closedToday\":" + D(closedToday, 2)
          + "}");
  }

string PositionsJson()
  {
   string out = "[";
   int n = PositionsTotal();
   int written = 0;
   for(int i = 0; i < n; i++)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0)
         continue;
      if(written > 0)
         out += ",";
      written++;
      string sym = PositionGetString(POSITION_SYMBOL);
      int dg = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      out += "{\"ticket\":" + IntegerToString((long)ticket)
             + ",\"symbol\":" + Q(sym)
             + ",\"side\":" + Q(PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "BUY" : "SELL")
             + ",\"volume\":" + D(PositionGetDouble(POSITION_VOLUME), 2)
             + ",\"open\":" + D(PositionGetDouble(POSITION_PRICE_OPEN), dg)
             + ",\"current\":" + D(PositionGetDouble(POSITION_PRICE_CURRENT), dg)
             + ",\"sl\":" + D(PositionGetDouble(POSITION_SL), dg)
             + ",\"tp\":" + D(PositionGetDouble(POSITION_TP), dg)
             + ",\"profit\":" + D(PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP), 2)
             + ",\"magic\":" + IntegerToString(PositionGetInteger(POSITION_MAGIC))
             + ",\"comment\":" + Q(PositionGetString(POSITION_COMMENT))
             + ",\"time\":" + IntegerToString(PositionGetInteger(POSITION_TIME))
             + "}";
     }
   return(out + "]");
  }

//+------------------------------------------------------------------+
//| Market data                                                      |
//+------------------------------------------------------------------+
string RatesJson(MqlRates &r[], const int count, const int dg)
  {
   string out = "[";
   for(int i = 0; i < count; i++)
     {
      if(i > 0)
         out += ",";
      out += "[" + IntegerToString((long)r[i].time) + "," + D(r[i].open, dg) + "," + D(r[i].high, dg) + ","
             + D(r[i].low, dg) + "," + D(r[i].close, dg) + "," + IntegerToString(r[i].tick_volume) + "]";
     }
   return(out + "]");
  }

string QuotesJson()
  {
   string out = "{";
   int written = 0;
   for(int i = 0; i < ArraySize(g_watch); i++)
     {
      string s = g_watch[i];
      if(StringLen(s) == 0 || !SymbolSelect(s, true))
         continue;
      int dg = (int)SymbolInfoInteger(s, SYMBOL_DIGITS);
      MqlRates r[];
      int got = CopyRates(s, PERIOD_M1, 0, 2, r);
      if(got < 0)
         got = 0;
      double tvLoss = SymbolInfoDouble(s, SYMBOL_TRADE_TICK_VALUE_LOSS);
      if(tvLoss <= 0)
         tvLoss = SymbolInfoDouble(s, SYMBOL_TRADE_TICK_VALUE);
      if(written > 0)
         out += ",";
      written++;
      out += Q(s) + ":{\"bid\":" + D(SymbolInfoDouble(s, SYMBOL_BID), dg)
             + ",\"ask\":" + D(SymbolInfoDouble(s, SYMBOL_ASK), dg)
             + ",\"digits\":" + IntegerToString(dg)
             + ",\"point\":" + D(SymbolInfoDouble(s, SYMBOL_POINT), 10)
             + ",\"tickSize\":" + D(SymbolInfoDouble(s, SYMBOL_TRADE_TICK_SIZE), 10)
             + ",\"tickValue\":" + D(SymbolInfoDouble(s, SYMBOL_TRADE_TICK_VALUE), 10)
             + ",\"tickValueLoss\":" + D(tvLoss, 10)
             + ",\"contractSize\":" + D(SymbolInfoDouble(s, SYMBOL_TRADE_CONTRACT_SIZE), 4)
             + ",\"volMin\":" + D(SymbolInfoDouble(s, SYMBOL_VOLUME_MIN), 4)
             + ",\"volStep\":" + D(SymbolInfoDouble(s, SYMBOL_VOLUME_STEP), 4)
             + ",\"volMax\":" + D(SymbolInfoDouble(s, SYMBOL_VOLUME_MAX), 4)
             + ",\"stopsLevel\":" + IntegerToString(SymbolInfoInteger(s, SYMBOL_TRADE_STOPS_LEVEL))
             + ",\"tradeMode\":" + IntegerToString(SymbolInfoInteger(s, SYMBOL_TRADE_MODE))
             + ",\"bars\":" + RatesJson(r, got, dg)
             + "}";
     }
   return(out + "}");
  }

string HistoryJson()
  {
   string out = "{";
   int written = 0;
   for(int i = 0; i < ArraySize(g_historyReq); i++)
     {
      string parts[];
      if(StringSplit(g_historyReq[i], '|', parts) < 2)
         continue;
      string s = parts[0];
      int count = (int)StringToInteger(parts[1]);
      if(!SymbolSelect(s, true))
         continue;
      MqlRates r[];
      int got = CopyRates(s, PERIOD_M1, 1, count, r);   // closed bars only
      if(got <= 0)
         continue;                                        // not downloaded yet; the floor asks again
      if(written > 0)
         out += ",";
      written++;
      out += Q(s) + ":" + RatesJson(r, got, (int)SymbolInfoInteger(s, SYMBOL_DIGITS));
     }
   return(out + "}");
  }

string SymbolsJson()
  {
   string out = "[";
   int n = SymbolsTotal(false);
   for(int i = 0; i < n; i++)
     {
      if(i > 0)
         out += ",";
      out += Q(SymbolName(i, false));
     }
   return(out + "]");
  }

//+------------------------------------------------------------------+
//| Sync with the floor                                              |
//+------------------------------------------------------------------+
void Sync()
  {
   long login = AccountInfoInteger(ACCOUNT_LOGIN);
   if(login != g_login)
     {
      g_login = login;
      g_initialDeposit = InitialDeposit();
      g_sendSymbols = true;
     }
   datetime srv = TimeTradeServer();
   long day = (long)srv / 86400;
   if(g_dealsDirty || day != g_dealsDay || TimeLocal() - g_dealsAt >= 30)
     {
      g_dealsJson = DealsJson(g_closedToday);
      g_dealsDirty = false;
      g_dealsDay = day;
      g_dealsAt = TimeLocal();
     }
   double closedToday = g_closedToday;
   string deals = g_dealsJson;

   string body = "{\"token\":" + Q(InpToken)
                 + ",\"version\":" + Q(EA_VERSION)
                 + ",\"caps\":{\"maxRiskPct\":" + D(InpMaxRiskPct, 2) + ",\"maxPositions\":" + IntegerToString(InpMaxPositions) + "}"
                 + ",\"account\":" + AccountJson(closedToday)
                 + ",\"positions\":" + PositionsJson()
                 + ",\"deals\":" + deals
                 + ",\"quotes\":" + QuotesJson()
                 + ",\"serverTime\":" + IntegerToString((long)srv)
                 + ",\"gmtOffset\":" + IntegerToString((long)srv - (long)TimeGMT())
                 + ",\"serverDay\":" + Q(TimeToString(srv, TIME_DATE))
                 + ",\"acks\":[" + g_acks + "]";
   bool sentSymbols = g_sendSymbols;
   bool sentHistory = ArraySize(g_historyReq) > 0;
   if(sentSymbols)
      body += ",\"symbols\":" + SymbolsJson();
   if(sentHistory)
      body += ",\"history\":" + HistoryJson();
   body += "}";

   char data[];
   char result[];
   string resHeaders;
   int len = StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(len > 0)
      ArrayResize(data, len - 1);   // drop the terminating zero
   string headers = "Content-Type: application/json\r\nX-Bridge-Token: " + InpToken + "\r\n";
   ResetLastError();
   int code = WebRequest("POST", InpUrl, headers, 4000, data, result, resHeaders);
   if(code == -1)
     {
      int err = GetLastError();
      string msg = (err == 4014)
                   ? "WebRequest is blocked. Tools > Options > Expert Advisors > allow WebRequest for http://127.0.0.1:3000"
                   : "Floor not reachable (error " + IntegerToString(err) + "). Is the floor running (npm start)?";
      Status(msg, true);
      SetPace(2000);   // no floor to talk to: knock every 2 seconds, not twice a second
      return;
     }
   string reply = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   if(code != 200)
     {
      Status("Floor refused the sync (HTTP " + IntegerToString(code) + "): " + reply, true);
      return;
     }
   // Delivered: clear what the floor has now received.
   g_acks = "";
   if(sentSymbols)
      g_sendSymbols = false;
   if(sentHistory)
      ArrayResize(g_historyReq, 0);
   g_lastOk = TimeLocal();
   Handle(reply);
   Status("Connected to the floor", false);
  }

// The chart comment. Redrawing it makes MT5 repaint the chart, so it changes only when there
// is news (and the last-sync time is shown to the minute).
void Status(const string msg, const bool isError)
  {
   if(isError && msg != g_lastError)
      Print("MeridianBridge: ", msg);
   g_lastError = isError ? msg : "";
   string text = "Meridian Bridge v" + EA_VERSION + "\n" + msg
                 + "\nAccount " + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + " on " + AccountInfoString(ACCOUNT_SERVER)
                 + "\nWatching " + IntegerToString(ArraySize(g_watch)) + " symbols, syncing every " + DoubleToString(g_timerMs / 1000.0, 1) + " s"
                 + (g_lastOk > 0 ? "\nLast sync " + TimeToString(g_lastOk, TIME_MINUTES) : "");
   if(text == g_comment)
      return;
   g_comment = text;
   Comment(text);
  }

//+------------------------------------------------------------------+
//| Commands from the floor (one per line, fields separated by '|')  |
//+------------------------------------------------------------------+
void Handle(const string text)
  {
   string lines[];
   int n = StringSplit(text, '\n', lines);
   for(int i = 0; i < n; i++)
     {
      string line = lines[i];
      StringTrimLeft(line);
      StringTrimRight(line);
      if(StringLen(line) == 0 || line == "OK")
         continue;
      string f[];
      int k = StringSplit(line, '|', f);
      if(k < 1)
         continue;
      string cmd = f[0];
      if(cmd == "watch")
         StringSplit(k > 1 ? f[1] : "", ',', g_watch);
      else if(cmd == "history" && k >= 3)
        {
         int sz = ArraySize(g_historyReq);
         ArrayResize(g_historyReq, sz + 1);
         g_historyReq[sz] = f[1] + "|" + f[2];
        }
      else if(cmd == "symbols")
         g_sendSymbols = true;
      else if(cmd == "pace" && k >= 2)
         SetPace((int)StringToInteger(f[1]));
      else if(cmd == "open" && k >= 9)
         DoOpen(f);
      else if(cmd == "close" && k >= 4)
         DoClose(f);
      else if(cmd == "modify" && k >= 5)
         DoModify(f);
      else if(cmd == "closeall" && k >= 3)
         DoCloseAll(f);
     }
  }

// Positions the floor opened (its magic numbers). The floor never touches your own trades.
bool IsFloorMagic(const long mg)
  {
   return(mg > MAGIC_MIN && mg <= MAGIC_MAX);
  }

int FloorPositions()
  {
   int n = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      if(PositionGetTicket(i) == 0)
         continue;
      if(IsFloorMagic(PositionGetInteger(POSITION_MAGIC)))
         n++;
     }
   return(n);
  }

bool Seen(const string id)
  {
   for(int i = 0; i < ArraySize(g_done); i++)
      if(g_done[i] == id)
         return(true);
   return(false);
  }

void Remember(const string id)
  {
   g_done[g_doneNext] = id;
   g_doneNext = (g_doneNext + 1) % DONE_SLOTS;
  }

void Ack(const string id, const bool ok, const uint retcode, const ulong ticket, const double price, const double volume, const string msg)
  {
   string a = "{\"id\":" + Q(id) + ",\"ok\":" + B(ok) + ",\"retcode\":" + IntegerToString(retcode)
              + ",\"ticket\":" + IntegerToString((long)ticket) + ",\"price\":" + D(price)
              + ",\"volume\":" + D(volume, 2) + ",\"msg\":" + Q(msg) + "}";
   if(StringLen(g_acks) > 0)
      g_acks += ",";
   g_acks += a;
  }

bool Done(const uint rc)
  {
   return(rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_PLACED || rc == TRADE_RETCODE_DONE_PARTIAL);
  }

double NormVol(const string sym, double vol)
  {
   double step = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   double vmin = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   double vmax = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   if(step <= 0)
      step = 0.01;
   vol = MathFloor(vol / step + 1e-9) * step;
   if(vol < vmin - 1e-9)
      return(0);
   if(vol > vmax)
      vol = vmax;
   int digits = (int)MathMax(0, MathCeil(-MathLog10(step) - 1e-9));
   return(NormalizeDouble(vol, digits));
  }

// open|id|SYMBOL|BUY|volume|slDistance|tpDistance|magic|comment
void DoOpen(string &f[])
  {
   string id = f[1];
   if(Seen(id))
     {
      Ack(id, true, 0, 0, 0, 0, "duplicate");
      return;
     }
   Remember(id);
   string sym = f[2];
   bool buy = (f[3] == "BUY");
   double slDist = StringToDouble(f[5]);
   double tpDist = StringToDouble(f[6]);
   ulong magic = (ulong)StringToInteger(f[7]);
   string comment = f[8];
   if(!IsFloorMagic((long)magic))
     {
      Ack(id, false, 0, 0, 0, 0, "refused by the EA: not a floor order");
      return;
     }
   if(f[3] != "BUY" && f[3] != "SELL")
     {
      Ack(id, false, 0, 0, 0, 0, "refused by the EA: bad side");
      return;
     }
   // Already placed (e.g. the EA was reloaded before its confirmation reached the floor):
   // every floor order has a unique comment, so never open it twice.
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i);
      if(t == 0 || PositionGetString(POSITION_COMMENT) != comment || !IsFloorMagic(PositionGetInteger(POSITION_MAGIC)))
         continue;
      Ack(id, true, 0, t, PositionGetDouble(POSITION_PRICE_OPEN), PositionGetDouble(POSITION_VOLUME), "already open");
      return;
     }
   if(InpMaxPositions > 0 && FloorPositions() >= InpMaxPositions)
     {
      Ack(id, false, 0, 0, 0, 0, "refused by the EA: " + IntegerToString(InpMaxPositions) + " floor positions already open (EA safety cap)");
      return;
     }
   if(!SymbolSelect(sym, true))
     {
      Ack(id, false, 0, 0, 0, 0, "unknown symbol " + sym);
      return;
     }
   if(slDist <= 0)
     {
      Ack(id, false, 0, 0, 0, 0, "refused: no stop-loss distance");
      return;
     }
   double vol = NormVol(sym, StringToDouble(f[4]));
   if(vol <= 0)
     {
      Ack(id, false, 0, 0, 0, 0, "volume below the symbol minimum");
      return;
     }
   int dg = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   double minDist = (double)SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL) * point + 2 * point;
   if(slDist < minDist)
      slDist = minDist;
   if(tpDist > 0 && tpDist < minDist)
      tpDist = minDist;
   // Risk cap: what this order loses if its stop-loss is hit, against the balance.
   double tickSize = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
   double tickLoss = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE_LOSS);
   if(tickLoss <= 0)
      tickLoss = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE);
   if(InpMaxRiskPct > 0)
     {
      double balance = AccountInfoDouble(ACCOUNT_BALANCE);
      double risk = (tickSize > 0 && tickLoss > 0) ? slDist / tickSize * tickLoss * vol : -1.0;
      if(risk < 0 || risk > balance * InpMaxRiskPct / 100.0)
        {
         Ack(id, false, 0, 0, 0, 0, risk < 0 ? "refused by the EA: cannot measure the order's risk"
             : "refused by the EA: risk " + DoubleToString(risk, 2) + " is above the " + DoubleToString(InpMaxRiskPct, 2) + "% cap (EA safety cap)");
         return;
        }
     }
   double price = buy ? SymbolInfoDouble(sym, SYMBOL_ASK) : SymbolInfoDouble(sym, SYMBOL_BID);
   double sl = NormalizeDouble(buy ? price - slDist : price + slDist, dg);
   double tp = (tpDist > 0) ? NormalizeDouble(buy ? price + tpDist : price - tpDist, dg) : 0.0;
   g_trade.SetExpertMagicNumber(magic);
   g_trade.SetTypeFillingBySymbol(sym);
   bool ok = buy ? g_trade.Buy(vol, sym, 0.0, sl, tp, comment) : g_trade.Sell(vol, sym, 0.0, sl, tp, comment);
   uint rc = g_trade.ResultRetcode();
   ok = ok && Done(rc);
   Ack(id, ok, rc, g_trade.ResultOrder(), g_trade.ResultPrice(), g_trade.ResultVolume(), g_trade.ResultRetcodeDescription());
  }

// close|id|ticket|fraction
void DoClose(string &f[])
  {
   string id = f[1];
   if(Seen(id))
     {
      Ack(id, true, 0, 0, 0, 0, "duplicate");
      return;
     }
   Remember(id);
   ulong ticket = (ulong)StringToInteger(f[2]);
   double frac = StringToDouble(f[3]);
   if(!PositionSelectByTicket(ticket))
     {
      Ack(id, true, 0, ticket, 0, 0, "position already closed");
      return;
     }
   if(!IsFloorMagic(PositionGetInteger(POSITION_MAGIC)))
     {
      Ack(id, false, 0, ticket, 0, 0, "refused by the EA: not a floor position");
      return;
     }
   if(frac <= 0)
     {
      Ack(id, false, 0, ticket, 0, 0, "refused by the EA: bad close fraction");
      return;
     }
   string sym = PositionGetString(POSITION_SYMBOL);
   double vol = PositionGetDouble(POSITION_VOLUME);
   g_trade.SetExpertMagicNumber((ulong)PositionGetInteger(POSITION_MAGIC));
   g_trade.SetTypeFillingBySymbol(sym);
   bool ok;
   double closed = vol;
   if(frac >= 0.999)
      ok = g_trade.PositionClose(ticket);
   else
     {
      closed = NormVol(sym, vol * frac);
      if(closed <= 0 || closed >= vol)
        {
         Ack(id, false, 0, ticket, 0, 0, "partial volume not tradable");
         return;
        }
      ok = g_trade.PositionClosePartial(ticket, closed);
     }
   uint rc = g_trade.ResultRetcode();
   ok = ok && Done(rc);
   Ack(id, ok, rc, ticket, g_trade.ResultPrice(), closed, g_trade.ResultRetcodeDescription());
  }

// modify|id|ticket|sl|tp   (tp may be "keep")
void DoModify(string &f[])
  {
   string id = f[1];
   if(Seen(id))
     {
      Ack(id, true, 0, 0, 0, 0, "duplicate");
      return;
     }
   Remember(id);
   ulong ticket = (ulong)StringToInteger(f[2]);
   if(!PositionSelectByTicket(ticket))
     {
      Ack(id, true, 0, ticket, 0, 0, "position already closed");
      return;
     }
   if(!IsFloorMagic(PositionGetInteger(POSITION_MAGIC)))
     {
      Ack(id, false, 0, ticket, 0, 0, "refused by the EA: not a floor position");
      return;
     }
   string sym = PositionGetString(POSITION_SYMBOL);
   int dg = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double sl = NormalizeDouble(StringToDouble(f[3]), dg);
   // The floor only ever tightens a stop. Removing it or moving it further away is refused.
   double curSl = PositionGetDouble(POSITION_SL);
   bool isBuy = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
   if(sl <= 0 || (curSl > 0 && (isBuy ? sl < curSl : sl > curSl)))
     {
      Ack(id, false, 0, ticket, 0, 0, "refused by the EA: a stop-loss can only be tightened");
      return;
     }
   double tp = (f[4] == "keep") ? PositionGetDouble(POSITION_TP) : NormalizeDouble(StringToDouble(f[4]), dg);
   bool ok = g_trade.PositionModify(ticket, sl, tp);
   uint rc = g_trade.ResultRetcode();
   ok = ok && Done(rc);
   Ack(id, ok, rc, ticket, sl, 0, g_trade.ResultRetcodeDescription());
  }

// closeall|id|bridge   (only ever positions opened by the floor; your own trades are never touched)
void DoCloseAll(string &f[])
  {
   string id = f[1];
   if(Seen(id))
     {
      Ack(id, true, 0, 0, 0, 0, "duplicate");
      return;
     }
   Remember(id);
   int failed = 0;
   int closed = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i);
      if(t == 0)
         continue;
      long mg = PositionGetInteger(POSITION_MAGIC);
      if(!IsFloorMagic(mg))
         continue;
      g_trade.SetTypeFillingBySymbol(PositionGetString(POSITION_SYMBOL));
      if(g_trade.PositionClose(t) && Done(g_trade.ResultRetcode()))
         closed++;
      else
         failed++;
     }
   Ack(id, failed == 0, 0, 0, 0, closed, "closed " + IntegerToString(closed) + (failed > 0 ? ", failed " + IntegerToString(failed) : ""));
  }
//+------------------------------------------------------------------+
