const express = require("express");
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const CONFIG = {
  SHOP_NAME: "MIGO PRINT SHOP",
  LOCATION: "Circle branch, near Benz Gate, closer to Calvary Church",
  MOMO: "0552719245",
  MOMO_NAME: "Kow Habib Baisie",
  PRICES: { A4: 3.20, A3: 6.40, A2: 16.00 },
  TWILIO_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER: "whatsapp:+14155238886",
  ANTHROPIC_KEY: process.env.ANTHROPIC_API_KEY,
  ADMIN_KEY: "admin",
};

const sessions = new Map();
const conversations = new Map();
const ratings = new Map();
let BOT_ACTIVE = true;

function newSession() {
  return {
    phase: "COLLECTING",
    knownItems: {},
    unknownFiles: [],
    files: [],
    clarificationTimer: null,
    clarificationCount: 0,
    clarificationDay: 0,
    clarifyRemindersToday: 0,
    billTimer: null,
    confirmTimer: null,
    pendingBill: null,
    total: 0,
    itemsStr: "",
    paid: false,
    orderReady: false,
    lastActivity: Date.now(),
  };
}

function getSession(phone) {
  if (!sessions.has(phone)) sessions.set(phone, newSession());
  return sessions.get(phone);
}

function clearTimers(session) {
  if (session.billTimer) clearTimeout(session.billTimer);
  if (session.confirmTimer) clearTimeout(session.confirmTimer);
  if (session.clarificationTimer) clearTimeout(session.clarificationTimer);
  session.billTimer = null;
  session.confirmTimer = null;
  session.clarificationTimer = null;
}

function getHistory(phone) {
  if (!conversations.has(phone)) conversations.set(phone, []);
  return conversations.get(phone);
}

function addToHistory(phone, role, content) {
  const history = getHistory(phone);
  history.push({ role, content });
  if (history.length > 20) history.shift();
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
        model: "claude-sonnet-4-20250514",
        max_tokens: 400,
        system: "You are a professional WhatsApp customer service assistant for MIGO PRINT SHOP, a DTF printing business in Accra, Ghana.\nSHOP INFO:\n- Name: MIGO PRINT SHOP\n- Location: Circle branch, near Benz Gate, closer to Calvary Church\n- Hours: Monday-Saturday 8am-6pm, Sunday closed\n- Service: DTF (Direct to Film) printing on all fabrics\nPRICES:\n- A4 = GHS 3.20 per sheet\n- A3 = GHS 6.40 per sheet\n- A2 = GHS 16.00 per sheet\nPAYMENT: MTN MoMo 0552719245 (Kow Habib Baisie)\nPERSONALITY:\n- Professional but friendly\n- Understand Ghanaian Pidgin (boss, chaley, dey, abeg, saa etc)\n- No greetings unless customer greets first\n- Keep replies SHORT and direct\n- Never reveal you are AI\n- Ask for clarification when unclear\n- Only give prices when asked",
        messages: history
      })
    });
    const data = await response.json();
    if (data.error || !data.content) return null;
    const reply = data.content[0].text;
    addToHistory(phone, "assistant", reply);
    return reply;
  } catch (err) {
    console.log("Claude error:", err.message);
    return null;
  }
}

async function claudeCalculate(items, files) {
  try {
    const itemList = Object.entries(items).map(([size, qty]) => qty + " x " + size).join(", ");
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CONFIG.ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        system: "You are a precise calculator for MIGO PRINT SHOP DTF printing.\nPRICES: A4=GHS 3.20, A3=GHS 6.40, A2=GHS 16.00 per sheet.\nCalculate accurately. Double check your math. Return ONLY JSON.",
        messages: [{
          role: "user",
          content: "Calculate this order:\nItems: " + itemList + "\nFiles: " + files.join(", ") + '\nReturn JSON only:\n{"items":[{"size":"A4","qty":20,"unitPrice":3.20,"subtotal":64.00}],"total":64.00,"itemsStr":"20 x A4","verified":true}'
        }]
      })
    });
    const data = await response.json();
    if (data.error || !data.content) return null;
    const text = data.content[0].text;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1) return JSON.parse(text.slice(start, end + 1));
    return null;
  } catch (err) {
    console.log("Calculate error:", err.message);
    return null;
  }
}

