const express = require("express");
const app = express();
const path = require("path");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── CONFIG ────────────────────────────────────────────────────────────────
const CONFIG = {
  SHOP_NAME: "MIGO PRINT SHOP",
  LOCATION: "Circle, near Benz Gate",
  MOMO: "0552719245",
  MOMO_NAME: "Kow Habib Baisie",
  PRICES: { A4: 3.20, A3: 6.40, A2: 16.00 },
  TWILIO_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER: "whatsapp:+14155238886",
  ANTHROPIC_KEY: process.env.ANTHROPIC_API_KEY,
  JOBS_BASE: path.join(__dirname, "migo_DTF"),
};

// ─── DATABASE ──────────────────────────────────────────────────────────────
const db = new sqlite3.Database("migo.db");
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT,
    phone TEXT,
    items TEXT,
    total REAL,
    amount_paid REAL DEFAULT 0,
    balance REAL,
    status TEXT DEFAULT 'PENDING_PAYMENT',
    folder TEXT,
    date TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    paid_at DATETIME
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT,
    order_id TEXT,
    original_name TEXT,
    saved_name TEXT,
    folder TEXT,
    status TEXT DEFAULT 'PENDING',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// ─── CONVERSATION HISTORY ──────────────────────────────────────────────────
const conversations = new Map();

function getHistory(phone) {
  if (!conversations.has(phone)) conversations.set(phone, []);
  return conversations.get(phone);
}

function addToHistory(phone, role, content) {
  const history = getHistory(phone);
  history.push({ role, content });
  if (history.length > 10) history.shift();
}

// ─── CLAUDE AI REPLY ───────────────────────────────────────────────────────
async function claudeReply(phone, customerMessage) {
  const history = getHistory(phone);
  addToHistory(phone, "user", customerMessage);

  const systemPrompt = `You are a friendly and professional WhatsApp customer service assistant for ${CONFIG.SHOP_NAME}, a DTF printing business in Ghana.

ABOUT THE SHOP:
- Name: ${CONFIG.SHOP_NAME}
- Location: ${CONFIG.LOCATION}, Accra, Ghana
- Service: DTF (Direct to Film) printing transfers for clothing and fabrics
- Works on ALL fabric types: cotton, polyester, blends, dark and light colours
- No minimum order required
- Fast turnaround: same day or
