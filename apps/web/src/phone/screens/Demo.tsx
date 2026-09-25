import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../net/api";
import { saveSession } from "../../net/session";
import { useAsyncAction } from "../useAsyncAction";
import { Lighthouse } from "../components/icons";
import { CopyLine, QR } from "../components/crew";
import { Card, Eyebrow, MarginNote, Page, StampButton } from "../components/ui";

type Seeded = Awaited<ReturnType<typeof api.seedDemo>>;

/** Dev helper: seed the Expo voyage (Rae, Maya, Dev pre-sealed) and hand out links. */
export default function Demo() {
  const [seed, setSeed] = useState<Seeded | null>(null);
  const { busy, err, run } = useAsyncAction();
  const origin = typeof location !== "undefined" ? location.origin : "";

  // SEC-004/SEC-019: a one-time handoff code (never the member token), in the fragment so no server log sees it
  const link = (m: { memberId: string; handoff: string }) =>
    `${origin}/t/${seed!.joinCode}#as=${encodeURIComponent(m.handoff)}&m=${encodeURIComponent(m.memberId)}`;

  return (
    <Page>
      <Eyebrow icon={<Lighthouse size={18} />}>Expo station</Eyebrow>
      <h1 className="h1">Seed the demo voyage</h1>
      <p className="body">Creates Rae (organizer), Maya and Dev (away) with sealed terms. Open each link on its own phone.</p>
      <StampButton
        disabled={busy} onClick={() => void run(async () => {
          const s = await api.seedDemo();
          saveSession({ tripId: s.tripId, joinCode: s.joinCode, memberId: s.organizer.memberId, memberToken: s.organizer.memberToken });
          setSeed(s);
        }, "Couldn't seed. Is the server running?")}
      >
        {seed ? "Seed a fresh voyage" : "Seed voyage"}
      </StampButton>
      {err ? <MarginNote>{err}</MarginNote> : null}

      {seed ? (
        <>
          <Card label="Rae">
            <h2 className="h2">Rae · organizer</h2>
            <p className="small">This device is now Rae.</p>
            <Link className="btn block" to={`/t/${seed.joinCode}`}>Open as Rae</Link>
            <CopyLine text={link(seed.organizer)} />
          </Card>
          <Card label="Maya">
            <h2 className="h2">Maya</h2>
            <div className="qr-wrap"><QR value={link(seed.maya)} label="QR for Maya's phone" /><p className="small">Scan with Maya's phone.</p></div>
            <CopyLine text={link(seed.maya)} />
          </Card>
          <Card label="Dev">
            <h2 className="h2">Dev · away</h2>
            <p className="small">Pre‑signed. Only needed to show the absent friend's view.</p>
            <CopyLine text={link(seed.dev)} />
          </Card>
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
