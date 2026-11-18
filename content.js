/**
 * CONTENT SCRIPT
 *
 * This script runs ON the YouTube page itself. It can see and modify
 * the YouTube page DOM (the HTML elements).
 *
 * It handles:
 * 1. Extracting video info (title, channel name) from the page
 * 2. Injecting "key moment" markers onto YouTube's progress bar
 * 3. Adding a "Digest" button to YouTube's action bar (next to Share/Save)
 *
 * Think of it like a robot sitting inside the YouTube tab,
 * reading the page and making small visual changes.
 */

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// ============================================================
// GLOBAL STATE
// ============================================================

let ytdNoteButton = null;
let ytdNoteButtonVisible = false;
let ytdNoteButtonTimer = null;
let ytdNoteKeyboardListenerAdded = false;
let ytdNoteButtonRetryTimer = null;
let ytdDigestButton = null;
let digestButtonObserver = null;
let digestButtonReconcileTimer = null;
let digestButtonResizeListenerAdded = false;

// Reconcile rate limit. YouTube mutates the watch page several times a second
// during playback, so an unbounded debounce still meant a full toolbar scan
// every 80ms. 400ms keeps the button responsive without the churn.
const DIGEST_RECONCILE_MIN_GAP_MS = 400;
let digestButtonLastReconcileAt = 0;
let biliDigestButton = null;
let biliNoteButton = null;
let biliNavTimer = null;
let biliLastHref = "";
let biliFullscreenListenerAdded = false;
let biliButtonPositionRaf = null;
let biliLastButtonLayout = "";
let biliPositionListenersAdded = false;
let biliActionsVisible = false;
let biliActionsHideTimer = null;
let biliActionsVisibilityTimer = null;
let biliPointerInside = false;
let biliPointerRaf = null;
let biliPeekedHref = "";

// The two B站 buttons float over the player's top-right corner. They are kept
// out of B站's own containers on purpose: the watch page is Vue-hydrated, and
// injecting into its toolbar makes the avatar / follow count / recommendation
// covers fail to render. A fixed overlay that tracks the player rect gives the
// same placement without touching the framework's DOM.
const BILIBILI_BUTTON_GAP = 12;

// 最近一次由播放器发出的、带 proof-of-origin token 的 timedtext URL。
// 由 MAIN world 的 caption-pot-hook.js 通过 postMessage 送过来。没有 pot 的
// URL 请求 YouTube 会返回空的 200，所以这里只接受带 pot 的那一种。
let ytdCaptionPotUrl = "";
let ytdCaptionPotAt = 0;
let ytdCaptionPotWaiters = [];

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "ytd-caption-pot" || data.type !== "url") return;
  if (!data.url) return;
  ytdCaptionPotUrl = data.url;
  ytdCaptionPotAt = data.at || Date.now();
  const waiters = ytdCaptionPotWaiters;
  ytdCaptionPotWaiters = [];
  for (const fn of waiters) fn(ytdCaptionPotUrl);
});

/**
 * Which platform this page belongs to. The same content script is injected on
 * YouTube and B站, and each site needs its own toolbar selectors.
 */
const YTD_PAGE_SITE = (() => {
  const host = window.location?.hostname || "";
  if (host.endsWith("bilibili.com")) return "bilibili";
  if (host.endsWith("youtube.com")) return "youtube";
  return "generic";
})();

// ============================================================
// INITIALIZATION
// ============================================================

/**
 * When the page loads, inject our Digest button and Note button.
 * We wait a bit for YouTube's UI to fully render.
 */
function init() {
  // The "n" shortcut only needs a video page, so register it before the site
  // split: B站 gets the same shortcut now that it has a Note button.
  if (!ytdNoteKeyboardListenerAdded) {
    document.addEventListener("keydown", handleNoteKeyboardShortcut);
    ytdNoteKeyboardListenerAdded = true;
  }

  // B站 keeps its own injection path: the toolbar is Vue-hydrated, so the
  // YouTube selectors must never run there (they would retry forever).
  if (YTD_PAGE_SITE === "bilibili") {
    initBilibili();
    return;
  }

  // Try to inject the buttons immediately
  injectDigestButton();
  tryInjectNoteButton();

  // Also set up an observer to handle YouTube's dynamic content loading
  // (YouTube is an SPA, so elements appear/disappear as you navigate)
  setupButtonObserver();
  setupDigestButtonResizeListener();
}

/**
 * Attempts to inject the note button. If the player container isn't ready yet,
 * retry a few times with a short delay. YouTube renders the player asynchronously
 * after navigation, so a single immediate attempt can miss it.
 */
function tryInjectNoteButton() {
  if (!window.location.pathname.includes("/watch")) return;

  // Two cheap exits before doing any DOM work. Both matter because this
  // function is called from the body-wide MutationObserver: YouTube rewrites
  // its time label several times a second, and re-arming the retry loop on
  // every one of those mutations used to reset the attempt budget, turning the
  // "give up after ~3s" guard into a permanent 10 queries/second scan.
  if (ytdNoteButton && ytdNoteButton.isConnected) return;
  if (ytdNoteButtonRetryTimer) return; // a retry loop is already running

  let attempts = 0;
  const maxAttempts = 30; // ~3 seconds of retrying

  function attempt() {
    attempts++;
    const playerContainer = document.querySelector(
      "#movie_player.html5-video-player, #movie_player, .html5-video-player",
    );

    if (playerContainer) {
      injectNoteButton();
      if (ytdNoteButtonRetryTimer) {
        clearInterval(ytdNoteButtonRetryTimer);
        ytdNoteButtonRetryTimer = null;
      }
      return;
    }

    if (attempts >= maxAttempts) {
      debugLog(
        "[YouTube Digest Content] Player container not found after retries, giving up",
      );
      if (ytdNoteButtonRetryTimer) {
        clearInterval(ytdNoteButtonRetryTimer);
        ytdNoteButtonRetryTimer = null;
      }
    }
  }

  attempt();
  if (!ytdNoteButton || !ytdNoteButton.isConnected) {
    ytdNoteButtonRetryTimer = setInterval(attempt, 100);
  }
}

// Run init when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel or background script.
 * When they ask for video info, we read it from the page.
 * When they send key moments, we highlight them on the progress bar.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  debugLog("[YouTube Digest Content] Received message:", message.action, message);

  if (message.action === "getVideoInfo") {
    // Read video title and channel name from the page
    const info = extractVideoInfo();
    debugLog("[YouTube Digest Content] Returning video info:", info);
    sendResponse(info);
    return false; // Synchronous response
  }

  if (message.action === "highlightMoments") {
    // Key moment markers disabled — chapters are shown in the side panel only.
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "getCurrentTime") {
    // Return the current video playback time (used by auto-scroll)
    const video = document.querySelector(
      "video.html5-main-video, #bilibili-player video, video",
    );
    sendResponse({
      currentTime: video ? Math.floor(video.currentTime) : 0,
      paused: video ? video.paused : true,
    });
    return false;
  }

  if (message.action === "fetchYoutubeCaptionText") {
    // YouTube 全量字幕：借播放器带 pot 的签名 URL，绕开"空 200"。
    fetchYoutubeCaptionText(message.trackLangs)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, reason: String(err) }));
    return true; // async response
  }

  if (message.action === "probePlatformSubtitle") {
    // 站点专属字幕探测：优先从页面拿到平台原生字幕所需的关键信息。
    // YouTube 的 captionTracks 需在 MAIN world 读取（由 background 用
    // executeScript 处理）；这里主要处理 B站 cid/bvid 提取。
    const info = extractPlatformSubtitleMeta();
    sendResponse(info);
    return false;
  }

  if (message.action === "fetchBilibiliSubtitleMeta") {
    // 从 B站页面 window.__INITIAL_STATE__ 提取 cid 与 bvid，供 background
    // 调用 B站字幕接口（返回 body 数组，全程免费）。
    const meta = extractBilibiliCid();
    sendResponse(meta);
    return false;
  }

  if (message.action === "seekTo") {
    // Jump the video to a specific timestamp
    debugLog("[YouTube Digest Content] Seeking to:", message.seconds);
    seekToTimestamp(message.seconds);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "showNoteSavedFeedback") {
    // Show brief feedback that note was saved
    showNoteSavedToast(message.note);
    sendResponse({ success: true });
    return false;
  }

  // Unknown action - still send a response to prevent hanging
  debugLog("[YouTube Digest Content] Unknown action:", message.action);
  sendResponse({ success: false, error: "Unknown action" });
  return false;
});

