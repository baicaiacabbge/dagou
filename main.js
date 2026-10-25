'use strict';
/* ============================================================
 * 大狗Tap —— 仿 Mikutap：点击/拖动屏幕，狗叫会卡在节拍上
 * 背景音轨：Web Audio 实时合成的劲爆鼓组 + 洗脑和弦循环
 * 视觉（仿 Mikutap）：
 *   · 全屏几何特效，以屏幕正中心为原点铺满全屏
 *   · 新特效叠在旧特效之上，旧特效随即退场
 *   · 固定米白背景；限定调色板：主色黄 + 次色灰（极少点缀色）
 *   · 特效带常驻动效（旋转 / 漂浮 / 环绕 / 波动）并随节拍轻微脉动（只做大小/形状变化，不变色）
 * ============================================================ */

/* ---------- 节奏常量 ---------- */
const BPM = 128;
const SPB = 60 / BPM;
const S16 = SPB / 4;
const S8  = SPB / 2;
const MASTER_GAIN = 0.85;
const PIANO_OCTAVE_MIN = 3;
const PIANO_OCTAVE_MAX = 6;
const PIANO_DEFAULT_OCTAVE_START = 4;
const DEFAULT_PERFORMANCE_SETTINGS = Object.freeze({
  pianoMode: false,
  octaveSwitching: false,
  pianoOctaveStart: PIANO_DEFAULT_OCTAVE_START,
  rhythmSnap: true,
  showGrid: false,
});

/* ---------- 全局状态 ---------- */
let ctx = null;
let master = null;
let bgmBus = null;
let sfxBus = null;
let noiseBuf = null;
let started = false;
let bgmMuted = false;
let sfxMuted = false;
const performanceSettings = { ...DEFAULT_PERFORMANCE_SETTINGS };
let performanceSettingsSaving = false;
let pendingPianoOctaveCloudValue = null;
let pianoOctaveCloudWriteRunning = false;

let startTime = 0;
let nextNoteTime = 0;
let stepCount = 0;

const SFX_SAMPLE_SETS = Object.freeze({
  dagou: Object.freeze({ da: 'da', gou: 'gou', jiao: 'jiao' }),
  hajimi: Object.freeze({ da: 'ha', gou: 'ji', jiao: 'mi' }),
  dingdong: Object.freeze({
    da: 'dingdongji_ding',
    gou: 'dingdongji_dong',
    jiao: 'dingdongji_ji',
  }),
});
const CHARACTER_IMAGE_SETS = Object.freeze({
  dagou: Object.freeze({
    close: 'Image/dagou_close_mouth.png',
    open: 'Image/dagou_open_mouth.png',
    alt: '大狗',
  }),
  dingdong: Object.freeze({
    close: 'Image/dingdongji_close_mouth.png',
    open: 'Image/dingdongji_open_mouth.png',
    alt: '叮咚鸡',
  }),
  hajimi: Object.freeze({
    close: 'Image/maodie_close_mouth.png',
    open: 'Image/maodie_open_mouth.png',
    alt: '哈基米',
  }),
});
const HAJIMI_ATLAS_URL =
  'Image/donghaidihuang_atlas.webp?v=20260721-beat-synced';
const HAJIMI_STATIC_ICON_URL = 'Image/maodie_close_mouth.png';
const HAJIMI_ANIMATION_ICON_URL = 'Image/donghaidihuang_icon.webp';
const HAJIMI_ANIMATION_BEATS = 9;
const HAJIMI_FRAMES_PER_BEAT = 12;
const HAJIMI_ATLAS_COLUMNS = 12;
const HAJIMI_ATLAS_FRAME_WIDTH = 360;
const HAJIMI_ATLAS_FRAME_HEIGHT = 514;
const HAJIMI_ANIMATION_FRAME_COUNT =
  HAJIMI_ANIMATION_BEATS * HAJIMI_FRAMES_PER_BEAT;
const RUNTIME_SAMPLE_NAMES = Object.freeze(
  [...new Set(Object.values(SFX_SAMPLE_SETS).flatMap(Object.values))]
);
const buffers = {};
const sustainLoops = {};
let selectedSfxId = 'hajimi';
let hajimiAnimationEnabled = false;
let hajimiAnimationReady = false;
let hajimiAnimationRequested = false;
let hajimiAnimationFrame = -1;
let hajimiAnimationEpochBeat = 0;

const SUSTAIN_REGIONS = {
  da: {
    enabled: false,
    regionStart: 0.065, regionEnd: 0.168,
    frame: 0.052, overlap: 0.026, search: 0.007,
    wrapBlend: 0.040, textureDuration: 7.31, seed: 0.17,
  },
  gou: {
    enabled: false,
    regionStart: 0.055, regionEnd: 0.140,
    frame: 0.048, overlap: 0.024, search: 0.006,
    wrapBlend: 0.036, textureDuration: 7.73, seed: 0.43,
  },
  jiao: {
    enabled: true,
    regionStart: 0.125, regionEnd: 0.290,
    frame: 0.100, overlap: 0.050, search: 0.012,
    wrapBlend: 0.040, textureDuration: 12.37, seed: 0.71,
    preferFrameEntry: true,
  },
  mi: {
    enabled: true,
    regionStart: 0.245, regionEnd: 0.345,
    frame: 0.070, overlap: 0.035, search: 0.008,
    wrapBlend: 0.028, textureDuration: 12.11, seed: 0.29,
    preferFrameEntry: true,
  },
  dingdongji_ji: {
    enabled: true,
    regionStart: 0.120, regionEnd: 0.310,
    frame: 0.100, overlap: 0.050, search: 0.012,
    wrapBlend: 0.040, textureDuration: 11.83, seed: 0.53,
    preferFrameEntry: true,
  },
};
const SUSTAIN_CLAIM_LEAD = 0.008;
const RELEASE_SCHEDULE_LEAD = 0.006;
const EMERGENCY_FADE = 0.018;

const liveVoices = new Set();
let voiceSerial = 0;
let activeSustainVoice = null;
let mouthVoice = null;

let cols = 4, rows = 3;
let zones = [];

let mouthTimer = 0;
let mouthPopped = false;
let barkPop = 0;
let barkPopVel = 0;
const BARK_KICK = 5.2;
const BARK_KICK_MAX = 9;
let holding = false;
let holdLevel = 0;
let jellyScale = 1;
let jellyVel = 0;
let lastTick = 0;
const INPUT_LOOKAHEAD = 0.12;
const INPUT_QUEUE_LOOKAHEAD = 0.03;
const inputQueue = [];
const inputVisualTimers = new Set();
let inputSerial = 0;
let lastCommittedInputTime = -Infinity;
const pointers = new Map();
const CONTROLS_IDLE_MS = 2000;
const CONTROLS_HOVER_IDLE_MS = 250;
const NAVIGATION_MUTE_KEY = 'dagou-navigation-muted';
const TOY_CLOUD_KEYS = Object.freeze({
  settingsSeen: 'dagou_settings_seen_v1',
  dingdongNewSeen: 'dagou_dingdong_new_seen_v1',
  hajimiNewSeen: 'dagou_hajimi_new_seen_v1',
  pianoMode: 'dagou_piano_mode_v1',
  octaveSwitching: 'dagou_octave_switching_v1',
  pianoOctaveStart: 'dagou_piano_octave_start_v1',
  rhythmSnap: 'dagou_rhythm_snap_v1',
  showGrid: 'dagou_show_grid_v1',
});
const TOY_CLOUD_KEY_LIST = Object.freeze(Object.values(TOY_CLOUD_KEYS));
const TOY_REQUIRED_ABILITIES = Object.freeze([
  'getAuthorVideos',
  'getVideoUserActions',
  'navigate',
]);
const TOY_CLOUD_ABILITIES = Object.freeze([
  'getCloudStorage',
  'setCloudStorage',
]);
const VIDEO_UNLOCK_ITEM_IDS = new Set();
const LOCKED_SFX_IDS = new Set();
let controlsIdleTimer = 0;
let navigationMuted = false;

try {
  navigationMuted =
    window.sessionStorage.getItem(NAVIGATION_MUTE_KEY) === '1';
} catch (error) {
  console.warn('[大狗Tap] 无法读取导航临时静音状态。', error);
}

/* ---------- DOM ---------- */
const stage     = document.getElementById('stage');
const fxCanvas  = document.getElementById('fx');
const dogEl     = document.getElementById('dog');
const dogInner  = document.getElementById('dog-inner');
const dogJelly  = document.getElementById('dog-jelly');
const dogCloseImage = document.getElementById('dog-close');
const dogOpenImage = document.getElementById('dog-open');
const dogAnimationCanvas = document.getElementById('dog-animation');
const dogAnimationAtlas = document.getElementById('dog-animation-atlas');
const dogAnimation2d = dogAnimationCanvas.getContext('2d', { alpha: true });
const overlay   = document.getElementById('overlay');
const keyGrid   = document.getElementById('key-grid');
const flashLayer = document.getElementById('zoneflash');
const octaveControls = document.getElementById('octave-controls');
const octaveDownButton = document.getElementById('octave-down');
const octaveUpButton = document.getElementById('octave-up');
const subEl     = overlay.querySelector('.sub');
const fx2d      = fxCanvas.getContext('2d');
const topControls = document.getElementById('top-controls');
const musicToggle = document.getElementById('music-toggle');
const sfxToggle = document.getElementById('sfx-toggle');
const settingsButton = document.getElementById('settings-button');
const updateDot = document.getElementById('update-dot');
const settingsOverlay = document.getElementById('settings-overlay');
const settingsPanel = document.getElementById('settings-panel');
const settingsClose = document.getElementById('settings-close');
const unlockConfirmOverlay = document.getElementById('unlock-confirm-overlay');
const unlockConfirmDialog = document.getElementById('unlock-confirm-dialog');
const unlockConfirmTitle = document.getElementById('unlock-confirm-title');
const unlockConfirmMessage = document.getElementById('unlock-confirm-message');
const unlockConfirmCancel = document.getElementById('unlock-confirm-cancel');
const unlockConfirmSubmit = document.getElementById('unlock-confirm-submit');
const sfxOptions = [...document.querySelectorAll('.sfx-option')];
const hajimiOptionImage = document.getElementById('hajimi-option-image');
const hajimiSkinSwitcher = document.getElementById('hajimi-skin-switcher');
const hajimiSkinOptions = [
  ...hajimiSkinSwitcher.querySelectorAll('.skin-option'),
];
const hajimiSkinClassic = hajimiSkinSwitcher.querySelector('[data-skin="classic"]');
const hajimiSkinEmperor = hajimiSkinSwitcher.querySelector('[data-skin="emperor"]');
const hajimiSkinEmperorHint = hajimiSkinEmperor.querySelector('.skin-hint');
const performanceSettingButtons = [
  ...document.querySelectorAll('.setting-row[data-setting]'),
];
const octaveSwitchingSetting = document.getElementById('octave-switching-setting');
const performanceSettingsStatus = document.getElementById(
  'performance-settings-status'
);
const toyNotice = document.getElementById('toy-notice');
const authorLink = document.getElementById('author-link');
const reduceUiMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function showControls() {
  if (pointers.size > 0 || holding) return;
  topControls.classList.add('is-visible');
}

function hideControlsUntilIdle() {
  topControls.classList.remove('is-visible');
  topControls.classList.remove('is-revealing-fast');
  clearTimeout(controlsIdleTimer);
  controlsIdleTimer = setTimeout(showControls, CONTROLS_IDLE_MS);
}

function accelerateControlsReveal() {
  if (
    topControls.classList.contains('is-visible') ||
    pointers.size > 0 ||
    holding
  ) return;
  topControls.classList.add('is-revealing-fast');
  clearTimeout(controlsIdleTimer);
  controlsIdleTimer = setTimeout(showControls, CONTROLS_HOVER_IDLE_MS);
}

function setBusMuted(bus, muted) {
  if (!ctx || !bus) return;
  const now = ctx.currentTime;
  bus.gain.cancelScheduledValues(now);
  bus.gain.setTargetAtTime(muted ? 0 : 1, now, 0.015);
}

function setNavigationMute(muted) {
  navigationMuted = muted;

  try {
    if (muted) {
      window.sessionStorage.setItem(NAVIGATION_MUTE_KEY, '1');
    } else {
      window.sessionStorage.removeItem(NAVIGATION_MUTE_KEY);
    }
  } catch (error) {
    console.warn('[大狗Tap] 无法保存导航临时静音状态。', error);
  }

  if (!ctx || !master) return;
  const now = ctx.currentTime;
  master.gain.cancelScheduledValues(now);
  master.gain.setTargetAtTime(muted ? 0 : MASTER_GAIN, now, 0.015);
}

function restoreAfterNavigation() {
  if (navigationMuted) setNavigationMute(false);
}

function updateMuteButton(button, muted, label) {
  const action = muted ? '开启' : '关闭';
  button.classList.toggle('is-muted', muted);
  button.setAttribute('aria-pressed', String(muted));
  button.setAttribute('aria-label', `${action}${label}`);
  button.title = `${action}${label}`;
}

function toggleMusic() {
  bgmMuted = !bgmMuted;
  setBusMuted(bgmBus, bgmMuted);
  updateMuteButton(musicToggle, bgmMuted, '音乐');
}

function toggleSoundEffects() {
  sfxMuted = !sfxMuted;
  setBusMuted(sfxBus, sfxMuted);
  updateMuteButton(sfxToggle, sfxMuted, '音效');

  if (sfxMuted) {
    dogInner.classList.remove('bark-image');
  } else if (mouthVoice) {
    dogInner.classList.add('bark-image');
  }
}

function setRhythmScale(element, pulse, amount) {
  element.style.setProperty(
    '--rhythm-scale',
    (1 + pulse * amount).toFixed(4)
  );
}

