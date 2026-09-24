// Plain script (no bundler, no imports) - runs in the Settings window with
// contextIsolation on and nodeIntegration off, talking to main.ts only
// through the `settingsApi` object preload.cjs exposes via contextBridge.
// main.ts is the single source of truth for both the size-preset list and
// the current values - this file just renders whatever it's given and
// reports changes back, so it never needs updating if a preset is added,
// renamed, or its dimensions change.

const sizeOptionsEl = document.getElementById("size-options");
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

function renderSizeOptions(presets, currentPreset) {
  sizeOptionsEl.innerHTML = "";
  for (const preset of presets) {
    const label = document.createElement("label");
    label.className = "size-option";

    const input = document.createElement("input");
    input.type = "radio";
    input.name = "size-preset";
    input.value = preset.key;
    input.checked = preset.key === currentPreset;
    input.addEventListener("change", async () => {
      const result = await window.settingsApi.setSizePreset(preset.key);
      if (!result || !result.ok) {
        showStatus((result && result.reason) || "Could not change the overlay size.");
      }
    });

    const text = document.createElement("span");
    text.textContent = preset.label;

    label.appendChild(input);
    label.appendChild(text);
    sizeOptionsEl.appendChild(label);
  }
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
  setOpacitySlider(settings.opacity);
}

init();
