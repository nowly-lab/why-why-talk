/** A Live connection lasts about 10 minutes and a token 30; reconnect before either runs out. */
export const PROACTIVE_RECONNECT_MS = 25 * 60_000;

export type LinkState = { handle: string | null; connectedAt: number | null };
export type LinkEvent =
  | { kind: "start" }
  | { kind: "goAway" }
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
      return { handle: null, fallback: false };
    case "goAway":
    case "closed":
      return state.handle ? { handle: state.handle, fallback: false } : { handle: null, fallback: true };
    case "handleRejected":
      return { handle: null, fallback: true };
    case "tick":
      if (state.connectedAt === null || event.now - state.connectedAt < PROACTIVE_RECONNECT_MS) return null;
      return state.handle ? { handle: state.handle, fallback: false } : { handle: null, fallback: true };
  }
}
