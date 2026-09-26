import { BOOKED_HEADLINE, formatCents, minToClock, type PlanPrivate, type PlanPublic } from "@all-ayes/shared";
import { useCrew, useTripSelector } from "../TripContext";
import { formatWindow } from "../format";
import { DOWNLOAD_URL_TTL_MS } from "../timing";
import { Bell } from "../components/icons";
import { RolledChartArt } from "../components/illustrations";
import { SealRow } from "../components/SealRow";
import { Button, Card, Eyebrow, Page } from "../components/ui";

/** P9 — Booked. */
export default function Booked() {
  // O2-046: the booking, my share and my itinerary only
  const { crew } = useCrew();
  const tripName = useTripSelector((s) => s.trip!.name);
  const booking = useTripSelector((s) => s.booking);
  const planId = useTripSelector((s) => s.booking?.planId ?? s.trip!.chosenPlanId);
  const plan = useTripSelector((s) => s.shortlist.find((p) => p.planId === planId));
  const reference = useTripSelector((s) => s.lastResult?.reference ?? s.booking?.reference);
  const share = useTripSelector((s) => (s.sealPrivate && s.booking && s.sealPrivate.bookingId === s.booking.bookingId ? s.sealPrivate.amountCents : null));
  // R2-WP-14: dateWindows is a static field (the store keeps it from the join's full snapshot)
  const win = useTripSelector((s) => s.trip!.dateWindows.find((w) => w.id === plan?.dateWindowId));
  // my own itinerary comes from plan:private (the public plan has no per-member schedule, SEC-001)
  const mine = useTripSelector((s) => (planId ? s.planPrivate[planId] : undefined));

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
            <p className="small">{plan.hotelName} · {plan.neighborhood}{win ? ` · ${formatWindow(win.start, win.end, { year: true })}` : ""}</p>
            {(mine?.days ?? []).map((d) => {
              const items = d.items;
              if (!items.length) return null;
              return (
                <div key={d.day} className="mt-s">
                  <div className="small">{d.label}</div>
                  <ul className="timeline">
                    {items.map((it) => (
                      <li key={it.activityId}><span className="t">{minToClock(it.startMin)}</span><span>{it.name}</span></li>
                    ))}
                  </ul>
                </div>
              );
            })}
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

      {booking ? (
        <Card label="Seals">
          <div className="eyebrow">All ayes</div>
          <SealRow booking={booking} crew={crew} />
        </Card>
      ) : null}
    </Page>
  );
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
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//All Ayes//Voyage//EN", "BEGIN:VEVENT",
    `UID:${ref ?? plan.planId}@allayes`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`,
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

