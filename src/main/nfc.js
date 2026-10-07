'use strict';
// Integración OPCIONAL con lectores PC/SC (ej. ACS ACR122U) usando la librería nfc-pcsc.
// No viene instalada por defecto porque es un módulo nativo. Para activarla:
//   npm install nfc-pcsc && npx electron-builder install-app-deps
// En Linux además: sudo apt install pcscd libpcsclite-dev
// Si la librería no está disponible, la app sigue funcionando con lectores tipo teclado (USB HID).
function startNfcReader(onUid, onStatus = () => {}) {
  let NFC;
  try { ({ NFC } = require('nfc-pcsc')); } catch (_) {
    onStatus({ available: false, message: 'Lector PC/SC no habilitado (modo teclado USB)' });
    return null;
  }
  try {
    const nfc = new NFC();
    nfc.on('reader', (reader) => {
      onStatus({ available: true, message: `Lector conectado: ${reader.reader.name}` });
      reader.autoProcessing = true; // lee el UID automáticamente
      reader.on('card', (card) => {
        if (card && card.uid) onUid(String(card.uid).toUpperCase());
      });
      reader.on('error', (err) => onStatus({ available: true, message: `Error del lector: ${err.message}` }));
      reader.on('end', () => onStatus({ available: false, message: 'Lector desconectado' }));
    });
    nfc.on('error', (err) => onStatus({ available: false, message: `Error PC/SC: ${err.message}` }));
    return nfc;
  } catch (e) {
    onStatus({ available: false, message: `No se pudo iniciar PC/SC: ${e.message}` });
    return null;
  }
}
module.exports = { startNfcReader };
