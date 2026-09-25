/**
 * WP-10 — persistence integrity & restore, at the helm level. Mongo is faked by test/support/fakeDb.ts (BSON round
 * trip with the old driver default, so `undefined` is stored as `null`); a restart = a new TripService restoring from
 * exactly what the previous one persisted.
 */
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, { PACE_SCALE: "0", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "" }));
vi.mock("../src/store/db.js", async () => (await import("./support/fakeDb.js")).fakeDb);
// voices "on" (no network): every voiced turn gets audio of 1.5 s, so the audioUrl path runs (TR4-015)
// (the cache key is stored with the turn; restore finds its file, so a replay after a restart still carries audio)
const voice = vi.hoisted(() => ({ fileThere: true }));
vi.mock("../src/voice/voice.js", () => ({
  synthesize: async () => 1500,
  audioKeyOf: () => "f".repeat(40),
  restoreTurnAudio: async () => voice.fileThere,
}));

import type { Plan, Turn } from "@all-ayes/shared";
import { fake } from "./support/fakeDb.js";
import { TripService } from "../src/trips/service.js";
import { datasetHash, type ShortlistDoc, type TripRec } from "../src/trips/records.js";
import { SimProvider } from "../src/payments/sim.js";
import { REASONS } from "../src/payments/orchestrator.js";
import { seedExpo } from "../src/demo/seed.js";
import { hasPasskey, resetPasskeysForTests } from "../src/passkeys/passkeys.js";
import { raiseJoinCodeClash } from "../src/store/hooks.js";
import { restoreOrRetry } from "../src/store/restoreRetry.js";

const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean) => { for (let i = 0; i < 400 && !pred(); i++) await settle(); };
function helm() {
  const h = new TripService();
  const sim = (h.payments as unknown as { provider: SimProvider }).provider;
  sim.latency = [1, 2]; sim.declineMember = ""; sim.timeoutMember = "";
  return h;
}
async function atDryRun(h: TripService) {
  const seed = await seedExpo(h);
  await h.startTable(seed.tripId, { memberId: seed.organizer.memberId });
  await until(() => h.trip(seed.tripId).status === "DRY_RUN");
  return seed;
}
async function restart() {
  const h = helm();
  await h.restore();
  return h;
}
function replayOf(h: TripService, tripId: string, memberId?: string) {
  const out: { ev: string; p: any }[] = [];
  return h.replayer.replay(h.trip(tripId), (ev, p) => out.push({ ev, p }), memberId).then(() => out);
}
const PLAN = "LIS-W1-casa-alfama";

beforeEach(() => { fake.reset(); voice.fileThere = true; });

describe("TR5-002: dangling references never crash the boot or a join", () => {
  it("a deleted member doc and a deleted brief doc: boots, warns, and the voyage's state() and replay work", async () => {
    const a = helm();
    const s = await atDryRun(a);
    const other = await atDryRun(a); // a healthy voyage alongside
    fake.delete("members", s.maya.memberId); // Maya's member write was lost
    fake.delete("briefs", s.dev.memberId); // Dev is briefSealed but his brief write was lost
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const b = await restart();
    const t = b.trip(s.tripId);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("member doc(s) missing"))).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("has no brief"))).toBe(true);
    warn.mockRestore();
    expect(t.memberIds).not.toContain(s.maya.memberId);
    expect(b.members.get(s.dev.memberId)!.briefSealed).toBe(false);
    expect(t.status).toBe("BRIEFING"); // terms missing: back to briefing, with a reason
    expect(() => b.state(t)).not.toThrow();
    expect(b.state(t).crew.map((c) => c.name)).toEqual(["Rae", "Dev"]);
    const ev = await replayOf(b, s.tripId, s.organizer.memberId);
    expect(ev.find((e) => e.ev === "error")?.p.code).toBe("TABLE_INTERRUPTED");
    // the repair itself is persisted
    expect(fake.get<TripRec>("trips", s.tripId)!.status).toBe("BRIEFING");
    expect(b.trip(other.tripId).status).toBe("DRY_RUN");
  });

  it("a voyage doc that can't be restored is skipped and logged; the others still boot", async () => {
    const a = helm();
    const good = await atDryRun(a);
    const bad = await seedExpo(a);
    (fake.get<Record<string, unknown>>("trips", bad.tripId)!).memberIds = "garbage";
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const b = await restart();
    expect(err.mock.calls.some((c) => String(c[0]).includes("could not be restored"))).toBe(true);
    err.mockRestore();
    expect(b.trips.has(bad.tripId)).toBe(false);
    expect(b.trip(good.tripId).status).toBe("DRY_RUN");
  });
});

