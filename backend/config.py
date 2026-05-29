import os
import yaml

_config = None

def load_config() -> dict:
    global _config
    if _config is not None:
        return _config

    config_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.yaml")
    if os.path.exists(config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            _config = yaml.safe_load(f) or {}
    else:
        _config = {}

    # 环境变量覆盖
    env_password = os.environ.get("AUTH_PASSWORD")
    if env_password:
        _config.setdefault("auth", {})["password"] = env_password

    return _config

def get(key: str, default=None):
    """获取配置值，支持点分路径如 'server.port'"""
    cfg = load_config()
    keys = key.split(".")
    for k in keys:
        if isinstance(cfg, dict):
            cfg = cfg.get(k)
        else:
            return default
        if cfg is None:
            return default
    return cfg