// ============================================================
// DIGEST BUTTON INJECTION
// ============================================================

/**
 * Injects a "Digest" button into YouTube's action bar.
 * The button appears next to Share, Save, etc. below the video.
 *
 * When clicked, it opens the YouTube Digest side panel.
 */
function isVisibleDigestHost(element) {
  if (!element || !element.isConnected) return false;

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

/**
 * Cheap "is our button still sitting somewhere usable" probe.
 *
 * Deliberately stops at the geometry check: the host we care about is the
 * native button group, and YouTube's hidden responsive copies are 0x0. Reading
 * only the parent's rect keeps the typical reconciliation at one layout read.
 */
function isMountedInVisibleHost(button) {
  if (!button || !button.isConnected) return false;
  const host = button.parentElement;
  if (!host || !host.isConnected) return false;
  const rect = host.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * YouTube keeps hidden copies of its responsive action toolbar in the DOM.
 * querySelector() can return one of those 0x0 copies before the toolbar the
 * viewer can actually see, so inspect every candidate and resolve the native
 * button group inside the visible action row for the current video.
 */
function findDigestButtonHost() {
  const primaryActionRows = Array.from(
    document.querySelectorAll("ytd-watch-metadata #actions-inner"),
  );

  for (const actionRow of primaryActionRows) {
    if (!isVisibleDigestHost(actionRow)) continue;

    const visibleButtonGroup = Array.from(
      actionRow.querySelectorAll("#top-level-buttons-computed"),
    ).find(isVisibleDigestHost);
    if (visibleButtonGroup) return visibleButtonGroup;
  }

  const fallbackCandidates = Array.from(
    document.querySelectorAll(
      "ytd-watch-metadata #actions #top-level-buttons-computed, " +
        "ytd-watch-metadata #top-level-buttons-computed, " +
        "#primary #actions #top-level-buttons-computed",
    ),
  );

  return (
    fallbackCandidates.find(
      (candidate) =>
        isVisibleDigestHost(candidate) &&
        (candidate.closest("ytd-watch-metadata") ||
          candidate.closest("#primary")),
    ) || null
  );
}

function createDigestButton() {
  const digestButton = document.createElement("button");
  digestButton.id = "ytd-digest-button";
  digestButton.type = "button";
  digestButton.setAttribute("aria-label", "Open YouTube Digest");
  digestButton.innerHTML = `<span class="ytd-digest-label">Digest</span>`;

  // Style the button — rounded pill in our terracotta accent, sized to sit
  // comfortably among YouTube's native action buttons.
  digestButton.style.cssText = `
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 18px;
    height: 36px;
    border: none;
    border-radius: 18px;
    background: #c8674f;
    color: white;
    font-family: "Roboto", "Arial", sans-serif;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    margin-right: 8px;
    transition: background 0.2s, transform 0.1s;
    flex: 0 0 auto;
    align-self: center;
    width: max-content;
    min-width: max-content;
    max-width: max-content;
    white-space: nowrap;
  `;

  // Hover effects
  digestButton.addEventListener("mouseenter", () => {
    digestButton.style.background = "#b25742";
    digestButton.style.transform = "scale(1.02)";
  });

  digestButton.addEventListener("mouseleave", () => {
    digestButton.style.background = "#c8674f";
    digestButton.style.transform = "scale(1)";
  });

  // Click handler — open the side panel
  digestButton.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await openDigestPanel("YouTube Digest");
  });

  ytdDigestButton = digestButton;
  return digestButton;
}

/**
 * Reconciles the Digest button with YouTube's currently visible action row.
 * This is intentionally idempotent because YouTube rebuilds its watch page
 * during navigation and at responsive breakpoints.
 */
function injectDigestButton() {
  if (!window.location.pathname.includes("/watch")) {
    document
      .querySelectorAll("#ytd-digest-button")
      .forEach((button) => button.remove());
    ytdDigestButton = null;
    return false;
  }

  // Fast path for the common case: our button is still mounted inside a host
  // that has real geometry. Costs one getBoundingClientRect instead of the
  // full scan below (querySelectorAll + a rect + getComputedStyle per
  // candidate), which is what this function did on every DOM mutation burst.
  if (isMountedInVisibleHost(ytdDigestButton)) return true;

  const existingButtons = Array.from(
    document.querySelectorAll("#ytd-digest-button"),
  );

  const actionsContainer = findDigestButtonHost();
  if (!actionsContainer) {
    debugLog("[YouTube Digest Content] Visible actions container not found yet");
    return false;
  }

  let digestButton = existingButtons.find(
    (button) => button === ytdDigestButton,
  );

  if (!digestButton) {
    existingButtons.forEach((button) => button.remove());
    existingButtons.length = 0;
    digestButton = createDigestButton();
  }

  existingButtons.forEach((button) => {
    if (button !== digestButton) button.remove();
  });

  if (digestButton.parentElement !== actionsContainer) {
    // YouTube turns #actions-inner into a vertical flex column at narrow
    // breakpoints. A direct child there stretches into a full-width second
    // row, so keep Digest inside the native horizontal button group and
    // prepend it to preserve visibility when space is limited.
    actionsContainer.insertBefore(digestButton, actionsContainer.firstChild);
  }

  debugLog("[YouTube Digest Content] Digest button reconciled");
  return true;
}

/**
 * Opens the side panel for the current tab from a page button.
 *
 * Chrome only allows sidePanel.open() inside a user gesture, so the message
 * has to leave the content script immediately (no awaits before sending).
 * The click itself does NOT grant activeTab — that still needs one toolbar
 * icon click — so the panel UI is responsible for telling the user when audio
 * capture needs that extra invocation.
 */
async function openDigestPanel(label = "Digest") {
  debugLog(`[${label}] Digest button clicked`);
  try {
    const result = await chrome.runtime.sendMessage({ action: "openSidePanel" });
    debugLog(`[${label}] openSidePanel response:`, result);
    return result;
  } catch (err) {
    console.error(`[${label}] Failed to open side panel:`, err);
    return null;
  }
}

// ============================================================
// BILIBILI
// ============================================================

/**
 * B站 watch pages are single-page too, and the action toolbar is rebuilt on
 * every part (分P) switch. A 1s URL poll keeps the Digest button alive without
 * depending on B站's internal navigation events.
 */
