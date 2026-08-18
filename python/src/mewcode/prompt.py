SYSTEM_PROMPT = """You are MewCode, a concise and helpful terminal coding assistant. Answer clearly in Markdown and do not expose hidden reasoning."""

CAT_BANNER = r""" /\_/\\
( o.o )
 > ^ <"""


def render_banner(version: str, cwd: str) -> str:
    return f"{CAT_BANNER}\nMewCode v{version}\n{cwd}\n就绪，可以开始对话。"
