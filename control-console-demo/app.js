"use strict";

const channelMeta = [
  ["thumb_cmc_abduction", "拇指外展"],
  ["thumb_cmc_flexion", "拇指 CMC"],
  ["thumb_tendon", "拇指腱绳"],
  ["index_tendon", "食指腱绳"],
  ["middle_tendon", "中指腱绳"],
  ["ring_tendon", "无名指腱绳"],
  ["pinky_tendon", "小指腱绳"],
];

const tendonChannels = new Set(channelMeta.slice(2).map(([name]) => name));
let currentState = null;
let gestureSignature = "";
let polling = false;
let protectionDirty = false;
let protectionSignature = "";
let cameraChoicesSignature = "";
let visionCaptureBusy = false;

const protectionInputIds = [
  "motionTorqueLimit",
  "holdTorqueLimit",
  "contactCurrentThreshold",
  "contactLoadThreshold",
  "contactDurationThreshold",
];

const byId = (id) => document.getElementById(id);

async function api(path, method = "GET", body = null) {
  const options = { method, headers: {} };
  if (body !== null) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({ detail: response.statusText }));
  if (!response.ok) {
    throw new Error(payload.detail || `请求失败：${response.status}`);
  }
  return payload;
}

function setMessage(message, error = false) {
  const node = byId("systemMessage");
  node.textContent = message;
  node.classList.toggle("error", error);
  byId("eventOutput").textContent = message;
}

async function perform(path, method = "POST", body = null) {
  try {
    const result = await api(path, method, body);
    if (result && result.message) {
      setMessage(result.message, Boolean(result.error));
    }
    await refreshState();
    return result;
  } catch (error) {
    setMessage(error.message, true);
    throw error;
  }
}

function updateChip(node, text, tone) {
  node.textContent = text;
  node.className = `chip ${tone}`;
}

function renderControls(state) {
  const connected = state.connected;
  const action = state.action_active;
  const vision = state.vision || {};
  const visionOn = Boolean(vision.switch_on);
  const busy = action || visionOn;
  const controllerState = state.controller_state;
  const disarmed = controllerState === "DISARMED";
  const ready = controllerState === "READY";
  const faulted = controllerState === "FAULT_LATCHED" || controllerState === "ESTOP_LATCHED";

  byId("connectButton").disabled = connected;
  byId("disconnectButton").disabled = !connected || busy;
  byId("armButton").disabled = !connected || !state.calibrated || !disarmed || busy;
  byId("disarmButton").disabled = !connected || !ready || busy;
  byId("stopButton").disabled = !busy;
  byId("estopButton").disabled = !connected || faulted;

  const calibrationReady = connected && disarmed && !busy && byId("calibrationConfirm").checked;
  document.querySelectorAll(".jog").forEach((button) => {
    button.disabled = !calibrationReady;
  });
  byId("captureMinButton").disabled = !calibrationReady;
  byId("captureMaxButton").disabled = !calibrationReady;
  byId("saveCalibrationButton").disabled = !calibrationReady;
  byId("rezeroButton").disabled =
    !calibrationReady || !tendonChannels.has(byId("channelSelect").value);

  const recoveryItem = selectedRecoveryChannel(state);
  const recoveryOutside = Boolean(
    recoveryItem
    && recoveryItem.position != null
    && (recoveryItem.position < recoveryItem.soft_min || recoveryItem.position > recoveryItem.soft_max)
  );
  const recoveryReady = connected && disarmed && !busy && recoveryOutside && byId("recoveryConfirm").checked;
  byId("recoveryChannelSelect").disabled = !connected || busy;
  byId("recoveryTargetInput").disabled = !recoveryReady;
  byId("recoveryRunButton").disabled = !recoveryReady;
  document.querySelectorAll(".recovery-jog, .recovery-preset").forEach((button) => {
    button.disabled = !recoveryReady;
  });
  byId("recoveryZeroButton").disabled = true;
  byId("recoveryMaxRawButton").disabled = true;
  byId("recoveryBoundaryConfirm").disabled = true;

  byId("previewButton").disabled = !ready || busy || !state.calibrated;
  byId("saveGestureButton").disabled = busy;
  byId("globalSpeed").disabled = busy;
  document.querySelectorAll(".gesture-button").forEach((button) => {
    button.disabled = !ready || busy || !state.calibrated;
  });

  renderServoSpeedOutput(Number(byId("globalSpeed").value), state.speed_control);

  const protectionEditable = Boolean(state.protection_settings?.editable);
  protectionInputIds.forEach((id) => {
    byId(id).disabled = !protectionEditable;
  });
  byId("protectionConfirm").disabled = !protectionEditable;
  byId("applyProtectionButton").disabled =
    !protectionEditable || !protectionDirty || !byId("protectionConfirm").checked;
  byId("resetProtectionButton").disabled = !protectionDirty;

  updateChip(byId("modeChip"), state.simulate ? "模拟模式" : "实机模式", state.simulate ? "warn" : "");
  updateChip(byId("connectionChip"), connected ? "已连接" : "未连接", connected ? "good" : "muted");
  updateChip(byId("calibrationChip"), state.calibrated ? "标定完成" : "等待标定", state.calibrated ? "good" : "warn");
  updateChip(
    byId("actionChip"),
    faulted
      ? "故障锁存"
      : visionOn
        ? vision.streaming ? "视觉跟随" : "视觉安全暂停"
      : action
        ? `${state.action_name || "动作中"} · ${state.action_speed_percent || "--"}%`
        : ready
          ? "已使能"
          : "空闲",
    faulted ? "danger" : visionOn ? (vision.streaming ? "good" : "warn") : action ? "warn" : ready ? "good" : "muted",
  );

  byId("startCameraButton").disabled = Boolean(vision.running) || visionOn || visionCaptureBusy;
  byId("stopCameraButton").disabled = !vision.running || visionOn || visionCaptureBusy;
  byId("cameraIndex").disabled = Boolean(vision.running) || visionOn || visionCaptureBusy;
  byId("visionHandedness").disabled = Boolean(vision.running) || visionOn || visionCaptureBusy;
  document.querySelectorAll(".vision-pose").forEach((button) => {
    button.disabled = !vision.running || visionOn || visionCaptureBusy;
  });
  byId("resetVisionCalibrationButton").disabled = visionOn || visionCaptureBusy;
  const visionReady = connected && ready && state.calibrated && vision.running && vision.calibrated;
  byId("visionToggleButton").disabled = visionOn
    ? false
    : !visionReady || !byId("visionConfirm").checked;
  byId("visionScale").disabled = visionOn;
}

