import { useNavigate } from "react-router-dom";
import { waitingOnTerms } from "@all-ayes/shared";
import { useCrew, useTripSelector } from "../TripContext";
import { AddPasskey } from "../components/AddPasskey";
import { CrewList } from "../components/crew";
import { Hourglass, WaxSeal } from "../components/icons";
import { SealedLetterArt } from "../components/illustrations";
import { Card, Eyebrow, LinkButton, Page } from "../components/ui";

/**
 * P5 — Sealed, waiting for the rest of the crew. Crew only: the sealed organizer stays on Muster, which carries
 * Weigh anchor, Sail without them and the headset code (TR1-007 removed the unreachable organizer copy here).
 */
export default function Wait() {
  // O2-046: the crew and the voyage's name only
  const { crew, me, session } = useCrew();
  const navigate = useNavigate();
  const tripName = useTripSelector((s) => s.trip!.name);
  const joinCode = useTripSelector((s) => s.trip!.joinCode);
  const pending = crew.filter((c) => !c.briefSealed);
  return (
    <Page>
      <Eyebrow icon={<WaxSeal size={18} />}>{tripName}</Eyebrow>
      <SealedLetterArt />
      <h1 className="h1 center">Sealed.</h1>
      <p className="body center">Your terms stay sealed. Only your mate knows what you can do.</p>
      <Card label="Crew">
        <CrewList crew={crew} meId={me?.memberId} />
        <p className="small row mt-s">
          {pending.length ? (<><Hourglass size={16} /> {waitingOnTerms(pending.map((c) => c.name))}</>) : "Everyone has sealed. The table meets soon."}
        </p>
      </Card>
      <div className="center"><LinkButton onClick={() => navigate(`/t/${joinCode}/brief`)}>Re‑read my terms</LinkButton></div>
      {/* LIVE-001: setting up a passkey is optional and happens here, never inside "Set your seal" */}
      <AddPasskey tripId={session.tripId} memberToken={session.memberToken} />
    </Page>
  );
}
