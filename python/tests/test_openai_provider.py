import asyncio
from types import SimpleNamespace

from mewcode.config import ProviderConfig
from mewcode.llm import Message
from mewcode.llm.openai_provider import OpenAIProvider


class FakeStream:
    def __init__(self, chunks):
        self.chunks = chunks

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self.chunks:
            raise StopAsyncIteration
        return self.chunks.pop(0)


class FakeCompletions:
    def __init__(self, stream):
        self._stream = stream

    async def create(self, **kwargs):
        return self._stream


class FakeProviderClient:
    def __init__(self, stream):
        self.chat = SimpleNamespace(completions=FakeCompletions(stream))


def make_provider(stream):
    provider = OpenAIProvider.__new__(OpenAIProvider)
    provider._client = FakeProviderClient(stream)
    provider._model = "test-model"
    provider._name = "test"
    return provider


def test_openai_stream_emits_text_and_done():
    chunk = SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content="hello"))])
    events = asyncio.run(
        make_provider(FakeStream([chunk])).stream([Message("user", "hi")]).__anext__()
    )
    assert events.text == "hello"


def test_openai_stream_reports_empty_response():
    async def collect():
        return [
            event async for event in make_provider(FakeStream([])).stream([Message("user", "hi")])
        ]

    events = asyncio.run(collect())
    assert len(events) == 1
    assert events[0].err is not None
    assert "空响应" in str(events[0].err)


def test_config_shape_for_openai_provider():
    config = ProviderConfig("test", "openai", "key", "model")
    assert config.protocol == "openai"
