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
        system: "You are a professional WhatsApp assistant for MIGO PRINT SHOP, a DTF printing business in Accra, Ghana.\nPRICES: A4=GHS 3.20, A3=GHS 6.40, A2=GHS 16.00\nLOCATION: Circle branch, near Benz Gate\nPAYMENT: MTN MoMo 0552719245 (Kow Habib Baisie)\nBe friendly, short, direct. Understand Ghanaian Pidgin. Never reveal you are AI.",
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
        system: "You are a calculator for MIGO PRINT SHOP. PRICES: A4=GHS 3.20, A3=GHS 6.40, A2=GHS 16.00. Return ONLY valid JSON.",
        messages: [{
          role: "user",
          content: "Calculate: " + itemList + ". Return JSON: {items:[{size,qty,unitPrice,subtotal}],total,itemsStr}"
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

function parseOrder(text) {
  if (!text) return {};
  const msg = text.toLowerCase();
  const totals = {};
  const words = msg.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1] || "";
    if (/^\d+$/.test(w) && /^a[234]$/.test(next)) {
      const qty = parseInt(w);
      const size = next.toUpperCase();
      if (CONFIG.PRICES[size] && qty > 0) totals[size] = (totals[size] || 0) + qty;
    }
    if (/^a[234]$/.test(w) && /^\d+$/.test(next)) {
      const size = w.toUpperCase();
      const qty = parseInt(next);
      if (CONFIG.PRICES[size] && qty > 0) totals[size] = (totals[size] || 0) + qty;
    }
    const m1 = w.match(/^(\d+)x?(a[234])$/);
    if (m1) {
      const qty = parseInt(m1[1]);
      const size = m1[2].toUpperCase();
      if (CONFIG.PRICES[size] && qty > 0) totals[size] = (totals[size] || 0) + qty;
    }
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
  for (const size in b) result[size] = (result[size] || 0) + b[size];
  return result;
}

function calcReadyTime(items) {
  const a4eq = (items.A4 || 0) + ((items.A3 || 0) * 2) + ((items.A2 || 0) * 4);
  const now = new Date();
  let h = a4eq <= 50 ? 2 : a4eq <= 100 ? 3 : a4eq <= 200 ? 4 : a4eq <= 400 ? 6 : a4eq <= 800 ? 8 : 24;
  const ready = new Date(now.getTime() + h * 3600000);
  const rh = ready.getHours();
  if (rh >= 18 || rh < 8) return "Tomorrow by 12:00 PM";
  const period = rh >= 12 ? "PM" : "AM";
  const dh = rh > 12 ? rh - 12 : rh;
  const mins = ready.getMinutes();
  const ms = mins > 0 ? ":" + String(mins).padStart(2, "0") : "";
  return (ready.getDate() === now.getDate() ? "Today" : "Tomorrow") + " by " + dh + ms + period;
}

function buildBill(r) {
  let b = "\u{1F44B} Hello!\n\n\u{1F9FE} *YOUR DTF PRINT BILL*\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n";
  for (const item of r.items) b += "\u{1F4C4} " + item.qty + " x " + item.size + " @ GHS " + item.unitPrice.toFixed(2) + " = *GHS " + item.subtotal.toFixed(2) + "*\n";
  b += "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u{1F4B0} *TOTAL: GHS " + r.total.toFixed(2) + "*\n\n\u{1F4F2} *Pay via MTN MoMo*\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n   \u{1F4F1} Number: *" + CONFIG.MOMO + "*\n   \u{1F464} Name: *" + CONFIG.MOMO_NAME + "*\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\n\u{1F4E9} Send receipt to *COMPLETE* your order \u{1F680}\u{1F64F}";
  return b;
}

function buildSummary(r) {
  let s = "\u{1F4CB} *ORDER SUMMARY*\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n";
  for (const item of r.items) s += "\u{1F4C4} " + item.qty + " x " + item.size + " = GHS " + item.subtotal.toFixed(2) + "\n";
  s += "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u{1F4B0} *TOTAL: GHS " + r.total.toFixed(2) + "*\n\n\u2705 Please *confirm* this order.\n\u274C Or tell us if anything is wrong.";
  return s;
}

// BUG FIXED: removed broken "to !== from"
async function sendMsg(to, body, mediaUrl) {
  if (!BOT_ACTIVE) return;
  const params = new URLSearchParams();
  params.append("From", CONFIG.TWILIO_NUMBER);
  params.append("To", to);
  params.append("Body", body);
  if (mediaUrl) params.append("MediaUrl", mediaUrl);
  try {
    const res = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + CONFIG.TWILIO_SID + "/Messages.json", {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(CONFIG.TWILIO_SID + ":" + CONFIG.TWILIO_TOKEN).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params
    });
    const result = await res.json();
    if (result.error_code) console.log("Twilio error:", result.error_message);
    else console.log("Sent to " + to + ":", body.substring(0, 40));
  } catch (err) { console.log("Send error:", err.message); }
}

