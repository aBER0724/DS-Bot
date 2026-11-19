// The address window's only API: hand the typed address to the main process, which checks it and
// answers with what is wrong, and cancel the window. The main process accepts the channel from
// this window alone.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dsBotRemote', {
  save: (text) => ipcRenderer.invoke('ds-bot:remote-address', text),
  cancel: () => ipcRenderer.send('ds-bot:remote-address-cancel'),
})