function renderCameraChoices(vision) {
  const choices = vision.available_cameras || [];
  const signature = JSON.stringify(choices);
  if (!choices.length || signature === cameraChoicesSignature || vision.running) return;
  cameraChoicesSignature = signature;
  const select = byId("cameraIndex");
  select.replaceChildren();
  choices.forEach((choice) => {
    const option = document.createElement("option");
    option.value = String(choice.index);
    option.textContent = `${choice.name}${choice.recommended ? "（推荐）" : ""}`;
    select.append(option);
  });
  const preferred = choices.find((item) => item.recommended) || choices[0];
  select.value = String(preferred.index);
}

function renderVision(vision = {}) {
  const cameraRunning = Boolean(vision.running);
  const handDetected = Boolean(vision.hand_detected);
  const switchOn = Boolean(vision.switch_on);
  const streaming = Boolean(vision.streaming);
  renderCameraChoices(vision);
  updateChip(
    byId("visionCameraChip"),
    cameraRunning ? (vision.camera_name || `摄像头 ${vision.camera_index}`) : "摄像头关闭",
    cameraRunning ? "good" : "muted",
  );
  updateChip(
    byId("visionTrackingChip"),
    handDetected ? `${vision.handedness === "Left" ? "左" : "右"}手 ${Math.round(Number(vision.confidence || 0) * 100)}%` : "未识别",
    handDetected ? "good" : cameraRunning ? "warn" : "muted",
  );
  const heartbeatOk = switchOn && Number(vision.heartbeat_age_s || 99) < 0.75;
  updateChip(byId("visionHeartbeatChip"), heartbeatOk ? "心跳正常" : "网页未接管", heartbeatOk ? "good" : "muted");
  updateChip(
    byId("visionSessionChip"),
    streaming ? "正在同步" : switchOn ? "安全暂停" : "同步关闭",
    streaming ? "good" : switchOn ? "warn" : "muted",
  );

  const preview = byId("visionPreview");
  if (cameraRunning && !preview.getAttribute("src")) {
    preview.src = window.DEMO_PREVIEW_URL || `/api/vision/preview.mjpeg?t=${Date.now()}`;
  } else if (!cameraRunning && preview.getAttribute("src")) {
    preview.removeAttribute("src");
  }
  byId("cameraPlaceholder").hidden = cameraRunning;
  if (!cameraRunning) byId("visionHandedness").value = vision.expected_handedness || "Right";
  byId("visionReason").textContent = vision.error
    || vision.calibration_error
    || vision.pause_reason
    || (streaming ? "识别、网页心跳与七路安全监督均正常。" : "视觉同步待命；开启后会从当前实测位置平滑接管。");
  byId("visionToggleLabel").textContent = switchOn ? "关闭并冻结" : "开启视觉同步";
  byId("visionToggleButton").classList.toggle("active", switchOn);

  const captured = vision.captured_poses || {};
  document.querySelectorAll(".vision-pose").forEach((button) => {
    const count = Number(captured[button.dataset.pose] || 0);
    const marker = button.querySelector("span");
    marker.textContent = count ? `${count} 帧` : (vision.calibrated ? "已保存" : "未采集");
    button.classList.toggle("captured", count > 0 || Boolean(vision.calibrated));
  });
  const calibrationCheck = byId("visionCalibrationCheck");
  calibrationCheck.textContent = vision.calibrated
    ? "视觉标定有效；视觉输出将套用原有按键的张开/握拳实机端点。"
    : (vision.calibration_error || "尚未获得可用标定；请按 ① → ④ 依次采集。");
  calibrationCheck.className = `vision-calibration-check ${vision.calibrated ? "valid" : "neutral"}`;

  const axisList = byId("visionAxisList");
  if (axisList.children.length !== channelMeta.length) {
    axisList.replaceChildren();
    channelMeta.forEach(([, label], index) => {
      const row = document.createElement("div");
      row.className = "vision-axis";
      row.dataset.axis = String(index);
      row.innerHTML = `<span>${label}</span><div class="vision-axis-track"><i></i><b></b></div><output>--</output>`;
      axisList.append(row);
    });
  }
  const outputs = vision.output_fractions || [];
  const low = vision.limited_low || [];
  const high = vision.limited_high || [];
  channelMeta.forEach((_, index) => {
    const row = axisList.querySelector(`[data-axis="${index}"]`);
    const value = outputs[index] == null ? null : Math.max(0, Math.min(1, Number(outputs[index])));
    row.querySelector("i").style.width = value == null ? "0%" : `${value * 100}%`;
    row.querySelector("b").style.left = value == null ? "2%" : `${value * 100}%`;
    row.querySelector("output").textContent = value == null ? "--" : `${Math.round(value * 100)}%`;
    row.classList.toggle("limited", Boolean(low[index] || high[index]));
  });
}

