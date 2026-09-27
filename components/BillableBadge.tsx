import { UNBILLABLE_LABEL, UNBILLABLE_TOOLTIP, type Invoice } from "@/lib/billing/types";

/** "Not sent to Stripe" badge for invoices Metronome marked billable_status = "unbillable". */
export function UnbillableBadge({ invoice }: { invoice: Pick<Invoice, "billableStatus"> }) {
  if (invoice.billableStatus !== "unbillable") return null;
  return (
    <span className="badge" title={UNBILLABLE_TOOLTIP} data-testid="unbillable">
      {UNBILLABLE_LABEL}<span className="sr-only">. {UNBILLABLE_TOOLTIP}</span>
    </span>
  );
}
