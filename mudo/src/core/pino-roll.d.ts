declare module 'pino-roll' {
  import type { DestinationStream } from 'pino'
  interface PinoRollOptions {
    file: string | (() => string)
    size?: string | number
    frequency?: 'daily' | 'hourly' | number
    extension?: string
    mkdir?: boolean
    dateFormat?: string
    limit?: { count?: number; removeOtherLogFiles?: boolean }
    symlink?: boolean
  }
  export default function pinoRoll(opts: PinoRollOptions): Promise<DestinationStream & { end(): void; flushSync?(): void }>
}
