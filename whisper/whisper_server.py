#!/usr/bin/env python3
"""
whisper_server.py — 本地 Whisper 转录服务（faster-whisper + FastAPI）

配套 video-digest Chrome 插件的"无原生字幕 → 音频转录"兜底通道。插件用
captureStream+MediaRecorder 捕获当前播放音频窗口（约 2 分钟），POST 到本服务
转成文字，再返回给插件用于 LLM 总结。

用途限制：
  - 仅用于你自己本机，密钥/隐私不离开本地。
  - 只能转录"当前正在播放"的一段音频；DRM/加密流、未开始播放的视频无法
    获得音轨，本服务也无能为力。
  - 首次运行会自动下载模型（small 约 460MB，可用 --model 换成更小/更大）。

安装与启动（推荐 Python 3.9+）：
    pip install faster-whisper fastapi uvicorn python-multipart
    python whisper_server.py [--model small] [--port 8000] [--device auto]

接口：
    POST /transcribe
        multipart: file=<音频文件>, model=<可选，覆盖默认模型>
        -> { "text": "..." }
    GET  /health -> { "status": "ok", "model": "..." }
"""

from __future__ import annotations

import argparse
import os
import tempfile
import threading
from typing import Optional

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware

MODEL_LOCK = threading.Lock()
_LOADED_MODEL: Optional[object] = None
_LOADED_MODEL_NAME: Optional[str] = None

app = FastAPI(title="local-whisper-server")

# 允许插件/本机页面跨域调用（仅本机 127.0.0.1，不外泄）。
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1",
        "http://localhost",
        "chrome-extension://*",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_model(model_name: str):
    """按需加载 faster-whisper 模型，缓存避免重复加载。"""
    global _LOADED_MODEL, _LOADED_MODEL_NAME
    with MODEL_LOCK:
        if _LOADED_MODEL is not None and _LOADED_MODEL_NAME == model_name:
            return _LOADED_MODEL
        from faster_whisper import WhisperModel

        device = os.environ.get("WHISPER_DEVICE", "auto")
        compute_type = os.environ.get("WHISPER_COMPUTE", "default")
        kwargs = {}
        if compute_type != "default":
            kwargs["compute_type"] = compute_type
        print(f"[whisper] loading model '{model_name}' on {device} ...")
        model = WhisperModel(model_name, device=device, **kwargs)
        _LOADED_MODEL = model
        _LOADED_MODEL_NAME = model_name
        return model


@app.get("/health")
def health():
    return {"status": "ok", "model": _LOADED_MODEL_NAME}


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    model: Optional[str] = Form(None),
):
    """接收音频文件，用 Whisper 转写成文本。"""
    model_name = model or _LOADED_MODEL_NAME or "small"
    suffix = os.path.splitext(file.filename or "")[1] or ".webm"

    # 落盘到临时文件（faster-whisper 需要文件路径）
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp_path = tmp.name
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                tmp.write(chunk)

        whisper = get_model(model_name)
        segments, info = whisper.transcribe(
            tmp_path,
            language=None,  # 自动检测
            vad_filter=True,  # 过滤静音，提升准确率与速度
        )

        parts = []
        for seg in segments:
            text = (seg.text or "").strip()
            if text:
                parts.append(text)
        return {"text": "\n".join(parts)}
    except Exception as exc:  # noqa: BLE001
        return {
            "text": "",
            "error": str(exc),
            "message": "Whisper 转录失败，请检查模型是否已安装、音频是否为有效格式。",
        }
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Local faster-whisper HTTP server")
    parser.add_argument("--model", default="small", help="faster-whisper 模型名，如 tiny/base/small/medium/large-v3")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    print(f"[whisper] starting server on http://{args.host}:{args.port}")
    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
