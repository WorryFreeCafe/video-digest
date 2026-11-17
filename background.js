/**
 * BACKGROUND SERVICE WORKER
 *
 * This is the "brain" of the extension. It runs in the background and handles:
 * 1. Opening the side panel when the user clicks the extension icon
 * 2. Probing platform-native transcripts and delegating audio to local Whisper
 * 3. Calling DeepSeek to analyze the transcript
 * 4. Sending results back to the side panel
 *
 * Think of it like a backend server — it does the heavy lifting
 * so the UI (side panel) can stay fast and responsive.
 */

// Import safe defaults and validation helpers. Secret keys live in
// chrome.storage.local and are never part of the extension source.
importScripts("settings.js", "subtitle-sources.js");

const DEBUG = false;
const AI_PROVIDER_IDLE_TIMEOUT_MS = 50_000;
const AI_PROVIDER_HARD_TIMEOUT_MS = 120_000;
const AI_PROVIDER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// Prevent the YouTube content script from reading API keys or cached data.
// Side panel, options, and service-worker contexts remain trusted.
chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch((error) =>
    console.warn("[YouTube Digest] Could not restrict storage access:", error),
  );

async function getSettings() {
  const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  return YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY]);
}

const promptFileCache = new Map();

async function loadPromptSection(fileName, heading, variables = {}) {
  let markdown = promptFileCache.get(fileName);
  if (!markdown) {
    const response = await fetch(chrome.runtime.getURL(`prompts/${fileName}`));
    if (!response.ok) {
      throw new Error(`Could not load prompt file: ${fileName}`);
    }
    markdown = await response.text();
    promptFileCache.set(fileName, markdown);
  }

  const marker = `## ${heading}`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }
  const sectionStart = markerIndex + marker.length;
  const nextSection = markdown.indexOf("\n## ", sectionStart);
  const section = markdown.slice(
    sectionStart,
    nextSection === -1 ? markdown.length : nextSection,
  );
  // Prompt files are checked out with CRLF on Windows (core.autocrlf=true)
  // and LF elsewhere. Accept both so prompt loading works on every platform.
  const fenceMatch = section.match(/```(?:[A-Za-z0-9_-]+)?\r?\n([\s\S]*?)\r?\n```/);
  if (!fenceMatch) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }

  let prompt = fenceMatch[1].replace(/\r\n/g, "\n");
  for (const [key, value] of Object.entries(variables)) {
    prompt = prompt.split(`{${key}}`).join(String(value ?? ""));
  }
  return prompt;
}

async function requestAiCompletion({
  messages,
  maxTokens,
  temperature,
  responseFormat,
}) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    const error = new Error(
      "DeepSeek API key not configured. Open YouTube Digest Settings.",
    );
    error.code = "NO_AI_KEY";
    throw error;
  }
  const body = {
    model: settings.aiModel,
    max_tokens: maxTokens,
    messages,
  };
  if (typeof temperature === "number") body.temperature = temperature;
  if (responseFormat) {
    body.response_format = responseFormat;
  }
  // Product features need bounded, predictable latency rather than reasoning traces.
  body.thinking = { type: "disabled" };

  const controller = new AbortController();
  let timeoutKind = "";
  let idleTimeoutId;
  let hardTimeoutId;
  const abortForTimeout = (kind) => {
    if (controller.signal.aborted) return;
    timeoutKind = kind;
    controller.abort();
  };
  const resetIdleTimeout = () => {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = setTimeout(
      () => abortForTimeout("idle"),
      AI_PROVIDER_IDLE_TIMEOUT_MS,
    );
  };

  hardTimeoutId = setTimeout(
    () => abortForTimeout("hard"),
    AI_PROVIDER_HARD_TIMEOUT_MS,
  );
  resetIdleTimeout();
  try {
    const response = await fetch(
      YTD_SETTINGS.chatCompletionsUrl(),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.aiApiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    // Receiving headers proves DeepSeek is still making progress. DeepSeek
    // may then send blank-line body chunks while a non-streaming request queues.
    resetIdleTimeout();

    const data = await readBoundedAiResponse(response, resetIdleTimeout);
    if (!response.ok) {
      const errorData = data && typeof data === "object" ? data : {};
      const error = new Error(
        errorData.error?.message ||
          errorData.message ||
          `DeepSeek error: ${response.status}`,
      );
      error.status = response.status;
      throw error;
    }

    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      const error = new Error("DeepSeek returned an empty response.");
      error.code = "EMPTY_AI_RESPONSE";
      throw error;
    }

    return { text, settings };
  } catch (error) {
    if (timeoutKind === "idle") {
      const timeoutError = new Error(
        "DeepSeek request was inactive for 50 seconds. Please Retry.",
      );
      timeoutError.code = "AI_IDLE_TIMEOUT";
      throw timeoutError;
    }
    if (timeoutKind === "hard") {
      const timeoutError = new Error(
        "DeepSeek request exceeded the 120-second limit. Please Retry.",
      );
      timeoutError.code = "AI_HARD_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(idleTimeoutId);
    clearTimeout(hardTimeoutId);
  }
}

async function readBoundedAiResponse(response, onActivity) {
  const reader = response.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    let responseText = "";
    let responseBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Every received chunk is activity, including DeepSeek's blank lines.
      onActivity();
      const byteLength = value?.byteLength ?? 0;
      responseBytes += byteLength;
      if (responseBytes > AI_PROVIDER_MAX_RESPONSE_BYTES) {
        await reader.cancel?.().catch(() => {});
        const error = new Error("DeepSeek response exceeded the 2 MiB limit.");
        error.code = "AI_RESPONSE_TOO_LARGE";
        throw error;
      }
      responseText += decoder.decode(value, { stream: true });
    }
    responseText += decoder.decode();
    return JSON.parse(responseText.trimStart());
  }

  // Some fetch implementations do not expose a readable stream. Preserve a
  // bounded body read for that case.
  if (typeof response.text === "function") {
    const responseText = await response.text();
    onActivity();
    const byteLength = new TextEncoder().encode(responseText).byteLength;
    if (byteLength > AI_PROVIDER_MAX_RESPONSE_BYTES) {
      const error = new Error("DeepSeek response exceeded the 2 MiB limit.");
      error.code = "AI_RESPONSE_TOO_LARGE";
      throw error;
    }
    return JSON.parse(responseText.trimStart());
  }

  // Legacy/test fetch shims may expose only json(). The hard and idle timers
  // still bound this fallback even though chunk-level activity is unavailable.
  const data = await response.json();
  onActivity();
  return data;
}

// ============================================================
// SIDE PANEL SETUP
// ============================================================

/**
 * When the user clicks the extension icon, open the side panel.
 * Chrome's Side Panel API lets us show a persistent panel alongside the page.
 */
chrome.action.onClicked.addListener((tab) => {
  if (!isSupportedPlatformUrl(tab.url)) {
    void updatePanelForTab(tab.id, tab.url, tab.windowId);
    return;
  }

  // Re-enable + open without awaiting — preserves user gesture context
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: "sidepanel.html",
    enabled: true,
  });
  chrome.sidePanel.open({ tabId: tab.id });

  // This click is what grants activeTab (the "extension has been invoked"
  // flag Chrome checks before tab audio capture). Tell the panel so it can
  // resume a capture that was blocked a second ago.
  chrome.storage.local.set({ ytd_last_invoke: Date.now() });
  chrome.runtime
    .sendMessage({ action: "extensionInvoked", tabId: tab.id })
    .catch(() => {});
});

/**
 * Keep the click on our own handler: `openPanelOnActionClick: true` opens the
 * panel straight from Chrome's UI without dispatching action.onClicked, and
 * without granting activeTab. tabCapture then always fails with "Extension
 * has not been invoked for the current page" no matter how often the icon is
 * clicked. Explicitly reset it in case an older build stored it.
 */
