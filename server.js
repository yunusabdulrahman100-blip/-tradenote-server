require("dotenv").config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = 5000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(express.json());
app.use(express.static("public"));

app.get("/", (req, res) => {
    res.send("TradeNote API is working!");
});

app.get("/test-db", async (req, res) => {
    res.send("Supabase connected! URL: " + process.env.SUPABASE_URL);
});

app.get("/add-test-trade", async (req, res) => {
    const { data, error } = await supabase.from("trades").insert([
        {
            symbol: "EURUSD",
            trade_type: "buy",
            entry_price: 1.085,
            exit_price: 1.09,
            lot_size: 0.5,
            profit_loss: 25.00,
            notes: "My first test trade!"
        }
    ]).select();

    if (error) {
        res.send("Error: " + error.message);
    } else {
        res.send("Trade saved! " + JSON.stringify(data));
    }
});

app.post("/add-trade", async (req, res) => {
    const { symbol, trade_type, entry_price, exit_price, lot_size, profit_loss, notes } = req.body;

    const { data, error } = await supabase.from("trades").insert([
        { symbol, trade_type, entry_price, exit_price, lot_size, profit_loss, notes }
    ]).select();

    if (error) {
        res.status(400).json({ error: error.message });
    } else {
        res.json({ message: "Trade received and saved!", trade: data });
    }
});

app.get("/trades", async (req, res) => {
    const { data, error } = await supabase
        .from("trades")
        .select("*")
        .order("opened_at", { ascending: false });

    if (error) {
        res.status(400).json({ error: error.message });
    } else {
        res.json(data);
    }
});

app.listen(PORT, () => {
    console.log(`TradeNote server is running on port ${PORT}`);
});

const MetaApi = require('metaapi.cloud-sdk').default;
const metaApiToken = process.env.METAAPI_TOKEN;

app.post('/api/broker-sync/connect', async (req, res) => {
  const { userId, broker, platform, login, server: brokerServer, password } = req.body;

  if (!userId || !platform || !login || !brokerServer || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const api = new MetaApi(metaApiToken);

    const account = await api.metatraderAccountApi.createAccount({
      name: `${broker || platform.toUpperCase()}-${login}`,
      type: 'cloud',
      login: String(login),
      password: password,
      server: brokerServer,
      platform: platform,
      magic: 0
    });

    await account.deploy();

    const { error } = await supabase.from('broker_connections').insert({
      user_id: userId,
      metaapi_account_id: account.id,
      broker_name: broker || platform,
      platform,
      login: String(login),
      server: brokerServer,
      status: 'connecting'
    });

    if (error) throw error;

    startTradeListener(account.id, userId);

    res.json({ success: true, accountId: account.id });
  } catch (err) {
    console.error('Broker connect error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

class TradeJournalListener {
  constructor(userId) {
    this.userId = userId;
    return new Proxy(this, {
      get(target, prop) {
        if (prop in target) {
          const value = target[prop];
          return typeof value === 'function' ? value.bind(target) : value;
        }
        if (typeof prop === 'string' && prop.startsWith('on')) {
          return async () => {};
        }
        return undefined;
      }
    });
  }

  async onDealAdded(instanceIndex, deal) {
    if (deal.type !== 'DEAL_TYPE_BUY' && deal.type !== 'DEAL_TYPE_SELL') return;
    if (!deal.entryType || deal.entryType !== 'DEAL_ENTRY_OUT') return;

    const { error } = await supabase.from('trades').insert({
      user_id: this.userId,
      symbol: deal.symbol,
      trade_type: deal.type === 'DEAL_TYPE_BUY' ? 'sell' : 'buy',
      entry_price: deal.price,
      exit_price: deal.price,
      lot_size: deal.volume,
      profit_loss: deal.profit,
      opened_at: deal.time,
      notes: 'Auto-synced via MetaApi'
    });

    if (error) console.error('Trade insert error:', error.message);
    else console.log(`Trade journaled for user ${this.userId}: ${deal.symbol} ${deal.profit}`);
  }
}

async function startTradeListener(accountId, userId) {
  try {
    const api = new MetaApi(metaApiToken);
    const account = await api.metatraderAccountApi.getAccount(accountId);
    await account.waitDeployed();

    const connection = account.getStreamingConnection();
    await connection.connect();
    await connection.waitSynchronized();

    connection.addSynchronizationListener(new TradeJournalListener(userId));

    console.log(`Trade listener active for account ${accountId}`);
  } catch (err) {
    console.error('Listener error:', err.message);
  }
}