// The replay viewer on a phone: a touch screen under 760 px wide, or a phone on its side.
// It adds a few controls of its own and drives the player through the player's own buttons, so the
// player itself is unchanged and a desktop browser never sees any of this (mobile.css keys off body.m).
(() => {
  "use strict";
  const PHONE = matchMedia("(pointer: coarse) and (max-width: 760px), (pointer: coarse) and (max-height: 500px)");
  const SIDEWAYS = matchMedia("(orientation: landscape)");
  const $ = id => document.getElementById(id);
  const TABS = [["order", "Order"], ["driver", "Driver"], ["moments", "Moments"]];
  const FULL_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg>';
  const SHRINK_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4"/></svg>';
  const CAMERA_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="1.5" y="4" width="10" height="8" rx="1.5"/><path d="M11.5 7l3-2v6l-3-2"/></svg>';
  let built = false, tab = "order", timer = 0;

  function el(tag, attrs = {}, html = "") {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (html) e.innerHTML = html;
    return e;
  }
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const click = node => node && node.click();

  function build() {
    if (built) return;
    built = true;
    const stage = $("stage"), deck = document.querySelector("footer.deck");

    const cam = el("button", { id: "mCam", type: "button", "aria-haspopup": "dialog", "aria-label": "How the race is shown" }, `${CAMERA_ICON}<span>Map</span>`);
    cam.addEventListener("click", openSheet);
    stage.appendChild(cam);

    const full = el("button", { id: "mFull", type: "button", "aria-label": "Full screen" }, FULL_ICON);
    full.addEventListener("click", () => (isFull() ? leaveFull() : enterFull("button")));
    stage.appendChild(full);
    stage.appendChild(el("div", { id: "mFullAsk", hidden: "" }, "Tap for full screen"));

    const speed = el("button", { id: "mSpeed", class: "btn", type: "button", "aria-label": "Playback speed" }, "1×");
    speed.addEventListener("click", () => {      // the next speed along, round to the first
      const all = [...$("speeds").children], at = all.findIndex(b => b.classList.contains("on"));
      click(all[(at + 1) % all.length]);
      setTimeout(sync, 30);
    });
    deck.querySelector(".transport").appendChild(speed);

    const strip = el("button", { id: "mStrip", type: "button", "aria-label": "The driver you are following: tap to pick another" },
      '<i class="bar"></i><b class="pos num">–</b><span class="nm"><b>—</b><small></small></span><span class="ty"></span><span class="go">Change ›</span>');
    strip.addEventListener("click", () => show("order"));
    document.body.appendChild(strip);

    const tabs = el("nav", { id: "mTabs", "aria-label": "What to see" });
    for (const [key, label] of TABS) {
      const b = el("button", { type: "button", "data-m": key }, label);
      b.addEventListener("click", () => show(key));
      tabs.appendChild(b);
    }
    document.body.appendChild(tabs);

    const sheet = el("div", { id: "mSheet", role: "dialog", "aria-modal": "true", "aria-label": "How the race is shown" },
      '<div class="scrim"></div><div class="panel"><div class="grab"></div><div class="body"></div><button type="button" class="btn primary done">Done</button></div>');
    sheet.querySelector(".scrim").addEventListener("click", closeSheet);
    sheet.querySelector(".done").addEventListener("click", closeSheet);
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });
    document.body.appendChild(sheet);

    // a driver picked from the order: back to the race, with the strip showing who it is now
    $("tower").addEventListener("click", e => { if (e.target.closest("tr[data-i]")) setTimeout(sync, 30); });
  }

  function show(key) {
    tab = key;
    document.body.dataset.mtab = key;
    for (const b of $("mTabs").children) b.classList.toggle("on", b.dataset.m === key);
    // the player's own panes: the Driver tab shows its laps, Moments its highlights
    if (key === "driver") click(document.querySelector('#tabs [data-tab="laps"]'));
    if (key === "moments") click(document.querySelector('#tabs [data-tab="reel"]'));
    if (key === "order") {
      const row = document.querySelector("#tower tr.focus");
      if (row) requestAnimationFrame(() => row.scrollIntoView({ block: "center" }));
    }
  }

  // ---- what the strip, the camera button and the speed say, copied from the player as it changes
  function factText(label) {
    for (const d of document.querySelectorAll("#cFacts > div")) if (d.querySelector("dt")?.textContent.trim() === label) return d.querySelector("dd")?.textContent.trim() || "";
    return "";
  }
  function viewName() {
    const on = document.querySelector("#viewSeg button.on");
    return on ? on.dataset.view : "2d";
  }
  function sync() {
    if (!document.body.classList.contains("m")) return;
    const strip = $("mStrip");
    strip.querySelector(".bar").style.background = $("cBar").style.background || "";
    strip.querySelector(".pos").textContent = $("cPos").textContent;
    strip.querySelector(".nm b").textContent = $("cName").textContent;
    const gap = factText("Gap"), team = $("cTeam").textContent.split(" · ")[0];
    strip.querySelector(".nm small").textContent = [team, gap && gap !== "—" ? gap : ""].filter(Boolean).join(" · ");
    const ty = strip.querySelector(".ty"), tyre = $("cTyre");
    ty.textContent = tyre.textContent; ty.style.color = tyre.style.color || ""; ty.hidden = !tyre.textContent;

    const view = viewName(), camBtn = window.Stage3D && document.querySelector(`#camBar [data-cam="${window.Stage3D.camera}"]`);
    $("mCam").querySelector("span").textContent = view === "3d" ? `3D · ${camBtn ? camBtn.textContent : "Camera"}`
      : view === "25d" ? "Table" : "Map";
    const sp = document.querySelector("#speeds button.on");
    if (sp) $("mSpeed").textContent = sp.textContent;
  }

  // ---- the sheet: view, camera, names, voice, sky and cars, each one a button of the player's own
  function opts(title, list) {
    if (!list.length) return "";
    return `<h3>${esc(title)}</h3><div class="opts">${list.map(([id, label, on]) => `<button type="button" data-do="${esc(id)}" class="${on ? "on" : ""}">${esc(label)}</button>`).join("")}</div>`;
  }
  function renderSheet() {
    const body = $("mSheet").querySelector(".body"), view = viewName(), parts = [];
    const views = [...document.querySelectorAll("#viewSeg button")];
    if (!$("viewSeg").hidden && views.length) {
      const names = { "2d": "Map", "25d": "Table", "3d": "3D" };
      parts.push(opts("View", views.map(b => [`view:${b.dataset.view}`, names[b.dataset.view] || b.textContent, b.classList.contains("on")])));
    }
    if (view === "3d" && window.Stage3D) {
      const order = ["auto", "cockpit", "pod", "chase", "heli", "tv", "story", "drone", "orbit"];      // the everyday ones first
      const cams = [...document.querySelectorAll("#camBar [data-cam]")].sort((a, b) => (order.indexOf(a.dataset.cam) + 99) % 99 - (order.indexOf(b.dataset.cam) + 99) % 99);
      parts.push(opts("Camera", cams.map(b => [`cam:${b.dataset.cam}`, b.textContent, b.dataset.cam === window.Stage3D.camera])));
    }
    const toggles = [];
    if (view === "2d" && $("followCam")) toggles.push(["follow", "Zoom on the car", $("followCam").classList.contains("on")]);
    if (view !== "2d" && $("names3d") && !$("namesBar").hidden) toggles.push(["names", "Driver names", $("names3d").classList.contains("on")]);
    if ($("voice")) toggles.push(["voice", "Commentary", /on/i.test($("voice").textContent)]);
    if (toggles.length) parts.push(`<h3>Show</h3><div class="row">${toggles.map(([id, label, on]) => `<button type="button" data-do="${id}" class="${on ? "on" : ""}">${esc(label)}</button>`).join("")}</div>`);
    if (view !== "2d" && !$("looksBar").hidden) {
      const pick = (id, label) => {
        const src = $(id);
        if (!src || !src.options.length) return "";
        return `<label class="pick">${esc(label)} <select data-mirror="${id}">${[...src.options].map(o => `<option value="${esc(o.value)}"${o.value === src.value ? " selected" : ""}>${esc(o.textContent)}</option>`).join("")}</select></label>`;
      };
      parts.push(`<h3>Looks</h3>${pick("skyPick", "Sky")}${pick("carsPick", "Cars")}`);
    }
    body.innerHTML = parts.join("") || "<p>The map is all this race has.</p>";
    body.querySelectorAll("[data-do]").forEach(b => b.addEventListener("click", () => act(b.dataset.do)));
    body.querySelectorAll("select[data-mirror]").forEach(s => s.addEventListener("change", () => {
      const src = $(s.dataset.mirror);
      src.value = s.value; src.dispatchEvent(new Event("change", { bubbles: true }));
    }));
  }
  function act(what) {
    const [kind, value] = what.split(":");
    if (kind === "view") click(document.querySelector(`#viewSeg [data-view="${value}"]`));
    else if (kind === "cam") { click(document.querySelector(`#camBar [data-cam="${value}"]`)); setTimeout(closeSheet, 120); }
    else if (kind === "follow") click($("followCam"));
    else if (kind === "names") click($("names3d"));
    else if (kind === "voice") click($("voice"));
    setTimeout(() => { sync(); if ($("mSheet").hasAttribute("open")) renderSheet(); }, 80);      // (3D takes a moment to come: the camera list follows it)
  }
  function openSheet() { renderSheet(); $("mSheet").setAttribute("open", ""); }
  function closeSheet() { const s = $("mSheet"); if (s) s.removeAttribute("open"); }

  // ---- full screen. A browser only goes full screen from a tap, so turning the phone sideways lays the race out
  // edge to edge at once and asks; where the browser wants a tap first, the next tap anywhere does it. An iPhone
  // will not put a page full screen at all (only a video), so there "full screen" is the edge-to-edge layout.
  const root = document.documentElement;
  const canFull = !!(root.requestFullscreen || root.webkitRequestFullscreen) && (document.fullscreenEnabled || document.webkitFullscreenEnabled);
  let fullBy = null, armed = false;      // what put us in full screen ("button" or "turn"); a tap still owed to the browser
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  const isFull = () => !!fsElement() || document.body.classList.contains("theatre");
  function request() {
    const go = root.requestFullscreen ? root.requestFullscreen({ navigationUI: "hide" }) : root.webkitRequestFullscreen();
    return Promise.resolve(go);
  }
  function enterFull(by) {
    fullBy = by;
    if (!canFull) { document.body.classList.add("theatre"); syncFull(); return Promise.resolve(); }
    return request().then(() => {
      disarm();
      // from the button with the phone upright, turn the picture sideways as a video app does (Android; others ignore it)
      if (by === "button" && screen.orientation && screen.orientation.lock) screen.orientation.lock("landscape").catch(() => {});
    }, () => { if (by === "turn") arm(); });
  }
  function leaveFull() {
    fullBy = null; disarm();
    document.body.classList.remove("theatre");
    if (screen.orientation && screen.orientation.unlock) try { screen.orientation.unlock(); } catch (e) { /* not locked */ }
    if (fsElement()) (document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen && document.webkitExitFullscreen())?.catch?.(() => {});
    syncFull();
  }
  function owedTap() { if (armed) enterFull("turn"); }
  function arm() {
    if (armed) return;
    armed = true; $("mFullAsk").hidden = false;
    addEventListener("pointerup", owedTap, true);
    setTimeout(() => { if ($("mFullAsk")) $("mFullAsk").hidden = true; }, 4000);      // the pill goes; the tap still works
  }
  function disarm() {
    armed = false; if ($("mFullAsk")) $("mFullAsk").hidden = true;
    removeEventListener("pointerup", owedTap, true);
  }
  function turned() {
    if (!document.body.classList.contains("m")) return;
    if (SIDEWAYS.matches) { if (!isFull()) enterFull("turn"); }
    else if (fullBy === "turn") leaveFull();
    else disarm();
  }
  function syncFull() {
    const on = isFull(), b = $("mFull");
    if (!b) return;
    b.innerHTML = on ? SHRINK_ICON : FULL_ICON;
    b.setAttribute("aria-label", on ? "Leave full screen" : "Full screen");
    document.body.classList.toggle("full", on);
    setLand();
  }
  function setLand() {        // the edge-to-edge layout: a phone on its side, or full screen of any kind
    const m = document.body.classList.contains("m");
    document.body.classList.toggle("land", m && ((SIDEWAYS.matches && innerHeight < 500) || isFull()));
  }
  document.addEventListener("fullscreenchange", () => { if (!fsElement()) { fullBy = null; if (screen.orientation && screen.orientation.unlock) try { screen.orientation.unlock(); } catch (e) { /* not locked */ } } syncFull(); });
  document.addEventListener("webkitfullscreenchange", syncFull);

  // ---- on and off with the screen
  function apply() {
    const on = PHONE.matches && !document.body.classList.contains("embed");
    if (on) build();
    document.body.classList.toggle("m", on);
    setLand();
    clearInterval(timer);
    if (on) { show(tab); sync(); syncFull(); timer = setInterval(sync, 300); }
    else { closeSheet(); if (document.body.classList.contains("theatre")) leaveFull(); disarm(); }
  }
  PHONE.addEventListener("change", apply);
  SIDEWAYS.addEventListener("change", () => { apply(); turned(); });
  addEventListener("resize", setLand);
  document.addEventListener("stage3d-ready", () => setTimeout(sync, 50));
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply); else apply();
  // the page marks itself an embed only once the race is in: look again when that mark comes or goes
  let wasEmbed = document.body.classList.contains("embed");
  new MutationObserver(() => {
    const now = document.body.classList.contains("embed");
    if (now !== wasEmbed) { wasEmbed = now; apply(); }
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
})();
