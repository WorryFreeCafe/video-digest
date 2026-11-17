const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function loadExportHelpers() {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame: () => 0,
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    window: { getSelection: () => null, close() {} },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => ({ set textContent(value) {}, get innerHTML() {} }),
    },
    chrome: {
      runtime: { onMessage: listeners, sendMessage: () => Promise.resolve({}) },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("sidepanel.js"), sandbox);
  return sandbox.__YTD_TRANSCRIPT_TESTING__;
}

const segments = [
  { id: "a", start: 0, text: "First line." },
  { id: "b", start: 3.2, text: "Second line." },
  { id: "c", start: 80.5, text: "After a long pause." },
];

test("cue ends follow the next caption, capped by a reading estimate", () => {
  const { buildTranscriptCues } = loadExportHelpers();
  const cues = buildTranscriptCues(segments);

  assert.equal(cues.length, 3);
  // 3.2s of room, but "First line." only needs the 1.6s floor.
  assert.equal(cues[0].end, 1.6);
  // The last cue has no successor, so the reading estimate owns the end time.
  assert.ok(cues[2].end > 80.5 && cues[2].end < 84);
});

test("a long gap never leaves a caption on screen for a minute", () => {
  const { buildTranscriptCues } = loadExportHelpers();
  const cues = buildTranscriptCues([
    { start: 0, text: "Short line." },
    { start: 600, text: "Much later." },
  ]);

  assert.ok(cues[0].end <= 7, `expected a capped cue, got ${cues[0].end}`);
});

test("dense captions keep a minimum on-screen duration without collapsing", () => {
  const { buildTranscriptCues } = loadExportHelpers();
  const cues = buildTranscriptCues([
    { start: 0, text: "One." },
    { start: 0.3, text: "Two." },
  ]);

  assert.equal(cues[0].end, 0.6);
  assert.ok(cues[0].end > cues[0].start);
});

test("empty captions are skipped instead of exporting blank cues", () => {
  const { buildTranscriptCues } = loadExportHelpers();
  const cues = buildTranscriptCues([
    { start: 0, text: "   " },
    { start: 5, text: null },
    { start: 9, text: "Real text." },
  ]);

  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "Real text.");
  assert.equal(cues[0].start, 9);
});

test("timecodes round on milliseconds and never produce 1000ms", () => {
  const { formatSubtitleTimestamp } = loadExportHelpers();

  assert.equal(formatSubtitleTimestamp(0), "00:00:00,000");
  assert.equal(formatSubtitleTimestamp(59.9996), "00:01:00,000");
  assert.equal(formatSubtitleTimestamp(3725.5, "."), "01:02:05.500");
  assert.equal(formatSubtitleTimestamp(-4), "00:00:00,000");
});

test("clock stamps stay mm:ss until the video passes an hour", () => {
  const { formatClockTimestamp } = loadExportHelpers();

  assert.equal(formatClockTimestamp(0), "00:00");
  assert.equal(formatClockTimestamp(65.9), "01:05");
  assert.equal(formatClockTimestamp(3725), "1:02:05");
});

test("SRT output is numbered, comma separated, and blank-line delimited", () => {
  const { buildTranscriptCues, buildSubtitleFile } = loadExportHelpers();
  const srt = buildSubtitleFile(buildTranscriptCues(segments.slice(0, 2)), "srt");

  assert.equal(
    srt,
    [
      "1",
      "00:00:00,000 --> 00:00:01,600",
      "First line.",
      "",
      "2",
      "00:00:03,200 --> 00:00:04,800",
      "Second line.",
      "",
    ].join("\n"),
  );
});

test("WebVTT output starts with WEBVTT and drops cue numbers", () => {
  const { buildTranscriptCues, buildSubtitleFile } = loadExportHelpers();
  const vtt = buildSubtitleFile(buildTranscriptCues(segments.slice(0, 1)), "vtt");

  assert.equal(
    vtt,
    ["WEBVTT", "", "00:00:00.000 --> 00:00:01.600", "First line.", ""].join("\n"),
  );
  assert.doesNotMatch(vtt, /^1$/m);
  assert.doesNotMatch(vtt, /\d{2},\d{3}/);
});

test("bilingual cues keep both lines inside one cue", () => {
  const { buildTranscriptCues, buildSubtitleFile } = loadExportHelpers();
  const cues = buildTranscriptCues([{ start: 2, text: "Hello\n你好" }]);
  const srt = buildSubtitleFile(cues, "srt");

  assert.match(srt, /Hello\n你好\n$/);
});

test("timestamped text indents continuation lines under the text column", () => {
  const { buildTranscriptCues, buildTimestampedText } = loadExportHelpers();
  const body = buildTimestampedText(
    buildTranscriptCues([{ start: 64, text: "原文\n译文" }]),
  );

  assert.equal(body, "[01:04] 原文\n        译文");
});

test("exported file names keep non-Latin titles usable", () => {
  const { sanitizeFilename } = loadExportHelpers();

  assert.equal(sanitizeFilename("为什么 AI 需要记忆？"), "为什么-ai-需要记忆");
  assert.equal(sanitizeFilename("   "), "untitled");
  assert.equal(sanitizeFilename("A/B: test"), "ab-test");
});

test("the transcript header is sticky so Copy and Export stay reachable", () => {
  const css = read("sidepanel.css");
  const block = css.slice(
    css.indexOf(".transcript-section-header {"),
    css.indexOf(".transcript-section-header.is-stuck"),
  );

  assert.match(block, /position:\s*sticky/);
  assert.match(block, /top:\s*0/);
  assert.match(block, /background:\s*var\(--bg\)/);
  assert.match(css, /\.transcript-section-header\.is-stuck\s*\{/);
});

test("the export trigger offers text, timestamped text, SRT, and WebVTT", () => {
  const html = read("sidepanel.html");
  const script = read("sidepanel.js");

  assert.match(html, /id="exportFormatMenu"/);
  assert.match(html, /aria-haspopup="menu"/);
  for (const format of ["txt", "txt-timed", "srt", "vtt"]) {
    assert.match(
      html,
      new RegExp(`data-export-format="${format}"`),
      `missing export format ${format}`,
    );
    assert.match(
      script,
      new RegExp(`"?${format}"?:\\s*\\{\\s*extension:`),
      `format ${format} has no file spec`,
    );
  }
  assert.equal(html.match(/data-export-format=/g).length, 4);
});

test("export no longer downloads before the user picks a format", () => {
  const script = read("sidepanel.js");

  assert.doesNotMatch(
    script,
    /getElementById\("exportTranscriptBtn"\)\s*[\r\n\s]*\?\.addEventListener\(\s*"click",\s*exportTranscript/,
    "the trigger must open the menu, not export the default format",
  );
  assert.match(script, /function setupExportMenu\(\)/);
  assert.match(script, /item\.dataset\.exportFormat/);
});
