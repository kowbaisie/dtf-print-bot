// ============================================================
// MIGO DTF PRINT SHOP — WhatsApp Order Management Bot
// Version : v34
// Date    : June 2026
// Owner   : Kow Habib Baisie — Migo Print Shop, Circle, Accra
// ============================================================
//
// VERSION HISTORY
//
// v29 (Jun 2026) — Bill sending hardened
//   • Replaced ━ box-drawing characters with plain dashes throughout
//     WasenderAPI was likely rejecting messages with Unicode box chars
//     causing bill to silently fail without error
//   • buildBill called BEFORE setTimeout so crash is caught
//     immediately and owner alerted — not lost silently
//   • If buildBill crashes, function aborts cleanly — customer
//     does not receive confusing partial messages
//
// v28 (Jun 2026) — Bill sending fixes
//   • Fix: sendBill wrapped in try/catch — bill failures now visible
//     instead of silently dropping the bill message
//   • Fix: *__COMPLETE__* → *COMPLETE* (WhatsApp renders underscores
//     as italic markers, breaking the bold formatting)
//
// v27 (Jun 2026) — Critical filename parsing fix
//   • Fix: handleImage now receives and uses filename for parsing
//     PNG/PDF files sent as documents with clear filenames
//     (e.g. "A2 13COPIES.png", "a3 - 4.png") now collected silently
//     instead of asking customer for size/qty they already provided
//
// v26 (Jun 2026) — Bug fixes
//   • Fix: FAQ delivery regex now catches "deliver" and "delivery"
//   • Fix: quickParse now handles space/underscore/parentheses
//     as size-qty separators (e.g. "A4 10", "A3 (5 copies)")
//
// v25 (Jun 2026) — Knowledge base & file agent
//   • admin learnbulk — paste any format, Claude parses Q&As
//   • /train dashboard page — paste or upload any text
//   • /api/train endpoint with Claude extraction
//   • /api/knowledge DELETE endpoint for dashboard
//   • Desktop file agent v2 — correct rename logic (A4 3.png)
//   • Two-phase agent: staging on download, hot folder on payment
//
// v24 (Jun 2026) — Bulk knowledge base
//   • admin learnbulk command (original Q:/A: version)
//   • learnbulk added to admin help output
//
// v23 (Jun 2026) — Scenario fixes
//   • S1:  Bill message → "Printing can *ONLY* start *AFTER* payment"
//   • S2:  PNG/PDF images — no background question asked
//   • S6:  Pressing tier rules hidden from customers and Claude prompt
//   • S6:  Pressing auto-confirm timeout reduced 90s → 60s
//   • S9:  Bot runs 24/7 — no closed-hours block
//   • S9:  Out-of-hours new orders → silent owner alert only
//   • S16: Sunday small order check moved to after payment confirmed
//   • S16: Owner alerted to decide — no message or refund to customer
//   • S21: Daily summary adds complaints, customer comments, delay reasons
//
// v22 (Jun 2026) — Receipt OCR fix
//   • Fix: extractReceiptFromImage replaced fetch() with https.get()
//   • Works on Node 16+ without native fetch (downloadBuffer helper)
//   • package.json engines: node >=18.0.0
//
// v21 (Jun 2026) — Three critical fixes
//   • Fix: Double message on image receive — handleImage() now
//     returns null; timer sends buildImageQuestion() only once
//   • Fix: cleanBody declared before testMode block (TDZ crash)
//     — test mode ReferenceError resolved
//   • Fix: Closed hours now answers FAQ questions then appends
//     closed notice (removed in v23 — bot now runs 24/7)
//
// v20 (Jun 2026) — Major feature release
//   • claude-opus-4-8 (most powerful model)
//   • Welcome message + name capture for new customers
//   • Duplicate file protection
//   • 3-day session auto-close on no payment
//   • Re-send bill on request
//   • Forwarded messages stripped
//   • Rating follow-up after 2 hours if ignored
//   • Pressing only asked if customer mentions it
//   • Natural ready-check detection (isReadyCheck)
//   • FAQ quick-match (location, prices, hours etc.)
//   • Queue position in payment confirmation
//   • Pickup code only sent when job is ready (not on payment)
//   • extractImageInstructions A4 default bug fixed
//   • Cash payment from dashboard (admin + worker)
//   • Dashboard bottom nav — 5 tabs professional layout
//
// v18–v19 (May 2026) — WasenderAPI migration
//   • WasenderAPI fully replaces Twilio
//   • Worker cash approval — any worker, no two-step
//   • Cash records: worker ID + name + timestamp
//   • Owner copy on every cash payment
//   • admin W01 bill — override bill total
//   • // prefix — simultaneous human+bot messaging
//   • Automated delay notification with reason
//   • Customer name capture
//   • Daily production report
//   • Confirmed payments API for desktop agent
//
// ============================================================

'use strict';

const express   = require('express');
const crypto    = require('crypto');
const https     = require('https');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── Config ────────────────────────────────────────────────────
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const ADMIN_PIN      = process.env.ADMIN_PIN      || '1914';
const ADMIN_DASH_PW  = process.env.ADMIN_DASHBOARD_PASSWORD || '1914';
const WASENDER_KEY   = process.env.WASENDER_API_KEY;
const WASENDER_SID   = process.env.WASENDER_SESSION || 'Migo Print Bot';
const WEBHOOK_SECRET = process.env.WASENDER_WEBHOOK_SECRET;
const DESKTOP_KEY    = process.env.DESKTOP_AGENT_KEY || 'migo-agent-2025';

// Phone numbers — stored as plain digits for WasenderAPI
const OWNER_NUMBER = process.env.OWNER_PHONE || '233272006161'; // 0272006161
const SHOP_NUMBER  = '233552719245';                             // 0552719245

// WasenderAPI base URL (used in all API calls below)
const WA_API_SEND = 'https://www.wasenderapi.com/api/send-message';

// ── Pricing ───────────────────────────────────────────────────
const PRICES = { A4: 3.20, A3: 6.40, A2: 16.00 };
const A4_EQ  = { A4: 1,    A3: 2,    A2: 4     };

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ── Model — most powerful available ──────────────────────────
const MODEL = 'claude-opus-4-8';

const BOT_VERSION = 'v34';
const BOT_START   = Date.now();

// ── Shop hours ────────────────────────────────────────────────
function shopStatus() {
  const now = new Date().toLocaleString('en-US', { timeZone: 'Africa/Accra' });
  const d   = new Date(now);
  const hr  = d.getHours();
  const day = d.getDay(); // 0=Sun
  const open = hr >= 7 && hr < 22; // 7am–10pm
  return { open, isSunday: day === 0, hour: hr };
}

// ── Greeting detector ────────────────────────────────────────
// Any greeting → mirror it + "Please send your DTF files."
function isGreeting(msg) {
  return /^\s*(hi+|hello+|hey+|good\s*(morning|afternoon|evening|night|day)|howdy|greetings|sup|what'?s up|yo\b|hy|helo|holla|morning|afternoon|evening|night|how are you|how r u)\b/i.test((msg||'').trim());
}
function greetingReply(msg) {
  // Mirror the greeting back naturally
  const m = (msg||'').trim();
  if (/good\s*morning/i.test(m)) return `Good morning! Please send your DTF files. 🖨️`;
  if (/good\s*afternoon/i.test(m)) return `Good afternoon! Please send your DTF files. 🖨️`;
  if (/good\s*evening/i.test(m)) return `Good evening! Please send your DTF files. 🖨️`;
  if (/good\s*night/i.test(m)) return `Good night! Please send your DTF files. 🖨️`;
  if (/good\s*day/i.test(m)) return `Good day! Please send your DTF files. 🖨️`;
  return `Hi! Please send your DTF files. 🖨️`;
}
const FAQ = [
  { p: /where.*(you|shop|locate|find|address|located)/i,
    a: `📍 We're at Circle branch, near Benz Gate, closer to Calvary Church, Accra.` },
  { p: /how much.*(a4|a3|a2)|price.*(a4|a3|a2)|(a4|a3|a2).*(price|cost|how much)/i,
    a: `🖨 *Printing prices:*\nA4 — GHS 3.20\nA3 — GHS 6.40\nA2 — GHS 16.00` },
  { p: /how much.*press|press.*price|press.*cost|cost.*press/i,
    a: `👕 *Pressing:* Please send your files and let us know you need pressing — we'll calculate the cost for you.` },
  { p: /what.*time|when.*open|opening.*hour|close.*time|hours/i,
    a: `🕐 Our standard hours are *7am – 10pm*, Monday to Sunday. Feel free to send your files anytime!` },
  { p: /sunday|tomorrow.*(sun)/i,
    a: `📅 Yes, we're open on Sundays! Send your files anytime.` },
  { p: /momo|mobile money|number.*pay|pay.*number/i,
    a: `🟡 *MTN MoMo:* 0552719245 · Kow Habib Baisie` },
  { p: /instagram|facebook|social|ig\b/i,
    a: `We're on Instagram — search *Migo Print Shop Accra*. 🙏` },
  { p: /sublim|embroid|screen.?print/i,
    a: `We specialise in *DTF printing and pressing* only. We do not offer sublimation, embroidery or screen printing.` },
  { p: /deliver(y)?|dispatch|rider|send.*my guy/i,
    a: `We don't offer delivery at the moment. Orders must be collected from the shop. Your pickup code is required for collection.` },
  { p: /thank|thanks|thank you|merci/i,
    a: `You're welcome! 🙏 Let us know if you need anything else.` },
];

function tryFAQ(msg) {
  for (const f of FAQ) if (f.p.test(msg)) return f.a;
  return null;
}

// ── Natural "is my job ready?" detector ──────────────────────
function isReadyCheck(msg) {
  const m = (msg || '').toLowerCase();
  // Explicit collection phrases
  if (/\b(can i (come|collect|send|pick)|my delivery|send.*guy|my rider|come now|come collect|come pick)\b/.test(m)) return true;
  // Job status questions
  if (/\b(is it|is my|are you|have you|when will|how long)\b/.test(m)
    && /\b(ready|done|finish|complet|printed|print)\b/.test(m)) return true;
  // "My job/order ready?" style
  if (/\b(my (order|job|file|design)|the order|the job)\b/.test(m)
    && /\b(ready|done|complet|finish)\b/.test(m)) return true;
  // "Have you finished?" / "Finished?" standalone
  if (/\b(have you (finish|done|complet)|you (finish|done)|finish(ed)?\s*\?)/i.test(m)) return true;
  return false;
}

// ── Strip WhatsApp forwarded prefix ──────────────────────────
function stripForwarded(body) {
  return (body || '').replace(/^(\[?forwarded\]?|_forwarded_|fwd:)\s*/i, '').trim();
}



// ── Global state ──────────────────────────────────────────────
const sessions     = new Map();
const timers       = new Map();
let   botActive    = true;
let   botCrashed   = false;
let   testMode     = false; // when true, only OWNER_PHONE receives replies

const paymentLedger = [];
const ratingsLog    = [];
const auditLog      = [];
const messageLog    = new Map();
const knowledgeBase = [];
const correctionLog = [];
const jobArchive    = [];
const pendingFiles  = [];
const downloadedIds = new Set();

// Worker registry: workerId → {name, pin, addedAt, addedBy}
// Confirmed payments queue for desktop agent
const confirmedPayments = [];
const confirmedPaymentAcked = new Set();
// Overdue flow: phone → { step, jobId, newTime, attempt }
const overdueFlow = new Map();
const workers    = new Map();
const pinLockout = new Map();

// ── Rate limiter ──────────────────────────────────────────────
let msgCount = 0;
let msgWindowStart = Date.now();
const MSG_LIMIT  = 20;
const MSG_WINDOW = 60000;

// ── Job ID counter ────────────────────────────────────────────
const JOB_BASE = Math.floor((Date.now() / 1000) % 8000) + 1000;
const jobCounters = { M: JOB_BASE, A: JOB_BASE, N: JOB_BASE, E: JOB_BASE };

// ── Helpers ───────────────────────────────────────────────────
function todayStr() {
  return new Date().toLocaleDateString('en-GH', { timeZone: 'Africa/Accra' });
}
function nowStr() {
  return new Date().toLocaleString('en-GH', {
    timeZone: 'Africa/Accra', hour12: true,
    day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });
}

// Convert any phone format to WasenderAPI format: 233XXXXXXXXX@s.whatsapp.net
function toWaId(phone) {
  const d = (phone || '').replace(/\D/g, '');
  const num = d.startsWith('233') ? d
    : d.startsWith('0') ? '233' + d.slice(1)
    : d.length === 9    ? '233' + d
    : d;
  return num + '@s.whatsapp.net';
}

// Extract plain digits from WaId
function fromWaId(waId) {
  return (waId || '').replace('@s.whatsapp.net', '').replace('@c.us', '');
}

// Display as local Ghana number
function displayPhone(waId) {
  const d = fromWaId(waId).replace(/\D/g, '');
  return d.startsWith('233') ? '0' + d.slice(3) : d;
}

function last4(phone) {
  return (phone || '').replace(/\D/g, '').slice(-4);
}

function findByLast4(digits) {
  const d = (digits || '').replace(/\D/g, '').slice(-4);
  for (const [key, s] of sessions.entries()) {
    if (key.replace(/\D/g, '').slice(-4) === d) return { key, session: s };
  }
  return null;
}

function generateJobId(phone) {
  const hour = parseInt(new Date().toLocaleString('en-GH', {
    timeZone: 'Africa/Accra', hour: '2-digit', hour12: false }));
  const p = hour>=6&&hour<12?'M':hour>=12&&hour<18?'A':hour>=18?'N':'E';
  jobCounters[p]++;
  return `MGO-${last4(phone)}-${p}${jobCounters[p]}`;
}

function dailyPayments() { return paymentLedger.filter(p => p.date === todayStr()); }

// ── Audit ─────────────────────────────────────────────────────
function audit(action, phone, detail, flag = false, workerId = null) {
  const wn = workerId ? (workers.get(workerId)?.name || workerId) : '—';
  auditLog.unshift({
    ts: nowStr(), date: todayStr(), action,
    phone: phone ? displayPhone(phone) : '—',
    workerId: workerId || '—', workerName: wn,
    detail, flag,
  });
  if (auditLog.length > 500) auditLog.splice(500);
  if (flag) console.warn(`🚩 ${action} | ${phone} | ${detail}`);
}

function logMsg(phone, dir, body) {
  if (!messageLog.has(phone)) messageLog.set(phone, []);
  const log = messageLog.get(phone);
  log.push({ ts: Date.now(), dir, body: (body || '').slice(0, 200) });
  if (log.length > 100) log.splice(0, log.length - 100);
}

// ── WasenderAPI send message ──────────────────────────────────
async function sendMsg(to, body) {
  // Rate limit
  const now = Date.now();
  if (now - msgWindowStart > MSG_WINDOW) { msgCount = 0; msgWindowStart = now; }
  if (msgCount >= MSG_LIMIT) {
    const wait = MSG_WINDOW - (now - msgWindowStart) + 1000;
    await new Promise(r => setTimeout(r, wait));
    msgCount = 0; msgWindowStart = Date.now();
  }
  msgCount++;

  // Human-like delay 800ms–2000ms
  await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));

  const waId = to.includes('@') ? to : toWaId(to);
  logMsg(waId, 'out', body);

  // WasenderAPI correct endpoint and payload format (confirmed by support)
  // WasenderAPI send-message needs plain phone number (no @s.whatsapp.net)
  const toPhone = waId.replace('@s.whatsapp.net', '').replace('@c.us', '');
  const payload = JSON.stringify({ to: toPhone, text: body });

  return new Promise((resolve) => {
    const options = {
      hostname: 'www.wasenderapi.com',
      path:     '/api/send-message',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Authorization':  `Bearer ${WASENDER_KEY}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          console.log(`✅ WA sent to ${displayPhone(waId)}: "${body.slice(0, 50)}"`);
        } else {
          console.error(`❌ WA error ${res.statusCode}: ${data.slice(0, 100)}`);
          if (waId !== toWaId(OWNER_NUMBER)) {
            alertOwner(`⚠️ Message send failed to ${displayPhone(waId)}: HTTP ${res.statusCode}`).catch(() => {});
          }
        }
        resolve();
      });
    });
    req.on('error', (err) => {
      console.error(`❌ WA network error:`, err.message);
      resolve();
    });
    req.setTimeout(15000, () => { req.destroy(); resolve(); });
    req.write(payload);
    req.end();
  });
}

