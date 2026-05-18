const express = require("express");
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── CONFIG ────────────────────────────────────────────────────────────────
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
  ADMIN: "whatsapp:+233552719245",
};

// ─── GLOBAL STATE ──────────────────────────────────────────────────────────
const sessions = new Map();      // phone -> session object
const conversations = new Map(); // phone -> claude history
const ratings = new Map();       // phone -> awaiting rating
let BOT_ACTIVE = true;           // global on/off switch

// ─── SESSION STRUCTURE ─────────────────────────────────────────────────────
function newSession() {
  return {
    phase: "COLLECTING",       // COLLECTING | ASKED_FINISHED | CONFIRMING | WAITING_RECEIPT | DONE
    knownItems: {},            // { A4: 20, A3: 5 }
    unknownFiles: [],          // files with no size/quantity info
    files: [],                 // all files received
    clarificationTimer: null,  // timer for unknown file reminders
    clarificationCount: 0,     // how many times we've asked
    clarificationDay: 0,       // day count for daily limit
    clarifyRemindersToday: 0,  // reminders sent today
    billTimer: null,           // 2-min inactivity timer
    confirmTimer: null,        // 5-min confirm timer
    pendingBill: null,         // bill waiting for confirmation
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

// ─── CLAUDE AI (Sonnet for accuracy) ──────────────────────────────────────
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
        system: `You are a professional WhatsApp customer service assistant for MIGO PRINT SHOP, a DTF printing business in Accra, Ghana.

SHOP INFO:
- Name: MIGO PRINT SHOP
- Location: Circle branch, near Benz Gate, closer to Calvary Church
- Hours: Monday-Saturday 8am-6pm, Sunday closed
- Service: DTF (Direct to Film) printing on all fabrics

PRICES:
- A4 = GHS 3.20 per sheet
- A3 = GHS 6.40 per sheet
- A2 = GHS 16.00 per sheet

PAYMENT: MTN MoMo 0552719245 (Kow Habib Baisie)

PERSONALITY:
- Professional but friendly
- Understand Ghanaian Pidgin (boss, chaley, dey, abeg, saa etc)
- No greetings unless customer greets first
- Keep replies SHORT and direct
- Never reveal you are AI
- Ask for clarification when unclear
- Only give prices when asked`,
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
    const itemList = Object.entries(items).map(([size, qty]) => `${qty} x ${size}`).join(", ");
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
        system: `You are a precise calculator for MIGO PRINT SHOP DTF printing.
PRICES: A4=GHS 3.20, A3=GHS 6.40, A2=GHS 16.00 per sheet.
Calculate accurately. Double check your math. Return ONLY JSON.`,
        messages: [{
          role: "user",
          content: `Calculate this order and verify the math:
Items: ${itemList}
Files: ${files.join(", ")}

Return JSON only:
{
  "items": [{"size": "A4", "qty": 20, "unitPrice": 3.20, "subtotal": 64.00}],
  "total": 64.00,
  "itemsStr": "20 x A4",
  "verified": true
}`
        }]
      })
    });
    const data = await response.json();
    if (data.error || !data.content) return null;
    const text = data.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return null;
  } catch (err) {
    console.log("Calculate error:", err.message);
    return null;
  }
}

// ─── ORDER PARSER ──────────────────────────────────────────────────────────
function parseOrder(text) {
  if (!text) return {};
  const msg = text.toLowerCase();
  const totals = {};
  const patterns = [
    /(\d+)\s*x?\s*(a[234])/gi,
    /(a[234])\s*x?\s*(\d+)/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(msg)) !== null) {
      let qty, size;
      if (/^\d+$/.test(match[1])) { qty = parseInt(match[1]); size = match[2].toUpperCase(); }
      else { size = match[1].toUpperCase(); qty = parseInt(match[2]); }
      if (CONFIG.PRICES[size] && qty > 0) {
        totals[size] = (totals[size] || 0) + qty;
      }
    }
  }
  return totals;
}

function mergeItems(a, b) {
  const result = { ...a };
  for (const [size, qty] of Object.entries(b)) {
    result[size] = (result[size] || 0) + qty;
  }
  return result;
}

