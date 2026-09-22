import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
}

// Deteksi Pola Candlestick (Hammer & Bullish Engulfing)
function detectCandlestickPattern(candles: Candle[]) {
  const current = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const bodySize = Math.abs(current.close - current.open);
  const lowerShadow = Math.min(current.open, current.close) - current.low;
  const upperShadow = current.high - Math.max(current.open, current.close);

  const isHammer = lowerShadow >= 2 * bodySize && upperShadow <= bodySize * 0.5 && bodySize > 0;
  
  const isBullishEngulfing = 
    previous.close < previous.open && 
    current.close > current.open &&   
    current.close > previous.open && 
    current.open < previous.close;

  if (isHammer) return 'HAMMER';
  if (isBullishEngulfing) return 'BULLISH_ENGULFING';
  return 'NO_PATTERN';
}

// Hitung RSI (14 Period)
function calculateRSI(closes: number[], period: number = 14): number {
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[closes.length - i] - closes[closes.length - i - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - (100 / (1 + rs))) * 100) / 100;
}

// Kirim Pesan Telegram
async function sendTelegramMessage(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

export async function GET() {
  try {
    const symbol = 'BTCUSDT';
    const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=50`);
    const data = await res.json();

    const candles: Candle[] = data.map((d: any) => ({
      open: parseFloat(d[1]),
      high: parseFloat(d[2]),
      low: parseFloat(d[3]),
      close: parseFloat(d[4]),
    }));

    const closes = candles.map(c => c.close);
    const lastPrice = closes[closes.length - 1];
    const rsi = calculateRSI(closes);
    const pattern = detectCandlestickPattern(candles);

    let probability = 50;
    let signalType = 'NEUTRAL';
    const reasons: string[] = [];

    if (pattern === 'HAMMER') {
      probability += 15;
      reasons.push('Terdeteksi Pola Hammer (Potensi Reversal)');
    } else if (pattern === 'BULLISH_ENGULFING') {
      probability += 20;
      reasons.push('Terdeteksi Bullish Engulfing (Pembeli Dominan)');
    }

    if (rsi < 30) {
      probability += 15;
      reasons.push(`RSI Oversold (${rsi})`);
    } else if (rsi > 70) {
      probability -= 20;
      reasons.push(`RSI Overbought (${rsi})`);
    }

    if (probability >= 65) signalType = 'BUY';
    else if (probability <= 35) signalType = 'SELL';

    // Simpan ke Supabase
    await supabase.from('trading_signals').insert({
      symbol,
      signal_type: signalType,
      candlestick_pattern: pattern,
      rsi_value: rsi,
      probability,
      price: lastPrice,
      reason: reasons.join(', ') || 'Kondisi Sideways/Konsolidasi',
    });

    // Kirim Notifikasi Telegram
    const message = `
🤖 <b>Sinyal Trading Analyst (${symbol})</b>
--------------------------------------
📈 <b>Sinyal:</b> ${signalType}
📊 <b>Estimasi Win-Rate:</b> ${probability}%
🏷️ <b>Harga Saat Ini:</b> $${lastPrice.toLocaleString()}
🕯️ <b>Pola Candle:</b> ${pattern}
📉 <b>RSI (14):</b> ${rsi}

<b>Alasan Analisis:</b>
${reasons.length > 0 ? reasons.map(r => `• ${r}`).join('\n') : '• Konsolidasi / Tidak ada pola kuat'}
    `;
    await sendTelegramMessage(message);

    return NextResponse.json({ success: true, symbol, signalType, probability, pattern, rsi });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}