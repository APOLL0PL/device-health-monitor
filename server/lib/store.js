import crypto from 'node:crypto';
import db from '../db.js';

const THRESHOLDS = {
  disk_percent: 90,
  disk_critical_percent: 97,
  temperature_c: 70,
  cpu_percent: 90,
  cpu_duration_minutes: 5,
  offline_minutes: 10,
};

function num(v, def = null) {
  // Number(null)=0, wiec jawne null/undefined musza isc prosto do defa,
  // inaczej "brak pomiaru" (np. temperatura) zapisuje sie jako falszywe zero
  if (v === null || v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function clamp(v, min, max, def = null) {
  const n = num(v, def);
  if (n === null) return def;
  return Math.min(max, Math.max(min, n));
}

let lastPrune = 0;

function isLoopback(ip) {
  return typeof ip === 'string' && (ip === '127.0.0.1' || ip.startsWith('127.'));
}

function registerDevice(name, ip, type = 'unknown', os_name = 'unknown', mac = null, grp = '', device_uuid = null) {
  // 1. UUID agenta - najmocniejsza tożsamość (trwała, generowana raz przez agenta)
  if (device_uuid) {
    const byUuid = db.prepare('SELECT id, api_key, ip FROM devices WHERE device_uuid = ?').get(device_uuid);
    if (byUuid) {
      const newIp = isLoopback(ip) ? byUuid.ip : ip;
      // grp aktualizowany tylko gdy agent faktycznie go podal (puste = nie ruszaj,
      // bo grupy ustawiane na dashboardzie wygryaja z pustym DEVICE_GROUP agenta)
      db.prepare('UPDATE devices SET ip = ?, os_name = ?, type = ?, mac = COALESCE(?, mac), grp = CASE WHEN ? != \'\' THEN ? ELSE grp END WHERE id = ?')
        .run(newIp, os_name, type, mac, grp ?? '', grp ?? '', byUuid.id);
      return getDevice(byUuid.id);
    }
  }
  // Try MAC-based lookup first
  if (mac) {
    const existing = db.prepare('SELECT id, api_key, ip FROM devices WHERE mac = ?').get(mac);
    if (existing) {
      // nigdy nie nadpisuj prawdziwego IP adresem loopback
      const newIp = isLoopback(ip) ? existing.ip : ip;
      db.prepare('UPDATE devices SET ip = ?, os_name = ? WHERE id = ?').run(newIp, os_name, existing.id);
      return existing;
    }
  }
  // Fallback to IP-based lookup for legacy (pomijaj loopback — nie jest tożsamością)
  if (!isLoopback(ip)) {
    const existing = db.prepare('SELECT id, api_key FROM devices WHERE ip = ?').get(ip);
    if (existing) {
      db.prepare('UPDATE devices SET mac = COALESCE(?, mac), os_name = ? WHERE id = ?').run(mac, os_name, existing.id);
      return existing;
    }
  }

  // Nie rejestruj urządzenia z IP loopback bez MAC (np. boot zanim sieć wstanie) —
  // to tworzyło duplikaty typu agent@127.0.0.1, które blokują prawdziwy adres.
  if (!mac && isLoopback(ip)) {
    return null;
  }

  const api_key = crypto.randomUUID();
  const result = db.prepare(
    'INSERT INTO devices (name, ip, type, os_name, mac, api_key, grp, device_uuid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(name, ip, type, os_name, mac, api_key, grp, device_uuid);

  return { id: result.lastInsertRowid, api_key };
}

function getAllDevices() {
  return db.prepare('SELECT * FROM devices ORDER BY is_online DESC, name').all();
}

function publicDevice(d) {
  if (!d) return d;
  const { api_key, device_uuid, ...device } = d;
  return device;
}

function getDevice(id) {
  return db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
}

function getDeviceByKey(api_key) {
  return db.prepare('SELECT * FROM devices WHERE api_key = ?').get(api_key);
}

function updateDeviceMeta(id, { name, grp } = {}) {
  if (name !== undefined) db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(name, id);
  if (grp !== undefined) db.prepare('UPDATE devices SET grp = ? WHERE id = ?').run(grp, id);
}

function removeDevice(id) {
  db.prepare('DELETE FROM metrics WHERE device_id = ?').run(id);
  db.prepare('DELETE FROM alerts WHERE device_id = ?').run(id);
  db.prepare('DELETE FROM devices WHERE id = ?').run(id);
}

function recordMetrics(deviceId, metrics) {
  let disksJson = null;
  if (Array.isArray(metrics.disks)) {
    const clean = metrics.disks.slice(0, 8).map((d) => ({
      mount: String(d?.mount ?? '').slice(0, 32),
      fs: String(d?.fs ?? '').slice(0, 16),
      used_gb: clamp(d?.used_gb, 0, 1e9, null),
      total_gb: clamp(d?.total_gb, 0, 1e9, null),
    })).filter((d) => d.mount && d.total_gb != null);
    if (clean.length) disksJson = JSON.stringify(clean);
  }

  const stmt = db.prepare(`
    INSERT INTO metrics (device_id, cpu_percent, ram_used_mb, ram_total_mb, ram_cache_mb,
      disk_used_gb, disk_total_gb, disk_sys_used_gb, disk_sys_total_gb,
      temperature_c, uptime_seconds,
      net_in_bytes, net_out_bytes, disks_json, battery_percent, battery_charging)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    deviceId,
    clamp(metrics.cpu_percent, 0, 100, 0),
    Math.round(clamp(metrics.ram_used_mb, 0, 1e9, 0)),
    Math.round(clamp(metrics.ram_total_mb, 0, 1e9, 0)),
    Math.round(clamp(metrics.ram_cache_mb, 0, 1e9, 0)),
    clamp(metrics.disk_used_gb, 0, 1e9, 0),
    clamp(metrics.disk_total_gb, 0, 1e9, 0),
    clamp(metrics.disk_sys_used_gb, 0, 1e9, null) ?? clamp(metrics.disk_used_gb, 0, 1e9, 0),
    clamp(metrics.disk_sys_total_gb, 0, 1e9, null) ?? clamp(metrics.disk_total_gb, 0, 1e9, 0),
    (() => {
      const t = num(metrics.temperature_c);
      return t !== null && t > -50 && t < 200 ? t : null;
    })(),
    Math.floor(clamp(metrics.uptime_seconds, 0, 1e12, 0)),
    clamp(metrics.net_in_bytes, 0, 1e18, 0),
    clamp(metrics.net_out_bytes, 0, 1e18, 0),
    disksJson,
    (() => {
      const b = num(metrics.battery_percent);
      return b !== null && b >= 0 && b <= 100 ? b : null;
    })(),
    metrics.battery_charging === 1 || metrics.battery_charging === true ? 1 : null
  );

  if (typeof metrics.ip === 'string' && metrics.ip.length <= 64 && metrics.ip !== '127.0.0.1') {
    const taken = db.prepare('SELECT id FROM devices WHERE ip = ? AND id != ?').get(metrics.ip, deviceId);
    if (!taken) {
      db.prepare('UPDATE devices SET ip = ? WHERE id = ?').run(metrics.ip, deviceId);
    }
  }

  if (typeof metrics.mac === 'string' && metrics.mac.length <= 32) {
    db.prepare('UPDATE devices SET mac = COALESCE(mac, ?) WHERE id = ?').run(metrics.mac, deviceId);
  }

  db.prepare(`
    UPDATE devices SET last_seen = datetime('now'), is_online = 1 WHERE id = ?
  `).run(deviceId);

  checkAlerts(deviceId, metrics);
  pruneOldMetrics();
}

function getMetrics(deviceId, hours = 24) {
  return db.prepare(`
    SELECT * FROM metrics
    WHERE device_id = ? AND timestamp > datetime('now', ?)
    ORDER BY timestamp ASC
  `).all(deviceId, `-${hours} hours`);
}

function getLatestMetrics(deviceId) {
  return db.prepare(`
    SELECT * FROM metrics WHERE device_id = ? ORDER BY timestamp DESC LIMIT 1
  `).get(deviceId);
}

function getThresholds(deviceId) {
  const row = db.prepare('SELECT * FROM device_thresholds WHERE device_id = ?').get(deviceId);
  const merged = { ...THRESHOLDS };
  if (row) {
    for (const k of ['disk_percent', 'disk_critical_percent', 'temperature_c', 'cpu_percent', 'cpu_duration_minutes']) {
      const v = row[k];
      if (v !== null && v !== undefined && Number.isFinite(Number(v))) merged[k] = Number(v);
    }
  }
  return merged;
}

function setThresholds(deviceId, patch = {}) {
  const keys = ['disk_percent', 'disk_critical_percent', 'temperature_c', 'cpu_percent', 'cpu_duration_minutes'];
  const existing = db.prepare('SELECT * FROM device_thresholds WHERE device_id = ?').get(deviceId) || {};
  const next = {};
  for (const k of keys) {
    if (patch[k] === undefined) next[k] = existing[k] ?? null;
    else if (patch[k] === null || patch[k] === '') next[k] = null;
    else next[k] = num(patch[k], existing[k] ?? null);
  }
  db.prepare(`
    INSERT OR REPLACE INTO device_thresholds (device_id, ${keys.join(', ')})
    VALUES (?, ${keys.map(() => '?').join(', ')})
  `).run(deviceId, ...keys.map((k) => next[k]));
}

function checkAlerts(deviceId, metrics) {
  const device = getDevice(deviceId);
  if (!device) return;

  const TH = getThresholds(deviceId);
  const newAlerts = [];

  if (metrics.disk_total_gb > 0) {
    const diskPercent = (metrics.disk_used_gb / metrics.disk_total_gb) * 100;
    if (diskPercent > TH.disk_percent) {
      newAlerts.push({
        type: 'disk_full',
        message: `${device.name}: dysk ${diskPercent.toFixed(1)}% (${metrics.disk_used_gb.toFixed(1)}/${metrics.disk_total_gb.toFixed(1)} GB)`,
        severity: diskPercent > TH.disk_critical_percent ? 'critical' : 'warning',
      });
    }
  }

  if (metrics.temperature_c && metrics.temperature_c > TH.temperature_c) {
    newAlerts.push({
      type: 'high_temp',
      message: `${device.name}: temperatura ${metrics.temperature_c}°C`,
      severity: metrics.temperature_c > 80 ? 'critical' : 'warning',
    });
  }

  if (metrics.cpu_percent > TH.cpu_percent) {
    const recent = db.prepare(`
      SELECT COUNT(*) as cnt FROM metrics
      WHERE device_id = ? AND cpu_percent > ? AND timestamp > datetime('now', ?)
    `).get(deviceId, TH.cpu_percent, `-${TH.cpu_duration_minutes} minutes`);

    if (recent.cnt >= TH.cpu_duration_minutes * 2) {
      newAlerts.push({
        type: 'high_cpu',
        message: `${device.name}: CPU ${metrics.cpu_percent}% przez >${TH.cpu_duration_minutes}min`,
        severity: 'warning',
      });
    }
  }

  const insert = db.prepare(`
    INSERT INTO alerts (device_id, type, message, severity)
    SELECT ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM alerts WHERE device_id = ? AND type = ? AND resolved_at IS NULL
    )
  `);

  for (const alert of newAlerts) {
    insert.run(deviceId, alert.type, alert.message, alert.severity, deviceId, alert.type);
  }
}

function checkOfflineDevices() {
  db.prepare(`
    UPDATE devices SET is_online = 0
    WHERE is_online = 1 AND last_seen < datetime('now', ?)
  `).run(`-${THRESHOLDS.offline_minutes} minutes`);
}

function getOfflineDevices() {
  return db.prepare(`
    SELECT id, name, ip, type, os_name, mac, last_seen, is_online
    FROM devices WHERE is_online = 0 AND last_seen IS NOT NULL
    ORDER BY last_seen DESC
  `).all();
}

function getActiveAlerts() {
  return db.prepare(`
    SELECT a.*, d.name as device_name FROM alerts a
    JOIN devices d ON a.device_id = d.id
    WHERE a.resolved_at IS NULL AND a.type != 'device_offline'
    ORDER BY a.created_at DESC
  `).all();
}

function getAlert(id) {
  return db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
}

function resolveAlert(id) {
  db.prepare("UPDATE alerts SET resolved_at = datetime('now') WHERE id = ?").run(id);
}

function pruneOldMetrics() {
  const now = Date.now();
  if (now - lastPrune < 3_600_000) return;
  lastPrune = now;
  db.prepare("DELETE FROM metrics WHERE timestamp < datetime('now', '-30 days')").run();
  // rotacja rozwiążanych alertów (aktywne zostają, zamknięte znikać po 30 dniach)
  db.prepare("DELETE FROM alerts WHERE resolved_at IS NOT NULL AND resolved_at < datetime('now', '-30 days')").run();
}

function getDeviceSummary() {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM devices').get().cnt;
  const online = db.prepare('SELECT COUNT(*) as cnt FROM devices WHERE is_online = 1').get().cnt;
  const activeAlerts = db.prepare(
    "SELECT COUNT(*) as cnt FROM alerts WHERE resolved_at IS NULL AND type != 'device_offline'"
  ).get().cnt;
  return { total, online, offline: total - online, activeAlerts };
}

export {
  registerDevice,
  getAllDevices,
  publicDevice,
  getDevice,
  getDeviceByKey,
  updateDeviceMeta,
  setThresholds,
  getThresholds,
  removeDevice,
  recordMetrics,
  getMetrics,
  getLatestMetrics,
  checkOfflineDevices,
  getOfflineDevices,
  getActiveAlerts,
  getAlert,
  resolveAlert,
  getDeviceSummary,
};
