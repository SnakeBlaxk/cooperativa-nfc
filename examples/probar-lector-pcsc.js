'use strict';
// Script independiente para PROBAR un lector PC/SC (ej. ACR122U) antes de usarlo con la app.
// Uso:
//   npm install nfc-pcsc        (en una carpeta aparte o en el proyecto)
//   node examples/probar-lector-pcsc.js
// Acerque una tarjeta: se imprime el UID tal como lo verá la app.
const { NFC } = require('nfc-pcsc');
const nfc = new NFC();
nfc.on('reader', (reader) => {
  console.log('Lector conectado:', reader.reader.name);
  reader.autoProcessing = true;
  reader.on('card', (card) => console.log('Tarjeta detectada. UID =', String(card.uid).toUpperCase(), '| ATR =', card.atr && card.atr.toString('hex')));
  reader.on('card.off', () => console.log('Tarjeta retirada'));
  reader.on('error', (e) => console.error('Error del lector:', e.message));
  reader.on('end', () => console.log('Lector desconectado'));
});
nfc.on('error', (e) => console.error('Error PC/SC:', e.message));
console.log('Esperando lector… (Ctrl+C para salir)');
