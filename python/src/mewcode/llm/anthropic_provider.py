import asyncio
from collections.abc import AsyncIterator

import anthropic

from ..config import ProviderConfig
from ..prompt import SYSTEM_PROMPT
from . import Message, StreamEvent


class AnthropicProvider:
    def __init__(self, cfg: ProviderConfig) -> None:
        if cfg.base_url:
            self._client = anthropic.AsyncAnthropic(api_key=cfg.api_key, base_url=cfg.base_url)
        else:
            self._client = anthropic.AsyncAnthropic(api_key=cfg.api_key)
        self._name = cfg.name
        self._model = cfg.model
        self._thinking = cfg.thinking

    @property
    def name(self) -> str:
        return self._name

    @property
    def model(self) -> str:
        return self._model

    async def stream(self, msgs: list[Message]) -> AsyncIterator[StreamEvent]:
        params = {
            "model": self._model,
            "max_tokens": 4096,
            "system": SYSTEM_PROMPT,
            "messages": [{"role": m.role, "content": m.content} for m in msgs],
        }
        if self._thinking:
            params["thinking"] = {"type": "enabled", "budget_tokens": 2048}
        try:
            async with self._client.messages.stream(**params) as stream:
                async for event in stream:
                    if getattr(event, "type", None) != "content_block_delta":
                        continue
                    delta = getattr(event, "delta", None)
                    if getattr(delta, "type", None) == "text_delta":
                        text = getattr(delta, "text", "")
                        if text:
                            yield StreamEvent(text=text)
            yield StreamEvent(done=True)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - 适配器需把 SDK 错误转为流事件
            yield StreamEvent(err=exc)
