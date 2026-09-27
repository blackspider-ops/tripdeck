import { useCrew, useSendGuard, useTripSelector } from "../TripContext";
import { Spyglass } from "./icons";
import { Button, StampButton } from "./ui";

/**
 * Quest-first (docs/03 §4): a headset asks to sit in this seat (Quest Browser → Join a trip → "Is this your seat?").
 * One tap lets it in: it becomes this member's headset (only this member's terms, never anyone else's). Shown over
 * every trip screen while the request is open; it goes away when answered here or elsewhere, or when it expires.
 */
export function HeadsetAsk() {
  const { me } = useCrew();
  const ask = useTripSelector((s) => s.headsetRequest);
  const [sent, answer] = useSendGuard("headset:approve", { reopenOnOk: true });
  if (!ask) return null;
  return (
    <div className="headset-ask" role="alertdialog" aria-label="Let this headset in?">
      <div className="eyebrow"><Spyglass size={18} /> A headset is asking</div>
      <p className="body">Let this headset in as {me?.name ?? ask.memberName}? It will see your sealed terms and can set your seal.</p>
      <div className="row">
        <StampButton block={false} disabled={sent} onClick={() => answer({ requestId: ask.requestId, allow: true })}>Let it in</StampButton>
        <Button disabled={sent} onClick={() => answer({ requestId: ask.requestId, allow: false })}>Not me</Button>
      </div>
      <p className="small">Only say yes if it's you wearing it.</p>
    </div>
  );
}