describe("TR4-002: one guarded transition() for every status change", () => {
  it("an error while announcing the two charts keeps the voyage in DRY_RUN and is logged", async () => {
    const h = helm();
    const seed = await seedExpo(h);
    h.attachBus({ trip: (_id, ev) => { if (ev === "table:decided") throw new Error("boom"); }, member: () => undefined });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await h.startTable(seed.tripId, { memberId: seed.organizer.memberId });
    await until(() => h.trip(seed.tripId).status !== "AT_TABLE");
    await settle(20);
    expect(h.trip(seed.tripId).status).toBe("DRY_RUN");
    expect(h.trip(seed.tripId).shortlistIds).toHaveLength(2);
    expect(err.mock.calls.some((c) => String(c[0]).includes("announcing the two charts failed"))).toBe(true);
    err.mockRestore();
  });

  it("illegal edges and stale versions are BAD_PHASE; no other code assigns a status", async () => {
    const h = helm();
    const seed = await seedExpo(h);
    const t = h.trip(seed.tripId);
    const transition = (h as unknown as { transition: (t: TripRec, to: string, o?: object) => void }).transition.bind(h);
    expect(() => transition(t, "BOOKED")).toThrow(expect.objectContaining({ code: "BAD_PHASE" }));
    expect(() => transition(t, "AT_TABLE", { expectVersion: t.version - 1 })).toThrow(expect.objectContaining({ code: "BAD_PHASE" }));
    expect(t.status).toBe("BRIEFING");
    // OPT-031: the helm is split across trips/*.ts; still exactly one status assignment among them
    const dir = new URL("../src/trips/", import.meta.url);
    const src = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(new URL(f, dir), "utf8")).join("\n");
    expect(src.match(/\.status\s*=[^=]/g)).toHaveLength(1); // the one inside transition() (core.ts)
  });
});

describe("TR5-012 / TR4-015: turns are their own documents", () => {
  it("the trip doc carries no turns; each turn (with audioUrl + durationMs) is stored at once; replay after restart is the same", async () => {
    const a = helm();
    const s = await atDryRun(a);
    const stored = fake.get<Record<string, any>>("trips", s.tripId)!;
    expect(stored.negotiation.turns).toBeUndefined();
    const turns = fake.docs<Turn & { round: number; tripId: string }>("turns").filter((d) => d.tripId === s.tripId);
    expect(turns.length).toBe(a.trip(s.tripId).negotiation.turns.length);
    expect(turns.every((d) => d.round === 1)).toBe(true);
    const last = a.trip(s.tripId).negotiation.turns.at(-1)!;
    expect(last.act).toBe("DECIDE");
    expect(fake.get<Turn>("turns", last.turnId)!.audioUrl).toBe(`/api/audio/${last.turnId}`);

    const before = await replayOf(a, s.tripId);
    const b = await restart();
    const after = await replayOf(b, s.tripId);
    const turnIds = (ev: { ev: string; p: any }[]) => ev.filter((e) => e.ev === "turn:new").map((e) => e.p.turnId);
    expect(turnIds(after)).toEqual(turnIds(before));
    const audio = after.filter((e) => e.ev === "turn:audioReady");
    expect(audio.length).toBeGreaterThan(0);
    expect(audio.find((e) => e.p.turnId === last.turnId)?.p).toEqual({ turnId: last.turnId, audioUrl: `/api/audio/${last.turnId}`, durationMs: 1500 });
  });
});

