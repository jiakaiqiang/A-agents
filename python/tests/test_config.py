import pytest

from mewcode.config import ConfigError, load


def write_config(tmp_path, content):
    path = tmp_path / "config.yaml"
    path.write_text(content, encoding="utf-8")
    return str(path)


def test_load_valid_config(tmp_path):
    cfg = load(
        write_config(
            tmp_path,
            """
providers:
  - name: Claude
    protocol: anthropic
    api_key: key
    model: claude-opus-5
    thinking: true
""",
        )
    )
    assert len(cfg.providers) == 1
    assert cfg.providers[0].thinking is True


@pytest.mark.parametrize(
    "content",
    [
        "providers:\n  - name: x\n    protocol: anthropic\n    model: m\n",
        "providers:\n  - name: x\n    protocol: other\n    api_key: k\n    model: m\n",
    ],
)
def test_invalid_config(tmp_path, content):
    with pytest.raises(ConfigError):
        load(write_config(tmp_path, content))


def test_missing_file():
    with pytest.raises(ConfigError, match="配置文件不存在"):
        load("missing-config.yaml")
