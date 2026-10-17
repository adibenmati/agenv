type Listeners<E> = { [K in keyof E]: (...a: any[]) => void };

/**
 * A minimal typed event emitter. Unlike Node's EventEmitter, a listener that throws is caught and logged,
 * so one faulty subscriber can never break the emitter or starve the listeners after it — important when
 * the emitter sits on the pty output path.
 */
export class TypedEmitter<E extends Listeners<E> = Record<string, (...a: any[]) => void>> {
  private listeners = new Map<string, Array<(...a: any[]) => void>>();

  on<K extends keyof E & string>(event: K, fn: E[K]): this {
    const list = this.listeners.get(event);
    if (list) list.push(fn); else this.listeners.set(event, [fn]);
    return this;
  }

  off<K extends keyof E & string>(event: K, fn: E[K]): this {
    const list = this.listeners.get(event);
    if (!list) return this;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
    return this;
  }

  emit<K extends keyof E & string>(event: K, ...args: Parameters<E[K]>): void {
    const list = this.listeners.get(event);
    if (!list) return;
    for (const fn of [...list]) {
      try { fn(...args); } catch (e) { console.error(`[agenv] listener for "${event}" threw:`, e); }
    }
  }
}
