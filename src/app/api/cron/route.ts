import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Inisialisasi Supabase Client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

// Fungsi untuk menghitung RSI
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

export async function GET() {
  try {
    // 1. Ambil Harga Realtime BTC/IDR dari Public Ticker Indodax
    let currentPrice = 0;
    try {
      const indodaxRes = await fetch('https://indodax.com/api/ticker/btcidr', { cache: 'no-store' });
      const indodaxData = await indodaxRes.json();
      if (indodaxData && indodaxData.ticker) {
        currentPrice = parseFloat(indodaxData.ticker.last);
      }
    } catch (e) {
      console.error('Error Indodax:', e);
    }

    // 2. Ambil Histori Harga Bitcoin dari CoinGecko API (100% Bebas Blokir di Vercel)
    let closePrices: number[] = [];
    try {
      const cgRes = await fetch('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=2', { cache: 'no-store' });
      const cgData = await cgRes.json();
      if (cgData && Array.isArray(cgData.prices)) {
        closePrices = cgData.prices.map((p: [number, number]) => p[1]);
      }
    } catch (e) {
      console.error('Error CoinGecko:', e);
    }

    // Jika CoinGecko gagal, gunakan dummy fallback berbasis harga saat ini agar fungsi RSI tidak crash
    if (closePrices.length === 0) {
      closePrices = Array(30).fill(currentPrice > 0 ? currentPrice : 1000000000);
    }

    // 3. Hitung RSI
    const rsi = calculateRSI(closePrices, 14);

    // 4. Analisis Sinyal
    let signal = 'NEUTRAL';
    let winRate = 50;
    let reason = 'Konsolidasi / Pasar sedang stabil';

    if (rsi < 35) {
      signal = 'BUY';
      winRate = 75;
      reason = 'RSI Oversold (Harga sudah murah / jenuh jual)';
    } else if (rsi > 68) {
      signal = 'SELL';
      winRate = 70;
      reason = 'RSI Overbought (Harga jenuh beli, rawan koreksi)';
    }

    // Format harga ke Rupiah
    const formattedPrice = currentPrice > 0
      ? new Intl.NumberFormat('id-ID', {
          style: 'currency',
          currency: 'IDR',
          maximumFractionDigits: 0
        }).format(currentPrice)
      : 'Rp -';

    // 5. Kirim Notifikasi ke Telegram
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (telegramToken && chatId) {
      const icon = signal === 'BUY' ? '🚀' : signal === 'SELL' ? '🔻' : '⚖️';
      const telegramMessage = 
`${icon} *Sinyal Trading Analyst (BTC/IDR)*

📈 *Sinyal:* ${signal}
📊 *Estimasi Win-Rate:* ${winRate}%
💰 *Harga Indodax:* ${formattedPrice}
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

    // 6. Simpan Log ke Supabase
    if (supabaseUrl && supabaseKey) {
      await supabase.from('trading_signals').insert([
        {
          pair: 'BTCIDR',
          signal: signal,
          win_rate: winRate,
          price: currentPrice,
          pattern: 'RSI_ANALYSIS',
          rsi: parseFloat(rsi.toFixed(2)),
          reason: reason,
        },
      ]);
    }

    return NextResponse.json({
      sukses: true,
      sinyal: signal,
      harga_indodax: formattedPrice,
      rsi: rsi.toFixed(2),
    });

  } catch (err: any) {
    return NextResponse.json(
      { sukses: false, error: err.message || 'Terjadi kesalahan server' },
      { status: 500 }
    );
  }
}