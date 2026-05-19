// ============================================================
// MIGO DTF PRINT SHOP — WhatsApp Bot (Fixed v9)
// Fix: proper TwiML responses + async Twilio API for delays
// ============================================================

const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── Config ────────────────────────────────────────────────────
const ACCOUNT_SID   = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN    = process.env.TWILIO_AUTH_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const FROM_NUMBER   = 'whatsapp:+14155238886'; // Twilio sandbox

const client    = twilio(ACCOUNT_SID, AUTH_TOKEN);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ── Prices ────────────────────────────────────────────────────
const PRICES  = { A4: 3.20, A3: 6.40, A2: 16.00 };
const A4_EQ   = { A4: 1,    A3: 2,    A2: 4    };

// ── State ─────────────────────────────────────────────────────
const sessions = new Map(); // phone -> session
const timers   = new Map(); // phone -> { timerName: timeoutHandle }
let   botActive = true;

// ── Session helpers ───────────────────────────────────────────
function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      phone,
      files:               [],   // [{ size, qty, source }]
      unknownFiles:        [],   // [{ name, url }]
      state:               'receiving',
      totalBill:           null,
      a4eq:                0,
      paymentReceived:     0,
      unknownReminderCount: 0,
      ratingAsked:         false,
    });
  }
  return sessions.get(phone);
}

function clearTimers(phone) {
  const t = timers.get(phone);
  if (t) Object.values(t).forEach(h => h && clearTimeout(h));
  timers.delete(phone);
}

function setTimer(phone, name, ms, fn) {
  if (!timers.has(phone)) timers.set(phone, {});
  const t = timers.get(phone);
  if (t[name]) clearTimeout(t[name]);
  t[name] = setTimeout(fn, ms);
}

// ── Twilio sender (async, for delayed messages) ───────────────
async function sendMsg(to, body) {
  const dest = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  try {
    const m = await client.messages.create({ from: FROM_NUMBER, to: dest, body });
    console.log(`✅ Sent to ${dest}: "${body.slice(0, 60)}..."`);
    return m.sid;
  } catch (err) {
    console.error(`❌ Send failed to ${dest}:`, err.message);
  }
}

// ── Order parsing ─────────────────────────────────────────────
function quickParse(text) {
  // Fallback if Claude is unavailable
  const upper = (text || '').toUpperCase();
  const size  = ['A2','A3','A4'].find(s => upper.includes(s)) || null;
  const match = text && text.match(/(\d+)/);
  const qty   = match ? parseInt(match[1]) : null;
  return { size, qty, isUnknown: !size || !qty, isMoreOf: null };
}

async function extractOrder(msg, filename, session) {
  const prompt = `You are an order parser for a DTF print shop in Accra, Ghana.
Extract print order info from the customer input below.

Customer message: "${msg || ''}"
Filename: "${filename || ''}"
Existing items: ${JSON.stringify(session.files)}

Rules:
- Detect paper size: A4, A3, A2 only
- Detect quantity (integer number of sheets/copies)
- Customer text ALWAYS wins over filename
- Words like "more", "add", "extra" mean add to same size
- Ghanaian pidgin (boss, chaley, dey, abeg) is normal
- Respond ONLY with valid JSON, no markdown, no extra text:
  {"size":"A4|A3|A2|null","qty":number|null,"isUnknown":boolean,"isMoreOf":"A4|A3|A2|null"}
- isUnknown=true when size OR qty cannot be determined
- isMoreOf = size string if customer says "more" of an existing size, else null`;

  try {
    const r = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 150,
      messages:   [{ role: 'user', content: prompt }],
    });
    const raw = r.content.map(c => c.text || '').join('').trim();
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (e) {
    console.error('Claude parse error:', e.message, '— using fallback');
    return quickParse(msg || filename);
  }
}

// ── Bill builder ──────────────────────────────────────────────
function calcBill(files) {
  const totals = { A4: 0, A3: 0, A2: 0 };
  for (const f of files) {
    if (f.size && totals[f.size] !== undefined) totals[f.size] += f.qty || 0;
  }
  let subtotal = 0, a4eq = 0;
  const lines = [];
  for (const [size, qty] of Object.entries(totals)) {
    if (qty > 0) {
      const price = PRICES[size] * qty;
      subtotal += price;
      a4eq     += qty * A4_EQ[size];
      lines.push(`${size}: ${qty} sheet${qty !== 1 ? 's' : ''} × GHS ${PRICES[size].toFixed(2)} = GHS ${price.toFixed(2)}`);
    }
  }
  return { totals, lines, subtotal, a4eq };
}