async function alertOwner(body) {
  const waId = toWaId(OWNER_NUMBER);
  logMsg(waId, 'out', body);
  // WasenderAPI send-message needs plain phone number (no @s.whatsapp.net)
  const toPhone = waId.replace('@s.whatsapp.net', '').replace('@c.us', '');
  const payload = JSON.stringify({ to: toPhone, text: body });
  return new Promise((resolve) => {
    const opts = {
      hostname: 'www.wasenderapi.com',
      path:     '/api/send-message',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Authorization':  `Bearer ${WASENDER_KEY}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(opts, (res) => { res.resume(); resolve(); });
    req.on('error', () => resolve());
    req.setTimeout(10000, () => { req.destroy(); resolve(); });
    req.write(payload);
    req.end();
  });
}

// ── Claude — all calls use MODEL ──────────────────────────────
async function askClaude(messages, system, maxTokens = 400, timeoutMs = 10000) {
  const opts = { model: MODEL, max_tokens: maxTokens, messages };
  if (system) opts.system = system;
  return Promise.race([
    anthropic.messages.create(opts),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Claude timeout')), timeoutMs)),
  ]);
}

// ── Knowledge base system prompt ─────────────────────────────
function buildShopSystem(session) {
  const kb = knowledgeBase.length > 0
    ? `\n\nADDITIONAL SHOP INFORMATION:\n${knowledgeBase.map((f,i)=>`${i+1}. ${f}`).join('\n')}`
    : '';
  const nameNote = session?.customerName
    ? `\nThe customer's name is ${session.customerName}. Use their name naturally in responses.`
    : '';
  return `You are a professional and helpful customer service representative for Migo Print Shop.

Shop: Circle branch, near Benz Gate, closer to Calvary Church, Accra, Ghana. DTF printing only.
Services:
- DTF Sheet Printing: A4=GHS 3.20, A3=GHS 6.40, A2=GHS 16.00 per sheet
- DTF Shirt Pressing: pricing calculated per order based on number of shirts, impression type, and artwork size. Do not quote specific rates — just say we'll calculate it for them.
Payment: MTN MoMo 0552719245 (Kow Habib Baisie) or cash at shop.
Hours: Standard hours Mon–Sun 7am–10pm. Orders accepted anytime — send files whenever convenient.
Style: Clear British English. Warm, professional. 1–4 sentences. Never reveal you are AI.${nameNote}
If you genuinely cannot answer: say "Let me get someone to assist you shortly." and nothing else.
You have full context of this customer's order in the conversation history.${kb}`;
}

function addToHistory(s, role, content) {
  s.chatHistory.push({ role, content });
  if (s.chatHistory.length > 40) s.chatHistory = s.chatHistory.slice(-40);
}

async function replyWithClaude(msg, session) {
  addToHistory(session, 'user', msg);
  try {
    const r = await askClaude(session.chatHistory, buildShopSystem(session), 400, 10000);
    const reply = r.content.map(c => c.text || '').join('').trim();
    if (reply) addToHistory(session, 'assistant', reply);

    // Customer name capture — try to extract name from conversation
    if (!session.customerName && session.chatHistory.length >= 2) {
      try {
        const nameR = await askClaude([{ role: 'user', content:
          `From this conversation snippet: ${JSON.stringify(session.chatHistory.slice(-4))}\n`+
          `Did the customer mention their name? Return ONLY valid JSON: {"name":"Kofi"} or {"name":null}` }],
          null, 50, 3000);
        const parsed = JSON.parse(nameR.content.map(c=>c.text||'').join('').trim().replace(/```json|```/g,''));
        if (parsed?.name && parsed.name.length > 1) {
          session.customerName = parsed.name;
          audit('NAME_CAPTURED', session.phone, parsed.name);
        }
      } catch(e) { /* silent fail */ }
    }

    if (reply && reply.toLowerCase().includes('let me get someone to assist')) {
      await alertOwner([
        `❓ *BOT CANNOT ANSWER*`,
        `📱 Customer: ${displayPhone(session.phone)}`,
        `💬 Question: "${msg.slice(0, 100)}"`,
        ``,
        `Use: admin W01 override ${last4(session.phone)} Your reply`,
        `Or: admin W01 pause ${last4(session.phone)} to take over`,
      ].join('\n'));
    }
    return reply || null;
  } catch (e) {
    console.error('Claude error:', e.message);
    return null;
  }
}

// ── Session ───────────────────────────────────────────────────
function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      phone, state: 'idle',
      files: [], confirmedFiles: [], unknownFiles: [],
      pendingImages: [], chatHistory: [],
      totalBill: null, a4eq: 0,
      paymentReceived: 0, jobId: null,
      readyTime: null, overdueReminders: 0,
      ratingAsked: false, ratingGiven: false, lastActivity: Date.now(),
      pendingTxId: null, pendingTxAmount: null,
      awaitingTxId: false, confirmedTxId: null,
      paused: false, servedBy: null,
      customerName: null,
      pressing: null,
      askedPressing: false,
      isFirstTime: true,      // true until name captured
      pressingMentioned: false, // true if customer mentions pressing
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

// ── Ready time ────────────────────────────────────────────────
function getReadyHours(a4eq) {
  if (a4eq <= 50)  return 3;
  if (a4eq <= 100) return 4;
  if (a4eq <= 200) return 5;
  if (a4eq <= 400) return 7;
  if (a4eq <= 800) return 9;
  return null; // next day 12pm
}
function readyTimeText(a4eq) {
  const h = getReadyHours(a4eq);
  if (!h) {
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(12, 0, 0, 0);
    return d.toLocaleString('en-GH', { timeZone: 'Africa/Accra', hour12: true, weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }
  return new Date(Date.now() + h * 3600000).toLocaleString('en-GH', {
    timeZone: 'Africa/Accra', hour12: true, hour: '2-digit', minute: '2-digit' });
}

// ── Receipt HTML (thermal 80mm + A4 copy) ─────────────────────
function buildReceiptHTML(payment) {
  const {
    jobId, phone, amount, type, confirmedBy, workerName,
    workerId, ts, files, balance, txId
  } = payment;
  const filesStr = (files || []).map(f => `${f.qty}×${f.size}`).join(', ') || '—';
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Receipt ${jobId}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }

  /* Thermal receipt — default */
  @media screen, print {
    body.thermal {
      font-family: 'Courier New', monospace;
      font-size: 12px;
      width: 80mm;
      margin: 0 auto;
      padding: 4mm;
      background: #fff;
      color: #000;
    }
    body.thermal .a4-only { display: none; }
    body.thermal .divider { border-top: 1px dashed #000; margin: 4px 0; }
    body.thermal .center  { text-align: center; }
    body.thermal .bold    { font-weight: bold; }
    body.thermal .large   { font-size: 16px; font-weight: bold; }
    body.thermal .xlarge  { font-size: 20px; font-weight: bold; letter-spacing: 2px; }
    body.thermal .row     { display: flex; justify-content: space-between; margin: 2px 0; }
    body.thermal .logo    { font-size: 18px; font-weight: 800; text-align: center; margin: 4px 0; }
  }

  /* A4 copy */
  @media screen {
    body.a4 {
      font-family: Arial, sans-serif;
      font-size: 13px;
      max-width: 500px;
      margin: 20px auto;
      padding: 20px;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      background: #fff;
    }
    body.a4 .thermal-only { display: none; }
  }
  @media print {
    body.a4 {
      font-family: Arial, sans-serif;
      font-size: 12pt;
      margin: 10mm;
    }
    body.a4 .thermal-only { display: none; }
    body.a4 .no-print { display: none; }
  }

  /* Buttons */
  .btn-row { display: flex; gap: 10px; margin-top: 16px; justify-content: center; }
  .btn { padding: 10px 20px; border: none; border-radius: 8px; font-size: 14px;
         font-weight: 700; cursor: pointer; font-family: inherit; }
  .btn-print   { background: #3b82f6; color: #fff; }
  .btn-a4      { background: #10b981; color: #fff; }
  .btn-close   { background: #e2e8f0; color: #334155; }
  @media print { .btn-row { display: none; } }
</style>
</head>
<body class="thermal" id="receiptBody">

<!-- THERMAL LAYOUT -->
<div class="logo">🧾 MIGO PRINT</div>
<div class="center" style="font-size:10px">Circle · Near Benz Gate · Accra</div>
<div class="center" style="font-size:10px">0552719245</div>
<div class="divider"></div>
<div class="center bold">${type === 'cash' ? 'CASH PAYMENT RECEIPT' : 'MOMO PAYMENT RECEIPT'}</div>
<div class="divider"></div>
<div class="row"><span>Date:</span><span>${ts}</span></div>
<div class="row"><span>Customer:</span><span>...${last4(phone)}</span></div>
<div class="row"><span>Files:</span><span>${filesStr}</span></div>
<div class="divider"></div>
<div class="row large"><span>TOTAL PAID:</span><span>GHS ${parseFloat(amount).toFixed(2)}</span></div>
${balance > 0 ? `<div class="row" style="color:#ef4444"><span>BALANCE:</span><span>GHS ${parseFloat(balance).toFixed(2)}</span></div>` : '<div class="row" style="color:green"><span>STATUS:</span><span>FULLY PAID</span></div>'}
<div class="divider"></div>
<div class="row"><span>Method:</span><span>${type === 'cash' ? 'Cash' : 'MTN MoMo'}</span></div>
${txId ? `<div class="row"><span>TxID:</span><span style="font-size:9px">${txId}</span></div>` : ''}
${workerName ? `<div class="row"><span>Served by:</span><span>${workerName}</span></div>` : ''}
<div class="divider"></div>
<div class="center xlarge">${jobId}</div>
<div class="center" style="font-size:9px">Show this ID when collecting your order</div>
<div class="divider"></div>
<div class="center" style="font-size:9px">Thank you for choosing Migo Print Shop!</div>
<div class="center" style="font-size:9px">Quality DTF Printing in Accra</div>
<br>

<!-- PRINT BUTTONS -->
<div class="btn-row no-print">
  <button class="btn btn-print" onclick="printThermal()">🖨️ Thermal Print</button>
  <button class="btn btn-a4" onclick="printA4()">📄 A4 Copy</button>
  <button class="btn btn-close" onclick="window.close()">✕ Close</button>
</div>

<script>
function printThermal() {
  document.getElementById('receiptBody').className = 'thermal';
  window.print();
}
function printA4() {
  document.getElementById('receiptBody').className = 'a4';
  // Rebuild for A4
  document.body.innerHTML = \`
  <div style="font-family:Arial;max-width:500px;margin:20px auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px">
    <div style="text-align:center;margin-bottom:20px">
      <div style="font-size:32px">🧾</div>
      <div style="font-size:22px;font-weight:800">MIGO PRINT SHOP</div>
      <div style="color:#64748b;font-size:12px">Circle, Near Benz Gate, Accra · 0552719245</div>
    </div>
    <hr style="border-color:#e2e8f0;margin-bottom:16px">
    <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">Payment Receipt</div>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr><td style="padding:6px 0;color:#64748b">Date</td><td style="text-align:right">${ts}</td></tr>
      <tr><td style="padding:6px 0;color:#64748b">Customer</td><td style="text-align:right">...${last4(phone)}</td></tr>
      <tr><td style="padding:6px 0;color:#64748b">Files</td><td style="text-align:right">${filesStr}</td></tr>
      <tr><td style="padding:6px 0;color:#64748b">Payment Method</td><td style="text-align:right">${type === 'cash' ? 'Cash' : 'MTN MoMo'}</td></tr>
      ${txId ? `<tr><td style="padding:6px 0;color:#64748b">Transaction ID</td><td style="text-align:right;font-family:monospace;font-size:11px">${txId}</td></tr>` : ''}
      ${workerName ? `<tr><td style="padding:6px 0;color:#64748b">Served by</td><td style="text-align:right">${workerName} (${workerId})</td></tr>` : ''}
    </table>
    <hr style="border-color:#e2e8f0;margin:16px 0">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <span style="font-size:16px;font-weight:700">Amount Paid</span>
      <span style="font-size:22px;font-weight:800;color:#10b981">GHS ${parseFloat(amount).toFixed(2)}</span>
    </div>
    ${balance > 0
      ? `<div style="display:flex;justify-content:space-between;color:#ef4444;margin-top:6px"><span>Balance Remaining</span><span style="font-weight:700">GHS ${parseFloat(balance).toFixed(2)}</span></div>`
      : `<div style="color:#10b981;text-align:right;margin-top:4px;font-size:12px">✅ Fully Paid</div>`
    }
    <hr style="border-color:#e2e8f0;margin:16px 0">
    <div style="text-align:center;margin-bottom:8px">
      <div style="font-size:11px;color:#64748b;margin-bottom:4px">JOB ID — Show when collecting</div>
      <div style="font-size:28px;font-weight:900;letter-spacing:4px;font-family:monospace">${jobId}</div>
    </div>
    <hr style="border-color:#e2e8f0;margin:16px 0">
    <div style="text-align:center;font-size:11px;color:#64748b">Thank you for choosing Migo Print Shop! 🙏</div>
  </div>\`;
  window.print();
}
</script>
</body>
</html>`;
}

// ── Payment processor ─────────────────────────────────────────
async function processPayment(phone, amount, type, confirmedBy = 'auto', workerId = null, exactBalance = null) {
  if (botCrashed) {
    await alertOwner(`🔴 Payment attempted while bot crashed. Manual intervention for ${displayPhone(phone)}.`);
    return { status: 'error', message: 'Bot in crash state' };
  }

  let paid, balance;
  try {
    paid = parseFloat(amount) || 0;
    if (!paid) return { status: 'ignored' };

    const tail = (phone || '').replace(/\D/g, '').slice(-9);
    let matched = null, matchedKey = null;
    for (const [key, s] of sessions.entries()) {
      if (key.replace(/\D/g, '').slice(-9) === tail) { matched = s; matchedKey = key; break; }
    }
    if (!matched) return { status: 'no_match', message: 'No active session' };

    const workerName = workerId ? (workers.get(workerId)?.name || workerId) : null;

    if (type === 'cash') {
      const expectedTotal = matched.totalBill || 0;
      if (paid > expectedTotal + 0.01) {
        audit('SUSPICIOUS_CASH', matchedKey,
          `Cash GHS ${paid.toFixed(2)} > order GHS ${expectedTotal.toFixed(2)} — ${workerName || confirmedBy}`,
          true, workerId);
      }
      // Alert owner of every cash payment
      await alertOwner([
        `💵 *CASH PAYMENT RECORDED*`, ``,
        `📱 Customer: ${displayPhone(matchedKey)}`,
        `💰 Amount:   GHS ${paid.toFixed(2)}`,
        `🔖 Job ID:   ${matched.jobId || 'pending'}`,
        `👤 Worker:   ${workerName || confirmedBy} (${workerId || '—'})`,
        `🕐 Time:     ${nowStr()}`,
      ].join('\n'));
      audit('CASH_PAYMENT', matchedKey, `GHS ${paid.toFixed(2)} — ${workerName || confirmedBy}`, false, workerId);
    } else {
      audit('MOMO_PAYMENT', matchedKey, `GHS ${paid.toFixed(2)} — ${confirmedBy}`, false, workerId);
    }

    matched.paymentReceived += paid;
    balance = exactBalance !== null ? exactBalance
      : Math.max(0, (matched.totalBill || 0) - matched.paymentReceived);

    const ledgerEntry = {
      ts: nowStr(), date: todayStr(),
      phone: displayPhone(matchedKey),
      jobId: matched.jobId || '—',
      amount: paid, type, balance,
      confirmedBy: workerId
        ? `${workers.get(workerId)?.name || workerId} (${workerId})`
        : confirmedBy,
      workerId: workerId || null,
      workerName: workerName || null,
      txId: matched.confirmedTxId || null,
      files: [...(matched.confirmedFiles || []), ...(matched.files || [])],
    };
    paymentLedger.push(ledgerEntry);

    if ((matched.totalBill || 0) - matched.paymentReceived <= 0.01) {
      const overpaid = matched.paymentReceived - (matched.totalBill || 0);

      matched.confirmedFiles = [...matched.confirmedFiles, ...matched.files];
      matched.files = []; matched.paymentReceived = 0; matched.totalBill = null;
      matched.state = 'processing';
      const jobId = generateJobId(matchedKey);
      matched.jobId = jobId;
      matched.readyTime = new Date(Date.now() + (getReadyHours(matched.a4eq || 0) || 24) * 3600000);
      matched.overdueReminders = 0;
      clearTimers(matchedKey);
      ledgerEntry.jobId = jobId;
      const readyAt = readyTimeText(matched.a4eq || 0);

      addToHistory(matched, 'assistant',
        `Payment confirmed via ${type}. Job ID: ${jobId}. Ready by ${readyAt}.${overpaid > 0.01 ? ` GHS ${overpaid.toFixed(2)} overpaid.` : ''}`);

      const workerLine = (type === 'cash' && workerName)
        ? `\n👤 Served by: *${workerName}* at Migo Print Shop` : '';

      // Queue position — count jobs already processing before this one
      const jobsAhead = [...sessions.values()].filter(s => s.state === 'processing' && s.jobId && s.jobId !== jobId).length;
      const queueLine = jobsAhead === 0
        ? `\n📋 *You're next in queue!* 🎉`
        : `\n📋 *Queue position: ${jobsAhead + 1}* (${jobsAhead} job${jobsAhead !== 1 ? 's' : ''} ahead of you)`;

      await sendMsg(matchedKey, [
        `✅ *Payment Confirmed!*${type === 'cash' ? ' _(Cash)_' : ''}`, ``,
        `GHS ${paid.toFixed(2)} received. Thank you! 🙏`,
        workerLine,
        overpaid > 0.01 ? `\n⚠️ GHS ${overpaid.toFixed(2)} overpaid — collect change at pickup.` : ``,
        queueLine,
        ``,
        `⏱ *ESTIMATED READY TIME*`,
        ``,
        `   *${readyAt}*`,
        ``,
        `We will notify you as soon as it is ready.`,
        `Your *Pickup Code* will be sent to you when your order is ready. 🙏`,
      ].filter(l => l !== null && l !== undefined).join('\n'));

      scheduleWorkerReminders(matchedKey, matched, jobId);

      // S16: Sunday small order — alert owner to decide, no message to customer
      const { isSunday } = shopStatus();
      if (isSunday && (matched.a4eq || 0) < 200) {
        alertOwner([
          `📅 *SUNDAY SMALL ORDER — PAYMENT RECEIVED*`,
          ``,
          `📱 Customer: ${displayPhone(matchedKey)}`,
          `🔖 Job ID:   ${jobId}`,
          `💰 Amount:   GHS ${paid.toFixed(2)}`,
          `🖨 Size:     ${matched.a4eq} A4-equivalent sheets`,
          ``,
          `This is below the 200-sheet Sunday minimum.`,
          `Please decide: process now or defer to Monday.`,
          `Use: admin W01 override ${last4(matchedKey)} [your message]`,
        ].join('\n')).catch(() => {});
      }

      // Queue for desktop agent to move files to hot folder after payment
      confirmedPayments.push({
        id:    crypto.randomBytes(8).toString('hex'),
        phone: matchedKey,
        jobId, ts: new Date().toISOString(),
        acknowledged: false,
      });

      return { status: 'confirmed', jobId, readyBy: readyAt, ledgerEntry };
    } else {
      const remaining = (matched.totalBill || 0) - matched.paymentReceived;
      await sendMsg(matchedKey, [
        `✅ GHS ${paid.toFixed(2)} received${type === 'cash' ? ' _(cash)_' : ''}. Thank you!`, ``,
        `⚠️ *Balance remaining: GHS ${remaining.toFixed(2)}*`, ``,
        `Please send the balance to:`,
        `🟡 MoMo: *0552719245*`, `👤 *Kow Habib Baisie*`,
      ].join('\n'));
      return { status: 'partial', paid, balance: Math.max(0, remaining), ledgerEntry };
    }
  } catch (err) {
    console.error('💥 PAYMENT CRASH:', err.message);
    botCrashed = true; botActive = false;
    await alertOwner([
      `🔴 *BOT PAYMENT CRASH*`, ``,
      `Error: ${err.message}`,
      `Customer: ${displayPhone(phone)}`,
      `Amount: GHS ${amount}`, ``,
      `⚠️ Bot stopped to prevent financial errors.`,
      `Type: admin restart to resume.`,
    ].join('\n'));
    audit('PAYMENT_CRASH', phone, err.message, true);
    return { status: 'error', message: err.message };
  }
}

// ── MoMo SMS parser ───────────────────────────────────────────
function parseMomoSMS(text) {
  const t = text || '';
  const amtMatch  = t.match(/GHS\s*([\d,]+\.?\d*)/i);
  const amount    = amtMatch ? parseFloat(amtMatch[1].replace(',', '')) : null;
  const txMatch   = t.match(/Transaction\s*I[Dd][:\s#]*(\d{6,})/i)
                 || t.match(/TxnI[Dd][:\s#]*(\d{6,})/i)
                 || t.match(/\bID[:\s]+(\d{8,})/i);
  const txId      = txMatch ? txMatch[1].trim() : null;
  const refMatch  = t.match(/(?:Reference|Ref)[:\s]+([^\s.\n,]+)/i);
  const reference = refMatch ? refMatch[1].trim() : null;
  const nameMatch = t.match(/from\s+([A-Z][A-Z\s]+?)(?=\.\s|\s+Current|\s+Balance|\s+Ref|\s+Trans|\s+TxnI|\s+Transaction|\n|$)/i);
  const senderName= nameMatch ? nameMatch[1].trim() : null;
  return { amount, txId, reference, senderName };
}

// ── Smart payment matcher ─────────────────────────────────────
function smartMatchPayment(amount, txId, reference) {
  if (txId) {
    for (const [key, s] of sessions.entries())
      if (s.pendingTxId === txId) return { match: 'txid', key, session: s };
  }
  const candidates = [];
  for (const [key, s] of sessions.entries()) {
    if (s.state !== 'awaiting_payment') continue;
    const balance = Math.max(0, (s.totalBill || 0) - s.paymentReceived);
    // Match full payments, overpayments (up to 1.5x), AND partial payments
    if (amount > 0 && amount <= balance * 1.5 + 0.01)
      candidates.push({ key, session: s, balance });
  }
  if (candidates.length === 0) return { match: 'none' };
  if (candidates.length === 1) return { match: 'amount', ...candidates[0] };
  const ref = (reference || '').replace(/[\s\-]/g, '').toUpperCase();
  if (ref && ref !== '0') {
    for (const { key, session: s, balance } of candidates) {
      const p4 = key.replace(/\D/g, '').slice(-4);
      const p9 = key.replace(/\D/g, '').slice(-9);
      const jc = (s.jobId || '').replace(/[\s\-]/g, '').toUpperCase();
      if (ref.includes(p4)||ref.includes(p9)||ref===jc||jc.includes(ref)||(ref.length>=4&&jc.includes(ref)))
        return { match: 'reference', key, session: s, balance };
    }
  }
  return { match: 'ambiguous', candidates };
}

// ── MoMo event handler ────────────────────────────────────────
async function handleMomoEvent(parsed, source) {
  const { amount, txId, reference, senderName } = parsed;
  if (!amount || amount <= 0) return { status: 'ignored', reason: 'no amount' };
  audit('MOMO_RECEIVED', 'sms', `GHS ${amount} | TxID:${txId||'—'} | Ref:${reference||'—'} | From:${senderName||'—'}`);
  const result = smartMatchPayment(amount, txId, reference);

  if (result.match === 'none') {
    await alertOwner([
      `🔔 *UNMATCHED MOMO*`, ``,
      `💰 GHS ${amount.toFixed(2)}`,
      `👤 ${senderName || '—'}`,
      `🔖 Ref: ${reference || '—'}`,
      `🧾 TxID: ${txId || '—'}`, ``,
      `No active order matched.`,
      `Confirm manually: admin W01 cash <last4> ${amount.toFixed(2)}`,
    ].join('\n'));
    audit('MOMO_UNMATCHED', 'sms', `GHS ${amount} from ${senderName || '—'}`, true);
    return { status: 'no_match' };
  }

  if (result.match === 'ambiguous') {
    const list = result.candidates.map((c, i) =>
      `${i+1}. ...${last4(c.key)} | Job:${c.session.jobId||'—'} | GHS ${c.session.totalBill?.toFixed(2)||'—'}`
    ).join('\n');
    await alertOwner([
      `⚠️ *AMBIGUOUS MOMO*`, ``,
      `💰 GHS ${amount.toFixed(2)}`,
      `👤 ${senderName || '—'}`,
      `🔖 Ref: ${reference || '—'}`, ``,
      `${result.candidates.length} matches:`, list, ``,
      `Customers asked for TxID.`,
    ].join('\n'));
    for (const { key, session: s } of result.candidates) {
      s.awaitingTxId = true;
      await sendMsg(key, [
        `We received GHS ${amount.toFixed(2)} but could not link it to your order.`, ``,
        `Please reply with your *Transaction ID* from your MoMo receipt.`,
        `_Example: "My TxID is 82052935078"_`,
      ].join('\n'));
    }
    audit('MOMO_AMBIGUOUS', 'sms', `GHS ${amount} — ${result.candidates.length} candidates`, true);
    return { status: 'ambiguous' };
  }

  const { key, session: s } = result;
  if (txId) s.confirmedTxId = txId;
  return processPayment(key, amount, 'momo', `auto-${result.match}${txId ? ` TxID:${txId}` : ''}`);
}

// ── Receipt OCR ───────────────────────────────────────────────
// Uses https (built-in) instead of fetch — works on Node 16+
function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : require('http');
    protocol.get(url, (res) => {
      // Follow redirects (301/302)
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadBuffer(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const mime = res.headers['content-type'] || 'image/jpeg';
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), mime }));
      res.on('error', reject);
    }).on('error', reject)
      .setTimeout(10000, function() { this.destroy(); reject(new Error('Download timeout')); });
  });
}

async function extractReceiptFromImage(mediaUrl) {
  try {
    const { buffer, mime } = await downloadBuffer(mediaUrl);
    const base64 = buffer.toString('base64');
    // Ensure mime is a valid image type for Anthropic
    const safeMime = ['image/jpeg','image/png','image/gif','image/webp'].includes(mime)
      ? mime : 'image/jpeg';
    const r = await anthropic.messages.create({
      model: MODEL, max_tokens: 200,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: safeMime, data: base64 } },
        { type: 'text', text: `Ghana MTN MoMo receipt. Extract ONLY valid JSON:
{"amount":<number|null>,"txId":"<digits|null>","reference":"<string|null>","senderName":"<string|null>"}` },
      ]}],
    });
    return JSON.parse(r.content.map(c => c.text || '').join('').trim().replace(/```json|```/g, ''));
  } catch (e) {
    console.error('Receipt OCR error:', e.message);
    return null;
  }
}

