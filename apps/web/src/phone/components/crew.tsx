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

/**
 * OPT-056: qrcode loads only where a QR is drawn (Muster, Demo), not with CrewList on every trip screen. A failed
 * lazy import (a dev dependency re-optimized under a new hash, a chunk gone after a deploy, a flaky network) is
 * retried once; a module that keeps failing isn't cached, so the next QR tries again.
 */
let qrModule: Promise<typeof import("qrcode")> | null = null;
export function loadQrcode(): Promise<typeof import("qrcode")> {
  qrModule ??= import("qrcode")
    .catch(() => new Promise<void>((r) => setTimeout(r, QR_RETRY_MS)).then(() => import("qrcode")))
    .catch((e) => { qrModule = null; throw e; });
  return qrModule;
}
const QR_RETRY_MS = 400;

/** QR drawn in ink on chart paper (no default black/white). If it can't be drawn, says so (the link is beside it). */
export function QR({ value, size = 132, label }: { value: string; size?: number; label: string }) {
  const [src, setSrc] = useState<string>("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    // always ink on light chart paper, dark mode or not, so the code still scans (O2-029: from PALETTE)
    loadQrcode()
      .then((mod) => {
        // the CommonJS package comes through as the default export (bundled) or as the namespace itself
        const QRCode = (mod as { default?: typeof mod }).default ?? mod;
        return QRCode.toDataURL(value, { margin: 1, width: size * 2, color: { dark: PALETTE.ink, light: PALETTE.paper }, errorCorrectionLevel: "M" });
      })
      .then((u) => { if (alive) setSrc(u); })
      .catch(() => { if (alive) { setSrc(""); setFailed(true); } });
    return () => { alive = false; };
  }, [value, size]);
  if (src) return <img src={src} width={size} height={size} alt={label} />;
  return (
    <div className="qr-empty" style={{ width: size, height: size, display: "grid", placeItems: "center", textAlign: "center" }} role="img" aria-label={label} aria-busy={!failed}>
      {failed ? <span className="small">QR didn't load. Use the link.</span> : null}
    </div>
  );
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
