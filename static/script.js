/* ------------------------------------------------------------------
   Calorie Counter: volume-based estimate with an honest error range
   ------------------------------------------------------------------
   Pipeline:  fill level -> volume (ml) -> mass (g) -> kcal -> range
   No ML involved. Geometry is simple closed-form.
------------------------------------------------------------------- */

/* ---------- Pure geometry / maths (testable without a browser) ---------- */

const MATH = {
  clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),

  // Straight-sided container: volume is linear in fill level.
  cylinderVolume(capacityMl, fill) {
    return capacityMl * fill;
  },

  // Tapered bowl filled to height h (cm). Radii in cm, result in ml (cm^3).
  frustumVolume(baseDiamCm, topDiamCm, heightCm, fillHeightCm) {
    const rb = baseDiamCm / 2;
    const rt = topDiamCm / 2;
    const h = MATH.clamp(fillHeightCm, 0, heightCm);
    const r = rb + (rt - rb) * (h / heightCm);
    return (Math.PI * h / 3) * (rb * rb + rb * r + r * r);
  },

  // Heap of food on a plate modelled as a spherical cap.
  // a = footprint radius (cm), h = heap height (cm).
  sphericalCapVolume(footprintRadiusCm, heapHeightCm) {
    const a = footprintRadiusCm, h = heapHeightCm;
    return (Math.PI * h / 6) * (3 * a * a + h * h);
  },

  // Fill fraction from three marked lines on a photo (fractions of image height,
  // 0 = top of image). Returns null when the lines are not in a valid order.
  fillFromLines(rim, surface, base) {
    if (!(base > rim)) return null;
    return MATH.clamp((base - surface) / (base - rim), 0, 1);
  },

  // Independent proportional errors combine in quadrature.
  combinedError(volPct, denPct, kcalPct) {
    return Math.sqrt(volPct ** 2 + denPct ** 2 + kcalPct ** 2) / 100;
  },

  estimate({ volumeMl, densityGPerMl, kcalPer100g, volPct, denPct, kcalPct }) {
    const massG = volumeMl * densityGPerMl;
    const kcal = massG * kcalPer100g / 100;
    const rel = Math.min(MATH.combinedError(volPct, denPct, kcalPct), 0.95);
    return {
      volumeMl, massG, kcal, rel,
      low: kcal * (1 - rel),
      high: kcal * (1 + rel)
    };
  }
};


/* ---------- Data ---------- */

// Offline fallback only. When the backend is reachable, foods come from /api/foods
// (seeded with the same values, then edited by the user). ids match the server's slugs.
const FALLBACK_FOODS = [
  { id: "cooked-white-rice",    name: "Cooked white rice",     kcal: 130, density: 0.80 },
  { id: "jollof-rice",          name: "Jollof rice",           kcal: 165, density: 0.80 },
  { id: "cooked-beans",         name: "Cooked beans",          kcal: 130, density: 0.90 },
  { id: "cooked-pasta",         name: "Cooked pasta",          kcal: 155, density: 0.65 },
  { id: "pounded-yam-swallow",  name: "Pounded yam / swallow", kcal: 120, density: 1.00 },
  { id: "boiled-yam-cubed",     name: "Boiled yam (cubed)",    kcal: 118, density: 0.85 },
  { id: "tomato-stew",          name: "Tomato stew",           kcal: 120, density: 1.00 },
  { id: "vegetable-okra-soup",  name: "Vegetable / okra soup", kcal: 95,  density: 1.00 },
  { id: "pepper-soup-broth",    name: "Pepper soup (broth)",   kcal: 45,  density: 1.00 },
  { id: "pap-ogi",              name: "Pap / ogi",             kcal: 60,  density: 1.02 }
];

const CUSTOM_FOOD_ID = "__custom__";

