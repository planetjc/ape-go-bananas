// The person's own study settings, kept in this window's storage beside the
// theme: how many new cards a day they add in Anki. With an exam date from a
// class, the organize step sizes a deck to what that rate reviews by then.

const KEY = 'ape.newPerDay';
/** Anki's own default for new cards a day. */
export const DEFAULT_NEW_PER_DAY = 20;

export function readNewPerDay(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return Number.isInteger(n) && n > 0 && n <= 9999 ? n : DEFAULT_NEW_PER_DAY;
  } catch {
    return DEFAULT_NEW_PER_DAY;
  }
}

export function setNewPerDay(n: number): void {
  try {
    localStorage.setItem(KEY, String(n));
  } catch {
    /* storage blocked: the default stands */
  }
}