function renderServoSpeedOutput(percent, speedControl = currentState?.speed_control) {
  if (!speedControl) {
    byId("servoSpeedOutput").textContent = "STS速度待连接";
    return;
  }
  const minimum = Number(speedControl.configured_command_speed_min || 0);
  const maximum = Number(speedControl.configured_command_speed_max || minimum);
  const ratio = Math.max(0, Math.min(1, (percent - 20) / 80));
  const commandSpeed = Math.round(minimum + ratio * (maximum - minimum));
  byId("servoSpeedOutput").textContent = `实际STS速度上限 ${commandSpeed}`;
}

function renderGestures(gestures) {
  const signature = JSON.stringify(gestures);
  if (signature === gestureSignature) return;
  gestureSignature = signature;

  const grid = byId("gestureGrid");
  grid.replaceChildren();
  gestures.forEach((gesture, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gesture-button";
    button.dataset.verified = String(gesture.verified);
    button.dataset.name = gesture.name;
    button.innerHTML = `
      <span class="gesture-index">${String(index + 1).padStart(2, "0")}</span>
      <strong>${gesture.label}</strong>
      <small>${gesture.verified ? "全幅执行" : "待实机确认 · 35%预览"}</small>
    `;
    button.addEventListener("click", async () => {
      const scale = gesture.verified ? 1 : 0.35;
      await perform(`/api/gestures/${gesture.name}/run`, "POST", {
        scale,
        speed_scale: Number(byId("globalSpeed").value) / 100,
      });
    });
    grid.append(button);
  });

  const select = byId("gestureSelect");
  const previous = select.value;
  select.replaceChildren();
  gestures.forEach((gesture) => {
    const option = document.createElement("option");
    option.value = gesture.name;
    option.textContent = gesture.label;
    select.append(option);
  });
  select.value = gestures.some((item) => item.name === previous) ? previous : "open";
  loadGestureIntoEditor(select.value);
}

