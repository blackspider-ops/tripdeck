// Rebuilds src/world/airports.json from an OurAirports CSV (public domain, https://ourairports.com/data/).
// Usage: curl -sSL -o /tmp/airports.csv https://davidmegginson.github.io/ourairports-data/airports.csv
//        node apps/server/scripts/world-airports.mjs /tmp/airports.csv
// Keeps large + medium airports with scheduled service and an IATA code. Rows: [iata, name, city, iso2, lat, lng, size]
// where size is 2 (large) or 1 (medium). Coordinates are rounded to 4 decimals (~11 m).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** RFC-4180-ish CSV line parser (quoted fields, doubled quotes). The OurAirports file has no embedded newlines. */
export function parseCsvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export function filterAirports(csv) {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const head = parseCsvLine(lines[0]);
  const ix = (k) => head.indexOf(k);
  const [T, N, LAT, LNG, C, M, S, I] = ["type", "name", "latitude_deg", "longitude_deg", "iso_country", "municipality", "scheduled_service", "iata_code"].map(ix);
  const rows = [];
  const seen = new Set();
  for (const line of lines.slice(1)) {
    const f = parseCsvLine(line);
    const type = f[T];
    if (type !== "large_airport" && type !== "medium_airport") continue;
    if (f[S] !== "yes") continue;
    const iata = (f[I] || "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(iata) || seen.has(iata)) continue;
    const lat = Number(f[LAT]), lng = Number(f[LNG]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    seen.add(iata);
    const r4 = (x) => Math.round(x * 1e4) / 1e4;
    rows.push([iata, f[N].trim(), (f[M] || "").trim(), (f[C] || "").trim().toUpperCase(), r4(lat), r4(lng), type === "large_airport" ? 2 : 1]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return rows;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const src = process.argv[2];
  if (!src) { console.error("usage: node world-airports.mjs <airports.csv>"); process.exit(1); }
  const rows = filterAirports(readFileSync(src, "utf8"));
  const doc = {
    source: "OurAirports (https://ourairports.com/data/), public domain",
    fields: ["iata", "name", "city", "country", "lat", "lng", "size"],
    rows,
  };
  const out = fileURLToPath(new URL("../src/world/airports.json", import.meta.url));
  const text = "{\"source\":" + JSON.stringify(doc.source) + ",\"fields\":" + JSON.stringify(doc.fields) + ",\"rows\":[\n" + rows.map((r) => JSON.stringify(r)).join(",\n") + "\n]}\n";
  writeFileSync(out, text);
  console.log(`${rows.length} airports → ${out} (${(text.length / 1024).toFixed(0)} kB)`);
}