describe("TR5-010: restored docs have no null optional fields", () => {
  it("BSON stores undefined as null; the restored voyage, briefs and turns don't carry them", async () => {
    const a = helm();
    const s = await atDryRun(a);
    // the fake stores like the old driver did
    expect(fake.get<Record<string, unknown>>("briefs", s.organizer.memberId)).toBeDefined();
    const b = await restart();
    const t = b.trip(s.tripId);
    expect("chosenPlanId" in t).toBe(false);
    expect(t.autoPick).toBeNull(); // the one field whose absent value is null
    for (const turn of t.negotiation.turns) expect(Object.values(turn)).not.toContain(null);
    for (const m of t.memberIds) expect(Object.values(b.members.get(m)!)).not.toContain(null);
    expect(b.state(t).chosenPlanId).toBeUndefined();
  });
});

describe("TR5-011: dry-run clock and void reason survive a restart", () => {
  it("dryrun:script resumes at the same startedAt, paused stays paused; a voided replay carries the public reason", async () => {
    const a = helm();
    const s = await atDryRun(a);
    a.dryrunControl(s.tripId, { memberId: s.organizer.memberId }, "pause");
    const clock = a.trip(s.tripId).dryrun!;
    const b = await restart();
    const script = (await replayOf(b, s.tripId)).find((e) => e.ev === "dryrun:script")!.p;
    expect(script.startedAt).toBe(clock.startedAt);
    expect(script.pausedAt).toBe(clock.pausedAt);

    // restart mid-seal: the reason reaches phones that join afterwards
    await b.pick(s.tripId, { memberId: s.organizer.memberId }, PLAN);
    const c = await restart();
    await until(() => c.trip(s.tripId).status === "VOIDED");
    const result = (await replayOf(c, s.tripId)).find((e) => e.ev === "booking:result")!.p;
    expect(result.publicReason).toBe(REASONS.restarted);
  });
});

describe("TR5-013: the events collection matches docs/04 §4.8 and feeds /api/debug after a restart", () => {
  it("{tripId, type, audience: trip|member:<id>, payloadRedacted, at}; no names, no private payloads", async () => {
    const a = helm();
    const s = await atDryRun(a);
    const events = fake.docs<Record<string, unknown>>("events").filter((e) => e.tripId === s.tripId);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(Object.keys(e).sort()).toEqual(["_id", "at", "audience", "payloadRedacted", "tripId", "type"]);
      expect(e.at).toBeInstanceOf(Date);
      expect(String(e.audience)).toMatch(/^(trip|member:[\w-]+)$/);
      expect(String(e.audience)).not.toContain("Maya");
      if (String(e.audience).startsWith("member:")) expect(e.payloadRedacted).toBe("");
    }
    const b = await restart();
    const log = b.debugLog.get(s.tripId) ?? [];
    expect(log.length).toBeGreaterThan(0);
    expect(log.some((r) => r.audience === "member:Maya")).toBe(true); // shown with names in the debug view
  });
});

describe("TR5-015: bookings don't store anyone's cap", () => {
  it("no capCents in any bookings doc; after a restart the seal limit comes from the brief again", async () => {
    const a = helm();
    const s = await atDryRun(a);
    await a.pick(s.tripId, { memberId: s.organizer.memberId }, PLAN);
    await a.setSeal(s.tripId, s.organizer.memberId, a.trip(s.tripId).bookingId!);
    await settle(20);
    const docs = fake.docs<{ seals: Record<string, unknown>[]; version: number }>("bookings");
    expect(docs.length).toBeGreaterThan(0);
    expect(JSON.stringify(docs)).not.toContain("capCents");
    expect(docs.every((d) => d.version > 0)).toBe(true);
    const b = await restart();
    const bk = [...b.payments.bookings.values()][0];
    for (const seal of bk.seals) expect(seal.capCents).toBe(b.briefs.get(seal.memberId)!.capCents);
  });
});

