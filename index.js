// ============================================================
// MIGO DTF PRINT SHOP — WhatsApp Bot (v11 — Clean Rewrite)
// ============================================================

const express  = require('express');
const twilio   = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── Credentials ───────────────────────────────────────────────
const ACCOUNT_SID   = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN    = process.env.TWILIO_AUTH_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const FROM_NUMBER   = 'whatsapp:+14155238886';

const twilioClient = twilio(ACCOUNT_SID, AUTH_TOKEN);
const anthropic    = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ── Prices ────────────────────────────────────────────────────
const PRICES = { A4: 3.20, A3: 6.40, A2: 16.00 };
const A4_EQ  = { A4: 1,    A3: 2,    A2: 4    };

// ── State ─────────────────────────────────────────────────────
const sessions = new Map();
const timers   = new Map();
let   botActive = true;

// ── Session ───────────────────────────────────────────────────
function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      phone,
      state:           'idle',
      files:           [],   // unpaid pending files
      confirmedFiles:  [],   // paid and confirmed files — never recalculated
      unknownFiles:    [],   // files with no size/qty info
      pendingImages:   [],   // images waiting for instructions
      chatHistory:     [],   // conversation history for Claude
      totalBill:       null,
      a4eq:            0,
      paymentReceived: 0,
      ratingAsked:     false,
      lastActivity:    Date.now(),
    });
  }
  return sessions.get(phone);
}

// ── Timer helpers ─────────────────────────────────────────────
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

// ── Send message via Twilio API ───────────────────────────────
async function sendMsg(to, body) {
  const dest = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  try {
    await twilioClient.messages.create({ from: FROM_NUMBER, to: dest, body });
    console.log(`✅ Sent to ${dest}: "${body.slice(0, 80)}"`);
  } catch (err) {
    console.error(`❌ Send failed to ${dest}:`, err.message);
  }
}

// ── Claude call with timeout ──────────────────────────────────
async function askClaude(messages, system, maxTokens = 300, timeoutMs = 12000) {
  const opts = {
    model:      'claude-opus-4-6',
    max_tokens: maxTokens,
    messages,
  };
  if (system) opts.system = system;
  return Promise.race([
    anthropic.messages.create(opts),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Claude timeout')), timeoutMs)
    ),
  ]);
}

// ── Shop system prompt ────────────────────────────────────────
const SHOP_SYSTEM = `You are a professional and helpful customer service representative for Migo Print Shop.

Shop details:
- Location: Circle branch, near Benz Gate, closer to Calvary Church, Accra, Ghana
- Services: DTF (Direct to Film) printing
- Sizes and prices: A4 at GHS 3.20 per sheet, A3 at GHS 6.40 per sheet, A2 at GHS 16.00 per sheet
- Payment: MTN Mobile Money — 0552719245 (Kow Habib Baisie)
- Hours: Monday to Saturday, 8:00am to 6:00pm. Closed on Sundays
- WhatsApp: 0552719245

Your behaviour:
- Always speak in clear, natural British English. No pidgin, no slang.
- Be warm, professional, and conversational — like a knowledgeable shop assistant.
- Respond to everything the customer says. Never ignore a message.
- If unsure about something, ask a clarifying question.
- Guide customers who seem ready to order to send their files.
- Never reveal you are an AI.
- Keep responses concise — 1 to 4 sentences unless more detail is needed.`;

// ── Chat history helpers ──────────────────────────────────────
function addToHistory(session, role, content) {
  session.chatHistory.push({ role, content });
  if (session.chatHistory.length > 40) session.chatHistory = session.chatHistory.slice(-40);
}

