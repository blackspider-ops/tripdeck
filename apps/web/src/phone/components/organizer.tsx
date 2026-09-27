import { useEffect, useMemo, useState } from "react";
import { MIN_TABLE_CREW, waitingOnTerms } from "@all-ayes/shared";
import { api } from "../../net/api";
import { KEYS, readJSON, removeKey, writeJSON } from "../../net/storage";
import { useCrew, useSendGuard, useTripSelector } from "../TripContext";
import { errorCopy } from "../errors";
import { useAsyncAction } from "../useAsyncAction";
import { SAIL_WITHOUT_AFTER_MS, SAIL_WITHOUT_TICK_MS } from "../timing";
import { useNow } from "../useNow";
import { useTwoTap } from "./useTwoTap";
import { Anchor, Spyglass } from "./icons";
import { Button, Card, InlineError, LinkButton, StampButton } from "./ui";

/** "Weigh anchor" — starts the table once every Brief is sealed and there are at least two aboard (organizer only). */
export function WeighAnchor() {
  const { crew, isOrganizer } = useCrew();
  const [sent, sendStart] = useSendGuard("table:start");
  if (!isOrganizer || !crew.length) return null;
  const allSealed = crew.every((c) => c.briefSealed);
  // TR1-006: the helm refuses a table of one (TOO_FEW); say so instead of offering the button
  const enough = crew.length >= MIN_TABLE_CREW;
  const pending = crew.filter((c) => !c.briefSealed).map((c) => c.name);
  return (
    <div className="stack">
      <StampButton disabled={!allSealed || !enough || sent} onClick={() => sendStart({})}>
        <Anchor size={20} /> Weigh anchor
      </StampButton>
      {!allSealed ? <p className="small center">{waitingOnTerms(pending)}</p>
        : !enough ? <p className="small center">{errorCopy({ code: "TOO_FEW", message: "" })}</p> : null}
    </div>
  );
}

/** Pair the Quest: shows an 8-character headset code to type at <origin>/xr (doc 03 P5), and unpairs it (SEC-018). */
export function HeadsetCodeCard() {
  const { session, isOrganizer } = useCrew();
  const [code, setCode] = useState<string | null>(null);
  const { busy, err, run } = useAsyncAction();
  if (!isOrganizer) return null;
  const host = typeof location !== "undefined" ? `${location.host}/xr/code` : "/xr/code";
  return (
    <Card label="Open on the headset">
      <div className="eyebrow"><Spyglass size={18} /> Open on the headset</div>
      {code ? (
        <>
          <p className="body">In Quest Browser go to <span className="mono">{host}</span> and type:</p>
          <div className="join-code center" aria-label={`Headset code ${code.split("").join(" ")}`}>{code}</div>
          <p className="small">The headset gets the controls, never anyone's terms or shares. Code works once, for 10 minutes.</p>
          <LinkButton onClick={() => setCode(null)}>Hide code</LinkButton>
        </>
      ) : (
        <>
          <p className="small">A shared headset for the table. To make a Quest your own seat instead, open {typeof location !== "undefined" ? location.host : ""}/xr on it and choose Join a trip.</p>
          <Button
            block disabled={busy || !session.memberToken} onClick={() => void run(async () => {
              setCode((await api.headsetCode(session.tripId, session.memberToken!)).code);
            }, "Couldn't get a code. Try again.")}
          >
            Show headset code
          </Button>
        </>
      )}
      {err ? <InlineError>{err}</InlineError> : null}
      <UnpairHeadset onUnpaired={() => setCode(null)} />
    </Card>
  );
}

/**
 * L1-006: after the table meets (Table, Dry Run, Seal) the organizer can still show a fresh headset code (a swapped
 * Quest, an expired code) or unpair the headset — behind a quiet link, so it doesn't crowd those screens.
 */
export function HeadsetControls() {
  const { isOrganizer } = useCrew();
  const [open, setOpen] = useState(false);
  if (!isOrganizer) return null;
  if (open) {
    return (
      <div className="stack">
        <HeadsetCodeCard />
        <div className="center"><LinkButton onClick={() => setOpen(false)}>Hide headset</LinkButton></div>
      </div>
    );
  }
  return <div className="center"><LinkButton onClick={() => setOpen(true)}>Headset code or unpair</LinkButton></div>;
}

