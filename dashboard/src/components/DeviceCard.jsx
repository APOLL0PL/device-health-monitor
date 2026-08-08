import { useState } from 'react';
import { Monitor, Terminal, Smartphone, Server, ThermometerSun, Pencil, Check, X, ArrowDown, ArrowUp } from 'lucide-react';

const API = '';
const TOKEN = window.DHM_CONFIG?.token;

function timeAgo(dateStr) {
  if (!dateStr) return 'nigdy';
  const diff = (Date.now() - new Date(dateStr + 'Z').getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s temu`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m temu`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h temu`;
  return `${Math.floor(diff / 86400)}d temu`;
}

function fmtBytes(v) {
  if (v == null) return '—';
  if (v > 1073741824) return `${(v / 1073741824).toFixed(1)} GB`;
  if (v > 1048576) return `${(v / 1048576).toFixed(1)} MB`;
  if (v > 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${v} B`;
}

function fmtMb(v) {
  if (v == null) return '—';
  if (v > 10240) return `${(v / 1024).toFixed(1)} GB`;
  return `${Math.round(v)} MB`;
}

function Gauge({ label, value, max, sub, warn, crit, display }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  let color = 'var(--ok)';
  if (warn && pct > warn) color = 'var(--warn)';
  if (crit && pct > crit) color = 'var(--crit)';
  if (pct > 90) color = 'var(--crit)';

  return (
    <div className="gauge">
      <div className="gauge-header">
        <span className="gauge-label">{label}</span>
        <span className="gauge-value" style={{ color }}>{display || (value != null ? `${Math.round(pct)}%` : '—')}</span>
      </div>
      <div className="gauge-bar">
        <div className="gauge-fill" style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: color }} />
      </div>
      {sub && <div className="gauge-sub">{sub}</div>}
    </div>
  );
}

const osIcons = {
  linux: Terminal,
  darwin: Monitor,
  win32: Monitor,
  android: Smartphone,
  ios: Smartphone,
};

export default function DeviceCard({ device, units, onClick }) {
  const [editing, setEditing] = useState(false);
  const [nameVal, setNameVal] = useState(device.name);
  const Icon = osIcons[device.os_name] || Server;
  const tempColor = device.last_temp != null
    ? (device.last_temp > 80 ? 'var(--crit)' : device.last_temp > 70 ? 'var(--warn)' : 'var(--text2)')
    : 'var(--text2)';
  const abs = units === 'abs';

  const saveName = async (e) => {
    e.stopPropagation();
    if (nameVal.trim() && nameVal !== device.name) {
      await fetch(`${API}/api/devices/${device.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(TOKEN ? { 'X-Auth-Token': TOKEN } : {}),
        },
        body: JSON.stringify({ name: nameVal.trim() }),
      });
    }
    setEditing(false);
  };

  return (
    <div className={`device-card ${device.is_online ? 'online' : 'offline'}`} onClick={onClick}>
      <div className="card-header">
        <div className="device-icon-wrap">
          <Icon size={22} strokeWidth={1.5} />
        </div>
        <div className="device-info">
          {editing ? (
            <div className="name-edit" onClick={e => e.stopPropagation()}>
              <input
                autoFocus
                value={nameVal}
                onChange={e => setNameVal(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveName(e)}
                className="name-input"
              />
              <button className="btn-icon save" onClick={saveName}><Check size={14} /></button>
              <button className="btn-icon cancel" onClick={() => { setNameVal(device.name); setEditing(false); }}><X size={14} /></button>
            </div>
          ) : (
            <div className="device-name-row">
              <span className="device-name">{device.name}</span>
              <button className="btn-icon edit" onClick={e => { e.stopPropagation(); setEditing(true); }}><Pencil size={12} /></button>
            </div>
          )}
          <div className="device-ip">{device.ip}</div>
        </div>
        <span className={`status-dot ${device.is_online ? 'online' : 'offline'}`} />
      </div>
      {device.is_online ? (
        <div className="card-metrics">
          <Gauge label="CPU" value={device.last_cpu} max={100} warn={70} crit={90} />
          <Gauge
            label="RAM"
            value={device.last_ram_used}
            max={device.last_ram_total}
            display={abs
              ? `${device.last_ram_used != null ? fmtMb(device.last_ram_used) : '—'} / ${device.last_ram_total != null ? fmtMb(device.last_ram_total) : '—'}`
              : null}
            sub={device.last_ram_used != null && device.last_ram_total != null
              ? `${fmtMb(device.last_ram_used)} / ${fmtMb(device.last_ram_total)}`
              : null}
            warn={75}
            crit={90}
          />
          {device.last_ram_cache > 0 && (
            <div className="cache-info">Cache: {fmtMb(device.last_ram_cache)}</div>
          )}
          <div className="disk-boxes">
            <Gauge
              label="Dysk — zajętość"
              value={device.last_disk_used}
              max={device.last_disk_total}
              display={abs
                ? `${device.last_disk_used != null ? device.last_disk_used : '—'} / ${device.last_disk_total != null ? device.last_disk_total : '—'} GB`
                : null}
              warn={80}
              crit={95}
            />
            <div className="disk-usage">
              <div className="disk-usage-title">Dysk — użycie</div>
              <div className="disk-usage-value">
                {device.last_disk_used != null ? `${device.last_disk_used} GB` : '—'}
              </div>
              <div className="disk-usage-total">
                z {device.last_disk_total != null ? `${device.last_disk_total} GB` : '—'}
              </div>
              {device.last_disk_sys_used != null && device.last_disk_sys_total > 0 && (
                <div className="disk-usage-sys">sys: {device.last_disk_sys_used} / {device.last_disk_sys_total} GB</div>
              )}
            </div>
          </div>
          {device.last_temp != null && (
            <div className="temp-badge" style={{ color: tempColor }}>
              <ThermometerSun size={14} strokeWidth={1.5} /> {device.last_temp}°C
            </div>
          )}
          {(device.last_net_in != null || device.last_net_out != null) && (
            <div className="net-row">
              <span className="net-in"><ArrowDown size={12} /> {fmtBytes(device.last_net_in)}</span>
              <span className="net-out"><ArrowUp size={12} /> {fmtBytes(device.last_net_out)}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="offline-msg">Offline — ostatnio {timeAgo(device.last_seen)}</div>
      )}
    </div>
  );
}
