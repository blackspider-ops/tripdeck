import { Link } from "react-router-dom";
import { lastJoinCode } from "../../net/session";
import "./landing.css";

/** P0 — Landing: the front page of tripdeck.tech. It only links into the create / join flows. */

const STEPS = [
  { n: "1", title: "Brief your mate", body: "Tell your own mate what you can spend, the days you're free, what you'd love and what you'd skip. Only you and your mate ever see it." },
  { n: "2", title: "The table", body: "The mates propose, object and back each other around a paper globe, out loud, each in their own voice. Jump in any time and hail yours." },
  { n: "3", title: "Dry Run", body: "The two best trips play out as small cities under glass, a day at a time, so you see the actual itinerary before anyone pays." },
  { n: "4", title: "Vote", body: "Everyone votes and the majority picks the trip. Friends who couldn't make it have their mate vote on their terms." },
  { n: "5", title: "Seal", body: "Each person approves their own share, capped at their own limit. If one share doesn't go through, nobody is charged." },
] as const;

const WORKS_WITH = ["Meta Quest", "Gemini", "ElevenLabs", "MongoDB Atlas", "Backboard", "Visa Developer sandbox"] as const;

function Logo({ className }: { className?: string }) {
  return (
    <picture className={className}>
      <source srcSet="/logo-light.svg" media="(prefers-color-scheme: dark)" />
      <img src="/logo.svg" alt="Tripdeck" width={150} height={40} />
    </picture>
  );
}

export default function Landing() {
  const last = lastJoinCode();
  return (
    <div className="lp">
      <a href="#lp-main" className="lp-skip">Skip to content</a>
      <header className="lp-nav">
        <Link to="/" className="lp-nav__home" aria-label="Tripdeck home"><Logo /></Link>
        <nav aria-label="Main" className="lp-nav__links">
          <a href="#how" className="lp-nav__link">How it works</a>
          <Link to="/new" className="lp-btn lp-btn--small">Open the app</Link>
        </nav>
      </header>

      <main id="lp-main">
        <section className="lp-hero" aria-labelledby="lp-h">
          <div className="lp-hero__words">
            <p className="lp-eyebrow">Group trips, settled at the table</p>
            <h1 id="lp-h" className="lp-hero__title">Everyone's in, or nobody pays.</h1>
            <p className="lp-hero__lede">
              Each friend quietly tells their own mate what they can spend, the mates hash out a trip that works for
              everyone, and nobody's card is touched until the whole crew is in.
            </p>
            <div className="lp-hero__cta">
              <Link to="/new" className="lp-btn">Start a trip</Link>
              <Link to="/join" className="lp-btn lp-btn--ghost">Join with a code</Link>
            </div>
            <p className="lp-hero__quest">
              On a Quest? Open <a href="/xr" className="lp-link">tripdeck.tech/xr</a> in the Quest Browser.
            </p>
            {last ? (
              <p className="lp-hero__back">
                <Link to={`/t/${last}`} className="lp-link">Back to your trip <span className="lp-mono">{last}</span></Link>
              </p>
            ) : null}
          </div>
          <ChartTable className="lp-hero__art" />
        </section>

        <section id="how" className="lp-row" aria-labelledby="lp-how-h">
          <h2 id="lp-how-h" className="lp-side">How it works</h2>
          <div>
            <ol className="lp-steps">
              {STEPS.map((s) => (
                <li key={s.n} className="lp-step">
                  <span className="lp-step__n" aria-hidden="true">{s.n}</span>
                  <h3 className="lp-h3">{s.title}</h3>
                  <p>{s.body}</p>
                </li>
              ))}
            </ol>
            <p className="lp-how__after">Then you're booked: the full day-by-day itinerary, your own receipt and a calendar file.</p>
          </div>
        </section>

        <section className="lp-row" aria-labelledby="lp-why-h">
          <h2 id="lp-why-h" className="lp-side">Why it holds together</h2>
          <ul className="lp-ways">
            <li className="lp-way">
              <h3 className="lp-way__name">Your budget stays private</h3>
              <p className="lp-way__line">
                Nobody's number is said out loud. At the table your mate just says "that's outside what my person can
                do". Nobody has to be the one who says it's too expensive.
              </p>
            </li>
            <li className="lp-way">
              <h3 className="lp-way__name">Your real table, in mixed reality</h3>
              <p className="lp-way__line">
                On a Meta Quest 3 or 3S the chart lies down on the table you're sitting at, and everyone in the room
                sees it in the same spot. No headset? Phones and laptops get the same table.
              </p>
            </li>
            <li className="lp-way">
              <h3 className="lp-way__name">All-or-nothing checkout</h3>
              <div className="lp-way__line">
                <p>
                  Everyone approves only their own share, capped at the limit they set. Holds become charges once every
                  seal is set. If one share fails, nobody is charged, and nobody spends a month chasing Venmo requests.
                </p>
                <SealLedger />
                <p className="lp-note">
                  To be clear: each card is checked against the Visa Developer sandbox, the holds and captures on top are
                  simulated, and no real money moves.
                </p>
              </div>
            </li>
          </ul>
        </section>

        <section className="lp-row lp-works" aria-labelledby="lp-works-h">
          <h2 id="lp-works-h" className="lp-side">Works with</h2>
          <p className="lp-works__list">{WORKS_WITH.join(", ")}.</p>
        </section>

        <section className="lp-band" aria-labelledby="lp-band-h">
          <h2 id="lp-band-h" className="lp-band__title">Get the trip out of the group chat.</h2>
          <p className="lp-band__lede">Start one, send the six-letter code, and let the mates do the arguing.</p>
          <div className="lp-hero__cta lp-band__cta">
            <Link to="/new" className="lp-btn lp-btn--paper">Start a trip</Link>
            <Link to="/join" className="lp-btn lp-btn--ghost-paper">Join with a code</Link>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <Logo className="lp-foot__logo" />
        <p>Built at HackGT 13.</p>
        <a href="https://github.com/blackspider-ops/tripdeck" className="lp-link" rel="noopener noreferrer">GitHub</a>
      </footer>
    </div>
  );
}