const authorNameLetters = [];
for (const line of authorLink.querySelectorAll('.author-label, .author-name')) {
  const text = line.textContent;
  line.textContent = '';
  for (const char of text) {
    const letter = document.createElement('span');
    letter.className = 'author-letter';
    letter.textContent = char === ' ' ? ' ' : char;
    line.appendChild(letter);
    if (line.classList.contains('author-name')) {
      authorNameLetters.push(letter);
    }
  }
}

function updateAuthorNameLetters(beatIndex, pulse) {
  const activeIndex = authorNameLetters.length
    ? ((beatIndex % authorNameLetters.length) + authorNameLetters.length) %
      authorNameLetters.length
    : -1;

  for (let i = 0; i < authorNameLetters.length; i++) {
    const scale = i === activeIndex ? 1 + pulse * 0.24 : 1;
    authorNameLetters[i].style.transform = `scale(${scale.toFixed(4)})`;
  }
}

function updateUiRhythm(beatPosition) {
  if (!Number.isFinite(beatPosition)) {
    setRhythmScale(musicToggle, 0, 0.075);
    setRhythmScale(sfxToggle, 0, 0.075);
    setRhythmScale(settingsButton, 0, 0.075);
    setRhythmScale(updateDot, 0, 0.4);
    authorLink.style.setProperty('--author-rhythm-scale', '1');
    authorLink.style.setProperty('--author-lift', '0px');
    updateAuthorNameLetters(-1, 0);
    return;
  }

  const phase = ((beatPosition % 1) + 1) % 1;
  const beatIndex = Math.floor(beatPosition);
  const pulse = reduceUiMotion ? 0 : Math.pow(1 - phase, 4.5);
  let musicPulse = 0;
  let sfxPulse = 0;

  if (!bgmMuted && !sfxMuted) {
    if (((beatIndex % 2) + 2) % 2 === 0) musicPulse = pulse;
    else sfxPulse = pulse;
  } else if (!bgmMuted) {
    musicPulse = pulse;
  } else if (!sfxMuted) {
    sfxPulse = pulse;
  }

  setRhythmScale(musicToggle, musicPulse, 0.075);
  setRhythmScale(sfxToggle, sfxPulse, 0.075);
  setRhythmScale(settingsButton, pulse, 0.075);
  setRhythmScale(updateDot, pulse, 0.4);
  authorLink.style.setProperty(
    '--author-rhythm-scale',
    (1 + pulse * 0.032).toFixed(4)
  );
  authorLink.style.setProperty(
    '--author-lift',
    `${(-pulse * 1.4).toFixed(3)}px`
  );
  updateAuthorNameLetters(beatIndex, pulse);
}

for (const button of topControls.querySelectorAll('button')) {
  button.addEventListener('pointerenter', (event) => {
    if (event.pointerType === 'mouse') accelerateControlsReveal();
  });
  button.addEventListener('click', (event) => {
    const pinnedSettingsButton =
      button === settingsButton &&
      topControls.classList.contains('has-update-dot');
    if (!topControls.classList.contains('is-visible') && !pinnedSettingsButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      accelerateControlsReveal();
    }
  }, { capture: true });
  button.addEventListener('pointerdown', (event) => event.stopPropagation());
  button.addEventListener('pointermove', (event) => event.stopPropagation());
  button.addEventListener('pointerup', (event) => event.stopPropagation());
  button.addEventListener('click', (event) => event.stopPropagation());
}
musicToggle.addEventListener('click', toggleMusic);
sfxToggle.addEventListener('click', toggleSoundEffects);

/* ---------- 设置菜单与 Toy 云状态 ---------- */
let settingsOpen = false;
let unlockConfirmOpen = false;
let unlockConfirmTrigger = null;
let toyNoticeTimer = 0;
const toyCloudState = {
  toy: null,
  initialized: false,
  environmentAvailable: false,
  cloudReadable: false,
  sfxUnlocked: true,
  settingsSeen: false,
  newSeen: {
    dingdong: false,
    hajimi: false,
  },
  locallyChanged: {
    settingsSeen: false,
    dingdong: false,
    hajimi: false,
  },
};
const PERFORMANCE_SETTING_KEYS = Object.freeze({
  pianoMode: TOY_CLOUD_KEYS.pianoMode,
  octaveSwitching: TOY_CLOUD_KEYS.octaveSwitching,
  rhythmSnap: TOY_CLOUD_KEYS.rhythmSnap,
  showGrid: TOY_CLOUD_KEYS.showGrid,
});

function showToyNotice(message, isError = false) {
  clearTimeout(toyNoticeTimer);
  toyNotice.textContent = message;
  toyNotice.classList.toggle('is-error', isError);
  toyNotice.classList.add('is-visible');
  toyNotice.setAttribute('aria-hidden', 'false');
  toyNoticeTimer = setTimeout(() => {
    toyNotice.classList.remove('is-visible');
    toyNotice.setAttribute('aria-hidden', 'true');
  }, 4800);
}

function clearQueuedPerformanceInput() {
  inputQueue.length = 0;
  lastCommittedInputTime = -Infinity;
  clearInputVisualTimers();
  for (const state of pointers.values()) state.pendingEntryId = null;
}

function settleActivePerformanceInput() {
  clearQueuedPerformanceInput();
  for (const inputId of [...pointers.keys()]) endInput(inputId, true);
}

function normalizePianoOctaveStart(value) {
  const octave = Number(value);
  return Number.isInteger(octave) &&
    octave >= PIANO_OCTAVE_MIN &&
    octave <= PIANO_OCTAVE_MAX
    ? octave
    : PIANO_DEFAULT_OCTAVE_START;
}

function effectivePianoOctaveStart(settings = performanceSettings) {
  return settings.pianoMode && settings.octaveSwitching
    ? normalizePianoOctaveStart(settings.pianoOctaveStart)
    : PIANO_DEFAULT_OCTAVE_START;
}

function octaveControlsEnabled(settings = performanceSettings) {
  return settings.pianoMode && settings.octaveSwitching;
}

function renderOctaveControlButton(button, currentOctave, targetOctave, direction) {
  const available = targetOctave >= PIANO_OCTAVE_MIN && targetOctave <= PIANO_OCTAVE_MAX;
  const currentLabel = `C${currentOctave}`;
  const targetLabel = available
    ? `C${targetOctave}`
    : (direction < 0 ? 'MIN' : 'MAX');
  const isLandscape = octaveControls.classList.contains('is-landscape');
  const directionLabel = direction < 0 ? '低八度' : '高八度';

  button.querySelector('.octave-current').textContent = currentLabel;
  button.querySelector('.octave-target').textContent = targetLabel;
  button.querySelector('.octave-arrow').textContent = isLandscape
    ? (direction < 0 ? '←' : '→')
    : (direction < 0 ? '↓' : '↑');
  button.disabled = !available;
  button.setAttribute(
    'aria-label',
    available
      ? `当前起始音 ${currentLabel}，切换到${directionLabel} ${targetLabel}`
      : `当前起始音 ${currentLabel}，已是${direction < 0 ? '最低' : '最高'}八度`,
  );
}

function renderOctaveControls() {
  const visible = octaveControlsEnabled();
  const { width, height } = getStageMetrics();
  const landscape = width >= height;
  const currentOctave = effectivePianoOctaveStart();

  octaveControls.classList.toggle('is-visible', visible);
  octaveControls.classList.toggle('is-landscape', landscape);
  octaveControls.setAttribute('aria-hidden', String(!visible));
  octaveControls.inert = !visible;
  renderOctaveControlButton(
    octaveDownButton,
    currentOctave,
    currentOctave - 1,
    -1,
  );
  renderOctaveControlButton(
    octaveUpButton,
    currentOctave,
    currentOctave + 1,
    1,
  );
}

function renderKeyGrid() {
  keyGrid.style.setProperty('--key-grid-cols', String(cols));
  keyGrid.style.setProperty('--key-grid-rows', String(rows));
  keyGrid.classList.toggle('is-visible', performanceSettings.showGrid);

  const fragment = document.createDocumentFragment();
  for (const zone of zones) {
    const cell = document.createElement('div');
    cell.className = 'key-grid-cell';
    cell.dataset.sample = zone.sample;
    if (zone.note) cell.dataset.note = zone.note;
    fragment.appendChild(cell);
  }
  keyGrid.replaceChildren(fragment);
}

function applyPerformanceSettings(previousSettings) {
  if (
    previousSettings &&
    previousSettings.rhythmSnap !== performanceSettings.rhythmSnap
  ) {
    clearQueuedPerformanceInput();
  }

  const scaleChanged = previousSettings && (
    previousSettings.pianoMode !== performanceSettings.pianoMode ||
    effectivePianoOctaveStart(previousSettings) !== effectivePianoOctaveStart()
  );
  if (scaleChanged) settleActivePerformanceInput();

  if (
    zones.length === 0 ||
    !previousSettings ||
    previousSettings.pianoMode !== performanceSettings.pianoMode ||
    effectivePianoOctaveStart(previousSettings) !== effectivePianoOctaveStart()
  ) {
    buildGrid();
  } else {
    renderKeyGrid();
  }
  renderOctaveControls();
}

function replacePerformanceSettings(nextSettings) {
  const previousSettings = { ...performanceSettings };
  for (const key of Object.keys(PERFORMANCE_SETTING_KEYS)) {
    performanceSettings[key] = nextSettings[key] === true;
  }
  performanceSettings.pianoOctaveStart = normalizePianoOctaveStart(
    nextSettings.pianoOctaveStart,
  );
  applyPerformanceSettings(previousSettings);
}

function resetPerformanceSettingsToDefaults() {
  replacePerformanceSettings(DEFAULT_PERFORMANCE_SETTINGS);
}

function markToyCloudUnavailable(state = toyCloudState) {
  state.cloudReadable = false;
  renderToyCloudState();
}

function readCloudPerformanceSettings(cloud) {
  const settings = { ...DEFAULT_PERFORMANCE_SETTINGS };
  for (const [settingName, cloudKey] of Object.entries(PERFORMANCE_SETTING_KEYS)) {
    const value = cloud[cloudKey];
    if (value === '1') settings[settingName] = true;
    else if (value === '0') settings[settingName] = false;
  }
  const cloudOctaveStart = Number(cloud[TOY_CLOUD_KEYS.pianoOctaveStart]);
  const validCloudOctaveStart = Number.isInteger(cloudOctaveStart) &&
    cloudOctaveStart >= PIANO_OCTAVE_MIN &&
    cloudOctaveStart <= PIANO_OCTAVE_MAX;
  settings.pianoOctaveStart = validCloudOctaveStart
    ? cloudOctaveStart
    : PIANO_DEFAULT_OCTAVE_START;
  if (!validCloudOctaveStart) settings.octaveSwitching = false;
  return settings;
}

function renderPerformanceSettings() {
  const cloudAvailable =
    toyCloudState.initialized &&
    toyCloudState.environmentAvailable &&
    toyCloudState.cloudReadable;
  octaveSwitchingSetting.hidden = !performanceSettings.pianoMode;

  for (const button of performanceSettingButtons) {
    const settingName = button.dataset.setting;
    button.setAttribute(
      'aria-checked',
      String(performanceSettings[settingName] === true)
    );
    button.disabled = !toyCloudState.initialized || performanceSettingsSaving;
  }

  performanceSettingsStatus.classList.toggle(
    'is-error',
    toyCloudState.initialized && !cloudAvailable
  );
  if (performanceSettingsSaving) {
    performanceSettingsStatus.textContent = '正在保存到哔哩哔哩云端…';
  } else if (!toyCloudState.initialized) {
    performanceSettingsStatus.textContent = '正在读取哔哩哔哩云端设置…';
  } else if (cloudAvailable) {
    performanceSettingsStatus.textContent = '设置已通过哔哩哔哩云端同步';
  } else {
    performanceSettingsStatus.textContent = '云存储不可用，本次设置仅在当前页面有效';
  }
  renderOctaveControls();
}

function renderToyCloudState() {
  const showUpdateDot = !toyCloudState.settingsSeen;
  updateDot.classList.toggle('is-hidden', !showUpdateDot);
  topControls.classList.toggle('has-update-dot', showUpdateDot);

  for (const option of sfxOptions) {
    const sfxId = option.dataset.sfx;
    option.classList.remove('is-locked');

    if (VIDEO_UNLOCK_ITEM_IDS.has(sfxId)) {
      const label = sfxId === 'dingdong' ? '叮咚鸡' : '哈基米';
      option.setAttribute('aria-label', label);
      option.classList.toggle('is-new-hidden', toyCloudState.newSeen[sfxId]);
    }
  }
  renderHajimiCharacterControl();
  renderPerformanceSettings();
}

async function detectToyEnvironment() {
  const toy = window.toy;
  if (
    !toy ||
    typeof toy.isSupport !== 'function' ||
    TOY_REQUIRED_ABILITIES.some((ability) => typeof toy[ability] !== 'function')
  ) {
    return null;
  }

  try {
    const support = await Promise.all(
      TOY_REQUIRED_ABILITIES.map((ability) => toy.isSupport(ability))
    );
    if (support.some((available) => available !== true)) return null;

    return toy;
  } catch (error) {
    console.warn('[大狗Tap] Toy 站内环境检测失败。', error);
    return null;
  }
}

async function detectToyCloudSupport(toy) {
  if (TOY_CLOUD_ABILITIES.some((ability) => typeof toy[ability] !== 'function')) {
    return false;
  }
  const support = await Promise.all(
    TOY_CLOUD_ABILITIES.map((ability) => toy.isSupport(ability))
  );
  return support.every((available) => available === true);
}

