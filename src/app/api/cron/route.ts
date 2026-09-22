import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Inisialisasi Supabase Client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

// Fungsi untuk menghitung RSI (Relative Strength Index)
function calculateRSI(closes: number[], period: number = 14): number {
  if (closes.length <= period) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - change) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Fungsi utama Cron Job
export async function GET() {
  try {
    // 1. Ambil data Candlestick (Klines) langsung dari Indodax API (Aman dari blokir Vercel)
    const toTime = Math.floor(Date.now() / 1000);
    const fromTime = toTime - 86400 * 3; // Data 3 hari terakhir
    
    const res = await fetch(
      `https://indodax.com/tradingview/history?symbol=BTCIDR&resolution=60&from=${fromTime}&to=${toTime}`,
      { cache: 'no-store' }
    );

    const data = await res.json();

    // Validasi data Indodax
    if (!data || data.s !== 'ok' || !Array.isArray(data.c) || data.c.length === 0) {
      return NextResponse.json(
        { sukses: false, error: 'Gagal mengambil data dari Indodax' },
        { status: 500 }
      );
    }

    const closePrices: number[] = data.c;
    const openPrices: number[] = data.o;
    const highPrices: number[] = data.h;
    const lowPrices: number[] = data.l;

    const totalCandles = closePrices.length;
    const currentPrice = closePrices[totalCandles - 1];

    // 2. Hitung Indikator RSI (14)
    const rsi = calculateRSI(closePrices, 14);

    // 3. Deteksi Pola Candlestick Sederhana
    const lastOpen = openPrices[totalCandles - 1];
    const lastClose = closePrices[totalCandles - 1];
    const lastHigh = highPrices[totalCandles - 1];
    const lastLow = lowPrices[totalCandles - 1];

    const bodySize = Math.abs(lastClose - lastOpen);
    const lowerShadow = Math.min(lastOpen, lastClose) - lastLow;

    let pattern = 'NO_PATTERN';
    if (lowerShadow > bodySize * 2 && (lastHigh - Math.max(lastOpen, lastClose)) < bodySize) {
      pattern = 'BULLISH_HAMMER';
    }

    // 4. Logika Penentuan Sinyal
    let signal = 'NEUTRAL';
    let winRate = 50;
    let reason = 'Konsolidasi / Tidak ada pola kuat';

    if (rsi < 35 || (rsi < 45 && pattern === 'BULLISH_HAMMER')) {
      signal = 'BUY';
      winRate = 75;
      reason = 'RSI Oversold & Terdeteksi Pola Pembalikan Naik';
    } else if (rsi > 68) {
      signal = 'SELL';
      winRate = 70;
      reason = 'RSI Overbought (Jenuh Beli), Rawan Koreksi';
    }

    // Format harga ke Rupiah
    const formattedPrice = new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: 'IDR',
      maximumFractionDigits: 0
    }).format(currentPrice);

    // 5. Kirim Notifikasi ke Telegram
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (telegramToken && chatId) {
      const icon = signal === 'BUY' ? '🚀' : signal === 'SELL' ? '🔻' : '⚖️';
      const telegramMessage = 
`${icon} *Sinyal Trading Analyst (BTC/IDR)*

📈 *Sinyal:* ${signal}
📊 *Estimasi Win-Rate:* ${winRate}%
💰 *Harga Saat Ini:* ${formattedPrice}
🕯️ *Pola Candle:* ${pattern}
📉 *RSI (14):* ${rsi.toFixed(2)}

💡 *Alasan Analisis:*
• ${reason}`;

      await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: telegramMessage,
          parse_mode: 'Markdown',
        }),
      });
    }

    // 6. Simpan Log Sinyal ke Supabase Database
    if (supabaseUrl && supabaseKey) {
      await supabase.from('trading_signals').insert([
        {
          pair: 'BTCIDR',
          signal: signal,
          win_rate: winRate,
          price: currentPrice,
          pattern: pattern,
          rsi: parseFloat(rsi.toFixed(2)),
          reason: reason,
        },
      ]);
    }

    return NextResponse.json({
      sukses: true,
      sinyal: signal,
      harga: currentPrice,
      rsi: rsi.toFixed(2),
    });

  } catch (err: any) {
    return NextResponse.json(
      { sukses: false, error: err.message || 'Terjadi kesalahan server' },
      { status: 500 }
    );
  }
}