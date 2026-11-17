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

### 3. Карточка лимитов показывает каждое окно отдельно

Апстрим рисует одну строку на провайдера и выбирает из его окон одно — самое длинное с
известной длительностью. Из-за этого месячное окно (у него нет `windowMinutes`) не
показывалось вообще, а пятичасовое проигрывало недельному.

| Файл | Что делает |
|---|---|
| `src/renderer/src/features/home/homeModel.ts` | `HomeLimitRow.windows` — все окна провайдера (5 ч / 7 д / месяц), `window` остаётся главным числом для совместимости |
| `src/renderer/src/features/home/HomeZone.tsx` | под главным числом рисуется по строке на каждое остальное окно: длительность, процент, остаток, обратный отсчёт |
| `src/renderer/src/lib/i18n.ts` | `limitWindowMonthly` — «месяц» / «month» для окна без фиксированной длины |
| `src/renderer/src/styles/app.css` | `.limit-row__windows` и строки окон |
| `src/renderer/src/features/home/HomeAppearanceSettings.tsx` | дефолтный размер плитки 7×4 вместо 7×3: три окна в 7×3 не влезали |
| `tests/home-limit-windows.test.mjs` | все три окна доезжают до строки, окно только с месячным процентом не превращается в «недоступно» |

### 4. Выбор папки не виснет в нативном фуллскрине

Симптом: в окне запуска агента нажатие на «Папка проекта» не показывает панель выбора, а
интерфейс перестаёт отвечать. macOS показывает `dialog.showOpenDialog(owner, …)` шторкой,
пристёгнутой к окну; шторка окна в нативном фуллскрине (и окна на другом Space) остаётся
невидимой, а рендерер ждёт её промис.

Все восемь вызовов нативной панели идут через одну обёртку.

| Файл | Что делает |
|---|---|
| `src/main/ipc/nativeDialog.ts` | `needsAppModalDialog(owner)` — чистое решение: фуллскрин (`isFullScreen` / `isSimpleFullScreen`), отсутствующее или уже уничтоженное окно → панель app-modal |
| `src/main/ipc/nativeOpenDialog.ts` | `showOpenDialogForPerson(owner, options)` — на macOS сначала `app.focus({ steal: true })`, затем либо панель без owner, либо шторка к окну; повторный запрос для того же окна получает уже открытую панель, чтобы вторая модальная сессия не вставала за первой |
| `src/main/ipc/registerIpc.ts` | папка проекта, медиа Home, корень карточки файлов, музыкальная библиотека плагина — через обёртку |
| `src/main/ipc/registerMaterialIpc.ts` | папка результатов и выбор файлов материалов — через обёртку |
| `tests/native-dialog-owner.test.mjs` | окно в фуллскрине, simple fullscreen, без owner, уничтоженное окно → app-modal; обычное окно → шторка |

### 5. Строка лимитов — одно число на окно

