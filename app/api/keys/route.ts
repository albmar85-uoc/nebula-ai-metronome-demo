import { NextResponse } from "next/server";
import { createApiKey, toPublic } from "@/lib/apikeys";
import { billing } from "@/lib/billing";
import { currentCustomerId } from "@/lib/session";
import { listApiKeys } from "@/lib/store";

export const dynamic = "force-dynamic";
export async function GET() {
  const cid = currentCustomerId();
  if (!cid) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  return NextResponse.json({ keys: listApiKeys(cid).map(toPublic).reverse() });
}
/** Crea una clave. El secreto solo viaja en esta respuesta (no se puede volver a consultar). */
export async function POST(req: Request) {
  const cid = currentCustomerId();
  if (!cid || !(await billing.get(cid))) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { name } = await req.json().catch(() => ({}));
  try {
    const r = createApiKey(cid, name, billing.mode);
    return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
