import { memo, useEffect, useState } from "react";
import { BANDS, PALETTE, type CrewPublic } from "@all-ayes/shared";
import { COPIED_MS } from "../timing";
import { Hourglass, WaxSeal } from "./icons";

export const CrewList = memo(function CrewList({ crew, meId, mode = "brief" }: { crew: CrewPublic[]; meId?: string; mode?: "brief" | "plain" }) {
  if (!crew.length) return <p className="small">Nobody's aboard yet. Share the code.</p>;
  return (
    <ul className="crew" aria-label="Crew">
      {crew.map((c) => (
        <li key={c.memberId}>
          <span className="band-dot" style={{ background: BANDS[c.band].hex }} aria-hidden />
          <span className="who">
            {c.name}
            {c.memberId === meId ? <span className="small"> (you)</span> : null}
            {c.role === "absent" ? <span className="small"> (away{c.inviteOpen ? ", opened their invite" : ""})</span> : null}
            {c.role === "organizer" && c.memberId !== meId ? <span className="small"> · organizer</span> : null}
          </span>
          {mode === "brief" ? (
            c.briefSealed ? (
              <span className="status sealed"><WaxSeal size={18} /> sealed</span>
            ) : (
              <span className="status"><Hourglass size={18} /> unsealed</span>
            )
          ) : null}
        </li>
      ))}
    </ul>
  );
});

/** QR drawn in ink on chart paper (no default black/white). */
export function QR({ value, size = 132, label }: { value: string; size?: number; label: string }) {
  const [src, setSrc] = useState<string>("");
  useEffect(() => {
    let alive = true;
    // always ink on light chart paper, dark mode or not, so the code still scans (O2-029: from PALETTE)
    // OPT-056: qrcode loads only where a QR is drawn (Muster, Demo), not with CrewList on every trip screen
    import("qrcode").then(({ default: QRCode }) => QRCode.toDataURL(value, { margin: 1, width: size * 2, color: { dark: PALETTE.ink, light: PALETTE.paper }, errorCorrectionLevel: "M" }))
      .then((u) => alive && setSrc(u))
      .catch(() => alive && setSrc(""));
    return () => { alive = false; };
  }, [value, size]);
  return src ? <img src={src} width={size} height={size} alt={label} /> : <div style={{ width: size, height: size }} aria-label={label} />;
}

export function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-line">
      <code>{text}</code>
      <button
        type="button" className="link" onClick={async () => {
          try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), COPIED_MS); } catch { /* ignore */ }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