/** The hero picture: a chart table seen from above, the route pencilled between ports, three mates' cards and a cloche. */
function ChartTable({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 480 440" role="img" aria-label="A chart table from above: a route pencilled between three ports, three mates' cards around it and a small city under glass">
      <ellipse cx="240" cy="236" rx="222" ry="190" className="art-wood" />
      <ellipse cx="240" cy="228" rx="222" ry="190" className="art-wood-top" />
      <g transform="rotate(-4 240 226)">
        <rect x="92" y="96" width="296" height="222" rx="4" className="art-paper" />
        <rect x="104" y="108" width="272" height="198" rx="2" className="art-rule" />
        {/* coastline */}
        <path d="M104 214 C140 196, 150 232, 188 222 S246 178, 272 196 S330 236, 376 204 L376 306 L104 306 Z" className="art-sea" />
        {/* grid */}
        <g className="art-grid">
          <line x1="172" y1="108" x2="172" y2="306" /><line x1="240" y1="108" x2="240" y2="306" /><line x1="308" y1="108" x2="308" y2="306" />
          <line x1="104" y1="174" x2="376" y2="174" /><line x1="104" y1="240" x2="376" y2="240" />
        </g>
        {/* route */}
        <path d="M146 152 C190 120, 220 190, 262 158 S330 130, 334 262" className="art-route" />
        <circle cx="146" cy="152" r="6" className="art-port" />
        <circle cx="262" cy="158" r="6" className="art-port" />
        <circle cx="334" cy="262" r="8" className="art-port art-port--pick" />
        {/* compass */}
        <g transform="translate(140 270)" className="art-compass">
          <circle r="18" />
          <path d="M0 -15 L4 0 L0 15 L-4 0 Z" />
        </g>
      </g>
      {/* cloche */}
      <g transform="translate(378 356)">
        <ellipse cx="0" cy="22" rx="46" ry="10" className="art-brass" />
        <rect x="-18" y="2" width="10" height="18" className="art-city" />
        <rect x="-6" y="-8" width="12" height="28" className="art-city" />
        <rect x="8" y="6" width="10" height="14" className="art-city" />
        <path d="M-40 20 C-40 -30, 40 -30, 40 20" className="art-glass" />
        <circle cx="0" cy="-26" r="4" className="art-brass" />
      </g>
      {/* mates' cards */}
      <g transform="translate(44 96) rotate(-12)"><MateCard label="Rae's mate" line="Two nights is plenty" /></g>
      <g transform="translate(286 30) rotate(6)"><MateCard label="Maya's mate" line="Can we do the coast?" /></g>
      <g transform="translate(56 336) rotate(4)"><MateCard label="Sam's mate" line="Too far for my person" red /></g>
    </svg>
  );
}

function MateCard({ label, line, red }: { label: string; line: string; red?: boolean }) {
  return (
    <g>
      <rect width="176" height="54" rx="4" className="art-card" />
      <rect width="6" height="54" rx="2" className={red ? "art-card-edge art-card-edge--red" : "art-card-edge"} />
      <text x="16" y="21" className="art-card-label">{label}</text>
      <text x="16" y="40" className="art-card-line">{line}</text>
    </g>
  );
}

/** A small picture of the seal step: each person's capped share, and the booking waiting on the last seal. */
function SealLedger() {
  const rows = [
    { name: "Rae", share: "$412", cap: "$450", state: "Sealed" },
    { name: "Maya", share: "$398", cap: "$500", state: "Sealed" },
    { name: "Sam", share: "$405", cap: "$420", state: "Waiting" },
  ];
  return (
    <figure className="lp-ledger" aria-label="Example: three shares, two sealed, one waiting, so nothing is charged yet">
      <div className="lp-ledger__head"><span>Lisbon, 4 nights</span><span className="lp-mono">AA-LIS</span></div>
      <table>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <th scope="row">{r.name}</th>
              <td className="lp-mono">{r.share} <span className="lp-ledger__cap">of {r.cap}</span></td>
              <td><span className={r.state === "Sealed" ? "lp-stamp" : "lp-stamp lp-stamp--wait"}>{r.state}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      <figcaption>Nothing is charged until Sam seals.</figcaption>
    </figure>
  );
}