async function initializeToyCloudState() {
  const toy = await detectToyEnvironment();
  if (!toy) {
    toyCloudState.initialized = true;
    resetPerformanceSettingsToDefaults();
    renderToyCloudState();
    return toyCloudState;
  }

  toyCloudState.toy = toy;
  toyCloudState.environmentAvailable = true;

  try {
    if (!(await detectToyCloudSupport(toy))) {
      throw new Error('Toy 云存储能力不可用');
    }
    const cloud = await toy.getCloudStorage(TOY_CLOUD_KEY_LIST);
    if (!cloud || typeof cloud !== 'object') {
      throw new Error('Toy 云存储返回值无效');
    }
    toyCloudState.cloudReadable = true;
    replacePerformanceSettings(readCloudPerformanceSettings(cloud));

    if (!toyCloudState.locallyChanged.settingsSeen) {
      toyCloudState.settingsSeen =
        cloud[TOY_CLOUD_KEYS.settingsSeen] === '1';
    }
    if (!toyCloudState.locallyChanged.dingdong) {
      toyCloudState.newSeen.dingdong =
        cloud[TOY_CLOUD_KEYS.dingdongNewSeen] === '1';
    }
    if (!toyCloudState.locallyChanged.hajimi) {
      toyCloudState.newSeen.hajimi =
        cloud[TOY_CLOUD_KEYS.hajimiNewSeen] === '1';
    }
  } catch (error) {
    toyCloudState.cloudReadable = false;
    resetPerformanceSettingsToDefaults();
    console.warn('[大狗Tap] Toy 云状态读取失败。', error);
  }

  toyCloudState.initialized = true;
  renderToyCloudState();
  return toyCloudState;
}

function persistSeenState(items) {
  void toyStateReady.then(async (state) => {
    if (!state.environmentAvailable || !state.cloudReadable || !state.toy) return;

    try {
      await state.toy.setCloudStorage(items);
    } catch (error) {
      markToyCloudUnavailable(state);
      console.warn('[大狗Tap] 提醒状态写入失败。', error);
      showToyNotice(
        '状态保存失败，请确认已登录哔哩哔哩后刷新重试。',
        true
      );
    }
  });
}

function markSettingsSeen() {
  if (toyCloudState.settingsSeen) return;
  toyCloudState.settingsSeen = true;
  toyCloudState.locallyChanged.settingsSeen = true;
  renderToyCloudState();
  persistSeenState({ [TOY_CLOUD_KEYS.settingsSeen]: '1' });
}

function markSfxNewSeen(sfxId) {
  if (!VIDEO_UNLOCK_ITEM_IDS.has(sfxId) || toyCloudState.newSeen[sfxId]) return;
  toyCloudState.newSeen[sfxId] = true;
  toyCloudState.locallyChanged[sfxId] = true;
  renderToyCloudState();
  const key = sfxId === 'dingdong'
    ? TOY_CLOUD_KEYS.dingdongNewSeen
    : TOY_CLOUD_KEYS.hajimiNewSeen;
  persistSeenState({ [key]: '1' });
}

function markAllSfxNewSeen() {
  const items = {};
  for (const sfxId of VIDEO_UNLOCK_ITEM_IDS) {
    if (toyCloudState.newSeen[sfxId]) continue;
    toyCloudState.newSeen[sfxId] = true;
    toyCloudState.locallyChanged[sfxId] = true;
    const key = sfxId === 'dingdong'
      ? TOY_CLOUD_KEYS.dingdongNewSeen
      : TOY_CLOUD_KEYS.hajimiNewSeen;
    items[key] = '1';
  }

  if (Object.keys(items).length === 0) return;
  renderToyCloudState();
  persistSeenState(items);
}

function openUnlockConfirm() { /* 已禁用：不再有锁定项 */ }
function closeUnlockConfirm(restoreFocus = true) { /* 已禁用 */ }
function setUnlockConfirmPending(pending) { /* 已禁用 */ }
async function confirmUnlockFromVideo() { /* 已禁用 */ }

function renderHajimiCharacterControl() {
  const option = sfxOptions.find((item) => item.dataset.sfx === 'hajimi');
  if (!option) return;

  const isSelected = selectedSfxId === 'hajimi';

  hajimiSkinSwitcher.classList.toggle('is-open', isSelected);
  hajimiSkinSwitcher.setAttribute('aria-hidden', String(!isSelected));
  for (const button of hajimiSkinOptions) {
    button.disabled = !isSelected;
  }

  hajimiSkinClassic.classList.toggle('is-active', !hajimiAnimationEnabled);
  hajimiSkinClassic.setAttribute('aria-checked', String(!hajimiAnimationEnabled));
  hajimiSkinEmperor.classList.toggle('is-active', hajimiAnimationEnabled);
  hajimiSkinEmperor.setAttribute('aria-checked', String(hajimiAnimationEnabled));
  hajimiSkinEmperor.classList.remove('is-locked');
  hajimiSkinEmperor.classList.toggle('is-new-hidden', toyCloudState.newSeen.hajimi);
  hajimiSkinEmperorHint.textContent = '已解锁';
  hajimiSkinEmperor.setAttribute('aria-label', '哈基米帝皇形象');

  hajimiOptionImage.src = isSelected && hajimiAnimationEnabled
    ? HAJIMI_ANIMATION_ICON_URL
    : HAJIMI_STATIC_ICON_URL;

  const label = isSelected ? '哈基米音效已启用' : '哈基米';
  option.setAttribute('aria-label', label);
  option.title = label;
}

function getAudioBeatPosition() {
  return started && ctx && startTime > 0 && ctx.currentTime >= startTime
    ? (ctx.currentTime - startTime) / SPB
    : null;
}

function alignHajimiAnimationToBeat() {
  const beatPosition = getAudioBeatPosition();
  hajimiAnimationEpochBeat = Number.isFinite(beatPosition)
    ? Math.ceil(beatPosition - 0.03)
    : 0;
  hajimiAnimationFrame = -1;
}

function renderHajimiAnimationFrame(beatPosition) {
  if (!hajimiAnimationReady) return;
  const relativeBeat = Number.isFinite(beatPosition)
    ? beatPosition - hajimiAnimationEpochBeat
    : 0;
  const loopBeat = relativeBeat > 0
    ? relativeBeat % HAJIMI_ANIMATION_BEATS
    : 0;
  const frameIndex = Math.min(
    HAJIMI_ANIMATION_FRAME_COUNT - 1,
    Math.floor(loopBeat * HAJIMI_FRAMES_PER_BEAT)
  );
  if (frameIndex === hajimiAnimationFrame) return;
  hajimiAnimationFrame = frameIndex;

  const sourceX =
    (frameIndex % HAJIMI_ATLAS_COLUMNS) * HAJIMI_ATLAS_FRAME_WIDTH;
  const sourceY =
    Math.floor(frameIndex / HAJIMI_ATLAS_COLUMNS) * HAJIMI_ATLAS_FRAME_HEIGHT;
  dogAnimation2d.clearRect(
    0,
    0,
    HAJIMI_ATLAS_FRAME_WIDTH,
    HAJIMI_ATLAS_FRAME_HEIGHT
  );
  dogAnimation2d.drawImage(
    dogAnimationAtlas,
    sourceX,
    sourceY,
    HAJIMI_ATLAS_FRAME_WIDTH,
    HAJIMI_ATLAS_FRAME_HEIGHT,
    0,
    0,
    HAJIMI_ATLAS_FRAME_WIDTH,
    HAJIMI_ATLAS_FRAME_HEIGHT
  );
}

function applyHajimiAnimationVisibility() {
  const showAnimation =
    selectedSfxId === 'hajimi' &&
    hajimiAnimationEnabled &&
    hajimiAnimationReady;
  dogInner.classList.toggle('is-hajimi-animation', showAnimation);
  dogAnimationCanvas.setAttribute('aria-hidden', String(!showAnimation));
  if (showAnimation) renderHajimiAnimationFrame(getAudioBeatPosition());
  const characterImages = CHARACTER_IMAGE_SETS[selectedSfxId]
    ?? CHARACTER_IMAGE_SETS.dagou;
  dogCloseImage.alt = showAnimation ? '' : characterImages.alt;
  renderHajimiCharacterControl();
}

function ensureHajimiAnimationLoaded() {
  if (hajimiAnimationReady || hajimiAnimationRequested) return;
  hajimiAnimationRequested = true;
  dogAnimationAtlas.src = HAJIMI_ATLAS_URL;
}

function setHajimiSkin(useEmperor) {
  if (selectedSfxId !== 'hajimi') return;
  if (useEmperor === hajimiAnimationEnabled) return;
  hajimiAnimationEnabled = useEmperor;
  if (useEmperor) {
    alignHajimiAnimationToBeat();
    ensureHajimiAnimationLoaded();
    if (!hajimiAnimationReady) showToyNotice('正在加载东海帝皇动画…');
  }
  applyHajimiAnimationVisibility();
}

function selectSfxOption(option) {
  selectedSfxId = SFX_SAMPLE_SETS[option.dataset.sfx]
    ? option.dataset.sfx
    : 'hajimi';
  hajimiAnimationEnabled = false;
  const characterImages = CHARACTER_IMAGE_SETS[selectedSfxId]
    ?? CHARACTER_IMAGE_SETS.dagou;
  dogCloseImage.src = characterImages.close;
  dogCloseImage.alt = characterImages.alt;
  dogOpenImage.src = characterImages.open;
  dogInner.classList.toggle('is-hajimi', selectedSfxId === 'hajimi');
  for (const other of sfxOptions) {
    const selected = other === option;
    other.classList.toggle('is-active', selected);
    other.setAttribute('aria-checked', String(selected));
  }
  applyHajimiAnimationVisibility();
}

async function handleSfxOptionClick(option) {
  selectSfxOption(option);
}

async function handleSkinOptionClick(button) {
  if (selectedSfxId !== 'hajimi') return;
  setHajimiSkin(button.dataset.skin === 'emperor');
}

function resolveSfxSample(sample, sfxId = selectedSfxId) {
  return SFX_SAMPLE_SETS[sfxId]?.[sample] ?? sample;
}

renderToyCloudState();
const toyStateReady = initializeToyCloudState();

dogAnimationAtlas.addEventListener('load', () => {
  hajimiAnimationReady = true;
  if (hajimiAnimationEnabled) alignHajimiAnimationToBeat();
  applyHajimiAnimationVisibility();
});
dogAnimationAtlas.addEventListener('error', () => {
  const wasWaitingForAnimation = hajimiAnimationEnabled;
  hajimiAnimationEnabled = false;
  hajimiAnimationReady = false;
  hajimiAnimationRequested = false;
  dogAnimationAtlas.removeAttribute('src');
  applyHajimiAnimationVisibility();
  if (wasWaitingForAnimation) {
    showToyNotice('东海帝皇动画加载失败，请稍后重试。', true);
  }
});

async function handlePerformanceSettingClick(button) {
  if (performanceSettingsSaving) return;
  const settingName = button.dataset.setting;
  const cloudKey = PERFORMANCE_SETTING_KEYS[settingName];
  if (!cloudKey) return;

  const state = await toyStateReady;
  const nextValue = !performanceSettings[settingName];
  if (!state.environmentAvailable || !state.cloudReadable || !state.toy) {
    replacePerformanceSettings({
      ...performanceSettings,
      [settingName]: nextValue,
    });
    renderToyCloudState();
    showToyNotice('云存储不可用，本次设置仅在当前页面有效。');
    return;
  }

  performanceSettingsSaving = true;
  renderPerformanceSettings();
  try {
    await state.toy.setCloudStorage({
      [cloudKey]: nextValue ? '1' : '0',
    });
    replacePerformanceSettings({
      ...performanceSettings,
      [settingName]: nextValue,
    });
  } catch (error) {
    markToyCloudUnavailable(state);
    replacePerformanceSettings({
      ...performanceSettings,
      [settingName]: nextValue,
    });
    console.warn('[大狗Tap] 演奏设置写入失败。', error);
    showToyNotice('云存储不可用，本次设置仅在当前页面有效。');
  } finally {
    performanceSettingsSaving = false;
    renderToyCloudState();
  }
}

for (const button of performanceSettingButtons) {
  button.addEventListener('click', () => {
    void handlePerformanceSettingClick(button);
  });
}

async function flushPianoOctaveCloudWrite() {
  const state = await toyStateReady;
  if (!state.environmentAvailable || !state.cloudReadable || !state.toy) {
    pendingPianoOctaveCloudValue = null;
    pianoOctaveCloudWriteRunning = false;
    return;
  }

  while (pendingPianoOctaveCloudValue !== null) {
    const octave = pendingPianoOctaveCloudValue;
    pendingPianoOctaveCloudValue = null;
    try {
      await state.toy.setCloudStorage({
        [TOY_CLOUD_KEYS.pianoOctaveStart]: String(octave),
      });
    } catch (error) {
      pendingPianoOctaveCloudValue = null;
      markToyCloudUnavailable(state);
      console.warn('[大狗Tap] 八度档位写入失败。', error);
      showToyNotice('云存储不可用，本次八度仅在当前页面有效。');
      break;
    }
  }

  pianoOctaveCloudWriteRunning = false;
  renderToyCloudState();
}

function queuePianoOctaveCloudWrite(octave) {
  pendingPianoOctaveCloudValue = normalizePianoOctaveStart(octave);
  if (pianoOctaveCloudWriteRunning) return;
  pianoOctaveCloudWriteRunning = true;
  void flushPianoOctaveCloudWrite();
}

function shiftPianoOctave(direction) {
  if (!octaveControlsEnabled()) return false;
  const currentOctave = normalizePianoOctaveStart(
    performanceSettings.pianoOctaveStart,
  );
  const targetOctave = currentOctave + direction;
  if (targetOctave < PIANO_OCTAVE_MIN || targetOctave > PIANO_OCTAVE_MAX) {
    renderOctaveControls();
    return true;
  }

  const previousSettings = { ...performanceSettings };
  performanceSettings.pianoOctaveStart = targetOctave;
  applyPerformanceSettings(previousSettings);
  renderToyCloudState();
  queuePianoOctaveCloudWrite(targetOctave);
  return true;
}

