import crypto from 'node:crypto';
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
  updateDeviceMeta,
  setThresholds,
  getThresholds,
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
// Haslo do dashboardu. Ustawione = odczyt i zapis wymagaja sesji (cookie HttpOnly).
// Nieustawione = stary tryb otwarty (token przez /config.js) - z ostrzezeniem przy starcie.
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const SECURED = DASHBOARD_PASSWORD.length > 0;
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

app.disable('x-powered-by');
if (process.env.CORS_DEV === '1') {
  // tylko dla dev (vite na 5173) - wlaczaj wprost: CORS_DEV=1
  app.use(cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'], credentials: true }));
}
app.use(express.json({ limit: '10kb' }));

// --- sesje dashboardu ---
const SESSION_TTL_MS = 12 * 3600 * 1000;
const sessions = new Map(); // sid -> expires (ms)
const COOKIE_NAME = 'dhm_sid';

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest(); }

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession(res) {
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, Date.now() + SESSION_TTL_MS);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
}

function validSession(req) {
  const sid = parseCookies(req)[COOKIE_NAME];
  if (!sid) return false;
  const exp = sessions.get(sid);
  if (!exp || exp < Date.now()) { sessions.delete(sid); return false; }
  sessions.set(sid, Date.now() + SESSION_TTL_MS); // przesuwanie okna aktywnosci
  return true;
}

const sessionSweeper = setInterval(() => {
  const now = Date.now();
  for (const [sid, exp] of sessions) if (exp < now) sessions.delete(sid);
}, 3600_000);
sessionSweeper.unref?.();

function requireSession(req, res, next) {
  if (!SECURED || validSession(req)) return next();
  res.status(401).json({ error: 'Unauthorized - sign in via /api/login' });
}

// config.js dynamicznie. W trybie secured NIE wydajemy tokenu nikomu -
// dashboard pracuje na sesji (cookie). Tryb otwarty zachowuje stary mechanizm.
app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  if (SECURED) {
    res.send('window.DHM_CONFIG = {};');
  } else {
    res.send(`window.DHM_CONFIG = { token: ${JSON.stringify(AUTH_TOKEN)} };`);
  }
});
app.use(express.static(path.join(__dirname, '../dashboard/dist')));

const limiterRegister = rateLimit({ windowMs: 60_000, limit: Number(process.env.REGISTER_RATE_LIMIT) || 5 });
const limiterLogin = rateLimit({ windowMs: 300_000, limit: Number(process.env.LOGIN_RATE_LIMIT) || 20 });
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
  group: z.string().trim().max(32).optional(),
  register_token: z.string().optional(),
  device_uuid: z.string().trim().max(64).optional(),
});

const nameSchema = z.string().trim().min(1).max(64);
const groupSchema = z.string().trim().max(32);

function authWrite(req, res, next) {
  // sesja (tryb secured) LUB naglowek X-Auth-Token (stary tryb otwarty)
  if (!SECURED && AUTH_TOKEN && req.headers['x-auth-token'] === AUTH_TOKEN) return next();
  if (!AUTH_TOKEN) {
    return res.status(503).json({ error: 'AUTH_TOKEN not configured - set it in server/.env' });
  }
  if (SECURED) {
    if (validSession(req)) return next();
    return res.status(401).json({ error: 'Unauthorized - sign in via /api/login' });
  }
  return res.status(401).json({ error: 'Unauthorized' });
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
    body.mac || null,
    body.group || '',
    body.device_uuid || null
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

// --- logowanie dashboardu (tryb secured: DASHBOARD_PASSWORD ustawione) ---
app.post('/api/login', limiterLogin, (req, res) => {
  if (!SECURED) return res.status(400).json({ error: 'Dashboard not secured - set DASHBOARD_PASSWORD in server/.env' });
  const pass = typeof req.body?.password === 'string' ? req.body.password : '';
  const ok = pass.length > 0 && sha256(pass).equals(sha256(DASHBOARD_PASSWORD));
  if (!ok) return res.status(401).json({ error: 'Invalid password' });
  createSession(res);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const sid = parseCookies(req)[COOKIE_NAME];
  if (sid) sessions.delete(sid);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  res.json({ secured: SECURED, authenticated: !SECURED || validSession(req) });
});

// Dashboard endpoints (odczyt - w trybie secured wymagana sesja)
app.get('/api/devices', requireSession, (req, res) => {
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
      last_disks: (() => {
        try { return m?.disks_json ? JSON.parse(m.disks_json) : null; } catch { return null; }
      })(),
      last_battery: m?.battery_percent ?? null,
      last_battery_charging: m?.battery_charging ?? null,
      os_name: d.os_name ?? 'unknown',
      mac: d.mac ?? null,
    };
  });
  const summary = getDeviceSummary();
  res.json({ devices, summary });
});