function renderTelemetry(channels) {
  const list = byId("telemetryList");
  if (list.children.length !== channelMeta.length) {
    list.replaceChildren();
    channelMeta.forEach(([name, label]) => {
      const card = document.createElement("article");
      card.className = "telemetry-card";
      card.dataset.channel = name;
      card.innerHTML = `
        <header>
          <div><h3>${label}</h3><span class="servo-id">ID --</span></div>
          <span class="effort-chip muted" data-field="state">监控</span>
        </header>
        <div class="telemetry-values">
          <div><small>POSITION</small><strong data-field="position">--</strong></div>
          <div><small>CURRENT</small><strong data-field="current">--</strong></div>
          <div><small>LOAD</small><strong data-field="load">--</strong></div>
          <div><small>TORQUE ≈</small><strong data-field="torque">--</strong></div>
          <div><small>ACTIVE LIMIT</small><strong data-field="limit">--</strong></div>
          <div><small>TEMP</small><strong data-field="temp">--</strong></div>
        </div>
        <div class="telemetry-peak" data-field="peak">尚无动作峰值</div>
        <div class="telemetry-contact" data-field="contact">接触检测待命</div>
        <div class="telemetry-bar"><span style="width:0%"></span></div>
        <div class="telemetry-bar effort"><span style="width:0%"></span></div>
      `;
      list.append(card);
    });
  }

  const channelMap = new Map(channels.map((item) => [item.channel, item]));
  channelMeta.forEach(([name]) => {
    const card = list.querySelector(`[data-channel="${name}"]`);
    const item = channelMap.get(name);
    card.querySelector(".servo-id").textContent = item
      ? `ID ${item.servo_id} · SAFE ${item.raw_at_actuation_min}–${item.raw_at_actuation_max}`
      : "ID --";
    card.querySelector('[data-field="position"]').textContent = item?.position ?? "--";
    card.querySelector('[data-field="current"]').textContent = item?.current_ma == null ? "--" : `${Math.round(item.current_ma)}mA`;
    card.querySelector('[data-field="load"]').textContent = item?.load ?? "--";
    card.querySelector('[data-field="torque"]').textContent = item?.estimated_torque_nm == null ? "--" : `${item.estimated_torque_nm.toFixed(2)}Nm`;
    card.querySelector('[data-field="limit"]').textContent = item == null
      ? "--"
      : `${(item.active_torque_limit / 10).toFixed(0)}% · ${item.active_torque_limit_nm.toFixed(2)}Nm · ${item.torque_limit_verified ? "已回读" : "待回读"}`;
    card.querySelector('[data-field="temp"]').textContent = item?.temperature_c == null ? "--" : `${item.temperature_c.toFixed(0)}°C`;
    card.querySelector('[data-field="peak"]').textContent = item == null
      ? "尚无动作峰值"
      : `动作峰值 ${item.peak_estimated_torque_nm.toFixed(2)}Nm · ${Math.round(item.peak_current_ma)}mA · load ${item.peak_load}`;

    const stateLabel = item?.effort_state === "contact"
      ? "已抓稳"
      : item?.effort_state === "safety_stop"
        ? "保护停止"
        : item?.effort_state === "moving"
          ? "抓握监控"
          : "监控";
    const stateTone = item?.effort_state === "contact"
      ? "good"
      : item?.effort_state === "safety_stop"
        ? "danger"
        : item?.effort_state === "moving"
          ? "warn"
          : "muted";
    const stateNode = card.querySelector('[data-field="state"]');
    stateNode.textContent = stateLabel;
    stateNode.className = `effort-chip ${stateTone}`;
    card.classList.toggle("contact-latched", item?.effort_state === "contact");
    card.classList.toggle("safety-stopped", item?.effort_state === "safety_stop");

    const contactNode = card.querySelector('[data-field="contact"]');
    if (item?.contact) {
      contactNode.textContent = item.contact.state === "contact"
        ? `接触于 ${item.contact.position} · 已冻结并降至保持上限 ${(item.hold_torque_limit / 10).toFixed(0)}%`
        : `保护停止于 ${item.contact.position} · 请检查腱绳与机构`;
      contactNode.title = item.contact.reason || "";
    } else if (item) {
      contactNode.textContent = `判据 ≥${Math.round(item.contact_current_threshold_ma)}mA 或 load≥${item.contact_load_threshold}，持续 ${item.contact_confirm_duration_s.toFixed(2)}s`;
      contactNode.title = "同时要求目标尚未到达且位置基本不再变化";
    } else {
      contactNode.textContent = "接触检测待命";
      contactNode.title = "";
    }

    const fraction = item?.fraction == null ? 0 : Math.max(0, Math.min(1, item.fraction));
    card.querySelector(".telemetry-bar span").style.width = `${Math.round(fraction * 100)}%`;
    const effortRatio = item == null
      ? 0
      : Math.max(
          item.current_ma / item.contact_current_threshold_ma,
          item.load / item.contact_load_threshold,
        );
    const effortBar = card.querySelector(".telemetry-bar.effort span");
    effortBar.style.width = `${Math.round(Math.min(1, effortRatio) * 100)}%`;
    effortBar.className = effortRatio >= 1 ? "at-threshold" : effortRatio >= 0.75 ? "near-threshold" : "";
  });
}

function renderProtectionOutputs(settings) {
  const stallTorque = Number(settings?.stall_torque_nm || 0);
  const motion = Number(byId("motionTorqueLimit").value);
  const hold = Number(byId("holdTorqueLimit").value);
  const motionNm = stallTorque * motion / 1000;
  const holdNm = stallTorque * hold / 1000;
  byId("motionTorqueLimitOutput").textContent = `${motion} · ${motionNm.toFixed(2)}Nm≈`;
  byId("holdTorqueLimitOutput").textContent = `${hold} · ${holdNm.toFixed(2)}Nm≈`;
  byId("contactCurrentThresholdOutput").textContent = `${Math.round(Number(byId("contactCurrentThreshold").value))}mA`;
  byId("contactLoadThresholdOutput").textContent = String(Math.round(Number(byId("contactLoadThreshold").value)));
  byId("contactDurationThresholdOutput").textContent = `${Number(byId("contactDurationThreshold").value).toFixed(2)}s`;
}

function loadProtectionInputs(settings, force = false) {
  if (!settings || (protectionDirty && !force)) return;
  const limits = settings.limits || {};
  const motion = byId("motionTorqueLimit");
  const hold = byId("holdTorqueLimit");
  const current = byId("contactCurrentThreshold");
  const load = byId("contactLoadThreshold");
  const duration = byId("contactDurationThreshold");

  motion.min = limits.motion_torque_min ?? 20;
  motion.max = limits.motion_torque_max ?? 250;
  hold.min = limits.hold_torque_min ?? 0;
  current.min = limits.contact_current_min_ma ?? 100;
  current.max = limits.contact_current_max_ma ?? 900;
  load.min = limits.contact_load_min ?? 10;
  load.max = limits.contact_load_max ?? 800;
  duration.min = limits.contact_duration_min_s ?? 0.10;
  duration.max = limits.contact_duration_max_s ?? 1.00;

  motion.value = settings.motion_torque_limit;
  hold.max = settings.motion_torque_limit;
  hold.value = settings.hold_torque_limit;
  current.value = settings.contact_current_ma;
  load.value = settings.contact_load;
  duration.value = settings.contact_confirm_duration_s;
  renderProtectionOutputs(settings);
}

