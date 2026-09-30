// Plain script (no bundler, no imports) - runs in the Settings window with
// contextIsolation on and nodeIntegration off, talking to main.ts only
// through the `settingsApi` object preload.cjs exposes via contextBridge.
// main.ts is the single source of truth for both the size-preset list and
// the current values - this file just renders whatever it's given and
// reports changes back, so it never needs updating if a preset is added,
// renamed, or its dimensions change.

const sizeOptionsEl = document.getElementById("size-options");
const cardSizeOptionsEl = document.getElementById("card-size-options");
const opacitySlider = document.getElementById("opacity-slider");
const opacityValueEl = document.getElementById("opacity-value");
const statusEl = document.getElementById("status");
// Milestone 15: the "Updates" section.
const autoUpdateCheckbox = document.getElementById("auto-update-checkbox");
const checkUpdatesBtn = document.getElementById("check-updates-btn");
const updateStatusEl = document.getElementById("update-status");
const appVersionLineEl = document.getElementById("app-version-line");
// Milestone 18: the "Locations" section.
const logPathStatusEl = document.getElementById("log-path-status");
const chooseLogPathBtn = document.getElementById("choose-log-path-btn");
const resetLogPathBtn = document.getElementById("reset-log-path-btn");
const cardDbPathStatusEl = document.getElementById("card-db-path-status");
const chooseCardDbPathBtn = document.getElementById("choose-card-db-path-btn");
const resetCardDbPathBtn = document.getElementById("reset-card-db-path-btn");

function showStatus(text) {
  statusEl.textContent = text;
  if (text) {
    setTimeout(() => {
      if (statusEl.textContent === text) statusEl.textContent = "";
    }, 2000);
  }
}

// Milestone 13: shared by the overlay-size group and the new card-size
// group below - each gets its own radio `name` (from the container's id) so
// the two groups never interfere with each other, and its own onChange
// callback so each posts to the right IPC handler.
function renderRadioOptions(containerEl, presets, currentPreset, onChange, errorMessage) {
  containerEl.innerHTML = "";
  for (const preset of presets) {
    const label = document.createElement("label");
    label.className = "size-option";

    const input = document.createElement("input");
    input.type = "radio";
    input.name = containerEl.id;
    input.value = preset.key;
    input.checked = preset.key === currentPreset;
    input.addEventListener("change", async () => {
      const result = await onChange(preset.key);
      if (!result || !result.ok) {
        showStatus((result && result.reason) || errorMessage);
      }
    });

    const text = document.createElement("span");
    text.textContent = preset.label;

    label.appendChild(input);
    label.appendChild(text);
    containerEl.appendChild(label);
  }
}

function renderSizeOptions(presets, currentPreset) {
  renderRadioOptions(sizeOptionsEl, presets, currentPreset, (key) => window.settingsApi.setSizePreset(key), "Could not change the overlay size.");
}

function renderCardSizeOptions(presets, currentPreset) {
  renderRadioOptions(
    cardSizeOptionsEl,
    presets,
    currentPreset,
    (key) => window.settingsApi.setCardSizePreset(key),
    "Could not change the card size.",
  );
}

function setOpacitySlider(opacity) {
  const pct = Math.round(opacity * 100);
  opacitySlider.value = String(pct);
  opacityValueEl.textContent = `${pct}%`;
}

// Live-updates the % readout while dragging, then commits to main.ts (and
// the actual overlay) on release/change - so the number tracks the thumb
// smoothly without firing an IPC call on every single pixel of drag.
opacitySlider.addEventListener("input", () => {
  opacityValueEl.textContent = `${opacitySlider.value}%`;
});
opacitySlider.addEventListener("change", async () => {
  const opacity = Number(opacitySlider.value) / 100;
  const result = await window.settingsApi.setOpacity(opacity);
  if (!result || !result.ok) {
    showStatus((result && result.reason) || "Could not change the overlay transparency.");
  }
});

// Milestone 15: renders whatever the last update check (from this run or an
// earlier one) found - see main.ts's UpdateCheckStatus/checkForUpdates.
// "Checking..." while a check is in flight overrides whatever's here.
function renderUpdateResult(result) {
  if (!result) {
    updateStatusEl.textContent = "Not checked yet.";
    return;
  }
  if (!result.ok) {
    updateStatusEl.textContent = result.error ? `Check failed: ${result.error}` : "Check failed.";
    return;
  }
  if (result.updateAvailable && result.latestVersion) {
    updateStatusEl.textContent = `Update available: ${result.latestVersion} (you have v${result.currentVersion})`;
  } else {
    updateStatusEl.textContent = `Up to date (v${result.currentVersion}).`;
  }
}