app.get('/api/devices/:id', requireSession, (req, res) => {
  const row = getDevice(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  const device = publicDevice(row);
  const metrics = getLatestMetrics(device.id);
  const thresholds = getThresholds(device.id);
  res.json({ device, metrics, thresholds });
});

app.patch('/api/devices/:id/thresholds', limiterWrite, authWrite, (req, res) => {
  const id = Number(req.params.id);
  if (!getDevice(id)) return res.status(404).json({ error: 'Not found' });
  setThresholds(id, req.body || {});
  broadcast({ type: 'device_update', device: publicDevice(getDevice(id)) });
  res.json({ ok: true, thresholds: getThresholds(id) });
});

app.get('/api/devices/:id/metrics', requireSession, (req, res) => {
  const raw = Number(req.query.hours);
  const hours = Number.isFinite(raw) ? Math.min(720, Math.max(1, raw)) : 24;
  const metrics = getMetrics(Number(req.params.id), hours);
  res.json({ metrics });
});

app.get('/api/alerts', requireSession, (req, res) => {
  res.json({ alerts: getActiveAlerts() });
});

app.get('/api/summary', requireSession, (req, res) => {
  res.json(getDeviceSummary());
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), version: PKG.version || null });
});

// Setup info dla dashboardu: gotowe komendy instalacji agenta
// (adres z Host naglowka; w trybie secured dostepne tylko po zalogowaniu)
app.get('/api/setup', requireSession, (req, res) => {
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
  const patch = {};
  if (req.body?.name !== undefined) patch.name = nameSchema.parse(req.body.name);
  if (req.body?.grp !== undefined) patch.grp = groupSchema.parse(req.body.grp);
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update' });
  updateDeviceMeta(id, patch);
  broadcast({ type: 'device_update', device: publicDevice(getDevice(id)) });
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

// Prometheus exposition format (odczyt - w trybie secured wymagana sesja)
app.get('/metrics', requireSession, (req, res) => {
  const rows = getAllDevices().map((d) => {
    const device = publicDevice(d);
    let disks = [];
    const m = getLatestMetrics(device.id);
    try { if (m?.disks_json) disks = JSON.parse(m.disks_json); } catch {}
    return { device, m, disks };
  });
  const lines = [];
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const labels = (d) => `device="${esc(d.name)}",ip="${esc(d.ip)}",type="${esc(d.type)}",group="${esc(d.grp || '')}"`;
  const emit = (name, help, fn) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const { device, m, disks } of rows) {
      const v = fn({ device, m, disks });
      if (v != null) lines.push(`${name}{${labels(device)}} ${v}`);
    }
  };

  emit('dhm_device_online', '1 if device reported recently', ({ device }) => (device.is_online ? 1 : 0));
  emit('dhm_cpu_percent', 'CPU usage percent', ({ m }) => m?.cpu_percent);
  emit('dhm_ram_used_mb', 'RAM used MB', ({ m }) => m?.ram_used_mb);
  emit('dhm_ram_total_mb', 'RAM total MB', ({ m }) => m?.ram_total_mb);
  emit('dhm_disk_used_gb', 'Disk used GB (system + /home)', ({ m }) => m?.disk_used_gb);
  emit('dhm_temperature_celsius', 'Temperature C', ({ m }) => m?.temperature_c);
  emit('dhm_uptime_seconds', 'Uptime seconds', ({ m }) => m?.uptime_seconds);
  emit('dhm_battery_percent', 'Battery percent', ({ m }) => m?.battery_percent);

  lines.push('# HELP dhm_disk_mount_used_gb Per-mount disk used GB', '# TYPE dhm_disk_mount_used_gb gauge');
  lines.push('# HELP dhm_disk_mount_total_gb Per-mount disk total GB', '# TYPE dhm_disk_mount_total_gb gauge');
  for (const { device, disks } of rows) {
    for (const dsk of disks) {
      const extra = `mount="${esc(dsk.mount)}"`;
      if (dsk.used_gb != null) lines.push(`dhm_disk_mount_used_gb{${labels(device)},${extra}} ${dsk.used_gb}`);
      if (dsk.total_gb != null) lines.push(`dhm_disk_mount_total_gb{${labels(device)},${extra}} ${dsk.total_gb}`);
    }
  }

  res.type('text/plain; version=0.0.4; charset=utf-8').send(lines.join('\n') + '\n');
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
  res.status(err.status || 500).json({ error: 'Internal Server Error' });
});

// HTTP + WebSocket
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  // tryb secured: handshake wymaga waznej sesji (cookie idzie automatycznie same-origin)
  verifyClient: (info, done) => {
    if (!SECURED) return done(true);
    done(validSession({ headers: info.req.headers }));
  },
});

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
  if (SECURED) {
    console.log('Dashboard: logowanie haslem (DASHBOARD_PASSWORD) - odczyt i zapis wymagaja sesji.');
  } else {
    console.warn('UWAGA: dashboard OTWARTY (bez loginu). Ustaw DASHBOARD_PASSWORD w server/.env,');
    console.warn('       zeby chronic podglad sieci i operacje zapisu.');
  }
});

function shutdown() {
  clearInterval(summaryTimer);
  clearInterval(selfTimer);
  clearInterval(sessionSweeper);
  server.close();
}

export { server, shutdown };
