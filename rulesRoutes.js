// rulesRoutes.js - standing trading limits for TradeNote
// Registered from server.js with:  require("./rulesRoutes")(app, supabase);
//
// How it works
//  - You save your four limits once. They repeat automatically every day.
//  - A new day's row is created from your standing limits the first time anything asks for it.
//  - Stricter numbers (lower) start right now. Looser numbers (higher) only start tomorrow.
const crypto = require("crypto");

const FIELDS = [
  "daily_profit_target",
  "max_daily_loss",
  "max_trades_per_day",
  "max_risk_per_trade"
];

module.exports = function registerRulesRoutes(app, supabase) {
  const todayDate = () => new Date().toISOString().slice(0, 10);

  const requireKey = (req, res, next) => {
    const expected = Buffer.from((process.env.RULES_KEY || "").trim());
    const given = Buffer.from((req.get("x-rules-key") || "").trim());
    if (!expected.length || given.length !== expected.length ||
        !crypto.timingSafeEqual(given, expected)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  };

  const pick = (row) => {
    const out = {};
    for (const f of FIELDS) out[f] = Number(row[f]);
    return out;
  };

  async function getToday() {
    const { data, error } = await supabase
      .from("trading_rules").select("*").eq("rule_date", todayDate()).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }

  async function getStanding() {
    const { data, error } = await supabase
      .from("standing_rules").select("*").eq("id", 1).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }

  async function saveStanding(values) {
    const { error } = await supabase
      .from("standing_rules")
      .upsert([{ id: 1, ...values, updated_at: new Date().toISOString() }]);
    if (error) throw new Error(error.message);
  }

  async function insertToday(values) {
    const { data, error } = await supabase
      .from("trading_rules")
      .insert([{ rule_date: todayDate(), ...values }])
      .select();
    if (error) {
      const again = await getToday();   // another request may have created it first
      if (again) return again;
      throw new Error(error.message);
    }
    return data[0];
  }

  // Today's row, created from the standing limits when a new day starts.
  async function getOrCreateToday() {
    const existing = await getToday();
    if (existing) return existing;

    let base = await getStanding();
    if (!base) {
      // No standing limits yet: carry forward the most recent day that was saved
      const { data, error } = await supabase
        .from("trading_rules").select("*")
        .lt("rule_date", todayDate())
        .order("rule_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      base = pick(data);
      await saveStanding(base);
    }
    return insertToday(pick(base));
  }

  // Today's limits + live status. The EA and the dashboard both read this.
  app.get("/api/rules/today", requireKey, async (req, res) => {
    try {
      const rules = await getOrCreateToday();
      if (!rules) return res.json({ rules: null });

      const { data: trades, error: tradesError } = await supabase
        .from("trades").select("profit_loss").gte("opened_at", todayDate());
      if (tradesError) return res.status(500).json({ error: tradesError.message });

      const pnl = trades.reduce((sum, t) => sum + Number(t.profit_loss || 0), 0);
      const tradeCount = trades.length;

      let locked = rules.locked;
      let lockReason = rules.lock_reason;

      if (!locked) {
        if (pnl >= Number(rules.daily_profit_target)) lockReason = "Daily profit target reached";
        else if (pnl <= -Number(rules.max_daily_loss)) lockReason = "Max daily loss reached";
        else if (tradeCount >= Number(rules.max_trades_per_day)) lockReason = "Max trades per day reached";

        if (lockReason) {
          locked = true;
          await supabase
            .from("trading_rules")
            .update({ locked: true, lock_reason: lockReason })
            .eq("id", rules.id);
        }
      }

      res.json({
        rules: { ...rules, locked, lock_reason: lockReason },
        pnl,
        trades_today: tradeCount
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // The limits that repeat every day
  app.get("/api/rules/standing", requireKey, async (req, res) => {
    try {
      const s = await getStanding();
      res.json({ standing: s ? pick(s) : null });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Save your limits. They become your standing limits for every day.
  app.post("/api/rules", requireKey, async (req, res) => {
    try {
      const incoming = {};
      for (const f of FIELDS) {
        const raw = req.body ? req.body[f] : undefined;
        const n = Number(raw);
        if (raw === undefined || raw === null || raw === "" || !isFinite(n) || n <= 0) {
          return res.status(400).json({ error: "All four rules must be numbers greater than 0." });
        }
        incoming[f] = n;
      }
      if (!Number.isInteger(incoming.max_trades_per_day)) {
        return res.status(400).json({ error: "Max trades per day must be a whole number." });
      }

      const oldStanding = await getStanding();
      let today = await getToday();
      let applies = "tomorrow";

      const base = today ? pick(today) : (oldStanding ? pick(oldStanding) : null);

      if (!base) {
        // very first setup: starts today
        today = await insertToday(incoming);
        applies = "today";
      } else {
        // stricter (lower) numbers apply now, looser (higher) numbers wait for tomorrow
        const tightened = {};
        let changed = false;
        for (const f of FIELDS) {
          tightened[f] = Math.min(base[f], incoming[f]);
          if (tightened[f] !== base[f]) changed = true;
        }
        if (!today) {
          today = await insertToday(tightened);
        } else if (changed) {
          const { data, error } = await supabase
            .from("trading_rules").update(tightened).eq("id", today.id).select();
          if (error) return res.status(500).json({ error: error.message });
          today = data[0];
        }
      }

      await saveStanding(incoming);
      res.json({ success: true, applies, today: pick(today), standing: incoming });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};
