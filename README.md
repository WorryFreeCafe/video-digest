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
  the free native subtitle track, with no Supadata spend.
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
2. Open the official Supadata and DeepSeek pages below and help you create your own accounts.
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

YouTube Digest needs two keys under your own provider accounts:

1. A **Supadata API key** to retrieve YouTube transcripts.
2. A **DeepSeek API key** for overviews, explanations, translation, and automatic note polishing.

### Get a Supadata API key

1. Open the official [Supadata sign-up page](https://dash.supadata.ai/auth/sign-up).
2. Create an account and complete the short onboarding flow.
3. Supadata generates an API key automatically during onboarding.
4. Open the [Supadata dashboard](https://dash.supadata.ai/) whenever you need to find or manage the key.
5. Copy the key and paste it into **Supadata API key** in YouTube Digest Settings.

See the [official Supadata documentation](https://docs.supadata.ai/) if the dashboard flow changes.

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
- Native subtitle tracks returned by Supadata. YouTube Digest prefers English when available, but may show another native language.
- Original, Simplified Chinese, and aligned bilingual transcript views.
- AI overviews, selected-text explanations, translation, and automatic note polishing.
- Local notes and a local cache for recent transcript and digest results.
- DeepSeek V4 Flash for all published AI features. Other providers require a local code adaptation and are not supported by this published version.

Shorts, live streams, private or access-restricted videos, and videos without an available native transcript may not work. Firefox, Safari, mobile browsers, and other Chromium browsers are not currently tested or supported.

## Subtitle source routing (three scenarios)

YouTube Digest now routes subtitle retrieval by availability, so it does not
blindly spend a Supadata credit on every video:

1. **Platform-native subtitles (free, no Supadata).** The extension first probes
   for native captions on the current page - YouTube `captionTracks`, Bilibili's
   free subtitle API, or generic HTML5 `video.textTracks`. If found, the text is
   used directly for the digest, spending **zero** Supadata credits.

2. **No native subtitle → local Whisper transcription (optional).** If no
   platform caption exists and you enable **Local Whisper** in Settings, the
   extension captures the tab's current audio (via `chrome.tabCapture`, which
   works for cross-origin players) and sends it to a local [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
   service (`whisper/whisper_server.py`). Transcription happens on your machine
   and does not touch Supadata.

3. **Manual Supadata fallback.** Supadata is no longer auto-called. When neither
   a native caption nor an enabled Whisper fallback is available, the side panel
   shows a manual **Use Supadata (fallback)** action so you can spend a credit
   only when you choose to.

Supadata remains available, but it is opt-in rather than the default path.

### Run the local Whisper server (optional)

```bash
pip install -r whisper/requirements.txt
python whisper/whisper_server.py --model small --port 8000
```

Then in Settings, enable **Local Whisper** and keep the default server URL
`http://127.0.0.1:8000`. Note the same limitation as always: DRM / encrypted
streams and videos that have not started playing cannot be captured, so this
fallback only helps for playable, unencrypted videos.

Two practical notes:

- Bilibili's subtitle API only returns tracks for a signed-in session. If you are
  logged out, the probe finds nothing and the flow falls through to Whisper.
- Chrome only allows tab audio capture after the extension has been invoked on
  that tab, and only the toolbar icon or the shortcut counts as an invocation.
  The in-page Digest button opens the panel but does not grant activeTab. When
  the grant is missing Chrome answers `Extension has not been invoked for the
  current page`; the panel asks for one icon click and then resumes the capture
  on its own.
- The shortcut **Alt+Shift+9** does the same thing as clicking the icon (it also
  grants activeTab for the current tab), which helps when the icon is folded into
  the Extensions menu. Reloading the page drops the grant, so press it again.
- The grant comes from declaring `activeTab` in the manifest plus one real
  invocation. Without that permission every click fails with the same error, so
  keep it in `permissions`.

## Supadata free tier and request costs

Current as of August 9, 2026, the [Supadata pricing page](https://supadata.ai/pricing) lists a free tier with **100 credits per month**, no credit card required. Unused credits do not roll over. Supadata pricing can change, so check the current page before relying on these numbers.

The [Supadata transcript documentation](https://docs.supadata.ai/get-transcript) describes the transcript request modes and credit behavior:

- A native transcript request uses **1 credit**, regardless of video duration.
- A generated transcript costs **2 credits per video minute**. YouTube Digest does not use this path because it forces `mode=native`.
- An unavailable native lookup returned as HTTP `206` still uses **1 credit**.

With the current native-only behavior, the free tier can cover roughly 100 transcript lookups per month when each request succeeds once. Retries and unavailable-caption lookups also consume credits, so actual successful-video coverage can be lower.

DeepSeek usage is separate from Supadata. YouTube Digest does not collect payments or resell access. Set spending limits and monitor both accounts.

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

1. It sends a canonical YouTube watch URL to Supadata to request the native transcript.
2. It sends the transcript and relevant video metadata to DeepSeek when you request AI features.
3. Focused features send only the content they need, such as selected text with context or small transcript batches for translation.
4. It stores keys, settings, notes, and recent cache entries locally in Chrome.

There is no YouTube Digest account system, advertising, analytics, or telemetry. Supadata and DeepSeek still receive data under their own terms and privacy policies. See [PRIVACY.md](PRIVACY.md) for details.

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

- Open **Settings** and save a DeepSeek key. A Supadata key is only required if
  you want the manual Supadata fallback; with platform-native subtitles or an
  enabled local Whisper fallback, Supadata is optional.
- This published version uses the fixed DeepSeek V4 Flash endpoint and model. There are no Base URL or Model fields to configure.
- If Settings says a legacy custom provider was removed, enter a DeepSeek key. The old AI key was cleared so it could not be reused with the wrong service.

### No transcript is found

- Confirm the video is public and has native captions.
- If you did not enable **Local Whisper** in Settings, the extension does not
  transcribe audio on its own. Enable it (and start `whisper/whisper_server.py`)
  to get an audio-transcription fallback.
- When you do use the manual Supadata fallback, remember that unavailable native
  lookups and manual retries may still consume credits.

The extension will not auto-spend Supadata credits when a native caption is
missing; it either uses a platform caption, your local Whisper fallback, or
asks you to choose before any paid lookup.

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
