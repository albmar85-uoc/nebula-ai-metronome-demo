import { NextResponse } from "next/server";
import { isLive } from "@/lib/billing";
import { demoClock, fastForward, personaAccount, resetDemo, trafficSpike } from "@/lib/demo";
import { PERSONAS, PERSONA_IDS, type PersonaId } from "@/lib/personas";
import { COOKIE, COOKIE_OPTS, currentCustomerId } from "@/lib/session";
import { getAccount, getDemoState } from "@/lib/store";
import { view } from "@/lib/serialize";

// Demo controls for live presentations. Mock mode only: in live mode they would create real Metronome customers
// and move no clock, so the endpoint does not exist there.
export const dynamic = "force-dynamic";
const notFound = () => NextResponse.json({ error: "Demo controls are only available in mock mode" }, { status: 404 });

function state() {
  const s = getDemoState();
  const cid = currentCustomerId();
  return {
    clock: demoClock(),
    current: (PERSONA_IDS.find(id => s.personas[id] && s.personas[id] === cid) ?? null) as PersonaId | null,
    signedIn: !!(cid && getAccount(cid)),
    personas: PERSONA_IDS.map(id => ({ ...PERSONAS[id], seeded: !!(s.personas[id] && getAccount(s.personas[id]!)) })),
  };
}

export function GET() {
  if (isLive()) return notFound();
  return NextResponse.json(state());
}

export async function POST(req: Request) {
  if (isLive()) return notFound();
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");
  try {
    if (action === "reset" || action === "persona") {
      const persona = (body.persona ?? "pro") as PersonaId;
      if (!PERSONAS[persona]) return NextResponse.json({ error: "Unknown persona" }, { status: 400 });
      if (action === "reset") await resetDemo();
      const cid = await personaAccount(persona);
      const p = PERSONAS[persona];
      const res = NextResponse.json({
        summary: action === "reset" ? `Demo data reset. Signed in as ${p.name} (${p.title}).` : `Now signed in as ${p.name} · ${p.title}.`,
        redirect: p.landing, account: view(getAccount(cid)!),
      });
      res.cookies.set(COOKIE, cid, COOKIE_OPTS);
      return res;
    }
    const cid = currentCustomerId();
    if (!cid || !getAccount(cid)) return NextResponse.json({ error: "Pick a persona first (or sign up)" }, { status: 400 });
    if (action === "fast-forward") { const r = fastForward(cid); return NextResponse.json({ ...r, account: view(getAccount(cid)!) }); }
    if (action === "spike") { const r = await trafficSpike(cid); return NextResponse.json({ ...r, account: view(getAccount(cid)!) }); }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