function initBilibili() {
  biliLastHref = window.location.href;

  // 必须等 B站 自己完成 hydration 再动手。内容脚本在 document_idle 就开始跑，
  // 那时 B站 的 Vue 还在接管 SSR 出来的 DOM；此刻插入节点会被它当成自己的
  // 子节点去对比，进而把整块区域（UP 主头像 / 关注数 / 推荐封面）渲染坏。
  const start = () => injectBilibiliButtons();
  if (document.readyState === "complete") {
    setTimeout(start, 700);
  } else {
    window.addEventListener("load", () => setTimeout(start, 700), { once: true });
  }

  if (biliNavTimer) clearInterval(biliNavTimer);
  biliNavTimer = setInterval(() => {
    const hrefChanged = biliLastHref !== window.location.href;
    if (hrefChanged) biliLastHref = window.location.href;

    if (!hrefChanged) {
      // 没有站内跳转时只有两种情况要做事：按钮被页面清掉了（重建），或者
      // 首次注入还没成功（继续尝试）。其余情况只更新一次位置，省掉每秒一次的
      // querySelectorAll —— B站首页、搜索页也注入了这个脚本，那里无需任何工作。
      if (biliDigestButton && biliDigestButton.isConnected) {
        positionBilibiliButtons();
        return;
      }
      if (!biliDigestButton && !isBilibiliVideoPage()) return;
    }

    injectBilibiliButtons();
  }, 1000);

  if (!biliPositionListenersAdded) {
    // 播放器位置随滚动和窗口尺寸变化，用 rAF 合并后在下一帧统一写入，
    // 避免滚动时每来一个事件就触发一次 layout 读取。
    window.addEventListener("scroll", scheduleBilibiliButtonPosition, {
      passive: true,
    });
    window.addEventListener("resize", scheduleBilibiliButtonPosition);
    // 浮层的显隐跟着指针走：鼠标在画面上才出现。
    document.addEventListener("mousemove", handleBilibiliPointerMove, {
      passive: true,
    });
    // 鼠标移出浏览器窗口时不会再收到 mousemove，这里补一次收起。
    document.addEventListener("mouseleave", () => {
      biliPointerInside = false;
      scheduleBilibiliActionsHide(120);
    });
    biliPositionListenersAdded = true;
  }

  if (!biliFullscreenListenerAdded) {
    document.addEventListener("fullscreenchange", () => {
      const bar = document.getElementById(BILIBILI_ACTIONS_ID);
      if (!bar) return;
      if (document.fullscreenElement) {
        setBilibiliActionsVisible(false);
        bar.style.display = "none";
        return;
      }
      // 退出全屏后播放器尺寸变了，缓存的 layout 必须先失效再重算。
      biliLastButtonLayout = "";
      bar.style.display = "";
      positionBilibiliButtons();
    });
    biliFullscreenListenerAdded = true;
  }
}

function isBilibiliVideoPage() {
  return /\/video\/(BV[0-9A-Za-z]+|av\d+)/.test(window.location.pathname);
}

/**
 * B站 的两个按钮共用一条浮层。它们挂在 <body> 上，不进入 B站 的任何容器：
 * 播放页是 Vue 接管 SSR 结果的，往工具栏这类受控容器里插一个外来子节点，
 * 会让它的 patch 逻辑对不上节点列表，表现为 UP 主头像、关注数、右侧推荐
 * 封面都不渲染（关掉扩展就恢复）。所以位置改成由 JS 追踪播放器 rect，
 * 视觉上贴着播放器右上角，DOM 上永远在 body 末尾。
 */
const BILIBILI_ACTIONS_ID = "ytd-bilibili-actions";

function bilibiliButtonStyle() {
  return `
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    height: 38px;
    padding: 0 18px;
    border: none;
    border-radius: 19px;
    background: #c8674f;
    color: #fff;
    font-family: "PingFang SC", "Microsoft YaHei", "Roboto", sans-serif;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
    transition: background 0.2s, transform 0.1s;
  `;
}

function attachBilibiliButtonHover(button) {
  button.addEventListener("mouseenter", () => {
    button.style.background = "#b25742";
    // 指针从播放器移到按钮上时，播放器会先发 pointerleave；这里把延迟隐藏取消，
    // 否则手还没点到按钮，浮层就淡出了。
    setBilibiliActionsVisible(true);
  });
  button.addEventListener("mouseleave", () => {
    button.style.background = "#c8674f";
    scheduleBilibiliActionsHide();
  });
}

function createBilibiliActionsBar() {
  const bar = document.createElement("div");
  bar.id = BILIBILI_ACTIONS_ID;
  bar.style.cssText = `
    position: fixed;
    top: 0;
    right: 0;
    z-index: 2147483000;
    display: flex;
    align-items: center;
    gap: ${BILIBILI_BUTTON_GAP}px;
    pointer-events: none;
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.16s ease;
  `;
  return bar;
}

/**
 * 浮层默认隐藏，只在鼠标进入播放器（或停在按钮上）时浮现。
 *
 * 之前它常驻在画面右上角，虽然位置正确，但一整块按钮压在视频上非常碍眼。
 * 现在跟 YouTube 的 Note 按钮行为一致：指针进播放器才出现，离开后淡出。
 * 指针进入播放器时先取消未执行的隐藏，避免"移向按钮"这一下被判定为离开。
 */
function setBilibiliActionsVisible(visible) {
  const bar = document.getElementById(BILIBILI_ACTIONS_ID);
  if (!bar) return;
  if (visible && biliActionsHideTimer) {
    clearTimeout(biliActionsHideTimer);
    biliActionsHideTimer = null;
  }
  if (biliActionsVisible === visible) return;
  biliActionsVisible = visible;

  if (visible) {
    if (biliActionsVisibilityTimer) {
      clearTimeout(biliActionsVisibilityTimer);
      biliActionsVisibilityTimer = null;
    }
    bar.style.visibility = "visible";
    // 先可见再改 opacity，否则隐藏状态下的过渡不会跑，会直接"跳"出来。
    requestAnimationFrame(() => {
      if (biliActionsVisible) bar.style.opacity = "1";
    });
    return;
  }

  bar.style.opacity = "0";
  // 淡出结束后才真正隐藏，这样按钮也不会留在 Tab 焦点顺序里。
  biliActionsVisibilityTimer = setTimeout(() => {
    biliActionsVisibilityTimer = null;
    if (!biliActionsVisible) bar.style.visibility = "hidden";
  }, 180);
}

function scheduleBilibiliActionsHide(delay = 260) {
  if (biliActionsHideTimer) clearTimeout(biliActionsHideTimer);
  biliActionsHideTimer = setTimeout(() => {
    biliActionsHideTimer = null;
    // 指针还停在画面上就不收。各类延迟收起（按钮 mouseleave、首次露面的
    // 计时器）都可能在手还停在画面上时到点，统一在这里兜一次。
    if (biliPointerInside) return;
    setBilibiliActionsVisible(false);
  }, delay);
}

/**
 * 用指针坐标判断"在不在画面上"，而不是监听播放器的 mouseenter。
 *
 * 原因是 mouseenter 只在"从外部进入"时才发：页面刷新后鼠标往往原地不动地
 * 停在视频区域，此时既没有 enter 也没有 leave，按钮就再也不会浮现。改成在
 * document 上被动监听 mousemove、每帧最多判定一次坐标，刷新后动一下鼠标即可。
 * （B站 播放器会对拖进度条做 pointer capture，pointerleave 也会丢，这里一并避开。）
 */
