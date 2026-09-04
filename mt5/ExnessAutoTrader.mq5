//+------------------------------------------------------------------+
//|                                            ExnessAutoTrader.mq5   |
//|   Multi-pair auto-trading Expert Advisor for MetaTrader 5        |
//|                                                                  |
//|   Strategy (ported from the Crypto Signal Engine):              |
//|     - EMA fast/slow crossover on the trading timeframe          |
//|     - RSI momentum filter                                       |
//|     - Higher-timeframe EMA TREND filter (don't fight the trend) |
//|     - ATR-based stop-loss and take-profit                       |
//|     - Position sized so a stop-out loses ~$RiskUsd (default $10)|
//|     - Up to MaxTrades open at once, one per symbol              |
//|                                                                  |
//|   THIS IS AN EXPERT ADVISOR (EA), NOT AN INDICATOR.             |
//|   Compile in MetaEditor (F7), then drag it onto ONE chart.      |
//|   It scans the whole symbol list itself from that one chart.    |
//|                                                                  |
//|   *** DEMO ACCOUNT ONLY until you have watched it for weeks. *** |
//|   No strategy wins every trade. This is a mechanical tool, not  |
//|   a guarantee of profit. Risk only money you can afford to lose.|
//+------------------------------------------------------------------+
#property copyright "Crypto Signal Engine"
#property version   "1.00"

#include <Trade/Trade.mqh>

//============================ INPUTS ================================
input group "=== Symbols ==="
input string   InpSymbols       = "EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD"; // pairs to trade (comma separated)
input string   InpSymbolSuffix  = "";        // Exness suffix if any (e.g. "m" -> EURUSDm). Leave blank first.

input group "=== Money / risk ==="
input double   InpRiskUsd       = 10.0;      // $ risked per trade (loss if stop is hit)
input bool     InpUsePercentRisk= false;     // true = risk a % of balance instead (compounds as you grow)
input double   InpRiskPercent   = 1.0;       // % of balance per trade when the above is true
input int      InpMaxTrades     = 5;         // max positions open AT ONCE (across all pairs)
input bool     InpOnePerSymbol  = true;      // only one open position per pair

input group "=== Strategy ==="
input ENUM_TIMEFRAMES InpTF      = PERIOD_M15; // trading timeframe (entries)
input ENUM_TIMEFRAMES InpTrendTF = PERIOD_H1;  // higher timeframe for the trend filter
input int      InpEmaFast        = 20;       // fast EMA
input int      InpEmaSlow        = 50;       // slow EMA
input int      InpTrendEma       = 50;       // EMA on the higher timeframe (trend direction)
input int      InpRsiPeriod      = 14;       // RSI period
input double   InpRsiLongMin     = 50.0;     // longs need RSI above this
input double   InpRsiShortMax    = 50.0;     // shorts need RSI below this
input int      InpAtrPeriod      = 14;       // ATR period (volatility)
input double   InpSlAtrMult      = 1.5;      // stop-loss = ATR x this
input double   InpTpAtrMult      = 2.0;      // take-profit = ATR x this (reward:risk ~ TP/SL)

input group "=== Safety ==="
input int      InpMaxSpreadPts   = 30;       // skip a pair if spread (points) is wider than this
input long     InpMagic          = 990010;   // EA id tag on its own trades
input int      InpSlippagePts    = 20;       // max price deviation (points)
input bool     InpTradeLongs     = true;     // allow buys
input bool     InpTradeShorts    = true;     // allow sells

//============================ GLOBALS ==============================
CTrade   trade;

string   g_syms[];        // resolved tradable symbols
int      hFast[], hSlow[], hRsi[], hAtr[], hTrend[]; // one indicator handle per symbol
datetime g_lastBar[];     // last processed bar time per symbol

