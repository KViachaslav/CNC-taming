# CNC Suite

Одностраничное веб-приложение — единый самодостаточный HTML-файл, объединяющий
два инструмента в визуальном стиле Blender:

- **Генерация G-code** — импорт DXF и генерация УП для фрезеровки / лазера /
  сверловки, анализ зазоров (DRC-lite) и измерение по двум точкам
  (функциональность исходного `dxf_to_gcode.html`).
- **Отправка G-code** — 3D-превью, WebSocket-клиент GRBL, консоль, пульт,
  карта высот (функциональность исходного `GcodeAir.html`).

Тёмная тема, окна и иконки заимствованы из `blender_view.html`.

## Результат сборки

`cnc_suite.html` — итоговый самодостаточный файл (открывается двойным кликом в
браузере; 3D-часть работает через CDN three.js / OrbitControls / clipper).
Это артефакт сборки, но он коммитится как готовый продукт.

Проверенный результат: SHA256
`00A75328A80DE4F8EA646AC9A66C7997BECA9FC5B994F5750D0177A926E73A81`,
размер 345 320 байт.

## Структура репозитория

```
big_html/
+-- cnc_suite.html          итоговый собранный файл (продукт)
+-- src/                    исходники сборки
|   +-- _tpl.html              HTML-шаблон с маркерами вставок
|   +-- _shell.js              JS оболочки (меню, окна, рабочие области)
|   +-- _js_gen.js             JS генерации G-code      (из dxf_to_gcode.html)
|   +-- _js_send_preview.js    JS 3D-превью отправки    (из GcodeAir.html)
|   +-- _js_send_sender.js     JS WebSocket-клиента GRBL (из GcodeAir.html)
|   +-- _importmap.html        importmap для three
|   +-- windows/               фрагменты окон _win_1..10_*.html
+-- originals/              исходные приложения-доноры
|   +-- dxf_to_gcode.html
|   +-- GcodeAir.html
|   +-- blender_view.html      (источник CSS + спрайта иконок)
+-- build/                  сборка и проверка
|   +-- _build.ps1             собрать cnc_suite.html
|   +-- _extract.ps1           нарезать _js_*.js из originals/
|   +-- _verify.ps1            проверка id/дублей
+-- tools/                  dev-инструменты
|   +-- _probe.ps1, _probe2.ps1   headless-прогоны сценариев
|   +-- _shot.ps1, _shotrun.ps1   скриншоты в headless Chrome
|   +-- _ids_report.ps1, _classes.ps1, _inspect.ps1  отчёты
+-- docs/
    +-- task.md               исходное ТЗ
    +-- screenshots/          _shot_a.png, _shot_b.png
```

## Сборка и проверка

Запускать в PowerShell из любой директории — скрипты сами определяют корень
репозитория (`Split-Path $PSScriptRoot -Parent`):

```powershell
powershell -ExecutionPolicy Bypass -File .\build\_build.ps1     # -> cnc_suite.html
powershell -ExecutionPolicy Bypass -File .\build\_verify.ps1    # -> отчёт в консоль
```

### Скриншоты (опционально)

Требуется установленный Google Chrome. PNG сохраняется в `docs/screenshots/`:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\_shotrun.ps1 -Mode a   # режим «Генерация»
powershell -ExecutionPolicy Bypass -File .\tools\_shotrun.ps1 -Mode b   # режим «Отправка»
```

## Пересборка JS-фрагментов из доноров

`build/_extract.ps1` заново вырезает `src/_js_gen.js`, `src/_js_send_preview.js`,
`src/_js_send_sender.js` и `src/_importmap.html` из `originals/dxf_to_gcode.html`
и `originals/GcodeAir.html` (по номерам строк). Нужен только если менялись сами
доноры в `originals/`.
