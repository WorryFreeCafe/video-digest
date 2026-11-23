# YouTube Digest

[English](README.md) | [简体中文](README.zh-CN.md)

Turn every YouTube video into a resource for deep learning. YouTube Digest brings transcripts, bilingual translation, AI overviews, explanations, and timestamped notes into one Chrome side panel, so you can study ideas and language without losing your place.

- Turn captions into a readable, searchable learning resource.
- Learn languages with the original transcript, a Simplified Chinese translation, or an aligned bilingual view.
- Build understanding with an AI overview, chapters, key quotes, and selected-text explanations.
- Navigate long videos by clicking timestamps in the transcript, overview, or notes.
- Save polished timestamped notes for later study.
- Keep control of your data with your own API keys, local Chrome storage, and no analytics or telemetry.

YouTube Digest is a bring-your-own-key project installed locally from GitHub. It is not available through the Chrome Web Store, does not include API credits, and does not run a developer-operated server.

![YouTube Digest demo](YouTube%20Digest%20demo.png)

## What is new in v1.4.0

- Removed the local Whisper fallback, along with `tabCapture`, the offscreen
  recorder, and the in-extension setup guide. Recording only ever covered 30
  seconds from the playhead, so it produced a transcript that looked truncated
  and had to be kept running by hand.
- The transcript now comes from three independent platform routes: the player's
  own signed `timedtext` URL, YouTube's `get_transcript` endpoint, and finally a
  read of the page's own transcript panel. The last two do not need a
  proof-of-origin token.
- A missing caption track no longer aborts the probe. Previously an empty
  `captionTracks` list returned "no subtitles" immediately, so a video with
  captions could be reported as having none.
- The panel separates "this video has no captions" from "this attempt failed,
  reload to retry", and drops the Whisper-related copy.
- Permissions are down to `sidePanel`, `storage`, `tabs`, and `scripting`.

## What is new in v1.3.9

- The Bilibili overlay no longer sits on the picture. It fades in only while the
  pointer is over the player and fades out when the pointer leaves, so the video
  frame stays clean. It shows once for a couple of seconds after a page loads so
  the buttons remain discoverable.
- Pointer tracking is coordinate based rather than `mouseenter`: reloading the
  page with the cursor already parked on the video used to leave the buttons
  unreachable until the cursor left the player and came back.

## What is new in v1.3.8

- Bilibili has a **Note** button now, next to **Digest**. The content script used
  to return early for Bilibili, so the only overlay there was Digest.
- Both Bilibili buttons sit at the player's top-right corner. The Digest button
  used to sit at the bottom-right of the window, on top of the recommendation
  list, where it read as part of the page rather than as an extension control.
- A note no longer requires a prior digest. When the digest cache is missing, the
  background reads that tab's platform captions instead of failing with
  `NO_CACHED_TRANSCRIPT`.
- Bilibili note links point at the Bilibili video and keep the part number
  (`?p=2&t=95`), so a multi-part note reopens the right part. Tracking
  parameters are dropped.
- A failed save explains itself in a toast. Before, the button only flashed
  `ERROR` for two seconds and the panel said nothing.

## What is new in v1.3.7

- A caption probe no longer gives up after a single read. The extension waits up
  to four seconds for the player to expose its caption tracks, so clicking
  **Digest** right after opening a video no longer falls through to Whisper.
- Fixed a pot dead end: when YouTube's caption button was already on, the old
  code skipped its own request and therefore never got a signed URL to read. It
  now toggles captions off and on so the player fetches the track once.
- When the signed URL never appears, the content script falls back to YouTube's
  own `get_transcript` endpoint (the one behind "Show transcript"), which needs no
  token. Two independent ways to read the same captions.
- The panel names the real reason captions are missing (no caption track, empty
  response, page not reloaded after an update, or a signed URL that never arrived)
  and states the Whisper status next to it. Before, every one of those cases
  showed up as "Local Whisper is not running", which made it look as if the
  extension now required Whisper.
- When the cause is page-side, the main button is **Reload page & retry**: the
  caption hook runs at `document_start`, so a reload is the only way to restore it
  on a tab that was already open before an update.

## What is new in v1.3.6