function renderProtectionSettings(settings) {
  if (!settings) return;
  const signature = JSON.stringify({
    motion: settings.motion_torque_limit,
    hold: settings.hold_torque_limit,
    current: settings.contact_current_ma,
    load: settings.contact_load,
    duration: settings.contact_confirm_duration_s,
    limits: settings.limits,
  });
  if (!protectionDirty && signature !== protectionSignature) {
    protectionSignature = signature;
    loadProtectionInputs(settings, true);
  } else {
    renderProtectionOutputs(settings);
  }

  const verification = settings.write_verification || {};
  const output = byId("protectionVerificationOutput");
  if (!settings.uniform_across_channels) {
    output.textContent = "当前七路上限不一致；保存后将统一为本面板设定值。";
    output.className = "protection-verification blocked";
  } else if (verification.state === "verified") {
    output.textContent = `${verification.verified_count}/${verification.expected_count} 路限制寄存器写入并回读一致`;
    output.className = "protection-verification verified";
  } else if (verification.state === "pending") {
    output.textContent = "参数已保存；卸力状态下待下次控制使能时逐路写入并回读。";
    output.className = "protection-verification pending";
  } else {
    output.textContent = "参数已保存在配置中；连接并使能后将逐路写入、回读确认。";
    output.className = "protection-verification pending";
  }
}

function renderEffortSummary(summary, channels, protectionSettings) {
  const safeSummary = summary || {};
  byId("currentTorqueOutput").textContent = `${Number(safeSummary.current_max_estimated_torque_nm || 0).toFixed(2)} Nm`;
  byId("peakTorqueOutput").textContent = `${Number(safeSummary.action_peak_estimated_torque_nm || 0).toFixed(2)} Nm`;
  const configuredCap = Number(
    safeSummary.configured_motion_cap_nm || protectionSettings?.motion_torque_limit_nm || 0,
  );
  byId("torqueCapOutput").textContent = `${configuredCap.toFixed(2)} Nm≈`;
  const contactCount = Number(safeSummary.contact_count || 0);
  const chip = byId("contactCountChip");
  chip.textContent = contactCount ? `${contactCount} 路已抓稳` : "未接触";
  chip.className = `effort-chip ${contactCount ? "good" : "muted"}`;
  const reference = channels.find((item) => item.contact_current_threshold_ma != null);
  byId("contactRuleOutput").textContent = reference
    ? `自动停止继续收线：≥${Math.round(reference.contact_current_threshold_ma)}mA 或 load≥${reference.contact_load_threshold}，且近似不动持续 ${reference.contact_confirm_duration_s.toFixed(2)}s。`
    : "等待读取接触判据。";
  byId("torqueModelNote").textContent = `${safeSummary.measurement_warning || "估算值"}；保护判断使用原始电流、load、位置与持续时间。`;
}

function renderCalibrationDraft(state) {
  const channel = byId("channelSelect").value;
  const draft = state.calibration_drafts[channel] || { min: null, max: null };
  byId("minOutput").textContent = draft.min == null ? "尚未记录" : String(draft.min);
  byId("maxOutput").textContent = draft.max == null ? "尚未记录" : String(draft.max);
}

function circularSignedDelta(start, end) {
  return ((end - start + 2048) % 4096 + 4096) % 4096 - 2048;
}

function circularDistance(start, end) {
  return Math.abs(circularSignedDelta(start, end));
}

function selectedRecoveryChannel(state = currentState) {
  if (!state) return null;
  const name = byId("recoveryChannelSelect").value;
  return state.channels.find((item) => item.channel === name) || null;
}

function recoverySuggestedTarget(item) {
  if (!item || item.position == null) return null;
  const low = Number(item.soft_min);
  const high = Number(item.soft_max);
  const position = Number(item.position);
  const step = 100;
  if (position >= low && position <= high) return position;
  if (position > high) return Math.max(high, position - step);
  return Math.min(low, position + step);
}

function renderRecovery(state, keepTarget = true) {
  const item = selectedRecoveryChannel(state);
  const currentOutput = byId("recoveryCurrentOutput");
  const rangeOutput = byId("recoveryRangeOutput");
  const suggestedOutput = byId("recoverySuggestedOutput");
  if (!item || item.position == null) {
    currentOutput.textContent = "--";
    rangeOutput.textContent = "--";
    suggestedOutput.textContent = "--";
    return;
  }
  const suggested = recoverySuggestedTarget(item);
  currentOutput.textContent = String(item.position);
  rangeOutput.textContent = `${item.soft_min}–${item.soft_max}`;
  const outside = item.position < item.soft_min || item.position > item.soft_max;
  suggestedOutput.textContent = outside
    ? (suggested == null ? "--" : String(suggested))
    : "无需恢复";
  currentOutput.className = outside ? "outside" : "inside";
  if (!keepTarget && suggested != null) byId("recoveryTargetInput").value = suggested;

  const settings = state.recovery_settings || {};
  byId("recoveryLimitsOutput").textContent = [
    `固定保护：速度 ${settings.speed ?? 50}`,
    `输出上限 ${settings.torque_limit ?? 50}/1000`,
    `电流 ${Math.round(settings.current_limit_ma ?? 350)}mA`,
    `load ${settings.load_limit ?? 350}`,
    `单次直接位移 ≤${settings.maximum_single_move_counts ?? 100} counts`,
    `扭矩使能与输出限制均会回读确认`,
  ].join("、") + "。";
}