const PRESET_CONTAINERS = [
  { id: "flask-350",  name: "Flask 350 ml",  shape: "cylinder", capacityMl: 350 },
  { id: "flask-500",  name: "Flask 500 ml",  shape: "cylinder", capacityMl: 500 },
  { id: "flask-750",  name: "Flask 750 ml",  shape: "cylinder", capacityMl: 750 },
  { id: "flask-1000", name: "Flask 1 L",     shape: "cylinder", capacityMl: 1000 },
  { id: "bowl-soup",  name: "Soup bowl",     shape: "tapered", topDiamCm: 14, baseDiamCm: 8,  heightCm: 6 },
  { id: "bowl-large", name: "Large bowl",    shape: "tapered", topDiamCm: 18, baseDiamCm: 10, heightCm: 8 },
  { id: "plate-27",   name: "Dinner plate (27 cm)", shape: "plate", diameterCm: 27 },
  { id: "plate-20",   name: "Side plate (20 cm)",   shape: "plate", diameterCm: 20 }
];

const API = "/api";
const STORAGE_KEY = "calorieCounter.customContainers";
const LAST_KEY = "calorieCounter.lastContainer";

/* ---------- API client ---------- */

// Resolves with parsed JSON (or null for 204). Rejects with an Error that has `.status`
// when the server answered with an error, and no `.status` when the server was unreachable.
async function api(path, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(API + path, {
      ...opts,
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) }
    });
    if (!res.ok) {
      let detail = res.statusText || "Request failed";
      try {
        const j = await res.json();
        detail = typeof j.detail === "string" ? j.detail : "Some values are invalid.";
      } catch (e) { /* keep statusText */ }
      const err = new Error(detail);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const foodFromApi = (f) => ({ id: f.id, name: f.name, kcal: f.kcal_per_100g, density: f.density_g_per_ml, source: f.source });

const containerFromApi = (c) => {
  const out = { id: c.id, name: c.name, shape: c.shape };
  if (c.shape === "cylinder") out.capacityMl = c.capacity_ml;
  if (c.shape === "tapered") { out.topDiamCm = c.top_diam_cm; out.baseDiamCm = c.base_diam_cm; out.heightCm = c.height_cm; }
  if (c.shape === "plate") out.diameterCm = c.diameter_cm;
  return out;
};

const containerToApi = (c) => ({
  name: c.name, shape: c.shape,
  capacity_ml: c.capacityMl ?? null, top_diam_cm: c.topDiamCm ?? null,
  base_diam_cm: c.baseDiamCm ?? null, height_cm: c.heightCm ?? null, diameter_cm: c.diameterCm ?? null
});

// Server ids are 12 hex chars. Anything else was created offline (or by the first,
// server-less version of this app) and still needs uploading.
const isLocalId = (id) => /^(custom|local)-/.test(id);

/* ---------- Local cache (localStorage can throw or be empty) ---------- */

function loadLocalContainers() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}
function saveLocalContainers(list) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
}
function loadLast() {
  try { return localStorage.getItem(LAST_KEY); } catch (e) { return null; }
}
function saveLast(id) {
  try { localStorage.setItem(LAST_KEY, id); } catch (e) { /* ignore */ }
}

/* ---------- Container helpers ---------- */

function containerCapacityMl(c) {
  if (c.shape === "cylinder") return c.capacityMl;
  if (c.shape === "tapered") return MATH.frustumVolume(c.baseDiamCm, c.topDiamCm, c.heightCm, c.heightCm);
  return null;
}

function describeContainer(c) {
  if (c.shape === "cylinder") return `Straight-sided, ${c.capacityMl} ml.`;
  if (c.shape === "tapered") {
    return `Tapered bowl, about ${Math.round(containerCapacityMl(c))} ml when full ` +
           `(${c.topDiamCm} cm top, ${c.baseDiamCm} cm base, ${c.heightCm} cm tall).`;
  }
  return `Plate, ${c.diameterCm} cm across. Volume comes from spread and heap height.`;
}

/* ---------- Browser UI ---------- */

