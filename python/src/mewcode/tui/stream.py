import asyncio
import time

from textual.widgets import RichLog

from .view import error_block, update_status, write_reply


async def consume_stream(app) -> None:
    provider = app.provider
    if provider is None:
        return
    try:
        async for event in provider.stream(app.conv.messages()):
            if event.err is not None:
                app.finish_with_error(event.err)
                return
            if event.text:
                app.cur_reply += event.text
                app.refresh_streaming_view()
            if event.done:
                app.finish_with_assistant(app.cur_reply)
                return
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - UI 必须呈现所有可恢复错误
        app.finish_with_error(exc)


def tick(app) -> None:
    if app.state.value == "streaming":
        app.refresh_streaming_view()


def finish_with_assistant(app, reply: str) -> None:
    elapsed = int(time.monotonic() - app.turn_start)
    write_reply(app.query_one("#log", RichLog), reply)
    app.query_one("#log", RichLog).write(f"[dim]Imagined in {elapsed}s[/]")
    app.conv.add_assistant(reply)
    app.finish_turn()


def finish_with_error(app, error: Exception) -> None:
    app.query_one("#log", RichLog).write(error_block(error))
    app.finish_turn()


def update_statusbar(app) -> None:
    update_status(app.query_one("#statusbar"), app.provider)