for (const [button, direction] of [
  [octaveDownButton, -1],
  [octaveUpButton, 1],
]) {
  button.addEventListener('pointerdown', event => event.stopPropagation());
  button.addEventListener('click', event => {
    event.stopPropagation();
    shiftPianoOctave(direction);
  });
}

function openSettings() {
  if (settingsOpen) return;
  markSettingsSeen();
  settingsOpen = true;
  settingsOverlay.inert = false;
  settingsOverlay.classList.add('is-open');
  settingsOverlay.setAttribute('aria-hidden', 'false');
  settingsClose.focus({ preventScroll: true });
}

function closeSettings() {
  if (!settingsOpen) return;
  if (unlockConfirmOpen) closeUnlockConfirm(false);
  markAllSfxNewSeen();
  settingsOpen = false;
  settingsOverlay.inert = true;
  settingsOverlay.classList.remove('is-open');
  settingsOverlay.setAttribute('aria-hidden', 'true');
  settingsButton.focus({ preventScroll: true });
}

settingsButton.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('pointerdown', (event) => {
  if (event.target === settingsOverlay) closeSettings();
});
for (const eventName of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
  settingsOverlay.addEventListener(eventName, (event) => event.stopPropagation());
}
settingsPanel.addEventListener('click', (event) => event.stopPropagation());
unlockConfirmCancel.addEventListener('click', () => closeUnlockConfirm());
unlockConfirmSubmit.addEventListener('click', () => {
  void confirmUnlockFromVideo();
});
unlockConfirmOverlay.addEventListener('pointerdown', (event) => {
  if (event.target === unlockConfirmOverlay) closeUnlockConfirm();
});
for (const eventName of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
  unlockConfirmOverlay.addEventListener(eventName, (event) => event.stopPropagation());
}
unlockConfirmDialog.addEventListener('click', (event) => event.stopPropagation());
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (unlockConfirmOpen) closeUnlockConfirm();
  else closeSettings();
});

for (const option of sfxOptions) {
  option.addEventListener('click', () => {
    void handleSfxOptionClick(option);
  });
}
for (const button of hajimiSkinOptions) {
  button.addEventListener('click', () => {
    void handleSkinOptionClick(button);
  });
}

document.addEventListener(
  'pointerdown',
  (event) => {
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest('#music-toggle, #sfx-toggle')
    ) {
      return;
    }
    restoreAfterNavigation();
  },
  { capture: true }
);

/* ---------- 和弦走向：C - G - Am - F ---------- */
const CHORDS = [
  { bass: 65.41, notes: [261.63, 329.63, 392.00, 523.25] },
  { bass: 49.00, notes: [196.00, 246.94, 293.66, 392.00] },
  { bass: 55.00, notes: [220.00, 261.63, 329.63, 440.00] },
  { bass: 43.65, notes: [174.61, 220.00, 261.63, 349.23] },
];
const HAT_VEL = [0.34, 0.16, 0.42, 0.16];

const BARK_SOURCE_MIDI = Object.freeze({
  da: 71.1950846771,
  gou: 65.5950930881,
  jiao: 71.1226079346,
  ha: 72.6652936920031,
  ji: 67.55506219280217,
  mi: 65.47641325112846,
  dingdongji_ding: 68.72369809072657,
  dingdongji_dong: 68.20736701647688,
  dingdongji_ji: 69.48535473104747,
});

const BARK_NORMAL_SOURCE_MIDI = Object.freeze({
  ha: 72.732,
});

const BARK_PIANO_SOURCE_MIDI = Object.freeze({
  mi: Object.freeze({
    5: 65.60141325112846,
    6: 65.17172575112846,
  }),
  dingdongji_ding: Object.freeze({
    3: 68.49322934072657,
    6: 68.86822934072657,
  }),
  dingdongji_ji: Object.freeze({
    6: 69.64941723104747,
  }),
});

const BARK_TARGET_MIDI = Object.freeze({
  da: Object.freeze([79, 76, 72, 69]),
  gou: Object.freeze([72, 69, 67, 64]),
  jiao: Object.freeze([79, 76, 72, 69]),
  ha: Object.freeze([81, 79, 76, 72]),
  ji: Object.freeze([74, 72, 69, 67]),
  mi: Object.freeze([72, 69, 67, 64]),
  dingdongji_ding: Object.freeze([74, 72, 69, 67]),
  dingdongji_dong: Object.freeze([74, 72, 69, 67]),
  dingdongji_ji: Object.freeze([74, 72, 69, 67]),
});

const SFX_SAMPLE_GAIN = Object.freeze({
  da: 1.0000000000,
  gou: 1.012898017161218,
  jiao: 0.953577156471302,
  ha: 1.283378415934229,
  ji: 1.4777851484035351,
  mi: 1.4846115949156913,
  dingdongji_ding: 2.5889190244772604,
  dingdongji_dong: 2.3637451111911507,
  dingdongji_ji: 2.3501763429894065,
});

const PIANO_SCALE_INTERVALS = Object.freeze([0, 2, 4, 5, 7, 9, 11, 12]);
const PIANO_SCALE_NOTES = Object.freeze(['C', 'D', 'E', 'F', 'G', 'A', 'B', 'C']);
const PIANO_SCALE_SOLFEGE = Object.freeze(['do', 're', 'mi', 'fa', 'sol', 'la', 'si', 'do']);

function buildPianoScale(octaveStart = PIANO_DEFAULT_OCTAVE_START) {
  const octave = normalizePianoOctaveStart(octaveStart);
  const baseMidi = (octave + 1) * 12;
  return PIANO_SCALE_INTERVALS.map((interval, index) => Object.freeze({
    midi: baseMidi + interval,
    note: `${PIANO_SCALE_NOTES[index]}${index === 7 ? octave + 1 : octave}`,
    solfege: PIANO_SCALE_SOLFEGE[index],
  }));
}
const PIANO_KEYBOARD_ROWS = Object.freeze([
  Object.freeze(['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI']),
  Object.freeze(['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK']),
  Object.freeze(['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma']),
]);
const PIANO_KEYBOARD_SAMPLES = Object.freeze(['da', 'gou', 'jiao']);

const C = {
  cream: '#fff2dc',
  amber: '#ffb400',
  gray:  '#87837e',
  coral: '#ff5a5f',
  teal:  '#16c2a3',
  blue:  '#3e7bfa',
};
const ACCENTS = [C.coral, C.teal, C.blue];

function pickColor(rng) {
  const r = rng();
  if (r < 0.62) return C.amber;
  if (r < 0.9) return C.gray;
  return ACCENTS[(rng() * ACCENTS.length) | 0];
}

const EFFECTS = [
  'rings', 'poly', 'spiral', 'rays', 'confetti', 'zigzag',
  'pop', 'cross', 'orbit', 'wave', 'stars', 'grid',
];

function initAudio() {
  ctx = new (window.AudioContext || window.webkitAudioContext)();

  master = ctx.createGain();
  master.gain.value = navigationMuted ? 0 : MASTER_GAIN;
  bgmBus = ctx.createGain();
  bgmBus.gain.value = bgmMuted ? 0 : 1;
  sfxBus = ctx.createGain();
  sfxBus.gain.value = sfxMuted ? 0 : 1;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 24;
  comp.ratio.value = 5;
  comp.attack.value = 0.004;
  comp.release.value = 0.18;

  bgmBus.connect(master);
  sfxBus.connect(master);
  master.connect(comp);
  comp.connect(ctx.destination);

  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

function b64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function loadSamples() {
  for (const n of RUNTIME_SAMPLE_NAMES) {
    const encoded = AUDIO_B64[n];
    if (typeof encoded !== 'string' || encoded.length === 0) {
      throw new Error(`Missing embedded audio sample: ${n}`);
    }
    buffers[n] = await ctx.decodeAudioData(b64ToArrayBuffer(encoded));
    sustainLoops[n] = SUSTAIN_REGIONS[n]?.enabled
      ? buildSustainTexture(buffers[n], SUSTAIN_REGIONS[n])
      : null;
  }
}

function monoMix(source) {
  const mono = new Float32Array(source.length);
  for (let ch = 0; ch < source.numberOfChannels; ch++) {
    const data = source.getChannelData(ch);
    for (let i = 0; i < data.length; i++) mono[i] += data[i];
  }
  const scale = 1 / source.numberOfChannels;
  for (let i = 0; i < mono.length; i++) mono[i] *= scale;
  return mono;
}

function bestWsolaStart(
  input, output, outputStart, overlapFrames,
  regionMin, regionMax, target, searchFrames, previousStart
) {
  const candidateStep = 8;
  const compareStep = 4;
  const lo = Math.max(regionMin, target - searchFrames);
  const hi = Math.min(regionMax, target + searchFrames);
  let bestStart = Math.max(regionMin, Math.min(regionMax, target));
  let bestScore = -Infinity;

  for (let start = lo; start <= hi; start += candidateStep) {
    let dot = 0, energyOut = 0, energyIn = 0;
    for (let i = 0; i < overlapFrames; i += compareStep) {
      const a = output[outputStart + i];
      const b = input[start + i];
      dot += a * b;
      energyOut += a * a;
      energyIn += b * b;
    }

    if (energyOut < 1e-9 || energyIn < 1e-9) continue;
    let score = dot / Math.sqrt(energyOut * energyIn);

    const distance = Math.abs(start - previousStart);
    if (distance < overlapFrames * 0.18) score -= 0.06;
    score -= Math.abs(Math.log(Math.sqrt(energyIn / energyOut))) * 0.04;

    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  return bestStart;
}

function buildSustainTexture(source, region) {
  const sr = source.sampleRate;
  const regionMin = Math.max(0, Math.round(region.regionStart * sr));
  const regionEnd = Math.min(source.length, Math.round(region.regionEnd * sr));
  const frameFrames = Math.round(region.frame * sr);
  const overlapFrames = Math.round(region.overlap * sr);
  const hopFrames = frameFrames - overlapFrames;
  const searchFrames = Math.round(region.search * sr);
  const wrapFrames = Math.round(region.wrapBlend * sr);
  const regionMax = regionEnd - frameFrames;

  if (
    regionMin >= regionMax ||
    overlapFrames <= 1 ||
    hopFrames <= 1 ||
    wrapFrames >= frameFrames
  ) {
    throw new Error('Invalid sustain region');
  }

  const requestedFrames = Math.ceil(region.textureDuration * sr);
  const workingLength = requestedFrames + frameFrames + wrapFrames;
  const channels = Array.from(
    { length: source.numberOfChannels },
    () => new Float32Array(workingLength)
  );
  const inputMono = monoMix(source);
  const outputMono = new Float32Array(workingLength);
  const releaseFrames = [];

  const entryStart = regionMax;
  const firstStart = Math.max(regionMin, entryStart - overlapFrames);
  for (let ch = 0; ch < source.numberOfChannels; ch++) {
    channels[ch].set(
      source.getChannelData(ch).subarray(firstStart, firstStart + frameFrames),
      0
    );
  }
  outputMono.set(
    inputMono.subarray(firstStart, firstStart + frameFrames),
    0
  );

  let previousStart = firstStart;
  let lastFilled = frameFrames;
  for (
    let step = 1, outputStart = hopFrames;
    outputStart + frameFrames <= workingLength;
    step++, outputStart += hopFrames
  ) {
    let candidateStart;
    if (step === 1) {
      candidateStart = entryStart;
    } else {
      const golden = (region.seed + step * 0.618033988749895) % 1;
      let target = Math.round(regionMin + golden * (regionMax - regionMin));

      if (Math.abs(target - previousStart) < overlapFrames * 0.2) {
        const span = regionMax - regionMin;
        target = Math.round(
          regionMin + ((target - regionMin + span * 0.47) % span)
        );
      }

      candidateStart = bestWsolaStart(
        inputMono,
        outputMono,
        outputStart,
        overlapFrames,
        regionMin,
        regionMax,
        target,
        searchFrames,
        previousStart
      );
    }

    for (let i = 0; i < overlapFrames; i++) {
      const p = i / (overlapFrames - 1);
      const mix = 0.5 - 0.5 * Math.cos(Math.PI * p);
      outputMono[outputStart + i] =
        outputMono[outputStart + i] * (1 - mix) +
        inputMono[candidateStart + i] * mix;

      for (let ch = 0; ch < source.numberOfChannels; ch++) {
        const output = channels[ch];
        const input = source.getChannelData(ch);
        output[outputStart + i] =
          output[outputStart + i] * (1 - mix) +
          input[candidateStart + i] * mix;
      }
    }

    outputMono.set(
      inputMono.subarray(
        candidateStart + overlapFrames,
        candidateStart + frameFrames
      ),
      outputStart + overlapFrames
    );
    for (let ch = 0; ch < source.numberOfChannels; ch++) {
      channels[ch].set(
        source.getChannelData(ch).subarray(
          candidateStart + overlapFrames,
          candidateStart + frameFrames
        ),
        outputStart + overlapFrames
      );
    }

    releaseFrames.push({
      textureFrame: outputStart + overlapFrames,
      sourceFrame: candidateStart + overlapFrames,
    });
    previousStart = candidateStart;
    lastFilled = outputStart + frameFrames;
  }

  const textureFrames = lastFilled - wrapFrames;
  const loopBuffer = ctx.createBuffer(
    source.numberOfChannels,
    textureFrames,
    sr
  );
  for (let ch = 0; ch < source.numberOfChannels; ch++) {
    const input = channels[ch];
    const output = loopBuffer.getChannelData(ch);
    output.set(input.subarray(0, textureFrames));
    for (let i = 0; i < wrapFrames; i++) {
      const p = i / (wrapFrames - 1);
      const mix = 0.5 - 0.5 * Math.cos(Math.PI * p);
      const tail = input[textureFrames + i];
      const head = input[i];
      output[i] = tail * (1 - mix) + head * mix;
    }
  }

  const validReleaseFrames = releaseFrames.filter(
    point =>
      point.textureFrame >= wrapFrames &&
      point.textureFrame < textureFrames
  );
  if (wrapFrames < hopFrames) {
    validReleaseFrames.push({
      textureFrame: wrapFrames,
      sourceFrame: firstStart + wrapFrames,
    });
    validReleaseFrames.sort((a, b) => a.textureFrame - b.textureFrame);
  }
  const attackPoint = region.preferFrameEntry
    ? validReleaseFrames.find(point => point.textureFrame >= frameFrames)
    : validReleaseFrames[0];
  if (!attackPoint) throw new Error('Sustain texture has no release points');

  return {
    buffer: loopBuffer,
    attackOffset: attackPoint.textureFrame / sr,
    tailOffset: attackPoint.sourceFrame / sr,
    releasePoints: validReleaseFrames.map(point => ({
      textureOffset: point.textureFrame / sr,
      sourceOffset: point.sourceFrame / sr,
    })),
  };
}

function kick(t) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(160, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.11);
  g.gain.setValueAtTime(0.95, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
  o.connect(g); g.connect(bgmBus);
  o.start(t); o.stop(t + 0.26);
}

function snare(t, vol = 0.5) {
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.9;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
  n.connect(f); f.connect(g); g.connect(bgmBus);
  n.start(t); n.stop(t + 0.18);
  const o = ctx.createOscillator(); o.type = 'triangle';
  o.frequency.setValueAtTime(240, t);
  const g2 = ctx.createGain();
  g2.gain.setValueAtTime(vol * 0.5, t);
  g2.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  o.connect(g2); g2.connect(bgmBus);
  o.start(t); o.stop(t + 0.1);
}

function hat(t, vol, decay) {
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7500;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + decay);
  n.connect(f); f.connect(g); g.connect(bgmBus);
  n.start(t); n.stop(t + decay + 0.02);
}

function crash(t) {
  const n = ctx.createBufferSource(); n.buffer = noiseBuf; n.loop = true;
  const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 5000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.32, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
  n.connect(f); f.connect(g); g.connect(bgmBus);
  n.start(t); n.stop(t + 1.3);
}

function stab(t, freqs) {
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(2600, t);
  f.frequency.exponentialRampToValueAtTime(600, t + 0.28);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.14, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
  f.connect(g); g.connect(bgmBus);
  for (const fr of freqs) {
    for (const det of [-6, 5]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = fr;
      o.detune.value = det;
      o.connect(f);
      o.start(t); o.stop(t + 0.3);
    }
  }
}

function bass(t, fr, vol) {
  const o = ctx.createOscillator(); o.type = 'square';
  o.frequency.value = fr * 2;
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 300;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t + S8 * 0.9);
  o.connect(f); f.connect(g); g.connect(bgmBus);
  o.start(t); o.stop(t + S8);
}

