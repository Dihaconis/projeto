/** Semáforo assíncrono simples (montagem limitada a N por vez). */
export class Semaphore {
  private active = 0
  private readonly waiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = []

  constructor(private readonly max: number) {}

  get inUse(): number {
    return this.active
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw signal.reason
    if (this.active < this.max) {
      this.active++
      return this.releaser()
    }
    await new Promise<void>((resolve, reject) => {
      const w = { resolve, reject }
      this.waiters.push(w)
      signal?.addEventListener(
        'abort',
        () => {
          const i = this.waiters.indexOf(w)
          if (i >= 0) {
            this.waiters.splice(i, 1)
            reject(signal.reason)
          }
        },
        { once: true },
      )
    })
    this.active++
    return this.releaser()
  }

  private releaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      const next = this.waiters.shift()
      next?.resolve()
    }
  }
}
