import type { MudoBridge } from '../../../shared/ipc'

declare global {
  interface Window {
    mudo: MudoBridge
  }
}

export const mudo: MudoBridge = window.mudo