// ── Order extraction ──────────────────────────────────────────
function quickParse(text) {
  if (!text) return [{ size: null, qty: null, isUnknown: true, isMoreOf: null }];
  const results = [];
  const re = /(?:(\d+)\s*[xX×]\s*)?([Aa][234])(?:\s*[xX×\-_ ]\s*\(?(\d+)\)?)?|(\d+)\s*[xX×]?\s*([Aa][234])/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let size, qty;
    if (m[2]) { size = m[2].toUpperCase(); qty = parseInt(m[1] || m[3]) || 1; }
    else if (m[5]) { size = m[5].toUpperCase(); qty = parseInt(m[4]) || 1; }
    else continue;
    const ex = results.find(r => r.size === size);
    if (ex) ex.qty += qty; else results.push({ size, qty, isUnknown: false, isMoreOf: null });
  }
  return results.length > 0 ? results : [{ size: null, qty: null, isUnknown: true, isMoreOf: null }];
}

async function extractOrder(msg, filename, session) {
  const prompt = `You are a precise order parser for a DTF print shop in Ghana.
Customer message/caption: "${msg || ''}"
Filename: "${filename || ''}"
Existing order items: ${JSON.stringify(session.files)}

TASK: Extract ALL print sizes and quantities from the customer message.
Handle multiple sizes in one message.
Handle Ghanaian pidgin English (e.g. "abeg print 3 A4").
Handle formats: "A4 x5", "5xA4", "A4×5", "5 A4", "A4-5".
If customer says "more/add/extra", set isMoreOf to the size they want more of.

Return ONLY a valid JSON array. No text. No markdown. No explanation.
Each object: {"size":"A4|A3|A2","qty":number,"isUnknown":false,"isMoreOf":"A4|A3|A2|null"}
If cannot parse: [{"size":null,"qty":null,"isUnknown":true,"isMoreOf":null}]`;
  try {
    const r = await askClaude([{ role: 'user', content: prompt }], null, 300, 8000);
    const raw = r.content.map(c => c.text || '').join('').trim();
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    console.error('extractOrder error:', e.message);
    return quickParse(msg || filename);
  }
}

async function extractImageInstructions(msg, pendingImages) {
  const count = pendingImages.length;
  const prompt = `DTF print shop Ghana. Customer has sent ${count} image(s) and now providing instructions.
Customer message: "${msg}"
Images waiting: ${JSON.stringify(pendingImages.map(i => ({ index: i.index, caption: i.caption || '' })))}

Extract print instructions for EACH image.
Return ONLY a valid JSON array with ${count} objects.
Each: {"size":"A3|A4|A2","qty":number,"background":"keep|remove|null"}
If size/qty unknown for an image, use null.

CRITICAL RULES:
- Only use sizes explicitly mentioned by the customer.
- If customer says "all A3" or "all are A3" — every single object MUST be A3. No exceptions.
- If customer says "all A4" — every object MUST be A4.
- NEVER assign a size that was not mentioned by the customer.
- NEVER default to A4 when the customer has specified a different size.`;
  try {
    const r = await askClaude([{ role: 'user', content: prompt }], null, 400, 8000);
    const raw = r.content.map(c => c.text || '').join('').trim();
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    const fb = quickParse(msg)[0] || {};
    return Array.from({ length: count }, () => ({ size: fb.size || null, qty: fb.qty || null, background: null }));
  }
}

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

function calcBill(files) {
  const t = { A4: 0, A3: 0, A2: 0 };
  for (const f of files) if (f.size && t[f.size] !== undefined) t[f.size] += f.qty || 0;
  let sub = 0, a4eq = 0;
  const lines = [];
  for (const [size, qty] of Object.entries(t)) {
    if (qty > 0) {
      const p = PRICES[size] * qty;
      sub += p; a4eq += qty * A4_EQ[size];
      lines.push({ size, qty, price: p });
    }
  }
  return { lines, subtotal: sub, a4eq };
}

function isYes(msg) {
  const t = (msg || '').trim().replace(/[!.?]+$/, '');
  return /^\s*(yes|yeah|yep|yh|ok|okay|sure|correct|right|confirm|confirmed|proceed|go ahead|👍)/i.test(t)
    || /^\s*y\s*$/i.test(t);
}
function isNo(msg) {
  const l = (msg || '').toLowerCase().trim();
  return /^\s*(no|nope|nah|not yet)\s*$/.test(l)
    || /\b(not yet|still sending|still going|sending more|adding more|one more|few more|hold on)\b/i.test(l);
}
function isMomoReceipt(msg) {
  return /paid|i paid|i have paid|done paying|payment done|settled|money sent|momo sent|transferred|receipt|sent the money/i.test(msg);
}

function buildSummary(session) {
  const { lines, subtotal, a4eq } = calcBill(session.files);
  session.a4eq = a4eq;
  let pressingFee = 0;
  if (session.pressing) {
    pressingFee = calcPressing(session.pressing.shirts, session.pressing.type, session.pressing.largeArtwork);
    session.pressing.fee = pressingFee;
  }
  const grandTotal = subtotal + pressingFee;
  session.totalBill = grandTotal;
  const items = lines.map(l => `  ${l.size} × ${l.qty} — GHS ${l.price.toFixed(2)}`).join('\n');
  const pressingLine = pressingFee > 0 ? `\n  👕 Pressing — GHS ${pressingFee.toFixed(2)}` : '';
  const parts = [
    `📋 *Order Summary*`, ``,
    (items + pressingLine) || `  (nothing detected)`, ``,
    `💰 *Total: GHS ${grandTotal.toFixed(2)}*`,
  ];
  if (session.unknownFiles.length > 0) {
    const names = session.unknownFiles.map(u => `  • ${u.name}`).join('\n');
    parts.push(``, `❓ *Still need size for:*`, names, `_e.g. logo=5 A3, flyer=10 A4_`);
  } else {
    parts.push(``, `Is this correct? Reply *YES* to confirm ✅ or tell us what to change.`, `_Auto-confirms in 1 min._`);
  }
  return parts.join('\n');
}

function calcPressing(shirts, type, largeArtwork) {
  if (!shirts || shirts <= 0) return 0;
  const base = (type === 'front_back') ? 3 : 2; // front+back=3, front or side=2
  const extra = largeArtwork ? 1 : 0;
  const rate = base + extra;
  if (shirts <= 2) return 10; // flat rate for 1-2 shirts
  if (shirts <= 5) return Math.ceil(shirts * rate * 1.5 * 100) / 100;
  return shirts * rate;
}

function buildBill(session) {
  const { lines, subtotal, a4eq } = calcBill(session.files);
  session.a4eq = a4eq;
  let pressingFee = 0;
  if (session.pressing) {
    pressingFee = calcPressing(session.pressing.shirts, session.pressing.type, session.pressing.largeArtwork);
    session.pressing.fee = pressingFee;
  }
  const grandTotal = subtotal + pressingFee;
  session.totalBill = grandTotal;
  const items = lines.map(l => `🖨 ${l.size}  ·  ${l.qty} sheet${l.qty!==1?'s':''}  ·  *GHS ${l.price.toFixed(2)}*`).join('\n');
  const pressingLine = pressingFee > 0
    ? `\n👕 Pressing  ·  *GHS ${pressingFee.toFixed(2)}*`
    : '';
  return [
    `--------------------`, `🧾 *MIGO PRINT SHOP*`,
    `📍 _Circle · Near Benz Gate · Accra_`, `--------------------`,
    `📄 *ORDER DETAILS*`, `--------------------`,
    items + pressingLine,
    `--------------------`,
    `💰 *TOTAL:  GHS ${grandTotal.toFixed(2)}*`,
    `--------------------`, `🟡 *MTN MOBILE MONEY*`, ``,
    `   📱 *0552719245*`, `   👤 *KOW HABIB BAISIE*`, ``,
    `🗓 ${nowStr()}`, `--------------------`,
    `_Thank you for choosing Migo!_ 🙏`,
  ].join('\n');
}

function buildReadyMsg(jobId) {
  return [
    `✅ *Your order is ready for pickup!*`, ``,
    `🔑 *PICKUP CODE*`, ``,
    `   *${jobId || '—'}*`, ``,
    `📍 *Migo Print Shop*`,
    `Circle branch, Near Benz Gate, Accra.`, ``,
    `No pickup code — no job released. 🙏`,
  ].join('\n');
}

function buildImageQuestion(session) {
  const imgs = session.pendingImages;
  const count = imgs.length;

  if (count === 1) {
    return `What size (A4 / A3 / A2) and how many copies?`;
  }
  // Multiple images — ask for size and qty of each, no listing
  return `Got *${count} images*. What size and quantity for each? e.g: A4 5, A3 2, A4 10`;
}

function startReceiveTimer(phone, session) {
  const fileCount = session.files.length + session.pendingImages.length + session.unknownFiles.length;

  if (fileCount >= 2) {
    // Bulk: set a short 5s timer after the LAST file arrives.
    // Each new file resets this timer — so it only fires 5s after they stop sending.
    setTimer(phone, 'checkin', 5000, async () => {
      if (session.state !== 'receiving') return;
      // Still have unresolved images without size info — ask for details
      if (session.pendingImages.length > 0) {
        session.state = 'asking_image_info';
        await sendMsg(phone, buildImageQuestion(session));
        setTimer(phone, 'imageTimeout', 300000, async () => {
          if (session.state !== 'asking_image_info') return;
          session.pendingImages = [];
          await proceedToSummary(phone, session);
        });
        return;
      }
      // All files have size info — go straight to bill
      await proceedToSummary(phone, session);
    });
    return;
  }

  // Single file — wait 60s for more files before asking
  setTimer(phone, 'checkin', 60000, async () => {
    if (session.state !== 'receiving') return;
    if (session.pendingImages.length > 0) {
      session.state = 'asking_image_info';
      await sendMsg(phone, buildImageQuestion(session));
      setTimer(phone, 'imageTimeout', 300000, async () => {
        if (session.state !== 'asking_image_info') return;
        session.pendingImages = []; session.state = 'asked_done';
        await sendMsg(phone, 'All done sending? 👍');
        setTimer(phone, 'nodone', 60000, async () => {
          if (session.state === 'asked_done') await proceedToSummary(phone, session);
        });
      });
      return;
    }
    session.state = 'asked_done';
    await sendMsg(phone, 'All done sending? 👍');
    setTimer(phone, 'nodone', 60000, async () => {
      if (session.state === 'asked_done') await proceedToSummary(phone, session);
    });
  });
}

async function proceedToSummary(phone, session) {
  if (!session.files.length && !session.unknownFiles.length && !session.pendingImages.length) {
    await sendMsg(phone, `I could not detect any files. Please send your files and I will calculate the cost.`);
    session.state = 'receiving'; return;
  }
  // Only ask about pressing if customer mentioned it and we haven't asked yet
  if (session.pressingMentioned && !session.askedPressing) {
    session.askedPressing = true;
    session.state = 'asking_pressing';
    await sendMsg(phone, `Pressing details — how many shirts and front only, front+back, or side? (Type *no* to skip)`);
    setTimer(phone, 'pressing_timeout', 60000, async () => {
      if (session.state === 'asking_pressing') {
        session.pressing = null;
        // Calculate bill totals before sending
        calcBill(session.files); // sets session.a4eq via buildBill
        await sendBill(phone, session);
      }
    });
    return;
  }
  // No summary — go straight to bill
  await sendBill(phone, session);
}

async function sendBill(phone, session) {
  session.state = 'awaiting_payment';
  audit('BILL_SENT', phone, `GHS ${session.totalBill?.toFixed(2)}`);

  // Build bill string NOW before setTimeout — so any crash is caught immediately
  let billMsg;
  try {
    billMsg = buildBill(session);
  } catch(e) {
    console.error('❌ buildBill error:', e.message);
    await alertOwner(`⚠️ buildBill crashed for ${displayPhone(phone)}: ${e.message}`).catch(()=>{});
    return;
  }

  // 3-day auto-close if no payment
  setTimer(phone, 'pay_expire', 3 * 24 * 3600000, async () => {
    if (session.state === 'awaiting_payment') {
      const waId = phone.includes('@') ? phone : toWaId(phone);
      await sendMsg(waId, `Hi${session.customerName ? ' ' + session.customerName.split(' ')[0] : ''}! Your order has been cancelled as we didn't receive payment. Send your files again whenever you're ready. 🙏`);
      archiveSession(waId, session, 'expired_no_payment');
    }
  });

  // Send bill after short delay (feels natural, avoids WhatsApp rate limits)
  setTimeout(async () => {
    try {
      await sendMsg(phone, billMsg);
      await sendMsg(phone, [
        `📌 Please send your payment receipt or MoMo confirmation screenshot to *COMPLETE* your order.`,
        ``,
        `Printing can *ONLY* start *AFTER* payment. 🙏`,
      ].join('\n'));
    } catch(e) {
      console.error('❌ Bill send error:', e.message);
      alertOwner(`⚠️ Bill failed to send to ${displayPhone(phone)}: ${e.message}`).catch(()=>{});
    }
    setTimer(phone, 'pay1', 600000, () => {
      if (session.state === 'awaiting_payment')
        sendMsg(phone, `⏰ Reminder: Pay *GHS ${session.totalBill?.toFixed(2)}* to MoMo *0552719245*. 🙏`);
    });
    setTimer(phone, 'pay2', 1800000, () => {
      if (session.state === 'awaiting_payment')
        sendMsg(phone, `🔔 *GHS ${session.totalBill?.toFixed(2)}* still pending. Please pay to keep your slot.`);
    });
    setTimer(phone, 'pay3', 3600000, () => {
      if (session.state === 'awaiting_payment')
        sendMsg(phone, `⚠️ Last reminder: Your order will be cancelled if payment is not received. MoMo: *0552719245*.`);
    });
  }, 2000);
}

function scheduleWorkerReminders(phone, session, jobId) {
  if (!session.readyTime) return;
  const now = Date.now(), readyMs = session.readyTime.getTime();
  const remind = (name, ms, label) => {
    if (ms <= now) return;
    setTimer(phone, name, ms - now, async () => {
      if (session.jobId !== jobId) return;
      await sendMsg(toWaId(SHOP_NUMBER),
        [label, ``, `🔖 Job: *${jobId}*`, `📱 ...${last4(phone)}`].join('\n'));
    });
  };
  remind('work30', readyMs - 30*60000, `⏰ *30-Min Warning* — Job ${jobId}`);
  remind('work15', readyMs - 15*60000, `⚠️ *15-Min Warning* — Job ${jobId}`);
  remind('work2',  readyMs -  2*60000, `🚨 *2-Min Warning*  — Job ${jobId} due NOW`);
  const overdueFn = async (attempt) => {
    if (session.jobId !== jobId) return;
    overdueFlow.set(phone, { step: 'asked_ready', jobId, attempt });
    await sendMsg(toWaId(SHOP_NUMBER), [
      `⏰ *JOB OVERDUE — Attempt ${attempt}*`, ``,
      `🔖 Job: *${jobId}*`,
      `📱 Customer: ...${last4(phone)}`, ``,
      `Is this job ready? Reply:`,
      `*YES ${last4(phone)}* — if ready now`,
      `*NO ${last4(phone)}*  — if not ready`,
    ].join('\n'));
    audit('JOB_OVERDUE', phone, `Attempt ${attempt} — Job ${jobId}`, true);
    // If no response in 10 minutes, ask again
    setTimer(phone, 'overdue', 600000, () => overdueFn(attempt + 1));
  };
  if (readyMs + 60000 > now)
    setTimer(phone, 'overdue', readyMs + 60000 - now, () => overdueFn(1));
}

async function handleImage(from, session, mediaUrl, caption, mediaType, filename) {
  // Duplicate check
  const isDuplicate = session.files.some(f => f.sourceUrl === mediaUrl)
    || session.pendingImages.some(p => p.url === mediaUrl);
  if (isDuplicate) return null; // silently ignore

  // Track for desktop agent
  trackFile(from, mediaUrl, filename || caption || 'image.jpg', mediaType || 'image/jpeg', caption, session);

  // Parse from caption first, fall back to filename (e.g. "A2 13COPIES.png" sent as document)
  const parseSource = caption || filename || '';
  const orders = await extractOrder(parseSource, filename || '', session);
  const valid  = orders.filter(o => !o.isUnknown && o.size && o.qty);
  if (valid.length > 0) {
    const bgNote = /no.?background|remove.?background|no.?bg|transparent/i.test(caption)
      ? 'remove background'
      : /with.?background|keep.?background|with.?bg/i.test(caption) ? 'keep background' : '';
    valid.forEach(o => addFile(session, { ...o, sourceUrl: mediaUrl }, caption || filename || 'image', bgNote));
    startReceiveTimer(from, session);
    return null; // ✅ silent — info was in caption/filename
  }
  // Unknown — queue for details, timer will send buildImageQuestion covering all pending images
  // Store mediaType so buildImageQuestion knows whether to ask about background
  session.pendingImages.push({ url: mediaUrl, caption, index: session.pendingImages.length + 1, mediaType: mediaType || '' });
  startReceiveTimer(from, session);
  return null; // ✅ No immediate reply — timer sends buildImageQuestion() after 60s inactivity
}

async function handleDoc(from, session, mediaUrl, caption, filename) {
  // Duplicate check
  const isDuplicate = session.files.some(f => f.sourceUrl === mediaUrl)
    || session.unknownFiles.some(u => u.url === mediaUrl);
  if (isDuplicate) return null;

  trackFile(from, mediaUrl, filename || 'file.pdf', 'application/pdf', caption, session);

  // Check if it's a PDF — could be multi-page
  const isPdf = /\.pdf$/i.test(filename || '') || /application\/pdf/i.test('');
  const orders = await extractOrder(caption, filename, session);
  const valid  = orders.filter(o => !o.isUnknown && o.size && o.qty);

  if (valid.length > 0) {
    // For PDFs with clear size/qty, still check if multi-page is possible
    if (isPdf && !caption && !filename?.match(/\d+\s*(page|pg|copy|copies|cop)/i)) {
      // Size/qty clear from filename — add and ask about pages only if filename has no page info
      valid.forEach(o => addFile(session, { ...o, sourceUrl: mediaUrl }, caption || filename, ''));
      startReceiveTimer(from, session);
      return null;
    }
    valid.forEach(o => addFile(session, { ...o, sourceUrl: mediaUrl }, caption || filename, ''));
    startReceiveTimer(from, session);
    return null;
  }

  // Unknown PDF — ask which page(s), size, and quantity
  if (isPdf) {
    session.unknownFiles.push({ name: filename || 'your file', url: mediaUrl });
    startReceiveTimer(from, session);
    return `📄 PDF received! If it has more than 1 page, which page(s) do you want printed?\nAlso — what size (A4 / A3 / A2) and how many copies?`;
  }

  // Non-PDF unknown file
  session.unknownFiles.push({ name: filename || 'your file', url: mediaUrl });
  startReceiveTimer(from, session);
  return `📥 File received! What size (A4 / A3 / A2) and how many copies?`;
}

// ── File tracking for desktop agent ──────────────────────────
function trackFile(phone, url, filename, mediaType, caption, session) {
  if (!url) return;
  const entry = {
    id:           crypto.randomBytes(8).toString('hex'),
    phone,
    customerName: session.customerName || null,
    jobId:        session.jobId || null,
    url, filename, mediaType, caption: caption || '',
    receivedAt:   new Date().toISOString(),
    downloaded:   false,
  };
  pendingFiles.unshift(entry);
  if (pendingFiles.length > 200) pendingFiles.splice(200);
}

