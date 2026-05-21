// ============================================================
// MIGO DTF PRINT SHOP — WhatsApp Bot (v13 — Full Audit Fix)
// All issues from chat review fixed:
// 1. Filename parsing — never ask if already in filename
// 2. Bulk images >5 — summarise, don't list individually
// 3. Ambiguous numbers — ask to clarify
// 4. Actual clock time on bill (not "2 hours")
// 5. Payment receipt acknowledged
// 6. British English only, no pidgin
// 7. Instant reply + Claude follow-up
// 8. Confirmed files locked from recalculation
// ============================================================

const express   = require('express');
const twilio    = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const ACCOUNT_SID   = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN    = process.env.TWILIO_AUTH_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const FROM_NUMBER   = 'whatsapp:+14155238886';
const ADMIN_PHONE   = 'whatsapp:+233552719245'; // Shop owner/admin number

const twilioClient = twilio(ACCOUNT_SID, AUTH_TOKEN);
const anthropic    = new Anthropic({ apiKey: ANTHROPIC_KEY });

const PRICES = { A4: 3.20, A3: 6.40, A2: 16.00 };
const A4_EQ  = { A4: 1, A3: 2, A2: 4 };

const sessions = new Map();
const timers   = new Map();
let   botActive = true;
// Job ID counters per shift
const jobCounters = { M: 1600, A: 1000, N: 1000, E: 1000 };

function generateJobId(phone) {
  // Get current hour in Ghana time (Africa/Accra = GMT+0)
  const now   = new Date();
  const hour  = parseInt(now.toLocaleString('en-GH', {
    timeZone: 'Africa/Accra', hour: '2-digit', hour12: false
  }));

  // Determine shift prefix
  let prefix;
  if (hour >= 6  && hour < 12) prefix = 'M'; // Morning   6am–12pm
  else if (hour >= 12 && hour < 18) prefix = 'A'; // Afternoon 12pm–6pm
  else if (hour >= 18 && hour < 24) prefix = 'N'; // Night     6pm–12am
  else                               prefix = 'E'; // Early     12am–6am

  // Increment counter for this shift
  jobCounters[prefix]++;

  // Last 4 digits of customer phone number
  const digits = (phone || '').replace(/\D/g, '');
  const last4  = digits.slice(-4);

  return `MGO-${last4}-${prefix}${jobCounters[prefix]}`;
}

// ── Session ───────────────────────────────────────────────────
function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      phone,
      state:           'idle',
      files:           [],
      confirmedFiles:  [],
      unknownFiles:    [],
      pendingImages:   [],
      chatHistory:     [],
      totalBill:       null,
      a4eq:            0,
      paymentReceived: 0,
      jobId:            null,
      readyTime:        null,
      overdueReminders: 0,
      ratingAsked:      false,
      lastActivity:     Date.now(),
    });
  }
  return sessions.get(phone);
}

// ── Timers ────────────────────────────────────────────────────
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

// ── Send message ──────────────────────────────────────────────
async function sendMsg(to, body) {
  const dest = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  try {
    await twilioClient.messages.create({ from: FROM_NUMBER, to: dest, body });
    console.log(`✅ Sent: "${body.slice(0, 60)}"`);
  } catch (err) {
    console.error(`❌ Send failed:`, err.message);
  }
}