const panelBehavior = chrome.sidePanel?.setPanelBehavior?.({
  openPanelOnActionClick: false,
});
if (panelBehavior && typeof panelBehavior.catch === "function") {
  panelBehavior.catch(() => {});
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

/**
 * Keep the side panel scoped to YouTube tabs only.
 *
 * Chrome side panels are "global" by default: once opened, the panel follows
 * you to every tab. To make YouTube Digest behave like a YouTube-only tool, we
 * enable the panel on YouTube tabs and disable it everywhere else. Disabling
 * on a tab makes Chrome hide/close the panel for that tab, so it never lingers
 * on a new tab or some other website.
 *
 * We have to react to BOTH things that can change "what tab you're looking at":
 *   - onUpdated: the current tab navigates to a new URL
 *   - onActivated: you switch to (or open) a different tab
 * The original code only handled onUpdated, which is why the panel stayed
 * visible when switching to an already-loaded non-YouTube tab.
 */
async function closePanelForTab(tabId, windowId) {
  // Chrome 141 added an explicit close API. On older supported versions,
  // disabling the tab-specific panel below remains the compatibility path.
  if (typeof chrome.sidePanel.close !== "function") return;

  try {
    // This closes the tab-specific panel used by YouTube Digest.
    await chrome.sidePanel.close({ tabId });
    return;
  } catch (error) {
    // Chrome 145+ rejects tabId when the visible instance is global. Close
    // that instance by window instead.
  }

  if (Number.isInteger(windowId)) {
    await chrome.sidePanel.close({ windowId }).catch(() => {});
  }
}

/**
 * Platforms the side panel can work on. YouTube was the original target; B站
 * uses the same free native-subtitle path (`x/player/wbi/v2`), so the panel is
 * enabled there too instead of being force-closed.
 * @param {string} [url]
 * @returns {boolean}
 */
function isSupportedPlatformUrl(url) {
  const value = url || "";
  return (
    value.startsWith("https://www.youtube.com") ||
    value.startsWith("https://www.bilibili.com") ||
    value.startsWith("https://m.bilibili.com")
  );
}

async function updatePanelForTab(tabId, url, windowId) {
  const isSupported = isSupportedPlatformUrl(url);
  if (!isSupported) {
    // Close the visible instance first. Then disable this tab so Chrome cannot
    // reopen the global default panel as navigation settles.
    await closePanelForTab(tabId, windowId);
    await chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
    return;
  }

  // setOptions can reject if the tab just closed. Ignore that harmlessly.
  await chrome.sidePanel
    .setOptions({ tabId, path: "sidepanel.html", enabled: true })
    .catch(() => {});
}

/**
 * Gets the best URL from a tab update that can change panel availability.
 * Chrome can apply tab-specific side-panel state before a navigation commits,
 * then reset it during the commit. Handling loading and complete gives the
 * first non-YouTube navigation a reliable second reconciliation.
 */
function getNavigationUrl(changeInfo, tab) {
  if (changeInfo.url) return changeInfo.url;
  if (changeInfo.status !== "loading" && changeInfo.status !== "complete") {
    return "";
  }
  return tab.pendingUrl || tab.url || "";
}

// A tab started or completed navigation. Reconcile at both stages because
// Chrome can replace per-tab side-panel options while the page commits.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = getNavigationUrl(changeInfo, tab);
  if (!url) return; // Ignore title and favicon-only updates.
  void updatePanelForTab(tabId, url, tab.windowId);
});