function recoveryConfirmed() {
  if (!byId("recoveryConfirm").checked) {
    setMessage("请先确认物理急停、单轴无明显外力和其他六路卸力。", true);
    return false;
  }
  return true;
}

async function runRecovery(target) {
  if (!recoveryConfirmed()) return;
  const item = selectedRecoveryChannel();
  if (!item || item.position == null) {
    setMessage("尚未读取到所选舵机当前位置。", true);
    return;
  }
  const value = Number(target);
  if (!Number.isInteger(value) || value < 0 || value > 4095) {
    setMessage("恢复目标必须是 0–4095 的整数。", true);
    return;
  }
  const distance = Math.abs(value - Number(item.position));
  const boundary = distance > 2048;
  if (boundary) {
    setMessage("v0.2.6 为避免位置模式误转一整圈，禁止直接跨越 0/4095；请沿数字连续方向分步恢复。", true);
    return;
  }
  if (!window.confirm(
    `只恢复 ${item.label} / ID ${item.servo_id}：${item.position} → ${value}\n` +
    `直接位移 ${distance} counts。\n` +
    "程序会以低速低输出运行并在结束后自动卸力；确认执行吗？"
  )) return;
  await perform("/api/recovery/move", "POST", {
    channel: item.channel,
    target_position: value,
    confirmed: true,
    boundary_confirmed: false,
  });
}

function loadGestureIntoEditor(name) {
  if (!currentState) return;
  const gesture = currentState.gestures.find((item) => item.name === name);
  if (!gesture) return;
  byId("gestureName").value = gesture.name;
  byId("gestureLabel").value = gesture.label;
  byId("durationInput").value = gesture.duration_s;
  byId("holdInput").value = gesture.hold_s;
  byId("contactAllowed").checked = gesture.contact_allowed;
  byId("gestureVerified").checked = gesture.verified;
  gesture.fractions.forEach((value, index) => {
    const input = byId(`axis-${index}`);
    if (input) {
      input.value = Math.round(value * 100);
      byId(`axis-output-${index}`).textContent = `${input.value}%`;
    }
  });
}

async function refreshState() {
  if (polling) return;
  polling = true;
  try {
    const state = await api("/api/state");
    currentState = state;
    renderGestures(state.gestures);
    renderProtectionSettings(state.protection_settings);
    renderRecovery(state);
    renderVision(state.vision);
    renderControls(state);
    renderTelemetry(state.channels);
    renderEffortSummary(state.effort_summary, state.channels, state.protection_settings);
    renderCalibrationDraft(state);
    setMessage(state.error || state.message, Boolean(state.error));
  } catch (error) {
    setMessage(`无法读取控制服务：${error.message}`, true);
  } finally {
    polling = false;
  }
}

function buildStaticControls() {
  const channelSelect = byId("channelSelect");
  const recoveryChannelSelect = byId("recoveryChannelSelect");
  channelMeta.forEach(([name, label], index) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = `ID ${index} · ${label}`;
    channelSelect.append(option);
    recoveryChannelSelect.append(option.cloneNode(true));
  });

  const sliderGrid = byId("sliderGrid");
  channelMeta.forEach(([, label], index) => {
    const wrapper = document.createElement("div");
    wrapper.className = "axis-slider";
    wrapper.innerHTML = `
      <label for="axis-${index}">${label}</label>
      <input id="axis-${index}" type="range" min="0" max="100" step="1" value="0">
      <output id="axis-output-${index}">0%</output>
    `;
    const input = wrapper.querySelector("input");
    input.addEventListener("input", () => {
      byId(`axis-output-${index}`).textContent = `${input.value}%`;
    });
    sliderGrid.append(wrapper);
  });
}

function editorFractions() {
  return channelMeta.map((_, index) => Number(byId(`axis-${index}`).value) / 100);
}

function protectionPayload() {
  const motion = Number(byId("motionTorqueLimit").value);
  const hold = Number(byId("holdTorqueLimit").value);
  if (hold > motion) {
    throw new Error("抓稳保持上限不能高于运动上限");
  }
  return {
    motion_torque_limit: motion,
    hold_torque_limit: hold,
    contact_current_ma: Number(byId("contactCurrentThreshold").value),
    contact_load: Number(byId("contactLoadThreshold").value),
    contact_confirm_duration_s: Number(byId("contactDurationThreshold").value),
    confirmed: true,
  };
}

function calibrationConfirmed() {
  if (!byId("calibrationConfirm").checked) {
    setMessage("请先确认物理急停和单轴安全条件。", true);
    return false;
  }
  return true;
}

