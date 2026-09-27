"use strict";

(() => {
  const originalFetch = window.fetch.bind(window);
  window.DEMO_PREVIEW_URL = "./hand-tracking-demo.svg";

  const channelSpecs = [
    ["thumb_cmc_abduction", "拇指外展", 0, 2170, 2930],
    ["thumb_cmc_flexion", "拇指 CMC", 1, 840, 1530],
    ["thumb_tendon", "拇指腱绳", 2, 0, 1800],
    ["index_tendon", "食指腱绳", 3, 0, 3150],
    ["middle_tendon", "中指腱绳", 4, 0, 3150],
    ["ring_tendon", "无名指腱绳", 5, 0, 3150],
    ["pinky_tendon", "小指腱绳", 6, 0, 3150],
  ];

  const gestureSeed = [
    ["open", "完全张开", [1, 0, 0, 0, 0, 0, 0], 1.6, 0.1, false],
    ["fist", "空握拳", [0.48, 0.38, 0.83, 0.90, 0.90, 0.91, 0.92], 1.6, 0.8, true],
    ["power_grasp", "抓握物体", [0.16, 0.66, 0.76, 0.91, 0.91, 0.91, 0.91], 6.0, 1.5, true],
    ["cylindrical", "圆柱抓握", [0.17, 0.37, 0.64, 0.89, 0.91, 0.93, 0.95], 6.0, 1.5, true],
    ["pinch_index", "食指捏取", [0.24, 0.56, 0.62, 0.61, 0, 0, 0], 1.6, 0.1, true],
    ["touch_middle", "触碰中指", [0, 0.82, 0.51, 0, 0.58, 0, 0], 1.6, 0.7, true],
    ["touch_ring", "触碰无名指", [0, 0.87, 0.46, 0, 0, 0.62, 0], 1.6, 0.7, true],
    ["touch_pinky", "国际友好手势", [0, 0.61, 0.68, 0.89, 0, 0.86, 0.87], 2.2, 0.7, false],
    ["peace", "V 字手势", [0.53, 0.66, 0.76, 0, 0, 0.92, 0.93], 1.6, 1.0, false],
    ["rockstar", "Rockstar", [0, 0.66, 0.50, 0, 0.78, 0.80, 0], 2.2, 1.0, true],
  ];

  const gestures = gestureSeed.map(([name, label, fractions, duration, hold, contact]) => ({
    name,
    label,
    fractions,
    duration_s: duration,
    hold_s: hold,
    contact_allowed: contact,
    verified: true,
  }));

  const fractions = [1, 0, 0, 0, 0, 0, 0];
  const calibrationDrafts = Object.fromEntries(
    channelSpecs.map(([name]) => [name, { min: null, max: null }]),
  );

  const state = {
    simulate: true,
    connected: false,
    calibrated: true,
    controller_state: "DISCONNECTED",
    action_active: false,
    action_name: null,
    action_speed_percent: null,
    message: "展示版已载入，点击“连接模拟器”开始体验。",
    error: null,
    gestures,
    calibration_drafts: calibrationDrafts,
    speed_control: {
      configured_command_speed_min: 150,
      configured_command_speed_max: 1400,
    },
    recovery_settings: {
      speed: 50,
      torque_limit: 50,
      current_limit_ma: 350,
      load_limit: 350,
      maximum_single_move_counts: 100,
    },
    protection_settings: {
      editable: false,
      stall_torque_nm: 2.94,
      motion_torque_limit: 120,
      hold_torque_limit: 50,
      contact_current_ma: 250,
      contact_load: 80,
      contact_confirm_duration_s: 0.15,
      uniform_across_channels: true,
      limits: {
        motion_torque_min: 20,
        motion_torque_max: 250,
        hold_torque_min: 0,
        contact_current_min_ma: 100,
        contact_current_max_ma: 900,
        contact_load_min: 10,
        contact_load_max: 800,
        contact_duration_min_s: 0.10,
        contact_duration_max_s: 1.00,
      },
      write_verification: { state: "pending", verified_count: 0, expected_count: 7 },
    },
    vision: {
      running: false,
      hand_detected: false,
      switch_on: false,
      streaming: false,
      camera_index: 1,
      camera_name: "浏览器模拟画面",
      expected_handedness: "Right",
      handedness: "Right",
      confidence: 0.91,
      heartbeat_age_s: 0.08,
      calibrated: true,
      calibration_error: null,
      pause_reason: null,
      error: null,
      captured_poses: {
        open_hand: 15,
        closed_fist: 15,
        thumb_abducted: 15,
        thumb_opposed: 15,
      },
      available_cameras: [
        { index: 1, name: "浏览器模拟画面", recommended: true },
        { index: 0, name: "静态关键点示意", recommended: false },
      ],
      output_fractions: fractions.slice(),
      limited_low: Array(7).fill(false),
      limited_high: Array(7).fill(false),
    },
  };

  let motionTimer = null;
  let visionTimer = null;

  function clamp(value, minimum = 0, maximum = 1) {
    return Math.max(minimum, Math.min(maximum, Number(value)));
  }

  function setMessage(message, error = null) {
    state.message = message;
    state.error = error;
    return { message, error: Boolean(error) };
  }

  function stopMotion(message = null) {
    if (motionTimer !== null) window.clearInterval(motionTimer);
    motionTimer = null;
    state.action_active = false;
    state.action_name = null;
    state.action_speed_percent = null;
    if (message) setMessage(message);
  }

  function stopVision(message = null) {
    if (visionTimer !== null) window.clearInterval(visionTimer);
    visionTimer = null;
    state.vision.switch_on = false;
    state.vision.streaming = false;
    state.vision.pause_reason = message;
    if (message) setMessage(message);
  }

  function animateTo(target, durationSeconds, label, speedPercent = 90) {
    stopMotion();
    const start = fractions.slice();
    const targetFractions = target.map((value) => clamp(value));
    const durationMs = Math.max(650, Math.min(2600, Number(durationSeconds || 1.6) * 650));
    const startedAt = performance.now();
    state.action_active = true;
    state.action_name = label;
    state.action_speed_percent = Math.round(speedPercent);
    setMessage(`正在模拟执行“${label}”……`);
    motionTimer = window.setInterval(() => {
      const progress = clamp((performance.now() - startedAt) / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      fractions.forEach((_, index) => {
        fractions[index] = start[index] + (targetFractions[index] - start[index]) * eased;
      });
      if (progress >= 1) {
        stopMotion(`“${label}”模拟动作完成。`);
      }
    }, 50);
  }

  function startVision(scale) {
    stopMotion();
    if (visionTimer !== null) window.clearInterval(visionTimer);
    state.vision.switch_on = true;
    state.vision.streaming = true;
    state.vision.pause_reason = null;
    const startedAt = performance.now();
    visionTimer = window.setInterval(() => {
      const phase = (performance.now() - startedAt) / 1150;
      const amplitude = clamp(scale, 0.1, 1);
      const targets = [
        0.50 + 0.38 * Math.sin(phase * 0.55),
        0.45 + 0.30 * Math.sin(phase * 0.63 + 0.4),
        0.46 + 0.42 * Math.sin(phase * 0.78 + 0.8),
        0.47 + 0.44 * Math.sin(phase + 0.2),
        0.47 + 0.44 * Math.sin(phase + 0.5),
        0.47 + 0.44 * Math.sin(phase + 0.8),
        0.47 + 0.44 * Math.sin(phase + 1.1),
      ];
      targets.forEach((value, index) => {
        const scaled = 0.5 + (value - 0.5) * amplitude;
        fractions[index] += (clamp(scaled, 0.02, 0.98) - fractions[index]) * 0.22;
      });
    }, 50);
    setMessage("视觉同步演示已开启；七路控制量正在模拟连续更新。");
  }

  function channelSnapshot(spec, index) {
    const [channel, label, servoId, rawMin, rawMax] = spec;
    const connected = state.connected;
    const ready = state.controller_state === "READY";
    const moving = state.action_active || state.vision.streaming;
    const fraction = clamp(fractions[index]);
    const wave = Math.sin(Date.now() / 530 + index * 0.7);
    const current = connected ? Math.round((ready ? 82 : 24) + fraction * 115 + (moving ? 38 : 0) + wave * 6) : 0;
    const load = connected ? Math.max(0, Math.round(fraction * 62 + (moving ? 15 : 0) + wave * 3)) : 0;
    const torque = current * 0.00078;
    const motionLimit = state.protection_settings.motion_torque_limit;
    return {
      channel,
      label,
      servo_id: servoId,
      raw_at_actuation_min: rawMin,
      raw_at_actuation_max: rawMax,
      soft_min: rawMin,
      soft_max: rawMax,
      position: connected ? Math.round(rawMin + (rawMax - rawMin) * fraction) : null,
      fraction,
      current_ma: connected ? current : null,
      load: connected ? load : null,
      estimated_torque_nm: connected ? torque : null,
      active_torque_limit: motionLimit,
      active_torque_limit_nm: 2.94 * motionLimit / 1000,
      torque_limit_verified: ready,
      temperature_c: connected ? 28 + index * 0.45 + fraction * 2 : null,
      peak_estimated_torque_nm: connected ? torque * 1.22 : 0,
      peak_current_ma: connected ? current * 1.18 : 0,
      peak_load: connected ? Math.round(load * 1.18) : 0,
      effort_state: moving ? "moving" : "idle",
      contact: null,
      hold_torque_limit: state.protection_settings.hold_torque_limit,
      contact_current_threshold_ma: state.protection_settings.contact_current_ma,
      contact_load_threshold: state.protection_settings.contact_load,
      contact_confirm_duration_s: state.protection_settings.contact_confirm_duration_s,
    };
  }

  function snapshot() {
    const channels = channelSpecs.map(channelSnapshot);
    const torqueValues = channels.map((item) => Number(item.estimated_torque_nm || 0));
    state.protection_settings.editable = state.connected && state.controller_state === "DISARMED";
    state.vision.output_fractions = fractions.slice();
    state.vision.hand_detected = state.vision.running;
    state.vision.heartbeat_age_s = state.vision.switch_on ? 0.08 : 99;
    return JSON.parse(JSON.stringify({
      ...state,
      channels,
      effort_summary: {
        current_max_estimated_torque_nm: Math.max(...torqueValues),
        action_peak_estimated_torque_nm: Math.max(...torqueValues) * 1.22,
        configured_motion_cap_nm: 2.94 * state.protection_settings.motion_torque_limit / 1000,
        contact_count: 0,
        measurement_warning: "演示估算值，不来自真实舵机",
      },
    }));
  }

  function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function parseBody(options) {
    if (!options || typeof options.body !== "string" || !options.body) return {};
    try {
      return JSON.parse(options.body);
    } catch (_) {
      return {};
    }
  }

  window.fetch = async (input, options = {}) => {
    const rawUrl = typeof input === "string" ? input : input.url;
    const url = new URL(rawUrl, window.location.href);
    if (!url.pathname.startsWith("/api/")) return originalFetch(input, options);

    const path = url.pathname;
    const body = parseBody(options);
    let result = null;

    if (path === "/api/state") return jsonResponse(snapshot());

    if (path === "/api/connect") {
      state.connected = true;
      state.controller_state = "DISARMED";
      result = setMessage("已连接浏览器模拟器，真实串口未被访问。");
    } else if (path === "/api/disconnect") {
      stopMotion();
      stopVision();
      state.connected = false;
      state.controller_state = "DISCONNECTED";
      result = setMessage("模拟器已断开。");
    } else if (path === "/api/arm") {
      state.controller_state = "READY";
      state.protection_settings.write_verification = { state: "verified", verified_count: 7, expected_count: 7 };
      result = setMessage("模拟控制已使能，可以体验预设手势与视觉同步。");
    } else if (path === "/api/disarm") {
      stopMotion();
      stopVision();
      state.controller_state = "DISARMED";
      result = setMessage("模拟输出已卸力。");
    } else if (path === "/api/stop") {
      stopMotion();
      stopVision();
      result = setMessage("已冻结当前模拟动作。");
    } else if (path === "/api/estop") {
      stopMotion();
      stopVision();
      state.controller_state = "ESTOP_LATCHED";
      result = setMessage("模拟急停已触发；断开并重新连接可恢复。", "模拟急停锁存");
    } else if (path === "/api/vision/camera/start") {
      state.vision.running = true;
      state.vision.camera_index = Number(body.camera_index ?? 1);
      state.vision.expected_handedness = body.handedness || "Right";
      state.vision.handedness = body.handedness || "Right";
      result = setMessage("模拟手部关键点画面已启动。");
    } else if (path === "/api/vision/camera/stop") {
      stopVision();
      state.vision.running = false;
      result = setMessage("模拟视觉画面已停止。");
    } else if (path === "/api/vision/calibration/reset") {
      state.vision.calibrated = false;
      Object.keys(state.vision.captured_poses).forEach((key) => { state.vision.captured_poses[key] = 0; });
      result = setMessage("演示标定已清除，可依次采集四个姿态。");
    } else if (path === "/api/vision/calibration/capture") {
      if (body.pose_name in state.vision.captured_poses) state.vision.captured_poses[body.pose_name] = 15;
      state.vision.calibrated = Object.values(state.vision.captured_poses).every((value) => value > 0);
      result = setMessage(state.vision.calibrated ? "四姿态演示标定完成。" : "该姿态已采集 15 帧模拟数据。");
    } else if (path === "/api/vision/session/start") {
      startVision(Number(body.scale || 0.35));
      result = { message: state.message };
    } else if (path === "/api/vision/session/pause") {
      stopVision("视觉同步演示已关闭，七路目标保持在当前位置。");
      result = { message: state.message };
    } else if (path === "/api/vision/heartbeat") {
      state.vision.heartbeat_age_s = 0.03;
      result = { message: "heartbeat" };
    } else if (path.startsWith("/api/gestures/") && path.endsWith("/run")) {
      const name = decodeURIComponent(path.slice("/api/gestures/".length, -"/run".length));
      const gesture = state.gestures.find((item) => item.name === name);
      if (!gesture) return jsonResponse({ detail: "未找到该演示手势" }, 404);
      const scale = clamp(body.scale ?? 1);
      const target = gesture.fractions.map((value) => value * scale);
      animateTo(target, gesture.duration_s, gesture.label, Number(body.speed_scale || 0.9) * 100);
      result = { message: state.message };
    } else if (path === "/api/preview") {
      const scale = clamp(body.scale ?? 0.25);
      animateTo((body.fractions || fractions).map((value) => value * scale), body.duration_s, "低速预览", 35);
      result = { message: state.message };
    } else if (path.startsWith("/api/gestures/") && (options.method || "GET").toUpperCase() === "PUT") {
      const name = decodeURIComponent(path.slice("/api/gestures/".length));
      const saved = {
        name,
        label: body.label || name,
        fractions: (body.fractions || fractions).map((value) => clamp(value)),
        duration_s: Number(body.duration_s || 1.6),
        hold_s: Number(body.hold_s || 0.5),
        contact_allowed: Boolean(body.contact_allowed),
        verified: Boolean(body.verified),
      };
      const index = state.gestures.findIndex((item) => item.name === name);
      if (index >= 0) state.gestures[index] = saved;
      else state.gestures.push(saved);
      result = setMessage(`“${saved.label}”已保存到本次浏览器演示会话。`);
    } else if (path === "/api/protection") {
      Object.assign(state.protection_settings, {
        motion_torque_limit: Number(body.motion_torque_limit),
        hold_torque_limit: Number(body.hold_torque_limit),
        contact_current_ma: Number(body.contact_current_ma),
        contact_load: Number(body.contact_load),
        contact_confirm_duration_s: Number(body.contact_confirm_duration_s),
      });
      result = setMessage("演示保护参数已保存到当前页面会话。");
    } else if (path === "/api/calibration/jog") {
      const index = channelSpecs.findIndex(([name]) => name === body.channel);
      if (index >= 0) {
        const range = channelSpecs[index][4] - channelSpecs[index][3];
        fractions[index] = clamp(fractions[index] + Number(body.delta_counts || 0) / Math.max(1, range));
      }
      result = setMessage("已执行模拟单轴点动。");
    } else if (path === "/api/calibration/capture") {
      const index = channelSpecs.findIndex(([name]) => name === body.channel);
      if (index >= 0) {
        const [, , , rawMin, rawMax] = channelSpecs[index];
        calibrationDrafts[body.channel][body.endpoint] = Math.round(rawMin + (rawMax - rawMin) * fractions[index]);
      }
      result = setMessage(`已记录模拟${body.endpoint === "min" ? "参考" : "安全"}端点。`);
    } else if (path === "/api/calibration/save") {
      result = setMessage("模拟标定已保存到当前页面会话。");
    } else if (path === "/api/calibration/rezero") {
      const index = channelSpecs.findIndex(([name]) => name === body.channel);
      if (index >= 0) fractions[index] = 0;
      result = setMessage("模拟通道已快速归零。");
    } else if (path === "/api/recovery/move") {
      const index = channelSpecs.findIndex(([name]) => name === body.channel);
      if (index >= 0) {
        const [, , , rawMin, rawMax] = channelSpecs[index];
        fractions[index] = clamp((Number(body.target_position) - rawMin) / Math.max(1, rawMax - rawMin));
      }
      result = setMessage("已完成模拟单轴恢复。");
    } else {
      result = setMessage("该实机接口在展示版中以模拟方式处理。");
    }

    return jsonResponse(result || { message: state.message });
  };
})();
