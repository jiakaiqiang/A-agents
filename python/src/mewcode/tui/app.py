import asyncio
import os
import time
from enum import Enum
from typing import ClassVar

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.events import Key
from textual.widgets import OptionList, RichLog, Static, TextArea

from .. import __version__
from ..config import ProviderConfig
from ..conversation import Conversation
from ..llm import Provider, new_provider
from ..prompt import render_banner
from .select import provider_options
from .stream import consume_stream, finish_with_assistant, finish_with_error, tick, update_statusbar
from .view import user_block


class SessionState(Enum):
    SELECTING = "selecting"
    IDLE = "idle"
    STREAMING = "streaming"


class MewCodeApp(App[None]):
    CSS = """
    Screen { layout: vertical; }
    #log { height: 1fr; width: 1fr; padding: 1 1 0 1; }
    #streaming { height: auto; width: 1fr; padding: 0 1; color: $text; }
    #input { height: 5; width: 1fr; border: solid $primary; margin: 0 1; }
    #statusbar { height: 1; width: 1fr; padding: 0 1; background: $primary-darken-2; }
    #providers { height: 1fr; width: 1fr; padding: 2 4; }
    """
    BINDINGS: ClassVar[list[Binding]] = [
        Binding("ctrl+c", "quit", "退出"),
        Binding("enter", "submit", "提交", show=False, priority=True),
    ]

    def __init__(self, providers: list[ProviderConfig]) -> None:
        super().__init__()
        self.providers = providers
        self.state = SessionState.IDLE if len(providers) == 1 else SessionState.SELECTING
        self.provider: Provider | None = None
        self.conv = Conversation()
        self.cur_reply = ""
        self.turn_start = 0.0
        self._stream_task: asyncio.Task[None] | None = None
        self._timer = None

    def compose(self) -> ComposeResult:
        if self.state is SessionState.SELECTING:
            options = provider_options(self.providers)
            options.id = "providers"
            yield options
            return
        yield RichLog(id="log", wrap=True, markup=True)
        yield Static(id="streaming")
        yield TextArea("", id="input", placeholder="❯ Send a message...")
        yield Static(id="statusbar")

    def on_mount(self) -> None:
        if self.state is SessionState.SELECTING:
            self.query_one("#providers", OptionList).focus()
            return
        self.provider = new_provider(self.providers[0])
        self.query_one("#log", RichLog).write(render_banner(__version__, os.getcwd()))
        update_statusbar(self)
        self.query_one("#input", TextArea).focus()

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        self.provider = new_provider(self.providers[event.option_index])
        self.state = SessionState.IDLE
        self.query_one("#providers", OptionList).remove()
        self.mount(RichLog(id="log", wrap=True, markup=True))
        self.mount(Static(id="streaming"))
        self.mount(TextArea("", id="input", placeholder="❯ Send a message..."))
        self.mount(Static(id="statusbar"))
        self.call_after_refresh(self._initialize_chat)

    def _initialize_chat(self) -> None:
        self.query_one("#log", RichLog).write(render_banner(__version__, os.getcwd()))
        update_statusbar(self)
        self.query_one("#input", TextArea).focus()

    async def action_submit(self) -> None:
        if self.state is not SessionState.IDLE:
            return
        input_widget = self.query_one("#input", TextArea)
        await self.submit(input_widget.text)

    async def submit(self, text: str) -> None:
        if text.strip() == "/exit":
            await self.action_quit()
            return
        if not text.strip() or self.provider is None:
            return
        self.conv.add_user(text)
        self.query_one("#log", RichLog).write(user_block(text))
        self.query_one("#input", TextArea).text = ""
        self.cur_reply = ""
        self.turn_start = time.monotonic()
        self.state = SessionState.STREAMING
        self.refresh_streaming_view()
        self._stream_task = asyncio.create_task(self._consume_stream())
        self._timer = self.set_interval(0.1, self._tick)

    async def _consume_stream(self) -> None:
        await consume_stream(self)

    def _tick(self) -> None:
        tick(self)

    def refresh_streaming_view(self) -> None:
        elapsed = int(time.monotonic() - self.turn_start)
        reply = f"● {self.cur_reply}" if self.cur_reply else ""
        self.query_one("#streaming", Static).update(f"{reply}\nImagining… ({elapsed}s)")

    def finish_with_assistant(self, reply: str) -> None:
        finish_with_assistant(self, reply)

    def finish_with_error(self, error: Exception) -> None:
        finish_with_error(self, error)

    def finish_turn(self) -> None:
        if self._timer is not None:
            self._timer.stop()
            self._timer = None
        self._stream_task = None
        self.state = SessionState.IDLE
        self.cur_reply = ""
        self.query_one("#streaming", Static).update("")
        self.query_one("#input", TextArea).focus()

    async def action_quit(self) -> None:
        if self._stream_task is not None:
            self._stream_task.cancel()
        self.exit()

    def on_key(self, event: Key) -> None:
        if event.key == "enter" and event.alt:
            event.stop()
            self.query_one("#input", TextArea).insert("\n")
