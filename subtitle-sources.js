/**
 * subtitle-sources.js — 字幕来源路由模块（Service Worker / Content 共用）
 *
 * 负责"先本地探测、再按来源取字幕"的统一编排。来源优先级：
 *   1. platform  — 平台原生字幕（YouTube captionTracks / B站字幕接口 /
 *                 通用 HTML5 <track> 与 video.textTracks），免费
 *   2. whisper   — 无原生字幕时，捕获视频音频走本地 faster-whisper 服务转录
 *
 * 该文件同时被 background.js（importScripts）和 content.js（content_scripts
 * 注入）加载，因此内部用全局命名空间挂载，不含任何 DOM 直接依赖；DOM 相关
 * 逻辑全部由 content.js 实现后回传数据。
 */
var YTD_SUBTITLE_SOURCES = (() => {
  /**
   * 识别当前站点类型，决定走哪条字幕探测路径。
   * @param {string} url 当前页面 URL
   * @returns {"youtube"|"bilibili"|"generic"}
   */
  function detectSite(url = "") {
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
      if (host === "youtube.com" || host.endsWith(".youtube.com")) {
        return "youtube";
      }
      if (host === "bilibili.com" || host.endsWith(".bilibili.com")) {
        return "bilibili";
      }
      return "generic";
    } catch (_e) {
      return "generic";
    }
  }

  /**
   * 从 URL 提取视频 ID（不同站点规则不同）。
   * @param {string} url
   * @returns {string|null}
   */
  function extractVideoId(url = "") {
    try {
      const u = new URL(url);
      const site = detectSite(url);
      if (site === "youtube") {
        return u.searchParams.get("v");
      }
      if (site === "bilibili") {
        // 支持 BV 号 / av 号，如 /video/BV1xx... 或 /video/av12345
        const m = u.pathname.match(/^\/video\/(BV[0-9A-Za-z]+|av\d+)/);
        return m ? m[1] : null;
      }
      // 通用站点无法可靠推断，返回 null
      return null;
    } catch (_e) {
      return null;
    }
  }

  /**
   * 把"页面已探测到的原生字幕"统一转成内部 transcript 结构。
   * 两种输入形态都兼容：
   *   - chunks: [{ start(秒), text }]（textTracks cues / B站 body / caption）
   *   - 数组直接作为 chunks
   * @param {Array<{start:number,text:string}>} chunks
   * @returns {{transcript:Array, transcriptText:string, transcriptTextTimestamped:string, language:string|null}}
   */
  function buildTranscriptFromChunks(chunks = []) {
    const transcript = [];
    let plain = "";
    let timestamped = "";

    for (const item of chunks) {
      const raw = typeof item === "string" ? item : item?.text;
      const text = String(raw == null ? "" : raw).replace(/>> ?/g, "").trim();
      if (!text) continue;

      const startSeconds = Number(
        typeof item === "object" && item.start != null ? item.start : 0,
      );
      const s = Math.max(0, Math.floor(startSeconds));
      const minutes = Math.floor(s / 60);
      const seconds = s % 60;
      const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

      transcript.push({
        text,
        start: s,
        duration: 0,
        language: typeof item === "object" ? item.language ?? null : null,
      });
      plain += text + " ";
      timestamped += `[${timestamp}] ${text}\n`;
    }

    return {
      transcript,
      transcriptText: plain.trim(),
      transcriptTextTimestamped: timestamped.trim(),
      language: null,
    };
  }

  /**
   * 把一份已就绪的字幕文本（无时间轴，例如 Whisper 输出）转成 transcript。
   * @param {string} text Whisper/纯文本字幕
   * @returns {{transcript:Array, transcriptText:string, transcriptTextTimestamped:string, language:string|null}}
   */
  function buildTranscriptFromPlainText(text = "") {
    const clean = String(text).trim();
    if (!clean) {
      return {
        transcript: [],
        transcriptText: "",
        transcriptTextTimestamped: "",
        language: null,
      };
    }
    // 纯文本整段作为一条（保留原文本，时间轴留空，标注来源）
    return {
      transcript: [{ text: clean, start: 0, duration: 0, language: null }],
      transcriptText: clean,
      transcriptTextTimestamped: clean,
      language: null,
    };
  }

  /**
   * 统一构造"来源"返回对象，供 background 直接 sendResponse。
   * @param {"platform"|"whisper"|"none"} source
   * @param {Object} payload
   */
  function sourceResult(source, payload = {}) {
    return {
      success: payload.success !== false,
      source,
      ...payload,
    };
  }

  return {
    detectSite,
    extractVideoId,
    buildTranscriptFromChunks,
    buildTranscriptFromPlainText,
    sourceResult,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SUBTITLE_SOURCES;
}
