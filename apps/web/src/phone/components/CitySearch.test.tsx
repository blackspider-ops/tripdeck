// @vitest-environment happy-dom
// "Any city on Earth": CitySearch with a mocked fetch — debounce, min length, curated-first badges, picks, errors.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorldSearchResponse } from "@all-ayes/shared";
import { CitySearch, SEARCH_DEBOUNCE_MS } from "./CitySearch";

const RESP: WorldSearchResponse = {
  world: "ok",
  attribution: "© OpenStreetMap contributors",
  results: [
    { kind: "curated", cityId: "BCN", name: "Barcelona", country: "Spain", countryCode: "", lat: 41.39, lng: 2.17, displayName: "Barcelona, Spain" },
    { kind: "world", osmId: "R2417889", name: "Barcelona", country: "Venezuela", countryCode: "VE", state: "Anzoátegui", lat: 10.13, lng: -64.69, displayName: "Barcelona, Anzoátegui, Venezuela" },
  ],
};
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn(async () => ok(RESP));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const type = (v: string) => fireEvent.change(screen.getByRole("combobox"), { target: { value: v } });
const settle = async (ms = SEARCH_DEBOUNCE_MS) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe("CitySearch", () => {
  it("waits for 2 characters and 400 ms of quiet, then asks once", async () => {
    render(<CitySearch onPick={() => undefined} />);
    type("b");
    await settle(1_000);
    expect(fetchMock).not.toHaveBeenCalled();
    type("ba"); await settle(200);
    type("bar"); await settle(200);
    type("barc"); await settle(399);
    expect(fetchMock).not.toHaveBeenCalled();
    await settle(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/world/search?q=barc");
  });

  it("lists curated first with badges, and the OSM attribution for map rows", async () => {
    render(<CitySearch onPick={() => undefined} />);
    type("barcelona");
    await settle();
    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Curated");
    expect(rows[1].textContent).toContain("From the map");
    expect(rows[1].textContent).toContain("Anzoátegui, Venezuela");
    expect(screen.getByText(/© OpenStreetMap contributors/)).toBeTruthy();
  });

  it("picks: a curated city by id, a map city by OSM ref (click and keyboard)", async () => {
    const onPick = vi.fn();
    render(<CitySearch onPick={onPick} />);
    type("barcelona");
    await settle();
    fireEvent.click(screen.getAllByRole("option")[0].querySelector("button")!);
    expect(onPick).toHaveBeenLastCalledWith({ kind: "curated", cityId: "BCN" });
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenLastCalledWith({ kind: "world", osmId: "R2417889", name: "Barcelona", country: "Venezuela" });
  });

  it("an older answer never replaces a newer query's", async () => {
    let releaseOld!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { releaseOld = r; }));
    fetchMock.mockImplementationOnce(async () => ok({ ...RESP, results: [RESP.results[0]] }));
    render(<CitySearch onPick={() => undefined} />);
    type("barc"); await settle();
    type("barcelona"); await settle();
    await act(async () => { releaseOld(ok({ ...RESP, results: [RESP.results[1]] })); await vi.advanceTimersByTimeAsync(0); });
    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Curated");
  });

  it("shows an error, an empty result, and the curated-only notice", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("{}", { status: 503 }));
    render(<CitySearch onPick={() => undefined} />);
    type("zz"); await settle();
    expect(screen.getByRole("alert").textContent).toMatch(/Couldn't search/);
    fetchMock.mockImplementationOnce(async () => ok({ ...RESP, results: [] }));
    type("zzz"); await settle();
    expect(screen.getByText(/No port by that name/)).toBeTruthy();
    fetchMock.mockImplementationOnce(async () => ok({ ...RESP, world: "unavailable", results: [RESP.results[0]] }));
    type("barce"); await settle();
    expect(screen.getByText(/curated ports only/)).toBeTruthy();
    expect(screen.queryByText(/© OpenStreetMap contributors/)).toBeNull();
  });
});
