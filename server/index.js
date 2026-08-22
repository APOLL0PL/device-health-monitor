import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { ZodError, z } from 'zod';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import {
  checkOfflineDevices,
  getActiveAlerts,
  getAllDevices,
  getAlert,
  getDevice,
  getDeviceByKey,
  getDeviceSummary,
  getLatestMetrics,
  getMetrics,
  publicDevice,
  recordMetrics,
  registerDevice,
  removeDevice,
  resolveAlert,
  updateDeviceName,
} from './lib/store.js';
import { start as selfmonitorStart } from './lib/selfmonitor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

app.disable('x-powered-by');
app.use(cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }));
app.use(express.json({ limit: '10kb' }));
// config.js dynamicznie (AUTH_TOKEN z .env) - npm run build kasuje plik z dist,
// a tak dashboard dostaje token niezaleznie od builda
app.get('/config.js', (req, res) => {
  res.type('application/javascript').send(`window.DHM_CONFIG = { token: ${JSON.stringify(AUTH_TOKEN)} };`);
});
app.use(express.static(path.join(__dirname, '../dashboard/dist')));

const limiterRegister = rateLimit({ windowMs: 60_000, limit: 5 });
const limiterWrite = rateLimit({ windowMs: 60_000, limit: 30 });
const limiterReport = rateLimit({
  windowMs: 60_000,
  limit: 30,
  keyGenerator: (req) => req.headers['x-api-key'] || ipKeyGenerator(req.ip),
});

const registerSchema = z.object({
  name: z.string().trim().min(1).max(64),
  ip: z.union([z.string().trim().ipv4(), z.string().trim().ipv6()]),
  type: z.enum(['server', 'desktop', 'laptop', 'phone', 'android', 'unknown']).default('unknown'),
  os_name: z.string().max(32).default('unknown'),
  mac: z.string().max(32).optional().nullable(),
  register_token: z.string().optional(),
});

const nameSchema = z.string().trim().min(1).max(64);

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
  const device = getDeviceByKey(key);
  if (!device) return res.status(403).json({ error: 'Invalid API key' });
  req.device = device;
  next();
}

// Agent endpoints
app.post('/api/agent/register', limiterRegister, (req, res) => {
  if (!REGISTER_TOKEN) {
    return res.status(503).json({ error: 'REGISTER_TOKEN not configured — set it in server/.env' });
  }
  const body = registerSchema.parse(req.body || {});
  if (body.register_token !== REGISTER_TOKEN) {
    return res.status(403).json({ error: 'Invalid register token' });
  }
  const device = registerDevice(
    body.name,
    body.ip,
    body.type,
    body.os_name,
    body.mac || null
  );
  if (!device) {
    return res.status(409).json({ error: 'No reliable identity (IP loopback without MAC)' });
  }
  broadcast({ type: 'device_update', device: publicDevice(getDevice(device.id)) });
  res.json(device);
});

app.post('/api/agent/report', limiterReport, authenticateAgent, (req, res) => {
  recordMetrics(req.device.id, req.body || {});
  const device = getDevice(req.device.id);
  const metrics = getLatestMetrics(req.device.id);
  broadcast({ type: 'metrics', deviceId: req.device.id, metrics, device: publicDevice(device) });
  res.json({ ok: true });
});

// Dashboard endpoints (read-only, open dashboard)
app.get('/api/devices', (req, res) => {
  const devices = getAllDevices().map((d) => {
    const device = publicDevice(d);
    const m = getLatestMetrics(device.id);
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
  const summary = getDeviceSummary();
  res.json({ devices, summary });
});

app.get('/api/devices/:id', (req, res) => {
  const row = getDevice(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  const device = publicDevice(row);
  const metrics = getLatestMetrics(device.id);
  res.json({ device, metrics });
});

app.get('/api/devices/:id/metrics', (req, res) => {
  const raw = Number(req.query.hours);
  const hours = Number.isFinite(raw) ? Math.min(720, Math.max(1, raw)) : 24;
  const metrics = getMetrics(Number(req.params.id), hours);
  res.json({ metrics });
});

app.get('/api/alerts', (req, res) => {
  res.json({ alerts: getActiveAlerts() });
});

app.get('/api/summary', (req, res) => {
  res.json(getDeviceSummary());
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), version: PKG.version || null });
});

// Setup info dla dashboardu: gotowe komendy instalacji agenta
// (adres z Host nagłówka - dashboard i tak jest otwarty w LAN)
app.get('/api/setup', (req, res) => {
  const host = req.headers.host || `localhost:${PORT}`;
  const proto = req.protocol === 'https' ? 'https' : 'http';
  const base = `${proto}://${host}`;
  if (!REGISTER_TOKEN) {
    return res.status(503).json({ error: 'REGISTER_TOKEN not configured — set it in server/.env' });
  }
  const rel = 'https://github.com/APOLL0PL/device-health-monitor/releases/latest/download';
  res.json({
    server_url: base,
    register_token: REGISTER_TOKEN,
    install: {
      windows: `curl -fsSL ${rel}/user-win.bat -o %TEMP%\\user-win.bat && set SERVER_URL=${base}&& set REGISTER_TOKEN=${REGISTER_TOKEN}&& %TEMP%\\user-win.bat`,
      linux: `curl -fsSL ${rel}/user-linux.sh -o /tmp/dhm-install.sh && SERVER_URL=${base} REGISTER_TOKEN=${REGISTER_TOKEN} sh /tmp/dhm-install.sh`,
      termux: `pkg install -y curl && curl -fsSL ${rel}/setup-termux.sh -o /tmp/dhm-setup.sh && SERVER_URL=${base} REGISTER_TOKEN=${REGISTER_TOKEN} sh /tmp/dhm-setup.sh`,
    },
  });
});

// Write endpoints (require X-Auth-Token)
app.patch('/api/devices/:id', limiterWrite, authWrite, (req, res) => {
  const id = Number(req.params.id);
  if (!getDevice(id)) return res.status(404).json({ error: 'Not found' });
  const name = nameSchema.parse(req.body?.name);
  updateDeviceName(id, name);
  res.json({ ok: true, device: publicDevice(getDevice(id)) });
});

app.delete('/api/devices/:id', limiterWrite, authWrite, (req, res) => {
  const id = Number(req.params.id);
  if (!getDevice(id)) return res.status(404).json({ error: 'Not found' });
  removeDevice(id);
  broadcast({ type: 'device_removed', deviceId: id });
  res.json({ ok: true });
});

app.post('/api/alerts/:id/resolve', limiterWrite, authWrite, (req, res) => {
  const id = Number(req.params.id);
  if (!getAlert(id)) return res.status(404).json({ error: 'Not found' });
  resolveAlert(id);
  broadcast({ type: 'alerts' });
  res.json({ ok: true });
});

// SPA fallback
app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, '../dashboard/dist/index.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'invalid payload', details: err.issues });
  }
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err.message || err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

// HTTP + WebSocket
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

const summaryTimer = setInterval(() => {
  checkOfflineDevices();
  const summary = getDeviceSummary();
  broadcast({ type: 'summary', summary });
}, 60_000);

const selfTimer = selfmonitorStart(broadcast);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Device Health Monitor server on http://0.0.0.0:${PORT}`);
});

function shutdown() {
  clearInterval(summaryTimer);
  clearInterval(selfTimer);
  server.close();
}

export { server, shutdown };
