# Hero shots

Screenshots of the real app for the landing page, each with the prompt to show beside it. Taken in an isolated OMFV at
1600×900 CSS pixels and 1.5× scale, so each PNG is 2400×1350. The PNGs are on the orphan branch `assets/landing-shots`, not
in this folder, so they don't weigh on every clone: the page commits only the crops it uses. The slot ids (H1, M1, …) are the image slots on the
design canvas's `Main.dc.html`.

## To collect

Page slots:

- [x] **H1 · hero.** The page rotates four, each after its prompt is typed: shots 8b, 1, 5b and 2. They're the ones with the palette closed, since the page types the prompt itself.
- [x] **M1 · spoiler check, then the jump.** Shots 6a, 6b and 6c.
- [x] **B1 · build draft, then Save.** Shots 3 and 4.
- [x] **S1 · suggestion strip with live previews.** Shot 7.
- [x] **X1 · point at anything.** [x1-mention.png](https://github.com/natheihei/oh-my-f1-viewer/blob/assets/landing-shots/x1-mention.png?raw=true). Asked as `how is @Ferrari doing against @Mercedes on the @gap` instead of `how is HAM vs @Ferrari`, since HAM drives for Ferrari in 2026, and only a tile tag lights a tile.
- [ ] **X3 · live races.** Waits for a live weekend.

Gallery cards:

- [x] **C1 Battle.** Crop from shot 5.
- [x] **C2 Chase.** [c2-chase.png](https://github.com/natheihei/oh-my-f1-viewer/blob/assets/landing-shots/c2-chase.png?raw=true).
- [x] **C3 Timing tower.** Crop from shot 2.
- [x] **C4 Gap.** Crop from shot 6c, or shot 2.
- [x] **C5 Speed ribbon.** [c5-speed-ribbon.png](https://github.com/natheihei/oh-my-f1-viewer/blob/assets/landing-shots/c5-speed-ribbon.png?raw=true).
- [x] **C6 Pedal barcode.** Crop from shot 2.
- [x] **C7 Tyre deg.** [c7-tyre-deg.png](https://github.com/natheihei/oh-my-f1-viewer/blob/assets/landing-shots/c7-tyre-deg.png?raw=true).
- [x] **C8 Pit window.** Crop from shot 2.

From the first hero list:

- [x] Main feed full of onboards. Shot 1.
- [x] A HAM vs VER battle with onboards and telemetry. Shots 8 and 8b.
- [x] Main feed with the battle tile. Shot 5.
- [x] Build mode, onboard of whoever is pitting. Shots 3 and 4.

## Collected

| File | Prompt to show | Race · video time | On screen |
| --- | --- | --- | --- |
| [shot1-onboards.png](https://github.com/natheihei/oh-my-f1-viewer/blob/assets/landing-shots/shot1-onboards.png?raw=true) | Onboards of the top 10, and jump to 10 seconds before lights out | 2026 Mexico City Grand Prix · 0:08:32, lap 1 of 71 | The world feed with five red lights and the grid formed up, and ten onboards: HAM, VER, RUS, NOR, LEC, HAD, ANT, LIN, GAS, HUL |
| [shot2-ham-lec.png](https://github.com/natheihei/oh-my-f1-viewer/blob/assets/landing-shots/shot2-ham-lec.png?raw=true) | All charts focusing on HAM vs. LEC | 2026 Mexico City Grand Prix · 0:21:34, lap 10 of 71 | The world feed, both onboards, and 15 charts on the two Ferraris: pit window ×2, timing tower, gap, sectors, speed ribbon ×2, telemetry ×2, pedals ×2, tyres, tyre deg, pit windows, track map |
| [shot3-build-pitting.png](https://github.com/natheihei/oh-my-f1-viewer/blob/assets/landing-shots/shot3-build-pitting.png?raw=true) | /build onboard of whoever's pitting. An overlay of "[DRIVER] pitting" in the center. | 2026 Mexico City Grand Prix · 1:09:59, lap 45 of 71, under the safety car | Build mode: the yellow palette with the prompt, "wrote pitting_onboard/main.tsx · loaded", a follow-up, `build · 1 change`, Undo all and Save. The draft tile, framed in yellow, shows RUS's onboard in the pit lane with "RUS pitting" over it, and the world feed shows RUS IN PIT. The window had been resized, so this was taken with the page's viewport set to 1600×900 over the devtools protocol |
| [shot4-build-saved.png](https://github.com/natheihei/oh-my-f1-viewer/blob/assets/landing-shots/shot4-build-saved.png?raw=true) | (after Save on shot 3's build) | Same frame as shot 3 | Build mode left with Save: `pitting_onboard` is an ordinary tile now, with "PITTING · RUS" and no yellow draft frame. Only two tiles, so the lower third shows the backdrop |
| [shot5-battle-lead.png](https://github.com/natheihei/oh-my-f1-viewer/blob/assets/landing-shots/shot5-battle-lead.png?raw=true) | the battle for the race lead | 2026 Mexico City Grand Prix · 1:56:07, just after lap 48 ends (lap 49 of 71) | The world feed and the battle tile: VER and HAM onboards for P1, 0.6 s apart, over the list of fights (P4 LEC–NOR, P5 NOR–RUS, …). The palette shows the prompt and "Suggested Battle; you can select the fight for the lead in the tile." |
| [shot5b-battle-lead-closed.png](https://github.com/natheihei/oh-my-f1-viewer/blob/assets/landing-shots/shot5b-battle-lead-closed.png?raw=true) | the battle for the race lead (typed by the page) | 2026 Mexico City Grand Prix · 1:56:10, lap 49 of 71 | Shot 5 again with the palette closed, for the hero. The battle tile was put on by hand and opened on HAD–SAI, its closest fight, so the P1 VER–HAM row was picked in the tile |
| [shot6a-spoiler-check.png](https://github.com/natheihei/oh-my-f1-viewer/blob/assets/landing-shots/shot6a-spoiler-check.png?raw=true) | go to when VER caught HAM after his pit stop | 2026 Italian Grand Prix · 1:14:02, lap 22 of 53 | The spoiler check in the palette: "! spoiler The agent wants to look ahead of where you are." with Allow once, Allow for this session and Don't allow. The tower shows LEC Out, which happened before this point |
| [shot6b-after-jump.png](https://github.com/natheihei/oh-my-f1-viewer/blob/assets/landing-shots/shot6b-after-jump.png?raw=true) | (Allow once on 6a) | 2026 Italian Grand Prix · 1:34:34, lap 36 of 53 | The frame after the jump, with "Jumped to Verstappen catching Hamilton." The broadcast tower shows HAM P4 on mediums, VER P5 on hards. The two cars are small in the background of the world feed |
| [shot6c-catch-tiles.png](https://github.com/natheihei/oh-my-f1-viewer/blob/assets/landing-shots/shot6c-catch-tiles.png?raw=true) | show both onboards and the chase · also the chase tile, VER chasing HAM | Same frame as 6b, layout arranged by hand | Palette closed. The world feed, and down the right the VER onboard, the gap chart (VER 10.6 s back after his stop, closing 1.27 s a lap to 1.44 s) and the HAM onboard. The chase tile was taken off |
| [shot7-strip-ver.png](https://github.com/natheihei/oh-my-f1-viewer/blob/assets/landing-shots/shot7-strip-ver.png?raw=true) | How's VER doing right now, tyres, speed, pitting strategy, etc | 2026 Italian Grand Prix · 1:34:34, lap 36 of 53 | For S1. The suggestion strip, open with live previews of six tiles: VER onboard, and timing tower, tyre strategy and tyre deg for the whole field with VER highlighted, then pit window and telemetry for VER. The palette shows the prompt and "Suggested Verstappen's onboard, timing, tyres, pit window and telemetry." Taken after the view prompt was changed to draw the whole field and highlight the driver asked about. Asked as "tyres", not the "types" of the original note |
| [shot8-ham-ver.png](https://github.com/natheihei/oh-my-f1-viewer/blob/assets/landing-shots/shot8-ham-ver.png?raw=true) | The battle between HAM and VER, with their telemetry | 2026 Canadian Grand Prix · 0:25:25, lap 8 of 68 | The world feed, HAM and VER onboards, the gap chart (VER 0.50 s behind HAM for P3, closing 0.12 s a lap, both in overtake range) and telemetry for each. The palette shows the prompt and "Suggested both onboards, their gap chart, and telemetry." Everything it suggested was added |
| [shot8b-ham-ver-closed.png](https://github.com/natheihei/oh-my-f1-viewer/blob/assets/landing-shots/shot8b-ham-ver-closed.png?raw=true) | (same as shot 8) | Same frame as shot 8 | Shot 8 with the palette closed, so both telemetry tiles show whole: HAM 219 km/h in 5th, VER 202 km/h with overtake on |
| [x1-mention.png](https://github.com/natheihei/oh-my-f1-viewer/blob/assets/landing-shots/x1-mention.png?raw=true) | how is @Ferrari doing against @Mercedes on the @gap (not sent) | 2026 Chinese Grand Prix · 0:41:30, lap 19 of 56 | For X1. Tiles put on by hand: the world feed, HAM, LEC, RUS and ANT onboards, a gap chart for LEC and HAM, and a timing tower with HAM and LEC highlighted. The prompt has two team tags, `▌▌FERRARI` and `▌▌MERCEDES`, and the picker is open on `@gap` with the "Gap LEC · HAM, on screen" row selected, so that tile is in the spotlight, with a lit title bar and a frame, and every other tile is dimmed |
| [c2-chase.png](https://github.com/natheihei/oh-my-f1-viewer/blob/assets/landing-shots/c2-chase.png?raw=true) | the chase tile, VER chasing HAM · also the chase tile | 2026 Italian Grand Prix · 1:34:34, lap 36 of 53, the moment of shot 6b | For C2. The world feed and the chase tile for VER: his onboard with "AHEAD HAM +1.4". The first ask gave both onboards and a gap chart, the second the chase tile. Palette closed |
| [c5-speed-ribbon.png](https://github.com/natheihei/oh-my-f1-viewer/blob/assets/landing-shots/c5-speed-ribbon.png?raw=true) | HAM onboard and his speed ribbon | 2026 Japanese Grand Prix · 1:07:57, lap 35 of 53 | For C5. The world feed with HAM's car on the main straight, his onboard, and the speed ribbon: Suzuka traced from his last lap, green through the Esses, 307 km/h in 8th. Palette closed |
| [c7-tyre-deg.png](https://github.com/natheihei/oh-my-f1-viewer/blob/assets/landing-shots/c7-tyre-deg.png?raw=true) | how are the top three doing on their tyres | 2026 Singapore Grand Prix · 1:01:04, lap 32 of 62 | For C7. The world feed (RUS's onboard, chasing BEA for 7th) and tyre deg for the whole field: VER, NOR and PIA all on 31-lap softs. The agent suggested it without a highlight, so VER, NOR and PIA were highlighted by hand. Palette closed |
