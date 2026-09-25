import { useEffect, useState } from "react";
import { addPasskey, passkeyAvailability } from "../../net/passkey";
import { LinkButton, MarginNote } from "./ui";

/**
 * LIVE-001: "Add a passkey" is an explicit, optional action somewhere calm (the Wait screen), never part of
 * "Set your seal". It only registers; it never sets a seal. Shown only on phones that can hold a passkey.
 * `lead` replaces the explanation (Seal uses it when the passkey on file lives on another address).
 */
export function AddPasskey({ tripId, memberToken, lead, onAdded }: {
  tripId: string; memberToken?: string; lead?: string; onAdded?: () => void;
}) {
  const [phase, setPhase] = useState<"hidden" | "offer" | "adding" | "added">("hidden");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!memberToken) return;
    let live = true;
    passkeyAvailability(tripId, memberToken)
      .then((a) => { if (live) setPhase(a.registered ? "added" : a.canAdd ? "offer" : "hidden"); })
      .catch(() => { /* status unreachable: offer nothing */ });
    return () => { live = false; };
  }, [tripId, memberToken]);

  if (!memberToken || phase === "hidden") return null;
  if (phase === "added") {
    return <p className="small center" role="status">Passkey added. Your seal will ask for Face ID or Touch ID.</p>;
  }

  async function add() {
    if (!memberToken || phase === "adding") return;
    setPhase("adding"); setNote(null);
    const r = await addPasskey(tripId, memberToken).catch(() => ({ kind: "cancelled" as const, message: "Couldn't reach the helm. Try again." }));
    if (r.kind === "added") { setPhase("added"); onAdded?.(); return; }
    setPhase("offer"); setNote(r.message);
  }

  return (
    <div className="center">
      <LinkButton onClick={() => void add()} disabled={phase === "adding"}>
        {phase === "adding" ? "Adding your passkey…" : "Add a passkey"}
      </LinkButton>
      <p className="small">{lead ?? "Optional. With one, you'll approve your seal with Face ID or Touch ID, and every seal will ask for it."}</p>
      {note ? <MarginNote onClear={() => setNote(null)}>{note}</MarginNote> : null}
    </div>
  );
}
