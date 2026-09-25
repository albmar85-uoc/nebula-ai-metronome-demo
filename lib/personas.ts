import type { PlanId } from "./catalog";

export type PersonaId = "free" | "pro" | "scale" | "enterprise";
export type Persona = { id: PersonaId; name: string; email: string; company: string; plan: PlanId; title: string; blurb: string; shows: string; landing: string };

/** Seeded demo personas (mock mode only). Shared by the server seeder and the Demo controls drawer. */
export const PERSONAS: Record<PersonaId, Persona> = {
  free: {
    id: "free", name: "Hana Sato", email: "hana@hobby.example", company: "Side project", plan: "free",
    title: "Free hobbyist near the limit", blurb: "€5 of monthly credits, about 85% used.",
    shows: "Low-balance alert (20% threshold), access cut-off at €0, bundles and upgrade prompts.", landing: "/dashboard",
  },
  pro: {
    id: "pro", name: "Leo Martins", email: "leo@brightloop.example", company: "Brightloop", plan: "pro",
    title: "Pro startup with auto-recharge", blurb: "Auto-recharge on: below €10 it tops up to €50. It already fired once this month.",
    shows: "Prepaid balance threshold (auto-recharge), 10% usage discount, next-invoice preview.", landing: "/dashboard",
  },
  scale: {
    id: "scale", name: "Priya Nair", email: "priya@orbitlabs.example", company: "Orbit Labs", plan: "scale",
    title: "Scale company with overage", blurb: "€250 of credits used up; about €235 of overage accrued this month.",
    shows: "Overage billed at month end, early charge every €300 of overage (spend threshold), month close.", landing: "/dashboard",
  },
  enterprise: {
    id: "enterprise", name: "Marcus Webb", email: "marcus@vertexhealth.example", company: "Vertex Health", plan: "scale",
    title: "Enterprise prospect", blurb: "Scale customer spending well over €1,500/month; has asked sales for a proposal.",
    shows: "Plan recommender suggesting Enterprise, annual commitment proposal (Metronome contract with commit).", landing: "/enterprise",
  },
};
export const PERSONA_IDS = Object.keys(PERSONAS) as PersonaId[];
