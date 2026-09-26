import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type DemoSeat, type DemoSeed } from "../../net/api";
import { saveSession } from "../../net/session";
import { useAsyncAction } from "../useAsyncAction";
import { Lighthouse } from "../components/icons";
import { CopyLine, QR } from "../components/crew";
import { Button, Card, Eyebrow, MarginNote, Page, StampButton } from "../components/ui";

/**
 * Dev helper (docs/09): seed a random voyage (a fresh crew, ports and dates every time) or the scripted Expo voyage
 * (Rae, Maya, Dev on Lisbon / Mexico City / Montréal), then hand out links.
 */
export default function Demo() {
  const [seed, setSeed] = useState<DemoSeed | null>(null);
  const { busy, err, run } = useAsyncAction();
  const origin = typeof location !== "undefined" ? location.origin : "";

  // SEC-004/SEC-019: a one-time handoff code (never the member token), in the fragment so no server log sees it
  const link = (m: DemoSeat) => `${origin}/t/${seed!.joinCode}#as=${encodeURIComponent(m.handoff)}&m=${encodeURIComponent(m.memberId)}`;

  const go = (kind: "random" | "expo") => void run(async () => {
    const s = await api.seedDemo(kind);
    saveSession({ tripId: s.tripId, joinCode: s.joinCode, memberId: s.organizer.memberId, memberToken: s.organizer.memberToken });
    setSeed(s);
  }, "Couldn't seed. Is the server running?");

  const others = seed ? seed.crew.filter((c) => c.memberId !== seed.organizer.memberId) : [];

  return (
    <Page>
      <Eyebrow icon={<Lighthouse size={18} />}>Expo station</Eyebrow>
      <h1 className="h1">Seed a demo voyage</h1>
      <p className="body">A random voyage has a fresh crew, ports and dates each time, with everyone's terms sealed and one friend away. The scripted Expo voyage is Rae, Maya and Dev.</p>
      <StampButton disabled={busy} onClick={() => go("random")}>Seed a random voyage</StampButton>
      <Button block disabled={busy} onClick={() => go("expo")}>Seed the scripted Expo voyage</Button>
      {err ? <MarginNote>{err}</MarginNote> : null}

      {seed ? (
        <>
          <Card label="Voyage">
            <h2 className="h2">{seed.tripName}</h2>
            <p className="small">{seed.ports.join(" · ")}</p>
            {seed.kind === "random" && seed.seed !== undefined ? <p className="small mono">Seed {seed.seed}</p> : null}
          </Card>
          <Card label={seed.organizer.name}>
            <h2 className="h2">{seed.organizer.name} · organizer</h2>
            <p className="small">This device is now {seed.organizer.name}.</p>
            <Link className="btn block" to={`/t/${seed.joinCode}`}>Open as {seed.organizer.name}</Link>
            <CopyLine text={link(seed.organizer)} />
          </Card>
          {others.map((m) => (
            <Card key={m.memberId} label={m.name}>
              <h2 className="h2">{m.name}{m.role === "absent" ? " · away" : ""}</h2>
              {m.role === "absent" ? (
                <p className="small">Pre‑signed. Only needed to show the absent friend's view.</p>
              ) : (
                <div className="qr-wrap"><QR value={link(m)} label={`QR for ${m.name}'s phone`} /><p className="small">Scan with {m.name}'s phone.</p></div>
              )}
              <CopyLine text={link(m)} />
            </Card>
          ))}
          <Card label="Headset and gallery">
            <h2 className="h2">Headset</h2>
            <p className="body">Quest Browser → <span className="mono">{location.host}/xr</span></p>
            <div className="join-code center">{seed.headsetCode}</div>
            <hr className="rule" />
            <h2 className="h2">Gallery</h2>
            <Link className="btn block" to={`/t/${seed.joinCode}/gallery`} target="_blank">Open the gallery view</Link>
            <p className="small mono center mt-s">Code {seed.joinCode}</p>
          </Card>
        </>
      ) : null}
    </Page>
  );
}
