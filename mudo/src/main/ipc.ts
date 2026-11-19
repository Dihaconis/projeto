import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { Logger } from 'pino'
import { ipcContract, type IpcChannel, type IpcInput, type IpcOutput } from '../shared/ipc'

export type IpcHandlers = {
  [C in IpcChannel]: (input: IpcInput<C>, e: IpcMainInvokeEvent) => IpcOutput<C> | Promise<IpcOutput<C>>
}

/** Mensagem segura para o usuário: erros esperados viram texto, o resto vai pro log. */
export class UserFacingError extends Error {}

/**
 * Registra todos os canais. Entrada validada com zod (o renderer não é
 * confiável), saída validada também. Só aceita chamadas do frame principal
 * da janela do app.
 */
export function registerIpc(handlers: IpcHandlers, log: Logger, isTrustedSender: (e: IpcMainInvokeEvent) => boolean) {
  for (const channel of Object.keys(ipcContract) as IpcChannel[]) {
    const spec = ipcContract[channel]
    ipcMain.handle(channel, async (e, raw: unknown) => {
      if (!isTrustedSender(e)) {
        log.warn({ channel }, 'chamada IPC de origem não confiável recusada')
        return { __ipcError: true, message: 'Origem não autorizada.' }
      }
      const parsed = spec.input.safeParse(raw)
      if (!parsed.success) {
        log.warn({ channel, issues: parsed.error.issues }, 'entrada IPC inválida')
        return { __ipcError: true, message: 'Dados inválidos enviados pela interface.' }
      }
      try {
        const handler = handlers[channel] as (i: unknown, e: IpcMainInvokeEvent) => unknown
        const out = await handler(parsed.data, e)
        return spec.output.parse(out)
      } catch (err) {
        if (err instanceof UserFacingError) return { __ipcError: true, message: err.message }
        log.error({ err, channel }, 'erro no handler IPC')
        return { __ipcError: true, message: 'Erro inesperado. Detalhes foram gravados no log.' }
      }
    })
  }
}
