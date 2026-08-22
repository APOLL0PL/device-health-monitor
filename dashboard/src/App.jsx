import { useState, useEffect, useCallback } from 'react';
import { Sun, Moon, MonitorDot, AlertTriangle, Percent, HardDrive, Plus } from 'lucide-react';
import DeviceCard from './components/DeviceCard';
import DeviceDetail from './components/DeviceDetail';
import AlertsPanel from './components/AlertsPanel';
import AddDevicePanel from './components/AddDevicePanel';
import { LangProvider, useT } from './i18n.jsx';

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

const parseHash = () => {
  const m = window.location.hash.match(/^#\/device\/(\d+)$/);
  return m ? Number(m[1]) : null;
};

export default function App() {
  const [devices, setDevices] = useState([]);
  const [summary, setSummary] = useState({ total: 0, online: 0, offline: 0, activeAlerts: 0 });
  const [selected, setSelected] = useState(parseHash);
  const [alerts, setAlerts] = useState([]);
  const [dark, setDark] = useState(() => localStorage.getItem('theme') !== 'light');
  const [units, setUnits] = useState(() => localStorage.getItem('units') || 'pct');
  const [showAdd, setShowAdd] = useState(false);
  const [groupFilter, setGroupFilter] = useState('');
  const [lang, setLang] = useState(() => localStorage.getItem('lang') || 'pl');
  const t = useT();

  const fetchData = useCallback(async () => {
    const [devData, alertData] = await Promise.all([
      api('/api/devices'),
      api('/api/alerts'),
    ]);
    setDevices(devData.devices || []);
    setSummary(devData.summary || { total: 0, online: 0, offline: 0, activeAlerts: 0 });
    setAlerts(alertData.alerts || []);
  }, []);

  const openDevice = useCallback((id) => {
    setSelected(id);
    window.location.hash = `#/device/${id}`;
  }, []);

  const closeDevice = useCallback(() => {
    if (window.location.hash.startsWith('#/device/')) {
      window.history.back();
    } else {
      setSelected(null);
    }
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

  useEffect(() => {
    const sync = () => setSelected(parseHash());
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    const onKey = (e) => { if (e.key === 'Escape') closeDevice(); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('keydown', onKey);
    };
  }, [closeDevice]);

  const resolveAlert = async (id) => {
    await apiWrite(`/api/alerts/${id}/resolve`, 'POST');
    fetchData();
  };

  useEffect(() => {
    localStorage.setItem('lang', lang);
    document.documentElement.setAttribute('lang', lang === 'en' ? 'en' : 'pl');
  }, [lang]);

  const toggleLang = () => setLang(l => (l === 'pl' ? 'en' : 'pl'));

  if (selected) {
    return (
      <LangProvider lang={lang}>
        <div className="app">
          <header>
            <button className="btn-back" onClick={closeDevice}>
              <MonitorDot size={16} /> {t("back")}
            </button>
            <h1>Device Health Monitor</h1>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-theme btn-lang" onClick={toggleLang}>{lang === 'pl' ? 'EN' : 'PL'}</button>
              <button className="btn-theme" onClick={() => setDark(!dark)}>
                {dark ? <Sun size={18} /> : <Moon size={18} />}
              </button>
            </div>
          </header>
          <DeviceDetail deviceId={selected} api={api} />
        </div>
      </LangProvider>
    );
  }

  return (
    <LangProvider lang={lang}>
      <div className="app">
        <header>
          <h1><MonitorDot size={22} strokeWidth={1.5} /> Device Health Monitor</h1>
          <div className="header-right">
            <span className="summary-badge online">{summary.online}/{summary.total} {t("online")}</span>
            {summary.offline > 0 && (
              <span className="summary-badge offline">
                <MonitorDot size={13} /> {summary.offline} {t("offline")}
              </span>
            )}
            {summary.activeAlerts > 0 && (
              <span className="summary-badge alert">
                <AlertTriangle size={13} /> {summary.activeAlerts}
              </span>
            )}
            <button
              className="btn-add"
              title={t('addDevice')}
              onClick={() => setShowAdd(true)}
            >
              <Plus size={16} /> {t("addDevice")}
            </button>
            <button
              className="btn-theme"
              title="% / MB-GB"
              onClick={() => setUnits(units === 'pct' ? 'abs' : 'pct')}
            >
              {units === 'pct' ? <Percent size={16} /> : <HardDrive size={16} />}
            </button>
            <button className="btn-theme btn-lang" onClick={toggleLang}>{lang === 'pl' ? 'EN' : 'PL'}</button>
            <button className="btn-theme" onClick={() => setDark(!dark)}>
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </div>
        </header>

      {(() => {
        const groups = [...new Set(devices.map(d => d.grp).filter(Boolean))];
        if (groups.length === 0) return null;
        return (
          <div className="group-filter">
            <button className={`group-chip-btn ${groupFilter === '' ? 'active' : ''}`} onClick={() => setGroupFilter('')}>
              {t('all')} ({devices.length})
            </button>
            {groups.map(g => (
              <button key={g} className={`group-chip-btn ${groupFilter === g ? 'active' : ''}`} onClick={() => setGroupFilter(groupFilter === g ? '' : g)}>
                {g} ({devices.filter(d => d.grp === g).length})
              </button>
            ))}
          </div>
        );
      })()}

      <div className="layout">
        <main className="device-grid">
          {showAdd && <AddDevicePanel onClose={() => setShowAdd(false)} />}
          {devices.length === 0 && (
            <div className="empty-state">
              <p>{t('noDevices')}</p>
              <p>{t('emptyHint')}</p>
            </div>
          )}
          {devices
            .filter(d => !groupFilter || d.grp === groupFilter)
            .map((d) => (
            <DeviceCard key={d.id} device={d} units={units} onClick={() => openDevice(d.id)} />
          ))}
        </main>

        {(alerts.length > 0 || devices.some(d => !d.is_online)) && (
          <AlertsPanel alerts={alerts} offlineDevices={devices.filter(d => !d.is_online)} onResolve={resolveAlert} />
        )}
      </div>
    </div>
    </LangProvider>
  );
}
