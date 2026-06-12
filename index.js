// ============================================================
// MIGO DTF PRINT SHOP — WhatsApp Order Management Bot
// Version : v51
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
const fs        = require('fs');
const path      = require('path');
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

// ── Customer order-form (tap-to-choose) ───────────────────────
const BASE_URL = process.env.BASE_URL || process.env.PUBLIC_URL || 'https://dtf-print-bot.onrender.com';
function orderSig(payload) {
  return crypto.createHmac('sha256', 'migo-order-' + (process.env.ADMIN_DASHBOARD_PASSWORD || 'migo'))
    .update(payload).digest('hex').slice(0, 16);
}
function makeOrderToken(phone, ref) {
  const payload = Buffer.from(`${phone}:${ref}`).toString('base64url');
  return payload + '.' + orderSig(payload);
}
function parseOrderToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig || orderSig(payload) !== sig) return null;   // tamper / invalid
  try {
    const [phone, ref] = Buffer.from(payload, 'base64url').toString('utf8').split(':');
    if (!phone || !ref) return null;
    return { phone, ref: parseInt(ref, 10) };
  } catch (_) { return null; }
}
function orderFormLink(phone, order) {
  return `${BASE_URL}/order/${makeOrderToken(phone, order.ref)}`;
}
// Short, clean confirmation links: BASE_URL/c/<code> → opens the same form.
const shortIndex = new Map();   // shortCode -> { phone, ref }
function genShortCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c; do { c = Array.from({ length: 6 }, () => A[Math.floor(Math.random() * A.length)]).join(''); } while (shortIndex.has(c));
  return c;
}
function orderShortLink(phone, order) {
  if (!order.shortCode) order.shortCode = genShortCode();
  shortIndex.set(order.shortCode, { phone, ref: order.ref });
  return `${BASE_URL}/c/${order.shortCode}`;
}
// One row per design the customer sent (sized files keep their values; unsized start blank).
function ensureFormDesigns(order) {
  const rows = [];
  const push = (size, qty, url, name) => {
    const clean = String(name || '').replace(/\.[a-z0-9]+$/i, '').trim();
    rows.push({ label: clean || `Design ${rows.length + 1}`, name: name || '', size: size || null, qty: (qty != null ? qty : null), url: url || null });
  };
  const seq = order._designs || [];
  if (seq.length) {
    // Prefill each design from its FILENAME (the clear part); the customer adjusts on the form.
    seq.forEach(d => { const fp = parseSizeQty(d.filename || ''); push(fp.size, fp.qty, d.url, d.filename); });
    (order.pendingImages || []).forEach(p => push(null, null, p.url, p.name));
  } else {
    (order.files || []).forEach(f => push(f.size, f.qty || 1, f.sourceUrl, f.source));
    (order.pendingImages || []).forEach(p => push(null, null, p.url, p.name));
    (order.unknownFiles || []).forEach(p => push(null, null, p.url, p.name));
    (order.qtyPending || []).forEach(p => push(p.size, null, p.url, p.label));
  }
  if (!rows.length) push(null, null, null);
  order.formDesigns = rows;
  return rows;
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ── Model ─────────────────────────────────────────────────────
const MODEL = 'claude-opus-4-8';
// AI batch reader (reads ALL filenames+captions at once). Flip off with USE_AI_BATCH_READER=0.
const AI_BATCH_READER = process.env.USE_AI_BATCH_READER !== '0';
let _batchLLM = async (user, system) => gptText(await askGPT([{ role:'user', content:user }], system, 600, 15000));
function __setBatchLLM(fn){ _batchLLM = fn; }

const BOT_VERSION = 'v73';
const SILENCE_MS  = parseInt(process.env.RECEIVE_SILENCE_MS, 10) || 60000;
const ASK_DONE_MS = parseInt(process.env.ASK_DONE_MS, 10) || 60000;
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
// Greeting → mirror warmly and stop. Nothing more.
function isGreeting(msg) {
  return /^\s*(hi+|hello+|hey+|good\s*(morning|afternoon|evening|night|day)|howdy|greetings|sup|what'?s up|yo\b|hy|helo|holla|morning|afternoon|evening|night|how are you|how r u)\b/i.test((msg||'').trim());
}
function greetingReply(msg) {
  const m = (msg||'').trim();
  if (/good\s*morning/i.test(m)) return `Good morning! 😊`;
  if (/good\s*afternoon/i.test(m)) return `Good afternoon! 😊`;
  if (/good\s*evening/i.test(m)) return `Good evening! 😊`;
  if (/good\s*night/i.test(m)) return `Good night! 😊`;
  if (/good\s*day/i.test(m)) return `Good day! 😊`;
  return `Hi! 👋`;
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
// ── Random fallback phrases ───────────────────────────────────
const FALLBACK_PHRASES = [
  `Please give me a minute. 🙏`,
  `I'll get back to you shortly. 🙏`,
  `One moment please. 🙏`,
  `Bear with me a moment. 🙏`,
  `Just a moment. 🙏`,
  `Please hold on. 🙏`,
  `I beg, a go get back to you soon boss. 🙏`,
  `Give me small time boss. 🙏`,
  `I dey come. 🙏`,
  `Small small, I go sort you out. 🙏`,
  `Hold on boss, I dey on it. 🙏`,
  `I beg, one minute. 🙏`,
];
function randomPhrase() {
  return FALLBACK_PHRASES[Math.floor(Math.random() * FALLBACK_PHRASES.length)];
}

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

// ── Outbound send queue ───────────────────────────────────────
// WasenderAPI account protection allows only 1 message every 5 seconds.
// ALL outbound messages (customer + owner) flow through ONE FIFO queue
// that spaces sends ~6s apart and retries on HTTP 429, so nothing is
// silently dropped. Enqueue resolves immediately (fire-and-forget) so
// webhook handlers never hang waiting for the queue to drain.
const SEND_GAP_MS      = 6000;   // safe margin over WasenderAPI's 1-per-5s rule
const MAX_SEND_RETRIES = 4;
const sendQueue        = [];
let   sendQueueRunning = false;
let   nextSendAt       = 0;

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
// ── Persistent state (survives restarts when DATA_DIR is on a Render disk) ──
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'migo-state.json');

function saveStateNow() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const state = {
      v: 1,
      savedAt: new Date().toISOString(),
      sessions:          [...sessions.entries()],
      workers:           [...workers.entries()],
      paymentLedger,
      knowledgeBase,
      jobCounters,
      confirmedPayments,
      auditLog:  auditLog.slice(-500),
      ratingsLog: ratingsLog.slice(-500),
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(state));
  } catch (e) { console.error('💾 save error:', e.message); }
}

let _saveTimer = null;
function saveState() { // debounced — coalesces rapid changes
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => { _saveTimer = null; saveStateNow(); }, 2000);
}

function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) { console.log('💾 No saved state — starting fresh.'); return; }
    const s = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(s.sessions)) for (const [k, v] of s.sessions) {
      if (v && v.orders) for (const o of v.orders) {
        if (o && o.readyTime) o.readyTime = new Date(o.readyTime);
        if (o && o.shortCode) shortIndex.set(o.shortCode, { phone: k, ref: o.ref });
      }
      sessions.set(k, v);
    }
    if (Array.isArray(s.workers))           for (const [k, v] of s.workers) workers.set(k, v);
    if (Array.isArray(s.paymentLedger))     paymentLedger.push(...s.paymentLedger);
    if (Array.isArray(s.knowledgeBase))     knowledgeBase.push(...s.knowledgeBase);
    if (s.jobCounters)                      Object.assign(jobCounters, s.jobCounters);
    if (Array.isArray(s.confirmedPayments)) confirmedPayments.push(...s.confirmedPayments);
    if (Array.isArray(s.auditLog))          auditLog.push(...s.auditLog);
    if (Array.isArray(s.ratingsLog))        ratingsLog.push(...s.ratingsLog);
    console.log(`💾 State restored: ${sessions.size} session(s), ${paymentLedger.length} payment(s). Last saved ${s.savedAt}`);
  } catch (e) { console.error('💾 load error:', e.message); }
}

// ── WhatsApp session health monitor ───────────────────────────
let consecutiveSendFails = 0;
let sessionDownAlerted   = false;

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
// Low-level HTTP POST to WasenderAPI. Resolves { status, body, retryAfter }.
function rawSend(toPhone, body) {
  const payload = JSON.stringify({ to: toPhone, text: body });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'www.wasenderapi.com',
      path:     '/api/send-message',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Authorization':  `Bearer ${WASENDER_KEY}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        let retryAfter = null;
        if (res.statusCode === 429) {
          const hdr = parseInt(res.headers['retry-after'], 10);
          if (!isNaN(hdr)) retryAfter = hdr;
          else { try { const j = JSON.parse(data); retryAfter = j.retry_after || j.retryAfter || null; } catch (_) {} }
        }
        resolve({ status: res.statusCode, body: data, retryAfter });
      });
    });
    req.on('error', (err) => resolve({ status: 0, body: err.message, retryAfter: null }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, body: 'timeout', retryAfter: null }); });
    req.write(payload);
    req.end();
  });
}

// Drains the outbound queue, spacing sends ≥ SEND_GAP_MS apart and retrying 429s.
async function processSendQueue() {
  if (sendQueueRunning) return;
  sendQueueRunning = true;
  try {
    while (sendQueue.length) {
      const waitMs = nextSendAt - Date.now();
      if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));

      const job = sendQueue[0]; // peek — keep at front until done
      const result = await rawSend(job.toPhone, job.body);

      if (result.status === 429 && job.attempts < MAX_SEND_RETRIES) {
        job.attempts++;
        const backoffSec = result.retryAfter && result.retryAfter > 0 ? result.retryAfter : 6;
        nextSendAt = Date.now() + (backoffSec * 1000);
        console.error(`⏳ WA 429 — retry ${job.attempts}/${MAX_SEND_RETRIES} for ${displayPhone(job.waId)} in ${backoffSec}s`);
        continue; // leave job at front, retry after backoff
      }

      sendQueue.shift(); // remove — delivered or permanently failed
      nextSendAt = Date.now() + SEND_GAP_MS;

      if (result.status === 200 || result.status === 201) {
        console.log(`✅ WA sent to ${displayPhone(job.waId)}: "${job.body.slice(0, 50)}"`);
        if (sessionDownAlerted) {
          sessionDownAlerted = false;
          alertOwner(`✅ WhatsApp sending recovered — Migo bot back to normal.`).catch(() => {});
        }
        consecutiveSendFails = 0;
      } else {
        console.error(`❌ WA error ${result.status}: ${String(result.body).slice(0, 100)}`);
        // Non-owner failures are the signal that the WhatsApp session may be dead
        if (job.waId !== toWaId(OWNER_NUMBER) && result.status !== 429) {
          consecutiveSendFails++;
          alertOwner(`⚠️ Message send failed to ${displayPhone(job.waId)}: HTTP ${result.status}`).catch(() => {});
          if (consecutiveSendFails >= 3 && !sessionDownAlerted) {
            sessionDownAlerted = true;
            alertOwner([
              `🔴 *WHATSAPP SESSION MAY BE DOWN*`, ``,
              `${consecutiveSendFails} messages failed in a row.`,
              `Check WasenderAPI — the WhatsApp session may have disconnected`,
              `(phone offline, or logged out).`,
            ].join('\n')).catch(() => {});
          }
        }
      }
    }
  } finally {
    sendQueueRunning = false;
  }
}

// Enqueue a message. Resolves immediately (fire-and-forget); queue delivers in background.
function enqueueSend(waId, toPhone, body) {
  sendQueue.push({ waId, toPhone, body, attempts: 0 });
  processSendQueue();
  return Promise.resolve();
}

async function sendMsg(to, body) {
  const waId    = to.includes('@') ? to : toWaId(to);
  const toPhone = waId.replace('@s.whatsapp.net', '').replace('@c.us', '');
  logMsg(waId, 'out', body);
  return enqueueSend(waId, toPhone, body);
}

async function alertOwner(body) {
  const waId    = toWaId(OWNER_NUMBER);
  const toPhone = waId.replace('@s.whatsapp.net', '').replace('@c.us', '');
  logMsg(waId, 'out', body);
  return enqueueSend(waId, toPhone, body);
}

// ── Claude — all calls use MODEL ─────────────────────────────
async function askGPT(messages, system, maxTokens = 400, timeoutMs = 15000) {
  const opts = { model: MODEL, max_tokens: maxTokens, messages };
  if (system) opts.system = system;
  return Promise.race([
    anthropic.messages.create(opts),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Claude timeout')), timeoutMs)),
  ]);
}

function gptText(r) {
  return (r?.content?.map(c => c.text || '').join('') || '').trim();
}

// ── GPT Full Control Engine ───────────────────────────────────
// GPT-5.5 reads the entire conversation and decides what to do.
// Returns structured JSON: { reply, action, files, pressing }

function buildMasterSystem(session) {
  const order = getActiveOrder(session);
  const kb = knowledgeBase.length > 0
    ? `\n\nSHOP KNOWLEDGE BASE:\n${knowledgeBase.map((f,i)=>`${i+1}. ${f}`).join('\n')}`
    : '';

  const filesReceived = order.files.length > 0
    ? `\nFILES ALREADY COLLECTED:\n${order.files.map((f,i)=>
        `  ${i+1}. ${f.name||'file'} → Size: ${f.size||'?'}, Qty: ${f.qty||'?'}`
      ).join('\n')}`
    : '';

  const pendingFiles = order.pendingImages.length > 0
    ? `\nFILES WAITING FOR SIZE/QTY:\n${order.pendingImages.map((f,i)=>
        `  ${i+1}. ${f.caption||f.url?.split('/').pop()||'image'} (mediaType: ${f.mediaType||'image'})`
      ).join('\n')}`
    : '';

  const unknownFiles = order.unknownFiles.length > 0
    ? `\nFILES WITH UNKNOWN SIZE:\n${order.unknownFiles.map((f,i)=>
        `  ${i+1}. ${f.name||'file'}`
      ).join('\n')}`
    : '';

  const currentBill = order.totalBill
    ? `\nCURRENT BILL: GHS ${order.totalBill.toFixed(2)}`
    : '';

  const customerName = session.customerName
    ? `\nCUSTOMER NAME: ${session.customerName}. Use their name naturally.`
    : '';

  const orderRef = order.ref > 1 ? `\nCURRENT ORDER: #${order.ref} for today` : '';

  return `You are the AI brain for Migo Print Shop WhatsApp bot. You have FULL CONTROL of this conversation.

SHOP INFO:
- Name: Migo Print Shop
- Location: Circle branch, near Benz Gate, Calvary Church side, Accra, Ghana
- Service: DTF sheet printing ONLY
- Payment: MTN MoMo 0552719245 (Kow Habib Baisie) or cash at shop
- Hours: Open Mon–Sun, orders accepted anytime${customerName}${orderRef}

PRICING (NEVER guess or change these):
- A4 sheet = GHS 3.20
- A3 sheet = GHS 6.40
- A2 sheet = GHS 16.00
- Pressing: calculated per order — do NOT quote rates to customers${filesReceived}${pendingFiles}${unknownFiles}${currentBill}${kb}

YOUR RESPONSIBILITIES:
1. Read the ENTIRE conversation history before responding
2. Understand what files have been sent and what sizes/quantities were given
3. When ALL files have size and quantity → set action="send_bill" with the files array
4. If files are waiting for size/qty → ask clearly, set action="ask_size_qty"
5. Answer FAQs about location, prices, hours, MoMo number directly
6. If customer mentions cash/no MoMo → say exactly: "Printing can only start after Payment Confirmation. Thank you."
7. For ANY greeting (hi, hello, good morning, afernon, morning, yoo man, whatsup, etc — even misspelled or informal) → reply with the SHORTEST possible warm response. Just 1-3 words + emoji. e.g. Hi! 👋 or Good morning! 😊. Nothing more. Do NOT add DTF prompt. Do NOT greet twice — if you already greeted, move the conversation forward instead.
7b. If the customer names the service or signals they want to print (e.g. "dtf", "printing", "print", "migo", "I want to print") but has NOT sent a file yet → reply ONCE, briefly: "Sure! 😊 Send your design and tell me the size (A4/A3/A2) and how many copies." Treat this as intent to order, NOT a greeting.
8. If you cannot answer → say "Let me get someone to assist you shortly."
9. AUDIT your response before returning — make sure sizes, quantities and prices are 100% correct
10. NEVER swap sizes between files. Image 1 = first file mentioned, Image 2 = second file, etc.
11. NEVER ask for information the customer already gave. If they said "one", "5 copies", "ten pieces" — use it. Do not ask again. If the customer gives a blanket size like "all are A3" or "make them all A4 10 copies", apply it to EVERY file they sent. If every file has a size AND quantity, proceed to the bill. If any file has a known size but the quantity is missing, set action="ask_size_qty" — do NOT assume a quantity, and NEVER escalate to a human or say the order is "too complex" just because quantities are missing.
12. If customer ONLY asks about prices (how much, price, cost etc.) → give prices and STOP. Never push for an order after a price enquiry.
13. Read filenames and captions carefully to extract size and quantity. "A3_5copies.png" means A3×5. "A2 13COPIES.png" means A2×13. Use this — never ignore filename info.

BILL CALCULATION RULES (when action=send_bill):
- List every file with its size and qty in the files array
- The code will calculate the exact price — you do NOT calculate
- Only set send_bill when you are 100% sure all files have size AND quantity

RESPONSE FORMAT — return ONLY valid JSON, no markdown, no explanation:
{
  "reply": "your message to the customer",
  "action": "none | send_bill | ask_size_qty | cannot_answer",
  "files": [{"size":"A4","qty":10},{"size":"A3","qty":5}],
  "pressing": null,
  "customerName": null
}

- files: array of all files with confirmed size+qty. Empty [] if not ready.
- pressing: {"shirts":5,"type":"front","largeArtwork":false} or null
- customerName: extracted name if customer mentioned it, or null
- action "send_bill": only when files array has ALL files with size+qty confirmed
- action "none": normal conversation, no bill yet
- action "ask_size_qty": waiting for size/qty from customer
- action "cannot_answer": escalate to human

STYLE: Warm, professional, clear British English. Short and direct. Never say you are AI.`;

}

function addToHistory(s, role, content) {
  s.chatHistory.push({ role, content });
  if (s.chatHistory.length > 60) s.chatHistory = s.chatHistory.slice(-60);
}