function readyTime(a4eq) {
  if (a4eq <= 50)  return '2 hours';
  if (a4eq <= 100) return '3 hours';
  if (a4eq <= 200) return '4 hours';
  if (a4eq <= 400) return '6 hours';
  if (a4eq <= 800) return '8 hours';
  return 'Next day by 12pm';
}

function buildBill(session) {
  const { lines, subtotal, a4eq } = calcBill(session.files);
  const ready = readyTime(a4eq);
  const now   = new Date().toLocaleString('en-GH', { timeZone: 'Africa/Accra' });

  session.totalBill = subtotal;
  session.a4eq      = a4eq;

  return [
    '━━━━━━━━━━━━━━━━━━',
    '🧾 MIGO PRINT SHOP',
    '📍 Circle – Near Benz Gate',
    '━━━━━━━━━━━━━━━━━━',
    'ORDER SUMMARY',
    '',
    ...lines,
    '',
    '━━━━━━━━━━━━━━━━━━',
    `TOTAL: GHS ${subtotal.toFixed(2)}`,
    '━━━━━━━━━━━━━━━━━━',
    '💳 PAYMENT',
    'MoMo: 0552719245',
    'Name: Kow Habib Baisie',
    '',
    `⏱ Est. Ready: ${ready} after payment confirmed`,
    `📅 Order Time: ${now}`,
    '━━━━━━━━━━━━━━━━━━',
    'Thank you for choosing Migo! 🙏',
  ].join('\n');
}

// ── Order flow helpers ────────────────────────────────────────
async function sendBill(phone, session) {
  session.state = 'awaiting_payment';

  await sendMsg(phone, 'Order received. Thank you. We will send you the cost soon. 🙏');

  setTimeout(async () => {
    const bill = buildBill(session);
    await sendMsg(phone, bill);

    // Payment reminders
    setTimer(phone, 'pay1', 10 * 60 * 1000, () => {
      if (session.state === 'awaiting_payment')
        sendMsg(phone, `⏰ Reminder: Please pay GHS ${session.totalBill.toFixed(2)} to MoMo 0552719245 (Kow Habib Baisie) to confirm your order.`);
    });
    setTimer(phone, 'pay2', 30 * 60 * 1000, () => {
      if (session.state === 'awaiting_payment')
        sendMsg(phone, `🔔 2nd reminder: GHS ${session.totalBill.toFixed(2)} still pending to 0552719245. Please don't lose your slot!`);
    });
    setTimer(phone, 'pay3', 60 * 60 * 1000, () => {
      if (session.state === 'awaiting_payment')
        sendMsg(phone, `⚠️ Final reminder: Please pay GHS ${session.totalBill.toFixed(2)} to MoMo 0552719245 to complete your order.`);
    });
  }, 2500);
}

function startReceiveTimer(phone, session) {
  setTimer(phone, 'checkin', 2 * 60 * 1000, async () => {
    if (session.state !== 'receiving') return;
    session.state = 'asked_done';
    await sendMsg(phone, 'Have you finished sending? 😊');

    // No reply in 2 more mins → proceed
    setTimer(phone, 'nodone', 2 * 60 * 1000, async () => {
      if (session.state === 'asked_done') await sendBill(phone, session);
    });
  });
}

function addFileToSession(session, info, rawText, filename) {
  const size = info.size;
  const qty  = info.qty;
  if (!size || !qty) return;

  if (info.isMoreOf) {
    const ex = session.files.find(f => f.size === info.isMoreOf);
    if (ex) { ex.qty += qty; return; }
  }
  const ex = session.files.find(f => f.size === size);
  if (ex) ex.qty += qty;
  else session.files.push({ size, qty, source: rawText || filename || 'file' });
}

// ── Intent detection ──────────────────────────────────────────
function isDone(msg) {
  return /\b(yes|yeah|yep|done|finished|finish|complete|ok|okay|yh|^y$|sure|sent|thats.?all|all.?sent)\b/i.test(msg);
}
function isNotDone(msg) {
  return /\b(no|not yet|still|more|wait|nope|nah|adding)\b/i.test(msg);
}