// The user switched to a different tab (or opened a new one).
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    void updatePanelForTab(tabId, tab.url || tab.pendingUrl, windowId);
  } catch (e) {
    // Tab vanished before we could read it — nothing to do.
  }
});

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel and content script.
 * This is like a switchboard — different "actions" trigger different handlers.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // We need to return true to indicate we'll respond asynchronously
  if (message.action === "fetchTranscriptSmart") {
    // 字幕预检编排：优先平台原生字幕（免费）→ Whisper 音频转录 → 给出提示。
    handleFetchTranscriptSmart(message.videoId, message.tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message, source: "smart" }));
    return true;
  }

  if (message.action === "captureAudioTranscribe") {
    // 手动触发：捕获当前播放音频并交给本地 Whisper 转录。
    // 第三个参数才是 options；第二位是 settings（null 表示实时读取）。
    handleCaptureAudioTranscribe(message.tabId, null, message.options)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "analyzeTranscript") {
    // Pass video duration to help the AI validate timestamps
    handleAnalyzeTranscript(
      message.transcriptText,
      message.videoTitle,
      message.channelName,
      message.videoDescription,
      message.videoDuration,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "explainSelection") {
    // Explain selected text using DeepSeek.
    handleExplainSelection(
      message.selectedText,
      message.transcriptContext,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "saveNote") {
    // Save a note at the current timestamp, or save exact selected transcript
    // text when the side panel supplies it.
    handleSaveNote(
      message.videoId,
      message.timestamp,
      message.videoTitle,
      message.channelName,
      message.selectedText,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getNotes") {
    // Get all saved notes
    handleGetNotes(message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "deleteNote") {
    // Delete a specific note
    handleDeleteNote(message.noteId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getVideoInfo") {
    handleGetVideoInfo(message.tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  // Translation: send content to DeepSeek.
  if (message.action === "translateContent") {
    handleTranslateContent(
      message.content,
      message.contentType,
      message.targetLanguage,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "checkConfig") {
    getSettings()
      .then((settings) =>
        sendResponse({
          hasAiKey: !!settings.aiApiKey,
        }),
      )
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.action === "openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "openSidePanel") {
    const tabId = sender.tab?.id;
    debugLog("[YouTube Digest BG] openSidePanel requested from tab:", tabId);

    // Re-enable the panel (it may have been disabled by auto-close) and open it.
    // IMPORTANT: we call setOptions + open synchronously (no await between them)
    // to preserve the user gesture context. Chrome requires sidePanel.open()
    // to be called within a user gesture — awaiting anything first can expire it.
    if (tabId) {
      chrome.sidePanel.setOptions({
        tabId,
        path: "sidepanel.html",
        enabled: true,
      });
      chrome.sidePanel
        .open({ tabId })
        .then(() => {
          // Broadcast to side panel to start digest (in case it's already open)
          setTimeout(() => {
            chrome.runtime
              .sendMessage({ action: "startDigestFromButton" })
              .catch(() => {});
          }, 300);
        })
        .catch((err) => {
          console.error("[YouTube Digest BG] openSidePanel error:", err);
        });
    } else {
      // Fallback: find the active tab
      chrome.tabs
        .query({ active: true, lastFocusedWindow: true })
        .then((tabs) => {
          if (tabs[0]) {
            chrome.sidePanel.setOptions({
              tabId: tabs[0].id,
              path: "sidepanel.html",
              enabled: true,
            });
            chrome.sidePanel.open({ tabId: tabs[0].id }).catch((err) => {
              console.error(
                "[YouTube Digest BG] openSidePanel fallback error:",
                err,
              );
            });
          }
        });
    }

    sendResponse({ success: true });
    return false;
  }

  // Relay messages from side panel to content script
  if (message.action === "relayToContent") {
    debugLog("[YouTube Digest BG] Relay request:", message.payload?.action);
    (async () => {
      try {
        // Query specifically for YouTube tabs to avoid side panel context issues
        // Try multiple query strategies to find the right tab
        let tabs = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        debugLog(
          "[YouTube Digest BG] Active tab in last focused window:",
          tabs.length,
          tabs[0]?.url,
        );

        // The panel is scoped per tab, so the active tab on a supported
        // platform is authoritative (YouTube or B站). Only fall back to a
        // platform-wide search when the focused tab is something else.
        if (!isSupportedPlatformUrl(tabs[0]?.url)) {
          tabs = await chrome.tabs.query({
            url: ["https://www.youtube.com/*", "https://*.bilibili.com/*"],
            active: true,
          });
          debugLog("[YouTube Digest BG] Active platform tabs:", tabs.length);
        }

        // Still nothing? Try any platform tab
        if (!tabs[0]) {
          tabs = await chrome.tabs.query({
            url: ["https://www.youtube.com/*", "https://*.bilibili.com/*"],
          });
          debugLog("[YouTube Digest BG] Any platform tabs:", tabs.length);
        }

        if (tabs[0]) {
          debugLog(
            "[YouTube Digest BG] Sending to tab:",
            tabs[0].id,
            "URL:",
            tabs[0].url,
          );
          let response = await chrome.tabs.sendMessage(
            tabs[0].id,
            message.payload,
          );

          // For getVideoInfo, PREFER YouTube's own player data over the
          // DOM scrape. The player's videoDetails is canonical: its `author`
          // is always THIS video's channel and its `shortDescription` is the
          // full text. The DOM scrape is unreliable — e.g. on a playlist page
          // it grabbed the playlist owner's name ("Zara Zhang") instead of the
          // real channel ("Replit and Stripe"), and its description is
          // truncated while the box is collapsed. We fall back to the DOM
          // only for fields the player didn't provide.
          if (
            message.payload?.action === "getVideoInfo" &&
            (tabs[0].url || "").includes("youtube.com")
          ) {
            const playerInfo = await getPlayerVideoDetails(tabs[0].id);
            if (playerInfo) {
              response = {
                title: playerInfo.title || response?.title || "",
                channelName:
                  playerInfo.channelName || response?.channelName || "",
                duration: playerInfo.duration || response?.duration || 0,
                description:
                  playerInfo.description || response?.description || "",
              };
            }
          }

          debugLog("[YouTube Digest BG] Got response from content:", response);
          sendResponse({ success: true, response });
        } else {
          debugLog("[YouTube Digest BG] No YouTube tab found");
          sendResponse({ success: false, error: "No YouTube tab found" });
        }
      } catch (err) {
        console.error("[YouTube Digest BG] Relay error:", err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open for async response
  }
});

/**
 * Reads the current video's full details straight from YouTube's player.
 *
 * Content scripts live in an isolated world and can't touch the page's own
 * JavaScript. But with the "scripting" permission we can run a tiny function
 * in the page's MAIN world, where YouTube's player object lives. Its
 * getPlayerResponse() carries videoDetails with the FULL description —
 * unlike the DOM, which truncates it until the user clicks "...more".
 *
 * Returns null on any failure so callers can fall back to DOM scraping.
 */
async function getPlayerVideoDetails(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        try {
          const player = document.getElementById("movie_player");
          const details = player?.getPlayerResponse?.()?.videoDetails;
          const caps = player?.getPlayerResponse?.()?.captions;
          const tracks = caps?.playerCaptionsTracklistRenderer?.captionTracks;
          const captionTracks = Array.isArray(tracks)
            ? tracks.map((t) => ({ baseUrl: t.baseUrl || "", lang: t.languageCode || "" }))
            : [];
          if (!details) return null;
          return {
            title: details.title || "",
            channelName: details.author || "",
            description: details.shortDescription || "",
            duration: Number(details.lengthSeconds) || 0,
            captionTracks,
          };
        } catch (e) {
          return null;
        }
      },
    });
    return results?.[0]?.result || null;
  } catch (e) {
    console.warn("[YouTube Digest BG] Player details unavailable:", e.message);
    return null;
  }
}

// ============================================================
// TRANSCRIPT FETCHING (PLATFORM-NATIVE + LOCAL WHISPER)
// ============================================================

/**
 * 字幕预检编排：先尝试免费获取平台原生字幕，再尝试本地 Whisper 音频转录，
 * 都没有就如实告诉用户缺什么。
 *
 * @param {string} videoId - 平台视频 ID（YouTube 或 B站标识）
 * @param {number} [tabId] - 当前标签页 ID，用于向 content script 探测
 * @returns {Object}
 */
async function handleFetchTranscriptSmart(videoId, tabId) {
  const settings = await getSettings();

  // 1) 平台原生字幕预检（免费）
  const platform = await probePlatformSubtitle(videoId, tabId, settings);
  if (platform && platform.success !== false && platform.transcript?.length) {
    return YTD_SUBTITLE_SOURCES.sourceResult("platform", {
      transcript: platform.transcript,
      transcriptText: platform.transcriptText,
      transcriptTextTimestamped: platform.transcriptTextTimestamped,
      language: platform.language || null,
      note: "来自平台原生字幕。",
    });
  }

  // 2) 本地 Whisper 音频转录兜底（若用户已启用）
  if (settings.whisperEnabled && tabId) {
    const whisper = await handleCaptureAudioTranscribe(tabId, settings, {
      silent: true,
    });
    if (whisper && whisper.success && whisper.transcriptText) {
      return YTD_SUBTITLE_SOURCES.sourceResult("whisper", {
        transcript: whisper.transcript,
        transcriptText: whisper.transcriptText,
        transcriptTextTimestamped: whisper.transcriptTextTimestamped,
        language: null,
        note: "无原生字幕，已通过本地 Whisper 转录（仅覆盖所捕获的一小段音频）。",
      });
    }
    return YTD_SUBTITLE_SOURCES.sourceResult("whisper", {
      success: false,
      error: whisper?.error || "WHISPER_FAILED",
      message:
        whisper?.message ||
        "无原生字幕，且本地 Whisper 转录失败。请确认视频正在播放、Whisper 服务已启动后重试。",
    });
  }

  // 3) 无字幕、未启用 Whisper：告诉用户唯一可用的补救方式
  return YTD_SUBTITLE_SOURCES.sourceResult("none", {
    success: false,
    error: "NO_TRANSCRIPT",
    message:
      "该视频未检测到原生字幕，且未启用本地 Whisper。请在设置中开启本地 Whisper 后重试。",
    canEnableWhisper: true,
  });
}

/**
 * 探测平台原生字幕（免费通道）。
 * 通过 content script 收集页面信息：
 *   - YouTube：页面脚本可读 captionTracks（由 getPlayerVideoDetails 顺带处理）
 *   - B站：读取 cid，再调 B站字幕接口
 *   - 通用 html：探测 video.textTracks
 * @returns {Object|null}
 */
/**
 * 把"已构建好的字幕对象"包成统一来源结构。
 *
 * buildTranscriptFromChunks / fetchBilibiliSubtitle 只返回 transcript 本体，
 * 不带 success / source 字段；而 handleFetchTranscriptSmart 以 platform.success
 * 作为"原生字幕可用"的判据。少了这层包装，B 站/YouTube/通用 video 的原生字幕
 * 会被整体判为不可用，直接掉到 Whisper 兜底（表现为"未检测到原生字幕"）。
 */
function asPlatformResult(built, note) {
  if (!built || !Array.isArray(built.transcript) || built.transcript.length === 0) {
    return null;
  }
  return YTD_SUBTITLE_SOURCES.sourceResult("platform", {
    transcript: built.transcript,
    transcriptText: built.transcriptText,
    transcriptTextTimestamped: built.transcriptTextTimestamped,
    language: built.language ?? null,
    note,
  });
}

async function probePlatformSubtitle(videoId, tabId, settings) {
  if (!tabId) return null;

  // 取得当前标签页的站点信息
  let pageUrl = "";
  try {
    const tab = await chrome.tabs.get(tabId);
    pageUrl = tab.url || "";
  } catch (_e) {
    return null;
  }
  const site = YTD_SUBTITLE_SOURCES.detectSite(pageUrl);

  // B站：走免费字幕接口
  if (site === "bilibili") {
    return asPlatformResult(
      await fetchBilibiliSubtitle(tabId, videoId),
      "来自 B 站原生字幕。",
    );
  }

  // 通用 html video：探测原生 textTracks
  if (site === "generic") {
    try {
      const probe = await chrome.tabs.sendMessage(tabId, {
        action: "probeGenericSubtitle",
      });
      if (probe && probe.found && probe.chunks?.length) {
        return asPlatformResult(
          YTD_SUBTITLE_SOURCES.buildTranscriptFromChunks(probe.chunks),
          "来自页面原生字幕轨。",
        );
      }
      return null;
    } catch (_e) {
      return null;
    }
  }

  // YouTube：优先尝试页面 captionTracks（免费），失败则交由调用方决定
  // 这里尝试从 player 取字幕轨道。
  try {
    const player = await getPlayerVideoDetails(tabId);
    const tracks = (player && player.captionTracks) || [];
    if (!tracks.length) return null;
    const trackLangs = tracks.map((t) => t.lang).filter(Boolean);

    // 1) 直接请求 baseUrl。YouTube 现在对没有 pot（proof-of-origin token）
    //    的请求返回 **HTTP 200 + 空响应体**，所以必须按内容长度判断，
    //    只看 resp.ok 会把空字幕当成成功，最后掉进 30 秒 Whisper 兜底。
    const first = tracks[0];
    if (first && first.baseUrl) {
      try {
        const resp = await fetch(first.baseUrl);
        if (resp.ok) {
          const body = await resp.text();
          if (body && body.length > 200) {
            const parsed = parseYoutubeCaptionBody(body);
            if (parsed.length) {
              return asPlatformResult(
                YTD_SUBTITLE_SOURCES.buildTranscriptFromChunks(parsed),
                "来自 YouTube 原生字幕。",
              );
            }
          }
        }
      } catch (_e) {
        /* 继续尝试 pot 通道 */
      }
    }

    // 2) pot 通道：让页面交出播放器自己带签名的 timedtext URL，
    //    改写 lang 后即可拿到整条字幕轨（含完整时间轴）。
    const potResult = await requestYoutubeCaptionFromPage(tabId, trackLangs);
    if (potResult && potResult.success) {
      const parsed = parseYoutubeCaptionBody(potResult.text);
      if (parsed.length) {
        const built = YTD_SUBTITLE_SOURCES.buildTranscriptFromChunks(parsed);
        if (potResult.lang) built.language = potResult.lang;
        return asPlatformResult(
          built,
          "来自 YouTube 原生字幕。",
        );
      }
    }
    return null;
  } catch (_e) {
    return null;
  }
}

/**
 * 请内容脚本用播放器带 pot 的 URL 取全量字幕。
 * 内容脚本跑在页面上下文里，带得上 cookie，也能读到播放器请求过的 URL。
 */
async function requestYoutubeCaptionFromPage(tabId, trackLangs) {
  const ask = async () => {
    try {
      return await chrome.tabs.sendMessage(tabId, {
        action: "fetchYoutubeCaptionText",
        trackLangs: Array.isArray(trackLangs) ? trackLangs : [],
      });
    } catch (_e) {
      // 内容脚本未注入（扩展刚更新、页面还没刷新）时 sendMessage 会抛错。
      return null;
    }
  };

  let res = await ask();
  // 页面在扩展更新之前就打开了：这次没有 pot 钩子，补注入一次再试，
  // 免得用户为了取字幕被迫刷新页面。
  if (!res || (!res.success && res.reason === "NO_POT_URL")) {
    if (await ensureCaptionPotHook(tabId)) {
      res = await ask();
    }
  }
  if (!res || !res.success) {
    if (res && res.reason) {
      debugLog("[YouTube Digest BG] Caption pot path failed:", res.reason);
    }
    return null;
  }
  return res;
}

/**
 * 把 pot 钩子补注入到已打开的页面（MAIN world）。
 * caption-pot-hook.js 自带 `__ytdCaptionPotHooked` 守卫，重复注入是安全的。
 */
async function ensureCaptionPotHook(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      files: ["caption-pot-hook.js"],
    });
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * 解析 YouTube 字幕响应体，自动识别 json3 与 XML 两种格式。
 */
function parseYoutubeCaptionBody(body) {
  const text = String(body || "").trim();
  if (!text) return [];
  if (text.startsWith("{")) return parseYoutubeCaptionJson3(text);
  return parseYoutubeCaptionXml(text);
}

/**
 * 解析 YouTube timedtext 的 json3 格式。
 * 结构：{ events:[{ tStartMs, dDurationMs, segs:[{ utf8, tOffsetMs }] }] }
 * 自动字幕会有大量重复片段（滚动式刷新），这里做一次连续去重。
 */
function parseYoutubeCaptionJson3(json) {
  let data;
  try {
    data = JSON.parse(json);
  } catch (_e) {
    return [];
  }
  const events = Array.isArray(data.events) ? data.events : [];
  const chunks = [];
  let previous = "";
  for (const event of events) {
    const segs = event && event.segs;
    if (!Array.isArray(segs) || !segs.length) continue;
    const text = segs
      .map((s) => (s && s.utf8) || "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    // json3 里相邻事件的文本经常只是上一句的滚动补全，重复内容直接丢弃。
    if (text === previous) continue;
    previous = text;
    chunks.push({ start: Number(event.tStartMs || 0) / 1000, text });
  }
  return chunks;
}

/**
 * 从 B站播放页读取 cid / bvid。
 *
 * 必须在 MAIN world 注入：content script 默认跑在 isolated world，页面的
 * `window.__INITIAL_STATE__` 在隔离世界里是 undefined，直接读会导致 cid
 * 永远为 null，B 站免费字幕路径整体失效（只能退回 Whisper）。
 *
 * 返回值用 JSON 字符串传回，避免结构化克隆对页面对象的限制。
 */
async function readBilibiliSubtitleMeta(tabId, videoId) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const state = window.__INITIAL_STATE__;
        if (!state) return "";
        const videoData = state.videoData || state.videoInfo || null;
        const cid =
          state.cid ||
          (videoData && videoData.cid) ||
          (Array.isArray(state.pages) && state.pages[0] && state.pages[0].cid) ||
          null;
        const bvid = state.bvid || (videoData && videoData.bvid) || null;
        if (!cid) return "";
        return JSON.stringify({ cid: Number(cid), bvid: bvid || null });
      },
    });
    const raw = injection?.result;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.cid) return parsed;
    }
  } catch (_e) {
    /* fall through to the content-script path below */
  }

  // 兜底：老路径（页面结构变化或 MAIN world 注入被策略禁用时）
  try {
    const meta = await chrome.tabs.sendMessage(tabId, {
      action: "fetchBilibiliSubtitleMeta",
    });
    if (meta?.cid) return meta;
  } catch (_e) {
    /* ignore */
  }
  return { cid: null, bvid: videoId || null };
}

