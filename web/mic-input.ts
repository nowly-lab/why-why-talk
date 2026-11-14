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

type Switchable = { switchDevice(id: string): Promise<SwitchResult>; stop(): void };

/**
 * Owns which microphone is chosen and which one is actually feeding the talk. The started mic is handed to
 * teardown before any follow-up switch, a choice made at any point (while starting or while another switch is
 * pending) wins in the end, and stop() closes whatever has started, now or when it arrives.
 * `persist` saves the choice and shows it in the selector. "" is the system default.
 */
export function createMicController<M extends Switchable>(
  deps: { start(id: string): Promise<M>; persist(id: string): void; onSwitchError?(e: Error): void },
  initial: string,
) {
  let choice = initial;
  let active: string | null = null;
  let mic: M | null = null;
  let ended = false;

  // Switch until the active mic matches the latest choice. A superseded switch leaves the newer call to finish.
  async function sync(): Promise<void> {
    while (mic && !ended && choice !== active) {
      const target = choice;
      let result: SwitchResult;
      try {
        result = await mic.switchDevice(target);
      } catch (e) {
        if (choice === target && active !== null) {
          choice = active;
          deps.persist(active);
        }
        throw e;
      }
      if (result !== "switched") return;
      active = target;
    }
  }

  return {
    choice: () => choice,
    active: () => active,
    mic: () => mic,
    /** Starts the mic; a remembered mic that fails (unplugged) falls back to the system default. Null if stop() came first. */
    async start(): Promise<M | null> {
      let used = choice;
      let started: M;
      try {
        started = await deps.start(used);
      } catch (e) {
        if (!used || ended) throw e;
        if (choice === used) {
          choice = "";
          deps.persist("");
        }
        used = "";
        started = await deps.start("");
      }
      if (ended) {
        started.stop();
        return null;
      }
      mic = started;
      active = used;
      // A choice made while starting that cannot be opened leaves the started mic running.
      await sync().catch((e: unknown) => deps.onSwitchError?.(e as Error));
      return mic;
    },
    /** The person picked a mic. While starting it is only remembered; start() applies it. */
    async choose(id: string): Promise<void> {
      choice = id;
      deps.persist(id);
      await sync();
    },
    stop() {
      ended = true;
      mic?.stop();
    },
  };
}
