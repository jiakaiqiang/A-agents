import sys

from .config import ConfigError, load
from .tui.app import MewCodeApp


def main() -> None:
    try:
        config = load(".mewcode/config.yaml")
    except ConfigError as exc:
        print(exc, file=sys.stderr)
        raise SystemExit(1) from exc
    try:
        MewCodeApp(config.providers).run()
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        print(f"MewCode 启动失败: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
