# 引擎启动即把 SSL 验证切到 macOS 系统信任库(truststore),绕开 Python3.14+OpenSSL3.6
# 在非 ASCII 项目路径(本仓库含中文目录)下加载 certifi 证书文件时的偶发 race/加载失败
# (X509: NO_CERTIFICATE_OR_CRL_FOUND / SSLError),让 requests/httpx 的 TLS 校验稳定可靠。
try:  # noqa: SIM105
    import truststore as _truststore
    _truststore.inject_into_ssl()
except Exception:  # pragma: no cover - 系统无 truststore 时退回默认,不阻断引擎
    pass
