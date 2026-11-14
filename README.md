<p align="center">
  <img src="docs/embydj-logo.webp" alt="EmbyDJ" width="560">
</p>

# EmbyDJ

An [Emby Server](https://emby.media) plugin that turns the Emby web app into a **two-deck DJ mixer** for your
own music library: waveforms, BPM detection, sync, loops, hot cues, effects, scratching and a sampler - all in
the browser, with the tracks coming straight from Emby.

EmbyDJ is a web app served by the plugin for **Emby administrators**. It opens inside the Emby dashboard or
full-window in its own tab, and uses the session of the signed-in administrator.

## Requirements

- Emby Server **4.9** or newer (built against SDK 4.8.0.80, tested on 4.11)
- A music library in Emby
- An Emby **administrator** account (EmbyDJ is available to administrators only)
- A current **Chromium-based browser** (Chrome, Edge) is recommended. Other browsers are not tested.
- For **scratching, backspin and the folder browser**: Emby must be opened over **https** or on the server
  itself via `localhost`. Browsers allow the required features (AudioWorklet, File System Access) only in a
  [secure context](https://developer.mozilla.org/docs/Web/Security/Secure_Contexts). Over plain `http://` with an
  IP address, EmbyDJ falls back to a basic audio engine without scratching and backspin; the status line shows
  which engine is active.

## Installation

1. Download `EmbyDJ.dll` from the [latest release](../../releases/latest).
2. Copy `EmbyDJ.dll` into the `plugins` folder of your Emby Server (`<programdata>/plugins`).
3. Restart Emby Server.

EmbyDJ then appears in the dashboard under **Advanced → EmbyDJ**. The **Open in new tab** button in its top bar
opens it full-window.

## Features

### Decks

- Two decks with play/pause, CUE (hold to preview), SYNC (tempo and beat phase) and 6 hot cues
- Vertical pitch fader (±8 / ±16 / ±50 %) with a button back to 0 %, pitch bend buttons; loading a track resets
  the tempo
- Beat loops (1/8 to 64 beats) with loop in/out, loops snap to the beat grid
- Automatic **BPM and first-beat detection**; correct it with /2, x2 or TAP, double-click the BPM to detect it
  again
- BPM, beat grid, cue and hot cues are saved on the server and are back the next time the track is loaded
- Tracks the browser cannot decode (e.g. ALAC, WMA) are transcoded to MP3 by Emby

### Waveforms

- Shared waveform band for both decks with a common playhead - deck A on top, deck B below, beat grid,
  cue/hot cue/loop markers; drag to scrub, mouse wheel to zoom
- Colour-coded by frequency (lows red, mids green, highs blue)
- Overview waveform per deck: click or drag to jump

### Jog wheel, scratching, backspin

- Jog wheel with progress ring and rotating marker (33⅓ rpm)
- **VINYL** mode: touching the platter scratches (with sound, forwards and backwards), the outer ring bends the
  tempo while playing
- **SLIP** mode: after a scratch, backspin or brake the track continues where it would have been - you stay in
  time
- **Backspin** and **forward spin**: flick the platter backwards or forwards and let go, or press **⟲ BACK** /
  **FWD ⟳** (beat-synced length)
- **Brake**: the platter slows down to a stop
- Click-free jumps (hot cues, seek, loop wrap) and click-free start/stop

### Auto-Mix

- **AUTO** plays one track after another: the next track is preloaded on the free deck and mixed in before the
  current one ends
- Next track from the **list** (current source, search and sort order) or at **random**
- Tracks with a similar tempo (max. 8 % apart) are beat-matched (tempo and beat phase) with a transition of 4, 8, 16
  or 32 beats; otherwise a plain crossfade. Silence at the start and end of a track is skipped
- **SKIP** mixes to the next track right away; the tooltip of **AUTO** shows the next track
- Any manual play, cue, load or crossfader move stops the Auto-Mix

### Mixer

- Per channel: gain, 3-band EQ with kill switches, filter (left = low-pass, right = high-pass), channel fader
  and VU meter
- **Auto-Gain**: measures the loudness of each track (similar to LUFS / ReplayGain) and sets the channel gain so
  that all tracks play at about the same level (max. +9 dB boost, the limiter catches peaks); switch it off with
  **AUTO GAIN** in the top bar. The gain can still be adjusted by hand
- Crossfader with smooth or sharp curve, master volume, master VU meter and limiter indicator

### Effects

One effect unit per deck with dry/wet and two parameters: **Echo, Ping-Pong, Reverb, Flanger, Phaser,
Distortion**. Echo, Ping-Pong, Flanger and Phaser follow the deck's BPM. Echo and reverb tails ring out after the
effect is switched off, even with the channel fader closed.

### Sampler

- 4 banks of 9 pads; modes **One-shot**, **Hold** and **Loop**; name, colour and volume per pad
- Load pads from
  - the **Emby library** (drag a track onto a pad),
  - **local files** (click an empty pad, or drag files from your file manager),
  - a **local sample folder** (folder browser with preview, Chrome/Edge only),
  - the **active loop of a deck** (**→PAD** button in the loop panel).
- Pads and uploaded samples are stored **per administrator** on the server, so they are the same in every
  browser
- Play with the mouse or the numeric keypad (7 8 9 / 4 5 6 / 1 2 3)

### Library

- All tracks, music libraries and playlists
- Search across **title, artist, album and genre**
- Columns: cover, track number, title, artist, album, genre, BPM and time - choose them with **Columns** or a
  right-click on the table header
- Click the **Title, Artist, Album, Genre or BPM** column header to sort (click again for descending); date added and
  random order are in the sort menu. Sorting by BPM lists all tracks with a known BPM first; sorting by genre lists the genres alphabetically
  (tracks without a genre at the end). Sorting by **track
  number** works when the list contains a single album.
- Load a track with the A/B buttons, a double-click or drag & drop onto a deck

### MIDI controllers

- Connect a USB MIDI controller and click **MIDI** in the top bar (Chrome or Edge, https or localhost; the
  browser asks for permission once)
- **Learn mode**: press **LEARN**, click a control in EmbyDJ (outlined), then move or press the control on the
  device. Buttons, faders, knobs, the crossfader, sampler pads and jog wheels can be mapped; jog wheels scratch
  when the deck is paused (or while the jog-touch sensor is held) and bend the tempo while playing
- **Calibrate jog**: turn the jog wheel once around - one turn on the controller then equals one turn of the
  platter; fine-tune with the jog sensitivity
- **Jog spins**: after a backspin / forward spin on the jog wheel (faster than scratching) the music plays on
  as soon as the wheel slows down - forward at normal speed, backward with a short motor start - instead of
  waiting until the controller reports the end of the movement (option in the MIDI panel)
- **Record 3 s** in the MIDI panel records what the controller sends (with time stamps) to copy it, e.g. for a bug
  report
- **Track list**: click a row to select it; with MIDI an encoder can browse the list and buttons load the selected
  track into deck A or B (learn them with **List browse**, **Load → A**, **Load → B**)
- **Deck switch and modes** for compact controllers with one control section: learn a button as *Deck switch
  A/B* (list **More functions…**) and tick **Selected deck (A/B switch)** while learning - those controls then act
  on the selected deck (outlined in EmbyDJ). With **Modes…** (e.g. `sampler, loop, fx, cue`) and **Only in current
  mode** a button or encoder can do something different in each mode; *Next mode* / *Mode · …* switch it. More
  functions for encoders: beat jump, fine tempo, loop size, set hot cue, previous / next effect
- **Import mapping**: takes over the mapping of another DJ program - **Mixxx** (`.midi.xml`, e.g. from the
  Mixxx project) or **Virtual DJ** (device definition plus mapper `.xml`, select both files). Play, cue, sync,
  faders, EQ, gain, filter, tempo, jog, jog touch, hot cues, loops, effects, sampler pads, list browsing and loading
  are translated, LEDs too where the file describes them. Scripts are not run; script functions are matched by
  their name, so check the result and map what is missing with LEARN. The files are read in the browser only
- **Save profile**: stores a learned or imported mapping (with LEDs and jog calibration) under a name on the
  server; saved profiles appear in the **Profile** list in every browser. **Export** downloads it as
  `.embydj-midi.json` to share it, **Import mapping** reads such a file again
- Every mapping - learned or imported - can be edited in the MIDI panel: **✎** assigns another control on the
  device to that function, **inv** inverts it, **✕** removes it

### Keyboard shortcuts

| | Deck A | Deck B |
|---|---|---|
| Cue | Q | O |
| Play / Pause | W | P |
| Sync | E | I |
| Beat loop | R | U |
| Hot cues 1-4 | 1 2 3 4 | 7 8 9 0 |
| Pitch bend −/+ | A / S | K / L |
| FX on/off | F | J |
| Backspin / Brake / Forward spin | Z / X / C | M / , / . |
| Crossfader | ← / → (Shift = full) | |
| Sampler pads | Numpad 7 8 9 / 4 5 6 / 1 2 3 | |

### Not (yet) supported

- Headphone cueing (pre-listen on a second output)
- Key lock (tempo changes also change the pitch), key detection
- Recording the mix

## Data, privacy and uninstall

- EmbyDJ talks only to your own Emby server. It uses the session of the signed-in administrator; no external
  services are contacted. All data routes require an administrator.
- Data is stored in `<programdata>/data/`:
  - `embydj-tracks.json` - BPM, beat grid, cue, hot cues and loudness per track, **shared by all administrators**.
  - `embydj-sampler/<userId>/` - the sampler pads (`pads.json`), saved MIDI controller profiles
    (`midi-profiles.json`) and uploaded samples of each administrator.
    Samples are limited to 10 MB each; replaced or cleared samples are deleted.
- Effect settings and the VINYL/SLIP state are kept in the browser (local storage), the chosen sample folder in
  the browser's IndexedDB.
- **Uninstalling removes all of this** - `embydj-tracks.json`, the whole `embydj-sampler/` folder with all
  samples, and the plugin configuration. Copy `embydj-sampler/` first if you want to keep your samples. Updating
  the plugin (replacing the DLL) keeps everything.
- The browser-side settings (effects, VINYL/SLIP, sample folder) stay in the browser; clear the site data of
  your Emby server in the browser to remove them.

## Building from source

Requires the .NET SDK (8.0 or newer).

```bash
dotnet build EmbyDJ -c Release
```

The plugin is `EmbyDJ/bin/Release/netstandard2.0/EmbyDJ.dll`. With
`-p:EmbyPluginsPath=<programdata>\plugins` the build copies it straight into an Emby plugins folder (restart Emby
afterwards).

The build is deterministic: the same sources produce a byte-identical DLL without local paths.

### Notes for contributors

- `EmbyDJ/Web/dashboard.html` and `dashboard.js` are a **fixed shell that should not change**: Emby caches plugin
  pages by server version only. The app itself (`EmbyDJ/Web/...`) is served by the plugin and is never stale.
- Bump the version in `EmbyDJ.csproj` with every release.

## API

| Method | Route | Auth | Purpose |
|---|---|---|---|
| GET | `/EmbyDJ/Web/{Name}` | none | Web app files (`index.html`, `app.js`, `app.css`, `deck-worklet.js`) |
| GET | `/EmbyDJ/Version` | none | Running plugin version |
| GET | `/EmbyDJ/Tracks?Ids=...` | admin | DJ metadata (BPM, beat grid, cues) for up to 500 items; `All=true` for all |
| POST | `/EmbyDJ/Tracks/{Id}` | admin | Store DJ metadata of an item (`Data` = JSON object, empty deletes) |
| GET/POST | `/EmbyDJ/Sampler/Pads` | admin | Pad layout of the current administrator |
| GET/POST | `/EmbyDJ/Midi/Profiles` | admin | Saved MIDI controller profiles of the current administrator |
| POST | `/EmbyDJ/Sampler/Samples?Name=...` | admin | Upload a sample (raw request body, max. 10 MB) |
| GET | `/EmbyDJ/Sampler/Samples/{Id}` | admin | Download a sample of the current administrator |
| DELETE | `/EmbyDJ/Sampler/Samples/{Id}` | admin | Delete a sample of the current administrator |

## License

[MIT](LICENSE) © SolisTVBox

## Built with AI assistance

Developed with the help of [Claude](https://claude.ai) (Anthropic).

## Support

If EmbyDJ is useful to you, consider [buying me a coffee ☕](https://ko-fi.com/soliflix).

[![ko-fi](https://storage.ko-fi.com/cdn/kofi3.png?v=3)](https://ko-fi.com/soliflix)
