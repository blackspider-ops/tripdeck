# 10 — The headset: an iPhone 16 Pro in a Gear VR shell

We didn't get a Quest 3, and we don't have a Galaxy phone. The headset is an **iPhone 16 Pro** (iOS 18, Safari) clamped into a **Samsung Gear VR shell**, which we use only as a lens viewer. This page covers the whole setup, start to finish, and it's written so anyone on the team can follow it at 7 AM on no sleep.

If a Quest turns up, nothing here gets in its way: `/xr` in Quest Browser still opens the mixed-reality table (doc 03 §4). If someone lends us a Gear VR-compatible Galaxy phone, see the appendix.

---

## 1. What this setup is (and isn't)

The Gear VR shell is plastic, two lenses, a focus wheel and a clamp. **The iPhone is the screen and the computer.** The shell's electronics (side touchpad, Back button, proximity sensor) only talk to a Galaxy phone through its USB plug. An iPhone can't use that plug, so we **don't plug it in**, and none of those controls do anything.

| It does | It doesn't |
|---|---|
| Show the VR chart room side by side through the lenses | See the room. No cameras and no passthrough, so no "chart on your real table" |
| Turn with your head (3DoF: look around, tilt) | Track you moving. If you lean forward, the table doesn't get closer |
| Select by **gaze**: hold the centre reticle on something for 1.6 s | Touchpad, Back button, controller. With no USB link to the phone, they're dead plastic |
| Run the page in **Safari** | Run WebXR natively. Safari on iPhone has no WebXR, so the page brings its own (below) |

**How it runs.** Safari on iOS has no WebXR. When `/xr` opens on a phone that can't do `immersive-ar` or `immersive-vr`, the page loads **webxr-polyfill in Cardboard mode**: it draws the scene side by side with lens distortion and turns the view using the iPhone's motion sensors (`deviceorientation`). On an iPhone this is the primary path, not a fallback, so you don't need `?vr=cardboard`.

On this setup All Ayes is a **VR chart room**: a dark room with a walnut table and the chart on it, at a fixed seated height. You don't place anything. The table is already in front of you when you put the headset on. Everything else is the same scene the Gallery shows: pieces, voices, ink ribbons, Dry Run cloches and wax seals.

**Honest limits.**
- 3DoF only. Head turns are tracked, head movement isn't.
- Gaze-dwell acts on **anything the reticle rests on for 1.6 s**, including a Dry Run cloche (picking a chart). A wandering gaze can pick. The organizer's phone is the safer place to pick and seal.
- The lens distortion uses the published Google Cardboard (2015) values. Nobody has measured them for Gear VR lenses, so the edges of the view may bend a little.

---

## 2. What you need

| ✓ | Item | Notes |
|---|---|---|
| ☐ | **iPhone 16 Pro**, iOS 18 up to date, charged ≥ 80% | Take the **case off** |
| ☐ | **Gear VR shell**, any model | Lenses wiped. The USB holder stays as it is; we don't use it |
| ☐ | A folded square of paper or thin foam | To pad the phone so it can't slide in the clamp (§3) |
| ☐ | **Laptop** running the helm | Also shows the Gallery. Plug it into the projector/TV if there is one |
| ☐ | **A second phone** for the organizer (Rae) | Any phone. It holds the headset code, *Weigh anchor*, the picks and the seals |
| ☐ | (Optional) a third phone for Maya | Or skip it; Rae's phone alone runs the demo |
| ☐ | Wi‑Fi or a hotspot | The tunnel works over any internet connection |
| ☐ | `cloudflared` on the laptop | `brew install cloudflared`. It gives the HTTPS address that motion sensors need |
| ☐ | USB‑C cable + charger | For the iPhone between runs, never inside the shell |
| ☐ | Alcohol wipes | Lenses and face pad, between judges |

---

## 3. Fitting the iPhone into the shell

