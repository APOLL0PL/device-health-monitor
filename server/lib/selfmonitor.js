import os from 'node:os';
import si from 'systeminformation';
import { getDevice, getLatestMetrics, publicDevice, recordMetrics, registerDevice } from './store.js';

const INTERVAL = Number(process.env.SELF_REPORT_INTERVAL) || 60_000;
const DEVICE_NAME = process.env.SELF_DEVICE_NAME || os.hostname();

let selfDeviceId = null;

function isVirtualIface(name) {
  return /^(br-|veth|docker|virbr|zbr|tun|vpn|tap)/.test(name);
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
  if (Number.isFinite(temp.main) && temp.main > 0) return temp.main;
  const gfx = await si.graphics().catch(() => ({ controllers: [] }));
  const temps = (gfx.controllers || [])
    .map((c) => c.temperatureCore)
    .filter((t) => Number.isFinite(t) && t > 0);
  if (temps.length) return Math.max(...temps);
  return null;
}

async function getMetrics() {
  const [cpu, mem, disks, net, temperature] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    getNetworkTotals(),
    getTemperature(),
  ]);

  const mainDisk = disks.find((d) => d.mount === '/') || disks[0] || {};
  const homeDisk = disks.find((d) => d.mount === '/home') || {};
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
    temperature_c: temperature,
    uptime_seconds: Math.floor(os.uptime()),
    net_in_bytes: net.rx,
    net_out_bytes: net.tx,
  };
}

function ensureRegistered() {
  if (selfDeviceId) return;
  const dev = registerDevice(DEVICE_NAME, getLocalIp(), 'server', os.platform(), getMac());
  if (dev) selfDeviceId = dev.id;
}

async function report(broadcast) {
  try {
    ensureRegistered();
    if (!selfDeviceId) return; // sieć jeszcze nie gotowa - ponów w następnym cyklu
    const metrics = await getMetrics();
    recordMetrics(selfDeviceId, { ...metrics, ip: getLocalIp(), mac: getMac() });
    const device = getDevice(selfDeviceId);
    const latest = getLatestMetrics(selfDeviceId);
    if (typeof broadcast === 'function') {
      broadcast({ type: 'metrics', deviceId: selfDeviceId, metrics: latest, device: publicDevice(device) });
    }
  } catch (err) {
    console.error(`[self-monitor] ${err.message}`);
  }
}

function start(broadcast) {
  ensureRegistered();
  report(broadcast);
  return setInterval(() => report(broadcast), INTERVAL);
}

export { start };
