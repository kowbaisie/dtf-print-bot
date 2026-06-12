// Isolated logic tests for the v74 additions (mirrors the exact implementations).
let pass=0, fail=0;
function ok(name, got, exp){ const g=JSON.stringify(got), e=JSON.stringify(exp);
  if(g===e){pass++; console.log('  ✅ '+name);} else {fail++; console.log('  ❌ '+name+'\n       got '+g+'\n       exp '+e);} }

// --- fmtDuration (item 6) ---
function fmtDuration(ms){ if(ms==null||ms<0||!isFinite(ms))return '--';
  const mins=Math.round(ms/60000); const h=Math.floor(mins/60), m=mins%60;
  if(h&&m)return h+'h '+m+'m'; if(h)return h+'h'; return m+'m'; }
console.log('fmtDuration:');
ok('90 min → 1h 30m', fmtDuration(90*60000), '1h 30m');
ok('150 min → 2h 30m', fmtDuration(150*60000), '2h 30m');
ok('50 min → 50m', fmtDuration(50*60000), '50m');
ok('120 min → 2h', fmtDuration(120*60000), '2h');
ok('null → --', fmtDuration(null), '--');

// --- toMsisdn (item 7 SMS) ---
function toMsisdn(phone){ let d=String(phone||'').replace(/@.*/,'').replace(/[^\d]/g,'');
  if(d.startsWith('233'))return d; if(d.startsWith('0'))return '233'+d.slice(1);
  if(d.length===9)return '233'+d; return d; }
console.log('toMsisdn:');
ok('0552719245 → 233552719245', toMsisdn('0552719245'), '233552719245');
ok('233271234567 passthrough', toMsisdn('233271234567'), '233271234567');
ok('waId strip', toMsisdn('233271234567@s.whatsapp.net'), '233271234567');
ok('9-digit local', toMsisdn('552719245'), '233552719245');

// --- on-time flag (item 6) ---
function onTimeFlag(nowMs, etaMs){ return etaMs ? (nowMs <= etaMs) : true; }
console.log('on-time flag:');
ok('within ETA → green(true)', onTimeFlag(1000, 2000), true);
ok('over ETA → red(false)', onTimeFlag(3000, 2000), false);
ok('no ETA → true', onTimeFlag(3000, null), true);

// --- ready-list builder (item 6) ---
const todayStr = () => '2026-06-12';
const readyLog = [
  {date:'2026-06-12', code:'MGO-1335-E1335', tookMs:90*60000,  onTime:true },
  {date:'2026-06-12', code:'MGO-1336-E1336', tookMs:150*60000, onTime:true },
  {date:'2026-06-12', code:'MGO-1337-E1337', tookMs:110*60000, onTime:false},
  {date:'2026-06-11', code:'MGO-OLD',        tookMs:30*60000,  onTime:true }, // yesterday — excluded
];
function buildReadyListMsg(){
  const today=readyLog.filter(r=>r.date===todayStr());
  if(!today.length)return null;
  const lines=today.map(r=>(r.onTime?'🟢':'🔴')+' Ready sent to '+r.code+'  '+fmtDuration(r.tookMs));
  return ['📋 *READY TODAY ('+today.length+')*',''].concat(lines).join('\n');
}
console.log('ready-list:');
const list=buildReadyListMsg();
ok('count excludes yesterday', list.includes('READY TODAY (3)'), true);
ok('green within time', list.includes('🟢 Ready sent to MGO-1335-E1335  1h 30m'), true);
ok('red over time', list.includes('🔴 Ready sent to MGO-1337-E1337  1h 50m'), true);
ok('yesterday excluded', list.includes('MGO-OLD'), false);

console.log('\n'+(fail===0?'✅ ALL '+pass+' PASSED':'❌ '+fail+' FAILED, '+pass+' passed'));
process.exit(fail?1:0);
