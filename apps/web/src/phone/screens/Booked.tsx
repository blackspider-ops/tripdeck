import { BOOKED_HEADLINE, buildItinerary, formatCents, minToClock, monthDayLabel, type ItineraryDay, type MyDay, type PlanPrivate, type PlanPublic } from "@all-ayes/shared";
import { useCrew, useTripSelector } from "../TripContext";
import { formatWindow } from "../format";
import { DOWNLOAD_URL_TTL_MS } from "../timing";
import { Bell } from "../components/icons";
import { RolledChartArt } from "../components/illustrations";
import { SealRow } from "../components/SealRow";
import { Button, Card, Eyebrow, Page } from "../components/ui";
import { Receipt } from "../components/Receipt";

const ROLE: Record<ItineraryDay["role"], string> = { arrival: "Arrival", full: "", departure: "Departure" };
/** "Inn at the Park ×2" → "Inn at the Park" (the room count is on the receipt). */
const stayOnly = (name: string) => name.replace(/ ×\d+$/, "");
/** "Fri, Feb 19" for the day a chosen moment is on in my itinerary. */
function activityDate(days: MyDay[], name: string): string | undefined {
  return days.find((d) => d.items.some((it) => it.name === name))?.label;
}
const nightsOf = (w: { start: string; end: string; nights?: number }) =>
  w.nights ?? Math.max(1, Math.round((Date.parse(`${w.end}T00:00:00Z`) - Date.parse(`${w.start}T00:00:00Z`)) / 86_400_000));