describe("TR5-016: only live and recent voyages are loaded at boot", () => {
  it("an old BOOKED voyage stays in the database and opens by code on demand", async () => {
    const a = helm();
    const s = await atDryRun(a);
    await a.pick(s.tripId, { memberId: s.organizer.memberId }, PLAN);
    const t = a.trip(s.tripId);
    await a.setSeal(s.tripId, s.organizer.memberId, t.bookingId!);
    await a.setSeal(s.tripId, s.maya.memberId, t.bookingId!);
    await until(() => t.status === "BOOKED");
    const live = await seedExpo(a);
    fake.get<TripRec>("trips", s.tripId)!.updatedAt = new Date(Date.now() - 60 * 86_400_000).toISOString();

    fake.state.connected = true;
    const b = await restart();
    expect(b.trips.has(live.tripId)).toBe(true);
    expect(b.trips.has(s.tripId)).toBe(false);
    expect(b.members.has(s.maya.memberId)).toBe(false);
    // a sync lookup starts the load and asks the caller to retry; then it is there
    expect(() => b.tripByCode(t.joinCode)).toThrow(expect.objectContaining({ code: "LOADING", status: 503 }));
    const loaded = await b.hydrate({ joinCode: t.joinCode });
    expect(loaded?.status).toBe("BOOKED");
    expect(b.tripByCode(t.joinCode)._id).toBe(s.tripId);
    expect(b.state(b.trip(s.tripId)).booking?.reference).toBe(a.payments.bookings.get(t.bookingId!)!.reference);
    // an unknown code is a plain 404 once the database said so
    expect(await b.hydrate({ joinCode: "ZZZZZZ" })).toBeUndefined();
    expect(() => b.tripByCode("ZZZZZZ")).toThrow(expect.objectContaining({ code: "NO_TRIP" }));
  });
});

describe("TR5-021: a table interrupted by a restart", () => {
  it("is reset to BRIEFING in the database and a reconnecting phone is told, with an empty log", async () => {
    const a = helm();
    const s = await seedExpo(a);
    await a.startTable(s.tripId, { memberId: s.organizer.memberId });
    const snap = fake.snapshot(); // the process dies mid-table
    expect(fake.get<TripRec>("trips", s.tripId)!.status).toBe("AT_TABLE");
    await until(() => a.trip(s.tripId).status === "DRY_RUN");
    fake.load(snap);
    const b = await restart();
    expect(b.trip(s.tripId).status).toBe("BRIEFING");
    expect(fake.get<TripRec>("trips", s.tripId)!.status).toBe("BRIEFING");
    const ev = await replayOf(b, s.tripId, s.maya.memberId);
    expect(ev.find((e) => e.ev === "error")?.p).toEqual({ code: "TABLE_INTERRUPTED", message: expect.stringContaining("restarted") });
    expect(ev.filter((e) => e.ev === "turn:new")).toHaveLength(0);
    // a second restart doesn't bring the old meeting's turns back, and the table can meet again
    const c = await restart();
    expect(c.trip(s.tripId).negotiation.turns).toHaveLength(0);
    await c.startTable(s.tripId, { memberId: s.organizer.memberId });
    await until(() => c.trip(s.tripId).status === "DRY_RUN");
    expect((await replayOf(c, s.tripId)).some((e) => e.ev === "error")).toBe(false);
  });
});

