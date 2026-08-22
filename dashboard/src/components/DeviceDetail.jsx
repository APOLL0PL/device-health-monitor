import { useState, useEffect } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { Clock, SlidersHorizontal } from 'lucide-react';
import { useT, useLang, localeOf } from '../i18n.jsx';

const DISK_COLORS = ['#a855f7', '#22c55e', '#3b82f6', '#f97316', '#eab308', '#ef4444', '#14b8a6', '#8b5cf6'];

const THRESHOLD_FIELDS = [
  ['disk_percent', t('thrDisk')],
  ['temperature_c', t('thrTemp')],
  ['cpu_percent', t('thrCpu')],
  ['cpu_duration_minutes', t('thrCpuMin')],
];

function ThresholdsPanel({ deviceId }) {
  const t = useT();
  const [values, setValues] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch(`/api/devices/${deviceId}`).then(r => r.json()).then(d => {
      setValues({
        disk_percent: d.thresholds?.disk_percent ?? '',
        temperature_c: d.thresholds?.temperature_c ?? '',
        cpu_percent: d.thresholds?.cpu_percent ?? '',
        cpu_duration_minutes: d.thresholds?.cpu_duration_minutes ?? '',
      });
    }).catch(() => {});
  }, [deviceId]);

  const save = async () => {
    await fetch(`/api/devices/${deviceId}/thresholds`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(window.DHM_CONFIG?.token ? { 'X-Auth-Token': window.DHM_CONFIG.token } : {}),
      },
      body: JSON.stringify(values),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (!values) return null;
  return (
    <div className="thresholds-panel">
      <h3><SlidersHorizontal size={12} /> {t('thresholds')}</h3>
      <div className="thresholds-row">
        {THRESHOLD_FIELDS.map(([key, label]) => (
          <label key={key} className="threshold-field">
            <span>{label}</span>
            <input
              type="number"
              value={values[key]}
              onChange={e => setValues({ ...values, [key]: e.target.value })}
              onKeyDown={e => e.key === 'Enter' && save()}
            />
          </label>
        ))}
        <button className="threshold-save" onClick={save}>{saved ? t('saved') : t('save')}</button>
      </div>
      <p className="thresholds-hint">{t('thrHint')}</p>
    </div>
  );
}

