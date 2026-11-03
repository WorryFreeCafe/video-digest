/**
 * generic-video-probe.js — 通用 HTML5 <video> 字幕探测与音频捕获
 *
 * 注入范围：<all_urls>（配合 manifest 第二段 content_scripts）。
 * 只处理浏览器原生的 <track>/video.textTracks 字幕，以及从视频元素捕获
 * 当前播放音频供本地 Whisper 转录。站点专属逻辑（YouTube captionTracks、
 * B站字幕接口）由 content.js 负责，避免重复注入。
 *
 * 消息：
 *   - probeGenericSubtitle  -> 返回页面 video.textTracks 中可用的字幕 cues
 *   - captureAudio          -> 用 captureStream+MediaRecorder 捕获当前播放
 *                              音频窗口，POST 到本地 whisper 服务，返回转录文本
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

  /**
   * 捕获当前播放音频并交给本地 whisper 服务转录。
   * 受浏览器限制：只能捕获"当前正在播放"的一段音频（captureStream），
   * DRM/加密流、未开始播放的视频无法获得音轨。第一版捕获固定时长窗口。
   * @param {Object} options { seconds, whisperUrl, model }
   */
  async function captureAndTranscribe(options = {}) {
    const video = Array.from(document.querySelectorAll("video")).find(
      (v) => v.readyState >= 2 && !v.paused && v.srcObject != null,
    );
    if (!video) {
      // 退而求其次：找任意可播放元素（即使未开始播放）
      return {
        success: false,
        error: "NO_AUDIO_SOURCE",
        message:
          "没有可捕获音频的视频元素（视频需已开始播放且未加密）。请先播放视频。",
      };
    }
    let stream;
    try {
      stream = video.captureStream();
    } catch (e) {
      return {
        success: false,
        error: "CAPTURE_STREAM_FAILED",
        message: "无法捕获该视频音频，可能是 DRM/加密流。",
      };
    }
    const audioTrack = (stream.getAudioTracks && stream.getAudioTracks())[0];
    if (!audioTrack) {
      return {
        success: false,
        error: "NO_AUDIO_TRACK",
        message: "该视频没有可捕获的音轨。",
      };
    }

    const seconds = Number(options.seconds) || 120;
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "";
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    const chunks = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    };
    const done = new Promise((resolve, reject) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: "audio/webm" }));
      recorder.onerror = (ev) => reject(new Error(ev.error?.message || "record error"));
    });

    recorder.start();
    await new Promise((r) => setTimeout(r, seconds * 1000));
    recorder.stop();
    const blob = await done;

    const whisperUrl = (options.whisperUrl || "http://127.0.0.1:8000")
      .replace(/\/+$/, "");
    const model = options.model || "small";

    const form = new FormData();
    form.append("file", blob, "capture.webm");
    form.append("model", model);

    try {
      const resp = await fetch(`${whisperUrl}/transcribe`, {
        method: "POST",
        body: form,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.text) {
        return {
          success: false,
          error: "WHISPER_SERVICE_ERROR",
          message: data.message || `Whisper 服务返回 ${resp.status}`,
        };
      }
      return { success: true, text: data.text };
    } catch (e) {
      return {
        success: false,
        error: "WHISPER_UNREACHABLE",
        message: `无法连接本地 Whisper 服务（${whisperUrl}）：${e.message}`,
      };
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === "probeGenericSubtitle") {
      sendResponse(collectNativeTracks());
      return false;
    }
    if (message.action === "captureAudio") {
      captureAndTranscribe(message.options || {}).then(sendResponse);
      return true; // 异步
    }
    return false;
  });
})();
