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

async function init() {
  const settings = await window.settingsApi.getSettings();
  renderSizeOptions(settings.presets, settings.sizePreset);
  renderCardSizeOptions(settings.cardSizePresets, settings.cardSizePreset);
  setOpacitySlider(settings.opacity);
}

init();
