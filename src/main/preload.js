'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// Puente mínimo de la caja de escritorio (contextIsolation + sandbox).
// La interfaz es la misma app web del servidor; aquí solo se agrega el lector NFC PC/SC
// y, en las páginas locales de la caja (sin conexión / configurar servidor), el cambio de servidor.
contextBridge.exposeInMainWorld('coopDesktop', {
  desktop: true,
  info: () => ipcRenderer.invoke('app:info'),
  nfcStatus: () => ipcRenderer.invoke('app:nfcStatus'),
  onNfcUid: (cb) => { const h = (_e, uid) => cb(uid); ipcRenderer.on('nfc:uid', h); return () => ipcRenderer.removeListener('nfc:uid', h); },
  onNfcStatus: (cb) => { const h = (_e, s) => cb(s); ipcRenderer.on('nfc:status', h); return () => ipcRenderer.removeListener('nfc:status', h); },
  // Solo funcionan desde las páginas locales de la caja (el proceso principal lo verifica)
  connection: {
    status: () => ipcRenderer.invoke('desk:status'),
    retry: () => ipcRenderer.invoke('desk:retry'),
    setServerUrl: (url) => ipcRenderer.invoke('desk:setServerUrl', url),
    onStatus: (cb) => { const h = (_e, s) => cb(s); ipcRenderer.on('desk:status', h); return () => ipcRenderer.removeListener('desk:status', h); },
  },
});
