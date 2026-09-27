import { useRef, useState } from "react";
import { SEALING_FOOTER, paymentLabelFor, sealSetLine } from "@all-ayes/shared";
import { useCrew, useInlineError, useSendGuard, useTripSelector } from "../TripContext";
import { COUNTDOWN_TICK_MS } from "../timing";
import { useNow } from "../useNow";
import { countdownLabel, windowLabel } from "../format";
import { PASSKEY_COPY, prepareSeal } from "../../net/passkey";
import { AddPasskey } from "../components/AddPasskey";
import { HeadsetControls } from "../components/organizer";
import { FitStamp, LedgerTable } from "../components/money";
import { Dividers, Ledger, WaxSeal } from "../components/icons";
import { SealRow, sealIsSet } from "../components/SealRow";
import { useTwoTap } from "../components/useTwoTap";
import { Card, Eyebrow, LinkButton, MarginNote, Page, Plotting, StampButton } from "../components/ui";
import { PinPad } from "../components/PinPad";


/** P8 — Your share & Seal. The share is private to this phone. */
export default function Seal() {
  // O2-046: the booking, my share and the chart; a turn or a vote doesn't redraw the seal screen
  const { session, isOrganizer, crew, store } = useCrew();
  const booking = useTripSelector((s) => s.booking);
  const mine = useTripSelector((s) => s.sealPrivate);
  // R2-WP-14: dateWindows is a static field (the store keeps it from the join's full snapshot)
  const dateWindows = useTripSelector((s) => s.trip!.dateWindows);
  const plan = useTripSelector((s) => s.shortlist.find((p) => p.planId === s.booking?.planId));
  const resultFor = useTripSelector((s) => s.lastResult?.bookingId ?? null);
  const declined = useTripSelector((s) => s.declined);
  // seal:set stays "sent" once it lands (the seal row moves on); lifting it re-opens Set your seal. A seal set again
  // after a lift clears this phone's "you lifted it" note (the helm sends none: publicly it read "set" all along)
  const [sealSent, sendSeal, { reset: reopenSeal }] = useSendGuard("seal:set", { onOk: () => { if (booking) store.clearDeclined(booking.bookingId); } });
  const [liftSent, sendLift] = useSendGuard("seal:cancel", { reopenOnOk: true });
  // "Lift my seal" asks first: a lifted seal left alone voids the booking for everyone
  const [liftArmed, tapLift] = useTwoTap((bookingId: string) => { if (sendLift({ bookingId })) reopenSeal(); });
  const [callOffSent, sendCallOff] = useSendGuard("booking:callOff");
  // an inline two-tap confirm, not a browser dialog
  const [callOffArmed, tapCallOff] = useTwoTap((bookingId: string) => sendCallOff({ bookingId }));
  // "Call it off" after every seal is set: say why here, under the button, in plain words
  const callOffRefused = useInlineError(["CAPTURING"], isOrganizer, ["booking:callOff"]);

  if (!booking || !mine || mine.bookingId !== booking.bookingId) return <Page><Plotting label="Unrolling your share…" /></Page>;

  const mySeal = booking.seals.find((s) => s.memberId === session.memberId);
  // my own lift (private: publicly a lifted seal still reads "set", S2-001) — I'm told plainly, and can set it again
  const lifted = declined?.bookingId === booking.bookingId && declined.reason === "user_cancelled";
  const status = lifted ? "PENDING" : mySeal?.status ?? "PENDING";
  // Publicly a seal is only "set" (AUTHORIZED on the wire) or not: no one, the owner included, sees an authorization
  // outcome before the booking settles (doc 06 §7, SEC-002). A decline reaches only its owner, privately.
  const waitingOn = booking.seals.filter((s) => !sealIsSet(s)).length;
  const gathering = booking.status === "PENDING" || booking.status === "AUTHORIZING";
  const othersPending = booking.seals.some((s) => s.memberId !== session.memberId && (s.status === "PENDING" || s.status === "AUTHORIZING"));
  // R2-WP-02 (collect, then settle together): once every seal is set, the booking settles and its outcome lands
  // about 2.5 s later (booking:result). Until then say "settling" — the same for every outcome.
  const resulted = resultFor === booking.bookingId;
  const settling = gathering && status !== "PENDING" && waitingOn === 0 && !resulted;

  const statusLine =
    settling ? <><Dividers size={18} /> Every seal is set · settling…</>
    : status === "AUTHORIZING" ? <><Dividers size={18} /> Seal set · authorizing…</>
    : status === "AUTHORIZED" ? <><WaxSeal size={18} /> {waitingOn ? `Waiting on ${waitingOn} seal${waitingOn === 1 ? "" : "s"}` : "Settling…"}</>
    : status === "CAPTURED" ? <>Logged.</>
    : null;

  return (
    <Page>
      <Eyebrow icon={<Ledger size={18} />}>Your share{plan ? ` — ${plan.cityName}` : ""}</Eyebrow>
      {plan ? <p className="small">{windowLabel(dateWindows, plan.dateWindowId, { year: true })} · {plan.hotelName}</p> : null}

      <Card label="Your share">
        <LedgerTable lines={mine.lines} />
        <div className="mt-s"><FitStamp fits={mine.fits} /></div>
        <p className="small mono mt-s">Visa •••• {mine.cardLast4} (agent card, capped)</p>
        <p className="body">Paid by your mate's card, capped at your terms. {SEALING_FOOTER}</p>
        <p className="small">{paymentLabelFor(mine.mode)}</p>
      </Card>

      {lifted && gathering ? (
        <div className="margin-note" role="status" aria-live="polite">
          <p className="body"><b>You lifted your seal.</b> If you don't set it again before the timer, nobody is booked.</p>
        </div>
      ) : null}
      {status === "PENDING" && (!lifted || (gathering && !settling)) ? (
        <SealAction bookingId={booking.bookingId} sent={sealSent} send={sendSeal} again={lifted} />
      ) : (
        <>
          {status === "AUTHORIZED" || status === "AUTHORIZING" ? (
            <div className="margin-note" role="status" aria-label="Seal confirmation">
              <p className="body"><b>{sealSetLine(mine.amountCents, mine.cardLast4)}</b></p>
            </div>
          ) : null}
          <p className="body row" role="status" aria-live="polite">{statusLine}</p>
        </>
      )}

      <Card label="The crew's seals">
        <div className="eyebrow">Seals</div>
        <SealRow booking={booking} crew={crew} />
        {gathering && waitingOn > 0 && booking.sealDeadlineAt ? <SealCountdown deadline={booking.sealDeadlineAt} /> : null}
        <p className="small">If not every seal is set in time, the booking is called off and nobody is charged.</p>
      </Card>

      {/* secondary, away from the status line, and it asks first (a lifted seal voids the booking for everyone) */}
      {!lifted && (status === "AUTHORIZED" || status === "AUTHORIZING") && othersPending ? (
        <div className="center">
          <LinkButton red disabled={liftSent} onClick={() => tapLift(booking.bookingId)}>{liftArmed ? "Yes, lift my seal" : "Lift my seal"}</LinkButton>
          {liftArmed ? <p className="small">Lift your seal? If you don't set it again before the timer, nobody is booked.</p> : null}
        </div>
      ) : null}

      {/* settling: too late to call it off (the helm would answer CAPTURING), so the button goes */}
      {isOrganizer && gathering && !settling ? (
        <div className="center">
          <LinkButton red disabled={callOffSent} onClick={() => tapCallOff(booking.bookingId)}>
            {callOffSent ? "Calling it off…" : callOffArmed ? "Tap again to call it off" : "Call it off"}
          </LinkButton>
          {callOffArmed ? <p className="small">Every hold is lifted and nobody is charged.</p> : null}
        </div>
      ) : null}
      {isOrganizer && callOffRefused.note ? <MarginNote onClear={callOffRefused.clear}>{callOffRefused.note}</MarginNote> : null}
      {/* L1-006: the organizer keeps the headset code and "Unpair headset" while the seals gather */}
      <HeadsetControls />
    </Page>
  );
}

/**
 * O2-021: "Set your seal" with its passkey step. LIVE-001: never registers a passkey; no passkey on file → the
 * confirm tap seals. A cancelled or failed Face ID prompt is a note, never a seal (L1-001). An unreachable passkey
 * service → confirm tap, and the server answers PASSKEY_REQUIRED if a passkey is on file (note below).
 */
function SealAction({ bookingId, sent, send, again = false }: {
  bookingId: string; sent: boolean; send: (body: { bookingId: string; assertionToken?: string; pin?: string }) => boolean; again?: boolean;
}) {
  const { session } = useCrew();
  const [approving, setApproving] = useState(false);
  const approvingRef = useRef(false); // one passkey prompt per tap, even on a fast double tap
  const [note, setNote] = useState<{ text: string; addHere?: boolean } | null>(null);
  // L1-004 / O2-026: a PASSKEY_REQUIRED refusal shows once, here, and the shell banner is cleared
  const passkeyRefused = useInlineError(["PASSKEY_REQUIRED"]);
  // Quest-first: a seal PIN (set on a headset) — asked for here when there's no passkey on this phone
  const [askPin, setAskPin] = useState(false);
  const pinRefused = useInlineError(["BAD_PIN", "PIN_LOCKED", "PIN_REQUIRED"], true, ["seal:set"]);

  async function setSeal() {
    if (approvingRef.current || sent) return;
    approvingRef.current = true;
    setApproving(true); setNote(null); passkeyRefused.clear();
    try {
      const step = await prepareSeal(session.tripId, session.memberToken, bookingId);
      if (step.kind === "note") { setNote({ text: step.message, addHere: step.addHere }); return; }
      if (step.kind === "pin") { setAskPin(true); return; }
      send({ bookingId, assertionToken: step.assertionToken });
    } finally {
      approvingRef.current = false;
      setApproving(false);
    }
  }

  if (askPin || pinRefused.code === "PIN_REQUIRED") {
    return (
      <>
        <PinPad label="Enter your seal PIN" busy={sent} onDone={(pin) => { pinRefused.clear(); send({ bookingId, pin }); }} />
        {pinRefused.note && pinRefused.code !== "PIN_REQUIRED" ? <MarginNote onClear={pinRefused.clear}>{pinRefused.note}</MarginNote> : null}
      </>
    );
  }

  return (
    <>
      <StampButton onClick={() => void setSeal()} disabled={approving || sent}>
        <WaxSeal size={20} /> {approving ? "Checking your passkey…" : sent ? "Setting your seal…" : again ? "Set my seal again" : "Set your seal"}
      </StampButton>
      <p className="small center">If you added a passkey, approve with Face ID or Touch ID. Otherwise this tap sets it.</p>
      {note ? <MarginNote onClear={() => setNote(null)}>{note.text}</MarginNote>
        : passkeyRefused.note ? <MarginNote onClear={passkeyRefused.clear}>{PASSKEY_COPY.required}</MarginNote> : null}
      {note?.addHere ? (
        <AddPasskey tripId={session.tripId} memberToken={session.memberToken}
          lead="You can add a passkey on this phone too. Then tap Set your seal again." onAdded={() => setNote(null)} />
      ) : null}
    </>
  );
}

/**
 * WP-04 (SEC-011): "Seals close in 9:41", ticking once a second on its own so the screen doesn't redraw.
 * The store maps the deadline onto this phone's clock with the server's `serverNow`, so a skewed phone still counts right.
 */
function SealCountdown({ deadline }: { deadline: string }) {
  const at = Date.parse(deadline);
  const now = useNow(COUNTDOWN_TICK_MS, at > Date.now()); // stops once the seals have closed
  const left = at - now;
  if (Number.isNaN(at)) return null;
  return (
    <p className="small mono" role="timer" aria-live="off">
      {left > 0 ? `Seals close in ${countdownLabel(left)}` : "Seals are closing…"}
    </p>
  );
}
