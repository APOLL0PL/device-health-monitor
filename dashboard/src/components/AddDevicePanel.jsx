import { useEffect, useState } from 'react';
import { Copy, Check, X } from 'lucide-react';

const PLATFORMS = [
  { key: 'windows', label: 'Windows', hint: 'cmd jako Administrator' },
  { key: 'linux', label: 'Linux', hint: 'bash' },
  { key: 'termux', label: 'Android (Termux)', hint: 'apka Termux' },
];

export default function AddDevicePanel({ onClose }) {
  const [setup, setSetup] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(null);

  useEffect(() => {
    fetch('/api/setup')
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => (ok ? setSetup(d) : setError(d.error || 'Błąd pobierania')))
      .catch(() => setError('Brak połączenia z serwerem'));
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
          <h2>Dodaj urządzenie</h2>
          <button className="btn-icon cancel" onClick={onClose}><X size={16} /></button>
        </div>
        <p className="panel-hint">
          Skopiuj komendę i odpal na nowym urządzeniu. Adres i token są już w środku.
        </p>
        {error && <p className="panel-error">{error}</p>}
        {!setup && !error && <p className="panel-hint">Ładowanie…</p>}
        {setup && (
          <>
            {PLATFORMS.map((p) => (
              <div className="install-block" key={p.key}>
                <div className="install-label">
                  <strong>{p.label}</strong> <span>({p.hint})</span>
                </div>
                <div className="install-cmd-row">
                  <code>{setup.install?.[p.key] || 'brak'}</code>
                  <button
                    className="btn-icon"
                    title="Kopiuj"
                    onClick={() => copy(p.key, setup.install[p.key])}
                  >
                    {copied === p.key ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
              </div>
            ))}
            <p className="panel-hint">
              Urządzenie pojawi się na karcie do ~minuty po instalacji.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
