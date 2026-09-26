/**
 * WP-14 part A — the helm after the split (OPT-031): hails and restore edge cases (OPT-070), text helpers and
 * validateBrief (OPT-068 / OPT-019), honest provider selection (OPT-009), SEAL_LOCKED (WP-09 follow-up), the table-run
 * cap (WP-07), the seal deadline on the wire (WP-04), brief:private before slow memory (WP-11) and the trip:state
 * payload budget (OPT-071).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, { PACE_SCALE: "0", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "" }));

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CAP_MAX_CENTS, MAX_DEALBREAKERS, MAX_MUST_HAVES, NOTE_MAX_CHARS, clockToMin, formatCents, formatDollars, minToClock, type TripStatus } from "@all-ayes/shared";
import { TripService } from "../src/trips/service.js";
import { type HelmError } from "../src/util/errors.js";
import { validateBrief } from "../src/trips/crew.js";
import { SimProvider } from "../src/payments/sim.js";
import { selectPaymentProvider } from "../src/payments/select.js";
import { seedExpo } from "../src/demo/seed.js";
import { HAIL_MAX_CHARS } from "@all-ayes/shared";
import { RIBBON_MAX_WORDS, clampWords, clean } from "../src/util/text.js";
import { NO_LOOKALIKES, newRef } from "../src/util/ids.js";
import { restoreTurnAudio } from "../src/voice/voice.js";
import { config } from "../src/config.js";

type Ev = { ev: string; p: any };
function helmWithBus() {
  const helm = new TripService();
  const sim = (helm.payments as unknown as { provider: SimProvider }).provider;
  sim.latency = [1, 2]; sim.declineMember = ""; sim.timeoutMember = "";
  const trip: Ev[] = [];
  const member: (Ev & { id: string })[] = [];
  helm.attachBus({ trip: (_t, ev, p) => trip.push({ ev, p }), member: (id, ev, p) => member.push({ id, ev, p }) });
  return { helm, sim, trip, member };
}
const code = async (fn: () => unknown) => { try { await fn(); } catch (e) { return (e as HelmError).code; } return "OK"; };
const until = async (ok: () => boolean) => { for (let i = 0; i < 600 && !ok(); i++) await new Promise((r) => setTimeout(r, 5)); expect(ok()).toBe(true); };
const LIS = "LIS-W1-casa-alfama";

afterEach(() => { vi.restoreAllMocks(); delete process.env.VISA_VIC_API_BASE; delete process.env.VISA_VIC_API_KEY; });

describe("OPT-070: the hail path and restore edge cases", () => {
  it("a hail stating a cap loses the amount (ribbon has no digits); an over-long hail is cut; two in 5 s are SLOW_DOWN", async () => {
    const { helm, trip } = helmWithBus();
    const seed = await seedExpo(helm);
    await helm.startTable(seed.tripId, { memberId: seed.organizer.memberId });
    helm.trip(seed.tripId).negotiation.watch = 1; // L4-005: hails open at Watch 1
    helm.hail(seed.tripId, seed.maya.memberId, "Maya can do 900 so let's go somewhere with a beach");
    const hail = trip.filter((e) => e.ev === "turn:new" && e.p.act === "HAIL").at(-1)!.p;
    expect(hail.redactions).toBe(1);
    expect(hail.text).not.toMatch(/\d/);
    expect(hail.ribbon).not.toMatch(/\d/);
    expect(hail.ribbon.split(" ").length).toBeLessThanOrEqual(RIBBON_MAX_WORDS);
    // the first hail was used (taken by the table): the next one inside 5 s is refused, not queued
    helm.pendingHails.set(seed.tripId, []);
    expect(await code(() => helm.hail(seed.tripId, seed.maya.memberId, "somewhere cheaper"))).toBe("SLOW_DOWN");
    helm.hail(seed.tripId, seed.dev.memberId, "beach ".repeat(60));
    const long = trip.filter((e) => e.ev === "turn:new" && e.p.act === "HAIL").at(-1)!.p;
    expect(long.text.length).toBeLessThanOrEqual(HAIL_MAX_CHARS);
  });

  it("OPT-064: a hail with no privacy context in memory (restore, sweep) rebuilds it instead of throwing", async () => {
    const { helm } = helmWithBus();
    const seed = await seedExpo(helm);
    await helm.startTable(seed.tripId, { memberId: seed.organizer.memberId });
    helm.trip(seed.tripId).negotiation.watch = 1; // L4-005: hails open at Watch 1
    helm.privacy.delete(seed.tripId);
    expect(await code(() => helm.hail(seed.tripId, seed.maya.memberId, "beach please"))).toBe("OK");
    expect(helm.privacy.has(seed.tripId)).toBe(true);
  });

  it("a member the crew sailed without can't seal terms", async () => {
    const { helm } = helmWithBus();
    const { trip, member: rae } = helm.createTrip({ name: "x", organizerName: "Rae", band: 1, origin: "ATL" });
    const bo = helm.join(trip._id, { name: "Bo", band: 2, origin: "ORD" });
    helm.sailWithout(trip._id, { memberId: rae._id }, [bo.member._id]);
    const brief = { capCents: 90_000, dateWindowIds: ["W1"], mustHaves: [], dealbreakers: [] };
    expect(await code(() => helm.submitBrief(trip._id, bo.member._id, brief))).toBe("NOT_MEMBER");
    expect(helm.briefs.has(bo.member._id)).toBe(false);
  });
});

describe("OPT-068 / OPT-019: text helpers, shared formatters and validateBrief", () => {
  it("clean strips control characters and angle brackets, trims, and cuts; clampWords keeps the first n words", () => {
    expect(clean("  <script>hi\u0007 there</script>  ", 100)).toBe("scripthi there/script");
    expect(clean(undefined, 5)).toBe("");
    expect(clean("abcdefgh", 3)).toBe("abc");
    expect(clampWords("one two  three four", 2)).toBe("one two");
  });

  it("formatCents / formatDollars / minToClock / clockToMin", () => {
    expect(formatCents(-5)).toBe("-$0.05");
    expect(formatCents(123_456_7)).toBe("$12,345.67");
    expect(formatCents(100)).toBe("$1.00");
    expect(formatDollars(300_000)).toBe("$3,000");
    expect(minToClock(-30)).toBe("23:30");
    expect(minToClock(1440 + 65)).toBe("01:05");
    expect(clockToMin("7")).toBe(420);
    expect(clockToMin("08:15")).toBe(495);
  });

  it("validateBrief dedupes, drops unknown ids, caps lists, cleans the note and rejects a cap out of range", () => {
    const ds = new TripService().ds;
    const b = validateBrief({
      capCents: 90_000.4, dateWindowIds: ["W1", "W99"], mustHaves: ["food", "food", "beach", "chill", "museums", "nope" as never],
      dealbreakers: ["hostel", "hostel", "early_start", "long_walks", "layovers_2plus"], note: "<b>hi</b>\u0000 " + "x".repeat(400),
    }, ds);
    expect(b.capCents).toBe(90_000);
    expect(b.dateWindowIds).toEqual(["W1"]);
    expect(b.mustHaves).toEqual(["food", "beach", "chill"].slice(0, MAX_MUST_HAVES));
    expect(b.dealbreakers.length).toBe(MAX_DEALBREAKERS);
    expect(new Set(b.dealbreakers).size).toBe(b.dealbreakers.length);
    expect(b.note!.length).toBeLessThanOrEqual(NOTE_MAX_CHARS);
    expect(b.note).not.toMatch(/[<>\u0000]/);
    expect(() => validateBrief({ ...b, capCents: CAP_MAX_CENTS + 1 }, ds)).toThrow("between $300 and $3,000");
    expect(() => validateBrief({ ...b, dateWindowIds: ["W99"] }, ds)).toThrow(expect.objectContaining({ code: "BAD_INPUT" }));
  });

  it("OPT-028: one no-lookalike alphabet for every human-facing code", () => {
    for (const n of [4, 6, 8]) {
      const r = newRef(n);
      expect(r).toHaveLength(n);
      expect([...r].every((c) => NO_LOOKALIKES.includes(c))).toBe(true);
    }
  });
});

describe("OPT-009: the payment provider is chosen explicitly and reported honestly", () => {
  it("PAYMENTS_MODE=visa_sandbox without credentials, or with them but no adapter, runs the SIM labelled sim", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(selectPaymentProvider("sim").mode).toBe("sim");
    expect(warn).not.toHaveBeenCalled();
    const bare = selectPaymentProvider("visa_sandbox");
    expect(bare).toBeInstanceOf(SimProvider);
    expect(bare.mode).toBe("sim");
    expect(String(warn.mock.calls.at(-1)?.[0])).toMatch(/VISA_VIC_API_BASE/);
    process.env.VISA_VIC_API_BASE = "https://sandbox.example"; process.env.VISA_VIC_API_KEY = "k";
    expect(selectPaymentProvider("visa_sandbox").mode).toBe("sim");
    expect(String(warn.mock.calls.at(-1)?.[0])).toMatch(/not wired/);
    expect(new TripService().payments.mode).toBe("sim");
  });
});

describe("WP-09 follow-up: a seal that can't change is refused with SEAL_LOCKED", () => {
  async function sealing() {
    const x = helmWithBus();
    const seed = await seedExpo(x.helm);
    await x.helm.startTable(seed.tripId, { memberId: seed.organizer.memberId });
    await until(() => x.helm.trip(seed.tripId).status === "DRY_RUN");
    await x.helm.pick(seed.tripId, { memberId: seed.organizer.memberId }, LIS);
    return { ...x, seed, t: x.helm.trip(seed.tripId) };
  }

  it("setting a seal twice: the second tap is SEAL_LOCKED", async () => {
    const { helm, seed, t, sim } = await sealing();
    sim.latency = [200, 300]; // keep the booking open while we tap again
    const first = helm.setSeal(seed.tripId, seed.maya.memberId, t.bookingId!);
    expect(await code(() => helm.setSeal(seed.tripId, seed.maya.memberId, t.bookingId!))).toBe("SEAL_LOCKED");
    await first;
  });

  it("lifting a seal once every seal is set (captures under way) is SEAL_LOCKED, and changes nothing", async () => {
    const { helm, seed, t } = await sealing();
    const b = helm.payments.bookings.get(t.bookingId!)!;
    b.status = "ALL_AUTHORIZED";
    expect(await code(() => helm.cancelSeal(seed.tripId, seed.maya.memberId, t.bookingId!))).toBe("SEAL_LOCKED");
    expect(b.status).toBe("ALL_AUTHORIZED");
    expect(t.status).toBe("SEALING");
  });

  it("WP-04: booking:created carries the seal deadline while seals can be set; a settled booking doesn't", async () => {
    const { helm, seed, t, trip } = await sealing();
    const created = trip.find((e) => e.ev === "booking:created")!.p;
    expect(Date.parse(created.sealDeadlineAt)).toBeGreaterThan(Date.now());
    expect(Math.abs(created.serverNow - Date.now())).toBeLessThan(5_000); // lets a skewed phone count down right
    await helm.setSeal(seed.tripId, seed.organizer.memberId, t.bookingId!);
    await helm.setSeal(seed.tripId, seed.maya.memberId, t.bookingId!);
    await until(() => t.status === "BOOKED");
    expect(helm.state(t).booking!.sealDeadlineAt).toBeUndefined();
    expect(helm.debugSummary(seed.tripId)!.booking).toMatchObject({ status: "CAPTURED", needsAttention: false });
  });
});

describe("WP-07 follow-up: a voyage meets a bounded number of times", () => {
  it("TOO_MANY_RUNS once TABLE_RUNS_MAX meetings have started (read at call time)", async () => {
    const { helm } = helmWithBus();
    const seed = await seedExpo(helm);
    const t = helm.trip(seed.tripId);
    const saved = process.env.TABLE_RUNS_MAX;
    process.env.TABLE_RUNS_MAX = "2";
    try {
      t.tableRuns = 2;
      expect(await code(() => helm.startTable(seed.tripId, { memberId: seed.organizer.memberId }))).toBe("TOO_MANY_RUNS");
      expect(t.status).toBe("BRIEFING");
      t.tableRuns = 1;
      expect(await code(() => helm.startTable(seed.tripId, { memberId: seed.organizer.memberId }))).toBe("OK");
      expect(t.tableRuns).toBe(2);
    } finally {
      process.env.TABLE_RUNS_MAX = saved;
    }
  });
});

describe("WP-11 follow-up: brief:private doesn't wait on slow memory", () => {
  it("the brief goes at once, trip:state follows, then a second brief:private brings the memory lines", async () => {
    const { helm, trip, member } = helmWithBus();
    const { trip: tr, member: rae } = helm.createTrip({ name: "x", organizerName: "Rae", band: 1, origin: "ATL" });
    const order: string[] = [];
    helm.attachBus({
      trip: (_t, ev, p) => { trip.push({ ev, p }); order.push(ev); },
      member: (id, ev, p) => { member.push({ id, ev, p }); order.push(`${ev}:${(p as { memory?: unknown }).memory ? "mem" : "none"}`); },
    });
    vi.spyOn(helm, "memoryFor").mockImplementation(() => new Promise((r) => setTimeout(() => r(["voyage: Nashville · booked"]), 40)));
    await helm.submitBrief(tr._id, rae._id, { capCents: 90_000, dateWindowIds: ["W1"], mustHaves: [], dealbreakers: [] });
    expect(order).toEqual(["brief:private:none", "trip:state", "brief:private:mem"]);
    expect(member.at(-1)!.p).toMatchObject({ brief: { capCents: 90_000 }, memory: ["voyage: Nashville · booked"] });
  });

  it("quick memory is sent with the brief in one event (unchanged)", async () => {
    const { helm, member } = helmWithBus();
    const { trip: tr, member: rae } = helm.createTrip({ name: "x", organizerName: "Rae", band: 1, origin: "ATL" });
    vi.spyOn(helm, "memoryFor").mockResolvedValue(["line"]);
    await helm.submitBrief(tr._id, rae._id, { capCents: 90_000, dateWindowIds: ["W1"], mustHaves: [], dealbreakers: [] });
    const briefs = member.filter((e) => e.ev === "brief:private");
    expect(briefs).toHaveLength(1);
    expect(briefs[0].p.memory).toEqual(["line"]);
  });
});

describe("OPT-071: trip:state stays small enough for a phone on Expo Wi-Fi", () => {
  it("under 3 kB in every phase of the Expo run", async () => {
    const { helm } = helmWithBus();
    const seed = await seedExpo(helm);
    const t = helm.trip(seed.tripId);
    const sizes: Partial<Record<TripStatus, number>> = {};
    const measure = () => { sizes[t.status] = JSON.stringify(helm.state(t)).length; };
    measure();
    await helm.startTable(seed.tripId, { memberId: seed.organizer.memberId });
    measure();
    await until(() => t.status === "DRY_RUN");
    measure();
    await helm.pick(seed.tripId, { memberId: seed.organizer.memberId }, LIS);
    measure();
    await helm.setSeal(seed.tripId, seed.organizer.memberId, t.bookingId!);
    await helm.setSeal(seed.tripId, seed.maya.memberId, t.bookingId!);
    await until(() => t.status === "BOOKED");
    measure();
    expect(Object.keys(sizes).sort()).toEqual(["AT_TABLE", "BOOKED", "BRIEFING", "DRY_RUN", "SEALING"]);
    for (const [phase, n] of Object.entries(sizes)) expect(n, phase).toBeLessThan(3000);
  });
});

describe("voice cache on restore", () => {
  it("restoreTurnAudio finds a cached mp3 by its key and refuses a missing file or a malformed key", async () => {
    const key = "a".repeat(40);
    expect(await restoreTurnAudio("t1", key)).toBe(false);
    const dir = join(config.cacheDir, "tts");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${key}.mp3`), Buffer.alloc(8));
    expect(await restoreTurnAudio("t1", key)).toBe(true);
    expect(await restoreTurnAudio("t2", "../../etc/passwd")).toBe(false);
  });
});
