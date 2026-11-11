/** The API-key window's only way out: the key, or a cancel, sent straight to main. See keyWindow.ts. */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('keyWindow', {
  submit: (key: string) => ipcRenderer.send('keyWindow:submit', String(key)),
  cancel: () => ipcRenderer.send('keyWindow:cancel'),
});
