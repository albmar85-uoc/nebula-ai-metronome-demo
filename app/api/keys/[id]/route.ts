import { NextResponse } from "next/server";
import { revokeApiKey } from "@/lib/apikeys";
import { currentCustomerId } from "@/lib/session";

/** Revoca una clave propia (deja de autenticar al momento; el registro se conserva para auditoría). */
export async function DELETE(_: Request, { params }: { params: { id: string } }) {
  const cid = currentCustomerId();
  if (!cid) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  try { return NextResponse.json({ key: revokeApiKey(cid, params.id) }); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 404 }); }
}
