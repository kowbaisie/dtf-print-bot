const express = require("express");
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

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
};

const orders = new Map();
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

async function claudeReply(phone, customerMessage) {
  try {
    const history = getHistory(phone);
    addToHistory(phone, "user", customerMessage);
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
        system: `You are a friendly WhatsApp assistant for MIGO PRINT SHOP, a DTF printing business in Accra, Ghana.
SHOP: Circle, near Benz Gate. Hours: Mon-Sat 8am-6pm.
PRICES: A4=GHS 3.20, A3=GHS 6.40, A2=GHS 16.00 per sheet.
PAYMENT: MTN MoMo 0552719245 (Kow Habib Baisie).
RULES: Be friendly. Understand Ghanaian Pidgin. Keep replies under 150 words. Guide customers to order. Never say you are AI. To order send size and quantity e.g 50 A4.`,
        messages: history
      })
    });
    const data = await response.json();
    if (data.error || !data.content) {
      console.log("Claude error:", JSON.stringify(data.error));
      return smartFallback(customerMessage);
    }
    const reply = data.content[0].text;
    addToHistory(phone, "assistant", reply);
    return reply;
  } catch (err) {
    console.log("Claude failed:", err.message);
    return smartFallback(customerMessage);
  }
}

function smartFallback(msg) {
  const m = msg.toLowerCase();
  if (m.match(/price|cost|how much|charge|rate/))
    return "Our DTF Prices: A4 GHS 3.20, A3 GHS 6.40, A2 GHS 16.00. Send order like 50 A4";
  if (m.match(/location|where|address/))
    return "MIGO PRINT SHOP - Circle, near Benz Gate";
  if (m.match(/time|open|hours/))
    return "Mon-Sat 8am-6pm. Sunday Closed.";
  if (m.match(/dtf|print|do you|services/))
    return "Yes! We do DTF printing on all fabrics! A4 GHS 3.20, A3 GHS 6.40, A2 GHS 16.00. Send 50 A4 to order!";
  if (m.match(/pay|momo|payment|account/))
    return "MTN MoMo: 0552719245 (Kow Habib Baisie). Send receipt after payment.";
  return "Welcome to MIGO PRINT SHOP! Circle, near Benz Gate. Prices: A4 GHS 3.20, A3 GHS 6.40, A2 GHS 16.00. Send order like 50 A4";
}

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

function buildBill(items, phone) {
  const total = items.reduce((sum, i) => sum + (i.qty * CONFIG.PRICES[i.size]), 0);
  const itemsStr = items.map(i => `${i.qty} x ${i.size}`).join(", ");
  let bill = "MIGO PRINT SHOP - INVOICE\n";
  bill += "------------------------\n";
  for (const item of items) {
    const sub = item.qty * CONFIG.PRICES[item.size];
    bill += `${item.qty} x ${item.size} @ GHS ${CONFIG.PRICES[item.size].toFixed(2)} = GHS ${sub.toFixed(2)}\n`;
  }
  bill += "------------------------\n";
  bill += `TOTAL: GHS ${total.toFixed(2)}\n\n`;
  bill += `Pay via MTN MoMo:\n`;
  bill += `Number: ${CONFIG.MOMO}\n`;
  bill += `Name: ${CONFIG.MOMO_NAME}\n\n`;
  bill += "Send your receipt after payment to confirm.\n";
  bill += "Thank you for choosing MIGO PRINT SHOP!";
  orders.set(phone, { items, total, itemsStr, paid: false, createdAt: Date.now() });
  scheduleReminders(phone, total);
  return bill;
}

function scheduleReminders(phone, total) {
  [
    { min: 10, msg: `Payment Reminder: Your order of GHS ${total.toFixed(2)} is awaiting payment. MoMo: ${CONFIG.MOMO} (${CONFIG.MOMO_NAME}). Send receipt after payment.` },
    { min: 30, msg: `Second Reminder: Payment of GHS ${total.toFixed(2)} not received. Pay to ${CONFIG.MOMO} and send receipt.` },
    { min: 60, msg: `Final Reminder: Your order will be cancelled without payment. Pay GHS ${total.toFixed(2)} to MoMo: ${CONFIG.MOMO} now!` }
  ].forEach(({ min, msg }) => {
    setTimeout(async () => {
      const order = orders.get(phone);
      if (order && !order.paid) await sendMsg(phone, msg);
    }, min * 60 * 1000);
  });
}

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
  } catch (err) { console.log("Send error:", err.message); }
}

