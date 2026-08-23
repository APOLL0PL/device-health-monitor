import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import si from 'systeminformation';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:4000';
const DEVICE_TYPE = process.env.DEVICE_TYPE || 'server';
const DEFAULT_INTERVAL_SECONDS = (DEVICE_TYPE === 'phone' || DEVICE_TYPE === 'android') ? 300 : 60;
const INTERVAL = (Number(process.env.REPORT_INTERVAL) || DEFAULT_INTERVAL_SECONDS) * 1000;
const DEVICE_NAME = process.env.DEVICE_NAME || os.hostname();
const DEVICE_GROUP = process.env.DEVICE_GROUP || '';
const REGISTER_TOKEN = process.env.REGISTER_TOKEN || '';

const KEY_FILE = path.join(__dirname, '.api_key');
const UUID_FILE = path.join(__dirname, '.device_uuid');

// Trwała tożsamość urządzenia: generowana raz, przetrwa zmiany IP/MAC/reinstalacje
// katalogu agenta (plik trzymany obok .api_key). Serwer rozpoznaje po niej urządzenie.
function ensureDeviceUuid() {
  try {
    const existing = fs.readFileSync(UUID_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const uuid = crypto.randomUUID();
  fs.writeFileSync(UUID_FILE, uuid);
  return uuid;
}
const DEVICE_UUID = ensureDeviceUuid();

import { startAutoUpdate } from './updater.mjs';
startAutoUpdate();

function isVirtualIface(name) {
  return /^(br-|veth|docker|virbr|zbr|tun|vpn|tap|wg)/.test(name);
}

const DISK_FS_SKIP = /^(tmpfs|devtmpfs|squashfs|overlay|efivarfs|bpf|cgroup|proc|sysfs|tracefs|debugfs|configfs|fusectl|hugetlbfs|mqueue|ramfs|iso9660)/;

async function getAllDisks(fsDisks) {
  return fsDisks
    .filter((d) => d.size >= 1073741824
      && !DISK_FS_SKIP.test(String(d.type || ''))
      && !DISK_FS_SKIP.test(String(d.fs || '')))
    .slice(0, 8)
    .map((d) => ({
      mount: d.mount,
      fs: d.type || d.fs,
      used_gb: Math.round((d.used / 1073741824) * 10) / 10,
      total_gb: Math.round((d.size / 1073741824) * 10) / 10,
    }));
}

function getLocalIp() {
  const nets = os.networkInterfaces();
  let lan = null;
  let fallback = null;
  for (const name of Object.keys(nets)) {
    if (isVirtualIface(name)) continue;
    for (const net of nets[name]) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (net.address.startsWith('192.168.')) return net.address;
      if (net.address.startsWith('10.') && !lan) lan = net.address;
      if (!fallback) fallback = net.address;
    }
  }
  return lan || fallback || '127.0.0.1';
}

function getMac() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    if (isVirtualIface(name)) continue;
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal && net.mac && net.mac !== '00:00:00:00:00:00') {
        return net.mac;
      }
    }
  }
  return null;
}

async function getNetworkTotals() {
  try {
    const ifaces = await si.networkInterfaces();
    const real = ifaces.filter((i) => !i.internal && i.iface);
    const results = await Promise.all(
      real.map((i) => si.networkStats(i.iface).catch(() => []))
    );
    let rx = 0;
    let tx = 0;
    for (const stats of results) {
      for (const n of stats) {
        if (Number.isFinite(n.rx_bytes)) rx += n.rx_bytes;
        if (Number.isFinite(n.tx_bytes)) tx += n.tx_bytes;
      }
    }
    return { rx, tx };
  } catch {
    return { rx: 0, tx: 0 };
  }
}

async function getTemperature() {
  const temp = await si.cpuTemperature().catch(() => ({ main: null }));
  if (Number.isFinite(temp.main) && temp.main > 0) return { v: temp.main, src: 'cpu' };
  const nv = await nvidiaSmiTemp();
  if (nv !== null) return { v: nv, src: 'gpu' };
  const gfx = await si.graphics().catch(() => ({ controllers: [] }));
  const temps = (gfx.controllers || [])
    .map((c) => c.temperatureCore)
    .filter((t) => Number.isFinite(t) && t > 0);
  if (temps.length) return { v: Math.max(...temps), src: 'gpu' };
  return { v: null, src: null };
}

// GPU temp z nvidia-smi - dziala bez admina, ratuje maszyny gdzie ACPI
// nie wystawia temperatury CPU (czeste na Windows; pm2/SSH czesto tez nie
// ma dostepu do MSAcpi_ThermalZoneTemperature).
function nvidiaSmiTemp() {
  return new Promise((resolve) => {
    const exe = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe')
      : 'nvidia-smi';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const c = spawn(exe, ['--query-gpu=temperature.gpu', '--format=csv,noheader,nounits'], { timeout: 5000 });
      let out = '';
      c.stdout?.on('data', (d) => (out += d));
      c.on('error', () => finish(null));
      c.on('close', () => {
        const v = Number(String(out).trim().split(/\r?\n/)[0]);
        finish(Number.isFinite(v) && v > 0 && v < 120 ? v : null);
      });
    } catch {
      finish(null);
    }
  });
}