// ── Claude ────────────────────────────────────────────────────
async function askClaude(messages, system, maxTokens = 300, timeoutMs = 12000) {
  const opts = { model: 'claude-opus-4-6', max_tokens: maxTokens, messages };
  if (system) opts.system = system;
  return Promise.race([
    anthropic.messages.create(opts),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

const SHOP_SYSTEM = `You are a professional and helpful customer service representative for Migo Print Shop.

Shop details:
- Location: Circle branch, near Benz Gate, closer to Calvary Church, Accra, Ghana
- Services: DTF (Direct to Film) printing
- Prices: A4 at GHS 3.20/sheet, A3 at GHS 6.40/sheet, A2 at GHS 16.00/sheet
- Payment: MTN Mobile Money — 0552719245 (Kow Habib Baisie)
- Hours: Monday to Saturday, 8:00am–6:00pm. Closed Sundays

Behaviour:
- Clear, natural British English only. No pidgin, no slang.
- Warm, professional, conversational. Like a knowledgeable shop assistant.
- Respond to everything. Never ignore a message.
- Ask clarifying questions when genuinely unsure.
- Never reveal you are an AI.
- Keep replies to 1–4 sentences unless more detail is needed.`;

function addToHistory(session, role, content) {
  session.chatHistory.push({ role, content });
  if (session.chatHistory.length > 40) session.chatHistory = session.chatHistory.slice(-40);
}

// ── Instant reply (within Twilio 15s limit) ───────────────────
function instantReply(msg) {
  const m = (msg || '').toLowerCase().trim();
  if (/^(hi|hello|hey|good morning|good afternoon|good evening|morning|evening|afternoon|howdy)[!.\s]*$/.test(m))
    return `Hello! Welcome to Migo Print Shop. 😊 How can I help you today?`;
  if (/dtf/.test(m))
    return `Yes, we do DTF printing. Please send your files and I will calculate the cost for you.`;
  if (/price|how much|cost|rate/.test(m))
    return `Our prices: A4 — GHS 3.20 | A3 — GHS 6.40 | A2 — GHS 16.00 per sheet.`;
  if (/open|hour|close|time/.test(m))
    return `We are open Monday to Saturday, 8am to 6pm. Closed on Sundays.`;
  if (/where|location|address|direction/.test(m))
    return `We are at Circle branch, near Benz Gate, closer to Calvary Church, Accra.`;
  if (/how are you|you good|how do you do/.test(m))
    return `I am very well, thank you! How can I assist you today?`;
  return `Thank you for your message. How can I help you today?`;
}

async function claudeReplyAsync(msg, session) {
  addToHistory(session, 'user', msg);
  try {
    const r = await askClaude(session.chatHistory, SHOP_SYSTEM, 300, 12000);
    const reply = r.content.map(c => c.text || '').join('').trim();
    if (reply) { addToHistory(session, 'assistant', reply); await sendMsg(session.phone, reply); }
  } catch (e) { console.error('Claude async error:', e.message); }
}

async function replyWithClaude(msg, session) {
  const quick = instantReply(msg);
  claudeReplyAsync(msg, session).catch(() => {});
  return quick;
}

// ── Ready time → actual clock time ───────────────────────────
function getReadyHours(a4eq) {
  if (a4eq <= 50)  return 2;
  if (a4eq <= 100) return 3;
  if (a4eq <= 200) return 4;
  if (a4eq <= 400) return 6;
  if (a4eq <= 800) return 8;
  return null;
}

function readyTimeText(a4eq) {
  const hours = getReadyHours(a4eq);
  if (!hours) {
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(12, 0, 0, 0);
    return d.toLocaleString('en-GH', { timeZone:'Africa/Accra', hour12:true, weekday:'short', hour:'2-digit', minute:'2-digit' });
  }
  const d = new Date(Date.now() + hours * 3600000);
  return d.toLocaleString('en-GH', { timeZone:'Africa/Accra', hour12:true, hour:'2-digit', minute:'2-digit' });
}

// ── Order extraction (Claude Opus — strict) ───────────────────
function quickParse(text) {
  const upper = (text || '').toUpperCase();
  const size  = ['A2', 'A3', 'A4'].find(s => upper.includes(s)) || null;

  // Pattern: "A4-2.pdf" → qty=2 (number after hyphen following size code)
  const hyphenMatch = (text || '').match(/[Aa][234]-(\d+)/);
  if (hyphenMatch) {
    return { size, qty: parseInt(hyphenMatch[1]), isUnknown: !size, isMoreOf: null };
  }

  // Remove size code first, then find standalone numbers
  // This prevents "A3" being read as qty=3, or "A4" as qty=4
  const cleaned = (text || '').replace(/[Aa][234]/gi, '');
  const numMatch = cleaned.match(/(\d+)/);
  const qty = numMatch ? parseInt(numMatch[1]) : (size ? 1 : null);

  return { size, qty, isUnknown: !size || !qty, isMoreOf: null };
}

async function extractOrder(msg, filename, session) {
  const prompt = `You are a precise order parser for a DTF print shop. Mistakes cost money. Be exact.

Customer message/caption: "${msg || ''}"
Filename: "${filename || ''}"
Existing order: ${JSON.stringify(session.files)}

FILENAME PARSING — critical rules:
- Number BEFORE size: "2 A4 DTF.pdf" → qty=2, size=A4
- Number AFTER hyphen: "A4-2.pdf" → qty=2, size=A4
- "20 A4 DTF.pdf" → qty=20, size=A4
- "20 A4 DTF HACK.pdf" → qty=20, size=A4
- "A3 flyer.pdf" → qty=1, size=A3 (size only = 1 copy)
- "krist_back_green.pdf" → isUnknown=true (no size/number)
- "design.jpg", "logo.jpg", "image.png" → isUnknown=true

CUSTOMER MESSAGE RULES:
- Customer text wins over filename if both have info
- "more","add","extra","another" → isMoreOf = that size
- "5 A3" → qty=5, size=A3

STRICT OUTPUT — reply ONLY with this JSON, no text, no markdown:
{"size":"A4|A3|A2|null","qty":number|null,"isUnknown":true|false,"isMoreOf":"A4|A3|A2|null"}`;

  try {
    const r = await askClaude([{ role:'user', content:prompt }], null, 150, 8000);
    const raw = r.content.map(c => c.text || '').join('').trim();
    return JSON.parse(raw.replace(/```json|```/g,'').trim());
  } catch (e) {
    console.error('Extract error:', e.message, '→ fallback');
    return quickParse(msg || filename);
  }
}

// ── Image instructions (bulk) ─────────────────────────────────
async function extractImageInstructions(msg, pendingImages) {
  const count = pendingImages.length;
  const prompt = `You are an order parser for a DTF print shop.

Customer provided instructions for ${count} image(s).
Their reply: "${msg}"

For each image extract:
- size: A4, A3, or A2
- qty: whole number of copies
- background: "keep" or "remove" or null

IMPORTANT: If the customer says a number like "2 each" or "all A4 2 copies", apply it to ALL images.
If they specify per image, apply individually.

Return ONLY a JSON array with exactly ${count} objects:
[{"size":"A4","qty":2,"background":"keep"}]`;

  try {
    const r = await askClaude([{ role:'user', content:prompt }], null, 300, 8000);
    const raw = r.content.map(c => c.text || '').join('').trim();
    const parsed = JSON.parse(raw.replace(/```json|```/g,'').trim());
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('Image instruction error:', e.message);
    const fb = quickParse(msg);
    return Array(count).fill({ size: fb.size, qty: fb.qty, background: null });
  }
}

// ── Add file ──────────────────────────────────────────────────
function addFile(session, info, source, notes) {
  const { size, qty, isMoreOf } = info;
  if (!size || !qty) return;
  if (isMoreOf) {
    const ex = session.files.find(f => f.size === isMoreOf);
    if (ex) { ex.qty += qty; return; }
  }
  const ex = session.files.find(f => f.size === size);
  if (ex) ex.qty += qty;
  else session.files.push({ size, qty, source: source || 'file', notes: notes || '' });
}

// ── Calculate bill ────────────────────────────────────────────
function calcBill(files) {
  const totals = { A4:0, A3:0, A2:0 };
  for (const f of files) if (f.size && totals[f.size] !== undefined) totals[f.size] += f.qty || 0;
  let subtotal = 0, a4eq = 0;
  const lines = [];
  for (const [size, qty] of Object.entries(totals)) {
    if (qty > 0) {
      const price = PRICES[size] * qty;
      subtotal += price; a4eq += qty * A4_EQ[size];
      lines.push({ size, qty, price });
    }
  }
  return { lines, subtotal, a4eq };
}

// ── Order summary ─────────────────────────────────────────────
function buildSummary(session) {
  const { lines, subtotal, a4eq } = calcBill(session.files);
  session.totalBill = subtotal; session.a4eq = a4eq;

  // Compact summary — show sizes totals, not individual files
  const items = lines.map(l =>
    `   ${l.size}  ·  *${l.qty} sheet${l.qty !== 1 ? 's' : ''}*  ·  GHS ${l.price.toFixed(2)}`
  ).join('\n');

  const parts = [
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `      📋 *ORDER SUMMARY*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    ``, items || `   (no items detected)`, ``,
    `   💰 *Total: GHS ${subtotal.toFixed(2)}*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
  ];

  if (session.unknownFiles.length > 0) {
    const names = session.unknownFiles.map(u => `   • ${u.name}`).join('\n');
    parts.push(``, `❓ *Still need size and quantity for:*`, names, ``,
      `_Reply e.g. "logo is 5 A3, flyer is 10 A4"_`, `_Known items auto-confirm in 5 mins._`);
  } else {
    parts.push(``, `Is this correct?`,
      `Reply *YES* to confirm ✅ or tell us what to change.`,
      `_Auto-confirms in 5 mins if no reply._`);
  }
  return parts.join('\n');
}

// ── Professional bill ─────────────────────────────────────────
function buildBill(session) {
  const { lines, subtotal, a4eq } = calcBill(session.files);
  session.totalBill = subtotal; session.a4eq = a4eq;
  const ready = readyTimeText(a4eq);
  const now   = new Date().toLocaleString('en-GH', {
    timeZone:'Africa/Accra', hour12:true,
    day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit',
  });

  const items = lines.map(l => {
    const bgFile = session.files.find(f => f.size === l.size && f.notes && f.notes.includes('background'));
    const note = bgFile ? ` _(${bgFile.notes})_` : '';
    return `🖨 ${l.size}  ·  ${l.qty} sheet${l.qty !== 1 ? 's' : ''}  ·  *GHS ${l.price.toFixed(2)}*${note}`;
  }).join('\n');

  return [
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `🧾 *MIGO PRINT SHOP*`,
    `📍 _Circle · Near Benz Gate · Accra_`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `📄 *ORDER DETAILS*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    items,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `💰 *TOTAL:  GHS ${subtotal.toFixed(2)}*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `🟡 *MTN MOBILE MONEY*`,
    ``, `   📱 *0552719245*`, `   👤 *KOW HABIB BAISIE*`, ``,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `⏱ Ready by *${ready}*`,
    `🗓 ${now}`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `_Thank you for choosing Migo!_ 🙏`,
  ].join('\n');
}

// ── Image question ────────────────────────────────────────────
// FIX: If more than 5 images, summarise — don't list individually
function buildImageQuestion(session) {
  const imgs = session.pendingImages;
  if (imgs.length === 1) {
    return [
      `I received your image. Please provide:`,
      ``, `  1️⃣  *Print size* — A4, A3, or A2?`,
      `  2️⃣  *Quantity* — How many copies?`,
      `  3️⃣  *Background* — Keep or remove?`,
    ].join('\n');
  }
  if (imgs.length <= 5) {
    const list = imgs.map((img, i) =>
      `  🖼 Image ${i + 1}${img.caption ? ` — _"${img.caption}"_` : ''}`
    ).join('\n');
    return [
      `I received *${imgs.length} images*. Please provide for each:`,
      ``, list, ``,
      `  1️⃣  *Print size* — A4, A3, or A2`,
      `  2️⃣  *Quantity* — Number of copies`,
      `  3️⃣  *Background* — Keep or remove`,
      ``,
      `_Example: "Image 1 — 10 A4, no bg. Image 2 — 5 A3, keep bg."_`,
    ].join('\n');
  }
  // More than 5 images — summarise
  return [
    `I received *${imgs.length} images*. Please provide the following for all of them:`,
    ``,
    `  1️⃣  *Print size* — A4, A3, or A2? (same for all, or specify per image)`,
    `  2️⃣  *Quantity* — How many copies of each?`,
    `  3️⃣  *Background* — Keep or remove? (same for all, or specify per image)`,
    ``,
    `_Example: "All A4, 2 copies each, keep background"_`,
    `_Or: "Images 1–10 are A4 x2 keep bg, last 2 are A3 x1 remove bg"_`,
  ].join('\n');
}

// ── Receive timer ─────────────────────────────────────────────
function startReceiveTimer(phone, session) {
  setTimer(phone, 'checkin', 2 * 60 * 1000, async () => {
    if (session.state !== 'receiving') return;

    if (session.pendingImages.length > 0) {
      session.state = 'asking_image_info';
      await sendMsg(phone, buildImageQuestion(session));
      setTimer(phone, 'imageTimeout', 5 * 60 * 1000, async () => {
        if (session.state !== 'asking_image_info') return;
        session.pendingImages = [];
        session.state = 'asked_done';
        await sendMsg(phone, 'Have you finished sending? 😊');
        setTimer(phone, 'nodone', 2 * 60 * 1000, async () => {
          if (session.state === 'asked_done') await proceedToSummary(phone, session);
        });
      });
      return;
    }

    session.state = 'asked_done';
    await sendMsg(phone, 'Have you finished sending? 😊');
    setTimer(phone, 'nodone', 2 * 60 * 1000, async () => {
      if (session.state === 'asked_done') await proceedToSummary(phone, session);
    });
  });
}

// ── Summary & Bill flows ──────────────────────────────────────
async function proceedToSummary(phone, session) {
  if (!session.files.length && !session.unknownFiles.length && !session.pendingImages.length) {
    await sendMsg(phone, `I could not detect any files. Please send your files and I will calculate the cost.`);
    session.state = 'receiving'; return;
  }
  session.state = 'confirming';
  await sendMsg(phone, buildSummary(session));
  setTimer(phone, 'autoconfirm', 5 * 60 * 1000, async () => {
    if (session.state === 'confirming') await sendBill(phone, session);
  });
}

async function sendBill(phone, session) {
  session.state = 'awaiting_payment';
  await sendMsg(phone, `Order received. Thank you. We will send you the cost shortly. 🙏`);
  setTimeout(async () => {
    await sendMsg(phone, buildBill(session));
    setTimer(phone, 'pay1', 10*60*1000, () => {
      if (session.state === 'awaiting_payment')
        sendMsg(phone, `⏰ Reminder: Please pay *GHS ${session.totalBill.toFixed(2)}* to MoMo *0552719245* (Kow Habib Baisie). 🙏`);
    });
    setTimer(phone, 'pay2', 30*60*1000, () => {
      if (session.state === 'awaiting_payment')
        sendMsg(phone, `🔔 Second reminder: *GHS ${session.totalBill.toFixed(2)}* still pending to *0552719245*. Please pay to keep your slot.`);
    });
    setTimer(phone, 'pay3', 60*60*1000, () => {
      if (session.state === 'awaiting_payment')
        sendMsg(phone, `⚠️ Final reminder: Please pay *GHS ${session.totalBill.toFixed(2)}* to MoMo *0552719245* to complete your order.`);
    });
  }, 2000);
}

// ── Intent helpers ────────────────────────────────────────────
function isYes(msg) {
  return /^\s*(yes|yeah|yep|yh|y|ok|okay|sure|correct|right|confirm|confirmed|proceed|go ahead|👍)\s*$/i.test(msg);
}
function isNo(msg) {
  return /\b(no|not yet|still sending|more|wait|nope|nah|adding|sending more)\b/i.test(msg);
}
function isMomoReceipt(msg) {
  return /paid|i paid|done paying|money sent|momo sent|transferred|i.ve paid|receipt|sent the money|i.ve sent/i.test(msg);
}

// ── Image handler ─────────────────────────────────────────────
async function handleImage(from, session, mediaUrl, caption) {
  const info = await extractOrder(caption, '', session);

  if (!info.isUnknown && info.size && info.qty) {
    const bgNote = /no.?background|remove.?background|no.?bg|transparent/i.test(caption) ? 'remove background'
                 : /with.?background|keep.?background|with.?bg/i.test(caption) ? 'keep background' : '';
    addFile(session, info, caption || 'image', bgNote);
    startReceiveTimer(from, session);
    return null; // silent
  }

  // No info — collect and ask IMMEDIATELY
  session.pendingImages.push({ url: mediaUrl, caption, index: session.pendingImages.length + 1 });
  startReceiveTimer(from, session);

  if (!caption) {
    return [
      `Thank you for your image! To add it to your order, please let me know:`,
      ``, `  1️⃣  *Print size* — A4, A3, or A2?`,
      `  2️⃣  *Quantity* — How many copies?`,
      `  3️⃣  *Background* — Keep or remove?`,
    ].join('\n');
  }
  return [
    `Thank you for your image. I could not determine the size and quantity from your caption.`,
    `Please specify:`,
    ``, `  1️⃣  *Print size* — A4, A3, or A2?`,
    `  2️⃣  *Quantity* — How many copies?`,
    `  3️⃣  *Background* — Keep or remove?`,
  ].join('\n');
}

// ── Document handler ──────────────────────────────────────────
async function handleDoc(from, session, mediaUrl, caption, filename) {
  const info = await extractOrder(caption, filename, session);
  if (!info.isUnknown && info.size && info.qty) {
    addFile(session, info, caption || filename, '');
    startReceiveTimer(from, session);
    return null; // silent
  }
  session.unknownFiles.push({ name: filename || 'your file', url: mediaUrl });
  startReceiveTimer(from, session);
  return `Thank you for sending "${filename || 'your file'}". Could you please let me know the print size (A4, A3, or A2) and how many copies you need?`;
}

// ── Main handler ──────────────────────────────────────────────
async function handleMessage(from, body, mediaUrl, mediaType, filename, isImage) {
  if (!botActive) return null;

  const msg     = (body || '').trim();
  const session = getSession(from);

  if (msg.toLowerCase().startsWith('admin ')) return handleAdmin(from, msg);

  // Auto-reset stale sessions (12h)
  const STALE = 12 * 60 * 60 * 1000;
  const inactiveStates = ['idle','receiving','asked_done','confirming','asking_image_info'];
  if (Date.now() - session.lastActivity > STALE && inactiveStates.includes(session.state)) {
    clearTimers(from); sessions.delete(from);
    return handleMessage(from, body, mediaUrl, mediaType, filename, isImage);
  }
  if (session.state === 'ready') {
    clearTimers(from); sessions.delete(from);
    return handleMessage(from, body, mediaUrl, mediaType, filename, isImage);
  }
  session.lastActivity = Date.now();
  console.log(`📩 ${from} [${session.state}]: "${msg || '[media]'}" img=${isImage}`);

  // ══ IDLE ══════════════════════════════════════════════════
  if (session.state === 'idle') {
    if (mediaUrl) {
      session.state = 'receiving';
      if (isImage) return handleImage(from, session, mediaUrl, msg);
      return handleDoc(from, session, mediaUrl, msg, filename);
    }
    if (msg) { session.state = 'receiving'; return replyWithClaude(msg, session); }
    return null;
  }

  // ══ RECEIVING ═════════════════════════════════════════════
  if (session.state === 'receiving') {
    if (mediaUrl) {
      if (isImage) return handleImage(from, session, mediaUrl, msg);
      return handleDoc(from, session, mediaUrl, msg, filename);
    }
    if (msg) {
      const info = await extractOrder(msg, null, session);
      if (!info.isUnknown && info.size && info.qty) {
        addFile(session, info, msg, '');
        startReceiveTimer(from, session);
        return null;
      }
      return replyWithClaude(msg, session);
    }
    return null;
  }

  // ══ ASKING IMAGE INFO ══════════════════════════════════════
  if (session.state === 'asking_image_info') {
    if (mediaUrl && isImage) {
      const info = await extractOrder(msg, '', session);
      if (!info.isUnknown && info.size && info.qty) addFile(session, info, msg || 'image', '');
      else session.pendingImages.push({ url: mediaUrl, caption: msg, index: session.pendingImages.length + 1 });
      return null;
    }
    if (msg) {
      const parsed = await extractImageInstructions(msg, session.pendingImages);
      const unresolved = [];
      for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i];
        if (item.size && item.qty) {
          const bgNote = item.background === 'remove' ? 'remove background'
                       : item.background === 'keep'   ? 'keep background' : '';
          addFile(session, { size:item.size, qty:item.qty, isUnknown:false, isMoreOf:null }, `image ${i+1}`, bgNote);
        } else { unresolved.push(session.pendingImages[i]); }
      }
      session.pendingImages = unresolved;
      if (session.pendingImages.length > 0) {
        return `Thank you. I still need instructions for ${session.pendingImages.length} image(s). Please provide the print size, quantity, and background preference.`;
      }
      clearTimers(from); await proceedToSummary(from, session); return null;
    }
    return null;
  }

  // ══ ASKED DONE ════════════════════════════════════════════
  if (session.state === 'asked_done') {
    clearTimers(from);
    if (isNo(msg)) { session.state = 'receiving'; startReceiveTimer(from, session); return null; }
    if (isYes(msg)) { await proceedToSummary(from, session); return null; }
    if (mediaUrl) {
      session.state = 'receiving';
      if (isImage) return handleImage(from, session, mediaUrl, msg);
      return handleDoc(from, session, mediaUrl, msg, filename);
    }
    const info = await extractOrder(msg, null, session);
    if (!info.isUnknown && info.size && info.qty) {
      addFile(session, info, msg, ''); session.state = 'receiving'; startReceiveTimer(from, session); return null;
    }
    session.state = 'receiving'; startReceiveTimer(from, session);
    return replyWithClaude(msg, session);
  }

  // ══ CONFIRMING ════════════════════════════════════════════
  if (session.state === 'confirming') {
    if (session.unknownFiles.length > 0 && msg && !isYes(msg)) {
      const info = await extractOrder(msg, null, session);
      if (!info.isUnknown && info.size && info.qty) { addFile(session, info, msg, ''); session.unknownFiles.shift(); }
      if (session.unknownFiles.length > 0) {
        const names = session.unknownFiles.map(u => `  • ${u.name}`).join('\n');
        return `Got it! I still need size and quantity for:\n${names}\n\n_e.g. "5 A3" or "10 A4"_`;
      }
      clearTimers(from); await proceedToSummary(from, session); return null;
    }
    clearTimers(from);
    if (isYes(msg)) { await sendBill(from, session); return null; }
    // Customer wants to correct
    session.state = 'receiving'; session.files = []; session.unknownFiles = []; session.pendingImages = [];
    await sendMsg(from, `No problem! Please resend the correct details and I will recalculate everything. 🙏`);
    startReceiveTimer(from, session); return null;
  }

  // ══ AWAITING PAYMENT ══════════════════════════════════════
  if (session.state === 'awaiting_payment') {
    // MoMo screenshot
    if (mediaUrl && isImage) {
      return [`Thank you for sending your payment receipt! 🙏`, ``,
        `We have received it and will confirm your payment shortly.`, ``,
        `🟡 MoMo: *0552719245* (Kow Habib Baisie)`].join('\n');
    }
    // New document after bill
    if (mediaUrl && !isImage) {
      const prevCount = session.files.length;
      await handleDoc(from, session, mediaUrl, msg, filename);
      if (session.files.length > prevCount) {
        const { subtotal, a4eq } = calcBill(session.files);
        session.totalBill = subtotal; session.a4eq = a4eq;
        await sendMsg(from, `I have added your new file to the order. Here is your updated bill:`);
        setTimeout(() => sendMsg(from, buildBill(session)), 1500);
      }
      return null;
    }
    const lower = msg.toLowerCase();
    if (isMomoReceipt(lower)) {
      return [`Thank you! 🙏 We have received your payment notification and will confirm shortly.`, ``,
        `🟡 *MTN MoMo: 0552719245*`, `👤 *Kow Habib Baisie*`].join('\n');
    }
    if (/how much|total|bill|balance|amount/.test(lower))
      return `Your current total is *GHS ${session.totalBill?.toFixed(2) || '—'}*.\n\n🟡 Please send to MoMo *0552719245* (Kow Habib Baisie). 🙏`;
    return replyWithClaude(msg, session);
  }

  // ══ PROCESSING ════════════════════════════════════════════
  if (session.state === 'processing') {
    if (mediaUrl) {
      session.state = 'receiving'; session.files = []; session.unknownFiles = []; session.pendingImages = [];
      if (isImage) return handleImage(from, session, mediaUrl, msg);
      return handleDoc(from, session, mediaUrl, msg, filename);
    }
    return replyWithClaude(msg, session);
  }

  // ══ READY ═════════════════════════════════════════════════
  if (session.state === 'ready') {
    const n = parseInt(msg);
    if (!isNaN(n) && n >= 1 && n <= 5) {
      if (n === 5) return `🎉 Thank you so much! We are thrilled you had a great experience!`;
      if (n === 4) return `😊 Thank you! We appreciate your kind feedback.`;
      if (n === 3) return `🙏 Thank you! We will work hard to do better next time.`;
      return `😔 We are truly sorry to hear that. Please tell us what went wrong so we can improve.`;
    }
    return replyWithClaude(msg, session);
  }

  return null;
}

// ── Admin ─────────────────────────────────────────────────────
async function handleAdmin(from, msg) {
  const parts = msg.trim().split(/\s+/);
  const cmd   = (parts[1] || '').toLowerCase();

  if (cmd === 'h') { botActive = false; return '🔴 Bot stopped.'; }
  if (cmd === 'j') { botActive = true;  return '🟢 Bot started.'; }

  if (cmd === 'override') {
    const phone = `whatsapp:+233${(parts[2]||'').replace(/^0/,'')}`;
    const message = parts.slice(3).join(' ');
    if (!message) return '❌ Usage: admin override 0244xxx Your message';
    await sendMsg(phone, message); return `✅ Sent to ${parts[2]}.`;
  }
  if (cmd === 'info') {
    const phone = `whatsapp:+233${(parts[2]||'').replace(/^0/,'')}`;
    const qty = parseInt(parts[3]); const size = (parts[4]||'').toUpperCase();
    if (!PRICES[size] || isNaN(qty)) return '❌ Usage: admin info 0244xxx 20 A4';
    addFile(getSession(phone), { size, qty, isUnknown:false, isMoreOf:null }, 'admin', '');
    return `✅ Added ${qty} ${size} for ${parts[2]}.`;
  }
  if (cmd === 'ready') {
    // Support both phone number AND Job ID lookup
    let phone = `whatsapp:+233${(parts[2]||'').replace(/^0/,'')}`;
    let s = sessions.get(phone);

    // If not found by phone, try Job ID
    if (!s) {
      const jobIdSearch = (parts[2]||'').toUpperCase();
      for (const [key, sess] of sessions.entries()) {
        if (sess.jobId === jobIdSearch) { phone = key; s = sess; break; }
      }
    }
    if (!s) return `❌ No session found for ${parts[2]}.`;
    s.state = 'ready'; clearTimers(phone);
    const jobIdLine = s.jobId ? [
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━`,
      `🔖 *YOUR JOB ID: ${s.jobId}*`,
      `━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `⚠️ *IMPORTANT:*`,
      `• Show this ID when collecting your order`,
      `• If sending a delivery person, they MUST quote *${s.jobId}* to receive your job`,
      `• No ID = No release of job`,
      ``,
    ].join('\n') : '';
    await sendMsg(phone, [
      `✅ *Your order is ready for pickup!*`,
      jobIdLine,
      `📍 *Migo Print Shop*`,
      `Circle branch, near Benz Gate,`,
      `closer to Calvary Church, Accra.`,
      ``,
      `Thank you for choosing Migo! 🙏`,
    ].join('\n'));
    setTimer(phone, 'rating', 30*60*1000, async () => {
      if (!s.ratingAsked) {
        s.ratingAsked = true;
        await sendMsg(phone, [`⭐ How was your experience at Migo Print Shop?`, ``,
          `5 — Excellent  |  4 — Good  |  3 — Okay  |  2 — Poor  |  1 — Very poor`].join('\n'));
      }
    });
    return `✅ Ready notification sent to ${parts[2]}.`;
  }
  if (cmd === 'status') {
    const phone = `whatsapp:+233${(parts[2]||'').replace(/^0/,'')}`;
    const s = sessions.get(phone);
    if (!s) return `❌ No session for ${parts[2]}.`;
    return [`📊 *${parts[2]}*`, `State: ${s.state}`,
      `Job ID: ${s.jobId || '—'}`,
      `Files: ${JSON.stringify(s.files)}`, `Unknown: ${s.unknownFiles.length}`,
      `Images pending: ${s.pendingImages.length}`,
      `Total: GHS ${s.totalBill?.toFixed(2)||'—'}`, `Paid: GHS ${s.paymentReceived.toFixed(2)}`].join('\n');
  }
  if (cmd === 'jobs') {
    const out = [`📋 *ACTIVE SESSIONS*`, ``];
    for (const [key, s] of sessions.entries())
      out.push(`${key.replace('whatsapp:+233','0')} → ${s.state} | GHS ${s.totalBill?.toFixed(2)||'—'}${s.jobId ? ' | ' + s.jobId : ''}`);
    return out.length > 2 ? out.join('\n') : '📭 No active sessions.';
  }
  if (cmd === 'reset') {
    const phone = `whatsapp:+233${(parts[2]||'').replace(/^0/,'')}`;
    if (sessions.has(phone)) { clearTimers(phone); sessions.delete(phone); return `✅ Reset ${parts[2]}.`; }
    return `❌ No session for ${parts[2]}.`;
  }
  if (cmd === 'resetall') {
    const count = sessions.size;
    for (const key of sessions.keys()) clearTimers(key);
    sessions.clear(); return `✅ All ${count} sessions cleared.`;
  }
  return `❓ Commands: admin h|j|override|info|ready|status|jobs|reset|resetall`;
}

// ── Webhook ───────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const twiml    = new twilio.twiml.MessagingResponse();
  const from     = req.body.From    || '';
  const body     = req.body.Body    || '';
  const mediaUrl = req.body.MediaUrl0;
  const mediaType= req.body.MediaContentType0 || '';
  const filename = req.body.MediaFilename || '';
  const isImage  = mediaType.startsWith('image/');

  console.log(`📩 from=${from} body="${body}" type=${mediaType||'text'} file=${filename}`);
  try {
    const reply = await handleMessage(from, body, mediaUrl, mediaType, filename, isImage);
    if (reply) twiml.message(reply);
  } catch (err) { console.error('❌ Webhook error:', err.message); }
  res.set('Content-Type', 'text/xml');
  res.send(twiml.toString());
});