function isReceipt(msg) {
  return !!msg.toLowerCase().match(/paid|payment|sent|transferred|momo|receipt|done|proof|i paid|i have paid|confirm/);
}

function xml(msg) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg}</Message></Response>`;
}

app.post("/webhook", async (req, res) => {
  res.set("Content-Type", "text/xml");
  const msg = (req.body.Body || "").trim();
  const from = req.body.From;
  const numMedia = parseInt(req.body.NumMedia || "0");
  console.log(`MSG: ${from} - ${msg}`);
  try {
    if (numMedia > 0 && !isReceipt(msg)) {
      return res.send(xml("Design File Received! Your file has been saved. Complete payment to proceed. To order send: 50 A4 or 20 A3"));
    }
    if (isReceipt(msg)) {
      const order = orders.get(from);
      if (order && !order.paid) {
        order.paid = true;
        await sendMsg(from, "Thank you for your payment!", "https://media.giphy.com/media/l0MYt5jPR6QX5pnqM/giphy.gif");
        return res.send(xml(`Payment Confirmed! Items: ${order.itemsStr}. Amount: GHS ${order.total.toFixed(2)}. Your job is in production! We will notify you when ready. Thank you! MIGO PRINT SHOP`));
      }
      return res.send(xml("Receipt received! Our team will confirm shortly. MIGO PRINT SHOP"));
    }
    const items = parseOrder(msg);
    if (items.length > 0) {
      return res.send(xml(buildBill(items, from)));
    }
    const reply = await claudeReply(from, msg);
    res.send(xml(reply));
  } catch (err) {
    console.log("Webhook error:", err.message);
    res.send(xml("Sorry, something went wrong. Please try again."));
  }
});

app.post("/momo", async (req, res) => {
  try {
    const sms = req.body.message || req.body.body || req.body.text || "";
    const amountMatch = sms.match(/GHS\s*([\d,]+\.?\d*)/i);
    const phoneMatch = sms.match(/(\+?233\d{9}|0\d{9})/);
    if (!amountMatch) return res.sendStatus(200);
    const amount = parseFloat(amountMatch[1].replace(",", ""));
    const phone = phoneMatch ? `whatsapp:+${phoneMatch[1].replace(/\D/g, "")}` : null;
    if (phone) {
      const order = orders.get(phone);
      if (order && !order.paid) {
        if (amount >= order.total) {
          order.paid = true;
          await sendMsg(phone, "Payment Confirmed! Your job is in production! We will notify you when ready. Thank you!");
        } else {
          const balance = order.total - amount;
          await sendMsg(phone, `Partial Payment received. Paid: GHS ${amount.toFixed(2)}. Balance: GHS ${balance.toFixed(2)}. Pay remaining to: ${CONFIG.MOMO}`);
        }
      }
    }
    res.sendStatus(200);
  } catch (err) { res.sendStatus(200); }
});

app.get("/jobs", (req, res) => {
  let html = "<html><head><title>MIGO Jobs</title><meta name='viewport' content='width=device-width,initial-scale=1'><style>body{font-family:Arial;padding:15px;background:#f5f5f5;}h1{color:#ff6600;}.job{background:#fff;padding:12px;margin:8px 0;border-radius:8px;}</style></head><body>";
  html += `<h1>MIGO PRINT SHOP</h1><p>${orders.size} orders</p>`;
  orders.forEach((o, phone) => {
    html += `<div class='job'><strong>${phone.replace("whatsapp:+","")}</strong><br>${o.itemsStr}<br>GHS ${o.total.toFixed(2)}<br>${o.paid ? "PAID" : "PENDING"}</div>`;
  });
  html += "</body></html>";
  res.send(html);
});

app.get("/", (req, res) => res.send("<html><body style='font-family:Arial;padding:20px;text-align:center;'><h2>MIGO PRINT SHOP</h2><p style='color:green;'>Running with Claude AI</p><a href='/jobs' style='background:#ff6600;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;'>View Jobs</a></body></html>"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MIGO PRINT SHOP running on port ${PORT}`));
