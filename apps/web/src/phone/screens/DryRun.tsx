import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DRYRUN_DAY1_LABEL, minToClock, formatDollars, type MyScheduleItem, type PlanPublic, type PlanPrivate } from "@all-ayes/shared";
import type { TripStore } from "../../net/tripStore";
import { useCrew, useSendGuard, useTripSelector } from "../TripContext";
import { COUNTDOWN_TICK_MS, DRYRUN_TICK_MS } from "../timing";
import { useNow } from "../useNow";
import { FitStamp } from "../components/money";
import { HeadsetControls } from "../components/organizer";
import { Cloche, WaxSeal } from "../components/icons";
import { Button, Card, Eyebrow, Page, Plotting, StampButton } from "../components/ui";

/**
 * O2-047: one ticker per store, shared by everything that shows the Dry Run's in-trip minute (the clock and the
 * timeline), running only while the day actually runs (paused or finished, it stops). Subscribers see the whole
 * minute, so they re-render once per minute change, not four times a second (OPT-048).
 */
class MinuteTicker {
  private subs = new Set<() => void>();
  private id: number | undefined;
  private offStore: (() => void) | undefined;
  constructor(private store: TripStore) {}

  subscribe = (cb: () => void) => {
    this.subs.add(cb);
    if (this.subs.size === 1) this.offStore = this.store.subscribe(this.sync);
    this.sync();
    return () => {
      this.subs.delete(cb);
      if (this.subs.size) return;
      this.offStore?.();
      this.stop();
    };
  };

  /** The whole in-trip minute, or null before the script arrives. */
  minute = () => {
    const m = this.store.dryrunMinute();
    return m === null ? null : Math.floor(m);
  };

  private running() {
    const d = this.store.state.dryrun;
    return !!d && d.pausedAt === null && (this.store.dryrunMinute() ?? 0) < d.dayEndMin;
  }

  private sync = () => {
    if (this.running()) { if (this.id === undefined) this.id = window.setInterval(this.tick, DRYRUN_TICK_MS); } else this.stop();
    for (const s of this.subs) s();
  };

  private tick = () => {
    if (!this.running()) this.stop();
    for (const s of this.subs) s();
  };

  private stop() {
    if (this.id !== undefined) window.clearInterval(this.id);
    this.id = undefined;
  }
}
const tickers = new WeakMap<TripStore, MinuteTicker>();

function useDryrunMinute(): number | null {
  const { store } = useCrew();
  let t = tickers.get(store);
  if (!t) tickers.set(store, (t = new MinuteTicker(store)));
  return useSyncExternalStore(t.subscribe, t.minute);
}

function DryRunClock() {
  const minute = useDryrunMinute();
  return <span className="clock" aria-label="Trip clock">{DRYRUN_DAY1_LABEL} · {minute === null ? "—" : minToClock(minute)}</span>;
}

/** P7 — Dry Run: the two charts side by side, private fit, a live timeline, votes. */
export default function DryRun() {
  // O2-046: the charts, my stamps and the votes; a voice or an error elsewhere doesn't redraw the screen
  const { store, isOrganizer } = useCrew();
  const shortlist = useTripSelector((s) => s.shortlist);
  const planPrivate = useTripSelector((s) => s.planPrivate);
  const votes = useTripSelector((s) => s.votes);
  const autoPick = useTripSelector((s) => s.autoPick);
  const serverVote = useTripSelector((s) => s.myVote);
  const [selected, setSelected] = useState<string | null>(null);
  // optimistic tap, then the helm's private echo (plan:myVote), which also restores it after a reload.
  // L1-003: the tap only holds until the helm answers (ok or refused); then plan:myVote is the truth, so a refused
  // vote springs back and a vote cast from this member's other phone shows here. Only the latest tap's answer counts.
  const [tapped, setMyVote] = useState<string | null>(null);
  const voteSeq = useRef(0);
  const myVote = tapped ?? serverVote;
  const vote = (planId: string) => {
    const id = ++voteSeq.current;
    setMyVote(planId);
    store.emit("plan:vote", { planId }, () => { if (voteSeq.current === id) setMyVote(null); });
  };
  const [picked, sendPick] = useSendGuard("plan:pick");

  useEffect(() => {
    if (!selected && shortlist.length) setSelected(shortlist[shortlist.length > 1 ? 1 : 0].planId);
  }, [shortlist, selected]);

  if (!shortlist.length) return <Page><Plotting label="Unrolling the charts…" /></Page>;

  const plan = shortlist.find((p) => p.planId === selected) ?? shortlist[0];
  const mine = planPrivate[plan.planId];

  return (
    <Page>
      <div className="row spread">
        <Eyebrow icon={<Cloche size={18} />}>Dry run</Eyebrow>
        <DryRunClock />
      </div>
      <p className="small">Watch both trips play out before anyone pays. Your stamps are private.</p>

      <div className="charts2" role="group" aria-label="The two charts">
        {shortlist.map((p) => (
          <ChartCard
            key={p.planId} plan={p} priv={planPrivate[p.planId]} selected={p.planId === plan.planId}
            onSelect={setSelected}
          />
        ))}
      </div>

      <Card label={`Timeline for ${plan.cityName}`}>
        <div className="eyebrow">Your day · {plan.cityName}</div>
        <Timeline plan={plan} priv={mine} />
        {mine && mine.lines.length ? <p className="small mt-s">Your share is ready on the next screen once a chart is picked.</p> : null}
      </Card>

      <div className="votes">
        {shortlist.map((p) => (
          <Button
            key={p.planId} block aria-pressed={myVote === p.planId}
            className={myVote === p.planId ? "stamp" : ""}
            onClick={() => vote(p.planId)}
          >
            Vote {p.label ?? ""} <span className="mono">({votes[p.planId] ?? 0})</span>
          </Button>
        ))}
      </div>

      <AutoPickNote shortlist={shortlist} autoPick={autoPick} />

      {isOrganizer ? (
        <div className="mt-m">
          <StampButton disabled={picked} onClick={() => { sendPick({ planId: plan.planId }); }}>
            <WaxSeal size={20} /> Pick {plan.cityName}
          </StampButton>
          <p className="small center">Or lift the cloche on the headset.</p>
        </div>
      ) : (
        <p className="small center">The organizer makes the final pick.</p>
      )}
      {/* L1-006: the organizer keeps the headset code and "Unpair headset" once the table meets */}
      <HeadsetControls />
    </Page>
  );
}

