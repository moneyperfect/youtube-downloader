const fs = require('fs');
const path = require('path');

let _config = null;

function loadConfig() {
    if (_config) return _config;

    const configPath = path.join(__dirname, '..', 'config.json');
    try {
        if (fs.existsSync(configPath)) {
            _config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        } else {
            _config = {};
        }
    } catch (e) {
        _config = {};
    }

    // 环境变量覆盖
    if (process.env.AUTH_PASSWORD) {
        _config.auth = _config.auth || {};
        _config.auth.password = process.env.AUTH_PASSWORD;
    }

    return _config;
}

function get(keyPath, defaultValue) {
    const cfg = loadConfig();
    const keys = keyPath.split('.');
    let value = cfg;
    for (const key of keys) {
        if (value && typeof value === 'object') {
            value = value[key];
        } else {
            return defaultValue;
        }
    }
    return value !== undefined ? value : defaultValue;
}

module.exports = { loadConfig, get };