// ── Main message handler ──────────────────────────────────────
async function handleMessage(from, body, mediaUrl, mediaType, filename, isImage) {
  const msg     = (body || '').trim();
  logMsg(from, 'in', msg || '[media]');

  // Admin commands always work — even when bot is stopped or crashed
  if (msg.toLowerCase().startsWith('admin ')) return handleAdmin(from, msg);

  // Overdue flow responses — workers reply YES/NO/TIME/REASON without 'admin' prefix
  const msgUpper = msg.toUpperCase().trim();
  const overdueArgs = msg.trim().split(/\s+/).slice(1);
  if ((msgUpper.startsWith('YES ') || msgUpper.startsWith('NO ') ||
       msgUpper.startsWith('TIME ') || msgUpper.startsWith('REASON ')) &&
      overdueFlow.size > 0) {
    const pseudoAdminMsg = 'admin ' + msg.trim();
    const result = await handleAdmin(from, pseudoAdminMsg);
    if (result && !result.includes('❌') && !result.includes('Unknown')) return result;
  }

  // // prefix — worker sends message to customer simultaneously
  if (msg.startsWith('//')) {
    const content = msg.replace(/^\/\/\d{4}\s+/, '').replace(/^\/\//, '').trim();
    if (content) {
      await sendMsg(from, content);
      audit('SIMULTANEOUS_MSG', from, `"${content.slice(0, 60)}"`, false, null);
    }
    return null;
  }

  if (botCrashed) {
    await alertOwner(`⚠️ Message from ${displayPhone(from)} while bot crashed.`);
    return null;
  }
  if (!botActive) return null;

  const session = getSession(from);
  if (session.paused) return null;

  // Auto-reset stale sessions (12h) — guard against double-reset
  const STALE = 12 * 60 * 60 * 1000;
  if (!body?.startsWith('__reset__') && Date.now() - session.lastActivity > STALE
      && ['idle','receiving','asked_done','confirming','asking_image_info','asking_pressing','ready'].includes(session.state)) {
    clearTimers(from); sessions.delete(from);
    return handleMessage(from, body, mediaUrl, mediaType, filename, isImage);
  }
  session.lastActivity = Date.now();

  // ── Detect pressing mention anywhere in message ───────────
  if (/\bpress(ing|ed)?\b/i.test(msg || '')) session.pressingMentioned = true;

  // ── Name greeting helper ──────────────────────────────────
  const greet = session.customerName ? `${session.customerName.split(' ')[0]}, ` : ``;

  // ── Job-ready check (natural language) ───────────────────
  if (isReadyCheck(msg || '') && session.state !== 'idle') {
    if (session.state === 'ready') {
      return `✅ Yes${greet}your order is ready! Come in with your pickup code *${session.jobId}* and we'll sort you out. 📍 Near Benz Gate, Circle.`;
    }
    if (session.state === 'processing') {
      const eta = session.readyTime
        ? session.readyTime.toLocaleTimeString('en-GH', { timeZone: 'Africa/Accra', hour12: true, hour: '2-digit', minute: '2-digit' })
        : 'shortly';
      return `Not yet${greet}we're still working on it. 🖨️ Estimated ready: *${eta}*. We'll notify you as soon as it's done!`;
    }
    if (session.state === 'awaiting_payment') {
      return `We haven't received your payment yet${greet}Once payment is confirmed we'll start printing and notify you. 🙏`;
    }
  }

  // ── FAQ quick-match ───────────────────────────────────────
  if (msg && session.state === 'idle') {
    // Greeting → instant reply, no Claude needed
    if (isGreeting(msg)) return greetingReply(msg);
    const faqAnswer = tryFAQ(msg);
    if (faqAnswer) return faqAnswer;
  }

  // ── IDLE ─────────────────────────────────────────────────
  if (session.state === 'idle') {
    if (mediaUrl) {
      session.state = 'receiving';
      if (isImage) return handleImage(from, session, mediaUrl, msg, mediaType, filename);
      return handleDoc(from, session, mediaUrl, msg, filename);
    }
    if (msg) {
      const orders = await extractOrder(msg, null, session);
      const valid  = orders.filter(o => !o.isUnknown && o.size && o.qty);
      if (valid.length > 0) {
        session.state = 'receiving';
        valid.forEach(o => addFile(session, o, msg, ''));
        startReceiveTimer(from, session);
        return `Got it! Please send your file(s). 📎`;
      }
      // Claude — fallback to DTF prompt if no reply
      const claudeReply = await replyWithClaude(msg, session);
      return claudeReply || `Hi! Please send your DTF files. 🖨️`;
    }
    return null;
  }

  // ── RECEIVING ───────────────────────────────────────────────
  if (session.state === 'receiving') {
    if (mediaUrl) {
      if (isImage) return handleImage(from, session, mediaUrl, msg, mediaType, filename);
      return handleDoc(from, session, mediaUrl, msg, filename);
    }
    if (msg) {
      const orders = await extractOrder(msg, null, session);
      const valid  = orders.filter(o => !o.isUnknown && o.size && o.qty);
      if (valid.length > 0) {
        // "all A3 1 each" — apply to all unknown files and pending images
        const allKeywords = /\ball\b/i.test(msg);
        const eachKeywords = /\beach\b/i.test(msg);
        if ((allKeywords || eachKeywords) && valid.length === 1 && session.unknownFiles.length > 0) {
          const { size, qty } = valid[0];
          session.unknownFiles.forEach(() => addFile(session, { size, qty, isUnknown: false, isMoreOf: null }, msg, ''));
          session.unknownFiles = [];
          session.pendingImages.forEach(() => addFile(session, { size, qty, isUnknown: false, isMoreOf: null }, msg, ''));
          session.pendingImages = [];
          clearTimers(from);
          await proceedToSummary(from, session);
          return null;
        }
        valid.forEach(o => addFile(session, o, msg, ''));
        startReceiveTimer(from, session);
        return null;
      }
      // Customer sent text while receiving — not a size instruction
      // If 2+ files in session the 5s timer will fire automatically
      // Otherwise ask Claude
      return replyWithClaude(msg, session);
    }
    return null;
  }

  // ── ASKING IMAGE INFO ────────────────────────────────────────
  if (session.state === 'asking_image_info') {
    if (mediaUrl && isImage) {
      const orders = await extractOrder(msg, '', session);
      const valid  = orders.filter(o => !o.isUnknown && o.size && o.qty);
      if (valid.length > 0) valid.forEach(o => addFile(session, o, msg || 'image', ''));
      else session.pendingImages.push({ url: mediaUrl, caption: msg, index: session.pendingImages.length + 1 });
      return null;
    }
    if (msg) {
      const parsed = await extractImageInstructions(msg, session.pendingImages);
      const unresolved = [];
      for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i];
        if (item.size && item.qty) {
          addFile(session, { size: item.size, qty: item.qty, isUnknown: false, isMoreOf: null },
            `image ${i+1}`, item.background === 'remove' ? 'remove background' : item.background === 'keep' ? 'keep background' : '');
        } else unresolved.push(session.pendingImages[i]);
      }
      session.pendingImages = unresolved;
      if (session.pendingImages.length > 0)
        return `Still need details for ${session.pendingImages.length} image(s). Size / qty / background?`;
      clearTimers(from); await proceedToSummary(from, session); return null;
    }
    return null;
  }

  // ── ASKING PRESSING ─────────────────────────────────────────
  if (session.state === 'asking_pressing') {
    clearTimers(from);
    const lower = (msg || '').toLowerCase().trim();
    if (lower === 'no' || lower === 'nope' || lower === 'nah' || lower === 'skip') {
      session.pressing = null;
    } else {
      const shirtsMatch = msg.match(/(\d+)/);
      const shirts = shirtsMatch ? parseInt(shirtsMatch[1]) : 1;
      const type = /front.?back|both/i.test(msg) ? 'front_back'
                 : /side/i.test(msg)              ? 'side'
                 :                                  'front';
      const largeArtwork = /large|big/i.test(msg);
      session.pressing = { shirts, type, largeArtwork };
    }
    session.askedPressing = true;
    await sendBill(from, session);
    return null;
  }

  // ── ASKED DONE ──────────────────────────────────────────────
  if (session.state === 'asked_done') {
    clearTimers(from);
    if (isNo(msg))  { session.state = 'receiving'; startReceiveTimer(from, session); return null; }
    if (isYes(msg) || msg) { await proceedToSummary(from, session); return null; }
    if (mediaUrl) {
      session.state = 'receiving';
      if (isImage) return handleImage(from, session, mediaUrl, msg, mediaType, filename);
      return handleDoc(from, session, mediaUrl, msg, filename);
    }
    return null;
  }

  // ── CONFIRMING (legacy — should not be reached in v30) ──────
  if (session.state === 'confirming') {
    clearTimers(from);
    await sendBill(from, session);
    return null;
  }

  // ── AWAITING PAYMENT ─────────────────────────────────────────
  if (session.state === 'awaiting_payment') {
    if (mediaUrl && isImage) {
      // Only treat as receipt if it has an amount (GHS value) — otherwise it's a new design file
      const ocr = await extractReceiptFromImage(mediaUrl);
      if (ocr && ocr.amount) {
        // Has amount = it's a MoMo receipt
        if (ocr.txId) {
          session.pendingTxId = ocr.txId; session.pendingTxAmount = ocr.amount;
          audit('RECEIPT_SCANNED', from, `TxID:${ocr.txId}`);
        }
        return ocr.txId
          ? `Got it! TxID *${ocr.txId}* noted — GHS ${ocr.amount.toFixed(2)}. We'll confirm shortly. 🙏`
          : `Got it! GHS ${ocr.amount.toFixed(2)} noted. Please reply with your *Transaction ID* so we can confirm faster.`;
      }
      // No amount = treat as a new design file
      if (msg) {
        const orders = await extractOrder(msg, '', session);
        const valid  = orders.filter(o => !o.isUnknown && o.size && o.qty);
        if (valid.length > 0) {
          valid.forEach(o => addFile(session, o, msg, ''));
          const billMsg = buildBill(session); // buildBill recalcs including pressing
          await sendMsg(from, `New file added. Updated total:`);
          setTimeout(() => sendMsg(from, billMsg), 1000);
          return null;
        }
      }
      // Image with no caption and no OCR amount — ask for details
      session.pendingImages.push({ url: mediaUrl, caption: msg, index: session.pendingImages.length + 1 });
      return `Got the image! Size and quantity? (e.g. A4 × 5)`;
    }
    if (mediaUrl && !isImage) {
      const prev = session.files.length;
      await handleDoc(from, session, mediaUrl, msg, filename);
      if (session.files.length > prev) {
        const billMsg = buildBill(session); // buildBill handles pressing too
        await sendMsg(from, `New file added. Updated total:`);
        setTimeout(() => sendMsg(from, billMsg), 1000);
      }
      return null;
    }
    const lower = (msg || '').toLowerCase();
    // Cash or no-MoMo indication — remind them payment must be confirmed
    if (/\b(cash|bring cash|pay cash|no momo|don.?t have momo|no mobile money|pay when i come|pay on arrival|pay at shop|i.?ll pay|coming to pay|bring the money|i have cash|physical(ly)?|in person)\b/i.test(msg)) {
      return `Printing can only start after Payment Confirmation. Thank you.`;
    }
    const txIdTyped = (msg || '').match(/\b(\d{8,})\b/);
    if (txIdTyped) {
      session.pendingTxId = txIdTyped[1]; session.awaitingTxId = false;
      audit('TXID_PROVIDED', from, `TxID:${txIdTyped[1]}`);
      return `Got it! TxID *${txIdTyped[1]}* noted. We'll confirm shortly. 🙏`;
    }
    if (isMomoReceipt(lower)) {
      if (!session.totalBill || session.totalBill <= 0) return null;
      return `Got it! We'll confirm your payment shortly. 🙏`;
    }
    // Re-send bill request
    if (/send.*bill|bill again|resend.*bill|can.?t see|didn.?t (get|receive)|show.*bill|send.*again/i.test(lower)) {
      await sendMsg(from, buildBill(session));
      return null;
    }
    if (/how much|total|bill|balance|amount/.test(lower))
      return `Total: *GHS ${session.totalBill?.toFixed(2) || '—'}*\n🟡 MoMo *0552719245* (Kow Habib Baisie)`;
    return replyWithClaude(msg, session);
  }

  // ── PROCESSING ───────────────────────────────────────────────
  if (session.state === 'processing') {
    if (mediaUrl) {
      session.state = 'receiving'; session.files = []; session.unknownFiles = []; session.pendingImages = [];
      if (isImage) return handleImage(from, session, mediaUrl, msg, mediaType, filename);
      return handleDoc(from, session, mediaUrl, msg, filename);
    }
    return replyWithClaude(msg, session);
  }

  // ── READY ────────────────────────────────────────────────────
  if (session.state === 'ready') {
    const n = parseInt(msg);
    if (!isNaN(n) && n >= 1 && n <= 5) {
      let reply, sentiment;
      if (n === 5) { reply = `🎉 Amazing — thank you! See you next time!`; sentiment = 'excellent'; }
      else if (n === 4) { reply = `😊 Thanks! Glad you're happy with the result.`; sentiment = 'good'; }
      else if (n === 3) { reply = `🙏 Thank you. We'll do better next time!`; sentiment = 'okay'; }
      else { reply = `😔 So sorry to hear that. What went wrong? We want to fix it.`; sentiment = 'poor'; }
      ratingsLog.unshift({
        ts: nowStr(), date: todayStr(), phone: displayPhone(from),
        jobId: session.jobId || '—', score: n, sentiment, comment: '',
        files: [...(session.confirmedFiles || [])],
      });
      session.ratingGiven = true;
      audit('RATING', from, `${n}/5 — ${sentiment} | Job:${session.jobId||'—'}`);
      if (n <= 2) await alertOwner(`⭐ *BAD RATING*\nCustomer ...${last4(from)} — ${n}/5 | Job: ${session.jobId||'—'}`);
      clearTimers(from); sessions.delete(from);
      return reply;
    }
    const lastRating = ratingsLog.find(r => r.phone === displayPhone(from));
    if (lastRating && !lastRating.comment) {
      lastRating.comment = msg;
      return `Thank you for letting us know. We take all feedback seriously. 🙏`;
    }
    return replyWithClaude(msg, session);
  }
  return null;
}

