import { useNavigate } from "react-router-dom";
import { BACK_TO_CHARTS, VOID_HEADLINE, type DeclineReason } from "@all-ayes/shared";
import { useCrew, useInlineError, useSendGuard, useTripSelector } from "../TripContext";
import { BrokenSeal } from "../components/icons";
import { BrokenSealArt } from "../components/illustrations";
import { SealRow } from "../components/SealRow";
import { Card, Eyebrow, LinkButton, MarginNote, Page, StampButton } from "../components/ui";

// Owner-only copy per decline reason (docs/06-payments-spec.md §7).
const REASON: Record<DeclineReason, string> = {
  over_limit: "Your seal didn't clear: that share is over your agent card's limit.",
  user_cancelled: "You lifted your seal, so nobody was charged.",
  timeout: "The card network didn't answer in time.",
  provider_error: "The card network had a problem.",
};

/** P10 — Voided: nobody was charged. */
export default function Voided() {
  // O2-046: the booking and its outcome only
  const { crew, isOrganizer } = useCrew();
  const navigate = useNavigate();
  const tripName = useTripSelector((s) => s.trip!.name);
  const joinCode = useTripSelector((s) => s.trip!.joinCode);
  const booking = useTripSelector((s) => s.booking);
  const declined = useTripSelector((s) => s.declined);
  const lastResult = useTripSelector((s) => s.lastResult);
  const [sent, sendRetry] = useSendGuard("booking:retry");
  // "Back to the charts" while a refund from this attempt is still unresolved: explain it by the button
  const retryRefused = useInlineError(["NEEDS_ATTENTION"], isOrganizer, ["booking:retry"]);
  const mine = declined && booking && declined.bookingId === booking.bookingId ? declined : null;
  // The server says why (a share didn't clear, the deadline passed, the organizer called it off, or a capture
  // failed and was refunded — docs/06 §7); the classic line is the fallback.
  const result = lastResult && (!booking || lastResult.bookingId === booking.bookingId) ? lastResult : null;
  const headline = result?.publicReason || VOID_HEADLINE;

  return (
    <Page>
      <Eyebrow icon={<BrokenSeal size={18} />}>{tripName}</Eyebrow>
      <BrokenSealArt />
      <h1 className="h1 center">{headline}</h1>
      {mine ? <p className="body center red">{REASON[mine.reason]}</p> : null}
      <p className="body center">Try again when ready.</p>

      {booking ? (
        <Card label="Seals">
          <div className="eyebrow">Every hold was lifted</div>
          <SealRow booking={booking} crew={crew} />
        </Card>
      ) : null}

      {isOrganizer ? (
        <>
          <StampButton disabled={sent} onClick={() => { retryRefused.clear(); sendRetry({}); }}>{BACK_TO_CHARTS}</StampButton>
          {retryRefused.note ? <MarginNote onClear={retryRefused.clear}>{retryRefused.note}</MarginNote> : null}
        </>
      ) : (
        <p className="small center">The organizer chooses what's next: back to the charts, or new terms for everyone.</p>
      )}
      {/* L4-002 (R2-WP-10): only the organizer's new terms reopen the briefing (a member's re-seal is BAD_PHASE) */}
      {isOrganizer ? (
        <div className="center">
          <LinkButton onClick={() => navigate(`/t/${joinCode}/brief`)}>Adjust my terms</LinkButton>
        </div>
      ) : null}
    </Page>
  );
}
