import type { PricingMember } from "../src/fit/pricing.js";

/** The Expo crew (docs/07-dataset-spec.md §8). Caps are private. */
export const EXPO_CREW: PricingMember[] = [
  { memberId: "rae", name: "Rae", role: "organizer", origin: "ATL",
    brief: { capCents: 110_000, dateWindowIds: ["W1"], mustHaves: ["food", "nightlife"], dealbreakers: ["early_start"], note: "Want at least one big night out" } },
  { memberId: "maya", name: "Maya", role: "member", origin: "ORD",
    brief: { capCents: 90_000, dateWindowIds: ["W1"], mustHaves: ["beach", "chill"], dealbreakers: ["hostel"], note: "I get tired walking hills" } },
  { memberId: "dev", name: "Dev", role: "absent", origin: "JFK",
    brief: { capCents: 140_000, dateWindowIds: ["W1", "W2"], mustHaves: ["food", "museums"], dealbreakers: ["layovers_2plus"], note: "Can't join live, trust my mate" } },
];
