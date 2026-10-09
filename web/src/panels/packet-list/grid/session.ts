/**
 * Per-instance view state that outlives the panel document. The host unmounts the panel's frame on a
 * layout tab switch and reloads it on return, so what React state would lose (the quick-filter text, the
 * column layout, where the viewport was parked) is kept in sessionStorage, keyed by the instance id.
 *
 * Storage can be unavailable (blocked, a private window, a full quota); every access is guarded and the
 * panel then behaves as a fresh one.
 */

export function sessionKey(instanceId: string, name: string): string {
  return `zelos.panel.${instanceId}.${name}`;
}

export function readSession<T>(key: string): T | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

/** `null` removes the key. */
export function writeSession(key: string, value: unknown): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is a convenience here: without it the state lasts as long as the document.
  }
}
