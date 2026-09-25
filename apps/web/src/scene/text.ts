import { Text, preloadFont } from "troika-three-text";
import { PALETTE } from "@all-ayes/shared";

// Fonts are bundled under /textures/type so the headset doesn't depend on a CDN over venue Wi-Fi. Only the faces
// 3D text uses (O2-059: the bold heading was preloaded on the Quest and never drawn; the page CSS loads its own).
const FONTS = {
  display: "/textures/type/caslon-display.woff",
  heading: "/textures/type/caslon-text.woff",
  body: "/textures/type/source-serif.woff",
  mono: "/textures/type/plex-mono.woff",
  hand: "/textures/type/homemade-apple.woff",
} as const;
type FontKey = keyof typeof FONTS;

const CHARSET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$.,:;·—–'’\"!?()/×½¼&-…";
/** The display face draws one thing: the "A" pressed into each wax seal (SealChart). */
const PRELOAD_CHARS: Record<FontKey, string> = { display: "A", heading: CHARSET, body: CHARSET, mono: CHARSET, hand: CHARSET };

const failed = new Set<string>();

// Every bundled face covers Latin-1 plus these; anything else makes troika fetch a fallback font from
// a CDN (and never render the text if that fetch fails on venue Wi-Fi). Map or drop such characters.
// U+00AD (soft hyphen) is carved out of Latin-1 so SUBST drops it: troika draws nothing for it but breaks lines
// after it, which would split a word with no hyphen shown.
const COVERED = /^[\u0020-\u007e\u00a0-\u00ac\u00ae-\u00ff\n\u0131\u0152\u0153\u02c6\u02da\u02dc\u2013\u2014\u2018\u2019\u201a\u201c\u201d\u201e\u2022\u2026\u2039\u203a\u2044\u20ac\u2122\u2212]*$/;
const SUBST: Record<string, string> = { "→": "->", "←": "<-", "⇄": "<->", "✓": "", "✔": "", "✗": "x", "✘": "x", "⅓": "1/3", "⅔": "2/3", "≈": "~", "′": "'", "″": "\"", "\u00ad": "" };
export function coverText(s: string): string {
  if (COVERED.test(s)) return s;
  let out = "";
  for (const ch of s) {
    if (COVERED.test(ch)) out += ch;
    else if (ch in SUBST) out += SUBST[ch];
    else if (/\s/.test(ch)) out += " ";
  }
  return out.replace(/ {2,}/g, " ").trim();
}

/** Preload every face before entering XR so the first ribbon doesn't hitch. Never rejects. */
let preloading: Promise<void> | null = null;
export function preloadFonts(): Promise<void> {
  if (preloading) return preloading;
  const all = (Object.keys(FONTS) as FontKey[]).map(
    (key) =>
      new Promise<void>((resolve) => {
        // slow Wi-Fi: stop waiting, but keep the (same-origin) face — the fallback would be a CDN font
        const font = FONTS[key];
        const timer = setTimeout(resolve, 6000);
        try {
          preloadFont({ font, characters: PRELOAD_CHARS[key] }, () => {
            clearTimeout(timer);
            resolve();
          });
        } catch {
          clearTimeout(timer);
          failed.add(font);
          resolve();
        }
      }),
  );
  return (preloading = Promise.all(all).then(() => undefined));
}

export interface TextOpts {
  text: string;
  font?: FontKey;
  size: number; // meters
  color?: string | number;
  anchorX?: Text["anchorX"];
  anchorY?: Text["anchorY"];
  maxWidth?: number;
  align?: Text["textAlign"];
  lineHeight?: number;
  letterSpacing?: number;
}

export function makeText(o: TextOpts): Text {
  const t = new Text();
  t.text = coverText(o.text);
  const url = FONTS[o.font ?? "body"];
  t.font = failed.has(url) ? null : url; // null → troika's built-in fallback
  t.fontSize = o.size;
  t.color = o.color ?? PALETTE.ink;
  t.anchorX = o.anchorX ?? "center";
  t.anchorY = o.anchorY ?? "middle";
  if (o.maxWidth) t.maxWidth = o.maxWidth;
  t.textAlign = o.align ?? "left";
  if (o.lineHeight) t.lineHeight = o.lineHeight;
  if (o.letterSpacing) t.letterSpacing = o.letterSpacing;
  t.overflowWrap = "break-word";
  t.depthOffset = -1;
  t.sync();
  return t;
}

export function setText(t: Text, text: string) {
  text = coverText(text);
  if (t.text === text) return;
  t.text = text;
  t.sync();
}
