import { logAdmin, withAdmin } from "@/lib/admin";
import { billing } from "@/lib/billing";

// Archive a demo customer (Metronome POST /v1/customers/archive in live mode). Only names starting with "Nebula demo":
// Metronome Trial accounts allow 5 active customers, so unused demo customers must be archived to sign up new ones.
export async function POST(_: Request, { params }: { params: { id: string } }) {
  return withAdmin(async () => {
    const r = await billing.archiveDemoCustomer(params.id);
    logAdmin(params.id, "archive_demo_customer", `Archived "${r.archived}"`);
    return { archived: true, name: r.archived };
  });
}