function scheduleStep(s, t) {
  const bar = (s / 16) | 0;
  const pos = s % 16;
  const ch = CHORDS[bar];

  if (bar === 0 && pos === 0) crash(t);
  if (pos % 4 === 0) kick(t);
  if (pos === 4 || pos === 12) snare(t);
  if (bar === 3 && pos === 14) snare(t, 0.3);
  hat(t, HAT_VEL[pos % 4], pos === 14 ? 0.12 : 0.04);
  if (pos % 4 === 2) stab(t, ch.notes);
  if (pos % 2 === 0) bass(t, ch.bass, pos % 4 === 0 ? 0.4 : 0.26);
}

function scheduler() {
  const horizon = ctx.currentTime + INPUT_LOOKAHEAD;
  while (nextNoteTime < horizon) {
    scheduleStep(stepCount, nextNoteTime);
    nextNoteTime += S16;
    stepCount = (stepCount + 1) % 64;
  }
  scheduleQueuedInputs(ctx.currentTime + INPUT_QUEUE_LOOKAHEAD);
}

function quantize(unit) {
  const now = ctx.currentTime;
  const k = Math.ceil((now + 0.02 - startTime) / unit);
  let t = startTime + k * unit;
  if (t < now) t += unit;
  return t;
}

function barkPlaybackRate(sample, pitchTier, fixedTargetMidi, pianoOctaveStart) {
  const octaveReference = Number.isFinite(fixedTargetMidi)
    ? BARK_PIANO_SOURCE_MIDI[sample]?.[
        normalizePianoOctaveStart(pianoOctaveStart)
      ]
    : undefined;
  const sourceMidi = Number.isFinite(fixedTargetMidi)
    ? (octaveReference ?? BARK_SOURCE_MIDI[sample])
    : (BARK_NORMAL_SOURCE_MIDI[sample] ?? BARK_SOURCE_MIDI[sample]);
  const targetMidi = Number.isFinite(fixedTargetMidi)
    ? fixedTargetMidi
    : BARK_TARGET_MIDI[sample]?.[pitchTier];
  if (!Number.isFinite(sourceMidi) || !Number.isFinite(targetMidi)) {
    throw new Error(`No fixed pitch target for ${sample}, tier ${pitchTier}`);
  }
  return Math.pow(2, (targetMidi - sourceMidi) / 12);
}

function safeStop(source, when = ctx.currentTime) {
  if (!source) return;
  try { source.stop(when); } catch (_) { }
}

function cleanupVoice(voice) {
  if (!voice || voice.cleaned) return;
  voice.cleaned = true;
  clearTimeout(voice.cleanupTimer);
  liveVoices.delete(voice);

  if (activeSustainVoice === voice) activeSustainVoice = null;
  if (mouthVoice === voice) unlockMouth(voice, 0);

  for (const node of [
    voice.drySource, voice.dryGain,
    voice.loopSource, voice.loopGain,
    voice.tailSource, voice.tailGain,
  ]) {
    if (!node) continue;
    try { node.disconnect(); } catch (_) { }
  }
}

function createTailSource(voice, boundary, sourceOffset) {
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  source.buffer = voice.sourceBuffer;
  source.playbackRate.setValueAtTime(voice.rate, boundary);
  gain.gain.setValueAtTime(voice.sampleGain, boundary);
  source.connect(gain);
  gain.connect(sfxBus);
  source.start(boundary, sourceOffset);

  voice.tailSource = source;
  voice.tailGain = gain;
  voice.tailEndAt =
    boundary + (voice.sourceBuffer.duration - sourceOffset) / voice.rate;
  source.onended = () => cleanupVoice(voice);
}

function playPressVoice(name, rate, when) {
  const sourceBuffer = buffers[name];
  const sustain = sustainLoops[name];
  const sampleGain = SFX_SAMPLE_GAIN[name] ?? 1;

  if (!sustain) {
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = sourceBuffer;
    source.playbackRate.setValueAtTime(rate, when);
    gain.gain.setValueAtTime(sampleGain, when);
    source.connect(gain);
    gain.connect(sfxBus);
    source.onended = () => {
      try { source.disconnect(); } catch (_) { }
      try { gain.disconnect(); } catch (_) { }
    };
    source.start(when);
    return null;
  }

  const handoffAt = when + sustain.tailOffset / rate;

  const drySource = ctx.createBufferSource();
  const dryGain = ctx.createGain();
  drySource.buffer = sourceBuffer;
  drySource.playbackRate.setValueAtTime(rate, when);
  dryGain.gain.setValueAtTime(sampleGain, when);
  dryGain.gain.setValueAtTime(0, handoffAt);
  drySource.connect(dryGain);
  dryGain.connect(sfxBus);

  const loopSource = ctx.createBufferSource();
  const loopGain = ctx.createGain();
  loopSource.buffer = sustain.buffer;
  loopSource.loop = true;
  loopSource.playbackRate.setValueAtTime(rate, handoffAt);
  loopGain.gain.setValueAtTime(sampleGain, handoffAt);
  loopSource.connect(loopGain);
  loopGain.connect(sfxBus);

  const voice = {
    id: ++voiceSerial,
    name,
    rate,
    sampleGain,
    when,
    handoffAt,
    visualEndAt: when + 0.28,
    sourceBuffer,
    sustain,
    drySource,
    dryGain,
    loopSource,
    loopGain,
    tailSource: null,
    tailGain: null,
    tailEndAt: 0,
    rateTimeline: [{ time: handoffAt, rate }],
    held: true,
    claimed: false,
    released: false,
    stopped: false,
    cleaned: false,
    mode: 'pending',
    cleanupTimer: 0,
  };

  liveVoices.add(voice);
  drySource.onended = () => {
    if (voice.mode === 'short') cleanupVoice(voice);
  };

  drySource.start(when);
  loopSource.start(handoffAt, sustain.attackOffset);
  return voice;
}

function texturePositionAt(voice, now) {
  const start = voice.handoffAt;
  if (now <= start) return voice.sustain.attackOffset;

  let position = voice.sustain.attackOffset;
  let cursor = start;
  let rate = voice.rateTimeline[0].rate;
  for (let i = 1; i < voice.rateTimeline.length; i++) {
    const event = voice.rateTimeline[i];
    if (event.time >= now) break;
    position += (event.time - cursor) * rate;
    cursor = event.time;
    rate = event.rate;
  }
  return position + (now - cursor) * rate;
}

function textureRateAt(voice, now) {
  let rate = voice.rateTimeline[0].rate;
  for (let i = 1; i < voice.rateTimeline.length; i++) {
    const event = voice.rateTimeline[i];
    if (event.time > now) break;
    rate = event.rate;
  }
  return rate;
}

function isRetunableSustainVoice(voice) {
  return Boolean(
    voice &&
    (
      voice.name === 'jiao' ||
      voice.name === 'mi' ||
      voice.name === 'dingdongji_ji'
    ) &&
    voice.mode === 'sustain' &&
    voice.held &&
    !voice.released &&
    !voice.stopped &&
    !voice.cleaned
  );
}

function retuneSustainVoice(voice, rate, when = ctx.currentTime) {
  if (!isRetunableSustainVoice(voice)) return false;

  const now = ctx.currentTime;
  const changeAt = Math.max(now, voice.handoffAt, when);
  const playbackRate = voice.loopSource.playbackRate;
  playbackRate.cancelScheduledValues(changeAt);
  playbackRate.setValueAtTime(rate, changeAt);

  voice.rateTimeline = voice.rateTimeline.filter(event => event.time < changeAt);
  voice.rateTimeline.push({ time: changeAt, rate });
  voice.rate = rate;
  return true;
}

function nextTextureRelease(voice, now) {
  const sustain = voice.sustain;
  const duration = sustain.buffer.duration;
  const absolutePosition = texturePositionAt(voice, now);
  const rate = textureRateAt(voice, now);
  const minimumPosition =
    absolutePosition + RELEASE_SCHEDULE_LEAD * rate;
  let best = null;

  for (const point of sustain.releasePoints) {
    const turns = Math.max(
      0,
      Math.ceil((minimumPosition - point.textureOffset) / duration - 1e-7)
    );
    const targetPosition = point.textureOffset + turns * duration;
    if (!best || targetPosition < best.targetPosition) {
      best = { ...point, targetPosition };
    }
  }

  if (!best) throw new Error('Sustain texture has no release point');
  return {
    boundary: now + (best.targetPosition - absolutePosition) / rate,
    sourceOffset: best.sourceOffset,
  };
}

function claimSustainVoice(voice) {
  if (!voice || !voice.held || voice.released || voice.claimed) return;

  const previous = activeSustainVoice;
  if (previous && previous !== voice) releaseVoice(previous, true);

  voice.claimed = true;
  voice.mode = 'sustain';
  activeSustainVoice = voice;
  lockMouth(voice);
}

function updateSustainClaims(audioNow) {
  const due = [];
  for (const voice of liveVoices) {
    if (
      voice.held &&
      !voice.released &&
      !voice.claimed &&
      audioNow + SUSTAIN_CLAIM_LEAD >= voice.handoffAt
    ) {
      due.push(voice);
    }
  }

  due.sort((a, b) => a.id - b.id);
  for (const voice of due) claimSustainVoice(voice);
}

function releaseVoice(voice, musical = true) {
  if (!voice || voice.released || voice.stopped || voice.cleaned) return;

  const now = ctx.currentTime;
  voice.held = false;
  voice.released = true;

  if (activeSustainVoice === voice) activeSustainVoice = null;

  if (!musical) {
    forceStopVoice(voice);
    return;
  }

  if (now < voice.handoffAt) {
    voice.mode = 'short';
    voice.dryGain.gain.cancelScheduledValues(now);
    voice.dryGain.gain.setValueAtTime(voice.sampleGain, now);
    safeStop(voice.loopSource, now);

    if (mouthVoice === voice) {
      const remainMs = Math.max(0, (voice.visualEndAt - now) * 1000);
      unlockMouth(voice, remainMs);
    }
    return;
  }

  voice.mode = 'tail';
  const releaseRate = textureRateAt(voice, now);
  voice.loopSource.playbackRate.cancelScheduledValues(now);
  voice.loopSource.playbackRate.setValueAtTime(releaseRate, now);
  voice.rateTimeline = voice.rateTimeline.filter(event => event.time <= now);
  voice.rate = releaseRate;
  const release = nextTextureRelease(voice, now);

  voice.loopGain.gain.setValueAtTime(0, release.boundary);
  safeStop(voice.loopSource, release.boundary + 0.01);
  createTailSource(voice, release.boundary, release.sourceOffset);

  const remainMs = Math.max(0, (voice.tailEndAt - now) * 1000);
  if (mouthVoice === voice) unlockMouth(voice, remainMs);
  else openMouth(remainMs);
}

function fadeGain(gainNode, now, stopAt) {
  if (!gainNode) return;
  const param = gainNode.gain;
  const value = Math.max(0, param.value);
  param.cancelScheduledValues(now);
  param.setValueAtTime(value, now);
  param.linearRampToValueAtTime(0, stopAt);
}