async function getBattery() {
  try {
    const b = await si.battery();
    if (!b || !b.hasBattery || !Number.isFinite(b.percent)) return null;
    return { percent: b.percent, charging: b.isCharging ? 1 : 0 };
  } catch {
    return null;
  }
}

async function getMetrics() {
  const [cpu, mem, disks, net, temperature, battery] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    getNetworkTotals(),
    getTemperature(),
    getBattery(),
  ]);

  const isWin = os.platform() === 'win32';
  const mainDisk = isWin
    ? disks.find((d) => d.mount && d.mount.match(/^[A-Z]:\\?$/i)) || disks[0] || {}
    : disks.find((d) => d.mount === '/') || disks[0] || {};
  const homeDisk = isWin ? {} : (disks.find((d) => d.mount === '/home') || {});
  const totalUsed = (mainDisk.used || 0) + (homeDisk.used || 0);
  const totalSize = (mainDisk.size || 0) + (homeDisk.size || 0);

  return {
    cpu_percent: Math.round(cpu.currentLoad * 10) / 10,
    ram_used_mb: Math.round((mem.active || mem.used) / 1024 / 1024),
    ram_cache_mb: Math.round(((mem.buffers || 0) + (mem.cached || 0)) / 1024 / 1024),
    ram_total_mb: Math.round(mem.total / 1024 / 1024),
    disk_used_gb: Math.round(totalUsed / 1024 / 1024 / 1024 * 10) / 10,
    disk_total_gb: Math.round(totalSize / 1024 / 1024 / 1024 * 10) / 10,
    disk_sys_used_gb: Math.round((mainDisk.used || 0) / 1024 / 1024 / 1024 * 10) / 10,
    disk_sys_total_gb: Math.round((mainDisk.size || 0) / 1024 / 1024 / 1024 * 10) / 10,
    temperature_c: temperature?.v ?? null,
    temperature_src: temperature?.src ?? null,
    uptime_seconds: Math.floor(os.uptime()),
    net_in_bytes: net.rx,
    net_out_bytes: net.tx,
    ...(battery ? { battery_percent: Math.round(battery.percent), battery_charging: battery.charging } : {}),
    disks: await getAllDisks(disks),
  };
}

async function register(apiKey) {
  const ip = getLocalIp();
  const mac = getMac();
  const res = await fetch(`${SERVER_URL}/api/agent/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: DEVICE_NAME,
      ip,
      type: DEVICE_TYPE,
      os_name: os.platform(),
      mac,
      group: DEVICE_GROUP,
      register_token: REGISTER_TOKEN,
      device_uuid: DEVICE_UUID,
    }),
  });
  const data = await res.json();
  if (data.api_key) {
    fs.writeFileSync(KEY_FILE, data.api_key);
    console.log(`Registered. API key saved.`);
  }
  return data.api_key || apiKey;
}

async function report(apiKey) {
  try {
    const metrics = await getMetrics();
    const res = await fetch(`${SERVER_URL}/api/agent/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
      },
      body: JSON.stringify({ ...metrics, ip: getLocalIp(), mac: getMac() }),
    });
    if (res.ok) {
      const d = metrics;
      console.log(`Reported: CPU ${d.cpu_percent}% | RAM ${d.ram_used_mb}/${d.ram_total_mb}MB | Disk ${d.disk_used_gb}/${d.disk_total_gb}GB | Temp ${d.temperature_c ?? 'n/a'}C | Net ↓ ${d.net_in_bytes} ↑ ${d.net_out_bytes}`);
    } else if (res.status === 403 || res.status === 401) {
      console.log('API key rejected, re-registering...');
      return await register(apiKey);
    }
  } catch (err) {
    console.error(`Report failed: ${err.message}`);
  }
  return apiKey;
}

async function main() {
  console.log(`DHM Agent — reporting to ${SERVER_URL}`);
  console.log(`Device: ${DEVICE_NAME} (${DEVICE_TYPE})`);

  let apiKey = fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf8').trim() : null;
  if (!apiKey) {
    if (getLocalIp() === '127.0.0.1') {
      console.log('Brak LAN IP - rejestracja odwleczona do nastepnego cyklu');
    } else {
      apiKey = await register(apiKey);
    }
  }

  await report(apiKey);
  setInterval(async () => {
    apiKey = await report(apiKey);
    if (!apiKey && getLocalIp() !== '127.0.0.1') apiKey = await register(apiKey);
  }, INTERVAL);
}

main().catch(console.error);
