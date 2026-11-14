// Microphone choice and input level: pure logic, no DOM, so it is tested in Node.

export const MIC_STORAGE_KEY = "why-why:mic";
/** Below this RMS (about -46 dBFS) the mic is treated as silent. */
export const SILENCE_FLOOR = 0.005;
export const SILENCE_WARN_MS = 5_000;

type KeyValue = { getItem(k: string): string | null; setItem(k: string, v: string): void };
export type MicOption = { id: string; label: string };

/** "" means the system default microphone. */
export function loadMicChoice(storage: KeyValue | null): string {
  try {
    return storage?.getItem(MIC_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveMicChoice(storage: KeyValue | null, id: string): void {
  try {
    storage?.setItem(MIC_STORAGE_KEY, id);
  } catch {
    // Private windows and blocked storage: the choice simply is not remembered.
  }
}

/** The system default first, then each other audio input. Labels are empty until mic permission is granted. */
export function micOptions(devices: MediaDeviceInfo[], chosen: string): { options: MicOption[]; selected: string } {
  const options: MicOption[] = [{ id: "", label: "既定のマイク" }];
  let n = 0;
  for (const d of devices) {
    if (d.kind !== "audioinput" || d.deviceId === "default" || d.deviceId === "") continue;
    n++;
    options.push({ id: d.deviceId, label: d.label || `マイク ${n}` });
  }
  return { options, selected: options.some((o) => o.id === chosen) ? chosen : "" };
}

export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

/** 0..1 for the level meter on a -60..0 dBFS scale, so quiet speech still moves it. */
export function meterValue(level: number): number {
  if (level <= 0) return 0;
  return Math.max(0, Math.min(1, (20 * Math.log10(level) + 60) / 60));
}

/**
 * Watches the input level. Emits "silent" once after SILENCE_WARN_MS of near-zero level while not muted,
 * and "heard" when sound comes back after that. Muting stops and restarts the clock.
 */
export function createSilenceWatch(opts: { floor?: number; warnMs?: number } = {}) {
  const floor = opts.floor ?? SILENCE_FLOOR;
  const warnMs = opts.warnMs ?? SILENCE_WARN_MS;
  let quietSince: number | null = null;
  let warned = false;
  return {
    sample(level: number, muted: boolean, at: number): "silent" | "heard" | null {
      if (muted) {
        quietSince = null;
        warned = false;
        return null;
      }
      if (level >= floor) {
        quietSince = null;
        if (warned) {
          warned = false;
          return "heard";
        }
        return null;
      }
      if (quietSince === null) quietSince = at;
      if (!warned && at - quietSince >= warnMs) {
        warned = true;
        return "silent";
      }
      return null;
    },
  };
}
