import { useEffect, useState } from 'react';
import { Copy, Check, X } from 'lucide-react';
import { useT } from '../i18n.jsx';

const PLATFORMS = [
  { key: 'windows', label: 'Windows', hintKey: 'hintWindows' },
  { key: 'linux', label: 'Linux', hintKey: 'hintLinux' },
  { key: 'termux', label: 'Android (Termux)', hintKey: 'hintTermux' },
];

export default function AddDevicePanel({ onClose }) {
  const t = useT();
  const [setup, setSetup] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(null);

  useEffect(() => {
    fetch('/api/setup')
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => (ok ? setSetup(d) : setError(d.error || t('fetchError'))))
      .catch(() => setError(t('connError')));
  }, []);

  const copy = async (key, text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="add-device-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-header">
          <h2>{t('addDevice')}</h2>
          <button className="btn-icon cancel" onClick={onClose}><X size={16} /></button>
        </div>
        <p className="panel-hint">
          {t('panelHint')}
        </p>
        {error && <p className="panel-error">{error}</p>}
        {!setup && !error && <p className="panel-hint">{t('loading')}</p>}
        {setup && (
          <>
            {PLATFORMS.map((p) => (
              <div className="install-block" key={p.key}>
                <div className="install-label">
                  <strong>{p.label}</strong> <span>({t(p.hintKey)})</span>
                </div>
                <div className="install-cmd-row">
                  <code>{setup.install?.[p.key] || t('missing')}</code>
                  <button
                    className="btn-icon"
                    title={t('copy')}
                    onClick={() => copy(p.key, setup.install[p.key])}
                  >
                    {copied === p.key ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
              </div>
            ))}
            <p className="panel-hint">
              {t('panelFooter')}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
