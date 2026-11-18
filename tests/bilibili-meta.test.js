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

test("the Bilibili button never enters Bilibili's own DOM tree", () => {
  const content = read("content.js");

  // B站 的播放页由 Vue 接管 SSR 结果。把外来节点插进 .video-toolbar-left-main
  // 这类受控容器，会让它的 patch 对不上节点列表，导致 UP 主头像、关注数、
  // 右侧推荐封面都不渲染（关掉扩展即恢复）。按钮必须是挂在 body 上的浮层。
  assert.doesNotMatch(content, /video-toolbar-left-main/);
  assert.doesNotMatch(content, /toolbar\.insertBefore/);
  assert.doesNotMatch(content, /findBilibiliToolbar/);

  const inject = content.slice(
    content.indexOf("function injectBilibiliButtons"),
    content.indexOf("function scheduleDigestButtonReconciliation"),
  );
  assert.match(inject, /document\.body\.appendChild\(fresh\)/);
  assert.match(inject, /if \(!isBilibiliVideoPage\(\)\)/);
});

test("the Bilibili button waits for hydration and stays out of fullscreen", () => {
  const content = read("content.js");
  const init = content.slice(
    content.indexOf("function initBilibili"),
    content.indexOf("function isBilibiliVideoPage"),
  );

  // document_idle 时 B站 的 hydration 还没结束，必须延后注入。
  assert.match(init, /window\.addEventListener\("load", \(\) => setTimeout\(start, 700\)/);
  assert.match(init, /setTimeout\(start, 700\)/);
  // 全屏播放时浮层不该盖在视频上。
  assert.match(init, /document\.fullscreenElement \? "none" : ""/);
});

test("the floating Bilibili button opens the side panel", () => {
  const content = read("content.js");
  const create = content.slice(
    content.indexOf("function createBilibiliDigestButton"),
    content.indexOf("function injectBilibiliDigestButton"),
  );

  assert.match(create, /void openDigestPanel\("Bilibili Digest"\)/);
  assert.match(create, /button\.id = "ytd-digest-button"/);
  assert.match(create, /position: fixed;/);
});