// ── Instant reply (no API — within Twilio 15s limit) ─────────
function instantReply(msg) {
  const m = (msg || '').toLowerCase().trim();
  if (/^(hi|hello|hey|good morning|good afternoon|good evening|morning|evening|afternoon|howdy)[!.\s]*$/.test(m))
    return `Hello! Welcome to Migo Print Shop. 😊 How can I help you today?`;
  if (/dtf/.test(m))
    return `Yes, we do DTF printing. Please send your files and we will calculate the cost for you.`;
  if (/price|how much|cost|rate/.test(m))
    return `Our prices are: A4 — GHS 3.20, A3 — GHS 6.40, A2 — GHS 16.00 per sheet.`;
  if (/open|hour|close|time/.test(m))
    return `We are open Monday to Saturday, 8am to 6pm. Closed on Sundays.`;
  if (/where|location|address|direction/.test(m))
    return `We are at Circle branch, near Benz Gate, closer to Calvary Church, Accra.`;
  if (/how are you|you good|how do you do/.test(m))
    return `I am very well, thank you! How can I assist you today?`;
  return `Thank you for your message. How can I help you today?`;
}

// ── Claude conversational reply (async, sends via Twilio) ─────
async function claudeReplyAsync(msg, session) {
  addToHistory(session, 'user', msg);
  try {
    const r = await askClaude(session.chatHistory, SHOP_SYSTEM, 300, 12000);
    const reply = r.content.map(c => c.text || '').join('').trim();
    if (reply) {
      addToHistory(session, 'assistant', reply);
      await sendMsg(session.phone, reply);
    }
  } catch (e) {
    console.error('Claude async error:', e.message);
  }
}

// ── Reply: instant first, Claude follows up ───────────────────
async function replyWithClaude(msg, session) {
  const quick = instantReply(msg);
  // Fire Claude in background — don't await
  claudeReplyAsync(msg, session).catch(() => {});
  return quick;
}

// ── Order extraction ──────────────────────────────────────────
function quickParse(text) {
  const upper = (text || '').toUpperCase();
  const size  = ['A2', 'A3', 'A4'].find(s => upper.includes(s)) || null;
  const match = (text || '').match(/(\d+)/);
  const qty   = match ? parseInt(match[1]) : null;
  return { size, qty, isUnknown: !size || !qty, isMoreOf: null };
}

async function extractOrder(msg, filename, session) {
  const prompt = `You are an order parser for a DTF print shop in Accra, Ghana.

Customer message or caption: "${msg || ''}"
Filename: "${filename || ''}"
Existing order: ${JSON.stringify(session.files)}

RULES:
1. Size must be A4, A3, or A2 only.
2. Quantity is a whole number of sheets.
3. If BOTH size and quantity found → isUnknown = false
4. If either is missing → isUnknown = true
5. Customer text always wins over filename.
6. Filename patterns:
   "20 A4 DTF.pdf" → 20 A4
   "2 A4 DTF.pdf" → 2 A4
   "A4-2.pdf" → 2 A4
   "A3 flyer.pdf" → 1 A3
   "design.jpg" → unknown
7. "more", "add", "extra", "another" → isMoreOf = that size
8. Size in filename but no number → qty = 1

Reply ONLY with this JSON, no other text:
{"size":"A4|A3|A2|null","qty":number|null,"isUnknown":true|false,"isMoreOf":"A4|A3|A2|null"}`;

  try {
    const r = await askClaude([{ role: 'user', content: prompt }], null, 150, 8000);
    const raw = r.content.map(c => c.text || '').join('').trim();
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (e) {
    console.error('Extract error:', e.message, '→ fallback');
    return quickParse(msg || filename);
  }
}

// ── Image instruction extraction ──────────────────────────────
async function extractImageInstructions(msg, pendingImages) {
  const count = pendingImages.length;
  const prompt = `You are an order parser for a DTF print shop.

Customer was asked for instructions for ${count} image(s).
Their reply: "${msg}"

For each image, extract:
- size: A4, A3, or A2
- qty: number of copies (integer)
- background: "keep" or "remove" or null

Return ONLY a JSON array with exactly ${count} objects. No extra text:
[{"size":"A4","qty":10,"background":"remove"}]

Use null for anything not mentioned.`;

  try {
    const r = await askClaude([{ role: 'user', content: prompt }], null, 300, 8000);
    const raw = r.content.map(c => c.text || '').join('').trim();
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('Image extract error:', e.message);
    const fb = quickParse(msg);
    return [{ size: fb.size, qty: fb.qty, background: null }];
  }
}

// ── Add file to session ───────────────────────────────────────
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
  return { lines, subtotal, a4eq };
}