Правила, которые Никита зафиксировал тремя итерациями (issue #2): на каждое окно одна строка
`5 ч · исп 7% · 00:28`, `7 д · исп 4% · 6д 01ч`, `месяц · исп 7% · 27д 14ч`. Окна идут от
короткого к длинному, число — израсходованное, сокращённо «исп», рядом обратный отсчёт.
Главного числа и полосы прогресса нет, «использовано» и «осталось» живут только в
`aria-label`/`title`.

| Файл | Что делает |
|---|---|
| `src/renderer/src/features/home/HomeZone.tsx` | `LimitRow` рисует по строке на каждое окно (включая то, что раньше было главным), сортирует окна по длине |
| `src/renderer/src/lib/i18n.ts` | `limitUsedShort` — «исп» / «used» |
| `src/renderer/src/styles/app.css` | строка окна — один поток (flex), разделители `limit-row__window-sep` |
| `tests/quota-used-left-labels.test.mjs` | контракт: одна строка на окно, «осталось» не видно, `limit-row__fill` отсутствует, aria-метка полная |

### 6. Перетаскивание карточки во время старта сессии

Запуск агента рождает пачку снапшотов сессии; часть сформирована до перетаскивания, и
рендерер применял их целиком — карточка 5–7 секунд отскакивала на прежнее место (issue #3).
Теперь собственные границы, отправленные в main, считаются авторитетными, пока main не
вернёт ровно их; окно 3 с страхует от потерянного эха.

| Файл | Что делает |
|---|---|
| `src/renderer/src/features/workspace/pendingBounds.ts` | `rememberPendingBounds` / `reconcilePendingBounds` — держит закоммиченные границы, снимает запись по эху, истекает по `PENDING_BOUNDS_GRACE_MS` |
| `src/renderer/src/App.tsx` | `changeSessionBounds` запоминает границы; `terminal.onSession` и стартовый список прогоняются через reconcile |
| `tests/pending-bounds.test.mjs` | откат не происходит, эхо снимает защиту, просроченная защита не запирает карточку |

### 7. Статус сессии Hermes не «недоступен», а живой (и у каждой карточки свой)

Hermes с недавних версий выполняет ход не в своём процессе, а в долгоживущем
`hermes gateway`, поэтому lifecycle-хуки запускаются из шлюза. Шлюз стартовал без
`CANVASTTY_RUNTIME_*`, хелпер молча ничего не отправлял — и карточка сессии навсегда
оставалась «Статус недоступен», хотя агент работал.

Первым лечением стала идентичность карточки прямо в команде хука. Пока карточка одна, это
работало; но конфиг `~/.hermes/config.yaml` один на профиль, команда хука у всех сессий
общая, и переживал только последний запуск: его карточка получала события всех остальных,
а сессии, запущенные раньше, замирали на «Запущен» / «Running».

Теперь хук не называет карточку вообще:

- команда хука несёт идентичность **провайдера**, а не карточки (`registerDispatcher`
  в `RuntimeGateway`): адрес сокета, `provider=hermes`, capability-токен — один на запуск
  приложения, поэтому конфиг больше не переписывается на каждом запуске;
- событие называет разговор Hermes (`session_id` приходит в stdin хука) и уходит
  сообщением `lifecycle-thread` — без `terminalSessionId`;
- CanvasTTY сам решает, чья это карточка: берёт `cwd` и время создания разговора из
  `~/.hermes/state.db` (таблица `sessions`, с подъёмом по `parent_session_id`) и сверяет с
  папками и временем запуска живых карточек (`HermesThreadSessions.ts`). Две карточки в
  одной папке различаются по времени: каждая берёт разговор, созданный сразу после её
  запуска, а ветка (`/new`, сжатие) остаётся за карточкой своего родителя;
- согласие Hermes (`~/.hermes/shell-hooks-allowlist.json`) привязано к паре (событие,
  команда). `carryHookApprovals` переносит уже выданное согласие на обновлённую команду
  этой же бинарки; согласие, которого не было, не выдумывается;
- распознаются и «временны́е», и `local-<digest>` идентификаторы разговоров Hermes —
  поэтому восстановленная карточка продолжает именно свой разговор (`--resume <id>`);
- карточка сессии, которая ещё не прислала событие, называет состояние «Запущен» /
  «Running» вместо «Статус недоступен».

| Файл | Что делает |
|---|---|
| `src/main/services/agent-runtime/ProviderRuntimeLaunch.ts` | `hookCommandWithEnvironment`, `carryHookApprovals`, `scriptMtime`; `HermesRuntimeHooks.begin` принимает идентичность провайдера |
| `src/main/services/agent-runtime/AgentRuntimeBridge.ts` | `hookIdentity` — карточке её собственная, Hermes — диспетчер провайдера; карточки с их `cwd` для резолвера |
| `src/main/services/agent-runtime/HermesThreadSessions.ts` | разговор Hermes → карточка: `state.db` (`node:sqlite` в отдельном потоке), сверка папок, кэш привязок |
| `src/main/services/agent-runtime/RuntimeGateway.ts` | `registerDispatcher`, `resolveThreadSession`, разбор и применение `lifecycle-thread` |
| `src/agent-runtime/runtime-protocol.mjs`, `runtime-client.mjs`, `native/canvastty-helper/{hook,runtime}.go` | `DISPATCHED_LIFECYCLE_TYPE`, форма идентификаторов Hermes, отправка события без карточки |
| `src/renderer/src/lib/sessionStatus.ts`, `lib/i18n.ts` | `statusRunning` — «Запущен» / «Running» |
| `tests/hermes-hook-dispatcher.test.mjs`, `tests/agent-runtime-dispatched-lifecycle.test.mjs`, `tests/hermes-thread-sessions.test.mjs` | хук без карточки и с переносом согласия; диспетчерское событие доходит до своей карточки (и не до чужой); резолвер по папкам и поверхностям |

### 8. Заявленная работа, которая замолчала, снова показывает «Простаивает»

Статусы событийные: «Работает» — по хуку в начале хода, «Простаивает» — по хуку в конце. Если событие не дошло
(шлюз перезапустился, согласие хука отбито, процесс умер), карточка залипала на «Работает» навсегда и врала.

Теперь у каждой карточки есть сторож тишины (`statusSignalWatchdog.ts`): сигнал «работает»/«ждёт ответа» заводит
окно в 5 минут и сбрасывает его каждым следующим сигналом, `idle` и закрытие карточки окно снимают. Истекло —
статус `idle` («Простаивает»), а в лог приложения уходит строка, что карточка заявила работу и замолчала.

Чтобы длинный ход не резался на ровном месте, «Работает» подпирается событием после каждого tool-call
(`post_tool_call` → `working` в `HERMES_HOOKS`), а не только в начале хода.

| Файл | Что делает |
|---|---|
| `src/main/services/statusSignalWatchdog.ts` | одно окно тишины на карточку, `observe`/`forget`/`dispose`, `STATUS_SIGNAL_TIMEOUT_MS` = 5 мин |
| `src/main/services/TerminalManager.ts` | `applyProviderSignal` держит состояние, `expireBusyStatus` возвращает `idle` и пишет причину в лог |
| `src/main/services/agent-runtime/ProviderRuntimeLaunch.ts` | `HERMES_HOOKS`: `post_tool_call` → `working` |
| `tests/status-signal-watchdog.test.mjs` | окно, сброс, `idle`, `needs_approval`, `forget`, константа |

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