describe("TR5-022: dataset drift is detected; the stored plan prices win", () => {
  it("a changed dataset keeps the Two Charts as priced; a voyage whose charts can't resolve goes back to BRIEFING", async () => {
    const a = helm();
    const s = await atDryRun(a);
    const stored = fake.get<TripRec>("trips", s.tripId)!;
    expect(stored.datasetHash).toBe(datasetHash(a.ds));
    // O2-036: the plan bodies live in their own doc, not in every trip save
    expect(stored.shortlistPlans).toBeUndefined();
    const charts = fake.get<ShortlistDoc>("shortlists", s.tripId)!;
    expect(charts.plans).toHaveLength(2);
    expect(charts.planIds).toEqual(stored.shortlistIds);
    // simulate a deploy whose dataset re-priced this chart: the stored plan says what the crew saw
    stored.datasetHash = "0000000000000000";
    const priced = charts.plans[0] as Plan;
    priced.groupCents += 12_300;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const b = await restart();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("dataset changed"))).toBe(true);
    warn.mockRestore();
    expect(b.table.shortlist(b.trip(s.tripId)).find((p) => p._id === priced._id)!.groupCents).toBe(priced.groupCents);

    // LEGACY (O2-036): a trip doc from before the split embeds its plans, and has no shortlists doc: they still load
    const legacyPlans = fake.get<ShortlistDoc>("shortlists", s.tripId)!.plans;
    fake.get<Record<string, any>>("trips", s.tripId)!.shortlistPlans = legacyPlans;
    fake.delete("shortlists", s.tripId);
    const b2 = await restart();
    expect(b2.table.shortlist(b2.trip(s.tripId)).find((p) => p._id === priced._id)!.groupCents).toBe(priced.groupCents);
    await Promise.resolve();
    expect(fake.get<ShortlistDoc>("shortlists", s.tripId)?.plans[0].groupCents).toBe(priced.groupCents); // migrated on load
    // and a shortlists doc of an earlier decision (another round) is never attached
    fake.get<Record<string, any>>("trips", s.tripId)!.shortlistPlans = undefined;
    fake.state.writes = [];
    b2.persistShortlist(b2.trip(s.tripId));
    const other = fake.get<ShortlistDoc>("shortlists", s.tripId)!;
    other.round += 1;
    const quiet0 = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const b3 = await restart();
    quiet0.mockRestore();
    expect(b3.trip(s.tripId).shortlistPlans).toBeUndefined();

    // an older doc without stored plans whose ids no longer exist: a clear status, no exception on pick
    const s2 = await atDryRun(a);
    const legacy = fake.get<Record<string, any>>("trips", s2.tripId)!;
    fake.delete("shortlists", s2.tripId);
    legacy.shortlistIds = ["GONE-1", "GONE-2"];
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const c = await restart();
    quiet.mockRestore();
    expect(c.trip(s2.tripId).status).toBe("BRIEFING");
    await expect(c.pick(s2.tripId, { memberId: s2.organizer.memberId }, "GONE-1")).rejects.toMatchObject({ code: "BAD_PHASE" });
  });
});

describe("TR5-007: MongoDB back after a failed boot connect", () => {
  it("the helm merges what is stored and writes everything it held in memory", async () => {
    const h = helm();
    await h.restore(); // registers the reconnect hook
    const s = await atDryRun(h);
    const stored = await (async () => { const x = helm(); const t = await seedExpo(x); return { x, t }; })();
    // nothing reached the database while it was down, except a voyage another instance wrote
    const keep = fake.snapshot();
    fake.load(new Map([...keep].map(([col, m]) => [col, new Map([...m].filter(([, d]) => (d as { tripId?: string; _id: string }).tripId === stored.t.tripId || d._id === stored.t.tripId))])));
    expect(h.trips.has(stored.t.tripId)).toBe(false);
    expect(fake.get("trips", s.tripId)).toBeUndefined();
    await fake.state.hook!();
    expect(fake.get<TripRec>("trips", s.tripId)!.status).toBe("DRY_RUN");
    expect(fake.get("members", s.maya.memberId)).toBeDefined();
    expect(fake.get("briefs", s.maya.memberId)).toBeDefined();
    expect(fake.docs<{ tripId: string }>("turns").filter((d) => d.tripId === s.tripId).length).toBe(h.trip(s.tripId).negotiation.turns.length);
    expect(h.trips.has(stored.t.tripId)).toBe(true); // merged in
  });
});

