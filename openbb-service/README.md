
# OpenBB Research Service

Bu servis OpenBB Open Data Platform REST API sunucusudur.

Render başlangıç komutu:

```bash
uvicorn openbb_core.rest_api:app --host 0.0.0.0 --port $PORT
```

Gerekli sağlayıcı API anahtarları Render environment variables üzerinden OpenBB kullanıcı ayarlarına bağlanmalıdır.
ABD temel verileri için FMP veya Intrinio; haberler için Benzinga veya FMP kullanılabilir.

Node servisinde:

```text
OPENBB_BASE_URL=https://OPENBB-SERVICE-URL
OPENBB_PROVIDER=fmp
```

tanımlanmalıdır.