/**
 * 从 B站字幕接口获取字幕（全程免费）。
 * 需要 cid；若页面未暴露 cid，则返回 null 由调用方兜底。
 */
async function fetchBilibiliSubtitle(tabId, videoId) {
  const meta = await readBilibiliSubtitleMeta(tabId, videoId);
  const cid = meta?.cid;
  const bvid = meta?.bvid || videoId;
  if (!cid || !bvid) return null;

  try {
    // B站播放信息接口：字幕列表（尤其 AI 字幕）只在登录会话下返回，
    // 必须带 cookie。字幕文件同样在 aisubtitle.hdslb.com 上要求登录态。
    const playerUrl = new URL("https://api.bilibili.com/x/player/wbi/v2");
    playerUrl.searchParams.set("bvid", bvid);
    playerUrl.searchParams.set("cid", cid);
    const infoResp = await fetch(playerUrl.toString(), {
      credentials: "include",
    });
    const info = await infoResp.json().catch(() => ({}));
    const subs = info?.data?.subtitle?.subtitles;
    if (!subs || !Array.isArray(subs) || subs.length === 0) return null;

    // 取第一条字幕（通常为中文），fetch 其 JSON
    const subUrl = subs[0].subtitle_url;
    if (!subUrl) return null;
    const fullUrl = subUrl.startsWith("//")
      ? `https:${subUrl}`
      : subUrl.startsWith("http")
        ? subUrl
        : `https://${subUrl}`;
    const subResp = await fetch(fullUrl, { credentials: "include" });
    const subData = await subResp.json().catch(() => ({}));
    const body = subData?.body;
    if (!Array.isArray(body) || body.length === 0) return null;

    const chunks = body.map((item) => ({
      start: Number(item.from) || 0,
      text: item.content || "",
      language: item.lan || subs[0].lan || null,
    }));
    const built = YTD_SUBTITLE_SOURCES.buildTranscriptFromChunks(chunks);
    built.language = subs[0].lan || null;
    return built;
  } catch (_e) {
    return null;
  }
}

