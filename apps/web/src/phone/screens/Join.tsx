import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { JOIN_CODE_LEN } from "@all-ayes/shared";
import { Anchor } from "../components/icons";
import { Eyebrow, LinkButton, Page, StampButton } from "../components/ui";

/** Enter a join code, then TripShell shows the crew form (P3). */
export default function Join() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [code, setCode] = useState((params.get("code") ?? "").toUpperCase());
  const clean = code.replace(/[^A-Z0-9]/g, "").slice(0, JOIN_CODE_LEN);
  return (
    <Page>
      <Eyebrow icon={<Anchor size={18} />}>All Ayes</Eyebrow>
      <h1 className="h1">Join a voyage</h1>
      <p className="body">Type the six‑character code your organizer shared, or scan their QR.</p>
      <form onSubmit={(e) => { e.preventDefault(); if (clean.length === JOIN_CODE_LEN) navigate(`/t/${clean}`); }}>
        <label className="field"><span>Voyage code</span>
          <input
            className="input code" value={clean} inputMode="text" autoCapitalize="characters" autoComplete="off"
            aria-label="Voyage code" onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="K7M2QX"
          />
        </label>
        <StampButton type="submit" disabled={clean.length !== JOIN_CODE_LEN}>Come aboard</StampButton>
      </form>
      <div className="center"><LinkButton onClick={() => navigate("/")}>Back</LinkButton></div>
    </Page>
  );
}