// ─── READY TIME CALCULATOR ─────────────────────────────────────────────────
function calcReadyTime(items) {
  // Convert everything to A4 equivalent
  const a4eq = (items.A4 || 0) + ((items.A3 || 0) * 2) + ((items.A2 || 0) * 4);
  const now = new Date();
  const hour = now.getHours();

  let hoursNeeded;
  if (a4eq <= 50) hoursNeeded = 2;
  else if (a4eq <= 100) hoursNeeded = 3;
  else if (a4eq <= 200) hoursNeeded = 4;
  else if (a4eq <= 400) hoursNeeded = 6;
  else if (a4eq <= 800) hoursNeeded = 8;
  else hoursNeeded = 24;

  const readyTime = new Date(now.getTime() + hoursNeeded * 60 * 60 * 1000);
  const readyHour = readyTime.getHours();

  // If ready time falls outside working hours (8am-6pm)
  if (readyHour >= 18 || readyHour < 8) {
    return "Tomorrow by 12:00 PM";
  }

  const period = readyHour >= 12 ? "PM" : "AM";
  const displayHour = readyHour > 12 ? readyHour - 12 : readyHour;
  const mins = readyTime.getMinutes();
  const minsStr = mins > 0 ? `:${String(mins).padStart(2, "0")}` : "";

  // Today or tomorrow
  if (readyTime.getDate() === now.getDate()) {
    return `Today by ${displayHour}${minsStr}${period}`;
  }
  return `Tomorrow by ${displayHour}${minsStr}${period}`;
}

// ─── BUILD BILL ────────────────────────────────────────────────────────────
function buildBill(calcResult) {
  const { items, total } = calcResult;
  let bill = `👋 Hello!\n\n`;
  bill += `🧾 *YOUR DTF PRINT BILL*\n`;
  bill += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  for (const item of items) {
    bill += `📄 ${item.qty} x ${item.size} @ GHS ${item.unitPrice.toFixed(2)} = *GHS ${item.subtotal.toFixed(2)}*\n`;
  }
  bill += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  bill += `💰 *TOTAL: GHS ${total.toFixed(2)}*\n\n`;
  bill += `📲 *Pay via MTN MoMo* 🟡\n`;
  bill += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  bill += `   📱 Number: *${CONFIG.MOMO}*\n`;
  bill += `   👤 Name: *${CONFIG.MOMO_NAME}*\n`;
  bill += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  bill += `📩 Please send your payment receipt to *COMPLETE* and *SPEED UP* your order 🚀🙏`;
  return bill;
}

function buildSummary(calcResult) {
  const { items, total } = calcResult;
  let summary = `📋 *ORDER SUMMARY*\n`;
  summary += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  for (const item of items) {
    summary += `📄 ${item.qty} x ${item.size} = GHS ${item.subtotal.toFixed(2)}\n`;
  }
  summary += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  summary += `💰 *TOTAL: GHS ${total.toFixed(2)}*\n\n`;
  summary += `✅ Please *confirm* this order to proceed.\n`;
  summary += `❌ Or let us know if you need any changes.`;
  return summary;
}

// ─── SEND MESSAGE ──────────────────────────────────────────────────────────
async function sendMsg(to, body, mediaUrl) {
  if (!BOT_ACTIVE && to !== CONFIG.ADMIN) return;
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
    console.log(`✅ Sent to ${to}: ${body.substring(0, 50)}...`);
  } catch (err) { console.log("Send error:", err.message); }
}

// ─── SCHEDULE REMINDERS ────────────────────────────────────────────────────
function scheduleReminders(phone, total) {
  [
    { min: 10, msg: `⏰ *Payment Reminder*\n\nYour order of *GHS ${total.toFixed(2)}* is awaiting payment.\n\n📱 MoMo: *${CONFIG.MOMO}*\n👤 ${CONFIG.MOMO_NAME}\n\n📩 Send your receipt to complete your order. 🙏` },
    { min: 30, msg: `⚠️ *Second Reminder*\n\nYour payment of *GHS ${total.toFixed(2)}* has not been received yet.\n\nPay to: 📱 *${CONFIG.MOMO}* (${CONFIG.MOMO_NAME})\n\nSend receipt to proceed. 🙏` },
    { min: 60, msg: `🚨 *Final Reminder*\n\nYour order will be *cancelled* if payment is not received.\n\nPlease pay *GHS ${total.toFixed(2)}* to:\n📱 *${CONFIG.MOMO}* (${CONFIG.MOMO_NAME}) now!\n\nThank you 🙏` }
  ].forEach(({ min, msg }) => {
    setTimeout(async () => {
      const session = sessions.get(phone);
      if (session && !session.paid) await sendMsg(phone, msg);
    }, min * 60 * 1000);
  });
}