/**
 * 解析 YouTube timedtext 字幕 XML 为 chunks。
 * 格式：<transcript><text start="..." dur="...">...</text>...</transcript>
 */
function parseYoutubeCaptionXml(xml) {
  const chunks = [];
  const textRegex = /<text[^>]*start="([0-9.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = textRegex.exec(xml)) !== null) {
    const start = parseFloat(m[1]);
    const raw = m[2]
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"');
    if (raw.trim()) chunks.push({ start: start || 0, text: raw.trim() });
  }
  return chunks;
}

/**
 * 捕获当前标签页音频并交给本地 Whisper 转录。
 *
 * Chrome MV3 的 service worker 没有 DOM，也就没有 getUserMedia/MediaRecorder。
 * 这里只调用 chrome.tabCapture.getMediaStreamId() 拿到一次性流 id，把它交给
 * Offscreen Document（offscreen.js）完成录制并 POST 给本地 Whisper。
 * 这也能捕获 YouTube/B站等跨域播放器的音频，不依赖 video.captureStream。
 *
 * 限制：视频必须正在播放才能捕获到声音；DRM/加密流无法捕获。
 * @param {number} tabId
 * @param {Object} settings
 * @param {Object} [opts]
 * @returns {Object}
 */
async function handleCaptureAudioTranscribe(tabId, settings = null, opts = {}) {
  const cfg = settings || (await getSettings());
  if (!cfg.whisperEnabled) {
    return {
      success: false,
      error: "WHISPER_DISABLED",
      message: "本地 Whisper 未启用。请在设置中开启。",
    };
  }
  if (!tabId) {
    return {
      success: false,
      error: "NO_TAB",
      message: "缺少标签页信息，无法捕获音频。",
    };
  }

  // 先确认目标标签页存在。
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_e) {
    return {
      success: false,
      error: "NO_TAB",
      message: "找不到目标标签页，请重新打开侧边栏后重试。",
    };
  }
  if (!tab || !tab.url || !/^https?:/i.test(tab.url)) {
    return {
      success: false,
      error: "UNSUPPORTED_TAB",
      message: "当前标签页不是网页，无法捕获音频。",
    };
  }

  const seconds = Math.min(Math.max(Number(opts.seconds) || 30, 5), 120);
  try {
    const text = await captureViaOffscreen(tabId, {
      seconds,
      whisperUrl: cfg.whisperServerUrl,
      model: cfg.whisperModel,
    });
    if (!text || !text.trim()) {
      return {
        success: false,
        error: "EMPTY_TRANSCRIPT",
        message: "音频已捕获但转录为空。请确认视频已播放出声音，或稍后重试。",
      };
    }
    const built = YTD_SUBTITLE_SOURCES.buildTranscriptFromPlainText(text);
    // 必须带 success / source：handleFetchTranscriptSmart 以 whisper.success
    // 判定兜底是否可用，直接返回 buildTranscriptFromPlainText 的裸对象会让
    // 真实转录成功也被当成 WHISPER_FAILED。
    return YTD_SUBTITLE_SOURCES.sourceResult("whisper", {
      ...built,
      note: `通过本地 Whisper 转录（只捕获了当前播放位置后的 ${seconds} 秒）`,
    });
  } catch (e) {
    const raw = String(e?.message || e);
    // Chrome only allows tabCapture after the extension has been invoked on
    // that tab (activeTab). Without this mapping the side panel shows the raw
    // English DevTools-style error, which reads like a bug rather than a step
    // the user has to take.
    if (/has not been invoked/i.test(raw)) {
      return {
        success: false,
        error: "CAPTURE_NOT_INVOKED",
        message:
          "Chrome 要求先在这个网页上唤醒一次扩展，才允许捕获标签页音频。请点一下工具栏的 YouTube Digest 图标（或按 Alt+Shift+9），面板会自动继续转录。",
      };
    }
    return {
      success: false,
      error: "TRANSCRIBE_ERROR",
      message: `转录失败：${raw}`,
    };
  }
}

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";

/**
 * Create the offscreen document once and reuse it for later recordings.
 * MV3 service workers have no DOM, so they cannot call getUserMedia() or
 * MediaRecorder; the offscreen document owns the MediaStream instead.
 */
async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  if (chrome.runtime.getContexts) {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [url],
    });
    if (existing && existing.length > 0) return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["USER_MEDIA"],
      justification:
        "Capture the active tab's audio and send it to the local Whisper service.",
    });
  } catch (error) {
    // A concurrent recording may have created the document already.
    if (!/single offscreen document/i.test(error?.message || "")) throw error;
  }
}

/**
 * Ask Chrome for a one-shot stream id for the target tab. Unlike
 * tabCapture.capture(), getMediaStreamId() is safe to call from a service
 * worker; the id is consumed by getUserMedia() in the offscreen document.
 * @param {number} tabId
 * @returns {Promise<string>}
 */
async function getTabCaptureStreamId(tabId) {
  if (!chrome.tabCapture?.getMediaStreamId) {
    throw new Error(
      "chrome.tabCapture.getMediaStreamId 不可用，需要 Chrome 116+ 与 tabCapture 权限。",
    );
  }
  return chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
}

/**
 * Delegate recording and transcription to the offscreen document.
 * @param {number} tabId
 * @param {{seconds:number, whisperUrl:string, model:string}} options
 * @returns {Promise<string>} transcribed text
 */
async function captureViaOffscreen(tabId, options) {
  await ensureOffscreenDocument();
  let streamId;
  try {
    streamId = await getTabCaptureStreamId(tabId);
  } catch (error) {
    if (!/active stream/i.test(error?.message || "")) throw error;
    // A previous recording was interrupted (offscreen document killed, tab
    // closed mid-record) and Chrome still counts its stream as active, so the
    // tab becomes un-capturable. Closing the document releases it; ask again.
    await chrome.offscreen.closeDocument().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 400));
    await ensureOffscreenDocument();
    streamId = await getTabCaptureStreamId(tabId);
  }
  let response;
  try {
    response = await chrome.runtime.sendMessage({
      action: "recordTabAudio",
      options: { ...options, streamId },
    });
  } catch (error) {
    // The id was minted but never consumed, which would leave the tab locked
    // for the next attempt; drop the offscreen document to release it.
    await chrome.offscreen.closeDocument().catch(() => {});
    throw new Error(`无法与 offscreen document 通信：${error.message}`);
  }
  if (!response) {
    throw new Error("offscreen document 没有响应，请重新加载扩展后重试。");
  }
  if (!response.success) {
    throw new Error(response.error || "音频转录失败。");
  }
  return response.text;
}

// ============================================================
// JSON HELPER
// ============================================================

/**
 * Parses JSON returned by an LLM, tolerating the small mistakes they sometimes
 * make. Some models occasionally emit a trailing
 * comma before a ] or }, or wraps the JSON in prose / code fences. Plain
 * JSON.parse throws on those, which is what caused the "Unexpected token ']'"
 * error on the Overview tab. This function strips fences, isolates the outer
 * JSON object, removes trailing commas, and only then parses.
 *
 * @param {string} text - The raw text from the model
 * @returns {Object} - The parsed object (throws if still unparseable)
 */