function scheduleReminders(phone, total) {
  const t = total.toFixed(2);
  const m = CONFIG.MOMO, n = CONFIG.MOMO_NAME;
  setTimeout(async () => { const s = sessions.get(phone); if (s && !s.paid) await sendMsg(phone, "Payment Reminder: GHS " + t + " pending. Pay to " + m + " (" + n + "). Send receipt to proceed."); }, 10 * 60000);
  setTimeout(async () => { const s = sessions.get(phone); if (s && !s.paid) await sendMsg(phone, "Second Reminder: GHS " + t + " still pending. Pay to " + m + " (" + n + "). Send receipt."); }, 30 * 60000);
  setTimeout(async () => { const s = sessions.get(phone); if (s && !s.paid) await sendMsg(phone, "FINAL REMINDER: Order will be cancelled. Pay GHS " + t + " to " + m + " (" + n + ") NOW!"); }, 60 * 60000);
}

function scheduleClarificationReminders(phone) {
  const session = getSession(phone);
  session.clarificationCount = 0;
  session.clarifyRemindersToday = 0;
  const remind = async () => {
    const s = sessions.get(phone);
    if (!s || s.unknownFiles.length === 0) return;
    if (s.clarifyRemindersToday >= 5) { s.clarificationDay++; s.clarifyRemindersToday = 0; if (s.clarificationDay >= 2) return; }
    s.clarificationCount++;
    s.clarifyRemindersToday++;
    const fl = s.unknownFiles.map(f => f).join(", ");
    await sendMsg(phone, "Clarification needed for: " + fl + ". Please reply with size and quantity e.g: logo.png 20 A4");
    s.clarificationTimer = setTimeout(remind, (s.clarificationCount <= 3 ? 5 : 60) * 60000);
  };
  session.clarificationTimer = setTimeout(remind, 5 * 60000);
}

async function processBill(phone) {
  const session = getSession(phone);
  clearTimers(session);
  if (Object.keys(session.knownItems).length === 0 && session.unknownFiles.length === 0) return;
  await sendMsg(phone, "Order received! We will send you the cost shortly.");
  if (Object.keys(session.knownItems).length === 0) {
    if (session.unknownFiles.length > 0) {
      await sendMsg(phone, "Please provide size and quantity for: " + session.unknownFiles.join(", ") + ". e.g: logo.png 20 A4");
      scheduleClarificationReminders(phone);
    }
    return;
  }
  const calcResult = await claudeCalculate(session.knownItems, session.files);
  if (!calcResult) {
    const items = Object.entries(session.knownItems).map(([size, qty]) => ({ size, qty, unitPrice: CONFIG.PRICES[size], subtotal: qty * CONFIG.PRICES[size] }));
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
  }, 5 * 60000);
}

async function sendBill(phone, calcResult, session) {
  clearTimers(session);
  session.total = calcResult.total;
  session.itemsStr = calcResult.itemsStr;
  session.phase = "WAITING_RECEIPT";
  await sendMsg(phone, buildBill(calcResult));
  if (session.unknownFiles.length > 0) {
    await sendMsg(phone, "Note: These files were not included: " + session.unknownFiles.join(", ") + ". Please clarify size/quantity.");
    scheduleClarificationReminders(phone);
  }
  scheduleReminders(phone, calcResult.total);
}

