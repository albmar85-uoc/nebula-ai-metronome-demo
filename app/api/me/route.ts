import { NextResponse } from "next/server";
import { billing } from "@/lib/billing";
import { COOKIE, currentCustomerId } from "@/lib/session";
import { view } from "@/lib/serialize";

export const dynamic = "force-dynamic";
export async function GET() {
  const cid = currentCustomerId();
  const a = cid ? await billing.get(cid) : null;
  if (!a) return NextResponse.json({ error: "Sin sesión" }, { status: 401 });
  return NextResponse.json(view(a));
}
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(COOKIE);
  return res;
}
