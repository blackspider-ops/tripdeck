import { memo } from "react";
import type { BookingPublic, CrewPublic, SealPublic } from "@all-ayes/shared";
import { BrokenSeal, Dividers, Hourglass, WaxSeal } from "./icons";

/** A seal counts as set once it is authorized (or captured); publicly there is nothing in between (doc 06 §7). */
export const sealIsSet = (s: Pick<SealPublic, "status">) => s.status === "AUTHORIZED" || s.status === "CAPTURED";

/** Shared seal status row: one slot per crew member, wax pressed when authorized (doc 02 §8). */
export const SealRow = memo(function SealRow({ booking, crew }: { booking: BookingPublic; crew: CrewPublic[] }) {
  return (
    <div className="seal-row" role="list" aria-label="Seals">
      {booking.seals.map((s) => {
        const c = crew.find((x) => x.memberId === s.memberId);
        const set = sealIsSet(s);
        const broken = s.status === "DECLINED" || s.status === "VOIDED";
        const working = s.status === "AUTHORIZING";
        const cls = set ? "set" : broken ? "broken" : working ? "working" : "";
        const label = set ? (s.standing ? "pre‑signed" : "sealed") : broken ? (s.status === "VOIDED" ? "lifted" : "didn't clear") : working ? "authorizing" : "waiting";
        return (
          <div key={s.memberId} className={`seal-slot ${cls}`} role="listitem" aria-label={`${c?.name ?? "Crew"}: ${label}`}>
            <div className="disc">
              {set ? <WaxSeal size={24} /> : broken ? <BrokenSeal size={30} /> : working ? <Dividers size={22} /> : <Hourglass size={20} />}
            </div>
            <div>{c?.name ?? "—"}</div>
            <div className="small">{label}</div>
          </div>
        );
      })}
    </div>
  );
});
