const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

/**
 * Slice a top-level function out of a source file. Both LF and CRLF checkouts
 * must work, since the repo is edited on Windows and on CI.
 */
function sliceFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const lf = source.indexOf("\n}\n", start);
  const crlf = source.indexOf("\r\n}\r\n", start);
  const end = crlf >= 0 && (lf < 0 || crlf < lf) ? crlf + 1 : lf;
  return source.slice(start, end + 3);
}

test("Bilibili gets a Note button next to the Digest button", () => {
  const content = read("content.js");

  assert.match(content, /function createBilibiliNoteButton\(\)/);
  assert.match(content, /button\.id = "ytd-bili-note-button"/);
  // Both buttons must live in the same overlay bar, appended to <body>.
  assert.match(content, /fresh\.append\(biliDigestButton, biliNoteButton\)/);
  assert.match(content, /document\.body\.appendChild\(fresh\)/);
  // The shortcut used to return early for Bilibili, so "n" did nothing there.
  assert.match(content, /if \(YTD_PAGE_SITE === "bilibili"\) return isBilibiliVideoPage\(\);/);
});

test("saveCurrentNote works on both platforms", () => {
  const content = read("content.js");
  const save = sliceFunction(content, "saveCurrentNote");

  // Bilibili's player is not `video.html5-main-video`.
  assert.match(save, /#bilibili-player video/);
  // videoId must come from the shared extractor, which understands BV / av ids.
  assert.match(save, /extractVideoId\(window\.location\.href\)/);
  assert.match(save, /site: YTD_PAGE_SITE/);
  assert.match(save, /pageUrl: window\.location\.href/);
});

test("note links point at Bilibili when the note comes from Bilibili", () => {
  const source = read("background.js");
  const sandbox = {
    YTD_SETTINGS: {
      canonicalYouTubeUrl: (id) => `https://www.youtube.com/watch?v=${id}`,
    },
    URL,
    console,
  };
  vm.runInNewContext(
    `${sliceFunction(source, "buildNoteTimestampedUrl")}
    this.build = buildNoteTimestampedUrl;`,
    sandbox,
  );

  const bili = sandbox.build({
    site: "bilibili",
    pageUrl: "https://www.bilibili.com/video/BV1GJ411x7h7/?p=2&spm_id_from=333",
    videoId: "BV1GJ411x7h7",
    seconds: 95,
  });
  assert.match(bili, /^https:\/\/www\.bilibili\.com\/video\/BV1GJ411x7h7\//);
  // The part number must survive, otherwise the note reopens the wrong part.
  assert.match(bili, /[?&]p=2/);
  assert.match(bili, /[?&]t=95/);
  assert.doesNotMatch(bili, /spm_id_from/);

  // Missing page URL still produces a usable Bilibili link.
  const fallback = sandbox.build({
    site: "bilibili",
    pageUrl: "",
    videoId: "BV1GJ411x7h7",
    seconds: 12,
  });
  assert.equal(fallback, "https://www.bilibili.com/video/BV1GJ411x7h7/?t=12");

  const youtube = sandbox.build({
    site: "youtube",
    pageUrl: "https://www.youtube.com/watch?v=ydTeb_I0b94",
    videoId: "ydTeb_I0b94",
    seconds: 30,
  });
  assert.equal(youtube, "https://www.youtube.com/watch?v=ydTeb_I0b94&t=30s");
});

test("a note without a digest cache reads the platform captions instead", () => {
  const source = read("background.js");
  const save = sliceFunction(source, "handleSaveNote");

  // Notes now come from a page overlay, not only from the side panel, so the
  // digest cache cannot be a hard requirement anymore.
  assert.match(save, /meta\.tabId/);
  assert.match(save, /handleFetchTranscriptSmart\(videoId, meta\.tabId\)/);
  // 只有平台字幕，不会再为了定位一句去录几十秒音频。
  const smart = sliceFunction(source, "handleFetchTranscriptSmart");
  assert.doesNotMatch(smart, /captureAudio|whisper/i);
});
