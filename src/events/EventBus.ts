import { EventHandlerMap, EventName } from "../types";

type Listener<N extends EventName> = EventHandlerMap[N];

export class EventBus {
  private listeners = new Map<EventName, Set<Function>>();

  on<N extends EventName>(name: N, fn: Listener<N>): () => void {
    let set = this.listeners.get(name) as Set<Listener<N>> | undefined;
    if (!set) {
      set = new Set<Listener<N>>();
      this.listeners.set(name, set as unknown as Set<Function>);
    }
    set.add(fn);
    return () => this.off(name, fn);
  }

  off<N extends EventName>(name: N, fn: Listener<N>): void {
    (this.listeners.get(name) as Set<Listener<N>> | undefined)?.delete(fn);
  }

  emit<N extends EventName>(name: N, ...args: Parameters<Listener<N>>): void {
    const set = this.listeners.get(name) as Set<Listener<N>> | undefined;
    if (!set) return;
    const a = args as Parameters<Listener<N>>;
    // Snapshot so a listener that (un)subscribes during dispatch can't skip/duplicate others.
    // Each listener is isolated: one throwing listener must not break internal
    // message routing or prevent the remaining listeners from running.
    for (const fn of [...set]) {
      try {
        (fn as (...a: Parameters<Listener<N>>) => void)(...a);
      } catch (error) {
        console.error(`[p2play] listener for "${String(name)}" threw:`, error);
      }
    }
  }

  /** Remove all listeners. Use when disposing the bus owner. */
  clear(): void {
    this.listeners.clear();
  }
}