- The extension now checks the local Whisper server before it starts recording,
  instead of discovering a closed port after 30 seconds of audio. A dead server
  comes back as `WHISPER_UNREACHABLE` in about a second.
- The side panel turns that result into an action: the title says the server is
  not running and the main button opens a built-in setup guide, with Settings as
  the secondary action.
- Settings has a **Check connection** button next to the Whisper fields. It
  reports the model and response time, or explains the failure (nothing
  listening, timeout, another service on the port) without needing a saved page.
- New in-extension page, `whisper-guide.html`, explaining how tab audio reaches
  faster-whisper, the install and start commands, a model comparison, and a
  troubleshooting table. It works offline and switches between English and
  Chinese.

## What is new in v1.3.5

- The transcript header (title, **Copy**, **Export**) now sticks to the top of
  the panel, so both actions stay reachable however far you scroll.
- **Export** opens a format menu instead of downloading one fixed file:
  - **Plain text** (`.txt`) keeps the title, channel, description, and transcript.
  - **With timestamps** (`.txt`) writes one timestamped line per caption.
  - **Subtitles** (`.srt`) and **WebVTT** (`.vtt`) write real subtitle files with
    `HH:MM:SS,mmm` / `HH:MM:SS.mmm` cues, ready for a video player or editor.
- Subtitle cues take their end time from the next caption, capped by a reading
  estimate, so a pause in speech does not leave one caption on screen for a
  minute.
- Exported file names keep non-Latin titles. A Chinese or Japanese title used to
  become `untitled-transcript.txt`; it now keeps its own characters.

## What is new in v1.3.4

- Removed the Supadata integration entirely. Transcripts now come from two
  sources only: the platform's own caption track, or your local Whisper server.
- Supadata was a paid proxy for captions that already existed. It could not
  transcribe a video that had no captions (`mode=native` returns `206`), and the
  one thing it did cover, YouTube's token-signed `timedtext` endpoint, is now
  handled inside the extension by `caption-pot-hook.js`.
- The Settings page no longer asks for a transcript key, and the extension no
  longer requests host access to `api.supadata.ai`.
- Fixed a gate in the side panel that refused to open unless a Supadata key was
  stored, even for videos whose captions were available locally.
- Saving a note without a cached transcript now asks you to reload the digest
  instead of silently re-downloading captions in the background.

## What is new in v1.3.3

- Reduced idle cost on YouTube. The note button retry loop used to be re-armed
  by every page mutation, which reset its attempt budget and turned the
  "give up after 3 seconds" guard into a permanent 10 queries per second scan on
  pages that mutate continuously.
- Toolbar reconciliation is now rate limited to one pass per 400ms, and exits
  after a single geometry read while the button is still mounted in a visible
  host, instead of a full `querySelectorAll` plus `getComputedStyle` sweep on
  every mutation burst.
- The note button's hover state only writes style when it actually changes.
- Bilibili's 1 second navigation poll no longer queries the DOM when there is
  nothing to repair, so non-video pages stay untouched.
- Measured on one Bilibili watch page, playing: the extension accounts for about
  0.3 percentage points of script time and 1.7 points of main-thread task time.

## What is new in v1.3.2

- Fixed a Bilibili regression: the UP avatar, follower count and the related
  video covers on the right stopped rendering while the extension was enabled.
  The Digest button used to be inserted into Bilibili's action toolbar
  (`.video-toolbar-left-main` / `#arc_toolbar_report`). Those containers are
  Vue-hydrated, and an extra child desynchronises its patch pass, leaving the
  surrounding blocks unrendered, which is why disabling the extension fixed it.
- The Bilibili button is now a fixed overlay appended to `<body>`, outside
  Bilibili's DOM tree entirely. It hides itself in fullscreen so it never covers
  the video.
- Injection is deferred to 700ms after `load`, outside Bilibili's hydration
  window.
- Added regression tests that keep the button out of Bilibili's containers.

## What is new in v1.3.1

- Fixed YouTube transcripts arriving as one or two sentences. YouTube now
  requires a proof-of-origin token (`pot`) on `/api/timedtext` and answers
  **HTTP 200 with an empty body** without it. The old code checked only the
  status code, so an empty body looked like "captions exist but are blank" and
  the panel silently fell back to a 30-second Whisper capture.