async function gptDecide(msg, session, extraContext) {
  // Add current message to history
  if (msg) addToHistory(session, 'user', msg);
  if (extraContext) addToHistory(session, 'user', extraContext);

  try {
    const system = buildMasterSystem(session);
    const r = await askGPT(session.chatHistory, system, 600, 20000);
    const raw = gptText(r).replace(/```json|```/g, '').trim();

    let decision;
    try {
      decision = JSON.parse(raw);
    } catch(e) {
      // GPT returned plain text — treat as reply with no action
      return { reply: raw || null, action: 'none', files: [], pressing: null, customerName: null };
    }

    // Capture customer name if GPT found it
    if (decision.customerName && decision.customerName.length > 1 && !session.customerName) {
      session.customerName = decision.customerName;
      audit('NAME_CAPTURED', session.phone, decision.customerName);
    }

    // Log to history
    if (decision.reply) addToHistory(session, 'assistant', decision.reply);

    // Escalate to human ONLY for genuine non-order questions.
    // If the customer is mid-order (files/images in play), never ping the owner —
    // fall back to the deterministic enumerated question instead.
    if (decision.action === 'cannot_answer') {
      const o = getActiveOrder(session);
      const midOrder = (o?.pendingImages?.length > 0) || (o?.unknownFiles?.length > 0)
                    || (o?.qtyPending?.length > 0) || (o?.state === 'asking_qty')
                    || (o?.files?.length > 0 && !['processing','ready'].includes(o.state));
      if (midOrder) {
        if (o?.qtyPending?.length > 0 || o?.state === 'asking_qty') {
          decision.action = 'ask_size_qty';
          decision.reply = buildQtyQuestion(o);
        } else {
          decision.action = 'ask_size_qty';
          decision.reply = buildImageQuestion(session);
        }
      } else {
        await alertOwner([
          `❓ *BOT CANNOT ANSWER*`,
          `📱 Customer: ${displayPhone(session.phone)}`,
          `💬 Question: "${(msg||'').slice(0, 100)}"`,
          ``,
          `Use: admin W01 override ${last4(session.phone)} Your reply`,
          `Or: admin W01 pause ${last4(session.phone)} to take over`,
        ].join('\n')).catch(()=>{});
      }
    }

    return decision;
  } catch(e) {
    console.error('GPT decide error:', e.message);
    return { reply: null, action: 'none', files: [], pressing: null, customerName: null };
  }
}

// ── Session ───────────────────────────────────────────────────
// ── Session & Order Management ────────────────────────────────
// Each phone has a customer record with multiple orders
// Orders are numbered 1,2,3... per phone per day (unpaid)
// Job ID only assigned after payment confirmed

function getDayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
}

function makeOrder(ref) {
  return {
    ref,                    // 1, 2, 3... per phone per day
    dayKey: getDayKey(),
    state: 'idle',          // idle|receiving|asked_done|asking_image_info|asking_pressing|awaiting_payment|processing|ready
    files: [],
    unknownFiles: [],
    pendingImages: [],
    totalBill: null,
    a4eq: 0,
    paymentReceived: 0,
    jobId: null,
    readyTime: null,
    pressing: null,
    askedPressing: false,
    pressingMentioned: false,
    billSentAt: null,       // timestamp when bill was sent
    confirmedFiles: [],
    overdueReminders: 0,
    qtyPending: [],         // items with known size but missing copy count (await customer reply, 5-min timeout)
    assumedQtyCount: 0,     // how many copies were assumed=1 on timeout (drives the "I assumed 1 copy" note)
    ratingAsked: false,
    ratingGiven: false,
    pendingTxId: null,
    pendingTxAmount: null,
    awaitingTxId: false,
    confirmedTxId: null,
    servedBy: null,
  };
}

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      phone,
      customerName: null,
      chatHistory: [],
      paused: false,
      pausedAt: null,
      isFirstTime: true,
      lastActivity: Date.now(),
      orders: [makeOrder(1)],
      activeRef: 1,
      dayKey: getDayKey(),
      unansweredCount: 0,      // counts messages with no bot response
      silenceNoticeSent: false, // true after first silence notice sent
    });
  }
  const s = sessions.get(phone);
  // Reset order numbering if new day
  if (s.dayKey !== getDayKey()) {
    s.dayKey = getDayKey();
    s.activeRef = 1;
    // Keep completed orders, start fresh active
    s.orders = s.orders.filter(o => o.state === 'processing' || o.state === 'ready');
    if (!s.orders.find(o => o.ref === 1 && o.dayKey === getDayKey())) {
      s.orders.push(makeOrder(1));
      s.activeRef = 1;
    }
  }
  return s;
}

// Get the current active order for a session
function getActiveOrder(session) {
  return session.orders.find(o => o.ref === session.activeRef) || session.orders[session.orders.length - 1];
}

// Compatibility helpers — get order properties from session
// Lets admin/dashboard code use s.state, s.jobId etc.
function sessState(s) {
  const o = getActiveOrder(s);
  // If there's a processing/ready order, surface that state
  const proc = s.orders.find(o => o.state === 'processing');
  const ready = s.orders.find(o => o.state === 'ready');
  if (ready) return 'ready';
  if (proc) return 'processing';
  return o?.state || 'idle';
}
function sessJobId(s) {
  const proc = s.orders.find(o => o.state === 'processing' || o.state === 'ready');
  return proc?.jobId || getActiveOrder(s)?.jobId || null;
}
function sessTotalBill(s) { return getActiveOrder(s)?.totalBill || null; }
function sessFiles(s) { return getActiveOrder(s)?.files || []; }
function sessA4eq(s) { return getActiveOrder(s)?.a4eq || 0; }

// Get next order ref for this phone (for this day)
function nextOrderRef(session) {
  const dayOrders = session.orders.filter(o => o.dayKey === getDayKey());
  return dayOrders.length + 1;
}

// Start a new order for this session
function startNewOrder(session) {
  const ref = nextOrderRef(session);
  const order = makeOrder(ref);
  session.orders.push(order);
  session.activeRef = ref;
  return order;
}

// Find an awaiting_payment order for this phone
function getPendingOrder(session) {
  return session.orders.find(o => o.state === 'awaiting_payment');
}

// Check if bot should be silent (human handling)
function isBotSilenced(session) {
  return session.paused === true;
}

// Silence bot and alert owner
async function silenceBot(phone, session, reason) {
  session.paused = true;
  session.pausedAt = Date.now();
  clearTimers(phone);
  await alertOwner([
    `🔕 *BOT SILENCED — HUMAN NEEDED*`,
    `📱 Customer: ${displayPhone(phone)}`,
    `👤 Name: ${session.customerName || 'Unknown'}`,
    `❓ Reason: ${reason}`,
    ``,
    `Use: admin W01 resume ${last4(phone)} — to hand back to bot`,
    `Or reply directly to the customer.`,
  ].join('\n')).catch(() => {});
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

    // Find the awaiting_payment order
    const matchedOrder = matched.orders?.find(o => o.state === 'awaiting_payment');
    if (!matchedOrder) {
      const last = matched.orders?.[matched.orders.length - 1];
      const st = last?.state || 'none';
      const hint = (st === 'processing' || st === 'ready') ? ' (already paid)'
                 : ['idle','receiving','asked_done','asking_image_info','asking_pressing','asking_qty','confirming'].includes(st) ? ' — no bill sent yet'
                 : '';
      return { status: 'no_match', message: `No order awaiting payment. Last order: ${st}${hint}.` };
    }

    const workerName = workerId ? (workers.get(workerId)?.name || workerId) : null;

    if (type === 'cash') {
      const expectedTotal = matchedOrder.totalBill || 0;
      if (paid > expectedTotal + 0.01) {
        audit('SUSPICIOUS_CASH', matchedKey,
          `Cash GHS ${paid.toFixed(2)} > order GHS ${expectedTotal.toFixed(2)} — ${workerName || confirmedBy}`,
          true, workerId);
      }
      await alertOwner([
        `💵 *CASH PAYMENT RECORDED*`, ``,
        `📱 Customer: ${displayPhone(matchedKey)}`,
        `💰 Amount:   GHS ${paid.toFixed(2)}`,
        `🔖 Order:    #${matchedOrder.ref}`,
        `👤 Worker:   ${workerName || confirmedBy} (${workerId || '—'})`,
        `🕐 Time:     ${nowStr()}`,
      ].join('\n'));
      audit('CASH_PAYMENT', matchedKey, `GHS ${paid.toFixed(2)} — ${workerName || confirmedBy}`, false, workerId);
    } else {
      audit('MOMO_PAYMENT', matchedKey, `GHS ${paid.toFixed(2)} — ${confirmedBy}`, false, workerId);
    }

    matchedOrder.paymentReceived = (matchedOrder.paymentReceived || 0) + paid;
    balance = exactBalance !== null ? exactBalance
      : Math.max(0, (matchedOrder.totalBill || 0) - matchedOrder.paymentReceived);

    const ledgerEntry = {
      ts: nowStr(), date: todayStr(),
      phone: displayPhone(matchedKey),
      jobId: matchedOrder.jobId || '—',
      amount: paid, type, balance,
      confirmedBy: workerId
        ? `${workers.get(workerId)?.name || workerId} (${workerId})`
        : confirmedBy,
      workerId: workerId || null,
      workerName: workerName || null,
      txId: matchedOrder.confirmedTxId || null,
      files: [...(matchedOrder.confirmedFiles || []), ...(matchedOrder.files || [])],
    };
    paymentLedger.push(ledgerEntry);
    saveState(); // money recorded — persist right away

    if ((matchedOrder.totalBill || 0) - matchedOrder.paymentReceived <= 0.01) {
      const overpaid = matchedOrder.paymentReceived - (matchedOrder.totalBill || 0);

      matchedOrder.confirmedFiles = [...(matchedOrder.confirmedFiles||[]), ...matchedOrder.files];
      matchedOrder.files = []; matchedOrder.paymentReceived = 0; matchedOrder.totalBill = null;
      matchedOrder.state = 'processing';
      const jobId = generateJobId(matchedKey);
      matchedOrder.jobId = jobId;
      matchedOrder.readyTime = new Date(Date.now() + (getReadyHours(matchedOrder.a4eq || 0) || 24) * 3600000);
      matchedOrder.overdueReminders = 0;

      // Start next order for this customer (ready for new files)
      if (!matched.orders.find(o => o.state === 'idle' || o.state === 'receiving')) {
        startNewOrder(matched);
      }

      clearTimers(matchedKey);
      ledgerEntry.jobId = jobId;
      const readyAt = readyTimeText(matchedOrder.a4eq || 0);

      addToHistory(matched, 'assistant',
        `Payment confirmed via ${type}. Job ID: ${jobId}. Ready by ${readyAt}.${overpaid > 0.01 ? ` GHS ${overpaid.toFixed(2)} overpaid.` : ''}`);

      // Unpause bot if it was silenced (human finished, new order can start)
      matched.paused = false;
      matched.pausedAt = null;
      matched.silenceNoticeSent = false;
      const workerLine = (type === 'cash' && workerName)
        ? `\n👤 Served by: *${workerName}* at Migo Print Shop` : '';

      // Queue position — count jobs already processing before this one
      const jobsAhead = [...sessions.values()].filter(s => s.orders?.some(o=>o.state==='processing') && s.orders?.some(o=>o.jobId&&o.jobId!==jobId)).length;
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

      scheduleWorkerReminders(matchedKey, matchedOrder, jobId);

      // S16: Sunday small order — alert owner to decide, no message to customer
      const { isSunday } = shopStatus();
      if (isSunday && (matchedOrder.a4eq || 0) < 200) {
        alertOwner([
          `📅 *SUNDAY SMALL ORDER — PAYMENT RECEIVED*`,
          ``,
          `📱 Customer: ${displayPhone(matchedKey)}`,
          `🔖 Job ID:   ${jobId}`,
          `💰 Amount:   GHS ${paid.toFixed(2)}`,
          `🖨 Size:     ${matchedOrder.a4eq} A4-equivalent sheets`,
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
      const remaining = (matchedOrder.totalBill || 0) - matchedOrder.paymentReceived;
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
  // TxID match — check pending orders
  if (txId) {
    for (const [key, s] of sessions.entries()) {
      const order = s.orders?.find(o => o.pendingTxId === txId);
      if (order) return { match: 'txid', key, session: s, order };
    }
  }
  const candidates = [];
  for (const [key, s] of sessions.entries()) {
    const order = s.orders?.find(o => o.state === 'awaiting_payment');
    if (!order) continue;
    const balance = Math.max(0, (order.totalBill || 0) - (order.paymentReceived || 0));
    if (amount > 0 && amount <= balance * 1.5 + 0.01)
      candidates.push({ key, session: s, order, balance });
  }
  if (candidates.length === 0) return { match: 'none' };
  if (candidates.length === 1) return { match: 'amount', ...candidates[0] };
  const ref = (reference || '').replace(/[\s\-]/g, '').toUpperCase();
  if (ref && ref !== '0') {
    for (const { key, session: s, order, balance } of candidates) {
      const p4 = key.replace(/\D/g, '').slice(-4);
      const p9 = key.replace(/\D/g, '').slice(-9);
      const jc = (order.jobId || '').replace(/[\s\-]/g, '').toUpperCase();
      if (ref.includes(p4)||ref.includes(p9)||ref===jc||jc.includes(ref)||(ref.length>=4&&jc.includes(ref)))
        return { match: 'reference', key, session: s, order, balance };
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
      `${i+1}. ...${last4(c.key)} | Job:${sessJobId(c.session)||'—'} | GHS ${sessTotalBill(c.session)?.toFixed(2)||'—'}`
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
    const safeMime = ['image/jpeg','image/png','image/gif','image/webp'].includes(mime)
      ? mime : 'image/jpeg';
    const r = await anthropic.messages.create({
      model: MODEL, max_tokens: 200,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: safeMime, data: base64 } },
        { type: 'text', text: `Ghana MTN MoMo receipt. Extract ONLY valid JSON:\n{"amount":<number|null>,"txId":"<digits|null>","reference":"<string|null>","senderName":"<string|null>"}` },
      ]}],
    });
    return JSON.parse(gptText(r).replace(/```json|```/g, '').trim());
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
    if (m[2]) { size = m[2].toUpperCase(); qty = parseInt(m[1] || m[3]) || null; }
    else if (m[5]) { size = m[5].toUpperCase(); qty = parseInt(m[4]) || null; }
    else continue;
    const ex = results.find(r => r.size === size);
    if (ex) { if (qty) ex.qty = (ex.qty || 0) + qty; }
    else results.push({ size, qty, isUnknown: false, isMoreOf: null });
  }
  // Explicit copy count anywhere (e.g. "13COPIES", "2 copies", "5 prints", "x10")
  const copyMatch = text.match(/(\d+)\s*(?:copies|copys|copy|cop|pcs|pc|pieces|prints?)\b/i);
  const copies = copyMatch ? parseInt(copyMatch[1]) : null;
  if (results.length === 1) {
    if (copies) results[0].qty = copies;          // explicit copies win
    else if (!results[0].qty) results[0].qty = 1; // single size, no qty → 1 sheet
  } else {
    results.forEach(r => { if (!r.qty) r.qty = 1; });
  }
  return results.length > 0 ? results : [{ size: null, qty: null, isUnknown: true, isMoreOf: null }];
}

// Deterministic, EXPLICIT-ONLY reader: returns {size, qty} where each is null unless the
// text actually states it. Unlike quickParse it never defaults a lone size to qty 1 — that
// distinction is what lets us merge a filename and a caption field-by-field.
function parseSizeQty(text) {
  const t = String(text || '').toLowerCase();
  const sm = t.match(/\ba\s?([234])\b/);
  const size = sm ? 'A' + sm[1] : null;
  let qty = null;
  const cm = t.match(/(\d+)\s*(?:copies|copys|copy|cop|pcs|pc|pieces|piece|prints?|sheets?)\b/);
  if (cm) qty = parseInt(cm[1], 10);
  if (qty == null) { const xm = t.match(/[x×]\s*(\d+)/) || t.match(/(\d+)\s*[x×]/); if (xm) qty = parseInt(xm[1], 10); }
  if (qty == null) {
    const stripped = t.replace(/\ba\s?[234]\b/g, ' ');
    const nm = stripped.match(/\b(\d+)\b/);
    if (nm) qty = parseInt(nm[1], 10);
  }
  if (qty != null && (qty < 1 || qty > 999)) qty = null;
  return { size, qty };
}

// Merge a filename and a caption field-by-field. The CAPTION wins each field it specifies;
// anything the caption leaves out falls back to the filename.
function mergeNameCaption(filename, caption) {
  const f = parseSizeQty(filename);
  const c = parseSizeQty(caption);
  return { size: c.size || f.size || null, qty: (c.qty != null ? c.qty : (f.qty != null ? f.qty : null)) };
}

