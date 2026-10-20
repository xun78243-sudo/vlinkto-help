'use strict'
/** 渲染进程与主进程之间的安全桥（contextIsolation 开启，不暴露 Node）。 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('assistant', {
  snapshot: () => ipcRenderer.invoke('app:snapshot'),
  logs: () => ipcRenderer.invoke('app:logs'),
  refreshToken: () => ipcRenderer.invoke('token:refresh'),
  toggleExam: (enabled) => ipcRenderer.invoke('exam:toggle', enabled),
  runNow: () => ipcRenderer.invoke('exam:runNow'),
  setDryRun: (value) => ipcRenderer.invoke('app:setDryRun', value),
  setCloseToTray: (value) => ipcRenderer.invoke('app:setCloseToTray', value),
  openLogs: () => ipcRenderer.invoke('app:openLogs'),
  openConfig: () => ipcRenderer.invoke('app:openConfig'),
  hide: () => ipcRenderer.invoke('app:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),
  onState: (callback) => {
    ipcRenderer.on('state:update', (event, payload) => callback(payload))
  },
  onLog: (callback) => {
    ipcRenderer.on('log:append', (event, entry) => callback(entry))
  },
})
