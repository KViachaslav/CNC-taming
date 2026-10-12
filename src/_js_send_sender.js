<script>
/* =============================================================================
 * GCodeSender — клиент (чистый JS, без Flask)
 *
 *   Браузер  ──WebSocket (текстовый протокол)──►  ESP8266  ──Serial──►  GRBL
 *
 * Две очереди:
 *   1) Здесь, в браузере: скользящее окно — не более N строк без подтверждения.
 *   2) На ESP8266: ring-buffer + отправка в GRBL по одному «ok» за раз.
 *
 * Протокол (см. README.md):
 *   -> "<src-id> <gcode>"   "?"   "!"   "~"   "-1 reset"   "-1 flush"
 *   <- "hello <ver> <cap>"  "ack <id> <resp>"  "msg <raw>"  "st <used> <free>"  "err <text>"
 * ===========================================================================*/
(function () {
  "use strict";

  // ============================ DOM ============================
  const $ = (id) => document.getElementById(id);

  const dotConn        = $("dotConn");
  const connTitle      = $("connTitle");
  const connSub        = $("connSub");
  const logEl          = $("log");

  const gcodeEl        = $("gcode");
  const IPEl           = $("IP");
  const PortEl         = $("Port");
  const windowEl       = $("window");
  const queueInfoEl    = $("queueInfo");
  const fileInput      = $("fileInput");

  const btnConnect     = $("btnConnect");
  const btnDisconnect  = $("btnDisconnect");
  const btnSend        = $("btnSend");
  const btnStop        = $("btnStop");
  const btnPreview     = $("btnPreview");
  const btnUseDemo     = $("btnUseDemo");
  const btnLoadFile    = $("btnLoadFile");
  const btnResetColors = $("btnResetColors");

  // --- панель управления станком ---
  const machineStateEl = $("machineState");
  const mposXEl        = $("mposX");
  const mposYEl        = $("mposY");
  const mposZEl        = $("mposZ");
  const jogStepEl      = $("jogStep");
  const jogFeedEl      = $("jogFeed");
  const spindleRpmEl   = $("spindleRpm");

  const btnUnlock      = $("btnUnlock");
  const btnHome        = $("btnHome");
  const btnStatusQuery = $("btnStatusQuery");
  const btnZeroXY      = $("btnZeroXY");
  const btnZeroAll     = $("btnZeroAll");
  const btnGotoZero    = $("btnGotoZero");
  const btnSoftReset   = $("btnSoftReset");
  const btnHold        = $("btnHold");
  const btnResume      = $("btnResume");
  const btnSpindleOn   = $("btnSpindleOn");
  const btnSpindleOff  = $("btnSpindleOff");
  const btnSettings    = $("btnSettings");
  const btnOffsets     = $("btnOffsets");
  const btnBuildInfo   = $("btnBuildInfo");

  // --- рабочие координаты: правка значений и ноль по оси ---
  const coordXEl       = $("coordX");
  const coordYEl       = $("coordY");
  const coordZEl       = $("coordZ");
  const btnCoordsApply = $("btnCoordsApply");
  const btnCoordsReload= $("btnCoordsReload");

  // --- карта высот (автоуровень) ---
  const hmBadge        = $("hmBadge");
  const hmMsgEl        = $("hmMsg");
  const hmSummaryEl    = $("hmSummary");
  const hmTableBox     = $("hmTableBox");
  const hmX0El         = $("hmX0");
  const hmX1El         = $("hmX1");
  const hmY0El         = $("hmY0");
  const hmY1El         = $("hmY1");
  const hmNxEl         = $("hmNx");
  const hmNyEl         = $("hmNy");
  const hmSafeEl       = $("hmSafe");
  const hmDepthEl      = $("hmDepth");
  const hmFeedEl       = $("hmFeed");
  const btnHmStart     = $("btnHmStart");
  const btnHmStop      = $("btnHmStop");
  const btnHmClear     = $("btnHmClear");
  const btnHmApply     = $("btnHmApply");
  const btnHmUndo      = $("btnHmUndo");
  const btnHmPreview   = $("btnHmPreview");
  const btnHmFromGcode = $("btnHmFromGcode");
  const chkHmInsertZ   = $("chkHmInsertZ");

  // ============================ состояние ============================
  let socket         = null;
  let deviceReady    = false;   // получен "hello" от ESP
  let espQueueCap    = 32;      // ёмкость очереди ESP (из hello)
  let espQueueUsed   = 0;       // текущее заполнение очереди ESP (из "st")
  let sendJob        = null;    // текущая задача отправки
  let stopRequested  = false;

  // --- карта высот / автоуровень ---
  let hmJob          = null;    // { xs, ys, nx, ny, nodes, complete, zmax, zmin, ... }
  let hmActive       = false;   // идёт сбор карты
  let hmGcodeBackup  = null;    // G-code до применения коррекции (для «Отменить»)
  let lastPrb        = null;    // последний [PRB:x,y,z:touched] от GRBL

  // --- правка рабочих координат ---
  const coordFields  = [
    { axis: "X", el: coordXEl, dirty: false },
    { axis: "Y", el: coordYEl, dirty: false },
    { axis: "Z", el: coordZEl, dirty: false }
  ];

  const WS_BUFFER_LIMIT = 64 * 1024;  // предел socket.bufferedAmount
  const STATUS_POLL_MS  = 500;        // период опроса "?" (живое положение станка)
  const CMD_ID_BASE     = 2000000;    // id команд: заведомо выше индексов строк файла

  // --- состояние станка ---
  let grblState     = "—";            // Idle / Run / Jog / Alarm / Door / Hold / ...
  const mpos        = { x: null, y: null, z: null };
  let nextCmdId     = CMD_ID_BASE;
  const pendingCmds = new Map();      // id -> { text, silent } ожидает ack
  let statusTimer   = null;
  const DEFAULT_WINDOW  = 4;

  // ============================ лог ============================
  function log(msg) {
    const ts = new Date().toLocaleTimeString();
    logEl.textContent += "[" + ts + "] " + msg + "\n";
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ============================ индикатор подключения ============================
  function setConnected(connected, sub) {
    if (connected) {
      dotConn.classList.add("ok");
      dotConn.classList.remove("bad");
      connTitle.textContent = "Подключено";
      connSub.textContent = sub || "Соединение установлено";
    } else {
      dotConn.classList.remove("ok");
      dotConn.classList.add("bad");
      connTitle.textContent = "Не подключено";
      connSub.textContent = sub || "Ожидание устройства...";
    }
    btnDisconnect.disabled = !connected;
    btnSend.disabled = !connected;
    btnStop.disabled = !connected;
    btnResetColors.disabled = !connected;

    // при потере связи — состояние станка неизвестно
    if (!connected) {
      stopStatusPolling();
      pendingCmds.clear();
      grblState = "—";
      mpos.x = mpos.y = mpos.z = null;
      if (hmActive) probeAbort("потеряна связь");
      updateStatusUI();
    }
    refreshMachineButtons();
  }

  // ============================ разбор G-code ============================
  // Возвращает [{ text, src }], где src — индекс строки в исходном тексте
  // (тот же индекс, что использует визуализатор в g1SegmentLineIdx).
  function extractGCodeLines(text) {
    const raw = String(text).replace(/^\uFEFF/, "").split(/\r?\n/);
    const items = [];
    for (let i = 0; i < raw.length; i++) {
      const s = raw[i].split(";")[0].replace(/\([^)]*\)/g, "").trim();
      if (!s) continue;
      items.push({ text: s, src: i });
    }
    return items;
  }

  // ============================ размер окна ============================
  function currentWindow() {
    let w = parseInt(windowEl.value, 10);
    if (!isFinite(w) || w < 1) w = DEFAULT_WINDOW;
    const cap = Math.max(1, espQueueCap - 1);  // не забиваем очередь ESP целиком
    if (w > cap) w = cap;
    if (w > 16) w = 16;
    return w;
  }

  // ============================ индикатор очередей ============================
  function updateQueueInfo() {
    const job = sendJob;
    const clientPart = job
      ? "клиент: в очереди " + (job.items.length - job.next) + ", в полёте " + job.inflightIds.length
      : "клиент: —";
    queueInfoEl.value = "ESP: " + espQueueUsed + "/" + espQueueCap + "  |  " + clientPart;
    refreshMachineButtons();
  }

  // ============================ WebSocket ============================
  function connect() {
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
      log("Соединение уже установлено/устанавливается");
      return;
    }
    const ip = IPEl.value.trim();
    const port = PortEl.value.trim();
    if (!ip || !port) { log("Укажите IP и порт"); return; }

    const url = "ws://" + ip + ":" + port;
    log("Подключение к " + url + " ...");
    deviceReady = false;

    try {
      socket = new WebSocket(url);
    } catch (e) {
      log("❌ Не удалось создать WebSocket: " + e.message);
      setConnected(false, "Ошибка");
      return;
    }

    socket.onopen = () => {
      log("WebSocket открыт, ждём hello от ESP...");
      setConnected(true, ip + ":" + port);
    };
    socket.onmessage = (ev) => onMessage(String(ev.data));
    socket.onerror = () => log("❌ Ошибка WebSocket");
    socket.onclose = (ev) => {
      log("Соединение закрыто (code " + ev.code + (ev.reason ? ", " + ev.reason : "") + ")");
      socket = null;
      deviceReady = false;
      setConnected(false, "Соединение закрыто");
      if (sendJob) {
        log("⏹️ Отправка прервана — соединение разорвано");
        sendJob = null;
        updateQueueInfo();
      }
    };
  }

  function disconnect() {
    if (socket) {
      const s = socket;
      socket = null;
      s.close();
    }
    deviceReady = false;
    sendJob = null;
    stopRequested = false;
    setConnected(false, "Отключено пользователем");
    updateQueueInfo();
    log("Отключено");
  }

  // ============================ приём сообщений от ESP ============================
  function onMessage(text) {
    const sp = text.indexOf(" ");
    const type = sp < 0 ? text : text.slice(0, sp);
    const rest = sp < 0 ? "" : text.slice(sp + 1);

    switch (type) {
      case "hello": {
        const parts = rest.split(" ");
        const ver = parts[0] || "?";
        const cap = parseInt(parts[1], 10);
        if (isFinite(cap) && cap > 0) espQueueCap = cap;
        deviceReady = true;
        startStatusPolling();   // начинаем живой опрос состояния GRBL
        log("✅ ESP готова: прошивка v" + ver + ", очередь " + espQueueCap + " строк");
        updateQueueInfo();
        break;
      }
      case "ack": {
        const sp2 = rest.indexOf(" ");
        const idStr = sp2 < 0 ? rest : rest.slice(0, sp2);
        const resp = sp2 < 0 ? "ok" : rest.slice(sp2 + 1).trim();
        const id = parseInt(idStr, 10);
        if (isFinite(id)) {
          if (pendingCmds.has(id)) {
            const cmd = pendingCmds.get(id);
            pendingCmds.delete(id);
            onCommandAck(cmd, resp);
          } else {
            onAck(id, resp);
          }
        }
        break;
      }
      case "msg":
        // [PRB:x,y,z:touched] — координаты срабатывания зонда (карта высот)
        if (handleProbeReport(rest)) break;
        // Строки статуса "<Idle|MPos:...>" — не в лог, а в панель станка
        if (!handleGrblStatusLine(rest)) {
          if (rest.indexOf("ALARM") === 0) setMachineState("Alarm");
          log("GRBL> " + rest);
        }
        break;
      case "st": {
        const parts = rest.split(" ");
        const used = parseInt(parts[0], 10);
        if (isFinite(used)) espQueueUsed = used;
        updateQueueInfo();
        break;
      }
      case "err":
        log("⚠️ ESP> " + rest);
        break;
      default:
        log("📨 " + text);
    }
  }

  // ============================ подтверждение строки ============================
  function onAck(id, resp) {
    const job = sendJob;
    if (!job) return;  // отправка уже остановлена — игнорируем «хвосты»

    const idx = job.inflightIds.indexOf(id);
    if (idx >= 0) job.inflightIds.splice(idx, 1);

    if (resp === "error:qfull") {
      // очередь ESP была заполнена — повторим эту строку и снизим темп
      job.retry.push(id);
      if (windowEl.value !== "1") {
        windowEl.value = "1";
        log("⚠️ Уменьшил окно до 1 (очередь ESP была заполнена)");
      }
      log("⚠️ Буфер ESP заполнен, повтор строки #" + id);
      setTimeout(pumpQueue, 200);
      return;
    }

    job.acked++;

    if (resp !== "ok") {
      const lineText = job.textBySrc.get(id);
      log("⚠️ GRBL «" + (lineText !== undefined ? lineText : "#" + id) + "» → " + resp);
    }

    const seg = job.lineToSeg.get(id);
    if (seg !== undefined && typeof window.markSegmentAsSent === "function") {
      window.markSegmentAsSent(seg);
    }

    pumpQueue();
  }

  // ============================ отправка со скользящим окном ============================
  function pumpQueue() {
    const job = sendJob;
    if (!job) return;
    if (stopRequested) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    const W = currentWindow();

    // сначала повторные строки (после error:qfull)
    while (job.retry.length > 0 &&
           job.inflightIds.length < W &&
           socket.bufferedAmount < WS_BUFFER_LIMIT) {
      const id = job.retry.shift();
      const it = job.bySrc.get(id);
      if (!it) continue;
      // состояние меняем ДО send: если ack придёт синхронно (ре-энтри),
      // pumpQueue не отправит эту же строку второй раз
      job.inflightIds.push(it.src);
      socket.send(it.src + " " + it.text);
    }

    // затем новые строки
    while (job.next < job.items.length &&
           job.inflightIds.length < W &&
           socket.bufferedAmount < WS_BUFFER_LIMIT) {
      const it = job.items[job.next];
      // состояние меняем ДО send (см. пояснение выше)
      job.inflightIds.push(it.src);
      job.next++;
      socket.send(it.src + " " + it.text);
    }

    updateQueueInfo();

    if (!job.done && job.retry.length === 0 && job.inflightIds.length === 0 &&
        job.next >= job.items.length) {
      job.done = true;
      log("✅ Отправка завершена. Строк: " + job.items.length + ", подтверждено: " + job.acked);
      // Освобождаем «замок»: иначе после завершения навсегда остаются
      // недоступными джог, команды панели и следующий запуск файла.
      sendJob = null;
      updateQueueInfo();
      sendRealtime("?");  // запросим финальный статус станка
    }
  }

  // ============================ realtime-команды ============================
  function sendRealtime(cmd) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(cmd);
  }

  // ======================================================================
  //  ПАНЕЛЬ СТАНКА: джог, блокировка кнопок, служебные операции
  // ======================================================================

  // Проверки безопасности перед любым движением.
  function canMove() {
    if (!socket || socket.readyState !== WebSocket.OPEN || !deviceReady) { log("❌ Нет связи с ESP"); return false; }
    if (sendJob) { log("⚠️ Идёт отправка файла — движение заблокировано (нажмите «Стоп»)"); return false; }
    if (hmActive) { log("⚠️ Идёт сбор карты высот — движение заблокировано (нажмите «Стоп сбора»)"); return false; }
    if (grblState === "Alarm") { log("⛔ Станок в ALARM — сначала «$X — разблокировать»"); return false; }
    if (String(grblState).split(":")[0] === "Door") { log("⛔ Открыта защитная дверь (Door) — движение запрещено"); return false; }
    return true;
  }

  // Относительное перемещение на один шаг. $J= всегда работает в G91,
  // поэтому модальное состояние программы (G90/G91) не меняется.
  function jog(axis, dir, step, feed) {
    if (!canMove()) return;
    let st = parseFloat(step);
    let fd = parseFloat(feed);
    if (!isFinite(st) || st <= 0) st = 1;
    if (!isFinite(fd) || fd <= 0) fd = 500;
    sendCommand("$J=G91 " + axis + (dir < 0 ? "-" : "") + st + " F" + fd, { silent: true });
  }

  // ============================ блокировка кнопок ============================
  const machineCmdBtns = [btnUnlock, btnHome, btnStatusQuery, btnZeroXY, btnZeroAll,
                          btnGotoZero, btnSpindleOn, btnSpindleOff,
                          btnSettings, btnOffsets, btnBuildInfo];

  function refreshMachineButtons() {
    const open   = !!socket && socket.readyState === WebSocket.OPEN;
    const canCmd = open && deviceReady && !sendJob;
    const canRt  = open && deviceReady;

    for (let i = 0; i < machineCmdBtns.length; i++) {
      const b = machineCmdBtns[i];
      if (b) b.disabled = !canCmd;
    }
    [btnHold, btnResume, btnSoftReset].forEach((b) => { if (b) b.disabled = !canRt; });
    document.querySelectorAll(".jogBtn").forEach((b) => { b.disabled = !canCmd; });
    if (jogStepEl) jogStepEl.disabled = !canCmd;
    if (jogFeedEl) jogFeedEl.disabled = !canCmd;
    if (spindleRpmEl) spindleRpmEl.disabled = !canCmd;

    // правка рабочих координат — только при живой связи и вне отправки файла
    document.querySelectorAll(".btnZeroAxis").forEach((b) => { b.disabled = !canCmd; });
    for (let i = 0; i < coordFields.length; i++) {
      if (coordFields[i].el) coordFields[i].el.disabled = !canCmd;
    }
    if (btnCoordsApply) btnCoordsApply.disabled = !canCmd;
    if (btnCoordsReload) btnCoordsReload.disabled = !canCmd;

    updateHmButtons();
  }

  // ============================ служебные операции ============================
  function softResetGrbl() {
    if (!confirm("Soft reset GRBL (Ctrl-X)?\n\nОтправка файла будет прервана, станок остановится.\nВероятно потребуется «$X — разблокировать».")) return;
    sendJob = null;
    pendingCmds.clear();
    if (hmActive) probeAbort("soft reset GRBL");
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send("-1 reset");
      log("🔄 Soft reset GRBL (Ctrl-X)");
    } else {
      log("❌ Нет соединения с ESP");
    }
    updateQueueInfo();
  }

  function homingGrbl() {
    if (!confirm("Выполнить хоминг ($H)?\n\nСтанок поедет искать концевики. Убедитесь, что путь свободен.")) return;
    sendCommand("$H");
  }

  function setWorkZero(axes) {
    const cmd = "G10 L20 P1 " + axes.map((a) => a + "0").join(" ");
    if (!confirm("Сделать текущее положение нулём " + axes.join("/") + "?\n\n" + cmd)) return;
    sendCommand(cmd);
  }

  function gotoWorkZero() {
    if (!canMove()) return;
    if (!confirm("G90 G0 X0 Y0 — переезд в рабочий ноль по X и Y?")) return;
    sendCommand("G90 G0 X0 Y0");
  }

  function spindleOn() {
    if (!socket || socket.readyState !== WebSocket.OPEN || !deviceReady) { log("❌ Нет связи с ESP"); return; }
    if (sendJob) { log("⚠️ Идёт отправка файла"); return; }
    const rpm = parseInt(spindleRpmEl.value, 10);
    if (!isFinite(rpm) || rpm <= 0) { log("⚠️ Укажите обороты шпинделя > 0"); return; }
    if (!confirm("Включить шпиндель: M3 S" + rpm + "?")) return;
    sendCommand("M3 S" + rpm);
  }

  // ============================ старт отправки ============================
  async function startSend() {
    if (!socket || socket.readyState !== WebSocket.OPEN) { log("❌ Нет соединения WebSocket"); return; }
    if (!deviceReady) { log("❌ ESP ещё не готова (не получен hello)"); return; }
    if (sendJob) { log("⚠️ Отправка уже идёт"); return; }
    if (hmActive) { log("⚠️ Идёт сбор карты высот — сначала «Стоп сбора»"); return; }

    const gcodeText = gcodeEl.value;
    const items = extractGCodeLines(gcodeText);
    if (items.length === 0) { log("Нет G-code для отправки"); return; }

    // Перестраиваем превью СИНХРОННО, чтобы карта сегментов точно совпала
    // с тем, что мы отправляем (иначе подсветка G1 «съедет»).
    if (typeof window.updateGCodeVisualization === "function") {
      await window.updateGCodeVisualization(gcodeText);
    }
    if (typeof window.resetColors === "function") window.resetColors();

    const lineToSeg = new Map();
    const segIdxArr = window.g1SegmentLineIdx || [];
    for (let s = 0; s < segIdxArr.length; s++) {
      const src = segIdxArr[s];
      if (src !== undefined && src !== null && src >= 0) lineToSeg.set(src, s);
    }

    stopRequested = false;
    sendJob = {
      items: items,
      bySrc: new Map(items.map((it) => [it.src, it])),
      textBySrc: new Map(items.map((it) => [it.src, it.text])),
      lineToSeg: lineToSeg,
      next: 0,
      acked: 0,
      inflightIds: [],
      retry: [],
      done: false
    };

    log("Начало отправки: строк " + items.length +
        ", G1-сегментов " + segIdxArr.length +
        ", окно " + currentWindow());
    pumpQueue();
  }

  // ============================ стоп ============================
  function stopSend(notifyGrbl) {
    stopRequested = true;
    if (notifyGrbl && socket && socket.readyState === WebSocket.OPEN) {
      socket.send("!");  // feed hold — мгновенная пауза станка
      setTimeout(() => {
        if (socket && socket.readyState === WebSocket.OPEN) socket.send("-1 reset");  // soft reset
      }, 250);
      log("⏹️ Стоп: feed hold + soft reset GRBL");
    } else {
      log("⏹️ Отправка остановлена");
    }
    sendJob = null;
    updateQueueInfo();
  }

  // ======================================================================
  //  ПАНЕЛЬ СТАНКА: состояние GRBL, опрос "?", отправка одиночных команд
  // ======================================================================
  const STATE_CLASS = {
    "Idle": "ok", "Run": "busy", "Jog": "busy", "Home": "busy",
    "Alarm": "bad", "Door": "warn", "Hold": "warn",
    "Check": "warn", "Sleep": "warn"
  };

  function stateClassOf(st) {
    if (!st || st === "—") return "";
    return STATE_CLASS[String(st).split(":")[0]] || "";
  }

  function setMachineState(st) {
    if (st === grblState) return;
    grblState = st;
    log("📟 GRBL: " + grblState);
    updateStatusUI();
    refreshMachineButtons();
  }

  function fmtPos(v) {
    return (v === null || v === undefined || !isFinite(v)) ? "—" : v.toFixed(3);
  }

  function updateStatusUI() {
    if (machineStateEl) {
      machineStateEl.textContent = grblState || "—";
      machineStateEl.className = "machineState " + stateClassOf(grblState);
    }
    if (mposXEl) mposXEl.textContent = fmtPos(mpos.x);
    if (mposYEl) mposYEl.textContent = fmtPos(mpos.y);
    if (mposZEl) mposZEl.textContent = fmtPos(mpos.z);

    // живое положение инструмента в 3D-превью (модуль three.js может быть не загружен)
    if (typeof window.setToolPosition === "function") window.setToolPosition(mpos.x, mpos.y, mpos.z);
    syncCoordFields();
  }

  // ============================ отчёт зонда ============================
  // "[PRB:1.000,2.000,-3.500:1]" — координаты срабатывания зонда,
  // последняя цифра: 1 — касание было, 0 — нет. true — если строка распознана.
  function handleProbeReport(line) {
    const m = String(line).match(/^\[PRB:(-?\d*\.?\d+),(-?\d*\.?\d+),(-?\d*\.?\d+):([01])\]/);
    if (!m) return false;
    lastPrb = {
      x: parseFloat(m[1]),
      y: parseFloat(m[2]),
      z: parseFloat(m[3]),
      touched: m[4] === "1"
    };
    log("📐 Зонд [PRB]: X" + lastPrb.x.toFixed(3) + " Y" + lastPrb.y.toFixed(3) +
        " Z" + lastPrb.z.toFixed(3) + (lastPrb.touched ? " (касание)" : " (без касания)"));
    return true;
  }

  // Разбор строки статуса GRBL: "<Idle|MPos:1.000,2.000,3.000|FS:0,0>"
  // true — если строка распознана как статус (тогда в лог её не пишем).
  function handleGrblStatusLine(line) {
    const s = String(line).trim();
    if (s.length < 3 || s.charAt(0) !== "<" || s.charAt(s.length - 1) !== ">") return false;

    const parts = s.slice(1, -1).split("|");
    setMachineState(parts[0].trim());

    const body = parts.slice(1).join("|");
    const mp = body.match(/(?:MPos|WPos):(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (mp) {
      mpos.x = parseFloat(mp[1]);
      mpos.y = parseFloat(mp[2]);
      mpos.z = parseFloat(mp[3]);
    }
    updateStatusUI();
    return true;
  }

  // ============================ опрос "?" ============================
  function startStatusPolling() {
    stopStatusPolling();
    if (socket && socket.readyState === WebSocket.OPEN) socket.send("?");
    statusTimer = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send("?");
    }, STATUS_POLL_MS);
  }

  function stopStatusPolling() {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
  }

  // ============================ отправка команды ============================
  // Команда уходит как обычная строка с положительным id: ESP кладёт её в
  // свою очередь и отдаёт в GRBL по одному "ok" за раз. Диапазон id начинается
  // с CMD_ID_BASE, поэтому команды не путаются с индексами строк файла.
  function sendCommand(text, opts) {
    opts = opts || {};
    if (!socket || socket.readyState !== WebSocket.OPEN) { log("❌ Нет соединения с ESP"); return false; }
    if (!deviceReady) { log("❌ ESP ещё не готова (нет hello)"); return false; }
    if (sendJob && !opts.allowDuringJob) {
      log("⚠️ «" + text + "» отменено: идёт отправка файла (сначала «Стоп»)");
      return false;
    }
    const id = nextCmdId++;
    pendingCmds.set(id, { text: text, silent: !!opts.silent, onAck: opts.onAck || null });
    socket.send(id + " " + text);
    log("→ " + text);
    return true;
  }

  function onCommandAck(cmd, resp) {
    if (resp === "ok") {
      if (!cmd.silent) log("✓ " + cmd.text);
    } else {
      log("⚠️ «" + cmd.text + "» → " + resp);
    }
    if (socket && socket.readyState === WebSocket.OPEN) socket.send("?");  // обновим состояние

    // пошаговые последовательности (сбор карты высот) продолжаются по подтверждению
    if (cmd.onAck) {
      try {
        cmd.onAck(resp, cmd.text);
      } catch (e) {
        log("❌ Ошибка обработки подтверждения: " + (e && e.message ? e.message : e));
      }
    }
  }

  // ======================================================================
  //  РАБОЧИЕ КООРДИНАТЫ: правка значений и ноль по оси (G10 L20 P1)
  // ======================================================================

  // Короткая запись числа для G-code: 3 знака, без хвостовых нулей и без «-0».
  function gnum(v) {
    if (v === null || v === undefined || !isFinite(v)) return "0";
    return String(Number(Number(v).toFixed(3)));
  }

  // 3 знака после запятой — для полей ввода и таблиц.
  function gnum3(v) {
    if (v === null || v === undefined || !isFinite(v)) return "";
    let s = Number(v).toFixed(3);
    if (s === "-0.000") s = "0.000";
    return s;
  }

  // Поля показывают MPos, но не затирают то, что пользователь печатает.
  function syncCoordFields() {
    for (let i = 0; i < coordFields.length; i++) {
      const f = coordFields[i];
      if (!f.el || f.dirty) continue;
      if (document.activeElement === f.el) continue;
      f.el.value = gnum3(mpos[f.axis.toLowerCase()]);
    }
  }

  function readCoordField(f) {
    const raw = String(f.el.value).replace(",", ".").trim();
    if (raw === "") return null;
    const v = parseFloat(raw);
    return isFinite(v) ? v : null;
  }

  function markCoordDirty(f, on) {
    f.dirty = !!on;
    if (f.el && f.el.classList) f.el.classList.toggle("dirty", !!on);
  }

  function clearCoordDirty() {
    for (let i = 0; i < coordFields.length; i++) markCoordDirty(coordFields[i], false);
  }

  // G10 L20 P1 X.. Y.. Z.. — «текущая точка получает эти рабочие координаты».
  function applyCoords() {
    if (!socket || socket.readyState !== WebSocket.OPEN || !deviceReady) { log("❌ Нет связи с ESP"); return false; }
    if (sendJob) { log("⚠️ Идёт отправка файла — команды заблокированы"); return false; }

    const parts = [];
    for (let i = 0; i < coordFields.length; i++) {
      const f = coordFields[i];
      if (!f.el || !f.dirty) continue;
      const v = readCoordField(f);
      if (v === null) { log("⚠️ Некорректное значение " + f.axis + " — пропускаю"); continue; }
      parts.push(f.axis + gnum(v));
    }
    if (!parts.length) { log("Нет изменённых координат — нечего применять"); return false; }

    const cmd = "G10 L20 P1 " + parts.join(" ");
    if (!confirm("Объявить текущее положение рабочими координатами?\n\n" + cmd +
                 "\n\nНоль по этим осям сдвинется и сохранится в EEPROM GRBL.")) return false;

    if (!sendCommand(cmd)) return false;
    clearCoordDirty();
    return true;
  }

  function zeroAxis(axis) {
    if (!socket || socket.readyState !== WebSocket.OPEN || !deviceReady) { log("❌ Нет связи с ESP"); return; }
    if (sendJob) { log("⚠️ Идёт отправка файла — команды заблокированы"); return; }
    if (!axis) return;
    if (!sendCommand("G10 L20 P1 " + axis + "0")) return;
    for (let i = 0; i < coordFields.length; i++) {
      if (coordFields[i].axis === axis) markCoordDirty(coordFields[i], false);
    }
  }

  // ======================================================================
  //  КАРТА ВЫСОТ (автоуровень зондом): G38.2 по сетке + коррекция Z в G-code
  // ======================================================================

  function hmSetMsg(text) { if (hmMsgEl) hmMsgEl.textContent = text; }

  function hmSetBadge(text, cls) {
    if (!hmBadge) return;
    hmBadge.textContent = text;
    hmBadge.className = "machineState" + (cls ? " " + cls : "");
  }

  function hmNum(el, dflt) {
    if (!el) return dflt;
    const v = parseFloat(String(el.value).replace(",", "."));
    return isFinite(v) ? v : dflt;
  }

  function hmInt(el, dflt, min, max) {
    let v = el ? parseInt(String(el.value), 10) : NaN;
    if (!isFinite(v)) v = dflt;
    if (v < min) v = min;
    if (v > max) v = max;
    return v;
  }

  function updateHmButtons() {
    const open = !!socket && socket.readyState === WebSocket.OPEN;
    const canCmd = open && deviceReady && !sendJob;
    if (btnHmStart) btnHmStart.disabled = !canCmd || hmActive;
    if (btnHmStop) btnHmStop.disabled = !hmActive;
    if (btnHmClear) btnHmClear.disabled = !hmJob;
    if (btnHmApply) btnHmApply.disabled = !(hmJob && hmJob.complete);
    if (btnHmUndo) btnHmUndo.disabled = hmGcodeBackup === null;
    if (btnHmPreview) btnHmPreview.disabled = !hmJob;
  }

  // Сетка точек зондирования в текущих рабочих координатах.
  function buildProbeGrid() {
    let x0 = hmNum(hmX0El, 0), x1 = hmNum(hmX1El, 100);
    let y0 = hmNum(hmY0El, 0), y1 = hmNum(hmY1El, 100);
    if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
    if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
    const nx = hmInt(hmNxEl, 3, 2, 20);
    const ny = hmInt(hmNyEl, 3, 2, 20);

    const xs = [], ys = [], nodes = [];
    for (let i = 0; i < nx; i++) xs.push(nx > 1 ? x0 + (x1 - x0) * i / (nx - 1) : x0);
    for (let j = 0; j < ny; j++) ys.push(ny > 1 ? y0 + (y1 - y0) * j / (ny - 1) : y0);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        nodes.push({ ix: i, iy: j, x: xs[i], y: ys[j], z: null, touched: false });
      }
    }

    return {
      x0: x0, x1: x1, y0: y0, y1: y1, xs: xs, ys: ys, nx: nx, ny: ny, nodes: nodes,
      idx: 0, phase: 0, complete: false, failed: 0,
      safe: hmNum(hmSafeEl, 5), depth: hmNum(hmDepthEl, 10), feed: hmNum(hmFeedEl, 100),
      zmin: null, zmax: null
    };
  }

  function renderHmTable(job) {
    if (!hmTableBox) return;
    if (!job) {
      hmTableBox.innerHTML = '<div class="hmHint">Нажмите «Собрать карту».</div>';
      if (hmSummaryEl) hmSummaryEl.textContent = "—";
      return;
    }

    let html = '<table class="hmTable"><tr><th>Y \\ X</th>';
    for (let i = 0; i < job.nx; i++) html += "<th>" + gnum3(job.xs[i]) + "</th>";
    html += "</tr>";

    for (let j = 0; j < job.ny; j++) {
      html += "<tr><th>" + gnum3(job.ys[j]) + "</th>";
      for (let i = 0; i < job.nx; i++) {
        const n = job.nodes[j * job.nx + i];
        const has = n.z !== null && isFinite(n.z);
        const now = hmActive && job.idx === j * job.nx + i;
        html += '<td class="' + (has ? "ok" : "bad") + (now ? " now" : "") + '">' +
                (has ? gnum3(n.z) : "—") + "</td>";
      }
      html += "</tr>";
    }
    html += "</table>";
    hmTableBox.innerHTML = html;

    if (hmSummaryEl) {
      if (job.complete) {
        hmSummaryEl.textContent = "разброс " + gnum3(job.zmax - job.zmin) + " мм (min " +
          gnum3(job.zmin) + ", max " + gnum3(job.zmax) + ")";
      } else {
        hmSummaryEl.textContent = "точек " + Math.min(job.idx, job.nodes.length) + "/" + job.nodes.length;
      }
    }
  }

  // ---------- сбор карты: 4 команды на точку ----------
  // phase 0: G90 G0 Z<safe>      — подъём на безопасную высоту
  // phase 1: G90 G0 X.. Y..      — переезд в точку сетки
  // phase 2: G91 G38.2 Z-.. F..  — зонд вниз до касания
  // phase 3: G90 G0 Z<safe>      — отвод, затем следующая точка
  function probeStart() {
    if (hmActive) { log("⚠️ Сбор карты уже идёт"); return; }
    if (sendJob) { log("⚠️ Идёт отправка файла — сначала «Стоп»"); return; }
    if (!canMove()) return;

    const job = buildProbeGrid();
    if (!(job.depth > 0)) { log("⚠️ «Макс. ход вниз» должен быть больше 0"); return; }
    if (!(job.feed > 0)) { log("⚠️ «Подача зонда» должна быть больше 0"); return; }

    const ask = "Собрать карту высот?\n\n" +
      "Точек: " + job.nodes.length + " (" + job.nx + "×" + job.ny + ")\n" +
      "X: " + gnum3(job.x0) + " … " + gnum3(job.x1) + "    Y: " + gnum3(job.y0) + " … " + gnum3(job.y1) + "\n" +
      "Отвод Z: " + gnum(job.safe) + " мм, ход вниз: -" + gnum(job.depth) + " мм, подача " + gnum(job.feed) + " мм/мин\n\n" +
      "Станок будет двигаться между точками. Сетка — в текущих рабочих координатах.";
    if (!confirm(ask)) return;

    if (typeof window.clearHeightMap === "function") window.clearHeightMap();
    hmJob = job;
    hmActive = true;
    lastPrb = null;
    hmSetBadge("сбор 0/" + job.nodes.length, "busy");
    hmSetMsg("Точка 0/" + job.nodes.length + " — идёт зондирование…");
    log("📐 Карта высот: " + job.nodes.length + " точек (" + job.nx + "×" + job.ny + "), ход -" +
        gnum(job.depth) + " мм, подача " + gnum(job.feed) + " мм/мин");
    renderHmTable(job);
    updateHmButtons();
    probeStep();
  }

  function probeStep() {
    if (!hmActive || !hmJob) return;
    const job = hmJob;
    const n = job.nodes[job.idx];
    let cmd = null;

    if (!n) { probeFinish(); return; }
    if (job.phase === 0) {
      cmd = "G90 G0 Z" + gnum(job.safe);
    } else if (job.phase === 1) {
      cmd = "G90 G0 X" + gnum(n.x) + " Y" + gnum(n.y);
    } else if (job.phase === 2) {
      lastPrb = null;                                    // сброс перед касанием
      cmd = "G91 G38.2 Z-" + gnum(job.depth) + " F" + gnum(job.feed);
    } else {
      cmd = "G90 G0 Z" + gnum(job.safe);
    }

    if (!cmd || !sendCommand(cmd, { onAck: probeAck })) probeAbort("команда не отправлена");
  }

  function probeAck(resp) {
    if (!hmActive || !hmJob) return;
    const job = hmJob;

    if (job.phase === 2) {           // ответ на сам зонд
      recordProbePoint(job, resp);
      if (!hmActive || !hmJob) return;
      job.phase = 3;
      renderHmTable(job);
      probeStep();
      return;
    }

    if (job.phase === 3) {           // отвод выполнен — переходим к следующей точке
      job.idx++;
      job.phase = 0;
      if (job.idx >= job.nodes.length) { probeFinish(); return; }
      hmSetBadge("сбор " + job.idx + "/" + job.nodes.length, "busy");
      hmSetMsg("Точка " + job.idx + "/" + job.nodes.length + " — идёт зондирование…");
      renderHmTable(job);
      probeStep();
      return;
    }

    job.phase++;                     // 0 -> 1 -> 2
    probeStep();
  }

  function recordProbePoint(job, resp) {
    const n = job.nodes[job.idx];
    const where = "X" + gnum3(n.x) + " Y" + gnum3(n.y);
    const num = (job.idx + 1) + "/" + job.nodes.length;

    if (resp === "ok" && lastPrb) {
      n.z = lastPrb.z;
      n.touched = !!lastPrb.touched;
      if (!n.touched) job.failed++;
      log("📐 Точка " + num + " " + where + ": Z " + gnum3(n.z) +
          (n.touched ? "" : "  (зонд не коснулся — проверьте $6 и «Макс. ход вниз»)"));
      return;
    }

    if (resp === "ok") {
      // GRBL ответил ok, но [PRB:...] не пришёл — берём координату из статуса
      const z = (mpos.z === null || !isFinite(mpos.z)) ? null : mpos.z;
      n.z = z;
      n.touched = (z !== null);
      if (!n.touched) job.failed++;
      log("📐 Точка " + num + " " + where + ": " +
          (z === null ? "нет данных [PRB:]" : "Z " + gnum3(z) + " (из статуса)"));
      return;
    }

    n.z = null;
    n.touched = false;
    job.failed++;

    if (String(resp).indexOf("ALARM") === 0) {
      hmSetMsg("Прервано: " + resp + " в точке " + where + ".\n" +
               "Скорее всего зонд не коснулся детали в пределах хода: увеличьте «Макс. ход вниз» " +
               "и запустите сбор заново после «$X — разблокировать».");
      log("⛔ Зонд: " + resp + " в точке " + where + " — сбор карты прерван");
      probeAbort("ALARM зонда", true);
      return;
    }

    log("⚠️ Зонд в точке " + where + " → " + resp + " (точка пропущена)");
  }

  function probeAbort(reason, keepMsg) {
    if (!hmActive && !hmJob) return;
    hmActive = false;
    if (hmJob) {
      hmJob.phase = 0;
      renderHmTable(hmJob);
    }
    hmSetBadge("сбор прерван", "bad");
    if (!keepMsg) hmSetMsg("Сбор прерван: " + reason);
    log("⛔ Сбор карты высот прерван: " + reason);
    updateHmButtons();
  }

  function probeFinish() {
    const job = hmJob;
    hmActive = false;
    if (!job) return;
    job.phase = 0;

    const zs = [];
    for (let i = 0; i < job.nodes.length; i++) {
      const z = job.nodes[i].z;
      if (z !== null && isFinite(z)) zs.push(z);
    }
    job.complete = (zs.length === job.nodes.length);
    if (zs.length) {
      job.zmax = Math.max.apply(null, zs);
      job.zmin = Math.min.apply(null, zs);
    }

    renderHmTable(job);
    if (typeof window.showHeightMap === "function") window.showHeightMap(job.nodes, job.nx, job.ny);

    if (job.complete) {
      hmSetBadge("карта " + job.nx + "×" + job.ny, "ok");
      hmSetMsg("Карта собрана: точек " + zs.length + ", разброс Z " + gnum3(job.zmax - job.zmin) +
               " мм (min " + gnum3(job.zmin) + ", max " + gnum3(job.zmax) + ").\n" +
               "Проверьте, что Z=0 программы стоит в самой высокой точке, затем «Применить к G-code».");
      log("✅ Карта высот собрана: " + zs.length + " точек, разброс Z " + gnum3(job.zmax - job.zmin) +
          " мм (min " + gnum3(job.zmin) + ", max " + gnum3(job.zmax) + ")");
    } else {
      hmSetBadge("карта неполная", "warn");
      hmSetMsg("Собрано точек " + zs.length + " из " + job.nodes.length +
               " — к G-code такая карта не применяется.\n" +
               "Увеличьте «Макс. ход вниз» и/или «Подача зонда» и повторите сбор.");
      log("⚠️ Карта высот неполная: " + zs.length + "/" + job.nodes.length + " точек");
    }
    updateHmButtons();
  }

  function hmStop() {
    if (!hmActive) { hmSetMsg("Сбор карты не идёт."); return; }
    probeAbort("остановлено пользователем");
    hmSetMsg("Сбор остановлен. Замеры сохранены, станок отводится на безопасную Z.");
    // поднимаем инструмент на «Безопасную Z» из поля ввода
    if (socket && socket.readyState === WebSocket.OPEN && deviceReady && !sendJob) {
      sendCommand("G90 G0 Z" + gnum(hmNum(hmSafeEl, 5)));
    }
  }

  function hmClear() {
    if (hmActive) probeAbort("карта сброшена");
    hmJob = null;
    if (typeof window.clearHeightMap === "function") window.clearHeightMap();
    renderHmTable(null);
    hmSetBadge("карта не собрана", "");
    hmSetMsg("Карта высот сброшена.");
    updateHmButtons();
  }

  // ---------- применение карты к G-code ----------

  // Z поверхности в точке (x, y) — билинейная интерполяция по сетке замеров.
  // Возвращает СМЕЩЕНИЕ относительно самой высокой точки карты (zmax):
  // 0 у максимума, у более низких мест — отрицательное.
  function hmOffsetAt(x, y) {
    const job = hmJob;
    if (!job || !job.nodes || !job.nodes.length) return 0;

    const nx = job.nx, ny = job.ny;
    const sx = (nx > 1 && job.x1 !== job.x0) ? (nx - 1) / (job.x1 - job.x0) : 0;
    const sy = (ny > 1 && job.y1 !== job.y0) ? (ny - 1) / (job.y1 - job.y0) : 0;

    let fx = (x - job.x0) * sx;
    let fy = (y - job.y0) * sy;
    if (!isFinite(fx)) fx = 0;
    if (!isFinite(fy)) fy = 0;
    fx = Math.max(0, Math.min(fx, nx - 1));
    fy = Math.max(0, Math.min(fy, ny - 1));

    let i0 = Math.floor(fx);
    let j0 = Math.floor(fy);
    if (i0 > nx - 2) i0 = Math.max(0, nx - 2);
    if (j0 > ny - 2) j0 = Math.max(0, ny - 2);
    const i1 = Math.min(i0 + 1, nx - 1);
    const j1 = Math.min(j0 + 1, ny - 1);
    const tx = (nx > 1) ? Math.min(1, Math.max(0, fx - i0)) : 0;
    const ty = (ny > 1) ? Math.min(1, Math.max(0, fy - j0)) : 0;

    const zAt = function (i, j) {
      const n = job.nodes[j * nx + i];
      return (n && n.z !== null && isFinite(n.z)) ? n.z : null;
    };

    const w = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
    const v = [zAt(i0, j0), zAt(i1, j0), zAt(i0, j1), zAt(i1, j1)];
    let sum = 0, wsum = 0;
    for (let k = 0; k < 4; k++) {
      if (v[k] === null) continue;
      sum += v[k] * w[k];
      wsum += w[k];
    }
    if (wsum <= 0) return 0;
    return (sum / wsum) - (isFinite(job.zmax) ? job.zmax : 0);
  }

  // Прошиваем G-code коррекцией по карте высот.
  //  - строки с Z-словом: Z заменяется на Z + смещение(X,Y);
  //  - при insertZ перед строками с X/Y вставляется G0 Z(текущая Z + смещение);
  //  - G91/G53/G92/G10/G28/G30/G38 и «$…» пропускаются — смещение к ним неприменимо.
  function hmRewriteGCode(text, insertZ) {
    const job = hmJob;
    if (!job) return null;

    const lines = String(text).split(/\r?\n/);
    const out = [];
    const skipRe = /(G0*91|G0*53|G0*92|G0*10|G0*28|G0*30|G0*38|\$)/;
    const zTokRe = /[Zz][+-]?\d*\.?\d+/;
    const mx = Math.abs(job.x1 - job.x0) * 0.01 + 1e-6;
    const my = Math.abs(job.y1 - job.y0) * 0.01 + 1e-6;

    let curX = 0, curY = 0, curZ = 0;      // модальные координаты
    let abs = true, motion = 0;
    let changed = 0, inserted = 0, skipped = 0, outside = 0;
    let warnedRel = false, warnedArc = false;

    for (let li = 0; li < lines.length; li++) {
      const raw = lines[li];
      const semi = raw.indexOf(";");
      const codeRaw = (semi >= 0) ? raw.slice(0, semi) : raw;
      const comment = (semi >= 0) ? raw.slice(semi) : "";
      const clean = codeRaw.replace(/\([^)]*\)/g, "");
      const words = clean.toUpperCase().match(/[A-Z][+-]?\d*\.?\d+/g) || [];

      let hasX = false, hasY = false, hasZ = false;
      let wx = 0, wy = 0, wz = 0;
      for (let k = 0; k < words.length; k++) {
        const letter = words[k].charAt(0);
        const val = parseFloat(words[k].slice(1));
        if (!isFinite(val)) continue;
        if (letter === "X") { hasX = true; wx = val; }
        else if (letter === "Y") { hasY = true; wy = val; }
        else if (letter === "Z") { hasZ = true; wz = val; }
        else if (letter === "G") {
          if (val === 0 || val === 1 || val === 2 || val === 3) motion = val;
          else if (val === 90) abs = true;
          else if (val === 91) abs = false;
        }
      }

      let line = raw;
      const skipLine = (!words.length) || skipRe.test(clean.replace(/\s+/g, ""));

      if (skipLine) {
        // служебные/сбросовые строки: ни Z, ни вставку к ним не применяем
      } else if (!abs) {
        if ((hasX || hasY || hasZ) && !warnedRel) {
          skipped++;
          log("⚠️ Карта высот: в G-code есть относительный режим (G91) — такие строки не корректируются");
          warnedRel = true;
        } else if (hasX || hasY || hasZ) {
          skipped++;
        }
      } else if (hasX || hasY || hasZ) {
        const tx = hasX ? wx : curX;
        const ty = hasY ? wy : curY;
        const off = hmOffsetAt(tx, ty);
        if (tx < job.x0 - mx || tx > job.x1 + mx || ty < job.y0 - my || ty > job.y1 + my) outside++;

        if (hasZ) {
          const mm = codeRaw.match(zTokRe);
          if (mm) {
            // меняем только само Z-слово, сохраняя его регистр и комментарий строки
            line = codeRaw.replace(zTokRe, mm[0].charAt(0) + gnum(wz + off)) + comment;
            changed++;
          }
        } else if (insertZ && (hasX || hasY) && (motion === 0 || motion === 1)) {
          out.push("G0 Z" + gnum(curZ + off));
          inserted++;
        } else if ((hasX || hasY) && (motion === 2 || motion === 3) && !warnedArc) {
          log("⚠️ Карта высот: дуги (G2/G3) без Z-слова не корректируются");
          warnedArc = true;
        }
      }

      if (hasX) curX = wx;
      if (hasY) curY = wy;
      if (hasZ) curZ = abs ? wz : (curZ + wz);

      out.push(line);
    }

    return {
      text: out.join("\n"),
      changed: changed, inserted: inserted, skipped: skipped,
      outside: outside, total: lines.length
    };
  }

  // ---------- кнопки карты высот ----------

  function hmFromGcodeBBox() {
    const b = window.gcodeBBox;
    if (!b) {
      log("⚠️ Границы G-code неизвестны — сначала постройте 3D-превью («Обновить превью»)");
      return;
    }
    if (hmX0El) hmX0El.value = gnum3(b.minX);
    if (hmX1El) hmX1El.value = gnum3(b.maxX);
    if (hmY0El) hmY0El.value = gnum3(b.minY);
    if (hmY1El) hmY1El.value = gnum3(b.maxY);
    log("Сетка карты высот взята из G-code: X " + gnum3(b.minX) + "…" + gnum3(b.maxX) +
        ", Y " + gnum3(b.minY) + "…" + gnum3(b.maxY));
  }

  function hmApplyToGcode() {
    if (!hmJob || !hmJob.complete) { log("⚠️ Сначала соберите полную карту высот"); return; }
    const text = gcodeEl.value;
    if (!text.trim()) { log("⚠️ Нет G-code для коррекции"); return; }

    const insertZ = !!(chkHmInsertZ && chkHmInsertZ.checked);
    const res = hmRewriteGCode(text, insertZ);
    if (!res || (!res.changed && !res.inserted)) {
      log("⚠️ Карта высот: в G-code нет строк, которые можно скорректировать");
      return;
    }

    const ask = "Применить карту высот к G-code?\n\n" +
      "Строк с Z изменено: " + res.changed + "\n" +
      (insertZ ? "Вставлено строк G0 Z: " + res.inserted + "\n" : "") +
      "Смещения: от " + gnum3(hmJob.zmin - hmJob.zmax) + " до 0.000 мм (0 — самая высокая точка).\n\n" +
      "Текст в поле G-code будет заменён. Вернуть исходный можно кнопкой «Отменить коррекцию».";
    if (!confirm(ask)) return;

    if (hmGcodeBackup === null) hmGcodeBackup = text;
    gcodeEl.value = res.text;
    if (typeof window.updateGCodeVisualization === "function") window.updateGCodeVisualization(res.text);
    hmSetMsg("Коррекция применена: изменено строк " + res.changed +
             (insertZ ? ", вставлено G0 Z: " + res.inserted : "") +
             ".\nСмещения от " + gnum3(hmJob.zmin - hmJob.zmax) + " до 0.000 мм.");
    log("📐 Карта высот применена к G-code: строк изменено " + res.changed +
        (insertZ ? ", вставлено " + res.inserted : "") +
        (res.outside ? ", точек вне сетки: " + res.outside : ""));
    updateHmButtons();
  }

  function hmUndoGcode() {
    if (hmGcodeBackup === null) { log("Нет сохранённого G-code для отката"); return; }
    gcodeEl.value = hmGcodeBackup;
    hmGcodeBackup = null;
    if (typeof window.updateGCodeVisualization === "function") window.updateGCodeVisualization(gcodeEl.value);
    hmSetMsg("Коррекция отменена — в поле вернулся исходный G-code.");
    log("↩️ Коррекция по карте высот отменена");
    updateHmButtons();
  }

  function hmPreview() {
    if (!hmJob) { log("⚠️ Карты высот ещё нет"); return; }
    if (typeof window.showHeightMap !== "function") {
      log("⚠️ 3D-превью недоступно (three.js не загрузился с CDN?)");
      return;
    }
    window.showHeightMap(hmJob.nodes, hmJob.nx, hmJob.ny);
    log("3D: показана карта высот (" + hmJob.nodes.length + " точек)");
  }

  // ---------- события: координаты и карта высот ----------
  for (let ci = 0; ci < coordFields.length; ci++) {
    const cf = coordFields[ci];
    if (!cf.el) continue;
    cf.el.addEventListener("input", () => markCoordDirty(cf, true));
    cf.el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); applyCoords(); }
      else if (e.key === "Escape") { markCoordDirty(cf, false); syncCoordFields(); }
    });
  }
  document.querySelectorAll(".btnZeroAxis").forEach((b) => {
    b.addEventListener("click", () => zeroAxis(b.getAttribute("data-zero-axis")));
  });
  if (btnCoordsApply) btnCoordsApply.addEventListener("click", applyCoords);
  if (btnCoordsReload) btnCoordsReload.addEventListener("click", () => {
    clearCoordDirty();
    sendRealtime("?");
  });

  if (btnHmStart) btnHmStart.addEventListener("click", probeStart);
  if (btnHmStop) btnHmStop.addEventListener("click", hmStop);
  if (btnHmClear) btnHmClear.addEventListener("click", hmClear);
  if (btnHmApply) btnHmApply.addEventListener("click", hmApplyToGcode);
  if (btnHmUndo) btnHmUndo.addEventListener("click", hmUndoGcode);
  if (btnHmPreview) btnHmPreview.addEventListener("click", hmPreview);
  if (btnHmFromGcode) btnHmFromGcode.addEventListener("click", hmFromGcodeBBox);

  // ============================ демо G-code ============================
  const DEMO_GCODE = [
    "; Демо: квадрат + окружность",
    "G21",
    "G90",
    "G0 X0 Y0 Z0",
    "G1 Z-1 F100",
    "G1 X0 Y50 F600",
    "G1 X50 Y50",
    "G1 X50 Y0",
    "G1 X0 Y0",
    "G0 Z5",
    "G0 X75 Y25",
    "G1 Z-1 F100",
    "G1 X85.00 Y25.00 F600",
    "G1 X84.66 Y27.59",
    "G1 X83.66 Y30.00",
    "G1 X82.07 Y32.07",
    "G1 X80.00 Y33.66",
    "G1 X77.59 Y34.66",
    "G1 X75.00 Y35.00",
    "G1 X72.41 Y34.66",
    "G1 X70.00 Y33.66",
    "G1 X67.93 Y32.07",
    "G1 X66.34 Y30.00",
    "G1 X65.34 Y27.59",
    "G1 X65.00 Y25.00",
    "G1 X65.34 Y22.41",
    "G1 X66.34 Y20.00",
    "G1 X67.93 Y17.93",
    "G1 X70.00 Y16.34",
    "G1 X72.41 Y15.34",
    "G1 X75.00 Y15.00",
    "G1 X77.59 Y15.34",
    "G1 X80.00 Y16.34",
    "G1 X82.07 Y17.93",
    "G1 X83.66 Y20.00",
    "G1 X84.66 Y22.41",
    "G1 X85.00 Y25.00",
    "G0 Z5",
    "G0 X0 Y0",
    "M30"
  ].join("\n");

  // ============================ UI-события ============================
  btnConnect.addEventListener("click", connect);

  // ============================ панель станка: события ============================
  btnUnlock.addEventListener("click", () => sendCommand("$X"));
  btnHome.addEventListener("click", homingGrbl);
  btnStatusQuery.addEventListener("click", () => sendRealtime("?"));
  btnSoftReset.addEventListener("click", softResetGrbl);
  btnHold.addEventListener("click", () => { sendRealtime("!"); log("→ ! (feed hold)"); });
  btnResume.addEventListener("click", () => { sendRealtime("~"); log("→ ~ (продолжить)"); });
  btnZeroXY.addEventListener("click", () => setWorkZero(["X", "Y"]));
  btnZeroAll.addEventListener("click", () => setWorkZero(["X", "Y", "Z"]));
  btnGotoZero.addEventListener("click", gotoWorkZero);
  btnSpindleOn.addEventListener("click", spindleOn);
  btnSpindleOff.addEventListener("click", () => sendCommand("M5"));
  btnSettings.addEventListener("click", () => sendCommand("$$"));
  btnOffsets.addEventListener("click", () => sendCommand("$#"));
  btnBuildInfo.addEventListener("click", () => sendCommand("$I"));

  // джог кнопками панели
  document.querySelectorAll(".jogBtn").forEach((b) => {
    b.addEventListener("click", () => {
      jog(b.dataset.axis, parseInt(b.dataset.dir, 10), jogStepEl.value, jogFeedEl.value);
    });
  });

  // джог с клавиатуры (когда фокус не в поле ввода). Shift — шаг ×10.
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" ||
              t.tagName === "SELECT" || t.isContentEditable)) return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;

    let axis = null;
    let dir = 0;
    switch (e.key) {
      case "ArrowLeft":  axis = "X"; dir = -1; break;
      case "ArrowRight": axis = "X"; dir =  1; break;
      case "ArrowUp":    axis = "Y"; dir =  1; break;
      case "ArrowDown":  axis = "Y"; dir = -1; break;
      case "PageUp":     axis = "Z"; dir =  1; break;
      case "PageDown":   axis = "Z"; dir = -1; break;
      default: return;
    }

    e.preventDefault();
    const step = (parseFloat(jogStepEl.value) || 1) * (e.shiftKey ? 10 : 1);
    jog(axis, dir, step, jogFeedEl.value);
  });
  btnDisconnect.addEventListener("click", disconnect);
  btnSend.addEventListener("click", startSend);
  btnStop.addEventListener("click", () => stopSend(true));

  btnResetColors.addEventListener("click", () => {
    if (typeof window.resetColors === "function") {
      window.resetColors();
      log("Цвета линий сброшены");
    }
  });

  btnPreview.addEventListener("click", () => {
    if (typeof window.updateGCodeVisualization !== "function") {
      log("⚠️ 3D-превью недоступно (не загрузился three.js с CDN?)");
      return;
    }
    if (gcodeEl.value.trim()) {
      window.updateGCodeVisualization(gcodeEl.value);
      log("3D-превью обновлено");
    } else {
      log("Нет G-code для отображения");
    }
  });

  btnUseDemo.addEventListener("click", () => {
    gcodeEl.value = DEMO_GCODE;
    if (typeof window.updateGCodeVisualization === "function") {
      window.updateGCodeVisualization(DEMO_GCODE);
    }
    log("Демо G-code загружен");
  });

  btnLoadFile.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (!file) return;
    log("Чтение файла: " + file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = String(e.target.result);
      gcodeEl.value = content;
      if (typeof window.updateGCodeVisualization === "function") {
        window.updateGCodeVisualization(content);
      }
      log('Файл "' + file.name + '" загружен (' + content.length + " символов)");
    };
    reader.onerror = () => log('Ошибка чтения файла "' + file.name + '"');
    reader.readAsText(file);
    fileInput.value = "";
  });

  // живое обновление превью при правке (с задержкой)
  let inputTimer = null;
  gcodeEl.addEventListener("input", () => {
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => {
      if (gcodeEl.value.trim() && typeof window.updateGCodeVisualization === "function") {
        window.updateGCodeVisualization(gcodeEl.value);
      }
    }, 800);
  });

  // ============================ старт ============================
  setConnected(false);
  updateQueueInfo();
  renderHmTable(null);
  if (!gcodeEl.value.trim()) gcodeEl.value = DEMO_GCODE;
  log("Готово. Укажите IP ESP8266, нажмите «Подключить», затем «Отправить».");

  setTimeout(() => {
    if (typeof window.updateGCodeVisualization === "function") {
      window.updateGCodeVisualization(gcodeEl.value);
    }
  }, 500);
})();




</script>