function readyTime(a4eq) {
  if (a4eq <= 50)  return '2 hours';
  if (a4eq <= 100) return '3 hours';
  if (a4eq <= 200) return '4 hours';
  if (a4eq <= 400) return '6 hours';
  if (a4eq <= 800) return '8 hours';
  return 'Next day by 12pm';
}

// ── Order summary (before bill) ───────────────────────────────
function buildSummary(session) {
  const { lines, subtotal, a4eq } = calcBill(session.files);
  session.totalBill = subtotal;
  session.a4eq      = a4eq;

  const items = lines.map(l =>
    `   ${l.size}  ·  *${l.qty} sheet${l.qty !== 1 ? 's' : ''}*`
  ).join('\n');

  const parts = [
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `      📋 *ORDER SUMMARY*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    items || `   (no items detected)`,
    ``,
    `   💰 *Total: GHS ${subtotal.toFixed(2)}*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
  ];

  if (session.unknownFiles.length > 0) {
    const names = session.unknownFiles.map(u => `   • ${u.name}`).join('\n');
    parts.push(``, `❓ *Still need size and quantity for:*`, names, ``,
      `_Reply e.g. "logo is 5 A3, flyer is 10 A4"_`, ``,
      `_Known items auto-confirm in 5 mins._`);
  } else {
    parts.push(``, `Is this correct?`,
      `Reply *YES* to confirm ✅ or tell us what to change.`,
      `_Auto-confirms in 5 mins if no reply._`);
  }
  return parts.join('\n');
}

