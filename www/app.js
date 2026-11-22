/* ==========================================================================
   ROBOT 2027 - V1.4 PRO (UPDATE 8)
   1. 3-State Voice Architecture (COMMAND_IDLE / TOPIC_SELECT / LESSON_LOCKED)
      + Anti-Self-Echo (850ms post-TTS guard + >60% 4.5s overlap filter + silent unmatched)
      + Topic ID / Name voice selection + Sequential vs Random choice
   2. Universal Virtual Keyboard Modal (#virtual-kb-modal: Numpad + QWERTY)
      + Zero native Android keyboard popup on landscape Kiosk screen
   3. In-App Bluetooth BLE Scanner & Config Modal (BleClient.requestLEScan)
      + Priority sorting for ESP32/Robot + PIN + Auto-Reconnect persistence
   4. Permanent Hardware DEVICE_UID Offline QR Code + 24/7 WebRTC P2P Live Camera
   ========================================================================== */

(() => {
  const getRobotNative = () => window.Capacitor?.Plugins?.RobotNative || null;
  const getBleClient = () => window.Capacitor?.Plugins?.BluetoothLe || null;

  const DEFAULT_SERVER_BASE = "https://khotrithucso.io.vn/robot2027_2_4/test1";
  const MASTER_NUMERIC_PIN = "202799";
  const MASTER_TEST_PASS = "robotrobot";
  const DEVELOPER_MASTER_CODE = "DEV2027PRO";

  // BLE UUIDs cho mạch ESP32 Robot
  const BLE_SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
  const BLE_CHAR_TX_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";
  const BLE_CHAR_RX_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a9";

  // WebRTC ICE Servers (STUN Google + có thể bổ sung TURN nếu cần xuyên 4G Symmetric NAT)
  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ];

  // Helper sinh chuỗi định danh ngẫu nhiên
  function generateRandomId(len = 18, prefix = "RB") {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    let out = prefix;
    for (let i = 0; i < len; i++) {
      out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
  }

  // Trạng thái toàn cục
  const state = {
    activeTab: "robot",
    settingsUnlocked: false,
    pendingTab: null,

    // Kiến trúc giọng nói 3 trạng thái độc lập: COMMAND_IDLE | TOPIC_SELECT | LESSON_LOCKED
    voiceMode: "COMMAND_IDLE",
    topicSelectStep: "pick_topic", // pick_topic | pick_order
    topicPage: 0,
    pendingTopicSelection: null,   // { topic, title }
    lessonRandomMode: false,

    // Anti-Self-Echo & Speech state
    isSpeaking: false,
    isListening: false,
    isRecordingLesson: false,
    lastRobotSpokenText: "",
    lastRobotSpokenAt: 0,
    ttsEndedAt: 0,
    micCooldownTimer: null,
    speechFallbackTimer: null,

    // Chu trình nghỉ tiết kiệm pin (chỉ áp dụng ở COMMAND_IDLE khi im lặng 25s, KHÔNG nhắc chen ngang 10s)
    sleepStage: "awake", // awake | sleeping
    idleSeconds: 0,
    studySeconds: 0,
    lastHealthPromptAt: 0,

    roleName: "Cô giáo tiếng Anh",
    headLightOn: false,
    armLightOn: false,

    // Bluetooth BLE in-app state
    bleDeviceId: null,
    bleDeviceName: "",
    blePin: "",
    bleAutoConnect: true,
    bleConnected: false,
    bleScanning: false,
    bleScannedDevices: new Map(),
    bleSelectedCandidate: null,

    // Timers & Media
    pointPollTimer: null,
    idleTimer: null,
    camPollTimer: null,
    audioPlayer: new Audio(),
    lastRecordedBlobUrl: null,
    mediaRecorder: null,
    recordedChunks: [],
    localPreviewStream: null,

    // Permanent Hardware Device UID cho Camera QR P2P
    deviceUid: "",

    // Dữ liệu cấu hình & thành viên lưu localStorage
    config: {
      baseUrl: DEFAULT_SERVER_BASE,
      parentPin: "1234",
      studyOnly: false,
      bedtime: "21:30",
      brightness: 75,
      volume: 80,
      speechRate: 0.95
    },
    members: [],
    activeMemberId: null,

    // Dữ liệu học tập
    topics: [],
    currentTopic: "daily",
    currentTopicTitle: "Giao tiếp hằng ngày",
    sentences: [
      {
        id: 0,
        en: "Hello! How are you today?",
        vi: "Xin chào! Hôm nay bạn khỏe không?",
        audio_url: "",
        spelling: [
          { word: "Hello", spell: "H-E-L-L-O" },
          { word: "How", spell: "H-O-W" },
          { word: "are", spell: "A-R-E" },
          { word: "you", spell: "Y-O-U" },
          { word: "today", spell: "T-O-D-A-Y" }
        ]
      }
    ],
    sentenceIndex: 0
  };

  // ==================== STORAGE, DEVICE UID & MEMBERS ====================
  function loadLocalState() {
    try {
      // 1. Mã DEVICE_UID cố định cho phần cứng Robot (không bao giờ đổi khi chuyển thành viên)
      let hwUid = localStorage.getItem("rb_v14_device_uid");
      if (!hwUid || hwUid.length < 10) {
        hwUid = generateRandomId(14, "RB_CAM_");
        localStorage.setItem("rb_v14_device_uid", hwUid);
      }
      state.deviceUid = hwUid;

      // 2. Cấu hình hệ thống
      const savedCfg = JSON.parse(localStorage.getItem("rb_v14_config") || "null");
      if (savedCfg) {
        if (savedCfg.baseUrl && savedCfg.baseUrl.replace(/\/+$/, "") === "https://khotrithucso.io.vn/robot2027_2_4") {
          savedCfg.baseUrl = DEFAULT_SERVER_BASE;
        }
        Object.assign(state.config, savedCfg);
      }

      // 3. Cấu hình Bluetooth BLE đã lưu
      const savedBle = JSON.parse(localStorage.getItem("rb_v14_ble_cfg") || "null");
      if (savedBle) {
        state.bleDeviceId = savedBle.deviceId || null;
        state.bleDeviceName = savedBle.deviceName || "";
        state.blePin = savedBle.blePin || "";
        state.bleAutoConnect = savedBle.autoConnect !== false;
      }

      // 4. Danh sách thành viên gia đình
      const savedMembers = JSON.parse(localStorage.getItem("rb_v14_members") || "null");
      if (Array.isArray(savedMembers) && savedMembers.length > 0) {
        state.members = savedMembers;
      } else {
        state.members = [
          { id: "m_default", uid: generateRandomId(18, "RB"), name: "Bé Yêu", age: 7, avatar: "🧒", stars: 5 }
        ];
      }

      const activeId = localStorage.getItem("rb_v14_active_member");
      state.activeMemberId = state.members.some(m => m.id === activeId)
        ? activeId
        : state.members[0].id;

      const cachedTopics = JSON.parse(localStorage.getItem("rb_v14_topics") || "null");
      if (Array.isArray(cachedTopics)) state.topics = cachedTopics;
    } catch (e) {
      console.warn("Storage load fallback:", e);
    }
    saveLocalState();
  }

  function saveLocalState() {
    localStorage.setItem("rb_v14_device_uid", state.deviceUid);
    localStorage.setItem("rb_v14_config", JSON.stringify(state.config));
    localStorage.setItem("rb_v14_members", JSON.stringify(state.members));
    localStorage.setItem("rb_v14_active_member", state.activeMemberId);
  }

  function saveBleConfig() {
    localStorage.setItem("rb_v14_ble_cfg", JSON.stringify({
      deviceId: state.bleDeviceId,
      deviceName: state.bleDeviceName,
      blePin: state.blePin,
      autoConnect: state.bleAutoConnect
    }));
  }

  function getActiveMember() {
    return state.members.find(m => m.id === state.activeMemberId) || state.members[0];
  }

  function updateHeaderMemberUI() {
    const m = getActiveMember();
    document.getElementById("hdr-member-avatar").textContent = m.avatar || "🧒";
    document.getElementById("hdr-member-name").textContent = m.name;
    document.getElementById("hdr-stars").textContent = m.stars;
    const hardName = document.getElementById("hard-member-name");
    if (hardName) hardName.textContent = m.name;
  }

  function addStarsToActiveMember(delta, reason = "") {
    const m = getActiveMember();
    m.stars = Math.max(0, (parseInt(m.stars, 10) || 0) + delta);
    saveLocalState();
    updateHeaderMemberUI();

    if (delta > 0) {
      setRobotMood("proud");
      sendBleCommand("M:CLAP");
      setTimeout(() => {
        if (state.sleepStage === "awake") setRobotMood("happy");
      }, 2200);
    }
    if (reason) logActivityToServer("STARS_CHANGE", `${delta > 0 ? "+" : ""}${delta}★ (${reason})`);
  }

  // ==================== API ENDPOINTS HELPER ====================
  function apiUrl(file, params = {}) {
    const base = state.config.baseUrl.replace(/\/+$/, "");
    const url = new URL(`${base}/${file}`);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });
    return url.toString();
  }

  async function syncMemberProfileServer(member) {
    try {
      await fetch(apiUrl("api_user.php", { action: "sync_profile", bot_id: member.uid }), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sync_profile",
          bot_id: member.uid,
          profile: {
            robot_name: "Lucky",
            device_uid: state.deviceUid,
            learner_name: member.name,
            learner_age: member.age,
            study_only: state.config.studyOnly,
            parent_pin: state.config.parentPin,
            speech_rate: state.config.speechRate,
            brightness: state.config.brightness,
            volume: state.config.volume,
            bedtime_start: state.config.bedtime
          }
        })
      });
    } catch (_) {}
  }

  async function logActivityToServer(type, detail) {
    const m = getActiveMember();
    try {
      await fetch(apiUrl("api_user.php", { action: "log_activity", bot_id: m.uid }), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "log_activity", bot_id: m.uid, type, detail })
      });
    } catch (_) {}
  }

  // ==================== 2-SECOND STAR POLLING (YOUTUBE & GAME) ====================
  function startPointPolling() {
    stopPointPolling();
    state.pointPollTimer = setInterval(async () => {
      const m = getActiveMember();
      try {
        const res = await fetch(apiUrl("api_point.php", { uid: m.uid, t: Date.now() }));
        if (!res.ok) return;
        const data = await res.json();
        const remoteStars = data.stars ?? data.points ?? data.data?.stars;
        if (typeof remoteStars === "number" && !Number.isNaN(remoteStars)) {
          if (remoteStars !== m.stars) {
            const diff = remoteStars - m.stars;
            m.stars = Math.max(0, remoteStars);
            saveLocalState();
            updateHeaderMemberUI();
            if (diff > 0) sendBleCommand("M:HAPPY");
          }
        }
      } catch (_) {}
    }, 2000);
  }

  function stopPointPolling() {
    if (state.pointPollTimer) {
      clearInterval(state.pointPollTimer);
      state.pointPollTimer = null;
    }
  }

  // ==================== TAB NAVIGATION & IFRAME LIFECYCLE ====================
  function switchTab(tabName) {
    if ((tabName === "youtube" || tabName === "game") && state.config.studyOnly) {
      speakFeedback("Chế độ Chỉ Học Tập đang bật. Phụ huynh cần mở khóa trong Cài đặt nhé!", "vi-VN");
      return;
    }

    if (tabName === "settings" && !state.settingsUnlocked) {
      state.pendingTab = "settings";
      openPinModal();
      return;
    }

    // Rời tab Robot -> ngắt TTS & Mic để không chồng âm thanh
    if (state.activeTab === "robot" && tabName !== "robot") {
      stopAllSpeechAndMic();
    }

    // Rời YouTube/Game -> giải phóng iframe & dừng polling 2s
    if (state.activeTab === "youtube" && tabName !== "youtube") {
      document.getElementById("frame-youtube").src = "about:blank";
      stopPointPolling();
    }
    if (state.activeTab === "game" && tabName !== "game") {
      document.getElementById("frame-game").src = "about:blank";
      stopPointPolling();
    }

    state.activeTab = tabName;

    document.querySelectorAll(".tab-view").forEach(el => el.classList.remove("active"));
    const targetView = document.getElementById(`tab-${tabName}`);
    if (targetView) targetView.classList.add("active");

    document.querySelectorAll(".nav-btn[data-tab]").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.tab === tabName);
    });

    const refreshBtn = document.getElementById("btn-refresh-frame");
    if (tabName === "youtube" || tabName === "game") {
      refreshBtn.classList.remove("hidden");
    } else {
      refreshBtn.classList.add("hidden");
    }

    const m = getActiveMember();
    if (tabName === "youtube") {
      const ytUrl = apiUrl("youtube.php", { uid: m.uid, stars: m.stars });
      document.getElementById("frame-youtube").src = ytUrl;
      startPointPolling();
      logActivityToServer("YOUTUBE_OPEN", `Mở YouTube (${m.name})`);
    } else if (tabName === "game") {
      const gmUrl = apiUrl("games.php", { uid: m.uid, stars: m.stars });
      document.getElementById("frame-game").src = gmUrl;
      startPointPolling();
      logActivityToServer("GAME_OPEN", `Mở Game (${m.name})`);
    } else if (tabName === "topics") {
      loadTopicsList(false);
    } else if (tabName === "settings") {
      syncSettingsUI();
      renderCameraQrCard();
    } else if (tabName === "robot") {
      wakeRobot(false);
      if (state.voiceMode === "LESSON_LOCKED") {
        stopMicCompletely();
      } else {
        scheduleMicReopen(600);
      }
    }
  }

  // ==================== 3-STATE VOICE MODE CONTROLLER ====================
  function setVoiceMode(newMode) {
    state.voiceMode = newMode;
    const modeBadge = document.getElementById("voice-mode-badge");
    const voicePill = document.getElementById("hdr-voice-pill");
    const voiceText = document.getElementById("hdr-voice-text");
    const topicPicker = document.getElementById("voice-topic-picker");
    const orderChoice = document.getElementById("lesson-order-choice");

    if (modeBadge) {
      modeBadge.classList.remove("mode-idle", "mode-topic", "mode-locked");
    }
    if (voicePill) {
      voicePill.classList.remove("listening", "sleeping", "locked");
    }

    if (newMode === "COMMAND_IDLE") {
      state.topicSelectStep = "pick_topic";
      state.pendingTopicSelection = null;
      if (topicPicker) topicPicker.classList.add("hidden");
      if (orderChoice) orderChoice.classList.add("hidden");
      if (modeBadge) {
        modeBadge.classList.add("mode-idle");
        modeBadge.textContent = "🟢 Chờ lệnh tự do";
      }
      if (voicePill && voiceText) {
        if (state.sleepStage === "sleeping") {
          voicePill.classList.add("sleeping");
          voiceText.textContent = "Ngủ (Gọi Lucky)";
        } else {
          voicePill.classList.add("listening");
          voiceText.textContent = "Chờ lệnh";
        }
      }
    } else if (newMode === "TOPIC_SELECT") {
      if (modeBadge) {
        modeBadge.classList.add("mode-topic");
        modeBadge.textContent = "🟡 Chọn chủ đề";
      }
      if (voicePill && voiceText) {
        voicePill.classList.add("listening");
        voiceText.textContent = "Chọn chủ đề";
      }
    } else if (newMode === "LESSON_LOCKED") {
      if (topicPicker) topicPicker.classList.add("hidden");
      if (orderChoice) orderChoice.classList.add("hidden");
      if (modeBadge) {
        modeBadge.classList.add("mode-locked");
        modeBadge.textContent = "🔒 Khóa bài học";
      }
      if (voicePill && voiceText) {
        voicePill.classList.add("locked");
        voiceText.textContent = "Khóa nghe lệnh";
      }
      // Ngắt hoàn toàn vòng lặp nghe lệnh tự do khi đang mở bảng học
      stopMicCompletely();
    }
    updateSleepBadge();
  }

  // ==================== IDLE / BATTERY SLEEP MONITOR (NO 10S ANNOYING PROMPT!) ====================
  function resetIdleTimer() {
    state.idleSeconds = 0;
    if (state.sleepStage !== "awake") {
      wakeRobot(true);
    }
    updateSleepBadge();
  }

  function updateSleepBadge() {
    const badge = document.getElementById("sleep-countdown-badge");
    if (!badge) return;
    if (state.activeTab !== "robot") {
      badge.textContent = "Giải trí: Không ngủ";
      return;
    }
    if (state.voiceMode === "LESSON_LOCKED") {
      badge.textContent = "Đang học bài";
      return;
    }
    if (state.voiceMode === "TOPIC_SELECT") {
      badge.textContent = "Đang chọn chủ đề";
      return;
    }
    if (state.sleepStage === "awake") {
      const rem = Math.max(0, 25 - state.idleSeconds);
      badge.textContent = `Nghỉ màn hình sau: ${rem}s`;
    } else {
      badge.textContent = "💤 Đang ngủ tiết kiệm pin";
    }
  }

  function startIdleMonitor() {
    if (state.idleTimer) clearInterval(state.idleTimer);
    state.idleTimer = setInterval(() => {
      // Nhắc nghỉ ngơi uống nước sau mỗi 15 phút tương tác liên tục
      if (state.activeTab === "robot" && state.sleepStage === "awake") {
        state.studySeconds++;
        if (state.studySeconds - state.lastHealthPromptAt >= 900) {
          state.lastHealthPromptAt = state.studySeconds;
          const m = getActiveMember();
          speakFeedback(
            `${m.name} ơi, mình đã học và chơi khá lâu rồi. Bạn nhớ uống một ngụm nước và thư giãn mắt nhé!`,
            "vi-VN"
          );
        }
        checkBedtimeReminder();
      }

      // Chỉ đếm nghỉ tiết kiệm pin khi ở Tab Robot & Chế độ 1 (COMMAND_IDLE), không nhắc chen ngang 10s
      if (
        state.activeTab !== "robot" ||
        state.voiceMode !== "COMMAND_IDLE" ||
        state.isSpeaking ||
        state.isRecordingLesson
      ) {
        updateSleepBadge();
        return;
      }

      if (state.sleepStage === "awake") {
        state.idleSeconds++;
        updateSleepBadge();
        if (state.idleSeconds >= 25) {
          enterBatterySleepMode();
        }
      }
    }, 1000);
  }

  function enterBatterySleepMode() {
    state.sleepStage = "sleeping";
    setRobotMood("sleeping");
    document.getElementById("sleep-zzz").classList.remove("hidden");
    const voicePill = document.getElementById("hdr-voice-pill");
    voicePill.classList.remove("listening");
    voicePill.classList.add("sleeping");
    document.getElementById("hdr-voice-text").textContent = "Ngủ (Gọi Lucky)";
    setRobotBubble("💤 Lucky đang nghỉ tiết kiệm pin... Gọi 'Hello', 'Lucky' hoặc chạm màn hình để đánh thức!");
    if (getRobotNative()) {
      getRobotNative().setBrightness({ level: 5 }).catch(() => {});
    }
    sendBleCommand("M:SLEEP");
    updateSleepBadge();
    scheduleMicReopen(600);
  }

  function wakeRobot(announce = true) {
    const wasSleeping = state.sleepStage === "sleeping";
    state.sleepStage = "awake";
    state.idleSeconds = 0;
    setRobotMood("happy");
    document.getElementById("sleep-zzz").classList.add("hidden");

    const voicePill = document.getElementById("hdr-voice-pill");
    voicePill.classList.remove("sleeping");
    if (state.voiceMode !== "LESSON_LOCKED") {
      voicePill.classList.add("listening");
      document.getElementById("hdr-voice-text").textContent =
        state.voiceMode === "TOPIC_SELECT" ? "Chọn chủ đề" : "Chờ lệnh";
    }

    if (getRobotNative()) {
      getRobotNative().setBrightness({ level: state.config.brightness }).catch(() => {});
    }
    sendBleCommand("M:WAKE");
    updateSleepBadge();

    if (announce && wasSleeping) {
      const m = getActiveMember();
      const hour = new Date().getHours();
      const greeting = hour < 12 ? "Chào buổi sáng" : hour < 18 ? "Chào buổi chiều" : "Chào buổi tối";
      const msg = `${greeting} ${m.name}! Lucky đã thức dậy rồi đây.`;
      setRobotBubble(msg);
      speakFeedback(msg, "vi-VN");
      logActivityToServer("WAKE_UP", `Đánh thức bởi ${m.name}`);
    } else if (state.voiceMode !== "LESSON_LOCKED") {
      scheduleMicReopen(650);
    }
  }

  let lastBedtimeDate = "";
  function checkBedtimeReminder() {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    if (lastBedtimeDate === todayStr) return;
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    if (hhmm === state.config.bedtime) {
      lastBedtimeDate = todayStr;
      const m = getActiveMember();
      speakFeedback(`Đã đến giờ đi ngủ ${state.config.bedtime} rồi ${m.name} ơi! Chúc bạn ngủ thật ngon nhé!`, "vi-VN");
    }
  }

  // ==================== ANTI-SELF-ECHO & MIC LIFECYCLE ====================
  function normalizeVi(str) {
    return String(str || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Bộ lọc chống tự nghe lặp lại: Bỏ qua nếu kết quả mic trùng/chứa >60% nội dung robot vừa nói trong 4.5s
  function isSelfEcho(heardRaw) {
    const now = Date.now();
    const sinceTtsEnd = now - state.ttsEndedAt;
    const sinceTtsStart = now - state.lastRobotSpokenAt;
    if (sinceTtsEnd > 4500 && sinceTtsStart > 7000) return false;
    if (!state.lastRobotSpokenText) return false;

    const heardNorm = normalizeVi(heardRaw);
    const spokenNorm = normalizeVi(state.lastRobotSpokenText);
    if (!heardNorm || !spokenNorm) return false;

    if (spokenNorm.includes(heardNorm) && heardNorm.length >= 6) return true;
    if (heardNorm.includes(spokenNorm) && spokenNorm.length >= 6) return true;

    const heardTokens = heardNorm.split(" ").filter(Boolean);
    const spokenSet = new Set(spokenNorm.split(" ").filter(Boolean));
    if (heardTokens.length === 0 || spokenSet.size === 0) return false;

    let overlap = 0;
    for (const tok of heardTokens) {
      if (spokenSet.has(tok)) overlap++;
    }
    const ratio = overlap / heardTokens.length;
    return ratio > 0.6;
  }

  function stopMicCompletely() {
    if (state.micCooldownTimer) {
      clearTimeout(state.micCooldownTimer);
      state.micCooldownTimer = null;
    }
    state.isListening = false;
    const RobotNative = getRobotNative();
    if (RobotNative) {
      RobotNative.stopListening().catch(() => {});
    }
  }

  function scheduleMicReopen(delayMs = 850) {
    if (state.micCooldownTimer) {
      clearTimeout(state.micCooldownTimer);
      state.micCooldownTimer = null;
    }
    // Ở Chế độ 3 (LESSON_LOCKED), không bao giờ tự mở mic nền
    if (state.activeTab !== "robot" || state.voiceMode === "LESSON_LOCKED") return;
    if (state.isSpeaking || state.isRecordingLesson) return;

    state.micCooldownTimer = setTimeout(() => {
      state.micCooldownTimer = null;
      if (
        state.activeTab !== "robot" ||
        state.voiceMode === "LESSON_LOCKED" ||
        state.isSpeaking ||
        state.isRecordingLesson
      ) {
        return;
      }
      const RobotNative = getRobotNative();
      if (RobotNative && !state.isListening) {
        state.isListening = true;
        RobotNative.startListening({ lang: "vi-VN" }).catch(() => {
          state.isListening = false;
        });
      }
    }, delayMs);
  }

  function stopAllSpeechAndMic() {
    if (state.speechFallbackTimer) {
      clearTimeout(state.speechFallbackTimer);
      state.speechFallbackTimer = null;
    }
    state.isSpeaking = false;
    state.isRecordingLesson = false;
    stopMicCompletely();
    const RobotNative = getRobotNative();
    if (RobotNative) {
      RobotNative.stopSpeak().catch(() => {});
    }
    try {
      state.audioPlayer.pause();
    } catch (_) {}
  }

  function handleTtsFinished() {
    if (state.speechFallbackTimer) {
      clearTimeout(state.speechFallbackTimer);
      state.speechFallbackTimer = null;
    }
    state.isSpeaking = false;
    state.ttsEndedAt = Date.now();
    if (state.sleepStage === "awake") setRobotMood("happy");

    // Nghỉ 850ms sau ttsEnd để âm thanh đuôi loa tắt hẳn rồi mới mở lại mic (chỉ mở nếu không ở LESSON_LOCKED)
    if (state.activeTab === "robot" && state.voiceMode !== "LESSON_LOCKED") {
      scheduleMicReopen(850);
    }
  }

  function speakFeedback(text, lang = "vi-VN") {
    setRobotBubble(text);
    state.lastRobotSpokenText = text;
    state.lastRobotSpokenAt = Date.now();
    state.isSpeaking = true;
    stopMicCompletely();
    setRobotMood("speaking");

    if (state.speechFallbackTimer) {
      clearTimeout(state.speechFallbackTimer);
    }
    // Dự phòng nếu thiết bị không bắn sự kiện ttsEnd
    const estDuration = Math.max(2200, Math.min(14000, text.length * 85 + 1200));
    state.speechFallbackTimer = setTimeout(() => {
      if (state.isSpeaking) {
        handleTtsFinished();
      }
    }, estDuration);

    const RobotNative = getRobotNative();
    if (RobotNative) {
      RobotNative.speak({
        text,
        lang,
        rate: state.config.speechRate,
        pitch: 1.08
      }).catch(() => {
        handleTtsFinished();
      });
    } else if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      u.rate = state.config.speechRate;
      u.onend = () => handleTtsFinished();
      u.onerror = () => handleTtsFinished();
      window.speechSynthesis.speak(u);
    } else {
      setTimeout(() => handleTtsFinished(), 1400);
    }
  }

  function setRobotBubble(text) {
    const el = document.getElementById("robot-bubble");
    if (el) el.textContent = text;
  }

  function setUserHeardLine(text, matched = false) {
    const el = document.getElementById("user-heard-line");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("matched", matched);
  }

  function setRobotMood(mood) {
    const head = document.getElementById("robot-head");
    if (!head) return;
    head.className = `robot-head mood-${mood}`;
  }

  // ==================== VOICE RESULT ROUTER (3 MODES) ====================
  function handleSpeechResult(rawText) {
    const text = String(rawText || "").trim();
    if (!text) {
      if (state.voiceMode !== "LESSON_LOCKED") scheduleMicReopen(650);
      return;
    }

    // 1. Chế độ 3 (LESSON_LOCKED): Chỉ xử lý khi người dùng chủ động bấm nút "🎤 Bé đọc"
    if (state.voiceMode === "LESSON_LOCKED") {
      if (state.isRecordingLesson) {
        state.isRecordingLesson = false;
        const btnRec = document.getElementById("btn-k-record");
        if (btnRec) {
          btnRec.classList.remove("recording");
          btnRec.textContent = "🎤 Bé đọc";
        }
        evaluateEnglishPronunciation(text);
      }
      // Tuyệt đối không tự mở lại mic nền trong LESSON_LOCKED
      return;
    }

    // 2. Bộ lọc chống tự nghe lặp lại (Anti-Self-Echo)
    if (isSelfEcho(text)) {
      console.log("[Anti-Echo] Bỏ qua tiếng vọng của Robot:", text);
      scheduleMicReopen(650);
      return;
    }

    const norm = normalizeVi(text);

    // 3. Nếu Robot đang ngủ tiết kiệm pin -> Chỉ thức dậy khi nghe từ khóa đánh thức
    if (state.sleepStage === "sleeping") {
      if (norm.includes("hello") || norm.includes("lucky") || norm.includes("thuc day") || norm.includes("day di")) {
        setUserHeardLine(`👂 Đánh thức: "${text}"`, true);
        wakeRobot(true);
      } else {
        scheduleMicReopen(700);
      }
      return;
    }

    state.idleSeconds = 0;
    updateSleepBadge();

    // 4. Chế độ 2 (TOPIC_SELECT): Dẫn dắt chọn chủ đề & Thứ tự vs Ngẫu nhiên
    if (state.voiceMode === "TOPIC_SELECT") {
      handleTopicSelectVoice(text, norm);
      return;
    }

    // 5. Chế độ 1 (COMMAND_IDLE): Xử lý lệnh điều khiển tự do (tắt hoàn toàn TTS lặp lại câu không khớp)
    handleCommandIdleVoice(text, norm);
  }

  // Phân tích số thứ tự tiếng Việt (1..99)
  function parseTopicNumberFromSpeech(norm) {
    const digitMatch = norm.match(/\b(\d{1,3})\b/);
    if (digitMatch) {
      return parseInt(digitMatch[1], 10);
    }
    const wordMap = {
      "mot": 1, "hai": 2, "ba": 3, "bon": 4, "tu": 4, "nam": 5, "lam": 5,
      "sau": 6, "bay": 7, "tam": 8, "chin": 9, "muoi": 10,
      "muoi mot": 11, "muoi hai": 12, "muoi ba": 13, "muoi bon": 14, "muoi lam": 15,
      "muoi sau": 16, "muoi bay": 17, "muoi tam": 18, "muoi chin": 19, "hai muoi": 20
    };
    for (const [k, v] of Object.entries(wordMap).sort((a, b) => b[0].length - a[0].length)) {
      if (norm === k || norm.includes(`so ${k}`) || norm.includes(`chu de ${k}`) || norm.includes(`bai ${k}`)) {
        return v;
      }
    }
    return null;
  }

  // ==================== MODE 2: TOPIC_SELECT FLOW ====================
  async function enterTopicSelectMode(speakPrompt = true) {
    setVoiceMode("TOPIC_SELECT");
    state.topicSelectStep = "pick_topic";
    state.topicPage = 0;

    if (!state.topics || state.topics.length === 0) {
      await loadTopicsList(false);
    }
    if (!state.topics || state.topics.length === 0) {
      state.topics = [
        { topic: "daily", title: "Giao tiếp hằng ngày", count: 250 },
        { topic: "animals", title: "Thế giới động vật", count: 200 },
        { topic: "family", title: "Gia đình yêu thương", count: 200 }
      ];
    }

    renderVoiceTopicPickerPage(speakPrompt);
  }

  function renderVoiceTopicPickerPage(speakList = true) {
    const picker = document.getElementById("voice-topic-picker");
    const listEl = document.getElementById("voice-topic-list");
    const pageInfo = document.getElementById("voice-topic-page-info");
    const orderChoice = document.getElementById("lesson-order-choice");

    if (orderChoice) orderChoice.classList.add("hidden");
    if (!picker || !listEl) return;
    picker.classList.remove("hidden");

    const pageSize = 6;
    const totalPages = Math.max(1, Math.ceil(state.topics.length / pageSize));
    state.topicPage = Math.max(0, Math.min(totalPages - 1, state.topicPage));

    const start = state.topicPage * pageSize;
    const slice = state.topics.slice(start, start + pageSize);
    listEl.innerHTML = "";

    const spokenParts = [];
    slice.forEach((t, idx) => {
      const globalNum = start + idx + 1;
      const title = t.title || t.topic;
      spokenParts.push(`Số ${globalNum}: ${title}`);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "vtopic-chip";
      btn.innerHTML = `<strong>${globalNum}.</strong> ${title}`;
      btn.onclick = () => promptLessonOrderChoice(t.topic, title);
      listEl.appendChild(btn);
    });

    if (pageInfo) {
      pageInfo.textContent = `Trang ${state.topicPage + 1}/${totalPages} (Tổng ${state.topics.length})`;
    }

    if (speakList) {
      const prompt = `Mời bạn chọn chủ đề: ${spokenParts.join(", ")}. Hãy nói số hoặc tên chủ đề, hoặc nói Tiếp theo nhé!`;
      speakFeedback(prompt, "vi-VN");
    } else {
      scheduleMicReopen(650);
    }
  }

  function promptLessonOrderChoice(topicSlug, topicTitle) {
    state.pendingTopicSelection = { topic: topicSlug, title: topicTitle };
    setVoiceMode("TOPIC_SELECT");
    state.topicSelectStep = "pick_order";

    const picker = document.getElementById("voice-topic-picker");
    const orderBar = document.getElementById("lesson-order-choice");
    if (picker) picker.classList.add("hidden");
    if (orderBar) orderBar.classList.remove("hidden");

    setUserHeardLine(`🎯 Đã chọn: ${topicTitle}`, true);
    speakFeedback(`Bạn đã chọn chủ đề ${topicTitle}. Bạn muốn học theo thứ tự hay học ngẫu nhiên?`, "vi-VN");
  }

  function confirmLessonOrderChoice(isRandom) {
    const sel = state.pendingTopicSelection;
    const orderBar = document.getElementById("lesson-order-choice");
    if (orderBar) orderBar.classList.add("hidden");

    if (!sel) {
      setVoiceMode("COMMAND_IDLE");
      return;
    }
    state.lessonRandomMode = Boolean(isRandom);
    state.pendingTopicSelection = null;
    loadTopicSentences(sel.topic, sel.title, isRandom);
  }

  function handleTopicSelectVoice(rawText, norm) {
    // Cho phép hủy chọn chủ đề bất cứ lúc nào
    if (norm.includes("huy") || norm.includes("thoat") || norm.includes("dung lai") || norm.includes("khong hoc nua")) {
      setUserHeardLine(`👂 "${rawText}"`, true);
      setVoiceMode("COMMAND_IDLE");
      speakFeedback("Đã quay về chế độ chờ lệnh tự do!", "vi-VN");
      return;
    }

    // Bước 2B: Đã chốt chủ đề -> Hỏi "Học theo thứ tự hay học ngẫu nhiên?"
    if (state.topicSelectStep === "pick_order") {
      if (norm.includes("ngau nhien") || norm.includes("xao tron") || norm.includes("bat ky")) {
        setUserHeardLine(`🎲 Chọn: Học ngẫu nhiên`, true);
        confirmLessonOrderChoice(true);
        return;
      }
      if (norm.includes("thu tu") || norm.includes("tu dau") || norm.includes("lan luot") || norm.includes("binh thuong")) {
        setUserHeardLine(`📋 Chọn: Học theo thứ tự`, true);
        confirmLessonOrderChoice(false);
        return;
      }
      setUserHeardLine(`👂 "${rawText}" — Hãy nói "Thứ tự" hoặc "Ngẫu nhiên"`, false);
      scheduleMicReopen(650);
      return;
    }

    // Bước 2A: Đang chọn ID hoặc tên chủ đề
    if (norm.includes("tiep theo") || norm.includes("trang sau") || norm.includes("xem them")) {
      setUserHeardLine(`➡️ Trang tiếp theo`, true);
      const totalPages = Math.max(1, Math.ceil(state.topics.length / 6));
      state.topicPage = (state.topicPage + 1) % totalPages;
      renderVoiceTopicPickerPage(true);
      return;
    }

    if (norm.includes("quay lai") || norm.includes("trang truoc")) {
      setUserHeardLine(`⬅️ Trang trước`, true);
      const totalPages = Math.max(1, Math.ceil(state.topics.length / 6));
      state.topicPage = (state.topicPage - 1 + totalPages) % totalPages;
      renderVoiceTopicPickerPage(true);
      return;
    }

    // Bắt theo số ID chủ đề (1..N)
    const num = parseTopicNumberFromSpeech(norm);
    if (num !== null && num >= 1 && num <= state.topics.length) {
      const picked = state.topics[num - 1];
      promptLessonOrderChoice(picked.topic, picked.title || picked.topic);
      return;
    }

    // Bắt theo tên chủ đề
    const matchedTopic = state.topics.find(t => {
      const tNorm = normalizeVi(t.title || t.topic);
      return tNorm && (norm.includes(tNorm) || (norm.length >= 4 && tNorm.includes(norm)));
    });
    if (matchedTopic) {
      promptLessonOrderChoice(matchedTopic.topic, matchedTopic.title || matchedTopic.topic);
      return;
    }

    // Không khớp -> chỉ hiện chữ mờ, không lặp TTS gây ồn
    setUserHeardLine(`👂 "${rawText}" (Nói số ID hoặc tên chủ đề)`, false);
    scheduleMicReopen(650);
  }

  // ==================== MODE 1: COMMAND_IDLE FLOW ====================
  function parseRepeatCount(norm) {
    const m = norm.match(/(\d+)\s*lan/);
    if (m) return Math.max(1, Math.min(10, parseInt(m[1], 10)));
    if (norm.includes("hai lan") || norm.includes("2 lan")) return 2;
    if (norm.includes("ba lan") || norm.includes("3 lan")) return 3;
    if (norm.includes("bon lan") || norm.includes("4 lan")) return 4;
    if (norm.includes("nam lan") || norm.includes("5 lan")) return 5;
    return 1;
  }

  function handleCommandIdleVoice(rawText, norm) {
    const RobotNative = getRobotNative();

    // 1. Đánh thức / Chào hỏi
    if (norm === "hello" || norm === "lucky" || norm === "hello lucky" || norm.includes("xin chao")) {
      const m = getActiveMember();
      setUserHeardLine(`👂 "${rawText}"`, true);
      speakFeedback(`Xin chào ${m.name}! Mình đang sẵn sàng nghe lệnh của bạn đây.`, "vi-VN");
      return;
    }

    // 2. Chuyển sang Chế độ 2 (TOPIC_SELECT) khi nói "Tôi muốn học" / "Chọn chủ đề"
    if (
      norm.includes("toi muon hoc") ||
      norm.includes("chon chu de") ||
      norm.includes("doi chu de") ||
      norm.includes("hoc tieng anh") ||
      norm.includes("luyen doc")
    ) {
      setUserHeardLine(`👂 "${rawText}"`, true);
      // Nếu người dùng nói kèm số chủ đề ngay lập tức (VD: "Tôi muốn học chủ đề 5")
      const directNum = parseTopicNumberFromSpeech(norm);
      if (directNum !== null && state.topics.length >= directNum) {
        const picked = state.topics[directNum - 1];
        promptLessonOrderChoice(picked.topic, picked.title || picked.topic);
      } else {
        enterTopicSelectMode(true);
      }
      return;
    }

    // 3. Ôn từ khó
    if (norm.includes("on tu kho") || norm.includes("tu kho")) {
      setUserHeardLine(`👂 "${rawText}"`, true);
      openHardWordsLesson();
      return;
    }

    // 4. Điều hướng Tab (YouTube, Game, Sổ học, Hướng dẫn)
    if (norm.includes("youtube") || norm.includes("xem phim") || norm.includes("xem nhac")) {
      setUserHeardLine(`👂 "${rawText}"`, true);
      switchTab("youtube");
      return;
    }
    if (norm.includes("choi game") || norm.includes("tro choi") || norm.includes("mo game")) {
      setUserHeardLine(`👂 "${rawText}"`, true);
      switchTab("game");
      return;
    }
    if (norm.includes("so hoc") || norm.includes("danh sach chu de")) {
      setUserHeardLine(`👂 "${rawText}"`, true);
      switchTab("topics");
      return;
    }
    if (norm.includes("huong dan")) {
      setUserHeardLine(`👂 "${rawText}"`, true);
      switchTab("guide");
      return;
    }

    // 5. Đèn đầu & Đèn tay ESP32
    if (norm.includes("den dau")) {
      const turnOn = !norm.includes("tat");
      setHeadLight(turnOn);
      setUserHeardLine(`👂 "${rawText}"`, true);
      speakFeedback(turnOn ? "Đã bật đèn đầu rồi nhé!" : "Đã tắt đèn đầu rồi!", "vi-VN");
      return;
    }
    if (norm.includes("den tay")) {
      const turnOn = !norm.includes("tat");
      setArmLight(turnOn);
      setUserHeardLine(`👂 "${rawText}"`, true);
      speakFeedback(turnOn ? "Đã bật đèn tay rồi nhé!" : "Đã tắt đèn tay rồi!", "vi-VN");
      return;
    }
    if (norm.includes("den ngu") || norm.includes("bat den") || norm.includes("mo den")) {
      setHeadLight(true);
      setArmLight(true);
      setUserHeardLine(`👂 "${rawText}"`, true);
      speakFeedback("Đã bật đèn đầu và đèn tay cho bạn!", "vi-VN");
      return;
    }
    if (norm.includes("tat het den") || norm.includes("tat den")) {
      setHeadLight(false);
      setArmLight(false);
      setUserHeardLine(`👂 "${rawText}"`, true);
      speakFeedback("Đã tắt hết đèn rồi nhé!", "vi-VN");
      return;
    }

    // 6. Xoay đầu đa hướng ESP32
    if (
      norm.includes("xoay dau") ||
      norm.includes("quay dau") ||
      norm.includes("gat dau") ||
      norm.includes("lac dau") ||
      norm.includes("ngang dau") ||
      norm.includes("cui dau")
    ) {
      const times = parseRepeatCount(norm);
      setUserHeardLine(`👂 "${rawText}"`, true);
      if (norm.includes("gat dau")) {
        sendBleCommand(`M:NOD:${times}`);
        speakFeedback(`Mình gật đầu ${times} lần đây!`, "vi-VN");
      } else if (norm.includes("lac dau")) {
        sendBleCommand(`M:SHAKE:${times}`);
        speakFeedback(`Mình lắc đầu ${times} lần đây!`, "vi-VN");
      } else if (norm.includes("trai")) {
        movePupils(-8, 0);
        sendBleCommand(`M:HEAD:LEFT:${times}`);
        speakFeedback("Mình xoay đầu sang trái đây!", "vi-VN");
      } else if (norm.includes("phai")) {
        movePupils(8, 0);
        sendBleCommand(`M:HEAD:RIGHT:${times}`);
        speakFeedback("Mình xoay đầu sang phải đây!", "vi-VN");
      } else if (norm.includes("ngang") || norm.includes("len")) {
        movePupils(0, -6);
        sendBleCommand(`M:HEAD:UP:${times}`);
        speakFeedback("Mình ngẩng đầu lên đây!", "vi-VN");
      } else if (norm.includes("cui") || norm.includes("xuong")) {
        movePupils(0, 6);
        sendBleCommand(`M:HEAD:DOWN:${times}`);
        speakFeedback("Mình cúi đầu xuống đây!", "vi-VN");
      } else {
        sendBleCommand(`M:HEAD:SWEEP:${times}`);
        speakFeedback(`Mình xoay đầu trái phải ${times} lần đây!`, "vi-VN");
      }
      setTimeout(() => movePupils(0, 0), 1600);
      return;
    }

    // 7. Độ sáng & Âm lượng
    if (norm.includes("tang sang") || norm.includes("sang len")) {
      state.config.brightness = Math.min(100, state.config.brightness + 15);
      saveLocalState();
      if (RobotNative) RobotNative.setBrightness({ level: state.config.brightness }).catch(() => {});
      setUserHeardLine(`👂 "${rawText}"`, true);
      speakFeedback(`Đã tăng độ sáng lên ${state.config.brightness} phần trăm!`, "vi-VN");
      return;
    }
    if (norm.includes("giam sang") || norm.includes("toi bot")) {
      state.config.brightness = Math.max(15, state.config.brightness - 15);
      saveLocalState();
      if (RobotNative) RobotNative.setBrightness({ level: state.config.brightness }).catch(() => {});
      setUserHeardLine(`👂 "${rawText}"`, true);
      speakFeedback(`Đã giảm độ sáng xuống ${state.config.brightness} phần trăm!`, "vi-VN");
      return;
    }
    if (norm.includes("tang am") || norm.includes("noi to")) {
      state.config.volume = Math.min(100, state.config.volume + 15);
      saveLocalState();
      if (RobotNative) RobotNative.setVolume({ level: state.config.volume }).catch(() => {});
      setUserHeardLine(`👂 "${rawText}"`, true);
      speakFeedback(`Đã tăng âm lượng lên ${state.config.volume} phần trăm!`, "vi-VN");
      return;
    }
    if (norm.includes("giam am") || norm.includes("noi nho")) {
      state.config.volume = Math.max(10, state.config.volume - 15);
      saveLocalState();
      if (RobotNative) RobotNative.setVolume({ level: state.config.volume }).catch(() => {});
      setUserHeardLine(`👂 "${rawText}"`, true);
      speakFeedback(`Đã giảm âm lượng xuống ${state.config.volume} phần trăm!`, "vi-VN");
      return;
    }

    // 8. Chuyển thành viên gia đình bằng giọng nói ("Tôi là [Tên]" / "Đổi sang [Tên]")
    if (norm.includes("toi la ") || norm.includes("doi sang ")) {
      const targetMember = state.members.find(m => norm.includes(normalizeVi(m.name)));
      if (targetMember) {
        state.activeMemberId = targetMember.id;
        saveLocalState();
        updateHeaderMemberUI();
        syncMemberProfileServer(targetMember);
        setUserHeardLine(`👂 Đổi sang: ${targetMember.name}`, true);
        speakFeedback(`Chào ${targetMember.name}! Mình đã chuyển sang hồ sơ của bạn rồi nhé.`, "vi-VN");
        return;
      }
    }

    // 9. Đổi vai trò trò chuyện
    const roles = [
      { key: "co giao", label: "🎓 Cô giáo tiếng Anh", reply: "Mình đã hóa thân thành Cô giáo tiếng Anh rồi đây!" },
      { key: "bac si", label: "🩺 Bác sĩ nhí", reply: "Xin chào! Bác sĩ Lucky sẵn sàng chăm sóc sức khỏe cho bạn!" },
      { key: "ban than", label: "🤝 Bạn thân Lucky", reply: "Chào cậu! Bạn thân Lucky luôn bên cạnh cậu đây!" },
      { key: "ke chuyen", label: "📚 Người kể chuyện", reply: "Mình đã sẵn sàng kể những câu chuyện thú vị cho bạn nghe!" }
    ];
    for (const r of roles) {
      if (norm.includes(r.key)) {
        state.roleName = r.label;
        document.getElementById("role-badge").textContent = r.label;
        setUserHeardLine(`👂 "${rawText}"`, true);
        speakFeedback(r.reply, "vi-VN");
        return;
      }
    }

    // 10. Hỏi giờ, pin & Đi ngủ
    if (norm.includes("may gio")) {
      const now = new Date();
      setUserHeardLine(`👂 "${rawText}"`, true);
      speakFeedback(`Bây giờ là ${now.getHours()} giờ ${now.getMinutes()} phút rồi bạn nhé!`, "vi-VN");
      return;
    }
    if (norm.includes("pin con") || norm.includes("bao nhieu pin")) {
      const batText = document.getElementById("hdr-battery")?.textContent || "80%";
      setUserHeardLine(`👂 "${rawText}"`, true);
      speakFeedback(`Pin của mình hiện đang còn ${batText.replace(/[^\d%]/g, "")} nhé!`, "vi-VN");
      return;
    }
    if (norm.includes("di ngu") || norm.includes("ngu di")) {
      setUserHeardLine(`👂 "${rawText}"`, true);
      enterBatterySleepMode();
      return;
    }

    // KHÔNG khớp lệnh: Tuyệt đối KHÔNG gọi speakFeedback("Mình nghe bạn nói...") để tránh vòng lặp tự nghe!
    // Chỉ hiển thị chữ mờ trên màn hình và mở lại mic sau nhịp nghỉ ngắn.
    setUserHeardLine(`👂 "${rawText}"`, false);
    scheduleMicReopen(650);
  }

  // ==================== MODE 3: LESSON_LOCKED (KARAOKE & PRONUNCIATION) ====================
  function toggleKaraokePanel(open) {
    const stage = document.getElementById("robot-stage");
    const panel = document.getElementById("karaoke-panel");
    const toggleBtn = document.getElementById("btn-toggle-karaoke");

    if (open) {
      stage.classList.remove("full-face");
      stage.classList.add("split-mode");
      panel.classList.remove("hidden");
      if (toggleBtn) toggleBtn.textContent = "✖ Đóng bảng luyện đọc";
      setVoiceMode("LESSON_LOCKED");
      renderCurrentSentence();
      // Đọc câu mẫu tiếng Anh 1 lần rồi dừng mic chờ người dùng bấm "🎤 Bé đọc"
      setTimeout(() => playCurrentSentence(), 300);
    } else {
      stage.classList.remove("split-mode");
      stage.classList.add("full-face");
      panel.classList.add("hidden");
      if (toggleBtn) toggleBtn.textContent = "📖 Mở bảng luyện đọc";
      stopAllSpeechAndMic();
      setVoiceMode("COMMAND_IDLE");
      setRobotBubble("Đã đóng bảng luyện đọc. Bạn có thể ra lệnh bằng giọng nói bất cứ lúc nào!");
      scheduleMicReopen(600);
    }
  }

  function renderCurrentSentence() {
    const item = state.sentences[state.sentenceIndex];
    if (!item) return;

    document.getElementById("k-topic-title").textContent = `Chủ đề: ${state.currentTopicTitle}`;
    document.getElementById("k-progress-text").textContent = `Câu ${state.sentenceIndex + 1} / ${state.sentences.length}`;
    const orderBadge = document.getElementById("k-order-badge");
    if (orderBadge) {
      orderBadge.textContent = state.lessonRandomMode ? "🎲 Ngẫu nhiên" : "📋 Thứ tự";
    }

    const enBox = document.getElementById("k-sentence-en");
    enBox.innerHTML = "";
    const words = item.en.split(/\s+/);
    words.forEach(w => {
      const span = document.createElement("span");
      span.className = "k-word";
      span.textContent = w;
      enBox.appendChild(span);
    });

    const spellBox = document.getElementById("k-spelling-box");
    spellBox.innerHTML = "";
    const spells = Array.isArray(item.spelling) && item.spelling.length > 0
      ? item.spelling
      : words.map(w => {
          const clean = w.replace(/[^a-zA-Z]/g, "");
          return { word: clean, spell: clean.toUpperCase().split("").join("-") };
        });

    spells.slice(0, 8).forEach(sp => {
      if (!sp.word) return;
      const chip = document.createElement("span");
      chip.className = "spell-chip";
      chip.textContent = `${sp.word}: ${sp.spell}`;
      spellBox.appendChild(chip);
    });

    document.getElementById("k-sentence-vi").textContent = item.vi || "";
    document.getElementById("k-score-label").textContent = 'Bấm "🎤 Bé đọc" để luyện phát âm';
    document.getElementById("k-heard-words").textContent = "";
  }

  function playCurrentSentence() {
    const item = state.sentences[state.sentenceIndex];
    if (!item) return;

    // Đảm bảo khóa mic trước khi phát câu mẫu
    stopMicCompletely();

    const wordEls = document.querySelectorAll("#k-sentence-en .k-word");
    wordEls.forEach((el, idx) => {
      setTimeout(() => {
        wordEls.forEach(w => w.classList.remove("active"));
        el.classList.add("active");
      }, idx * 300);
    });
    setTimeout(() => wordEls.forEach(w => w.classList.remove("active")), wordEls.length * 300 + 350);

    if (item.audio_url) {
      state.isSpeaking = true;
      setRobotMood("speaking");
      state.audioPlayer.src = item.audio_url;
      state.audioPlayer.onended = () => handleTtsFinished();
      state.audioPlayer.onerror = () => speakFeedback(item.en, "en-US");
      state.audioPlayer.play().catch(() => speakFeedback(item.en, "en-US"));
    } else {
      speakFeedback(item.en, "en-US");
    }
  }

  // Bấm nút "🎤 Bé đọc" hoặc nút cứng BTN_2 trên ESP32 -> thu đúng 1 lượt en-US rồi tắt mic ngay
  function startSingleLessonRecording() {
    if (state.voiceMode !== "LESSON_LOCKED") {
      toggleKaraokePanel(true);
      return;
    }

    // Dừng TTS nếu robot đang đọc mẫu
    const RobotNative = getRobotNative();
    if (state.isSpeaking) {
      state.isSpeaking = false;
      if (RobotNative) RobotNative.stopSpeak().catch(() => {});
      try { state.audioPlayer.pause(); } catch (_) {}
    }

    stopMicCompletely();
    state.isRecordingLesson = true;
    setRobotMood("listening");

    const btnRec = document.getElementById("btn-k-record");
    if (btnRec) {
      btnRec.classList.add("recording");
      btnRec.textContent = "⏺️ Đang thu...";
    }
    document.getElementById("k-score-label").textContent = "🎙️ Đang nghe bạn đọc tiếng Anh (1 lượt)...";

    if (RobotNative) {
      state.isListening = true;
      RobotNative.startListening({ lang: "en-US" }).catch(() => {
        state.isListening = false;
        state.isRecordingLesson = false;
        if (btnRec) {
          btnRec.classList.remove("recording");
          btnRec.textContent = "🎤 Bé đọc";
        }
      });
    }
  }

  function evaluateEnglishPronunciation(spokenEn) {
    const item = state.sentences[state.sentenceIndex];
    if (!item) return;

    const targetWords = item.en.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
    const spokenSet = new Set(spokenEn.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean));

    const wordEls = document.querySelectorAll("#k-sentence-en .k-word");
    let matchedCount = 0;
    const hardWords = JSON.parse(localStorage.getItem(`rb_hard_words_${state.activeMemberId}`) || "[]");

    targetWords.forEach((tw, idx) => {
      const ok = spokenSet.has(tw);
      if (ok) {
        matchedCount++;
        if (wordEls[idx]) wordEls[idx].classList.add("matched");
      } else {
        if (wordEls[idx]) wordEls[idx].classList.add("missed");
        if (tw.length >= 3 && !hardWords.includes(tw)) {
          hardWords.push(tw);
        }
      }
    });

    localStorage.setItem(`rb_hard_words_${state.activeMemberId}`, JSON.stringify(hardWords.slice(-60)));

    const score = targetWords.length > 0 ? Math.round((matchedCount / targetWords.length) * 100) : 0;
    document.getElementById("k-score-label").textContent = `Điểm phát âm: ${score}% (${matchedCount}/${targetWords.length} từ)`;
    document.getElementById("k-heard-words").textContent = `Bạn đọc: "${spokenEn}"`;

    if (score >= 80) {
      addStarsToActiveMember(1, `Đọc chuẩn câu: ${item.en}`);
      speakFeedback(`Tuyệt vời! Bạn đạt ${score} điểm và được thưởng 1 ngôi sao!`, "vi-VN");
    } else {
      speakFeedback(`Bạn đạt ${score} điểm. Bấm Nghe mẫu hoặc Bé đọc để thử lại nhé!`, "vi-VN");
    }
  }

  // ==================== TOPICS & SHUFFLE / SEQUENTIAL LOADER ====================
  async function loadTopicsList(forceRefresh = false) {
    const summary = document.getElementById("topics-summary-text");
    if (summary) summary.textContent = "Đang đồng bộ danh sách chủ đề từ máy chủ...";

    try {
      const res = await fetch(apiUrl("api.php", { action: "list_topics", t: forceRefresh ? Date.now() : undefined }));
      if (res.ok) {
        const data = await res.json();
        const list = Array.isArray(data) ? data : (data.topics || data.data || []);
        if (list.length > 0) {
          state.topics = list;
          localStorage.setItem("rb_v14_topics", JSON.stringify(list));
        }
      }
    } catch (_) {}

    renderTopicsGrid();
  }

  function renderTopicsGrid() {
    const grid = document.getElementById("topics-grid");
    const summary = document.getElementById("topics-summary-text");
    if (!grid) return;

    if (!state.topics || state.topics.length === 0) {
      if (summary) summary.textContent = "Chưa tải được danh sách chủ đề trực tuyến (đang dùng dữ liệu mẫu).";
      return;
    }

    if (summary) summary.textContent = `Đã đồng bộ ${state.topics.length} chủ đề học tiếng Anh (Chạm để chọn Thứ tự hoặc Ngẫu nhiên).`;
    grid.innerHTML = "";

    state.topics.forEach((t, idx) => {
      const title = t.title || t.topic;
      const card = document.createElement("div");
      card.className = "topic-card";
      card.innerHTML = `
        <div>
          <h4>#${idx + 1} • ${title}</h4>
          <p class="topic-meta">${t.count || 250} câu luyện đọc</p>
        </div>
        <div class="btn-group-wrap">
          <button type="button" class="action-btn primary" data-mode="seq">📋 Thứ tự</button>
          <button type="button" class="action-btn warn" data-mode="rnd">🎲 Ngẫu nhiên</button>
        </div>
      `;
      card.querySelector('[data-mode="seq"]').onclick = e => {
        e.stopPropagation();
        loadTopicSentences(t.topic, title, false);
      };
      card.querySelector('[data-mode="rnd"]').onclick = e => {
        e.stopPropagation();
        loadTopicSentences(t.topic, title, true);
      };
      card.onclick = () => {
        switchTab("robot");
        promptLessonOrderChoice(t.topic, title);
      };
      grid.appendChild(card);
    });
  }

  function shuffleArray(arr) {
    const copy = arr.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  async function loadTopicSentences(topicSlug, topicTitle, isRandom = false) {
    state.currentTopic = topicSlug;
    state.currentTopicTitle = topicTitle;
    state.lessonRandomMode = Boolean(isRandom);

    let allItems = [];
    const cacheKey = `rb_topic_data_${topicSlug}`;

    try {
      const res = await fetch(apiUrl("api.php", { action: "get_topic", topic: topicSlug, limit: 250 }));
      if (res.ok) {
        const data = await res.json();
        allItems = Array.isArray(data) ? data : (data.sentences || data.items || data.data || []);
        if (allItems.length > 0) {
          localStorage.setItem(cacheKey, JSON.stringify(allItems));
        }
      }
    } catch (_) {}

    if (allItems.length === 0) {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
      if (Array.isArray(cached) && cached.length > 0) allItems = cached;
    }

    if (allItems.length > 0) {
      state.sentences = isRandom ? shuffleArray(allItems) : allItems;
      state.sentenceIndex = 0;
    }

    switchTab("robot");
    toggleKaraokePanel(true);
  }

  function openHardWordsLesson() {
    const hardWords = JSON.parse(localStorage.getItem(`rb_hard_words_${state.activeMemberId}`) || "[]");
    if (hardWords.length === 0) {
      speakFeedback("Bạn chưa có từ khó nào cần ôn. Giỏi lắm!", "vi-VN");
      return;
    }
    state.currentTopic = "hard_words";
    state.currentTopicTitle = "Ôn từ khó";
    state.lessonRandomMode = false;
    state.sentences = hardWords.map((w, i) => ({
      id: i,
      en: w,
      vi: `Luyện phát âm lại từ: ${w}`,
      audio_url: "",
      spelling: [{ word: w, spell: w.toUpperCase().split("").join("-") }]
    }));
    state.sentenceIndex = 0;
    switchTab("robot");
    toggleKaraokePanel(true);
  }

  // ==================== UNIVERSAL VIRTUAL KEYBOARD (#virtual-kb-modal + #pin-modal) ====================
  const vkbState = {
    targetInput: null,
    mode: "qwerty", // numpad | qwerty
    shift: false,
    masked: true
  };

  const QWERTY_ROWS_LOWER = [
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
    ["SHIFT", "z", "x", "c", "v", "b", "n", "m", "DEL"],
    ["@", "#", "$", "_", "-", ".", "!", "?", "*", "/", "+", "="],
    ["CLR", "SPACE", ".com"]
  ];

  function renderVirtualKeypad(containerEl, mode, shiftOn, onKeyPress) {
    if (!containerEl) return;
    containerEl.innerHTML = "";

    if (mode === "numpad") {
      const grid = document.createElement("div");
      grid.className = "numpad-grid";
      const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "CLR", "0", "DEL"];
      keys.forEach(k => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "vkb-key" + (k === "CLR" ? " warn" : "");
        btn.textContent = k === "CLR" ? "Xóa hết" : k === "DEL" ? "⌫" : k;
        btn.onclick = () => onKeyPress(k);
        grid.appendChild(btn);
      });
      containerEl.appendChild(grid);
      return;
    }

    // QWERTY + Numbers + Symbols layout
    QWERTY_ROWS_LOWER.forEach(rowKeys => {
      const rowDiv = document.createElement("div");
      rowDiv.className = "qwerty-row";
      rowKeys.forEach(k => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "vkb-key";
        if (k === "SHIFT") {
          btn.classList.add("wide");
          if (shiftOn) btn.classList.add("active-shift");
          btn.textContent = shiftOn ? "⇧ HOA" : "⇧ thường";
        } else if (k === "DEL") {
          btn.classList.add("wide");
          btn.textContent = "⌫";
        } else if (k === "CLR") {
          btn.classList.add("wide", "warn");
          btn.textContent = "Xóa hết";
        } else if (k === "SPACE") {
          btn.classList.add("space-key");
          btn.textContent = "Dấu cách (Space)";
        } else if (k === ".com") {
          btn.classList.add("wide");
          btn.textContent = ".com";
        } else {
          const disp = shiftOn && /^[a-z]$/.test(k) ? k.toUpperCase() : k;
          btn.textContent = disp;
        }
        btn.onclick = () => onKeyPress(k);
        rowDiv.appendChild(btn);
      });
      containerEl.appendChild(rowDiv);
    });
  }

  function openUniversalVirtualKeyboard(inputEl) {
    if (!inputEl) return;
    vkbState.targetInput = inputEl;
    vkbState.mode = inputEl.dataset.vkbMode || "qwerty";
    vkbState.shift = false;
    vkbState.masked = inputEl.type === "password";

    const modal = document.getElementById("virtual-kb-modal");
    const titleEl = document.getElementById("vkb-title");
    const dispEl = document.getElementById("vkb-display-input");
    const keysContainer = document.getElementById("vkb-keys-container");

    titleEl.textContent = `⌨️ ${inputEl.dataset.vkbTitle || "Nhập dữ liệu"}`;
    dispEl.value = inputEl.value || "";
    dispEl.type = vkbState.masked ? "password" : "text";

    const handleKey = k => {
      if (k === "SHIFT") {
        vkbState.shift = !vkbState.shift;
        renderVirtualKeypad(keysContainer, vkbState.mode, vkbState.shift, handleKey);
        return;
      }
      if (k === "CLR") {
        dispEl.value = "";
        return;
      }
      if (k === "DEL") {
        dispEl.value = dispEl.value.slice(0, -1);
        return;
      }
      if (k === "SPACE") {
        dispEl.value += " ";
        return;
      }
      const ch = vkbState.shift && /^[a-z]$/.test(k) ? k.toUpperCase() : k;
      dispEl.value += ch;
    };

    renderVirtualKeypad(keysContainer, vkbState.mode, vkbState.shift, handleKey);
    modal.classList.remove("hidden");
  }

  function initUniversalVirtualKeyboard() {
    // Gắn sự kiện chạm mở Bàn phím ảo cho toàn bộ ô có class .vkb-bind-input
    document.querySelectorAll(".vkb-bind-input").forEach(inp => {
      inp.addEventListener("click", e => {
        e.preventDefault();
        openUniversalVirtualKeyboard(inp);
      });
    });

    document.getElementById("btn-vkb-switch-layout").addEventListener("click", () => {
      vkbState.mode = vkbState.mode === "numpad" ? "qwerty" : "numpad";
      const keysContainer = document.getElementById("vkb-keys-container");
      const dispEl = document.getElementById("vkb-display-input");
      renderVirtualKeypad(keysContainer, vkbState.mode, vkbState.shift, k => {
        if (k === "SHIFT") {
          vkbState.shift = !vkbState.shift;
          renderVirtualKeypad(keysContainer, vkbState.mode, vkbState.shift, arguments.callee);
        } else if (k === "CLR") dispEl.value = "";
        else if (k === "DEL") dispEl.value = dispEl.value.slice(0, -1);
        else if (k === "SPACE") dispEl.value += " ";
        else dispEl.value += vkbState.shift && /^[a-z]$/.test(k) ? k.toUpperCase() : k;
      });
    });

    document.getElementById("btn-vkb-toggle-eye").addEventListener("click", () => {
      const dispEl = document.getElementById("vkb-display-input");
      vkbState.masked = !vkbState.masked;
      dispEl.type = vkbState.masked ? "password" : "text";
    });

    document.getElementById("btn-vkb-cancel").addEventListener("click", () => {
      document.getElementById("virtual-kb-modal").classList.add("hidden");
      vkbState.targetInput = null;
    });

    document.getElementById("btn-vkb-confirm").addEventListener("click", () => {
      const dispEl = document.getElementById("vkb-display-input");
      if (vkbState.targetInput) {
        vkbState.targetInput.value = dispEl.value;
        vkbState.targetInput.dispatchEvent(new Event("change"));
      }
      document.getElementById("virtual-kb-modal").classList.add("hidden");
      vkbState.targetInput = null;
    });
  }

  // ==================== IN-APP BLUETOOTH BLE SCANNER & CONFIG MODAL ====================
  function updateBleHeaderAndSettingsUI() {
    const pill = document.getElementById("hdr-ble-pill");
    const hdrTxt = document.getElementById("hdr-ble-text");
    const detail = document.getElementById("ble-status-detail");

    if (state.bleConnected) {
      if (pill) {
        pill.classList.remove("offline");
        pill.classList.add("online");
      }
      const shortName = state.bleDeviceName || "ESP32";
      if (hdrTxt) hdrTxt.textContent = `BLE: ${shortName.slice(0, 12)}`;
      if (detail) {
        detail.innerHTML = `Trạng thái: <strong style="color:#22c55e;">Đã kết nối ${shortName}</strong> (${state.bleDeviceId}) ${state.bleAutoConnect ? "• Tự động kết nối" : ""}`;
      }
    } else {
      if (pill) {
        pill.classList.remove("online");
        pill.classList.add("offline");
      }
      if (hdrTxt) hdrTxt.textContent = "ESP32: Chờ";
      if (detail) {
        detail.textContent = state.bleDeviceId
          ? `Đã lưu: ${state.bleDeviceName || state.bleDeviceId} (Chưa kết nối)`
          : "Trạng thái: Chưa kết nối mạch ESP32";
      }
    }
  }

  function renderBleScannedList() {
    const listEl = document.getElementById("ble-device-list");
    if (!listEl) return;

    const items = Array.from(state.bleScannedDevices.values());
    if (items.length === 0) {
      listEl.innerHTML = `<div class="sub-text" style="padding:10px;">${state.bleScanning ? "Đang dò tìm thiết bị BLE xung quanh..." : "Không tìm thấy thiết bị nào. Hãy bật nguồn ESP32 và bấm Quét lại."}</div>`;
      return;
    }

    // Ưu tiên đưa thiết bị chứa ESP32 / Robot / Lucky lên đầu danh sách, sau đó sắp xếp theo sóng mạnh nhất (RSSI)
    items.sort((a, b) => {
      const aPri = /esp32|robot|lucky/i.test(a.name) ? 1 : 0;
      const bPri = /esp32|robot|lucky/i.test(b.name) ? 1 : 0;
      if (aPri !== bPri) return bPri - aPri;
      return (b.rssi || -100) - (a.rssi || -100);
    });

    listEl.innerHTML = "";
    items.forEach(dev => {
      const isPri = /esp32|robot|lucky/i.test(dev.name);
      const isSel = state.bleSelectedCandidate && state.bleSelectedCandidate.deviceId === dev.deviceId;
      const row = document.createElement("div");
      row.className = "ble-dev-item" + (isPri ? " priority" : "") + (isSel ? " selected" : "");
      row.innerHTML = `
        <div>
          <div class="ble-dev-name">${isPri ? "🤖 " : "📶 "}${dev.name || "Thiết bị BLE không tên"}</div>
          <div class="ble-dev-mac">${dev.deviceId}</div>
        </div>
        <span class="ble-rssi-chip">${dev.rssi ? `${dev.rssi} dBm` : "Sẵn sàng"}</span>
      `;
      row.onclick = () => selectBleCandidate(dev);
      listEl.appendChild(row);
    });
  }

  function selectBleCandidate(dev) {
    state.bleSelectedCandidate = dev;
    document.getElementById("ble-sel-name").textContent = dev.name || "Thiết bị BLE";
    document.getElementById("ble-sel-id").textContent = `Địa chỉ / ID: ${dev.deviceId}`;
    document.getElementById("ble-pin-input").value = (dev.deviceId === state.bleDeviceId) ? state.blePin : "";
    document.getElementById("ble-auto-connect-chk").checked = state.bleAutoConnect;
    renderBleScannedList();
  }

  async function startInAppBleScan() {
    const BleClient = getBleClient();
    const scanTag = document.getElementById("ble-scan-state-tag");

    // Giữ lại thiết bị đã lưu trong danh sách để phụ huynh dễ chọn lại
    if (state.bleDeviceId && !state.bleScannedDevices.has(state.bleDeviceId)) {
      state.bleScannedDevices.set(state.bleDeviceId, {
        deviceId: state.bleDeviceId,
        name: state.bleDeviceName || "ESP32 Robot (Đã lưu)",
        rssi: -55
      });
    }
    renderBleScannedList();

    if (!BleClient) {
      if (scanTag) scanTag.textContent = "Chế độ mô phỏng Web";
      return;
    }

    try {
      await BleClient.initialize();
      if (state.bleScanning) {
        try { await BleClient.stopLEScan(); } catch (_) {}
      }
      state.bleScanning = true;
      if (scanTag) scanTag.textContent = "🔄 Đang quét...";

      await BleClient.requestLEScan({ allowDuplicates: true }, result => {
        const dev = result?.device;
        if (!dev || !dev.deviceId) return;
        const name = result.localName || dev.name || "Thiết bị BLE";
        state.bleScannedDevices.set(dev.deviceId, {
          deviceId: dev.deviceId,
          name,
          rssi: result.rssi ?? -70
        });
        renderBleScannedList();
      });

      setTimeout(async () => {
        if (state.bleScanning) {
          state.bleScanning = false;
          try { await BleClient.stopLEScan(); } catch (_) {}
          if (scanTag) scanTag.textContent = `Tìm thấy ${state.bleScannedDevices.size} thiết bị`;
        }
      }, 10000);
    } catch (err) {
      state.bleScanning = false;
      if (scanTag) scanTag.textContent = `Lỗi quét: ${err?.message || "Chưa bật Bluetooth"}`;
    }
  }

  async function connectToBleDevice(deviceId, deviceName, pinCode = "", autoConnect = true, silent = false) {
    const BleClient = getBleClient();
    if (!BleClient || !deviceId) return;

    const scanTag = document.getElementById("ble-scan-state-tag");
    if (scanTag && !silent) scanTag.textContent = "⏳ Đang kết nối...";

    try {
      if (state.bleScanning) {
        state.bleScanning = false;
        try { await BleClient.stopLEScan(); } catch (_) {}
      }
      await BleClient.initialize();
      await BleClient.connect(deviceId, () => {
        state.bleConnected = false;
        updateBleHeaderAndSettingsUI();
      });

      state.bleDeviceId = deviceId;
      state.bleDeviceName = deviceName || "ESP32 Robot";
      state.blePin = pinCode;
      state.bleAutoConnect = autoConnect;
      state.bleConnected = true;
      saveBleConfig();
      updateBleHeaderAndSettingsUI();

      // Lắng nghe dữ liệu cảm biến / nút cứng từ ESP32
      try {
        await BleClient.startNotifications(deviceId, BLE_SERVICE_UUID, BLE_CHAR_RX_UUID, value => {
          const msg = new TextDecoder().decode(value).trim();
          handleEspHardwareEvent(msg);
        });
      } catch (_) {}

      // Nếu có đặt mật khẩu/PIN BLE, gửi gói xác thực PIN:xxxx xuống ESP32
      if (pinCode) {
        await sendBleCommand(`PIN:${pinCode}`);
      }

      if (scanTag && !silent) scanTag.textContent = "✅ Đã kết nối!";
      if (!silent) {
        speakFeedback(`Đã kết nối thành công với ${state.bleDeviceName}!`, "vi-VN");
      }
    } catch (err) {
      state.bleConnected = false;
      updateBleHeaderAndSettingsUI();
      if (scanTag && !silent) scanTag.textContent = `❌ Lỗi: ${err?.message || "Thất bại"}`;
    }
  }

  async function disconnectBleDevice() {
    const BleClient = getBleClient();
    if (BleClient && state.bleDeviceId) {
      try { await BleClient.disconnect(state.bleDeviceId); } catch (_) {}
    }
    state.bleConnected = false;
    updateBleHeaderAndSettingsUI();
    const scanTag = document.getElementById("ble-scan-state-tag");
    if (scanTag) scanTag.textContent = "Đã ngắt kết nối";
  }

  async function forgetBleDevice() {
    await disconnectBleDevice();
    state.bleDeviceId = null;
    state.bleDeviceName = "";
    state.blePin = "";
    state.bleSelectedCandidate = null;
    localStorage.removeItem("rb_v14_ble_cfg");
    updateBleHeaderAndSettingsUI();
    document.getElementById("ble-sel-name").textContent = "Chưa chọn thiết bị";
    document.getElementById("ble-sel-id").textContent = "Đã xóa cấu hình thiết bị đã lưu";
  }

  function openBleManagerModal() {
    document.getElementById("ble-modal").classList.remove("hidden");
    if (state.bleDeviceId) {
      selectBleCandidate({
        deviceId: state.bleDeviceId,
        name: state.bleDeviceName || "ESP32 Robot",
        rssi: -55
      });
    }
    startInAppBleScan();
  }

  async function sendBleCommand(cmd) {
    const BleClient = getBleClient();
    if (!BleClient || !state.bleConnected || !state.bleDeviceId) return;
    try {
      const encoder = new TextEncoder();
      const dataView = new DataView(encoder.encode(cmd + "\n").buffer);
      await BleClient.write(state.bleDeviceId, BLE_SERVICE_UUID, BLE_CHAR_TX_UUID, dataView);
    } catch (_) {}
  }

  function handleEspHardwareEvent(msg) {
    if (!msg) return;
    if (msg.includes("TOUCH_HEAD") || msg.includes("PIR_WAKE")) {
      resetIdleTimer();
    } else if (msg.includes("BTN_1")) {
      if (state.voiceMode === "LESSON_LOCKED") playCurrentSentence();
    } else if (msg.includes("BTN_2")) {
      startSingleLessonRecording();
    }
  }

  // ==================== 24/7 WEBRTC P2P LIVE CAMERA & OFFLINE QR CODE ====================
  let robotPc = null;
  let robotCamStream = null;
  let isAnsweringCall = false;
  let appliedViewerIceCount = 0;

  function getCameraLiveViewerUrl() {
    const base = state.config.baseUrl.replace(/\/+$/, "");
    return `${base}/camera_live.php?uid=${encodeURIComponent(state.deviceUid)}`;
  }

  function getCameraLiveApiBase() {
    const base = state.config.baseUrl.replace(/\/+$/, "");
    return `${base}/camera_live.php?api=1&uid=${encodeURIComponent(state.deviceUid)}`;
  }

  function renderCameraQrCard() {
    const qrBox = document.getElementById("qr-code-container");
    const uidLabel = document.getElementById("cam-device-uid-label");
    const urlInput = document.getElementById("cam-live-url-text");
    const viewerUrl = getCameraLiveViewerUrl();

    if (uidLabel) uidLabel.textContent = state.deviceUid;
    if (urlInput) urlInput.value = viewerUrl;
    if (qrBox && window.RobotQR) {
      window.RobotQR.render(qrBox, viewerUrl, 140);
    }
  }

  function updateRemoteCamStatusBadge(text, color = "#86efac") {
    const el = document.getElementById("cam-remote-status");
    if (el) {
      el.textContent = text;
      el.style.color = color;
    }
  }

  async function camApiPost(action, payload = {}) {
    const res = await fetch(`${getCameraLiveApiBase()}&action=${encodeURIComponent(action)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uid: state.deviceUid,
        role: "robot",
        action,
        ...payload
      })
    });
    return res.json();
  }

  function stopRobotCameraStream() {
    if (robotPc) {
      try { robotPc.close(); } catch (_) {}
      robotPc = null;
    }
    if (robotCamStream) {
      try { robotCamStream.getTracks().forEach(track => track.stop()); } catch (_) {}
      robotCamStream = null;
    }
    isAnsweringCall = false;
    appliedViewerIceCount = 0;
    updateRemoteCamStatusBadge("🟢 Sẵn sàng nhận cuộc gọi từ xa (Poll 2.5s)", "#86efac");
  }

  async function handleIncomingViewerCall(offerSdp) {
    if (isAnsweringCall || robotPc) return;
    isAnsweringCall = true;
    appliedViewerIceCount = 0;
    updateRemoteCamStatusBadge("🔴 Đang kết nối Camera trực tiếp P2P...", "#fca5a5");

    try {
      // Tự động mở Camera trước & Mic của Robot (không cần chạm màn hình)
      robotCamStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: true
      });

      robotPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      robotCamStream.getTracks().forEach(track => robotPc.addTrack(track, robotCamStream));

      robotPc.onicecandidate = ev => {
        if (ev.candidate) {
          camApiPost("ice", { candidate: ev.candidate.toJSON() }).catch(() => {});
        }
      };

      robotPc.onconnectionstatechange = () => {
        if (!robotPc) return;
        if (robotPc.connectionState === "connected") {
          updateRemoteCamStatusBadge("🔴 ĐANG TRUYỀN HÌNH P2P TỚI ĐIỆN THOẠI", "#f87171");
        } else if (["disconnected", "failed", "closed"].includes(robotPc.connectionState)) {
          stopRobotCameraStream();
        }
      };

      await robotPc.setRemoteDescription(new RTCSessionDescription(offerSdp));
      const answer = await robotPc.createAnswer();
      await robotPc.setLocalDescription(answer);

      await camApiPost("robot_answer", {
        sdp: { type: answer.type, sdp: answer.sdp }
      });
    } catch (err) {
      console.error("Lỗi mở camera Robot:", err);
      stopRobotCameraStream();
    } finally {
      isAnsweringCall = false;
    }
  }

  function startGlobalRemoteCameraPoller() {
    if (state.camPollTimer) clearInterval(state.camPollTimer);
    // Chạy ngầm toàn cục 24/7 mỗi 2.5 giây (kể cả khi Robot đang ngủ hoặc mở YouTube/Game)
    state.camPollTimer = setInterval(async () => {
      try {
        const res = await fetch(`${getCameraLiveApiBase()}&action=poll&role=robot&t=${Date.now()}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.status !== "ok" || !data.session) return;
        const sess = data.session;

        // 1. Có người thân bấm gọi từ xa -> Tự động bật camera & trả lời
        if (sess.state === "ringing" && sess.offer && !robotPc && !isAnsweringCall) {
          await handleIncomingViewerCall(sess.offer);
        }

        // 2. Nhận thêm ICE candidates từ trình duyệt người xem để khớp đường P2P
        if (robotPc && Array.isArray(sess.viewer_ice) && sess.viewer_ice.length > appliedViewerIceCount) {
          for (let i = appliedViewerIceCount; i < sess.viewer_ice.length; i++) {
            try {
              await robotPc.addIceCandidate(new RTCIceCandidate(sess.viewer_ice[i]));
            } catch (_) {}
          }
          appliedViewerIceCount = sess.viewer_ice.length;
        }

        // 3. Người xem tắt máy hoặc hết 10 phút -> Tắt ngay Camera trước trên Robot
        if (robotPc && (sess.state === "cooldown" || sess.state === "idle")) {
          stopRobotCameraStream();
        }
      } catch (_) {}
    }, 2500);
  }

  // ==================== LIGHTS, FACE ANIMATION & TELEMETRY ====================
  function setHeadLight(on) {
    state.headLightOn = on;
    const el = document.getElementById("head-led-indicator");
    if (el) {
      el.textContent = on ? "💡 Đèn đầu: Bật" : "💡 Đèn đầu: Tắt";
      el.classList.toggle("on", on);
    }
    sendBleCommand(on ? "L:HEAD:1" : "L:HEAD:0");
  }

  function setArmLight(on) {
    state.armLightOn = on;
    const el = document.getElementById("arm-led-indicator");
    if (el) {
      el.textContent = on ? "🦾 Đèn tay: Bật" : "🦾 Đèn tay: Tắt";
      el.classList.toggle("on", on);
    }
    sendBleCommand(on ? "L:ARM:1" : "L:ARM:0");
  }

  function movePupils(dx, dy) {
    document.querySelectorAll(".pupil").forEach(p => {
      p.style.transform = `translate(${dx}px, ${dy}px)`;
    });
  }

  function startBlinkLoop() {
    setInterval(() => {
      if (state.sleepStage === "sleeping") return;
      document.querySelectorAll(".eye").forEach(e => e.classList.add("blink"));
      setTimeout(() => {
        document.querySelectorAll(".eye").forEach(e => e.classList.remove("blink"));
      }, 170);
    }, 3800);
  }

  async function refreshDeviceTelemetry() {
    const RobotNative = getRobotNative();
    if (RobotNative) {
      try {
        const st = await RobotNative.getDeviceStatus();
        const batIcon = st.isCharging ? "⚡" : "🔋";
        document.getElementById("hdr-battery").textContent = `${batIcon} ${st.battery}%`;
        document.getElementById("hdr-temp").textContent = `${Number(st.temperature).toFixed(1)}°C`;

        const wifiLabel = st.wifiSsid || "Đã kết nối";
        const wifiInfo = document.getElementById("set-wifi-info");
        if (wifiInfo) wifiInfo.textContent = wifiLabel;

        const wifiCur = document.getElementById("wifi-current-status");
        if (wifiCur) wifiCur.textContent = `Mạng hiện tại: ${wifiLabel} (IP: ${st.localIp || "0.0.0.0"})`;

        const wifiSsidInput = document.getElementById("wifi-ssid-input");
        if (wifiSsidInput && !wifiSsidInput.value && st.wifiSsid && !st.wifiSsid.includes("Chưa")) {
          wifiSsidInput.value = st.wifiSsid;
        }
        return;
      } catch (_) {}
    }

    if (navigator.getBattery) {
      try {
        const b = await navigator.getBattery();
        const pct = Math.round(b.level * 100);
        document.getElementById("hdr-battery").textContent = `${b.charging ? "⚡" : "🔋"} ${pct}%`;
      } catch (_) {}
    }
  }

  // ==================== PIN UNLOCK MODAL (NUMPAD + QWERTY) ====================
  let pinModalMode = "numpad";
  let pinModalMasked = true;

  function renderPinModalKeypad() {
    const container = document.getElementById("pin-keypad-container");
    const inp = document.getElementById("pin-modal-input");
    let shift = false;

    const onKey = k => {
      if (k === "SHIFT") {
        shift = !shift;
        renderVirtualKeypad(container, pinModalMode, shift, onKey);
        return;
      }
      if (k === "CLR") {
        inp.value = "";
        return;
      }
      if (k === "DEL") {
        inp.value = inp.value.slice(0, -1);
        return;
      }
      if (k === "SPACE") {
        inp.value += " ";
        return;
      }
      inp.value += shift && /^[a-z]$/.test(k) ? k.toUpperCase() : k;
    };

    renderVirtualKeypad(container, pinModalMode, shift, onKey);
  }

  function openPinModal() {
    pinModalMode = "numpad";
    pinModalMasked = true;
    const inp = document.getElementById("pin-modal-input");
    inp.value = "";
    inp.type = "password";
    document.getElementById("pin-modal-error").classList.add("hidden");
    renderPinModalKeypad();
    document.getElementById("pin-modal").classList.remove("hidden");
  }

  function verifyAndUnlockSettings() {
    const val = document.getElementById("pin-modal-input").value.trim();
    if (
      val === state.config.parentPin ||
      val === MASTER_NUMERIC_PIN ||
      val.toLowerCase() === MASTER_TEST_PASS
    ) {
      state.settingsUnlocked = true;
      document.getElementById("pin-modal").classList.add("hidden");
      if (state.pendingTab) {
        const nextTab = state.pendingTab;
        state.pendingTab = null;
        switchTab(nextTab);
      }
    } else {
      document.getElementById("pin-modal-error").classList.remove("hidden");
    }
  }

  // ==================== SETTINGS & MEMBERS UI ====================
  function syncSettingsUI() {
    document.getElementById("set-study-only").checked = Boolean(state.config.studyOnly);
    document.getElementById("set-bedtime").value = state.config.bedtime || "21:30";
    document.getElementById("set-brightness").value = state.config.brightness;
    document.getElementById("val-brightness").textContent = `${state.config.brightness}%`;
    document.getElementById("set-volume").value = state.config.volume;
    document.getElementById("val-volume").textContent = `${state.config.volume}%`;
    document.getElementById("set-rate").value = state.config.speechRate;
    document.getElementById("val-rate").textContent = `${state.config.speechRate}x`;
    document.getElementById("set-base-url").value = state.config.baseUrl;
    renderMembersSettingsList();
    updateBleHeaderAndSettingsUI();
  }

  function renderMembersSettingsList() {
    const list = document.getElementById("members-list");
    if (!list) return;
    list.innerHTML = "";
    state.members.forEach(m => {
      const row = document.createElement("div");
      row.className = "member-item";
      const isCur = m.id === state.activeMemberId;
      row.innerHTML = `
        <span>${m.avatar || "🧒"} <strong>${m.name}</strong> (${m.age} tuổi) • ★ ${m.stars} ${isCur ? '<strong style="color:#38bdf8;">[Đang chọn]</strong>' : ""}</span>
        <div style="display:flex; gap:5px;">
          <button type="button" class="action-btn" data-act="sel">Chọn</button>
          ${state.members.length > 1 ? '<button type="button" class="action-btn danger" data-act="del">Xóa</button>' : ""}
        </div>
      `;
      row.querySelector('[data-act="sel"]').onclick = () => {
        state.activeMemberId = m.id;
        saveLocalState();
        updateHeaderMemberUI();
        renderMembersSettingsList();
        syncMemberProfileServer(m);
      };
      const delBtn = row.querySelector('[data-act="del"]');
      if (delBtn) {
        delBtn.onclick = () => {
          state.members = state.members.filter(x => x.id !== m.id);
          if (state.activeMemberId === m.id) state.activeMemberId = state.members[0].id;
          saveLocalState();
          updateHeaderMemberUI();
          renderMembersSettingsList();
        };
      }
      list.appendChild(row);
    });
  }

  function openQuickMemberModal() {
    const grid = document.getElementById("quick-member-grid");
    grid.innerHTML = "";
    state.members.forEach(m => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "action-btn" + (m.id === state.activeMemberId ? " primary" : "");
      btn.innerHTML = `${m.avatar || "🧒"} ${m.name} (★ ${m.stars})`;
      btn.onclick = () => {
        state.activeMemberId = m.id;
        saveLocalState();
        updateHeaderMemberUI();
        syncMemberProfileServer(m);
        document.getElementById("member-modal").classList.add("hidden");
        speakFeedback(`Đã chuyển sang hồ sơ của ${m.name}!`, "vi-VN");
      };
      grid.appendChild(btn);
    });
    document.getElementById("member-modal").classList.remove("hidden");
  }

  // ==================== APP INITIALIZATION ====================
  function bindEvents() {
    const RobotNative = getRobotNative();

    // Header Navigation
    document.querySelectorAll(".nav-btn[data-tab]").forEach(btn => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    document.getElementById("btn-refresh-frame").addEventListener("click", () => {
      const m = getActiveMember();
      if (state.activeTab === "youtube") {
        document.getElementById("frame-youtube").src = apiUrl("youtube.php", { uid: m.uid, stars: m.stars, r: Date.now() });
      } else if (state.activeTab === "game") {
        document.getElementById("frame-game").src = apiUrl("games.php", { uid: m.uid, stars: m.stars, r: Date.now() });
      }
    });

    document.getElementById("member-badge").addEventListener("click", openQuickMemberModal);
    document.getElementById("btn-member-close").addEventListener("click", () => {
      document.getElementById("member-modal").classList.add("hidden");
    });

    // Touch on Robot Face wakes up & resets idle
    document.getElementById("robot-face-wrap").addEventListener("click", e => {
      if (e.target.closest("button")) return;
      resetIdleTimer();
    });

    // Quick Action Buttons on Robot Face
    document.getElementById("btn-voice-topic-select").addEventListener("click", () => {
      enterTopicSelectMode(true);
    });

    document.getElementById("btn-toggle-karaoke").addEventListener("click", () => {
      const isHidden = document.getElementById("karaoke-panel").classList.contains("hidden");
      toggleKaraokePanel(isHidden);
    });

    document.getElementById("btn-quick-talk").addEventListener("click", () => {
      if (state.voiceMode === "LESSON_LOCKED") {
        startSingleLessonRecording();
      } else {
        resetIdleTimer();
        scheduleMicReopen(150);
      }
    });

    // Topic Picker & Order Choice Buttons
    document.getElementById("btn-vtopic-prev").addEventListener("click", () => {
      const totalPages = Math.max(1, Math.ceil(state.topics.length / 6));
      state.topicPage = (state.topicPage - 1 + totalPages) % totalPages;
      renderVoiceTopicPickerPage(true);
    });
    document.getElementById("btn-vtopic-next").addEventListener("click", () => {
      const totalPages = Math.max(1, Math.ceil(state.topics.length / 6));
      state.topicPage = (state.topicPage + 1) % totalPages;
      renderVoiceTopicPickerPage(true);
    });
    document.getElementById("btn-vtopic-close").addEventListener("click", () => {
      setVoiceMode("COMMAND_IDLE");
      scheduleMicReopen(400);
    });

    document.getElementById("btn-order-sequential").addEventListener("click", () => confirmLessonOrderChoice(false));
    document.getElementById("btn-order-random").addEventListener("click", () => confirmLessonOrderChoice(true));
    document.getElementById("btn-order-cancel").addEventListener("click", () => {
      setVoiceMode("COMMAND_IDLE");
      scheduleMicReopen(400);
    });

    // Karaoke Lesson Controls (Mode 3: LESSON_LOCKED)
    document.getElementById("btn-close-karaoke").addEventListener("click", () => toggleKaraokePanel(false));
    document.getElementById("btn-k-prev").addEventListener("click", () => {
      state.sentenceIndex = (state.sentenceIndex - 1 + state.sentences.length) % state.sentences.length;
      renderCurrentSentence();
      playCurrentSentence();
    });
    document.getElementById("btn-k-listen").addEventListener("click", () => playCurrentSentence());
    document.getElementById("btn-k-record").addEventListener("click", () => startSingleLessonRecording());
    document.getElementById("btn-k-replay").addEventListener("click", () => {
      if (state.lastRecordedBlobUrl) {
        new Audio(state.lastRecordedBlobUrl).play().catch(() => {});
      } else {
        playCurrentSentence();
      }
    });
    document.getElementById("btn-k-next").addEventListener("click", () => {
      state.sentenceIndex = (state.sentenceIndex + 1) % state.sentences.length;
      renderCurrentSentence();
      playCurrentSentence();
    });

    // Topics Tab Controls
    document.getElementById("btn-sync-topics").addEventListener("click", () => loadTopicsList(true));
    document.getElementById("btn-review-hard-words").addEventListener("click", () => openHardWordsLesson());

    // PIN Modal Controls
    document.getElementById("btn-pin-switch-layout").addEventListener("click", () => {
      pinModalMode = pinModalMode === "numpad" ? "qwerty" : "numpad";
      renderPinModalKeypad();
    });
    document.getElementById("btn-pin-toggle-eye").addEventListener("click", () => {
      const inp = document.getElementById("pin-modal-input");
      pinModalMasked = !pinModalMasked;
      inp.type = pinModalMasked ? "password" : "text";
    });
    document.getElementById("btn-pin-cancel").addEventListener("click", () => {
      document.getElementById("pin-modal").classList.add("hidden");
      state.pendingTab = null;
    });
    document.getElementById("btn-pin-confirm").addEventListener("click", verifyAndUnlockSettings);

    // Settings Controls
    document.getElementById("btn-lock-settings").addEventListener("click", () => {
      state.settingsUnlocked = false;
      switchTab("robot");
    });

    document.getElementById("btn-add-member").addEventListener("click", () => {
      const name = document.getElementById("new-member-name").value.trim();
      const age = parseInt(document.getElementById("new-member-age").value, 10) || 7;
      const avatar = document.getElementById("new-member-avatar").value;
      if (!name) return;
      const newM = { id: "m_" + Date.now(), uid: generateRandomId(18, "RB"), name, age, avatar, stars: 0 };
      state.members.push(newM);
      state.activeMemberId = newM.id;
      document.getElementById("new-member-name").value = "";
      saveLocalState();
      updateHeaderMemberUI();
      renderMembersSettingsList();
      syncMemberProfileServer(newM);
    });

    document.getElementById("set-study-only").addEventListener("change", e => {
      state.config.studyOnly = e.target.checked;
      saveLocalState();
      syncMemberProfileServer(getActiveMember());
    });

    document.getElementById("set-bedtime").addEventListener("change", e => {
      state.config.bedtime = e.target.value;
      saveLocalState();
    });

    document.getElementById("btn-save-parent-pin").addEventListener("click", () => {
      const newPin = document.getElementById("set-new-parent-pin").value.trim();
      if (newPin.length >= 4) {
        state.config.parentPin = newPin;
        document.getElementById("set-new-parent-pin").value = "";
        saveLocalState();
        syncMemberProfileServer(getActiveMember());
        speakFeedback("Đã lưu mã PIN Phụ huynh mới thành công!", "vi-VN");
      }
    });

    document.getElementById("set-brightness").addEventListener("input", e => {
      state.config.brightness = parseInt(e.target.value, 10);
      document.getElementById("val-brightness").textContent = `${state.config.brightness}%`;
      saveLocalState();
      if (RobotNative) RobotNative.setBrightness({ level: state.config.brightness }).catch(() => {});
    });

    document.getElementById("set-volume").addEventListener("input", e => {
      state.config.volume = parseInt(e.target.value, 10);
      document.getElementById("val-volume").textContent = `${state.config.volume}%`;
      saveLocalState();
      if (RobotNative) RobotNative.setVolume({ level: state.config.volume }).catch(() => {});
    });

    document.getElementById("set-rate").addEventListener("input", e => {
      state.config.speechRate = parseFloat(e.target.value);
      document.getElementById("val-rate").textContent = `${state.config.speechRate}x`;
      saveLocalState();
    });

    document.getElementById("btn-req-perms").addEventListener("click", () => {
      if (RobotNative) RobotNative.requestAllPermissions().catch(() => {});
    });

    // Wi-Fi Modal Controls
    document.getElementById("btn-open-wifi").addEventListener("click", () => {
      refreshDeviceTelemetry();
      document.getElementById("wifi-modal").classList.remove("hidden");
    });
    document.getElementById("btn-wifi-modal-close").addEventListener("click", () => {
      document.getElementById("wifi-modal").classList.add("hidden");
    });
    document.getElementById("btn-wifi-android-panel").addEventListener("click", () => {
      if (RobotNative) RobotNative.openWifiSettings().catch(() => {});
    });
    document.getElementById("btn-wifi-connect-now").addEventListener("click", () => {
      const ssid = document.getElementById("wifi-ssid-input").value.trim();
      const password = document.getElementById("wifi-pass-input").value;
      if (RobotNative) {
        RobotNative.connectWifiLegacy({ ssid, password }).catch(() => {});
      }
      document.getElementById("wifi-modal").classList.add("hidden");
    });

    // In-App Bluetooth BLE Modal Controls
    document.getElementById("btn-ble-scan").addEventListener("click", openBleManagerModal);
    document.getElementById("btn-ble-rescan").addEventListener("click", startInAppBleScan);
    document.getElementById("btn-ble-modal-close").addEventListener("click", async () => {
      const BleClient = getBleClient();
      if (BleClient && state.bleScanning) {
        state.bleScanning = false;
        try { await BleClient.stopLEScan(); } catch (_) {}
      }
      document.getElementById("ble-modal").classList.add("hidden");
    });
    document.getElementById("btn-ble-connect").addEventListener("click", () => {
      const cand = state.bleSelectedCandidate;
      if (!cand) return;
      const pinCode = document.getElementById("ble-pin-input").value.trim();
      const autoConn = document.getElementById("ble-auto-connect-chk").checked;
      connectToBleDevice(cand.deviceId, cand.name, pinCode, autoConn, false);
    });
    document.getElementById("btn-ble-disconnect").addEventListener("click", disconnectBleDevice);
    document.getElementById("btn-ble-forget").addEventListener("click", forgetBleDevice);

    // Hardware Test Buttons
    document.getElementById("btn-test-head-light").addEventListener("click", () => setHeadLight(!state.headLightOn));
    document.getElementById("btn-test-arm-light").addEventListener("click", () => setArmLight(!state.armLightOn));
    document.getElementById("btn-test-head-turn").addEventListener("click", () => {
      sendBleCommand("M:HEAD:SWEEP:1");
      movePupils(-8, 0);
      setTimeout(() => movePupils(8, 0), 500);
      setTimeout(() => movePupils(0, 0), 1000);
    });

    // Server URL & QR Camera Controls
    document.getElementById("btn-save-server").addEventListener("click", () => {
      const urlVal = document.getElementById("set-base-url").value.trim();
      if (urlVal) {
        state.config.baseUrl = urlVal.replace(/\/+$/, "");
        saveLocalState();
        renderCameraQrCard();
        speakFeedback("Đã lưu địa chỉ máy chủ và cập nhật mã QR Camera!", "vi-VN");
      }
    });

    document.getElementById("btn-copy-cam-url").addEventListener("click", async () => {
      const url = getCameraLiveViewerUrl();
      try {
        await navigator.clipboard.writeText(url);
      } catch (_) {
        const inp = document.getElementById("cam-live-url-text");
        if (inp) {
          inp.select();
          document.execCommand("copy");
        }
      }
      const btn = document.getElementById("btn-copy-cam-url");
      const orig = btn.textContent;
      btn.textContent = "✅ Đã sao chép!";
      setTimeout(() => { btn.textContent = orig; }, 1800);
    });

    document.getElementById("btn-toggle-cam-preview").addEventListener("click", async () => {
      const videoEl = document.getElementById("cam-preview-video");
      if (state.localPreviewStream) {
        state.localPreviewStream.getTracks().forEach(t => t.stop());
        state.localPreviewStream = null;
        videoEl.classList.add("hidden");
        return;
      }
      try {
        state.localPreviewStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
        videoEl.srcObject = state.localPreviewStream;
        videoEl.classList.remove("hidden");
      } catch (_) {}
    });

    // Kiosk / Developer Pin Controls
    document.getElementById("btn-dev-lock").addEventListener("click", () => {
      if (RobotNative) {
        RobotNative.setKioskMode({ enabled: true }).then(() => {
          document.getElementById("dev-lock-state").innerHTML = 'Trạng thái Kiosk: <strong style="color:#f59e0b;">ĐANG GHIM MÀN HÌNH</strong>';
        }).catch(() => {});
      }
    });

    document.getElementById("btn-check-pin-status").addEventListener("click", async () => {
      if (!RobotNative) return;
      const st = await RobotNative.getDeviceStatus().catch(() => ({}));
      document.getElementById("dev-lock-state").innerHTML = st.kioskLocked
        ? 'Trạng thái Kiosk: <strong style="color:#f59e0b;">ĐANG GHIM MÀN HÌNH</strong>'
        : 'Trạng thái Kiosk: <strong style="color:#22c55e;">ĐANG MỞ (KHÔNG GHIM)</strong>';
    });

    document.getElementById("btn-dev-unlock").addEventListener("click", () => {
      const code = document.getElementById("dev-exit-code-input").value.trim();
      if (code === DEVELOPER_MASTER_CODE) {
        document.getElementById("dev-exit-code-input").value = "";
        if (RobotNative) {
          RobotNative.setKioskMode({ enabled: false }).then(() => {
            document.getElementById("dev-lock-state").innerHTML = 'Trạng thái Kiosk: <strong style="color:#22c55e;">ĐÃ GỠ GHIM THOÁT APP</strong>';
          }).catch(() => {});
        }
      }
    });

    // Native Plugin Speech & TTS Listeners
    if (RobotNative) {
      RobotNative.addListener("ttsStart", () => {
        state.isSpeaking = true;
        stopMicCompletely();
        setRobotMood("speaking");
      });

      RobotNative.addListener("ttsEnd", () => {
        handleTtsFinished();
      });

      RobotNative.addListener("speechPartial", data => {
        if (data?.text && state.voiceMode !== "LESSON_LOCKED") {
          setUserHeardLine(`👂 Đang nghe: "${data.text}"...`, false);
        }
      });

      RobotNative.addListener("speechResult", data => {
        state.isListening = false;
        handleSpeechResult(data?.text || "");
      });

      RobotNative.addListener("speechError", () => {
        state.isListening = false;
        if (state.isRecordingLesson) {
          state.isRecordingLesson = false;
          const btnRec = document.getElementById("btn-k-record");
          if (btnRec) {
            btnRec.classList.remove("recording");
            btnRec.textContent = "🎤 Bé đọc";
          }
          document.getElementById("k-score-label").textContent = "Chưa nghe rõ, bấm 🎤 Bé đọc để thử lại!";
          if (state.sleepStage === "awake") setRobotMood("happy");
          return;
        }
        // Chỉ tự mở lại mic nền nếu đang ở COMMAND_IDLE hoặc TOPIC_SELECT (không ở LESSON_LOCKED)
        if (state.activeTab === "robot" && state.voiceMode !== "LESSON_LOCKED" && !state.isSpeaking) {
          scheduleMicReopen(700);
        }
      });
    }

    // Bridge postMessage với iframe YouTube & Game
    window.addEventListener("message", ev => {
      const d = ev.data;
      if (!d || typeof d !== "object") return;
      if (d.type === "GAME_REQ_PROFILE") {
        const m = getActiveMember();
        ev.source?.postMessage({ type: "APP_PROFILE_DATA", uid: m.uid, name: m.name, stars: m.stars }, "*");
      } else if (d.type === "APP_CHANGE_STARS" && typeof d.delta === "number") {
        addStarsToActiveMember(d.delta, d.reason || "Tương tác giải trí");
      } else if (d.type === "GAME_ESP_CMD" && typeof d.cmd === "string") {
        sendBleCommand(d.cmd);
      }
    });
  }

  function initApp() {
    loadLocalState();
    updateHeaderMemberUI();
    initUniversalVirtualKeyboard();
    bindEvents();
    renderCameraQrCard();
    startBlinkLoop();
    startIdleMonitor();
    startGlobalRemoteCameraPoller();
    setVoiceMode("COMMAND_IDLE");

    const RobotNative = getRobotNative();
    if (RobotNative) {
      RobotNative.requestAllPermissions().catch(() => {});
      RobotNative.setBrightness({ level: state.config.brightness }).catch(() => {});
      RobotNative.setVolume({ level: state.config.volume }).catch(() => {});
      refreshDeviceTelemetry();
      setInterval(refreshDeviceTelemetry, 12000);
    }

    // Tự động kết nối lại Bluetooth BLE đã lưu nếu bật Auto-Connect
    if (state.bleDeviceId && state.bleAutoConnect) {
      setTimeout(() => {
        connectToBleDevice(state.bleDeviceId, state.bleDeviceName, state.blePin, true, true);
      }, 1500);
    }

    syncMemberProfileServer(getActiveMember());
    loadTopicsList(false);
    scheduleMicReopen(900);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initApp);
  } else {
    initApp();
  }
})();
