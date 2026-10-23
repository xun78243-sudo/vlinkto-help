'use strict'
/** 渲染进程与主进程之间的安全桥（contextIsolation 开启，不暴露 Node）。 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('assistant', {
  snapshot: () => ipcRenderer.invoke('app:snapshot'),
  logs: () => ipcRenderer.invoke('app:logs'),
  refreshToken: () => ipcRenderer.invoke('token:refresh'),
  toggleExam: (enabled) => ipcRenderer.invoke('exam:toggle', enabled),
  runNow: () => ipcRenderer.invoke('exam:runNow'),
  toggleReminder: (enabled) => ipcRenderer.invoke('reminder:toggle', enabled),
  runReminder: () => ipcRenderer.invoke('reminder:runNow'),
  testReminderNotify: () => ipcRenderer.invoke('reminder:test'),
  setDryRun: (value) => ipcRenderer.invoke('app:setDryRun', value),
  setCloseToTray: (value) => ipcRenderer.invoke('app:setCloseToTray', value),
  openLogs: () => ipcRenderer.invoke('app:openLogs'),
  openConfig: () => ipcRenderer.invoke('app:openConfig'),
  copy: (text) => ipcRenderer.invoke('app:copy', text),
  openUrl: (url) => ipcRenderer.invoke('app:openUrl', url),
  hide: () => ipcRenderer.invoke('app:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),
  defectModels: () => ipcRenderer.invoke('defect:models'),
  saveDefectSettings: (patch) => ipcRenderer.invoke('defect:saveSettings', patch),
  generateDefect: (payload) => ipcRenderer.invoke('defect:generate', payload),
  lookupDefectUrl: () => ipcRenderer.invoke('defect:url'),
  onState: (callback) => {
    ipcRenderer.on('state:update', (event, payload) => callback(payload))
  },
  onLog: (callback) => {
    ipcRenderer.on('log:append', (event, entry) => callback(entry))
  },
  onDefectStage: (callback) => {
    ipcRenderer.on('defect:stage', (event, payload) => callback(payload))
  },
  cloudState: () => ipcRenderer.invoke('cloud:state'),
  cloudDevices: () => ipcRenderer.invoke('cloud:devices'),
  cloudStart: (serial) => ipcRenderer.invoke('cloud:start', serial),
  cloudStop: () => ipcRenderer.invoke('cloud:stop'),
  cloudPause: (paused) => ipcRenderer.invoke('cloud:pause', paused),
  cloudTouch: (event) => ipcRenderer.invoke('cloud:input', { kind: 'touch', event }),
  cloudKey: (event) => ipcRenderer.invoke('cloud:input', { kind: 'key', event }),
  cloudText: (payload) => ipcRenderer.invoke('cloud:input', { kind: 'text', payload }),
  cloudScroll: (event) => ipcRenderer.invoke('cloud:input', { kind: 'scroll', event }),
  cloudRotate: () => ipcRenderer.invoke('cloud:input', { kind: 'rotate' }),
  cloudNotification: () => ipcRenderer.invoke('cloud:input', { kind: 'notification' }),
  cloudDisplayPower: () => ipcRenderer.invoke('cloud:input', { kind: 'displayPower' }),
  cloudScreenshot: () => ipcRenderer.invoke('cloud:screenshot'),
  cloudSendImages: () => ipcRenderer.invoke('cloud:sendImages'),
  cloudEnableWireless: (serial) => ipcRenderer.invoke('cloud:wireless', serial),
  onCloudState: (callback) => {
    ipcRenderer.on('cloud:state', (event, payload) => callback(payload))
  },
  onCloudFrames: (callback) => {
    ipcRenderer.on('cloud:frames', (event, payload) => callback(payload))
  },
})
