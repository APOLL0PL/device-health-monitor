const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { WebSocketServer } = require('ws');
const http = require('http');
const store = require('./lib/store');
const rateLimit = require('./lib/ratelimit');
const selfmonitor = require('./lib/selfmonitor');

if (fs.existsSync(path.join(__dirname, '.env'))) {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const app = express();
const PORT = process.env.PORT || 4000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const REGISTER_TOKEN = process.env.REGISTER_TOKEN || process.env.AUTH_TOKEN || '';

app.disable('x-powered-by');
app.use(cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, '../dashboard/dist')));

const limiterRegister = rateLimit(60_000, 5, (req) => req.ip);
const limiterWrite = rateLimit(60_000, 30, (req) => req.ip);
const limiterReport = rateLimit(60_000, 30, (req) => req.headers['x-api-key'] || req.ip);

function authWrite(req, res, next) {
  if (!AUTH_TOKEN) {
    return res.status(503).json({ error: 'AUTH_TOKEN not configured — set it in server/.env' });
  }
  if (req.headers['x-auth-token'] !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function authenticateAgent(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'Missing X-Api-Key header' });
  const device = store.getDeviceByKey(key);
  if (!device) return res.status(403).json({ error: 'Invalid API key' });
  req.device = device;
  next();
}

// --- Agent endpoints ---
app.post('/api/agent/register', limiterRegister, (req, res) => {
  const { name, ip, type, os_name, mac, register_token } = req.body || {};
  if (!REGISTER_TOKEN) {
    return res.status(503).json({ error: 'REGISTER_TOKEN not configured — set it in server/.env' });
  }
  if (register_token !== REGISTER_TOKEN) {
    return res.status(403).json({ error: 'Invalid register token' });
  }
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 64) {
    return res.status(400).json({ error: 'name invalid' });
  }
  if (typeof ip !== 'string' || net.isIP(ip.trim()) === 0) {
    return res.status(400).json({ error: 'ip invalid' });
  }
  const types = ['server', 'desktop', 'laptop', 'phone', 'android', 'unknown'];
  const deviceType = types.includes(type) ? type : 'unknown';
  const device = store.registerDevice(
    name.trim(),
    ip.trim(),
    deviceType,
    typeof os_name === 'string' ? os_name.slice(0, 32) : 'unknown',
    typeof mac === 'string' ? mac.slice(0, 32) : null
  );
  if (!device) {
    return res.status(409).json({ error: 'No reliable identity (IP loopback without MAC)' });
  }
  broadcast({ type: 'device_update', device: store.getDevice(device.id) });
  res.json(device);
});

app.post('/api/agent/report', limiterReport, authenticateAgent, (req, res) => {
  store.recordMetrics(req.device.id, req.body || {});
  const device = store.getDevice(req.device.id);
  const metrics = store.getLatestMetrics(req.device.id);
  broadcast({ type: 'metrics', deviceId: req.device.id, metrics, device });
  res.json({ ok: true });
});

// --- Dashboard endpoints (odczyt otwarty, bez logowania) ---
app.get('/api/devices', (req, res) => {
  const devices = store.getAllDevices().map((d) => {
    const { api_key, ...device } = d;
    const m = store.getLatestMetrics(device.id);
    return {
      ...device,
      last_cpu: m?.cpu_percent ?? null,
      last_ram_pct: m?.ram_total_mb > 0 ? Math.round((m.ram_used_mb / m.ram_total_mb) * 100) : null,
      last_disk_pct: m?.disk_total_gb > 0 ? Math.round((m.disk_used_gb / m.disk_total_gb) * 100) : null,
      last_temp: m?.temperature_c ?? null,
      last_ram_used: m?.ram_used_mb ?? null,
      last_ram_total: m?.ram_total_mb ?? null,
      last_ram_cache: m?.ram_cache_mb ?? 0,
      last_disk_used: m?.disk_used_gb ?? null,
      last_disk_total: m?.disk_total_gb ?? null,
      last_disk_sys_used: m?.disk_sys_used_gb ?? null,
      last_disk_sys_total: m?.disk_sys_total_gb ?? null,
      last_net_in: m?.net_in_bytes ?? null,
      last_net_out: m?.net_out_bytes ?? null,
      os_name: d.os_name ?? 'unknown',
      mac: d.mac ?? null,
    };
  });
  const summary = store.getDeviceSummary();
  res.json({ devices, summary });
});

app.get('/api/devices/:id', (req, res) => {
  const row = store.getDevice(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { api_key, ...device } = row;
  const metrics = store.getLatestMetrics(device.id);
  res.json({ device, metrics });
});

app.get('/api/devices/:id/metrics', (req, res) => {
  const raw = Number(req.query.hours);
  const hours = Number.isFinite(raw) ? Math.min(720, Math.max(1, raw)) : 24;
  const metrics = store.getMetrics(Number(req.params.id), hours);
  res.json({ metrics });
});

app.get('/api/alerts', (req, res) => {
  res.json({ alerts: store.getActiveAlerts() });
});

app.get('/api/summary', (req, res) => {
  res.json(store.getDeviceSummary());
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), version: require('./package.json').version || null });
});

// --- Endpointy zapisu (wymagają X-Auth-Token) ---
app.patch('/api/devices/:id', limiterWrite, authWrite, (req, res) => {
  const id = Number(req.params.id);
  if (!store.getDevice(id)) return res.status(404).json({ error: 'Not found' });
  const name = req.body?.name;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 64) {
    return res.status(400).json({ error: 'name invalid' });
  }
  store.updateDeviceName(id, name.trim());
  res.json({ ok: true, device: store.getDevice(id) });
});

app.delete('/api/devices/:id', limiterWrite, authWrite, (req, res) => {
  const id = Number(req.params.id);
  if (!store.getDevice(id)) return res.status(404).json({ error: 'Not found' });
  store.removeDevice(id);
  broadcast({ type: 'device_removed', deviceId: id });
  res.json({ ok: true });
});

app.post('/api/alerts/:id/resolve', limiterWrite, authWrite, (req, res) => {
  const id = Number(req.params.id);
  if (!store.getAlert(id)) return res.status(404).json({ error: 'Not found' });
  store.resolveAlert(id);
  broadcast({ type: 'alerts' });
  res.json({ ok: true });
});

// SPA fallback
app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, '../dashboard/dist/index.html'));
});

// --- HTTP + WebSocket ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

setInterval(() => {
  store.checkOfflineDevices();
  const summary = store.getDeviceSummary();
  broadcast({ type: 'summary', summary });
}, 60_000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Device Health Monitor server on http://0.0.0.0:${PORT}`);
  selfmonitor.start(broadcast);
});