function handleBilibiliPointerMove(event) {
  if (biliPointerRaf) return;
  const x = event.clientX;
  const y = event.clientY;
  biliPointerRaf = requestAnimationFrame(() => {
    biliPointerRaf = null;
    const player = findBilibiliPlayer();
    if (!player) return;
    const rect = player.getBoundingClientRect();
    const inside =
      x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    if (inside === biliPointerInside) return;
    biliPointerInside = inside;
    if (inside) setBilibiliActionsVisible(true);
    else scheduleBilibiliActionsHide();
  });
}

/**
 * Builds the B站 Digest button.
 */
function createBilibiliDigestButton() {
  const button = document.createElement("button");
  button.id = "ytd-digest-button";
  button.type = "button";
  button.setAttribute("aria-label", "Open Digest side panel");
  button.textContent = "Digest";
  button.style.cssText = `${bilibiliButtonStyle()} pointer-events: auto;`;
  attachBilibiliButtonHover(button);
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void openDigestPanel("Bilibili Digest");
  });
  return button;
}

/**
 * Builds the B站 Note button. It saves the subtitle line at the current
 * playback position, same as the YouTube overlay.
 */
function createBilibiliNoteButton() {
  const button = document.createElement("button");
  button.id = "ytd-bili-note-button";
  button.type = "button";
  button.setAttribute("aria-label", "Save a note at the current position");
  button.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
    </svg>
    <span>Note</span>
  `;
  button.style.cssText = `${bilibiliButtonStyle()} background: #3d3a36; pointer-events: auto;`;
  button.addEventListener("mouseenter", () => {
    button.style.background = "#2c2a27";
    setBilibiliActionsVisible(true);
  });
  button.addEventListener("mouseleave", () => {
    button.style.background = "#3d3a36";
    scheduleBilibiliActionsHide();
  });
  button.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await saveCurrentNote(button);
  });
  return button;
}

function findBilibiliPlayer() {
  return (
    document.querySelector("#bilibili-player") ||
    document.querySelector(".bpx-player-container") ||
    document.querySelector("#playerWrap")
  );
}

/**
 * Keeps the action bar pinned to the player's top-right corner. Runs on
 * scroll / resize (rAF-merged) and once per second from the nav poll, so a
 * player that resizes or swaps parts is followed without a MutationObserver.
 */
function positionBilibiliButtons() {
  const bar = document.getElementById(BILIBILI_ACTIONS_ID);
  if (!bar) return;

  const player = findBilibiliPlayer();
  if (!player) return;

  const rect = player.getBoundingClientRect();
  const inView =
    rect.width > 240 &&
    rect.bottom > 80 &&
    rect.top < window.innerHeight - 80;

  // 播放器滚出视口或全屏时整条浮层收起；回到视口后只有在指针仍停在画面上
  // 才重新浮现——否则滚动一屏就会把按钮"甩"回常驻状态。
  if (!inView) setBilibiliActionsVisible(false);
  else if (biliPointerInside) setBilibiliActionsVisible(true);

  const top = Math.max(12, Math.round(rect.top) + 16);
  const right = Math.max(12, Math.round(window.innerWidth - rect.right) + 16);
  const layout = `${inView ? 1 : 0}:${top}:${right}`;
  if (layout === biliLastButtonLayout) return;
  biliLastButtonLayout = layout;

  bar.style.top = `${top}px`;
  bar.style.right = `${right}px`;
  bar.style.display = inView ? "flex" : "none";
}

function scheduleBilibiliButtonPosition() {
  if (biliButtonPositionRaf) return;
  biliButtonPositionRaf = requestAnimationFrame(() => {
    biliButtonPositionRaf = null;
    positionBilibiliButtons();
  });
}

function removeBilibiliButtons() {
  document.getElementById(BILIBILI_ACTIONS_ID)?.remove();
  document
    .querySelectorAll("#ytd-digest-button, #ytd-bili-note-button")
    .forEach((node) => node.remove());
  biliDigestButton = null;
  biliNoteButton = null;
  biliLastButtonLayout = "";
  // 节点没了，可见状态必须归零，否则重新注入的新浮层会因为"状态没变"而
  // 一直停在 opacity:0。
  if (biliActionsHideTimer) {
    clearTimeout(biliActionsHideTimer);
    biliActionsHideTimer = null;
  }
  if (biliActionsVisibilityTimer) {
    clearTimeout(biliActionsVisibilityTimer);
    biliActionsVisibilityTimer = null;
  }
  biliActionsVisible = false;
  biliPointerInside = false;
}

/**
 * 每个视频第一次挂上浮层时，让它浮现 2.6 秒再淡出。
 * 纯 hover 触发的话，第一次用的人根本不知道这里有按钮；露一次面成本很低。
 */
function peekBilibiliActions() {
  const href = window.location.href.split("#")[0];
  if (biliPeekedHref === href) return;
  biliPeekedHref = href;
  setBilibiliActionsVisible(true);
  scheduleBilibiliActionsHide(2600);
}

function injectBilibiliButtons() {
  if (!isBilibiliVideoPage()) {
    removeBilibiliButtons();
    return false;
  }

  const bar = document.getElementById(BILIBILI_ACTIONS_ID);
  if (
    bar &&
    biliDigestButton?.isConnected &&
    biliNoteButton?.isConnected &&
    bar.contains(biliDigestButton) &&
    bar.contains(biliNoteButton)
  ) {
    // 顺手清掉旧版本残留在页面里的按钮（旧版本直接挂在 body 上）。
    document
      .querySelectorAll("#ytd-digest-button, #ytd-bili-note-button")
      .forEach((node) => {
        if (!bar.contains(node)) node.remove();
      });
    positionBilibiliButtons();
    return true;
  }

  removeBilibiliButtons();

  const fresh = createBilibiliActionsBar();
  biliDigestButton = createBilibiliDigestButton();
  biliNoteButton = createBilibiliNoteButton();
  fresh.append(biliDigestButton, biliNoteButton);
  document.body.appendChild(fresh);
  positionBilibiliButtons();
  peekBilibiliActions();
  return true;
}

/**
 * Debounced reconcile. YouTube mutates its watch page continuously (time
 * label, view count, comments), so this is rate limited as well as debounced:
 * a steady mutation stream can no longer turn into a reconcile every 80ms.
 */
function scheduleDigestButtonReconciliation(delay = 80) {
  if (digestButtonReconcileTimer) return; // one pending reconcile is enough

  const sinceLast = Date.now() - digestButtonLastReconcileAt;
  const wait = Math.max(delay, DIGEST_RECONCILE_MIN_GAP_MS - sinceLast);

  digestButtonReconcileTimer = setTimeout(() => {
    digestButtonReconcileTimer = null;
    digestButtonLastReconcileAt = Date.now();
    injectDigestButton();
  }, wait);
}

function setupDigestButtonResizeListener() {
  if (digestButtonResizeListenerAdded) return;

  window.addEventListener("resize", () => {
    scheduleDigestButtonReconciliation(120);
  });
  digestButtonResizeListenerAdded = true;
}

/**
 * Sets up a MutationObserver to watch for YouTube's dynamic content changes.
 * When the action buttons container appears (after navigation), we inject our button.
 */