// ✅ SAFE parseOrder - no regex backslash issues
function parseOrder(text) {
  if (!text) return {};
  const msg = text.toLowerCase();
  const totals = {};
  const words = msg.split(/\s+/);

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1] || "";

    // "20 a4" or "20 a3"
    if (/^\d+$/.test(w) && /^a[234]$/.test(next)) {
      const qty = parseInt(w);
      const size = next.toUpperCase();
      if (CONFIG.PRICES[size] && qty > 0) totals[size] = (totals[size] || 0) + qty;
    }

    // "a4 20" or "a3 20"
    if (/^a[234]$/.test(w) && /^\d+$/.test(next)) {
      const size = w.toUpperCase();
      const qty = parseInt(next);
      if (CONFIG.PRICES[size] && qty > 0) totals[size] = (totals[size] || 0) + qty;
    }

    // "20xa4" or "20a4"
    const m1 = w.match(/^(\d+)x?(a[234])$/);
    if (m1) {
      const qty = parseInt(m1[1]);
      const size = m1[2].toUpperCase();
      if (CONFIG.PRICES[size] && qty > 0) totals[size] = (totals[size] || 0) + qty;
    }

    // "a4x20" or "a420"
    const m2 = w.match(/^(a[234])x?(\d+)$/);
    if (m2) {
      const size = m2[1].toUpperCase();
      const qty = parseInt(m2[2]);
      if (CONFIG.PRICES[size] && qty > 0) totals[size] = (totals[size] || 0) + qty;
    }
  }
  return totals;
}

function mergeItems(a, b) {
  const result = Object.assign({}, a);
  for (const size in b) {
    result[size] = (result[size] || 0) + b[size];
  }
  return result;
}

function calcReadyTime(items) {
  const a4eq = (items.A4 || 0) + ((items.A3 || 0) * 2) + ((items.A2 || 0) * 4);
  const now = new Date();
  let hoursNeeded;
  if (a4eq <= 50) hoursNeeded = 2;
  else if (a4eq <= 100) hoursNeeded = 3;
  else if (a4eq <= 200) hoursNeeded = 4;
  else if (a4eq <= 400) hoursNeeded = 6;
  else if (a4eq <= 800) hoursNeeded = 8;
  else hoursNeeded = 24;
  const readyTime = new Date(now.getTime() + hoursNeeded * 60 * 60 * 1000);
  const readyHour = readyTime.getHours();
  if (readyHour >= 18 || readyHour < 8) return "Tomorrow by 12:00 PM";
  const period = readyHour >= 12 ? "PM" : "AM";
  const displayHour = readyHour > 12 ? readyHour - 12 : readyHour;
  const mins = readyTime.getMinutes();
  const minsStr = mins > 0 ? ":" + String(mins).padStart(2, "0") : "";
  if (readyTime.getDate() === now.getDate()) return "Today by " + displayHour + minsStr + period;
  return "Tomorrow by " + displayHour + minsStr + period;
}

function buildBill(calcResult) {
  const items = calcResult.items;
  const total = calcResult.total;
  let bill = "👋 Hello!\n\n🧾 *YOUR DTF PRINT BILL*\n━━━━━━━━━━━━━━━━━━━━━━\n";
  for (const item of items) {
    bill += "📄 " + item.qty + " x " + item.size + " @ GHS " + item.unitPrice.toFixed(2) + " = *GHS " + item.subtotal.toFixed(2) + "*\n";
  }
  bill += "━━━━━━━━━━━━━━━━━━━━━━\n";
  bill += "💰 *TOTAL: GHS " + total.toFixed(2) + "*\n\n";
  bill += "📲 *Pay via MTN MoMo* 🟡\n";
  bill += "━━━━━━━━━━━━━━━━━━━━━━\n";
  bill += "   📱 Number: *" + CONFIG.MOMO + "*\n";
  bill += "   👤 Name: *" + CONFIG.MOMO_NAME + "*\n";
  bill += "━━━━━━━━━━━━━━━━━━━━━━\n\n";
  bill += "📩 Please send your payment receipt to *COMPLETE* and *SPEED UP* your order 🚀🙏";
  return bill;
}

