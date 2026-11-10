// Wecord — processo principal do Electron
const { app, BrowserWindow, session, desktopCapturer, ipcMain, shell, Menu, systemPreferences } = require('electron');
const path = require('path');

// Toca áudio/vídeo sem exigir clique (necessário para ouvir quem entra na chamada)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Não reduzir desempenho quando a janela está minimizada/escondida
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

if (process.platform === 'win32') app.setAppUserModelId('com.wecord.app');

let win = null;
let pendingSelection = null; // { id, audio } escolhido no seletor do app

// --profile=nome abre uma instância separada (útil para testar duas pessoas no mesmo PC)
const profileArg = process.argv.find((a) => a.startsWith('--profile='));
const profile = profileArg ? profileArg.split('=')[1].replace(/[^\w-]/g, '') : '';
if (profile) app.setPath('userData', app.getPath('userData') + '-' + profile);

if (!profile && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 580,
    show: false,
    backgroundColor: '#0e1014',
    title: 'Wecord',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Links externos abrem no navegador padrão
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
  // F12 / Ctrl+Shift+I abre as ferramentas de diagnóstico
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      win.webContents.toggleDevTools();
    }
  });
  win.on('closed', () => { win = null; });
}

function setupPermissions() {
  const ses = session.defaultSession;
  const allowed = new Set(['media', 'display-capture', 'notifications', 'fullscreen', 'clipboard-sanitized-write', 'speaker-selection', 'screen-wake-lock']);
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission) || permission === 'media');

  // getDisplayMedia() no app usa a fonte escolhida no nosso seletor (com miniaturas)
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sel = pendingSelection;
    pendingSelection = null;
    try {
      if (!sel) return callback(null);
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find((s) => s.id === sel.id);
      if (!source) return callback(null);
      const streams = { video: source };
      if (sel.audio && process.platform === 'win32') streams.audio = 'loopback';
      callback(streams);
    } catch (err) {
      console.error('display media', err);
      callback(null);
    }
  }, { useSystemPicker: false });
}

ipcMain.handle('wecord:get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 480, height: 270 },
    fetchWindowIcons: true,
  });
  const screens = sources.filter((s) => s.id.startsWith('screen:'));
  const toItem = (s, name) => ({
    id: s.id,
    type: s.id.startsWith('screen:') ? 'screen' : 'window',
    name,
    thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
    icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
  });
  return [
    ...screens.map((s, i) => toItem(s, screens.length > 1 ? `Tela ${i + 1}` : 'Tela inteira')),
    ...sources.filter((s) => !s.id.startsWith('screen:') && s.name && s.name !== 'Wecord').map((s) => toItem(s, s.name)),
  ];
});

ipcMain.handle('wecord:select-source', (_e, sel) => {
  pendingSelection = sel && typeof sel.id === 'string' ? { id: sel.id, audio: !!sel.audio } : null;
  return true;
});

ipcMain.handle('wecord:info', () => ({ version: app.getVersion(), platform: process.platform }));

// ---------- Atualização automática (GitHub Releases) ----------
// Só no app instalado (NSIS). O portátil e o modo desenvolvimento não se atualizam.
let updateState = { status: 'idle' };
let autoUpdater = null;
const canAutoUpdate = app.isPackaged && process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_DIR;

function sendUpdate(patch) {
  updateState = { ...updateState, ...patch };
  if (win && !win.isDestroyed()) win.webContents.send('wecord:update', updateState);
}

function setupUpdater() {
  if (!canAutoUpdate) return;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.error('electron-updater indisponível', err);
    return;
  }
  autoUpdater.autoDownload = true;          // baixa em segundo plano
  autoUpdater.autoInstallOnAppQuit = true;  // se não reiniciar agora, instala ao fechar
  autoUpdater.on('update-available', (i) => sendUpdate({ status: 'downloading', version: i.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => sendUpdate({ status: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (i) => sendUpdate({ status: 'ready', version: i.version }));
  autoUpdater.on('update-not-available', () => sendUpdate({ status: 'idle' }));
  autoUpdater.on('error', (err) => { console.error('update', err && err.message); if (updateState.status !== 'ready') sendUpdate({ status: 'idle' }); });
  const check = () => { if (updateState.status === 'idle') autoUpdater.checkForUpdates().catch(() => {}); };
  setTimeout(check, 4000);
  setInterval(check, 4 * 60 * 60 * 1000); // a cada 4 h, para quem deixa o app aberto
}

ipcMain.handle('wecord:update-state', () => updateState);
ipcMain.handle('wecord:update-install', () => {
  if (autoUpdater && updateState.status === 'ready') {
    setImmediate(() => autoUpdater.quitAndInstall(true, true)); // silencioso e reabre em seguida
    return true;
  }
  return false;
});

ipcMain.handle('wecord:flash', () => {
  if (win && !win.isFocused()) win.flashFrame(true);
});

app.whenReady().then(async () => {
  setupPermissions();
  if (process.platform === 'darwin') {
    try {
      await systemPreferences.askForMediaAccess('microphone');
      await systemPreferences.askForMediaAccess('camera');
    } catch { /* ignore */ }
  }
  createWindow();
  setupUpdater();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('browser-window-focus', () => { if (win) win.flashFrame(false); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
