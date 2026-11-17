const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const client = require("../whisper-client.js");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("base URLs are normalised before probing", () => {
  assert.equal(
    client.normalizeBaseUrl("http://127.0.0.1:8000/"),
    "http://127.0.0.1:8000",
  );
  assert.equal(client.normalizeBaseUrl("127.0.0.1:9000"), "http://127.0.0.1:9000");
  assert.equal(client.normalizeBaseUrl("  http://localhost:8001//  "), "http://localhost:8001");
  assert.equal(client.normalizeBaseUrl(""), client.DEFAULT_BASE_URL);
  assert.equal(client.normalizeBaseUrl(null), client.DEFAULT_BASE_URL);
});

test("a healthy server reports the loaded model", async () => {
  const calls = [];
  const probe = client.createWhisperClient({
    fetchImpl: async (url) => {
      calls.push(url);
      return jsonResponse({ status: "ok", model: "small" });
    },
    now: (() => {
      let t = 0;
      return () => (t += 12);
    })(),
  });

  const result = await probe.probe("http://127.0.0.1:8000/");
  assert.equal(result.ok, true);
  assert.equal(result.status, "running");
  assert.equal(result.model, "small");
  assert.equal(result.url, "http://127.0.0.1:8000");
  assert.equal(result.elapsedMs, 12);
  assert.deepEqual(calls, ["http://127.0.0.1:8000/health"]);
});

test("a healthy server that has not loaded a model yet is still running", async () => {
  const probe = client.createWhisperClient({
    fetchImpl: async () => jsonResponse({ status: "ok", model: null }),
  });

  const result = await probe.probe("http://127.0.0.1:8000");
  assert.equal(result.ok, true);
  assert.equal(result.model, null);
  assert.match(result.message, /第一次转录/);
});

test("a closed port is reported as unreachable, not as a transcription failure", async () => {
  const probe = client.createWhisperClient({
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
  });

  const result = await probe.probe("http://127.0.0.1:8000");
  assert.equal(result.ok, false);
  assert.equal(result.status, "unreachable");
  assert.match(result.message, /启动/);
  assert.match(result.message, /whisper_server\.py/);
});

