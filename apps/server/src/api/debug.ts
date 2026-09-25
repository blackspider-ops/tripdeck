/**
 * The dev debug view (docs/04 §4.8): a self-refreshing page per voyage with its event log and seals.
 * Access is the dev key (header) or the short-lived sign-in cookie, never a query string (SEC-013 / SEC-025, see
 * devAccess.ts). The page names nobody: each person appears as one `crew-xxxxxx` reference keyed with a server
 * secret (S2-004), seals show their public status (DECLINED reads VOIDED), in reference order, without provider refs.
 */
import express, { type Router } from "express";
import { publicSealStatus } from "../payments/orchestrator.js";
import type { TripService } from "../trips/service.js";
import { memberOfRoom, type TripRec } from "../trips/records.js";
import { devAllowed, devLogin, devLoginPage, redactRef } from "./devAccess.js";
import { esc, param } from "./http.js";

/**
 * One reference per person (WP-08 follow-up): seals carry the member id, while the event log's audience reads
 * `member:<name>` (or `member:<id>` for someone no longer on file). Both resolve to the member id, then to its ref.
 */
function refResolver(helm: TripService, t: TripRec) {
  const byLabel = new Map<string, string>();
  for (const id of new Set([...t.memberIds, ...t.removedMemberIds])) {
    const name = helm.members.get(id)?.name;
    if (name && !byLabel.has(name)) byLabel.set(name, id);
    byLabel.set(id, id);
  }
  return {
    member: (memberId: string) => redactRef(t._id, memberId),
    // `member:*` (a decline's private notice, core.ts log()) names nobody on purpose
    audience: (a: string) => {
      const label = memberOfRoom(a);
      return a === "member:*" || !label ? a : `member:${redactRef(t._id, byLabel.get(label) ?? label)}`;
    },
  };
}

/** "in 4m 12s" / "passed 30s ago" for the seal deadline line. */
function deadlineIn(at: string | number): string {
  const ms = new Date(at).getTime() - Date.now();
  if (Number.isNaN(ms)) return "unknown";
  const s = Math.round(Math.abs(ms) / 1000);
  const txt = `${Math.floor(s / 60)}m ${s % 60}s`;
  return ms >= 0 ? `in ${txt}` : `passed ${txt} ago`;
}

function debugPage(helm: TripService, t: TripRec): string {
  const ref = refResolver(helm, t);
  const rows = helm.debugLines(t._id).slice().reverse()
    .map((e) => `<tr><td>${e.at.slice(11, 19)}</td><td>${esc(e.event)}</td><td>${esc(ref.audience(e.audience))}</td><td>${esc(e.summary)}</td></tr>`).join("");
  const b = helm.currentBooking(t);
  const sum = helm.debugSummary(t._id);
  const bs = sum?.booking ?? null;
  // S2-004: public status only (a decline reads VOIDED), no instruction/auth refs, and sorted by reference so the
  // order doesn't map back to the crew list
  const seals = b ? b.seals.map((s) => `${ref.member(s.memberId)}: ${publicSealStatus(s.status)}`)
    .sort().map((line) => `<li>${line}</li>`).join("") : "";
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>debug ${t.joinCode}</title>
<style>body{font:13px ui-monospace,monospace;background:#1B2130;color:#E8DFC9;padding:16px}td{padding:2px 8px;border-bottom:1px solid #333;vertical-align:top}h1{font:600 16px Georgia}</style>
<h1>${esc(t.name)} · ${t.joinCode} · ${t.status} · v${t.version}</h1>
<p>payments: ${helm.payments.mode} · watch ${t.negotiation.watch} · turns ${t.negotiation.turns.length} · table runs ${t.tableRuns ?? 0} · booking ${bs ? `${bs.status} ${bs.reference ?? ""} (attempt ${bs.attempt})` : "—"}</p>
${bs?.needsAttention ? `<p style="color:#E07A5F"><b>needs attention:</b> a refund or release was refused by the provider; retry is blocked until it clears</p>` : ""}
${bs?.sealDeadlineAt ? `<p>seal deadline: ${esc(bs.sealDeadlineAt)} (${bs.status === "PENDING" || bs.status === "AUTHORIZING" ? deadlineIn(bs.sealDeadlineAt) : "settled"})</p>` : ""}
<ul>${seals}</ul><table>${rows}</table>`;
}

/** Mounts /debug/login (GET form, POST sign-in) and /debug/:tripId (by id or join code) on the /api router. */
export function mountDebugRoutes(r: Router, helm: TripService) {
  // SEC-025: the key never travels in a query string; a browser signs in once (form POST → short-lived cookie)
  r.get("/debug/login", (req, res) => devLoginPage(res, String(req.query.next ?? ""), 200));
  r.post("/debug/login", express.urlencoded({ extended: false, limit: "2kb" }), devLogin);
  r.get("/debug/:tripId", (req, res) => {
    if (!devAllowed(req)) return devLoginPage(res, req.originalUrl.split("?")[0]);
    const id = param(req, "tripId");
    const t = helm.trips.get(id) ?? helm.findByCode(id);
    if (!t) return void res.status(404).send("no such voyage");
    res.type("html").send(debugPage(helm, t));
  });
}