function isFinished(msg) {
  return ["yes","yeah","yep","done","finish","finished","proceed","okay","ok","fine","alright","sure","correct","right"].some(w => msg.toLowerCase().includes(w));
}
function isNo(msg) {
  return ["no","nope","nah","not yet","wait","still","more","adding","hold on"].some(w => msg.toLowerCase().includes(w));
}
function isConfirm(msg) {
  return ["yes","yeah","confirm","correct","right","ok","okay","proceed","sure","fine","alright"].some(w => msg.toLowerCase().includes(w));
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
  if (m === "h") { BOT_ACTIVE = false; await sendMsg(from, "Bot STOPPED. Type admin j to restart."); return true; }
  if (m === "j") { BOT_ACTIVE = true; await sendMsg(from, "Bot STARTED. Resuming customer replies."); return true; }
  if (m.startsWith("override ")) {
    const parts = m.split(" ");
    const cp = "whatsapp:+233" + parts[1].replace(/^0/, "");
    const cm = parts.slice(2).join(" ");
    await sendMsg(cp, cm);
    await sendMsg(from, "Sent to " + parts[1] + ": " + cm);
    return true;
  }
  if (m.startsWith("info ")) {
    const parts = m.split(" ");
    const cp = "whatsapp:+233" + parts[1].replace(/^0/, "");
    const info = parts.slice(2).join(" ");
    const session = getSession(cp);
    const newItems = parseOrder(info);
    if (Object.keys(newItems).length > 0) {
      session.knownItems = mergeItems(session.knownItems, newItems);
      session.unknownFiles = [];
      clearTimers(session);
      await processBill(cp);
      await sendMsg(from, "Info added for " + parts[1] + ". Bill recalculated.");
    } else {
      await sendMsg(from, "Could not parse: " + info + ". Try: admin info 0244123456 20 A4");
    }
    return true;
  }
  if (m.startsWith("ready ")) {
    const parts = m.split(" ");
    const cp = "whatsapp:+233" + parts[1].replace(/^0/, "");
    getSession(cp).orderReady = true;
    await sendMsg(cp, "Your order is ready for pickup! Come to MIGO PRINT SHOP, " + CONFIG.LOCATION + ". Bring your receipt.");
    setTimeout(async () => { await sendMsg(cp, "How was your experience? Rate us 1-5: 1=Poor 2=Fair 3=Good 4=Very Good 5=Excellent"); ratings.set(cp, true); }, 30 * 60000);
    await sendMsg(from, "Ready notification sent to " + parts[1] + ".");
    return true;
  }
  if (m.startsWith("status ")) {
    const parts = m.split(" ");
    const cp = "whatsapp:+233" + parts[1].replace(/^0/, "");
    const s = sessions.get(cp);
    if (s) await sendMsg(from, "Status " + parts[1] + ": Phase=" + s.phase + " Items=" + JSON.stringify(s.knownItems) + " Total=" + s.total + " Paid=" + s.paid);
    else await sendMsg(from, "No session for " + parts[1]);
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
  for (let i = 0; i < numMedia; i++) filenames.push(req.body["MediaFilename" + i] || "file_" + (i + 1));
  console.log("MSG from " + from + ": " + msg + " | media:" + numMedia);
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
      const resp = ["","Sorry to hear that. Tell us what went wrong.","Sorry, we will improve.","Thank you! We will do better!","Thank you! We appreciate your feedback!","Thank you so much! See you next time!"];
      await sendMsg(from, resp[rating]);
      return;
    }
  }
  if (isReceipt(msg, numMedia)) {
    const am = msg.match(/GHS[\s]*(\d+\.?\d*)/i);
    if (am && session.total > 0) {
      const paid = parseFloat(am[1]);
      if (paid < session.total) {
        await sendMsg(from, "Receipt received. Payment of GHS " + paid.toFixed(2) + " is less than total GHS " + session.total.toFixed(2) + ". Balance: GHS " + (session.total - paid).toFixed(2) + ". Pay balance to " + CONFIG.MOMO + ".");
        return;
      }
    }
    await sendMsg(from, "Receipt received! Thank you. Processing your payment. MIGO PRINT SHOP.");
    return;
  }
  if (session.phase === "CONFIRMING" && session.pendingBill) {
    if (isConfirm(msg)) { clearTimers(session); await sendBill(from, session.pendingBill, session); session.pendingBill = null; return; }
    if (["change","wrong","mistake","incorrect","different","update","modify","error"].some(w => msg.toLowerCase().includes(w))) {
      clearTimers(session);
      await sendMsg(from, "No problem! Tell us what to change and we will recalculate.");
      session.phase = "COLLECTING"; session.knownItems = {}; session.pendingBill = null; return;
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
      if (Object.keys(parseOrder(fn)).length === 0 && Object.keys(parseOrder(msg)).length === 0) {
        if (!session.unknownFiles.includes(fn)) session.unknownFiles.push(fn);
      }
    }
    session.files.push(...filenames);
  }
  if (Object.keys(newItems).length > 0) {
    const ti = parseOrder(msg);
    session.knownItems = mergeItems(session.knownItems, Object.keys(ti).length > 0 ? ti : newItems);
  }
  if (session.unknownFiles.length > 0 && Object.keys(newItems).length > 0) { session.unknownFiles = []; clearTimers(session); }
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
    await sendMsg(phone, "Have you finished sending? Reply YES to get your bill or NO to continue.");
    s.billTimer = setTimeout(async () => {
      const s2 = sessions.get(phone);
      if (s2 && s2.phase === "ASKED_FINISHED") { s2.phase = "COLLECTING"; await processBill(phone); }
    }, 2 * 60000);
  }, 2 * 60000);
}

