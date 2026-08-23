#!/usr/bin/env node
// E2E smoke DHM: stawia prawdziwy serwer na losowym porcie (tryb otwarty),
// przechodzi pelna sciezke: health -> rejestracja agenta -> raporty ->
// dashboard API -> alerty -> progi -> WS broadcast -> statyki.
// Uruchomienie:  node scripts/e2e-smoke.mjs
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(__dirname, '..', 'server');
const AUTH_TOKEN = crypto.randomBytes(12).toString('hex');
const REGISTER_TOKEN = crypto.randomBytes(12).toString('hex');
const UUID = crypto.randomUUID();
let failures = 0;

function ok(cond, label) {
  console.log(`${cond ? '[OK]  ' : '[FAIL]'} ${label}`);
  if (!cond) failures++;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function waitHealth(base, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('serwer nie wstal w czasie');
}

function report(base, key, body) {
  return fetch(`${base}/api/agent/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
    body: JSON.stringify(body),
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dhm-e2e-'));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
// minimalny, jawny env dziecka - pelny dziedziczony env bywa zepsuty pod
// sandboxami (duplikaty Path/PATH -> ENOENT nawet na cmd.exe)
const childEnv = {};
for (const k of ['SystemRoot', 'windir', 'COMSPEC', 'TEMP', 'TMP', 'PROCESSOR_ARCHITECTURE']) {
  if (process.env[k]) childEnv[k] = process.env[k];
}
Object.assign(childEnv, {
  PORT: String(port),
  DB_PATH: path.join(tmp, 'e2e.db'),
  AUTH_TOKEN,
  REGISTER_TOKEN,
  // brak DASHBOARD_PASSWORD - swiadomie testujemy tryb otwarty
});
const child = spawn(process.execPath, ['index.js'], {
  cwd: SERVER_DIR,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: childEnv,
});
child.stdout.on('data', () => {});
child.stderr.on('data', (d) => console.error(`[srv] ${d}`));

try {
  const health = await waitHealth(base);
  ok(!!health.ok, `/api/health ok (port ${port}, wersja ${health.version ?? '?'})`);

  const reg = await fetch(`${base}/api/agent/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'e2e-fake', ip: '10.99.0.1', type: 'laptop', os_name: 'linux',
      mac: 'DE:AD:BE:EF:00:01', register_token: REGISTER_TOKEN, device_uuid: UUID,
    }),
  });
  const dev = await reg.json();
  ok(reg.status === 200 && !!dev.api_key, 'rejestracja fake-agenta zwraca api_key');

  for (const cpu of [11, 22, 33]) {
    const r = await report(base, dev.api_key, {
      cpu_percent: cpu, ram_used_mb: 500, ram_total_mb: 4000,
      disk_used_gb: 20, disk_total_gb: 100, uptime_seconds: 100,
      net_in_bytes: 5, net_out_bytes: 6,
      disks: [{ mount: '/', fs: 'ext4', used_gb: 20, total_gb: 100 }],
    });
    ok(r.status === 200, `raport agenta (${cpu}% CPU) przyjety`);
  }

  const list = await (await fetch(`${base}/api/devices`)).json();
  const e2e = (list.devices || []).find((d) => d.name === 'e2e-fake');
  ok(!!e2e && list.devices.every((d) => !('api_key' in d) && !('device_uuid' in d)),
    'dashboard widzi urzadzenie, zero wyciekow kluczy');
  ok(e2e?.last_cpu === 33 && e2e?.last_disks?.length === 1, 'ostatnie metryki i dyski widoczne');

  const hist = await (await fetch(`${base}/api/devices/${dev.id}/metrics?hours=1`)).json();
  ok(hist.metrics.length === 3, `historia ma 3 pomiary (${hist.metrics.length})`);

  const cfg = await (await fetch(`${base}/config.js`)).text();
  ok(cfg.includes(AUTH_TOKEN), 'tryb otwarty: config.js wydaje token (legacy)');

  const home = await fetch(base);
  const html = await home.text();
  ok(home.status === 200 && html.includes('<div id="root">'), 'dashboard (SPA) serwowany z /');

  await report(base, dev.api_key, { cpu_percent: 5, temperature_c: 99 });
  const alerts = await (await fetch(`${base}/api/alerts`)).json();
  const highTemp = alerts.alerts.find((a) => a.type === 'high_temp');
  ok(!!highTemp, 'alert high_temp powstaje po goracym raporcie');

  const patch = await fetch(`${base}/api/devices/${dev.id}/thresholds`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Auth-Token': AUTH_TOKEN },
    body: JSON.stringify({ temperature_c: 60 }),
  });
  ok(patch.status === 200, 'zapis progow z X-Auth-Token (tryb otwarty)');

  const wsMsg = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'metrics') { resolve(m); ws.close(); }
    });
    ws.on('error', reject);
    setTimeout(() => { ws.close(); reject(new Error('brak broadcastu WS')); }, 10000);
    report(base, dev.api_key, { cpu_percent: 44 }).catch(reject);
  });
  ok(wsMsg.metrics.cpu_percent === 44, 'WS broadcast metrics dochodzi live');
} catch (e) {
  ok(false, `wyjatek: ${e.message}`);
} finally {
  child.kill();
  setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }, 1500);
}

console.log(failures === 0 ? '\nE2E SMOKE: WSZYSTKO ZIELONE' : `\nE2E SMOKE: ${failures} FAILI`);
process.exit(failures === 0 ? 0 : 1);