// ── Professional receipt ──────────────────────────────────────
function buildBill(session) {
  const { lines, subtotal, a4eq } = calcBill(session.files);
  const ready = readyTime(a4eq);
  const now   = new Date().toLocaleString('en-GH', {
    timeZone: 'Africa/Accra', hour12: true,
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  session.totalBill = subtotal;
  session.a4eq      = a4eq;

  const items = lines.map(l => {
    const bgNote = session.files.find(f => f.size === l.size && f.notes && f.notes.includes('background'));
    const note   = bgNote ? ` _(${bgNote.notes})_` : '';
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
    ``,
    `   📱 *0552719245*`,
    `   👤 *KOW HABIB BAISIE*`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `⏱ Ready in *${ready}* after payment`,
    `🗓 ${now}`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `_Thank you for choosing Migo!_ 🙏`,
  ].join('\n');
}

// ── Pending image question ────────────────────────────────────
function buildImageQuestion(session) {
  const imgs = session.pendingImages;
  if (imgs.length === 1) {
    return [
      `I received your image. Please provide the following:`,
      ``,
      `  1️⃣  *Print size* — A4, A3, or A2?`,
      `  2️⃣  *Quantity* — How many copies?`,
      `  3️⃣  *Background* — Keep or remove?`,
    ].join('\n');
  }
  const list = imgs.map((img, i) =>
    `  🖼 Image ${i + 1}${img.caption ? ` — _"${img.caption}"_` : ''}`
  ).join('\n');
  return [
    `I received *${imgs.length} images*. Please provide for each one:`,
    ``,
    list,
    ``,
    `  1️⃣  *Print size* — A4, A3, or A2`,
    `  2️⃣  *Quantity* — Number of copies`,
    `  3️⃣  *Background* — Keep or remove`,
    ``,
    `_Example: "Image 1 — 10 A4, no background. Image 2 — 5 A3, keep background."_`,
  ].join('\n');
}

// ── Receive timer ─────────────────────────────────────────────
function startReceiveTimer(phone, session) {
  setTimer(phone, 'checkin', 2 * 60 * 1000, async () => {
    if (session.state !== 'receiving') return;

    // Pending images need instructions first
    if (session.pendingImages.length > 0) {
      session.state = 'asking_image_info';
      await sendMsg(phone, buildImageQuestion(session));
      // If no reply in 5 mins — exclude those images and proceed
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

// ── Summary → Bill flow ───────────────────────────────────────
async function proceedToSummary(phone, session) {
  if (!session.files.length && !session.unknownFiles.length && !session.pendingImages.length) {
    await sendMsg(phone, `I could not detect any files or order details. Please send your files and I will calculate the cost for you.`);
    session.state = 'receiving';
    return;
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
    // Payment reminders
    setTimer(phone, 'pay1', 10 * 60 * 1000, () => {
      if (session.state === 'awaiting_payment')
        sendMsg(phone, `⏰ Reminder: Please pay *GHS ${session.totalBill.toFixed(2)}* to MoMo *0552719245* (Kow Habib Baisie) to confirm your order. 🙏`);
    });
    setTimer(phone, 'pay2', 30 * 60 * 1000, () => {
      if (session.state === 'awaiting_payment')
        sendMsg(phone, `🔔 Second reminder: *GHS ${session.totalBill.toFixed(2)}* is still pending. Please pay to *0552719245* to keep your slot.`);
    });
    setTimer(phone, 'pay3', 60 * 60 * 1000, () => {
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

// ── Handle image media ────────────────────────────────────────
async function handleImageMedia(from, session, mediaUrl, caption) {
  const info = await extractOrder(caption, '', session);
  if (!info.isUnknown && info.size && info.qty) {
    const bgNote = /no.?background|remove.?background|no.?bg|transparent/i.test(caption) ? 'remove background'
                 : /with.?background|keep.?background|with.?bg/i.test(caption) ? 'keep background' : '';
    addFile(session, info, caption || 'image', bgNote);
    startReceiveTimer(from, session);
    return null; // silent
  }
  // No info — collect for bulk ask
  session.pendingImages.push({ url: mediaUrl, caption, index: session.pendingImages.length + 1 });
  startReceiveTimer(from, session);
  return null; // silent — wait for more images, then ask at once
}

// ── Handle document/PDF media ─────────────────────────────────
async function handleDocMedia(from, session, mediaUrl, caption, filename) {
  const info = await extractOrder(caption, filename, session);
  if (!info.isUnknown && info.size && info.qty) {
    addFile(session, info, caption || filename, '');
    startReceiveTimer(from, session);
    return null;
  }
  session.unknownFiles.push({ name: filename || 'your file', url: mediaUrl });
  startReceiveTimer(from, session);
  return `Thank you for sending "${filename || 'your file'}". Could you please let me know the print size (A4, A3, or A2) and how many copies you need?`;
}

// ── Main message handler ──────────────────────────────────────
async function handleMessage(from, body, mediaUrl, mediaType, filename, isImage) {
  if (!botActive) return null;

  const msg     = (body || '').trim();
  const session = getSession(from);

  // Admin
  if (msg.toLowerCase().startsWith('admin ')) return handleAdmin(from, msg);

  // Auto-reset stale sessions (12h no activity)
  const STALE = 12 * 60 * 60 * 1000;
  const inactiveStates = ['idle', 'receiving', 'asked_done', 'confirming', 'asking_image_info'];
  if (Date.now() - session.lastActivity > STALE && inactiveStates.includes(session.state)) {
    clearTimers(from);
    sessions.delete(from);
    return await handleMessage(from, body, mediaUrl, mediaType, filename, isImage);
  }
  if (session.state === 'ready') {
    clearTimers(from);
    sessions.delete(from);
    return await handleMessage(from, body, mediaUrl, mediaType, filename, isImage);
  }
  session.lastActivity = Date.now();

  console.log(`📩 ${from} [${session.state}]: "${msg || '[media]'}" img=${isImage}`);

  // ── IDLE ─────────────────────────────────────────────────
  if (session.state === 'idle') {
    if (mediaUrl) {
      session.state = 'receiving';
      if (isImage) return handleImageMedia(from, session, mediaUrl, msg);
      return handleDocMedia(from, session, mediaUrl, msg, filename);
    }
    if (msg) {
      session.state = 'receiving';
      return replyWithClaude(msg, session);
    }
    return null;
  }

  // ── RECEIVING ────────────────────────────────────────────
  if (session.state === 'receiving') {
    if (mediaUrl) {
      if (isImage) return handleImageMedia(from, session, mediaUrl, msg);
      return handleDocMedia(from, session, mediaUrl, msg, filename);
    }
    if (msg) {
      // Check if it's order info (e.g. "5 more A3")
      const info = await extractOrder(msg, null, session);
      if (!info.isUnknown && info.size && info.qty) {
        addFile(session, info, msg, '');
        startReceiveTimer(from, session);
        return null;
      }
      // Otherwise reply — don't reset the file timer
      return replyWithClaude(msg, session);
    }
    return null;
  }

  // ── ASKING IMAGE INFO ─────────────────────────────────────
  if (session.state === 'asking_image_info') {
    if (mediaUrl && isImage) {
      const info = await extractOrder(msg, '', session);
      if (!info.isUnknown && info.size && info.qty) {
        addFile(session, info, msg || 'image', '');
      } else {
        session.pendingImages.push({ url: mediaUrl, caption: msg, index: session.pendingImages.length + 1 });
      }
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
          addFile(session, { size: item.size, qty: item.qty, isUnknown: false, isMoreOf: null },
            `image ${i + 1}`, bgNote);
        } else {
          unresolved.push(session.pendingImages[i]);
        }
      }
      session.pendingImages = unresolved;
      if (session.pendingImages.length > 0) {
        return `Thank you. I still need instructions for ${session.pendingImages.length} image(s). Please provide the print size, quantity, and background preference for each.`;
      }
      clearTimers(from);
      await proceedToSummary(from, session);
      return null;
    }
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
    if (isYes(msg)) {
      await proceedToSummary(from, session);
      return null;
    }
    if (mediaUrl) {
      session.state = 'receiving';
      if (isImage) return handleImageMedia(from, session, mediaUrl, msg);
      return handleDocMedia(from, session, mediaUrl, msg, filename);
    }
    // Ambiguous — treat as still sending
    const info = await extractOrder(msg, null, session);
    if (!info.isUnknown && info.size && info.qty) {
      addFile(session, info, msg, '');
      session.state = 'receiving';
      startReceiveTimer(from, session);
      return null;
    }
    session.state = 'receiving';
    startReceiveTimer(from, session);
    return replyWithClaude(msg, session);
  }

  // ── CONFIRMING ────────────────────────────────────────────
  if (session.state === 'confirming') {
    // Customer provided info for unknown files
    if (session.unknownFiles.length > 0 && msg && !isYes(msg)) {
      const info = await extractOrder(msg, null, session);
      if (!info.isUnknown && info.size && info.qty) {
        addFile(session, info, msg, '');
        session.unknownFiles.shift();
      }
      if (session.unknownFiles.length > 0) {
        const names = session.unknownFiles.map(u => `  • ${u.name}`).join('\n');
        return `Got it! I still need size and quantity for:\n${names}\n\n_e.g. "5 A3" or "10 A4"_`;
      }
      // All resolved — show updated summary
      clearTimers(from);
      await proceedToSummary(from, session);
      return null;
    }

    clearTimers(from);

    if (isYes(msg)) {
      await sendBill(from, session);
      return null;
    }

    // Customer wants to correct something
    session.state = 'receiving';
    session.files = [];
    session.unknownFiles = [];
    session.pendingImages = [];
    await sendMsg(from, `No problem! Please resend the correct details and I will recalculate everything. 🙏`);
    startReceiveTimer(from, session);
    return null;
  }

  // ── AWAITING PAYMENT ─────────────────────────────────────
  if (session.state === 'awaiting_payment') {
    // New file after bill — recalculate (unpaid files only)
    if (mediaUrl) {
      let reply;
      if (isImage) reply = await handleImageMedia(from, session, mediaUrl, msg);
      else         reply = await handleDocMedia(from, session, mediaUrl, msg, filename);

      const info = session.files.length > 0 ? session.files[session.files.length - 1] : null;
      if (info && session.files.length > 0) {
        const { subtotal, a4eq } = calcBill(session.files);
        session.totalBill = subtotal;
        session.a4eq = a4eq;
        await sendMsg(from, `I have added your new file to the order. Here is your updated bill:`);
        setTimeout(() => sendMsg(from, buildBill(session)), 1500);
        return null;
      }
      return reply;
    }

    const lower = msg.toLowerCase();
    if (/paid|i paid|done paying|money sent|momo sent|transferred|i.ve paid/.test(lower))
      return `Thank you! 🙏 We will confirm your payment shortly.\n\n🟡 *MTN MoMo: 0552719245*\n👤 *Kow Habib Baisie*`;
    if (/how much|total|bill|balance|amount/.test(lower))
      return `Your current total is *GHS ${session.totalBill?.toFixed(2) || '—'}*.\n\n🟡 Please send to MoMo *0552719245* (Kow Habib Baisie). 🙏`;

    return replyWithClaude(msg, session);
  }

  // ── PROCESSING ────────────────────────────────────────────
  if (session.state === 'processing') {
    if (mediaUrl) {
      // Customer sending new files — start a new order alongside
      session.state = 'receiving';
      session.files = [];
      session.unknownFiles = [];
      session.pendingImages = [];
      if (isImage) return handleImageMedia(from, session, mediaUrl, msg);
      return handleDocMedia(from, session, mediaUrl, msg, filename);
    }
    return replyWithClaude(msg, session);
  }

  // ── READY ─────────────────────────────────────────────────
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

// ── Admin handler ─────────────────────────────────────────────
async function handleAdmin(from, msg) {
  const parts = msg.trim().split(/\s+/);
  const cmd   = (parts[1] || '').toLowerCase();

  if (cmd === 'h') { botActive = false; return '🔴 Bot stopped.'; }
  if (cmd === 'j') { botActive = true;  return '🟢 Bot started.'; }

  if (cmd === 'override') {
    const phone   = `whatsapp:+233${(parts[2] || '').replace(/^0/, '')}`;
    const message = parts.slice(3).join(' ');
    if (!message) return '❌ Usage: admin override 0244xxx Your message here';
    await sendMsg(phone, message);
    return `✅ Message sent to ${parts[2]}.`;
  }

  if (cmd === 'info') {
    const phone = `whatsapp:+233${(parts[2] || '').replace(/^0/, '')}`;
    const qty   = parseInt(parts[3]);
    const size  = (parts[4] || '').toUpperCase();
    if (!PRICES[size] || isNaN(qty)) return '❌ Usage: admin info 0244xxx 20 A4';
    const s = getSession(phone);
    addFile(s, { size, qty, isUnknown: false, isMoreOf: null }, 'admin', '');
    return `✅ Added ${qty} ${size} for ${parts[2]}.`;
  }

  if (cmd === 'ready') {
    const phone = `whatsapp:+233${(parts[2] || '').replace(/^0/, '')}`;
    const s     = sessions.get(phone);
    if (!s) return `❌ No session for ${parts[2]}.`;
    s.state = 'ready';
    clearTimers(phone);
    await sendMsg(phone,
      `✅ Your order is ready for pickup!\n\n📍 *Migo Print Shop*\nCircle branch, near Benz Gate,\ncloser to Calvary Church, Accra.\n\nThank you for choosing Migo! 🙏`
    );
    setTimer(phone, 'rating', 30 * 60 * 1000, async () => {
      if (!s.ratingAsked) {
        s.ratingAsked = true;
        await sendMsg(phone,
          `⭐ How was your experience at Migo Print Shop?\n\nReply with a number:\n5 — Excellent\n4 — Good\n3 — Okay\n2 — Poor\n1 — Very poor`
        );
      }
    });
    return `✅ Ready notification sent to ${parts[2]}.`;
  }

  if (cmd === 'status') {
    const phone = `whatsapp:+233${(parts[2] || '').replace(/^0/, '')}`;
    const s     = sessions.get(phone);
    if (!s) return `❌ No session for ${parts[2]}.`;
    return [
      `📊 *Status: ${parts[2]}*`,
      `State: ${s.state}`,
      `Files: ${JSON.stringify(s.files)}`,
      `Unknown: ${s.unknownFiles.length}`,
      `Pending images: ${s.pendingImages.length}`,
      `Total: GHS ${s.totalBill?.toFixed(2) || '—'}`,
      `Paid: GHS ${s.paymentReceived.toFixed(2)}`,
    ].join('\n');
  }

  if (cmd === 'jobs') {
    const out = [`📋 *ALL ACTIVE SESSIONS*`, ``];
    for (const [key, s] of sessions.entries()) {
      const ph = key.replace('whatsapp:+233', '0');
      out.push(`${ph} → ${s.state} | GHS ${s.totalBill?.toFixed(2) || '—'}`);
    }
    return out.length > 2 ? out.join('\n') : '📭 No active sessions.';
  }

  if (cmd === 'reset') {
    const phone = `whatsapp:+233${(parts[2] || '').replace(/^0/, '')}`;
    if (sessions.has(phone)) {
      clearTimers(phone);
      sessions.delete(phone);
      return `✅ Session reset for ${parts[2]}. They can start fresh.`;
    }
    return `❌ No session for ${parts[2]}.`;
  }

  if (cmd === 'resetall') {
    const count = sessions.size;
    for (const key of sessions.keys()) clearTimers(key);
    sessions.clear();
    return `✅ All ${count} sessions cleared.`;
  }

  return `❓ Commands: admin h | j | override | info | ready | status | jobs | reset | resetall`;
}

// ── Webhook ───────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const twiml    = new twilio.twiml.MessagingResponse();
  const from     = req.body.From                   || '';
  const body     = req.body.Body                   || '';
  const mediaUrl = req.body.MediaUrl0;
  const mediaType= req.body.MediaContentType0      || '';
  const filename = req.body.MediaFilename          || '';
  const isImage  = mediaType.startsWith('image/');

  console.log(`📩 Webhook from=${from} body="${body}" type=${mediaType || 'text'} file=${filename}`);

  try {
    const reply = await handleMessage(from, body, mediaUrl, mediaType, filename, isImage);
    if (reply) twiml.message(reply);
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }

  res.set('Content-Type', 'text/xml');
  res.send(twiml.toString());
});

// ── MoMo payment endpoint ─────────────────────────────────────
app.post('/momo', async (req, res) => {
  const { amount, phone } = req.body;
  console.log(`💰 MoMo: amount=${amount} phone=${phone}`);

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
    // Lock paid files away — never recalculated
    matched.confirmedFiles = [...matched.confirmedFiles, ...matched.files];
    matched.files          = [];
    matched.paymentReceived = 0;
    matched.totalBill      = null;
    matched.state          = 'processing';
    clearTimers(matchedKey);
    await sendMsg(matchedKey,
      `✅ *Payment Confirmed!*\n\nGHS ${paid.toFixed(2)} received. Thank you! 🙏\n\nYour order will be ready in *${readyTime(matched.a4eq || 0)}*.\n\nWe will notify you as soon as it is ready for pickup.`
    );
  } else {
    await sendMsg(matchedKey,
      `✅ GHS ${paid.toFixed(2)} received. Thank you!\n\n⚠️ *Balance remaining: GHS ${balance.toFixed(2)}*\n\nPlease send the balance to:\n🟡 MoMo: *0552719245*\n👤 *Kow Habib Baisie*`
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

app.get('/', (req, res) => res.json({
  status:   'running',
  version:  'v11',
  bot:      botActive ? 'active' : 'stopped',
  sessions: sessions.size,
  uptime:   process.uptime().toFixed(0) + 's',
}));

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 MIGO Print Bot v11 — port ${PORT}`);
  console.log(`   Twilio SID : ${ACCOUNT_SID   ? ACCOUNT_SID.slice(0,10)+'…' : 'NOT SET ❌'}`);
  console.log(`   Auth Token : ${AUTH_TOKEN    ? '✅ set' : 'NOT SET ❌'}`);
  console.log(`   Anthropic  : ${ANTHROPIC_KEY ? '✅ set' : 'NOT SET ❌'}`);
});
