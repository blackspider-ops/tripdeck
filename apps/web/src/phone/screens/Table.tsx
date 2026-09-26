import { memo, useState } from "react";
import { BANDS, MAX_WATCHES, PALETTE, type CrewPublic, type Turn } from "@all-ayes/shared";
import { seatAngle } from "../../shared-ui/seating";
import { speakerLabel } from "../../shared-ui/labels";
import { useCrew, useTripSelector } from "../TripContext";
import { HailDock } from "../components/Hail";
import { HeadsetControls } from "../components/organizer";
import { CompassRose } from "../components/icons";
import { useVoicePlayback } from "../components/voices";
import { Card, Eyebrow, Page, Plotting } from "../components/ui";

/**
 * P6 — The Table, mirrored on the phone: top-down chart, caption, log, hail.
 * OPT-047 / O2-046: reads the turns and three fields of the trip, so a voice arriving (turn:audioReady) or a vote
 * doesn't redraw the screen; a new turn redraws this, the log and one new row (the hail dock is memo'd).
 */
export default function Table() {
  const { store, crew, crewName, crewOf } = useCrew();
  const status = useTripSelector((s) => s.trip!.status);
  const organizerId = useTripSelector((s) => s.trip!.organizerId);
  const tableWatch = useTripSelector((s) => s.trip!.negotiation.watch);
  const turns = useTripSelector((s) => s.turns);
  const [voices, setVoices] = useState(false);
  useVoicePlayback(voices, turns, store);

  const latest = turns.at(-1) ?? null;
  const latestSpoken = [...turns].reverse().find((t) => t.speaker.kind !== "human") ?? null;
  // the helm takes no hail once the last Watch has started or the Captain decides (CAPTAINS_CALLING), nor while
  // the Captain opens the table (Watch 0, TABLE_OPENING; R2-WP-04): the dock says so instead of offering it
  const closed = turns.some((t) => t.act === "DECIDE") || status !== "AT_TABLE" || tableWatch >= MAX_WATCHES;
  const opening = !closed && tableWatch < 1;
  const watch = latest?.watch ?? 0;

  const who = (t: Turn) => whoSpoke(t, crew, crewName);

  const speakingId = latestSpoken?.speaker.kind === "advocate" ? latestSpoken.speaker.memberId
    : latestSpoken?.speaker.kind === "captain" ? "captain" : null;

  return (
    <Page>
      <div className="row spread">
        <Eyebrow icon={<CompassRose size={18} />}>The Table</Eyebrow>
        <span className="watch-pill">{watch === 0 ? "Opening" : `Watch ${Math.min(watch, MAX_WATCHES)} of ${MAX_WATCHES}`}</span>
      </div>

      <TopDownChart crew={crew} organizerId={organizerId} speakingId={speakingId} />

      <div className="caption-card" aria-live="polite">
        {latest ? (
          <>
            <div className="who">
              {latest.speaker.kind === "human" ? `${who(latest)} hails` : latest.speaker.kind === "captain" ? "The Captain" : `${who(latest)} is speaking`}
            </div>
            <div className="line">
              {latest.speaker.kind === "human" ? <em>“{latest.text}”</em> : latest.text}
            </div>
          </>
        ) : (
          <Plotting label="The crew is taking their seats…" />
        )}
      </div>

      <Card label="Hail the table">
        <HailDock closed={closed} opening={opening} />
        <label className="toggle">
          <input type="checkbox" checked={voices} onChange={(e) => setVoices(e.target.checked)} />
          Play voices here
        </label>
      </Card>

      <ShipsLog turns={turns} crew={crew} crewName={crewName} crewOf={crewOf} />
      {/* L1-006: the organizer keeps the headset code and "Unpair headset" once the table meets */}
      <HeadsetControls />
    </Page>
  );
}

/** The chart room's name for a speaker (shared-ui/labels.ts, OPT-017); a hail is just the friend's own name here. */
function whoSpoke(t: Turn, crew: CrewPublic[], crewName: (id: string) => string) {
  return t.speaker.kind === "human" ? crewName(t.speaker.memberId) : speakerLabel(t, crew).name;
}

const ShipsLog = memo(function ShipsLog({ turns, crew, crewName, crewOf }: {
  turns: Turn[]; crew: CrewPublic[]; crewName: (id: string) => string; crewOf: (id: string) => CrewPublic | undefined;
}) {
  // newest first; each row is memo'd, so a new turn renders one new row (O2-046)
  const rows: Turn[] = [];
  for (let i = turns.length - 1; i >= 0; i--) rows.push(turns[i]);
  return (
    <Card label="Ship's log">
      <div className="eyebrow">Log</div>
      {rows.length ? (
        <ul className="log">
          {rows.map((t) => <LogRow key={t.turnId} turn={t} crew={crew} crewName={crewName} crewOf={crewOf} />)}
        </ul>
      ) : (
        <p className="small">Nothing logged yet.</p>
      )}
    </Card>
  );
});

const LogRow = memo(function LogRow({ turn: t, crew, crewName, crewOf }: {
  turn: Turn; crew: CrewPublic[]; crewName: (id: string) => string; crewOf: (id: string) => CrewPublic | undefined;
}) {
  return (
    <li className={t.speaker.kind === "human" ? "hail" : ""}>
      <span className="t">{clock(t.createdAt)}</span>
      <FlagDot turn={t} crewOf={crewOf} />
      <span>
        <span className="act">{actLabel(t)}</span>
        <span className="line">{t.speaker.kind === "human" ? `“${t.text}”` : t.text}</span>
        <span className="small"> — {whoSpoke(t, crew, crewName)}</span>
      </span>
    </li>
  );
});