// ─── CLARIFICATION REMINDERS ───────────────────────────────────────────────
function scheduleClarificationReminders(phone, unknownFiles) {
  const session = getSession(phone);
  session.clarificationCount = 0;
  session.clarifyRemindersToday = 0;

  const remind = async () => {
    const s = sessions.get(phone);
    if (!s || s.unknownFiles.length === 0) return;

    const maxPerDay = 5;
    const maxDays = 2;

    if (s.clarifyRemindersToday >= maxPerDay) {
      s.clarificationDay++;
      s.clarifyRemindersToday = 0;
      if (s.clarificationDay >= maxDays) {
        console.log("Max clarification days reached for", phone);
        return;
      }
    }

    s.clarificationCount++;
    s.clarifyRemindersToday++;

    const fileList = s.unknownFiles.map(f => `📄 ${f}`).join("\n");
    await sendMsg(phone,
      `📋 *Clarification Needed*\n\n` +
      `We still need the size and quantity for:\n${fileList}\n\n` +
      `Please reply with size and quantity e.g:\n_"logo1.png → 20 A4"_\n\nThank you! 🙏`
    );

    // Schedule next reminder
    const interval = s.clarificationCount <= 3 ? 5 * 60 * 1000 : 60 * 60 * 1000;
    s.clarificationTimer = setTimeout(remind, interval);
  };

  // First reminder after 5 minutes
  session.clarificationTimer = setTimeout(remind, 5 * 60 * 1000);
}

// ─── PROCESS AND SEND BILL ─────────────────────────────────────────────────
async function processBill(phone) {
  const session = getSession(phone);
  clearTimers(session);

  if (Object.keys(session.knownItems).length === 0 && session.unknownFiles.length === 0) return;

  // Send acknowledgement first
  await sendMsg(phone, `📦 *Order received. Thank you!*\n\nWe will send you the cost shortly. ⏳`);

  if (Object.keys(session.knownItems).length === 0) {
    // No calculable items
    if (session.unknownFiles.length > 0) {
      const fileList = session.unknownFiles.map(f => `📄 ${f}`).join("\n");
      await sendMsg(phone,
        `📋 *Clarification Needed*\n\n` +
        `Please provide the size and quantity for:\n${fileList}\n\n` +
        `e.g. _"logo1.png → 20 A4"_ 🙏`
      );
      scheduleClarificationReminders(phone, session.unknownFiles);
    }
    return;
  }

  // Calculate with Claude
  const calcResult = await claudeCalculate(session.knownItems, session.files);

  if (!calcResult) {
    // Fallback manual calculation
    const items = Object.entries(session.knownItems).map(([size, qty]) => ({
      size, qty,
      unitPrice: CONFIG.PRICES[size],
      subtotal: qty * CONFIG.PRICES[size]
    }));
    const total = items.reduce((sum, i) => sum + i.subtotal, 0);
    const fallback = { items, total, itemsStr: items.map(i => `${i.qty} x ${i.size}`).join(", ") };
    await sendSummaryAndBill(phone, fallback, session);
    return;
  }

  await sendSummaryAndBill(phone, calcResult, session);
}

async function sendSummaryAndBill(phone, calcResult, session) {
  // Show summary first
  const summary = buildSummary(calcResult);
  session.pendingBill = calcResult;
  session.phase = "CONFIRMING";
  await sendMsg(phone, summary);

  // Wait 5 minutes for confirmation
  session.confirmTimer = setTimeout(async () => {
    const s = sessions.get(phone);
    if (s && s.phase === "CONFIRMING" && s.pendingBill) {
      await sendBill(phone, s.pendingBill, s);
    }
  }, 5 * 60 * 1000);
}

