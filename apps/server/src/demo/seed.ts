/**
 * Expo scenario (docs/07-dataset-spec.md §8): Rae (organizer, ATL), Maya (ORD), Dev (absent, JFK),
 * all briefs sealed, Maya's memory from a previous voyage, Dev's standing instruction, and a headset code.
 */
import type { TripService } from "../trips/service.js";
import { crewKeyHash, personKey, recall, remember } from "../memory/memory.js";
import { newToken } from "../util/ids.js";

export async function seedExpo(helm: TripService) {
  const { trip, member: rae, token: raeToken } = helm.createTrip({ name: "Spring Break '27", organizerName: "Rae", band: 1, origin: "ATL" });
  // SEC-003: memory is keyed on a private crew key, not "Maya|ORD". Seeded Maya gets her own fresh key, and her
  // "previous voyage" is written under it, so the Expo line ("gave up the city pick last time") still plays and
  // nobody else's history can leak into (or out of) the demo.
  const mayaCrewKey = newToken();
  const maya = helm.join(trip._id, { name: "Maya", band: 2, origin: "ORD", crewKey: mayaCrewKey });
  const dev = helm.addAbsent(trip._id, { memberId: rae._id }, { name: "Dev", band: 3, origin: "JFK" });
  const devClaim = helm.claimAbsent(trip._id, dev.memberId, dev.inviteKey);

  const mayaKey = personKey(crewKeyHash(mayaCrewKey), "Maya");
  if (!(await recall(mayaKey)).some((m) => /conceded/i.test(m))) {
    await remember(mayaKey, "voyage: Nashville · booked · mid budget · conceded the city choice (wanted Chicago)");
  }

  await helm.submitBrief(trip._id, rae._id, { capCents: 110_000, dateWindowIds: ["W1"], mustHaves: ["food", "nightlife"], dealbreakers: ["early_start"], note: "Want at least one big night out" });
  await helm.submitBrief(trip._id, maya.member._id, { capCents: 90_000, dateWindowIds: ["W1"], mustHaves: ["beach", "chill"], dealbreakers: ["hostel"], note: "I get tired walking hills" });
  await helm.submitBrief(trip._id, dev.memberId, { capCents: 140_000, dateWindowIds: ["W1", "W2"], mustHaves: ["food", "museums"], dealbreakers: ["layovers_2plus"], note: "Can't join live, trust my mate" });

  const { code } = helm.headsetCode(trip._id, { memberId: rae._id });
  // SEC-004: the /demo page hands phones a one-time handoff code (fragment of the link), never a member token
  const seat = (memberId: string, memberToken: string) => ({ memberId, memberToken, handoff: helm.mintHandoff(trip._id, memberId, memberToken) });
  return {
    tripId: trip._id, joinCode: trip.joinCode,
    organizer: seat(rae._id, raeToken),
    maya: seat(maya.member._id, maya.token),
    dev: seat(dev.memberId, devClaim.memberToken),
    headsetCode: code,
  };
}
