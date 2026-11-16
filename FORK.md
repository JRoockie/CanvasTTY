# Форк CanvasTTY под Hermes

Это форк [howdeploy/CanvasTTY](https://github.com/howdeploy/CanvasTTY): ветка `main`
здесь — это upstream `main` плюс два патча, без которых Hermes в CanvasTTY работает
плохо или не показывает свои лимиты. Патчи лежат обычными коммитами поверх апстрима,
поэтому обновление сводится к `rebase`, а не к ручному переписыванию кода.

## Что поменяно

### 1. Hermes может достучаться до своего шлюза (`isolation`)

`src/main/services/isolation/isolationPaths.ts` — провайдеру `hermes` разрешён его
собственный home как папка сокетов.

Зачем: CanvasTTY по умолчанию заворачивает агентов в `sandbox-exec` (seatbelt), а профиль
запрещает `(deny network-outbound (remote unix-socket))`. Hermes общается со своим
демоном через `$HERMES_HOME/gateway.sock`, коннект режется, и каждая сессия умирает на
первом ходе с `Gateway inaccessible: authorization`. Тест
`tests/agent-isolation.test.mjs` проверяет, что грант есть у `hermes`, отсутствует у
`codex` и следует за перенесённым `HERMES_HOME`.

### 2. Карточка лимитов для Hermes

CanvasTTY умел читать лимиты codex, claude, qwen, kimi, opencode и grok, но не `hermes` —
поэтому на Home у плитки Hermes было пусто. Патч добавляет седьмого провайдера лимитов:

| Файл | Что делает |
|---|---|
| `src/shared/contracts.ts` | `LimitProviderId` и `LIMIT_PROVIDERS` включают `hermes`; новый `LimitSource = "hermes-usage-cli"` |
| `src/main/services/LimitsService.ts` | `loadHermes()` запускает `hermes usage --json` (15 с таймаут, лимит вывода, стадия `stale` из последнего удачного чтения) и `normalizeHermesLimits()` раскладывает окна в `LimitWindow` (5h / 7d / monthly) |
| `src/main/services/SettingsStore.ts` | версия настроек 23 + миграция: профили, у которых был полный набор лимитов, получают строку Hermes; выключенные вручную провайдеры не включаются |
| `tests/hermes-limits-adapter.test.mjs` | нормализация реального ответа, неизвестные окна, `unavailable_reason`, интеграция с CLI через фикстуру, `cli-not-found` |

Почему через CLI, а не напрямую в API: лимиты принадлежат не CanvasTTY, а тому
провайдеру, на который настроен сам Hermes. `hermes usage --json` — единственный
источник, который знает текущий провайдер и его ключи; дублировать чтение
`~/.hermes/.env` и угадывать эндпоинт означало бы разъезжаться с Hermes при каждой
смене провайдера.

## Настройка после установки

1. Лимиты видны только для включённых строк: Настройки → Агенты → «Отображение лимитов» →
   включить нужных провайдеров.
2. Карточка OpenCode Go берёт ключ из `~/.local/share/opencode/auth.json`
   (`{"opencode-go":{"type":"api","key":"…"}}`). Ключ, введённый только в Hermes
   (`OPENCODE_GO_API_KEY`), она не видит.
3. В терминале те же цифры: `hermes usage`.

## Как обновляться с апстримом

```bash
git remote add upstream https://github.com/howdeploy/CanvasTTY.git   # один раз
git fetch upstream
git rebase upstream/main
git push --force-with-lease origin main
npm run build && npx electron-builder --dir
```

Если апстрим уже добавил свою строку лимитов Hermes (`LimitProviderId`), при rebase
выбирайте их вариант: наш патч нужен только пока её нет.

## Как собрать локально (macOS, arm64)

```bash
pnpm install --config.dangerouslyAllowAllBuilds=true   # без флага падает ERR_PNPM_IGNORED_BUILDS
brew install go                                       # иначе нативные хелперы не соберутся
npm run build
KEY=$(python3 -c "import os,base64;print(base64.b64encode(os.urandom(32)).decode())")
SPARKLE_PUBLIC_ED_KEY="$KEY" npx electron-builder --dir
```

`pnpm-lock.yaml` и `pnpm-workspace.yaml` генерируются установкой и в репозиторий не
попадают: без lockfile апстрим тянет свежие зависимости.

## Проверено

- `node --test` по затронутым файлам: `limits-normalizer`, `hermes-limits-adapter`,
  `settings-normalizer`, `settings-file-preservation`, `provider-cli-integration`,
  `usage-account-scope`, `home-launcher-providers`, `limits-dispose` — зелёные.
- `npm run typecheck` — чисто.
- Живая проверка: `hermes usage --json` отдаёт `rolling/weekly/monthly`, а
  `LimitsService.getProviders(["hermes"])` с настоящим CLI возвращает
  `state: "available"` и три окна.