if (typeof document !== "undefined") {
  const $ = (id) => document.getElementById(id);

  const ui = {
    food: $("foodSelect"), foodName: $("foodName"), foodNameRow: $("foodNameRow"),
    kcal: $("kcalInput"), density: $("densityInput"),
    saveFood: $("saveFoodBtn"), deleteFood: $("deleteFoodBtn"), foodStatus: $("foodStatus"),
    apiStatus: $("apiStatus"),
    container: $("containerSelect"), info: $("containerInfo"), del: $("deleteContainerBtn"),
    photo: $("photoInput"), preview: $("preview"), markWrap: $("markWrap"), markHelp: $("markHelp"),
    fillPanel: $("fillPanel"), platePanel: $("platePanel"), platePreview: $("platePreview"),
    fill: $("fillSlider"), fillLabel: $("fillLabel"),
    cover: $("coverSlider"), coverLabel: $("coverLabel"),
    height: $("heightSlider"), heightLabel: $("heightLabel"),
    errVol: $("errVol"), errDen: $("errDen"), errKcal: $("errKcal")
  };

  // Marking lines as fractions of the photo height (0 = top).
  const lines = { rim: 0.12, surface: 0.5, base: 0.88 };
  let hasPhoto = false;

  let online = false;
  let foods = FALLBACK_FOODS.slice();
  let customContainers = loadLocalContainers();

  function setOnline(value) {
    online = value;
    ui.apiStatus.textContent = value ? "Server connected" : "Offline mode";
    ui.apiStatus.className = "badge " + (value ? "text-bg-success" : "text-bg-warning");
    updateFoodControls();
  }

  /* --- foods --- */
  function currentFood() {
    return foods.find(f => f.id === ui.food.value) || null; // null means "Custom"
  }

  function renderFoods(selectedId) {
    ui.food.innerHTML = "";
    foods.forEach(f => ui.food.add(new Option(f.name, f.id)));
    ui.food.add(new Option("Custom (enter values)", CUSTOM_FOOD_ID));
    ui.food.value = foods.some(f => f.id === selectedId) || selectedId === CUSTOM_FOOD_ID
      ? selectedId
      : (foods[0] ? foods[0].id : CUSTOM_FOOD_ID);
  }

  function applyFoodValues() {
    const f = currentFood();
    if (f) { ui.kcal.value = f.kcal; ui.density.value = f.density; }
  }

  function setFoodStatus(msg, isError = false) {
    ui.foodStatus.textContent = msg;
    ui.foodStatus.className = "small " + (isError ? "text-danger" : "text-secondary");
  }

  function validFoodNumbers() {
    const k = Number(ui.kcal.value), d = Number(ui.density.value);
    return k > 0 && k <= 900 && d >= 0.1 && d <= 2;
  }

  function updateFoodControls() {
    const f = currentFood();
    const isCustom = f === null;
    ui.foodNameRow.classList.toggle("d-none", !isCustom);
    const changed = isCustom || Number(ui.kcal.value) !== f.kcal || Number(ui.density.value) !== f.density;
    ui.saveFood.classList.toggle("d-none", !(online && changed && validFoodNumbers()));
    ui.saveFood.textContent = isCustom ? "Save as new meal" : "Save values";
    ui.deleteFood.classList.toggle("d-none", !(online && !isCustom));
    if (!online && changed) setFoodStatus("Offline: changes apply to this estimate only and are not saved.");
  }

  async function loadFoods(selectId) {
    const keep = selectId || ui.food.value;
    try {
      const list = await api("/foods");
      foods = list.map(foodFromApi);
      setOnline(true);
    } catch (e) {
      foods = FALLBACK_FOODS.slice();
      setOnline(false);
    }
    renderFoods(keep);
    applyFoodValues();
    updateFoodControls();
    update();
  }

  async function saveFood() {
    if (!validFoodNumbers()) { setFoodStatus("kcal must be 1 to 900 and density 0.1 to 2.", true); return; }
    const f = currentFood();
    const body = { kcal_per_100g: Number(ui.kcal.value), density_g_per_ml: Number(ui.density.value) };
    try {
      if (f === null) {
        const name = ui.foodName.value.trim();
        if (!name) { setFoodStatus("Enter a name for this meal.", true); return; }
        const saved = await api("/foods", { method: "POST", body: JSON.stringify({ name, ...body }) });
        ui.foodName.value = "";
        await loadFoods(saved.id);
      } else {
        await api("/foods/" + encodeURIComponent(f.id), { method: "PUT", body: JSON.stringify(body) });
        await loadFoods(f.id);
      }
      setFoodStatus("Saved.");
    } catch (e) {
      setFoodStatus(e.status ? e.message : "Could not reach the server.", true);
      if (!e.status) setOnline(false);
    }
  }

  async function deleteFood() {
    const f = currentFood();
    if (!f || !window.confirm(`Delete "${f.name}"?`)) return;
    try {
      await api("/foods/" + encodeURIComponent(f.id), { method: "DELETE" });
      await loadFoods(null);
      setFoodStatus("Deleted.");
    } catch (e) {
      setFoodStatus(e.status ? e.message : "Could not reach the server.", true);
    }
  }

  /* --- containers --- */
  function allContainers() { return PRESET_CONTAINERS.concat(customContainers); }

  function renderContainers(selectedId) {
    ui.container.innerHTML = "";
    const presetGroup = document.createElement("optgroup");
    presetGroup.label = "Presets";
    PRESET_CONTAINERS.forEach(c => presetGroup.appendChild(new Option(c.name, c.id)));
    ui.container.appendChild(presetGroup);

    if (customContainers.length) {
      const g = document.createElement("optgroup");
      g.label = "My containers";
      customContainers.forEach(c => g.appendChild(new Option(c.name, c.id)));
      ui.container.appendChild(g);
    }
    const ids = allContainers().map(c => c.id);
    ui.container.value = ids.includes(selectedId) ? selectedId : PRESET_CONTAINERS[1].id;
  }

  function currentContainer() {
    return allContainers().find(c => c.id === ui.container.value) || PRESET_CONTAINERS[0];
  }

  // Pull custom containers from the server and upload any that were created offline.
  async function syncContainers() {
    try {
      const pending = loadLocalContainers().filter(c => isLocalId(c.id));
      const remaining = [];
      for (const c of pending) {
        try { await api("/containers", { method: "POST", body: JSON.stringify(containerToApi(c)) }); }
        catch (e) { remaining.push(c); }
      }
      const list = (await api("/containers")).map(containerFromApi);
      customContainers = list.concat(remaining);
      saveLocalContainers(customContainers);
      setOnline(true);
    } catch (e) {
      setOnline(false); // keep whatever the local cache gave us
    }
    renderContainers(ui.container.value || loadLast());
    updatePanels();
    update();
  }

  /* --- marking lines --- */
  function positionLines() {
    ["rim", "surface", "base"].forEach(k => {
      $("line-" + k).style.top = (lines[k] * 100) + "%";
    });
  }

  function syncSliderFromLines() {
    const f = MATH.fillFromLines(lines.rim, lines.surface, lines.base);
    if (f === null) return;
    ui.fill.value = Math.round(f * 100);
  }

  function syncLinesFromSlider() {
    const f = Number(ui.fill.value) / 100;
    lines.surface = lines.base - f * (lines.base - lines.rim);
    positionLines();
  }

  function setupDragging() {
    let active = null;
    ["rim", "surface", "base"].forEach(k => {
      const el = $("line-" + k);
      el.addEventListener("pointerdown", (e) => {
        active = k;
        el.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      el.addEventListener("pointermove", (e) => {
        if (active !== k) return;
        const r = ui.markWrap.getBoundingClientRect();
        let y = MATH.clamp((e.clientY - r.top) / r.height, 0, 1);
        const gap = 0.02;
        if (k === "rim")     y = Math.min(y, lines.base - gap);
        if (k === "base")    y = Math.max(y, lines.rim + gap);
        lines[k] = y;
        // Keep the surface line between rim and base.
        lines.surface = MATH.clamp(lines.surface, lines.rim, lines.base);
        positionLines();
        syncSliderFromLines();
        update();
      });
      const end = () => { active = null; };
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
    });
  }

  /* --- panels depend on container shape --- */
  function updatePanels() {
    const c = currentContainer();
    const isPlate = c.shape === "plate";
    ui.fillPanel.classList.toggle("d-none", isPlate);
    ui.platePanel.classList.toggle("d-none", !isPlate);
    ui.info.textContent = describeContainer(c);
    ui.del.classList.toggle("d-none", !customContainers.some(x => x.id === c.id));
    if (hasPhoto) {
      ui.platePreview.classList.toggle("d-none", !isPlate);
    }
  }

  /* --- volume for the current inputs --- */
  function currentVolumeMl() {
    const c = currentContainer();
    if (c.shape === "cylinder") {
      return MATH.cylinderVolume(c.capacityMl, Number(ui.fill.value) / 100);
    }
    if (c.shape === "tapered") {
      const h = (Number(ui.fill.value) / 100) * c.heightCm;
      return MATH.frustumVolume(c.baseDiamCm, c.topDiamCm, c.heightCm, h);
    }
    const footprintR = (c.diameterCm * Number(ui.cover.value) / 100) / 2;
    return MATH.sphericalCapVolume(footprintR, Number(ui.height.value));
  }

  /* --- render result --- */
  const fmt = (n) => Math.round(n).toLocaleString();

  function update() {
    ui.fillLabel.textContent = ui.fill.value + "%";
    ui.coverLabel.textContent = ui.cover.value + "%";
    ui.heightLabel.textContent = Number(ui.height.value).toFixed(1) + " cm";

    const kcal100 = Number(ui.kcal.value);
    const dens = Number(ui.density.value);
    const vol = currentVolumeMl();

    const empty = $("resultEmpty"), body = $("resultBody"), warn = $("warnOut");
    if (!(kcal100 > 0) || !(dens > 0) || !(vol > 0)) {
      empty.classList.remove("d-none");
      body.classList.add("d-none");
      empty.textContent = !(vol > 0) ? "Set a fill level above zero." : "Enter kcal per 100 g and density.";
      return;
    }

    const r = MATH.estimate({
      volumeMl: vol, densityGPerMl: dens, kcalPer100g: kcal100,
      volPct: Number(ui.errVol.value) || 0,
      denPct: Number(ui.errDen.value) || 0,
      kcalPct: Number(ui.errKcal.value) || 0
    });

    empty.classList.add("d-none");
    body.classList.remove("d-none");
    $("kcalEst").textContent = fmt(r.kcal);
    $("kcalRange").textContent = `${fmt(r.low)} to ${fmt(r.high)}`;
    $("volOut").textContent = fmt(r.volumeMl);
    $("massOut").textContent = fmt(r.massG);
    $("errOut").textContent = Math.round(r.rel * 100);

    // Range bar: scale to the high end plus headroom.
    const max = r.high * 1.1;
    $("rangeFill").style.left = (r.low / max * 100) + "%";
    $("rangeFill").style.width = ((r.high - r.low) / max * 100) + "%";
    $("rangeMid").style.left = (r.kcal / max * 100) + "%";

    // Warnings
    const c = currentContainer();
    const msgs = [];
    if (c.shape === "plate") {
      msgs.push("Plate estimates depend on your height guess, which a top-down photo cannot measure.");
    }
    if (hasPhoto && c.shape !== "plate" && MATH.fillFromLines(lines.rim, lines.surface, lines.base) === null) {
      msgs.push("Rim and base lines are out of order.");
    }
    if (c.shape !== "plate" && Number(ui.fill.value) >= 98) {
      msgs.push("Container looks full. Check for food heaped above the rim.");
    }
    warn.textContent = msgs.join(" ");
    warn.classList.toggle("d-none", msgs.length === 0);
  }

  /* --- events --- */
  ui.food.addEventListener("change", () => {
    setFoodStatus("");
    applyFoodValues();
    updateFoodControls();
    update();
  });
  [ui.kcal, ui.density].forEach(el => el.addEventListener("input", () => {
    setFoodStatus("");
    updateFoodControls();
    update();
  }));
  [ui.errVol, ui.errDen, ui.errKcal].forEach(el => el.addEventListener("input", update));
  ui.saveFood.addEventListener("click", saveFood);
  ui.deleteFood.addEventListener("click", deleteFood);

  ui.container.addEventListener("change", () => {
    saveLast(ui.container.value);
    updatePanels();
    update();
  });

  ui.fill.addEventListener("input", () => { syncLinesFromSlider(); update(); });
  ui.cover.addEventListener("input", update);
  ui.height.addEventListener("input", update);

  ui.photo.addEventListener("change", () => {
    const file = ui.photo.files && ui.photo.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    ui.preview.onload = () => {
      ui.markWrap.classList.remove("d-none");
      ui.markHelp.classList.remove("d-none");
      positionLines();
    };
    ui.preview.src = url;
    ui.platePreview.src = url;
    hasPhoto = true;
    // Reset lines to sensible defaults for a new photo.
    lines.rim = 0.12; lines.base = 0.88;
    syncLinesFromSlider();
    updatePanels();
    update();
  });

  /* --- custom containers --- */
  const shapeSel = $("cShape");
  function showShapeFields() {
    document.querySelectorAll(".shape-field").forEach(el => {
      el.classList.toggle("d-none", el.dataset.shape !== shapeSel.value);
    });
  }
  shapeSel.addEventListener("change", showShapeFields);

  $("saveContainerBtn").addEventListener("click", async () => {
    const err = $("containerError");
    err.textContent = "";
    const name = $("cName").value.trim();
    const shape = shapeSel.value;
    const num = (id) => Number($(id).value);
    if (!name) { err.textContent = "Give it a name."; return; }

    let c = { id: "local-" + Date.now(), name, shape };
    if (shape === "cylinder") {
      c.capacityMl = num("cCap");
      if (!(c.capacityMl >= 50)) { err.textContent = "Enter a capacity in ml."; return; }
    } else if (shape === "tapered") {
      c.topDiamCm = num("cTop"); c.baseDiamCm = num("cBottom"); c.heightCm = num("cHeight");
      if (![c.topDiamCm, c.baseDiamCm, c.heightCm].every(v => v > 0)) {
        err.textContent = "Enter all three dimensions."; return;
      }
    } else {
      c.diameterCm = num("cDiam");
      if (!(c.diameterCm >= 5)) { err.textContent = "Enter the plate diameter."; return; }
    }

    if (online) {
      try {
        c = containerFromApi(await api("/containers", { method: "POST", body: JSON.stringify(containerToApi(c)) }));
      } catch (e) {
        if (e.status) { err.textContent = e.message; return; }
        setOnline(false); // fall through and keep it locally; it uploads on the next sync
      }
    }

    customContainers.push(c);
    saveLocalContainers(customContainers);
    saveLast(c.id);
    renderContainers(c.id);
    updatePanels();
    update();
    ["cName", "cCap", "cTop", "cBottom", "cHeight", "cDiam"].forEach(id => { $(id).value = ""; });
    const panel = bootstrap.Collapse.getOrCreateInstance($("customContainer"), { toggle: false });
    panel.hide();
  });

  ui.del.addEventListener("click", async () => {
    const id = ui.container.value;
    if (online && !isLocalId(id)) {
      try { await api("/containers/" + encodeURIComponent(id), { method: "DELETE" }); }
      catch (e) {
        if (e.status && e.status !== 404) { $("containerError").textContent = e.message; return; }
        if (!e.status) { $("containerError").textContent = "Could not reach the server, so it was not deleted."; return; }
      }
    }
    customContainers = customContainers.filter(c => c.id !== id);
    saveLocalContainers(customContainers);
    saveLast(PRESET_CONTAINERS[1].id);
    renderContainers(PRESET_CONTAINERS[1].id);
    updatePanels();
    update();
  });

  /* --- init: render instantly from the fallback and cache, then upgrade from the server --- */
  renderFoods(FALLBACK_FOODS[0].id);
  applyFoodValues();
  renderContainers(loadLast());
  showShapeFields();
  setupDragging();
  positionLines();
  updatePanels();
  updateFoodControls();
  update();
  loadFoods(FALLBACK_FOODS[0].id);
  syncContainers();
}

// Allow `node` to load the maths for testing.
if (typeof module !== "undefined") module.exports = { MATH, FALLBACK_FOODS, PRESET_CONTAINERS, containerCapacityMl };