app.post("/momo", async (req, res) => {
  try {
    const sms = req.body.message || req.body.body || req.body.text || "";
    const am = sms.match(/GHS[\s]*(\d+\.?\d*)/i);
    const pm = sms.match(/(233\d{9}|0\d{9})/);
    if (!am || !pm) return res.sendStatus(200);
    const amount = parseFloat(am[1]);
    const phone = "whatsapp:+" + pm[1].replace(/^0/, "233");
    const session = sessions.get(phone);
    if (!session) return res.sendStatus(200);
    if (amount >= session.total) {
      session.paid = true;
      await sendMsg(phone, "PAYMENT CONFIRMED! GHS " + amount.toFixed(2) + " received. Items: " + session.itemsStr + ". Job in production! Ready: " + calcReadyTime(session.knownItems) + ". Pickup: " + CONFIG.LOCATION + ". Thank you!");
    } else if (amount > 0) {
      await sendMsg(phone, "Partial payment GHS " + amount.toFixed(2) + " received. Total: GHS " + session.total.toFixed(2) + ". Balance: GHS " + (session.total - amount).toFixed(2) + ". Pay balance to " + CONFIG.MOMO + ".");
    }
    res.sendStatus(200);
  } catch (err) { res.sendStatus(200); }
});

app.get("/jobs", (req, res) => {
  let h = "<html><head><title>MIGO</title><meta name='viewport' content='width=device-width,initial-scale=1'><style>body{font-family:Arial;padding:15px;background:#f5f5f5;}h1{color:#f60;}.j{background:#fff;padding:12px;margin:8px 0;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,.1);}.p{color:green;font-weight:bold;}.w{color:orange;font-weight:bold;}.c{color:blue;font-weight:bold;}</style></head><body><h1>MIGO PRINT SHOP</h1><p>Bot: <b style='color:" + (BOT_ACTIVE?"green":"red") + "'>" + (BOT_ACTIVE?"Active":"Paused") + "</b></p><p>" + sessions.size + " sessions</p>";
  sessions.forEach((s, phone) => {
    const items = Object.entries(s.knownItems).map(([sz,q]) => q+"x"+sz).join(",");
    h += "<div class='j'><b>" + phone.replace("whatsapp:+","") + "</b><br>Phase: " + s.phase + "<br>Items: " + (items||"none") + "<br>" + (s.total>0?"Total: GHS "+s.total.toFixed(2)+"<br>":"") + "Paid: " + (s.paid?"YES":"NO") + "</div>";
  });
  res.send(h + "</body></html>");
});

app.get("/", (req, res) => res.send("<html><body style='font-family:Arial;padding:20px;text-align:center'><h2>MIGO PRINT SHOP</h2><p>Bot v10</p><p style='color:" + (BOT_ACTIVE?"green":"red") + "'>" + (BOT_ACTIVE?"Active":"Paused") + "</p><a href='/jobs' style='background:#f60;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none'>View Jobs</a></body></html>"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("MIGO PRINT SHOP v10 running on port " + PORT));
