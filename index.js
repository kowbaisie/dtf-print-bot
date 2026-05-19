// ============================================================
// MIGO DTF PRINT SHOP — WhatsApp Bot (v10)
// Updates: greeting replies, summary confirmation, better bill
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
const FROM_NUMBER   = 'whatsapp:+14155238886';

const client    = twilio(ACCOUNT_SID, AUTH_TOKEN);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ── Prices ────────────────────────────────────────────────────
const PRICES = { A4: 3.20, A3: 6.40, A2: 16.00 };
const A4_EQ  = { A4: 1,    A3: 2,    A2: 4    };

// ── State ─────────────────────────────────────────────────────
const sessions = new Map();
const timers   = new Map();
let   botActive = true;

// ── Helpers ───────────────────────────────────────────────────
function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      phone,
      files:                [],
      unknownFiles:         [],
      state:                'idle',  // idle, receiving, asked_done, confirming, awaiting_payment, processing, ready
      totalBill:            null,
      a4eq:                 0,
      paymentReceived:      0,
      unknownReminderCount: 0,
      dailyReminderCount:   0,
      ratingAsked:          false,
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

async function sendMsg(to, body) {
  const dest = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  try {
    await client.messages.create({ from: FROM_NUMBER, to: dest, body });
    console.log(`✅ Sent to ${dest}: "${body.slice(0, 60)}"`);
  } catch (err) {
    console.error(`❌ Send failed to ${dest}:`, err.message);
  }
}

// ── Greeting / query detector ─────────────────────────────────
function isGreetingOrQuery(msg) {
  const lower = msg.toLowerCase().trim();
  const greetings = ['hi','hello','hey','good morning','good afternoon','good evening',
    'morning','evening','afternoon','how much','price','prices','what is','how are',
    'boss','chaley','oga','please','abeg','do you','can you','are you','open','hours',
    'location','where','address'];
  return greetings.some(g => lower.includes(g));
}

async function getGreetingReply(msg) {
  try {
    const r = await anthropic.messages.create({
      model:      'claude-opus-4-6',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `You are a friendly assistant for MIGO Print Shop in Accra Ghana (Circle, near Benz Gate, closer to Calvary Church).
Shop hours: Monday-Saturday 8am-6pm. Sunday closed.
Prices: A4=GHS 3.20/sheet, A3=GHS 6.40/sheet, A2=GHS 16.00/sheet.
MoMo: 0552719245 (Kow Habib Baisie). WhatsApp: 0552719245.
You understand Ghanaian pidgin. Be short, warm, and direct. Never reveal you are AI.
Customer message: "${msg}"
Reply naturally in 1-3 sentences max.`
      }]
    });
    return r.content.map(c => c.text || '').join('').trim();
  } catch (e) {
    return `Welcome to Migo Print Shop! 😊 A4=GHS 3.20 | A3=GHS 6.40 | A2=GHS 16.00. Send your files anytime!`;
  }
}

// ── Order parsing ─────────────────────────────────────────────
function quickParse(text) {
  const upper = (text || '').toUpperCase();
  const size  = ['A2','A3','A4'].find(s => upper.includes(s)) || null;
  const match = (text || '').match(/(\d+)/);
  const qty   = match ? parseInt(match[1]) : null;
  return { size, qty, isUnknown: !size || !qty, isMoreOf: null };
}

