"use client";
import { useConfig } from "./useAccount";

export default function ModeBadge({ compact = false }: { compact?: boolean }) {
  const cfg = useConfig();
  if (!cfg) return null;
  const live = cfg.mode === "metronome";
  return (
    <span className={`mode ${live ? "live" : "sim"}`} title={live ? "Actions call the real Metronome and Stripe APIs" : "Everything is simulated locally; Metronome and Stripe are not called"}>
      <i />{compact ? (live ? "Live" : "Simulated") : live ? "Live Metronome" : "Simulated mode"}
    </span>
  );
}