- Added `caption-pot-hook.js` (MAIN world, `document_start`): it hooks the
  player's own caption requests and remembers the signed URL, which carries the
  token. The content script rewrites `lang`/`fmt` on that URL and downloads the
  full track. The signature does not cover `lang`/`tlang`, so switching away from
  a translated track back to the original is safe.
- Captions are parsed from json3 with their real timeline (measured locally:
  605 segments spanning 0:00 → 15:36 on a 15:38 video).
- The panel cache is now versioned (`DIGEST_CACHE_VERSION`), so shortened
  transcripts stored by older builds are discarded and refetched automatically.
- Turning captions on just to obtain the URL is undone afterwards, so the player
  settings stay untouched.

## What is new in v1.3.0

- The side panel now works on Bilibili: watch pages get a Digest button that uses
  the free native subtitle track, with no third-party transcript service.
- Fixed `Extension has not been invoked` no matter how often the icon was
  clicked: the manifest now declares `activeTab`, and the action click opens the
  panel itself (Chrome's `openPanelOnActionClick` swallows the click, so the
  grant never happened).
- When the panel asks for the grant, one icon click (or `Alt+Shift+9`) resumes
  the capture automatically instead of requiring a second click.
- Stale capture streams are released before retrying, so
  `Cannot capture a tab with an active stream` no longer blocks a second run.
- An empty Whisper result now reads "video not playing or muted" instead of the
  confusing `Whisper service returned 200`.

## New in v1.2.0

- Search transcript words or phrases and move through every match.
- Use one Original, Chinese, or bilingual setting across Transcript, Overview, and Notes. New videos stay in Original by default.
- Translate visible Overview and Notes content progressively in small cached batches.
- Explain selected transcript text or save it directly as a timestamped note.
- Keep your transcript position across navigation, with the panel closing automatically outside YouTube video pages.

## Install with your coding agent

You do not need to understand the code or use the command line. Send this message to your coding agent:

> Download or clone this project into a permanent folder I choose, tell me its exact full path, and use that same folder for Chrome's Load unpacked step. If I need a suggestion during this first installation, offer `~/Documents/youtube-digest` on macOS or Linux, or `%USERPROFILE%\Documents\youtube-digest` on Windows, but do not assume either path. Walk me through installation and setup in simple terms. https://github.com/zarazhangrui/youtube-digest

Your agent should:

1. Ask where you want to keep the project, download or clone it there, and tell you the exact full path. If you want a suggestion, it can offer `~/Documents/youtube-digest` on macOS or Linux, or `%USERPROFILE%\Documents\youtube-digest` on Windows.
2. Open the official DeepSeek API Keys page below and help you create your own account.
3. Walk you through selecting the exact project folder you chose in Chrome with **Load unpacked**.
4. Show you where to enter your API keys in the extension's **Settings** page.
5. Open a YouTube video with captions and confirm the transcript and translation work.

Keep this folder in the same place after installation. If you move or delete it, Chrome's unpacked extension stops working until you load the extension again from its new permanent folder.

Never paste an API key into an AI chat, source file, screenshot, or public message. Enter keys yourself, directly in the YouTube Digest Settings page. Your coding agent can point to the correct field without seeing the key.

## Install manually

If you prefer to do it yourself:

