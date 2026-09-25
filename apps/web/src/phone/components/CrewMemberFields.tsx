import { NAME_MAX_CHARS, type Band, type Origin } from "@all-ayes/shared";
import { BandSwatches, OriginSelect } from "./ui";

/** A crew member as the create, join and add-an-absent-friend forms fill it in. */
export interface CrewMemberDraft { name: string; band: Band; origin: Origin }

/**
 * O2-015: the name / colour band / home port fields, written once for Create (the organizer), JoinCrew (a friend
 * with the code) and Muster's "Add an absent friend" (`whose="their"`). `taken` bands can't be picked.
 */
export function CrewMemberFields({ value, onChange, taken, whose = "your" }: {
  value: CrewMemberDraft; onChange: (next: CrewMemberDraft) => void; taken?: Band[]; whose?: "your" | "their";
}) {
  const Whose = whose === "your" ? "Your" : "Their";
  return (
    <>
      <label className="field"><span>{Whose} name</span>
        <input
          className="input" value={value.name} maxLength={NAME_MAX_CHARS} required
          autoComplete={whose === "your" ? "given-name" : "off"} onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
      </label>
      <div className="field"><span>{Whose} color band</span>
        <BandSwatches value={value.band} onChange={(band) => onChange({ ...value, band })} taken={taken} label={`${Whose} color band`} />
      </div>
      <div className="spacer" />
      <label className="field"><span>Flying from</span>
        <OriginSelect value={value.origin} onChange={(origin) => onChange({ ...value, origin })} />
      </label>
    </>
  );
}
