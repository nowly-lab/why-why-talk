// Microphone stream lifecycle: pure logic (no DOM), so the races around switching and stopping are tested in Node.

type Stream = { getTracks(): { stop(): void }[] };
export type SwitchResult = "switched" | "superseded" | "stopped";

const stopTracks = (s: Stream) => {
  for (const t of s.getTracks()) t.stop();
};

/**
 * Holds the one live input stream. A switch that resolves after stop(), or after a newer switch, stops its own
 * stream instead of attaching it, so no microphone stays open behind the page.
 */
export function createInputSlot<S extends Stream>(first: S, wire: { attach(s: S): void; detach(): void }) {
  let stream = first;
  let generation = 0;
  let stopped = false;
  return {
    current: () => stream,
    async switchTo(acquire: () => Promise<S>): Promise<SwitchResult> {
      const mine = ++generation;
      const next = await acquire();
      if (stopped || mine !== generation) {
        stopTracks(next);
        return stopped ? "stopped" : "superseded";
      }
      wire.detach();
      stopTracks(stream);
      stream = next;
      wire.attach(stream);
      return "switched";
    },
    stop() {
      stopped = true;
      generation++;
      wire.detach();
      stopTracks(stream);
    },
  };
}

/** Starts the mic with the current choice, then applies a choice made while it was starting. A failing late switch keeps the first mic. */
export async function startWithLatestChoice<M extends { switchDevice(id: string): Promise<unknown> }>(
  choice: () => string,
  start: (id: string) => Promise<M>,
): Promise<{ mic: M; used: string; switchError?: Error }> {
  const first = choice();
  const mic = await start(first);
  const latest = choice();
  if (latest === first) return { mic, used: first };
  try {
    await mic.switchDevice(latest);
    return { mic, used: latest };
  } catch (e) {
    return { mic, used: first, switchError: e as Error };
  }
}
