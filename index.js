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

// ─── CONVERSATION HISTORY (for Claude context) ─────────────────────────────
const conversations = new Map();

function getHistory(phone) {
  if (!conversations.has(phone)) conversations.set(phone, []);
  return conversations.get(phone);
}

function addToHistory(phone, role, content) {
  const history = getHistory(phone);
  history.push({ role, content });
  // Keep last 10 messages only (saves API cost)
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
- Fast turnaround: same day or next day
- High quality, vibrant colours that last

PRICES:
- A4 = GHS 3.20 per sheet
- A3 = GHS 6.40 per sheet
- A2 = GHS 16.00 per sheet

PAYMENT:
- MTN MoMo number: ${CONFIG.MOMO}
- Account name: ${CONFIG.MOMO_NAME}
- Customer must send payment receipt to confirm order

HOW TO ORDER:
- Customer sends size and quantity e.g. "50 A4" or "20 A3 and 10 A2"
- System automatically calculates and sends bill
- Customer pays via MoMo and sends receipt

WORKING HOURS:
- Monday to Saturday: 8am - 6pm
- Sunday: Closed
- WhatsApp orders accepted anytime

YOUR PERSONALITY:
- Friendly, warm and professional
- Understand Ghanaian culture and expressions
- Understand Pidgin English (boss, oga, chaley, chale, dey, wey, abeg, etc.)
- Keep replies SHORT and clear — this is WhatsApp
- Use emojis naturally but not excessively
- Always guide customer toward placing an order
- Use WhatsApp formatting: *bold*, _italic_
- Never make up information not listed above
- If asked about something you don't know, politely say so and redirect to ordering

CRITICAL RULES:
- Keep replies under 200 words
- Never mention you are an AI unless directly asked
- If customer sends a size and quantity like "50 A4", tell them to send it as their order
- Always end with a helpful next step`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CONFIG.ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: systemPrompt,
        messages: history
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error("Claude error:", data.error);
      return fallbackReply(customerMessage);
    }

    const reply = data.content[0].text;
    addToHistory(phone, "assistant", reply);
    return reply;

  } catch (err) {
    console.error("Claude API error:", err);
    return fallbackReply(customerMessage);
  }
}

// ─── FALLBACK (if Claude fails) ────────────────────────────────────────────
function fallbackReply(msg) {
  const m = msg.toLowerCase();
  if (m.match(/price|cost|how much/)) return `📋 *Our DTF Prices:*\n• A4 → GHS 3.20\n• A3 → GHS 6.40\n• A2 → GHS 16.00\n\nSend your order like _"50 A4"_ ✅`;
  if (m.match(/location|where|address/)) return `📍 *${CONFIG.SHOP_NAME}*\nCircle, near Benz Gate 😊`;
  if (m.match(/time|open|hours/)) return `🕐 Mon–Sat: 8am–6pm\nSunday: Closed`;
  return `👋 Welcome to *${CONFIG.SHOP_NAME}!*\n\nSend your order like:\n_"50 A4"_ or _"20 A3 and 10 A2"_ ✅`;
}

// ─── HELPERS ───────────────────────────────────────────────────────────────
function getDateFolder() {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${dd}_${months[now.getMonth()]}_${now.getFullYear()}`;
}

function getLast4(phone) {
  return phone.replace(/\D/g, "").slice(-4);
}

