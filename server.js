/**
 * server.js — Biometric Sync Server (multi-device, per-device logs)
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const http    = require('http');

const app        = express();
const PORT       = 3000;
const LOGS_DIR   = path.join(__dirname, 'logs');
const BODY_HASH  = '98265b79323f2b0b270a70d48202b996';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── ACTIVE DEVICE STATE ──────────────────────────────────────────────────
let activeDevice = null; // set by browser via /api/devices/active

function logFile(device) {
  const safe = (device.id || device.host).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(LOGS_DIR, `device_${safe}.jsonl`);
}

function stateFile(device) {
  const safe = (device.id || device.host).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(LOGS_DIR, `state_${safe}.json`);
}

// ─── HTTP / AUTH ──────────────────────────────────────────────────────────
function post(device, endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: device.host, port: device.port || 80,
      path: `/${endpoint}`, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 15000,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(`Bad JSON: ${d.slice(0,200)}`)); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Connection timeout')); });
    req.write(payload); req.end();
  });
}

function md5(str) { return crypto.createHash('md5').update(str).digest('hex'); }

async function login(device) {
  const step1 = await post(device, 'CmdLogin', {
    method: 'global.login',
    params: { username: device.username, password: '', clientType: 'Web', authType: 'Digest' },
    id: 9999,
  });
  if (!step1.params?.nonce) throw new Error(`Challenge failed: ${JSON.stringify(step1)}`);
  const { nonce, realm, qop } = step1.params;
  const session  = step1.session;
  const nc       = '00000001';
  const cnonce   = md5(Date.now().toString() + Math.random()).slice(0, 32);
  const ha1      = md5(`${device.username}:${realm}:${device.password}`);
  const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${BODY_HASH}`);
  const authInfo = `${nc}:${cnonce}:${qop}:${BODY_HASH}`;
  const step2 = await post(device, 'CmdLogin', {
    method: 'global.login', session,
    params: { username: device.username, password: response, clientType: 'Web', authType: 'Digest', authInfo },
    id: 9999,
  });
  if (!step2.result) throw new Error(`Login failed: ${JSON.stringify(step2.error)}`);
  return step2.session || session;
}

function unixToLocal(unix) {
  return new Date(unix * 1000).toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
}

async function fetchAccessLogs(device, startTime, endTime, limit = 1000) {
  const session   = await login(device);
  const startUnix = Math.floor(startTime.getTime() / 1000);
  const endUnix   = Math.floor(endTime.getTime()   / 1000);
  let allRecords = [], offset = 0, total = null;
  do {
    const res = await post(device, 'CmdGeneral', {
      method: 'accessRecord.find',
      params: { Condition: { StartTime: startUnix, EndTime: endUnix, Offset: offset, Limit: limit } },
      session, id: 34,
    });
    if (!res.result) throw new Error(`accessRecord.find failed: ${JSON.stringify(res.error)}`);
    const records = res.params?.Records || [];
    if (total === null) total = res.params?.Total ?? res.params?.total ?? 999999;
    const normalized = records.map(r => ({
      Timestamp: unixToLocal(r.Time), TimestampUnix: r.Time,
      PersonCode: r.PersonCode||'', PersonName: r.PersonName||'',
      AccessGranted: r.Pass?'Yes':'No', Detail: r.Detail||'',
      AccessType: r.AccessType||'', Temperature: r.Temperature??'',
      Mask: r.Mask===1?'With Mask':r.Mask===2?'Without Mask':'Unknown',
      CardNo: r.CardNo||'', _savedAt: new Date().toISOString(),
    }));
    console.log(`[device:${device.host}] Got ${records.length} records (offset ${offset})`);
    allRecords = allRecords.concat(normalized);
    offset += records.length;
    if (records.length === 0) break;
  } while (allRecords.length < total);
  try { await post(device, 'CmdGeneral', { method:'global.logout', params:{}, session, id:99 }); } catch {}
  return { total: allRecords.length, records: allRecords };
}

// ─── DEVICE ROUTES ────────────────────────────────────────────────────────

app.post('/api/devices/active', (req, res) => {
  const { id, name, host, ip, port, username, password } = req.body;
  activeDevice = { id: id||'default', name: name||ip||host, host: host||ip, port: port||80, username: username||'admin', password };
  console.log(`[device] Switched to "${activeDevice.name}" (${activeDevice.host}:${activeDevice.port})`);
  res.json({ ok: true });
});

app.post('/api/devices/test', async (req, res) => {
  const { ip, port, username, password } = req.body;
  const device = { host: ip, port: port||80, username: username||'admin', password };
  try {
    const session = await login(device);
    await post(device, 'CmdGeneral', { method:'global.logout', params:{}, session, id:99 });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ─── STATUS ───────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  let lastSync = null, lineCount = 0;
  try { lastSync = JSON.parse(fs.readFileSync(stateFile(activeDevice),'utf8')).lastSync; } catch {}
  try { lineCount = fs.readFileSync(logFile(activeDevice),'utf8').split('\n').filter(Boolean).length; } catch {}
  res.json({ ok:true, lastSync, totalLogsLocal:lineCount, device:`${activeDevice.host}:${activeDevice.port}`, deviceName: activeDevice.name });
});

// ─── FETCH FROM DEVICE (replaces device log) ──────────────────────────────
app.post('/api/device/fetch', async (req, res) => {
  const { from, to } = req.body;
  if (!activeDevice) return res.status(400).json({ ok:false, error:'No active device. Add a device first.' });
  if (!from || !to) return res.status(400).json({ ok:false, error:'from and to required' });
  try {
    const { records } = await fetchAccessLogs(activeDevice, new Date(from), new Date(to));
    fs.mkdirSync(LOGS_DIR, { recursive:true });
    fs.writeFileSync(logFile(activeDevice), records.map(r => JSON.stringify(r)).join('\n') + (records.length?'\n':''));
    fs.writeFileSync(stateFile(activeDevice), JSON.stringify({ lastSync: new Date().toISOString() }, null, 2));
    console.log(`[fetch] Stored ${records.length} records → ${logFile(activeDevice)}`);
    res.json({ ok:true, count:records.length });
  } catch (err) {
    console.error(`[fetch] Error: ${err.message}`);
    res.status(500).json({ ok:false, error:err.message });
  }
});


// ─── CLEAR LOCAL LOGS ─────────────────────────────────────────────────────
app.post('/api/logs/clear', (req, res) => {
  const { deviceId } = req.body;
  try {
    // Build a temp device object using the id to find the right log file
    const targetDevice = deviceId ? { id: deviceId } : activeDevice;
    const lf = logFile(targetDevice);
    const sf = stateFile(targetDevice);
    if (fs.existsSync(lf)) fs.writeFileSync(lf, '');
    if (fs.existsSync(sf)) fs.writeFileSync(sf, JSON.stringify({ lastSync: null }, null, 2));
    console.log(`[clear] Cleared local logs for device id: ${deviceId || 'active'}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[clear] Error: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── READ LOGS ────────────────────────────────────────────────────────────
app.get('/api/logs', (req, res) => {
  const page  = parseInt(req.query.page  || '1');
  const limit = parseInt(req.query.limit || '50');
  if (!activeDevice) return res.json({ ok:true, total:0, page, limit, records:[] });
  try {
    const lines   = fs.readFileSync(logFile(activeDevice),'utf8').split('\n').filter(Boolean).reverse();
    const total   = lines.length;
    const records = lines.slice((page-1)*limit, page*limit).map(l => { try{return JSON.parse(l);}catch{return null;} }).filter(Boolean);
    res.json({ ok:true, total, page, limit, records });
  } catch { res.json({ ok:true, total:0, page, limit, records:[] }); }
});

// ─── CSV DOWNLOAD ─────────────────────────────────────────────────────────
app.get('/api/logs/download', (req, res) => {
  const { from, to } = req.query;
  if (!activeDevice) return res.status(400).json({ ok:false, error:'No active device' });
  if (!from) return res.status(400).json({ ok:false, error:'from required' });
  const start = new Date(from), end = to ? new Date(to) : new Date();
  let records = [];
  try {
    const lf = logFile(activeDevice);
    if (fs.existsSync(lf)) {
      for (const line of fs.readFileSync(lf,'utf8').split('\n').filter(Boolean)) {
        try {
          const r = JSON.parse(line);
          const t = r.TimestampUnix ? new Date(r.TimestampUnix*1000) : new Date(r.Timestamp||r._savedAt);
          if (!isNaN(t) && t>=start && t<=end) records.push(r);
        } catch {}
      }
    }
  } catch (err) { return res.status(500).json({ ok:false, error:err.message }); }

  records.sort((a,b) => (a.TimestampUnix||0)-(b.TimestampUnix||0));
  const esc = v => { const s=String(v??''); return s.includes(',')||s.includes('"')||s.includes('\n')?`"${s.replace(/"/g,'""')}"`:''+s; };
  const headers = ['Index','Timestamp','ID','Name','Access Granted','Body Temperature','Mask Detection','Details'];
  const rows    = records.map((r,i) => [i+1,r.Timestamp||'',r.PersonCode||'',r.PersonName||'',r.AccessGranted||'',r.Temperature??'',r.Mask||'',r.Detail ? `Detection Type:Face Detection    Result:${r.Detail}` : ''].map(esc).join(','));
  const csv     = [headers.join(','), ...rows].join('\r\n');
  const fromStr = start.toISOString().slice(0,10), toStr = end.toISOString().slice(0,10);
  const devName = (activeDevice.name||activeDevice.host).replace(/[^a-zA-Z0-9]/g,'_');
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="${devName}_${fromStr}_to_${toStr}.csv"`);
  res.send(csv);
});

// ─── START ────────────────────────────────────────────────────────────────
fs.mkdirSync(LOGS_DIR, { recursive: true });

app.listen(PORT, () => {
  console.log(`\n[startup] Biometric Sync running at http://localhost:${PORT}`);
  console.log(`[startup] Logs directory: ${LOGS_DIR}\n`);
});
process.on('SIGINT', () => process.exit(0));