async function extractOrder(msg, filename, session) {
  const prompt = `You are an order parser for a DTF print shop in Accra Ghana.
Extract print order info from the customer input.

Customer message: "${msg || ''}"
Filename: "${filename || ''}"
Existing order: ${JSON.stringify(session.files)}

Rules:
- Detect paper size: A4, A3, or A2 ONLY
- Detect quantity (number of sheets/copies)
- Customer TEXT always wins over filename
- "more", "add", "extra", "another" = add to same size
- Numbers in filename like "2 A4 DTF.pdf" mean 2 sheets of A4
- "20 A4 DTF HACK.pdf" means 20 sheets of A4
- Ghanaian pidgin (boss, chaley, dey, abeg) is normal
- Respond ONLY with valid JSON, no markdown:
  {"size":"A4|A3|A2|null","qty":number|null,"isUnknown":boolean,"isMoreOf":"A4|A3|A2|null"}
- isUnknown=true when size OR qty cannot be determined
- isMoreOf = size if customer says more of an existing size, else null`;

  try {
    const r = await anthropic.messages.create({
      model:      'claude-opus-4-6',
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

// ── Bill calculation ──────────────────────────────────────────
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
      lines.push({ size, qty, price });
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

// ── Order summary message (before confirmation) ───────────────
function buildSummary(session) {
  const { lines, subtotal, a4eq } = calcBill(session.files);
  session.totalBill = subtotal;
  session.a4eq      = a4eq;

  const itemLines = lines.map(l =>
    `  • ${l.size}: *${l.qty} sheet${l.qty !== 1 ? 's' : ''}*`
  ).join('\n');

  return [
    `📋 *ORDER SUMMARY*`,
    ``,
    itemLines,
    ``,
    `💰 *Total: GHS ${subtotal.toFixed(2)}*`,
    ``,
    `Is this correct? Reply *YES* to confirm or tell us what's wrong.`,
    `_(Auto-confirms in 5 mins if no reply)_`,
  ].join('\n');
}

// ── Professional bill message ─────────────────────────────────
function buildBill(session) {
  const { lines, subtotal, a4eq } = calcBill(session.files);
  const ready = readyTime(a4eq);
  const now   = new Date().toLocaleString('en-GH', { timeZone: 'Africa/Accra', hour12: true });

  session.totalBill = subtotal;
  session.a4eq      = a4eq;

  const itemLines = lines.map(l =>
    `${l.size}: ${l.qty} sheet${l.qty !== 1 ? 's' : ''} × GHS ${PRICES[l.size].toFixed(2)} = GHS ${l.price.toFixed(2)}`
  ).join('\n');

  return [
    `━━━━━━━━━━━━━━━━━━━━━`,
    `🧾 *MIGO PRINT SHOP*`,
    `📍 Circle – Near Benz Gate`,
    `━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `🖨 *ORDER BREAKDOWN*`,
    itemLines,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━`,
    `💵 *TOTAL: GHS ${subtotal.toFixed(2)}*`,
    `━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `🟡 *MTN MOBILE MONEY*`,
    ``,
    `📱 *0552719245*`,
    `👤 *KOW HABIB BAISIE*`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━`,
    `⏱ Ready in: *${ready}* after payment`,
    `🕐 Order time: ${now}`,
    `━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `Thank you for choosing Migo! 🙏`,
  ].join('\n');
}

// ── Flow helpers ──────────────────────────────────────────────
function addFile(session, info, rawText, filename) {
  const { size, qty, isMoreOf } = info;
  if (!size || !qty) return;
  if (isMoreOf) {
    const ex = session.files.find(f => f.size === isMoreOf);
    if (ex) { ex.qty += qty; return; }
  }
  const ex = session.files.find(f => f.size === size);
  if (ex) ex.qty += qty;
  else session.files.push({ size, qty, source: rawText || filename || 'file' });
}

function startReceiveTimer(phone, session) {
  setTimer(phone, 'checkin', 2 * 60 * 1000, async () => {
    if (session.state !== 'receiving') return;
    session.state = 'asked_done';
    await sendMsg(phone, 'Have you finished sending? 😊');
    setTimer(phone, 'nodone', 2 * 60 * 1000, async () => {
      if (session.state === 'asked_done') await sendSummaryForConfirm(phone, session);
    });
  });
}

async function sendSummaryForConfirm(phone, session) {
  if (!session.files.length) return;
  session.state = 'confirming';
  const summary = buildSummary(session);
  await sendMsg(phone, summary);

  // Auto-confirm after 5 mins
  setTimer(phone, 'autoconfirm', 5 * 60 * 1000, async () => {
    if (session.state === 'confirming') await sendBillFlow(phone, session);
  });
}

async function sendBillFlow(phone, session) {
  session.state = 'awaiting_payment';
  await sendMsg(phone, 'Order received. Thank you. We will send you the cost soon. 🙏');
  setTimeout(async () => {
    const bill = buildBill(session);
    await sendMsg(phone, bill);

    setTimer(phone, 'pay1', 10 * 60 * 1000, () => {
      if (session.state === 'awaiting_payment')
        sendMsg(phone, `⏰ Reminder: Please pay *GHS ${session.totalBill.toFixed(2)}* to MoMo *0552719245* (Kow Habib Baisie) to confirm your order. 🙏`);
    });
    setTimer(phone, 'pay2', 30 * 60 * 1000, () => {
      if (session.state === 'awaiting_payment')
        sendMsg(phone, `🔔 2nd reminder: *GHS ${session.totalBill.toFixed(2)}* still pending to *0552719245*. Don't lose your slot!`);
    });
    setTimer(phone, 'pay3', 60 * 60 * 1000, () => {
      if (session.state === 'awaiting_payment')
        sendMsg(phone, `⚠️ Final reminder: Pay *GHS ${session.totalBill.toFixed(2)}* to MoMo *0552719245* to complete your order.`);
    });
  }, 2000);
}

// ── Intent helpers ────────────────────────────────────────────
function isYes(msg) {
  return /^\s*(yes|yeah|yep|yh|y|ok|okay|sure|correct|right|fine|done|finish|finished|confirm|confirmed|send|go|proceed|👍)\s*$/i.test(msg);
}
function isNo(msg) {
  return /\b(no|not yet|still|more|wait|nope|nah|adding|sending)\b/i.test(msg);
}

// ── Main handler ──────────────────────────────────────────────
async function handleMessage(from, body, mediaUrl, mediaType, filename) {
  if (!botActive) return null;

  const msg     = (body || '').trim();
  const session = getSession(from);

  // Admin commands
  if (msg.toLowerCase().startsWith('admin ')) return handleAdmin(from, msg);

  console.log(`📩 ${from} [${session.state}]: "${msg || '[media]'}"`);

  // ── IDLE: first contact ───────────────────────────────────
  if (session.state === 'idle') {
    if (mediaUrl) {
      // First thing is a file — go silent, process it
      session.state = 'receiving';
      const info = await extractOrder(msg, filename, session);
      if (!info.isUnknown && info.size && info.qty) addFile(session, info, msg, filename);
      else session.unknownFiles.push({ name: filename || 'file', url: mediaUrl });
      startReceiveTimer(from, session);
      return null;
    }
    if (msg) {
      // Text first — reply to greeting/query
      session.state = 'receiving';
      if (isGreetingOrQuery(msg)) {
        const reply = await getGreetingReply(msg);
        return reply;
      }
      // Could be order info as text
      const info = await extractOrder(msg, null, session);
      if (!info.isUnknown && info.size && info.qty) {
        addFile(session, info, msg, null);
        startReceiveTimer(from, session);
        return null;
      }
      const reply = await getGreetingReply(msg);
      return reply;
    }
    return null;
  }

  // ── RECEIVING: silent file collection ─────────────────────
  if (session.state === 'receiving') {
    if (mediaUrl || (msg && !isGreetingOrQuery(msg))) {
      const info = await extractOrder(msg, filename, session);
      if (!info.isUnknown && info.size && info.qty) addFile(session, info, msg, filename);
      else if (mediaUrl) session.unknownFiles.push({ name: filename || 'file', url: mediaUrl });
      startReceiveTimer(from, session); // reset timer
      return null;
    }
    // If they send a greeting mid-receiving, still stay silent (they're sending files)
    if (mediaUrl) {
      startReceiveTimer(from, session);
      return null;
    }
    // Pure greeting text — reply but don't reset file timer
    if (isGreetingOrQuery(msg)) {
      return await getGreetingReply(msg);
    }
    startReceiveTimer(from, session);
    return null;
  }

  // ── ASKED DONE ───────────────────────────────────────────
  if (session.state === 'asked_done') {
    clearTimers(from);

    if (isNo(msg)) {
      session.state = 'receiving';
      startReceiveTimer(from, session);
      return null;
    }
    if (isYes(msg) || mediaUrl) {
      if (mediaUrl) {
        const info = await extractOrder(msg, filename, session);
        if (!info.isUnknown && info.size && info.qty) addFile(session, info, msg, filename);
        session.state = 'receiving';
        startReceiveTimer(from, session);
        return null;
      }
      await sendSummaryForConfirm(from, session);
      return null;
    }
    // Anything else — treat as more info
    const info = await extractOrder(msg, filename, session);
    if (!info.isUnknown && info.size && info.qty) addFile(session, info, msg, filename);
    session.state = 'receiving';
    startReceiveTimer(from, session);
    return null;
  }

  // ── CONFIRMING: waiting for summary approval ──────────────
  if (session.state === 'confirming') {
    clearTimers(from);

    if (isYes(msg)) {
      await sendBillFlow(from, session);
      return null;
    }
    // Customer raised an issue
    session.state = 'receiving';
    await sendMsg(from, `Sorry about that! Please send the correct details and we'll fix it. 🙏`);
    session.files = []; // reset files for correction
    startReceiveTimer(from, session);
    return null;
  }

  // ── AWAITING PAYMENT ─────────────────────────────────────
  if (session.state === 'awaiting_payment') {
    const lower = msg.toLowerCase();
    if (lower.match(/paid|sent|payment|i.ve paid|done paying/)) {
      return `Thank you! 🙏 We'll confirm your payment shortly.\n\n🟡 *MTN MoMo: 0552719245*\n👤 *Kow Habib Baisie*`;
    }
    if (lower.match(/how much|total|bill|balance|amount/)) {
      return `Your total is *GHS ${session.totalBill?.toFixed(2) || '—'}*.\n\n🟡 Please send to MoMo *0552719245* (Kow Habib Baisie). 🙏`;
    }
    if (isGreetingOrQuery(msg)) return await getGreetingReply(msg);
    return null;
  }

  // ── PROCESSING ────────────────────────────────────────────
  if (session.state === 'processing') {
    const lower = msg.toLowerCase();
    if (lower.match(/ready|done|when|collect|pick/)) {
      return `Your order is being prepared! We'll message you as soon as it's ready for pickup. 🙏`;
    }
    if (isGreetingOrQuery(msg)) return await getGreetingReply(msg);
    return null;
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
    if (isGreetingOrQuery(msg)) return await getGreetingReply(msg);
    return null;
  }

  return null;
}

// ── Admin handler ─────────────────────────────────────────────
async function handleAdmin(from, msg) {
  const parts = msg.trim().split(/\s+/);
  const cmd   = (parts[1] || '').toLowerCase();

  if (cmd === 'h') { botActive = false; return '🔴 Bot stopped.'; }
  if (cmd === 'j') { botActive = true;  return '🟢 Bot started.'; }

  if (cmd === 'override') {
    const phone   = `whatsapp:+233${parts[2]?.replace(/^0/, '')}`;
    const message = parts.slice(3).join(' ');
    if (!message) return '❌ Usage: admin override 0244xxx message';
    await sendMsg(phone, message);
    return `✅ Sent to ${parts[2]}.`;
  }

  if (cmd === 'info') {
    const phone = `whatsapp:+233${parts[2]?.replace(/^0/, '')}`;
    const qty   = parseInt(parts[3]);
    const size  = (parts[4] || '').toUpperCase();
    if (!PRICES[size] || isNaN(qty)) return '❌ Usage: admin info 0244xxx 20 A4';
    const session = getSession(phone);
    addFile(session, { size, qty, isUnknown: false, isMoreOf: null }, 'admin', null);
    return `✅ Added ${qty} ${size} for ${parts[2]}.`;
  }

  if (cmd === 'ready') {
    const phone   = `whatsapp:+233${parts[2]?.replace(/^0/, '')}`;
    const session = sessions.get(phone);
    if (!session) return `❌ No session for ${parts[2]}.`;
    session.state = 'ready';
    clearTimers(phone);
    await sendMsg(phone, `✅ Your order is ready for pickup!\n\n📍 *Migo Print Shop*\nCircle branch, near Benz Gate,\ncloser to Calvary Church, Accra.\n\nThank you for choosing Migo! 🙏`);
    setTimer(phone, 'rating', 30 * 60 * 1000, async () => {
      if (!session.ratingAsked) {
        session.ratingAsked = true;
        await sendMsg(phone, `⭐ How was your experience at Migo Print Shop?\n\nReply with a number:\n5 = Excellent\n4 = Good\n3 = Okay\n2 = Poor\n1 = Very bad`);
      }
    });
    return `✅ Ready notification sent to ${parts[2]}.`;
  }

  if (cmd === 'status') {
    const phone   = `whatsapp:+233${parts[2]?.replace(/^0/, '')}`;
    const session = sessions.get(phone);
    if (!session) return `❌ No session for ${parts[2]}.`;
    return [
      `📊 *Status: ${parts[2]}*`,
      `State: ${session.state}`,
      `Files: ${JSON.stringify(session.files)}`,
      `Unknown files: ${session.unknownFiles.length}`,
      `Total: GHS ${session.totalBill?.toFixed(2) || 'not billed'}`,
      `Paid: GHS ${session.paymentReceived.toFixed(2)}`,
    ].join('\n');
  }

  if (cmd === 'jobs') {
    let out = [`📋 *ALL ACTIVE SESSIONS*`, ``];
    for (const [key, s] of sessions.entries()) {
      const ph = key.replace('whatsapp:+233', '0');
      out.push(`${ph} → ${s.state} | GHS ${s.totalBill?.toFixed(2) || '—'}`);
    }
    return out.length > 2 ? out.join('\n') : '📭 No active sessions.';
  }

  return '❓ Commands: admin h|j|override|info|ready|status|jobs';
}

// ── Webhook ───────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  const from      = req.body.From    || '';
  const body      = req.body.Body    || '';
  const mediaUrl  = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;
  const filename  = req.body.MediaFilename || '';

  console.log(`📩 Webhook: from=${from}, body="${body}", media=${mediaUrl ? 'YES' : 'no'}, file=${filename}`);

  try {
    const reply = await handleMessage(from, body, mediaUrl, mediaType, filename);
    if (reply) twiml.message(reply);
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }

  res.set('Content-Type', 'text/xml');
  res.send(twiml.toString());
});