// ── Worker reminders & overdue alerts ────────────────────────
function scheduleWorkerReminders(phone, session) {
  if (!session.readyTime) return;

  const now        = Date.now();
  const readyMs    = session.readyTime.getTime();
  const ms30before = readyMs - (30 * 60 * 1000);
  const ms15before = readyMs - (15 * 60 * 1000);
  const ms2before  = readyMs - (2  * 60 * 1000);
  const msOverdue  = readyMs + (1  * 60 * 1000); // 1 min after ready time

  const jobId      = session.jobId || '—';
  const customerPh = phone;

  // 30-minute reminder to workers
  if (ms30before > now) {
    setTimer(phone, 'work30', ms30before - now, async () => {
      if (session.state !== 'processing') return;
      await sendMsg(ADMIN_PHONE, [
        `⏰ *30-Minute Warning*`,
        ``,
        `🔖 Job ID: *${jobId}*`,
        `📱 Customer: ${customerPh.replace('whatsapp:+233','0')}`,
        ``,
        `This job is due in 30 minutes.`,
        `Please ensure it is on track. 🙏`,
      ].join('\n'));
    });
  }

  // 15-minute reminder to workers
  if (ms15before > now) {
    setTimer(phone, 'work15', ms15before - now, async () => {
      if (session.state !== 'processing') return;
      await sendMsg(ADMIN_PHONE, [
        `⚠️ *15-Minute Warning*`,
        ``,
        `🔖 Job ID: *${jobId}*`,
        `📱 Customer: ${customerPh.replace('whatsapp:+233','0')}`,
        ``,
        `This job is due in 15 minutes. Please prioritise it now.`,
      ].join('\n'));
    });
  }

  // 2-minute reminder to workers
  if (ms2before > now) {
    setTimer(phone, 'work2', ms2before - now, async () => {
      if (session.state !== 'processing') return;
      await sendMsg(ADMIN_PHONE, [
        `🚨 *2-Minute Warning*`,
        ``,
        `🔖 Job ID: *${jobId}*`,
        `📱 Customer: ${customerPh.replace('whatsapp:+233','0')}`,
        ``,
        `This job is due in 2 minutes! Please finalise immediately.`,
      ].join('\n'));
    });
  }

  // Overdue — notify customer and keep reminding workers every 30 mins
  if (msOverdue > now) {
    setTimer(phone, 'overdue', msOverdue - now, () => {
      handleOverdue(phone, session, 1);
    });
  }
}