async function sendBill(phone, calcResult, session) {
  clearTimers(session);
  const bill = buildBill(calcResult);
  session.total = calcResult.total;
  session.itemsStr = calcResult.itemsStr;
  session.phase = "WAITING_RECEIPT";
  await sendMsg(phone, bill);

  // Handle unknown files
  if (session.unknownFiles.length > 0) {
    const fileList = session.unknownFiles.map(f => `📄 ${f}`).join("\n");
    await sendMsg(phone,
      `⚠️ *Note:* The following file(s) were not included in this bill as we couldn't determine the size/quantity:\n${fileList}\n\nPlease clarify and we will add them to your order. 🙏`
    );
    scheduleClarificationReminders(phone, session.unknownFiles);
  }

  scheduleReminders(phone, calcResult.total);
}

// ─── IS FINISHED ───────────────────────────────────────────────────────────
function isFinished(msg) {
  return /\b(yes|yeah|yep|yh|done|finish|finished|proceed|go ahead|send|okay|ok|fine|alright|sure|correct|right|that.?s all|thats all)\b/i.test(msg);
}

function isNo(msg) {
  return /\b(no|nope|nah|not yet|wait|still|more|adding|hold on)\b/i.test(msg);
}

function isConfirm(msg) {
  return /\b(yes|yeah|confirm|correct|right|ok|okay|proceed|go ahead|sure|fine|alright)\b/i.test(msg);
}

function isReceipt(msg, numMedia) {
  const m = msg.toLowerCase();
  const payWords = /\b(paid|momo receipt|payment receipt|i have paid|payment done|i paid|receipt|transaction|confirm payment|transferred|sent payment)\b/;
  const fileWords = /\b(sent files|uploaded|design|image files)\b/;
  if (numMedia > 0 && !payWords.test(m)) return false;
  if (fileWords.test(m) && !payWords.test(m)) return false;
  return payWords.test(m);
}

// ─── ADMIN COMMANDS ────────────────────────────────────────────────────────
async function handleAdmin(msg) {
  const m = msg.trim();

  // STOP bot
  if (m === "h") {
    BOT_ACTIVE = false;
    await sendMsg(CONFIG.ADMIN, "🔴 *Bot STOPPED.* All customer replies paused.\nType *j* to restart.");
    return true;
  }

  // START bot
  if (m === "j") {
    BOT_ACTIVE = true;
    await sendMsg(CONFIG.ADMIN, "🟢 *Bot STARTED.* Resuming all customer replies.");
    return true;
  }

  // OVERRIDE — send custom message to customer
  if (m.startsWith("override ")) {
    const parts = m.split(" ");
    const customerPhone = `whatsapp:+233${parts[1].replace(/^0/, "")}`;
    const customMsg = parts.slice(2).join(" ");
    await sendMsg(customerPhone, customMsg);
    await sendMsg(CONFIG.ADMIN, `✅ Message sent to ${parts[1]}: "${customMsg}"`);
    return true;
  }

  // INFO — give bot missing file info
  if (m.startsWith("info ")) {
    const parts = m.split(" ");
    const customerPhone = `whatsapp:+233${parts[1].replace(/^0/, "")}`;
    const info = parts.slice(2).join(" ");
    const session = getSession(customerPhone);
    const newItems = parseOrder(info);
    if (Object.keys(newItems).length > 0) {
      session.knownItems = mergeItems(session.knownItems, newItems);
      // Remove from unknown files if found
      session.unknownFiles = [];
      clearTimers(session);
      await processBill(customerPhone);
      await sendMsg(CONFIG.ADMIN, `✅ Info added for ${parts[1]}. Bill recalculated.`);
    } else {
      await sendMsg(CONFIG.ADMIN, `⚠️ Could not parse order from: "${info}". Try format: "info 0244123456 20 A4"`);
    }
    return true;
  }

  // READY — mark order as ready for pickup
  if (m.startsWith("ready ")) {
    const parts = m.split(" ");
    const customerPhone = `whatsapp:+233${parts[1].replace(/^0/, "")}`;
    const session = getSession(customerPhone);
    session.orderReady = true;
    await sendMsg(customerPhone,
      `✅ *Your order is ready for pickup!* 🎉\n\n` +
      `📍 *${CONFIG.SHOP_NAME}*\n` +
      `${CONFIG.LOCATION}\n\n` +
      `Please come with your payment receipt. 🙏`
    );
    // Schedule rating after 30 mins
    setTimeout(async () => {
      await sendMsg(customerPhone,
        `⭐ *How was your experience with MIGO PRINT SHOP?*\n\n` +
        `Please rate us:\n` +
        `1️⃣ Poor\n2️⃣ Fair\n3️⃣ Good\n4️⃣ Very Good\n5️⃣ Excellent\n\n` +
        `Reply with a number 1-5 😊`
      );
      ratings.set(customerPhone, true);
    }, 30 * 60 * 1000);
    await sendMsg(CONFIG.ADMIN, `✅ Ready notification sent to ${parts[1]}.`);
    return true;
  }

  // STATUS — check session status
  if (m.startsWith("status ")) {
    const parts = m.split(" ");
    const customerPhone = `whatsapp:+233${parts[1].replace(/^0/, "")}`;
    const session = sessions.get(customerPhone);
    if (session) {
      await sendMsg(CONFIG.ADMIN,
        `📊 *Status for ${parts[1]}*\n` +
        `Phase: ${session.phase}\n` +
        `Items: ${JSON.stringify(session.knownItems)}\n` +
        `Unknown files: ${session.unknownFiles.length}\n` +
        `Total: GHS ${session.total}\n` +
        `Paid: ${session.paid}`
      );
    } else {
      await sendMsg(CONFIG.ADMIN, `No session found for ${parts[1]}`);
    }
    return true;
  }

  return false;
}

