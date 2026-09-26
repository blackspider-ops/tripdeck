/**
 * "Any city on Earth" (docs/11-world-cities.md): a search box for a port. Curated cities come first ("Curated"),
 * then places from OpenStreetMap ("From the map"). Debounced 400 ms, from 2 characters; a stale answer never
 * replaces a newer one. Choosing a row calls onPick — building a map city's pack is the caller's job
 * (POST /api/world/packs), so this stays a plain picker.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { CityPick, WorldSearchResponse, WorldSearchResult } from "@all-ayes/shared";
import "./citySearch.css";

export const SEARCH_DEBOUNCE_MS = 400;
export const SEARCH_MIN_CHARS = 2;

type Status = "idle" | "loading" | "done" | "error";

async function searchWorld(q: string, signal: AbortSignal): Promise<WorldSearchResponse> {
  const res = await fetch(`/api/world/search?q=${encodeURIComponent(q)}`, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`search ${res.status}`);
  return (await res.json()) as WorldSearchResponse;
}

export const pickOf = (r: WorldSearchResult): CityPick =>
  r.kind === "curated" && r.cityId
    ? { kind: "curated", cityId: r.cityId }
    : { kind: "world", osmId: r.osmId ?? "", name: r.name, country: r.country };

const placeLine = (r: WorldSearchResult) => [r.state, r.country].filter((x) => x && x !== r.name).join(", ");

export function CitySearch({
  onPick, label = "Find a port", placeholder = "Any city — try “Split”", autoFocus = false,
}: { onPick: (p: CityPick) => void; label?: string; placeholder?: string; autoFocus?: boolean }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [data, setData] = useState<WorldSearchResponse | null>(null);
  const [active, setActive] = useState(-1);
  const seq = useRef(0);
  const listId = useId();

  useEffect(() => {
    const query = q.trim();
    const mine = ++seq.current;
    if (query.length < SEARCH_MIN_CHARS) { setStatus("idle"); setData(null); return; }
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      setStatus("loading");
      searchWorld(query, ctl.signal).then(
        (r) => { if (seq.current === mine) { setData(r); setStatus("done"); setActive(-1); } },
        () => { if (seq.current === mine && !ctl.signal.aborted) setStatus("error"); },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(timer); ctl.abort(); };
  }, [q]);

  const results = status === "done" ? data?.results ?? [] : [];
  const choose = (r: WorldSearchResult) => onPick(pickOf(r));
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!results.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % results.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (i <= 0 ? results.length - 1 : i - 1)); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); choose(results[active]); }
  };
  const hasWorld = results.some((r) => r.kind === "world");

  return (
    <div className="city-search">
      <label className="field">
        <span>{label}</span>
        <input
          className="input" type="search" value={q} placeholder={placeholder} autoFocus={autoFocus}
          autoComplete="off" spellCheck={false} maxLength={100}
          role="combobox" aria-expanded={results.length > 0} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
        />
      </label>
      {status === "loading" ? <p className="small" role="status">Searching the charts…</p> : null}
      {status === "error" ? <p className="small red" role="alert">Couldn't search right now. Try again in a moment.</p> : null}
      {status === "done" && !results.length ? <p className="small">No port by that name. Try the city's own spelling.</p> : null}
      {status === "done" && data?.world === "unavailable" ? <p className="hint">The world map isn't answering — curated ports only for now.</p> : null}
      <ul className="city-results" id={listId} role="listbox" aria-label="Ports">
        {results.map((r, i) => (
          <li key={r.kind === "curated" ? `c:${r.cityId}` : `w:${r.osmId}`} id={`${listId}-${i}`} role="option" aria-selected={i === active}>
            <button type="button" className={`city-row${i === active ? " active" : ""}`} onClick={() => choose(r)}>
              <span className="city-name">{r.name}</span>
              <span className={`plaque ${r.kind === "curated" ? "curated" : "map"}`}>{r.kind === "curated" ? "Curated" : "From the map"}</span>
              {placeLine(r) ? <span className="city-where small">{placeLine(r)}</span> : null}
            </button>
          </li>
        ))}
      </ul>
      {hasWorld ? <p className="hint city-attrib">Map places © OpenStreetMap contributors</p> : null}
    </div>
  );
}

export default CitySearch;
