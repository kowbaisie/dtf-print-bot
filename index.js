const express = require("express");
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
const PRICES = { A4: 3.20, A3: 6.40, A2: 16.00 };
const MOMO = "0552719245";
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
app.post("/webhook", (req, res) => {
  const msg = (req.body.Body || "").trim();
  const items = parseOrder(msg);
  let reply;
  if (items.length > 0) {
    let total = 0;
    let bill = "Hello! 👋\n\n🧾 *YOUR DTF PRINT BILL*\n━━━━━━━━━━━━━━━━━━━━\n";
    for (const item of items) {
      const sub = item.qty * PRICES[item.size];
      total += sub;
      bill += `📄 ${item.qty} x ${item.size} @ GHS ${PRICES[item.size].toFixed(2)} = *GHS ${sub.toFixed(2)}*\n`;
    }
    bill += `━━━━━━━━━━━━━━━━━━━━\n💰 *TOTAL: GHS ${total.toFixed(2)}*\n\n`;
    bill += `📲 *Pay via MoMo:*\n   Number: *${MOMO}*\n   Name: *DTF Print Shop*\n\n`;
    bill += `📩 Send me your payment receipt to complete your order.\n\nThank you! 🙏`;
    reply = bill;
  } else {
    reply = `👋 Welcome to *DTF Print Shop!*\n\n📋 *Our Prices:*\n• A4 → GHS 3.20\n• A3 → GHS 6.40\n• A2 → GHS 16.00\n\n💬 Just send your order like:\n_"50 A4"_ or _"20 A3 and 10 A2"_\n\nWe'll send your bill instantly! ✅`;
  }
  res.set("Content-Type", "text/xml");
  res.send(`<Response><Message>${reply}</Message></Response>`);
});
app.get("/", (req, res) => res.send("DTF Bot Running ✅"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Bot running on port " + PORT));
