import { NextResponse } from "next/server";
import { currentCustomerId } from "./session";
import { view } from "./serialize";
import type { Account } from "./billing/types";

export async function withCustomer(fn: (cid: string) => Promise<Account | { account: Account; [k: string]: unknown }>) {
  const cid = currentCustomerId();
  if (!cid) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  try {
    const r = await fn(cid);
    if ("account" in r) { const { account, ...rest } = r; return NextResponse.json({ ...view(account), ...rest }); }
    return NextResponse.json(view(r));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
