const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(process.env.DB_PATH || path.join(__dirname, 'data.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    ip TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL DEFAULT 'unknown',
    api_key TEXT NOT NULL UNIQUE,
    last_seen DATETIME,
    is_online INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    timestamp DATETIME NOT NULL DEFAULT (datetime('now')),
    cpu_percent REAL,
    ram_used_mb INTEGER,
    ram_total_mb INTEGER,
    ram_cache_mb INTEGER DEFAULT 0,
    disk_used_gb REAL,
    disk_total_gb REAL,
    disk_sys_used_gb REAL,
    disk_sys_total_gb REAL,
    temperature_c REAL,
    uptime_seconds INTEGER,
    net_in_bytes INTEGER,
    net_out_bytes INTEGER,
    FOREIGN KEY (device_id) REFERENCES devices(id)
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'warning',
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    resolved_at DATETIME,
    FOREIGN KEY (device_id) REFERENCES devices(id)
  );

  CREATE INDEX IF NOT EXISTS idx_metrics_device_time ON metrics(device_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts(resolved_at);
`);

try { db.exec("ALTER TABLE devices ADD COLUMN os_name TEXT DEFAULT 'unknown'"); } catch {}
try { db.exec("ALTER TABLE devices ADD COLUMN mac TEXT"); } catch {}
try { db.exec("ALTER TABLE metrics ADD COLUMN ram_cache_mb INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE metrics ADD COLUMN disk_sys_used_gb REAL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE metrics ADD COLUMN disk_sys_total_gb REAL DEFAULT 0"); } catch {}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_mac ON devices(mac) WHERE mac IS NOT NULL");
try { db.exec("ALTER TABLE alerts ADD COLUMN type TEXT NOT NULL DEFAULT 'threshold'"); } catch {}
db.exec("DELETE FROM alerts WHERE type = 'device_offline'");

module.exports = db;
