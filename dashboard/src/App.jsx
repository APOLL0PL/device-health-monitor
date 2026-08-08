import { useState, useEffect, useCallback } from 'react';
import { Sun, Moon, MonitorDot, AlertTriangle, Percent, HardDrive } from 'lucide-react';
import DeviceCard from './components/DeviceCard';
import DeviceDetail from './components/DeviceDetail';
import AlertsPanel from './components/AlertsPanel';

const API = '';
const TOKEN = window.DHM_CONFIG?.token;

async function api(path) {
  const res = await fetch(`${API}${path}`);
  return res.json();
}

async function apiWrite(path, method, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { 'X-Auth-Token': TOKEN } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

export default function App() {
  const [devices, setDevices] = useState([]);
  const [summary, setSummary] = useState({ total: 0, online: 0, offline: 0, activeAlerts: 0 });
  const [selected, setSelected] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [dark, setDark] = useState(() => localStorage.getItem('theme') !== 'light');
  const [units, setUnits] = useState(() => localStorage.getItem('units') || 'pct');

  const fetchData = useCallback(async () => {
    const [devData, alertData] = await Promise.all([
      api('/api/devices'),
      api('/api/alerts'),
    ]);
    setDevices(devData.devices || []);
    setSummary(devData.summary || { total: 0, online: 0, offline: 0, activeAlerts: 0 });
    setAlerts(alertData.alerts || []);
  }, []);

  useEffect(() => {
    fetchData();
    const poll = setInterval(fetchData, 5000);

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${proto}://${window.location.hostname}:${window.location.port || '4000'}`;
    let ws;
    try {
      ws = new WebSocket(wsUrl);
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'summary') setSummary(msg.summary);
        if (msg.type === 'metrics' || msg.type === 'device_update') fetchData();
        if (msg.type === 'alerts') api('/api/alerts').then(d => setAlerts(d.alerts || []));
        if (msg.type === 'device_removed') fetchData();
      };
    } catch {}

    return () => { clearInterval(poll); ws?.close(); };
  }, [fetchData]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  }, [dark]);

  useEffect(() => {
    localStorage.setItem('units', units);
  }, [units]);

  const resolveAlert = async (id) => {
    await apiWrite(`/api/alerts/${id}/resolve`, 'POST');
    fetchData();
  };

  if (selected) {
    return (
      <div className="app">
        <header>
          <button className="btn-back" onClick={() => setSelected(null)}>
            <MonitorDot size={16} /> Wstecz
          </button>
          <h1>Device Health Monitor</h1>
          <button className="btn-theme" onClick={() => setDark(!dark)}>
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </header>
        <DeviceDetail deviceId={selected} api={api} />
      </div>
    );
  }

  return (
    <div className="app">
      <header>
        <h1><MonitorDot size={22} strokeWidth={1.5} /> Device Health Monitor</h1>
        <div className="header-right">
          <span className="summary-badge online">{summary.online}/{summary.total} online</span>
          {summary.offline > 0 && (
            <span className="summary-badge offline">
              <MonitorDot size={13} /> {summary.offline} offline
            </span>
          )}
          {summary.activeAlerts > 0 && (
            <span className="summary-badge alert">
              <AlertTriangle size={13} /> {summary.activeAlerts} alert{summary.activeAlerts > 1 ? 'y' : ''}
            </span>
          )}
          <button
            className="btn-theme"
            title="Przełącz jednostki: % / MB-GB"
            onClick={() => setUnits(units === 'pct' ? 'abs' : 'pct')}
          >
            {units === 'pct' ? <Percent size={16} /> : <HardDrive size={16} />}
          </button>
          <button className="btn-theme" onClick={() => setDark(!dark)}>
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </header>

      <div className="layout">
        <main className="device-grid">
          {devices.length === 0 && (
            <div className="empty-state">
              <p>Brak urzadzen.</p>
              <p>Uruchom agenta na urzadzeniu:</p>
              <code>SERVER_URL=http://&lt;server-IP&gt;:4000 DEVICE_NAME="My Laptop" node agent/index.js</code>
            </div>
          )}
          {devices.map((d) => (
            <DeviceCard key={d.id} device={d} units={units} onClick={() => setSelected(d.id)} />
          ))}
        </main>

        {(alerts.length > 0 || devices.some(d => !d.is_online)) && (
          <AlertsPanel alerts={alerts} offlineDevices={devices.filter(d => !d.is_online)} onResolve={resolveAlert} />
        )}
      </div>
    </div>
  );
}
