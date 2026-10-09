// A tiny application event bus.
//   bus.on('library:changed', fn) -> unsubscribe()
//   bus.emit('library:changed', detail)
// Well-known events:
//   session:changed   { account, profile, mode }
//   library:changed   { titleId? }
//   theme:changed     { preferences }
//   route:changed     { path, params }
//   player:active     boolean   (the immersive player opened/closed)
//   notifications:changed
const listeners = new Map();

export const bus = {
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event)?.delete(fn);
  },
  once(event, fn) {
    const off = this.on(event, (d) => {
      off();
      fn(d);
    });
    return off;
  },
  emit(event, detail) {
    for (const fn of listeners.get(event) || []) {
      try {
        fn(detail);
      } catch (err) {
        console.error(`[bus] ${event} handler failed`, err);
      }
    }
  },
};