function setupButtonObserver() {
  if (digestButtonObserver) return;

  digestButtonObserver = new MutationObserver(() => {
    // Check if we need to inject the buttons
    if (window.location.pathname.includes("/watch")) {
      scheduleDigestButtonReconciliation();
      if (!ytdNoteButton || !ytdNoteButton.isConnected) {
        tryInjectNoteButton();
      }
    }
  });

  // Watch the entire body for changes (YouTube rebuilds large chunks of the DOM)
  digestButtonObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// ============================================================
// NOTE BUTTON (Overlay on Video Player)
// ============================================================

/**
 * Injects a "Note" button overlay on top of the YouTube video player.
 * The button appears when the mouse enters or moves over the player and hides
 * after the cursor stays still for more than 2 seconds or leaves the player.
 */
function injectNoteButton() {
  // Don't inject if we're not on a video page
  if (!window.location.pathname.includes("/watch")) return;

  // Don't inject if button already exists and is properly tracked.
  // If a stale button exists (e.g., from a previous content-script instance),
  // remove it and re-inject so event listeners are attached to the live one.
  const existingButton = document.getElementById("ytd-note-button");
  if (existingButton) {
    if (ytdNoteButton === existingButton && existingButton.isConnected) {
      return; // already injected and connected
    }
    existingButton.remove();
  }

  // Find the video player container. YouTube rebuilds this dynamically, so
  // we try the most common selectors.
  const playerContainer = document.querySelector(
    "#movie_player.html5-video-player, " +
      "#movie_player, " +
      ".html5-video-player",
  );

  if (!playerContainer) {
    debugLog(
      "[YouTube Digest Content] Player container not found yet, will retry",
    );
    return;
  }

  // Ensure the player container has relative positioning for absolute children
  if (
    window.getComputedStyle(playerContainer).position === "static" ||
    !playerContainer.style.position
  ) {
    playerContainer.style.position = "relative";
  }

  debugLog("[YouTube Digest Content] Injecting note button");

  // Create the note button — a soft rounded pill that floats over the player
  const noteButton = document.createElement("button");
  noteButton.id = "ytd-note-button";
  noteButton.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="margin-right: 7px;">
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
    </svg>
    <span>Note</span>
  `;

  // Soft rounded pill in the terracotta accent, with a gentle shadow.
  // Start hidden; visibility is controlled by mouse activity.
  noteButton.style.cssText = `
    position: absolute;
    top: 16px;
    right: 16px;
    z-index: 9999;
    display: flex;
    align-items: center;
    padding: 9px 16px;
    background: #c8674f;
    color: white;
    border: none;
    border-radius: 999px;
    font-family: system-ui, -apple-system, "Roboto", sans-serif;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.2px;
    cursor: pointer;
    transition: opacity 0.18s ease, transform 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
    opacity: 0;
    pointer-events: none;
    box-shadow: 0 4px 14px rgba(0,0,0,0.3);
  `;

  ytdNoteButton = noteButton;
  ytdNoteButtonVisible = false;

  // Show button when mouse enters or moves over the player.
  // Hide after 2 seconds of idle or when the mouse leaves.
  playerContainer.addEventListener("mouseenter", () => {
    showNoteButton();
    resetNoteButtonTimer();
  });

  playerContainer.addEventListener("mousemove", () => {
    showNoteButton();
    resetNoteButtonTimer();
  });

  playerContainer.addEventListener("mouseleave", () => {
    clearTimeout(ytdNoteButtonTimer);
    ytdNoteButtonTimer = null;
    hideNoteButton();
  });

  // Hover effect — lift slightly
  noteButton.addEventListener("mouseenter", () => {
    noteButton.style.background = "#b25742";
    noteButton.style.boxShadow = "0 6px 18px rgba(0,0,0,0.35)";
    noteButton.style.transform = "translateY(-1px)";
  });

  noteButton.addEventListener("mouseleave", () => {
    noteButton.style.background = "#c8674f";
    noteButton.style.boxShadow = "0 4px 14px rgba(0,0,0,0.3)";
    noteButton.style.transform = "translateY(0)";
  });

  // Click handler — save the current moment as a note
  noteButton.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await saveCurrentNote();
  });

  playerContainer.appendChild(noteButton);

  debugLog("[YouTube Digest Content] Note button injected");
}

function showNoteButton() {
  if (!ytdNoteButton || ytdNoteButtonVisible) return;
  ytdNoteButtonVisible = true;
  ytdNoteButton.style.opacity = "1";
  ytdNoteButton.style.pointerEvents = "auto";
}

function hideNoteButton() {
  if (!ytdNoteButton || !ytdNoteButtonVisible) return;
  ytdNoteButtonVisible = false;
  ytdNoteButton.style.opacity = "0";
  ytdNoteButton.style.pointerEvents = "none";
}

function resetNoteButtonTimer() {
  clearTimeout(ytdNoteButtonTimer);
  ytdNoteButtonTimer = setTimeout(() => {
    hideNoteButton();
  }, 2000);
}

function isNoteShortcutPage() {
  if (YTD_PAGE_SITE === "bilibili") return isBilibiliVideoPage();
  return window.location.pathname.includes("/watch");
}

/**
 * Handles the "n" keyboard shortcut for saving a note.
 * Only triggers on a video page and when the user is not typing
 * in an input field.
 */
function handleNoteKeyboardShortcut(e) {
  if (!isNoteShortcutPage()) return;
  if (e.key !== "n" && e.key !== "N") return;

  // Ignore if the user is typing in an input/textarea/contenteditable
  const active = document.activeElement;
  if (
    active &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.isContentEditable)
  ) {
    return;
  }

  // Prevent the site's own "n" shortcut (e.g. next video in a playlist)
  e.preventDefault();
  e.stopPropagation();

  if (YTD_PAGE_SITE === "bilibili") {
    // B站 的浮层是 hover 才出现的，快捷键不该依赖它是否可见。
    saveCurrentNote(biliNoteButton);
    return;
  }

  // Show brief visual feedback on the button, then save
  showNoteButton();
  resetNoteButtonTimer();
  saveCurrentNote();
}

/**
 * Captures the current timestamp and saves it as a note.
 */
async function saveCurrentNote(buttonEl) {
  debugLog("[YouTube Digest] Saving note");

  const video = document.querySelector(
    "video.html5-main-video, #bilibili-player video, .bpx-player-container video, video",
  );
  if (!video) {
    console.error("[YouTube Digest] No video element found");
    return;
  }

  // Go back 3 seconds to capture what was just said (user reacts after hearing it)
  const currentTime = Math.max(0, Math.floor(video.currentTime) - 3);
  const videoInfo = extractVideoInfo();
  const videoId = YTD_SUBTITLE_SOURCES?.extractVideoId
    ? YTD_SUBTITLE_SOURCES.extractVideoId(window.location.href)
    : new URLSearchParams(window.location.search).get("v");

  const noteButton = buttonEl || ytdNoteButton || biliNoteButton;
  const originalContent = noteButton ? noteButton.innerHTML : "";
  const restingBackground = noteButton
    ? noteButton.style.background || "#c8674f"
    : "#c8674f";

  if (noteButton) {
    noteButton.innerHTML =
      '<span style="letter-spacing: 0.2px;">SAVING...</span>';
    noteButton.style.pointerEvents = "none";
  }

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId: videoId,
      timestamp: currentTime,
      videoTitle: videoInfo.title,
      channelName: videoInfo.channelName,
      site: YTD_PAGE_SITE,
      pageUrl: window.location.href,
    });

    if (result.success) {
      if (noteButton) {
        noteButton.innerHTML =
          '<span style="letter-spacing: 0.2px;">SAVED</span>';
        noteButton.style.background = "#7c8b6f";
      }
      showNoteSavedToast(result.note);
    } else {
      if (noteButton) {
        noteButton.innerHTML =
          '<span style="letter-spacing: 0.2px;">ERROR</span>';
      }
      showNoteFailureToast(
        result.message ||
          "找不到这一时刻对应的字幕。请先在侧边栏生成一次 Digest 再试。",
      );
      console.error("[YouTube Digest] Save note error:", result.error);
    }
  } catch (err) {
    if (noteButton) {
      noteButton.innerHTML =
        '<span style="letter-spacing: 0.2px;">ERROR</span>';
    }
    showNoteFailureToast(
      "扩展后台没有响应。请刷新这个页面后重试。",
    );
    console.error("[YouTube Digest] Save note exception:", err);
  }

  setTimeout(() => {
    if (noteButton) {
      noteButton.innerHTML = originalContent;
      noteButton.style.background = restingBackground;
      noteButton.style.pointerEvents = "auto";
    }
  }, 2000);
}

/**
 * Shows a toast notification when a note is saved.
 */
function ensureNoteToastStyle() {
  if (document.getElementById("ytd-note-toast-style")) return;
  const style = document.createElement("style");
  style.id = "ytd-note-toast-style";
  style.textContent = `
    @keyframes ytdSlideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
  `;
  document.head.appendChild(style);
}

function createNoteToast() {
  document.getElementById("ytd-note-toast")?.remove();
  ensureNoteToastStyle();

  const toast = document.createElement("div");
  toast.id = "ytd-note-toast";
  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 999999;
    background: #ffffff;
    border: 1px solid #ece5d9;
    border-radius: 14px;
    padding: 16px 20px;
    max-width: 350px;
    box-shadow: 0 12px 32px rgba(50, 42, 32, 0.2);
    font-family: system-ui, -apple-system, "Roboto", sans-serif;
    animation: ytdSlideIn 0.3s ease;
  `;
  return toast;
}

function dismissNoteToastLater(toast, ms) {
  setTimeout(() => {
    toast.style.animation = "ytdSlideIn 0.3s ease reverse";
    setTimeout(() => toast.remove(), 300);
  }, ms);
}

function showNoteSavedToast(note) {
  const toast = createNoteToast();
  toast.innerHTML = `
    <div style="font-weight: 700; margin-bottom: 6px; color: #c8674f;">Note saved</div>
    <div style="font-size: 12px; color: #6b6258; margin-bottom: 8px;">${escapeHtmlForContent(note.timestamp)} — ${escapeHtmlForContent(note.videoTitle)}</div>
    <div style="font-size: 13px; line-height: 1.55; color: #2e2a24;">"${escapeHtmlForContent(note.text)}"</div>
    <div style="margin-top: 10px; font-size: 11px;">
      <a href="${escapeHtmlForContent(note.timestampedUrl)}" style="color: #c8674f; font-weight: 600; text-decoration: none;">Copy link</a>
    </div>
  `;

  toast.querySelector("a").addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(note.timestampedUrl);
      e.target.textContent = "Copied";
    } catch (err) {
      console.error("Copy failed:", err);
    }
  });

  document.body.appendChild(toast);
  dismissNoteToastLater(toast, 5000);
}

