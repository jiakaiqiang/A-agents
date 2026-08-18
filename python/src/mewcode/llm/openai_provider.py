import asyncio
from collections.abc import AsyncIterator

import openai

from ..config import ProviderConfig
from ..prompt import SYSTEM_PROMPT
from . import Message, StreamEvent


class OpenAIProvider:
    def __init__(self, cfg: ProviderConfig) -> None:
        if cfg.base_url:
            self._client = openai.AsyncOpenAI(api_key=cfg.api_key, base_url=cfg.base_url)
        else:
            self._client = openai.AsyncOpenAI(api_key=cfg.api_key)
        self._name = cfg.name
        self._model = cfg.model

    @property
    def name(self) -> str:
        return self._name

    @property
    def model(self) -> str:
        return self._model

    async def stream(self, msgs: list[Message]) -> AsyncIterator[StreamEvent]:
        messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        messages.extend({"role": m.role, "content": m.content} for m in msgs)
        try:
            stream = await self._client.chat.completions.create(
                model=self._model, messages=messages, stream=True
            )
            chunk_count = 0
            text_count = 0
            async for chunk in stream:
                chunk_count += 1
                choices = getattr(chunk, "choices", [])
                if not choices:
                    continue
                text = getattr(choices[0].delta, "content", None)
                if text:
                    text_count += 1
                    yield StreamEvent(text=text)
            if chunk_count == 0:
                yield StreamEvent(
                    err=RuntimeError("OpenAI 端点返回空响应，请检查 base_url 是否为 API 地址")
                )
                return
            if text_count == 0:
                yield StreamEvent(
                    err=RuntimeError("模型未返回文本内容，请检查模型名称或接口兼容性")
                )
                return
            yield StreamEvent(done=True)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - 适配器需把 SDK 错误转为流事件
            yield StreamEvent(err=exc)
