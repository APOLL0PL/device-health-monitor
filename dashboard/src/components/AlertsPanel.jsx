import { AlertTriangle, Check, MonitorDot } from 'lucide-react';

function timeAgo(dateStr) {
  if (!dateStr) return 'nigdy';
  const diff = (Date.now() - new Date(dateStr + 'Z').getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s temu`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m temu`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h temu`;
  return `${Math.floor(diff / 86400)}d temu`;
}

export default function AlertsPanel({ alerts, offlineDevices, onResolve }) {
  const offline = offlineDevices || [];

  return (
    <aside className="alerts-panel">
      <h3><AlertTriangle size={16} /> Alerty ({alerts.length})</h3>
      <div className="alerts-list">
        {alerts.length === 0 && (
          <div className="alert-empty">Brak poważnych alertów — dobrze!</div>
        )}
        {alerts.map(a => (
          <div key={a.id} className={`alert-item ${a.severity}`}>
            <div className="alert-content">
              <span className="alert-type">{a.type.replace(/_/g, ' ')}</span>
              <span className="alert-msg">{a.message}</span>
              <span className="alert-time">{new Date(a.created_at + 'Z').toLocaleString('pl-PL')}</span>
            </div>
            <button className="btn-resolve" onClick={() => onResolve(a.id)}>
              <Check size={14} />
            </button>
          </div>
        ))}
      </div>

      <h3 className="offline-title"><MonitorDot size={16} /> Offline ({offline.length})</h3>
      <div className="alerts-list">
        {offline.length === 0 && (
          <div className="alert-empty">Wszystkie urządzenia online.</div>
        )}
        {offline.map(d => (
          <div key={d.id} className="offline-item">
            <span className="offline-name">{d.name}</span>
            <span className="offline-ip">{d.ip}</span>
            <span className="offline-time">ostatnio {timeAgo(d.last_seen)}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}