1. Open [github.com/zarazhangrui/youtube-digest](https://github.com/zarazhangrui/youtube-digest).
2. Choose **Code**, then **Download ZIP**.
3. Choose a permanent folder and unzip the project there. Optional suggestions are `~/Documents/youtube-digest` on macOS or Linux, or `%USERPROFILE%\Documents\youtube-digest` on Windows. You may use a different folder.
4. In Chrome, open `chrome://extensions`.
5. Turn on **Developer mode**.
6. Click **Load unpacked**.
7. Select the exact project folder you chose, which must contain `manifest.json`.
8. Pin YouTube Digest from Chrome's Extensions menu if you want quick access.

Because this is an unpacked extension, it does not update automatically. After downloading an update or changing local files, click **Reload** on the YouTube Digest card at `chrome://extensions`, then refresh open YouTube tabs. Moving or deleting the source folder breaks the unpacked extension until you load it again from the new location.

## Set up your API keys

YouTube Digest needs one key under your own provider account: a **DeepSeek API key** for overviews, explanations, translation, and automatic note polishing. Transcripts themselves need no key, because they are read from the page or produced by your own machine.

### Get a DeepSeek API key

1. Open the official [DeepSeek API Keys page](https://platform.deepseek.com/api_keys).
2. Sign in or create a DeepSeek Platform account when prompted.
3. Choose **Create new API key**, give it a recognizable name such as `YouTube Digest`, and create it.
4. Copy the key immediately. The full key may only be shown once.
5. Paste it into **DeepSeek API key** in YouTube Digest Settings.
6. If DeepSeek reports insufficient balance, add credit in your DeepSeek Platform account and try again.

See the [official DeepSeek API documentation](https://api-docs.deepseek.com/) for current account and API details.

Open **Settings** from the side panel. You can also open the YouTube Digest **Options** page from its card at `chrome://extensions` or by right-clicking its toolbar icon. Paste keys only into these Settings fields. Never paste a key into an AI chat, repository file, screenshot, or public message.

The published version supports DeepSeek V4 Flash as its only AI provider:

```text
Base URL: https://api.deepseek.com
Model: deepseek-v4-flash
```

YouTube Digest sends every DeepSeek request in non-thinking mode for responsive, predictable interactions. The endpoint and model are fixed in Settings, so the only AI credential you enter is your DeepSeek API key. To use another provider or model, copy the safe customization prompt in Settings and give it to a coding agent for your local copy. Never add an API key to that prompt or chat.

Keys and settings are stored in Chrome's local extension storage on your device. Release builds do not include or use `config.js`.

## Use YouTube Digest

1. Open a standard YouTube watch page with captions.
2. Click the YouTube Digest extension icon to open the side panel.
3. Read the timestamped transcript, or choose **Original**, **中文**, or **双语**.
4. Open **Overview** when you want AI-generated chapters and key quotes.
5. Select transcript text when you want an AI explanation.
6. Save a note from the player or a key quote, then revisit it from **Notes**.

## What works today

- Google Chrome 116 or newer, using the Side Panel API.
- Standard `youtube.com/watch` video pages.
- Platform-native subtitle tracks read directly from the page: YouTube `captionTracks` (including the signed `timedtext` URL the player itself uses) and Bilibili's subtitle API. No third-party transcript service is involved.
- Original, Simplified Chinese, and aligned bilingual transcript views.
- AI overviews, selected-text explanations, translation, and automatic note polishing.
- Local notes and a local cache for recent transcript and digest results.
- DeepSeek V4 Flash for all published AI features. Other providers require a local code adaptation and are not supported by this published version.

Shorts, live streams, private or access-restricted videos, and videos without an available native transcript may not work. Firefox, Safari, mobile browsers, and other Chromium browsers are not currently tested or supported.

## Subtitle source routing (two scenarios)

YouTube Digest routes subtitle retrieval by availability. There is no metered
transcript service in the loop, so a failed probe costs nothing:

1. **Platform-native subtitles.** The extension probes for native captions on the
   current page: YouTube `captionTracks`, Bilibili's free subtitle API, or a
   generic HTML5 `video.textTracks`. YouTube's `timedtext` endpoint now requires a
   proof-of-origin token and answers `HTTP 200` with an empty body when the token
   is missing. `caption-pot-hook.js` records the signed URL the player itself
   requests, so the content script can download the full track with its real
   timeline. If that signed URL never shows up, the content script asks YouTube's
   `get_transcript` endpoint instead (the one behind the "Show transcript"
   panel), which needs no token. Bilibili's API needs a signed-in session; when logged
   out it returns nothing.

2. **No captions? Say so.** There is no audio recording and no local service to
   run. If a video has no caption track and no transcript panel, the panel states
   that plainly and offers a reload when the cause is a stale page. Nothing is
   uploaded anywhere.

Two practical notes:

- Bilibili's subtitle API only returns tracks for a signed-in session. If you are
  logged out, the probe finds nothing and the panel tells you the video has no
  readable captions.
- YouTube's transcript panel is a UI fallback, so it depends on the page layout.
  If a future redesign removes it, the first two routes still work.

## Roadmap: cloud transcription with Groq (not implemented)

A video with no captions at all cannot be digested right now: the extension only
reads captions the page already has, and recording the tab was removed in v1.4.0
(it only ever captured 30 seconds, which is enough to sample a video, not to
digest it). The planned fix is an opt-in cloud path using
[Groq](https://groq.com/) rather than a transcript vendor, because Groq
transcribes audio instead of proxying captions.

Why Groq:

- `whisper-large-v3-turbo` is listed at **$0.04 per hour of audio** (about
  $0.013 for a 20-minute video, $0.04 for an hour), with a 10 second minimum per
  request. `whisper-large-v3` is $0.111 per hour if accuracy matters more.
- It runs around 216x real time, so a 20-minute video returns in seconds.
- It speaks the OpenAI audio API shape (`POST /openai/v1/audio/transcriptions`
  with `model`, `file`, `response_format=verbose_json`), so the existing
  `fetch`-based code needs no SDK.

Implementation sketch:

1. Settings: add `transcriptionProvider: "local" | "groq"`, `groqApiKey`, and
   `groqModel` (default `whisper-large-v3-turbo`). Keep the key in
   `chrome.storage.local` like the DeepSeek key, and never auto-select Groq.
2. Capture: `handleCaptureAudioTranscribe` already owns the tab-capture path.
   Lift its 5 to 120 second clamp into a per-request option and record the whole
   track while it plays, or chunk the `MediaRecorder` output into segments under
   25 MB (roughly an hour of compressed speech) and upload them in order.
3. Transcribe: send each chunk with `response_format=verbose_json` and offset the
   returned segment timestamps by the chunk start. Reuse
   `YTD_SUBTITLE_SOURCES.buildTranscriptFromChunks` so the panel, seek, notes, and
   translation keep working unchanged.
4. Gate it: keep the current rule that nothing is spent without an explicit
   click. Show the estimated audio length and cost before the request.
5. Cache: store the result under the same `digest_<videoId>` key and bump
   `DIGEST_CACHE_VERSION`, so switching providers does not serve a 30 second
   sample as if it were a full transcript.

Known constraints: 25 MB per upload on the base tier (100 MB on the dev tier),
10 second minimum billing, no diarization, and DRM or encrypted streams remain
uncapturable. Audio leaves your machine, so the README and the Settings page must
say so next to the toggle.

Other audio APIs, priced per hour of audio for comparison: OpenAI
`gpt-4o-mini-transcribe` about $0.18, `whisper-1` about $0.36, AssemblyAI
Universal-2 about $0.15, Deepgram Nova-3 about $0.26. Groq is the cheapest of
that group by a wide margin.

## DeepSeek V4 Flash pricing

As of August 27, 2026, DeepSeek lists these USD prices per 1 million tokens on its official [pricing page](https://api-docs.deepseek.com/quick_start/pricing/):

| Token type | Off-peak | Peak |
| --- | ---: | ---: |
| Cache-hit input | $0.007 | $0.014 |
| Cache-miss input | $0.22 | $0.44 |
| Output | $0.66 | $1.32 |

Peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday through Friday. All other hours use off-peak rates.

A measured 20-minute English talk used about **32,600 input tokens** and an estimated **3,500 to 4,500 output tokens** across 43 small translation batches. At current prices, translating the full video costs approximately:

- **Off-peak: $0.003 to $0.010 USD**.
- **Peak: $0.005 to $0.020 USD**.

The lower end assumes most repeated input hits DeepSeek's cache. The upper end assumes cache misses. Translation is lazy and cached, so translating only part of a video costs less. Check the official page before relying on these prices.

## Remix it with your coding agent

This is a personal remix project. Upstream issues and pull requests are not accepted. If something breaks or you want a new feature, download or fork your own copy and ask your coding agent to fix, remix, or personalize it for you.

YouTube Digest uses plain HTML, CSS, and JavaScript with no build step, so it is a friendly starting point for agent-assisted projects. Ideas to try:

- Add more translation languages and let each person choose a learning language.
- Create customized summary templates for lectures, interviews, tutorials, reviews, or research talks.
- Build a vocabulary notebook that saves a word, its sentence, meaning, and video timestamp.
- Export notes and vocabulary to Markdown, CSV, Anki, or another study tool.
- Add personal topic filters that highlight the chapters most relevant to a goal.
- Add optional local-model support for a different privacy and cost tradeoff.
- Improve accessibility with keyboard navigation, font controls, and higher-contrast themes.

Ask your agent to preserve the bring-your-own-key model, keep secrets out of source files, run the checks below, and test the remix on real videos.

If you want another AI provider or model, first open the exact YouTube Digest project folder that Chrome loaded through **Load unpacked** in your coding agent. Then open YouTube Digest Settings and use **Copy customization prompt**. Replace the `[PROVIDER]` and `[MODEL]` placeholders before sending it. Do not include any API key in the prompt or chat. After the agent updates your local copy, enter the key yourself in the Settings field it identifies.

## Privacy and data flow

YouTube Digest makes provider requests directly from the extension:

1. It reads captions from the page you already have open. Subtitle retrieval never leaves your machine and never uses a paid service.
2. It sends the transcript and relevant video metadata to DeepSeek when you request AI features.
3. Focused features send only the content they need, such as selected text with context or small transcript batches for translation.
4. It stores keys, settings, notes, and recent cache entries locally in Chrome.

There is no YouTube Digest account system, advertising, analytics, or telemetry. DeepSeek still receives data under its own terms and privacy policy. See [PRIVACY.md](PRIVACY.md) for details.

## Troubleshooting

### The Digest button is missing on a YouTube video

- At `chrome://extensions`, find YouTube Digest and click **Reload**, then refresh the YouTube tab.
- Confirm that you are on a standard `https://www.youtube.com/watch?...` page, not a Short, embed, or live page.
- The current version automatically follows YouTube when its responsive action bar changes. Wait a moment after the page finishes loading.
- If you have an older downloaded copy, resizing the YouTube window horizontally once may reveal the button. Then download the latest version so resizing is no longer required.
- If it is still missing, ask your coding agent to inspect the content script on that exact video page.

### The side panel does not open

- Confirm that you are on a standard `https://www.youtube.com/watch?...` page.
- At `chrome://extensions`, confirm YouTube Digest is enabled and click **Reload**.
- Refresh the YouTube tab after reloading the extension.
- Ask your coding agent to inspect the extension if the problem continues.

### YouTube Digest asks for setup

- Open **Settings** and save a DeepSeek key. That is the only key this extension
  asks for.
- This published version uses the fixed DeepSeek V4 Flash endpoint and model. There are no Base URL or Model fields to configure.
- If Settings says a legacy custom provider was removed, enter a DeepSeek key. The old AI key was cleared so it could not be reused with the wrong service.

### No transcript is found

- The panel distinguishes two cases. "This video has no captions" means the
  creator uploaded none and YouTube generated none, so there is nothing to read.
- "Couldn't read this video's captions" means captions exist but the page did not
  hand them over, which is usual after an extension update. Press
  **Reload page & retry**.
- Caption retrieval never uses a paid service, so retries cost nothing.
- There is no audio recording and no cloud transcription: a video without
  captions cannot be digested.

### AI requests fail

- A `401` or `403` usually means the DeepSeek key or account access is invalid.
- A `429` usually means a DeepSeek rate or spending limit was reached.
- Confirm the key was created in the DeepSeek Platform account linked above and that the account has available credit.
- If you adapted a local copy for another model, use the Settings customization prompt again and ask your coding agent to inspect that local implementation.

Never share API keys, private transcripts, or personal notes in chats, screenshots, or logs.

## Checks for coding agents

Ask your coding agent to run these commands after changing the project:

```bash
npm test
npm run check
npm run package
```

The agent should also reload the unpacked extension in Chrome and test several real YouTube videos. Automated checks do not prove that live provider requests and YouTube interactions work.

## License

MIT. See [LICENSE](LICENSE).
