"use client";
import { useConfig } from "./useAccount";

export default function ModeBadge({ compact = false }: { compact?: boolean }) {
  const cfg = useConfig();
  if (!cfg) return null;
  const live = cfg.mode === "metronome";
  return (
    <span className={`mode ${live ? "live" : "sim"}`} title={live ? "Las operaciones llaman a la API real de Metronome y Stripe" : "Todo se simula en local; no se llama a Metronome ni a Stripe"}>
      <i />{compact ? (live ? "En vivo" : "Simulado") : live ? "Metronome en vivo" : "Modo simulado"}
    </span>
  );
}