/**
 * The button can only flash "ERROR" for two seconds, which leaves the user
 * guessing. This explains why the note was not saved.
 */
function showNoteFailureToast(message) {
  const toast = createNoteToast();
  toast.innerHTML = `
    <div style="font-weight: 700; margin-bottom: 6px; color: #b23b2c;">Note not saved</div>
    <div style="font-size: 13px; line-height: 1.55; color: #2e2a24;">${escapeHtmlForContent(message || "Unknown error.")}</div>
  `;
  document.body.appendChild(toast);
  dismissNoteToastLater(toast, 6000);
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Reads the video title, channel name, and description directly from YouTube's page.
 * These are just sitting in the HTML — we grab them from the DOM elements.
 */
function extractVideoInfo() {
  if (YTD_PAGE_SITE === "bilibili") return extractBilibiliVideoInfo();

  // The video title is in an h1 element inside the #title container
  const titleElement = document.querySelector(
    "h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string",
  );

  // The channel name is in the channel info section
  const channelElement = document.querySelector(
    "#channel-name yt-formatted-string a, ytd-channel-name yt-formatted-string a",
  );

  // Video duration from the video element
  const videoElement = document.querySelector("video.html5-main-video");

  // Video description — YouTube has this in a few possible places
  const descriptionElement = document.querySelector(
    "#description-inner, " +
      "ytd-watch-metadata #description yt-attributed-string, " +
      "#description yt-formatted-string, " +
      "ytd-expander#description yt-attributed-string",
  );

  return {
    title: titleElement?.textContent?.trim() || "",
    channelName: channelElement?.textContent?.trim() || "",
    duration: videoElement?.duration || 0,
    description: descriptionElement?.textContent?.trim() || "",
  };
}

/**
 * B站 metadata comes from the watch page DOM: the title lives in
 * #viewbox_report, the uploader in the up-info card. Selectors are tried from
 * newest to oldest layout because B站 reshuffles them between A/B tests.
 */
function extractBilibiliVideoInfo() {
  const pick = (selectors) => {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const text = node?.textContent?.trim();
      if (text) return text;
    }
    return "";
  };

  const video = document.querySelector("#bilibili-player video, video");

  return {
    title: pick([
      "h1.video-title",
      "#viewbox_report h1",
      ".video-title",
      ".video-info-title",
    ]),
    channelName: pick([
      ".up-name",
      ".up-info--name a",
      ".up-info--name",
      "#v_upinfo .up-name",
      ".up-detail-top .up-name",
    ]),
    duration: video?.duration || 0,
    description: pick([
      ".desc-info-text",
      "#v_desc .desc-info-text",
      ".video-desc",
      ".desc-info",
    ]),
  };
}

/**
 * 站点专属字幕元信息提取。
 * 返回当前站点、URL、以及用于获取平台原生字幕的关键标识。background 据此
 * 决定走哪条免费字幕通道。
 */
function extractPlatformSubtitleMeta() {
  const url = window.location.href;
  const site = YTD_SUBTITLE_SOURCES?.detectSite
    ? YTD_SUBTITLE_SOURCES.detectSite(url)
    : "generic";
  const result = { site, url, videoId: null, bilibili: null };

  if (site === "bilibili") {
    result.videoId = YTD_SUBTITLE_SOURCES.extractVideoId(url);
    result.bilibili = extractBilibiliCid();
  } else if (site === "youtube") {
    result.videoId = YTD_SUBTITLE_SOURCES.extractVideoId(url);
  }
  return result;
}

// ============================================================
// YOUTUBE FULL CAPTIONS (pot TOKEN)
// ============================================================

/**
 * 当前 YouTube 视频 id。
 */
function currentYoutubeVideoId() {
  try {
    return new URL(window.location.href).searchParams.get("v") || "";
  } catch (_e) {
    return "";
  }
}

/**
 * 取一份"还能用"的 pot URL。
 * 过期时间给 5 分钟：签名里的 expire 通常远大于这个值，但播放器换 P 或长时间
 * 暂停后 token 会失效，保守一点直接重拿更稳。
 */
function usableCaptionPotUrl() {
  if (!ytdCaptionPotUrl) return "";
  if (Date.now() - ytdCaptionPotAt > 5 * 60 * 1000) return "";
  const videoId = currentYoutubeVideoId();
  try {
    const u = new URL(ytdCaptionPotUrl);
    if (videoId && u.searchParams.get("v") !== videoId) return "";
  } catch (_e) {
    return "";
  }
  return ytdCaptionPotUrl;
}

/**
 * 等待 MAIN world 钩子送来新的 pot URL。
 */
