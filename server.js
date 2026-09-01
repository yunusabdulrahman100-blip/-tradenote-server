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