function buildSummary(calcResult) {
  const items = calcResult.items;
  const total = calcResult.total;
  let summary = "📋 *ORDER SUMMARY*\n━━━━━━━━━━━━━━━━━━━━━━\n";
  for (const item of items) {
    summary += "📄 " + item.qty + " x " + item.size + " = GHS " + item.subtotal.toFixed(2) + "\n";
  }
  summary += "━━━━━━━━━━━━━━━━━━━━━━\n";
  summary += "💰 *TOTAL: GHS " + total.toFixed(2) + "*\n\n";
  summary += "✅ Please *confirm* this order to proceed.\n";
  summary += "❌ Or let us know if you need any changes.";
  return summary;
}

// ✅ BUG FIXED: removed broken "to !== from"
async function sendMsg(to, body, mediaUrl) {
  if (!BOT_ACTIVE) return;
  const params = new URLSearchParams();
  params.append("From", CONFIG.TWILIO_NUMBER);
  params.append("To", to);
  params.append("Body", body);
  if (mediaUrl) params.append("MediaUrl", mediaUrl);
  try {
    const response = await fetch(
      "https://api.twilio.com/2010-04-01/Accounts/" + CONFIG.TWILIO_SID + "/Messages.json",
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(CONFIG.TWILIO_SID + ":" + CONFIG.TWILIO_TOKEN).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params
      }
    );
    const result = await response.json();
    if (result.error_code) {
      console.log("❌ Twilio error: " + result.error_message);
    } else {
      console.log("✅ Sent to " + to + ": " + body.substring(0, 50) + "...");
    }
  } catch (err) {
    console.log("Send error:", err.message);
  }
}

function scheduleReminders(phone, total) {
  const r1 = "⏰ *Payment Reminder*\n\nYour order of *GHS " + total.toFixed(2) + "* is awaiting payment.\n\n📱 MoMo: *" + CONFIG.MOMO + "*\n👤 " + CONFIG.MOMO_NAME + "\n\n📩 Send your receipt to complete your order. 🙏";
  const r2 = "⚠️ *Second Reminder*\n\nYour payment of *GHS " + total.toFixed(2) + "* has not been received.\n\nPay to: 📱 *" + CONFIG.MOMO + "* (" + CONFIG.MOMO_NAME + ")\n\nSend receipt to proceed. 🙏";
  const r3 = "🚨 *Final Reminder*\n\nYour order will be *cancelled* if payment not received.\n\nPay *GHS " + total.toFixed(2) + "* to:\n📱 *" + CONFIG.MOMO + "* (" + CONFIG.MOMO_NAME + ") now!\n\nThank you 🙏";
  setTimeout(async () => { const s = sessions.get(phone); if (s && !s.paid) await sendMsg(phone, r1); }, 10 * 60 * 1000);
  setTimeout(async () => { const s = sessions.get(phone); if (s && !s.paid) await sendMsg(phone, r2); }, 30 * 60 * 1000);
  setTimeout(async () => { const s = sessions.get(phone); if (s && !s.paid) await sendMsg(phone, r3); }, 60 * 60 * 1000);
}

function scheduleClarificationReminders(phone) {
  const session = getSession(phone);
  session.clarificationCount = 0;
  session.clarifyRemindersToday = 0;
  const remind = async () => {
    const s = sessions.get(phone);
    if (!s || s.unknownFiles.length === 0) return;
    if (s.clarifyRemindersToday >= 5) {
      s.clarificationDay++;
      s.clarifyRemindersToday = 0;
      if (s.clarificationDay >= 2) return;
    }
    s.clarificationCount++;
    s.clarifyRemindersToday++;
    const fileList = s.unknownFiles.map(f => "📄 " + f).join("\n");
    await sendMsg(phone, "📋 *Clarification Needed*\n\nWe still need size and quantity for:\n" + fileList + "\n\nReply e.g: _\"logo1.png → 20 A4\"_\n\nThank you! 🙏");
    const interval = s.clarificationCount <= 3 ? 5 * 60 * 1000 : 60 * 60 * 1000;
    s.clarificationTimer = setTimeout(remind, interval);
  };
  session.clarificationTimer = setTimeout(remind, 5 * 60 * 1000);
}

