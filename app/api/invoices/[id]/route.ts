import { NextResponse } from "next/server";
import { billing } from "@/lib/billing";
import { currentCustomerId } from "@/lib/session";

export const dynamic = "force-dynamic";
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const cid = currentCustomerId();
  if (!cid) return NextResponse.json({ error: "Sin sesión" }, { status: 401 });
  try {
    const inv = await billing.getInvoice?.(cid, params.id);
    if (!inv) return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });
    return NextResponse.json(inv);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
