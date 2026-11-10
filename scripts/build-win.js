// Gera o instalador do Windows (NSIS + portátil) em qualquer sistema, sem precisar do Wine.
// Em Linux/macOS, o electron-builder executaria o instalador via Wine só para extrair o
// desinstalador. Ele já tem um extrator em JavaScript puro (UninstallerReader), usado no
// macOS Catalina — aqui ativamos esse caminho.
const fs = require('fs');
const path = require('path');

fs.copyFileSync(
  path.join(__dirname, '..', 'node_modules', 'peerjs', 'dist', 'peerjs.min.js'),
  path.join(__dirname, '..', 'src', 'vendor', 'peerjs.min.js'),
);

if (process.platform !== 'win32') {
  const mv = require('app-builder-lib/out/util/macosVersion');
  mv.isMacOsCatalina = () => true;
}

// No Windows ou no WSL (que roda .exe nativamente) dá para aplicar ícone/metadados no Wecord.exe
const isWSL = !!(process.platform === 'linux' && (process.env.WSL_DISTRO_NAME || /microsoft/i.test(require('os').release())));
const canEditExe = process.platform === 'win32' || isWSL;
if (isWSL) {
  const shimDir = path.join(require('os').tmpdir(), 'wecord-wsl-wine');
  fs.mkdirSync(shimDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'wsl-wine'), path.join(shimDir, 'wine'));
  fs.chmodSync(path.join(shimDir, 'wine'), 0o755);
  process.env.PATH = shimDir + path.delimiter + process.env.PATH;
}

const { build, Platform, Arch } = require('electron-builder');
build({
  targets: Platform.WINDOWS.createTarget(['nsis', 'portable'], Arch.x64),
  // --publish envia o instalador + latest.yml para o GitHub Releases (usado no CI)
  publish: process.argv.includes('--publish') ? 'always' : 'never',
  config: { ...require('../package.json').build, win: { ...require('../package.json').build.win, signAndEditExecutable: canEditExe } },
})
  .then((files) => console.log('\nPronto:\n' + files.map((f) => '  ' + f).join('\n')))
  .catch((e) => { console.error(e); process.exit(1); });
