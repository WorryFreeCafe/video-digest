const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/**
 * 用户反馈："以前点 Digest 立刻出字幕，现在提示 Local Whisper is not running。"
 *
 * 真实原因链是：平台原生字幕没取到 → 掉到 Whisper 兜底 → Whisper 没启动 →
 * 面板只显示 Whisper 的错误。这些用例锁住三件事：
 *   1. 字幕轨要等页面就绪，不能读一次失败就判定"没有字幕"；
 *   2. 失败原因要带回面板，不能只报 Whisper；
 *   3. pot 通道拿不到 URL 时，要让播放器重新请求一次，并用 inner API 兜底。
 */

function sliceFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} should exist`);
  // 函数体以首个 column-0 的 "}" 结尾。
  const lf = source.indexOf("\n}\n", start);
  const crlf = source.indexOf("\r\n}\r\n", start);
  const end = crlf >= 0 && (lf < 0 || crlf < lf) ? crlf + 1 : lf;
  return source.slice(start, end + 3);
}

test("caption tracks are awaited instead of read once", () => {
  const background = read("background.js");

  assert.match(background, /async function waitForCaptionTracks\(tabId, timeoutMs = 4000\)/);
  assert.match(background, /await new Promise\(\(resolve\) => setTimeout\(resolve, 400\)\)/);
  assert.match(background, /const \{ tracks \} = await waitForCaptionTracks\(tabId\)/);
  // 读不到就直落 Whisper 才是"有时能出字幕"的根因。
  assert.doesNotMatch(
    background,
    /const player = await getPlayerVideoDetails\(tabId\);\n\s*const tracks = \(player && player\.captionTracks\) \|\| \[\];/,
  );
});

test("the page snapshot is used when the player has no captions yet", () => {
  const background = read("background.js");
  const fetchDetails = background.slice(
    background.indexOf("async function getPlayerVideoDetails"),
    background.indexOf("// ============================================================\n// TRANSCRIPT FETCHING"),
  );

  assert.match(fetchDetails, /window\.ytInitialPlayerResponse/);
  assert.match(fetchDetails, /const captions = fromPlayer\?\.captions \|\| fromPage\?\.captions/);
});

test("platform failures are reported back to the panel", () => {
  const background = read("background.js");

  for (const reason of [
    "NO_CAPTION_TRACKS",
    "PLATFORM_PROBE_FAILED",
    "EMPTY_CAPTION_BODY",
    "CONTENT_SCRIPT_MISSING",
    "POT_UNAVAILABLE",
  ]) {
    assert.match(background, new RegExp(`"${reason}"`), `${reason} should be produced`);
  }
  // 失败原因必须随结果一起回到面板，否则用户只能看到一句笼统的失败。
  assert.match(background, /platformFailure,\s*platformDetail,/);
  assert.match(background, /retryable/);
});

test("the panel explains the platform cause and offers a reload", () => {
  const sidepanel = read("sidepanel.js");

  assert.match(sidepanel, /const PLATFORM_FAILURE_HINTS = \{/);
  assert.match(sidepanel, /function platformFailureHint\(result\)/);
  // 页面侧原因可直接刷新恢复，pot 钩子只在 document_start 注入。
  assert.match(sidepanel, /async function reloadTabAndRetryTranscript\(\)/);
  assert.match(sidepanel, /await chrome\.tabs\.reload\(youtubeTabId\)/);
  // 标题与正文都来自平台原因表，不再引导安装本地 Whisper。
  const fn = sidepanel.slice(sidepanel.indexOf("function showSubtitleFallbackError"));
  assert.match(fn, /document\.getElementById\("errorTitle"\)\.textContent =/);
  assert.match(fn, /platform\?\.title/);
  assert.match(fn, /platform\?\.hint/);
  assert.doesNotMatch(sidepanel, /openWhisperGuide|showWhisperFallbackError/);
});

test("a missing caption track still tries get_transcript and the page panel", () => {
  const background = read("background.js");
  const probe = background.slice(
    background.indexOf("async function probePlatformSubtitle"),
    background.indexOf("async function requestYoutubeCaptionFromPage"),
  );

  // 没有 tracks 时不能直接放弃，否则有字幕的视频也会被判定为"没有字幕"。
  assert.doesNotMatch(
    probe,
    /if \(!tracks\.length\) \{[\s\S]{0,200}?return null;/,
    "an empty track list must not bail out",
  );
  assert.match(probe, /await requestYoutubeTranscriptInner\(tabId, videoId, diagnostics\)/);
  assert.match(probe, /await requestYoutubeTranscriptPanel\(tabId, diagnostics\)/);
});

test("the transcript panel fallback reads rendered segments", () => {
  const content = read("content.js");

  assert.match(content, /async function fetchYoutubeTranscriptPanel\(\)/);
  assert.match(content, /ytd-transcript-segment-renderer/);
  assert.match(content, /querySelector\("\.segment-text"\)/);
  assert.match(content, /function findTranscriptToggle\(\)/);
  // 面板是 YouTube 自己渲染的：它天然带 pot 与登录态，是 pot 失败后的最后兜底。
  assert.match(content, /ytd-video-description-transcript-section-renderer/);
});

test("an already-on caption button is toggled so the player refetches", () => {
  const content = read("content.js");
  const kick = sliceFunction(content, "kickCaptionRequest");

  // 原本就开着时直接 return false → 播放器不会重新请求 → pot 永远拿不到。
  assert.doesNotMatch(kick, /aria-pressed"\) === "true"\) return false;/);
  assert.match(kick, /button\.click\(\);\s*setTimeout\(\(\) => \{/);
  assert.match(kick, /return \{ kicked: true, restore: false \}/);
});

test("the inner transcript API is the last native fallback", () => {
  const content = read("content.js");

  assert.match(content, /async function fetchYoutubeTranscriptInner\(videoId\)/);
  assert.match(content, /\/youtubei\/v1\/get_transcript\?prettyPrint=false/);
  assert.match(content, /const inner = await fetchYoutubeTranscriptInner\(videoId\)/);
  // 没有 pot 时也必须继续尝试，不能直接 NO_POT_URL。
  assert.match(content, /if \(inner\.success\) return inner;/);
});

test("findTranscriptParams walks the page data and finds the endpoint", () => {
  const content = read("content.js");
  const sandbox = {};
  vm.runInNewContext(
    `${sliceFunction(content, "findTranscriptParams")}\nthis.find = findTranscriptParams;`,
    sandbox,
  );

  const page = {
    engagementPanels: [
      { engagementPanelSectionListRenderer: { content: { nested: { getTranscriptEndpoint: { params: "abc123" } } } } },
    ],
  };
  assert.equal(sandbox.find(page), "abc123");
  assert.equal(sandbox.find({}), "");
});

test("collectTranscriptSegments flattens transcript renderers", () => {
  const source = read("content.js");
  const sandbox = {};
  vm.runInNewContext(
    `${sliceFunction(source, "collectTranscriptSegments")}\nthis.collect = collectTranscriptSegments;`,
    sandbox,
  );

  const data = {
    actions: [
      {
        updateEngagementPanelAction: {
          content: {
            transcriptRenderer: {
              a: { startMs: "0", snippet: { runs: [{ text: "hello" }] } },
              b: { startMs: "1200", snippet: { runs: [{ text: "world" }] } },
            },
          },
        },
      },
    ],
  };
  const segments = sandbox.collect(data);
  assert.equal(segments.length, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(segments.map((s) => s.startMs))).sort(),
    ["0", "1200"],
  );
  // 深度搜索本身不保证顺序，调用方必须按 startMs 排序，否则时间轴会乱。
  assert.match(
    source,
    /collectTranscriptSegments\(data\)\.sort\(\s*\(a, b\) => Number\(a\.startMs\) - Number\(b\.startMs\),?\s*\)/,
  );
});
