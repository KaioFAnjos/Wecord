// Lança uma versão nova: npm run release -- 1.1.0   (ou: patch | minor | major)
// Atualiza o package.json, faz commit, cria a tag vX.Y.Z e envia ao GitHub.
// O GitHub Actions gera os instaladores e publica o release; o Wecord instalado se atualiza sozinho.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
const out = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const arg = process.argv[2];
if (!arg) {
  console.log(`Versão atual: ${pkg.version}\nUso: npm run release -- <patch|minor|major|X.Y.Z>`);
  process.exit(1);
}

const [ma, mi, pa] = pkg.version.split('.').map(Number);
const next = arg === 'major' ? `${ma + 1}.0.0`
  : arg === 'minor' ? `${ma}.${mi + 1}.0`
  : arg === 'patch' ? `${ma}.${mi}.${pa + 1}`
  : arg.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(next)) { console.error('Versão inválida: ' + arg); process.exit(1); }
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
if (!newer(next, pkg.version)) { console.error(`A versão nova (${next}) precisa ser maior que a atual (${pkg.version}).`); process.exit(1); }

const raw = fs.readFileSync(pkgPath, 'utf8').replace(/"version":\s*"[^"]+"/, `"version": "${next}"`);
fs.writeFileSync(pkgPath, raw);
const lockPath = path.join(__dirname, '..', 'package-lock.json');
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.version = next;
  if (lock.packages && lock.packages['']) lock.packages[''].version = next;
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
}

run('git add -A');
run(`git commit -m "Wecord v${next}"`);
run(`git tag v${next}`);
const branch = out('git rev-parse --abbrev-ref HEAD');
run(`git push origin ${branch}`);
run(`git push origin v${next}`);
console.log(`\nv${next} enviada! Acompanhe em https://github.com/KaioFAnjos/Wecord/actions`);
console.log('Quando terminar (~10 min), quem tem o Wecord instalado recebe a atualização ao abrir o app.');