function forceStopVoice(voice) {
  if (!voice || voice.stopped || voice.cleaned) return;

  const now = ctx.currentTime;
  const stopAt = now + EMERGENCY_FADE;
  voice.held = false;
  voice.released = true;
  voice.stopped = true;
  voice.mode = 'stopped';

  if (activeSustainVoice === voice) activeSustainVoice = null;
  fadeGain(voice.dryGain, now, stopAt);
  fadeGain(voice.loopGain, now, stopAt);
  fadeGain(voice.tailGain, now, stopAt);
  safeStop(voice.drySource, stopAt);
  safeStop(voice.loopSource, stopAt);
  safeStop(voice.tailSource, stopAt);

  if (mouthVoice === voice) unlockMouth(voice, EMERGENCY_FADE * 1000);
  voice.cleanupTimer = setTimeout(
    () => cleanupVoice(voice),
    (EMERGENCY_FADE + 0.05) * 1000
  );
}

function buildGrid() {
  const { width, height } = getStageMetrics();
  const landscape = width >= height;
  const pianoScale = performanceSettings.pianoMode
    ? buildPianoScale(effectivePianoOctaveStart())
    : null;
  cols = landscape ? (performanceSettings.pianoMode ? 8 : 4) : 3;
  rows = landscape ? 3 : (performanceSettings.pianoMode ? 8 : 4);

  zones = [];
  if (landscape) {
    const rowMap = [{ n: 'da', s: '大' }, { n: 'gou', s: '狗' }, { n: 'jiao', s: '叫' }];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const pianoKey = pianoScale?.[c] ?? null;
        zones.push({
          sample: rowMap[r].n,
          syllable: rowMap[r].s,
          pitchTier: c,
          targetMidi: pianoKey?.midi,
          pianoOctaveStart: pianoKey ? effectivePianoOctaveStart() : undefined,
          note: pianoKey?.note,
          solfege: pianoKey?.solfege,
        });
      }
    }
  } else {
    const colMap = [{ n: 'da', s: '大' }, { n: 'gou', s: '狗' }, { n: 'jiao', s: '叫' }];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const pianoIndex = performanceSettings.pianoMode
          ? pianoScale.length - 1 - r
          : r;
        const pianoKey = pianoScale?.[pianoIndex] ?? null;
        zones.push({
          sample: colMap[c].n,
          syllable: colMap[c].s,
          pitchTier: pianoIndex,
          targetMidi: pianoKey?.midi,
          pianoOctaveStart: pianoKey ? effectivePianoOctaveStart() : undefined,
          note: pianoKey?.note,
          solfege: pianoKey?.solfege,
        });
      }
    }
  }

  if (typeof renderKeyGrid === 'function') renderKeyGrid();
  if (typeof renderOctaveControls === 'function') renderOctaveControls();
}

function zoneIndex(x, y) {
  const { width, height, left, top } = getStageMetrics();
  const localX = x - left;
  const localY = y - top;
  const c = Math.min(cols - 1, Math.max(0, Math.floor(localX / width * cols)));
  const r = Math.min(rows - 1, Math.max(0, Math.floor(localY / height * rows)));
  return r * cols + c;
}

function pianoKeyboardBinding(code) {
  for (let rowIndex = 0; rowIndex < PIANO_KEYBOARD_ROWS.length; rowIndex++) {
    const pitchTier = PIANO_KEYBOARD_ROWS[rowIndex].indexOf(code);
    if (pitchTier >= 0) {
      return { sample: PIANO_KEYBOARD_SAMPLES[rowIndex], pitchTier };
    }
  }
  return null;
}

function pianoZoneIndexForCode(code) {
  if (!performanceSettings.pianoMode) return -1;
  const binding = pianoKeyboardBinding(code);
  if (!binding) return -1;
  return zones.findIndex(
    zone => zone.sample === binding.sample && zone.pitchTier === binding.pitchTier
  );
}

function zonesAlongSegment(x0, y0, x1, y1) {
  const { width, height, left, top } = getStageMetrics();
  const dx = x1 - x0;
  const dy = y1 - y0;
  const times = [0, 1];

  if (Math.abs(dx) > 1e-7) {
    for (let c = 1; c < cols; c++) {
      const t = (left + width * c / cols - x0) / dx;
      if (t > 0 && t < 1) times.push(t);
    }
  }
  if (Math.abs(dy) > 1e-7) {
    for (let r = 1; r < rows; r++) {
      const t = (top + height * r / rows - y0) / dy;
      if (t > 0 && t < 1) times.push(t);
    }
  }

  times.sort((a, b) => a - b);
  const uniqueTimes = times.filter(
    (t, i) => i === 0 || Math.abs(t - times[i - 1]) > 1e-7
  );
  const result = [];
  const appendAt = (t) => {
    const zi = zoneIndex(x0 + dx * t, y0 + dy * t);
    if (result[result.length - 1] !== zi) result.push(zi);
  };

  appendAt(0);
  for (let i = 1; i < uniqueTimes.length; i++) {
    appendAt((uniqueTimes[i - 1] + uniqueTimes[i]) / 2);
  }
  appendAt(1);
  return result;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const smooth = t => t * t * (3 - 2 * t);
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const easeOutBack = t => { const c = 1.70158, u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; };
const easeOutElastic = t =>
  t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1;

function tracePoly(g, x, y, r, sides, rot) {
  g.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = rot + (i * 2 * Math.PI) / sides;
    const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
    i ? g.lineTo(px, py) : g.moveTo(px, py);
  }
  g.closePath();
}

function traceStar(g, x, y, r, points, rot) {
  g.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const rr = i % 2 ? r * 0.46 : r;
    const a = rot + (i * Math.PI) / points;
    const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
    i ? g.lineTo(px, py) : g.moveTo(px, py);
  }
  g.closePath();
}

function drawPiece(g, kind, color, x, y, r, rot) {
  if (r <= 0) return;
  g.save();
  g.translate(x, y);
  g.rotate(rot || 0);
  switch (kind) {
    case 'circle':
      g.fillStyle = color;
      g.beginPath(); g.arc(0, 0, r, 0, 7); g.fill();
      break;
    case 'ring':
      g.strokeStyle = color;
      g.lineWidth = Math.max(2, r * 0.3);
      g.beginPath(); g.arc(0, 0, r, 0, 7); g.stroke();
      break;
    case 'square':
      g.fillStyle = color;
      g.fillRect(-r, -r, r * 2, r * 2);
      break;
    case 'triangle':
      g.fillStyle = color;
      tracePoly(g, 0, 0, r * 1.2, 3, -Math.PI / 2); g.fill();
      break;
    case 'diamond':
      g.fillStyle = color;
      tracePoly(g, 0, 0, r * 1.15, 4, 0); g.fill();
      break;
    case 'hexagon':
      g.fillStyle = color;
      tracePoly(g, 0, 0, r * 1.1, 6, 0); g.fill();
      break;
    case 'star':
      g.fillStyle = color;
      traceStar(g, 0, 0, r * 1.25, 5, -Math.PI / 2); g.fill();
      break;
    case 'cross': {
      g.fillStyle = color;
      const w = r * 0.62;
      g.fillRect(-r, -w / 2, r * 2, w);
      g.fillRect(-w / 2, -r, w, r * 2);
      break;
    }
  }
  g.restore();
}

const FX_IN = 0.55;
const FX_OUT = 0.4;

let fxW = 0, fxH = 0;
let fxList = [];
let beatP = 0;

function nowSec() { return ctx ? ctx.currentTime : performance.now() / 1000; }
const prog = (t, delay, dur = FX_IN) => clamp01((t - delay) / dur);
const cx0 = () => fxW / 2, cy0 = () => fxH / 2;

function getStageMetrics() {
  const rect = stage.getBoundingClientRect();
  return {
    width: Math.max(1, rect.width || stage.clientWidth || 1),
    height: Math.max(1, rect.height || stage.clientHeight || 1),
    left: rect.left,
    top: rect.top,
  };
}

function fxResize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const { width, height } = getStageMetrics();
  fxW = width;
  fxH = height;
  const sceneUnit = fxW >= fxH ? fxH / 2 : fxW / 1.5;
  stage.style.setProperty('--scene-unit', `${sceneUnit}px`);
  fxCanvas.width = Math.round(fxW * dpr);
  fxCanvas.height = Math.round(fxH * dpr);
  fxCanvas.style.width = fxW + 'px';
  fxCanvas.style.height = fxH + 'px';
  fx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const e of fxList) { e.cx = cx0(); e.cy = cy0(); }
}

const BUILD = {
  rings(inst, rng) {
    const minD = Math.min(fxW, fxH);
    for (let i = 0; i < 7; i++) inst.shapes.push({
      delay: i * 0.05,
      rEnd: minD * (0.13 + rng() * 0.29),
      w: 5 + rng() * 9,
      color: pickColor(rng),
    });
    inst.dotR = minD * 0.07;
  },
  poly(inst, rng) {
    const sides = 3 + (rng() * 5 | 0);
    const minD = Math.min(fxW, fxH);
    [[0.46, C.amber, 0], [0.3, C.gray, 0.09], [0.17, C.amber, 0.18]].forEach(([s, color, d], i) =>
      inst.shapes.push({
        sides, delay: d, color,
        rEnd: minD * s,
        w: minD * (0.034 - i * 0.007),
      }));
  },
  spiral(inst, rng) {
    const minD = Math.min(fxW, fxH);
    for (let i = 0; i < 36; i++) inst.shapes.push({
      ang: i * 0.55,
      rad: 6 + i * minD * 0.0125,
      size: minD * (0.009 + i * 0.0008),
      delay: i * 0.018,
      color: pickColor(rng),
    });
  },
  rays(inst, rng) {
    const minD = Math.min(fxW, fxH);
    const n = 13 + (rng() * 4 | 0);
    inst.r0 = minD * 0.06;
    for (let i = 0; i < n; i++) inst.shapes.push({
      ang: (i / n) * 2 * Math.PI + rng() * 0.15,
      w: 0.09 + rng() * 0.13,
      len: minD * (0.36 + rng() * 0.1),
      delay: rng() * 0.12,
      color: rng() < 0.12 ? ACCENTS[(rng() * 3) | 0] : (i % 2 ? C.gray : C.amber),
    });
  },
  confetti(inst, rng) {
    const maxD = Math.hypot(fxW, fxH);
    const minD = Math.min(fxW, fxH);
    const kinds = ['square', 'circle', 'triangle', 'diamond'];
    for (let i = 0; i < 30; i++) inst.shapes.push({
      ang: rng() * 2 * Math.PI,
      dist: maxD * (0.12 + rng() * 0.46),
      size: minD * (0.026 + rng() * 0.05),
      spin: inst.dir * (1 + rng() * 2) * 2.2,
      delay: rng() * 0.18,
      kind: kinds[(rng() * 4) | 0],
      color: pickColor(rng),
    });
  },
  zigzag(inst, rng) {
    const minD = Math.min(fxW, fxH);
    const horiz = rng() < 0.5;
    const n = 5 + (rng() * 3 | 0);
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      if (horiz) pts.push({
        x: -fxW * 0.08 + f * fxW * 1.16,
        y: fxH * (i % 2 ? 0.72 + rng() * 0.14 : 0.14 + rng() * 0.14),
      });
      else pts.push({
        x: fxW * (i % 2 ? 0.7 + rng() * 0.16 : 0.14 + rng() * 0.16),
        y: -fxH * 0.08 + f * fxH * 1.16,
      });
    }
    const lens = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      lens.push(l); total += l;
    }
    inst.shapes.push({ pts, lens, total, w: minD * (0.026 + rng() * 0.024), color: C.amber });
  },
  pop(inst, rng) {
    const minD = Math.min(fxW, fxH);
    const kinds = ['circle', 'square', 'ring', 'triangle', 'hexagon'];
    for (let i = 0; i < 16; i++) inst.shapes.push({
      x: fxW * (0.06 + rng() * 0.88),
      y: fxH * (0.06 + rng() * 0.88),
      size: minD * (0.036 + rng() * 0.06),
      delay: rng() * 0.28,
      rot: rng() * Math.PI,
      kind: kinds[(rng() * kinds.length) | 0],
      color: pickColor(rng),
    });
  },
  cross(inst, rng) {
    const minD = Math.min(fxW, fxH);
    const size = minD * (0.6 + rng() * 0.25);
    inst.shapes.push({
      size,
      w: size * (0.14 + rng() * 0.08),
      color: rng() < 0.2 ? ACCENTS[(rng() * 3) | 0] : C.amber,
    });
  },
  orbit(inst, rng) {
    const minD = Math.min(fxW, fxH);
    const kinds = ['circle', 'square', 'triangle', 'ring'];
    const n = 10;
    for (let i = 0; i < n; i++) inst.shapes.push({
      ang0: (i / n) * 2 * Math.PI,
      rad: minD * (0.18 + rng() * 0.24),
      speed: inst.dir * (0.45 + rng() * 0.5),
      size: minD * (0.026 + rng() * 0.032),
      delay: rng() * 0.15,
      kind: kinds[i % 4],
      color: pickColor(rng),
    });
    inst.coreR = minD * 0.055;
  },
  wave(inst, rng) {
    const minD = Math.min(fxW, fxH);
    for (let i = 0; i < 4; i++) inst.shapes.push({
      y0: fxH * (0.14 + i * 0.24) + (rng() - 0.5) * fxH * 0.08,
      amp: minD * (0.03 + rng() * 0.05),
      wl: fxW * (0.45 + rng() * 0.4),
      speed: inst.dir * (1 + rng() * 1.2),
      th: minD * (0.07 + rng() * 0.06),
      side: i % 2 ? 1 : -1,
      delay: i * 0.08,
      color: rng() < 0.12 ? ACCENTS[(rng() * 3) | 0] : (i % 2 ? C.gray : C.amber),
    });
  },
  stars(inst, rng) {
    const minD = Math.min(fxW, fxH);
    for (let i = 0; i < 12; i++) inst.shapes.push({
      x: fxW * (0.07 + rng() * 0.86),
      y: fxH * (0.07 + rng() * 0.86),
      r: minD * (0.034 + rng() * 0.055),
      delay: rng() * 0.25,
      rot: rng() * Math.PI,
      color: pickColor(rng),
    });
  },
  grid(inst, rng) {
    const minD = Math.min(fxW, fxH);
    const n = 11;
    const radius = minD * (0.4 + rng() * 0.04);
    const lines = [];
    for (let i = 0; i < n; i++) lines.push({
      y: (i - (n - 1) / 2) * (radius * 2 / n),
      w: 4.5 + ((i * 7) % 3) * 4,
      delay: i * 0.045,
      color: i % 2 ? C.gray : C.amber,
    });
    inst.shapes.push({ radius, lines });
  },
};

