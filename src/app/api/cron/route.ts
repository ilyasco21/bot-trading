import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

// Daftar koin yang ingin dipantau
const WATCHLIST = [
  { symbol: 'BTC', indodaxId: 'btcidr', geckoid: 'bitcoin', name: 'Bitcoin' },
  { symbol: 'ETH', indodaxId: 'ethidr', geckoid: 'ethereum', name: 'Ethereum' },
  { symbol: 'SOL', indodaxId: 'solidr', geckoid: 'solana', name: 'Solana' },
  { symbol: 'XRP', indodaxId: 'xrpidr', geckoid: 'ripple', name: 'XRP' },
  { symbol: 'DOGE', indodaxId: 'dogeidr', geckoid: 'dogecoin', name: 'Dogecoin' },
];

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
    const activeSignals: string[] = [];
    const dbLogs: any[] = [];

    // Loop analisis untuk setiap koin
    for (const coin of WATCHLIST) {
      let currentPrice = 0;
      let closePrices: number[] = [];

      // 1. Ambil Harga Indodax
      try {
        const res = await fetch(`https://indodax.com/api/ticker/${coin.indodaxId}`, { cache: 'no-store' });
        const data = await res.json();
        if (data && data.ticker) {
          currentPrice = parseFloat(data.ticker.last);
        }
      } catch (e) {
        console.error(`Error Indodax ${coin.symbol}:`, e);
      }

      // 2. Ambil Histori CoinGecko untuk RSI
      try {
        const res = await fetch(`https://api.coingecko.com/api/v3/coins/${coin.geckoid}/market_chart?vs_currency=usd&days=2`, { cache: 'no-store' });
        const data = await res.json();
        if (data && Array.isArray(data.prices)) {
          closePrices = data.prices.map((p: [number, number]) => p[1]);
        }
      } catch (e) {
        console.error(`Error CoinGecko ${coin.symbol}:`, e);
      }

      if (closePrices.length === 0) {
        closePrices = Array(30).fill(currentPrice > 0 ? currentPrice : 1000);
      }

      // 3. Hitung RSI & Evaluasi Sinyal
      const rsi = calculateRSI(closePrices, 14);
      let signal = 'NEUTRAL';
      let reason = '';

      // Ambang batas yang lebih peka untuk altcoin
      if (rsi < 38) {
        signal = 'BUY';
        reason = 'RSI Oversold (Harga Murah/Jenuh Jual)';
      } else if (rsi > 65) {
        signal = 'SELL';
        reason = 'RSI Overbought (Harga Jenuh Beli, Rawan Koreksi)';
      }

      const formattedPrice = currentPrice > 0
        ? new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(currentPrice)
        : 'Rp -';

      // 4. Jika ada sinyal BUY atau SELL, catat untuk dikirim
      if (signal !== 'NEUTRAL') {
        const icon = signal === 'BUY' ? '🚀' : '🔻';
        activeSignals.push(
`${icon} *${coin.name} (${coin.symbol}/IDR)*
• *Sinyal:* ${signal}
• *Harga:* ${formattedPrice}
• *RSI (14):* ${rsi.toFixed(2)}
• *Catatan:* ${reason}`
        );
      }

      // Simpan log analisis ke DB
      dbLogs.push({
        pair: `${coin.symbol}IDR`,
        signal: signal,
        win_rate: signal === 'BUY' ? 75 : signal === 'SELL' ? 70 : 50,
        price: currentPrice,
        pattern: 'MULTI_COIN_RSI',
        rsi: parseFloat(rsi.toFixed(2)),
        reason: reason || 'Pasar Stabil',
      });
    }

    // 5. Kirim Notifikasi Telegram HANYA jika ada sinyal BUY / SELL
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (telegramToken && chatId && activeSignals.length > 0) {
      const header = `🚨 *OPSI TRADING DITEMUKAN!*\n\n`;
      const fullMessage = header + activeSignals.join('\n\n---\n\n');

      await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: fullMessage,
          parse_mode: 'Markdown',
        }),
      });
    }

    // 6. Simpan ke Supabase
    if (supabaseUrl && supabaseKey && dbLogs.length > 0) {
      await supabase.from('trading_signals').insert(dbLogs);
    }

    return NextResponse.json({
      sukses: true,
      sinyal_ditemukan: activeSignals.length,
      detail: activeSignals.length > 0 ? 'Notifikasi terkirim ke Telegram' : 'Semua koin netral, tidak kirim spam',
    });

  } catch (err: any) {
    return NextResponse.json(
      { sukses: false, error: err.message || 'Terjadi kesalahan server' },
      { status: 500 }
    );
  }
}