// ─── XML RESPONSE ──────────────────────────────────────────────────────────
function xml(msg) {
  if (!msg) return `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg}</Message></Response>`;
}

// ─── MAIN WEBHOOK ──────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  // Always respond immediately to Twilio
  res.set("Content-Type", "text/xml");
  res.send(xml(""));

  const msg = (req.body.Body || "").trim();
  const from = req.body.From;
  const numMedia = parseInt(req.body.NumMedia || "0");

  // Get all filenames from request
  const filenames = [];
  for (let i = 0; i < numMedia; i++) {
    const fn = req.body[`MediaFilename${i}`] || "";
    filenames.push(fn || `file_${i + 1}`);
  }

  console.log(`📩 ${from} | "${msg}" | Media: ${numMedia} | Files: ${filenames.join(", ")}`);

  // ── ADMIN COMMANDS ──
  if (from === CONFIG.ADMIN) {
    const handled = await handleAdmin(msg);
    if (handled) return;
    // If not a command, admin is chatting — don't process as customer
    return;
  }

  // ── BOT PAUSED ──
  if (!BOT_ACTIVE) return;

  const session = getSession(from);
  session.lastActivity = Date.now();

  // ── RATING RESPONSE ──
  if (ratings.get(from)) {
    const rating = parseInt(msg);
    if (rating >= 1 && rating <= 5) {
      ratings.delete(from);
      let response;
      if (rating === 5) response = `🎉 *Thank you so much!* We're thrilled you loved it! See you next time! 😊❤️`;
      else if (rating === 4) response = `😊 *Thank you!* We really appreciate your feedback! 🙏`;
      else if (rating === 3) response = `🙏 *Thank you!* We'll work hard to do better next time!`;
      else response = `😔 *We're sorry to hear that.* Please tell us what went wrong so we can improve. 🙏`;
      await sendMsg(from, response);
      return;
    }
  }

  // ── RECEIPT ──
  if (isReceipt(msg, numMedia)) {
    // Try to extract amount from text
    const amountMatch = msg.match(/GHS?\s*([\d,]+\.?\d*)/i);
    if (amountMatch && session.total > 0) {
      const paid = parseFloat(amountMatch[1].replace(",", ""));
      if (paid < session.total) {
        const balance = session.total - paid;
        await sendMsg(from,
          `📩 *Receipt Received* ✅\n\n` +
          `⚠️ We noticed your payment of *GHS ${paid.toFixed(2)}* is less than your total of *GHS ${session.total.toFixed(2)}*.\n\n` +
          `❌ *Balance Remaining: GHS ${balance.toFixed(2)}*\n\n` +
          `Please send the remaining balance to:\n📱 *${CONFIG.MOMO}* (${CONFIG.MOMO_NAME})\n\n` +
          `Thank you! 🙏`
        );
        return;
      }
    }
    await sendMsg(from,
      `📩 *Receipt Received!* ✅\n\nThank you! We are processing your payment. 🙏\n\n*MIGO PRINT SHOP*`
    );
    return;
  }

  // ── CONFIRMING PHASE ──
  if (session.phase === "CONFIRMING" && session.pendingBill) {
    if (isConfirm(msg)) {
      clearTimers(session);
      await sendBill(from, session.pendingBill, session);
      session.pendingBill = null;
      return;
    }
    if (/\b(change|wrong|mistake|incorrect|different|update|modify|adjust|not right|error)\b/i.test(msg)) {
      clearTimers(session);
      await sendMsg(from,
        `😊 *No problem at all!* We apologize for any confusion.\n\nPlease tell us what needs to be changed and we'll recalculate right away. 🙏`
      );
      session.phase = "COLLECTING";
      session.knownItems = {};
      session.pendingBill = null;
      return;
    }
  }

  // ── ASKED FINISHED PHASE ──
  if (session.phase === "ASKED_FINISHED") {
    if (isNo(msg)) {
      session.phase = "COLLECTING";
      // Reset 2-min timer silently
      clearTimers(session);
      resetBillTimer(from, session);
      return;
    }
    if (isFinished(msg)) {
      session.phase = "COLLECTING";
      clearTimers(session);
      await processBill(from);
      return;
    }
    // Customer sent more items instead of answering
    // Fall through to COLLECTING
  }

  // ── COLLECTING PHASE ──
  // Parse order from text (priority 1)
  let newItems = parseOrder(msg);

  // Parse from filenames (priority 2, only if no text order)
  if (Object.keys(newItems).length === 0 && filenames.length > 0) {
    for (const fn of filenames) {
      const fnItems = parseOrder(fn);
      newItems = mergeItems(newItems, fnItems);
    }
  }

  // Track unknown files (no order info found)
  if (numMedia > 0) {
    for (const fn of filenames) {
      const fnItems = parseOrder(fn);
      const hasTextOrder = Object.keys(parseOrder(msg)).length > 0;
      if (Object.keys(fnItems).length === 0 && !hasTextOrder) {
        if (!session.unknownFiles.includes(fn)) {
          session.unknownFiles.push(fn);
        }
      }
    }
    session.files.push(...filenames);
  }

  // Merge new items with existing (text takes priority over filename for same size)
  if (Object.keys(newItems).length > 0) {
    const textItems = parseOrder(msg);
    if (Object.keys(textItems).length > 0) {
      // Text order — overrides filename for same size
      session.knownItems = mergeItems(session.knownItems, textItems);
    } else {
      // Filename order — only add if size not already in knownItems from text
      session.knownItems = mergeItems(session.knownItems, newItems);
    }
  }

  // Handle clarification responses for unknown files
  if (session.unknownFiles.length > 0 && Object.keys(newItems).length > 0) {
    // Customer clarified! Remove from unknown
    session.unknownFiles = [];
    clearTimers(session);
  }

  // Always reset the 2-minute timer on any activity
  session.phase = "COLLECTING";
  resetBillTimer(from, session);
});

