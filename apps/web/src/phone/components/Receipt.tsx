import { formatCents, humanShareLabel, type ShareLine } from "@all-ayes/shared";

const GROUPS: { kind: ShareLine["kind"]; title: string }[] = [
  { kind: "flight", title: "Flight" },
  { kind: "lodging", title: "Lodging" },
  { kind: "activity", title: "Experiences" },
];

/** A stable, clearly simulated merchant confirmation code ("SIM-7K2Q4A") from the reference and the line. */
export function simConfirmation(reference: string | undefined, label: string): string {
  let h = 2166136261;
  for (const ch of `${reference ?? ""}|${label}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) { out += alphabet[h % alphabet.length]; h = Math.floor(h / alphabet.length) || Math.imul(h + i + 1, 2654435761) >>> 0; }
  return `SIM-${out}`;
}

const issuedFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

export interface ReceiptProps {
  reference?: string;
  tripName: string;
  dates?: string;
  lines: ShareLine[];
  totalCents: number;
  cardLast4: string;
  mode: "visa_sandbox" | "sim";
  captured: boolean;
  /** "Fri, Feb 19" for an experience, from my itinerary. */
  dateOf?: (name: string) => string | undefined;
  /** "Feb 18 / Feb 21" for the round trip. */
  flightDates?: string;
  issuedAt?: Date;
}

/** P9 "Your receipt": a clean, itemised receipt (only the member themselves ever sees it). */
export function Receipt(p: ReceiptProps) {
  const describe = (l: ShareLine) => {
    const base = humanShareLabel(l.label);
    if (l.kind === "flight" && p.flightDates) return `${base} · ${p.flightDates}`;
    if (l.kind === "activity") { const d = p.dateOf?.(l.label); return d ? `${base} · ${d}` : base; }
    return base;
  };
  const status = p.captured ? "Captured" : "Held";
  const visa = p.mode === "visa_sandbox" ? "Visa sandbox: card verified at seal" : "Simulated payments";
  return (
    <article className="receipt-card" aria-label="Receipt">
      <header className="receipt-head">
        <div className="eyebrow m-0">Your receipt</div>
        <dl className="receipt-meta">
          {p.reference ? <><dt>Booking ref.</dt><dd className="mono">{p.reference}</dd></> : null}
          <dt>Issued</dt><dd>{issuedFmt.format(p.issuedAt ?? new Date())}</dd>
          <dt>Voyage</dt><dd>{p.tripName}{p.dates ? ` · ${p.dates}` : ""}</dd>
        </dl>
      </header>
      {GROUPS.map((g) => {
        const lines = p.lines.filter((l) => l.kind === g.kind);
        if (!lines.length) return null;
        const subtotal = lines.reduce((s, l) => s + l.amountCents, 0);
        return (
          <section key={g.kind} className="receipt-group" aria-label={g.title}>
            <h3 className="receipt-group-title">{g.title}</h3>
            <ul className="receipt-lines" aria-label="Receipt lines">
              {lines.map((l, i) => (
                <li key={i} className="receipt-line">
                  <span className="desc">
                    {describe(l)}
                    <span className="conf">Conf. {simConfirmation(p.reference, l.label)} <i>(simulated)</i></span>
                  </span>
                  <span className="amt">{formatCents(l.amountCents)}</span>
                </li>
              ))}
            </ul>
            {lines.length > 1 ? (
              <p className="receipt-subtotal"><span>{g.title} subtotal</span><span className="amt">{formatCents(subtotal)}</span></p>
            ) : null}
          </section>
        );
      })}
      <p className="receipt-total"><span>Charged to Visa •••• {p.cardLast4}</span><span className="amt">{formatCents(p.totalCents)}</span></p>
      <p className="receipt-status small">{status} · {visa} · holds and charges simulated · no real card charged</p>
      <p className="receipt-privacy small">Only you see your receipt. Your crew sees your seal, never your share or your lines.</p>
    </article>
  );
}
