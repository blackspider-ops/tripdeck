import { useNavigate } from "react-router-dom";
import { lastJoinCode } from "../../net/session";
import { Anchor } from "../components/icons";
import { Card, Eyebrow, LinkButton, Page, StampButton } from "../components/ui";

/** P0 — Landing. */
export default function Landing() {
  const navigate = useNavigate();
  const last = lastJoinCode();
  return (
    <Page>
      <Eyebrow icon={<Anchor size={18} />}>Tripdeck</Eyebrow>
      <h1 className="display">Everyone's in, or nobody pays.</h1>
      <p className="body muted">Send your mate to the table.</p>

      <div className="stack mt-l">
        <StampButton onClick={() => navigate("/new")}>Start a voyage</StampButton>
        <div className="center">
          <LinkButton onClick={() => navigate("/join")}>Join with a code</LinkButton>
        </div>
        {last ? (
          <div className="center">
            <LinkButton onClick={() => navigate(`/t/${last}`)}>Back to voyage <span className="mono">{last}</span></LinkButton>
          </div>
        ) : null}
      </div>

      <Card label="How it works">
        <div className="eyebrow">How it works</div>
        <ol className="steps">
          <li>Seal your terms — only your mate sees them.</li>
          <li>The mates argue it out at the table.</li>
          <li>Watch both trips run dry.</li>
          <li>Everyone seals their share — or nobody pays.</li>
        </ol>
      </Card>
    </Page>
  );
}
