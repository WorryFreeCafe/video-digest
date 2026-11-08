const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("tab audio capture runs in an offscreen document, not the service worker", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const background = read("background.js");
  const offscreen = read("offscreen.js");
  const html = read("offscreen.html");

  assert.ok(manifest.permissions.includes("offscreen"));
  assert.ok(manifest.permissions.includes("tabCapture"));
  assert.match(html, /<script src="offscreen\.js"><\/script>/);

  // The service worker only acquires a stream id and delegates recording.
  assert.match(background, /chrome\.tabCapture\.getMediaStreamId/);
  assert.match(background, /chrome\.offscreen\.createDocument/);
  assert.match(background, /action: "recordTabAudio"/);
  assert.doesNotMatch(background, /chrome\.tabCapture\.capture\s*\(/);
  assert.doesNotMatch(background, /new MediaRecorder/);

  // Recording and uploading belong to the offscreen document.
  assert.match(offscreen, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(offscreen, /new MediaRecorder/);
  assert.match(offscreen, /chromeMediaSource:\s*"tab"/);
  assert.match(offscreen, /\/transcribe/);
  assert.match(offscreen, /stream\.getTracks\(\)\.forEach/);
});

test("manual Whisper retry passes options as the third argument", () => {
  const background = read("background.js");
  assert.match(
    background,
    /handleCaptureAudioTranscribe\(message\.tabId, null, message\.options\)/,
  );
});

test("whisper server allows extension-page and localhost origins", () => {
  const server = read("whisper/whisper_server.py");
  assert.match(server, /allow_origin_regex=/);
  assert.match(server, /chrome-extension:\/\//);
  assert.match(server, /localhost/);
});

test("tabCapture invoked-guard error becomes an actionable Chinese hint", () => {
  const background = read("background.js");
  assert.match(background, /has not been invoked/i);
  assert.match(background, /CAPTURE_NOT_INVOKED/);
  assert.match(background, /请点一下工具栏的 YouTube Digest 图标/);
  assert.match(background, /Alt\+Shift\+9/);
});

test("release allowlist includes the offscreen document files", () => {
  const check = read("scripts/check-release.sh");
  assert.match(check, /"offscreen\.html"/);
  assert.match(check, /"offscreen\.js"/);
});
