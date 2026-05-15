const express = require("express");
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PRICES = { A4: 3.20, A3: 6.40, A2: 16.00 };
const MOMO = "0552719245";
const MOMO_NAME = "KOW HABIB BAISIE";
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = "whatsapp:+14155238886";

const pendingOrders = new Map();

const WELCOME = `👋 Welcome to *MIGO PRINT SHOP!*
📍 Circle near Benz Gate

📋 *Our DTF Prices:*
• A4 → GHS 3.20
• A3 → GHS 6.40
• A2 → GHS 16.00

💬 Send your order like:
_"50 A4"_ or _"20 A3 and 10 A2"_

We'll send your bill instantly! ✅`;

function parseOrder(text) {
  const msg = text.toLowerCase();
  const results = [];
  const pattern = /(\d+)\s*x?\s*(a[234])/gi;
  let match;
  while ((match = pattern.exec(msg)) !== null) {
    const qty = parseInt(match[1]);
    const size = match[2].toUpperCase();
    if (PRICES[size] && qty > 0) results.push({ size, qty });
  }
  return results;
}

function buildBill(items, customer) {
  let total = 0;
  let bill = "Hello! 👋\n\n🧾 *YOUR DTF PRINT BILL*\n━━━━━━━━━━━━━━━━━━━━\n";
  for (const item of items) {
    const sub = item.qty * PRICES[item.size];
    total += sub;
    bill += `📄 ${item.qty} x ${item.size} @ GHS ${PRICES[item.size].toFixed(2)} = *GHS ${sub.toFixed(2)}*\n`;
  }
  bill += `━━━━━━━━━━━━━━━━━━━━\n💰 *TOTAL: GHS ${total.toFixed(2)}*\n\n`;
  bill += `📲 *Pay via MTN MoMo* 🟡\n`;
  bill += `━━━━━━━━━━━━━━━━━━━━\n`;
  bill += `   📱 Number: *${MOMO}*\n`;
  bill += `   👤 Name: *${MOMO_NAME}*\n`;
  bill += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  bill += `📩 Send your payment receipt to complete your order.\n\nThank you for choosing Migo Print Shop! 🙏`;

  pendingOrders.set(customer, { items, total, paid: false, createdAt: Date.now() });
  scheduleReminders(customer, total);
  return bill;
}

function scheduleReminders(customer, total) {
  const times = [
    { min: 10, msg: `⏰ *Reminder:* Your order of GHS ${total.toFixed(2)} is still pending.\n\nPlease send payment to:\n📱 *${MOMO}* (${MOMO_NAME})\n\nSend receipt to confirm. 🙏` },
    { min: 30, msg: `⚠️ *Second Reminder:* We haven't received your payment yet.\n\nGHS ${total.toFixed(2)} → MoMo *${MOMO}*\n\nYour order will be cancelled if not paid soon.` },
    { min: 60, msg: `🚨 *Final Reminder:* Your order of GHS ${total.toFixed(2)} will be cancelled.\n\nPay now to *${MOMO}* and send receipt to keep your order.` }
  ];
  times.forEach(({ min, msg }) => {
    setTimeout(async () => {
      const order = pendingOrders.get(customer);
      if (!order || order.paid) return;
      await sendMsg(customer, msg);
    }, min * 60 * 1000);
  });
}

async function sendMsg(to, body, mediaUrl) {
  const params = new URLSearchParams();
  params.append("From", TWILIO_NUMBER);
  params.append("To", to);
  params.append("Body", body);
  if (mediaUrl) params.append("MediaUrl", mediaUrl);
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params
  });
}

function isReceipt(msg, numMedia) {
  const m = msg.toLowerCase();
  return numMedia > 0 || m.match(/paid|payment|sent|transferred|momo|receipt|done|screenshot|proof|i paid|i have paid/);
}