async function processBill(phone) {
  const session = getSession(phone);
  clearTimers(session);
  if (Object.keys(session.knownItems).length === 0 && session.unknownFiles.length === 0) return;
  await sendMsg(phone, "📦 *Order received. Thank you!*\n\nWe will send you the cost shortly. ⏳");
  if (Object.keys(session.knownItems).length === 0) {
    if (session.unknownFiles.length > 0) {
      const fileList = session.unknownFiles.map(f => "📄 " + f).join("\n");
      await sendMsg(phone, "📋 *Clarification Needed*\n\nPlease provide size and quantity for:\n" + fileList + "\n\ne.g. _\"logo1.png → 20 A4\"_ 🙏");
      scheduleClarificationReminders(phone);
    }
    return;
  }
  const calcResult = await claudeCalculate(session.knownItems, session.files);
  if (!calcResult) {
    const items = Object.entries(session.knownItems).map(([size, qty]) => ({
      size, qty, unitPrice: CONFIG.PRICES[size], subtotal: qty * CONFIG.PRICES[size]
    }));
    const total = items.reduce((sum, i) => sum + i.subtotal, 0);
    await sendSummaryAndBill(phone, { items, total, itemsStr: items.map(i => i.qty + " x " + i.size).join(", ") }, session);
    return;
  }
  await sendSummaryAndBill(phone, calcResult, session);
}

async function sendSummaryAndBill(phone, calcResult, session) {
  session.pendingBill = calcResult;
  session.phase = "CONFIRMING";
  await sendMsg(phone, buildSummary(calcResult));
  session.confirmTimer = setTimeout(async () => {
    const s = sessions.get(phone);
    if (s && s.phase === "CONFIRMING" && s.pendingBill) await sendBill(phone, s.pendingBill, s);
  }, 5 * 60 * 1000);
}

async function sendBill(phone, calcResult, session) {
  clearTimers(session);
  session.total = calcResult.total;
  session.itemsStr = calcResult.itemsStr;
  session.phase = "WAITING_RECEIPT";
  await sendMsg(phone, buildBill(calcResult));
  if (session.unknownFiles.length > 0) {
    const fileList = session.unknownFiles.map(f => "📄 " + f).join("\n");
    await sendMsg(phone, "⚠️ *Note:* These files were not included:\n" + fileList + "\n\nPlease clarify size/quantity. 🙏");
    scheduleClarificationReminders(phone);
  }
  scheduleReminders(phone, calcResult.total);
}

function isFinished(msg) {
  const m = msg.toLowerCase();
  return ["yes","yeah","yep","yh","done","finish","finished","proceed","send","okay","ok","fine","alright","sure","correct","right"].some(w => m.includes(w));
}

function isNo(msg) {
  const m = msg.toLowerCase();
  return ["no","nope","nah","not yet","wait","still","more","adding","hold on"].some(w => m.includes(w));
}

function isConfirm(msg) {
  const m = msg.toLowerCase();
  return ["yes","yeah","confirm","correct","right","ok","okay","proceed","sure","fine","alright"].some(w => m.includes(w));
}

function isReceipt(msg, numMedia) {
  const m = msg.toLowerCase();
  const hasPay = ["paid","momo receipt","payment receipt","i have paid","payment done","i paid","receipt","transaction","confirm payment","transferred","sent payment"].some(w => m.includes(w));
  const hasFile = ["sent files","uploaded","design","image files"].some(w => m.includes(w));
  if (numMedia > 0 && !hasPay) return false;
  if (hasFile && !hasPay) return false;
  return hasPay;
}