//+------------------------------------------------------------------+
//| Init                                                             |
//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpSlippagePts);
   trade.SetAsyncMode(false);

   // Parse the comma-separated symbol list, append the broker suffix, and keep
   // only the ones this account can actually trade.
   string parts[];
   ushort sep = StringGetCharacter(",", 0);
   int n = StringSplit(InpSymbols, sep, parts);
   if(n <= 0){ Print("No symbols configured."); return(INIT_PARAMETERS_INCORRECT); }

   for(int i=0; i<n; i++)
   {
      string s = parts[i];
      StringTrimLeft(s); StringTrimRight(s);
      if(s=="") continue;
      if(InpSymbolSuffix!="") s = s + InpSymbolSuffix;

      if(!SymbolSelect(s, true)) { PrintFormat("Symbol %s not found - skipped. (Check the exact name in Market Watch / try the suffix input.)", s); continue; }

      int idx = ArraySize(g_syms);
      ArrayResize(g_syms, idx+1);
      ArrayResize(hFast, idx+1); ArrayResize(hSlow, idx+1);
      ArrayResize(hRsi, idx+1);  ArrayResize(hAtr, idx+1);
      ArrayResize(hTrend, idx+1); ArrayResize(g_lastBar, idx+1);

      g_syms[idx]    = s;
      hFast[idx]     = iMA (s, InpTF,      InpEmaFast,  0, MODE_EMA, PRICE_CLOSE);
      hSlow[idx]     = iMA (s, InpTF,      InpEmaSlow,  0, MODE_EMA, PRICE_CLOSE);
      hRsi[idx]      = iRSI(s, InpTF,      InpRsiPeriod,   PRICE_CLOSE);
      hAtr[idx]      = iATR(s, InpTF,      InpAtrPeriod);
      hTrend[idx]    = iMA (s, InpTrendTF, InpTrendEma, 0, MODE_EMA, PRICE_CLOSE);
      g_lastBar[idx] = 0;

      if(hFast[idx]==INVALID_HANDLE || hSlow[idx]==INVALID_HANDLE || hRsi[idx]==INVALID_HANDLE ||
         hAtr[idx]==INVALID_HANDLE  || hTrend[idx]==INVALID_HANDLE)
      { PrintFormat("Indicator handle failed for %s.", s); return(INIT_FAILED); }
   }

   if(ArraySize(g_syms)==0){ Print("No tradable symbols after filtering."); return(INIT_PARAMETERS_INCORRECT); }
   PrintFormat("ExnessAutoTrader ready: %d pairs, risk $%.2f/trade, max %d open.", ArraySize(g_syms), InpRiskUsd, InpMaxTrades);
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   for(int i=0; i<ArraySize(g_syms); i++)
   {
      IndicatorRelease(hFast[i]);  IndicatorRelease(hSlow[i]);
      IndicatorRelease(hRsi[i]);   IndicatorRelease(hAtr[i]);
      IndicatorRelease(hTrend[i]);
   }
}

//+------------------------------------------------------------------+
//| Tick                                                             |
//+------------------------------------------------------------------+
void OnTick()
{
   // Global "can I trade right now?" checks.
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)) return;  // AutoTrading button off
   if(!MQLInfoInteger(MQL_TRADE_ALLOWED))          return;  // "Allow Algo Trading" unchecked on the chart
   if(!AccountInfoInteger(ACCOUNT_TRADE_ALLOWED))  return;  // account not permitted to trade

   for(int i=0; i<ArraySize(g_syms); i++)
   {
      string sym = g_syms[i];

      // Only act once per NEW (closed) bar on the trading timeframe.
      datetime bt = iTime(sym, InpTF, 0);
      if(bt==0 || bt==g_lastBar[i]) continue;
      g_lastBar[i] = bt;

      // Respect the max-open and one-per-symbol limits.
      if(CountPositions("") >= InpMaxTrades) continue;
      if(InpOnePerSymbol && CountPositions(sym) > 0) continue;

      TryTrade(sym, i);
   }
}

//+------------------------------------------------------------------+
//| Count our open positions (all if sym=="", else that symbol)      |
//+------------------------------------------------------------------+
int CountPositions(const string sym)
{
   int c=0;
   for(int i=PositionsTotal()-1; i>=0; i--)
   {
      ulong tk = PositionGetTicket(i);
      if(tk==0) continue;
      if(PositionGetInteger(POSITION_MAGIC) != InpMagic) continue;
      if(sym!="" && PositionGetString(POSITION_SYMBOL) != sym) continue;
      c++;
   }
   return c;
}

//+------------------------------------------------------------------+
//| Read one indicator value from a closed bar (shift>=1)            |
//+------------------------------------------------------------------+
bool Buf(const int handle, const int shift, double &val)
{
   double b[];
   if(CopyBuffer(handle, 0, shift, 1, b) < 1) return false;
   val = b[0];
   return true;
}

