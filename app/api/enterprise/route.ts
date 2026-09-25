import { NextResponse } from "next/server";
import { enterpriseProposal } from "@/lib/billing/insights";
import { addEnterpriseLead } from "@/lib/store";

// Solicitud de propuesta Enterprise. En la demo NO se envía nada a nadie: se guarda localmente (data/db.json) y se
// devuelve una propuesta de ejemplo con la forma EnterpriseContractSummary (en vivo, ventas usaría createEnterpriseContract).
export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  const company = String(b.company ?? "").trim().slice(0, 120);
  const email = String(b.email ?? "").trim().slice(0, 200);
  const monthlySpend = Math.max(0, Number(b.monthlySpend) || 0);
  if (!company || !/^\S+@\S+\.\S+$/.test(email)) return NextResponse.json({ error: "Enter a company and a valid email" }, { status: 400 });
  const id = `lead_${Date.now().toString(36)}`;
  addEnterpriseLead({ id, ts: new Date().toISOString(), company, email, monthlySpend });
  // Compromiso sugerido: 12 × gasto mensual estimado (mínimo 12 000 €), redondeado a miles.
  const commit = Math.max(12_000, Math.round((monthlySpend * 12) / 1000) * 1000);
  return NextResponse.json({ ok: true, leadId: id, proposal: enterpriseProposal({ customerId: id, commitAmountEur: commit }) });
}