async function handleAdmin(msg, from) {
  const m = msg.trim();
  if (m === "h") {
    BOT_ACTIVE = false;
    await sendMsg(from, "🔴 *Bot STOPPED.*\nType *admin j* to restart.");
    return true;
  }
  if (m === "j") {
    BOT_ACTIVE = true;
    await sendMsg(from, "🟢 *Bot STARTED.* Resuming all customer replies.");
    return true;
  }
  if (m.startsWith("override ")) {
    const parts = m.split(" ");
    const customerPhone = "whatsapp:+233" + parts[1].replace(/^0/, "");
    const customMsg = parts.slice(2).join(" ");
    await sendMsg(customerPhone, customMsg);
    await sendMsg(from, "✅ Sent to " + parts[1] + ": \"" + customMsg + "\"");
    return true;
  }
  if (m.startsWith("info ")) {
    const parts = m.split(" ");
    const customerPhone = "whatsapp:+233" + parts[1].replace(/^0/, "");
    const info = parts.slice(2).join(" ");
    const session = getSession(customerPhone);
    const newItems = parseOrder(info);
    if (Object.keys(newItems).length > 0) {
      session.knownItems = mergeItems(session.knownItems, newItems);
      session.unknownFiles = [];
      clearTimers(session);
      await processBill(customerPhone);
      await sendMsg(from, "✅ Info added for " + parts[1] + ". Bill recalculated.");
    } else {
      await sendMsg(from, "⚠️ Could not parse: \"" + info + "\". Try: \"admin info 0244123456 20 A4\"");
    }
    return true;
  }
  if (m.startsWith("ready ")) {
    const parts = m.split(" ");
    const customerPhone = "whatsapp:+233" + parts[1].replace(/^0/, "");
    const session = getSession(customerPhone);
    session.orderReady = true;
    await sendMsg(customerPhone, "✅ *Your order is ready for pickup!* 🎉\n\n📍 *" + CONFIG.SHOP_NAME + "*\n" + CONFIG.LOCATION + "\n\nPlease come with your payment receipt. 🙏");
    setTimeout(async () => {
      await sendMsg(customerPhone, "⭐ *How was your experience?*\n\n1️⃣ Poor\n2️⃣ Fair\n3️⃣ Good\n4️⃣ Very Good\n5️⃣ Excellent\n\nReply 1-5 😊");
      ratings.set(customerPhone, true);
    }, 30 * 60 * 1000);
    await sendMsg(from, "✅ Ready notification sent to " + parts[1] + ".");
    return true;
  }
  if (m.startsWith("status ")) {
    const parts = m.split(" ");
    const customerPhone = "whatsapp:+233" + parts[1].replace(/^0/, "");
    const session = sessions.get(customerPhone);
    if (session) {
      await sendMsg(from, "📊 *Status for " + parts[1] + "*\nPhase: " + session.phase + "\nItems: " + JSON.stringify(session.knownItems) + "\nUnknown: " + session.unknownFiles.length + "\nTotal: GHS " + session.total + "\nPaid: " + session.paid);
    } else {
      await sendMsg(from, "No session for " + parts[1]);
    }
    return true;
  }
  return false;
}

function xml(msg) {
  if (!msg) return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + msg + '</Message></Response>';
}

