const crypto = require('crypto');
const http   = require('http');

const DEVICE = { host: '10.30.0.100', port: 80, username: 'admin', password: 'admin' };

function md5(str) { return crypto.createHash('md5').update(str).digest('hex'); }

// Hardcoded bodyHash constant in device firmware
const BODY_HASH = '98265b79323f2b0b270a70d48202b996';

function post(endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { hostname: DEVICE.host, port: DEVICE.port, path: `/${endpoint}`, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) }, timeout: 10000 },
      (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d))}catch{reject(new Error(d.slice(0,200)))} }); }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payload); req.end();
  });
}

async function run() {
  console.log('━━━ Step 1: Challenge ━━━');
  const step1 = await post('CmdLogin', {
    method: 'global.login',
    params: { username: DEVICE.username, password: '', clientType: 'Web', authType: 'Digest' },
    id: 9999,
  });
  console.log('nonce:', step1.params.nonce, '| session:', step1.session);

  const { nonce, realm, qop } = step1.params;
  const session  = step1.session;
  const nc       = '00000001';
  const cnonce   = md5(Date.now().toString() + Math.random()).slice(0, 32);
  const ha1      = md5(`${DEVICE.username}:${realm}:${DEVICE.password}`);
  const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${BODY_HASH}`);
  const authInfo = `${nc}:${cnonce}:${qop}:${BODY_HASH}`;

  console.log('━━━ Step 2: Login ━━━');
  const step2 = await post('CmdLogin', {
    method: 'global.login', session,
    params: { username: DEVICE.username, password: response, clientType: 'Web', authType: 'Digest', authInfo },
    id: 9999,
  });
  console.log('Result:', step2.result, '| Error:', step2.error || 'none');

  if (step2.result) {
    console.log('✅ LOGIN SUCCESS!');
    const s = step2.session || session;
    const now = Math.floor(Date.now()/1000);
    const rec = await post('CmdGeneral', {
      method: 'accessRecord.find',
      params: { Condition: { StartTime: now-86400, EndTime: now, Offset: 0, Limit: 3 } },
      session: s, id: 34,
    });
    console.log('Total records:', rec.params?.Total);
    console.log('Sample:', JSON.stringify((rec.params?.Records||[]).slice(0,1), null, 2));
  }
}
run().catch(console.error);