import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('desk', {
  state: () => ipcRenderer.invoke('desk:state'),
  add: (name: string) => ipcRenderer.invoke('desk:add', name),
  activate: (id: string) => ipcRenderer.invoke('desk:activate', id),
  stop: (id: string) => ipcRenderer.invoke('desk:stop', id),
  remove: (id: string) => ipcRenderer.invoke('desk:remove', id),
  rename: (id: string, name: string) => ipcRenderer.invoke('desk:rename', id, name),
  setLayout: (layout: string) => ipcRenderer.invoke('desk:layout', layout),
  requestPermission: () => ipcRenderer.invoke('desk:permission'),
  focusShell: () => ipcRenderer.invoke('desk:focus-shell'),
  onState: (cb: (state: unknown) => void) => {
    ipcRenderer.on('desk:state', (_e, state) => cb(state));
  },
});
