import { formatCents, type ShareLine } from "@all-ayes/shared";

export function LedgerTable({ lines, totalLabel = "Your share" }: { lines: ShareLine[]; totalLabel?: string }) {
  const total = lines.reduce((s, l) => s + l.amountCents, 0);
  return (
    <table className="ledger">
      <tbody>
        {lines.map((l, i) => (
          <tr key={i}>
            <td>{l.label}</td>
            <td className="amt">{formatCents(l.amountCents)}</td>
          </tr>
        ))}
        <tr className="total">
          <td>{totalLabel}</td>
          <td className="amt">{formatCents(total)}</td>
        </tr>
      </tbody>
    </table>
  );
}

export function FitStamp({ fits }: { fits: boolean }) {
  return fits
    ? <span className="stamp-mark ok">Fits your terms ✓</span>
    : <span className="stamp-mark over">Over your terms ✗</span>;
}