app.post("/webhook", async (req, res) => {
  res.set("Content-Type", "text/xml");
  res.send(xml(""));

  const msg = (req.body.Body || "").trim();
  const from = req.body.From;
  const numMedia = parseInt(req.body.NumMedia || "0");
  const filenames = [];
  for (let i = 0; i < numMedia; i++) {
    filenames.push(req.body["MediaFilename" + i] || "file_" + (i + 1));
  }

  console.log("📩 " + from + " | \"" + msg + "\" | Media: " + numMedia + " | Files: " + filenames.join(", "));

  if (msg.toLowerCase().startsWith(CONFIG.ADMIN_KEY + " ")) {
    const handled = await handleAdmin(msg.substring(CONFIG.ADMIN_KEY.length + 1).trim(), from);
    if (handled) return;
  }

  if (!BOT_ACTIVE) return;

  const session = getSession(from);
  session.lastActivity = Date.now();

  if (ratings.get(from)) {
    const rating = parseInt(msg);
    if (rating >= 1 && rating <= 5) {
      ratings.delete(from);
      const responses = ["", "😔 *Sorry to hear that.* Tell us what went wrong. 🙏", "😔 *Sorry.* We will improve. 🙏", "🙏 *Thank you!* We will do better!", "😊 *Thank you!* We appreciate your feedback! 🙏", "🎉 *Thank you so much!* See you next time! 😊❤️"];
      await sendMsg(from, responses[rating]);
      return;
    }
  }

  if (isReceipt(msg, numMedia)) {
    const amountMatch = msg.match(/GHS[\s]*([\d,]+\.?\d*)/i);
    if (amountMatch && session.total > 0) {
      const paid = parseFloat(amountMatch[1].replace(",", ""));
      if (paid < session.total) {
        const balance = session.total - paid;
        await sendMsg(from, "📩 *Receipt Received* ✅\n\n⚠️ Payment of *GHS " + paid.toFixed(2) + "* is less than total *GHS " + session.total.toFixed(2) + "*.\n\n❌ *Balance: GHS " + balance.toFixed(2) + "*\n\nPay balance to:\n📱 *" + CONFIG.MOMO + "* (" + CONFIG.MOMO_NAME + ") 🙏");
        return;
      }
    }
    await sendMsg(from, "📩 *Receipt Received!* ✅\n\nThank you! Processing your payment. 🙏\n\n*MIGO PRINT SHOP*");
    return;
  }

  if (session.phase === "CONFIRMING" && session.pendingBill) {
    if (isConfirm(msg)) {
      clearTimers(session);
      await sendBill(from, session.pendingBill, session);
      session.pendingBill = null;
      return;
    }
    if (["change","wrong","mistake","incorrect","different","update","modify","adjust","not right","error"].some(w => msg.toLowerCase().includes(w))) {
      clearTimers(session);
      await sendMsg(from, "😊 *No problem!* Tell us what to change and we will recalculate. 🙏");
      session.phase = "COLLECTING";
      session.knownItems = {};
      session.pendingBill = null;
      return;
    }
  }

  if (session.phase === "ASKED_FINISHED") {
    if (isNo(msg)) { session.phase = "COLLECTING"; clearTimers(session); resetBillTimer(from, session); return; }
    if (isFinished(msg)) { session.phase = "COLLECTING"; clearTimers(session); await processBill(from); return; }
  }

  let newItems = parseOrder(msg);
  if (Object.keys(newItems).length === 0 && filenames.length > 0) {
    for (const fn of filenames) newItems = mergeItems(newItems, parseOrder(fn));
  }

  if (numMedia > 0) {
    for (const fn of filenames) {
      const fnHasItems = Object.keys(parseOrder(fn)).length > 0;
      const msgHasItems = Object.keys(parseOrder(msg)).length > 0;
      if (!fnHasItems && !msgHasItems) {
        if (!session.unknownFiles.includes(fn)) session.unknownFiles.push(fn);
      }
    }
    session.files.push(...filenames);
  }

  if (Object.keys(newItems).length > 0) {
    const textItems = parseOrder(msg);
    session.knownItems = mergeItems(session.knownItems, Object.keys(textItems).length > 0 ? textItems : newItems);
  }

  if (session.unknownFiles.length > 0 && Object.keys(newItems).length > 0) {
    session.unknownFiles = [];
    clearTimers(session);
  }

  session.phase = "COLLECTING";
  resetBillTimer(from, session);
});

function resetBillTimer(phone, session) {
  if (session.billTimer) clearTimeout(session.billTimer);
  session.billTimer = setTimeout(async () => {
    const s = sessions.get(phone);
    if (!s || s.phase !== "COLLECTING") return;
    if (Object.keys(s.knownItems).length === 0 && s.unknownFiles.length === 0 && s.files.length === 0) return;
    s.phase = "ASKED_FINISHED";
    await sendMsg(phone, "🤔 Have you *finished sending*?\n\nReply *Yes* to get your bill or *No* to continue. 😊");
    s.billTimer = setTimeout(async () => {
      const s2 = sessions.get(phone);
      if (s2 && s2.phase === "ASKED_FINISHED") { s2.phase = "COLLECTING"; await processBill(phone); }
    }, 2 * 60 * 1000);
  }, 2 * 60 * 1000);
}

