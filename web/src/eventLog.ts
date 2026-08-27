type Listener = (lines: string[]) => void;

let lines: string[] = [];
const listeners = new Set<Listener>();

/**
 * One log for the whole app.
 *
 * It used to live in the diagnostics screen's React state, which meant the
 * translator — where the interesting failures actually happen — could not
 * write to it, and nothing it did ever reached the exported report. A run that
 * "didn't work" was undiagnosable as a result.
 */
export function logEvent(message: string) {
  const stamped = `${new Date().toLocaleTimeString()}  ${message}`;
  lines = [stamped, ...lines].slice(0, 300);
  for (const l of listeners) l(lines);
}

export function getLog(): string[] {
  return lines;
}

export function primeLog(initial: string[]) {
  lines = initial;
  for (const l of listeners) l(lines);
}

export function clearLog() {
  lines = [];
  for (const l of listeners) l(lines);
}

export function subscribeLog(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
