// tradeIngest.js
// npm i express helmet express-rate-limit zod @supabase/supabase-js
//
// In server.js (AFTER app.use(express.json())):
//   app.set('trust proxy', 1);   // needed on Render so rate limiting works
//   app.use('/api/v2/trades', require('./tradeIngest'));

const express = require('express');
const helmet = require('helmet');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { createClient } = require('@supabase/supabase-js');

// Service role key lives ONLY in server environment variables (Render).
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY
);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------- 1. Rate limit ----------
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------- 2. API key auth (only the hash is stored) ----------
async function requireApiKey(req, res, next) {
  const match = /^Bearer (tn_live_[A-Za-z0-9_-]{20,100})$/.exec(req.get('authorization') || '');
  if (!match) return res.status(401).json({ error: 'unauthorized' });

  const { data, error } = await supabase
    .from('api_keys')
    .select('id, user_id')
    .eq('key_hash', sha256(match[1]))
    .eq('revoked', false)
    .maybeSingle();

  if (error || !data) return res.status(401).json({ error: 'unauthorized' });

  req.userId = data.user_id; // identity comes from the key, never from the body
  supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(() => {}, () => {});
  next();
}

// ---------- 3. Input validation ----------
const num = z.number().finite();
const TradeSchema = z.object({
  account: z.number().int().positive(),
  deal_ticket: z.string().regex(/^\d{1,20}$/),
  position_id: z.string().regex(/^\d{1,20}$/),
  symbol: z.string().regex(/^[A-Za-z0-9._#\-]{1,32}$/),
  side: z.enum(['buy', 'sell']),
  volume: num.positive().max(10000),
  open_price: num.min(0),
  close_price: num.min(0),
  sl: num.min(0),
  tp: num.min(0),
  open_time_utc: z.string().datetime(),
  close_time_utc: z.string().datetime(),
  profit: num,
  commission: num,
  swap: num,
}).strict();

// ---------- 4. Route ----------
const router = express.Router();
router.use(helmet()); // security headers on this API route only (won't affect your dashboard)

router.post('/', limiter, requireApiKey, async (req, res) => {
  const parsed = TradeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid payload', details: parsed.error.issues.map(i => i.path.join('.')) });
  }
  const t = parsed.data;

  // trade_type values your journal uses. Change the right-hand side if your
  // dashboard expects different words (e.g. 'BUY'/'SELL' or 'Long'/'Short').
  const TYPE_MAP = { buy: 'buy', sell: 'sell' };

  // Mapped to YOUR existing trades table columns.
  const row = {
    user_id: req.userId,
    symbol: t.symbol,
    trade_type: TYPE_MAP[t.side],
    entry_price: t.open_price,
    exit_price: t.close_price,
    lot_size: t.volume,
    profit_loss: +(t.profit + t.commission + t.swap).toFixed(2), // net P&L
    opened_at: t.open_time_utc,
    closed_at: t.close_time_utc,
    notes: null,
    // new columns from setup.sql
    account_login: t.account,
    deal_ticket: t.deal_ticket,
    position_id: t.position_id,
    stop_loss: t.sl || null,
    take_profit: t.tp || null,
    commission: t.commission,
    swap: t.swap,
    source: 'mt5-ea',
  };

  // Upsert on (user_id, account_login, deal_ticket) => duplicates are impossible
  const { error } = await supabase
    .from('trades')
    .upsert(row, { onConflict: 'user_id,account_login,deal_ticket' });

  if (error) {
    console.error('trade upsert failed:', error.message);
    return res.status(500).json({ error: 'server error' });
  }
  res.status(201).json({ ok: true });
});

module.exports = router;
