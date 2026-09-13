/**
 * 冷热切换互斥锁（进程内单例语义，由装配方注入两侧）：
 *
 * 冷切换（kill Cursor → 写 state.vscdb → 拉起）与热切（回环泵票给运行中的
 * Cursor）绝不能并发——热切期间冷切换写库会被运行中的 Cursor flush 覆盖，
 * 冷切换杀进程会让热切等不到回执。占用即拒，不排队（两条链都有自己的
 * 用户可感知进度，排队只会让后一条对着过期上下文操作）。
 */
export class CursorSwitchMutex {
  private holder: string | undefined

  /** 当前是否有切换在进行（UI 禁用按钮的判定依据）。 */
  get locked(): boolean {
    return this.holder !== undefined
  }

  /** 持锁执行；已被占用时抛出带持锁方名字的 Error。fn 结束后无论成败都释放。 */
  async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (this.holder !== undefined) {
      throw new Error(`${this.holder}正在进行，请等待当前操作完成`)
    }
    this.holder = name
    try {
      return await fn()
    } finally {
      if (this.holder === name) this.holder = undefined
    }
  }
}