export default function DeviceDetail({ deviceId, api }) {
  const t = useT();
  const locale = localeOf(useLang());
  const [device, setDevice] = useState(null);
  const [metrics, setMetrics] = useState([]);
  const [diskSeries, setDiskSeries] = useState({});
  const [hours, setHours] = useState(24);

  useEffect(() => {
    api(`/api/devices/${deviceId}`).then(d => setDevice(d.device));
  }, [deviceId]);

  useEffect(() => {
    api(`/api/devices/${deviceId}/metrics?hours=${hours}`).then(d => {
      const rows = d.metrics || [];
      const data = rows.map((m, i) => {
        const prev = rows[i - 1];
        let net_in_rate = null;
        let net_out_rate = null;
        if (prev) {
          const dt = (new Date(m.timestamp + 'Z').getTime() - new Date(prev.timestamp + 'Z').getTime()) / 1000;
          if (dt > 0) {
            net_in_rate = (m.net_in_bytes - prev.net_in_bytes) / dt;
            net_out_rate = (m.net_out_bytes - prev.net_out_bytes) / dt;
          }
        }
        return {
          ...m,
          time: new Date(m.timestamp + 'Z').toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }),
          ram_pct: m.ram_total_mb > 0 ? Math.round((m.ram_used_mb / m.ram_total_mb) * 100) : 0,
          disk_pct: m.disk_total_gb > 0 ? Math.round((m.disk_used_gb / m.disk_total_gb) * 100) : 0,
          net_in_rate,
          net_out_rate,
        };
      });

      const diskSeries = {};
      for (const m of data) {
        let arr = [];
        try { arr = m.disks_json ? JSON.parse(m.disks_json) : []; } catch {}
        for (const d of arr) {
          (diskSeries[d.mount] ||= []).push({
            time: m.time,
            pct: d.total_gb > 0 ? Math.round((d.used_gb / d.total_gb) * 1000) / 10 : 0,
          });
        }
      }

      setMetrics(data);
      setDiskSeries(diskSeries);
    });
  }, [deviceId, hours]);

  if (!device) return <div className="loading">{t('loading')}</div>;

  return (
    <div className="device-detail">
      <div className="detail-header">
        <h2>{device.name}</h2>
        <span className="device-ip">{device.ip} · {device.type}</span>
        <div className="time-selector">
          {[1, 6, 24, 72, 168].map(h => (
            <button key={h} className={hours === h ? 'active' : ''} onClick={() => setHours(h)}>
              <Clock size={12} /> {h < 24 ? `${h}h` : `${h / 24}d`}
            </button>
          ))}
        </div>
      </div>

      <ThresholdsPanel deviceId={deviceId} />

      {device.last_disks?.length > 0 && (
        <div className="disks-panel">
          <h3>{t('disks')} ({device.last_disks.length})</h3>
          {device.last_disks.map((d) => {
            const pct = d.total_gb > 0 ? (d.used_gb / d.total_gb) * 100 : 0;
            const color = pct > 95 ? 'var(--crit)' : pct > 80 ? 'var(--warn)' : 'var(--ok)';
            return (
              <div key={d.mount} className="disk-row">
                <span className="disk-mount">{d.mount}</span>
                <span className="disk-fs">{d.fs}</span>
                <div className="gauge-bar">
                  <div className="gauge-fill" style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: color }} />
                </div>
                <span className="disk-cap">{d.used_gb} / {d.total_gb} GB ({Math.round(pct)}%)</span>
              </div>
            );
          })}
        </div>
      )}

      {metrics.length === 0 ? (
        <div className="empty-state">Brak danych — poczekaj na raport agenta</div>
      ) : (
        <div className="charts-grid">
          <ChartCard title="CPU %" data={metrics} dataKey="cpu_percent" color="#f97316" max={100} unit="%" />
          <ChartCard title="RAM %" data={metrics} dataKey="ram_pct" color="#3b82f6" max={100} unit="%" />
          <ChartCard title={t('chartDiskPct')} data={metrics} dataKey="disk_pct" color="#a855f7" max={100} unit="%" />
          <ChartCard title={t('chartTemperature')} data={metrics} dataKey="temperature_c" color="#ef4444" unit="°C" />
          <ChartCard title="RAM" data={metrics} dataKey="ram_used_mb" color="#3b82f6" unitMb />
          <ChartCard title={t('chartInternetDown')} data={metrics} dataKey="net_in_rate" color="#22c55e" rateBytes />
          <ChartCard title={t('chartInternetUp')} data={metrics} dataKey="net_out_rate" color="#eab308" rateBytes />
        </div>
      )}

      {Object.keys(diskSeries).length > 0 && (
        <div className="charts-grid">
          {Object.entries(diskSeries).map(([mount, series], i) => (
            <ChartCard
              key={mount}
              title={t('chartDiskMount', { mount })}
              data={series}
              dataKey="pct"
              id={`disk-${i}`}
              color={DISK_COLORS[i % DISK_COLORS.length]}
              max={100}
              unit="%"
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ChartCard({ title, data, dataKey, color, max, unit, formatBytes, rateBytes, unitMb, id }) {
  const formatValue = (v) => {
    if (v == null) return '—';
    if (rateBytes) {
      if (v > 1048576) return `${(v / 1048576).toFixed(2)} MB/s`;
      if (v > 1024) return `${(v / 1024).toFixed(1)} KB/s`;
      return `${v.toFixed(1)} B/s`;
    }
    if (unitMb) {
      if (v > 10240) return `${(v / 1024).toFixed(1)} GB`;
      return `${Math.round(v)} MB`;
    }
    if (formatBytes) {
      if (v > 1073741824) return `${(v / 1073741824).toFixed(1)} GB`;
      if (v > 1048576) return `${(v / 1048576).toFixed(1)} MB`;
      if (v > 1024) return `${(v / 1024).toFixed(1)} KB`;
      return `${v} B`;
    }
    return `${v}${unit || ''}`;
  };

  return (
    <div className="chart-card">
      <h3>{title}</h3>
      <ResponsiveContainer width="100%" height={180}>
        <AreaChart data={data}>
          <defs>
            <linearGradient id={`grad-${id || dataKey}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="time" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
          <YAxis domain={max ? [0, max] : undefined} tick={{ fontSize: 10 }} width={40} />
          <Tooltip formatter={(v) => formatValue(v)} labelStyle={{ color: '#888' }} />
          <Area type="monotone" dataKey={dataKey} stroke={color} fill={`url(#grad-${id || dataKey})`} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