/** PRD D5 — a clear majority picks the chart after a short countdown unless the organizer picks first. */
function AutoPickNote({ shortlist, autoPick }: { shortlist: PlanPublic[]; autoPick: { planId: string; at: number } | null }) {
  const now = useNow(COUNTDOWN_TICK_MS, !!autoPick);
  if (!autoPick) return null;
  const city = shortlist.find((p) => p.planId === autoPick.planId)?.cityName ?? "that chart";
  const secs = Math.max(0, Math.ceil((autoPick.at - now) / 1000));
  return (
    <p className="small center" role="status" aria-live="polite">
      Most of the crew chose {city}. Picking it in <span className="mono">{secs}s</span> unless the organizer chooses first.
    </p>
  );
}

const ChartCard = memo(function ChartCard({ plan, priv, selected, onSelect }: { plan: PlanPublic; priv?: PlanPrivate; selected: boolean; onSelect: (planId: string) => void }) {
  const publicTypes = new Set(plan.publicFlags.map((f) => f.type));
  const myFlags = (priv?.flags ?? []).filter((f) => !publicTypes.has(f.type));
  return (
    <button type="button" className="chart-card" aria-pressed={selected} onClick={() => onSelect(plan.planId)}>
      <div className="lbl">CHART {plan.label ?? ""}</div>
      <div className="city">{plan.cityName}</div>
      <div className="small">{plan.neighborhood} · {plan.hotelName}</div>
      {/* S2-002: the group total anyone may see is a range from public facts; your exact share is private */}
      <div className="total">{formatDollars(plan.groupRange.lowCents)}–{formatDollars(plan.groupRange.highCents).slice(1)} <span className="small">group, all in</span></div>
      {priv ? <FitStamp fits={priv.fits} /> : null}
      {plan.fitsEveryone ? <div className="mt-xs"><span className="plaque">Fits everyone</span></div> : null}
      <ul>
        {(priv?.missing ?? []).map((t) => <li key={t} className="red">no {t} <span className="small">(private)</span></li>)}
        {myFlags.map((f, i) => <li key={`m${i}`} className="red">{f.detail}</li>)}
        {plan.publicFlags.map((f, i) => <li key={`p${i}`} className="pub">{f.detail}</li>)}
      </ul>
    </button>
  );
});

/** My own day — read from plan:private only (the public plan carries no per-member schedule, SEC-001). */
function Timeline({ plan, priv }: { plan: PlanPublic; priv?: PlanPrivate }) {
  const minute = useDryrunMinute();
  if (!priv) return <p className="small">Plotting your day…</p>;
  const day1 = priv.days[0];
  const later = priv.days.slice(1);
  const arrival = priv.arrival;
  const state = (it: MyScheduleItem) =>
    minute === null ? "" : minute >= it.endMin ? "past" : minute >= it.startMin ? "now" : "";

  return (
    <>
      <div className="small mb-xs">{day1?.label}</div>
      <ul className="timeline">
        {arrival ? (
          <li className={minute !== null && minute >= arrival.atStayMin ? "past" : ""}>
            <span className="t">{minToClock(arrival.landMin)}</span>
            <span>Land, then to {plan.neighborhood}</span>
          </li>
        ) : null}
        {day1 ? day1.items.map((it) => <Row key={it.activityId} it={it} cls={state(it)} />) : null}
      </ul>
      {later.map((d) => (
        <div key={d.day} className="mt-s">
          <div className="small">{d.label}</div>
          <ul className="timeline">
            {d.items.map((it) => <Row key={it.activityId} it={it} cls="" />)}
            {!d.items.length ? <li><span className="t">—</span><span className="small">Free day</span></li> : null}
          </ul>
        </div>
      ))}
    </>
  );
}

const Row = memo(function Row({ it, cls }: { it: MyScheduleItem; cls: string }) {
  const leg = it.travel;
  return (
    <li className={cls}>
      <span className="t">{minToClock(it.startMin)}</span>
      <span>
        {it.name}
        {it.together ? <span className="small"> · together</span> : null}
        {leg ? (
          <div className={`leg ${leg.flagged ? "flag" : ""}`}>
            {leg.minutes} min {leg.mode}
            {leg.flagged ? <span className="hand-note"> long walk</span> : null}
          </div>
        ) : null}
      </span>
    </li>
  );
});