// ── MoMo endpoint ─────────────────────────────────────────────
app.post('/momo', async (req, res) => {
  const { amount, phone } = req.body;
  console.log(`💰 MoMo: amount=${amount}, phone=${phone}`);

  const paid = parseFloat(amount) || 0;
  if (!paid) return res.json({ status: 'ignored' });

  const tail = (phone || '').replace(/\D/g, '').slice(-9);
  let matched = null, matchedKey = null;
  for (const [key, s] of sessions.entries()) {
    if (key.replace(/\D/g, '').slice(-9) === tail) { matched = s; matchedKey = key; break; }
  }
  if (!matched) return res.json({ status: 'no_match' });

  matched.paymentReceived += paid;
  const balance = (matched.totalBill || 0) - matched.paymentReceived;

  if (balance <= 0.01) {
    matched.state = 'processing';
    clearTimers(matchedKey);
    await sendMsg(matchedKey,
      `✅ *Payment Confirmed!*\n\nGHS ${paid.toFixed(2)} received. Thank you! 🙏\n\nYour order will be ready in *${readyTime(matched.a4eq || 0)}*.\n\nWe'll notify you when it's ready for pickup!`
    );
  } else {
    await sendMsg(matchedKey,
      `✅ GHS ${paid.toFixed(2)} received. Thank you!\n\n⚠️ *Balance remaining: GHS ${balance.toFixed(2)}*\n\nPlease send balance to:\n🟡 MoMo: *0552719245*\n👤 *Kow Habib Baisie*`
    );
  }
  res.json({ status: 'ok', paid, balance: Math.max(0, balance) });
});

// ── Dashboard ─────────────────────────────────────────────────
app.get('/jobs', (req, res) => {
  const jobs = [];
  for (const [key, s] of sessions.entries()) {
    jobs.push({
      phone:   key,
      state:   s.state,
      files:   s.files,
      total:   s.totalBill,
      paid:    s.paymentReceived,
      balance: Math.max(0, (s.totalBill || 0) - s.paymentReceived),
    });
  }
  res.json({ bot: botActive ? 'active' : 'stopped', sessions: jobs.length, jobs });
});

app.get('/', (req, res) => {
  res.json({
    status: 'running',
    bot:    botActive ? 'active' : 'stopped',
    sessions: sessions.size,
    uptime: process.uptime().toFixed(0) + 's',
  });
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 MIGO Print Bot v10 running on port ${PORT}`);
  console.log(`   Twilio SID : ${ACCOUNT_SID ? ACCOUNT_SID.slice(0, 10) + '…' : 'NOT SET ❌'}`);
  console.log(`   Auth Token : ${AUTH_TOKEN    ? '✅ set' : 'NOT SET ❌'}`);
  console.log(`   Anthropic  : ${ANTHROPIC_KEY ? '✅ set' : 'NOT SET ❌'}`);
});
