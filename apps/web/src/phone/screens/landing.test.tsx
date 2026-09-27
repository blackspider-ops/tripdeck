// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Landing from "./Landing";

afterEach(cleanup);

describe("Landing (tripdeck.tech front page)", () => {
  it("says the line and links into the create / join flows and the Quest start", () => {
    render(<MemoryRouter><Landing /></MemoryRouter>);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Everyone's in, or nobody pays.");
    expect(screen.getAllByRole("link", { name: "Start a trip" })[0].getAttribute("href")).toBe("/new");
    expect(screen.getAllByRole("link", { name: "Join with a code" })[0].getAttribute("href")).toBe("/join");
    expect(screen.getByRole("link", { name: "Open the app" }).getAttribute("href")).toBe("/new");
    expect(screen.getByRole("link", { name: "tripdeck.tech/xr" }).getAttribute("href")).toBe("/xr");
  });
  it("walks through five steps and is honest about the money", () => {
    render(<MemoryRouter><Landing /></MemoryRouter>);
    const steps = screen.getByRole("heading", { name: "How it works" }).closest("section")!.querySelectorAll("ol > li");
    expect([...steps].map((li) => li.querySelector("h3")!.textContent)).toEqual(["Brief your mate", "The table", "Dry Run", "Vote", "Seal"]);
    expect(screen.getByText(/no real money moves/)).toBeTruthy();
    expect(screen.getByText(/Meta Quest, Gemini, ElevenLabs, MongoDB Atlas, Backboard, Visa Developer sandbox/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "GitHub" }).getAttribute("href")).toBe("https://github.com/blackspider-ops/tripdeck");
    expect(screen.getByRole("contentinfo").textContent).toMatch(/HackGT 13/);
  });
});