The clamp was made for Galaxy S6–S10 and Note 5–9 phones, which are roughly 142–162 mm long and 70–77 mm wide. The **iPhone 16 Pro is 149.6 × 71.5 × 8.25 mm** ([Apple: iPhone 16 Pro tech specs](https://support.apple.com/en-us/121031)), so it fits the length range, but the clamp isn't shaped for it.

1. **Take the case off.** With a case the phone won't seat flat against the lenses.
2. **Don't use the USB plug.** Don't try to push the iPhone's port onto the Micro‑USB or USB‑C holder. It won't connect, and forcing it can scratch the phone or crack the holder. If the holder sticks out and gets in the way, slide it to the side or pop it out.
3. **Turn the phone to landscape with the screen facing the lenses.** The page must already be in VR (§5, step 7) before the phone goes in.
4. **Centre it.** The middle of the screen should line up with the notch between the lenses. Check that the **camera bump clears** the clamp jaw and the front cover. If the bump presses on something, the phone tilts and one eye sees a skewed image.
5. **Stop it moving.** The iPhone sits a little loose in a clamp built for Galaxy phones. Wedge folded paper or a strip of foam between the phone's edge and the clamp so it can't slide sideways. A phone that slides out of centre gives a double image.
6. **Close the front cover** if your shell has one, and check that it doesn't press on the side buttons. The volume or power button pressed inside the shell will lock the screen or change the volume.
7. **Focus** with the **wheel on top** of the shell. Turn it until the ink on the chart is sharp.

---

## 4. iPhone prep (the night before)

| Setting | Where | Set to |
|---|---|---|
| iOS | Settings → General → Software Update | Latest iOS 18 |
| Low Power Mode | Control Center, or Settings → Battery | **Off**. It throttles the frame rate |
| Brightness | Control Center | High, about 80%. Turn it down if the phone gets hot |
| Auto‑Brightness / True Tone / Night Shift | Settings → Accessibility → Display & Text Size; Settings → Display & Brightness | Off. Colours in the chart room shift, and brightness wanders mid-demo |
| Auto‑Lock | Settings → Display & Brightness → Auto‑Lock | **5 minutes**. The page holds a screen wake lock while it's open, but this is the backstop |
| Do Not Disturb (Focus) | Control Center | **On**. A notification in VR is a banner over one eye |
| Silent mode | Side switch / Action button | **Off**, media volume up. Web audio can be muted in silent mode |
| Rotation Lock | Control Center | **Off**. The page waits for landscape |
| Motion & Orientation Access | Settings → Safari (see note) | **On**, if your iOS shows the toggle |
| Safari toolbar | In Safari: **aA → Hide Toolbar** (on `/xr`, before Enter VR) | Hidden, so the side-by-side view fills the screen ([Apple: change the layout in Safari](https://support.apple.com/guide/iphone/ipha9ffea1a3/ios)). Tap the bottom edge to bring it back |

**Note on motion access.** Head tracking needs Safari to share the phone's motion sensors with the page. Safari once had a global **Settings → Safari → Motion & Orientation Access** toggle (added in iOS 12.2, [MacRumors](https://www.macrumors.com/2019/02/04/ios-12-2-safari-motion-orientation-access-toggle/)). Since iOS 13 each site asks for itself instead: tapping **Enter VR** shows iOS's *"… would like to access motion and orientation"* prompt, and you tap **Allow**. On iOS 18 the global toggle usually isn't there at all ([Apple Developer Forums](https://developer.apple.com/forums/thread/771270)). If you find it, turn it on. If you don't, the prompt is what counts.

If someone taps **Don't Allow**, Safari remembers the answer for that site. The page then shows: *"Head tracking needs motion access. Tap Enter VR again and choose Allow. If Safari doesn't ask, close this tab and open the link again (…)."* To fix it, **close the tab and open `/xr` in a new tab**. If that doesn't bring the prompt back, go to Settings → Apps → Safari → Advanced → Website Data, delete the `trycloudflare.com` entry, and reopen `/xr`. A new tunnel address is a new site, so it asks again anyway.

**Why HTTPS.** Safari only gives motion data to a secure page ([MDN: DeviceOrientation](https://developer.mozilla.org/en-US/docs/Web/API/Window/deviceorientation_event)). `http://192.168.x.x:5173` from the laptop will load, but the view never turns. Always use the `https://…trycloudflare.com` address.

---

## 5. Running the demo

This is the same production-mode tunnel flow as README *Run it*. Do it in this order.

**On the laptop**

```bash
npm run build
cloudflared tunnel --url http://localhost:8787      # prints https://<random>.trycloudflare.com; leave it running
APP_ENV=production SERVE_WEB=1 PUBLIC_BASE_URL=https://<random>.trycloudflare.com DEV_KEY=$(openssl rand -hex 24) npm run start:prod
```

Write down the tunnel address and the `DEV_KEY`. The address changes every time you restart `cloudflared`, and every device needs the new one.

1. **Seed.** On the laptop open `https://<tunnel>/demo#key=<DEV_KEY>` → *Seed the Expo voyage*. You get three links: Rae, Maya and the Gallery.
2. **Gallery on the laptop.** Open the Gallery link on the laptop and put it on the projector. The judges watch this.
3. **Rae on the organizer's phone** (the second phone, not the iPhone in the headset). Send Rae's link to it (AirDrop, a message to yourself, a QR code) and open it once. The link works once, within 2 hours. If it's used up, re‑seed.
4. **Get the headset code.** On Rae's phone, on the Muster screen, tap **Show headset code**. If you're past that screen, use the **Headset code or unpair** link instead. The code is 8 characters, lasts 10 minutes and works once.
5. **Open `/xr` on the iPhone.** In Safari open `https://<tunnel>/xr` and type the 8-character code. The Enter card shows *"Checking for mixed reality and VR…"*, then **Enter VR** and **Laptop view**.
6. **Hide the toolbar.** Tap **aA → Hide Toolbar**.
7. **Enter VR.** Tap **Enter VR**. When iOS asks for motion and orientation access, tap **Allow**. If the phone is still upright you'll see **"Turn your phone sideways"**. Turn it to landscape and the side-by-side chart room appears.
8. **Clamp it in** (§3): screen to the lenses, centred, padded. Hold the headset to your face and look straight ahead. If the table isn't in front of you, look at the brass ship's wheel and keep your gaze on it for 3.2 s to **Recenter** (§6).
9. **Start.** When all the crew pieces are at the table, **Rae taps *Weigh anchor* on the phone.** The wearer can also do it by holding their gaze on the Captain's tag.

**Leaving VR.** Look down at the red **Exit VR** plaque below the table and hold your gaze on it, or use menu → **Exit**. You're back on the Enter card and the pairing is kept, so **Enter VR** goes straight back in.

**After each run.** Re‑seed on `/demo`, get a **new headset code** (step 4) and re‑pair the iPhone (step 5). Re‑seeding ends the old pairing.

---

## 6. Controls in the headset

The only input is where you look. A small ink **reticle** sits in the middle of your view, and whatever it rests on is what you'll select.

| To… | Do this |
|---|---|
| Aim | Turn your head. The reticle follows your gaze |
| **Select** | **Hold your gaze** on the thing for **1.6 s**. A red ring fills around the reticle, and it selects when full. (Tapping the screen also selects, but you can't reach the screen once the phone is in the shell) |
| Weigh anchor | Hold your gaze on the Captain's tag. Better: Rae taps it on the phone |
| Hail | Hold your gaze on the **"Hail the table"** tag on the table's near-left edge. It's only there while hails are open. A **HAIL THE TABLE** card opens with four set lines and **Never mind**. Hold your gaze on one |
| Pick a chart | Hold your gaze on a cloche. **Prefer Rae's phone**: dwell picks whatever you stare at |
| Pause/resume the Dry Run clock | Hold your gaze on the carriage clock |
| Open the menu | Hold your gaze on the **brass ship's wheel** on the chart's south-east edge |
| **Recenter** | **Keep your gaze on the wheel for 3.2 s** (it recenters directly), or menu → **Recenter**. The table moves to straight ahead of wherever you're facing |
| Leave VR | Look down at the red **Exit VR** plaque and hold your gaze, or menu → **Exit** |

**Menu items:** **Recenter** · **Captions: M** (cycles S / M / L) · **Reduce motion: off** · **Sound: on** · **Photoreal cities: off** (turning it on loads Google 3D Tiles into the cloches: heavy and hot, so leave it off) · **Lens spacing: normal** · **Debug: off** · **Exit**.

**Who does what.** The wearer **looks**. The organizer's phone **drives**: *Weigh anchor*, picks and seals. Everyone else watches the Gallery on the projector.

Tips for the wearer:
- **Sit down** and keep your head fairly still. The table is set for someone seated.
- Don't turn your chair to chase a drifting table. Recenter instead.
- Voices come out of the iPhone speaker, muffled by the shell. In a loud room, rely on the captions and the Gallery's speaker.

---

## 7. Lens spacing (double image, eye strain)

The side-by-side views have to line up with the lenses. The Gear VR's lenses are about 62 mm apart, and the page assumes the same. If the wearer sees two tables, or their eyes strain after a few seconds, change **Lens spacing** in the menu:

| Setting | Lens centres | Try it when |
|---|---|---|
| narrow | 58 mm | The two images drift apart outward, or the wearer's eyes are close‑set |
| **normal** (default) | 62 mm | Start here |
| wide | 66 mm | The images cross, or the wearer's eyes are wide‑set |

It applies at once, even mid-session, and the phone remembers it. To set an exact value, add `?ipd=<mm>` to the URL (50–75), e.g. `https://<tunnel>/xr?ipd=60`. That value replaces **normal**.

Before you move the spacing, check that the phone is centred in the clamp (§3). A phone that's a few millimetres off-centre looks exactly like a wrong spacing.

**URL flags.**

| Flag | Does |
|---|---|
| `?ipd=<mm>` | Lens spacing in mm (50–75) for the *normal* profile |
| `?vr=cardboard` | Forces the Cardboard (polyfill) path. The iPhone already uses it. Useful on a laptop (stereo, no head tracking) or on a browser whose native WebXR misbehaves |
| `?lowtex` | Low-resolution textures (already on with any `?vr=`). Use it if the phone is hot or stutters |

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| **View doesn't turn with your head** | Motion access denied, or the page is on `http://` | See the motion-access note in §4: close the tab, reopen `/xr`, **Enter VR**, **Allow**. Always use the `https://` tunnel address |
| Message: *"Head tracking needs motion access…"* | **Don't Allow** was tapped | Same as above. If a new tab doesn't ask again, delete the site's website data (§4) |
| **Double image** / eyes strain | Phone off-centre, or lens spacing wrong | Re-centre and pad the phone (§3), then menu → **Lens spacing**, or `?ipd=` (§7) |
| **Blurry** | Focus, smudges | Turn the focus wheel on top. Wipe the lenses and the phone screen |
| **Black or half screen**, one eye cut off | Safari toolbar showing, or the phone is still in portrait | **aA → Hide Toolbar**, landscape, Rotation Lock off. If it's stuck on **"Turn your phone sideways"**, take the phone out and rotate it once |
| Screen went dark mid-run | Auto-Lock, or a side button pressed by the clamp | Auto-Lock 5 min (§4); make sure the shell cover doesn't press the buttons; unlock, reopen `/xr` (the pairing is kept) |
| **Table drifts** or isn't in front | 3DoF sensor drift, which is normal over a few minutes | Keep your gaze on the ship's wheel for 3.2 s, or menu → **Recenter** |
| Something got picked by accident | Dwell selects whatever the reticle rests on | Picks and seals belong on Rae's phone. Tell the wearer to look at the table, not stare at the cloches |
| **Phone hot**, "Temperature" warning, stutters | The shell traps heat; brightness; photoreal tiles | Out of the shell, screen off, 5 minutes. *Photoreal cities* off, `?lowtex`, brightness down. Take it out between judges. Never charge it in the shell |
| Battery under 30% | VR drains fast | Charge between runs |
| No voices | Silent mode, volume, or audio not unlocked | Silent mode off, media volume up; **Exit VR**, then tap **Enter VR** again (the tap unlocks audio) |
| Code refused on `/xr` | Older than 10 min, already used, or the voyage was re-seeded | New code from Rae's phone |
| Pairing card shows again by itself | `DEVICE_EXPIRED`: a newer pairing, unpaired from Rae's phone, or 12 h passed | Type a new code |
| Tunnel URL stopped working | `cloudflared` was restarted, so the address changed | New address on every device, re-seed |
| Gallery and headset disagree | One of them dropped its socket | Reload that one. The server is the source of truth |
| Wearer feels sick | 3DoF, drift, low frame rate | Take the headset off. Keep sessions under 3 minutes, seated, and turn on **Reduce motion**. Point queasy judges at the Gallery |
| Nothing works in the headset | — | Don't debug in front of judges. Say "Same table on the screen" and continue on the Gallery (doc 09 §2) |

---

## 9. Sixty seconds before each demo

1. ☐ Tunnel running; `https://<tunnel>/api/health` answers on the laptop.
2. ☐ Fresh seed on `/demo#key=…`; Gallery up on the projector.
3. ☐ Rae's phone on the Muster screen, **new headset code** showing.
4. ☐ iPhone: ≥ 50% battery, cool to the touch, case off, Low Power Mode off, Do Not Disturb on, silent off, brightness up.
5. ☐ Safari on `https://<tunnel>/xr`, code typed, crew visible, **aA → Hide Toolbar**, **Enter VR**, motion **allowed**, landscape.
6. ☐ Clamped in: centred, padded, camera bump clear, buttons not pressed. Focus wheel set.
7. ☐ Put it on yourself for five seconds: table ahead, one image (not two), reticle visible, voices audible. **Recenter** if needed.
8. ☐ Lenses and face pad wiped. Hand it over, and tell the judge: "Just look around. Rae drives from her phone."

---

## Appendix A: a borrowed Galaxy phone

If someone lends us a Gear VR-compatible Galaxy phone (S6–S10, Note 5–9; the Note 10 and later don't fit, [UploadVR](https://www.uploadvr.com/note-10-no-gear-vr/)), it can use the shell's **touchpad**:

- **Connector:** SM‑R322 is Micro‑USB only; SM‑R323/R324/R325 take swappable Micro‑USB or USB‑C holders. S8 and later need the USB‑C holder ([Road to VR](https://roadtovr.com/everything-you-need-to-know-about-samsung-gear-vr-phone-compatibility/)).
- **Browser:** update Chrome (Play Store) and Samsung Internet (Galaxy Store). Chrome for Android does WebXR `immersive-vr` natively in Cardboard-style side-by-side. If it's missing or misbehaves, add `?vr=cardboard` to use the polyfill as the iPhone does.
- **The Oculus app hijacks the phone** when it's pushed onto the plug (Gear VR Service). Disable it: Settings → Apps → *Gear VR Service* → *Disable*; if that's greyed out, use Package Disabler Pro ([TechCult](https://techcult.com/how-to-disable-gear-vr-service/)). If none of that works, clamp it **without** the plug and use gaze, like the iPhone.
- **Controls with the plug:** a **side touchpad tap** reaches the page as a tap or Enter key, which is a select (same as the 1.6 s dwell). **Back** leaves VR (like Escape on a keyboard). Everything else (dwell, wheel, Exit plaque, menu) is the same as §6.
- Settings: screen timeout 10 min, Do Not Disturb on, battery saver off, brightness ~70%.
- The Gear VR Bluetooth controller pairs through the dead Oculus app and does nothing. Leave it in the box.

## Appendix B: a Quest

On a Meta Quest 3 (or any browser that can do `immersive-ar`), the Enter card offers **Enter the chart room** instead: mixed reality with passthrough, the chart laid on your real table (pinch to place), hands or controllers to select. Same URL, same pairing code. See doc 03 §4 and doc 04 §9.1.
