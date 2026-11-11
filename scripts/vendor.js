// Copia as bibliotecas de terceiros para src/vendor (a interface não usa node_modules diretamente)
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const files = {
  'peerjs.min.js': 'node_modules/peerjs/dist/peerjs.min.js',
  'qrcode.js': 'node_modules/qrcode-generator/qrcode.js',
};
for (const [dest, src] of Object.entries(files)) {
  fs.copyFileSync(path.join(root, src), path.join(root, 'src', 'vendor', dest));
}
module.exports = files;