/** SEC-018 / WP-06 follow-up: revoke the paired headset (and any pending code). Organizer phone only. */
function UnpairHeadset({ onUnpaired }: { onUnpaired: () => void }) {
  const { session } = useCrew();
  const [done, setDone] = useState(false);
  const { busy, err, run } = useAsyncAction();
  const [armed, tap] = useTwoTap(() => {
    if (!session.memberToken) return;
    setDone(false);
    void run(async () => {
      await api.unpairHeadset(session.tripId, session.memberToken!);
      setDone(true);
      onUnpaired();
    }, "Couldn't unpair the headset. Try again.");
  });
  return (
    <div className="mt-s">
      {done ? <p className="small" role="status">Headset unpaired. It needs a fresh code to open this voyage again.</p> : null}
      <LinkButton red disabled={busy || !session.memberToken} onClick={() => tap()}>
        {busy ? "Unpairing…" : armed ? "Tap again to unpair the headset" : "Unpair headset"}
      </LinkButton>
      {err ? <InlineError>{err}</InlineError> : null}
    </div>
  );
}

/**
 * SEC-010: the voyage code is on the gallery, QR codes and screenshots, so the organizer can close the crew once
 * everyone is aboard. Joins after the table meets are refused anyway; absent-friend invites still work.
 */
export function CrewDoor() {
  const closed = useTripSelector((s) => !!s.trip?.crewClosed);
  // O2-029: one tap, one toggle (a double tap no longer closes and reopens it); open again once the helm answers
  const [sent, setOpen] = useSendGuard("crew:setOpen", { reopenOnOk: true });
  return (
    <div className="log-column pt-0">
      <p className="small">
        {closed ? "The crew is closed: the voyage code no longer lets anyone join." : "Anyone with the voyage code can join until the table meets."}
      </p>
      <LinkButton disabled={sent} onClick={() => setOpen({ open: closed })}>{closed ? "Reopen the crew" : "Close the crew"}</LinkButton>
    </div>
  );
}


/**
 * TR1-007: when this phone first saw each unsealed crew member, kept per voyage (KEYS.unsealedSince) so moving
 * between screens or reloading doesn't restart the 2 minutes. (A server timestamp would also survive a device
 * change.) O2-047: read during render, written in an effect; O2-017: the key goes once everyone has sealed.
 */
function useUnsealedSince(tripId: string, unsealedIds: string[], crewLoaded: boolean, active: boolean): Record<string, number> {
  const key = KEYS.unsealedSince(tripId);
  const ids = unsealedIds.join(",");
  const since = useMemo(() => {
    const seen = active ? readJSON<Record<string, number>>(key) ?? {} : {};
    const now = Date.now();
    const next: Record<string, number> = {};
    for (const id of ids ? ids.split(",") : []) next[id] = typeof seen[id] === "number" ? seen[id] : now;
    return next;
  }, [key, ids, active]);
  useEffect(() => {
    // (not before the trip loads, so an empty crew never wipes the clock)
    if (!active || !crewLoaded) return;
    if (ids) writeJSON(key, since); else removeKey(key);
  }, [key, ids, since, active, crewLoaded]);
  return since;
}

/** After 2 minutes unsealed, the organizer can sail without that friend (doc 03 §6). */
export function SailWithout() {
  const { session, crew, isOrganizer } = useCrew();
  const organizerId = useTripSelector((s) => s.trip?.organizerId);
  // re-opens once the helm answers, so a friend who goes overdue later can be left behind too
  const [sent, sendSailWithout] = useSendGuard("table:sailWithout", { reopenOnOk: true });
  const unsealed = crew.filter((c) => !c.briefSealed && c.memberId !== organizerId);
  const waiting = isOrganizer && unsealed.length > 0;
  const since = useUnsealedSince(session.tripId, unsealed.map((c) => c.memberId), crew.length > 0, isOrganizer);
  const now = useNow(SAIL_WITHOUT_TICK_MS, waiting);
  if (!waiting) return null;
  const overdue = unsealed.filter((c) => now - since[c.memberId] >= SAIL_WITHOUT_AFTER_MS);
  if (!overdue.length) return null;
  return (
    <div className="stack">
      <p className="small">Still waiting on {overdue.map((c) => c.name).join(", ")}. You can sail without them; they won't travel or be charged.</p>
      <LinkButton red disabled={sent} onClick={() => sendSailWithout({ memberIds: overdue.map((c) => c.memberId) })}>
        Sail without them
      </LinkButton>
    </div>
  );
}
