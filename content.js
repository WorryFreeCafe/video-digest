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
let biliNavTimer = null;
let biliLastHref = "";
let biliFullscreenListenerAdded = false;

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
  // B站 has a different toolbar and no note button; keep it isolated so the
  // YouTube selectors never run there (they would retry forever and log noise).
  if (YTD_PAGE_SITE === "bilibili") {
    initBilibili();
    return;
  }

  // Register the global "n" keyboard shortcut once
  if (!ytdNoteKeyboardListenerAdded) {
    document.addEventListener("keydown", handleNoteKeyboardShortcut);
    ytdNoteKeyboardListenerAdded = true;
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
  const start = () => injectBilibiliDigestButton();
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
      // 首次注入还没成功（继续尝试）。其余情况直接返回，省掉每秒一次的
      // querySelectorAll —— B站首页、搜索页也注入了这个脚本，那里无需任何工作。
      if (biliDigestButton && biliDigestButton.isConnected) return;
      if (!biliDigestButton && !isBilibiliVideoPage()) return;
    }

    injectBilibiliDigestButton();
  }, 1000);

  if (!biliFullscreenListenerAdded) {
    document.addEventListener("fullscreenchange", () => {
      if (!biliDigestButton) return;
      biliDigestButton.style.display = document.fullscreenElement ? "none" : "";
    });
    biliFullscreenListenerAdded = true;
  }
}

function isBilibiliVideoPage() {
  return /\/video\/(BV[0-9A-Za-z]+|av\d+)/.test(window.location.pathname);
}

/**
 * Builds the B站 Digest button.
 *
 * 它永远是挂在 <body> 上的独立浮层，不进入 B站 的任何容器：
 * B站 的播放页是 Vue 接管 SSR 结果的，往播放页工具栏这类受控容器里
 * 插一个外来子节点，会让它的 patch 逻辑对不上节点列表，
 * 表现为 UP 主头像、关注数、右侧推荐封面都不渲染（关掉扩展就恢复）。
 */
function createBilibiliDigestButton() {
  const button = document.createElement("button");
  button.id = "ytd-digest-button";
  button.type = "button";
  button.setAttribute("aria-label", "Open Digest side panel");
  button.textContent = "Digest";
  button.style.cssText = `
    position: fixed;
    right: 24px;
    bottom: 96px;
    z-index: 2147483000;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 40px;
    padding: 0 20px;
    border: none;
    border-radius: 20px;
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

  button.addEventListener("mouseenter", () => {
    button.style.background = "#b25742";
  });
  button.addEventListener("mouseleave", () => {
    button.style.background = "#c8674f";
  });
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void openDigestPanel("Bilibili Digest");
  });

  return button;
}

function injectBilibiliDigestButton() {
  const existing = Array.from(document.querySelectorAll("#ytd-digest-button"));

  if (!isBilibiliVideoPage()) {
    existing.forEach((node) => node.remove());
    biliDigestButton = null;
    return false;
  }

  if (biliDigestButton && biliDigestButton.isConnected) {
    // 顺手清掉旧版本残留在页面里的按钮（旧版本会插进工具栏）。
    existing.forEach((node) => {
      if (node !== biliDigestButton) node.remove();
    });
    return true;
  }

  existing.forEach((node) => node.remove());
  const button = createBilibiliDigestButton();
  document.body.appendChild(button);
  biliDigestButton = button;
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

/**
 * Handles the "n" keyboard shortcut for saving a note.
 * Only triggers on YouTube watch pages and when the user is not typing
 * in an input field.
 */
function handleNoteKeyboardShortcut(e) {
  if (!window.location.pathname.includes("/watch")) return;
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

  // Prevent YouTube's own "n" shortcut (e.g. next video in playlist)
  e.preventDefault();
  e.stopPropagation();

  // Show brief visual feedback on the button, then save
  showNoteButton();
  resetNoteButtonTimer();
  saveCurrentNote();
}

/**
 * Captures the current timestamp and saves it as a note.
 */
async function saveCurrentNote() {
  debugLog("[YouTube Digest] Saving note");

  const video = document.querySelector("video.html5-main-video");
  if (!video) {
    console.error("[YouTube Digest] No video element found");
    return;
  }

  // Go back 3 seconds to capture what was just said (user reacts after hearing it)
  const currentTime = Math.max(0, Math.floor(video.currentTime) - 3);
  const videoInfo = extractVideoInfo();
  const videoId = new URLSearchParams(window.location.search).get("v");

  const noteButton = ytdNoteButton;
  const originalContent = noteButton ? noteButton.innerHTML : "";

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
      console.error("[YouTube Digest] Save note error:", result.error);
    }
  } catch (err) {
    if (noteButton) {
      noteButton.innerHTML =
        '<span style="letter-spacing: 0.2px;">ERROR</span>';
    }
    console.error("[YouTube Digest] Save note exception:", err);
  }

  setTimeout(() => {
    if (noteButton) {
      noteButton.innerHTML = originalContent;
      noteButton.style.background = "#c8674f";
      noteButton.style.pointerEvents = "auto";
    }
  }, 2000);
}

/**
 * Shows a toast notification when a note is saved.
 */
function showNoteSavedToast(note) {
  // Remove existing toast
  const existing = document.getElementById("ytd-note-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "ytd-note-toast";
  toast.innerHTML = `
    <div style="font-weight: 700; margin-bottom: 6px; color: #c8674f;">Note saved</div>
    <div style="font-size: 12px; color: #6b6258; margin-bottom: 8px;">${escapeHtmlForContent(note.timestamp)} — ${escapeHtmlForContent(note.videoTitle)}</div>
    <div style="font-size: 13px; line-height: 1.55; color: #2e2a24;">"${escapeHtmlForContent(note.text)}"</div>
    <div style="margin-top: 10px; font-size: 11px;">
      <a href="${escapeHtmlForContent(note.timestampedUrl)}" style="color: #c8674f; font-weight: 600; text-decoration: none;">Copy link</a>
    </div>
  `;

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

  // Add animation keyframes
  const style = document.createElement("style");
  style.textContent = `
    @keyframes ytdSlideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
  `;
  document.head.appendChild(style);

  // Copy link handler
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

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    toast.style.animation = "ytdSlideIn 0.3s ease reverse";
    setTimeout(() => toast.remove(), 300);
  }, 5000);
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
 * 返回 true 表示字幕开关是我们打开的，抓完需要还原，避免打扰用户。
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
    return false;
  }
  if (button.getAttribute("aria-pressed") === "true") return false;
  button.click();
  return true;
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
  let weEnabled = false;

  if (!url) {
    weEnabled = kickCaptionRequest();
    url = await waitForCaptionPotUrl(9000);
    if (!url) url = await pullCaptionPotUrl();
    // 播放器偶尔会比点击慢一拍，再等一小会儿。
    if (!url) url = await waitForCaptionPotUrl(3000);
  }

  try {
    if (!url) return { success: false, reason: "NO_POT_URL" };

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
  } finally {
    restoreCaptionState(weEnabled);
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