function autoReply(msg) {
  const m = msg.toLowerCase();
  if (m.match(/hi|hello|hey|morning|afternoon|evening|how are|what can/)) return WELCOME;
  if (m.match(/price|cost|how much|charges|rate/)) return `📋 *Our DTF Prices:*\n• A4 → GHS 3.20\n• A3 → GHS 6.40\n• A2 → GHS 16.00\n\nNo minimum order! Send size & quantity for instant bill. 😊`;
  if (m.match(/dtf|print|do you|services|offer/)) return `Yes! ✅ We print *DTF transfers* at *MIGO PRINT SHOP*\n\n📍 Circle near Benz Gate\n✔️ All fabrics\n✔️ Dark & light colours\n✔️ No minimum order\n\nSend your order for instant bill!`;
  if (m.match(/location|where|address|find you/)) return `📍 *MIGO PRINT SHOP*\nCircle, near Benz Gate\n\nVisit us or order via WhatsApp! 😊`;
  if (m.match(/time|open|hours|working/)) return `🕐 *Working Hours:*\nMon – Sat: 8am – 6pm\nSunday: Closed\n\nOrder on WhatsApp anytime! ✅`;
  if (m.match(/momo|payment|pay|account/)) return `📲 *MTN MoMo* 🟡\n━━━━━━━━━━━━━━━━━━━━\n📱 *${MOMO}*\n👤 *${MOMO_NAME}*\n━━━━━━━━━━━━━━━━━━━━\nSend receipt after payment. 🙏`;
  if (m.match(/how long|ready|turnaround/)) return `⏱️ Most orders ready *same day* or *next day*!\n\nSend your order now! 💪`;
  if (m.match(/thank|thanks|okay|ok|great|perfect|noted/)) return `You're welcome! 😊\n\n*MIGO PRINT SHOP* — Circle near Benz Gate 🙏`;
  return WELCOME;
}

app.post("/webhook", async (req, res) => {
  const msg = (req.body.Body || "").trim();
  const from = req.body.From;
  const numMedia = parseInt(req.body.NumMedia || "0");

  res.set("Content-Type", "text/xml");

  if (isReceipt(msg, numMedia)) {
    await sendMsg(from, "🎉 *Payment Received! Thank You!* 🎉", "https://media.giphy.com/media/l0MYt5jPR6QX5pnqM/giphy.gif");
    const order = pendingOrders.get(from);
    if (order) order.paid = true;
    const confirm = `✅ *Payment Confirmed!*\n\n🖨️ Your job is being processed and we will notify you when it is ready.\n\nThank you for choosing *MIGO PRINT SHOP!* 🙏\n📍 Circle near Benz Gate`;
    return res.send(`<Response><Message>${confirm}</Message></Response>`);
  }

  const items = parseOrder(msg);
  if (items.length > 0) {
    return res.send(`<Response><Message>${buildBill(items, from)}</Message></Response>`);
  }

  res.send(`<Response><Message>${autoReply(msg)}</Message></Response>`);
});

app.post("/momo", async (req, res) => {
  const sms = req.body.message || "";
  const amountMatch = sms.match(/GHS\s*([\d.]+)/i);
  if (!amountMatch) return res.sendStatus(200);
  const amount = parseFloat(amountMatch[1]);

  for (const [customer, order] of pendingOrders.entries()) {
    if (!order.paid && Math.abs(order.total - amount) < 0.01) {
      order.paid = true;
      await sendMsg(customer, "🎉 *Payment Received! Thank You!* 🎉", "https://media.giphy.com/media/l0MYt5jPR6QX5pnqM/giphy.gif");
      await sendMsg(customer, `✅ *Payment Confirmed!*\n\n🖨️ Your job is being processed and we will notify you when it is ready.\n\nThank you for choosing *MIGO PRINT SHOP!* 🙏`);
      break;
    }
  }
  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("MIGO PRINT SHOP Bot Running ✅"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Bot running on port " + PORT));
