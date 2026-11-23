const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/**
 * YouTube 从 2025 年起对 /api/timedtext 加了 proof-of-origin token（pot）。
 * 没有 pot 时接口返回 HTTP 200 + 空响应体 —— 这些用例锁住两层保证：
 *   1. 抓取端不能把"空 200"当成成功；
 *   2. 抓取端必须能拿到播放器自己带 pot 的签名 URL，并改写 lang 直取全量字幕。
 */

test("the pot hook runs in MAIN world before the player starts", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const hook = manifest.content_scripts.find((script) =>
    (script.js || []).includes("caption-pot-hook.js"),
  );

  assert.ok(hook, "caption-pot-hook.js must be a declared content script");
  // 播放器在页面加载早期就会请求字幕，钩子必须比它更早注入。
  assert.equal(hook.run_at, "document_start");
  // 钩子要改页面的 XMLHttpRequest，必须跑在 MAIN world。
  assert.equal(hook.world, "MAIN");
  assert.deepEqual(hook.js, ["caption-pot-hook.js"]);
});

test("the hook only remembers signed (pot) caption URLs", () => {
  const hook = read("caption-pot-hook.js");

  assert.match(hook, /url\.indexOf\("\/api\/timedtext"\)/);
  assert.match(hook, /url\.indexOf\("pot="\)/);
  assert.match(hook, /XMLHttpRequest\.prototype\.open/);
  assert.match(hook, /window\.postMessage/);
  // 不能因为挂钩子影响播放器自己的请求。
  assert.match(hook, /origSend\.apply\(this, arguments\)/);
});

test("content script rewrites the signed URL instead of re-signing it", () => {
  const content = read("content.js");

  assert.match(content, /function fetchYoutubeCaptionText\(trackLangs\)/);
  assert.match(content, /target\.searchParams\.set\("fmt", "json3"\)/);
  // tlang 是"翻译成某语言"，留着会拿到翻译版甚至空结果。
  assert.match(content, /target\.searchParams\.delete\("tlang"\)/);
  // 中文优先：用户看的是中文视频，轨道顺序不一定稳定。
  assert.match(content, /const chinese = langs\.find\(\(l\) => \/\^zh\(-\|\$\)\/i\.test\(l\)\)/);
  // 空响应说明 pot 失效，必须丢弃缓存。
  assert.match(content, /return \{ success: false, reason: "EMPTY", status: resp\.status \}/);
  // 为了拿 URL 而打开的字幕开关，抓完要还原。
  assert.match(content, /restoreCaptionState\(restoreNeeded\)/);
});

test("an empty HTTP 200 is treated as failure, not as captions", () => {
  const background = read("background.js");
  const body = background.slice(
    background.indexOf("async function probePlatformSubtitle"),
    background.indexOf("async function readBilibiliSubtitleMeta"),
  );

  // 只看 resp.ok 会把空的 200 当成"已拿到字幕"。
  assert.match(body, /if \(body && body\.length > 200\)/);
  assert.match(
    body,
    /requestYoutubeCaptionFromPage\(\s*tabId,\s*trackLangs,\s*diagnostics,?\s*\)/,
  );
});

test("json3 captions are parsed with their timeline", () => {
  const background = read("background.js");

  assert.match(background, /function parseYoutubeCaptionJson3\(json\)/);
  assert.match(background, /Number\(event\.tStartMs \|\| 0\) \/ 1000/);
  // 自动字幕相邻事件会重复上一句，重复项必须去掉，否则时间轴翻倍。
  assert.match(background, /if \(text === previous\) continue;/);
  assert.match(background, /if \(text\.startsWith\("\{"\)\) return parseYoutubeCaptionJson3\(text\)/);
});

test("stale digests from older caption logic are dropped", () => {
  const sidepanel = read("sidepanel.js");

  assert.match(sidepanel, /const DIGEST_CACHE_VERSION = 2;/);
  assert.match(sidepanel, /version: DIGEST_CACHE_VERSION,/);
  assert.match(
    sidepanel,
    /if \(\(cached\.version \|\| 0\) < DIGEST_CACHE_VERSION\) \{[\s\S]*?return null;/,
  );
});

test("pages opened before the update still get the hook, no reload needed", () => {
  const background = read("background.js");

  assert.match(background, /async function ensureCaptionPotHook\(tabId\)/);
  assert.match(
    background,
    /world: "MAIN",\s*\n\s*files: \["caption-pot-hook\.js"\]/,
  );
  // 旧页面没有钩子时会返回 NO_POT_URL，必须补注入后重试一次。
  assert.match(background, /res\.reason === "NO_POT_URL"/);
  assert.match(background, /if \(await ensureCaptionPotHook\(tabId\)\)/);
});
