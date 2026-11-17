/**
 * whisper-guide.js — 安装指南页的交互
 *
 * 只做三件小事：切换中英文、复制命令、跳回设置页。没有网络请求，也没有
 * 第三方脚本，页面在离线时同样可用。
 */
(() => {
  const LANGUAGE_KEY = "ytd_whisper_guide_language";
  const COPY = {
    en: {
      copy: "Copy",
      copied: "Copied",
      copyFailed: "Select and copy manually",
      openSettings: "Open Settings",
      title: "Local Whisper setup · YouTube Digest",
    },
    "zh-CN": {
      copy: "复制",
      copied: "已复制",
      copyFailed: "请手动选中复制",
      openSettings: "打开设置",
      title: "本地 Whisper 安装与启动 · YouTube Digest",
    },
  };

  const blocks = [...document.querySelectorAll(".lang-block")];
  const buttons = [...document.querySelectorAll(".lang-btn")];
  const settingsButton = document.getElementById("openSettingsBtn");

  function normalize(language) {
    return String(language || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  }

  function applyLanguage(language) {
    const next = normalize(language);
    document.documentElement.lang = next;
    document.title = COPY[next].title;
    for (const block of blocks) {
      block.hidden = block.dataset.lang !== next;
    }
    for (const button of buttons) {
      const active = button.dataset.lang === next;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    for (const button of document.querySelectorAll(".copy-btn")) {
      if (button.dataset.busy === "1") continue;
      button.textContent = COPY[next].copy;
    }
    if (settingsButton) settingsButton.textContent = COPY[next].openSettings;
  }

  function readLanguage() {
    try {
      return localStorage.getItem(LANGUAGE_KEY);
    } catch (_error) {
      return null;
    }
  }

  function saveLanguage(language) {
    try {
      localStorage.setItem(LANGUAGE_KEY, language);
    } catch (_error) {
      /* 隐私模式下写不进去也不影响阅读 */
    }
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    // 扩展页面里 clipboard API 偶尔不可用，退回到选区方案。
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) throw new Error("copy failed");
  }

  async function handleCopy(button) {
    const target = document.getElementById(button.dataset.copyTarget);
    if (!target) return;
    const language = normalize(document.documentElement.lang);
    const original = COPY[language].copy;
    button.dataset.busy = "1";
    try {
      await copyText(target.textContent);
      button.textContent = COPY[language].copied;
      button.classList.add("copied");
    } catch (_error) {
      button.textContent = COPY[language].copyFailed;
    }
    setTimeout(() => {
      button.dataset.busy = "0";
      button.classList.remove("copied");
      button.textContent = original;
    }, 1800);
  }

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const language = normalize(button.dataset.lang);
      applyLanguage(language);
      saveLanguage(language);
    });
  }

  for (const button of document.querySelectorAll(".copy-btn")) {
    button.addEventListener("click", () => handleCopy(button));
  }

  settingsButton?.addEventListener("click", () => {
    if (chrome?.runtime?.openOptionsPage) {
      chrome.runtime.openOptionsPage();
      return;
    }
    location.href = "options.html";
  });

  applyLanguage(readLanguage() || navigator.language);
})();
