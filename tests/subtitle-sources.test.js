const test = require("node:test");
const assert = require("node:assert/strict");

const sources = require("../subtitle-sources.js");

test("detectSite recognizes youtube, bilibili, and generic hosts", () => {
  assert.equal(sources.detectSite("https://www.youtube.com/watch?v=abc123"), "youtube");
  assert.equal(sources.detectSite("https://www.bilibili.com/video/BV1xx411c7mD"), "bilibili");
  assert.equal(sources.detectSite("https://example.com/video"), "generic");
  assert.equal(sources.detectSite(""), "generic");
});

test("extractVideoId handles YouTube v param and Bilibili BV/av", () => {
  assert.equal(
    sources.extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    "dQw4w9WgXcQ",
  );
  assert.equal(
    sources.extractVideoId("https://www.bilibili.com/video/BV1xx411c7mD"),
    "BV1xx411c7mD",
  );
  assert.equal(
    sources.extractVideoId("https://www.bilibili.com/video/av12345"),
    "av12345",
  );
  assert.equal(sources.extractVideoId("https://example.com/video"), null);
});

test("buildTranscriptFromChunks produces transcript, plain text, and timestamped text", () => {
  const built = sources.buildTranscriptFromChunks([
    { start: 0, text: "Hello >> world" },
    { start: 90, text: "Second line" },
    { start: 120, text: "" },
  ]);
  assert.equal(built.transcript.length, 2);
  assert.equal(built.transcript[0].text, "Hello world");
  assert.equal(built.transcript[1].start, 90);
  assert.equal(built.transcriptText, "Hello world Second line");
  assert.match(built.transcriptTextTimestamped, /\[0:00\] Hello world/);
  assert.match(built.transcriptTextTimestamped, /\[1:30\] Second line/);
});

test("buildTranscriptFromChunks accepts plain string chunks", () => {
  const built = sources.buildTranscriptFromChunks(["alpha", "beta"]);
  assert.equal(built.transcriptText, "alpha beta");
});

test("buildTranscriptFromPlainText wraps text as a single entry", () => {
  const built = sources.buildTranscriptFromPlainText("Transcribed words");
  assert.equal(built.transcript.length, 1);
  assert.equal(built.transcript[0].text, "Transcribed words");
  assert.equal(built.transcriptText, "Transcribed words");
});

test("buildTranscriptFromPlainText returns empty result for blank input", () => {
  const built = sources.buildTranscriptFromPlainText("   ");
  assert.equal(built.transcript.length, 0);
  assert.equal(built.transcriptText, "");
});

test("sourceResult stamps the source and keeps payload", () => {
  const res = sources.sourceResult("platform", {
    success: true,
    transcript: [],
    transcriptText: "x",
  });
  assert.equal(res.source, "platform");
  assert.equal(res.success, true);
  assert.equal(res.transcriptText, "x");
});
