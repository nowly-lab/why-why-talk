/** A Live connection lasts about 10 minutes and a token 30; reconnect before either runs out. */
export const PROACTIVE_RECONNECT_MS = 25 * 60_000;
export const MAX_RETRIES = 6;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

/** Wait before retry number `attempt` (0-based): 1 s, 2 s, 4 s … capped at 30 s; null after MAX_RETRIES. */
export function retryDelay(attempt: number): number | null {
  if (attempt >= MAX_RETRIES) return null;
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
}

/**
 * Counts failed connection attempts. A connection only resets the count once it has stayed up
 * (`stable`), so one that opens and closes right away still uses up the budget.
 */
export function createRetryBudget() {
  let attempt = 0;
  return {
    connected(): void {},
    stable(): void {
      attempt = 0;
    },
    /** The wait before the next try, or null when the budget is spent. */
    failed(): number | null {
      return retryDelay(attempt++);
    },
    reset(): void {
      attempt = 0;
    },
  };
}

export type LinkState = { handle: string | null; connectedAt: number | null };
export type LinkEvent =
  | { kind: "start"; hasHistory: boolean }
  | { kind: "goAway" }
  | { kind: "stalled" }
  | { kind: "closed" }
  | { kind: "handleRejected" }
  | { kind: "tick"; now: number };
export type Connection = { handle: string | null; fallback: boolean };

/**
 * How to connect next. Resume with the session-resumption handle when there is one; when there is
 * none (or it was refused), start a new Live session seeded with the tree and the transcript tail.
 */
export function nextConnection(state: LinkState, event: LinkEvent): Connection | null {
  switch (event.kind) {
    case "start":
      // A reloaded page has no handle; when the talk already has history, seed the new Live session with it.
      return { handle: null, fallback: event.hasHistory };
    case "goAway":
    case "stalled":
    case "closed":
      return state.handle ? { handle: state.handle, fallback: false } : { handle: null, fallback: true };
    case "handleRejected":
      return { handle: null, fallback: true };
    case "tick":
      if (state.connectedAt === null || event.now - state.connectedAt < PROACTIVE_RECONNECT_MS) return null;
      return state.handle ? { handle: state.handle, fallback: false } : { handle: null, fallback: true };
  }
}
