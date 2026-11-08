const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const sources = require(path.join(root, "subtitle-sources.js"));

test("every platform branch is wrapped in a source envelope", () => {
  const background = read("background.js");

  // buildTranscriptFromChunks / fetchBilibiliSubtitle return the transcript
  // body only — no `success` flag. The smart router gates on
  // `platform.success`, so returning the raw body made every native caption
  // path look unavailable and fall through to Whisper.
  assert.match(background, /function asPlatformResult\(built, note\)/);
  assert.match(
    background,
    /return YTD_SUBTITLE_SOURCES\.sourceResult\("platform",\s*\{[\s\S]*?note,/,
  );

  for (const branch of ["B 站原生字幕", "页面原生字幕轨", "YouTube 原生字幕"]) {
    assert.ok(
      background.includes(branch),
      `platform branch "${branch}" must go through asPlatformResult`,
    );
  }
});

test("asPlatformResult drops empty transcripts and stamps success", () => {
  const background = read("background.js");
  const body = background.slice(
    background.indexOf("function asPlatformResult"),
    background.indexOf("async function probePlatformSubtitle"),
  );

  assert.match(body, /Array\.isArray\(built\.transcript\)/);
  assert.match(body, /built\.transcript\.length === 0/);
  assert.match(body, /return null;/);
});

test("smart router tolerates a missing success flag", () => {
  const background = read("background.js");
  // Defensive: an unwrapped platform result must still be usable, otherwise a
  // future branch reintroduces the silent fallback to Whisper.
  assert.match(background, /platform\.success !== false/);
});

test("source envelope marks platform subtitles as successful", () => {
  const res = sources.sourceResult("platform", {
    transcript: [{ text: "你好呀！", start: 4, duration: 0, language: "ai-zh" }],
    transcriptText: "你好呀！",
    language: "ai-zh",
  });

  assert.equal(res.success, true);
  assert.equal(res.source, "platform");
  assert.equal(res.transcript.length, 1);
});

test("whisper capture results carry a success envelope", () => {
  const background = read("background.js");
  const start = background.indexOf("const text = await captureViaOffscreen");
  const slice = background.slice(start, start + 900);

  // buildTranscriptFromPlainText returns the transcript body only. Returning
  // it raw made applyTranscriptResult() and handleFetchTranscriptSmart() treat
  // a successful Whisper run as a failure ("No transcript found").
  assert.match(slice, /sourceResult\("whisper"/);
  assert.doesNotMatch(slice, /built\.note = /);
});
