# 10 — Running the headset on a Samsung Gear VR

We did not get a Quest 3. We have a **Samsung Gear VR**. This page is the whole setup, start to finish, written so anyone on the team can do it at 7 AM on no sleep. If a Quest does turn up, nothing here gets in the way: `/xr` on a Quest still opens the mixed‑reality table (doc 03 §4).

---

## 1. What a Gear VR is (and isn't)

A Gear VR is a plastic shell with two lenses and a clamp. **The phone you slot into it is the screen and the computer.** No phone, no headset.

| It does | It doesn't |
|---|---|
| Show a VR scene side by side through the lenses | See the room. No cameras, no passthrough, so no "chart on your real table" |
| Turn with your head (3DoF: look around, tilt) | Track you moving. Lean forward and the table doesn't get closer |
| Give you a **side touchpad** (tap) and a **Back** button | Hand tracking, controllers without the Oculus app |
| Run a web page in Samsung Internet or Chrome | Run the old Oculus/Gear VR store. Oculus ended support; that side is dead ([Android Central](https://www.androidcentral.com/its-time-say-goodbye-samsung-gear-vr), [Wikipedia](https://en.wikipedia.org/wiki/Samsung_Gear_VR)) |

So on the Gear VR, All Ayes is a **VR chart room**: a quiet paper room with the chart table in front of you at a fixed seated height. You don't place it; it's already there when you put the headset on. Everything else (pieces, voices, ink ribbons, Dry Run cloches, wax seals) is the same scene the Gallery shows.

The in‑headset Samsung "Internet for Gear VR" browser was last updated in 2018 and predates WebXR. **We don't use it.** We use the normal phone browser in Cardboard‑style side‑by‑side mode, with the phone sitting in the Gear VR as a very good Cardboard viewer.

---

## 2. What you need

| ✓ | Item | Notes |
|---|---|---|
| ☐ | **A Gear VR‑compatible Galaxy phone**, charged ≥ 80% | S6/S7/S8/S9/S10 family, Note 5/8/9. **Note 10 and later don't fit and aren't supported** ([UploadVR](https://www.uploadvr.com/note-10-no-gear-vr/)). Best bet: an S9 or S10 on the newest Android it takes |
| ☐ | **The Gear VR** with the right connector for that phone | See the table below. Wipe the lenses |
| ☐ | **Laptop** running the helm | Also shows the Gallery; plug it into the projector/TV if there is one |
| ☐ | **A second phone** for the organizer (Rae) | Any phone. It holds the headset code and the *Weigh anchor* button |
| ☐ | (Optional) a third phone for Maya | Or skip; Rae's phone alone runs the demo |
| ☐ | Wi‑Fi or a hotspot all devices can reach | The tunnel works over any internet connection |
| ☐ | `cloudflared` installed on the laptop | `brew install cloudflared`. It gives us the HTTPS address WebXR needs |
| ☐ | USB‑C / micro‑USB cable + charger | For the Gear VR phone between runs |

### Which phone fits which Gear VR

The model number is on the inside of the shell or the box ([Road to VR](https://roadtovr.com/everything-you-need-to-know-about-samsung-gear-vr-phone-compatibility/), [Samsung SM‑R325](https://www.samsung.com/us/business/support/owners/product/gear-vr-with-controller-sm-r325/)).

| Gear VR | Year | Connector | Phones |
|---|---|---|---|
| SM‑R322 | 2015 | micro‑USB only | Note 5, S6, S6 edge/edge+, S7, S7 edge |
| SM‑R323 | 2016 | swappable micro‑USB **and** USB‑C holders | Note 5, S6 family, S7 family (and Note 7) |
| SM‑R324 | 2017, with controller | micro‑USB + USB‑C | as R323, plus S8, S8+ |
| SM‑R325 | late 2017, with controller | micro‑USB + USB‑C | S6–S8 families, Note 8; S9/S9+, Note 9 and S10/S10+ work with it too |

If the phone has USB‑C (S8 and later), you need an R323/R324/R325 with the USB‑C holder clicked in. The holder slides out sideways; the spare one is often lost, so check before the event.

The plug matters only for the side touchpad and Back button. If the phone won't connect to the plug, it can still sit in the clamp, and you select by holding your gaze (§5).

---

## 3. One‑time phone setup (do it the night before)

### 3.1 Update the browser
- Open the Galaxy Store and update **Samsung Internet**. WebXR arrived in Samsung Internet 11.2 and renders Cardboard‑style side by side ([Samsung Developers](https://developer.samsung.com/internet/blog/en/2020/04/27/virtual-reality-webxr-and-samsung-internet)). Anything 12 or newer is what we tested against.
- Also update **Chrome** from the Play Store. Chrome on Android does WebXR `immersive-vr` with Cardboard too. Keep both; if one misbehaves, try the other.
- Older phones (S6, S7) may be stuck on an old Android that the current browsers no longer support. If the browser can't update, use the Cardboard fallback (§6) or borrow a newer Galaxy.

### 3.2 Stop the Oculus app from hijacking the phone
When a Galaxy phone is plugged into a Gear VR, the **Gear VR Service** launches the Oculus app, which no longer works and blocks our page. Turn it off. It usually **cannot be uninstalled**, only disabled.

Try these in order:

1. **Disable it in Settings.** Settings → Apps → *Gear VR Service* → *Disable*. On many phones this button is greyed out. Then:
2. **Package Disabler Pro** (Play Store, a few dollars). Search for "Gear VR" and disable *Gear VR Service*, *Gear VR SetupWizardStub* and *Gear VR Shell* ([TechCult](https://techcult.com/how-to-disable-gear-vr-service/), [UnlockUnit](https://www.unlockunit.com/blog/get-rid-samsung-galaxy-vr-service-app/)).
3. **The VR Service developer mode trick.** Settings → Apps → *Gear VR Service* → *Storage* (or *Manage storage*) → tap **VR Service Version** about six times until a *Developer mode* toggle appears → switch it as needed ([10Scopes](https://10scopes.com/disable-gear-vr-service/), [XDA thread](https://xdaforums.com/t/easier-non-root-way-to-get-oculus-home-not-to-autolaunch-use-cardboard-apps-etc.3255907/page-2)). This menu only shows on phones where the Oculus software was installed once. Results vary by phone; test by plugging the phone into the Gear VR with the browser open. If the browser stays in front, you're done.

If none of that works: slot the phone into the clamp **without** pushing it onto the plug. The touchpad won't work, but gaze‑dwell does (§5).

### 3.3 Phone settings

| Setting | Where | Set to |
|---|---|---|
| Screen timeout | Settings → Display → Screen timeout | 10 minutes (the longest) |
| Brightness | Quick panel | Around 70%, adaptive **off**. Full brightness heats the phone fast |
| Do Not Disturb | Quick panel | **On**. A notification in VR is a banner over one eye |
| Auto‑rotate | Quick panel | **On** (the page wants landscape) |
| Battery saver / power mode | Settings → Battery | **Off**. It throttles the frame rate |
| Blue light filter / Night mode | Quick panel | **Off**. Colors in the chart room shift |
| Wi‑Fi | Settings | Connected to the same network as the organizer's phone, or any network with internet |
| Screen lock | Settings → Lock screen | None or swipe, just for the weekend |

### 3.4 Why HTTPS
WebXR and the phone's orientation sensor only work on a **secure page** (HTTPS) ([MDN: WebXR](https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API), [MDN: DeviceOrientation](https://developer.mozilla.org/en-US/docs/Web/API/Window/deviceorientation_event)). `http://192.168.x.x:5173` from the laptop will load, but the headset will never turn. Always use the `https://…trycloudflare.com` address from the tunnel.

---

## 4. Running the demo

Same production‑mode tunnel flow as README *Run it*. Do it in this order.

**On the laptop**

```bash
npm run build
cloudflared tunnel --url http://localhost:8787      # prints https://<random>.trycloudflare.com; leave it running
APP_ENV=production SERVE_WEB=1 PUBLIC_BASE_URL=https://<random>.trycloudflare.com DEV_KEY=$(openssl rand -hex 24) npm run start:prod
```

Write down the tunnel address and the `DEV_KEY`. The tunnel address changes every time you restart `cloudflared`, and every phone needs the new one.

1. **Seed.** In the laptop browser open `https://<random>.trycloudflare.com/demo#key=<DEV_KEY>` → *Seed the Expo voyage*. You get three links: Rae, Maya, the Gallery.
2. **Gallery on the laptop.** Open the Gallery link on the laptop and put it on the projector. Judges watch this.
3. **Rae on the organizer's phone.** Send Rae's link to the second phone (AirDrop, a message to yourself, a QR). Open it once. The link works for one open within 2 hours; if it's used up, re‑seed.
4. **Get the headset code.** On Rae's phone, on the Muster screen, tap **Show headset code**. (If you're past that screen, use the **Headset code or unpair** link.) It's 8 characters, valid 10 minutes, single use.
5. **Open `/xr` on the Gear VR phone.** In Samsung Internet or Chrome open `https://<random>.trycloudflare.com/xr`. Type the 8‑character code.
6. **Enter VR.** Tap **Enter VR**. Allow motion/VR access if the browser asks. Chrome may ask you to scan a viewer QR code the first time; skip it (the default is fine).
7. **Rotate to landscape**, screen facing the lenses, and **slot the phone into the Gear VR**: plug end first, then press the other side into the clamp. Hold the headset to your face, look straight ahead, and tap **Recenter** if the table isn't in front of you.
8. **Start.** When the crew pieces are all at the table, Rae taps **Weigh anchor** on the phone, or the wearer looks at the Captain's tag and taps the touchpad.

After each run: re‑seed on `/demo`, then a **new headset code** (step 4) and re‑pair the Gear VR phone (step 5). The old pairing ends when the voyage is re‑seeded.

---

## 5. Controls in the headset

There's a small ink **reticle** (a dot) in the middle of your view. Whatever it sits on is what you'll select.

| To… | Do this |
|---|---|
| Aim | Turn your head. The reticle follows your gaze |
| Select | **Tap the side touchpad**, or tap the screen / press Enter if the phone is out of the headset. Or **hold your gaze** on the thing for **1.6 s**; a ring fills around the reticle, and it selects when full |
| Weigh anchor | Look at the Captain's tag, select |
| Hail | Look at empty space, select → the hail card with four set lines; look at one, select |
| Pick a chart | Look at a cloche, select |
| Pause/resume the Dry Run clock | Look at the carriage clock, select |
| Open the menu | Look at the brass ship's wheel on the chart's south‑east edge, select |
| **Recenter** | Menu → *Recenter*. Puts the table straight in front of wherever you're facing now |
| Leave VR | The Gear VR's **Back** button (Android Back). Escape on a keyboard |

Menu items in VR: *Recenter* · *Captions S / M / L* · *Reduce motion* · *Sound* · **Photoreal cities** (off by default in VR; turning it on loads Google 3D Tiles in the cloches, which is heavy for an old phone) · *Debug* · *Exit*.

Tips for the person wearing it:
- **Sit down** and keep the head still‑ish. The table is set for a seated person.
- Don't chase a drifting table by turning your chair. Use *Recenter*.
- Voices come out of the phone speaker. In a loud room, wear wired earbuds into the phone (if it has a jack) or trust the captions.

---

## 6. Fallback paths

| Problem | Do this |
|---|---|
| **Enter VR doesn't appear, or says VR isn't supported** | The browser has no WebXR. Open `https://<tunnel>/xr?vr=cardboard`. That forces the built‑in Cardboard mode (the webxr‑polyfill): same side‑by‑side view, driven by the phone's orientation sensor. Also try the other browser (Samsung Internet ↔ Chrome) |
| **The Oculus app pops up when you slot the phone in** | Gear VR Service is still on. Take the phone out, redo §3.2, or slot it into the clamp without pressing it onto the plug and use gaze‑dwell to select |
| **Black screen in the headset** | Take the phone out. If the page is there, the Oculus service grabbed the screen (see above). If the phone is locked or asleep, raise the screen timeout. If the page is white or blank, reload `/xr`; the pairing is kept |
| **The table isn't in front of you / keeps drifting** | Menu → *Recenter*. 3DoF drifts over a few minutes; that's the phone's sensors, not the app |
| **Blurry or doubled image** | Turn the focus wheel on top of the Gear VR. Check the phone is centred in the clamp (the middle of the screen lines up with the notch). Wipe the lenses |
| **Wearer feels sick** | Take it off. Keep sessions under 3 minutes, sit down, turn on *Reduce motion* in the menu. Don't hand it to a judge who says they get motion sick; point them at the Gallery |
| **Phone is hot / "Phone overheating" warning / frame rate drops** | Out of the headset, screen off, 5 minutes. Keep *Photoreal cities* off. Lower brightness. Take the phone out between judges; the shell traps heat. Don't charge it inside the headset during a run |
| **Battery under 30%** | Charge between runs. VR drains an old Galaxy battery fast, and a hot phone charges slowly |
| **Headset code rejected** | Codes are single use and last 10 minutes. Get a fresh one on Rae's phone. After a re‑seed the old pairing is gone |
| **Nothing works on the Gear VR** | Don't debug in front of judges. "Same table on the laptop": continue on the Gallery (doc 09 §2) |

About the **Gear VR controller** (the small Bluetooth remote that came with the R324/R325): it pairs through the Oculus app, which is gone, so it does nothing for us. Leave it in the box. The side touchpad and gaze are the controls.

---

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Page loads, but turning your head does nothing | Opened over `http://`, not the tunnel | Use `https://<tunnel>/xr` |
| Code refused on `/xr` | Older than 10 min, used once already, or the voyage was re‑seeded | New code from Rae's phone |
| Pairing card shows again by itself | `DEVICE_EXPIRED`: a newer pairing, unpaired from Rae's phone, or 12 h passed | Type a new code |
| Enter VR does nothing | Browser blocked it, or no WebXR | Tap again once; then `?vr=cardboard`; then the other browser |
| Touchpad taps do nothing | Phone not on the plug, wrong holder (micro‑USB vs USB‑C), or the Oculus service ate the input | Reseat on the plug; otherwise use gaze‑dwell (1.6 s) |
| Back button opens the Oculus app | Gear VR Service still active | §3.2 |
| Everything is dark / washed out | Adaptive brightness or Night mode | §3.3 |
| Stutters in Dry Run | Old phone, photoreal tiles on, or it's hot | *Photoreal cities* off; cool the phone |
| No voices | Phone on silent, or audio not unlocked | Media volume up; exit and tap **Enter VR** again (the tap unlocks audio) |
| Tunnel URL stopped working | `cloudflared` was restarted, so the address changed | New address on every device, re‑seed |
| Gallery and headset disagree | One of them dropped its socket | Reload that one; the server is the source of truth |

---

## 8. Sixty seconds before each demo

1. ☐ Tunnel running; `https://<tunnel>/api/health` answers on the laptop.
2. ☐ Fresh seed on `/demo#key=…`; Gallery up on the projector.
3. ☐ Rae's phone open on the Muster screen; **new headset code** shown.
4. ☐ Gear VR phone: ≥ 50% battery, cool to the touch, Do Not Disturb on, brightness ~70%.
5. ☐ `/xr` open, code typed, crew visible, **Enter VR** tapped, phone in landscape and in the headset.
6. ☐ Put it on yourself for five seconds: table in front, reticle visible, voices audible. *Recenter* if needed.
7. ☐ Lenses wiped. Face pad wiped. Hand it over.
