// Auto-update DHM agenta z GitHub Releases.
// Wyłącznik: DHM_AUTO_UPDATE=0. Repo: DHM_UPDATE_REPO (default APOLL0PL/device-health-monitor).
// Integralność: tarball weryfikowany po sha256 z assetu <nazwa>.sha256
// (awaryjne obejście, świadomie i na własne ryzyko: DHM_UPDATE_SKIP_HASH=1).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPO = process.env.DHM_UPDATE_REPO || 'APOLL0PL/device-health-monitor';
const ASSET_NAME = 'dhm-agent.tar.gz';
const PM2_APP = process.env.DHM_PM2_NAME || 'dhm-agent';

export function localVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

export function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

async function fetchLatestRelease() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { 'User-Agent': 'dhm-agent', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  return res.json();
}

async function downloadAsset(assetUrl, destFile) {
  const res = await fetch(assetUrl, {
    headers: { 'User-Agent': 'dhm-agent', Accept: 'application/octet-stream' },
  });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  fs.writeFileSync(destFile, Buffer.from(await res.arrayBuffer()));
}

// Weryfikacja sha256 tarballa względem assetu <ASSET_NAME>.sha256 (format: "<hash>  <plik>").
function verifySha256(tarFile, expectedHash) {
  const actual = crypto.createHash('sha256').update(fs.readFileSync(tarFile)).digest('hex');
  if (actual !== String(expectedHash).trim().toLowerCase()) {
    throw new Error(`sha256 mismatch! oczekiwany ${expectedHash}, aktualny ${actual} - NIE instaluję.`);
  }
}

async function fetchAndVerifyTarball(asset, destDir) {
  const tarPath = path.join(destDir, ASSET_NAME);
  await downloadAsset(asset.url, tarPath);

  if (process.env.DHM_UPDATE_SKIP_HASH === '1') {
    console.warn('[update] UWAGA: pomijam weryfikację sha256 (DHM_UPDATE_SKIP_HASH=1)');
    return tarPath;
  }

  const hashAsset = (release.assets || []).find((a) => a.name === `${ASSET_NAME}.sha256`);
  if (!hashAsset) throw new Error(`brak assetu ${ASSET_NAME}.sha256 - nie da się zweryfikować pobieranego kodu`);
  const hashTmp = path.join(destDir, `${ASSET_NAME}.sha256`);
  await downloadAsset(hashAsset.url, hashTmp);
  // plik ma format "hash  nazwa" (jak wyjście sha256sum) - bierzemy pierwsze pole
  const expected = fs.readFileSync(hashTmp, 'utf8').trim().split(/\s+/)[0];
  verifySha256(tarPath, expected);
  return tarPath;
}

const COPY_SKIP = new Set(['node_modules', '.api_key', '.update-tmp']);

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (COPY_SKIP.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

export async function applyUpdate(release, log = console) {
  const asset = (release.assets || []).find((a) => a.name === ASSET_NAME);
  if (!asset) throw new Error(`brak assetu ${ASSET_NAME} w ${release.tag_name}`);

  const tmp = path.join(os.tmpdir(), `dhm-update-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    log.log(`[update] pobieram ${ASSET_NAME} (${release.tag_name})...`);
    const tarPath = await fetchAndVerifyTarball(release, tmp);
    // tarball ma pliki w korzeniu -> rozpakowujemy bezposrednio do tmp
    await pexec('tar', ['-xzf', path.basename(tarPath)], { cwd: tmp });

    // sanity: tarball musi zawierac index.js
    if (!fs.existsSync(path.join(tmp, 'index.js'))) throw new Error('zly tarball (brak index.js)');

    copyTree(tmp, __dirname);
    log.log('[update] pliki podmienione, npm install...');
    await pexec(process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: __dirname });

    log.log(`[update] restart pm2 (${PM2_APP})...`);
    const cmd = process.platform === 'win32' ? 'pm2.cmd' : 'pm2';
    const child = spawn(cmd, ['restart', PM2_APP], { detached: true, stdio: 'ignore' });
    child.unref();
    setTimeout(() => process.exit(0), 2000);
    return true;
  } finally {
    setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }, 15000);
  }
}

// Zwraca { update: bool, mine, latest, applied? }; rzuca wyjatkiem przy bledach sieciowych.
export async function checkForUpdate({ autoApply = false, log = console } = {}) {
  const mine = localVersion();
  const release = await fetchLatestRelease();
  const latest = release.tag_name;
  if (!mine || cmpVer(latest, mine) <= 0) {
    return { update: false, mine, latest };
  }
  log.log(`[update] dostepna nowa wersja: ${latest} (lokalna: ${mine})`);
  if (!autoApply) return { update: true, mine, latest };
  await applyUpdate(release, log);
  return { update: true, mine, latest, applied: true };
}

export function startAutoUpdate(log = console) {
  if (process.env.DHM_AUTO_UPDATE === '0') {
    log.log('[update] auto-update wylaczony (DHM_AUTO_UPDATE=0)');
    return;
  }
  const hours = Number(process.env.DHM_UPDATE_CHECK_H) || 24;
  const run = () => checkForUpdate({ autoApply: true, log }).catch((e) => log.error(`[update] ${e.message}`));
  setTimeout(run, 2 * 60 * 1000); // pierwszy check po 2 min od startu
  setInterval(run, hours * 3600 * 1000);
  log.log(`[update] auto-update aktywny (check co ${hours}h)`);
}
