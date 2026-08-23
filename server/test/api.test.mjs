import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhm-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.PORT = '4099';
process.env.AUTH_TOKEN = 'test-auth';
process.env.REGISTER_TOKEN = 'test-register';
process.env.DASHBOARD_PASSWORD = 'test-pass';
// wyzej limit domyslny (5/min) - testy robią kilka rejestracji, flood-test ma wtedy jeszcze dosięgnąć 429
process.env.REGISTER_RATE_LIMIT = '8';

const { WebSocket } = await import('ws');
const { server, shutdown } = await import('../index.js');

const BASE = 'http://127.0.0.1:4099';

let registeredKey = null;
let registeredId = null;
let cookie = null;

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

async function login(password) {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const setCookie = res.headers.get('set-cookie') || '';
  // nie nadpisuj sesji, gdy logowanie nie powiodlo sie (brak Set-Cookie)
  if (setCookie) cookie = setCookie.split(';')[0];
  return res;
}

function get(path) {
  return fetch(`${BASE}${path}`, { headers: cookie ? { Cookie: cookie } : {} });
}

before(async () => {
  const res = await login('test-pass');
  assert.equal(res.status, 200);
  assert.ok(cookie && cookie.startsWith('dhm_sid='), 'login ustawia cookie sesji');
});

test('secured mode: /config.js nie wydaja tokenu', async () => {
  const res = await fetch(`${BASE}/config.js`);
  const body = await res.text();
  assert.ok(!body.includes('test-auth'), 'token AUTH nie moze trafic do przegladarki');
  assert.ok(body.includes('window.DHM_CONFIG'), 'config.js dalej istnieje (pusty)');
});

test('secured mode: odczyt bez sesji -> 401', async () => {
  for (const path of ['/api/devices', '/api/alerts', '/api/summary', '/metrics', '/api/setup']) {
    const res = await fetch(`${BASE}${path}`);
    assert.equal(res.status, 401, `${path} wymaga sesji`);
  }
});

test('login odrzuca zle haslo', async () => {
  const res = await login('wrong-pass');
  assert.equal(res.status, 401);
});

test('register device', async () => {
  const res = await register('test-machine', 'test-register');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.api_key, 'register returns api_key for the agent');
  assert.ok(body.id, 'register returns device id');
  registeredKey = body.api_key;
  registeredId = body.id;
});

test('register rejects wrong token', async () => {
  const res = await register('bad', 'wrong-token');
  assert.equal(res.status, 403);
});

test('register rejects invalid payload', async () => {
  const res = await fetch(`${BASE}/api/agent/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '', ip: 'not-an-ip', register_token: 'test-register' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'invalid payload');
  assert.ok(Array.isArray(body.details) && body.details.length > 0);
});

test('device_uuid: re-register rozpoznaje to samo urzadzenie mimo zmiany IP/MAC', async () => {
  const uuid = crypto.randomUUID();
  const r1 = await register('uuid-dev', 'test-register', { device_uuid: uuid, ip: '10.0.0.50' });
  assert.equal(r1.status, 200);
  const d1 = await r1.json();

  // ten sam uuid, inne IP i MAC -> to samo ID, nie powstaje duplikat
  const r2 = await register('uuid-dev-renamed', 'test-register', {
    device_uuid: uuid,
    ip: '10.0.0.77',
    mac: 'AA:BB:CC:DD:EE:FF',
  });
  assert.equal(r2.status, 200);
  const d2 = await r2.json();
  assert.equal(d2.id, d1.id, 'tozsamosc UUID wygrywa ze zmiana IP/MAC');
  assert.equal(d2.api_key, d1.api_key);
  // nazwa ustawiana tylko raz - pozniejsze rejestry jej nie nadpisuja
  // (zmiana nazwy nalezy do uzytkownika na dashboardzie)
  assert.equal(d2.name, 'uuid-dev');

  const list = await get('/api/devices');
  const { devices } = await list.json();
  const matches = devices.filter((d) => d.ip === '10.0.0.77');
  assert.equal(matches.length, 1, 'brak duplikatu po zmianie IP');
  assert.equal(matches[0].name, 'uuid-dev', 'nazwa z pierwszej rejestracji bez zmian');
});

test('api/devices never exposes api_key or device_uuid', async () => {
  const res = await get('/api/devices');
  assert.equal(res.status, 200);
  const { devices } = await res.json();
  assert.ok(Array.isArray(devices) && devices.length > 0);
  for (const d of devices) {
    assert.ok(!('api_key' in d), 'device must not contain api_key');
    assert.ok(!('device_uuid' in d), 'device must not contain device_uuid');
  }
});

test('api/devices/:id never exposes api_key', async () => {
  const res = await get(`/api/devices/${registeredId}`);
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
  const ws = new WebSocket('ws://127.0.0.1:4099', { headers: { Cookie: cookie } });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const gotMetrics = new Promise((resolve) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
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

test('WS handshake bez sesji odrzucony (secured mode)', async () => {
  const err = await new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:4099');
    ws.once('error', resolve);
    ws.once('open', () => {
      ws.close();
      resolve(null); // polaczenie dopuszczone = problem
    });
  });
  assert.ok(err, 'WS bez cookie powinien zostac odrzucony');
});

test('logout kasuje sesje', async () => {
  await fetch(`${BASE}/api/logout`, { method: 'POST', headers: { Cookie: cookie } });
  const res = await get('/api/summary');
  assert.equal(res.status, 401, 'po logout stary cookie jest niewazny');
  // ponowne logowanie dla ewentualnych kolejnych testow
  await login('test-pass');
});

test('unknown route returns JSON 404', async () => {
  const res = await fetch(`${BASE}/api/does-not-exist`, { method: 'POST' });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'Not found');
});

test('secured odczyt z X-Auth-Token (mostek ntfy / Prometheus), zapis juz nie', async () => {
  for (const path of ['/api/devices', '/api/alerts', '/metrics']) {
    const res = await fetch(`${BASE}${path}`, { headers: { 'X-Auth-Token': 'test-auth' } });
    assert.equal(res.status, 200, `${path} przyjmuje X-Auth-Token bez cookie`);
  }
  const write = await fetch(`${BASE}/api/alerts/1/resolve`, {
    method: 'POST',
    headers: { 'X-Auth-Token': 'test-auth' },
  });
  assert.equal(write.status, 401, 'zapis w secured wymaga sesji, sam naglowek nie wystarczy');
});

test('device_uuid: odswieza type, grp tylko gdy agent go podal', async () => {
  const uuid = crypto.randomUUID();
  const r1 = await register('grp-dev', 'test-register', { device_uuid: uuid, ip: '10.0.0.60', type: 'laptop' });
  const d1 = await r1.json();
  await register('grp-dev', 'test-register', { device_uuid: uuid, ip: '10.0.0.61', type: 'desktop', group: 'biuro' });
  let list = await (await get('/api/devices')).json();
  let dev = list.devices.find((d) => d.id === d1.id);
  assert.equal(dev.type, 'desktop', 'type odswiezany z rejestru');
  assert.equal(dev.grp, 'biuro');
  await register('grp-dev', 'test-register', { device_uuid: uuid, ip: '10.0.0.62' });
  list = await (await get('/api/devices')).json();
  dev = list.devices.find((d) => d.id === d1.id);
  assert.equal(dev.grp, 'biuro', 'pusty DEVICE_GROUP agenta nie kasuje grupy');
});

test('register rate limit kicks in', async () => {
  let saw429 = false;
  for (let i = 0; i < 10; i++) {
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