const DRAW = {
  rings(g, inst, t, fade) {
    const minD = Math.min(fxW, fxH);
    inst.shapes.forEach((s, i) => {
      const k = easeOutCubic(prog(t, s.delay));
      if (k <= 0) return;
      const r = k * s.rEnd * (1 + 0.04 * Math.sin(t * 1.4 + i)) + beatP * minD * 0.012;
      g.globalAlpha = (1 - k * 0.5) * fade;
      g.strokeStyle = s.color;
      g.lineWidth = s.w * (1 + beatP * 0.5);
      g.beginPath(); g.arc(inst.cx, inst.cy, r, 0, 7); g.stroke();
    });
    const dk = easeOutBack(prog(t, 0));
    if (dk > 0) {
      g.globalAlpha = fade;
      g.fillStyle = C.amber;
      g.beginPath(); g.arc(inst.cx, inst.cy, inst.dotR * dk * (1 + beatP * 0.2), 0, 7); g.fill();
    }
  },
  poly(g, inst, t, fade) {
    const minD = Math.min(fxW, fxH);
    inst.shapes.forEach((s, i) => {
      const k = easeOutCubic(prog(t, s.delay));
      if (k <= 0) return;
      const r = k * s.rEnd * (1 + beatP * 0.035 + 0.03 * Math.sin(t * 1.1 + i * 1.9));
      const rot = inst.rot0 + inst.dir * (1 - k) * 1.3 + t * 0.18 * inst.dir;
      g.globalAlpha = (1 - k * 0.3) * fade;
      g.strokeStyle = s.color;
      g.lineWidth = s.w * (1 + beatP * 0.4) + beatP * minD * 0.0015;
      tracePoly(g, inst.cx, inst.cy, r, s.sides, rot);
      g.stroke();
    });
  },
  spiral(g, inst, t, fade) {
    const rot = inst.rot0 + t * 0.45 * inst.dir + beatP * 0.05 * inst.dir;
    inst.shapes.forEach((s, i) => {
      const k = easeOutBack(prog(t, s.delay));
      if (k <= 0) return;
      const a = s.ang + rot;
      const r = s.rad * k * (1 + beatP * 0.04) + Math.sin(t * 1.5 + i * 0.5) * 4;
      const x = inst.cx + Math.cos(a) * r;
      const y = inst.cy + Math.sin(a) * r;
      const sz = s.size * k * (1 + beatP * 0.25);
      g.globalAlpha = fade;
      drawPiece(g, i % 6 === 5 ? 'square' : 'circle', s.color, x, y, sz, a);
    });
  },
  rays(g, inst, t, fade) {
    for (const s of inst.shapes) {
      const k = easeOutCubic(prog(t, s.delay, 0.5));
      if (k <= 0) continue;
      const rot = inst.rot0 + inst.dir * (1 - k) * 0.8 + t * 0.14 * inst.dir;
      const len = s.len * k * (1 + beatP * 0.09);
      const a = s.ang + rot;
      g.globalAlpha = 0.88 * fade;
      g.fillStyle = s.color;
      g.beginPath();
      g.moveTo(inst.cx, inst.cy);
      g.arc(inst.cx, inst.cy, inst.r0 + len, a - s.w, a + s.w);
      g.closePath(); g.fill();
    }
  },
  confetti(g, inst, t, fade) {
    inst.shapes.forEach((s, i) => {
      const k = easeOutBack(prog(t, s.delay));
      if (k <= 0) return;
      const x = inst.cx + Math.cos(s.ang) * s.dist * k * (1 + beatP * 0.025);
      const y = inst.cy + Math.sin(s.ang) * s.dist * k * (1 + beatP * 0.025)
        + Math.sin(t * 2.2 + i * 1.3) * 6;
      const sz = s.size * k * (1 + beatP * 0.18);
      const rot = s.spin * k + t * 0.6 * inst.dir;
      g.globalAlpha = fade;
      drawPiece(g, s.kind, s.color, x, y, sz, rot);
    });
  },
  zigzag(g, inst, t, fade) {
    const s = inst.shapes[0];
    const k = easeOutCubic(prog(t, 0, 0.6));
    if (k <= 0) return;
    g.save();
    g.translate(0, Math.sin(t * 1.6) * 7);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.save();
    g.translate(0, s.w * 2.1);
    g.globalAlpha = 0.4 * fade;
    g.strokeStyle = C.gray;
    g.lineWidth = s.w * (1 + beatP * 0.2);
    strokePartial(g, s.pts, s.lens, k * s.total);
    g.stroke();
    g.restore();
    g.globalAlpha = fade;
    g.strokeStyle = s.color;
    g.lineWidth = s.w * (1 + beatP * 0.3);
    const tip = strokePartial(g, s.pts, s.lens, k * s.total);
    g.stroke();
    g.fillStyle = C.gray;
    g.beginPath(); g.arc(tip.x, tip.y, s.w * (1.1 + beatP * 0.45), 0, 7); g.fill();
    g.restore();
  },
  pop(g, inst, t, fade) {
    inst.shapes.forEach((s, i) => {
      const k = easeOutBack(prog(t, s.delay));
      if (k <= 0) return;
      const y = s.y + Math.sin(t * 2 + i * 1.7) * 7;
      const sz = s.size * k * (1 + beatP * 0.2);
      g.globalAlpha = 0.96 * fade;
      drawPiece(g, s.kind, s.color, s.x, y, sz, s.rot + t * 0.4 * inst.dir + beatP * 0.08 * inst.dir);
    });
  },
  cross(g, inst, t, fade) {
    const s = inst.shapes[0];
    const k1 = easeOutBack(prog(t, 0));
    const k2 = easeOutBack(prog(t, 0.13));
    if (k1 <= 0) return;
    g.save();
    g.translate(inst.cx, inst.cy);
    g.rotate(inst.rot0 + inst.dir * (1 - k1) * 1.6 + Math.sin(t * 1.3) * 0.07 + beatP * 0.02 * inst.dir);
    const pulse = 1 + beatP * 0.12;
    g.scale(pulse, pulse);
    const L = s.size / 2, w = s.w / 2;
    g.globalAlpha = fade;
    g.fillStyle = s.color;
    g.fillRect(-L * k1, -w, L * 2 * k1, w * 2);
    if (k2 > 0) g.fillRect(-w, -L * k2, w * 2, L * 2 * k2);
    g.globalAlpha = 0.6 * fade;
    g.strokeStyle = C.gray;
    g.lineWidth = Math.max(2, s.w * 0.28);
    g.beginPath(); g.arc(0, 0, s.size * 0.68 * k1 * (1 + beatP * 0.08), 0, 7); g.stroke();
    g.restore();
  },
  orbit(g, inst, t, fade) {
    inst.shapes.forEach(s => {
      const k = easeOutCubic(prog(t, s.delay));
      if (k <= 0) return;
      const a = s.ang0 + t * s.speed + inst.dir * (1 - k) * 1.8;
      const R = s.rad * k * (1 + beatP * 0.09);
      const x = inst.cx + Math.cos(a) * R;
      const y = inst.cy + Math.sin(a) * R;
      g.globalAlpha = fade;
      drawPiece(g, s.kind, s.color, x, y, s.size * (0.6 + 0.4 * k) * (1 + beatP * 0.15), t * 1.2 * inst.dir);
    });
    const ck = easeOutBack(prog(t, 0));
    if (ck > 0) {
      g.globalAlpha = fade;
      drawPiece(g, 'circle', C.amber, inst.cx, inst.cy,
        inst.coreR * ck * (1 + beatP * 0.2), 0);
    }
  },
  wave(g, inst, t, fade) {
    const step = Math.max(14, fxW / 28);
    for (const s of inst.shapes) {
      const k = easeOutCubic(prog(t, s.delay, 0.6));
      if (k <= 0) continue;
      const off = (1 - k) * (fxW + 120) * s.side;
      const amp = s.amp * (0.6 + 0.4 * k) * (1 + beatP * 0.3);
      g.globalAlpha = 0.9 * fade;
      g.fillStyle = s.color;
      g.beginPath();
      for (let x = -60; x <= fxW + 60; x += step) {
        const y = s.y0 + Math.sin((x / s.wl) * Math.PI * 2 + t * s.speed) * amp;
        x === -60 ? g.moveTo(x + off, y) : g.lineTo(x + off, y);
      }
      for (let x = fxW + 60; x >= -60; x -= step) {
        const y = s.y0 + s.th * (1 + beatP * 0.12)
          + Math.sin((x / s.wl) * Math.PI * 2 + t * s.speed + 0.9) * amp;
        g.lineTo(x + off, y);
      }
      g.closePath(); g.fill();
    }
  },
  stars(g, inst, t, fade) {
    inst.shapes.forEach((s, i) => {
      const k = easeOutElastic(prog(t, s.delay));
      if (k <= 0) return;
      const tw = 1 + 0.15 * Math.sin(t * 3.2 + i * 2.1) + beatP * 0.18;
      g.globalAlpha = 0.97 * fade;
      drawPiece(g, 'star', s.color, s.x, s.y, s.r * k * tw, s.rot + t * 0.7 * inst.dir);
    });
  },
  grid(g, inst, t, fade) {
    const s = inst.shapes[0];
    const R = s.radius * (1 + beatP * 0.06 + 0.03 * Math.sin(t * 1.3));
    g.save();
    g.translate(inst.cx, inst.cy);
    g.rotate(inst.rot0 + t * 0.22 * inst.dir + beatP * 0.025 * inst.dir);
    g.beginPath(); g.arc(0, 0, R, 0, 7); g.clip();
    for (const ln of s.lines) {
      const k = easeOutCubic(prog(t, ln.delay));
      if (k <= 0) continue;
      g.globalAlpha = 0.92 * fade;
      g.strokeStyle = ln.color;
      g.lineWidth = ln.w * (1 + beatP * 0.35);
      g.beginPath();
      g.moveTo(-R * k, ln.y);
      g.lineTo(R * k, ln.y);
      g.stroke();
    }
    g.restore();
    const ok = easeOutBack(prog(t, 0));
    if (ok > 0) {
      g.globalAlpha = fade;
      g.strokeStyle = C.amber;
      g.lineWidth = 6 * (1 + beatP * 0.35);
      g.beginPath(); g.arc(inst.cx, inst.cy, R * ok, 0, 7); g.stroke();
    }
  },
};

function strokePartial(g, pts, lens, vis) {
  g.beginPath();
  g.moveTo(pts[0].x, pts[0].y);
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = lens[i - 1];
    if (acc + seg <= vis) {
      g.lineTo(pts[i].x, pts[i].y);
      acc += seg;
    } else {
      const f = seg > 0 ? (vis - acc) / seg : 0;
      const tx = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f;
      const ty = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f;
      g.lineTo(tx, ty);
      return { x: tx, y: ty };
    }
  }
  return pts[pts.length - 1];
}

function buildEffect(type) {
  const rng = mulberry32((Math.random() * 1e9) | 0);
  const inst = {
    type,
    cx: cx0(), cy: cy0(),
    t0: 0, state: 'in', outT0: 0,
    rot0: rng() * Math.PI * 2,
    dir: rng() < 0.5 ? -1 : 1,
    shapes: [],
  };
  BUILD[type](inst, rng);
  return inst;
}

function spawnEffect(zi, when) {
  const type = EFFECTS[zi % EFFECTS.length];
  const now = nowSec();

  for (const e of fxList) {
    if (e.state !== 'out') { e.state = 'out'; e.outT0 = now; }
  }
  while (fxList.length > 6) fxList.shift();

  const inst = buildEffect(type);
  inst.t0 = Math.min(when, now + 0.05);
  fxList.push(inst);
}

function fxFrame(now) {
  fx2d.clearRect(0, 0, fxW, fxH);

  for (let i = fxList.length - 1; i >= 0; i--) {
    const inst = fxList[i];
    let outK = 0;
    if (inst.state === 'out') {
      outK = clamp01((now - inst.outT0) / FX_OUT);
      if (outK >= 1) { fxList.splice(i, 1); continue; }
    }
    const t = now - inst.t0;
    if (t < 0) continue;

    const fade = 1 - smooth(outK);
    const sc = inst.state === 'out' ? 1 - 0.22 * outK : 1 + beatP * 0.02;
    fx2d.save();
    fx2d.translate(inst.cx, inst.cy);
    fx2d.scale(sc, sc);
    fx2d.translate(-inst.cx, -inst.cy);
    DRAW[inst.type](fx2d, inst, t, fade);
    fx2d.restore();
  }
}

function openMouth(holdMs) {
  mouthPopped = true;
  dogInner.classList.toggle('bark-image', !sfxMuted);
  clearTimeout(mouthTimer);
  mouthTimer = setTimeout(() => {
    if (!mouthVoice) {
      mouthPopped = false;
      dogInner.classList.remove('bark-image');
    }
  }, holdMs);
}

