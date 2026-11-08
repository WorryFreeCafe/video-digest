/**
 * offscreen.js — MV3 Offscreen Document for tab audio capture.
 *
 * Chrome MV3 service workers have no DOM and no MediaRecorder, so all recording
 * happens here, in a real (invisible) extension page. The service worker calls
 * chrome.tabCapture.getMediaStreamId(), passes the stream id to this document,
 * and we turn it into a MediaStream with getUserMedia().
 *
 * Message handled:
 *   recordTabAudio -> { success, text } | { success: false, error }
 */
(function () {
  const DEFAULT_WHISPER_URL = "http://127.0.0.1:8000";

  /** Turn a tabCapture stream id into an audio-only MediaStream. */
  function openTabAudioStream(streamId) {
    if (!streamId) {
      return Promise.reject(new Error("Missing tab capture stream id."));
    }
    return navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
  }

  /** Record a fixed window of audio into a WebM blob. */
  function recordStream(stream, seconds) {
    return new Promise((resolve, reject) => {
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "";
      let recorder;
      try {
        recorder = new MediaRecorder(
          stream,
          mimeType ? { mimeType } : undefined,
        );
      } catch (error) {
        reject(error);
        return;
      }

      const chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = (event) =>
        reject(new Error(event.error?.message || "Audio recording failed."));
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
        if (!blob.size) {
          reject(new Error("Recording produced no audio. Is the video playing?"));
          return;
        }
        resolve(blob);
      };

      recorder.start(1000); // emit chunks every second
      setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
      }, seconds * 1000);
    });
  }

  /** Upload the recording to the local Whisper service and return its text. */
  async function transcribe(blob, whisperUrl, model) {
    const base = String(whisperUrl || DEFAULT_WHISPER_URL).replace(/\/+$/, "");
    const form = new FormData();
    form.append("file", blob, "capture.webm");
    form.append("model", model || "small");

    const response = await fetch(`${base}/transcribe`, {
      method: "POST",
      body: form,
    });
    let data = {};
    try {
      data = await response.json();
    } catch (_error) {
      /* keep the status-based error below */
    }
    if (!response.ok) {
      throw new Error(
        data.message || data.error || `Whisper service returned ${response.status}`,
      );
    }
    if (!data.text) {
      // HTTP 200 with an empty transcript means the audio track was silent:
      // the tab was paused, muted, or the video had not started playing yet.
      throw new Error(
        "没有识别到语音：请确认视频正在播放且有声音（未静音），然后重试。",
      );
    }
    return data.text;
  }

  async function recordTabAudio(options = {}) {
    const seconds = Number(options.seconds) || 30;
    const stream = await openTabAudioStream(options.streamId);
    try {
      const blob = await recordStream(stream, seconds);
      const text = await transcribe(
        blob,
        options.whisperUrl,
        options.model,
      );
      return { success: true, text };
    } finally {
      stream.getTracks().forEach((track) => track.stop());
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action !== "recordTabAudio") return false;
    recordTabAudio(message.options || {})
      .then(sendResponse)
      .catch((error) =>
        sendResponse({ success: false, error: error.message || String(error) }),
      );
    return true; // asynchronous sendResponse
  });
})();