const delay = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

async function captureVisionPose(button) {
  if (visionCaptureBusy) return;
  visionCaptureBusy = true;
  if (currentState) renderControls(currentState);
  const guide = byId("visionCaptureGuide");
  const countdown = byId("visionCaptureCountdown");
  byId("visionCapturePoseLabel").textContent = button.dataset.label;
  byId("visionCaptureInstruction").textContent = button.dataset.instruction;
  guide.hidden = false;
  try {
    for (let value = 3; value >= 1; value -= 1) {
      countdown.textContent = String(value);
      setMessage(`准备采集“${button.dataset.label}”：${value}……`);
      await delay(1000);
    }
    countdown.textContent = "采集";
    setMessage(`正在采集“${button.dataset.label}”，请保持不动约 1 秒……`);
    await perform("/api/vision/calibration/capture", "POST", { pose_name: button.dataset.pose });
  } finally {
    guide.hidden = true;
    visionCaptureBusy = false;
    if (currentState) renderControls(currentState);
  }
}

function bindEvents() {
  byId("connectButton").addEventListener("click", () => perform("/api/connect"));
  byId("disconnectButton").addEventListener("click", () => perform("/api/disconnect"));
  byId("armButton").addEventListener("click", () => perform("/api/arm"));
  byId("disarmButton").addEventListener("click", () => perform("/api/disarm"));
  byId("stopButton").addEventListener("click", () => perform("/api/stop"));
  byId("estopButton").addEventListener("click", async () => {
    if (window.confirm("软件急停将立即卸力并锁存。确认执行吗？")) {
      await perform("/api/estop");
    }
  });

  byId("startCameraButton").addEventListener("click", async () => {
    const result = await perform("/api/vision/camera/start", "POST", {
      camera_index: Number(byId("cameraIndex").value),
      handedness: byId("visionHandedness").value,
    });
    if (result) byId("visionPreview").src = window.DEMO_PREVIEW_URL || `/api/vision/preview.mjpeg?t=${Date.now()}`;
  });
  byId("stopCameraButton").addEventListener("click", async () => {
    await perform("/api/vision/camera/stop");
    byId("visionPreview").removeAttribute("src");
  });
  document.querySelectorAll(".vision-pose").forEach((button) => {
    button.addEventListener("click", () => captureVisionPose(button));
  });
  byId("resetVisionCalibrationButton").addEventListener("click", async () => {
    if (!window.confirm("清除当前视觉标定并重新采集四个姿态吗？原有按键手势参数不会改变。")) return;
    await perform("/api/vision/calibration/reset", "POST", { confirmed: true });
  });
  byId("visionConfirm").addEventListener("change", () => {
    if (currentState) renderControls(currentState);
  });
  byId("visionScale").addEventListener("input", (event) => {
    byId("visionScaleOutput").textContent = `${event.target.value}%`;
  });
  byId("visionToggleButton").addEventListener("click", async () => {
    if (currentState?.vision?.switch_on) {
      await perform("/api/vision/session/pause");
      return;
    }
    await perform("/api/vision/session/start", "POST", {
      confirmed: byId("visionConfirm").checked,
      scale: Number(byId("visionScale").value) / 100,
    });
  });

  protectionInputIds.forEach((id) => {
    byId(id).addEventListener("input", () => {
      if (id === "motionTorqueLimit") {
        const hold = byId("holdTorqueLimit");
        hold.max = byId("motionTorqueLimit").value;
        if (Number(hold.value) > Number(hold.max)) hold.value = hold.max;
      }
      protectionDirty = true;
      renderProtectionOutputs(currentState?.protection_settings);
      if (currentState) renderControls(currentState);
    });
  });
  byId("protectionConfirm").addEventListener("change", () => {
    if (currentState) renderControls(currentState);
  });
  byId("resetProtectionButton").addEventListener("click", () => {
    protectionDirty = false;
    byId("protectionConfirm").checked = false;
    loadProtectionInputs(currentState?.protection_settings, true);
    if (currentState) renderControls(currentState);
    setMessage("已恢复页面中最后保存的保护参数，未写入新值。", false);
  });
  byId("applyProtectionButton").addEventListener("click", async () => {
    try {
      const payload = protectionPayload();
      const summary = [
        `运动 ${payload.motion_torque_limit}/1000`,
        `保持 ${payload.hold_torque_limit}/1000`,
        `接触 ${payload.contact_current_ma}mA 或 load ${payload.contact_load}`,
        `持续 ${payload.contact_confirm_duration_s.toFixed(2)}s`,
      ].join("；");
      if (!window.confirm(`确认保存以下保护参数吗？\n${summary}\n提高上限前必须先从低值完成实机测试。`)) return;
      await perform("/api/protection", "PUT", payload);
      protectionDirty = false;
      byId("protectionConfirm").checked = false;
      await refreshState();
    } catch (error) {
      setMessage(error.message, true);
    }
  });

  byId("calibrationConfirm").addEventListener("change", () => {
    if (currentState) renderControls(currentState);
  });
  byId("channelSelect").addEventListener("change", () => {
    if (currentState) {
      renderCalibrationDraft(currentState);
      renderControls(currentState);
    }
  });
  document.querySelectorAll(".jog").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!calibrationConfirmed()) return;
      await perform("/api/calibration/jog", "POST", {
        channel: byId("channelSelect").value,
        delta_counts: Number(button.dataset.delta),
        confirmed: true,
      });
    });
  });
  byId("captureMinButton").addEventListener("click", async () => {
    if (!calibrationConfirmed()) return;
    await perform("/api/calibration/capture", "POST", {
      channel: byId("channelSelect").value,
      endpoint: "min",
      confirmed: true,
    });
  });
  byId("captureMaxButton").addEventListener("click", async () => {
    if (!calibrationConfirmed()) return;
    await perform("/api/calibration/capture", "POST", {
      channel: byId("channelSelect").value,
      endpoint: "max",
      confirmed: true,
    });
  });
  byId("saveCalibrationButton").addEventListener("click", async () => {
    if (!calibrationConfirmed()) return;
    if (!window.confirm("确认两个记录位置都是保留裕量后的安全端点吗？")) return;
    await perform("/api/calibration/save", "POST", {
      channel: byId("channelSelect").value,
      confirmed: true,
    });
  });
  byId("rezeroButton").addEventListener("click", async () => {
    if (!calibrationConfirmed()) return;
    if (!window.confirm("确认手指完全张开、腱绳刚好绷直且棘轮已锁定吗？")) return;
    await perform("/api/calibration/rezero", "POST", {
      channel: byId("channelSelect").value,
      confirmed: true,
    });
  });

  byId("recoveryConfirm").addEventListener("change", () => {
    if (currentState) renderControls(currentState);
  });
  byId("recoveryBoundaryConfirm").addEventListener("change", () => {
    if (currentState) renderControls(currentState);
  });
  byId("recoveryChannelSelect").addEventListener("change", () => {
    if (currentState) {
      renderRecovery(currentState, false);
      renderControls(currentState);
    }
  });
  byId("recoverySuggestedButton").addEventListener("click", () => {
    const item = selectedRecoveryChannel();
    const target = recoverySuggestedTarget(item);
    if (target != null) byId("recoveryTargetInput").value = target;
  });
  byId("recoveryMinButton").addEventListener("click", () => {
    const item = selectedRecoveryChannel();
    if (item?.raw_at_actuation_min != null) byId("recoveryTargetInput").value = item.raw_at_actuation_min;
  });
  byId("recoveryZeroButton").addEventListener("click", () => {
    byId("recoveryTargetInput").value = 0;
  });
  byId("recoveryMaxRawButton").addEventListener("click", () => {
    byId("recoveryTargetInput").value = 4095;
  });
  document.querySelectorAll(".recovery-jog").forEach((button) => {
    button.addEventListener("click", async () => {
      const item = selectedRecoveryChannel();
      if (!item || item.position == null) return;
      const target = ((Number(item.position) + Number(button.dataset.delta)) % 4096 + 4096) % 4096;
      byId("recoveryTargetInput").value = target;
      await runRecovery(target);
    });
  });
  byId("recoveryRunButton").addEventListener("click", async () => {
    await runRecovery(Number(byId("recoveryTargetInput").value));
  });

  byId("gestureSelect").addEventListener("change", (event) => {
    loadGestureIntoEditor(event.target.value);
  });
  byId("previewScale").addEventListener("input", (event) => {
    byId("previewScaleOutput").textContent = `${event.target.value}%`;
  });
  byId("globalSpeed").addEventListener("input", (event) => {
    byId("globalSpeedOutput").textContent = `${event.target.value}%`;
    renderServoSpeedOutput(Number(event.target.value));
  });
  byId("previewButton").addEventListener("click", async () => {
    await perform("/api/preview", "POST", {
      fractions: editorFractions(),
      duration_s: Number(byId("durationInput").value),
      contact_allowed: byId("contactAllowed").checked,
      scale: Number(byId("previewScale").value) / 100,
      speed_scale: Number(byId("globalSpeed").value) / 100,
      confirmed: byId("previewConfirm").checked,
    });
  });
  byId("saveGestureButton").addEventListener("click", async () => {
    const name = byId("gestureName").value.trim();
    await perform(`/api/gestures/${encodeURIComponent(name)}`, "PUT", {
      label: byId("gestureLabel").value.trim(),
      fractions: editorFractions(),
      duration_s: Number(byId("durationInput").value),
      hold_s: Number(byId("holdInput").value),
      contact_allowed: byId("contactAllowed").checked,
      verified: byId("gestureVerified").checked,
    });
  });
}

function updateClock() {
  byId("clockOutput").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

buildStaticControls();
bindEvents();
refreshState();
updateClock();
window.setInterval(refreshState, 600);
window.setInterval(async () => {
  if (!currentState?.vision?.switch_on) return;
  try {
    await api("/api/vision/heartbeat", "POST");
  } catch (_) {
    // 后台心跳超时会冻结当前位置；状态轮询会显示具体原因。
  }
}, 250);
window.setInterval(updateClock, 1000);
