// ============================================================
// Slop Watch Popup Script
// ============================================================
const defaults = {
  enabled: true,
  hideVideos: false,
  hideVideoThreshold: 75,
  hideChannels: false,
  hideChannelThreshold: 75,
};

/*
 * Element cache avoids repeated DOM queries during event handlers and state
 * updates. All UI state flows through these references.
 */
const els = {};

document.addEventListener("DOMContentLoaded", () => {
  els.masterToggle = document.getElementById("master-toggle");
  els.controls = document.getElementById("controls");
  els.hideVideos = document.getElementById("hide-videos");
  els.videoThreshold = document.getElementById("video-threshold");
  els.videoThresholdVal = document.getElementById("video-threshold-val");
  els.hideChannels = document.getElementById("hide-channels");
  els.channelThreshold = document.getElementById("channel-threshold");
  els.channelThresholdVal = document.getElementById("channel-threshold-val");
  els.toggleText = document.querySelector(".toggle__text");

  loadSettings();

  /*
   * Event listeners use save as a common handler for checkbox and select
   * changes. Input events on sliders update the display value without saving,
   * reducing disk I/O during drag operations. Change events persist the final value.
   */
  els.masterToggle.addEventListener("change", save);
  els.hideVideos.addEventListener("change", save);
  els.hideChannels.addEventListener("change", save);
  els.videoThreshold.addEventListener("input", () => {
    els.videoThresholdVal.textContent = els.videoThreshold.value + "%";
  });
  els.videoThreshold.addEventListener("change", save);
  els.channelThreshold.addEventListener("input", () => {
    els.channelThresholdVal.textContent = els.channelThreshold.value + "%";
  });
  els.channelThreshold.addEventListener("change", save);

  // Advanced Options toggle
  const advToggle = document.getElementById("advanced-toggle");
  const advPanel = document.getElementById("advanced-panel");
  advToggle.addEventListener("click", () => {
    advToggle.classList.toggle("advanced-toggle--open");
    advPanel.classList.toggle("advanced-panel--open");
  });

  // Leaderboard button
  document.getElementById("leaderboard-btn").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("leaderboard.html") });
  });
});

/*
 * Load settings from storage and merge with defaults. Spread defaults first
 * so undefined values fallback gracefully even if storage is corrupted or
 * incomplete.
 */
function loadSettings() {
  chrome.storage.local.get("slopwatch_settings", (data) => {
    const s = { ...defaults, ...(data.slopwatch_settings || {}) };
    applyToUI(s);
  });
}

/*
 * Single source of truth for syncing settings to DOM. All UI state changes
 * go through this function to ensure consistency. Called both on init
 * (loadSettings) and after state mutations (save).
 */
function applyToUI(s) {
  els.masterToggle.checked = s.enabled;
  els.hideVideos.checked = s.hideVideos;
  els.videoThreshold.value = s.hideVideoThreshold;
  els.videoThresholdVal.textContent = s.hideVideoThreshold + "%";
  els.hideChannels.checked = s.hideChannels;
  els.channelThreshold.value = s.hideChannelThreshold;
  els.channelThresholdVal.textContent = s.hideChannelThreshold + "%";
  updateDisabledState(s.enabled);
  updateSliderStates();
}

/*
 * Update disabled/enabled visual state and re-enable slider controls only if
 * the extension is enabled. When disabled, all controls are visually grayed out
 * regardless of their checked state, and slider row states are not recalculated.
 */
function updateDisabledState(enabled) {
  els.controls.classList.toggle("popup__controls--disabled", !enabled);
  els.toggleText.textContent = enabled ? "Enabled" : "Disabled";
  if (enabled) updateSliderStates();
}

/*
 * Show/hide individual slider rows based on their parent checkbox state.
 * Each row (video threshold, channel threshold) is only active if its
 * corresponding "hide X" checkbox is checked.
 */
function updateSliderStates() {
  const videoSliderRow = els.videoThreshold.closest(".slider-row");
  const channelSliderRow = els.channelThreshold.closest(".slider-row");
  videoSliderRow.classList.toggle(
    "slider-row--disabled",
    !els.hideVideos.checked,
  );
  channelSliderRow.classList.toggle(
    "slider-row--disabled",
    !els.hideChannels.checked,
  );
}

/*
 * Collect current UI state, persist to storage, and re-sync DOM to ensure
 * consistency. Intentionally re-applies UI state even though values should
 * match, to guard against manual DOM mutations or race conditions with
 * other popup instances.
 */
function save() {
  const s = {
    enabled: els.masterToggle.checked,
    hideVideos: els.hideVideos.checked,
    hideVideoThreshold: parseInt(els.videoThreshold.value, 10),
    hideChannels: els.hideChannels.checked,
    hideChannelThreshold: parseInt(els.channelThreshold.value, 10),
  };
  updateDisabledState(s.enabled);
  updateSliderStates();
  chrome.storage.local.set({ slopwatch_settings: s });
}