// ── Admin handler ─────────────────────────────────────────────
async function handleAdmin(from, msg) {
  const parts = msg.trim().split(/\s+/);
  let workerId = null, cmd, argStart;
  if (/^[Ww]\d{1,2}$/.test(parts[1])) {
    workerId = parts[1].toUpperCase(); cmd = (parts[2] || '').toLowerCase(); argStart = 3;
  } else {
    cmd = (parts[1] || '').toLowerCase(); argStart = 2;
  }
  const args = parts.slice(argStart);
  const workerName = workerId ? (workers.get(workerId)?.name || workerId) : 'Admin';

  if (cmd === 'h')       { botActive = false; return '🔴 Bot stopped.'; }
  if (cmd === 'j')       { botActive = true; botCrashed = false; return '🟢 Bot started.'; }
  if (cmd === 'restart') {
    botActive = true; botCrashed = false;
    await alertOwner(`✅ Bot restarted by ${workerName}.`);
    return '🟢 Bot restarted.';
  }

  if (cmd === 'pause') {
    const found = findByLast4(args[0]);
    if (!found) return `❌ No session for ...${args[0]}`;
    found.session.paused = true; found.session.servedBy = workerId;
    await sendMsg(found.key, `A member of our team will assist you shortly. 🙏`);
    audit('PAUSE', found.key, `By ${workerName}`, false, workerId);
    return `✅ Bot paused for ...${args[0]}.`;
  }
  if (cmd === 'resume') {
    const found = findByLast4(args[0]);
    if (!found) return `❌ No session for ...${args[0]}`;
    found.session.paused = false;
    audit('RESUME', found.key, `By ${workerName}`, false, workerId);
    return `✅ Bot resumed for ...${args[0]}.`;
  }

  // Cash — any worker approves directly, no two-step
  // Bill override command
  if (cmd === 'bill') {
    const customerLast4 = args[0];
    const newAmount     = parseFloat(args[1]);
    if (!customerLast4 || isNaN(newAmount)) return `❌ Usage: admin W01 bill <last4> <amount>\nExample: admin W01 bill 9245 25`;
    const found = findByLast4(customerLast4);
    if (!found) return `❌ No active session for ...${customerLast4}`;
    // Calculate a4eq from files but keep the overridden total
    const { a4eq: overrideEq } = calcBill(found.session.files);
    found.session.a4eq = overrideEq;
    found.session.totalBill = newAmount; // set override AFTER calcBill
    audit('BILL_OVERRIDE', found.key, `GHS ${newAmount.toFixed(2)} by ${workerName}`, false, workerId);
    // Build bill message manually with overridden amount
    const billItems = found.session.files
      .filter(f => f.size && f.qty)
      .map(f => `🖨 ${f.size}  ·  ${f.qty} sheet${f.qty!==1?'s':''}`)
      .join('\n') || '(files to be confirmed)';
    const overrideBillMsg = [
      `--------------------`,
      `🧾 *MIGO PRINT SHOP*`,
      `📍 _Circle · Near Benz Gate · Accra_`,
      `--------------------`,
      `📄 *ORDER DETAILS*`,
      `--------------------`,
      billItems,
      `--------------------`,
      `💰 *TOTAL:  GHS ${newAmount.toFixed(2)}*`,
      `--------------------`,
      `🟡 *MTN MOBILE MONEY*`, ``,
      `   📱 *0552719245*`,
      `   👤 *KOW HABIB BAISIE*`, ``,
      `--------------------`,
      `🗓 ${nowStr()}`,
      `--------------------`,
      `_Thank you for choosing Migo!_ 🙏`,
    ].join('\n');
    await sendMsg(found.key, overrideBillMsg);
    return `✅ Bill updated to GHS ${newAmount.toFixed(2)} and resent to customer.`;
  }

  // Overdue flow — YES/NO/TIME/REASON responses
  if ((msg.toUpperCase().startsWith('YES ') || cmd.toLowerCase() === 'yes') && args[0]?.length === 4) {
    const l4 = args[0];
    const flow = [...overdueFlow.entries()].find(([k]) => last4(k) === l4);
    if (flow && flow[1].step === 'asked_ready') {
      overdueFlow.delete(flow[0]);
      const found2 = findByLast4(l4);
      if (found2) {
        found2.session.state = 'ready'; clearTimers(found2.key);
        await sendMsg(found2.key, buildReadyMsg(found2.session.jobId));
      }
      return `✅ Job marked ready. Customer notified.`;
    }
  }

  if ((msg.toUpperCase().startsWith('NO ') || cmd.toLowerCase() === 'no') && args[0]?.length === 4) {
    const l4 = args[0];
    const found2 = findByLast4(l4);
    if (found2 && overdueFlow.has(found2.key)) {
      overdueFlow.set(found2.key, { ...overdueFlow.get(found2.key), step: 'asked_time' });
      return `When will it be ready? Reply with time e.g.:\n*TIME ${l4} 11:00*`;
    }
  }

  if ((msg.toUpperCase().startsWith('TIME ') || cmd.toLowerCase() === 'time') && args.length >= 2) {
    const l4 = args[0];
    const newTime = args[1];
    const found2 = findByLast4(l4);
    if (found2 && overdueFlow.has(found2.key)) {
      overdueFlow.set(found2.key, { ...overdueFlow.get(found2.key), step: 'asked_reason', newTime });
      return `What is the reason for the delay? Reply:\n*REASON ${l4} your reason here*`;
    }
  }

  if ((msg.toUpperCase().startsWith('REASON ') || cmd.toLowerCase() === 'reason') && args.length >= 2) {
    const l4 = args[0];
    const reason = args.slice(1).join(' ');
    const found2 = findByLast4(l4);
    if (found2 && overdueFlow.has(found2.key)) {
      const flow = overdueFlow.get(found2.key);
      const [hh, mm] = (flow.newTime || '12:00').split(':').map(Number);
      const newDate = new Date();
      newDate.setHours(hh, mm || 0, 0, 0);
      // If time already passed today, push to tomorrow
      if (newDate <= new Date()) newDate.setDate(newDate.getDate() + 1);
      const newETA = newDate.toLocaleTimeString('en-GH', {
        timeZone: 'Africa/Accra', hour12: true, hour: '2-digit', minute: '2-digit',
      });
      // Update session ready time
      found2.session.readyTime = newDate;
      // Send new ready time first, then apology
      await sendMsg(found2.key, [
        `⏱ *UPDATED READY TIME*`, ``,
        `   *${newETA}*`, ``,
        `We sincerely apologise for the delay. Thank you for your patience. 🙏`,
      ].join('\n'));
      await alertOwner([
        `🔴 *JOB OVERDUE ALERT*`, ``,
        `🔖 Job: *${found2.session.jobId || l4}*`,
        `📱 Customer: ...${l4}`,
        `🕐 New ETA: *${newETA}*`,
        `❓ Reason: ${reason}`,
        `👤 By: ${workerName || 'worker'}`,
      ].join('\n'));
      overdueFlow.delete(found2.key);
      audit('JOB_DELAY', found2.key, `New ETA: ${newETA} — Reason: ${reason}`, true, workerId);
      return `✅ Customer notified. New ETA: ${newETA}. Owner alerted.`;
    }
  }

  if (cmd === 'cash') {
    const customerLast4 = args[0];
    const amount        = parseFloat(args[1]);
    const pin           = args[2] || '';

    if (!customerLast4 || isNaN(amount)) return `❌ Usage: admin W01 cash <last4> <amount> <PIN>`;

    // PIN lockout check
    if (workerId && checkPinLockout(workerId)) {
      await alertOwner(`🔴 Locked worker ${workerId} tried cash ...${customerLast4}`);
      return `❌ Your account is locked. Contact the owner to unlock.`;
    }

    if (pin !== ADMIN_PIN) {
      const remaining = workerId ? recordBadPin(workerId) : '—';
      audit('WRONG_CASH_PIN', from, `${workerId||'?'} tried cash ...${customerLast4} GHS ${amount} — rejected (${remaining})`, true, workerId);
      await alertOwner([
        `🚨 *WRONG CASH PIN*`, ``,
        `👤 Worker: ${workerName} (${workerId || from})`,
        `💰 Amount: GHS ${amount?.toFixed(2)}`,
        `📱 Customer: ...${customerLast4}`,
        `${remaining === 'locked' ? '🔴 Worker is now LOCKED OUT.' : `⚠️ ${remaining}.`}`,
      ].join('\n'));
      return remaining === 'locked'
        ? `❌ Wrong PIN. You are LOCKED OUT. Owner alerted.`
        : `❌ Wrong PIN. ${remaining}.`;
    }

    // Correct PIN — confirm immediately
    if (workerId) pinLockout.delete(workerId);
    const found = findByLast4(customerLast4);
    if (!found) return `❌ No active session for ...${customerLast4}`;
    found.session.servedBy = workerId;
    const result = await processPayment(found.key, amount, 'cash', `${workerName} (${workerId||'admin'})`, workerId);
    if (result.status === 'confirmed') return `✅ Cash GHS ${amount.toFixed(2)} confirmed. Job: ${result.jobId}.`;
    if (result.status === 'partial')   return `✅ Partial GHS ${amount.toFixed(2)}. Balance: GHS ${result.balance?.toFixed(2)}.`;
    return `❌ ${result.message || 'Error.'}`;
  }

  if (cmd === 'ready') {
    const input = args[0] || '';
    // Support: admin W01 ready 9245 (last4) or admin W01 ready MGO-9245-A1001 (jobId)
    const byLast4 = findByLast4(input);
    let phone, s;
    if (byLast4) { phone = byLast4.key; s = byLast4.session; }
    else {
      for (const [key, sess] of sessions.entries())
        if (sess.jobId === input.toUpperCase()) { phone = key; s = sess; break; }
    }
    if (!s) return `❌ No session for "${input}".\nUsage: admin W01 ready <last4>`;
    s.state = 'ready'; s.servedBy = workerId; clearTimers(phone);
    audit('MARKED_READY', from, `Job ${s.jobId||'—'} by ${workerName}`, false, workerId);
    const readyMsg = buildReadyMsg(s.jobId);
    await sendMsg(phone, readyMsg);
    setTimer(phone, 'rating', 1800000, async () => {
      if (!s.ratingAsked) {
        s.ratingAsked = true;
        await sendMsg(phone, [`⭐ How was your experience at Migo Print Shop?`, ``,
          `5 — Excellent  |  4 — Good  |  3 — Okay  |  2 — Poor  |  1 — Very poor`].join('\n'));
        // Follow-up if no rating after 2 hours
        setTimer(phone, 'rating_followup', 7200000, async () => {
          if (s.state === 'ready' && !s.ratingGiven) {
            await sendMsg(phone, `😊 We'd love to hear how your experience was! Just reply with a number:\n5 — Excellent  |  4 — Good  |  3 — Okay  |  2 — Poor  |  1 — Very poor`);
          }
        });
      }
    });
    return `✅ Ready sent to ...${last4(phone)}.`;
  }

  if (cmd === 'status') {
    const found = findByLast4(args[0]);
    if (!found) return `❌ No session for "${args[0]}".`;
    const s = found.session;
    return [`📊 *...${last4(found.key)}*`,
      `State: ${s.state}`, `Job ID: ${s.jobId||'—'}`,
      `Files: ${JSON.stringify(s.files)}`,
      `Total: GHS ${s.totalBill?.toFixed(2)||'—'}`,
      `Paid: GHS ${s.paymentReceived.toFixed(2)}`,
      `Pending TxID: ${s.pendingTxId||'—'}`,
      `Paused: ${s.paused ? 'YES' : 'no'}`,
    ].join('\n');
  }

  if (cmd === 'override') {
    const found = findByLast4(args[0]);
    if (!found) return `❌ No session for ...${args[0]}`;
    const message = args.slice(1).join(' ');
    if (!message) return `❌ Usage: admin W01 override <last4> message`;
    await sendMsg(found.key, message);
    audit('OVERRIDE', from, `→ ...${args[0]}: "${message.slice(0,50)}" by ${workerName}`, false, workerId);
    return `✅ Sent to ...${args[0]}.`;
  }

  if (cmd === 'correct') {
    const found = findByLast4(args[0]);
    if (!found) return `❌ No session for ...${args[0]}`;
    const correction = args.slice(1).join(' ');
    if (!correction) return `❌ Usage: admin W01 correct <last4> correction`;
    await sendMsg(found.key, correction);
    correctionLog.unshift({ ts: nowStr(), customer: `...${args[0]}`, correction, by: workerName });
    audit('CORRECTION', from, `...${args[0]}: "${correction.slice(0,60)}"`, false, workerId);
    return `✅ Correction sent to ...${args[0]}.`;
  }

  if (cmd === 'learn') {
    const fact = args.join(' ');
    if (!fact) return `❌ Usage: admin learn <fact>`;
    knowledgeBase.push(fact);
    audit('KNOWLEDGE_ADDED', from, `"${fact.slice(0,80)}"`, false, workerId);
    return `✅ Learned: "${fact}" (${knowledgeBase.length} facts total)`;
  }

  // ── learnbulk — paste any list, Claude figures out the Q&As ──
  // Send as one WhatsApp message. Any format works:
  //   admin learnbulk
  //   Do you deliver?
  //   No, collection only from Circle.
  //   Do you do sublimation?
  //   No, DTF only.
  if (cmd === 'learnbulk') {
    const content = msg.split(/\r?\n/).slice(1).join('\n').trim();
    if (!content || content.length < 5)
      return [
        `❌ No content found. Just paste your list after:`,
        ``,
        `admin learnbulk`,
        `Do you deliver?`,
        `No, collection only from Circle.`,
        `Do you do sublimation?`,
        `No, DTF only.`,
        `How long does pressing take?`,
        `About 30 minutes after printing.`,
      ].join('\n');

    // Use Claude to parse any format into clean Q&A pairs
    let parsed = [];
    try {
      const r = await askClaude([{ role: 'user', content:
        `You are parsing a Q&A list for a DTF print shop knowledge base.\n` +
        `Extract all question-answer pairs from this text. The format may be messy — ` +
        `numbered, dashed, plain alternating lines, Q:/A: prefixed, or anything else.\n\n` +
        `TEXT:\n${content}\n\n` +
        `Return ONLY a valid JSON array. Each object: {"q":"question","a":"answer"}\n` +
        `If a line is a standalone fact (not a Q&A), use {"q":null,"a":"the fact"}\n` +
        `No markdown. No explanation. JSON only.`
      }], null, 800, 12000);
      const raw = r.content.map(c => c.text || '').join('').trim().replace(/```json|```/g, '').trim();
      parsed = JSON.parse(raw);
    } catch(e) {
      // Fallback — add each non-empty line as a raw fact
      console.error('learnbulk Claude parse error:', e.message);
      parsed = content.split(/\r?\n/).filter(l => l.trim().length > 3)
        .map(l => ({ q: null, a: l.trim() }));
    }

    if (!Array.isArray(parsed) || parsed.length === 0)
      return `❌ Could not parse any facts from that content. Try again.`;

    const added = [];
    for (const item of parsed) {
      if (!item.a) continue;
      const fact = item.q ? `Q: ${item.q} A: ${item.a}` : item.a;
      knowledgeBase.push(fact);
      added.push(`  • ${(item.q || item.a).slice(0, 60)}`);
    }

    audit('KNOWLEDGE_BULK', from, `${added.length} facts added`, false, workerId);

    if (added.length === 0) return `❌ Nothing could be extracted. Try a clearer format.`;

    return [
      `✅ *${added.length} fact(s) added to knowledge base:*`,
      ``,
      ...added,
      ``,
      `Total facts: ${knowledgeBase.length}`,
      `Use: admin knowledge — to review all`,
    ].join('\n');
  }

  if (cmd === 'unlearn') {
    const idx = parseInt(args[0]) - 1;
    if (isNaN(idx) || idx < 0 || idx >= knowledgeBase.length)
      return `❌ Usage: admin unlearn <number>\nCurrent:\n${knowledgeBase.map((f,i)=>`${i+1}. ${f}`).join('\n')||'(none)'}`;
    return `✅ Removed: "${knowledgeBase.splice(idx, 1)[0]}"`;
  }

  if (cmd === 'knowledge') {
    return knowledgeBase.length === 0
      ? `📚 No custom facts yet. Use: admin learn <fact>`
      : `📚 *Knowledge Base:*\n\n${knowledgeBase.map((f,i)=>`${i+1}. ${f}`).join('\n')}`;
  }

  if (cmd === 'addworker') {
    const wid   = (args[0] || '').toUpperCase();
    const wname = args.slice(1, -1).join(' ') || args[1];
    const wpin  = args[args.length - 1] || '';
    if (!wid || !/^W\d{1,2}$/.test(wid)) return `❌ Usage: admin addworker W01 Name 5678`;
    const pin = wpin.length === 4 && !isNaN(wpin) ? wpin : null;
    const name = pin ? args.slice(1, -1).join(' ') : args.slice(1).join(' ');
    if (!name) return `❌ Usage: admin addworker W01 Name 5678`;
    workers.set(wid, { name, pin, addedBy: workerName, addedAt: nowStr() });
    audit('WORKER_ADDED', from, `${wid}: ${name}`, false, workerId);
    return `✅ Worker registered:\n🆔 ID: *${wid}*\n👤 Name: *${name}*\n🔑 Dashboard PIN: ${pin || 'not set'}\n\nWorker logs in at /login`;
  }

  if (cmd === 'removeworker') {
    const wid = (args[0] || '').toUpperCase();
    if (!workers.has(wid)) return `❌ Worker ${wid} not found.`;
    const w = workers.get(wid);
    workers.delete(wid);
    audit('WORKER_REMOVED', from, `${wid}: ${w.name}`, false, workerId);
    return `✅ Worker ${wid} (${w.name}) removed.`;
  }

  if (cmd === 'workers') {
    if (workers.size === 0) return `👷 No workers. Use: admin addworker W01 Name 5678`;
    return `👷 *Workers:*\n\n${[...workers.entries()].map(([id,w])=>`${id}: ${w.name}`).join('\n')}`;
  }

  if (cmd === 'unlock') {
    const wid = (args[0] || '').toUpperCase();
    if (!pinLockout.has(wid)) return `✅ ${wid} is not locked.`;
    pinLockout.delete(wid);
    audit('WORKER_UNLOCKED', from, `${wid} unlocked by ${workerName}`, false, workerId);
    return `✅ ${wid} unlocked.`;
  }

  if (cmd === 'info') {
    const found = findByLast4(args[0]);
    if (!found) return `❌ No session for ...${args[0]}`;
    const qty = parseInt(args[1]), size = (args[2] || '').toUpperCase();
    if (!PRICES[size] || isNaN(qty)) return `❌ Usage: admin W01 info <last4> 20 A4`;
    addFile(found.session, { size, qty, isUnknown: false, isMoreOf: null }, 'admin', '');
    return `✅ Added ${qty} ${size} for ...${args[0]}.`;
  }

  if (cmd === 'jobs') {
    const out = [`📋 *ACTIVE SESSIONS*`, ``];
    for (const [key, s] of sessions.entries())
      out.push(`...${last4(key)} → ${s.state} | GHS ${s.totalBill?.toFixed(2)||'—'}${s.jobId?' | '+s.jobId:''}`);
    return out.length > 2 ? out.join('\n') : '📭 No active sessions.';
  }

  if (cmd === 'reset') {
    const found = findByLast4(args[0]);
    if (!found) return `❌ No session for ...${args[0]}`;
    clearTimers(found.key); sessions.delete(found.key);
    return `✅ Reset ...${args[0]}.`;
  }

  if (cmd === 'resetall') {
    const count = sessions.size;
    for (const key of sessions.keys()) clearTimers(key);
    sessions.clear();
    return `✅ All ${count} sessions cleared.`;
  }

  if (cmd === 'test') {
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'on') {
      testMode = true;
      audit('TEST_MODE_ON', from, `Enabled by ${workerName}`);
      await alertOwner(`🧪 *TEST MODE ON*\nBot only responding to your private number (0272006161). All other customers silently ignored.`);
      return `🧪 *Test mode ON.*\nBot will only respond to the owner number.\nUse: admin reset 0272006161 — to reset your test session between tests.\nUse: admin test off — when done.`;
    }
    if (sub === 'off') {
      testMode = false;
      audit('TEST_MODE_OFF', from, `Disabled by ${workerName}`);
      await alertOwner(`✅ *TEST MODE OFF*\nBot back to normal — responding to all customers.`);
      return `✅ *Test mode OFF.* Bot is back to normal for all customers.`;
    }
    return `❌ Usage: admin test on  OR  admin test off\nCurrent: ${testMode ? '🧪 ON' : '✅ OFF'}`;
  }

  if (cmd === 'daily') { await sendDailySummary(); return `✅ Daily summary sent.`; }

  if (cmd === 'archive') {
    const found = findByLast4(args[0]);
    if (!found) return `❌ No session for ...${args[0]}`;
    archiveSession(found.key, found.session, 'manual');
    return `✅ Job ...${args[0]} archived.`;
  }

  if (cmd === 'help' || cmd === '?') {
    return [
      `🤖 *MIGO BOT ${BOT_VERSION} — COMMANDS*`, ``,
      `*PAYMENTS:*`,
      `admin W01 cash <last4> <amount> <PIN>`,
      `admin W01 bill <last4> <amount>`,``,
      `*JOBS:*`,
      `admin W01 ready <last4 or JobID>`,
      `admin W01 status <last4>`,
      `admin W01 info <last4> <qty> <size>`,
      `admin W01 reset <last4>`,
      `admin jobs`,``,
      `*COMMS:*`,
      `admin W01 pause <last4>`,
      `admin W01 resume <last4>`,
      `admin W01 override <last4> <msg>`,
      `admin W01 correct <last4> <msg>`,``,
      `*WORKERS:*`,
      `admin addworker W01 Name PIN`,
      `admin removeworker W01`,
      `admin workers`,
      `admin unlock W01`,``,
      `*TRAINING:*`,
      `admin learn <fact>`,
      `admin learnbulk  (multiline Q&A list)`,
      `admin unlearn <n>`,
      `admin knowledge`,``,
      `*BOT:*`,
      `admin h|j|restart|daily`,
      `admin test on|off  — test mode (${testMode?'🧪 ON':'✅ OFF'})`,
    ].join('\n');
  }

  return `❓ Unknown command. Type: admin help`;
}

// ── PIN lockout ───────────────────────────────────────────────
function checkPinLockout(wid) {
  const lock = pinLockout.get(wid);
  if (!lock) return false;
  if (Date.now() - lock.lockedAt < 30 * 60 * 1000) return true;
  pinLockout.delete(wid); return false;
}
function recordBadPin(wid) {
  const lock = pinLockout.get(wid) || { attempts: 0, lockedAt: null };
  lock.attempts++;
  if (lock.attempts >= 3) { lock.lockedAt = Date.now(); pinLockout.set(wid, lock); return 'locked'; }
  pinLockout.set(wid, lock);
  return `${3 - lock.attempts} attempts remaining`;
}

// ── Archive ───────────────────────────────────────────────────
function archiveSession(key, session, reason) {
  const { subtotal } = calcBill([...(session.confirmedFiles||[]), ...(session.files||[])]);
  jobArchive.unshift({
    archivedAt: nowStr(), archivedDate: todayStr(), reason,
    phone: `...${last4(key)}`, fullPhone: key,
    jobId: session.jobId || '—', state: session.state,
    files: [...(session.confirmedFiles||[]), ...(session.files||[])],
    total: session.totalBill || subtotal || 0,
    paid: session.paymentReceived || 0,
    servedBy: session.servedBy || null,
    workerName: session.servedBy ? (workers.get(session.servedBy)?.name || session.servedBy) : null,
  });
  if (jobArchive.length > 500) jobArchive.splice(500);
  clearTimers(key); sessions.delete(key);
}

function runAutoArchive() {
  const now = Date.now(); let count = 0;
  for (const [key, s] of sessions.entries()) {
    const hrs = (now - (s.lastActivity || now)) / 3600000;
    if (s.state === 'ready' && hrs > 6)                    { archiveSession(key, s, 'completed'); count++; }
    else if (s.state === 'awaiting_payment' && hrs > 24)   { archiveSession(key, s, 'abandoned'); count++; }
    else if (s.state === 'processing' && hrs > 12)         { archiveSession(key, s, 'overdue');   count++; }
    else if (['idle','receiving','asked_done','confirming'].includes(s.state) && hrs > 24)
                                                           { archiveSession(key, s, 'abandoned'); count++; }
  }
  if (count > 0) alertOwner(`🗂️ Auto-archived ${count} job(s).`).catch(() => {});
}

// ── Daily summary ─────────────────────────────────────────────
async function sendDailySummary() {
  const todayP = dailyPayments();
  const momoT  = todayP.filter(p => p.type === 'momo').reduce((s, p) => s + p.amount, 0);
  const cashT  = todayP.filter(p => p.type === 'cash').reduce((s, p) => s + p.amount, 0);
  const todayR = ratingsLog.filter(r => r.date === todayStr());
  const avgR   = todayR.length ? (todayR.reduce((s,r) => s + r.score, 0) / todayR.length).toFixed(1) : '—';
  const flagged= auditLog.filter(a => a.flag && a.date === todayStr()).length;
  const cashByWorker = {};
  todayP.filter(p => p.type === 'cash').forEach(p => {
    const k = p.confirmedBy || 'Unknown';
    cashByWorker[k] = (cashByWorker[k] || 0) + p.amount;
  });
  const wb = Object.entries(cashByWorker).map(([w,a]) => `  ${w}: GHS ${a.toFixed(2)}`).join('\n') || '  None';
  // Production report
  const todayArchive = jobArchive.filter(a => a.archivedDate === todayStr());
  const bySize = { A4: 0, A3: 0, A2: 0 };
  todayArchive.forEach(job => {
    (job.files || []).forEach(f => { if (bySize[f.size] !== undefined) bySize[f.size] += f.qty || 0; });
  });
  const completed = todayArchive.filter(a => a.reason === 'completed').length;
  const abandoned = todayArchive.filter(a => a.reason === 'abandoned').length;
  const overdueCount = auditLog.filter(a => a.action === 'JOB_OVERDUE' && a.date === todayStr()).length;

  const pressingT = todayP.reduce((s, p) => s + (p.pressingFee || 0), 0);

  // Complaints — bad ratings (1-2) with comments today
  const todayComplaints = todayR.filter(r => r.score <= 2);
  const complaintsLines = todayComplaints.length > 0
    ? todayComplaints.map(r =>
        `  • ...${r.phone.slice(-4)} — ⭐${r.score}/5${r.comment ? `: "${r.comment}"` : ''} | Job: ${r.jobId}`
      ).join('\n')
    : '  None';

  // Rating comments (all ratings with comments today)
  const todayComments = todayR.filter(r => r.comment && r.comment.trim());
  const commentsLines = todayComments.length > 0
    ? todayComments.map(r =>
        `  • ...${r.phone.slice(-4)} (⭐${r.score}): "${r.comment}"`
      ).join('\n')
    : '  None';

  // Delay reasons — from audit log today
  const todayDelays = auditLog.filter(a => a.action === 'JOB_DELAY' && a.date === todayStr());
  const delayLines = todayDelays.length > 0
    ? todayDelays.map(d => `  • ${d.phone}: ${d.detail}`).join('\n')
    : '  None';

  await alertOwner([
    `--------------------`,
    `📊 *MIGO DAILY SUMMARY*`,
    `📅 ${todayStr()} 🕗 8pm`,
    `--------------------`, ``,
    `🟡 MoMo:      GHS ${momoT.toFixed(2)}`,
    `💵 Cash:      GHS ${cashT.toFixed(2)}`,
    pressingT > 0 ? `👕 Pressing:  GHS ${pressingT.toFixed(2)}` : ``,
    `--------`,
    `💰 TOTAL:     GHS ${(momoT + cashT).toFixed(2)}`, ``,
    `*Cash by worker:*`, wb, ``,
    `⭐ Avg Rating: ${avgR} (${todayR.length} reviews)`,
    `🚩 Flagged events: ${flagged}`,
    `📋 Active sessions: ${sessions.size}`,
    `--------------------`,
    `📊 *PRODUCTION REPORT*`,
    `🖨 A4 sheets: ${bySize.A4}`,
    `🖨 A3 sheets: ${bySize.A3}`,
    `🖨 A2 sheets: ${bySize.A2}`,
    `--------`,
    `✅ Completed: ${completed}`,
    `❌ Abandoned: ${abandoned}`,
    `⚠️ Overdue:   ${overdueCount}`,
    `--------------------`,
    `😠 *COMPLAINTS (${todayComplaints.length})*`,
    complaintsLines,
    `--------`,
    `💬 *CUSTOMER COMMENTS*`,
    commentsLines,
    `--------`,
    `🕐 *DELAY REASONS (${todayDelays.length})*`,
    delayLines,
    `--------------------`,
  ].filter(l => l !== '').join('\n'));
}

