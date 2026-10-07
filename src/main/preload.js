'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// API mínima expuesta al renderer (contextIsolation + sandbox).
contextBridge.exposeInMainWorld('coop', {
  call: (method, args) => ipcRenderer.invoke('api', method, args),
  info: () => ipcRenderer.invoke('app:info'),
  nfcStatus: () => ipcRenderer.invoke('app:nfcStatus'),
  getConfig: () => ipcRenderer.invoke('app:getConfig'),
  setConfig: (c) => ipcRenderer.invoke('app:setConfig', c),
  testServer: (url) => ipcRenderer.invoke('app:testServer', url),
  sync: {
    status: () => ipcRenderer.invoke('sync:getStatus'),
    now: () => ipcRenderer.invoke('sync:now'),
    link: (a) => ipcRenderer.invoke('sync:link', a),
    unlink: () => ipcRenderer.invoke('sync:unlink'),
    makePrimary: (a) => ipcRenderer.invoke('sync:makePrimary', a),
    onStatus: (cb) => { const h = (_e, s) => cb(s); ipcRenderer.on('sync:status', h); return () => ipcRenderer.removeListener('sync:status', h); },
  },
  backup: () => ipcRenderer.invoke('app:backup'),
  codes: (a) => ipcRenderer.invoke('codes:get', a),
  exportPdf: (a) => ipcRenderer.invoke('app:exportPdf', a),
  openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'),
  onNfcUid: (cb) => { const h = (_e, uid) => cb(uid); ipcRenderer.on('nfc:uid', h); return () => ipcRenderer.removeListener('nfc:uid', h); },
  onNfcStatus: (cb) => { const h = (_e, s) => cb(s); ipcRenderer.on('nfc:status', h); return () => ipcRenderer.removeListener('nfc:status', h); },
});
