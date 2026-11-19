/**
 * Ponte única entre renderer e main. O renderer não tem Node, disco, rede nem
 * chaves: só pode chamar os canais do contrato, com entrada validada aqui e
 * de novo no main.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { ipcContract, ipcErrorSchema, ipcEvents, type IpcChannel, type IpcEvent, type MudoBridge } from '../shared/ipc'

const bridge: MudoBridge = {
  async invoke(channel: IpcChannel, ...args: unknown[]) {
    const spec = ipcContract[channel]
    if (!spec) throw new Error(`canal desconhecido: ${String(channel)}`)
    const input = spec.input.parse(args[0])
    const res: unknown = await ipcRenderer.invoke(channel, input)
    const err = ipcErrorSchema.safeParse(res)
    if (err.success) throw new Error(err.data.message)
    return spec.output.parse(res)
  },
  on(event: IpcEvent, cb: (payload: never) => void) {
    const schema = ipcEvents[event]
    if (!schema) throw new Error(`evento desconhecido: ${String(event)}`)
    const listener = (_e: Electron.IpcRendererEvent, payload: unknown) => {
      const p = schema.safeParse(payload)
      if (p.success) cb(p.data as never)
    }
    ipcRenderer.on(event, listener)
    return () => {
      ipcRenderer.removeListener(event, listener)
    }
  },
} as MudoBridge

contextBridge.exposeInMainWorld('mudo', bridge)