// Detect a blanket instruction like "all are A3", "make them all A4 2 copies", "everything A2"
function parseBlanketSize(msg) {
  if (!msg) return null;
  const t = msg.toLowerCase();
  const sizeM = t.match(/\b(a[234])\b/);
  if (!sizeM) return null;
  if (!/\b(all|every|everything|them all|all of them|the rest|each|both|make them|they are|they're)\b/.test(t)) return null;
  const size = sizeM[1].toUpperCase();
  const qtyM = t.match(/(\d+)\s*(?:copies|copy|each|pcs|prints?)\b/) || t.match(/[x×]\s*(\d+)/);
  const qty = qtyM ? parseInt(qtyM[1]) : null;
  return { size, qty };
}

async function extractOrder(msg, filename, session) {
  const cap = msg || '';
  const fn  = filename || '';
  // CAPTION WINS: if the typed caption names a size (A4/A3/A2), trust it and ignore the
  // filename entirely — the customer's latest words override whatever the file is named.
  // Otherwise combine filename + caption (filename gives size, caption can add copies).
  const captionHasSize = /\b[aA][234]\b/.test(cap);
  const fast = captionHasSize ? quickParse(cap) : quickParse(`${fn} ${cap}`);
  if (fast.length && fast[0].size && fast[0].qty) return fast;

  const prompt = `You are a precise order parser for a DTF print shop in Ghana.
Customer message/caption: "${cap}"
Filename: "${fn}"
Existing order items: ${JSON.stringify(session.files)}

TASK: Extract ALL print sizes and quantities.
IMPORTANT: If the caption names a size, the CAPTION OVERRIDES the filename — use the caption's size and ignore the filename's size.
Handle multiple sizes in one message.
Handle Ghanaian pidgin English (e.g. "abeg print 3 A4").
Handle formats: "A4 x5", "5xA4", "A4×5", "5 A4", "A4-5".
If customer says "more/add/extra", set isMoreOf to the size they want more of.

Return ONLY a valid JSON array. No text. No markdown. No explanation.
Each object: {"size":"A4|A3|A2","qty":number,"isUnknown":false,"isMoreOf":"A4|A3|A2|null"}
If cannot parse: [{"size":null,"qty":null,"isUnknown":true,"isMoreOf":null}]`;
  try {
    const r = await askGPT([{ role: 'user', content: prompt }], null, 300, 8000);
    const raw = gptText(r);
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    console.error('extractOrder error:', e.message);
    return quickParse(captionHasSize ? cap : (cap || fn));
  }
}

async function extractImageInstructions(msg, pendingImages) {
  const count = pendingImages.length;
  const imageList = pendingImages.map((img, i) =>
    `Image ${i+1}: caption="${img.caption || 'none'}"`
  ).join('\n');

  const prompt = `DTF print shop Ghana. A customer sent ${count} image(s) and is now giving print instructions.

Customer message: "${msg}"

Images (in order):
${imageList}

TASK: Match the customer's instructions to each image IN ORDER (Image 1 first, Image 2 second, etc).
When customer says "first one" or "1st" → Image 1.
When customer says "second one" or "2nd" → Image 2.
When customer says "both/all" → apply to all images.

Return ONLY a valid JSON array with exactly ${count} objects in order.
Each object: {"size":"A4|A3|A2","qty":number}
If size/qty unknown for an image, use {"size":null,"qty":null}

STRICT RULES:
- Preserve the ORDER — array index 0 = Image 1, index 1 = Image 2, etc.
- NEVER swap sizes between images.
- NEVER guess — only use what the customer explicitly said.
- No markdown. No explanation. JSON array only.`;

  try {
    const r = await askGPT([{ role: 'user', content: prompt }], null, 400, 8000);
    const raw = gptText(r);
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    const fb = quickParse(msg)[0] || {};
    return Array.from({ length: count }, () => ({ size: fb.size || null, qty: fb.qty || null }));
  }
}

function addFile(order, info, source, notes) {
  const { size, qty, isMoreOf } = info;
  if (!size || !qty) return;
  if (isMoreOf) {
    const ex = order.files.find(f => f.size === isMoreOf);
    if (ex) { ex.qty += qty; return; }
  }
  const ex = order.files.find(f => f.size === size);
  if (ex) ex.qty += qty;
  else order.files.push({ size, qty, source: source || 'file', notes: notes || '' });
}

// Remove every contribution a given named file made to the order (wherever it landed),
// so a re-send of the same filename REPLACES it instead of adding on top.
function removeNamedContribution(order, nameKey) {
  if (!nameKey) return;
  order.files        = (order.files || []).filter(f => f._name !== nameKey);
  order.qtyPending   = (order.qtyPending || []).filter(q => q._name !== nameKey);
  order.unknownFiles = (order.unknownFiles || []).filter(u => u._name !== nameKey);
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

function buildSummary(order) {
  const { lines, subtotal, a4eq } = calcBill(order.files);
  order.a4eq = a4eq;
  let pressingFee = 0;
  if (order.pressing) {
    pressingFee = calcPressing(order.pressing.shirts, order.pressing.type, order.pressing.largeArtwork);
    order.pressing.fee = pressingFee;
  }
  const grandTotal = subtotal + pressingFee;
  order.totalBill = grandTotal;
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

function buildBill(order) {
  const { lines, subtotal, a4eq } = calcBill(order.files);
  order.a4eq = a4eq;
  let pressingFee = 0;
  if (order.pressing) {
    pressingFee = calcPressing(order.pressing.shirts, order.pressing.type, order.pressing.largeArtwork);
    order.pressing.fee = pressingFee;
  }
  const grandTotal = subtotal + pressingFee;
  order.totalBill = grandTotal;
  const orderRef = order.ref > 1 ? ` — Order #${order.ref}` : '';
  const items = lines.map(l =>
    `*${l.size}*  ${l.qty} sheet${l.qty!==1?'s':''}  =  *GHS ${l.price.toFixed(2)}*`
  ).join('\n');
  const pressingLine = pressingFee > 0
    ? `\n👕 Pressing  =  *GHS ${pressingFee.toFixed(2)}*`
    : '';
  return [
    `--------------------`,
    `🧾 *MIGO PRINT SHOP*${orderRef}`,
    `   Circle · Near Benz Gate · Accra`,
    `--------------------`,
    `🖨️ *ORDER BREAKDOWN*`,
    `--------------------`,
    items + pressingLine,
    `--------------------`,
    `💵 *TOTAL:  GHS ${grandTotal.toFixed(2)}*`,
    `--------------------`,
    ``,
    `🟡 MTN MOBILE MONEY`,
    `      0552719245`,
    `    Kow Habib Baisie`,
    ``,
    `--------------------`,
    `🗓️ ${nowStr()}`,
    `--------------------`,
    `🤝 _Thank you for choosing Migo!_ 🙏`,
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
  const order = getActiveOrder(session);
  const pend = [...(order.pendingImages || []), ...(order.unknownFiles || [])];
  const n = pend.length;

  if (n === 0) return `What size (A4 / A3 / A2) and how many copies?`;
  if (n === 1) return `What size (A4 / A3 / A2) and how many copies for your file? 🙂`;

  return [
    `What size and how many copies for your *${n} files*? 🙂`,
    ``,
    `If they're *all the same*, just say e.g. *all A3, 1 copy each*.`,
    `If some are different, tell me and I'll sort them out.`,
  ].join('\n');
}

// ── Missing-quantity flow (size known, copies unknown) ──────────────
// Build ONE message asking for all missing copy counts together.
function buildQtyQuestion(order) {
  const items = order.qtyPending || [];
  const n = items.length;
  if (n === 0) return `How many copies?`;
  if (n === 1) {
    const nm = String(items[0].label || '').replace(/\.[a-z0-9]+$/i, '').trim();
    const who = nm ? `*${nm}* (${items[0].size})` : `your *${items[0].size}* file`;
    return [
      `How many copies of ${who}? 🙂`,
      `(No reply in 5 min → I'll assume *1 copy* and send your bill.)`,
    ].join('\n');
  }
  return [
    `I have *${n} file(s)* that just need a quantity (how many copies of each):`,
    ``,
    ...items.map((it, i) => `${i + 1}. ${it.label} (${it.size}) → ? copies`),
    ``,
    `Reply *all 1* for one copy each, or list them in order: *2, 1, 3 …*`,
    `(No reply in 5 min → I'll assume *1 copy each* and send your bill.)`,
  ].join('\n');
}

// Parse a customer's reply to the quantity question into an array of counts.
// Handles: "all 2" / "2 each" / "every 1"  → same number for all
//          "2, 1, 3" (count matches)        → one per item, in order
//          single number                    → same number for all
// Returns array length === count, or null if it can't be parsed.
function parseQtyReply(msg, count) {
  if (!msg || count < 1) return null;
  const t = String(msg).toLowerCase();
  const blanket = t.match(/\b(?:all|each|every|both)\b[^\d]*(\d+)/) ||
                  t.match(/(\d+)\s*(?:each|per|apiece|a\s*piece)\b/);
  if (blanket) {
    const q = parseInt(blanket[1], 10);
    if (q >= 1) return Array(count).fill(q);
  }
  const nums = (t.match(/\d+/g) || []).map(n => parseInt(n, 10)).filter(n => n >= 1);
  if (nums.length === count) return nums;
  if (nums.length === 1) return Array(count).fill(nums[0]);
  return null;
}

// Ask the customer for size/copies. For multi-design / messy orders, send the tap-to-choose
// link (the safe path). For a single design, keep the simple typed question.
async function sendSizeQtyAsk(phone, session, order, fallbackText) {
  ensureFormDesigns(order);
  const _wantLink = order._aiResolved ? order._aiAmbiguous : order._captionSeen;
  if (_wantLink && (order.formDesigns || []).length >= 2) {
    const link = orderShortLink(phone, order);
    await sendMsg(phone, [
      `📋 You've sent *${order.formDesigns.length} designs*.`,
      `Tap here to set the size & copies for each — quick and easy 👇`,
      link,
      ``,
      `_Or just reply here, e.g. *all A3 2*._`,
    ].join('\n'));
  } else {
    await sendMsg(phone, fallbackText);
  }
}

// Ask once for all missing quantities, then wait 5 minutes.
// On timeout: assume 1 copy each (flagged) and bill.
async function askQty(phone, session, order) {
  if (!order) order = getActiveOrder(session);
  if (!(order.qtyPending || []).length) { await proceedToSummary(phone, session, order); return; }
  order.state = 'asking_qty';
  await sendSizeQtyAsk(phone, session, order, buildQtyQuestion(order));
  setTimer(phone, 'qty_timeout', 300000, async () => {
    if (order.state !== 'asking_qty' || !(order.qtyPending || []).length) return;
    order.qtyPending.forEach((it) => {
      addFile(order, { size: it.size, qty: 1, sourceUrl: it.url || null, isUnknown: false, isMoreOf: null },
              it.caption || it.label, '');
      order.assumedQtyCount = (order.assumedQtyCount || 0) + 1;
    });
    order.qtyPending = [];
    await proceedToSummary(phone, session, order);
  });
}

function startReceiveTimer(phone, session) {
  const fileCount = order.files.length + session.pendingImages.length + session.unknownFiles.length;

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

// ── AI BATCH READER ───────────────────────────────────────────
// Reads the WHOLE batch (every filename + caption + loose note, in arrival
// order) in ONE Opus call and returns a clean design list. Claude reads INTENT
// only; deterministic code still does all pricing & confirmation.
async function aiReadBatch(order) {
  const batch = (order._batch || []);
  if (!batch.some(b => b.kind === 'file')) return null;
  const lines = []; let n = 0;
  batch.forEach(b => {
    if (b.kind === 'file') {
      n++;
      lines.push(`${n}. FILE: "${b.filename || '(no name)'}"` + (b.caption ? ` (caption: "${b.caption}")` : ''));
    } else if (b.kind === 'text' && b.text) {
      lines.push(`   note: "${b.text}"`);
    }
  });
  const system = [
    'You read what a print-shop customer sent and output ONLY JSON. No prose, no markdown.',
    'Each FILE is one design. Using the filename, its caption, and any notes (read together, in order),',
    'determine the paper size (one of A4, A3, A2) and the quantity (number of copies) for each design.',
    'Conventions: "1pc"/"1 copy"/"x1"/"1 piece"/"1pcs" means qty 1. "A2", "A 2", "a2" all mean size A2.',
    'A lone size with no number means the quantity is unknown (null). If the SAME filename appears more',
    'than once it is a correction: use the latest and count it ONCE.',
    'If a size cannot be determined set size to null. If a quantity cannot be determined set qty to null.',
    'need = "qty" if only quantity missing, "size" if only size missing, "both" if both missing, else null.',
    'Set ambiguous to true ONLY when notes/captions cannot be confidently matched to specific files.',
    'If everything is clear from the filenames alone, ambiguous MUST be false.',
    'Output EXACTLY this shape:',
    '{"designs":[{"i":1,"file":"<filename>","size":"A2"|null,"qty":<integer>|null,"need":null|"qty"|"size"|"both"}],"ambiguous":false}',
  ].join('\n');
  const user = 'Items the customer sent, in order:\n' + lines.join('\n');
  let txt;
  try { txt = await _batchLLM(user, system); } catch (e) { return null; }
  if (!txt) return null;
  txt = String(txt).replace(/```json|```/g, '').trim();
  let parsed = null;
  try { parsed = JSON.parse(txt); }
  catch { const m = txt.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch {} } }
  if (!parsed || !Array.isArray(parsed.designs) || !parsed.designs.length) return null;
  const designs = parsed.designs.map((d, i) => {
    const size = ['A4','A3','A2'].includes(String(d.size || '').toUpperCase()) ? String(d.size).toUpperCase() : null;
    let qty = parseInt(d.qty, 10); if (!(qty >= 1 && qty <= 999)) qty = null;
    const file = String(d.file || `Design ${i + 1}`);
    const need = (!size && !qty) ? 'both' : (!size ? 'size' : (!qty ? 'qty' : null));
    return { i: i + 1, file, size, qty, need };
  });
  return { designs, ambiguous: !!parsed.ambiguous };
}

// Rebuild the order deterministically from the AI's design list (single source of truth).
function applyAiDesigns(order, ai) {
  order.files = []; order.qtyPending = []; order.unknownFiles = []; order.pendingImages = [];
  order.assumedQtyCount = 0; order._designs = [];
  const batchFiles = (order._batch || []).filter(b => b.kind === 'file');
  const urlFor = (file) => { const b = batchFiles.find(x => (x.filename || '') === file); return b ? (b.url || null) : null; };
  ai.designs.forEach(d => {
    const key = (d.file || '').toLowerCase();
    const url = urlFor(d.file);
    if (d.size && d.qty) order.files.push({ size: d.size, qty: d.qty, source: d.file, notes: '', sourceUrl: url, _name: key });
    else if (d.size)     order.qtyPending.push({ size: d.size, label: d.file, caption: '', url, _name: key });
    else                 order.unknownFiles.push({ name: d.file, url, _name: key });
    order._designs.push({ name: key, filename: d.file, url, captioned: false });
  });
  order._aiResolved = true;
  order._aiAmbiguous = !!ai.ambiguous;
  order._aiDone = true;
}

async function proceedToSummary(phone, session, order) {
  if (!order) order = getActiveOrder(session);

  // No files at all
  if (!order.files.length && !order.unknownFiles.length && !order.pendingImages.length && !(order.qtyPending || []).length) {
    await sendMsg(phone, `I could not detect any files. Please send your files and I will calculate the cost.`);
    order.state = 'receiving'; return;
  }

  // AI BATCH READER: read the whole batch at once, rebuild deterministically. Falls back
  // to the existing arrays if the reader is off or the call fails.
  if (AI_BATCH_READER && !order._aiDone && (order._batch || []).some(b => b.kind === 'file')) {
    const ai = await aiReadBatch(order);
    if (ai) applyAiDesigns(order, ai);
    else order._aiDone = true; // don't keep retrying a failed read for this batch
  }

  // Ambiguous (captions/notes can't be safely attributed) → PREFILLED tap-to-choose form.
  // When the AI reader is off, fall back to the old caption-seen signal.
  const _designCount = order.files.length + (order.qtyPending || []).length + order.unknownFiles.length + order.pendingImages.length;
  const _wantPlanB = order._aiResolved ? order._aiAmbiguous : order._captionSeen;
  if (_designCount >= 2 && _wantPlanB) {
    order.state = 'asking_image_info';
    ensureFormDesigns(order);
    const link = orderShortLink(phone, order);
    await sendMsg(phone, [
      `\u{1F4CB} You've sent *${order.formDesigns.length} designs* with instructions.`,
      `To make sure each one is exactly right, tap here to set the size & copies \u{1F447}`,
      link,
    ].join('\n'));
    return;
  }

  // Files with no size/qty — single design asks in text; multi-design gets the tap-to-choose link.
  if (order.pendingImages.length > 0 || order.unknownFiles.length > 0) {
    order.state = 'asking_image_info';
    await sendSizeQtyAsk(phone, session, order, buildImageQuestion(session));
    return;
  }

  // Size known but copies missing — ask once for all, wait 5 min (askQty handles timeout→assume 1)
  if ((order.qtyPending || []).length > 0) {
    await askQty(phone, session, order);
    return;
  }

  // All files have size/qty — pressing check then bill
  if (order.pressingMentioned && !order.askedPressing) {
    order.askedPressing = true;
    order.state = 'asking_pressing';
    await sendMsg(phone, `How many shirts, and front only, front+back, or side? (Type *no* to skip)`);
    setTimer(phone, 'pressing_timeout', 60000, async () => {
      if (order.state === 'asking_pressing') {
        order.pressing = null;
        await sendBill(phone, session, order);
      }
    });
    return;
  }

  // All good — send bill
  await sendBill(phone, session, order);
}

async function sendBill(phone, session, order) {
  if (!order) order = getActiveOrder(session);
  order.state = 'awaiting_payment';
  order.billSentAt = Date.now();
  audit('BILL_SENT', phone, `Order #${order.ref} — GHS ${order.totalBill?.toFixed(2)}`);

  // Build bill string NOW before setTimeout
  let billMsg;
  try {
    billMsg = buildBill(order);
  } catch(e) {
    console.error('❌ buildBill error:', e.message);
    await alertOwner(`⚠️ buildBill crashed for ${displayPhone(phone)}: ${e.message}`).catch(()=>{});
    return;
  }

  // Send bill after short delay (feels natural, avoids WhatsApp rate limits)
  setTimeout(async () => {
    try {
      await sendMsg(phone, [
        billMsg,
        ``,
        ...(order.assumedQtyCount > 0
          ? [`ℹ️ I assumed *1 copy* for image(s) where no quantity was given. Tell me if any need more, and I'll update the bill.`, ``]
          : []),
        `📌 Please send your MoMo receipt to complete your order.`,
        `Printing can *ONLY* start *AFTER* payment. 🙏`,
      ].join('\n'));
    } catch(e) {
      console.error('❌ Bill send error:', e.message);
      alertOwner(`⚠️ Bill failed to send to ${displayPhone(phone)}: ${e.message}`).catch(()=>{});
    }
    // Gentle reminders — no cancellation, no threats
    setTimer(phone, 'pay1', 600000, () => {
      if (order.state === 'awaiting_payment')
        sendMsg(phone, `Please send your payment receipt to complete your order. 🙏`);
    });
    setTimer(phone, 'pay2', 1800000, () => {
      if (order.state === 'awaiting_payment')
        sendMsg(phone, `Please send your payment receipt to complete your order. 🙏`);
    });
    setTimer(phone, 'pay3', 3600000, () => {
      if (order.state === 'awaiting_payment')
        sendMsg(phone, `Please send your payment receipt to complete your order. 🙏`);
    });
  }, 2000);
}

function scheduleWorkerReminders(phone, order, jobId) {
  if (!order.readyTime) return;
  const now = Date.now(), readyMs = order.readyTime.getTime();
  const remind = (name, ms, label) => {
    if (ms <= now) return;
    setTimer(phone, name, ms - now, async () => {
      if (order.jobId !== jobId) return;
      await sendMsg(toWaId(SHOP_NUMBER),
        [label, ``, `🔖 Job: *${jobId}*`, `📱 ...${last4(phone)}`].join('\n'));
    });
  };
  remind('work30', readyMs - 30*60000, `⏰ *30-Min Warning* — Job ${jobId}`);
  remind('work15', readyMs - 15*60000, `⚠️ *15-Min Warning* — Job ${jobId}`);
  remind('work2',  readyMs -  2*60000, `🚨 *2-Min Warning*  — Job ${jobId} due NOW`);
  const overdueFn = async (attempt) => {
    if (order.jobId !== jobId) return;
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
// ── Apply GPT's confirmed file list to session ────────────────
function _applyGPTFiles(gptFiles, order) {
  // Merge GPT's confirmed sizes/qtys with pending/unknown files by position
  const pending = [...order.pendingImages, ...order.unknownFiles];
  gptFiles.forEach((f, i) => {
    const size = String(f.size || '').toUpperCase();
    if (!['A4', 'A3', 'A2'].includes(size)) return;        // validate size — reject anything else
    let qty = parseInt(f.qty);
    const src = pending[i];
    if (!qty || qty < 1) {
      // Size known, copies missing → defer. We'll ask once for all of them (5-min timeout assumes 1).
      order.qtyPending = order.qtyPending || [];
      order.qtyPending.push({
        size,
        url: src ? src.url : null,
        caption: src ? (src.caption || src.name) : null,
        label: `Image ${order.qtyPending.length + 1}`,
      });
      return;
    }
    if (src) {
      addFile(order, { size, qty, sourceUrl: src.url, isUnknown: false, isMoreOf: null },
        src.caption || src.name || `file ${i+1}`, '');
    } else if (!order.files.some(sf => sf.size === size)) {
      // No matching attachment slot AND this size isn't already counted → genuinely new.
      // (Files merge by size, so we can't match individual qtys — never re-add an existing size.)
      addFile(order, { size, qty, isUnknown: false, isMoreOf: null }, 'order', '');
    }
  });
  order.pendingImages = [];
  order.unknownFiles = [];
}

function armSilence(from, session, order) {
  order.state = 'receiving';
  setTimer(from, 'checkin', SILENCE_MS, async () => {
    if (order.state !== 'receiving') return;
    order.state = 'asked_done';
    await sendMsg(from, 'Are you done sending? \u{1F44D}');
    setTimer(from, 'nodone', ASK_DONE_MS, async () => {
      if (order.state === 'asked_done') await proceedToSummary(from, session, order);
    });
  });
}

// Track every named file in ARRIVAL ORDER so a separate caption text can be matched to the
// right file. `captioned` = a caption has already been applied to this design.
function upsertDesign(order, name, filename, url, captioned) {
  order._designs = order._designs || [];
  let d = order._designs.find(x => x.name === name);
  if (!d) { d = { name, filename, url: url || null, captioned: !!captioned }; order._designs.push(d); }
  else { d.filename = filename; if (url) d.url = url; if (captioned) d.captioned = true; }
  return d;
}

// A caption that arrives as a SEPARATE text (the gateway often splits a document's caption off)
// is applied to the FIRST file still awaiting a caption, in the order files were sent — so with
// two files, the first caption corrects the first file and the second corrects the second.
function applyLooseCaption(order, text) {
  const seq = order._designs || [];
  const d = seq.find(x => !x.captioned) || seq[seq.length - 1];
  if (d) {
    const merged = mergeNameCaption(d.filename, text);
    removeNamedContribution(order, d.name);
    if (merged.size && merged.qty != null) order.files.push({ size: merged.size, qty: merged.qty, source: d.filename, notes: '', sourceUrl: d.url || null, _name: d.name });
    else if (merged.size) { order.qtyPending = order.qtyPending || []; order.qtyPending.push({ size: merged.size, url: d.url || null, caption: text, label: d.filename, _name: d.name }); }
    else order.unknownFiles.push({ name: d.filename, url: d.url || null, _name: d.name });
    d.captioned = true;
    return;
  }
  if (order.pendingImages.length === 1 && !order.unknownFiles.length) {
    const sq = parseSizeQty(text); const img = order.pendingImages[0];
    if (sq.size && sq.qty != null) { order.pendingImages = []; addFile(order, { size: sq.size, qty: sq.qty, sourceUrl: img.url, isUnknown: false, isMoreOf: null }, text, ''); }
    else if (sq.size) { order.pendingImages = []; order.qtyPending = order.qtyPending || []; order.qtyPending.push({ size: sq.size, url: img.url, caption: text, label: 'Image 1' }); }
  }
}

function isDoneText(msg) {
  const t = (msg || '').trim().toLowerCase();
  if (!t) return false;
  if (/\b(bill|invoice)\b|send.*(bill|invoice)|that.?s? ?all|all done|i.?m done|am done|finish(ed)?|go ahead|proceed/i.test(t)) return true;
  return /^(yes|yep|yeah|yh|ok|okay|done|sure)\b/i.test(t) || isYes(t);
}

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

  // ── Bot silenced — human is handling ─────────────────────
  if (isBotSilenced(session)) {
    if (!session.silenceNoticeSent) {
      session.silenceNoticeSent = true;
      return `Please, I will get back to you shortly. 🙏`;
    }
    return null;
  }

  session.lastActivity = Date.now();

  // Get active order
  let order = getActiveOrder(session);


  // ── Instant greeting reply — no GPT delay ────────────────
  // Catches any opening message that looks like a greeting
  // including misspelled ones like "Afernon", "Godd monrin"
  if (msg && !mediaUrl && order.state === 'idle' && order.files.length === 0 && !getPendingOrder(session)) {
    const m = msg.trim().toLowerCase();
    const isSimpleGreeting =
      /^(hi+|hey+|hello+|helo|hy|holla|howdy|yo+|sup)[\s!.,\w]*$/i.test(m) ||
      /^good[\s]*(morning|afternoon|evening|night|day|morn\w*|aftern\w*|even\w*|nite)/i.test(m) ||
      /^(morning|afternoon|evening|night|morn\w*|aftern\w*|evenin\w*)/i.test(m) ||
      /^(afern|afternon|afternn|aftenon)\w*/i.test(m);

    if (isSimpleGreeting) {
      if (/morning|^morn/i.test(m)) return `Good morning! 😊`;
      if (/afternoon|^aftern|^afern/i.test(m)) return `Good afternoon! 😊`;
      if (/evening|^evenin|nite/i.test(m)) return `Good evening! 😊`;
      if (/night/i.test(m)) return `Good night! 😊`;
      return `Hi! 👋`;
    }

    // Customer typed a size/quantity but hasn't attached anything yet (e.g. "2a4", "A3 5") → ask for the file.
    const qp = quickParse(m);
    if (qp.length && qp[0].size) {
      const f = qp[0];
      const qtyTxt = f.qty ? ` × ${f.qty}` : '';
      return `Got it — *${f.size}${qtyTxt}* 👍 Now send your design file 📎 and I'll prepare your bill.`;
    }

    // Customer named the service / signalled they want to print, but no file yet → start once (NOT a greeting).
    if (/^(dtf|printing|print|migo|order|i\s*(want|need|would\s*like)\b.*\b(print|dtf|design)|want\s*(to\s*)?(print|dtf))\b/i.test(m)) {
      if (!session.startPrompted) {
        session.startPrompted = true;
        return `Sure! 😊 Send your design and tell me the size (A4/A3/A2) and how many copies.`;
      }
      return null; // already prompted — don't greet again or repeat
    }
  }

  // ── FAQ quick-match — runs for ALL states ─────────────────
  if (msg) {
    const faqAnswer = tryFAQ(msg);
    if (faqAnswer) return faqAnswer;
  }

  // ── Reset timers if idle with no files ───────────────────
  if (msg && order.state === 'idle' && order.files.length === 0) {
    const pendingOrder = getPendingOrder(session);
    if (!pendingOrder) clearTimers(from);
  }

  // ── New message while awaiting payment ───────────────────
  const pendingOrder = getPendingOrder(session);
  if (pendingOrder && order.ref !== pendingOrder.ref) {
    // Customer has an unpaid order AND is starting something new
    const timeSinceBill = Date.now() - (pendingOrder.billSentAt || Date.now());
    const THIRTY_MIN = 30 * 60 * 1000;

    if (timeSinceBill <= THIRTY_MIN && mediaUrl) {
      // Within 30 min with new files → merge into pending order
      order = pendingOrder;
      session.activeRef = pendingOrder.ref;
    } else if (timeSinceBill > THIRTY_MIN) {
      // After 30 min → silence bot, alert owner
      await silenceBot(from, session, `Customer returned after ${Math.round(timeSinceBill/60000)} min. Unpaid order ref #${pendingOrder.ref} (GHS ${pendingOrder.totalBill?.toFixed(2) || '?'})`);
      return null;
    }
    // else within 30 min with text message — let GPT handle
  }

  // ── Pressing mention ──────────────────────────────────────
  if (/\bpress(ing|ed)?\b/i.test(msg || '')) order.pressingMentioned = true;

  // ── READY state ───────────────────────────────────────────
  const readyOrder = session.orders.find(o => o.state === 'ready');
  if (readyOrder && isReadyCheck(msg || '')) {
    return `✅ Your order is ready!\n🔑 Pickup code: *${readyOrder.jobId}*\n📍 Near Benz Gate, Circle. No pickup code — no release.`;
  }

  // ── PROCESSING state ──────────────────────────────────────
  const processingOrder = session.orders.find(o => o.state === 'processing');
  if (processingOrder && isReadyCheck(msg || '')) {
    const eta = processingOrder.readyTime
      ? processingOrder.readyTime.toLocaleTimeString('en-GH', { timeZone:'Africa/Accra', hour12:true, hour:'2-digit', minute:'2-digit' })
      : 'shortly';
    return `Still printing. 🖨️ Ready by *${eta}*. We'll notify you!`;
  }

  // Casual acknowledgement after an order is done (paid / printing / ready) — just an
  // "ok / thanks / 👍" with no new file. Acknowledge silently; never route to billing.
  if ((readyOrder || processingOrder) && !mediaUrl) {
    const ack = (msg || '').trim().toLowerCase().replace(/[.!,\s]+$/u, '');
    if (/^(ok|okay|k|kk|alright|aii|cool|great|nice|fine|good|noted|sure|thanks|thank you|thank u|thx|tnx|ty|received|got it|👍|🙏|😊|🙂)$/i.test(ack)) {
      return null; // nothing to bill — stay quiet
    }
  }

  // ── AWAITING PAYMENT ──────────────────────────────────────
  if (order.state === 'awaiting_payment') {
    const lower = (msg || '').toLowerCase();
    if (/\b(cash|bring cash|pay cash|no momo|don.?t have momo|no mobile money|pay when i come|pay on arrival|pay at shop|i.?ll pay|coming to pay|bring the money|i have cash|physical(ly)?|in person)\b/i.test(msg)) {
      const nowTs = Date.now();
      if (order.lastCashNudgeAt && nowTs - order.lastCashNudgeAt < 60000) return null; // already nudged within 60s
      order.lastCashNudgeAt = nowTs;
      return `Printing can only start after Payment Confirmation. Thank you.`;
    }
    if (isReadyCheck(msg || ''))
      return `We haven't received your payment yet. Once payment is confirmed we'll start printing. 🙏`;
    if (/send.*bill|bill again|resend|can.?t see|didn.?t (get|receive)|show.*bill/i.test(lower)) {
      await sendMsg(from, buildBill(order)); return null;
    }
    if (/how much|total|amount|balance/.test(lower))
      return `Total: *GHS ${order.totalBill?.toFixed(2) || '—'}*\nMoMo: *0552719245*`;
    const txIdTyped = (msg || '').match(/\b(\d{8,})\b/);
    if (txIdTyped) {
      order.pendingTxId = txIdTyped[1];
      audit('TXID_PROVIDED', from, `TxID:${txIdTyped[1]}`);
      return `Got it! TxID *${txIdTyped[1]}* noted. We'll confirm shortly. 🙏`;
    }
    if (mediaUrl && isImage) {
      const ocr = await extractReceiptFromImage(mediaUrl);
      if (ocr?.amount) {
        if (ocr.txId) { order.pendingTxId = ocr.txId; order.pendingTxAmount = ocr.amount; }
        return ocr.txId
          ? `Got it! TxID *${ocr.txId}* — GHS ${ocr.amount.toFixed(2)}. Confirming now. 🙏`
          : `Got it! GHS ${ocr.amount.toFixed(2)} noted. Please reply with your Transaction ID to confirm faster.`;
      }
    }
    const d0 = await gptDecide(msg, session);
    return d0.reply || null;
  }

  // ── FILE RECEIVED — silent collect, 30s timer ────────────
  if (mediaUrl) {
    // A new file after a FINISHED order (paid / printing / ready) starts a fresh order,
    // so it never attaches to the closed one.
    if (order.paymentReceived || ['processing','ready'].includes(order.state)) {
      order = startNewOrder(session);
    }
    order._batch = order._batch || [];
    order._batch.push({ kind: 'file', filename: filename || '', caption: (msg || '').trim(), url: mediaUrl });
    order._aiDone = false;               // a new file arrived -> the batch must be re-read
    const fileLabel = filename || (isImage ? 'image' : 'file');
    const captionNote = msg ? `, caption: "${msg}"` : '';
    const fileDesc = `[FILE RECEIVED: "${fileLabel}", type: ${mediaType||'unknown'}${captionNote}]`;

    const fnNorm = (filename || '').trim().toLowerCase();

    // -- NAMED FILE (a file with a real filename, e.g. a document) --------------
    // Deterministic merge of filename + caption, field-by-field, caption winning each
    // field it specifies. Re-sending the SAME filename is a CORRECTION: it replaces that
    // design in place and the LATEST caption always wins -- never double-charged, however
    // many times it is re-sent. (Inline photos have no filename, so they fall through to
    // the pending-image flow below and each counts as a new design.)
    const isGeneric = !fnNorm || /^(image|file|photo|img|picture|untitled)(\.\w+)?$/.test(fnNorm);
    if (!isGeneric) {
      const merged     = mergeNameCaption(filename, msg);
      const isResend   = (order.files || []).some(f => f._name === fnNorm)
                      || (order.qtyPending || []).some(q => q._name === fnNorm)
                      || (order.unknownFiles || []).some(u => u._name === fnNorm);
      const hasCaption = !!(msg && msg.trim());
      trackFile(from, mediaUrl, filename, mediaType || (isImage ? 'image/jpeg' : 'application/pdf'), msg, session);
      // A bare re-send (same filename, no new caption) carries no new info -> leave it unchanged.
      // Otherwise replace this design in place with the latest merge (correction / latest-wins).
      if (!(isResend && !hasCaption)) {
        removeNamedContribution(order, fnNorm);          // wipe prior contribution -> replace, never add
        if (merged.size && merged.qty != null) {
          order.files.push({ size: merged.size, qty: merged.qty, source: filename, notes: '', sourceUrl: mediaUrl, _name: fnNorm });
        } else if (merged.size) {                        // size known, copies missing -> ask later
          order.qtyPending = order.qtyPending || [];
          order.qtyPending.push({ size: merged.size, url: mediaUrl, caption: msg, label: filename, _name: fnNorm });
        } else {                                         // no size at all -> needs sizing
          order.unknownFiles.push({ name: filename, url: mediaUrl, _name: fnNorm });
        }
        addToHistory(session, 'user', `${fileDesc} -> ${isResend ? 'corrected ' : ''}${merged.size || '?'}x${merged.qty != null ? merged.qty : '?'}`);
      }
      upsertDesign(order, fnNorm, filename, mediaUrl, hasCaption);
      if (hasCaption) order._captionSeen = true;
      armSilence(from, session, order);
      return null;
    }

    if (isImage) {
      const isDup = order.files.some(f=>f.sourceUrl===mediaUrl) || order.pendingImages.some(p=>p.url===mediaUrl);
      if (isDup) return null;
      trackFile(from, mediaUrl, filename||msg||'image.jpg', mediaType||'image/jpeg', msg, session);

      const orders = await extractOrder(msg || '', filename || '', session);
      const valid  = orders.filter(o => !o.isUnknown && o.size && o.qty);
      if (valid.length > 0) {
        valid.forEach(o => addFile(order, { ...o, sourceUrl: mediaUrl }, msg||filename||'image', ''));
        addToHistory(session, 'user', `${fileDesc} → auto-parsed: ${valid.map(v=>`${v.size}×${v.qty}`).join(', ')}`);
      } else {
        order.pendingImages.push({ url: mediaUrl, caption: msg, index: order.pendingImages.length+1, mediaType: mediaType||'' });
        addToHistory(session, 'user', fileDesc);
      }
    } else {
      const isDup = order.files.some(f=>f.sourceUrl===mediaUrl) || order.unknownFiles.some(u=>u.url===mediaUrl);
      if (isDup) return null;
      trackFile(from, mediaUrl, filename||'file.pdf', 'application/pdf', msg, session);
      const orders = await extractOrder(msg, filename, session);
      const valid  = orders.filter(o => !o.isUnknown && o.size && o.qty);
      if (valid.length > 0) {
        valid.forEach(o => addFile(order, { ...o, sourceUrl: mediaUrl }, msg||filename, ''));
        addToHistory(session, 'user', `${fileDesc} → auto-parsed: ${valid.map(v=>`${v.size}×${v.qty}`).join(', ')}`);
      } else {
        order.unknownFiles.push({ name: filename||'file', url: mediaUrl });
        addToHistory(session, 'user', fileDesc);
      }
    }

    // inline (unnamed) photo: a loose caption still maps to named files first, else this image
    armSilence(from, session, order);
    return null; // Silent - no reply while collecting files
  }

  // ── TEXT MESSAGE ─────────────────────────────────────────

  // Deterministic blanket size: "all are A3", "make them all A4 2 copies".
  // Applies the size to every waiting image. If a count was given, bill; otherwise
  // ask once for the copies (5-min timeout → assume 1).
  const blanket = parseBlanketSize(msg);
  if (blanket && (order.pendingImages.length > 0 || order.unknownFiles.length > 0)) {
    clearTimers(from);
    const pend = [...order.pendingImages, ...order.unknownFiles];
    order.pendingImages = [];
    order.unknownFiles = [];
    if (blanket.qty) {
      pend.forEach((p, i) => {
        addFile(order, { size: blanket.size, qty: blanket.qty, sourceUrl: p.url, isUnknown: false, isMoreOf: null },
          p.caption || p.name || `image ${i + 1}`, '');
      });
      await proceedToSummary(from, session, order);
    } else {
      order.qtyPending = pend.map((p, i) => ({
        size: blanket.size, url: p.url, caption: p.caption || p.name, label: `Image ${i + 1}`,
      }));
      await askQty(from, session, order);
    }
    return null;
  }

  // Reply to the "how many copies?" question (state asking_qty)
  if (order.state === 'asking_qty' && (order.qtyPending || []).length > 0) {
    const qtys = parseQtyReply(msg, order.qtyPending.length);
    if (qtys) {
      clearTimers(from); // cancel the 5-min timeout
      order.qtyPending.forEach((it, i) => {
        if (it._name) {
          removeNamedContribution(order, it._name);
          order.files.push({ size: it.size, qty: qtys[i], source: it.label || 'file', notes: '', sourceUrl: it.url || null, _name: it._name });
        } else {
          addFile(order, { size: it.size, qty: qtys[i], sourceUrl: it.url || null, isUnknown: false, isMoreOf: null },
            it.caption || it.label, '');
        }
      });
      order.qtyPending = [];
      await proceedToSummary(from, session, order);
      return null;
    }
    return `Just the number of copies please 🙂 — e.g. *all 1*, or list them in order like *2, 1, 3*.`;
  }

  if (!mediaUrl && order.state === 'receiving' &&
      (order.files.length || order.pendingImages.length || order.unknownFiles.length || (order.qtyPending || []).length)) {
    if (isNo(msg)) { armSilence(from, session, order); return null; }
    if (isDoneText(msg)) { clearTimers(from); await proceedToSummary(from, session, order); return null; }
    const sq = parseSizeQty(msg);
    if (sq.size || sq.qty != null) { order._captionSeen = true; (order._batch=order._batch||[]).push({kind:'text',text:msg}); order._aiDone=false; applyLooseCaption(order, msg); armSilence(from, session, order); return null; }
    const faq = (typeof tryFAQ === 'function') ? tryFAQ(msg) : null;
    armSilence(from, session, order);
    return faq || null;
  }

  if (order.state === 'asked_done') {
    clearTimers(from);
    if (isNo(msg)) { armSilence(from, session, order); return null; }
    const sqd = parseSizeQty(msg);
    if (!isDoneText(msg) && (sqd.size || sqd.qty != null)) {
      order._captionSeen = true; (order._batch=order._batch||[]).push({kind:'text',text:msg}); order._aiDone=false; applyLooseCaption(order, msg); armSilence(from, session, order); return null;
    }
    await proceedToSummary(from, session, order);
    return null;
  }

  // GPT handles everything else
  const d = await gptDecide(msg, session);

  if (d.action === 'send_bill') {
    clearTimers(from);
    // LOCK FINISHED ORDERS: once an order is paid / printing / ready it is closed —
    // never generate a bill for it again (stops a stray "Ok" re-triggering a receipt).
    if (order.paymentReceived || ['processing','ready'].includes(order.state)) {
      return null;
    }
    // DOUBLE-COUNT FIX: files parsed on receipt are the source of truth. Only let the AI
    // supply files when something is still waiting for a size (pending/unknown) or when
    // nothing was parsed at all. Never re-add files already counted on receipt.
    const hasPending = order.pendingImages.length > 0 || order.unknownFiles.length > 0;
    if (d.files?.length > 0 && (hasPending || order.files.length === 0)) {
      _applyGPTFiles(d.files, order);
    }
    if (d.pressing) order.pressing = d.pressing;
    // FIX: Never bill without actual file attachment
    if (order.files.length > 0 || (order.qtyPending || []).length > 0) {
      // If any images still have no size, ask for those deterministically — don't bill incomplete
      if (order.pendingImages.length > 0 || order.unknownFiles.length > 0) {
        order.state = 'asking_image_info';
        session.unansweredCount = 0;
        return buildImageQuestion(session);
      }
      // Size known but copies missing → ask once, 5-min timeout assumes 1
      if ((order.qtyPending || []).length > 0) {
        session.unansweredCount = 0;
        await askQty(from, session, order);
        return null;
      }
      session.unansweredCount = 0;
      await sendBill(from, session, order);
      return null;
    } else {
      return `Please send your actual design file so we can process your order. 📎`;
    }
  }

  if (d.action === 'ask_size_qty') order.state = 'asking_image_info';

  const reply = d.reply || null;

  // Track unanswered messages + stuck detection
  if (reply) {
    session.unansweredCount = 0;
  } else {
    session.unansweredCount = (session.unansweredCount || 0) + 1;
    if (session.unansweredCount >= 3) {
      session.unansweredCount = 0;
      // Alert owner + all workers
      const workerAlerts = [...workers.values()].map(w => w.phone).filter(Boolean);
      const alertMsg = [
        `⚠️ *BOT NEEDS HELP*`,
        `📱 Customer: ${displayPhone(from)}`,
        `👤 Name: ${session.customerName || 'Unknown'}`,
        `💬 Last message: "${(msg||'').slice(0,80)}"`,
        `❓ Bot has not responded 3+ times — please assist.`,
      ].join('\n');
      await alertOwner(alertMsg).catch(()=>{});
      for (const wp of workerAlerts) {
        await sendMsg(wp, alertMsg).catch(()=>{});
      }
      return randomPhrase();
    }
    return randomPhrase();
  }

  return reply;


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
        jobId: sessJobId(session) || '—', score: n, sentiment, comment: '',
        files: [...(readyOrder?.confirmedFiles || [])],
      });
      session.ratingGiven = true;
      audit('RATING', from, `${n}/5 — ${sentiment} | Job:${sessJobId(session)||'—'}`);
      if (n <= 2) await alertOwner(`⭐ *BAD RATING*\nCustomer ...${last4(from)} — ${n}/5 | Job: ${sessJobId(session)||'—'}`);
      clearTimers(from); sessions.delete(from);
      return reply;
    }
    const lastRating = ratingsLog.find(r => r.phone === displayPhone(from));
    if (lastRating && !lastRating.comment) {
      lastRating.comment = msg;
      return `Thank you for letting us know. We take all feedback seriously. 🙏`;
    }
    const d0 = await gptDecide(msg, session);
    return d0.reply || null;
  }
  return null;
}

// ── Admin handler ─────────────────────────────────────────────
async function handleAdmin(from, msg) {
  const parts = msg.trim().split(/\s+/);
  let workerId = null, cmd, argStart;
  if (/^[Ww]\d{1,2}$/.test(parts[1])) {
    workerId = parts[1].toUpperCase(); cmd = (parts[2] || '').toLowerCase().replace(/[^a-z]/g, ''); argStart = 3;
  } else {
    cmd = (parts[1] || '').toLowerCase().replace(/[^a-z]/g, ''); argStart = 2;
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
        const fo=found2.session.orders?.find(o=>o.state==='processing'); if(fo){ fo.state='ready'; } clearTimers(found2.key);
        await sendMsg(found2.key, buildReadyMsg(sessJobId(found2.session)));
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
      const fo2=found2.session.orders?.find(o=>o.state==='processing'); if(fo2) fo2.readyTime = newDate;
      // Send new ready time first, then apology
      await sendMsg(found2.key, [
        `⏱ *UPDATED READY TIME*`, ``,
        `   *${newETA}*`, ``,
        `We sincerely apologise for the delay. Thank you for your patience. 🙏`,
      ].join('\n'));
      await alertOwner([
        `🔴 *JOB OVERDUE ALERT*`, ``,
        `🔖 Job: *${sessJobId(found2.session) || l4}*`,
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
    if (!pin) return `❌ PIN missing. Format:\nadmin W01 cash <last4> <amount> <PIN>`;

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
    const byLast4 = findByLast4(input);
    let phone, s, targetOrder;
    if (byLast4) {
      phone = byLast4.key; s = byLast4.session;
      targetOrder = s.orders.find(o => o.state === 'processing') || getActiveOrder(s);
    } else {
      for (const [key, sess] of sessions.entries()) {
        const o = sess.orders?.find(o => sessJobId(sess) === input.toUpperCase());
        if (o) { phone = key; s = sess; targetOrder = o; break; }
      }
    }
    if (!s || !targetOrder) return `❌ No session for "${input}".\nUsage: admin W01 ready <last4>`;
    targetOrder.state = 'ready'; targetOrder.servedBy = workerId; clearTimers(phone);
    audit('MARKED_READY', from, `Job ${targetOrder.jobId||'—'} by ${workerName}`, false, workerId);
    const readyMsg = buildReadyMsg(targetOrder.jobId);
    await sendMsg(phone, readyMsg);
    setTimer(phone, 'rating', 1800000, async () => {
      if (!s.ratingAsked) {
        s.ratingAsked = true;
        await sendMsg(phone, `⭐ How was your experience?\n5 Excellent  4 Good  3 Okay  2 Poor  1 Very poor`);
        setTimer(phone, 'rating_followup', 7200000, async () => {
          if (targetOrder.state === 'ready' && !s.ratingGiven)
            await sendMsg(phone, `⭐ How was your experience?\n5 Excellent  4 Good  3 Okay  2 Poor  1 Very poor`);
        });
      }
    });
    return `✅ Ready sent to ...${last4(phone)}.`;
  }

  if (cmd === 'status') {
    const found = findByLast4(args[0]);
    if (!found) return `❌ No session for "${args[0]}".`;
    const s = found.session;
    const orderLines = s.orders.map((o,i) =>
      `  Order ${o.ref}: ${o.state} | Files: ${o.files.length} | Bill: GHS ${o.totalBill?.toFixed(2)||'—'} | Job: ${o.jobId||'pending'}`
    ).join('\n');
    return [`📊 *...${last4(found.key)}*`,
      `Name: ${s.customerName||'—'}`,
      `Paused: ${s.paused ? 'YES' : 'no'}`,
      `Orders today:`, orderLines,
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
      const r = await askGPT([{ role: 'user', content:
        `You are parsing a Q&A list for a DTF print shop knowledge base.\n` +
        `Extract all question-answer pairs from this text. The format may be messy — ` +
        `numbered, dashed, plain alternating lines, Q:/A: prefixed, or anything else.\n\n` +
        `TEXT:\n${content}\n\n` +
        `Return ONLY a valid JSON array. Each object: {"q":"question","a":"answer"}\n` +
        `If a line is a standalone fact (not a Q&A), use {"q":null,"a":"the fact"}\n` +
        `No markdown. No explanation. JSON only.`
      }], null, 800, 12000);
      const raw = gptText(r).replace(/```json|```/g, '').trim();
      parsed = JSON.parse(raw);
    } catch(e) {
      // Fallback — add each non-empty line as a raw fact
      console.error('learnbulk GPT parse error:', e.message);
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
    const activeOrd = getActiveOrder(found.session);
    addFile(activeOrd, { size, qty, isUnknown: false, isMoreOf: null }, 'admin', '');
    return `✅ Added ${qty} ${size} for ...${args[0]}.`;
  }

  if (cmd === 'jobs') {
    const out = [`📋 *ACTIVE SESSIONS*`, ``];
    let i = 1;
    for (const [key, s] of sessions.entries()) {
      const state = sessState(s);
      const bill = sessTotalBill(s);
      const jid = sessJobId(s);
      const orderCount = s.orders?.filter(o => o.state !== 'idle').length || 0;
      out.push(`${i}. ...${last4(key)} (${s.customerName||'—'}) → ${state} | ${bill ? 'GHS '+bill.toFixed(2) : '—'}${jid?' | '+jid:''} | Orders: ${orderCount}`);
      i++;
    }
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

  // Smart hint: "admin W01 6161 38.40 2007" (missing the word "cash")
  if (!cmd) {
    const digits = args.filter(a => /^\d+(\.\d+)?$/.test(a));
    if (digits.length >= 2) {
      return `❓ Did you mean a cash payment? The word *cash* is missing.\nUse: admin ${workerId || 'W01'} cash <last4> <amount> <PIN>`;
    }
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
    else if (sessState(s) === 'awaiting_payment' && hrs > 24)   { archiveSession(key, s, 'abandoned'); count++; }
    else if (sessState(s) === 'processing' && hrs > 12)         { archiveSession(key, s, 'overdue');   count++; }
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
  // Production report — count from today's PAID orders (money = work done today),
  // deduplicated by job so a partial/second payment doesn't double-count the sheets.
  const bySize = { A4: 0, A3: 0, A2: 0 };
  const paidJobs = new Map(); // jobId → files (first payment wins)
  todayP.forEach(p => {
    const key = p.jobId && p.jobId !== '—' ? p.jobId : `noid:${p.phone}:${p.ts}`;
    if (!paidJobs.has(key)) paidJobs.set(key, p.files || []);
  });
  paidJobs.forEach(files => {
    (files || []).forEach(f => { if (bySize[f.size] !== undefined) bySize[f.size] += f.qty || 0; });
  });
  // "Completed" = jobs paid today (printing starts right after payment). Switch to
  // jobArchive 'completed' count here if you'd rather count only picked-up jobs.
  const completed = paidJobs.size;
  const todayArchive = jobArchive.filter(a => a.archivedDate === todayStr());
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

// Daily heartbeat — if the owner does NOT get this each morning, the bot is down.
function scheduleHeartbeat() {
  const now  = new Date();
  const next = new Date(); next.setHours(7, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(async () => {
    const today = (typeof todayStr === 'function') ? todayStr() : '';
    const todayPays = paymentLedger.filter(p => p.date === today);
    const momo = todayPays.filter(p => p.type === 'momo').reduce((s, p) => s + p.amount, 0);
    const cash = todayPays.filter(p => p.type === 'cash').reduce((s, p) => s + p.amount, 0);
    await alertOwner([
      `💚 *Migo Bot Healthy* — ${BOT_VERSION}`,
      `🕐 ${nowStr()}`,
      `📈 Yesterday: ${todayPays.length} payment(s) · MoMo GHS ${momo.toFixed(2)} · Cash GHS ${cash.toFixed(2)}`,
      `⚙️ All systems running.`,
    ].join('\n')).catch(() => {});
    scheduleHeartbeat();
  }, next - now);
  console.log(`💚 Heartbeat scheduled in ${Math.round((next - now) / 60000)} mins`);
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

// ── Customer order form (tap to choose sizes & copies) ────────
function orderFormPage(order, token, mode) {
  const shop = 'Migo Print Shop';
  const loc  = 'Circle · Near Benz Gate · Accra';
  const shell = (inner) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>${shop} — Your Order</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--brand:#4E9E25;--brand2:#3B7D17;--bg:#f4f4f6;--card:#fff;--ink:#17171c;--mut:#73737d;--line:#ececed;--ok:#16a34a}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;font-family:'Space Grotesk',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink);padding-bottom:120px}
.wrap{max-width:560px;margin:0 auto;padding:18px 16px}
.head{display:flex;align-items:center;gap:12px;padding:6px 2px 16px}
.logo{width:46px;height:46px;border-radius:13px;background:linear-gradient(135deg,var(--brand),var(--brand2));display:flex;align-items:center;justify-content:center;font-size:24px;box-shadow:0 6px 16px rgba(78,158,37,.32)}
.brand{font-weight:700;font-size:19px;letter-spacing:-.3px}
.loc{color:var(--mut);font-size:12.5px;margin-top:1px}
.sub{font-size:14px;color:var(--mut);margin:2px 2px 14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px;margin-bottom:12px;box-shadow:0 1px 2px rgba(0,0,0,.03)}
.allbar{background:linear-gradient(135deg,#f1f8e1,#fff);border:1px dashed #c5e1a5}
.allbar .t{font-weight:600;font-size:13px;margin-bottom:10px;color:var(--brand2)}
.row{display:flex;align-items:center;gap:12px}
.thumb{position:relative;width:52px;height:52px;border-radius:11px;background:#f1f1f4;display:flex;align-items:center;justify-content:center;font-size:22px;overflow:hidden;flex:0 0 auto}
.thumb.file{font-size:13px;font-weight:800;color:#3b7d17;background:#eef7e0;letter-spacing:.5px}
.thumb img{width:100%;height:100%;object-fit:cover}
.dlabel{font-weight:600;font-size:14.5px}
.sizes{display:flex;gap:8px;margin-top:12px}
.sz{flex:1;border:1.5px solid var(--line);border-radius:12px;padding:10px 4px;text-align:center;cursor:pointer;background:#fff;transition:.12s;user-select:none}
.sz b{display:block;font-size:15px;font-weight:700}
.sz span{display:block;font-size:11px;color:var(--mut);margin-top:2px}
.sz.on{border-color:var(--brand);background:#f1f8e1;box-shadow:0 0 0 3px rgba(78,158,37,.12)}
.sz.on b{color:var(--brand2)}
.qty{display:flex;align-items:center;gap:6px;margin-top:12px;justify-content:flex-end}
.qty .lab{font-size:13px;color:var(--mut);margin-right:6px}
.stp{width:44px;height:44px;border:1.5px solid var(--line);background:#fff;border-radius:12px;font-size:26px;font-weight:800;color:#000;cursor:pointer;display:flex;align-items:center;justify-content:center}
.qn{min-width:30px;text-align:center;font-size:24px;font-weight:800;color:#000}
.foot{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid var(--line);padding:12px 16px calc(12px + env(safe-area-inset-bottom));box-shadow:0 -6px 18px rgba(0,0,0,.05)}
.foot .in{max-width:560px;margin:0 auto;display:flex;align-items:center;gap:12px}
.tot{flex:1}.tot .l{font-size:11.5px;color:var(--mut)}.tot .v{font-size:22px;font-weight:700;letter-spacing:-.5px}
.btn{background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;border:0;border-radius:13px;padding:14px 22px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;box-shadow:0 6px 16px rgba(78,158,37,.32)}
.btn:disabled{opacity:.55}
.note{text-align:center;color:var(--mut);font-size:12px;margin-top:14px;padding:0 8px}
.msg{background:#fff;border:1px solid var(--line);border-radius:16px;padding:26px 18px;text-align:center;margin-top:30px}
.msg .big{font-size:40px}.msg h2{margin:10px 0 6px;font-size:19px}.msg p{color:var(--mut);font-size:14px;margin:0}
.tick{color:var(--ok)}
</style></head><body><div class="wrap">
<div class="head"><div class="logo">🖨️</div><div><div class="brand">${shop}</div><div class="loc">${loc}</div></div></div>
${inner}
</div></body></html>`;

  if (mode === 'invalid')
    return shell(`<div class="msg"><div class="big">⚠️</div><h2>Link not valid</h2><p>This order link is invalid or has expired. Please head back to WhatsApp and we'll sort you out.</p></div>`);
  if (mode === 'done')
    return shell(`<div class="msg"><div class="big tick">✅</div><h2>Order already confirmed</h2><p>Check your WhatsApp chat for your bill and payment details. Thank you! 🙏</p></div>`);

  const designs = (order.formDesigns || []).map(d => ({ label: d.label, name: d.name || '', size: d.size || null, qty: d.qty || 1, url: d.url || null, isImage: /\.(png|jpe?g|webp|gif)$/i.test(d.name || '') }));
  const data = { token, designs, prices: PRICES };
  const inner = `
<div class="sub">Tap a size and set how many copies for each design. You only pay after you approve. 👍</div>
<div id="all"></div>
<div id="list"></div>
<div class="note">Printing starts after payment confirmation. 🙏</div>
<div class="foot"><div class="in"><div class="tot"><div class="l">TOTAL</div><div class="v" id="tot">GHS 0.00</div></div>
<button class="btn" id="go">Confirm Order</button></div></div>
<script>
var D=${JSON.stringify(data)};
var P=D.prices, S=D.designs.map(function(d){return {size:d.size,qty:d.qty||1};});
function money(n){return 'GHS '+n.toFixed(2);}
function total(){var t=0;S.forEach(function(s){if(s.size)t+=P[s.size]*s.qty;});return t;}
function szHTML(idx,cur){var o=['A4','A3','A2'].map(function(z){var on=cur===z?' on':'';return '<div class="sz'+on+'" onclick="pick('+idx+',\\''+z+'\\')"><b>'+z+'</b><span>'+money(P[z])+'</span></div>';});return o.join('');}
function row(d,i){
  var th;
  if(d.isImage){ th='<div class="thumb">🖼️<img src="/thumb/'+D.token+'/'+i+'" onerror="this.remove()" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></div>'; }
  else { var ext=((d.name||'').split('.').pop()||'').toUpperCase(); if(!ext||ext.length>4)ext='FILE'; th='<div class="thumb file">'+ext+'</div>'; }
  return '<div class="card"><div class="row">'+th+'<div class="dlabel">'+d.label+'</div></div>'+
    '<div class="sizes">'+szHTML(i,S[i].size)+'</div>'+
    '<div class="qty"><span class="lab">Copies</span><div class="stp" onclick="bump('+i+',-1)">−</div><div class="qn" id="q'+i+'">'+S[i].qty+'</div><div class="stp" onclick="bump('+i+',1)">+</div></div></div>';
}
function draw(){
  var L=document.getElementById('list');L.innerHTML=D.designs.map(row).join('');
  if(D.designs.length>1){
    document.getElementById('all').innerHTML='<div class="card allbar"><div class="t">⚡ All one size? Apply this to all the designs</div>'+
      '<div class="sizes">'+['A4','A3','A2'].map(function(z){return '<div class="sz" id="A'+z+'" onclick="allPick(\\''+z+'\\')"><b>'+z+'</b><span>'+money(P[z])+'</span></div>';}).join('')+'</div>'+
      '<div class="qty"><span class="lab">Quantity</span><div class="stp" onclick="allBump(-1)">−</div><div class="qn" id="aq">1</div><div class="stp" onclick="allBump(1)">+</div></div>'+
      '<div style="margin-top:12px"><button class="btn" style="width:100%" onclick="applyAll()">Apply to all designs</button></div></div>';
  }
  upd();
}
var allSize=null,allQty=1;
function allPick(z){allSize=z;['A4','A3','A2'].forEach(function(x){document.getElementById('A'+x).className='sz'+(x===z?' on':'');});}
function allBump(d){allQty=Math.max(1,Math.min(999,allQty+d));document.getElementById('aq').textContent=allQty;}
function applyAll(){if(!allSize){alert('Pick a size to apply.');return;}S.forEach(function(s){s.size=allSize;s.qty=allQty;});draw();}
function pick(i,z){S[i].size=z;draw();}
function bump(i,d){S[i].qty=Math.max(1,Math.min(999,S[i].qty+d));document.getElementById('q'+i).textContent=S[i].qty;upd();}
function upd(){
  D.designs.forEach(function(d,i){
    var cards=document.getElementById('list').children[i];
    if(!cards)return;var sz=cards.querySelectorAll('.sz');['A4','A3','A2'].forEach(function(z,k){sz[k].className='sz'+(S[i].size===z?' on':'');});
  });
  document.getElementById('tot').textContent=money(total());
}
function submit(){
  for(var i=0;i<S.length;i++){if(!S[i].size){alert('Please choose a size for '+D.designs[i].label+'.');return;}}
  var b=document.getElementById('go');b.disabled=true;b.textContent='Confirming…';
  var ctrl=('AbortController' in window)?new AbortController():null;
  var to=setTimeout(function(){ if(ctrl)ctrl.abort(); },25000);
  fetch('/order/'+D.token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:S}),signal:ctrl?ctrl.signal:undefined})
   .then(function(r){return r.json();})
   .then(function(j){
     clearTimeout(to);
     if(j.ok){document.querySelector('.wrap').innerHTML='<div class="msg"><div class="big tick">✅</div><h2>Order confirmed!</h2><p>'+(j.msg||'Check WhatsApp for your bill.')+'</p></div>';document.querySelector('.foot').style.display='none';}
     else{b.disabled=false;b.textContent='Confirm Order';alert(j.msg||'Something went wrong. Please try again.');}
   }).catch(function(){
     clearTimeout(to);
     b.disabled=false;b.textContent='Confirm Order';
     alert('Hmm, the connection is slow. Please check your WhatsApp — if your bill is not there in a minute, tap Confirm Order again. 🙏');
   });
}
document.getElementById('go').onclick=submit;
draw();
</script>`;
  return shell(inner);
}

function resolveOrderFromToken(token) {
  const info = parseOrderToken(token);
  if (!info) return null;
  const session = sessions.get(info.phone);
  if (!session) return null;
  const order = session.orders.find(o => o.ref === info.ref);
  if (!order) return null;
  return { phone: info.phone, session, order };
}

app.get('/c/:code', (req, res) => {
  res.set('Content-Type', 'text/html');
  const ref = shortIndex.get(req.params.code);
  if (!ref) return res.status(404).send(orderFormPage(null, null, 'invalid'));
  const session = sessions.get(ref.phone);
  const order = session && session.orders.find(o => o.ref === ref.ref);
  if (!order) return res.status(404).send(orderFormPage(null, null, 'invalid'));
  const token = makeOrderToken(ref.phone, order.ref);
  if (order.paymentReceived || ['processing', 'ready'].includes(order.state))
    return res.send(orderFormPage(order, token, 'done'));
  ensureFormDesigns(order);
  res.send(orderFormPage(order, token, 'open'));
});

// Thumbnail proxy — the bot downloads the customer's file and streams it, so image
// previews load in the browser even when the raw WhatsApp media URL won't.
app.get('/thumb/:token/:idx', async (req, res) => {
  const r = resolveOrderFromToken(req.params.token);
  if (!r) return res.status(404).end();
  ensureFormDesigns(r.order);
  const d = (r.order.formDesigns || [])[parseInt(req.params.idx, 10)];
  if (!d || !d.url || !/\.(png|jpe?g|webp|gif)$/i.test(d.name || '')) return res.status(404).end();
  try {
    const { buffer, mime } = await downloadBuffer(d.url);
    res.set('Content-Type', mime && mime.startsWith('image/') ? mime : 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    res.end(buffer);
  } catch (e) { res.status(404).end(); }
});

app.get('/order/:token', (req, res) => {
  const r = resolveOrderFromToken(req.params.token);
  res.set('Content-Type', 'text/html');
  if (!r) return res.status(404).send(orderFormPage(null, null, 'invalid'));
  if (r.order.paymentReceived || ['processing', 'ready'].includes(r.order.state)) {
    return res.send(orderFormPage(r.order, req.params.token, 'done'));
  }
  ensureFormDesigns(r.order);
  res.send(orderFormPage(r.order, req.params.token, 'open'));
});

app.post('/order/:token', async (req, res) => {
  const r = resolveOrderFromToken(req.params.token);
  if (!r) return res.json({ ok: false, msg: 'This order link is invalid or expired.' });
  const { order, session, phone } = r;
  if (order.paymentReceived || ['confirming', 'processing', 'ready'].includes(order.state))
    return res.json({ ok: false, msg: 'This order is already confirmed.' });

  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const clean = items
    .map(it => ({ size: String(it.size || '').toUpperCase(), qty: parseInt(it.qty, 10) }))
    .filter(it => ['A4', 'A3', 'A2'].includes(it.size) && it.qty >= 1 && it.qty <= 999);
  if (!clean.length) return res.json({ ok: false, msg: 'Please choose a size and at least 1 copy for each design.' });

  // The form is the single source of truth — rebuild the order from it.
  order.files = [];
  order.pendingImages = [];
  order.unknownFiles = [];
  order.qtyPending = [];
  order.assumedQtyCount = 0;
  clean.forEach((it, i) => addFile(order, { size: it.size, qty: it.qty, isUnknown: false, isMoreOf: null }, `order form ${i + 1}`, ''));
  order.formDesigns = clean.map((it, i) => ({ label: `Design ${i + 1}`, size: it.size, qty: it.qty }));

  clearTimers(phone);
  // Lock immediately (blocks a double-tap), REPLY INSTANTLY, then send the WhatsApp bill
  // in the BACKGROUND. The page no longer waits on the 6s send-queue or a Render cold
  // start — that delay is what used to surface to the customer as a false "Network error".
  order.state = 'confirming';
  audit('ORDER_FORM_SUBMITTED', phone, clean.map(c => `${c.size}×${c.qty}`).join(', '));
  res.json({ ok: true, msg: 'Order confirmed! Check WhatsApp for your bill. 🙏' });
  sendBill(phone, session, order).catch(err => {
    console.error('background sendBill failed:', err && err.message);
    // if the bill never went out, unlock so the customer can retry from the link
    if (order.state === 'confirming' && !order.paymentReceived) order.state = 'receiving';
  });
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
// NOTE: the live /api/stats route is defined inside setupDashboard() with
// authMiddleware. The earlier un-authed duplicate was removed in v52 — it
// registered first (so it always won), returned the wrong field names, and
// leaked daily revenue without a token.

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
    active:          [...sessions.values()].filter(s => sessState(s) === 'processing').length,
    awaiting_payment:[...sessions.values()].filter(s => sessState(s) === 'awaiting_payment').length,
    ready:           [...sessions.values()].filter(s => s.state === 'ready').length,
  },
}));

// ── Dashboard ─────────────────────────────────────────────────

// ── Admin & Worker Dashboard HTML ────────────────────────────
function adminHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Migo Print Shop — Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700;800&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#0a0a0f;
  --surface:#111118;
  --card:#18181f;
  --border:#2a2a35;
  --text:#f0f0f5;
  --muted:#6b6b80;
  --green:#00d68f;
  --amber:#ffb020;
  --blue:#4d9fff;
  --red:#ff4d6a;
  --nav-h:56px;
}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:'Space Grotesk',sans-serif;min-height:100vh;padding-bottom:calc(var(--nav-h) + 12px)}

/* ── HEADER ── */
.hd{background:var(--surface);border-bottom:2px solid var(--border);padding:0 16px;height:56px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:100}
.hd-brand{display:flex;align-items:center;gap:12px}
.hd-logo{width:36px;height:36px;background:var(--amber);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px}
.hd-name{font-size:16px;font-weight:800;color:var(--text);letter-spacing:-.3px}
.hd-role{font-size:10px;font-weight:700;color:var(--amber);text-transform:uppercase;letter-spacing:1px}
.live-dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 8px var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.6;transform:scale(.85)}}
.btn-sm{padding:6px 14px;border:1.5px solid var(--border);border-radius:8px;background:transparent;color:var(--muted);font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .15s}
.btn-sm:hover{border-color:var(--red);color:var(--red)}

/* ── STATS BAR ── */
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:14px 14px 0}
.stat{background:var(--card);border:1.5px solid var(--border);border-radius:12px;padding:14px 12px;text-align:center;cursor:default}
.stat-val{font-size:22px;font-weight:900;font-family:'JetBrains Mono',monospace;line-height:1;color:#ffffff}
.stat-lbl{font-size:10px;font-weight:900;color:#ffffff;text-transform:uppercase;letter-spacing:.8px;margin-top:5px}
.c-green{color:var(--green)}.c-amber{color:var(--amber)}.c-blue{color:var(--blue)}.c-red{color:var(--red)}

/* ── TEST MODE BANNER ── */
.test-banner{margin:12px 14px 0;background:#1a1500;border:2px solid var(--amber);border-radius:10px;padding:10px 14px;font-size:13px;font-weight:700;color:var(--amber);display:flex;align-items:center;gap:8px}

/* ── PANEL ── */
.panel{padding:14px;display:none}.panel.on{display:block}
.ph{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.ph h2{font-size:13px;font-weight:900;text-transform:uppercase;letter-spacing:.8px;color:#ffffff}
.refresh-btn{padding:6px 12px;background:var(--card);border:1.5px solid var(--border);border-radius:8px;color:var(--muted);font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .15s}
.refresh-btn:hover{border-color:var(--blue);color:var(--blue)}

/* ── TABLE ── */
.tbl-wrap{background:var(--card);border:1.5px solid var(--border);border-radius:12px;overflow:hidden}
table{width:100%;border-collapse:collapse}
th{background:var(--surface);padding:10px 12px;text-align:left;color:#ffffff;font-weight:900;font-size:11px;text-transform:uppercase;letter-spacing:.8px;border-bottom:1.5px solid var(--border)}
td{padding:12px 12px;border-bottom:1px solid var(--border);vertical-align:middle;font-size:13px;font-weight:700;color:#ffffff}
tr:last-child td{border-bottom:none}
tr:hover td{background:#ffffff04}

/* ── BADGES ── */
.badge{padding:4px 10px;border-radius:20px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap}
.b-green{background:#00d68f18;color:var(--green);border:1px solid #00d68f30}
.b-amber{background:#ffb02018;color:var(--amber);border:1px solid #ffb02030}
.b-blue{background:#4d9fff18;color:var(--blue);border:1px solid #4d9fff30}
.b-red{background:#ff4d6a18;color:var(--red);border:1px solid #ff4d6a30}

/* ── ACTION BUTTONS ── */
.btn-action{padding:7px 14px;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:800;font-family:inherit;transition:all .15s;white-space:nowrap;text-transform:uppercase;letter-spacing:.3px}
.btn-green{background:var(--green);color:#000}.btn-green:hover{background:#00f0a0}
.btn-blue{background:var(--blue);color:#fff}.btn-blue:hover{background:#6aafff}
.btn-red{background:var(--red);color:#fff}.btn-red:hover{background:#ff6680}
.btn-muted{background:var(--border);color:var(--muted)}.btn-muted:hover{background:#333340}

/* ── WORKER FORM ── */
.w-form{background:var(--card);border:1.5px solid var(--border);border-radius:12px;padding:14px;margin-bottom:12px;display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end}
.w-form input{background:var(--bg);border:1.5px solid var(--border);color:var(--text);padding:9px 12px;border-radius:8px;font-size:13px;font-family:inherit;font-weight:600;flex:1;min-width:80px;transition:border-color .15s}
.w-form input:focus{outline:none;border-color:var(--blue)}
.w-form input::placeholder{color:var(--muted)}

/* ── MODAL ── */
.modal{display:none;position:fixed;inset:0;background:#00000099;z-index:999;align-items:center;justify-content:center;backdrop-filter:blur(4px)}
.modal.open{display:flex}
.modal-box{background:var(--card);border:1.5px solid var(--border);border-radius:16px;padding:24px;width:92%;max-width:340px;box-shadow:0 24px 64px #00000080}
.modal-box h3{font-size:16px;font-weight:800;margin-bottom:6px;color:var(--text)}
.modal-box p{font-size:12px;color:var(--muted);margin-bottom:16px;font-weight:600}
.modal-lbl{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;display:block;margin-bottom:5px}
.modal-input{width:100%;margin-bottom:14px;padding:11px 13px;background:var(--bg);border:1.5px solid var(--border);color:var(--text);border-radius:10px;font-size:14px;font-family:inherit;font-weight:600;transition:border-color .15s}
.modal-input:focus{outline:none;border-color:var(--blue)}
.modal-err{color:var(--red);font-size:12px;font-weight:700;min-height:18px;margin-bottom:8px}
.modal-btns{display:flex;gap:10px}
.modal-btns button{flex:1;padding:12px;border:none;border-radius:10px;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;transition:all .15s}

/* ── EMPTY STATE ── */
.empty{text-align:center;padding:40px 20px;color:var(--muted)}
.empty-icon{font-size:40px;margin-bottom:10px;opacity:.5}
.empty-txt{font-size:13px;font-weight:600}

/* ── NAV ── */
nav{position:fixed;bottom:0;left:0;right:0;background:var(--surface);border-top:2px solid var(--border);display:grid;grid-template-columns:repeat(5,1fr);height:var(--nav-h);z-index:100}
.nav-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;cursor:pointer;color:#ffffff;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.5px;border:none;background:none;font-family:inherit;transition:color .15s;padding:0;border-top:3px solid transparent;transition:all .15s}
.nav-btn:hover{color:var(--amber)}
.nav-btn.on{color:var(--amber);border-top-color:var(--amber)}
.nav-icon{font-size:18px;line-height:1}

/* ── MONO ── */
.mono{font-family:'JetBrains Mono',monospace;font-size:12px}
.flag-row td{background:#ff4d6a08!important}
</style>
</head>
<body>

<!-- HEADER -->
<div class="hd">
  <div class="hd-brand">
    <div class="hd-logo">🖨️</div>
    <div>
      <div class="hd-name">Migo Print Shop</div>
      <div class="hd-role">Admin Dashboard</div>
    </div>
  </div>
  <div style="display:flex;align-items:center;gap:12px">
    <div class="live-dot" title="Bot live"></div>
    <button class="btn-sm" onclick="logout()">Sign Out</button>
  </div>
</div>

${`<!-- TEST BANNER -->`}
<div id="testBanner" style="display:none" class="test-banner">🧪 TEST MODE ON — Bot only responding to owner number</div>

<!-- STATS -->
<div class="stats">
  <div class="stat"><div class="stat-val c-blue" id="sn">—</div><div class="stat-lbl">Active Jobs</div></div>
  <div class="stat"><div class="stat-val c-green" id="sm">—</div><div class="stat-lbl">MoMo Today</div></div>
  <div class="stat"><div class="stat-val c-amber" id="sc">—</div><div class="stat-lbl">Cash Today</div></div>
</div>

<!-- PANELS -->
<div class="panel on" id="b0">
  <div class="ph"><h2>🖨️ Live Queue</h2><button class="refresh-btn" onclick="lq()">↻ Refresh</button></div>
  <div class="tbl-wrap">
    <table>
      <thead><tr><th>#</th><th>Customer</th><th>Status</th><th>Files</th><th>Bill</th><th>Job ID</th><th>Action</th></tr></thead>
      <tbody id="qb"><tr><td colspan="7" style="text-align:center;padding:24px;color:var(--muted);font-weight:700">Loading...</td></tr></tbody>
    </table>
  </div>
</div>

<div class="panel" id="b1">
  <div class="ph"><h2>💰 Payments</h2><button class="refresh-btn" onclick="lp()">↻ Refresh</button></div>
  <div class="tbl-wrap">
    <table>
      <thead><tr><th>Time</th><th>Customer</th><th>Amount</th><th>Type</th><th>Worker</th><th>Job ID</th></tr></thead>
      <tbody id="pb"><tr><td colspan="6" style="text-align:center;padding:24px;color:var(--muted);font-weight:700">Loading...</td></tr></tbody>
    </table>
  </div>
</div>

<div class="panel" id="b2">
  <div class="ph"><h2>👷 Workers</h2></div>
  <div class="w-form">
    <input id="wi" placeholder="ID e.g. W04">
    <input id="wn" placeholder="Name">
    <input id="wp" placeholder="PIN" type="password">
    <button class="btn-action btn-blue" onclick="addW()">+ Add</button>
  </div>
  <div class="tbl-wrap">
    <table>
      <thead><tr><th>ID</th><th>Name</th><th>Added</th><th>Action</th></tr></thead>
      <tbody id="wb"></tbody>
    </table>
  </div>
</div>

<div class="panel" id="b3">
  <div class="ph"><h2>⭐ Ratings</h2><button class="refresh-btn" onclick="lr()">↻ Refresh</button></div>
  <div class="tbl-wrap">
    <table>
      <thead><tr><th>Time</th><th>Score</th><th>Customer</th><th>Comment</th><th>Job ID</th></tr></thead>
      <tbody id="rb"></tbody>
    </table>
  </div>
</div>

<div class="panel" id="b4">
  <div class="ph"><h2>🔍 Audit Log</h2><button class="refresh-btn" onclick="la()">↻ Refresh</button></div>
  <div class="tbl-wrap">
    <table>
      <thead><tr><th>Time</th><th>Action</th><th>Customer</th><th>Detail</th></tr></thead>
      <tbody id="ab"></tbody>
    </table>
  </div>
</div>

<!-- CASH MODAL -->
<div class="modal" id="cm">
  <div class="modal-box">
    <h3>💵 Confirm Cash Payment</h3>
    <p>Customer: <b id="cm-phone" style="color:var(--text)"></b> &nbsp;·&nbsp; Total: <b id="cm-amt" style="color:var(--green)"></b></p>
    <label class="modal-lbl">Amount received (blank = full total)</label>
    <input class="modal-input" id="cm-custom" type="number" step="0.01" placeholder="Leave blank for full amount">
    <label class="modal-lbl">Your PIN</label>
    <input class="modal-input" id="cm-pin" type="password" placeholder="Enter PIN" maxlength="6">
    <div class="modal-err" id="cm-err"></div>
    <div class="modal-btns">
      <button style="background:var(--border);color:var(--muted)" onclick="closeCash()">Cancel</button>
      <button id="cm-btn" style="background:var(--green);color:#000" onclick="confirmCash()">Confirm Cash</button>
    </div>
  </div>
</div>

<!-- NAV -->
<nav>
  <button class="nav-btn on" id="n0" onclick="sw(0)"><span class="nav-icon">🖨️</span>Queue</button>
  <button class="nav-btn" id="n1" onclick="sw(1)"><span class="nav-icon">💰</span>Payments</button>
  <button class="nav-btn" id="n2" onclick="sw(2)"><span class="nav-icon">👷</span>Workers</button>
  <button class="nav-btn" id="n3" onclick="sw(3)"><span class="nav-icon">⭐</span>Ratings</button>
  <button class="nav-btn" id="n4" onclick="sw(4)"><span class="nav-icon">🔍</span>Audit</button>
</nav>

<script>
var TK=localStorage.getItem('migo_token');
if(!TK)window.location.href='/login';

function api(p,m,b){
  function call(){return fetch(p,{method:m||'GET',headers:{'Content-Type':'application/json','X-Dashboard-Token':TK},body:b?JSON.stringify(b):null}).then(function(r){return r.json();});}
  return call().catch(function(){return new Promise(function(res){setTimeout(function(){call().then(res).catch(function(){res({ok:false});});},3000);});});
}

function sw(i){
  document.querySelectorAll('.panel').forEach(function(x){x.classList.remove('on');});
  document.querySelectorAll('.nav-btn').forEach(function(x){x.classList.remove('on');});
  document.getElementById('b'+i).classList.add('on');
  document.getElementById('n'+i).classList.add('on');
  [lq,lp,lw,lr,la][i]();
}

var stateBadge={awaiting_payment:'b-amber',processing:'b-blue',confirming:'b-amber',ready:'b-green',idle:'b-red',receiving:'b-blue',asked_done:'b-blue',asking_image_info:'b-blue',asking_pressing:'b-blue',asking_qty:'b-blue'};
var stateLabel={awaiting_payment:'Awaiting Payment',processing:'Printing',confirming:'Confirming',ready:'Ready',idle:'Idle',receiving:'Receiving',asked_done:'Done?',asking_image_info:'Asking Details',asking_pressing:'Pressing?',asking_qty:'Asking Copies'};

function lq(){
  api('/api/stats').then(function(st){
    if(!st.ok)return;
    document.getElementById('sn').textContent=st.sessions||0;
    document.getElementById('sm').textContent='GHS '+(st.todayMomo||0).toFixed(2);
    document.getElementById('sc').textContent='GHS '+(st.todayCash||0).toFixed(2);
  });
  api('/api/sessions').then(function(se){
    if(!se.ok)return;
    var all=(se.sessions||[]).filter(function(s){
      return s.state!=='idle'||s.files>0||s.totalBill;
    });
    var rows=all.map(function(s){
      var btn='';
      if(s.state==='processing'){
        btn='<button class="btn-action btn-green" onclick="rd(this)" data-phone="'+s.phone+'">Ready</button>';
      }
      if(s.state==='awaiting_payment'){
        var amt=s.totalBill?s.totalBill.toFixed(2):'0.00';
        btn='<button class="btn-action btn-blue" onclick="showCash(this)" data-phone="'+s.phone+'" data-amt="'+amt+'">Cash</button>';
      }
      var qp=s.queuePosition?'#'+s.queuePosition:'&mdash;';
      var bill=s.totalBill?'<b style="color:#00d68f">GHS '+s.totalBill.toFixed(2)+'</b>':'&mdash;';
      var jid=s.jobId?'<span style="font-size:11px;color:#6b6b80">'+s.jobId+'</span>':'&mdash;';
      var bclass=stateBadge[s.state]||'b-blue';
      var blabel=stateLabel[s.state]||s.state;
      var badge='<span class="badge '+bclass+'">'+blabel+'</span>';
      var name='<b>'+(s.customerName||s.phone)+'</b>';
      return '<tr><td>'+qp+'</td><td>'+name+'</td><td>'+badge+'</td><td>'+s.files+'</td><td>'+bill+'</td><td>'+jid+'</td><td>'+btn+'</td></tr>';
    }).join('');
    document.getElementById('qb').innerHTML=rows||'<tr><td colspan="7" style="text-align:center;padding:24px;color:#6b6b80">No active jobs</td></tr>';
  });
}

function rd(el){
  var phone=el.getAttribute('data-phone');
  if(!confirm('Mark ready and send pickup code?'))return;
  api('/api/mark-ready','POST',{phone:phone}).then(function(r){if(r.ok)lq();else alert(r.error||'Failed');});
}

var cashPhone='',cashAmt=0;
function showCash(el){
  cashPhone=el.getAttribute('data-phone');
  cashAmt=parseFloat(el.getAttribute('data-amt'))||0;
  var phone=cashPhone, amt=cashAmt;
  document.getElementById('cm-phone').textContent=phone.replace('@s.whatsapp.net','');
  document.getElementById('cm-amt').textContent='GHS '+amt.toFixed(2);
  document.getElementById('cm-custom').value='';
  document.getElementById('cm-pin').value='';
  document.getElementById('cm-err').textContent='';
  document.getElementById('cm-btn').disabled=false;
  document.getElementById('cm-btn').textContent='Confirm Cash';
  document.getElementById('cm').classList.add('open');
  setTimeout(function(){document.getElementById('cm-pin').focus();},100);
}
function closeCash(){document.getElementById('cm').classList.remove('open');}
function confirmCash(){
  var customAmt=document.getElementById('cm-custom').value.trim();
  var amount=customAmt?parseFloat(customAmt):cashAmt;
  var pin=document.getElementById('cm-pin').value.trim();
  if(!pin){document.getElementById('cm-err').textContent='Enter your PIN';return;}
  if(isNaN(amount)||amount<=0){document.getElementById('cm-err').textContent='Invalid amount';return;}
  document.getElementById('cm-btn').disabled=true;
  document.getElementById('cm-btn').textContent='Processing...';
  api('/api/cash-payment','POST',{phone:cashPhone,amount:amount,pin:pin}).then(function(r){
    if(r.ok){closeCash();lq();alert('✅ Cash confirmed!');}
    else{document.getElementById('cm-err').textContent=r.error||'Failed';document.getElementById('cm-btn').disabled=false;document.getElementById('cm-btn').textContent='Confirm Cash';}
  }).catch(function(){document.getElementById('cm-err').textContent='Network error';document.getElementById('cm-btn').disabled=false;document.getElementById('cm-btn').textContent='Confirm Cash';});
}

function lp(){
  api('/api/payments').then(function(d){
    if(!d.ok)return;
    var rows=(d.payments||[]).slice().reverse().map(function(p){
      var typeColor=p.type==='momo'?'var(--green)':'var(--amber)';
      return '<tr><td class="mono" style="color:var(--muted)">'+(p.ts||'')+'</td><td style="font-weight:700">'+(p.phone||'')+'</td><td style="font-weight:800;color:'+typeColor+'">GHS '+parseFloat(p.amount||0).toFixed(2)+'</td><td><span class="badge '+(p.type==='momo'?'b-green':'b-amber')+'">'+(p.type||'').toUpperCase()+'</span></td><td style="font-weight:700">'+(p.workerName||'Auto')+'</td><td class="mono" style="font-size:11px;color:var(--muted)">'+(p.jobId||'')+'</td></tr>';
    }).join('');
    document.getElementById('pb').innerHTML=rows||'<tr><td colspan="6"><div class="empty"><div class="empty-icon">💰</div><div class="empty-txt">No payments today</div></div></td></tr>';
  });
}

function lw(){
  api('/api/workers').then(function(d){
    if(!d.ok)return;
    var rows=(d.workers||[]).map(function(w){
      return '<tr><td><span class="badge b-blue">'+w.id+'</span></td><td style="font-weight:700">'+w.name+'</td><td class="mono" style="color:var(--muted)">'+(w.addedAt||'')+'</td><td><button class="btn-action btn-red" onclick="rmW(\''+w.id+'\')">Remove</button></td></tr>';
    }).join('');
    document.getElementById('wb').innerHTML=rows||'<tr><td colspan="4"><div class="empty"><div class="empty-icon">👷</div><div class="empty-txt">No workers added</div></div></td></tr>';
  });
}
function addW(){
  var id=document.getElementById('wi').value.toUpperCase().trim();
  var name=document.getElementById('wn').value.trim();
  var pin=document.getElementById('wp').value.trim();
  if(!id||!name||!pin){alert('Fill all fields');return;}
  api('/api/workers/add','POST',{id:id,name:name,pin:pin}).then(function(r){
    if(r.ok){document.getElementById('wi').value='';document.getElementById('wn').value='';document.getElementById('wp').value='';lw();}
    else alert(r.error||'Failed');
  });
}
function rmW(id){if(!confirm('Remove worker '+id+'?'))return;api('/api/workers/remove','POST',{id:id}).then(lw);}

function lr(){
  api('/api/ratings').then(function(d){
    if(!d.ok)return;
    var rows=(d.ratings||[]).slice().reverse().map(function(rt){
      var stars='';for(var i=0;i<5;i++)stars+='<span style="color:'+(i<rt.score?'var(--amber)':'var(--border)')+'">★</span>';
      var scoreColor=rt.score<=2?'var(--red)':rt.score>=5?'var(--green)':'var(--amber)';
      return '<tr><td class="mono" style="color:var(--muted)">'+(rt.ts||rt.date||'')+'</td><td style="font-size:16px">'+stars+'</td><td style="font-weight:700">'+(rt.phone||'')+'</td><td style="color:var(--muted)">'+(rt.comment||'—')+'</td><td class="mono" style="font-size:11px;color:var(--muted)">'+(rt.jobId||'')+'</td></tr>';
    }).join('');
    document.getElementById('rb').innerHTML=rows||'<tr><td colspan="5"><div class="empty"><div class="empty-icon">⭐</div><div class="empty-txt">No ratings yet</div></div></td></tr>';
  });
}

function la(){
  api('/api/audit').then(function(d){
    if(!d.ok)return;
    var rows=(d.audit||[]).map(function(a){
      return '<tr class="'+(a.flag?'flag-row':'')+'"><td class="mono" style="color:var(--muted)">'+a.ts+'</td><td style="font-weight:700">'+(a.flag?'🚩 ':'')+a.action+'</td><td style="font-weight:600">'+(a.phone||'—')+'</td><td style="color:var(--muted);font-size:12px">'+(a.detail||'')+'</td></tr>';
    }).join('');
    document.getElementById('ab').innerHTML=rows||'<tr><td colspan="4"><div class="empty"><div class="empty-icon">🔍</div><div class="empty-txt">No audit entries</div></div></td></tr>';
  });
}

function logout(){localStorage.removeItem('migo_token');localStorage.removeItem('migo_role');window.location.href='/login';}

// Close modal on backdrop click
document.getElementById('cm').addEventListener('click',function(e){if(e.target===this)closeCash();});

// Initial load
lq();
setInterval(lq,15000);
</script>
</body></html>`;
}

function workerHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Migo — Worker View</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700;800&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#0a0a0f;--surface:#111118;--card:#18181f;--border:#2a2a35;--text:#f0f0f5;--muted:#6b6b80;--green:#00d68f;--amber:#ffb020;--blue:#4d9fff;--red:#ff4d6a;--nav-h:56px;}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:'Space Grotesk',sans-serif;min-height:100vh;padding-bottom:calc(var(--nav-h)+12px)}
.hd{background:var(--surface);border-bottom:2px solid var(--border);padding:0 16px;height:56px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:100}
.hd-brand{display:flex;align-items:center;gap:12px}
.hd-logo{width:36px;height:36px;background:var(--blue);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px}
.hd-name{font-size:16px;font-weight:800}
.hd-role{font-size:10px;font-weight:700;color:var(--blue);text-transform:uppercase;letter-spacing:1px}
.live-dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 8px var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.6;transform:scale(.85)}}
.btn-sm{padding:6px 14px;border:1.5px solid var(--border);border-radius:8px;background:transparent;color:var(--muted);font-size:12px;font-weight:700;cursor:pointer;font-family:inherit}
.btn-sm:hover{border-color:var(--red);color:var(--red)}
.panel{padding:14px;display:none}.panel.on{display:block}
.ph{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.ph h2{font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.8px}
.refresh-btn{padding:6px 12px;background:var(--card);border:1.5px solid var(--border);border-radius:8px;color:var(--muted);font-size:12px;font-weight:700;cursor:pointer;font-family:inherit}
.refresh-btn:hover{border-color:var(--blue);color:var(--blue)}
.tbl-wrap{background:var(--card);border:1.5px solid var(--border);border-radius:12px;overflow:hidden}
table{width:100%;border-collapse:collapse}
th{background:var(--surface);padding:10px 12px;text-align:left;color:#ffffff;font-weight:900;font-size:11px;text-transform:uppercase;letter-spacing:.8px;border-bottom:1.5px solid var(--border)}
td{padding:12px 12px;border-bottom:1px solid var(--border);vertical-align:middle;font-size:13px;font-weight:700;color:#ffffff}
tr:last-child td{border-bottom:none}
tr:hover td{background:#ffffff04}
.badge{padding:4px 10px;border-radius:20px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.5px}
.b-green{background:#00d68f18;color:var(--green);border:1px solid #00d68f30}
.b-amber{background:#ffb02018;color:var(--amber);border:1px solid #ffb02030}
.b-blue{background:#4d9fff18;color:var(--blue);border:1px solid #4d9fff30}
.btn-action{padding:8px 16px;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:800;font-family:inherit;transition:all .15s;white-space:nowrap;text-transform:uppercase;letter-spacing:.3px}
.btn-green{background:var(--green);color:#000}.btn-green:hover{background:#00f0a0}
.btn-blue{background:var(--blue);color:#fff}.btn-blue:hover{background:#6aafff}
.modal{display:none;position:fixed;inset:0;background:#00000099;z-index:999;align-items:center;justify-content:center;backdrop-filter:blur(4px)}
.modal.open{display:flex}
.modal-box{background:var(--card);border:1.5px solid var(--border);border-radius:16px;padding:24px;width:92%;max-width:340px;box-shadow:0 24px 64px #00000080}
.modal-box h3{font-size:16px;font-weight:800;margin-bottom:6px}
.modal-box p{font-size:12px;color:var(--muted);margin-bottom:16px;font-weight:600}
.modal-lbl{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;display:block;margin-bottom:5px}
.modal-input{width:100%;margin-bottom:14px;padding:11px 13px;background:var(--bg);border:1.5px solid var(--border);color:var(--text);border-radius:10px;font-size:14px;font-family:inherit;font-weight:600}
.modal-input:focus{outline:none;border-color:var(--blue)}
.modal-err{color:var(--red);font-size:12px;font-weight:700;min-height:18px;margin-bottom:8px}
.modal-btns{display:flex;gap:10px}
.modal-btns button{flex:1;padding:12px;border:none;border-radius:10px;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit}
.empty{text-align:center;padding:40px 20px;color:var(--muted)}
.empty-icon{font-size:40px;margin-bottom:10px;opacity:.5}
.empty-txt{font-size:13px;font-weight:600}
nav{position:fixed;bottom:0;left:0;right:0;background:var(--surface);border-top:2px solid var(--border);display:grid;grid-template-columns:repeat(2,1fr);height:var(--nav-h);z-index:100}
.nav-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;cursor:pointer;color:#ffffff;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.5px;border:none;background:none;font-family:inherit;transition:all .15s;border-top:3px solid transparent}
.nav-btn:hover{color:var(--amber)}
.nav-btn.on{color:var(--blue);border-top-color:var(--blue)}
.nav-icon{font-size:18px;line-height:1}
.mono{font-family:'JetBrains Mono',monospace;font-size:12px}
</style>
</head>
<body>

<div class="hd">
  <div class="hd-brand">
    <div class="hd-logo">👷</div>
    <div>
      <div class="hd-name" id="workerName">Worker</div>
      <div class="hd-role">Worker Dashboard</div>
    </div>
  </div>
  <div style="display:flex;align-items:center;gap:12px">
    <div class="live-dot"></div>
    <button class="btn-sm" onclick="logout()">Sign Out</button>
  </div>
</div>

<div class="panel on" id="b0">
  <div class="ph"><h2>🖨️ Job Queue</h2><button class="refresh-btn" onclick="load()">↻ Refresh</button></div>
  <div class="tbl-wrap">
    <table>
      <thead><tr><th>#</th><th>Customer</th><th>Status</th><th>Files</th><th>Bill</th><th>Job ID</th><th>Action</th></tr></thead>
      <tbody id="qb"><tr><td colspan="7" style="text-align:center;padding:24px;color:var(--muted);font-weight:700">Loading...</td></tr></tbody>
    </table>
  </div>
</div>

<div class="panel" id="b1">
  <div class="ph"><h2>💰 My Payments</h2><button class="refresh-btn" onclick="lp()">↻ Refresh</button></div>
  <div class="tbl-wrap">
    <table>
      <thead><tr><th>Time</th><th>Customer</th><th>Amount</th><th>Job ID</th></tr></thead>
      <tbody id="pb"></tbody>
    </table>
  </div>
</div>

<!-- CASH MODAL -->
<div class="modal" id="cm">
  <div class="modal-box">
    <h3>💵 Confirm Cash Payment</h3>
    <p>Customer: <b id="cm-phone" style="color:var(--text)"></b> &nbsp;·&nbsp; Total: <b id="cm-amt" style="color:var(--green)"></b></p>
    <label class="modal-lbl">Amount received (blank = full total)</label>
    <input class="modal-input" id="cm-custom" type="number" step="0.01" placeholder="Leave blank for full amount">
    <label class="modal-lbl">Your PIN</label>
    <input class="modal-input" id="cm-pin" type="password" placeholder="Enter PIN" maxlength="6">
    <div class="modal-err" id="cm-err"></div>
    <div class="modal-btns">
      <button style="background:var(--border);color:var(--muted)" onclick="closeCash()">Cancel</button>
      <button id="cm-btn" style="background:var(--green);color:#000" onclick="confirmCash()">Confirm Cash</button>
    </div>
  </div>
</div>

<nav>
  <button class="nav-btn on" id="n0" onclick="sw(0)"><span class="nav-icon">🖨️</span>Queue</button>
  <button class="nav-btn" id="n1" onclick="sw(1)"><span class="nav-icon">💰</span>Payments</button>
</nav>

<script>
var TK=localStorage.getItem('migo_token');
if(!TK)window.location.href='/login';

function api(p,m,b){
  function call(){return fetch(p,{method:m||'GET',headers:{'Content-Type':'application/json','X-Dashboard-Token':TK},body:b?JSON.stringify(b):null}).then(function(r){return r.json();});}
  return call().catch(function(){return new Promise(function(res){setTimeout(function(){call().then(res).catch(function(){res({ok:false});});},3000);});});
}

function sw(i){
  document.querySelectorAll('.panel').forEach(function(x){x.classList.remove('on');});
  document.querySelectorAll('.nav-btn').forEach(function(x){x.classList.remove('on');});
  document.getElementById('b'+i).classList.add('on');
  document.getElementById('n'+i).classList.add('on');
  if(i===0)load();else lp();
}

var stateBadge={awaiting_payment:'b-amber',processing:'b-blue',ready:'b-green',idle:'b-amber',receiving:'b-blue'};
var stateLabel={awaiting_payment:'Awaiting Payment',processing:'Printing',ready:'Ready',idle:'Idle',receiving:'Receiving'};

function load(){
  api('/api/sessions').then(function(se){
    if(!se.ok)return;
    var rows=(se.sessions||[]).map(function(s){
      var btn='';
      if(s.state==='processing') btn='<button class="btn-action btn-green" onclick="rd(\''+s.phone+'\')">✅ Ready</button>';
      if(s.state==='awaiting_payment') btn='<button class="btn-action btn-blue" onclick="showCash(\''+s.phone+'\','+(s.totalBill||0).toFixed(2)+')">💵 Cash</button>';
      var bill=s.totalBill?'<b style="color:var(--green)">GHS '+s.totalBill.toFixed(2)+'</b>':'—';
      var badge='<span class="badge '+(stateBadge[s.state]||'b-blue')+'">'+(stateLabel[s.state]||s.state)+'</span>';
      var qp=s.queuePosition?'#'+s.queuePosition:'—';
      return '<tr><td style="font-weight:800;color:var(--muted)">'+qp+'</td><td style="font-weight:700">'+(s.customerName||s.phone)+'</td><td>'+badge+'</td><td style="font-weight:700">'+s.files+'</td><td>'+bill+'</td><td class="mono" style="color:var(--muted);font-size:11px">'+(s.jobId||'—')+'</td><td>'+btn+'</td></tr>';
    }).join('');
    document.getElementById('qb').innerHTML=rows||'<tr><td colspan="7"><div class="empty"><div class="empty-icon">🖨️</div><div class="empty-txt">No active jobs</div></div></td></tr>';
  });
}

function rd(phone){if(!confirm('Mark ready and send pickup code?'))return;api('/api/mark-ready','POST',{phone:phone}).then(function(r){if(r.ok)load();else alert(r.error||'Failed');});}

var cashPhone='',cashAmt=0;
function showCash(phone,amt){
  cashPhone=phone;cashAmt=amt;
  document.getElementById('cm-phone').textContent=phone.replace('@s.whatsapp.net','');
  document.getElementById('cm-amt').textContent='GHS '+amt.toFixed(2);
  document.getElementById('cm-custom').value='';
  document.getElementById('cm-pin').value='';
  document.getElementById('cm-err').textContent='';
  document.getElementById('cm-btn').disabled=false;
  document.getElementById('cm-btn').textContent='Confirm Cash';
  document.getElementById('cm').classList.add('open');
  setTimeout(function(){document.getElementById('cm-pin').focus();},100);
}
function closeCash(){document.getElementById('cm').classList.remove('open');}
function confirmCash(){
  var customAmt=document.getElementById('cm-custom').value.trim();
  var amount=customAmt?parseFloat(customAmt):cashAmt;
  var pin=document.getElementById('cm-pin').value.trim();
  if(!pin){document.getElementById('cm-err').textContent='Enter your PIN';return;}
  if(isNaN(amount)||amount<=0){document.getElementById('cm-err').textContent='Invalid amount';return;}
  document.getElementById('cm-btn').disabled=true;
  document.getElementById('cm-btn').textContent='Processing...';
  api('/api/cash-payment','POST',{phone:cashPhone,amount:amount,pin:pin}).then(function(r){
    if(r.ok){closeCash();load();alert('✅ Cash confirmed!');}
    else{document.getElementById('cm-err').textContent=r.error||'Failed';document.getElementById('cm-btn').disabled=false;document.getElementById('cm-btn').textContent='Confirm Cash';}
  }).catch(function(){document.getElementById('cm-err').textContent='Network error';document.getElementById('cm-btn').disabled=false;document.getElementById('cm-btn').textContent='Confirm Cash';});
}

function lp(){
  api('/api/payments').then(function(d){
    if(!d.ok)return;
    var wid=localStorage.getItem('migo_role')||'';
    var rows=(d.payments||[]).filter(function(p){return !wid||wid==='admin'||p.workerId===wid;}).slice().reverse().map(function(p){
      return '<tr><td class="mono" style="color:var(--muted)">'+(p.ts||'')+'</td><td style="font-weight:700">'+(p.phone||'')+'</td><td style="font-weight:800;color:var(--green)">GHS '+parseFloat(p.amount||0).toFixed(2)+'</td><td class="mono" style="font-size:11px;color:var(--muted)">'+(p.jobId||'')+'</td></tr>';
    }).join('');
    document.getElementById('pb').innerHTML=rows||'<tr><td colspan="4"><div class="empty"><div class="empty-icon">💰</div><div class="empty-txt">No payments yet</div></div></td></tr>';
  });
}

document.getElementById('cm').addEventListener('click',function(e){if(e.target===this)closeCash();});
function logout(){localStorage.removeItem('migo_token');localStorage.removeItem('migo_role');window.location.href='/login';}

load();
setInterval(load,15000);
</script>
</body></html>`;
}

// ── Login HTML ───────────────────────────────────────────────
function dashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Migo Print Shop — Login</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#0a0a0f;--surface:#111118;--card:#18181f;--border:#2a2a35;--text:#f0f0f5;--muted:#6b6b80;--green:#00d68f;--amber:#ffb020;--blue:#4d9fff;--red:#ff4d6a;}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:'Space Grotesk',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.wrap{width:100%;max-width:380px}
.logo-wrap{text-align:center;margin-bottom:32px}
.logo{width:64px;height:64px;background:var(--amber);border-radius:16px;display:inline-flex;align-items:center;justify-content:center;font-size:32px;margin-bottom:14px;box-shadow:0 8px 32px #ffb02040}
.brand{font-size:24px;font-weight:800;color:var(--text);letter-spacing:-.5px}
.tagline{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:1.5px;margin-top:4px}
.card{background:var(--card);border:1.5px solid var(--border);border-radius:20px;padding:28px;box-shadow:0 24px 64px #00000060}
.tabs{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:24px;background:var(--surface);border-radius:12px;padding:4px}
.tab{padding:10px;border:none;border-radius:9px;background:transparent;color:var(--muted);cursor:pointer;font-size:14px;font-weight:800;font-family:inherit;transition:all .2s;text-transform:uppercase;letter-spacing:.5px}
.tab.active{background:var(--card);color:var(--text);box-shadow:0 2px 8px #00000040}
.field{margin-bottom:18px}
.field label{display:block;font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:7px}
.field input{width:100%;padding:13px 15px;background:var(--surface);border:1.5px solid var(--border);border-radius:10px;color:var(--text);font-size:15px;font-weight:600;font-family:inherit;transition:border-color .15s}
.field input:focus{outline:none;border-color:var(--blue)}
.field input::placeholder{color:var(--border)}
.login-btn{width:100%;padding:14px;border:none;border-radius:12px;font-size:15px;font-weight:800;cursor:pointer;font-family:inherit;transition:all .2s;letter-spacing:.3px;text-transform:uppercase}
.login-btn.admin{background:var(--amber);color:#000}
.login-btn.admin:hover{background:#ffc040;transform:translateY(-1px);box-shadow:0 8px 24px #ffb02040}
.login-btn.worker{background:var(--blue);color:#fff}
.login-btn.worker:hover{background:#6aafff;transform:translateY(-1px);box-shadow:0 8px 24px #4d9fff40}
.err{color:var(--red);font-size:13px;font-weight:700;text-align:center;margin-top:14px;min-height:18px}
.ver{text-align:center;margin-top:20px;font-size:11px;color:var(--border);font-weight:600}
</style>
</head>
<body>
<div class="wrap">
  <div class="logo-wrap">
    <div class="logo">🖨️</div>
    <div class="brand">Migo Print Shop</div>
    <div class="tagline">Dashboard</div>
  </div>
  <div class="card">
    <div class="tabs">
      <button class="tab active" id="tab-admin" onclick="setTab('admin')">Admin</button>
      <button class="tab" id="tab-worker" onclick="setTab('worker')">Worker</button>
    </div>
    <div id="adminForm">
      <div class="field">
        <label>Admin Password</label>
        <input type="password" id="adminPw" placeholder="••••••••" onkeydown="if(event.key==='Enter')loginAdmin()">
      </div>
      <button class="login-btn admin" onclick="loginAdmin()">Sign In as Admin</button>
    </div>
    <div id="workerForm" style="display:none">
      <div class="field">
        <label>Worker ID</label>
        <input type="text" id="wId" placeholder="e.g. W01" onkeydown="if(event.key==='Enter')loginWorker()">
      </div>
      <div class="field">
        <label>Worker PIN</label>
        <input type="password" id="wPin" placeholder="••••" maxlength="6" onkeydown="if(event.key==='Enter')loginWorker()">
      </div>
      <button class="login-btn worker" onclick="loginWorker()">Sign In as Worker</button>
    </div>
    <div class="err" id="err"></div>
  </div>
  <div class="ver">Migo Bot v51 · Circle, Accra</div>
</div>
<script>
function setTab(t){
  document.getElementById('adminForm').style.display=t==='admin'?'block':'none';
  document.getElementById('workerForm').style.display=t==='worker'?'block':'none';
  document.getElementById('tab-admin').classList.toggle('active',t==='admin');
  document.getElementById('tab-worker').classList.toggle('active',t==='worker');
  document.getElementById('err').textContent='';
}
async function loginAdmin(){
  const pw=document.getElementById('adminPw').value;
  if(!pw){document.getElementById('err').textContent='Enter your password';return;}
  const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});
  const d=await r.json();
  if(d.ok){localStorage.setItem('migo_token',d.token);localStorage.setItem('migo_role',d.role);window.location='/admin';}
  else document.getElementById('err').textContent='Wrong password. Try again.';
}
async function loginWorker(){
  const wId=document.getElementById('wId').value.toUpperCase().trim();
  const pin=document.getElementById('wPin').value.trim();
  if(!wId||!pin){document.getElementById('err').textContent='Enter Worker ID and PIN';return;}
  const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workerId:wId,pin})});
  const d=await r.json();
  if(d.ok){localStorage.setItem('migo_token',d.token);localStorage.setItem('migo_role',d.role);window.location='/worker';}
  else document.getElementById('err').textContent='Wrong Worker ID or PIN.';
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
  // Use stable token derived from password — survives Render restarts
  const crypto = require('crypto');
  function makeStableToken(pw) {
    return crypto.createHmac('sha256', pw + 'migo-salt-2025').digest('hex');
  }
  const ADMIN_TOKEN = makeStableToken(ADMIN_DASH_PW);

  function authMiddleware(req, res, next) {
    const token = req.headers['x-dashboard-token'] || req.query.token;
    if (!token) return res.status(401).json({ ok: false, error: 'Unauthorised' });
    // Check admin token
    if (token === ADMIN_TOKEN) { req.role = 'admin'; return next(); }
    // Check worker tokens
    for (const [wid, w] of workers.entries()) {
      const wToken = makeStableToken(wid + w.pin);
      if (token === wToken) { req.role = 'worker'; req.workerId = wid; return next(); }
    }
    res.status(401).json({ ok: false, error: 'Unauthorised' });
  }

  // Login
  app.post('/api/login', (req, res) => {
    const { password, workerId, pin } = req.body || {};
    if (password === ADMIN_DASH_PW) {
      return res.json({ ok: true, token: ADMIN_TOKEN, role: 'admin' });
    }
    const w = workers.get(workerId);
    if (w && w.pin === pin) {
      const wToken = makeStableToken(workerId + pin);
      return res.json({ ok: true, token: wToken, role: 'worker', name: w.name });
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
    const processingList = [...sessions.values()].filter(s => sessState(s) === 'processing');
    const list = [...sessions.entries()].map(([key, s]) => {
      const order = getActiveOrder(s);
      const state = sessState(s);
      const qPos = state === 'processing' ? processingList.indexOf(s) + 1 : null;
      return {
        phone: displayPhone(key), state,
        totalBill: sessTotalBill(s), paymentReceived: order?.paymentReceived,
        jobId: sessJobId(s), a4eq: sessA4eq(s), paused: s.paused,
        customerName: s.customerName,
        files: sessFiles(s)?.length || 0,
        pressing: order?.pressing ? `${order.pressing.shirts} shirts (${order.pressing.type})` : null,
        queuePosition: qPos,
        orderRef: order?.ref,
        orders: s.orders?.length || 1,
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
      const r = await askGPT([{ role: 'user', content:
        `You are parsing a Q&A list for a DTF print shop knowledge base.\n` +
        `Extract all question-answer pairs and standalone facts from this text.\n` +
        `The format may be anything — numbered, dashed, plain, Q:/A:, paragraphs, etc.\n\n` +
        `TEXT:\n${content.slice(0, 4000)}\n\n` +
        `Return ONLY a valid JSON array. Each object: {"q":"question or null","a":"answer or fact"}\n` +
        `For standalone facts (no clear question): {"q":null,"a":"the fact"}\n` +
        `No markdown. No explanation. JSON only.`
      }], null, 1500, 20000);
      const raw = gptText(r).replace(/```json|```/g, '').trim();
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
    const workerId = req.workerId || (req.role === 'worker' ? 'worker' : 'admin');
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
app.get('/health', (req, res) => res.json({ status: 'ok', version: BOT_VERSION, model: MODEL, uptime: Math.floor((Date.now()-BOT_START)/1000)+'s' }));
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

  loadState();                                   // restore sessions, ledger, workers, etc.
  setInterval(saveStateNow, 30 * 1000);          // periodic autosave
  schedule8pm();
  scheduleHeartbeat();                           // daily 7am "bot healthy" ping
  setInterval(runAutoArchive, 30 * 60 * 1000);

  // Save a final snapshot when Render restarts/redeploys (graceful shutdown)
  process.on('SIGTERM', () => { saveStateNow(); process.exit(0); });
  process.on('SIGINT',  () => { saveStateNow(); process.exit(0); });

  // Warn the owner if default credentials are still in use
  if (ADMIN_PIN === '1914' || ADMIN_DASH_PW === '1914') {
    await alertOwner([
      `🔐 *SECURITY: default credentials in use*`,
      `${ADMIN_PIN === '1914' ? '• Cash PIN is still 1914' : ''}`,
      `${ADMIN_DASH_PW === '1914' ? '• Dashboard password is still 1914' : ''}`,
      ``,
      `Anyone who guesses these can confirm fake payments or open the dashboard.`,
      `Set ADMIN_PIN and ADMIN_DASHBOARD_PASSWORD in Render → Environment.`,
    ].filter(Boolean).join('\n')).catch(() => {});
  }

  await alertOwner([
    `✅ *Migo Bot ${BOT_VERSION} Started*`,
    `🕐 ${nowStr()}`,
    `🤖 Model: ${MODEL}`,
    `📱 WasenderAPI: Connected`,
    `⚙️ All systems running.`,
  ].join('\n'));
});