describe("WP-14 (WP-07 follow-up): turn audio after a restart", () => {
  it("the cache key is stored with the turn; a restart serves it again, or drops audioUrl when the file is gone", async () => {
    const a = helm();
    const s = await atDryRun(a);
    const voiced = a.trip(s.tripId).negotiation.turns.filter((t) => t.audioUrl);
    expect(voiced.length).toBeGreaterThan(0);
    expect(fake.get<{ audioKey?: string }>("turns", voiced[0].turnId)!.audioKey).toBe("f".repeat(40));
    const kept = await restart();
    expect(kept.trip(s.tripId).negotiation.turns.filter((t) => t.audioUrl).length).toBe(voiced.length);
    voice.fileThere = false;
    const gone = await restart();
    const turns = gone.trip(s.tripId).negotiation.turns;
    expect(turns.length).toBe(a.trip(s.tripId).negotiation.turns.length);
    expect(turns.some((t) => t.audioUrl || t.durationMs)).toBe(false);
    expect((await replayOf(gone, s.tripId)).some((e) => e.ev === "turn:audioReady")).toBe(false);
  });
});

describe("OPT-071: I/O-count regression", () => {
  it("a table run writes each turn at most twice (insert + its audio) and the trip doc only at start and decide", async () => {
    const h = helm();
    const seed = await seedExpo(h);
    fake.state.writes = [];
    await h.startTable(seed.tripId, { memberId: seed.organizer.memberId });
    await until(() => h.trip(seed.tripId).status === "DRY_RUN");
    const perTurn = new Map<string, number>();
    for (const w of fake.state.writes.filter((x) => x.col === "turns")) perTurn.set(w.id, (perTurn.get(w.id) ?? 0) + 1);
    const turns = h.trip(seed.tripId).negotiation.turns;
    expect(perTurn.size).toBe(turns.length);
    for (const turn of turns) expect(perTurn.get(turn.turnId)).toBe(turn.audioUrl ? 2 : 1);
    expect(fake.state.writes.filter((x) => x.col === "trips").length).toBe(2);
    expect(fake.state.writes.filter((x) => x.col === "members" || x.col === "briefs").length).toBe(0);
  });
});

describe("L5-003: the reconnect merge loads passkeys", () => {
  it("after a failed boot connect, a member whose passkey is stored must still use it once MongoDB is back", async () => {
    resetPasskeysForTests();
    const h = helm();
    await h.restore(); // boot with MongoDB unreachable: nothing loaded, the hook registered
    const s = await atDryRun(h);
    expect(hasPasskey(s.maya.memberId)).toBe(false);
    // the passkey Maya registered before the outage is in the database
    const doc = { _id: "cred-maya", memberId: s.maya.memberId, rpID: "localhost", publicKey: Buffer.from([1, 2, 3]).toString("base64url"), counter: 3, createdAt: new Date().toISOString() };
    fake.load(new Map([...fake.snapshot(), ["passkeys", new Map([[doc._id, doc]])]]));
    fake.state.connected = true;
    await fake.state.hook!();
    expect(hasPasskey(s.maya.memberId)).toBe(true); // the seal gate holds again (no plain confirm tap)
    expect(fake.get("passkeys", doc._id)).toBeDefined();
    resetPasskeysForTests();
  });
});

