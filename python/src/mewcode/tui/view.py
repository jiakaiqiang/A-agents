from rich.markdown import Markdown
from rich.text import Text
from textual.widgets import RichLog, Static


def user_block(text: str) -> Text:
    return Text("● " + text, style="bold")


def render_markdown(reply: str) -> Markdown:
    return Markdown("● " + reply)


def error_block(error: Exception) -> Text:
    return Text("● " + str(error), style="bold red")


def update_status(widget: Static, provider) -> None:
    if provider is None:
        widget.update("选择一个 provider")
    else:
        widget.update(f"{provider.name:<20}{provider.model:>20}")


def write_reply(log: RichLog, reply: str) -> None:
    log.write(render_markdown(reply))
