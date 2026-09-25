import { read } from "./store";

/**
 * Demo clock. In mock mode "Fast-forward to month end" moves the whole simulated world forward by storing an offset
 * (db.demo.clockOffsetMs); every mock billing timestamp comes from here. Live mode never sets an offset, so it is real time.
 */
export const clockOffsetMs = () => read(db => db.demo?.clockOffsetMs ?? 0);
export const nowMs = () => Date.now() + clockOffsetMs();
export const nowDate = () => new Date(nowMs());
export const nowIso = () => nowDate().toISOString();