function parseLooseJson(text) {
  let cleaned = (text || "").trim();

  // Strip ```json ... ``` style code fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }

  // Isolate the outermost { ... } in case the model added a sentence around it
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    // Most common LLM slip: a trailing comma right before a } or ].
    // e.g. ["a", "b", ]  ->  ["a", "b" ]
    const repaired = cleaned.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(repaired);
  }
}

// ============================================================
// DEEPSEEK ANALYSIS
// ============================================================

/**
 * Sends the transcript to DeepSeek for analysis.
 *
 * The prompt asks the model to produce chapters covering the whole video
 * and 3-5 key quotes with timestamps.
 *
 * @param {string} transcriptText - The full transcript as plain text
 * @param {string} videoTitle - The video title
 * @param {string} channelName - The channel name
 * @returns {Object} - { success, analysis } or { success: false, error }
 */
async function handleAnalyzeTranscript(
  transcriptText,
  videoTitle,
  channelName,
  videoDescription,
  videoDuration,
) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "DeepSeek API key not configured. Open YouTube Digest Settings.",
      };
    }

    // Convert duration to MM:SS format for context
    // The transcript text is already prefixed with [M:SS] markers. Its LAST
    // marker is the most reliable signal of where the content actually ends —
    // more trustworthy than the duration metadata, which is sometimes missing
    // or wrong. We use the larger of (metadata duration, last transcript stamp).
    let lastTranscriptSeconds = 0;
    const stampMatches = transcriptText.match(/\[(\d+):(\d{2})\]/g) || [];
    if (stampMatches.length) {
      const last =
        stampMatches[stampMatches.length - 1].match(/\[(\d+):(\d{2})\]/);
      lastTranscriptSeconds = parseInt(last[1]) * 60 + parseInt(last[2]);
    }

    const effectiveSeconds = Math.max(
      Math.floor(videoDuration || 0),
      lastTranscriptSeconds,
    );
    const durationMinutes = Math.floor(effectiveSeconds / 60);
    const durationSeconds = Math.floor(effectiveSeconds % 60);
    const durationFormatted = `${durationMinutes}:${String(durationSeconds).padStart(2, "0")}`;
    const maxTimestampSeconds = effectiveSeconds;

    // The "last chapter must be after" threshold (75% in) forces the model to
    // cover the WHOLE video instead of front-loading chapters near the start.
    // We do NOT prescribe a chapter count — the model picks the natural splits.
    const lateThresholdSeconds = Math.floor(effectiveSeconds * 0.75);
    const lateThreshold = `${Math.floor(lateThresholdSeconds / 60)}:${String(
      lateThresholdSeconds % 60,
    ).padStart(2, "0")}`;

    const promptVariables = {
      durationFormatted,
      lateThreshold,
      maxTimestampSeconds,
      videoTitle: videoTitle || "Unknown",
      channelName: channelName || "Unknown",
      videoDescription: videoDescription || "No description available",
      transcriptText,
    };
    const systemPrompt = await loadPromptSection(
      "analysis.md",
      "System prompt",
      promptVariables,
    );
    const userPrompt = await loadPromptSection(
      "analysis.md",
      "User prompt",
      promptVariables,
    );

    debugLog("[YouTube Digest] Requesting video analysis", settings.aiModel);
    const { text: responseText } = await requestAiCompletion({
      maxTokens: 8192,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    // Parse the JSON, tolerating trailing commas / stray prose
    let analysis = parseLooseJson(responseText);

    // Treat every model response as untrusted data. Rebuild the supported
    // schema and derive display timestamps from validated numeric seconds.
    analysis = validateAndFixTimestamps(analysis, maxTimestampSeconds);

    return {
      success: true,
      analysis: analysis,
    };
  } catch (error) {
    console.error("Analysis error:", error);
    if (error.status === 401) {
      return {
        success: false,
        error: "INVALID_AI_KEY",
        message: "DeepSeek rejected the API key.",
      };
    }
    if (error.status === 429) {
      return {
        success: false,
        error: "RATE_LIMITED",
        message: "DeepSeek rate-limited this request. Try again shortly.",
      };
    }
    return {
      success: false,
      error: error.message || "Failed to analyze transcript",
    };
  }
}

/**
 * Validates all timestamps in the analysis and fixes any that exceed video duration.
 * This is a safety net to prevent hallucinated timestamps from reaching the UI.
 *
 * @param {Object} analysis - The parsed analysis from DeepSeek
 * @param {number} maxSeconds - Maximum valid timestamp in seconds
 * @returns {Object} - Analysis with validated timestamps
 */