function generateOrderId() {
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}`;
  return new Promise((resolve) => {
    db.get(`SELECT COUNT(*) as count FROM orders WHERE date = ?`, [getDateFolder()], (err, row) => {
      const seq = String((row?.count || 0) + 1).padStart(4, "0");
      resolve(`ORD-${date}-${seq}`);
    });
  });
}

async function downloadFile(mediaUrl, destPath) {
  const https = require("https");
  const http = require("http");
  const auth = Buffer.from(`${CONFIG.TWILIO_SID}:${CONFIG.TWILIO_TOKEN}`).toString("base64");
  return new Promise((resolve, reject) => {
    const client = mediaUrl.startsWith("https") ? https : http;
    client.get(mediaUrl, { headers: { Authorization: `Basic ${auth}` } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302)
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
      file.on("error", reject);
    }).on("error", reject);
  });
}

async function handleIncomingFile(req, phone) {
  const mediaUrl = req.body.MediaUrl0;
  const contentType = req.body.MediaContentType0 || "image/jpeg";
  const ext = contentType.includes("pdf") ? "pdf" : contentType.includes("png") ? "png" : contentType.includes("tiff") ? "tiff" : "jpg";
  const dateFolder = getDateFolder();
  const pendingFolder = path.join(CONFIG.JOBS_BASE, dateFolder, "PENDING_PAYMENT", getLast4(phone));
  if (!fs.existsSync(pendingFolder)) fs.mkdirSync(pendingFolder, { recursive: true });
  const fileName = `${Date.now()}.${ext}`;
  await downloadFile(mediaUrl, path.join(pendingFolder, fileName));
  db.run(`INSERT INTO files (phone, original_name, saved_name, folder, status) VALUES (?, ?, ?, ?, ?)`,
    [phone, fileName, fileName, pendingFolder, "PENDING_PAYMENT"]);
  return { pendingFolder, fileName, dateFolder };
}

// ─── ORDER PARSER ──────────────────────────────────────────────────────────
function parseOrder(text) {
  const msg = text.toLowerCase();
  const results = [];
  const patterns = [
    /(\d+)\s*(?:pcs|pieces|sheets?)?\s*x?\s*(a[234])/gi,
    /(a[234])\s*x?\s*(\d+)/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(msg)) !== null) {
      let qty, size;
      if (/^\d+$/.test(match[1])) { qty = parseInt(match[1]); size = match[2].toUpperCase(); }
      else { size = match[1].toUpperCase(); qty = parseInt(match[2]); }
      if (CONFIG.PRICES[size] && qty > 0 && !results.find(r => r.size === size))
        results.push({ size, qty });
    }
    if (results.length > 0) break;
  }
  return results;
}

// ─── BUILD BILL ────────────────────────────────────────────────────────────
async function buildBill(items, phone) {
  const total = items.reduce((sum, i) => sum + (i.qty * CONFIG.PRICES[i.size]), 0);
  const itemsStr = items.map(i => `${i.qty} x ${i.size}`).join(", ");

  let bill = `🧾 *${CONFIG.SHOP_NAME} — INVOICE*\n`;
  bill += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  for (const item of items) {
    const sub = item.qty * CONFIG.PRICES[item.size];
    bill += `📄 ${item.qty} x ${item.size} sheets\n`;
    bill += `   @ GHS ${CONFIG.PRICES[item.size].toFixed(2)} = *GHS ${sub.toFixed(2)}*\n`;
  }
  bill += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  bill += `💰 *TOTAL: GHS ${total.toFixed(2)}*\n\n`;
  bill += `📲 *Pay via MTN MoMo* 🟡\n`;
  bill += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  bill += `   📱 *${CONFIG.MOMO}*\n`;
  bill += `   👤 *${CONFIG.MOMO_NAME}*\n`;
  bill += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  bill += `📩 Send your receipt after payment to confirm your order.\n\n`;
  bill += `Thank you for choosing *${CONFIG.SHOP_NAME}!* 🙏`;

  db.run(`INSERT INTO orders (phone, items, total, balance, status, date) VALUES (?, ?, ?, ?, ?, ?)`,
    [phone, itemsStr, total, total, "PENDING_PAYMENT", getDateFolder()]);

  scheduleReminders(phone, total);
  return bill;
}

// ─── REMINDERS ─────────────────────────────────────────────────────────────
function scheduleReminders(phone, total) {
  [
    { min: 10, msg: `⏰ *Payment Reminder*\n\nYour order of *GHS ${total.toFixed(2)}* is awaiting payment.\n\n📱 MoMo: *${CONFIG.MOMO}*\n👤 ${CONFIG.MOMO_NAME}\n\nSend receipt after payment. 🙏` },
    { min: 30, msg: `⚠️ *Second Reminder*\n\nPayment of *GHS ${total.toFixed(2)}* not received yet.\n\nPay to *${CONFIG.MOMO}* and send receipt to proceed.` },
    { min: 60, msg: `🚨 *Final Reminder*\n\nYour order will be cancelled without payment.\n\nPay *GHS ${total.toFixed(2)}* to MoMo: *${CONFIG.MOMO}* now!` }
  ].forEach(({ min, msg }) => {
    setTimeout(async () => {
      return new Promise((resolve) => {
        db.get(`SELECT status FROM orders WHERE phone = ? ORDER BY created_at DESC LIMIT 1`,
          [phone], async (err, row) => {
            if (row && (row.status === "PENDING_PAYMENT" || row.status === "PARTIAL")) {
              await sendMsg(phone, msg);
            }
            resolve();
          });
      });
    }, min * 60 * 1000);
  });
}

// ─── SEND MESSAGE ──────────────────────────────────────────────────────────
async function sendMsg(to, body, mediaUrl) {
  const params = new URLSearchParams();
  params.append("From", CONFIG.TWILIO_NUMBER);
  params.append("To", to);
  params.append("Body", body);
  if (mediaUrl) params.append("MediaUrl", mediaUrl);
  try {
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${CONFIG.TWILIO_SID}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${CONFIG.TWILIO_SID}:${CONFIG.TWILIO_TOKEN}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params
    });
  } catch (err) {
    console.error("Send error:", err);
  }
}

// ─── PAYMENT HANDLER ───────────────────────────────────────────────────────
async function handlePayment(phone, amount) {
  return new Promise((resolve) => {
    const waPhone = `whatsapp:+${phone.replace(/\D/g, "")}`;
    db.get(`SELECT * FROM orders WHERE phone = ? AND status IN ('PENDING_PAYMENT','PARTIAL') ORDER BY created_at DESC LIMIT 1`,
      [waPhone], async (err, order) => {
        if (!order) { console.log("No order found for:", phone); return resolve(); }

        const newPaid = (order.amount_paid || 0) + amount;
        const balance = order.total - newPaid;

        if (newPaid >= order.total) {
          // FULL PAYMENT
          const orderId = await generateOrderId();
          const dateFolder = getDateFolder();
          const orderFolder = path.join(CONFIG.JOBS_BASE, dateFolder, orderId);
          if (!fs.existsSync(orderFolder)) fs.mkdirSync(orderFolder, { recursive: true });

          const pendingFolder = path.join(CONFIG.JOBS_BASE, dateFolder, "PENDING_PAYMENT", getLast4(waPhone));
          if (fs.existsSync(pendingFolder)) {
            fs.readdirSync(pendingFolder).forEach(file => {
              fs.renameSync(path.join(pendingFolder, file), path.join(orderFolder, file));
            });
          }

          db.run(`UPDATE orders SET order_id=?, status='PAID', amount_paid=?, balance=0, folder=?, paid_at=CURRENT_TIMESTAMP WHERE id=?`,
            [orderId, newPaid, orderFolder, order.id]);

          await sendMsg(waPhone,
            `✅ *PAYMENT CONFIRMED!*\n\n` +
            `🧾 *Order ID:* ${orderId}\n` +
            `💰 *Amount Paid:* GHS ${newPaid.toFixed(2)}\n` +
            `📋 *Items:* ${order.items}\n\n` +
            `🖨️ Your job is now in production!\n` +
            `We will notify you when it is ready.\n\n` +
            `Thank you for choosing *${CONFIG.SHOP_NAME}!* 🙏`
          );
          await sendMsg(waPhone, "🎉 Thank you for your payment!", "https://media.giphy.com/media/l0MYt5jPR6QX5pnqM/giphy.gif");

        } else {
          // PARTIAL PAYMENT
          db.run(`UPDATE orders SET status='PARTIAL', amount_paid=?, balance=? WHERE id=?`, [newPaid, balance, order.id]);
          await sendMsg(waPhone,
            `⚠️ *PARTIAL PAYMENT RECEIVED*\n\n` +
            `💰 *Total Bill:* GHS ${order.total.toFixed(2)}\n` +
            `✅ *Amount Paid:* GHS ${newPaid.toFixed(2)}\n` +
            `❌ *Balance Left:* GHS ${balance.toFixed(2)}\n\n` +
            `Please pay the remaining balance:\n` +
            `📱 MoMo: *${CONFIG.MOMO}* (${CONFIG.MOMO_NAME})\n\n` +
            `⚠️ Production starts only after full payment.`
          );
        }
        resolve();
      });
  });
}

function isReceipt(msg) {
  return !!msg.toLowerCase().match(/paid|payment|sent|transferred|momo|receipt|done|screenshot|proof|i paid|i have paid|check|confirm/);
}

// ─── SINGLE WEBHOOK ────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.set("Content-Type", "text/xml");
  const msg = (req.body.Body || "").trim();
  const from = req.body.From;
  const numMedia = parseInt(req.body.NumMedia || "0");

  try {
    // ── Design file ──
    if (numMedia > 0 && !isReceipt(msg)) {
      const { dateFolder } = await handleIncomingFile(req, from);
      return res.send(`<Response><Message>✅ *Design File Received!*\n\n📁 Your file has been saved.\n📅 Date: *${dateFolder}*\n\n⏳ Awaiting payment confirmation before production.\n\nIf you haven't ordered yet, send size and quantity:\n_"50 A4"_ or _"20 A3"_ ✅</Message></Response>`);
    }

    // ── Payment receipt ──
    if (isReceipt(msg)) {
      const order = await new Promise((resolve) => {
        db.get(`SELECT * FROM orders WHERE phone = ? AND status IN ('PENDING_PAYMENT','PARTIAL') ORDER BY created_at DESC LIMIT 1`,
          [from], (err, row) => resolve(row));
      });
      if (order) {
        return res.send(`<Response><Message>✅ *Receipt Received!*\n\nOur team is verifying your payment of *GHS ${order.total.toFixed(2)}*.\n\nYou will receive confirmation shortly. 🙏\n\n*${CONFIG.SHOP_NAME}*</Message></Response>`);
      }
      return res.send(`<Response><Message>Thank you! 🙏 Our team will confirm your payment shortly.\n\n*${CONFIG.SHOP_NAME}*</Message></Response>`);
    }

    // ── Order ──
    const items = parseOrder(msg);
    if (items.length > 0) {
      const bill = await buildBill(items, from);
      return res.send(`<Response><Message>${bill}</Message></Response>`);
    }

    // ── Claude AI reply ──
    const reply = await claudeReply(from, msg);
    res.send(`<Response><Message>${reply}</Message></Response>`);

  } catch (err) {
    console.error("Webhook error:", err);
    res.send(`<Response><Message>Sorry, something went wrong. Please try again. 🙏</Message></Response>`);
  }
});

