/**
 * whisper-client.js — 本地 Whisper 服务探活（Service Worker 专用）
 *
 * 插件在无原生字幕时会退到本地 faster-whisper（whisper/whisper_server.py）。
 * 那个服务是用户自己启动的进程，随时可能没开、端口被占、或者地址填错。如果
 * 不先探活，用户会先等 30 秒录音，再收到一句"转录失败: Failed to fetch"。
 *
 * 这里只做一件事：请求 `GET {base}/health`，把结果翻译成可操作的结论。没有
 * DOM 依赖，可以用假的 fetch 直接单测。
 *
 * 探活结论（status）：
 *   running    服务在线，能读到 /health
 *   unreachable 连不上（进程没启动 / 端口不对 / 被防火墙拦）
 *   timeout     有连接但超过超时时间没回
 *   http-error  地址有响应但 /health 返回非 2xx（通常是地址指向了别的服务）
 *   unexpected  有响应但不是 whisper_server.py 的返回结构
 */
var YTD_WHISPER_CLIENT = (() => {
  const DEFAULT_BASE_URL = "http://127.0.0.1:8000";
  const DEFAULT_TIMEOUT_MS = 2500;

  /**
   * 把用户填的地址规范成 `scheme://host:port` 形式，去掉尾部斜杠。
   * 空值回落到默认地址，缺 scheme 时补 http://（本地服务不会是 https）。
   * @param {string} url
   * @param {string} [fallback]
   * @returns {string}
   */
  function normalizeBaseUrl(url, fallback = DEFAULT_BASE_URL) {
    const raw = String(url == null ? "" : url).trim();
    if (!raw) return fallback;
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    return withScheme.replace(/\/+$/, "");
  }

  /**
   * @param {{fetchImpl?: Function, timeoutMs?: number, now?: Function}} [options]
   */
  function createWhisperClient(options = {}) {
    const timeoutMs = Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const doFetch =
      typeof options.fetchImpl === "function"
        ? options.fetchImpl
        : (...args) => fetch(...args);

    /**
     * 探测一次。永远 resolve，不抛异常：调用方只关心结论，不需要 try/catch。
     * @param {string} url
     * @returns {Promise<Object>}
     */
    async function probe(url) {
      const base = normalizeBaseUrl(url);
      const startedAt = now();
      const controller =
        typeof AbortController === "function" ? new AbortController() : null;
      const timer = setTimeout(() => {
        try {
          controller?.abort();
        } catch (_e) {
          /* abort 只影响这次探活 */
        }
      }, timeoutMs);

      try {
        const response = await doFetch(`${base}/health`, {
          method: "GET",
          cache: "no-store",
          signal: controller ? controller.signal : undefined,
        });
        const elapsedMs = now() - startedAt;

        if (!response || !response.ok) {
          const httpStatus = response ? Number(response.status) || 0 : 0;
          return {
            ok: false,
            status: "http-error",
            httpStatus,
            url: base,
            elapsedMs,
            error: `HTTP ${httpStatus}`,
            message: `${base} 有响应，但 /health 返回 HTTP ${httpStatus}。请确认地址指向 whisper_server.py，而不是别的服务。`,
          };
        }

        let payload = null;
        try {
          payload = await response.json();
        } catch (_e) {
          payload = null;
        }

        if (!payload || payload.status !== "ok") {
          return {
            ok: false,
            status: "unexpected",
            httpStatus: Number(response.status) || 0,
            url: base,
            elapsedMs,
            error: "unexpected health payload",
            message: `${base} 有响应，但返回内容不像本地 Whisper 服务。请核对地址、端口，以及是否启动了 whisper_server.py。`,
          };
        }

        const model = payload.model || null;
        return {
          ok: true,
          status: "running",
          url: base,
          elapsedMs,
          model,
          message: model
            ? `已连接，当前模型 ${model}`
            : "已连接。模型会在第一次转录时自动加载。",
        };
      } catch (error) {
        const elapsedMs = now() - startedAt;
        const name = String(error?.name || "");
        if (name === "AbortError" || name === "TimeoutError") {
          return {
            ok: false,
            status: "timeout",
            url: base,
            elapsedMs,
            error: "timeout",
            message: `${base} 在 ${timeoutMs}ms 内没有响应。服务可能正在加载模型，或端口被其他程序占用。`,
          };
        }
        return {
          ok: false,
          status: "unreachable",
          url: base,
          elapsedMs,
          error: String(error?.message || error),
          message: `连不上 ${base}。请先启动 whisper/whisper_server.py，再点“检查连接”。`,
        };
      } finally {
        clearTimeout(timer);
      }
    }

    return { probe, timeoutMs };
  }

  return {
    DEFAULT_BASE_URL,
    DEFAULT_TIMEOUT_MS,
    normalizeBaseUrl,
    createWhisperClient,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_WHISPER_CLIENT;
}