// ── Main message handler ──────────────────────────────────────
// Returns string → send as TwiML reply
// Returns null  → send empty TwiML (silence)
async function handleMessage(from, body, mediaUrl, mediaType, filename) {
  if (!botActive) return null;

  const msg     = (body || '').trim();
  const session = getSession(from);

  // ── Admin commands (any state) ────────────────────────────
  if (msg.toLowerCase().startsWith('admin ')) {
    return handleAdmin(from, msg);
  }

  console.log(`📩 ${from} [${session.state}]: "${msg || '[media]'}"`);

  // ── RECEIVING: silent phase ───────────────────────────────
  if (session.state === 'receiving') {
    if (mediaUrl || msg) {
      const info = await extractOrder(msg, filename, session);
      if (info.isUnknown || (!info.size && !info.qty)) {
        session.unknownFiles.push({ name: filename || msg.slice(0, 30) || 'unknown file', url: mediaUrl });
      } else {
        addFileToSession(session, info, msg, filename);
      }
    }
    startReceiveTimer(from, session); // resets on every message
    return null; // SILENT
  }

  // ── ASKED DONE ───────────────────────────────────────────
  if (session.state === 'asked_done') {
    clearTimers(from);

    if (isNotDone(msg)) {
      session.state = 'receiving';
      startReceiveTimer(from, session);
      return null; // SILENT — customer still sending

    } else if (isDone(msg)) {
      await sendBill(from, session);
      return null;

    } else {
      // Could be more files in response to "finished?"
      if (mediaUrl || msg) {
        const info = await extractOrder(msg, filename, session);
        if (!info.isUnknown && info.size && info.qty) {
          addFileToSession(session, info, msg, filename);
        } else if (mediaUrl) {
          session.unknownFiles.push({ name: filename || 'file', url: mediaUrl });
        }
      }
      // Treat as "still sending"
      session.state = 'receiving';
      startReceiveTimer(from, session);
      return null;
    }
  }

  // ── AWAITING PAYMENT ─────────────────────────────────────
  if (session.state === 'awaiting_payment') {
    const lower = msg.toLowerCase();
    if (lower.match(/paid|sent money|i.ve paid|done paying|payment/)) {
      return `Thank you! We'll confirm your payment shortly. MoMo: 0552719245 (Kow Habib Baisie) 🙏`;
    }
    if (lower.match(/how much|total|bill|balance/)) {
      return `Your total is GHS ${session.totalBill?.toFixed(2) || '—'}. Please send to MoMo 0552719245 (Kow Habib Baisie).`;
    }
    return null; // silence for everything else
  }

  // ── READY ─────────────────────────────────────────────────
  if (session.state === 'ready') {
    const n = parseInt(msg);
    if (!isNaN(n)) {
      if (n === 5) return `🎉 Thank you! We're thrilled you loved it!`;
      if (n === 4) return `😊 Thank you! We appreciate your feedback!`;
      if (n === 3) return `🙏 Thank you! We'll work to do better!`;
      if (n <= 2)  return `😔 We're sorry. Please tell us what went wrong.`;
    }
    return null;
  }

  // ── PROCESSING (paid, waiting to be printed) ─────────────
  if (session.state === 'processing') {
    const lower = msg.toLowerCase();
    if (lower.match(/ready|done|when|collect/)) {
      return `Your order is being prepared! We'll message you as soon as it's ready for pickup. 🙏`;
    }
    return null;
  }

  return null;
}

// ── Admin commands ────────────────────────────────────────────
async function handleAdmin(from, msg) {
  const parts = msg.trim().split(/\s+/);
  const cmd   = (parts[1] || '').toLowerCase();

  if (cmd === 'h') {
    botActive = false;
    return '🔴 Bot stopped.';
  }
  if (cmd === 'j') {
    botActive = true;
    return '🟢 Bot started.';
  }

  if (cmd === 'override') {
    // admin override 0244xxxxxx Your message here
    const phone   = `whatsapp:+233${parts[2]?.replace(/^0/, '')}`;
    const message = parts.slice(3).join(' ');
    if (!message) return '❌ Usage: admin override 0244xxx message';
    await sendMsg(phone, message);
    return `✅ Sent to ${parts[2]}.`;
  }

  if (cmd === 'info') {
    // admin info 0244xxx 20 A4
    const phone = `whatsapp:+233${parts[2]?.replace(/^0/, '')}`;
    const qty   = parseInt(parts[3]);
    const size  = (parts[4] || '').toUpperCase();
    if (!PRICES[size] || isNaN(qty)) return '❌ Usage: admin info 0244xxx 20 A4';
    const session = getSession(phone);
    addFileToSession(session, { size, qty, isUnknown: false, isMoreOf: null }, 'admin', null);
    return `✅ Added ${qty} ${size} for ${parts[2]}.`;
  }

  if (cmd === 'ready') {
    // admin ready 0244xxx
    const phone   = `whatsapp:+233${parts[2]?.replace(/^0/, '')}`;
    const session = sessions.get(phone);
    if (!session) return `❌ No active session for ${parts[2]}.`;
    session.state = 'ready';
    clearTimers(phone);
    await sendMsg(phone, '✅ Your order is ready for pickup at Migo Print Shop — Circle branch, near Benz Gate, closer to Calvary Church!');
    // Rating after 30 mins
    setTimer(phone, 'rating', 30 * 60 * 1000, async () => {
      if (!session.ratingAsked) {
        session.ratingAsked = true;
        await sendMsg(phone, '⭐ How was your experience? Reply 1-5');
      }
    });
    return `✅ Ready notification sent to ${parts[2]}.`;
  }

  if (cmd === 'status') {
    // admin status 0244xxx
    const phone   = `whatsapp:+233${parts[2]?.replace(/^0/, '')}`;
    const session = sessions.get(phone);
    if (!session) return `❌ No session for ${parts[2]}.`;
    return [
      `📊 Status for ${parts[2]}`,
      `State: ${session.state}`,
      `Files: ${JSON.stringify(session.files)}`,
      `Unknown: ${session.unknownFiles.length}`,
      `Total: GHS ${session.totalBill?.toFixed(2) || 'not billed'}`,
      `Paid: GHS ${session.paymentReceived.toFixed(2)}`,
    ].join('\n');
  }

  return '❓ Commands: admin h|j|override|info|ready|status';
}

