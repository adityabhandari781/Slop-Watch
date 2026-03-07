// ============================================================
// Slop Watch — Popup Script
// ============================================================

const defaults = {
  enabled: true,
  hideVideos: false,
  hideVideoThreshold: 75,
  hideChannels: false,
  hideChannelThreshold: 75,
};

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

  // ── Event listeners ──
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
});

function loadSettings() {
  chrome.storage.local.get("slopwatch_settings", (data) => {
    const s = { ...defaults, ...(data.slopwatch_settings || {}) };
    applyToUI(s);
  });
}

function applyToUI(s) {
  els.masterToggle.checked = s.enabled;
  els.hideVideos.checked = s.hideVideos;
  els.videoThreshold.value = s.hideVideoThreshold;
  els.videoThresholdVal.textContent = s.hideVideoThreshold + "%";
  els.hideChannels.checked = s.hideChannels;
  els.channelThreshold.value = s.hideChannelThreshold;
  els.channelThresholdVal.textContent = s.hideChannelThreshold + "%";
  updateDisabledState(s.enabled);
}

function updateDisabledState(enabled) {
  els.controls.classList.toggle("popup__controls--disabled", !enabled);
  els.toggleText.textContent = enabled ? "Enabled" : "Disabled";
}

function save() {
  const s = {
    enabled: els.masterToggle.checked,
    hideVideos: els.hideVideos.checked,
    hideVideoThreshold: parseInt(els.videoThreshold.value, 10),
    hideChannels: els.hideChannels.checked,
    hideChannelThreshold: parseInt(els.channelThreshold.value, 10),
  };
  updateDisabledState(s.enabled);
  chrome.storage.local.set({ slopwatch_settings: s });
}