//+------------------------------------------------------------------+
//| Evaluate the strategy on one symbol and open a trade if it fires |
//+------------------------------------------------------------------+
void TryTrade(const string sym, const int i)
{
   // Skip if the spread is abnormally wide (news / illiquid moment).
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   long   spread = SymbolInfoInteger(sym, SYMBOL_SPREAD);
   if(spread > InpMaxSpreadPts) return;

   // Pull the values we need from the last CLOSED bars (shift 1 = last closed, 2 = prior).
   double fast1,fast2, slow1,slow2, rsi1, atr1, trendEma1, trendClose1;
   if(!Buf(hFast[i],1,fast1) || !Buf(hFast[i],2,fast2)) return;
   if(!Buf(hSlow[i],1,slow1) || !Buf(hSlow[i],2,slow2)) return;
   if(!Buf(hRsi[i], 1,rsi1))  return;
   if(!Buf(hAtr[i], 1,atr1) || atr1<=0) return;
   if(!Buf(hTrend[i],1,trendEma1)) return;
   trendClose1 = iClose(sym, InpTrendTF, 1);
   if(trendClose1<=0) return;

   bool crossUp   = (fast2 <= slow2) && (fast1 > slow1); // fast EMA crossed above slow
   bool crossDown = (fast2 >= slow2) && (fast1 < slow1); // fast EMA crossed below slow

   bool trendUp   = trendClose1 > trendEma1;             // higher timeframe is bullish
   bool trendDown = trendClose1 < trendEma1;

   bool goLong  = InpTradeLongs  && crossUp   && rsi1 > InpRsiLongMin  && trendUp;
   bool goShort = InpTradeShorts && crossDown && rsi1 < InpRsiShortMax && trendDown;

   if(!goLong && !goShort) return;

   int    digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double ask    = SymbolInfoDouble(sym, SYMBOL_ASK);
   double bid    = SymbolInfoDouble(sym, SYMBOL_BID);
   double slDist = atr1 * InpSlAtrMult;
   double tpDist = atr1 * InpTpAtrMult;

   // Broker minimum stop distance - widen SL/TP if they'd be too close.
   double stopsMin = (double)SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL) * point;
   if(slDist < stopsMin) slDist = stopsMin;
   if(tpDist < stopsMin) tpDist = stopsMin;

   double entry, sl, tp;
   ENUM_ORDER_TYPE type;
   if(goLong) { type=ORDER_TYPE_BUY;  entry=ask; sl=ask-slDist; tp=ask+tpDist; }
   else       { type=ORDER_TYPE_SELL; entry=bid; sl=bid+slDist; tp=bid-tpDist; }

   entry = NormalizeDouble(entry, digits);
   sl    = NormalizeDouble(sl,    digits);
   tp    = NormalizeDouble(tp,    digits);

   double lots = LotsForRisk(sym, slDist);
   if(lots<=0){ PrintFormat("%s: could not size a lot for $%.2f risk - skipped.", sym, RiskAmount()); return; }

   // Final margin sanity check.
   double marginNeeded;
   if(OrderCalcMargin(type, sym, lots, entry, marginNeeded))
      if(marginNeeded > AccountInfoDouble(ACCOUNT_MARGIN_FREE))
      { PrintFormat("%s: not enough free margin (need %.2f) - skipped.", sym, marginNeeded); return; }

   trade.SetTypeFillingBySymbol(sym);
   bool ok = (type==ORDER_TYPE_BUY)
             ? trade.Buy (lots, sym, entry, sl, tp, "AutoTrader")
             : trade.Sell(lots, sym, entry, sl, tp, "AutoTrader");

   if(ok) PrintFormat("%s %s %.2f lots @ %s  SL %s  TP %s  (risk ~$%.2f)",
                      sym, (type==ORDER_TYPE_BUY?"BUY":"SELL"), lots,
                      DoubleToString(entry,digits), DoubleToString(sl,digits),
                      DoubleToString(tp,digits), RiskAmount());
   else   PrintFormat("%s order failed: %s (%d)", sym, trade.ResultRetcodeDescription(), trade.ResultRetcode());
}

//+------------------------------------------------------------------+
//| The $ to risk on the next trade (fixed, or % of balance)         |
//+------------------------------------------------------------------+
double RiskAmount()
{
   if(InpUsePercentRisk) return AccountInfoDouble(ACCOUNT_BALANCE) * InpRiskPercent / 100.0;
   return InpRiskUsd;
}

//+------------------------------------------------------------------+
//| Lot size so that hitting the stop loses ~RiskAmount()            |
//|   lossPerLot = (stopDistance / tickSize) * tickValue             |
//|   lots       = risk / lossPerLot                                 |
//+------------------------------------------------------------------+
double LotsForRisk(const string sym, const double slDist)
{
   double tickVal  = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE);
   double tickSize = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
   if(tickVal<=0 || tickSize<=0) return 0.0;

   double lossPerLot = (slDist / tickSize) * tickVal;   // $ lost per 1.00 lot if stopped
   if(lossPerLot<=0) return 0.0;

   double lots = RiskAmount() / lossPerLot;

   // Snap to the broker's volume step / min / max.
   double step = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   double minv = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   double maxv = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   if(step<=0) step = 0.01;

   lots = MathFloor(lots/step) * step;
   if(lots < minv) lots = minv;   // can't trade smaller than the minimum lot
   if(lots > maxv) lots = maxv;

   // Round to the step's decimal places to avoid float noise.
   int stepDigits = (int)MathMax(0, -MathLog10(step) + 0.5);
   lots = NormalizeDouble(lots, stepDigits);
   return lots;
}
//+------------------------------------------------------------------+
