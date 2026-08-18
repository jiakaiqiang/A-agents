from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import yaml

ProtocolName = Literal["anthropic", "openai"]


@dataclass
class ProviderConfig:
    name: str
    protocol: ProtocolName
    api_key: str
    model: str
    base_url: str | None = None
    thinking: bool = False


@dataclass
class Config:
    providers: list[ProviderConfig]


class ConfigError(Exception):
    """配置文件无效。"""


def _required(item: dict[str, Any], key: str, index: int) -> str:
    value = item.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"providers[{index}].{key} 不能为空")
    return value.strip()


def _from_dict(data: Any) -> Config:
    if not isinstance(data, dict) or not isinstance(data.get("providers"), list):
        raise ConfigError("providers 必须是非空列表")
    raw_providers = data["providers"]
    if not raw_providers:
        raise ConfigError("providers 必须是非空列表")

    providers: list[ProviderConfig] = []
    for index, raw in enumerate(raw_providers):
        if not isinstance(raw, dict):
            raise ConfigError(f"providers[{index}] 必须是对象")
        name = _required(raw, "name", index)
        protocol = _required(raw, "protocol", index)
        if protocol not in {"anthropic", "openai"}:
            raise ConfigError(f"providers[{index}].protocol 必须是 anthropic 或 openai")
        api_key = _required(raw, "api_key", index)
        model = _required(raw, "model", index)
        base_url = raw.get("base_url")
        if base_url is not None and not isinstance(base_url, str):
            raise ConfigError(f"providers[{index}].base_url 必须是字符串")
        thinking = raw.get("thinking", False)
        if not isinstance(thinking, bool):
            raise ConfigError(f"providers[{index}].thinking 必须是布尔值")
        providers.append(ProviderConfig(name, protocol, api_key, model, base_url, thinking))
    return Config(providers)


def load(path: str) -> Config:
    config_path = Path(path)
    if not config_path.exists():
        raise ConfigError(f"配置文件不存在: {path}")
    try:
        data = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise ConfigError(f"YAML 解析失败: {exc}") from exc
    except OSError as exc:
        raise ConfigError(f"读取配置文件失败: {exc}") from exc
    return _from_dict(data)