function actLabel(t: Turn) {
  return ({ OPEN: "opens", PROPOSE: "proposes", OBJECT: "objects", CONCEDE: "concedes", SUPPORT: "supports", HAIL: "hail", DECIDE: "decides" } as const)[t.act];
}

function clock(iso: string) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function FlagDot({ turn, crewOf }: { turn: Turn; crewOf: (id: string) => CrewPublic | undefined }) {
  const c = turn.speaker.kind === "captain" ? null : crewOf(turn.speaker.memberId);
  const color = c ? BANDS[c.band].hex : "var(--brass-dark)";
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="flag-dot">
      <path d="M4 17V2" stroke="var(--ink)" strokeWidth="1.3" />
      <path d="M4 2.5h10l-2.5 3 2.5 3H4" fill={color} stroke="var(--ink)" strokeWidth=".8" />
    </svg>
  );
}

/** Up to this many aboard, each seat on the top-down chart carries its name; beyond, an initial and a key below. */
const COMPACT_FROM = 6;

/**
 * Top-down chart: paper disc, globe, compass rose + Captain at north, crew seated around. Organizer at south.
 * Seats follow the 3D table's seating plan (shared-ui/seating.ts: x = cos, SVG y = sin, so south is down): the same
 * angles, spread evenly round the whole ring clear of the Captain / compass (north here) and the Dry Run cloches; one
 * radius here (the 3D inner ring only exists to pass between the globe and a cloche).
 */
export const TopDownChart = memo(function TopDownChart({ crew, organizerId, speakingId }: { crew: CrewPublic[]; organizerId: string; speakingId: string | null }) {
  const cx = 150, cy = 150;
  // a big crew (7–12) seats smaller pieces with just an initial on each; the names go in a key under the chart
  const compact = crew.length > COMPACT_FROM;
  const pr = compact ? 9 : 12;
  // names go under a seat unless it sits well up the chart (a seat just north of east keeps its name clear of the one above)
  const seats = crew.map((c) => {
    const a = (seatAngle(crew, organizerId, c.memberId) * Math.PI) / 180;
    const r = c.memberId === organizerId ? 110 : 108;
    return { c, x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });

  return (
    <>
    <svg className="chart-svg" viewBox="0 0 300 300" role="img" aria-label="The chart table, seen from above">
      <circle cx={cx} cy={cy} r="140" fill="var(--paper)" stroke="var(--paper-deep)" strokeWidth="2" />
      <circle cx={cx} cy={cy} r="134" fill="none" stroke="var(--ink)" strokeOpacity=".35" strokeDasharray="1 4" />
      {/* globe */}
      <circle cx={cx} cy={cy} r="46" fill="var(--sea-wash)" stroke="var(--ink)" strokeWidth="1.2" />
      <ellipse cx={cx} cy={cy} rx="46" ry="16" fill="none" stroke="var(--ink)" strokeOpacity=".5" />
      <ellipse cx={cx} cy={cy} rx="18" ry="46" fill="none" stroke="var(--ink)" strokeOpacity=".5" />
      <path d={`M${cx - 46} ${cy}h92M${cx} ${cy - 46}v92`} stroke="var(--ink)" strokeOpacity=".4" />
      {/* compass + Captain at north */}
      <g transform={`translate(${cx} ${cy - 112})`}>
        <circle r={speakingId === "captain" ? 17 : 14} fill="none" stroke="var(--brass)" strokeWidth={speakingId === "captain" ? 3 : 0} />
        <path d="M0-12l3 9-3 3-3-3zM0 12l-3-9 3-3 3 3z" fill="var(--brass-dark)" />
        <text y="28" textAnchor="middle" fontSize="11" fill="var(--ink)">Captain</text>
      </g>
      {seats.map(({ c, x, y }) => {
        const speaking = speakingId === c.memberId;
        return (
          <g key={c.memberId} transform={`translate(${x} ${y})${speaking ? " translate(0 -3)" : ""}`} data-seat={c.memberId}>
            {compact ? <title>{c.name}{c.role === "absent" ? " (away)" : ""}</title> : null}
            {speaking ? <circle r={pr + 5} fill="none" stroke="var(--brass)" strokeWidth="3" /> : null}
            <circle r={pr} fill="var(--wood)" />
            <circle r={pr} fill="none" stroke={BANDS[c.band].hex} strokeWidth={compact ? 3 : 4} />
            <text y={compact ? 3.5 : 4} textAnchor="middle" fontSize={compact ? 9 : 11} fill={PALETTE.paper} fontFamily="var(--f-heading)">{c.name.slice(0, 1).toUpperCase()}</text>
            {compact ? null : (
              <text y={y > cy - 32 ? 28 : -18} textAnchor="middle" fontSize="11" fill="var(--ink)">
                {c.name}{c.role === "absent" ? " (away)" : ""}
              </text>
            )}
          </g>
        );
      })}
    </svg>
    {compact ? (
      <ul className="chart-key" aria-label="Who sits where">
        {crew.map((c) => (
          <li key={c.memberId} className={speakingId === c.memberId ? "speaking" : undefined}>
            <span className="band-dot" style={{ background: BANDS[c.band].hex }} aria-hidden />
            {c.name}{c.role === "absent" ? " (away)" : ""}
          </li>
        ))}
      </ul>
    ) : null}
    </>
  );
});