/** P9 — Booked. */
export default function Booked() {
  // O2-046: the booking, my share and my itinerary only
  const { crew } = useCrew();
  const tripName = useTripSelector((s) => s.trip!.name);
  const booking = useTripSelector((s) => s.booking);
  const planId = useTripSelector((s) => s.booking?.planId ?? s.trip!.chosenPlanId);
  const plan = useTripSelector((s) => s.shortlist.find((p) => p.planId === planId));
  const reference = useTripSelector((s) => s.lastResult?.reference ?? s.booking?.reference);
  const mySeal = useTripSelector((s) => (s.sealPrivate && s.booking && s.sealPrivate.bookingId === s.booking.bookingId ? s.sealPrivate : null));
  const share = mySeal ? mySeal.amountCents : null;
  // R2-WP-14: dateWindows is a static field (the store keeps it from the join's full snapshot)
  const win = useTripSelector((s) => s.trip!.dateWindows.find((w) => w.id === plan?.dateWindowId));
  // my own itinerary comes from plan:private (the public plan has no per-member schedule, SEC-001)
  const mine = useTripSelector((s) => (planId ? s.planPrivate[planId] : undefined));
  const nights = win ? nightsOf(win) : 0;
  // every day of the stay: flight in, check-in and dinner on day 1; full days; check-out and the flight home
  const itinerary = plan && mine && win ? buildItinerary({
    days: mine.days ?? [], nights, startDate: win.start, neighborhood: plan.neighborhood, hotelName: stayOnly(plan.hotelName),
    cityName: plan.cityName, arrival: mine.arrival, departure: mine.departure, route: mine.route ?? routeFromLines(mine.lines),
  }) : [];

  return (
    <Page>
      <Eyebrow icon={<Bell size={18} />}>{tripName}</Eyebrow>
      <RolledChartArt />
      <h1 className="h1 center">{BOOKED_HEADLINE}</h1>
      {reference ? <p className="center mono" aria-label="Booking reference">{reference}</p> : null}

      <Card label="Voyage">
        {plan ? (
          <>
            <h2 className="h2">{plan.cityName}</h2>
            <p className="small">{stayOnly(plan.hotelName)} · {plan.neighborhood}{win ? ` · ${formatWindow(win.start, win.end, { year: true })} · ${nights} night${nights === 1 ? "" : "s"}` : ""}</p>
            {itinerary.length ? (
              <div className="itinerary" aria-label="Itinerary">
                {itinerary.map((d) => (
                  <section key={d.day} className="itin-day" aria-label={d.label}>
                    <h3 className="itin-head"><span>{d.label}</span><span className="itin-role">{ROLE[d.role]}</span></h3>
                    <ul className="timeline">
                      {d.entries.map((e, i) => (
                        <li key={e.activityId ?? `${e.kind}-${i}`} className={`k-${e.kind}`}>
                          <span className="t">{e.startMin === null ? "" : minToClock(e.startMin)}</span><span>{e.title}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
        {share !== null ? (
          <p className="row spread mt-s">
            <span className="h2 m-0">Your share</span>
            <span className="mono">{formatCents(share)}</span>
          </p>
        ) : null}
        {plan?.priceSource === "live" ? (
          <p className="small price-source">Prices from RouteStack{plan.priceFeed === "live" ? "" : " sandbox"}</p>
        ) : null}
        {plan ? <Button block onClick={() => downloadIcs(tripName, plan, mine, win, reference)}>Save to your log (.ics)</Button> : null}
      </Card>

      {mySeal ? (
        <Card label="Your receipt">
          <Receipt
            reference={reference}
            tripName={tripName}
            dates={win ? formatWindow(win.start, win.end, { year: true }) : undefined}
            lines={mySeal.lines}
            totalCents={mySeal.amountCents}
            cardLast4={mySeal.cardLast4}
            mode={mySeal.mode}
            captured={booking?.status === "CAPTURED"}
            dateOf={(name) => activityDate(mine?.days ?? [], name)}
            flightDates={win ? `${monthDayLabel(win.start)} / ${monthDayLabel(win.end)}` : undefined}
          />
        </Card>
      ) : null}

      {booking ? (
        <Card label="Seals">
          <div className="eyebrow">Everyone sealed</div>
          <SealRow booking={booking} crew={crew} />
        </Card>
      ) : null}
    </Page>
  );
}

/** Older plans carry no route: read it off the flight line ("Flight IAD⇄SDF" or "Round-trip flight · IAD ⇄ SDF"). */
function routeFromLines(lines: PlanPrivate["lines"] | undefined): { origin: string; airport: string } | undefined {
  const l = lines?.find((x) => x.kind === "flight");
  const m = l ? /([A-Z0-9]{3,4})\s*⇄\s*([A-Z0-9]{3,4})/.exec(l.label) : null;
  return m ? { origin: m[1], airport: m[2] } : undefined;
}

function downloadIcs(name: string, plan: PlanPublic, mine: PlanPrivate | undefined, win: { start: string; end: string } | undefined, ref?: string) {
  const d = (iso: string, add = 0) => {
    const x = new Date(iso + "T12:00:00Z");
    x.setUTCDate(x.getUTCDate() + add);
    return x.toISOString().slice(0, 10).replace(/-/g, "");
  };
  const lines = (mine?.days ?? []).flatMap((day) => day.items.map((it) => `${day.label} ${minToClock(it.startMin)} ${it.name}`));
  const esc = (s: string) => s.replace(/[\\,;]/g, (m) => `\\${m}`).replace(/\n/g, "\\n");
  const body = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Tripdeck//Voyage//EN", "BEGIN:VEVENT",
    `UID:${ref ?? plan.planId}@tripdeck`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`,
    ...(win ? [`DTSTART;VALUE=DATE:${d(win.start)}`, `DTEND;VALUE=DATE:${d(win.end, 1)}`] : []),
    `SUMMARY:${esc(`${name} — ${plan.cityName}`)}`,
    `LOCATION:${esc(`${plan.hotelName}, ${plan.neighborhood}, ${plan.cityName}`)}`,
    `DESCRIPTION:${esc([ref ? `Ref ${ref}` : "", ...lines].filter(Boolean).join("\n"))}`,
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  const url = URL.createObjectURL(new Blob([body], { type: "text/calendar" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${plan.cityName.replace(/\W+/g, "-").toLowerCase()}-voyage.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_TTL_MS);
}