async function handleOverdue(phone, session, attempt) {
  if (session.state !== 'processing') return; // Job was marked ready, stop

  session.overdueReminders = attempt;

  // New estimated time — add 30 mins per attempt
  const newReadyMs = Date.now() + 30 * 60 * 1000;
  const newReady   = new Date(newReadyMs).toLocaleString('en-GH', {
    timeZone:'Africa/Accra', hour12:true, hour:'2-digit', minute:'2-digit',
  });

  // Apologise to customer
  await sendMsg(phone, [
    `We sincerely apologise for the delay with your order. 🙏`,
    ``,
    `🔖 Job ID: *${session.jobId}*`,
    ``,
    `We are working hard to complete it and your order will be ready by *${newReady}*.`,
    ``,
    `We truly appreciate your patience and understanding.`,
    `Thank you for choosing Migo Print Shop. 😊`,
  ].join('\n'));

  // Alert workers
  await sendMsg(ADMIN_PHONE, [
    `🔴 *OVERDUE JOB — Attempt ${attempt}*`,
    ``,
    `🔖 Job ID: *${session.jobId}*`,
    `📱 Customer: ${phone.replace('whatsapp:+233','0')}`,
    ``,
    `This job is overdue! Customer has been informed.`,
    `New estimated time given: *${newReady}*`,
    ``,
    `Please complete and type: admin ready ${phone.replace('whatsapp:+233','0')}`,
  ].join('\n'));

  // Remind workers again every 30 mins until job is marked ready
  setTimer(phone, 'overdue', 30 * 60 * 1000, () => {
    handleOverdue(phone, session, attempt + 1);
  });
}