describe("L5-004: stored voyages while MongoDB is unreachable", () => {
  it("answer 503 LOADING (retryable), not 404 NO_TRIP; once it's back the voyage is there", async () => {
    const a = helm();
    const s = await seedExpo(a);
    const code = a.trip(s.tripId).joinCode;
    const b = helm();
    fake.state.mode = "reconnecting"; // MONGODB_URI set, boot connect failed: the boot restore reads nothing
    const stored = fake.snapshot();
    fake.load(new Map());
    await b.restore();
    fake.load(stored);
    expect(() => b.tripByCode(code)).toThrow(expect.objectContaining({ code: "LOADING", status: 503 }));
    expect(() => b.trip(s.tripId)).toThrow(expect.objectContaining({ code: "LOADING", status: 503 }));
    fake.state.connected = true;
    await fake.state.hook!();
    expect(b.tripByCode(code)._id).toBe(s.tripId);
    // memory-only mode (no MONGODB_URI) is still a plain 404
    fake.state.connected = false; fake.state.mode = "memory";
    expect(() => b.tripByCode("ZZZZZZ")).toThrow(expect.objectContaining({ code: "NO_TRIP", status: 404 }));
  });
});

describe("L5-009: restore never crashes the boot", () => {
  it("a booking doc without seals is skipped with a warning; the voyage still boots", async () => {
    const a = helm();
    const s = await atDryRun(a);
    await a.pick(s.tripId, { memberId: s.organizer.memberId }, PLAN);
    const id = a.trip(s.tripId).bookingId!;
    delete (fake.get<Record<string, unknown>>("bookings", id)!).seals;
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const b = await restart();
    expect(err.mock.calls.some((c) => String(c[0]).includes(`booking ${id} could not be restored`))).toBe(true);
    err.mockRestore();
    const t = b.trip(s.tripId);
    expect(t.status).toBe("VOIDED"); // SEALING with no usable booking record: voided with the restart reason
    expect(t.lastResult?.publicReason).toBe(REASONS.restarted);
  });

  it("a load that throws once at boot: the helm starts, and a later merge restores the voyages", async () => {
    const a = helm();
    const s = await atDryRun(a);
    fake.state.failLoads = { bookings: 1 };
    const b = helm();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await restoreOrRetry(b, { baseDelayMs: 1, maxDelayMs: 2, log: () => undefined })).toBe(false);
    await until(() => b.trips.has(s.tripId));
    quiet.mockRestore();
    expect(b.trip(s.tripId).status).toBe("DRY_RUN");
  });
});

describe("L5-010: a join code an archived voyage holds", () => {
  it("the clash draws a new code, saves it, and the voyage opens by the new code", async () => {
    const h = helm();
    const s = await seedExpo(h);
    const t = h.trip(s.tripId);
    const old = t.joinCode;
    const states: string[] = [];
    h.attachBus({ trip: (_id, ev, p) => { if (ev === "trip:state") states.push((p as { joinCode: string }).joinCode); }, member: () => undefined });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    raiseJoinCodeClash(s.tripId); // what store/db.ts raises on E11000 {joinCode}
    await settle(10);
    warn.mockRestore();
    expect(t.joinCode).not.toBe(old);
    expect(fake.get<TripRec>("trips", s.tripId)!.joinCode).toBe(t.joinCode);
    expect(h.tripByCode(t.joinCode)._id).toBe(s.tripId);
    expect(h.findByCode(old)).toBeUndefined();
    expect(states.at(-1)).toBe(t.joinCode); // the phones learn the new code
  });
});

describe("L4-007 (second half): a VOIDED voyage whose charts no longer resolve", () => {
  it("goes back to BRIEFING at restore, with a reason, instead of offering charts that are gone", async () => {
    const a = helm();
    const s = await atDryRun(a);
    await a.pick(s.tripId, { memberId: s.organizer.memberId }, PLAN);
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const b = await restart(); // restart mid-seal → VOIDED
    expect(b.trip(s.tripId).status).toBe("VOIDED");
    const doc = fake.get<Record<string, any>>("trips", s.tripId)!;
    fake.delete("shortlists", s.tripId);
    doc.shortlistIds = ["GONE-1", "GONE-2"];
    const c = await restart();
    quiet.mockRestore();
    expect(c.trip(s.tripId).status).toBe("BRIEFING");
    expect(c.trip(s.tripId).tableReset?.reason).toBeTruthy();
    expect(fake.get<TripRec>("trips", s.tripId)!.status).toBe("BRIEFING");
  });
});
