/**
 * YouTube 字幕 pot 钩子（MAIN world）
 * ============================================================
 * YouTube 从 2025 年起对 `/api/timedtext` 增加了 proof-of-origin token
 * （URL 里的 `pot` / `potc` 参数）。没有 pot 时接口返回 **HTTP 200 但响应体为空**，
 * 这正是扩展"拿到 captionTracks 却解析出 0 条字幕"的原因。
 *
 * pot 由播放器内部的 BotGuard 生成，扩展无法自行计算。但播放器自己会带着 pot 去
 * 请求一次完整字幕文件（开启 CC 时）。这个脚本就住在页面的 MAIN world，负责：
 *   1. 挂钩 XMLHttpRequest / fetch，记住最近一次带 pot 的 timedtext URL；
 *   2. 通过 window.postMessage 把 URL 交给隔离世界的 content.js。
 *
 * 签名（sparams）只覆盖 v/ei/caps/opi/exp/xoaf，**不含 lang/tlang**，
 * 所以调用方可以自由把 lang 改成想要的语种、去掉 tlang 翻译，不需要重新签名。
 */
(() => {
  if (window.__ytdCaptionPotHooked) return;
  window.__ytdCaptionPotHooked = true;

  const CHANNEL = "ytd-caption-pot";
  let lastUrl = "";
  let lastAt = 0;

  function record(url) {
    if (!url || typeof url !== "string") return;
    if (url.indexOf("/api/timedtext") === -1) return;
    // 只认带 pot 的 URL —— 没有 pot 的请求必然拿到空响应，记住了也没用。
    if (url.indexOf("pot=") === -1) return;
    lastUrl = url;
    lastAt = Date.now();
    window.postMessage({ source: CHANNEL, type: "url", url, at: lastAt }, "*");
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__ytdCaptionUrl = typeof url === "string" ? url : "";
    } catch (_e) {
      this.__ytdCaptionUrl = "";
    }
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    try {
      if (this.__ytdCaptionUrl) record(this.__ytdCaptionUrl);
    } catch (_e) {
      /* 钩子不能影响播放器自身请求 */
    }
    return origSend.apply(this, arguments);
  };

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (...args) {
      try {
        const input = args[0];
        const url = typeof input === "string" ? input : input && input.url;
        if (url) record(url);
      } catch (_e) {
        /* noop */
      }
      return origFetch.apply(this, args);
    };
  }

  // 支持"拉取"：content.js 可能比播放器更晚启动，需要主动问一次。
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== CHANNEL || data.type !== "get") return;
    window.postMessage(
      { source: CHANNEL, type: "url", url: lastUrl, at: lastAt, id: data.id },
      "*",
    );
  });
})();