test("a silent server times out instead of waiting forever", async () => {
  const probe = client.createWhisperClient({
    timeoutMs: 30,
    fetchImpl: (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });

  const result = await probe.probe("http://127.0.0.1:8000");
  assert.equal(result.ok, false);
  assert.equal(result.status, "timeout");
});

test("an address serving something else points at the wrong port", async () => {
  const notWhisper = await client
    .createWhisperClient({ fetchImpl: async () => jsonResponse({}, 404) })
    .probe("http://127.0.0.1:8000");
  assert.equal(notWhisper.status, "http-error");
  assert.equal(notWhisper.httpStatus, 404);
  assert.match(notWhisper.message, /404/);

  const wrongPayload = await client
    .createWhisperClient({
      fetchImpl: async () => jsonResponse({ hello: "world" }),
    })
    .probe("http://127.0.0.1:8000");
  assert.equal(wrongPayload.status, "unexpected");
  assert.match(wrongPayload.message, /不像本地 Whisper 服务/);
});

test("probing never throws, even when the fetch implementation does", async () => {
  const probe = client.createWhisperClient({
    fetchImpl: () => {
      throw new Error("synchronous explode");
    },
  });

  const result = await probe.probe("nonsense-address");
  assert.equal(result.ok, false);
  assert.equal(result.status, "unreachable");
  assert.equal(result.url, "http://nonsense-address");
});

test("the background checks the server before it starts recording", () => {
  const source = read("background.js");
  assert.match(source, /importScripts\("settings\.js", "subtitle-sources\.js", "whisper-client\.js"\)/);

  const probeAt = source.indexOf("getWhisperClient().probe(cfg.whisperServerUrl)");
  const recordAt = source.indexOf("captureViaOffscreen(tabId");
  assert.ok(probeAt > 0, "the capture path must probe the server");
  assert.ok(
    probeAt < recordAt,
    "the probe has to run before 30 seconds of audio are recorded",
  );

  assert.match(source, /WHISPER_UNREACHABLE/);
  assert.match(source, /WHISPER_TIMEOUT/);
  assert.match(source, /canOpenWhisperGuide: true/);
});

test("the panel turns an unreachable server into a setup action", () => {
  const script = read("sidepanel.js");
  const html = read("sidepanel.html");

  assert.match(html, /id="errorSecondaryBtn"/);
  assert.match(script, /function setErrorSecondary/);
  assert.match(script, /Local Whisper is not running/);
  assert.match(script, /action: "openWhisperGuide"/);
  assert.match(script, /WHISPER_UNREACHABLE/);
  assert.match(
    script,
    /getElementById\("errorSecondaryBtn"\)[\s\S]{0,80}errorSecondaryAction/,
  );
});

test("settings can probe the typed URL without saving first", () => {
  const html = read("options.html");
  const script = read("options.js");
  const background = read("background.js");

  assert.match(html, /id="whisperCheckBtn"/);
  assert.match(html, /id="whisperGuideLink"/);
  assert.match(html, /href="whisper-guide\.html"/);
  assert.match(script, /action: "whisperHealth"/);
  assert.match(script, /url: whisperServerUrlInput \? whisperServerUrlInput\.value : ""/);
  assert.match(background, /handleWhisperHealth\(message\.url\)/);
  // Probe results are rendered from translation keys, not from a hardcoded
  // Chinese sentence, so switching language re-renders the verdict too.
  assert.match(script, /whisperUnreachable/);
  assert.match(script, /"zh-CN"[\s\S]*whisperUnreachable/);
});

test("the guide page is offline, bilingual, and copyable", () => {
  const html = read("whisper-guide.html");
  const script = read("whisper-guide.js");

  assert.match(html, /data-lang="en"/);
  assert.match(html, /data-lang="zh-CN"/);
  assert.match(html, /whisper\/requirements\.txt/);
  assert.match(html, /whisper\/whisper_server\.py/);
  assert.match(html, /\/health/);
  assert.match(html, /HF_ENDPOINT/);
  for (const model of ["tiny", "base", "small", "medium", "large-v3"]) {
    assert.match(html, new RegExp(`<code>${model}</code>`));
  }
  // MV3 pages forbid inline script, so the behaviour must live in its own file.
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/);
  assert.match(html, /<script src="whisper-guide\.js">/);
  assert.match(script, /navigator\.clipboard/);
  assert.match(script, /openOptionsPage/);
  assert.equal(
    fs.existsSync(path.join(root, "whisper-guide.css")),
    true,
    "the guide needs its stylesheet",
  );
});

test("every new runtime file ships in the release package", () => {
  const check = read("scripts/check-release.sh");
  for (const file of [
    "whisper-client.js",
    "whisper-guide.html",
    "whisper-guide.css",
    "whisper-guide.js",
  ]) {
    assert.match(check, new RegExp(`"${file.replace(/\./g, "\\.")}"`));
  }
});

test("probing works against a real HTTP endpoint", async () => {
  const server = http.createServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end("nope");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", model: "base" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const result = await client
      .createWhisperClient()
      .probe(`http://127.0.0.1:${port}`);
    assert.equal(result.ok, true);
    assert.equal(result.status, "running");
    assert.equal(result.model, "base");
    assert.ok(result.elapsedMs >= 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a refused connection maps to the start-the-server hint", async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  const result = await client
    .createWhisperClient({ timeoutMs: 1000 })
    .probe(`http://127.0.0.1:${port}`);
  assert.equal(result.ok, false);
  assert.equal(result.status, "unreachable");
  assert.match(result.message, /whisper_server\.py/);
});