function lockMouth(voice) {
  mouthVoice = voice;
  clearTimeout(mouthTimer);
  mouthPopped = true;
  dogInner.classList.toggle('bark-image', !sfxMuted);
  holding = true;
}

function unlockMouth(voice, holdMs) {
  if (mouthVoice !== voice) return;
  mouthVoice = null;
  holding = false;
  openMouth(holdMs);
}

function flashZone(zi) {
  const r = (zi / cols) | 0, c = zi % cols;
  const el = document.createElement('div');
  el.className = 'zone-flash';
  el.style.left   = `calc(${c * 100 / cols}% + 3px)`;
  el.style.top    = `calc(${r * 100 / rows}% + 3px)`;
  el.style.width  = `calc(${100 / cols}% - 6px)`;
  el.style.height = `calc(${100 / rows}% - 6px)`;
  el.addEventListener('animationend', () => el.remove());
  flashLayer.appendChild(el);
}

function reflowQueuedInputTimes() {
  if (!performanceSettings.rhythmSnap) {
    const now = ctx?.currentTime ?? 0;
    for (const entry of inputQueue) entry.when = now;
    return;
  }

  let when = quantize(S8);
  if (Number.isFinite(lastCommittedInputTime)) {
    when = Math.max(when, lastCommittedInputTime + S8);
  }
  for (const entry of inputQueue) {
    entry.when = when;
    when += S8;
  }
}

function removeQueuedSample(sample) {
  if (!performanceSettings.rhythmSnap) return;
  for (let i = inputQueue.length - 1; i >= 0; i--) {
    const entry = inputQueue[i];
    if (entry.sample !== sample) continue;

    inputQueue.splice(i, 1);
    const state = pointers.get(entry.pointerId);
    if (state && state.pendingEntryId === entry.id) {
      state.pendingEntryId = null;
    }
  }
}

function enqueueActivation(zi, pointerId) {
  hideControlsUntilIdle();
  const z = zones[zi];
  removeQueuedSample(z.sample);
  const entry = {
    id: ++inputSerial,
    kind: 'press',
    pointerId,
    zone: zi,
    sample: z.sample,
    audioSample: resolveSfxSample(z.sample),
    pitchTier: z.pitchTier,
    targetMidi: z.targetMidi,
    pianoOctaveStart: z.pianoOctaveStart,
    when: 0,
  };
  inputQueue.push(entry);
  reflowQueuedInputTimes();
  flashZone(zi);
  return entry;
}

function enqueueSustainRetune(zi, pointerId, voice) {
  hideControlsUntilIdle();
  const z = zones[zi];
  removeQueuedSample(z.sample);
  const entry = {
    id: ++inputSerial,
    kind: 'sustain-retune',
    pointerId,
    zone: zi,
    sample: z.sample,
    audioSample: voice?.name ?? resolveSfxSample(z.sample),
    pitchTier: z.pitchTier,
    targetMidi: z.targetMidi,
    pianoOctaveStart: z.pianoOctaveStart,
    voice,
    when: 0,
  };
  inputQueue.push(entry);
  reflowQueuedInputTimes();
  flashZone(zi);
  return entry;
}

function commitUnsnappedInput(entry) {
  if (performanceSettings.rhythmSnap) return;
  const queuedIndex = inputQueue.indexOf(entry);
  if (queuedIndex >= 0) inputQueue.splice(queuedIndex, 1);
  entry.when = ctx.currentTime;
  lastCommittedInputTime = entry.when;
  playQueuedInput(entry);
}

function scheduleActivationVisual(zi, when) {
  const waitMs = Math.max(0, (when - ctx.currentTime) * 1000);
  const timer = setTimeout(() => {
    inputVisualTimers.delete(timer);
    openMouth(280);
    barkPopVel = Math.min(barkPopVel + BARK_KICK, BARK_KICK_MAX);
    spawnEffect(zi, ctx.currentTime);
  }, waitMs);
  inputVisualTimers.add(timer);
}

function playQueuedInput(entry) {
  const audioSample = entry.audioSample ?? resolveSfxSample(entry.sample);
  const rate = barkPlaybackRate(
    audioSample,
    entry.pitchTier,
    entry.targetMidi,
    entry.pianoOctaveStart,
  );
  if (entry.kind === 'sustain-retune') {
    if (retuneSustainVoice(entry.voice, rate, entry.when)) {
      scheduleActivationVisual(entry.zone, entry.when);
    }
    return;
  }

  const state = pointers.get(entry.pointerId);
  const stillHeld =
    state &&
    state.zone === entry.zone &&
    state.pendingEntryId === entry.id;
  const voice = playPressVoice(audioSample, rate, entry.when);

  if (stillHeld) {
    state.pendingEntryId = null;
    state.voice = voice;
  } else if (voice) {
    releaseVoice(voice, true);
  }
  scheduleActivationVisual(entry.zone, entry.when);
}

function scheduleQueuedInputs(horizon) {
  while (inputQueue.length && inputQueue[0].when < horizon) {
    const entry = inputQueue.shift();
    lastCommittedInputTime = entry.when;
    playQueuedInput(entry);
  }
}

function cancelQueuedInputs(pointerId) {
  for (let i = inputQueue.length - 1; i >= 0; i--) {
    if (inputQueue[i].pointerId === pointerId) inputQueue.splice(i, 1);
  }
  reflowQueuedInputTimes();
}

function clearInputVisualTimers() {
  for (const timer of inputVisualTimers) clearTimeout(timer);
  inputVisualTimers.clear();
}

function tick() {
  requestAnimationFrame(tick);
  const now = nowSec();
  const dt = Math.min(0.05, Math.max(0.001, now - lastTick));
  lastTick = now;
  const uiBeatPosition = getAudioBeatPosition();
  updateUiRhythm(uiBeatPosition);
  if (hajimiAnimationEnabled && hajimiAnimationReady) {
    renderHajimiAnimationFrame(uiBeatPosition);
  }

  if (started && ctx) {
    const t = ctx.currentTime;
    updateSustainClaims(t);
    const phase = (((t - startTime) / SPB) % 1 + 1) % 1;
    beatP = Math.pow(1 - phase, 2.4);

    const sway = Math.sin(((t - startTime) / (SPB * 2)) * Math.PI * 2);
    dogEl.style.transform =
      `translate(${(sway * 5).toFixed(2)}px, ${(-9 * beatP).toFixed(2)}px)` +
      ` rotate(${(sway * 2.4).toFixed(2)}deg)` +
      ` scale(${(1 + 0.06 * beatP).toFixed(4)}, ${(1 - 0.05 * beatP).toFixed(4)})`;
  }

  const popTarget = mouthPopped ? 1 : 0;
  barkPopVel += (popTarget - barkPop) * 320 * dt;
  barkPopVel *= Math.exp(-13 * dt);
  barkPopVel = Math.max(-10, Math.min(10, barkPopVel));
  barkPop += barkPopVel * dt;
  dogInner.style.transform =
    `scale(${(1 + 0.17 * barkPop).toFixed(4)}) rotate(${(-3.5 * barkPop).toFixed(2)}deg)`;

  const holdTarget = holding ? 1 : 0;
  const tau = holding ? 1.1 : 0.22;
  holdLevel += (holdTarget - holdLevel) * (1 - Math.exp(-dt / tau));

  const scaleTarget = 1 + 0.16 * holdLevel;
  jellyVel += (scaleTarget - jellyScale) * 55 * dt;
  jellyVel *= Math.exp(-7 * dt);
  jellyScale += jellyVel * dt;

  const amp = 6 * holdLevel;
  const jx = (Math.sin(now * 120) + Math.sin(now * 197 + 1.7) * 0.6) * amp * 0.55;
  const jy = (Math.cos(now * 128 + 0.6) + Math.sin(now * 233 + 3.1) * 0.6) * amp * 0.55;
  const jr = (Math.sin(now * 108 + 2.2) + Math.sin(now * 181) * 0.5) * 2.4 * holdLevel;
  dogJelly.style.transform =
    `translate(${jx.toFixed(2)}px, ${jy.toFixed(2)}px)` +
    ` rotate(${jr.toFixed(2)}deg) scale(${jellyScale.toFixed(4)})`;

  if (holdLevel > 0.004) {
    dogJelly.style.filter =
      `hue-rotate(${(-42 * holdLevel).toFixed(1)}deg)` +
      ` saturate(${(1 + 0.7 * holdLevel).toFixed(3)})` +
      ` brightness(${(1 + 0.04 * holdLevel).toFixed(3)})`;
  } else {
    dogJelly.style.filter = '';
  }

  fxFrame(now);
}

function retuneHeldJiao(pointerId, state, zi) {
  const z = zones[zi];
  if (!z || z.sample !== 'jiao' || !state.voice) return false;
  if (!isRetunableSustainVoice(state.voice)) return false;

  state.zone = zi;
  state.pendingEntryId = null;
  const entry = enqueueSustainRetune(zi, pointerId, state.voice);
  commitUnsnappedInput(entry);
  return true;
}

function enterZone(pointerId, state, zi) {
  if (zi === state.zone) return;
  if (retuneHeldJiao(pointerId, state, zi)) return;

  if (state.voice) {
    releaseVoice(state.voice, true);
    state.voice = null;
  }

  state.zone = zi;
  const entry = enqueueActivation(zi, pointerId);
  state.pendingEntryId = entry.id;
  commitUnsnappedInput(entry);
}

function createInputState(lastX = 0, lastY = 0) {
  return {
    zone: -1,
    voice: null,
    pendingEntryId: null,
    lastX,
    lastY,
  };
}

function beginZoneInput(inputId, zi, lastX = 0, lastY = 0) {
  const state = createInputState(lastX, lastY);
  pointers.set(inputId, state);
  enterZone(inputId, state, zi);
  return state;
}

function tryActivate(pointerId, x, y, state) {
  if (!state) {
    return beginZoneInput(pointerId, zoneIndex(x, y), x, y);
  }

  for (const zi of zonesAlongSegment(state.lastX, state.lastY, x, y)) {
    enterZone(pointerId, state, zi);
  }
  state.lastX = x;
  state.lastY = y;
  return state;
}

stage.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!started || !buffers.da) {
    pointers.set(e.pointerId, createInputState(e.clientX, e.clientY));
    hideControlsUntilIdle();
    start();
    return;
  }
  try { stage.setPointerCapture(e.pointerId); } catch (_) { }
  pointers.set(
    e.pointerId,
    tryActivate(e.pointerId, e.clientX, e.clientY, null)
  );
}, { passive: false });

stage.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  if (!started || !buffers.da) return;
  e.preventDefault();
  pointers.set(
    e.pointerId,
    tryActivate(
      e.pointerId,
      e.clientX,
      e.clientY,
      pointers.get(e.pointerId)
    )
  );
}, { passive: false });

function endInput(inputId, musical) {
  const state = pointers.get(inputId);
  if (state && state.voice) {
    if (musical) releaseVoice(state.voice, true);
    else forceStopVoice(state.voice);
  }
  if (!musical) cancelQueuedInputs(inputId);
  pointers.delete(inputId);
  if (pointers.size === 0) hideControlsUntilIdle();
}

function endPointer(e, musical) {
  endInput(e.pointerId, musical);
  try {
    if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
  } catch (_) { }
}

window.addEventListener('pointerup', (e) => endPointer(e, true));
window.addEventListener('pointercancel', (e) => endPointer(e, false));

function handlePianoKeyDown(event) {
  if (
    event.repeat ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    settingsOpen ||
    unlockConfirmOpen
  ) return;

  if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
    if (!octaveControlsEnabled()) return;
    event.preventDefault();
    shiftPianoOctave(event.code === 'ArrowLeft' ? -1 : 1);
    return;
  }

  const zi = pianoZoneIndexForCode(event.code);
  if (zi < 0) return;

  const inputId = `keyboard:${event.code}`;
  if (pointers.has(inputId)) return;
  event.preventDefault();

  if (!started || !buffers.da) {
    pointers.set(inputId, createInputState());
    hideControlsUntilIdle();
    start();
    return;
  }
  beginZoneInput(inputId, zi);
}

function handlePianoKeyUp(event) {
  if (!pianoKeyboardBinding(event.code)) return;
  const inputId = `keyboard:${event.code}`;
  if (!pointers.has(inputId)) return;
  event.preventDefault();
  endInput(inputId, true);
}

window.addEventListener('keydown', handlePianoKeyDown);
window.addEventListener('keyup', handlePianoKeyUp);
window.addEventListener('blur', () => {
  inputQueue.length = 0;
  clearInputVisualTimers();
  pointers.clear();
  for (const voice of [...liveVoices]) forceStopVoice(voice);
});

window.addEventListener('contextmenu', (e) => e.preventDefault());

async function start() {
  if (started) return;
  started = true;
  hideControlsUntilIdle();
  subEl.textContent = '加 载 中 …';

  initAudio();
  if (ctx.state === 'suspended') await ctx.resume();
  await loadSamples();

  startTime = ctx.currentTime + 0.12;
  nextNoteTime = startTime;
  lastCommittedInputTime = -Infinity;
  inputQueue.length = 0;
  stepCount = 0;
  setInterval(scheduler, 25);

  overlay.classList.add('hide');
}

let resizeTimer = 0;
function handleLayoutResize() {
  fxResize();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(buildGrid, 150);
}
window.addEventListener('resize', handleLayoutResize);
if (window.ResizeObserver) {
  const stageResizeObserver = new ResizeObserver(handleLayoutResize);
  stageResizeObserver.observe(stage);
}

buildGrid();
fxResize();
updateMuteButton(musicToggle, bgmMuted, '音乐');
updateMuteButton(sfxToggle, sfxMuted, '音效');
showControls();
requestAnimationFrame(tick);