// ─── MOMO ENDPOINT ─────────────────────────────────────────────────────────
app.post("/momo", async (req, res) => {
  try {
    const sms = req.body.message || req.body.body || req.body.text || "";
    console.log("📲 MoMo SMS:", sms);
    const amountMatch = sms.match(/GHS\s*([\d,]+\.?\d*)/i);
    const phoneMatch = sms.match(/(\+?233\d{9}|0\d{9})/);
    if (!amountMatch) return res.sendStatus(200);
    const amount = parseFloat(amountMatch[1].replace(",", ""));
    const phone = phoneMatch ? phoneMatch[1] : null;
    console.log(`💰 GHS ${amount} from ${phone}`);
    if (phone) await handlePayment(phone, amount);
    res.sendStatus(200);
  } catch (err) {
    console.error("MoMo error:", err);
    res.sendStatus(200);
  }
});

// ─── JOBS DASHBOARD ────────────────────────────────────────────────────────
app.get("/jobs", (req, res) => {
  db.all(`SELECT * FROM orders ORDER BY created_at DESC LIMIT 100`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    let html = `<html><head><title>MIGO DTF Jobs</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      body{font-family:Arial,sans-serif;padding:15px;background:#f5f5f5;}
      h1{color:#ff6600;font-size:1.3rem;}
      table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);}
      th{background:#ff6600;color:#fff;padding:10px 8px;font-size:0.85rem;text-align:left;}
      td{padding:8px;font-size:0.8rem;border-bottom:1px solid #eee;}
      .PAID{color:green;font-weight:bold;}
      .PENDING_PAYMENT{color:orange;font-weight:bold;}
      .PARTIAL{color:red;font-weight:bold;}
    </style></head><body>
    <h1>🖨️ MIGO PRINT SHOP — Jobs</h1>
    <p style="color:#888;font-size:0.8rem">Total: ${rows.length} orders</p>
    <table><tr><th>Order ID</th><th>Phone</th><th>Items</th><th>Total</th><th>Paid</th><th>Balance</th><th>Status</th><th>Date</th></tr>`;
    rows.forEach(r => {
      html += `<tr>
        <td>${r.order_id || "—"}</td>
        <td>${r.phone?.replace("whatsapp:+","")}</td>
        <td>${r.items}</td>
        <td>GHS ${r.total?.toFixed(2)}</td>
        <td>GHS ${r.amount_paid?.toFixed(2)||"0.00"}</td>
        <td>GHS ${r.balance?.toFixed(2)||r.total?.toFixed(2)}</td>
        <td class="${r.status}">${r.status}</td>
        <td>${r.date}</td></tr>`;
    });
    html += `</table></body></html>`;
    res.send(html);
  });
});

app.get("/", (req, res) => res.send(`
  <html><body style="font-family:Arial;padding:20px;text-align:center;">
  <h2>🖨️ MIGO PRINT SHOP</h2>
  <p>WhatsApp Bot + Job Management System</p>
  <p style="color:green;font-weight:bold;">✅ Running with Claude AI</p>
  <a href="/jobs" style="background:#ff6600;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;">📋 View Jobs Dashboard</a>
  </body></html>
`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 MIGO DTF + Claude AI running on port ${PORT}`));
