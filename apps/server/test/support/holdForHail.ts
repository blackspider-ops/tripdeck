/**
 * O2-062: full-voyage socket tests run at PACE_SCALE=0, so a meeting no longer waits ~125 ms per line and a hail sent
 * over the wire could arrive after the table has moved on. Instead of pacing, this holds one Watch-1 PROPOSE line
 * (its voice step, which the engine awaits) until a hail is pending for that voyage — event-driven, no sleeps.
 * `memberId` picks whose PROPOSE is held (default: the first one spoken). Gives up after `maxMs` so a test that
 * never hails can't hang.
 */
import type { TripService } from "../../src/trips/service.js";

type Hooks = { voice(turnId: string, text: string, key?: string): Promise<number | null> };
type TableLike = { engineHooks(t: { _id: string; negotiation: { turns: { turnId: string; act: string; watch?: number; speaker: { memberId?: string } }[] } }, m: unknown): Hooks };

export function holdForHail(helm: TripService, opts: { memberId?: string; maxMs?: number } = {}) {
  const table = helm.table as unknown as TableLike;
  const original = table.engineHooks.bind(table);
  table.engineHooks = (t, memories) => {
    const io = original(t, memories);
    const voice = io.voice.bind(io);
    let held = false;
    io.voice = async (turnId, text, key) => {
      const turn = t.negotiation.turns.find((x) => x.turnId === turnId);
      if (!held && turn?.act === "PROPOSE" && turn.watch === 1 && (!opts.memberId || turn.speaker.memberId === opts.memberId)) {
        held = true;
        await until(() => (helm.pendingHails.get(t._id)?.length ?? 0) > 0, opts.maxMs ?? 5_000);
      }
      return voice(turnId, text, key);
    };
    return io;
  };
  return () => { table.engineHooks = original; };
}

/** Resolves once `pred()` holds, checking on every macrotask turn (socket I/O gets through between checks). */
function until(pred: () => boolean, maxMs: number): Promise<void> {
  const end = Date.now() + maxMs;
  return new Promise((resolve) => {
    const tick = () => (pred() || Date.now() > end ? resolve() : setImmediate(tick));
    tick();
  });
}
