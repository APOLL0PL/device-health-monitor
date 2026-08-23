import { createContext, useContext } from 'react';

export const STRINGS = {
  pl: {
    back: 'Wstecz',
    phName: 'nazwa urządzenia',
    phGroup: 'grupa',
    addDevice: 'Dodaj urządzenie',
    online: 'online',
    offline: 'offline',
    alerts: 'Alerty',
    offlineTitle: 'Offline',
    noAlerts: 'Brak poważnych alertów — dobrze!',
    allOnline: 'Wszystkie urządzenia online.',
    lastSeen: 'ostatnio',
    never: 'nigdy',
    agoS: 's temu',
    agoM: 'm temu',
    agoH: 'h temu',
    agoD: 'd temu',
    noDevices: 'Brak urzadzen.',
    emptyHint: 'Kliknij „Dodaj urządzenie” w prawym górnym rogu - dostaniesz gotową komendę z adresem i tokenem.',
    all: 'Wszystkie',
    diskOccupancy: 'Dysk — zajętość',
    diskUsage: 'Dysk — użycie',
    cache: 'Cache:',
    offlineSince: 'Offline — ostatnio',
    loading: 'Ładowanie...',
    disks: 'Dyski',
    chartDiskPct: 'Dysk %',
    chartDiskMount: 'Dysk {mount} %',
    chartTemperature: 'Temperatura',
    chartInternetDown: 'Internet ↓',
    chartInternetUp: 'Internet ↑',
    thresholds: 'Progi alertów',
    save: 'Zapisz',
    saved: 'Zapisano ✓',
    thrHint: 'Puste pole = wartość domyślna (dysk 90%, temp 70°C, CPU 90%/5 min)',
    thrDisk: 'Dysk %',
    thrTemp: 'Temp °C',
    thrCpu: 'CPU %',
    thrCpuMin: 'CPU min',
    panelHint: 'Skopiuj komendę i odpal na nowym urządzeniu. Adres i token są już w środku.',
    panelFooter: 'Urządzenie pojawi się na karcie do ~minuty po instalacji.',
    copy: 'Kopiuj',
    missing: 'brak',
    fetchError: 'Błąd pobierania',
    connError: 'Brak połączenia z serwerem',
    hintWindows: 'cmd jako Administrator',
    hintLinux: 'bash',
    hintTermux: 'apka Termux',
    loginPrompt: 'Ten dashboard jest chroniony hasłem.',
    phPassword: 'hasło',
    signIn: 'Zaloguj',
    loginFailed: 'Błędne hasło',
    logout: 'Wyloguj',
  },
  en: {
    back: 'Back',
    phName: 'device name',
    phGroup: 'group',
    addDevice: 'Add device',
    online: 'online',
    offline: 'offline',
    alerts: 'Alerts',
    offlineTitle: 'Offline',
    noAlerts: 'No serious alerts — looking good!',
    allOnline: 'All devices are online.',
    lastSeen: 'last seen',
    never: 'never',
    agoS: 's ago',
    agoM: 'm ago',
    agoH: 'h ago',
    agoD: 'd ago',
    noDevices: 'No devices yet.',
    emptyHint: 'Click "Add device" in the top right corner - you will get a ready-made command with the address and token included.',
    all: 'All',
    diskOccupancy: 'Disk — usage',
    diskUsage: 'Disk — used',
    cache: 'Cache:',
    offlineSince: 'Offline — last seen',
    loading: 'Loading...',
    disks: 'Disks',
    chartDiskPct: 'Disk %',
    chartDiskMount: 'Disk {mount} %',
    chartTemperature: 'Temperature',
    chartInternetDown: 'Internet ↓',
    chartInternetUp: 'Internet ↑',
    thresholds: 'Alert thresholds',
    save: 'Save',
    saved: 'Saved ✓',
    thrHint: 'Empty field = default value (disk 90%, temp 70°C, CPU 90%/5 min)',
    thrDisk: 'Disk %',
    thrTemp: 'Temp °C',
    thrCpu: 'CPU %',
    thrCpuMin: 'CPU min',
    panelHint: 'Copy the command and run it on the new device. The address and token are already inside.',
    panelFooter: 'The device will appear on the dashboard within ~a minute after installation.',
    copy: 'Copy',
    missing: 'missing',
    fetchError: 'Fetch failed',
    connError: 'Cannot reach the server',
    hintWindows: 'cmd as Administrator',
    hintLinux: 'bash',
    hintTermux: 'Termux app',
    loginPrompt: 'This dashboard is password protected.',
    phPassword: 'password',
    signIn: 'Sign in',
    loginFailed: 'Wrong password',
    logout: 'Log out',
  },
};

const LangContext = createContext('pl');

export function LangProvider({ lang, children }) {
  return <LangContext.Provider value={lang}>{children}</LangContext.Provider>;
}

// t z konkretnego jezyka - dla komponentow NAD providerem (App)
export function makeT(lang) {
  const dict = STRINGS[lang] || STRINGS.pl;
  return (key, params = {}) =>
    String(dict[key] ?? STRINGS.pl[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => params[k] ?? `{${k}}`);
}

// zwraca funkcje t(key, params) - params np. { mount: '/' }
export function useT() {
  return makeT(useContext(LangContext));
}

export function useLang() {
  return useContext(LangContext);
}

export function localeOf(lang) {
  return lang === 'en' ? 'en-GB' : 'pl-PL';
}
