/**
 * device-client.js
 * Generic Face Recognition Device — CmdGeneral API Client
 * Auth: 2-step Digest with firmware-hardcoded bodyHash constant
 */

const crypto = require('crypto');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

// ─── CONFIG ────────────────────────────────────────────────────────────────
const DEVICE = {
  host:     '10.30.0.100',
  port:     80,
  username: 'admin',
  password: 'admin', 
};

// Firmware-hardcoded bodyHash constant (same across all sessions)
const BODY_HASH = '98265b79323f2b0b270a70d48202b996';

const STATE_FILE = path.join(__dirname, 'last_sync.json');
const LOG_FILE   = path.join(__dirname, 'logs', 'access_logs.jsonl');

// ─── HTTP POST ─────────────────────────────────────────────────────────────
function post(endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: DEVICE.host, port: DEVICE.port,
      path: `/${endpoint}`, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 15000,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error(`Bad JSON: ${data.slice(0,200)}`)); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payload); req.end();
  });
}

// ─── LOGIN ─────────────────────────────────────────────────────────────────
function md5(str) { return crypto.createHash('md5').update(str).digest('hex'); }

async function login() {
  const step1 = await post('CmdLogin', {
    method: 'global.login',
    params: { username: DEVICE.username, password: '', clientType: 'Web', authType: 'Digest' },
    id: 9999,
  });

  if (!step1.params?.nonce) throw new Error(`Challenge failed: ${JSON.stringify(step1)}`);

  const { nonce, realm, qop } = step1.params;
  const session  = step1.session;
  const nc       = '00000001';
  const cnonce   = md5(Date.now().toString() + Math.random()).slice(0, 32);
  const ha1      = md5(`${DEVICE.username}:${realm}:${DEVICE.password}`);
  const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${BODY_HASH}`);
  const authInfo = `${nc}:${cnonce}:${qop}:${BODY_HASH}`;

  const step2 = await post('CmdLogin', {
    method: 'global.login', session,
    params: { username: DEVICE.username, password: response, clientType: 'Web', authType: 'Digest', authInfo },
    id: 9999,
  });

  if (!step2.result) throw new Error(`Login failed: ${JSON.stringify(step2.error)}`);
  return step2.session || session;
}

// ─── HELPERS ───────────────────────────────────────────────────────────────
function unixToLocal(unix) {
  return new Date(unix * 1000).toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
}

// ─── FETCH RECORDS ─────────────────────────────────────────────────────────
async function fetchAccessLogs(startTime, endTime, limit = 1000) {
  console.log(`[device] Logging in to ${DEVICE.host}...`);
  const session   = await login();
  const startUnix = Math.floor(startTime.getTime() / 1000);
  const endUnix   = Math.floor(endTime.getTime()   / 1000);

  let allRecords = [], offset = 0, total = null;

  do {
    const res = await post('CmdGeneral', {
      method: 'accessRecord.find',
      params: { Condition: { StartTime: startUnix, EndTime: endUnix, Offset: offset, Limit: limit } },
      session, id: 34,
    });

    if (!res.result) throw new Error(`accessRecord.find failed: ${JSON.stringify(res.error)}`);

    const records = res.params?.Records || [];
    if (total === null) total = res.params?.Total ?? res.params?.total ?? 999999;

    const normalized = records.map(r => ({
      Timestamp:     unixToLocal(r.Time),
      TimestampUnix: r.Time,
      PersonCode:    r.PersonCode || '',
      PersonName:    r.PersonName || '',
      AccessGranted: r.Pass ? 'Yes' : 'No',
      Detail:        r.Detail || '',
      AccessType:    r.AccessType || '',
      Temperature:   r.Temperature ?? '',
      Mask:          r.Mask === 1 ? 'With Mask' : r.Mask === 2 ? 'Without Mask' : 'Unknown',
      CardNo:        r.CardNo || '',
      _savedAt:      new Date().toISOString(),
    }));

    console.log(`[device] Got ${records.length} records (offset ${offset} / total ${total})`);
    allRecords = allRecords.concat(normalized);
    offset += records.length;
    if (records.length === 0) break;

  } while (allRecords.length < total);

  try { await post('CmdGeneral', { method: 'global.logout', params: {}, session, id: 99 }); } catch {}
  return { total, records: allRecords };
}

// ─── STATE ─────────────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastSync: null }; }
}
function saveState(state) { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }

// ─── STORAGE ──────────────────────────────────────────────────────────────
function appendLogs(records) {
  if (!records.length) return;
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(`[storage] Saved ${records.length} records`);
}

async function saveToServer(records) {
  if (!records.length) return;
  console.log(`[server] ${records.length} records ready for DB`);
}

// ─── GAP FILL ─────────────────────────────────────────────────────────────
async function gapFill() {
  const state = loadState();
  const now   = new Date();
  const start = state.lastSync ? new Date(state.lastSync) : new Date(now - 24 * 60 * 60 * 1000);
  console.log(`[gap-fill] From: ${start.toISOString()} → Now`);
  const { records } = await fetchAccessLogs(start, now);
  if (records.length) { appendLogs(records); await saveToServer(records); }
  saveState({ lastSync: now.toISOString() });
  console.log(`[gap-fill] Done. Recovered ${records.length} records.`);
  return records;
}

// ─── POLLING ──────────────────────────────────────────────────────────────
let pollTimer = null;

async function pollOnce() {
  const state = loadState();
  const now   = new Date();
  const since = state.lastSync ? new Date(state.lastSync) : new Date(now - 5 * 60 * 1000);
  try {
    const { records } = await fetchAccessLogs(since, now);
    if (records.length) { appendLogs(records); await saveToServer(records); }
    saveState({ lastSync: now.toISOString() });
    return { success: true, count: records.length, timestamp: now };
  } catch (err) {
    console.error(`[poll] Error: ${err.message}`);
    return { success: false, error: err.message, timestamp: now };
  }
}

function startPolling(intervalMinutes = 5) {
  if (pollTimer) clearInterval(pollTimer);
  console.log(`[poll] Every ${intervalMinutes} min`);
  pollTimer = setInterval(pollOnce, intervalMinutes * 60 * 1000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

module.exports = { gapFill, pollOnce, startPolling, stopPolling, fetchAccessLogs, loadState };