function waitForCaptionPotUrl(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (url) => {
      if (done) return;
      done = true;
      resolve(url || "");
    };
    const timer = setTimeout(() => finish(""), timeoutMs);
    ytdCaptionPotWaiters.push((url) => {
      clearTimeout(timer);
      finish(url);
    });
  });
}

/**
 * 主动问一次 MAIN world：它可能在我们启动前就抓到过 URL。
 */
function pullCaptionPotUrl() {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    let done = false;
    const onMessage = (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== "ytd-caption-pot") return;
      if (data.type !== "url" || data.id !== id) return;
      done = true;
      window.removeEventListener("message", onMessage);
      resolve(data.url || "");
    };
    window.addEventListener("message", onMessage);
    window.postMessage({ source: "ytd-caption-pot", type: "get", id }, "*");
    setTimeout(() => {
      if (done) return;
      window.removeEventListener("message", onMessage);
      resolve("");
    }, 1200);
  });
}

/**
 * 让播放器去请求一次字幕文件——它会自动带上 pot。
 *
 * 返回 { kicked, restore }：`restore` 表示字幕开关是被我们打开的，抓完要还原；
 * 原本就开着的情况不能直接 return，否则播放器不会重新请求，钩子又错过首次请求
 * 时整条 pot 通道永远拿不到 URL（表现为"没有字幕、请开 Whisper"）。
 */
function kickCaptionRequest() {
  const button = document.querySelector(".ytp-subtitles-button");
  if (!button) {
    const player = document.getElementById("movie_player");
    try {
      player?.setOption?.("captions", "track", { languageCode: "zh" });
    } catch (_e) {
      /* noop */
    }
    return { kicked: false, restore: false };
  }
  if (button.getAttribute("aria-pressed") === "true") {
    // 关掉再打开，逼播放器重新拉一次 timedtext（带 pot）。
    try {
      button.click();
      setTimeout(() => {
        try {
          button.click();
        } catch (_e) {
          /* noop */
        }
      }, 350);
    } catch (_e) {
      /* noop */
    }
    // 状态回到用户原本的设置，不需要再还原。
    return { kicked: true, restore: false };
  }
  button.click();
  return { kicked: true, restore: true };
}

function restoreCaptionState(wasOurs) {
  if (!wasOurs) return;
  const button = document.querySelector(".ytp-subtitles-button");
  if (button && button.getAttribute("aria-pressed") === "true") {
    try {
      button.click();
    } catch (_e) {
      /* noop */
    }
  }
}

/**
 * 从页面的 ytInitialData 里找出"显示转录文字"面板的 params。
 * getTranscriptEndpoint 挂在 engagementPanel 上，位置随页面版本变化，所以
 * 这里做一次有上限的深度搜索，比写死路径更耐用。
 * @returns {string}
 */
function findTranscriptParams(root, limit = 20000) {
  const seen = new Set();
  const stack = [root];
  let visited = 0;
  while (stack.length && visited < limit) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    visited += 1;
    const endpoint = node.getTranscriptEndpoint;
    if (endpoint && typeof endpoint.params === "string" && endpoint.params) {
      return endpoint.params;
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return "";
}

/** 收集 get_transcript 返回的 transcriptSegmentRenderer。 */
function collectTranscriptSegments(root, out = [], limit = 40000) {
  const seen = new Set();
  const stack = [root];
  let visited = 0;
  while (stack.length && visited < limit) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    visited += 1;
    if (typeof node.startMs === "string" && node.snippet) {
      out.push(node);
      continue;
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return out;
}

/**
 * 读取 YouTube innertube 需要的上下文（visitorData / 客户端版本 / 语言）。
 */
function getInnertubeContext() {
  const cfg = window.ytcfg;
  const read = (key, fallback) => {
    try {
      if (cfg && typeof cfg.get === "function") {
        const value = cfg.get(key);
        if (value) return value;
      }
      if (cfg && cfg.data_ && cfg.data_[key]) return cfg.data_[key];
    } catch (_e) {
      /* noop */
    }
    return fallback;
  };
  return {
    visitorData: read("VISITOR_DATA", ""),
    clientVersion: read("INNERTUBE_CLIENT_VERSION", "2.20240101.00.00"),
    hl: read("HL", "en"),
    gl: read("GL", "US"),
  };
}

/**
 * 调 YouTube 网页版"显示转录文字"用的 inner API 取字幕。
 *
 * 这条路不需要 pot（所以不受"扩展更新后旧页面拿不到 pot"影响），只要页面还
 * 在登录态里。它是 pot 通道全部失败后的最后一道原生字幕兜底，返回 json3 文本
 * 以复用 background 既有的解析。
 *
 * @returns {Promise<{success:boolean, text?:string, reason?:string}>}
 */
async function fetchYoutubeTranscriptInner(videoId) {
  try {
    if (!videoId) return { success: false, reason: "NO_VIDEO_ID" };
    const ctx = getInnertubeContext();
    const context = {
      client: {
        clientName: "WEB",
        clientVersion: ctx.clientVersion,
        hl: ctx.hl,
        gl: ctx.gl,
      },
    };
    if (ctx.visitorData) context.client.visitorData = ctx.visitorData;

    const headers = {
      "Content-Type": "application/json",
      "X-Youtube-Client-Name": "1",
      "X-Youtube-Client-Version": ctx.clientVersion,
    };
    // 带上 visitorData，未登录会话也能拿到同一份转录。
    if (ctx.visitorData) headers["X-Goog-Visitor-Id"] = ctx.visitorData;

    let params = findTranscriptParams(window.ytInitialData);
    if (!params) {
      // 转录面板的 params 不一定在首屏数据里，用 next 接口补一次。
      const nextResp = await fetch("/youtubei/v1/next?prettyPrint=false", {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({ context, videoId }),
      });
      if (!nextResp.ok) return { success: false, reason: `NEXT_HTTP_${nextResp.status}` };
      params = findTranscriptParams(await nextResp.json());
    }
    if (!params) return { success: false, reason: "NO_TRANSCRIPT_PARAMS" };

    const resp = await fetch("/youtubei/v1/get_transcript?prettyPrint=false", {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ context, params }),
    });
    if (!resp.ok) return { success: false, reason: `TRANSCRIPT_HTTP_${resp.status}` };
    const data = await resp.json();

    const segments = collectTranscriptSegments(data).sort(
      (a, b) => Number(a.startMs) - Number(b.startMs),
    );
    const events = [];
    for (const seg of segments) {
      const runs = seg.snippet?.runs || [];
      const text = runs
        .map((r) => (r && r.text) || "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (text) events.push({ tStartMs: Number(seg.startMs) || 0, segs: [{ utf8: text }] });
    }
    if (!events.length) return { success: false, reason: "NO_TRANSCRIPT_EVENTS" };
    return { success: true, text: JSON.stringify({ events }), lang: "" };
  } catch (e) {
    return { success: false, reason: "TRANSCRIPT_API_FAILED" };
  }
}

/**
 * 选出最合适的目标语种：优先中文，其次是轨道列表里的第一个。
 */
function pickCaptionLang(currentLang, trackLangs) {
  const langs = Array.isArray(trackLangs) ? trackLangs.filter(Boolean) : [];
  const chinese = langs.find((l) => /^zh(-|$)/i.test(l));
  if (chinese) return chinese;
  if (currentLang) return currentLang;
  return langs[0] || "";
}

/**
 * 取 YouTube 全量字幕文本（json3）。
 *
 * 关键点：直接请求 captionTracks 的 baseUrl 会得到空的 200（缺 pot）。这里改用
 * 播放器自己请求过的 URL —— 它带 pot —— 只把 lang 改成想要的语种、去掉 tlang。
 * 签名参数 sparams 不含 lang/tlang，所以改写不会被拒绝。
 *
 * 返回 { success, text, lang, reason }。
 */
async function fetchYoutubeCaptionText(trackLangs) {
  const videoId = currentYoutubeVideoId();
  let url = usableCaptionPotUrl();
  let restoreNeeded = false;
  if (!url) {
    const kick = kickCaptionRequest();
    restoreNeeded = kick.restore;
    url = await waitForCaptionPotUrl(5000);
    if (!url) url = await pullCaptionPotUrl();
    // 播放器偶尔会比点击慢一拍，再等一小会儿。
    if (!url) url = await waitForCaptionPotUrl(2000);
  }

  try {
    let potReason = "";
    if (url) {
      const viaPot = await fetchCaptionsFromPotUrl(url, trackLangs, videoId);
      if (viaPot.success) return viaPot;
      potReason = viaPot.reason || "POT_FAILED";
    }

    // pot 通道没成功（没拿到 URL、空响应、解析不出事件）：改用网页版
    // "显示转录文字"的 inner API。它不需要 pot，因此不受"扩展更新后旧页面
    // 错过播放器请求"影响。
    const inner = await fetchYoutubeTranscriptInner(videoId);
    if (inner.success) return inner;
    return { success: false, reason: inner.reason || potReason || "NO_POT_URL" };
  } finally {
    restoreCaptionState(restoreNeeded);
  }
}

/**
 * 用播放器签过名的 timedtext URL 取整条字幕轨（只改写 lang/fmt）。
 */
async function fetchCaptionsFromPotUrl(url, trackLangs, videoId) {
  try {
    const target = new URL(url);
    const lang = pickCaptionLang(target.searchParams.get("lang"), trackLangs);
    target.searchParams.set("fmt", "json3");
    // tlang 是"翻译成某语言"，保留会拿到翻译版甚至空结果，去掉才能拿到原轨。
    target.searchParams.delete("tlang");
    if (lang) target.searchParams.set("lang", lang);

    const resp = await fetch(target.toString(), { credentials: "include" });
    const text = await resp.text();

    // 空响应说明 pot 失效：把缓存清掉，让下次重新抓。
    if (!text || text.length < 40) {
      ytdCaptionPotUrl = "";
      ytdCaptionPotAt = 0;
      return { success: false, reason: "EMPTY", status: resp.status };
    }

    if (videoId) {
      try {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed.events) || !parsed.events.length) {
          return { success: false, reason: "NO_EVENTS" };
        }
      } catch (_e) {
        return { success: false, reason: "BAD_JSON" };
      }
    }
    return { success: true, text, lang };
  } catch (_e) {
    return { success: false, reason: "POT_FETCH_FAILED" };
  }
}