// ── MoMo endpoint ─────────────────────────────────────────────
app.post('/momo', async (req, res) => {
  const { amount, phone } = req.body;
  const paid = parseFloat(amount) || 0;
  if (!paid) return res.json({ status: 'ignored' });

  const tail = (phone||'').replace(/\D/g,'').slice(-9);
  let matched = null, matchedKey = null;
  for (const [key, s] of sessions.entries())
    if (key.replace(/\D/g,'').slice(-9) === tail) { matched = s; matchedKey = key; break; }
  if (!matched) return res.json({ status: 'no_match' });

  matched.paymentReceived += paid;
  const balance = (matched.totalBill || 0) - matched.paymentReceived;

  if (balance <= 0.01) {
    matched.confirmedFiles = [...matched.confirmedFiles, ...matched.files];
    matched.files = []; matched.paymentReceived = 0; matched.totalBill = null;
    matched.state = 'processing';
    matched.jobId = generateJobId(matchedKey); // Assign unique Job ID
    matched.readyTime = new Date(Date.now() + getReadyHours(matched.a4eq||0) * 3600000);
    matched.overdueReminders = 0; // track how many overdue reminders sent
    clearTimers(matchedKey);

    const readyAt = readyTimeText(matched.a4eq||0);

    // Notify customer
    await sendMsg(matchedKey, [
      `✅ *Payment Confirmed!*`,
      ``,
      `GHS ${paid.toFixed(2)} received. Thank you! 🙏`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━`,
      `🔖 *YOUR JOB ID*`,
      ``,
      `   *${matched.jobId}*`,
      `━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `⚠️ *IMPORTANT — Please note:*`,
      `• Quote this ID for any enquiries about your order`,
      `• Show this ID when picking up your order`,
      `• If sending a delivery person, they MUST provide this ID to collect your job`,
      `• Screenshot or save this message for reference`,
      ``,
      `⏱ Your order will be ready by *${readyAt}*.`,
      ``,
      `We will notify you as soon as it is ready. 🙏`,
    ].join('\n'));

    // Schedule worker reminders
    scheduleWorkerReminders(matchedKey, matched);
  } else {
    await sendMsg(matchedKey, [`✅ GHS ${paid.toFixed(2)} received. Thank you!`, ``,
      `⚠️ *Balance remaining: GHS ${balance.toFixed(2)}*`, ``,
      `Please send the balance to:`, `🟡 MoMo: *0552719245*`, `👤 *Kow Habib Baisie*`].join('\n'));
  }
  res.json({ status:'ok', paid, balance: Math.max(0, balance) });
});

app.get('/jobs', (req, res) => {
  const jobs = [];
  for (const [key, s] of sessions.entries())
    jobs.push({ phone:key, state:s.state, files:s.files, total:s.totalBill,
      paid:s.paymentReceived, balance:Math.max(0,(s.totalBill||0)-s.paymentReceived) });
  res.json({ bot: botActive?'active':'stopped', sessions:jobs.length, jobs });
});

app.get('/', (req, res) => res.json({
  status:'running', version:'v13.1',
  bot: botActive?'active':'stopped',
  sessions: sessions.size,
  uptime: process.uptime().toFixed(0)+'s',
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 MIGO Print Bot v13 — port ${PORT}`);
  console.log(`   Twilio SID : ${ACCOUNT_SID   ? ACCOUNT_SID.slice(0,10)+'…' : 'NOT SET ❌'}`);
  console.log(`   Auth Token : ${AUTH_TOKEN    ? '✅ set' : 'NOT SET ❌'}`);
  console.log(`   Anthropic  : ${ANTHROPIC_KEY ? '✅ set' : 'NOT SET ❌'}`);
});
