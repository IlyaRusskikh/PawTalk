# API v0.1

## POST /api/connect

Заголовок `Content-Type: application/json`. Максимум 4096 байт тела. Неизвестные поля, несколько JSON-объектов, управляющие символы в никнейме отклоняются.

```json
{"nickname":"Друг","password":"общий пароль"}
```

Для комнаты с обязательным E2EE клиент добавляет `"e2ee":true` и `"e2eeKeyId":"<SHA256 raw 32-byte key>"`. Секретный ключ API не принимает. Без этих полей возвращается HTTP 426; при несовпадении с настроенным `VOICECORD_E2EE_KEY_ID` — 403. Ответ успешного входа содержит `e2eeRequired`; при обязательном режиме JWT также содержит атрибут `voicecord.e2ee=required`. Это политика клиентов, а не криптографическая проверка SFU содержимого опубликованных кадров. Подробности: [E2EE.md](E2EE.md).

`GET /api/config` возвращает публичную политику `{"e2eeRequired":true|false}` без пароля и ключей.

Никнейм: 1–32 Unicode-символа после удаления пробелов по краям. Совпадение имён допустимо. Внутренняя идентичность — случайные 128 бит на каждое подключение.

Успех, HTTP 200:

```json
{"url":"wss://203.0.113.10/rtc","token":"<JWT>","identity":"<random-id>","room":"common","expiresIn":300}
```

Токен HS256 содержит `iss`, `sub`, `name`, `nbf`, `exp` и LiveKit video grant: `roomJoin=true`, комната `common`, `canPublish=true`, `canSubscribe=true`, `canPublishSources=["microphone"]`, `canPublishData=false`, `canUpdateOwnMetadata=false`. Права администратора не выдаются. Начальный TTL — пять минут; LiveKit управляет обновлением токена установленной сессии.

Ошибки: `{"error":"сообщение"}` с HTTP 400, 401, 413/400 для большого тела, 415, 429 или 503. При превышении пяти запросов подключения с одного IP в минуту возвращается `Retry-After: 60`. Максимум четыре параллельных PBKDF2-проверки во всём процессе. После рестарта лимиты сбрасываются.

Пароли, токены и тела запросов не журналируются. Ответы имеют `Cache-Control: no-store`. CORS не открыт: API вызывается main-процессом Electron, не произвольным сайтом.

## GET /healthz

HTTP 200: `{"status":"ok"}`. Проверяет процесс API; не проверяет доступность LiveKit, UDP или сертификата. Для полной диагностики используйте подключение двух клиентов.

## Конфигурация API

`LISTEN_ADDR` — по умолчанию `127.0.0.1:8080`.

Обязательные `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (минимум 32 символа), `LIVEKIT_URL`, `VOICECORD_PASSWORD_HASH`.

Формат хеша: `pbkdf2-sha256$600000$<base64url salt 16 bytes>$<base64url SHA256 digest 32 bytes>`, без padding. Получить свой хеш можно командой `go run . hash-password`, передав пароль в stdin; configure использует тот же формат.
