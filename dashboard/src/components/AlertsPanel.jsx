import { AlertTriangle, Check, MonitorDot } from 'lucide-react';
import { useT, useLang, localeOf } from '../i18n.jsx';

function timeAgo(dateStr, t) {
  if (!dateStr) return t('never');
  const diff = Math.max(0, (Date.now() - new Date(dateStr + 'Z').getTime()) / 1000);
  if (diff < 60) return `${Math.floor(diff)}${t('agoS')}`;
  if (diff < 3600) return `${Math.floor(diff / 60)}${t('agoM')}`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}${t('agoH')}`;
  return `${Math.floor(diff / 86400)}${t('agoD')}`;
}

export default function AlertsPanel({ alerts, offlineDevices, onResolve }) {
  const t = useT();
  const locale = localeOf(useLang());
  const offline = offlineDevices || [];

  return (
    <aside className="alerts-panel">
      <h3><AlertTriangle size={16} /> {t('alerts')} ({alerts.length})</h3>
      <div className="alerts-list">
        {alerts.length === 0 && (
          <div className="alert-empty">{t('noAlerts')}</div>
        )}
        {alerts.map(a => (
          <div key={a.id} className={`alert-item ${a.severity}`}>
            <div className="alert-content">
              <span className="alert-type">{a.type.replace(/_/g, ' ')}</span>
              <span className="alert-msg">{a.message}</span>
              <span className="alert-time">{new Date(a.created_at + 'Z').toLocaleString(locale)}</span>
            </div>
            <button className="btn-resolve" onClick={() => onResolve(a.id)}>
              <Check size={14} />
            </button>
          </div>
        ))}
      </div>

      <h3 className="offline-title"><MonitorDot size={16} /> {t('offlineTitle')} ({offline.length})</h3>
      <div className="alerts-list">
        {offline.length === 0 && (
          <div className="alert-empty">{t('allOnline')}</div>
        )}
        {offline.map(d => (
          <div key={d.id} className="offline-item">
            <span className="offline-name">{d.name}</span>
            <span className="offline-ip">{d.ip}</span>
            <span className="offline-time">{t('lastSeen')} {timeAgo(d.last_seen, t)}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}