function schedule8pm() {
  const now  = new Date();
  const next = new Date(); next.setHours(20, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(async () => {
    // Close all open sessions before daily summary
    for (const [key, s] of sessions.entries()) {
      if (!['processing', 'ready'].includes(s.state)) {
        archiveSession(key, s, 'end_of_day');
      }
    }
    await sendDailySummary();
    schedule8pm();
  }, next - now);
  console.log(`⏰ Daily summary scheduled in ${Math.round((next-now)/60000)} mins`);
}

// ── WasenderAPI Webhook ───────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Verify webhook signature if secret is set
  if (WEBHOOK_SECRET) {
    // Signature check disabled — accept all webhooks from WasenderAPI
  // const sig = req.headers['x-webhook-secret'] || req.headers['x-wasender-signature'] || '';
  // if (sig !== WEBHOOK_SECRET) { return res.status(401).json({ ok: false }); }
  }

  res.status(200).json({ ok: true }); // Respond immediately

  const payload = req.body;
  if (!payload) return;
  console.log('📨 Webhook RAW:', JSON.stringify(payload).slice(0, 800));

  // WasenderAPI message format
  const event = payload.event || payload.type;
  if (event !== 'message' && event !== 'messages.upsert' && event !== 'messages.received') return;

  // WasenderAPI messages.received payload structure:
  // payload.data.messages = OBJECT (not array) with key and message fields
  const rawData = payload.data || {};
  // messages can be object OR array — handle both
  const msgsRaw = rawData.messages;
  const msgObj  = Array.isArray(msgsRaw) ? (msgsRaw[0] || {})
                : (msgsRaw && typeof msgsRaw === 'object') ? msgsRaw
                : rawData;
  const keyObj  = msgObj.key || {};

  // Sender phone — from key.cleanedSenderPn or key.senderPn
  const cleanedPn = keyObj.cleanedSenderPn || '';
  const senderPn  = keyObj.senderPn || '';
  const from = cleanedPn
    ? cleanedPn + '@s.whatsapp.net'
    : senderPn
      ? senderPn.replace('as.whatsapp.net', '@s.whatsapp.net')
      : '';

  // Message body
  const msgContent = msgObj.message || {};
  const body = msgContent.conversation
            || msgContent.extendedTextMessage?.text
            || msgContent.imageMessage?.caption
            || msgContent.documentMessage?.caption
            || msgObj.messageBody
            || msgObj.body
            || '';

  // Media
  const mediaUrl  = msgContent.imageMessage?.url
                 || msgContent.documentMessage?.url || null;
  const mediaType = msgContent.imageMessage?.mimetype
                 || msgContent.documentMessage?.mimetype || '';
  const filename  = msgContent.documentMessage?.fileName || '';

  const isImage   = mediaType.startsWith('image/') ||
                    ['image/jpeg','image/png','image/webp'].includes(mediaType);

  console.log('📨 Parsed:', { from: from?.slice(0,25)||'EMPTY', body: body?.slice(0,50)||'EMPTY', cleanedPn: cleanedPn||'EMPTY' });

  // Skip if no sender extracted
  if (!from) return;
  // Skip messages from the bot itself
  if (from.includes(SHOP_NUMBER) || from.includes('status@broadcast') || from.includes('@newsletter')) return;
  // Skip if no content
  if (!body && !mediaUrl) return;

  console.log(`📩 WA: ${from} — "${(body||'').slice(0,60)}" media=${!!mediaUrl}`);
  logMsg(from, 'in', body || '[media]');

  // Strip WhatsApp forwarded prefix — must be before testMode block uses cleanBody
  const cleanBody = stripForwarded(body);

  // ── Test mode filter ─────────────────────────────────────────
  // When test mode is ON, only owner's private number gets replies
  // Admin commands from the shop number always pass through
  if (testMode) {
    const isOwner = from.includes(OWNER_NUMBER.replace(/\D/g,'').slice(-9));
    const isAdminCmd = (cleanBody||'').toLowerCase().startsWith('admin');
    const isShop = from.includes(SHOP_NUMBER.replace(/\D/g,'').slice(-9));
    if (!isOwner && !(isShop && isAdminCmd)) {
      console.log(`🧪 TEST MODE — silent ignore: ${from.slice(0,20)}`);
      return; // silently ignore
    }
  }

  // ── Shop hours — bot runs 24/7 ───────────────────────────────
  // No closed-hours block. Orders are accepted at any time.
  // Owner is alerted when a new order arrives outside 7am–10pm so they can decide.
  const { open, isSunday } = shopStatus();
  const session = getSession(from);
  if (!open && !cleanBody?.toLowerCase().startsWith('admin')) {
    // Only alert owner on first message of a new session (state idle/asking_name)
    if (session.state === 'idle' || session.state === 'asking_name') {
      alertOwner([
        `🌙 *OUT-OF-HOURS ORDER*`,
        `📱 Customer: ${displayPhone(from)}`,
        `💬 Message: "${(cleanBody||'').slice(0, 80)}"`,
        `🕐 Time: ${nowStr()}`,
        ``,
        `Bot is processing normally. Reply to decide.`,
      ].join('\n')).catch(() => {});
    }
  }

  // Sunday: only bulk (200+ A4eq)
  // We don't know order size yet, so we flag it after bill is calculated

  try {
    const reply = await handleMessage(from, cleanBody, mediaUrl, mediaType, filename, isImage);
    if (reply) await sendMsg(from, reply);
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    await alertOwner([
      `🔴 *UNHANDLED ERROR*`, ``,
      `From: ${displayPhone(from)}`,
      `Msg: "${body.slice(0, 80)}"`,
      `Error: ${err.message}`,
    ].join('\n'));
  }
});

// ── MoMo endpoint ─────────────────────────────────────────────
app.post('/momo', async (req, res) => {
  const { text, amount, phone } = req.body;
  if (text) { const r = await handleMomoEvent(parseMomoSMS(text), 'sms'); return res.json(r); }
  if (amount && phone) { const r = await processPayment(toWaId(phone), amount, 'momo', 'direct'); return res.json(r); }
  res.json({ status: 'ignored' });
});

// ── Receipt page ──────────────────────────────────────────────
app.get('/receipt/:jobid', (req, res) => {
  const jid = (req.params.jobid || '').toUpperCase();
  const payment = paymentLedger.slice().reverse().find(p => p.jobId === jid);
  if (!payment) return res.status(404).send('<h2>Receipt not found</h2>');
  res.set('Content-Type', 'text/html');
  res.send(buildReceiptHTML(payment));
});

// ── Dashboard cash payment ────────────────────────────────────
app.post('/api/cash', async (req, res) => {
  const { customer_last4, amount, pin, workerId: wid } = req.body;
  const wIdUpper = (wid || '').toUpperCase();

  if (wIdUpper && checkPinLockout(wIdUpper))
    return res.json({ ok: false, msg: 'Worker locked out. Contact owner.' });

  if (pin !== ADMIN_PIN) {
    if (wIdUpper) recordBadPin(wIdUpper);
    audit('WRONG_CASH_PIN', 'dashboard', `GHS ${amount} for ...${customer_last4} — wrong PIN`, true, wIdUpper || null);
    await alertOwner([
      `🚨 *WRONG CASH PIN (DASHBOARD)*`, ``,
      `Worker: ${wIdUpper || 'unknown'}`,
      `Customer: ...${customer_last4}`,
      `Amount: GHS ${amount}`,
    ].join('\n'));
    return res.json({ ok: false, msg: 'Incorrect PIN. Attempt logged.' });
  }

  if (wIdUpper) pinLockout.delete(wIdUpper);
  const found = findByLast4(customer_last4);
  if (!found) return res.json({ ok: false, msg: `No active order for ...${customer_last4}` });

  const result = await processPayment(found.key, parseFloat(amount), 'cash',
    `${workers.get(wIdUpper)?.name || wIdUpper || 'dashboard'} (${wIdUpper || '—'})`, wIdUpper || null);

  if (result.status === 'confirmed' || result.status === 'partial') {
    return res.json({
      ok:     true,
      msg:    result.status === 'confirmed' ? `✅ Confirmed! Job: ${result.jobId}` : `✅ Partial. Balance: GHS ${result.balance?.toFixed(2)}`,
      jobId:  result.jobId,
      receiptUrl: result.jobId ? `/receipt/${result.jobId}` : null,
      ...result,
    });
  }
  return res.json({ ok: false, msg: result.message || 'Error.' });
});

// ── MoMo simulate ─────────────────────────────────────────────
app.post('/test-momo', async (req, res) => {
  const { amount, phone } = req.body;
  const r = await processPayment(toWaId(phone), amount, 'momo', 'dashboard-test');
  res.json(r);
});

// ── Mark ready ─────────────────────────────────────────────────
app.get('/mark-ready/:phone', async (req, res) => {
  const raw   = decodeURIComponent(req.params.phone);
  const waId  = raw.includes('@') ? raw : toWaId(raw);
  let s = sessions.get(waId);
  if (!s) for (const [key, sess] of sessions.entries())
    if (sess.jobId === raw.toUpperCase()) { s = sess; break; }
  if (!s) return res.json({ status: 'error', message: 'Not found' });
  s.state = 'ready'; clearTimers(waId);
  const readyMsg2 = buildReadyMsg(s.jobId);
  await sendMsg(waId, readyMsg2);
  setTimer(waId, 'rating', 1800000, async () => {
    if (!s.ratingAsked) {
      s.ratingAsked = true;
      await sendMsg(waId, [`⭐ How was your experience at Migo Print Shop?`, ``,
        `5 — Excellent  |  4 — Good  |  3 — Okay  |  2 — Poor  |  1 — Very poor`].join('\n'));
    }
  });
  res.json({ status: 'ready' });
});

