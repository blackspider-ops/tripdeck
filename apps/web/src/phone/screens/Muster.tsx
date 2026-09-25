import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MAX_CREW, type Band, type CrewPublic } from "@all-ayes/shared";
import { api } from "../../net/api";
import { KEYS, readJSON, writeJSON } from "../../net/storage";
import { useCrew, useTripSelector } from "../TripContext";
import { useAsyncAction } from "../useAsyncAction";
import { inviteView, resetSeat, seatLists } from "../seatClaims";
import { CopyLine, CrewList, QR } from "../components/crew";
import { CrewMemberFields, type CrewMemberDraft } from "../components/CrewMemberFields";
import { Anchor, SealedLetter } from "../components/icons";
import { HeadsetCodeCard, SailWithout, WeighAnchor } from "../components/organizer";
import { Button, Card, Eyebrow, InlineError, LinkButton, Page, StampButton, firstFreeBand } from "../components/ui";

/** P2 — Muster your crew (organizer). */
export default function Muster() {
  const { crew, me, session, isOrganizer } = useCrew();
  const name = useTripSelector((s) => s.trip!.name);
  const joinCode = useTripSelector((s) => s.trip!.joinCode);
  const navigate = useNavigate();
  const joinUrl = `${location.origin}/t/${joinCode}`;
  // TR1-001: the invite links live here, not inside the add-friend form, so filling the crew to 4 (which hides the
  // form) can't take the link with it. Kept for this tab so leaving Muster and coming back still shows them.
  const [invites, keepInvite] = useInvites(session.tripId);
  const [justMade, setJustMade] = useState<string | null>(null);
  // L1-009: every invited seat (absent friends, and seats the organizer reset) — with its link until it's opened,
  // then "opened" (S2-012: the whole crew sees that too) and a way to reset it if it wasn't them
  const { invited, others } = seatLists(crew, me?.memberId);

  return (
    <Page>
      <Eyebrow icon={<Anchor size={18} />}>{name}</Eyebrow>
      <h1 className="h1">Muster your crew</h1>

      <Card label="Invite">
        <div className="qr-wrap">
          <QR value={joinUrl} label={`QR to join voyage ${joinCode}`} />
          <div>
            <div className="small">Code</div>
            <div className="join-code" aria-label={`Code ${joinCode.split("").join(" ")}`}>{joinCode}</div>
            <p className="small">Scan, or type the code at {location.host}/join</p>
          </div>
        </div>
      </Card>

      <Card label="Crew">
        <div className="eyebrow">Crew</div>
        <CrewList crew={crew} meId={me?.memberId} />
        {isOrganizer && session.memberToken ? (
          <>
            {invited.map((c) => (
              <AbsentInvite
                key={c.memberId} friend={c} tripId={session.tripId} token={session.memberToken!} url={invites[c.memberId]}
                open={justMade === c.memberId}
                onUrl={(url) => { keepInvite(c.memberId, url); setJustMade(c.memberId); }}
              />
            ))}
            {others.length ? (
              <SeatReset
                seats={others} tripId={session.tripId} token={session.memberToken}
                onInvite={(memberId, url) => { keepInvite(memberId, url); setJustMade(memberId); }}
              />
            ) : null}
            {crew.length < MAX_CREW ? (
              <AddAbsent
                tripId={session.tripId} token={session.memberToken} taken={crew.map((c) => c.band)}
                onInvite={(memberId, url) => { keepInvite(memberId, url); setJustMade(memberId); }}
              />
            ) : null}
          </>
        ) : null}
      </Card>

      {!me?.briefSealed ? (
        <StampButton onClick={() => navigate(`/t/${joinCode}/brief`)}>
          <SealedLetter size={20} /> Seal my terms
        </StampButton>
      ) : (
        <WeighAnchor />
      )}
      <SailWithout />
      <HeadsetCodeCard />
      {me?.briefSealed ? (
        <div className="center"><LinkButton onClick={() => navigate(`/t/${joinCode}/brief`)}>Re‑read my terms</LinkButton></div>
      ) : null}
    </Page>
  );
}

/** Invite links by member id, for this voyage, kept in sessionStorage (the key itself is only ever stored hashed on the server). */
function useInvites(tripId: string) {
  const key = KEYS.invites(tripId);
  const [invites, set] = useState<Record<string, string>>(() => readJSON<Record<string, string>>(key, "session") ?? {});
  const keep = (memberId: string, url: string) => set((cur) => {
    const next = { ...cur, [memberId]: url };
    writeJSON(key, next, "session"); // private mode: kept in memory for this page
    return next;
  });
  return [invites, keep] as const;
}

/**
 * One invited seat: its link (QR + copy) until the friend opens it. If this phone no longer has it (another tab, a
 * reload in a new tab), the organizer can make a fresh one; the old link then stops working. Once opened (L1-009)
 * the spent link is gone, and if it wasn't the friend who opened it the organizer can reset the seat (S2-012).
 */
