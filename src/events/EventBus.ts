import { EventHandlerMap, EventName } from "../types";

type Listener<N extends EventName> = EventHandlerMap[N];

export class EventBus {
  private listeners = new Map<EventName, Set<Function>>();

  on<N extends EventName>(name: N, fn: Listener<N>): () => void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(fn as any);
    return () => this.off(name, fn);
  }

  off<N extends EventName>(name: N, fn: Listener<N>): void {
    this.listeners.get(name)?.delete(fn as any);
  }

  emit<N extends EventName>(name: N, ...args: Parameters<Listener<N>>): void {
    const set = this.listeners.get(name);
    if (!set) return;
    set.forEach((fn) => (fn as any)(...args));
  }
}