/**
 * 从 B站页面全局状态提取 cid（视频分 P 编号）与 bvid。
 * B站字幕接口依赖 cid；拿到后可请求 /x/player/wbi/v2 获取字幕 URL，
 * 全程免费。
 * 返回 { cid:number|null, bvid:string|null, ok:boolean }。
 */
function extractBilibiliCid() {
  try {
    // 优先读 __INITIAL_STATE__（B站播放页注入的全局数据）
    const state = window.__INITIAL_STATE__;
    if (state) {
      const videoData =
        state.videoData || state.videoInfo || state.aidAndCidMap || null;
      const aid =
        state.aid || videoData?.aid || state.videoData?.aid || null;
      const bvid =
        state.bvid || videoData?.bvid || state.videoData?.bvid || null;
      // cid 优先取当前分 P
      const cid =
        state.cid ||
        videoData?.cid ||
        state.videoData?.cid ||
        (Array.isArray(state.pages) && state.pages[0]?.cid) ||
        null;
      return { cid: cid ? Number(cid) : null, bvid: bvid || null, ok: !!cid };
    }
    // 兜底：从 DOM meta 或地址栏解析
    const m = window.location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    return { cid: null, bvid: m ? m[1] : null, ok: false };
  } catch (_e) {
    return { cid: null, bvid: null, ok: false };
  }
}

// ============================================================
// PROGRESS BAR KEY MOMENTS
// ============================================================

/**
 * Adds colored marker dots to YouTube's video progress bar
 * at the positions of key moments identified by the AI provider.
 *
 * How it works:
 * - YouTube's progress bar is a <div> element with a known class
 * - We calculate each moment's position as a percentage of total duration
 * - We inject small colored <div> elements at those positions
 * - The markers are absolutely positioned on top of the progress bar
 *
 * This is a "bonus feature" — it gives you a visual preview
 * of where the good stuff is in the video.
 */
function highlightKeyMoments(moments, videoDuration) {
  // Disabled: no timeline markers. Chapters live only in the side panel.
  return;
}

// ============================================================
// SEEK TO TIMESTAMP
// ============================================================

/**
 * Jumps the YouTube video to a specific timestamp (in seconds).
 * This is called when the user clicks a timestamp in the side panel.
 *
 * We simply set the video element's .currentTime property,
 * which is the standard HTML5 way to seek in a video.
 */
function seekToTimestamp(seconds) {
  const video = document.querySelector(
    "video.html5-main-video, #bilibili-player video, video",
  );
  if (!video) {
    console.error("[YouTube Digest Content] No video element found for seek");
    return;
  }

  debugLog("[YouTube Digest Content] Seeking to:", seconds);
  video.currentTime = seconds;
  // Also play the video if it's paused
  if (video.paused) {
    video.play().catch(() => {}); // Ignore autoplay errors
  }
}

function escapeHtmlForContent(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

// ============================================================
// PAGE NAVIGATION DETECTION
// ============================================================

/**
 * YouTube is a "Single Page Application" (SPA). This means when you
 * click on a new video, the page doesn't fully reload — YouTube
 * dynamically swaps out the content. So our content script stays alive
 * but needs to detect when the video changes.
 *
 * We watch for URL changes using the `yt-navigate-finish` event,
 * which YouTube fires after navigation completes. When that happens,
 * we clean up old markers and re-inject the button.
 */
document.addEventListener("yt-navigate-finish", () => {
  // Clean up old key moment markers when navigating to a new video
  const existingMarkers = document.querySelectorAll(".ytd-key-moment-markers");
  existingMarkers.forEach((m) => m.remove());

  // Remove old buttons (they will be re-injected for the new video)
  document
    .querySelectorAll("#ytd-digest-button")
    .forEach((button) => button.remove());
  ytdDigestButton = null;
  if (digestButtonReconcileTimer) {
    clearTimeout(digestButtonReconcileTimer);
    digestButtonReconcileTimer = null;
  }

  const existingNoteButton = document.getElementById("ytd-note-button");
  if (existingNoteButton) existingNoteButton.remove();

  // Reset note button state
  ytdNoteButton = null;
  clearTimeout(ytdNoteButtonTimer);
  ytdNoteButtonTimer = null;
  if (ytdNoteButtonRetryTimer) {
    clearInterval(ytdNoteButtonRetryTimer);
    ytdNoteButtonRetryTimer = null;
  }

  // Remove any toasts
  const existingToast = document.getElementById("ytd-note-toast");
  if (existingToast) existingToast.remove();

  // Re-inject buttons for the new video (with a small delay for YouTube to render)
  setTimeout(() => {
    scheduleDigestButtonReconciliation(0);
    tryInjectNoteButton();
  }, 500);
});