app.post("/momo", async (req, res) => {
  try {
    const sms = req.body.message || req.body.body || req.body.text || "";
    console.log("📲 MoMo SMS:", sms);
    const amountMatch = sms.match(/GHS[\s]*([\d,]+\.?\d*)/i);
    const phoneMatch = sms.match(/(233\d{9}|0\d{9})/);
    if (!amountMatch || !phoneMatch) return res.sendStatus(200);
    const amount = parseFloat(amountMatch[1].replace(",", ""));
    const phone = "whatsapp:+" + phoneMatch[1].replace(/^0/, "233");
    const session = sessions.get(phone);
    if (!session) return res.sendStatus(200);
    if (amount >= session.total) {
      session.paid = true;
      await sendMsg(phone, "✅ *PAYMENT CONFIRMED!* 🎉\n\n💰 Amount: *GHS " + amount.toFixed(2) + "*\n📋 Items: " + session.itemsStr + "\n\n🖨️ Job is *in production!*\n⏱️ *Ready:* " + calcReadyTime(session.knownItems) + "\n📍 " + CONFIG.LOCATION + "\n\nThank you for choosing *MIGO PRINT SHOP!* 🙏");
    } else if (amount > 0) {
      const balance = session.total - amount;
      await sendMsg(phone, "⚠️ *Partial Payment*\n\n💰 Paid: *GHS " + amount.toFixed(2) + "*\nTotal: *GHS " + session.total.toFixed(2) + "*\n❌ Balance: *GHS " + balance.toFixed(2) + "*\n\nPay balance to:\n📱 *" + CONFIG.MOMO + "* (" + CONFIG.MOMO_NAME + ") 🙏");
    }
    res.sendStatus(200);
  } catch (err) { console.log("MoMo error:", err.message); res.sendStatus(200); }
});

app.get("/jobs", (req, res) => {
  let html = "<html><head><title>MIGO Jobs</title><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>body{font-family:Arial;padding:15px;background:#f5f5f5;}h1{color:#ff6600;}.job{background:#fff;padding:12px;margin:8px 0;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1);}.paid{color:green;font-weight:bold;}.pending{color:orange;font-weight:bold;}.collecting{color:blue;font-weight:bold;}</style></head><body>";
  html += "<h1>🖨️ MIGO PRINT SHOP</h1><p>Bot: <strong style=\"color:" + (BOT_ACTIVE ? "green" : "red") + "\">" + (BOT_ACTIVE ? "🟢 Active" : "🔴 Paused") + "</strong></p><p>" + sessions.size + " sessions</p>";
  sessions.forEach((s, phone) => {
    const items = Object.entries(s.knownItems).map(([sz, q]) => q + "x" + sz).join(", ");
    const cls = s.paid ? "paid" : s.phase === "COLLECTING" ? "collecting" : "pending";
    html += "<div class=\"job\"><strong>" + phone.replace("whatsapp:+", "") + "</strong><br>Phase: <span class=\"" + cls + "\">" + s.phase + "</span><br>Items: " + (items || "none") + "<br>" + (s.total > 0 ? "Total: GHS " + s.total.toFixed(2) + "<br>" : "") + (s.unknownFiles.length > 0 ? "⚠️ Unknown: " + s.unknownFiles.length + "<br>" : "") + "Paid: " + (s.paid ? "✅ YES" : "❌ NO") + "</div>";
  });
  res.send(html + "</body></html>");
});

app.get("/", (req, res) => {
  res.send("<html><body style=\"font-family:Arial;padding:20px;text-align:center;\"><h2>🖨️ MIGO PRINT SHOP</h2><p>WhatsApp Bot v10 ✅</p><p style=\"color:" + (BOT_ACTIVE ? "green" : "red") + ";font-weight:bold;\">" + (BOT_ACTIVE ? "✅ Bot Active" : "🔴 Bot Paused") + "</p><a href=\"/jobs\" style=\"background:#ff6600;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;\">📋 View Dashboard</a></body></html>");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 MIGO PRINT SHOP v10 running on port " + PORT));