// ── Webhook ───────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  const from      = req.body.From    || '';
  const body      = req.body.Body    || '';
  const mediaUrl  = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;
  const filename  = req.body.MediaFilename || '';

  console.log(`📩 Webhook: from=${from}, body="${body}", media=${mediaUrl ? 'YES' : 'no'}`);

  try {
    const reply = await handleMessage(from, body, mediaUrl, mediaType, filename);
    if (reply) twiml.message(reply);
    // null → empty <Response/> (intentional silence)
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }

  res.set('Content-Type', 'text/xml');
  res.send(twiml.toString());
});

// ── MoMo payment endpoint ─────────────────────────────────────
app.post('/momo', async (req, res) => {
  // Payload from SMS Forwarder by Zerogic
  const { amount, phone, sms } = req.body;
  console.log(`💰 MoMo: amount=${amount}, phone=${phone}`);

  const paid = parseFloat(amount) || 0;
  if (!paid) return res.json({ status: 'ignored', reason: 'no amount' });

  // Match session by last 9 digits of phone
  const tail = (phone || '').replace(/\D/g, '').slice(-9);
  let matched = null, matchedKey = null;

  for (const [key, session] of sessions.entries()) {
    if (key.replace(/\D/g, '').slice(-9) === tail) {
      matched = session; matchedKey = key; break;
    }
  }

  if (!matched) {
    console.warn('⚠️ No session matched for MoMo phone:', phone);
    return res.json({ status: 'no_match' });
  }

  matched.paymentReceived += paid;
  const balance = (matched.totalBill || 0) - matched.paymentReceived;

  if (balance <= 0.01) {
    // Full payment confirmed
    const eta = readyTime(matched.a4eq || 0);
    matched.state = 'processing';
    clearTimers(matchedKey);
    await sendMsg(matchedKey,
      `✅ Payment confirmed! GHS ${paid.toFixed(2)} received.\n\nYour order will be ready in ${eta}. We'll notify you when it's done! 🙏`
    );
  } else {
    // Partial payment
    await sendMsg(matchedKey,
      `✅ GHS ${paid.toFixed(2)} received. Thank you!\n\n⚠️ Balance remaining: GHS ${balance.toFixed(2)}\n\nPlease send balance to MoMo: 0552719245 (Kow Habib Baisie).`
    );
  }

  res.json({ status: 'ok', paid, balance: Math.max(0, balance) });
});

// ── Health check ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:   'running',
    bot:      botActive ? 'active' : 'stopped',
    sessions: sessions.size,
    uptime:   process.uptime().toFixed(0) + 's',
    time:     new Date().toISOString(),
  });
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 MIGO Print Bot v9 running on port ${PORT}`);
  console.log(`   Twilio SID : ${ACCOUNT_SID ? ACCOUNT_SID.slice(0,10) + '…' : 'NOT SET ❌'}`);
  console.log(`   Auth Token : ${AUTH_TOKEN ? '✅ set' : 'NOT SET ❌'}`);
  console.log(`   Anthropic  : ${ANTHROPIC_KEY ? '✅ set' : 'NOT SET ❌'}`);
});