// ── Pickup verification ────────────────────────────────────────
app.get('/pickup/:jobid', (req, res) => {
  const jid = (req.params.jobid || '').toUpperCase();
  let found = null;
  for (const [key, s] of sessions.entries())
    if ((s.jobId || '').toUpperCase() === jid) { found = { key, session: s }; break; }
  if (!found) return res.send(`<html><body><h2>Job not found: ${jid}</h2></body></html>`);
  const s = found.session;
  const files = (s.confirmedFiles.length > 0 ? s.confirmedFiles : s.files).map(f=>`${f.qty}×${f.size}`).join(', ');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Collect Order</title><style>body{background:#0f172a;color:#f9fafb;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:28px;width:100%;max-width:360px}
h2{font-size:18px;margin-bottom:4px}.sub{color:#94a3b8;font-size:13px;margin-bottom:20px}
.info{background:#0f172a;border-radius:8px;padding:12px;margin-bottom:16px;font-size:13px}
.info div{display:flex;justify-content:space-between;margin-bottom:6px}
input{width:100%;background:#0f172a;border:1px solid #334155;color:#f9fafb;padding:12px;border-radius:8px;font-size:20px;letter-spacing:6px;text-align:center;margin-bottom:8px}
.btn{width:100%;background:#10b981;color:#fff;border:none;padding:13px;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer}
.err{color:#ef4444;font-size:12px;margin-bottom:8px;display:none}
.ok{display:none;text-align:center}.ok .code{font-size:36px;font-weight:900;color:#10b981;letter-spacing:4px;margin:10px 0}
</style></head><body><div class="card">
<h2>📦 Collect Your Order</h2><div class="sub">Migo Print Shop · Circle, Accra</div>
<div class="info"><div><span>Job ID</span><span><b>${jid}</b></span></div><div><span>Items</span><span>${files}</span></div><div><span>Status</span><span style="color:#10b981">Ready ✅</span></div></div>
<div id="form"><input type="number" id="d" maxlength="4" placeholder="Last 4 digits of your phone" oninput="this.value=this.value.slice(0,4)">
<div class="err" id="err">❌ Incorrect. Please try again.</div>
<button class="btn" onclick="verify()">Confirm Collection</button></div>
<div class="ok" id="ok"><div style="font-size:40px">🎉</div><h2>Confirmed!</h2><p style="color:#94a3b8;margin:8px 0">Show this code to the worker:</p><div class="code" id="code"></div></div>
</div><script>
async function verify(){const d=document.getElementById('d').value;if(d.length!==4)return;
const r=await fetch('/pickup-verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobId:'${jid}',digits:d})});
const j=await r.json();if(j.ok){document.getElementById('form').style.display='none';document.getElementById('ok').style.display='block';document.getElementById('code').textContent=j.code;}
else document.getElementById('err').style.display='block';}
</script></body></html>`);
});

app.post('/pickup-verify', async (req, res) => {
  const { jobId, digits } = req.body;
  const jid = (jobId || '').toUpperCase();
  let found = null;
  for (const [key, s] of sessions.entries())
    if ((s.jobId||'').toUpperCase() === jid) { found = { key, session: s }; break; }
  if (!found) return res.json({ ok: false });
  if (digits !== found.key.replace(/\D/g,'').slice(-4)) {
    audit('PICKUP_WRONG', found.key, `Job ${jid}`);
    return res.json({ ok: false });
  }
  const code = 'MC' + Date.now().toString(36).toUpperCase().slice(-4);
  found.session.collectionCode = code; found.session.collectedAt = nowStr();
  audit('PICKUP_VERIFIED', found.key, `Job ${jid} code:${code}`);
  await sendMsg(toWaId(SHOP_NUMBER), [`📦 *ORDER COLLECTION VERIFIED*`, `🔖 Job: *${jid}*`,
    `📱 ...${last4(found.key)}`, `🔑 Code: *${code}*`, `Please release the order.`].join('\n'));
  res.json({ ok: true, code });
});

// ── Desktop agent endpoints ───────────────────────────────────
app.get('/api/pending-files', (req, res) => {
  if (req.headers['x-agent-key'] !== DESKTOP_KEY) return res.status(401).json({ ok: false });
  const files = pendingFiles.filter(f => !f.downloaded && !downloadedIds.has(f.id));
  res.json({ ok: true, files, count: files.length });
});

app.post('/api/files/acknowledge', (req, res) => {
  if (req.headers['x-agent-key'] !== DESKTOP_KEY) return res.status(401).json({ ok: false });
  const { fileIds } = req.body;
  if (Array.isArray(fileIds)) fileIds.forEach(id => {
    downloadedIds.add(id);
    const f = pendingFiles.find(p => p.id === id);
    if (f) f.downloaded = true;
  });
  res.json({ ok: true });
});

// Desktop agent polls for confirmed payments → moves files to hot folder
app.get('/api/confirmed-payments', (req, res) => {
  if (req.headers['x-agent-key'] !== DESKTOP_KEY) return res.status(401).json({ ok: false });
  const pending = confirmedPayments.filter(p => !p.acknowledged && !confirmedPaymentAcked.has(p.id));
  res.json({ ok: true, payments: pending });
});

app.post('/api/confirmed-payments/acknowledge', (req, res) => {
  if (req.headers['x-agent-key'] !== DESKTOP_KEY) return res.status(401).json({ ok: false });
  const { ids } = req.body;
  if (Array.isArray(ids)) ids.forEach(id => {
    confirmedPaymentAcked.add(id);
    const p = confirmedPayments.find(cp => cp.id === id);
    if (p) p.acknowledged = true;
  });
  res.json({ ok: true });
});

// ── Stats API ─────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const todayP = dailyPayments();
  res.json({
    ok: true,
    active:          sessions.size,
    awaitingPayment: [...sessions.values()].filter(s=>s.state==='awaiting_payment').length,
    printing:        [...sessions.values()].filter(s=>s.state==='processing').length,
    momoTotal:       todayP.filter(p=>p.type==='momo').reduce((s,p)=>s+p.amount,0),
    cashTotal:       todayP.filter(p=>p.type==='cash').reduce((s,p)=>s+p.amount,0),
    botActive, botCrashed,
  });
});

// ── Health ────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status:   botCrashed ? 'CRASHED' : botActive ? 'running' : 'stopped',
  version:  BOT_VERSION,
  model:    MODEL,
  testMode,
  sessions: sessions.size,
  uptime:   `${Math.floor(process.uptime()/3600)}h ${Math.floor(process.uptime()%3600/60)}m`,
  started:  new Date(BOT_START).toLocaleString('en-GH', { timeZone: 'Africa/Accra' }),
  queue: {
    active:          [...sessions.values()].filter(s => s.state === 'processing').length,
    awaiting_payment:[...sessions.values()].filter(s => s.state === 'awaiting_payment').length,
    ready:           [...sessions.values()].filter(s => s.state === 'ready').length,
  },
}));

// ── Dashboard ─────────────────────────────────────────────────

// ── Admin & Worker Dashboard HTML ────────────────────────────
function adminHTML() {
  return [
    '<!DOCTYPE html><html><head><meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Migo Admin</title>',
    '<style>',
    '*{margin:0;padding:0;box-sizing:border-box}',
    'body{background:#0f172a;color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;min-height:100vh;padding-bottom:70px}',
    /* Header */
    '.hd{background:#1e293b;border-bottom:1px solid #334155;padding:10px 16px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:100}',
    '.hd-left{display:flex;align-items:center;gap:10px}',
    '.hd-logo{font-size:18px}.hd-title{font-size:14px;font-weight:700;color:#f1f5f9}',
    '.hd-sub{font-size:10px;color:#64748b;margin-top:1px}',
    '.hd-dot{width:7px;height:7px;border-radius:50%;background:#10b981;animation:pulse 2s infinite}',
    '@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}',
    /* Stats bar */
    '.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:12px 14px}',
    '.stat{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:10px 12px;text-align:center}',
    '.stat-n{font-size:18px;font-weight:800;line-height:1.1}',
    '.stat-l{font-size:9px;color:#64748b;margin-top:3px;text-transform:uppercase;letter-spacing:.5px}',
    '.gr{color:#10b981}.bl{color:#3b82f6}.am{color:#f59e0b}.rd{color:#ef4444}',
    /* Content panels */
    '.panel{padding:0 14px;display:none}.panel.on{display:block}',
    /* Section headers inside panels */
    '.section-hd{display:flex;justify-content:space-between;align-items:center;padding:10px 0 8px}',
    '.section-hd h2{font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.6px}',
    /* Tables */
    '.tbl-wrap{background:#1e293b;border:1px solid #334155;border-radius:10px;overflow:hidden}',
    'table{width:100%;border-collapse:collapse;font-size:11px}',
    'th{background:#0f172a;padding:8px 10px;text-align:left;color:#64748b;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px}',
    'td{padding:9px 10px;border-bottom:1px solid #0f172a;vertical-align:middle}',
    'tr:last-child td{border-bottom:none}',
    'tr:hover td{background:#ffffff06}',
    /* Badges */
    '.badge{padding:3px 8px;border-radius:20px;font-size:10px;font-weight:700;white-space:nowrap}',
    '.bg-gr{background:#10b98118;color:#10b981}.bg-bl{background:#3b82f618;color:#3b82f6}',
    '.bg-am{background:#f59e0b18;color:#f59e0b}.bg-rd{background:#ef444418;color:#ef4444}',
    /* Buttons */
    '.btn{padding:5px 11px;border:none;border-radius:6px;cursor:pointer;font-size:11px;font-weight:700;white-space:nowrap}',
    '.btn-g{background:#10b981;color:#fff}.btn-b{background:#3b82f6;color:#fff}',
    '.btn-r{background:#ef4444;color:#fff}.btn-ghost{background:#334155;color:#94a3b8}',
    /* Worker form */
    '.w-form{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:12px;margin-bottom:10px;display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end}',
    '.w-form input{background:#0f172a;border:1px solid #334155;color:#f1f5f9;padding:7px 10px;border-radius:7px;font-size:11px;width:90px;flex:1;min-width:70px}',
    /* Bottom nav */
    '.nav{position:fixed;bottom:0;left:0;right:0;background:#1e293b;border-top:1px solid #334155;display:flex;z-index:100}',
    '.nav-item{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:8px 4px;cursor:pointer;color:#64748b;font-size:9px;font-weight:600;gap:3px;text-transform:uppercase;letter-spacing:.3px;border:none;background:none;transition:color .15s}',
    '.nav-item.on{color:#3b82f6}',
    '.nav-icon{font-size:18px;line-height:1}',
    '.nav-item.on .nav-icon{filter:drop-shadow(0 0 4px #3b82f6aa)}',
    /* Empty state */
    '.empty{text-align:center;padding:32px 16px;color:#475569}',
    '.empty-icon{font-size:36px;margin-bottom:8px}',
    '.empty-txt{font-size:12px}',
    /* Misc */
    '.fl{color:#ef4444}',
    /* Modal */
    '.modal{display:none;position:fixed;inset:0;background:#000a;z-index:999;align-items:center;justify-content:center}',
    '.modal-box{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:22px;width:92%;max-width:320px}',
    '.modal-box h3{font-size:14px;font-weight:700;margin-bottom:14px}',
    '.modal-box label{font-size:11px;color:#94a3b8;display:block;margin-bottom:4px}',
    '.modal-box input{width:100%;margin-bottom:12px;padding:9px 11px;background:#0f172a;border:1px solid #334155;color:#f1f5f9;border-radius:8px;font-size:13px}',
    '.modal-row{display:flex;gap:8px;margin-top:6px}',
    '.modal-row button{flex:1;padding:10px;border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer}',
    '.err{color:#ef4444;font-size:11px;min-height:16px;margin-bottom:4px}',
    '</style>',
    '</head><body>',
    /* Header */
    '<div class="hd">',
    '  <div class="hd-left">',
    '    <span class="hd-logo">🧾</span>',
    '    <div><div class="hd-title">Migo Print Shop</div><div class="hd-sub">Admin Dashboard</div></div>',
    '  </div>',
    '  <div style="display:flex;align-items:center;gap:10px">',
    '    <span class="hd-dot" title="Bot active"></span>',
    '    <button class="btn btn-ghost" onclick="logout()" style="font-size:10px;padding:5px 10px">Sign out</button>',
    '  </div>',
    '</div>',
    /* Cash Modal */
    '<div class="modal" id="cm"><div class="modal-box">',
    '<h3>💵 Confirm Cash Payment</h3>',
    '<p style="font-size:11px;color:#94a3b8;margin-bottom:6px">Customer: <b id="cm-phone" style="color:#f1f5f9"></b></p>',
    '<p style="font-size:11px;color:#94a3b8;margin-bottom:14px">Order total: <b id="cm-amt" style="color:#10b981"></b></p>',
    '<label>Amount received (blank = full total)</label>',
    '<input id="cm-custom" type="number" step="0.01" placeholder="e.g. 20.00">',
    '<label>Your PIN</label>',
    '<input id="cm-pin" type="password" placeholder="Enter your PIN" maxlength="6">',
    '<div class="err" id="cm-err"></div>',
    '<div class="modal-row">',
    '<button style="background:#334155;color:#94a3b8" onclick="closeCash()">Cancel</button>',
    '<button id="cm-btn" style="background:#10b981;color:#fff" onclick="confirmCash()">Confirm Cash</button>',
    '</div></div></div>',
    /* Stats bar */
    '<div class="stats">',
    `'<div class="stat"><div class="stat-n" id="sn">—</div><div class="stat-l">Active Jobs</div></div>',`,
    `'<div class="stat"><div class="stat-n gr" id="sm">—</div><div class="stat-l">MoMo Today</div></div>',`,
    `'<div class="stat"><div class="stat-n am" id="sc">—</div><div class="stat-l">Cash Today</div></div>',`,
    '</div>',
    testMode ? '<div style="background:#f59e0b;color:#000;text-align:center;padding:10px;font-weight:700;font-size:13px">🧪 TEST MODE ON — Bot only responding to owner number. Type: admin test off to disable.</div>' : '',
    /* Panels */
    '<div class="panel on" id="b0">',
    '  <div class="section-hd"><h2>🖨️ Live Job Queue</h2><button class="btn btn-ghost" onclick="lq()" style="font-size:10px">↻ Refresh</button></div>',
    '  <div class="tbl-wrap"><table><thead><tr><th>#</th><th>Customer</th><th>Status</th><th>Files</th><th>Bill</th><th>Pressing</th><th>Job ID</th><th>Action</th></tr></thead>',
    '  <tbody id="qb"></tbody></table></div>',
    '</div>',
    '<div class="panel" id="b1">',
    '  <div class="section-hd"><h2>💰 Payments</h2></div>',
    '  <div class="tbl-wrap"><table><thead><tr><th>Time</th><th>Customer</th><th>Amount</th><th>Type</th><th>Worker</th><th>Job ID</th></tr></thead>',
    '  <tbody id="pb"></tbody></table></div>',
    '</div>',
    '<div class="panel" id="b2">',
    '  <div class="section-hd"><h2>👷 Workers</h2></div>',
    '  <div class="w-form">',
    '    <input id="wi" placeholder="ID e.g. W04"><input id="wn" placeholder="Name"><input id="wp" placeholder="PIN">',
    '    <button class="btn btn-b" onclick="addW()">+ Add</button>',
    '  </div>',
    '  <div class="tbl-wrap"><table><thead><tr><th>ID</th><th>Name</th><th>Added</th><th></th></tr></thead>',
    '  <tbody id="wb"></tbody></table></div>',
    '</div>',
    '<div class="panel" id="b3">',
    '  <div class="section-hd"><h2>⭐ Customer Ratings</h2></div>',
    '  <div class="tbl-wrap"><table><thead><tr><th>Time</th><th>Rating</th><th>Job ID</th></tr></thead>',
    '  <tbody id="rb"></tbody></table></div>',
    '</div>',
    '<div class="panel" id="b4">',
    '  <div class="section-hd"><h2>🔍 Audit Log</h2></div>',
    '  <div class="tbl-wrap"><table><thead><tr><th>Time</th><th>Action</th><th>Customer</th><th>Detail</th></tr></thead>',
    '  <tbody id="ab"></tbody></table></div>',
    '</div>',
    /* Bottom nav */
    '<nav class="nav">',
    '<button class="nav-item on" id="n0" onclick="sw(0)"><span class="nav-icon">🖨️</span>Queue</button>',
    '<button class="nav-item" id="n1" onclick="sw(1)"><span class="nav-icon">💰</span>Payments</button>',
    '<button class="nav-item" id="n2" onclick="sw(2)"><span class="nav-icon">👷</span>Workers</button>',
    '<button class="nav-item" id="n3" onclick="sw(3)"><span class="nav-icon">⭐</span>Ratings</button>',
    '<button class="nav-item" id="n4" onclick="sw(4)"><span class="nav-icon">🔍</span>Audit</button>',
    '</nav>',
    '<script>',
    'var TK=localStorage.getItem("migo_token");',
    'if(!TK)window.location="/login";',
    'var cur=0;',
    'function sw(i){',
    '  document.querySelectorAll(".panel").forEach(function(x){x.classList.remove("on");});',
    '  document.querySelectorAll(".nav-item").forEach(function(x){x.classList.remove("on");});',
    '  document.getElementById("b"+i).classList.add("on");',
    '  document.getElementById("n"+i).classList.add("on");',
    '  cur=i;[lq,lp,lw,lr,la][i]();',
    '}',
    'function api(p,m,b){return fetch(p,{method:m||"GET",headers:{"Content-Type":"application/json","X-Dashboard-Token":TK},body:b?JSON.stringify(b):null}).then(function(r){return r.json();});}',
    'var bs={awaiting_payment:"bg-am",processing:"bg-bl",confirming:"bg-am",ready:"bg-gr",idle:"bg-rd"};',
    'function lq(){',
    '  api("/api/stats").then(function(st){',
    '    if(!st.ok)return;',
    '    document.getElementById("sn").textContent=st.sessions||0;',
    '    document.getElementById("sm").textContent="GHS "+st.todayMomo.toFixed(2);',
    '    document.getElementById("sc").textContent="GHS "+st.todayCash.toFixed(2);',
    '  });',
    '  api("/api/sessions").then(function(se){',
    '    if(!se.ok)return;',
    '    var r=(se.sessions||[]).map(function(s){',
    '      var btn="";',
    '      if(s.state==="processing")btn="<button class=\"btn btn-g\" onclick=\"rd(\'"+s.phone+"\')\">✅ Ready</button>";',
    '      if(s.state==="awaiting_payment")btn="<button class=\"btn btn-b\" onclick=\"showCash(\'"+s.phone+"\',"+( s.totalBill||0).toFixed(2)+")\">💵 Cash</button>";',
    '      var qp=s.queuePosition?"#"+s.queuePosition:"&mdash;";',
    '      return "<tr><td>"+qp+"</td><td>"+(s.customerName||s.phone)+"</td><td><span class=\"badge "+(bs[s.state]||"bl")+"\">"+ s.state+"</span></td><td>"+s.files+"</td><td>"+(s.totalBill?"GHS "+s.totalBill.toFixed(2):"&mdash;")+"</td><td style=\"font-size:10px\">"+(s.pressing||"&mdash;")+"</td><td style=\"font-size:10px\">"+(s.jobId||"&mdash;")+"</td><td>"+btn+"</td></tr>";',
    '    }).join("");',
    '    document.getElementById("qb").innerHTML=r||"<tr><td colspan=6 class=\"mt\">No active sessions</td></tr>";',
    '  });',
    '}',
    'function rd(phone){if(!confirm("Mark ready?"))return;api("/api/mark-ready","POST",{phone:phone}).then(lq);}',
    '/* ── Cash modal ── */',
    'var cashPhone="",cashAmt=0;',
    'function showCash(phone,amt){',
    '  cashPhone=phone;cashAmt=amt;',
    '  document.getElementById("cm-phone").textContent=phone;',
    '  document.getElementById("cm-amt").textContent="GHS "+amt.toFixed(2);',
    '  document.getElementById("cm-custom").value="";',
    '  document.getElementById("cm-pin").value="";',
    '  document.getElementById("cm-err").textContent="";',
    '  document.getElementById("cm").style.display="flex";',
    '  document.getElementById("cm-pin").focus();',
    '}',
    'function closeCash(){document.getElementById("cm").style.display="none";}',
    'function confirmCash(){',
    '  var customAmt=document.getElementById("cm-custom").value.trim();',
    '  var amount=customAmt?parseFloat(customAmt):cashAmt;',
    '  var pin=document.getElementById("cm-pin").value.trim();',
    '  if(!pin){document.getElementById("cm-err").textContent="Enter your PIN";return;}',
    '  if(isNaN(amount)||amount<=0){document.getElementById("cm-err").textContent="Invalid amount";return;}',
    '  document.getElementById("cm-btn").disabled=true;',
    '  document.getElementById("cm-btn").textContent="Processing...";',
    '  api("/api/cash-payment","POST",{phone:cashPhone,amount:amount,pin:pin}).then(function(r){',
    '    if(r.ok){closeCash();lq();alert("✅ Cash payment confirmed!");}',
    '    else{document.getElementById("cm-err").textContent=r.error||"Failed";document.getElementById("cm-btn").disabled=false;document.getElementById("cm-btn").textContent="Confirm Cash";}',
    '  }).catch(function(){document.getElementById("cm-err").textContent="Network error";document.getElementById("cm-btn").disabled=false;document.getElementById("cm-btn").textContent="Confirm Cash";});',
    '}',
    'function lp(){',
    '  api("/api/payments").then(function(d){',
    '    if(!d.ok)return;',
    '    var r=(d.payments||[]).slice().reverse().map(function(p){',
    '      return "<tr><td>"+(p.ts||p.date||"")+"</td><td>"+(p.phone||"")+"</td><td>GHS "+parseFloat(p.amount||0).toFixed(2)+"</td><td>"+(p.type||"")+"</td><td>"+(p.workerName||"auto")+"</td><td style=\"font-size:10px\">"+( p.jobId||"")+"</td></tr>";',
    '    }).join("");',
    '    document.getElementById("pb").innerHTML=r||"<tr><td colspan=6 class=\"mt\">No payments</td></tr>";',
    '  });',
    '}',
    'function lw(){',
    '  api("/api/workers").then(function(d){',
    '    if(!d.ok)return;',
    '    var r=(d.workers||[]).map(function(w){',
    '      return "<tr><td><b>"+w.id+"</b></td><td>"+w.name+"</td><td>"+(w.addedAt||"")+"</td><td><button class=\"btn btn-r\" onclick=\"rmW(\'"+w.id+"\')\">Remove</button></td></tr>";',
    '    }).join("");',
    '    document.getElementById("wb").innerHTML=r||"<tr><td colspan=4 class=\"mt\">No workers</td></tr>";',
    '  });',
    '}',
    'function addW(){',
    '  var id=document.getElementById("wi").value.toUpperCase().trim();',
    '  var name=document.getElementById("wn").value.trim();',
    '  var pin=document.getElementById("wp").value.trim();',
    '  if(!id||!name||!pin){alert("Fill all fields");return;}',
    '  api("/api/workers/add","POST",{id:id,name:name,pin:pin}).then(function(r){if(r.ok)lw();else alert(r.error||"Failed");});',
    '}',
    'function rmW(id){if(!confirm("Remove "+id+"?"))return;api("/api/workers/remove","POST",{id:id}).then(lw);}',
    'function lr(){',
    '  api("/api/ratings").then(function(d){',
    '    if(!d.ok)return;',
    '    var r=(d.ratings||[]).slice().reverse().map(function(rt){',
    '      var stars="";for(var i=0;i<rt.score;i++)stars+="★";',
    '      var col=rt.score<=2?"#ef4444":rt.score>=5?"#10b981":"#f59e0b";',
    '      return "<tr><td>"+(rt.ts||"")+"</td><td style=\"color:"+col+"\">"+stars+"</td><td style=\"font-size:10px\">"+(rt.jobId||"")+"</td></tr>";',
    '    }).join("");',
    '    document.getElementById("rb").innerHTML=r||"<tr><td colspan=3 class=\"mt\">No ratings</td></tr>";',
    '  });',
    '}',
    'function la(){',
    '  api("/api/audit").then(function(d){',
    '    if(!d.ok)return;',
    '    var r=(d.audit||[]).map(function(a){',
    '      return "<tr class=\""+(a.flag?"fl":"")+"\"><td>"+a.ts+"</td><td>"+(a.flag?"🚩 ":"")+a.action+"</td><td>"+(a.phone||"&mdash;")+"</td><td style=\"font-size:10px\">"+(a.detail||"")+"</td></tr>";',
    '    }).join("");',
    '    document.getElementById("ab").innerHTML=r||"<tr><td colspan=4 class=\"mt\">No entries</td></tr>";',
    '  });',
    '}',
    'function logout(){localStorage.removeItem("migo_token");window.location="/login";}',
    'lq();setInterval(lq,15000);',
    '<\/script></body></html>'
  ].join("");
}

function workerHTML() {
  return [
    '<!DOCTYPE html><html><head><meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Migo Worker</title>',
    '<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0f172a;color:#f1f5f9;font-family:Arial,sans-serif}',
    '.hd{background:#1e293b;border-bottom:2px solid #10b981;padding:12px 20px;display:flex;justify-content:space-between;align-items:center}',
    '.hd h1{font-size:15px;font-weight:700}.content{padding:14px}',
    'table{width:100%;border-collapse:collapse;font-size:11px}',
    'th{background:#1e293b;padding:7px;text-align:left;color:#64748b;font-weight:600}',
    'td{padding:9px 7px;border-bottom:1px solid #1e293b}',
    '.badge{padding:2px 7px;border-radius:10px;font-size:10px;font-weight:700}',
    '.gr{background:#10b98120;color:#10b981}.bl{background:#3b82f620;color:#3b82f6}.am{background:#f59e0b20;color:#f59e0b}',
    '.btn{padding:7px 12px;border:none;border-radius:5px;cursor:pointer;font-size:11px;font-weight:700}',
    '.btn-g{background:#10b981;color:#fff}.btn-r{background:#ef4444;color:#fff}.btn-b{background:#3b82f6;color:#fff}',
    '.mt{text-align:center;padding:30px;color:#334155}',
    '.modal{display:none;position:fixed;inset:0;background:#0009;z-index:999;align-items:center;justify-content:center}',
    '.modal-box{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:20px;width:90%;max-width:320px}',
    '.modal-box h3{font-size:14px;margin-bottom:12px}.modal-box label{font-size:11px;color:#94a3b8;display:block;margin-bottom:3px}',
    '.modal-box input{width:100%;margin:0 0 10px 0;padding:8px 10px;background:#0f172a;border:1px solid #334155;color:#f1f5f9;border-radius:7px;font-size:13px}',
    '.row{display:flex;gap:8px;margin-top:4px}.row button{flex:1;padding:9px;border:none;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer}',
    '.err{color:#ef4444;font-size:11px;margin-top:4px;min-height:16px}</style>',
    '</head><body>',
    '<div class="hd"><h1>Migo Print Shop &mdash; Worker View</h1>',
    '<button class="btn btn-r" onclick="logout()">Logout</button></div>',
    '<!-- Cash Modal -->',
    '<div class="modal" id="cm"><div class="modal-box">',
    '<h3>💵 Confirm Cash Payment</h3>',
    '<p style="font-size:11px;color:#94a3b8;margin-bottom:10px">Customer: <b id="cm-phone"></b></p>',
    '<p style="font-size:11px;color:#94a3b8;margin-bottom:12px">Total: <b id="cm-amt" style="color:#f1f5f9"></b></p>',
    '<label>Amount received (blank = full total)</label>',
    '<input id="cm-custom" type="number" step="0.01" placeholder="e.g. 20.00">',
    '<label>Your PIN</label>',
    '<input id="cm-pin" type="password" placeholder="4-digit PIN" maxlength="6">',
    '<div class="err" id="cm-err"></div>',
    '<div class="row"><button style="background:#334155;color:#f1f5f9" onclick="closeCash()">Cancel</button>',
    '<button id="cm-btn" style="background:#10b981;color:#fff" onclick="confirmCash()">Confirm Cash</button>',
    '</div></div></div>',
    '<div class="content"><table><thead><tr><th>Customer</th><th>State</th><th>Files</th><th>Bill</th><th>Job ID</th><th>Action</th></tr></thead>',
    '<tbody id="body"></tbody></table></div>',
    '<script>',
    'var TK=localStorage.getItem("migo_token");if(!TK)window.location="/login";',
    'var bs={awaiting_payment:"am",processing:"bl",confirming:"am",ready:"gr"};',
    'var cashPhone="",cashAmt=0;',
    'function load(){',
    '  fetch("/api/sessions",{headers:{"X-Dashboard-Token":TK}}).then(function(r){return r.json();}).then(function(d){',
    '    if(!d.ok){window.location="/login";return;}',
    '    var r=(d.sessions||[]).map(function(s){',
    '      var btn="";',
    '      if(s.state==="processing")btn="<button class=\"btn btn-g\" onclick=\"rdy(\'"+s.phone+"\')\">✅ Ready</button>";',
    '      if(s.state==="awaiting_payment")btn="<button class=\"btn btn-b\" onclick=\"showCash(\'"+s.phone+"\',"+( s.totalBill||0).toFixed(2)+")\">💵 Cash</button>";',
    '      return "<tr><td>"+(s.customerName||s.phone)+"</td><td><span class=\"badge "+(bs[s.state]||"bl")+"\">"+s.state+"</span></td><td>"+s.files+"</td><td>"+(s.totalBill?"GHS "+s.totalBill.toFixed(2):"&mdash;")+"</td><td style=\"font-size:10px\">"+(s.jobId||"&mdash;")+"</td><td>"+btn+"</td></tr>";',
    '    }).join("");',
    '    document.getElementById("body").innerHTML=r||"<tr><td colspan=6 class=\"mt\">No active orders</td></tr>";',
    '  });',
    '}',
    'function rdy(phone){',
    '  if(!confirm("Mark ready?"))return;',
    '  fetch("/api/mark-ready",{method:"POST",headers:{"Content-Type":"application/json","X-Dashboard-Token":TK},body:JSON.stringify({phone:phone})}).then(load);',
    '}',
    'function showCash(phone,amt){',
    '  cashPhone=phone;cashAmt=amt;',
    '  document.getElementById("cm-phone").textContent=phone;',
    '  document.getElementById("cm-amt").textContent="GHS "+amt.toFixed(2);',
    '  document.getElementById("cm-custom").value="";',
    '  document.getElementById("cm-pin").value="";',
    '  document.getElementById("cm-err").textContent="";',
    '  document.getElementById("cm").style.display="flex";',
    '  document.getElementById("cm-pin").focus();',
    '}',
    'function closeCash(){document.getElementById("cm").style.display="none";}',
    'function confirmCash(){',
    '  var customAmt=document.getElementById("cm-custom").value.trim();',
    '  var amount=customAmt?parseFloat(customAmt):cashAmt;',
    '  var pin=document.getElementById("cm-pin").value.trim();',
    '  if(!pin){document.getElementById("cm-err").textContent="Enter your PIN";return;}',
    '  if(isNaN(amount)||amount<=0){document.getElementById("cm-err").textContent="Invalid amount";return;}',
    '  document.getElementById("cm-btn").disabled=true;',
    '  document.getElementById("cm-btn").textContent="Processing...";',
    '  fetch("/api/cash-payment",{method:"POST",headers:{"Content-Type":"application/json","X-Dashboard-Token":TK},body:JSON.stringify({phone:cashPhone,amount:amount,pin:pin})})',
    '  .then(function(r){return r.json();}).then(function(r){',
    '    if(r.ok){closeCash();load();alert("✅ Cash confirmed!");}',
    '    else{document.getElementById("cm-err").textContent=r.error||"Failed";document.getElementById("cm-btn").disabled=false;document.getElementById("cm-btn").textContent="Confirm Cash";}',
    '  }).catch(function(){document.getElementById("cm-err").textContent="Network error";document.getElementById("cm-btn").disabled=false;document.getElementById("cm-btn").textContent="Confirm Cash";});',
    '}',
    'function logout(){localStorage.removeItem("migo_token");window.location="/login";}',
    'load();setInterval(load,15000);',
    '<\/script></body></html>'
  ].join("");
}

// ── Login HTML ───────────────────────────────────────────────
function dashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Migo Print Shop — Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f172a;color:#f1f5f9;font-family:Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:40px;width:360px;max-width:95vw}
h1{font-size:22px;font-weight:800;margin-bottom:4px}
.sub{color:#64748b;font-size:13px;margin-bottom:28px}
.tabs{display:flex;gap:8px;margin-bottom:20px}
.tab{flex:1;padding:8px;border:1px solid #334155;border-radius:8px;background:transparent;color:#94a3b8;cursor:pointer;font-size:13px;font-weight:600}
.tab.active{background:#3b82f6;color:#fff;border-color:#3b82f6}
label{display:block;font-size:12px;color:#94a3b8;margin-bottom:6px;font-weight:600}
input{width:100%;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#f1f5f9;font-size:14px;margin-bottom:14px}
input:focus{outline:none;border-color:#3b82f6}
button{width:100%;padding:12px;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer}
button:hover{background:#2563eb}
.err{color:#ef4444;font-size:13px;margin-top:10px;text-align:center}
</style></head><body>
<div class="card">
  <div style="text-align:center;margin-bottom:24px">
    <div style="font-size:40px">🧾</div>
    <h1>Migo Print Shop</h1>
    <div class="sub">Dashboard Login</div>
  </div>
  <div class="tabs">
    <button class="tab active" onclick="setTab('admin')">Admin</button>
    <button class="tab" onclick="setTab('worker')">Worker</button>
  </div>
  <div id="adminForm">
    <label>Admin Password</label>
    <input type="password" id="adminPw" placeholder="Enter password">
    <button onclick="loginAdmin()">Login as Admin</button>
  </div>
  <div id="workerForm" style="display:none">
    <label>Worker ID</label>
    <input type="text" id="wId" placeholder="e.g. W01">
    <label>Worker PIN</label>
    <input type="password" id="wPin" placeholder="4-digit PIN">
    <button onclick="loginWorker()">Login as Worker</button>
  </div>
  <div class="err" id="err"></div>
</div>
<script>
function setTab(t){
  document.getElementById('adminForm').style.display=t==='admin'?'block':'none';
  document.getElementById('workerForm').style.display=t==='worker'?'block':'none';
  document.querySelectorAll('.tab').forEach((b,i)=>b.classList.toggle('active',(i===0&&t==='admin')||(i===1&&t==='worker')));
}
async function loginAdmin(){
  const pw=document.getElementById('adminPw').value;
  const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});
  const d=await r.json();
  if(d.ok){localStorage.setItem('migo_token',d.token);localStorage.setItem('migo_role',d.role);window.location='/admin';}
  else document.getElementById('err').textContent='Wrong password';
}
async function loginWorker(){
  const wId=document.getElementById('wId').value.toUpperCase();
  const pin=document.getElementById('wPin').value;
  const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workerId:wId,pin})});
  const d=await r.json();
  if(d.ok){localStorage.setItem('migo_token',d.token);localStorage.setItem('migo_role',d.role);window.location='/worker';}
  else document.getElementById('err').textContent='Wrong Worker ID or PIN';
}
</script>
</body></html>`;
}

// ── Train page HTML ───────────────────────────────────────────
function trainHTML() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Migo — Train Bot</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f172a;color:#f1f5f9;font-family:Arial,sans-serif;min-height:100vh;padding:20px}
.wrap{max-width:700px;margin:0 auto}
h1{font-size:22px;font-weight:800;margin-bottom:4px}
.sub{color:#64748b;font-size:13px;margin-bottom:24px}
.card{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:24px;margin-bottom:20px}
h2{font-size:15px;font-weight:700;margin-bottom:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px}
textarea{width:100%;min-height:220px;padding:12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#f1f5f9;font-size:14px;line-height:1.6;resize:vertical}
textarea:focus{outline:none;border-color:#3b82f6}
.btn{padding:12px 24px;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;margin-top:12px}
.btn:hover{background:#2563eb}
.btn-red{background:#ef4444}.btn-red:hover{background:#dc2626}
.btn-sm{padding:6px 12px;font-size:12px;margin:0}
.result{margin-top:16px;padding:14px;background:#0f172a;border-radius:8px;font-size:13px;line-height:1.7;display:none}
.result.ok{border-left:4px solid #10b981}
.result.err{border-left:4px solid #ef4444}
.fact-list{list-style:none}
.fact-list li{display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid #1e293b;font-size:13px;line-height:1.5}
.fact-list li:last-child{border-bottom:none}
.fact-num{color:#64748b;min-width:24px;font-size:12px;padding-top:1px}
.fact-text{flex:1}
.hint{color:#64748b;font-size:12px;margin-top:8px;line-height:1.6}
.loading{color:#94a3b8;font-size:13px;margin-top:12px;display:none}
</style></head><body>
<div class="wrap">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
    <div>
      <h1>🧠 Train the Bot</h1>
      <div class="sub">Paste any list — Claude reads it and extracts the Q&As automatically</div>
    </div>
    <a href="/login" style="color:#64748b;font-size:13px;text-decoration:none">← Dashboard</a>
  </div>

  <!-- Paste area -->
  <div class="card">
    <h2>Paste your content</h2>
    <textarea id="content" placeholder="Paste anything — a list of questions and answers, FAQs, notes, any format:

Do you deliver?
No, collection only from our Circle branch.

Do you do sublimation?
No, DTF printing only.

How long does pressing take?
About 30 minutes after printing is done.

1. Do you accept JPEG?
   Yes, we accept JPG, PNG, and PDF.

Q: What payment methods do you accept?
A: MTN MoMo and cash at the counter."></textarea>
    <div class="hint">Any format works — numbered, dashed, Q:/A:, plain alternating lines, or paragraphs. Claude figures it out.</div>
    <button class="btn" onclick="trainBot()">📤 Extract & Save to Bot</button>
    <div class="loading" id="loading">⏳ Claude is reading your content...</div>
    <div class="result" id="result"></div>
  </div>

  <!-- Current knowledge base -->
  <div class="card">
    <h2>Current Knowledge Base (<span id="factCount">...</span> facts)</h2>
    <ul class="fact-list" id="factList"><li style="color:#64748b;font-size:13px">Loading...</li></ul>
  </div>
</div>

<script>
const TK = localStorage.getItem('migo_token');
if (!TK) window.location = '/login';

async function api(path, method, body) {
  const r = await fetch(path, {
    method: method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': TK },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

async function loadFacts() {
  const d = await api('/api/knowledge');
  if (!d.ok) return;
  document.getElementById('factCount').textContent = d.facts.length;
  const ul = document.getElementById('factList');
  if (d.facts.length === 0) {
    ul.innerHTML = '<li style="color:#64748b;font-size:13px">No facts yet. Paste content above to add some.</li>';
    return;
  }
  ul.innerHTML = d.facts.map((f, i) => \`
    <li>
      <span class="fact-num">\${i+1}</span>
      <span class="fact-text">\${f.replace(/</g,'&lt;')}</span>
      <button class="btn btn-red btn-sm" onclick="deleteFact(\${i})">✕</button>
    </li>
  \`).join('');
}

async function deleteFact(idx) {
  if (!confirm('Remove this fact?')) return;
  const d = await api('/api/knowledge/' + idx, 'DELETE');
  if (d.ok) loadFacts();
  else alert('Error: ' + d.error);
}

async function trainBot() {
  const content = document.getElementById('content').value.trim();
  if (!content) { alert('Please paste some content first.'); return; }
  document.getElementById('loading').style.display = 'block';
  document.getElementById('result').style.display = 'none';
  const d = await api('/api/train', 'POST', { content });
  document.getElementById('loading').style.display = 'none';
  const res = document.getElementById('result');
  if (d.ok) {
    res.className = 'result ok';
    res.innerHTML = '<strong>✅ ' + d.added.length + ' fact(s) added:</strong><br><br>' +
      d.added.map(f => '• ' + f.replace(/</g,'&lt;')).join('<br>') +
      '<br><br>Total facts in knowledge base: <strong>' + d.total + '</strong>';
    document.getElementById('content').value = '';
    loadFacts();
  } else {
    res.className = 'result err';
    res.innerHTML = '❌ ' + (d.error || 'Something went wrong.');
  }
  res.style.display = 'block';
}

loadFacts();
</script>
</body></html>`;
}

// ── Dashboard inline (no external file needed) ───────────────
// Basic dashboard routes built directly here
(function setupDashboard() {
  const SESSION_TOKENS = new Map();

  function authMiddleware(req, res, next) {
    const token = req.headers['x-dashboard-token'] || req.query.token;
    if (SESSION_TOKENS.has(token)) { req.role = SESSION_TOKENS.get(token).role; return next(); }
    res.status(401).json({ ok: false, error: 'Unauthorised' });
  }

  // Login
  app.post('/api/login', (req, res) => {
    const { password, workerId, pin } = req.body || {};
    if (password === ADMIN_DASH_PW) {
      const token = require('crypto').randomBytes(16).toString('hex');
      SESSION_TOKENS.set(token, { role: 'admin', ts: Date.now() });
      return res.json({ ok: true, token, role: 'admin' });
    }
    const w = workers.get(workerId);
    if (w && w.pin === pin) {
      const token = require('crypto').randomBytes(16).toString('hex');
      SESSION_TOKENS.set(token, { role: 'worker', workerId, ts: Date.now() });
      return res.json({ ok: true, token, role: 'worker', name: w.name });
    }
    res.json({ ok: false, error: 'Wrong credentials' });
  });

  // Stats
  app.get('/api/stats', authMiddleware, (req, res) => {
    const today = todayStr();
    const todayP = paymentLedger.filter(p => p.date === today);
    res.json({
      ok: true,
      sessions: sessions.size,
      todayMomo: todayP.filter(p=>p.type==='momo').reduce((s,p)=>s+p.amount,0),
      todayCash: todayP.filter(p=>p.type==='cash').reduce((s,p)=>s+p.amount,0),
      ratings: ratingsLog.slice(-20),
      flagged: auditLog.filter(a=>a.flag).slice(-20),
      workers: [...workers.entries()].map(([id,w])=>({id,name:w.name})),
    });
  });

  // Sessions list
  app.get('/api/sessions', authMiddleware, (req, res) => {
    const processingList = [...sessions.values()].filter(s => s.state === 'processing');
    const list = [...sessions.entries()].map(([key, s], idx) => {
      const qPos = s.state === 'processing'
        ? processingList.indexOf(s) + 1
        : null;
      return {
        phone: displayPhone(key), state: s.state,
        totalBill: s.totalBill, paymentReceived: s.paymentReceived,
        jobId: s.jobId, a4eq: s.a4eq, paused: s.paused,
        customerName: s.customerName,
        files: s.files?.length || 0,
        pressing: s.pressing ? `${s.pressing.shirts} shirts (${s.pressing.type}) — GHS ${(s.pressing.fee||0).toFixed(2)}` : null,
        queuePosition: qPos,
      };
    });
    res.json({ ok: true, sessions: list });
  });

  // Payment ledger
  app.get('/api/payments', authMiddleware, (req, res) => {
    res.json({ ok: true, payments: paymentLedger.slice(-100) });
  });

  // Audit log
  app.get('/api/audit', authMiddleware, (req, res) => {
    res.json({ ok: true, audit: auditLog.slice(-200) });
  });

  // Ratings
  app.get('/api/ratings', authMiddleware, (req, res) => {
    res.json({ ok: true, ratings: ratingsLog.slice(-100) });
  });

  // Workers
  app.get('/api/workers', authMiddleware, (req, res) => {
    const list = [...workers.entries()].map(([id,w])=>({id,name:w.name,addedAt:w.addedAt,addedBy:w.addedBy}));
    res.json({ ok: true, workers: list });
  });

  // Knowledge base
  app.get('/api/knowledge', authMiddleware, (req, res) => {
    res.json({ ok: true, facts: knowledgeBase });
  });

  // Delete a knowledge fact
  app.delete('/api/knowledge/:index', authMiddleware, (req, res) => {
    if (req.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin only' });
    const idx = parseInt(req.params.index);
    if (isNaN(idx) || idx < 0 || idx >= knowledgeBase.length)
      return res.json({ ok: false, error: 'Invalid index' });
    const removed = knowledgeBase.splice(idx, 1)[0];
    audit('KNOWLEDGE_DELETED', null, `"${removed.slice(0,80)}" via dashboard`);
    res.json({ ok: true, removed });
  });

  // Train — paste or upload any text, Claude extracts Q&As automatically
  app.post('/api/train', authMiddleware, async (req, res) => {
    if (req.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin only' });
    const { content } = req.body || {};
    if (!content || content.trim().length < 5)
      return res.json({ ok: false, error: 'No content provided' });

    let parsed = [];
    try {
      const r = await askClaude([{ role: 'user', content:
        `You are parsing a Q&A list for a DTF print shop knowledge base.\n` +
        `Extract all question-answer pairs and standalone facts from this text.\n` +
        `The format may be anything — numbered, dashed, plain, Q:/A:, paragraphs, etc.\n\n` +
        `TEXT:\n${content.slice(0, 4000)}\n\n` +
        `Return ONLY a valid JSON array. Each object: {"q":"question or null","a":"answer or fact"}\n` +
        `For standalone facts (no clear question): {"q":null,"a":"the fact"}\n` +
        `No markdown. No explanation. JSON only.`
      }], null, 1500, 20000);
      const raw = r.content.map(c => c.text || '').join('').trim().replace(/```json|```/g, '').trim();
      parsed = JSON.parse(raw);
    } catch(e) {
      console.error('Train endpoint Claude error:', e.message);
      return res.json({ ok: false, error: 'Could not parse content. Try a cleaner format.' });
    }

    if (!Array.isArray(parsed) || parsed.length === 0)
      return res.json({ ok: false, error: 'No facts extracted.' });

    const added = [];
    for (const item of parsed) {
      if (!item.a) continue;
      const fact = item.q ? `Q: ${item.q} A: ${item.a}` : item.a;
      knowledgeBase.push(fact);
      added.push(fact);
    }

    audit('KNOWLEDGE_TRAIN', null, `${added.length} facts added via dashboard train`);
    res.json({ ok: true, added, total: knowledgeBase.length });
  });

  // Train page HTML
  app.get('/train', (req, res) => { res.send(trainHTML()); });
  app.post('/api/cash-payment', authMiddleware, async (req, res) => {
    const { phone, amount, pin } = req.body || {};
    if (!phone || !amount || !pin) return res.json({ ok: false, error: 'Missing fields' });
    const workerId = req.role === 'worker'
      ? (SESSION_TOKENS.get(req.headers['x-dashboard-token'] || req.query.token)?.workerId || 'dashboard')
      : 'admin';
    const w = req.role === 'worker' ? workers.get(workerId) : null;
    const expectedPin = w ? w.pin : ADMIN_PIN;
    if (pin !== expectedPin) {
      audit('WRONG_PIN_DASHBOARD', phone, `Wrong PIN by ${workerId}`, true, workerId === 'admin' ? null : workerId);
      await alertOwner([
        `🚨 *WRONG PIN — DASHBOARD*`,
        `📱 Customer: ${phone}`,
        `👤 By: ${workerId}`,
        `⚠️ Possible theft attempt.`,
      ].join('\n'));
      return res.json({ ok: false, error: 'Wrong PIN — owner has been alerted.' });
    }
    const result = await processPayment(toWaId(phone), amount, 'cash', workerId, workerId === 'admin' ? null : workerId);
    if (result.status === 'confirmed' || result.status === 'partial') {
      return res.json({ ok: true, result });
    }
    return res.json({ ok: false, error: result.message || 'Payment failed' });
  });

  // Mark ready
  app.post('/api/mark-ready', authMiddleware, (req, res) => {
    const { phone } = req.body || {};
    if (!phone) return res.json({ ok: false, error: 'No phone' });
    const waId = toWaId(phone);
    const s = sessions.get(waId);
    if (!s) return res.json({ ok: false, error: 'No session' });
    s.state = 'ready'; clearTimers(waId);
    sendMsg(waId, buildReadyMsg(s.jobId)).catch(()=>{});
    audit('MARKED_READY', waId, `Via dashboard`);
    res.json({ ok: true });
  });

  // Worker management
  app.post('/api/workers/add', authMiddleware, (req, res) => {
    if (req.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin only' });
    const { id, name, pin } = req.body || {};
    if (!id || !name || !pin) return res.json({ ok: false, error: 'Missing fields' });
    workers.set(id, { name, pin, addedAt: nowStr(), addedBy: 'dashboard' });
    audit('ADD_WORKER', null, `${id} ${name} added via dashboard`);
    res.json({ ok: true });
  });

  app.post('/api/workers/remove', authMiddleware, (req, res) => {
    if (req.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin only' });
    const { id } = req.body || {};
    workers.delete(id);
    audit('REMOVE_WORKER', null, `${id} removed via dashboard`);
    res.json({ ok: true });
  });

  // Receipt endpoint
  app.get('/api/receipt/:jobId', (req, res) => {
    const entry = paymentLedger.find(p => p.jobId === req.params.jobId);
    if (!entry) return res.status(404).send('Receipt not found');
    res.send(buildReceiptHTML(entry));
  });

  // Dashboard HTML
  app.get('/admin', (req, res) => { res.send(adminHTML()); });
  app.get('/worker', (req, res) => { res.send(workerHTML()); });
    app.get('/login', (req, res) => {
    res.send(dashboardHTML());
    });
  app.get('/jobs', (req, res) => { res.redirect('/login'); });
  app.get('/dashboard', (req, res) => { res.redirect('/login'); });
})();

// ── Unhandled errors ──────────────────────────────────────────
process.on('unhandledRejection', async (reason) => {
  console.error('💥 Unhandled rejection:', reason);
  await alertOwner([
    `🔴 *UNHANDLED ERROR*`, ``,
    `${String(reason).slice(0, 200)}`, ``,
    `Bot may be unstable. Type: admin restart if needed.`,
  ].join('\n'));
});

// ── Start ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 MIGO Print Bot ${BOT_VERSION} — port ${PORT}`);
  console.log(`   WasenderAPI : ${WASENDER_KEY ? '✅ set' : 'NOT SET ❌'}`);
  console.log(`   Session     : ${WASENDER_SID}`);
  console.log(`   Anthropic   : ${ANTHROPIC_KEY ? '✅ set' : 'NOT SET ❌'}`);
  console.log(`   Model       : ${MODEL}`);
  console.log(`   Admin PIN   : ${ADMIN_PIN !== '1914' ? '✅ custom' : '⚠️  default 1914'}`);
  console.log(`   Owner       : +${OWNER_NUMBER}`);
  console.log(`   Webhook URL : https://dtf-print-bot.onrender.com/webhook`);

  schedule8pm();
  setInterval(runAutoArchive, 30 * 60 * 1000);

  await alertOwner([
    `✅ *Migo Bot ${BOT_VERSION} Started*`,
    `🕐 ${nowStr()}`,
    `🤖 Model: ${MODEL}`,
    `📱 WasenderAPI: Connected`,
    `⚙️ All systems running.`,
  ].join('\n'));
});