function validateAndFixTimestamps(analysis, maxSeconds) {
  const safeMax =
    Number.isFinite(Number(maxSeconds)) && Number(maxSeconds) > 0
      ? Number(maxSeconds)
      : Number.MAX_SAFE_INTEGER;

  // Helper to format seconds as MM:SS
  const formatTimestamp = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  };

  const safeString = (value, maxLength) =>
    typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  const safeSeconds = (value) => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > safeMax) {
      return null;
    }
    return Math.floor(seconds);
  };

  const chapters = (Array.isArray(analysis?.chapters) ? analysis.chapters : [])
    .slice(0, 100)
    .map((chapter) => {
      const seconds = safeSeconds(chapter?.timestampSeconds);
      const title = safeString(chapter?.title, 300);
      if (seconds === null || !title) return null;
      return {
        title,
        summary: safeString(chapter?.summary, 1500),
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyQuotes = (
    Array.isArray(analysis?.keyQuotes) ? analysis.keyQuotes : []
  )
    .slice(0, 50)
    .map((quote) => {
      const seconds = safeSeconds(quote?.timestampSeconds);
      const text = safeString(quote?.quote, 3000);
      if (seconds === null || !text) return null;
      return {
        quote: text,
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyMoments = (
    Array.isArray(analysis?.keyMoments) ? analysis.keyMoments : []
  )
    .map(safeSeconds)
    .filter((seconds) => seconds !== null)
    .slice(0, 100);

  return { chapters, keyQuotes, keyMoments };
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Gets video info (title, channel, description) from the active YouTube tab.
 * We do this by asking the content script to read the page.
 */
async function handleGetVideoInfo(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: "getVideoInfo",
    });
    return response;
  } catch (error) {
    return { title: "", channelName: "", description: "" };
  }
}

// ============================================================
// EXPLAIN SELECTION
// ============================================================

/**
 * Explains selected text using DeepSeek.
 * Provides context, definitions, and clarification for complex terms.
 *
 * @param {string} selectedText - The text the user selected
 * @param {string} transcriptContext - Surrounding transcript for context
 * @param {string} videoTitle - Video title for additional context
 * @returns {Object} - { success, explanation } or { success: false, error }
 */
// ============================================================
// NOTE MANAGEMENT
// ============================================================

/**
 * Saves a note at a timestamp. Exact selected text is stored directly.
 * Other note requests find the relevant transcript line and clean it up.
 */
async function handleSaveNote(
  videoId,
  timestamp,
  videoTitle,
  channelName,
  selectedText,
) {
  try {
    const canonicalVideoUrl = YTD_SETTINGS.canonicalYouTubeUrl(videoId);
    const safeTimestamp = Math.max(0, Math.floor(Number(timestamp) || 0));
    const exactSelectedText =
      typeof selectedText === "string"
        ? selectedText.replace(/\s+/g, " ").trim().slice(0, 3000)
        : "";

    // A selected transcript note is already the exact text the user wants.
    // Save it directly without a transcript fetch or an AI cleanup request.
    if (exactSelectedText) {
      const minutes = Math.floor(safeTimestamp / 60);
      const seconds = safeTimestamp % 60;
      const note = {
        id: `note_${Date.now()}`,
        videoId,
        videoTitle:
          typeof videoTitle === "string"
            ? videoTitle.slice(0, 500)
            : "Untitled Video",
        channelName:
          typeof channelName === "string" ? channelName.slice(0, 300) : "",
        timestamp: `${minutes}:${String(seconds).padStart(2, "0")}`,
        timestampSeconds: safeTimestamp,
        timestampedUrl: `${canonicalVideoUrl}&t=${safeTimestamp}s`,
        text: exactSelectedText,
        rawText: exactSelectedText,
        createdAt: Date.now(),
      };

      await saveNoteToStorage(note);
      chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});
      return { success: true, note };
    }

    // First, try to get the transcript from the digest cache. The side panel
    // saves digests to chrome.storage.LOCAL — this used to look in
    // storage.session (the wrong store), so it missed every time and
    // refetched the transcript over the network on every saved note.
    let transcript = null;
    try {
      const cached = await chrome.storage.local.get(`digest_${videoId}`);
      if (cached[`digest_${videoId}`]?.transcript) {
        transcript = cached[`digest_${videoId}`].transcript;
        debugLog("[YouTube Digest] Using cached transcript for note");
      }
    } catch (e) {
      debugLog("[YouTube Digest] No cached transcript");
    }

    // Notes are created from the side panel, which only opens after a digest
    // has been loaded and cached. If the cache is gone, asking the user to
    // reload is cheaper and more honest than re-running subtitle discovery
    // from a background context that has no tab to probe.
    if (!transcript) {
      return {
        success: false,
        error: "NO_CACHED_TRANSCRIPT",
        message: "字幕缓存已失效，请在侧边栏重新加载这个视频后再保存笔记。",
      };
    }

    // Find the transcript line at the current timestamp
    // Look for the line that contains this timestamp (or the closest one before)
    let matchedLine = null;
    let matchedIndex = 0;
    let contextLines = [];
    let beforeLine = null; // a few sentences before
    let afterLine = null; // a few sentences after

    for (let i = 0; i < transcript.length; i++) {
      const line = transcript[i];
      if (
        line.start <= safeTimestamp &&
        (!transcript[i + 1] || transcript[i + 1].start > safeTimestamp)
      ) {
        matchedLine = line;
        matchedIndex = i;

        // Build a buffer of 2 lines before and 4 lines after the target.
        // This gives the model enough text to find a natural sentence boundary
        // and complete a thought that spans multiple short caption chunks.
        const beforeLines = [];
        for (let j = 1; j <= 2 && i - j >= 0; j++) {
          beforeLines.unshift(transcript[i - j].text);
        }
        if (beforeLines.length > 0) {
          beforeLine = beforeLines.join(" ");
        }

        const afterLines = [];
        for (let j = 1; j <= 4 && i + j < transcript.length; j++) {
          afterLines.push(transcript[i + j].text);
        }
        if (afterLines.length > 0) {
          afterLine = afterLines.join(" ");
        }

        // Get broader context (8 lines before and 12 lines after) for understanding
        const startIdx = Math.max(0, i - 8);
        const endIdx = Math.min(transcript.length - 1, i + 12);
        for (let j = startIdx; j <= endIdx; j++) {
          contextLines.push(transcript[j].text);
        }
        break;
      }
    }

    if (!matchedLine) {
      // Fallback: use the last line if timestamp is beyond transcript
      matchedLine = transcript[transcript.length - 1];
      matchedIndex = transcript.length - 1;

      // Get buffer sentence (only before, since we're at the end)
      const beforeLines = [];
      for (let j = 1; j <= 2 && matchedIndex - j >= 0; j++) {
        beforeLines.unshift(transcript[matchedIndex - j].text);
      }
      if (beforeLines.length > 0) {
        beforeLine = beforeLines.join(" ");
      }

      const startIdx = Math.max(0, matchedIndex - 8);
      for (let j = startIdx; j <= matchedIndex; j++) {
        contextLines.push(transcript[j].text);
      }
    }

    // Clean up the text with DeepSeek.
    const cleanedText = await cleanupNoteText(
      matchedLine.text,
      beforeLine,
      afterLine,
      contextLines.join(" "),
      videoTitle,
    );

    // Format timestamp as MM:SS
    const minutes = Math.floor(safeTimestamp / 60);
    const seconds = safeTimestamp % 60;
    const formattedTimestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    // Create timestamped URL
    const timestampedUrl = `${canonicalVideoUrl}&t=${safeTimestamp}s`;

    // Create the note object
    const note = {
      id: `note_${Date.now()}`,
      videoId: videoId,
      videoTitle:
        typeof videoTitle === "string"
          ? videoTitle.slice(0, 500)
          : "Untitled Video",
      channelName:
        typeof channelName === "string" ? channelName.slice(0, 300) : "",
      timestamp: formattedTimestamp,
      timestampSeconds: safeTimestamp,
      timestampedUrl: timestampedUrl,
      text: cleanedText,
      rawText: matchedLine.text,
      createdAt: Date.now(),
    };

    // Save to storage
    await saveNoteToStorage(note);

    // Notify side panel to refresh notes list
    chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});

    return { success: true, note };
  } catch (error) {
    console.error("[YouTube Digest] Save note error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Cleans up transcript lines using DeepSeek.
 * Takes the target line plus buffer sentences (1 before, 1 after).
 * Uses JSON output to prevent any preambles from appearing.
 */
async function cleanupNoteText(
  targetText,
  beforeText,
  afterText,
  fullContext,
  videoTitle,
) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    return [beforeText, targetText, afterText].filter(Boolean).join(" ");
  }

  try {
    debugLog("[YouTube Digest] Requesting note cleanup");
    const variables = {
      videoTitle: videoTitle || "Unknown",
      fullContext,
      beforeText: beforeText || "(none)",
      targetText,
      afterText: afterText || "(none)",
    };
    const systemPrompt = await loadPromptSection(
      "note-cleanup.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "note-cleanup.md",
      "User prompt",
      variables,
    );
    const { text: resultText } = await requestAiCompletion({
      maxTokens: 512,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    let result = resultText.trim() || targetText;

    // Parse the JSON response (tolerating trailing commas / fences).
    try {
      const parsed = parseLooseJson(result);
      if (typeof parsed.quote === "string" && parsed.quote.trim()) {
        return parsed.quote.trim().slice(0, 3000);
      }
    } catch (parseError) {
      console.warn(
        "[YouTube Digest] JSON parse failed for note, stripping preambles:",
        parseError,
      );
      result = result.replace(
        /^(Here'?s?( the)?( cleaned)?( version)?:?\s*)/i,
        "",
      );
      result = result.replace(
        /^(The cleaned (quote|text|version)( is)?:?\s*)/i,
        "",
      );
      result = result.replace(/^(I will.*?:?\s*)/i, "");
      result = result.replace(/^(Cleaned:?\s*)/i, "");
      result = result.replace(/^["']|["']$/g, "");
    }

    return result.slice(0, 3000);
  } catch (e) {
    console.error("[YouTube Digest] Cleanup error:", e);
  }

  // Return combined raw text if cleanup fails
  return [beforeText, targetText, afterText].filter(Boolean).join(" ");
}

/**
 * Saves a note to chrome.storage.local
 */
async function saveNoteToStorage(note) {
  const result = await chrome.storage.local.get("ytd_notes");
  const notes = result.ytd_notes || [];
  notes.unshift(note); // Add to beginning (newest first)

  // Keep only last 100 notes to prevent storage bloat
  if (notes.length > 100) {
    notes.splice(100);
  }

  await chrome.storage.local.set({ ytd_notes: notes });
}

/**
 * Gets notes from storage, optionally filtered by video ID
 */
async function handleGetNotes(videoId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];

    if (videoId) {
      notes = notes.filter((n) => n.videoId === videoId);
    }

    return { success: true, notes };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Deletes a note by ID
 */
async function handleDeleteNote(noteId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];
    notes = notes.filter((n) => n.id !== noteId);
    await chrome.storage.local.set({ ytd_notes: notes });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleExplainSelection(
  selectedText,
  transcriptContext,
  videoTitle,
) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "DeepSeek API key not configured.",
      };
    }

    const variables = {
      videoTitle: videoTitle || "Unknown",
      selectedText,
      transcriptContext: transcriptContext || "None",
    };
    const systemPrompt = await loadPromptSection(
      "explain.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "explain.md",
      "User prompt",
      variables,
    );

    debugLog("[YouTube Digest] Requesting selection explanation");
    const { text: explanation } = await requestAiCompletion({
      maxTokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    return {
      success: true,
      explanation: explanation.trim(),
    };
  } catch (error) {
    console.error("Explain selection error:", error);
    return {
      success: false,
      error: error.message || "Failed to explain selection",
    };
  }
}

// ============================================================
// TRANSLATION — Translate transcript batches into Simplified Chinese
// ============================================================
// Uses a low temperature for consistent, natural translations.

/**
 * Shared base rules that every translation prompt includes.
 * These ensure translations sound natural rather than machine-translated.
 *
 * @param {string} targetLanguage - Must be 'zh'
 * @returns {Promise<string>} - The base translation rules
 */
async function getTranslationBaseRules(targetLanguage) {
  if (targetLanguage !== "zh") {
    throw new Error(`Unsupported translation target: ${targetLanguage}`);
  }
  const langName = "Simplified Chinese";
  const langSpecific = await loadPromptSection(
    "translation.md",
    "Chinese rules",
  );
  return loadPromptSection("translation.md", "Shared base rules", {
    langName,
    langSpecific,
  });
}

function validateTranscriptBatchRequest(content) {
  const segments = content?.segments;
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 4) {
    throw new Error("Transcript translation requires 1 to 4 segments");
  }

  const seenIds = new Set();
  let totalCharacters = 0;
  const normalized = segments.map((segment) => {
    const id = typeof segment?.id === "string" ? segment.id.trim() : "";
    const text = typeof segment?.text === "string" ? segment.text.trim() : "";
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id) || seenIds.has(id)) {
      throw new Error("Transcript translation segment IDs must be unique and stable");
    }
    if (!text || text.length > 4000) {
      throw new Error("Transcript translation segment text is invalid or too long");
    }
    seenIds.add(id);
    totalCharacters += text.length;
    return { id, text };
  });
  if (totalCharacters > 12000) {
    throw new Error("Transcript translation batch is too large");
  }
  return normalized;
}

