/**
 * generic-video-probe.js — 通用 HTML5 <video> 字幕探测
 *
 * 注入范围：<all_urls>（配合 manifest 中的 content_scripts）。
 * 只处理浏览器原生的 <track>/video.textTracks 字幕。站点专属逻辑
 * （YouTube captionTracks、B站字幕接口）由 content.js 负责，避免重复注入。
 *
 * 消息：
 *   - probeGenericSubtitle  -> 返回页面 video.textTracks 中可用的字幕 cues
 */
(function () {
  if (window.__YTD_GENERIC_PROBE__) return;
  window.__YTD_GENERIC_PROBE__ = true;

  /** 收集页面上所有 <video> 的原生字幕 cues。 */
  function collectNativeTracks() {
    const videos = Array.from(document.querySelectorAll("video"));
    for (const video of videos) {
      const tracks = Array.from(video.textTracks || []);
      const usable = tracks.filter(
        (t) =>
          (t.kind === "subtitles" || t.kind === "captions") &&
          t.cues &&
          t.cues.length > 0,
      );
      if (usable.length === 0) continue;
      // 取第一条可用字幕轨，转换为 chunks
      const cues = Array.from(usable[0].cues)
        .map((cue) => ({
          start: Number(cue.startTime) || 0,
          text: String(cue.text || ""),
        }))
        .filter((c) => c.text.trim());
      if (cues.length === 0) continue;
      return { found: true, chunks: cues, label: usable[0].label || "" };
    }
    // 兜底：也检查 <track> 标签（即使 textTracks 尚未加载）
    const trackEls = Array.from(
      document.querySelectorAll(
        'video track[kind="subtitles"], video track[kind="captions"]',
      ),
    );
    if (trackEls.length > 0 && trackEls[0].src) {
      return { found: false, deferredTrack: trackEls[0].src };
    }
    return { found: false, chunks: [] };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === "probeGenericSubtitle") {
      sendResponse(collectNativeTracks());
      return false;
    }
    return false;
  });
})();
