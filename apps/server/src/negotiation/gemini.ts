/**
 * Gemini transport for the crew's lines (docs/05-agent-spec.md §1, §6, §10). The requests (system prompts, facts)
 * are worded in prompts.ts (O2-019); this file only sends one and checks the shape of what comes back.
 * The protocol decides the legal acts; Gemini writes every line in character, and in
 * AGENT_DECISIONS=model it may also choose the act/plan from the legal options.
 */
import { GoogleGenAI, Type } from "@google/genai";
import { config, features } from "../config.js";
import { spend } from "../util/limits.js";
import { withTimeout } from "../util/timeout.js";
import type { LineRequest } from "./prompts.js";

/** O2-033: a line is short; a model that takes longer than this is skipped for the template (O2-011: timer cleared). */
const MAX_OUTPUT_TOKENS = 300;
const MODEL_TIMEOUT_MS = 6_000;

let client: GoogleGenAI | null = null;
const ai = () => (client ??= new GoogleGenAI({ apiKey: config.gemini.apiKey }));

interface GenLine { line: string; ribbon: string; act?: string; planId?: string }

export async function generateLine(p: LineRequest): Promise<GenLine | null> {
  if (!features.gemini()) return null;
  if (!spend("gemini")) return null; // SEC-005: budget spent → the protocol's template line
  const properties: Record<string, { type: Type; description?: string }> = {
    line: { type: Type.STRING, description: "What you say out loud. No dollar amounts except public prices given to you." },
    ribbon: { type: Type.STRING, description: "At most 8 words, handwritten on the chart." },
  };
  if (p.allowChoice) {
    properties.act = { type: Type.STRING };
    properties.planId = { type: Type.STRING };
  }
  const call = ai().models.generateContent({
    model: config.gemini.model,
    contents: p.user,
    config: {
      systemInstruction: p.system,
      temperature: p.temperature,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      responseMimeType: "application/json",
      responseSchema: { type: Type.OBJECT, properties, required: Object.keys(properties) },
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  try {
    const res = await withTimeout(call, MODEL_TIMEOUT_MS, () => null);
    if (!res || !res.text) return null;
    const out = JSON.parse(res.text) as GenLine;
    if (typeof out.line !== "string" || typeof out.ribbon !== "string") return null;
    return out;
  } catch (e) {
    console.warn("[gemini]", (e as Error).message);
    return null;
  }
}