function looksLikeChineseTranslation(text, sourceText) {
  const latinLetters = (sourceText.match(/[A-Za-z]/g) || []).length;
  if (latinLetters < 20) return true;
  return /[\u3400-\u9fff]/.test(text);
}

/**
 * Aligns untrusted model output by exact stable ID. Missing, duplicated,
 * unknown, empty, or clearly non-Chinese values become explicit row errors.
 */
function normalizeTranslatedSegmentBatch(parsed, sourceSegments) {
  const candidates = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const sourceById = new Map(sourceSegments.map((segment) => [segment.id, segment]));
  const translatedById = new Map();

  candidates.forEach((candidate) => {
    if (
      typeof candidate?.id !== "string" ||
      typeof candidate?.text !== "string" ||
      !sourceById.has(candidate.id) ||
      translatedById.has(candidate.id)
    ) {
      return;
    }
    const text = candidate.text.trim();
    const source = sourceById.get(candidate.id);
    if (text && looksLikeChineseTranslation(text, source.text)) {
      translatedById.set(candidate.id, text);
    }
  });

  return {
    segments: sourceSegments.map((source) => ({
      id: source.id,
      text: translatedById.get(source.id) || "",
      error: translatedById.has(source.id)
        ? ""
        : "Missing or invalid Chinese translation",
    })),
  };
}

/**
 * Translates content using DeepSeek.
 * @param {Object} content - JSON object containing semantic transcript segments
 * @param {string} contentType - 'transcriptBatch' or 'interfaceBatch'
 * @param {string} targetLanguage - 'zh' for Simplified Chinese
 * @param {string} videoTitle - The video title (for context)
 * @returns {Object} - { success, translatedContent } or { success: false, error }
 */
async function handleTranslateContent(
  content,
  contentType,
  targetLanguage,
  videoTitle,
) {
  try {
    if (targetLanguage !== "zh") {
      return {
        success: false,
        error: `Unsupported translation target: ${String(targetLanguage)}`,
      };
    }
    if (!["transcriptBatch", "interfaceBatch"].includes(contentType)) {
      return {
        success: false,
        error: `Unsupported translation content type: ${String(contentType)}`,
      };
    }

    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return { success: false, error: "DeepSeek API key not configured" };
    }

    const sourceSegments = validateTranscriptBatchRequest(content);
    const langName = "Simplified Chinese";
    const baseRules = await getTranslationBaseRules(targetLanguage);
    const promptSection =
      contentType === "transcriptBatch"
        ? "Transcript batch translation"
        : "Interface content translation";
    const systemPrompt = await loadPromptSection(
      "translation.md",
      promptSection,
      {
        langName,
        videoTitle: videoTitle || "Unknown",
        baseRules,
      },
    );
    const userContent = JSON.stringify({ segments: sourceSegments });
    const translationOptions = {
      temperature: 0.2,
      maxTokens: 1536,
      responseFormat: { type: "json_object" },
    };
    let result = await callAiTranslation(
      systemPrompt,
      userContent,
      translationOptions,
    );

    // DeepSeek JSON mode can rarely return an empty content string. The prompt
    // already requires JSON, so retry once without response_format.
    if (!result.success && result.code === "EMPTY_AI_RESPONSE") {
      result = await callAiTranslation(systemPrompt, userContent, {
        temperature: translationOptions.temperature,
        maxTokens: translationOptions.maxTokens,
      });
    }
    if (!result.success) return result;

    const parsed = parseLooseJson(result.text);
    const aligned = normalizeTranslatedSegmentBatch(parsed, sourceSegments);
    if (!aligned.segments.some((segment) => segment.text)) {
      return {
        success: false,
        error: "Translation returned no valid Chinese segments",
      };
    }
    return { success: true, translatedContent: aligned };
  } catch (error) {
    console.error("[YouTube Digest] Translation error:", error);
    return { success: false, error: error.message || "Translation failed" };
  }
}

/**
 * Makes a single DeepSeek call for translation.
 * Uses temperature 0.3 for consistent, predictable translations.
 *
 * @param {string} systemPrompt - The system-level instructions
 * @param {string} userContent - The user message (content to translate)
 * @returns {Object} - { success, text } or { success: false, error }
 */
async function callAiTranslation(
  systemPrompt,
  userContent,
  { temperature = 0.3, maxTokens = 8192, responseFormat } = {},
) {
  try {
    const { text } = await requestAiCompletion({
      temperature,
      maxTokens,
      responseFormat,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    });

    return { success: true, text };
  } catch (error) {
    if (error.status === 429) {
      return {
        success: false,
        error: "Rate limited — try again in a moment",
        code: "RATE_LIMITED",
      };
    }
    return { success: false, error: error.message, code: error.code };
  }
}

// Pure validators are exposed for the repository's Node tests only.
globalThis.__YTD_TRANSLATION_TESTING__ = {
  requestAiCompletion,
  callAiTranslation,
  validateTranscriptBatchRequest,
  normalizeTranslatedSegmentBatch,
  handleSaveNote,
  handleTranslateContent,
  closePanelForTab,
  updatePanelForTab,
};

// Keyboard shortcut (default Alt+Shift+9): invoking a command grants
// activeTab on the current tab, exactly like clicking the toolbar icon.
// This gives tab audio capture a second, always-visible invocation path.
chrome.commands?.onCommand.addListener((command) => {
  if (command !== "invoke-capture") return;
  chrome.tabs
    .query({ active: true, currentWindow: true })
    .then(([tab]) => {
      if (!tab) return;
      chrome.storage.local.set({ ytd_last_invoke: Date.now() });
      // Same effect as clicking the icon: activeTab is now granted, so let the
      // panel resume a capture that was waiting for this.
      chrome.runtime
        .sendMessage({ action: "extensionInvoked", tabId: tab.id })
        .catch(() => {});
    });
});
