const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhm-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.PORT = '4099';
process.env.AUTH_TOKEN = 'test-auth';
process.env.REGISTER_TOKEN = 'test-register';

const { WebSocket } = require('ws');
const { server, shutdown } = require('../index.js');

const BASE = 'http://127.0.0.1:4099';

let registeredKey = null;
let registeredId = null;

async function register(name, token, extra = {}) {
  return fetch(`${BASE}/api/agent/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      ip: '10.0.0.9',
      type: 'desktop',
      os_name: 'linux',
      register_token: token,
      ...extra,
    }),
  });
}

test('register device', async () => {
  const res = await register('test-machine', 'test-register');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.api_key, 'register returns api_key for the agent');
  assert.ok(body.id, 'register returns device id');
  registeredKey = body.api_key;
  registeredId = body.id;
  assert.equal(body.api_key, registeredKey);
});

test('register rejects wrong token', async () => {
  const res = await register('bad', 'wrong-token');
  assert.equal(res.status, 403);
});

test('api/devices never exposes api_key', async () => {
  const res = await fetch(`${BASE}/api/devices`);
  assert.equal(res.status, 200);
  const { devices } = await res.json();
  assert.ok(Array.isArray(devices) && devices.length > 0);
  for (const d of devices) assert.ok(!('api_key' in d), 'device must not contain api_key');
});

test('api/devices/:id never exposes api_key', async () => {
  const res = await fetch(`${BASE}/api/devices/${registeredId}`);
  assert.equal(res.status, 200);
  const { device } = await res.json();
  assert.ok(!('api_key' in device), 'device must not contain api_key');
});

test('report requires a valid X-Api-Key', async () => {
  const res = await fetch(`${BASE}/api/agent/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'nope' },
    body: JSON.stringify({ cpu_percent: 1 }),
  });
  assert.equal(res.status, 403);
});

test('WS broadcasts do not leak api_key', async () => {
  const ws = new WebSocket('ws://127.0.0.1:4099');
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const seen = [];
  const gotMetrics = new Promise((resolve) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      seen.push(msg);
      if (msg.type === 'metrics' && msg.deviceId === registeredId) resolve(msg);
    });
  });

  const res = await fetch(`${BASE}/api/agent/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': registeredKey },
    body: JSON.stringify({ cpu_percent: 12, ram_used_mb: 500, ram_total_mb: 2000 }),
  });
  assert.equal(res.status, 200);

  const msg = await gotMetrics;
  assert.ok(msg.device, 'metrics payload includes device');
  assert.ok(!('api_key' in msg.device), 'broadcast device must not contain api_key');
  assert.ok(!JSON.stringify(msg).includes(registeredKey), 'broadcast payload must not contain the key');
  assert.equal(msg.metrics.cpu_percent, 12);

  ws.close();
});

test('unknown route returns JSON 404', async () => {
  const res = await fetch(`${BASE}/api/does-not-exist`, { method: 'POST' });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'Not found');
});

test('register rate limit kicks in', async () => {
  let saw429 = false;
  for (let i = 0; i < 8; i++) {
    const res = await register(`flood-${i}`, 'test-register');
    if (res.status === 429) {
      saw429 = true;
      break;
    }
  }
  assert.ok(saw429, 'expected a 429 after exceeding the limit');
});

after(() => {
  server.closeAllConnections?.();
  shutdown();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