function AbsentInvite({ friend, tripId, token, url, open: startOpen, onUrl }: {
  friend: CrewPublic; tripId: string; token: string; url?: string; open: boolean; onUrl: (url: string) => void;
}) {
  const [open, setOpen] = useState(startOpen);
  const { busy, err, run } = useAsyncAction();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { if (startOpen) setOpen(true); }, [startOpen]); // just made: show it straight away

  const reset = () => run(async () => {
    const r = await resetSeat(tripId, token, friend.memberId);
    onUrl(`${location.origin}${r.invitePath}`);
    setConfirming(false);
    setOpen(true);
  }, "Couldn't reset that seat. Try again.");

  const view = inviteView(friend, url);
  if (view === "opened") {
    return (
      <div className="stack mt-m">
        <p className="small">{friend.name} has opened their invite{friend.briefSealed ? " and sealed their terms" : ""}.</p>
        {confirming ? (
          <>
            <p className="small">Only if it wasn't {friend.name}: their seat gets a new link, and whoever opened the old one is signed out.</p>
            <div className="row">
              <LinkButton red disabled={busy} onClick={() => void reset()}>{busy ? "Resetting…" : `Reset ${friend.name}'s seat`}</LinkButton>
              <LinkButton onClick={() => setConfirming(false)}>Cancel</LinkButton>
            </div>
          </>
        ) : (
          <LinkButton onClick={() => setConfirming(true)}>Wasn't {friend.name}?</LinkButton>
        )}
        {err ? <InlineError>{err}</InlineError> : null}
      </div>
    );
  }

  const reissue = () => run(async () => {
    const r = await api.reissueInvite(tripId, token, friend.memberId);
    onUrl(`${location.origin}${r.invitePath}`);
    setOpen(true);
  }, "Couldn't make a new link. Try again.");

  return (
    <div className="stack mt-m">
      {view === "link" && url && open ? (
        <>
          <p className="body">Send this to {friend.name}. It opens their sealed terms directly.</p>
          <div className="qr-wrap"><QR value={url} label={`QR for ${friend.name}'s invite`} /></div>
          <CopyLine text={url} />
          <LinkButton onClick={() => setOpen(false)}>Hide {friend.name}'s link</LinkButton>
        </>
      ) : view === "link" ? (
        <LinkButton onClick={() => setOpen(true)}>Show {friend.name}'s invite link</LinkButton>
      ) : (
        <>
          <p className="small">{friend.name} hasn't opened their invite yet.</p>
          <LinkButton disabled={busy} onClick={() => void reissue()}>{busy ? "Making a new link…" : `Make a new link for ${friend.name}`}</LinkButton>
        </>
      )}
      {err ? <InlineError>{err}</InlineError> : null}
    </div>
  );
}

/**
 * S2-009: a crew member whose seat someone else is using (a shared phone, a leaked link) — the organizer resets it:
 * the seat's token and passkey stop working, and a new link goes to the member to open on their own phone.
 */
function SeatReset({ seats, tripId, token, onInvite }: {
  seats: CrewPublic[]; tripId: string; token: string; onInvite: (memberId: string, url: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [resetting, setResetting] = useState<string | null>(null);
  const { busy, err, run } = useAsyncAction();
  if (!open) return <LinkButton onClick={() => setOpen(true)}>Someone else on a seat?</LinkButton>;
  const reset = (c: CrewPublic) => {
    setResetting(c.memberId);
    void run(async () => {
      const r = await resetSeat(tripId, token, c.memberId);
      onInvite(c.memberId, `${location.origin}${r.invitePath}`);
      setOpen(false);
    }, "Couldn't reset that seat. Try again.");
  };
  return (
    <div className="stack mt-s">
      <p className="small">Resetting a seat signs it out everywhere and makes a new link to send to its owner.</p>
      {seats.map((c) => (
        <LinkButton key={c.memberId} red disabled={busy} onClick={() => reset(c)}>
          {busy && resetting === c.memberId ? "Resetting…" : `Reset ${c.name}'s seat`}
        </LinkButton>
      ))}
      <LinkButton onClick={() => setOpen(false)}>Cancel</LinkButton>
      {err ? <InlineError>{err}</InlineError> : null}
    </div>
  );
}

function AddAbsent({ tripId, token, taken, onInvite }: {
  tripId: string; token: string; taken: Band[]; onInvite: (memberId: string, url: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // (Create defaults the organizer to ATL, JoinCrew a friend to ORD: see Create)
  const [friend, setFriend] = useState<CrewMemberDraft>({ name: "", band: firstFreeBand(taken), origin: "JFK" });
  const { busy, err, run } = useAsyncAction();

  if (!open) return <LinkButton onClick={() => { setFriend((f) => ({ ...f, band: firstFreeBand(taken) })); setOpen(true); }}>+ Add an absent friend</LinkButton>;
  const add = () => run(async () => {
    const r = await api.addAbsent(tripId, token, { name: friend.name.trim(), band: friend.band, origin: friend.origin });
    // Muster holds the link: this form may already be gone (the crew just reached MAX_CREW)
    onInvite(r.memberId, `${location.origin}${r.invitePath}`);
    setFriend((f) => ({ ...f, name: "" })); setOpen(false);
  }, "Couldn't add them. Try again.");
  return (
    <form className="mt-s" onSubmit={(e) => { e.preventDefault(); if (friend.name.trim()) void add(); }}>
      <CrewMemberFields value={friend} onChange={setFriend} taken={taken} whose="their" />
      {err ? <InlineError>{err}</InlineError> : null}
      <div className="row">
        <Button type="submit" disabled={busy || !friend.name.trim()}>Make their invite</Button>
        <LinkButton onClick={() => setOpen(false)}>Cancel</LinkButton>
      </div>
    </form>
  );
}
