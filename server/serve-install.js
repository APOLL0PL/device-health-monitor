// DHM — prosty serwer plików instalacyjnych (LAN).
// Serwuje tylko białą listę plików: tarball agenta + skrypt Termuxa.
//
//   DHM_INSTALL_DIR  katalog z plikami  (domyślnie /mnt/storage/media/DHM)
//   DHM_SERVE_PORT   port               (domyślnie 9999)
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.DHM_INSTALL_DIR || '/mnt/storage/media/DHM';
const PORT = Number(process.env.DHM_SERVE_PORT) || 9999;

const FILES = {
  '/dhm-agent.tar.gz': path.join(ROOT, 'dhm-agent.tar.gz'),
  '/dhm-bundle.tar.gz': path.join(ROOT, 'dhm-bundle.tar.gz'),
  '/setup-termux.sh': path.join(ROOT, 'setup-termux.sh'),
  '/serwer.sh': path.join(ROOT, 'serwer.sh'),
  '/user-win.bat': path.join(ROOT, 'user-win.bat'),
  '/user-linux.sh': path.join(ROOT, 'user-linux.sh'),
  '/uninstall-win.bat': path.join(ROOT, 'uninstall-win.bat'),
  '/uninstall-linux.sh': path.join(ROOT, 'uninstall-linux.sh'),
};

http
  .createServer((req, res) => {
    const file = FILES[req.url.split('?')[0]];
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': file.endsWith('.tar.gz') ? 'application/gzip' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, '0.0.0.0', () => {
    console.log(`DHM install files on http://0.0.0.0:${PORT}`);
  });
