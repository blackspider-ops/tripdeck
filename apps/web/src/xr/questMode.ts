// Quest-first helpers (docs/03 §4): is this a headset browser, the larger phone screens for a headset seat, and
// whether this browser can hold a passkey (else the member sets a seal PIN).

/** Quest Browser (Meta Quest 2/3/3S/Pro): "OculusBrowser" in the user agent. */
export function isQuestBrowser(ua: string): boolean {
  return /OculusBrowser|Quest/i.test(ua);
}

/** The phone screens drawn larger (html.quest-ui: zoom 1.3, so 17 px body text reads as ~22 px and buttons as 60+ px). */
export function questUi(on: boolean) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("quest-ui", on);
  return () => document.documentElement.classList.remove("quest-ui");
}

/**
 * Can this browser hold a passkey (a user-verifying platform authenticator)? Quest Browser may not: then the member
 * sets a 4–6 digit seal PIN when they join on the headset.
 */
export async function passkeysUsable(win: { PublicKeyCredential?: unknown } = globalThis as never): Promise<boolean> {
  const PKC = win.PublicKeyCredential as { isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean> } | undefined;
  if (typeof PKC !== "function" && typeof PKC !== "object") return false;
  try { return Boolean(await PKC?.isUserVerifyingPlatformAuthenticatorAvailable?.()); } catch { return false; }
}

/** A 4–6 digit seal PIN. */
export const pinOk = (pin: string) => /^\d{4,6}$/.test(pin);