function resetBillTimer(phone, session) {
  if (session.billTimer) clearTimeout(session.billTimer);

  // After 2 minutes of inactivity, ask "Have you finished?"
  session.billTimer = setTimeout(async () => {
    const s = sessions.get(phone);
    if (!s || s.phase !== "COLLECTING") return;

    if (Object.keys(s.knownItems).length === 0 && s.unknownFiles.length === 0 && s.files.length === 0) return;

    s.phase = "ASKED_FINISHED";
    await sendMsg(phone, `🤔 Have you *finished sending*?\n\nReply *Yes* to get your bill or *No* to continue sending. 😊`);

    // After 2 more minutes with no reply, auto-proceed
    s.billTimer = setTimeout(async () => {
      const s2 = sessions.get(phone);
      if (s2 && s2.phase === "ASKED_FINISHED") {
        s2.phase = "COLLECTING";
        await processBill(phone);
      }
    }, 2 * 60 * 1000);

  }, 2 * 60 * 1000);
}

// ─── MOMO SMS ENDPOINT ─────────────────────────────────────────────────────
app.post("/momo", async (req, res) => {
  try {
    const sms = req.body.message || req.body.body || req.body.text || "";
    console.log("📲 MoMo SMS:", sms);

    const amountMatch = sms.match(/GHS\s*([\d,]+\.?\d*)/i);
    const phoneMatch = sms.match(/(\+?233\d{9}|0\d{9})/);

    if (!amountMatch) return res.sendStatus(200);

    const amount = parseFloat(amountMatch[1].replace(",", ""));
    const rawPhone = phoneMatch ? phoneMatch[1] : null;

    if (!rawPhone) return res.sendStatus(200);

    const phone = `whatsapp:+${rawPhone.replace(/^0/, "233")}`;
    const session = sessions.get(phone);

    if (!session) return res.sendStatus(200);

    const balance = session.total - amount;

    if (amount >= session.total) {
      // FULL PAYMENT CONFIRMED
      session.paid = true;
      const readyTime = calcReadyTime(session.knownItems);

      await sendMsg(phone,
        `✅ *PAYMENT CONFIRMED!* 🎉\n\n` +
        `💰 Amount Received: *GHS ${amount.toFixed(2)}*\n` +
        `📋 Items: ${session.itemsStr}\n\n` +
        `🖨️ Your job is now *in production!*\n\n` +
        `⏱️ *Estimated Ready Time:* ${readyTime}\n\n` +
        `📍 Pickup: *${CONFIG.LOCATION}*\n\n` +
        `We will notify you when your order is ready. Thank you for choosing *MIGO PRINT SHOP!* 🙏`
      );

    } else if (amount > 0) {
      // PARTIAL PAYMENT
      await sendMsg(phone,
        `⚠️ *Partial Payment Received*\n\n` +
        `💰 Amount Paid: *GHS ${amount.toFixed(2)}*\n` +
        `📋 Total Bill: *GHS ${session.total.toFixed(2)}*\n` +
        `❌ Balance Remaining: *GHS ${balance.toFixed(2)}*\n\n` +
        `Please pay the remaining balance to proceed:\n` +
        `📱 *${CONFIG.MOMO}* (${CONFIG.MOMO_NAME})\n\n` +
        `⚠️ Production starts only after *full payment*. 🙏`
      );
    }

    res.sendStatus(200);
  } catch (err) {
    console.log("MoMo error:", err.message);
    res.sendStatus(200);
  }
});

