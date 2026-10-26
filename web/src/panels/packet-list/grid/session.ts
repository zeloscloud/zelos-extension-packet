// The frame reloads on a layout tab switch, so view state that should survive it lives in sessionStorage.

export function sessionKey(sessionId: string, name: string): string {
  return `zelos.panel.${sessionId}.${name}`;
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
