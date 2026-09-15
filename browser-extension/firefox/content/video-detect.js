// OmniGet in-page download button (IDM-style).
//
// Shows a floating "Download" button whenever the current page has a playable
// video (a real <video> element) or is a supported media platform. Clicking it
// asks the desktop app (through the background service worker → local bridge)
// for the list of available resolutions and renders an in-page picker; choosing
// a resolution starts the download immediately at that quality.
//
// Everything lives inside a Shadow DOM so the host page's CSS can't touch it
// and vice versa. The script runs in the top frame only.
//
// IMPORTANT: the whole UI is built with DOM APIs (createElement/textContent) and
// never assigns innerHTML. Sites like YouTube ship a Trusted Types CSP
// (`require-trusted-types-for 'script'`) that throws on raw innerHTML strings,
// which would silently break the button on exactly the pages we care about.

(() => {
  "use strict";

  if (window.top !== window) return; // top frame only
  if (window.__omnigetIdmLoaded) return;
  window.__omnigetIdmLoaded = true;

  // Hostnames we know the desktop app can handle. Keep in loose sync with
  // src/detect.js — this is only used to decide whether to offer the button on
  // pages that have no <video> element yet (SPA shells, embeds, audio).
  const SUPPORTED_HOST_RE =
    /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|instagram\.com|tiktok\.com|twitter\.com|x\.com|vxtwitter\.com|fixvx\.com|reddit\.com|redd\.it|twitch\.tv|pinterest\.[\w.]+|pin\.it|bsky\.app|t\.me|telegram\.(me|org)|vimeo\.com|bilibili\.com|b23\.tv|soundcloud\.com|dailymotion\.com|facebook\.com|streamable\.com)$/i;

  const NS_SVG = "http://www.w3.org/2000/svg";

  let host, shadow, fab, panel;
  let panelOpen = false;
  let currentUrl = location.href;

  function isSupportedHost() {
    try {
      return SUPPORTED_HOST_RE.test(new URL(location.href).hostname);
    } catch {
      return false;
    }
  }

  // A "real" video is one that is reasonably sized and has (or will have) a
  // source. Tiny hidden <video> tags used for previews/ads are ignored.
  function hasPlayableVideo() {
    const vids = document.querySelectorAll("video");
    for (const v of vids) {
      const r = v.getBoundingClientRect();
      const big = r.width >= 200 && r.height >= 150;
      const hasSrc = v.currentSrc || v.src || v.querySelector("source");
      if (big && (hasSrc || v.readyState > 0)) return true;
    }
    return false;
  }

  function shouldShow() {
    return isSupportedHost() || hasPlayableVideo();
  }

  // ── DOM builders (no innerHTML) ───────────────────────────────────────────

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const key in props) {
        const value = props[key];
        if (value == null) continue;
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = value;
        else if (key.startsWith("on") && typeof value === "function")
          node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value);
      }
    }
    if (children) {
      for (const child of children) {
        if (child == null) continue;
        node.appendChild(
          typeof child === "string" ? document.createTextNode(child) : child
        );
      }
    }
    return node;
  }

  function svgIcon(paths, { size = 20, strokeWidth = 2, spin = false } = {}) {
    const svg = document.createElementNS(NS_SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", String(strokeWidth));
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    if (spin) svg.setAttribute("class", "og-spin");
    for (const d of paths) {
      const p = document.createElementNS(NS_SVG, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    }
    return svg;
  }

  // Fresh nodes each call — appending an SVG moves it, so it can't be reused.
  function iconDownload(size = 20) {
    return svgIcon(["M12 3v12", "m7 11 5 5 5-5", "M5 21h14"], { size });
  }
  function iconSpinner(size = 18) {
    return svgIcon(["M12 3a9 9 0 1 0 9 9"], {
      size,
      strokeWidth: 2.5,
      spin: true,
    });
  }

  function replaceChildren(node, ...kids) {
    while (node.firstChild) node.removeChild(node.firstChild);
    for (const k of kids) if (k != null) node.appendChild(k);
  }

  // ── UI ────────────────────────────────────────────────────────────────

  function ensureRoot() {
    if (host) return;
    host = document.createElement("div");
    host.id = "omniget-idm-root";
    host.style.cssText =
      "all:initial;position:fixed;z-index:2147483647;bottom:20px;right:20px;";
    shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .fab {
        display: flex; align-items: center; gap: 8px;
        background: #F04E23; color: #fff; border: none;
        padding: 10px 14px; border-radius: 999px; cursor: pointer;
        box-shadow: 0 6px 20px rgba(0,0,0,.28);
        font-size: 14px; font-weight: 600; line-height: 1;
        transition: transform .15s ease, box-shadow .15s ease, opacity .2s ease;
        user-select: none;
      }
      .fab:hover { transform: translateY(-1px); box-shadow: 0 8px 26px rgba(0,0,0,.34); }
      .fab:active { transform: translateY(0); }
      .fab .label { white-space: nowrap; }
      .panel {
        position: absolute; bottom: 56px; right: 0;
        min-width: 240px; max-width: 320px;
        background: #1c1c1e; color: #fff; border-radius: 14px;
        box-shadow: 0 12px 40px rgba(0,0,0,.45);
        overflow: hidden; opacity: 0; transform: translateY(8px) scale(.98);
        transition: opacity .16s ease, transform .16s ease;
        pointer-events: none;
      }
      .panel.open { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
      .panel-header {
        padding: 12px 14px; font-size: 13px; font-weight: 600;
        border-bottom: 1px solid rgba(255,255,255,.08);
        display: flex; align-items: center; gap: 8px;
        color: #fff;
      }
      .panel-title {
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        opacity: .95;
      }
      .panel-body { max-height: 320px; overflow-y: auto; padding: 6px; }
      .row {
        display: flex; align-items: center; justify-content: space-between;
        gap: 10px; width: 100%; text-align: left;
        background: transparent; color: #fff; border: none;
        padding: 10px 12px; border-radius: 10px; cursor: pointer;
        font-size: 14px;
      }
      .row:hover { background: rgba(255,255,255,.10); }
      .row .q { font-weight: 600; }
      .row .meta { font-size: 12px; opacity: .6; }
      .state { padding: 16px 14px; font-size: 13px; opacity: .85; display:flex; align-items:center; gap:10px; }
      .state.err { color: #ff9a8b; }
      .toast {
        position: absolute; bottom: 56px; right: 0;
        background: #1c1c1e; color: #fff; border-radius: 12px;
        padding: 10px 14px; font-size: 13px; font-weight: 500;
        box-shadow: 0 12px 40px rgba(0,0,0,.45); white-space: nowrap;
        opacity: 0; transform: translateY(8px); transition: opacity .18s ease, transform .18s ease;
        pointer-events: none;
      }
      .toast.show { opacity: 1; transform: translateY(0); }
      .toast.ok::before { content: "✓ "; color: #4ade80; }
      .toast.bad::before { content: "⚠ "; color: #fbbf24; }
      .og-spin { animation: ogspin 0.8s linear infinite; transform-origin: 12px 12px; }
      @keyframes ogspin { to { transform: rotate(360deg); } }
    `;
    shadow.appendChild(style);

    fab = el("button", { class: "fab", type: "button", onclick: onFabClick });
    setFabLoading(false);
    shadow.appendChild(fab);

    panel = el("div", { class: "panel" });
    shadow.appendChild(panel);

    document.documentElement.appendChild(host);
  }

  function showToast(text, kind) {
    const t = el("div", { class: `toast ${kind || ""}`, text });
    shadow.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => t.remove(), 300);
    }, 3200);
  }

  function closePanel() {
    panelOpen = false;
    if (panel) panel.classList.remove("open");
  }

  function openPanel() {
    panelOpen = true;
    panel.classList.add("open");
  }

  function renderState(text, isError) {
    const state = el("div", { class: `state ${isError ? "err" : ""}` }, [
      iconSpinner(),
      el("span", { text }),
    ]);
    replaceChildren(panel, state);
    openPanel();
  }

  function setFabLoading(loading) {
    if (!fab) return;
    replaceChildren(
      fab,
      loading ? iconSpinner() : iconDownload(),
      el("span", { class: "label", text: loading ? "Loading…" : "Download" })
    );
  }

  function renderQualities(data) {
    const title = data.title || "Available formats";
    const qualities = Array.isArray(data.qualities) ? data.qualities : [];

    const body = el("div", { class: "panel-body" });
    if (qualities.length === 0) {
      body.appendChild(rowEl({ value: "best", label: "Best available", meta: "" }));
    } else {
      for (const q of qualities) {
        const meta = q.width && q.height ? `${q.width}×${q.height}` : q.format || "";
        body.appendChild(rowEl({ value: q.value, label: q.label, meta }));
      }
      body.appendChild(
        rowEl({ value: "best", label: "Best available", meta: "auto" })
      );
    }

    const header = el("div", { class: "panel-header" }, [
      iconDownload(18),
      el("span", { class: "panel-title", text: title }),
    ]);

    replaceChildren(panel, header, body);
    openPanel();
  }

  function rowEl({ value, label, meta }) {
    return el(
      "button",
      { class: "row", type: "button", onclick: () => startDownload(value) },
      [
        el("span", { class: "q", text: label }),
        el("span", { class: "meta", text: meta || "" }),
      ]
    );
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  async function onFabClick() {
    if (panelOpen) {
      closePanel();
      return;
    }
    setFabLoading(true);
    renderState("Fetching available resolutions…");
    try {
      const res = await sendMessage({ type: "getFormats", url: location.href });
      if (res && res.ok) {
        renderQualities(res);
      } else {
        renderState(errorText(res), true);
      }
    } catch (e) {
      renderState("Couldn't reach the OmniGet app. Is it running?", true);
    } finally {
      setFabLoading(false);
    }
  }

  async function startDownload(quality) {
    renderState("Starting download…");
    try {
      const res = await sendMessage({
        type: "downloadWithQuality",
        url: location.href,
        quality,
      });
      closePanel();
      if (res && res.ok) {
        showToast(`Download started (${quality})`, "ok");
      } else {
        showToast(shortError(res), "bad");
      }
    } catch {
      closePanel();
      showToast("OmniGet app not reachable", "bad");
    }
  }

  function errorText(res) {
    if (!res) return "No response from the OmniGet app.";
    if (res.reason === "missing-token" || res.reason === "unauthorized")
      return "Extension not paired. Open OmniGet → Settings → Pair extension.";
    if (res.reason === "missing-endpoint" || res.reason === "fetch-failed")
      return "OmniGet app not reachable. Make sure it's running.";
    return res.message || "Couldn't read the available formats.";
  }

  function shortError(res) {
    if (!res) return "Download failed";
    if (res.reason === "missing-token" || res.reason === "unauthorized")
      return "Pair the extension in OmniGet settings";
    return res.error || res.message || "Download failed";
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          const err = chrome.runtime.lastError;
          if (err) return reject(new Error(err.message));
          resolve(response);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  // ── Visibility management ────────────────────────────────────────────────

  function update() {
    if (shouldShow()) {
      ensureRoot();
      if (host) host.style.display = "block";
    } else if (host) {
      host.style.display = "none";
      closePanel();
    }
  }

  // React to DOM changes (videos loading in), throttled.
  let pending = false;
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      update();
    }, 500);
  });

  // SPA route changes (YouTube etc.) don't reload the page — watch the URL.
  setInterval(() => {
    if (location.href !== currentUrl) {
      currentUrl = location.href;
      closePanel();
      update();
    }
  }, 1000);

  // Close the panel when clicking elsewhere on the page.
  document.addEventListener(
    "click",
    (e) => {
      if (!panelOpen) return;
      if (host && e.composedPath && e.composedPath().includes(host)) return;
      closePanel();
    },
    true
  );

  function start() {
    update();
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