// ─── JOBS DASHBOARD ────────────────────────────────────────────────────────
app.get("/jobs", (req, res) => {
  let html = `<html><head><title>MIGO Jobs</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{font-family:Arial;padding:15px;background:#f5f5f5;}
    h1{color:#ff6600;font-size:1.2rem;}
    .job{background:#fff;padding:12px;margin:8px 0;border-radius:8px;font-size:0.85rem;box-shadow:0 2px 4px rgba(0,0,0,0.1);}
    .paid{color:green;font-weight:bold;}
    .pending{color:orange;font-weight:bold;}
    .collecting{color:blue;font-weight:bold;}
  </style></head><body>
  <h1>🖨️ MIGO PRINT SHOP — Dashboard</h1>
  <p>Bot: <strong style="color:${BOT_ACTIVE ? 'green' : 'red'}">${BOT_ACTIVE ? '🟢 Active' : '🔴 Paused'}</strong></p>
  <p>${sessions.size} active sessions</p>`;

  sessions.forEach((s, phone) => {
    const items = Object.entries(s.knownItems).map(([size, qty]) => `${qty}x${size}`).join(", ");
    html += `<div class="job">
      <strong>${phone.replace("whatsapp:+", "")}</strong><br>
      Phase: <span class="${s.paid ? 'paid' : s.phase === 'COLLECTING' ? 'collecting' : 'pending'}">${s.phase}</span><br>
      Items: ${items || "none"}<br>
      ${s.total > 0 ? `Total: GHS ${s.total.toFixed(2)}<br>` : ""}
      ${s.unknownFiles.length > 0 ? `⚠️ Unknown files: ${s.unknownFiles.length}<br>` : ""}
      Paid: ${s.paid ? "✅ YES" : "❌ NO"}
    </div>`;
  });

  html += `</body></html>`;
  res.send(html);
});

app.get("/", (req, res) => res.send(`
  <html><body style="font-family:Arial;padding:20px;text-align:center;">
  <h2>🖨️ MIGO PRINT SHOP</h2>
  <p>WhatsApp Bot + Job Management</p>
  <p style="color:${BOT_ACTIVE ? 'green' : 'red'};font-weight:bold;">${BOT_ACTIVE ? '✅ Bot Active' : '🔴 Bot Paused'}</p>
  <a href="/jobs" style="background:#ff6600;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;">📋 View Dashboard</a>
  </body></html>
`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 MIGO PRINT SHOP v7 running on port ${PORT}`));
