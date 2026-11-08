const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("bilibili cid is read from the page's main world", () => {
  const background = read("background.js");

  // window.__INITIAL_STATE__ only exists in the page's main world. A content
  // script reading it from the isolated world always gets undefined, which
  // silently disables the free Bilibili caption path.
  assert.match(background, /async function readBilibiliSubtitleMeta/);
  assert.match(background, /world:\s*"MAIN"/);
  assert.match(background, /window\.__INITIAL_STATE__/);
});

test("fetchBilibiliSubtitle resolves cid through the main-world reader", () => {
  const background = read("background.js");
  assert.match(background, /const meta = await readBilibiliSubtitleMeta\(tabId, videoId\)/);
  assert.doesNotMatch(
    background,
    /async function fetchBilibiliSubtitle\(tabId, videoId\) \{\s*let meta;/,
  );
});

test("main-world reader keeps the content-script path as a fallback", () => {
  const background = read("background.js");
  assert.match(background, /action: "fetchBilibiliSubtitleMeta"/);
  assert.match(background, /JSON\.parse\(raw\)/);
});

test("bilibili API and subtitle-file requests carry login cookies", () => {
  const background = read("background.js");
  // Both the player info API and the AI-subtitle file on aisubtitle.hdslb.com
  // only return data for a signed-in session; "omit" silently empties results.
  assert.doesNotMatch(background, /credentials:\s*"omit"/);
  assert.match(background, /credentials:\s*"include"/);
});