autoUpdateCheckbox.addEventListener("change", async () => {
  const result = await window.settingsApi.setAutoCheckForUpdates(autoUpdateCheckbox.checked);
  if (!result || !result.ok) {
    showStatus((result && result.reason) || "Could not change the update-check setting.");
    autoUpdateCheckbox.checked = !autoUpdateCheckbox.checked; // revert the checkbox on failure
  }
});

checkUpdatesBtn.addEventListener("click", async () => {
  checkUpdatesBtn.disabled = true;
  updateStatusEl.textContent = "Checking...";
  try {
    const result = await window.settingsApi.checkForUpdatesNow();
    renderUpdateResult(result);
  } finally {
    checkUpdatesBtn.disabled = false;
  }
});

// Milestone 18: renders one Locations row's status text/style and the
// enabled state of its own "Auto-detect" reset button (disabled when
// there's nothing custom to reset - "Reset" wouldn't do anything).
function renderLocationStatus(statusEl, resetBtn, info, notFoundHint) {
  const path = info.custom ?? info.resolved;
  if (info.found && path) {
    statusEl.textContent = path;
    statusEl.classList.remove("not-found");
  } else if (path) {
    statusEl.textContent = `${path} (not found)`;
    statusEl.classList.add("not-found");
  } else {
    statusEl.textContent = notFoundHint;
    statusEl.classList.add("not-found");
  }
  resetBtn.disabled = !info.custom;
}

function renderLocations(settings) {
  renderLocationStatus(logPathStatusEl, resetLogPathBtn, settings.logPath, "Not found automatically.");
  renderLocationStatus(cardDbPathStatusEl, resetCardDbPathBtn, settings.cardDbPath, "Not found automatically.");
}

chooseLogPathBtn.addEventListener("click", async () => {
  chooseLogPathBtn.disabled = true;
  try {
    const result = await window.settingsApi.chooseLogPath();
    if (result && result.ok && result.willRestart) {
      logPathStatusEl.textContent = "Restarting...";
      logPathStatusEl.classList.remove("not-found");
    } else if (result && !result.canceled) {
      showStatus("Could not set that path.");
    }
  } finally {
    chooseLogPathBtn.disabled = false;
  }
});

resetLogPathBtn.addEventListener("click", async () => {
  resetLogPathBtn.disabled = true;
  logPathStatusEl.textContent = "Restarting...";
  logPathStatusEl.classList.remove("not-found");
  await window.settingsApi.resetLogPath();
});

chooseCardDbPathBtn.addEventListener("click", async () => {
  chooseCardDbPathBtn.disabled = true;
  try {
    const result = await window.settingsApi.chooseCardDbPath();
    if (result && result.ok) {
      renderLocationStatus(
        cardDbPathStatusEl,
        resetCardDbPathBtn,
        { custom: result.path, resolved: result.resolved, found: result.found },
        "Not found automatically.",
      );
    } else if (result && !result.canceled) {
      showStatus("Could not set that folder.");
    }
  } finally {
    chooseCardDbPathBtn.disabled = false;
  }
});

resetCardDbPathBtn.addEventListener("click", async () => {
  resetCardDbPathBtn.disabled = true;
  try {
    const result = await window.settingsApi.resetCardDbPath();
    renderLocationStatus(cardDbPathStatusEl, resetCardDbPathBtn, { custom: null, resolved: result.resolved, found: result.found }, "Not found automatically.");
  } finally {
    resetCardDbPathBtn.disabled = false;
  }
});

async function init() {
  const settings = await window.settingsApi.getSettings();
  renderSizeOptions(settings.presets, settings.sizePreset);
  renderCardSizeOptions(settings.cardSizePresets, settings.cardSizePreset);
  setOpacitySlider(settings.opacity);
  autoUpdateCheckbox.checked = settings.autoCheckForUpdates !== false;
  updateStatusEl.textContent = settings.appVersion ? `Current version: v${settings.appVersion}` : "";
  // Milestone 19: a separate, never-overwritten line - updateStatusEl above
  // gets replaced by checkForUpdates results (see the click handler further
  // up), which was silently hiding the version again after any check.
  appVersionLineEl.textContent = settings.appVersion ? `MTGA Tracker v${settings.appVersion}` : "";
  renderLocations(settings);
}

init();
