/* ============================================================
   Slop Watch — Content Script
   ============================================================
   Injects AI-slop indicators into YouTube pages:
   - "Is video AI" button (clickable, voteable)
   - "Is channel AI" button (clickable, voteable)
   - "Is AI" overlay (read-only badge on thumbnails)
   ============================================================ */

(() => {
  "use strict";

  // ── Marker class to avoid duplicate injection ──────────────
  const INJECTED = "slop-injected";

  // ── Settings (loaded from storage) ─────────────────────────
  let settings = {
    enabled: true,
    hideVideos: false,
    hideVideoThreshold: 75,
    hideChannels: false,
    hideChannelThreshold: 75,
  };

  function loadSettings() {
    chrome.storage.local.get("slopwatch_settings", (data) => {
      if (data.slopwatch_settings) {
        settings = { ...settings, ...data.slopwatch_settings };
      }
    });
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.slopwatch_settings) {
      settings = { ...settings, ...changes.slopwatch_settings.newValue };
      if (settings.enabled) runInjectors();
    }
  });

  loadSettings();

  // ── Helpers ────────────────────────────────────────────────

  function isSignedIntoYT() {
    return !!document.querySelector(
      "button#avatar-btn, img.ytd-topbar-menu-button-renderer[alt='Avatar image']"
    );
  }

  function getVideoIdFromUrl(url) {
    try {
      const u = new URL(url, location.origin);
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const m = u.pathname.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    } catch {}
    return null;
  }

  function getCurrentVideoId() {
    return getVideoIdFromUrl(location.href);
  }

  function getVideoIdFromThumb(thumbEl) {
    const anchor = thumbEl.closest("a[href]");
    if (!anchor) return null;
    return getVideoIdFromUrl(anchor.href);
  }

  function getChannelHandle() {
    // Watch page: channel link in owner section
    const link = document.querySelector(
      "ytd-watch-metadata #owner ytd-channel-name a"
    );
    if (link) {
      const m = link.href.match(/\/@([^/?]+)/);
      if (m) return m[1];
    }
    return null;
  }

  function getChannelHandleFromPage() {
    const m = location.pathname.match(/^\/@([^/?]+)/);
    return m ? m[1] : null;
  }

  function getChannelHandleFromThumb(thumbEl) {
    // Walk up to the renderer, find channel link
    const renderer = thumbEl.closest(
      "ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-video-renderer"
    );
    if (!renderer) return null;
    const link = renderer.querySelector('a[href*="/@"]');
    if (!link) return null;
    const m = link.href.match(/\/@([^/?]+)/);
    return m ? m[1] : null;
  }

  // ── Badge / Button creation ────────────────────────────────

  function scorePct(score) {
    if (score.total < 1) return null; // not enough data
    return Math.round((score.ai / score.total) * 100);
  }

  function scoreColor(pct) {
    if (pct === null) return "#888";
    if (pct <= 30) return "#4caf50";
    if (pct <= 60) return "#ff9800";
    return "#f44336";
  }

  function createBadgeText(score) {
    const pct = scorePct(score);
    return pct === null ? "?" : `${pct}%`;
  }

  function createTooltip(score) {
    return `${score.total} vote${score.total !== 1 ? "s" : ""}`;
  }

  /**
   * Create a read-only overlay badge for thumbnails.
   */
  function createOverlay(score) {
    const el = document.createElement("div");
    el.className = "slop-overlay";
    const pct = scorePct(score);
    el.style.setProperty("--slop-color", scoreColor(pct));
    el.textContent = createBadgeText(score);
    el.title = createTooltip(score);

    if (
      settings.hideVideos &&
      pct !== null &&
      pct >= settings.hideVideoThreshold
    ) {
      el.classList.add("slop-overlay--flagged");
    }
    return el;
  }

  /**
   * Create a read-only channel overlay (for sidebar metadata rows).
   * Looks like a small inline badge, not clickable.
   */
  function createChannelOverlay(score) {
    const el = document.createElement("span");
    el.className = "slop-channel-overlay";
    const pct = scorePct(score);
    el.style.setProperty("--slop-color", scoreColor(pct));
    el.textContent = createBadgeText(score);
    el.title = createTooltip(score);
    return el;
  }

  /**
   * Create an interactive button ("Is video AI" / "Is channel AI").
   */
  function createButton(type, entityId, extraClass) {
    const container = document.createElement("span");
    container.className = `slop-btn ${extraClass || ""}`;
    container.dataset.slopType = type;
    container.dataset.slopId = entityId;

    const label = document.createElement("span");
    label.className = "slop-btn__label";
    label.textContent = "?";
    container.appendChild(label);

    // Tooltip holder
    container.title = "Loading…";

    // Load score
    sendMsg({ action: "getScore", type, entityId }).then((resp) => {
      if (!resp?.success) return;
      const s = resp.score;
      const pct = scorePct(s);
      label.textContent = createBadgeText(s);
      container.style.setProperty("--slop-color", scoreColor(pct));
      container.title = createTooltip(s);

      // Apply hide if channel threshold exceeded
      if (
        type === "channel" &&
        settings.hideChannels &&
        pct !== null &&
        pct >= settings.hideChannelThreshold
      ) {
        container.classList.add("slop-btn--flagged");
      }
    });

    // Click handler → show voting popup
    container.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      showVotingPopup(container, type, entityId);
    });

    return container;
  }

  // ── Voting popup ───────────────────────────────────────────

  function showVotingPopup(anchorEl, type, entityId) {
    // Remove any existing popup
    document.querySelectorAll(".slop-popup").forEach((p) => p.remove());

    if (!isSignedIntoYT()) {
      showToast("Sign in to YouTube to vote!");
      return;
    }

    const popup = document.createElement("div");
    popup.className = "slop-popup";

    const btnAi = document.createElement("button");
    btnAi.className = "slop-popup__btn slop-popup__btn--ai";
    btnAi.textContent = "🤖 Mark as AI";

    const btnHuman = document.createElement("button");
    btnHuman.className = "slop-popup__btn slop-popup__btn--human";
    btnHuman.textContent = "👤 Mark as Human";

    const btnClear = document.createElement("button");
    btnClear.className = "slop-popup__btn slop-popup__btn--clear";
    btnClear.textContent = "✖ Clear";

    // Highlight current vote
    sendMsg({ action: "getMyVote", type, entityId }).then((resp) => {
      if (resp?.success && resp.vote) {
        if (resp.vote === "ai") btnAi.classList.add("slop-popup__btn--active");
        else btnHuman.classList.add("slop-popup__btn--active");
      }
    });

    btnAi.onclick = async (e) => {
      e.stopPropagation();
      const resp = await sendMsg({
        action: "vote",
        type,
        entityId,
        vote: "ai",
      });
      if (resp?.success) updateButton(anchorEl, resp.score);
      popup.remove();
    };

    btnHuman.onclick = async (e) => {
      e.stopPropagation();
      const resp = await sendMsg({
        action: "vote",
        type,
        entityId,
        vote: "human",
      });
      if (resp?.success) updateButton(anchorEl, resp.score);
      popup.remove();
    };

    btnClear.onclick = async (e) => {
      e.stopPropagation();
      const resp = await sendMsg({ action: "clearVote", type, entityId });
      if (resp?.success) updateButton(anchorEl, resp.score);
      popup.remove();
    };

    popup.append(btnAi, btnHuman, btnClear);

    // Position popup on document.body with absolute positioning
    // (scrolls with the page, not fixed on screen)
    document.body.appendChild(popup);
    const rect = anchorEl.getBoundingClientRect();
    popup.style.position = "absolute";
    popup.style.top = `${rect.bottom + window.scrollY + 6}px`;
    popup.style.left = `${rect.left + window.scrollX + rect.width / 2}px`;
    popup.style.transform = "translateX(-50%)";

    // Close on click outside
    const closeHandler = (ev) => {
      if (!popup.contains(ev.target) && !anchorEl.contains(ev.target)) {
        popup.remove();
        document.removeEventListener("click", closeHandler, true);
      }
    };
    setTimeout(() => document.addEventListener("click", closeHandler, true), 0);
  }

  function updateButton(btnEl, score) {
    const label = btnEl.querySelector(".slop-btn__label");
    if (!label) return;
    const pct = scorePct(score);
    label.textContent = createBadgeText(score);
    btnEl.style.setProperty("--slop-color", scoreColor(pct));
    btnEl.title = createTooltip(score);
  }

  function showToast(message) {
    let toast = document.querySelector(".slop-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "slop-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add("slop-toast--visible");
    setTimeout(() => toast.classList.remove("slop-toast--visible"), 2500);
  }

  // ── Message helper ─────────────────────────────────────────

  function sendMsg(msg) {
    return new Promise((resolve) => {
      try {
        if (!chrome.runtime?.id) {
          resolve(null);
          return;
        }
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
          } else {
            resolve(response);
          }
        });
      } catch {
        resolve(null);
      }
    });
  }

  // ── PAGE INJECTORS ─────────────────────────────────────────

  // ▸▸ Watch page ▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸

  function injectWatchVideoButton() {
    const titleH1 = document.querySelector(
      "ytd-watch-metadata #title h1"
    );
    if (!titleH1 || titleH1.classList.contains(INJECTED)) return;
    const videoId = getCurrentVideoId();
    if (!videoId) return;

    titleH1.classList.add(INJECTED);
    titleH1.style.display = "flex";
    titleH1.style.alignItems = "center";
    const btn = createButton("video", videoId, "slop-btn--video-title");
    // Append inside the h1, after the yt-formatted-string
    titleH1.appendChild(btn);
  }

  function injectWatchChannelButton() {
    const ownerRenderer = document.querySelector(
      "ytd-watch-metadata ytd-video-owner-renderer"
    );
    if (!ownerRenderer || ownerRenderer.classList.contains(INJECTED)) return;
    const uploadInfo = ownerRenderer.querySelector("#upload-info");
    if (!uploadInfo) return;
    const handle = getChannelHandle();
    if (!handle) return;

    ownerRenderer.classList.add(INJECTED);
    const btn = createButton("channel", handle, "slop-btn--channel-watch");
    // Insert after #upload-info, inside ytd-video-owner-renderer
    uploadInfo.insertAdjacentElement("afterend", btn);
  }

  // ▸▸ Channel overlays (read-only badge in metadata rows, universal) ▸▸

  function injectChannelOverlays() {
    // Find ALL yt-lockup-view-model items across the entire page
    const items = document.querySelectorAll(
      `yt-lockup-view-model:not(.${INJECTED}-ch)`
    );

    items.forEach((item) => {
      item.classList.add(`${INJECTED}-ch`);

      // Find the first metadata row (contains channel name)
      const metaRows = item.querySelectorAll(
        ".yt-content-metadata-view-model__metadata-row"
      );
      const channelRow = metaRows[0];
      if (!channelRow) return;

      // Try to extract channel handle from a link first (homepage has links)
      let handle = null;
      const channelLink = item.querySelector('a[href*="/@"]');
      if (channelLink) {
        const m = channelLink.href.match(/\/@([^/?]+)/);
        if (m) handle = m[1];
      }

      // Fallback: extract channel name from the text in the first metadata row
      // (sidebar renders channel name as plain text spans, not links)
      if (!handle) {
        const textSpan = channelRow.querySelector(
          ".yt-content-metadata-view-model__metadata-text"
        );
        if (textSpan) {
          // Get only the direct text content (channel name), excluding nested badges
          const cloned = textSpan.cloneNode(true);
          // Remove nested non-text elements (verified badge icons, etc.)
          cloned.querySelectorAll(".yt-core-attributed-string--inline-block-mod").forEach(el => el.remove());
          handle = cloned.textContent.trim();
        }
      }

      if (!handle) return;

      // Skip if already has a channel overlay
      if (channelRow.querySelector(".slop-channel-overlay")) return;

      sendMsg({ action: "getScore", type: "channel", entityId: handle }).then(
        (resp) => {
          if (!resp?.success) return;
          if (channelRow.querySelector(".slop-channel-overlay")) return;
          const overlay = createChannelOverlay(resp.score);
          channelRow.appendChild(overlay);
        }
      );
    });
  }

  // ▸▸ Universal thumbnail overlays (works on ALL pages) ▸▸▸▸▸

  function injectAllThumbnailOverlays() {
    // Find every thumbnail link across the entire page.
    // Includes classic a#thumbnail, modern lockup-view-model, and shorts-specific anchors.
    const allThumbnailLinks = document.querySelectorAll(
      `a#thumbnail[href*="/watch"]:not(.${INJECTED}),
       a#thumbnail[href*="/shorts/"]:not(.${INJECTED}),
       a.ytd-thumbnail[href*="/watch"]:not(.${INJECTED}),
       a.ytd-thumbnail[href*="/shorts/"]:not(.${INJECTED}),
       a.yt-lockup-view-model__content-image[href*="/watch"]:not(.${INJECTED}),
       a.yt-lockup-view-model__content-image[href*="/shorts/"]:not(.${INJECTED}),
       a.reel-item-endpoint[href*="/shorts/"]:not(.${INJECTED}),
       a.shortsLockupViewModelHostEndpoint.reel-item-endpoint[href*="/shorts/"]:not(.${INJECTED})`
    );

    allThumbnailLinks.forEach((anchor) => {
      anchor.classList.add(INJECTED);

      const videoId = getVideoIdFromUrl(anchor.href);
      if (!videoId) return;

      // Skip if this anchor already has an overlay (prevents duplicates)
      if (anchor.querySelector(":scope > .slop-overlay")) return;

      // Place overlay directly on the anchor to avoid overflow:hidden
      // from child containers like yt-image or ytd-thumbnail
      anchor.style.position = "relative";

      sendMsg({ action: "getScore", type: "video", entityId: videoId }).then(
        (resp) => {
          if (!resp?.success) return;
          // Double-check no overlay was added while waiting
          if (anchor.querySelector(":scope > .slop-overlay")) return;
          const overlay = createOverlay(resp.score);
          anchor.appendChild(overlay);

          // Apply blur/hide
          const pct = scorePct(resp.score);
          if (
            settings.hideVideos &&
            pct !== null &&
            pct >= settings.hideVideoThreshold
          ) {
            const renderer = anchor.closest(
              "ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-video-renderer, ytd-grid-video-renderer, yt-lockup-view-model"
            );
            if (renderer) renderer.classList.add("slop-hidden");
          }
        }
      );
    });
  }

  // ▸▸ Shorts page ▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸

  function injectShortsVideoButton() {
    // Find the actions panel in the shorts player
    const actionsEl = document.querySelector(
      "ytd-reel-player-overlay-renderer #actions"
    );
    if (!actionsEl || actionsEl.classList.contains(INJECTED)) return;
    const videoId = getCurrentVideoId();
    if (!videoId) return;

    actionsEl.classList.add(INJECTED);
    const btn = createButton("video", videoId, "slop-btn--shorts-video");
    actionsEl.insertBefore(btn, actionsEl.firstChild);
  }

  function injectShortsChannelButton() {
    // Modern shorts layout: yt-reel-channel-bar-view-model
    const channelBars = document.querySelectorAll(
      `yt-reel-channel-bar-view-model:not(.${INJECTED})`
    );

    channelBars.forEach((bar) => {
      bar.classList.add(INJECTED);

      // Channel name is a span with class ytReelChannelBarViewModelChannelName
      const nameSpan = bar.querySelector(
        "span.ytReelChannelBarViewModelChannelName"
      );
      if (!nameSpan) return;

      const link = nameSpan.querySelector("a[href]");
      if (!link) return;
      const m = link.href.match(/\/@([^/?]+)/);
      if (!m) return;
      const handle = m[1];

      const btn = createButton("channel", handle, "slop-btn--shorts-channel");
      nameSpan.insertAdjacentElement("afterend", btn);
    });

    // Fallback: legacy shorts layout
    const legacyChannelEl = document.querySelector(
      `ytd-reel-player-overlay-renderer #channel-name:not(.${INJECTED})`
    );
    if (legacyChannelEl) {
      legacyChannelEl.classList.add(INJECTED);
      const link = legacyChannelEl.querySelector("a[href]");
      if (link) {
        const m = link.href.match(/\/@([^/?]+)/);
        if (m) {
          const btn = createButton("channel", m[1], "slop-btn--shorts-channel");
          legacyChannelEl.parentElement.insertBefore(btn, legacyChannelEl.nextSibling);
        }
      }
    }
  }

  // ▸▸ Channel page ▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸

  function injectChannelPageButton() {
    // Target the h1 inside the channel page header
    const h1 = document.querySelector(
      "h1.dynamic-text-view-model-wiz__h1, h1.dynamicTextViewModelH1"
    );
    if (!h1 || h1.classList.contains(INJECTED)) return;
    const handle = getChannelHandleFromPage();
    if (!handle) return;

    h1.classList.add(INJECTED);
    h1.style.display = "flex";
    h1.style.alignItems = "center";
    const btn = createButton("channel", handle, "slop-btn--channel-page");
    h1.appendChild(btn);
  }

  // ── MASTER INJECTOR ────────────────────────────────────────

  function runInjectors() {
    if (!settings.enabled) return;

    const path = location.pathname;

    if (path === "/watch") {
      injectWatchVideoButton();
      injectWatchChannelButton();
    }

    if (path.startsWith("/shorts/")) {
      injectShortsVideoButton();
      injectShortsChannelButton();
    }

    if (path.startsWith("/@") || path.startsWith("/channel/")) {
      injectChannelPageButton();
    }

    // Universal — runs on EVERY page
    injectAllThumbnailOverlays();
    injectChannelOverlays();
  }

  // ── MUTATION OBSERVER (YouTube SPA) ────────────────────────

  let debounceTimer = null;

  function onMutation() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runInjectors, 300);
  }

  const observer = new MutationObserver(onMutation);
  observer.observe(document.body, { childList: true, subtree: true });

  // Also listen for YouTube SPA navigations
  document.addEventListener("yt-navigate-finish", () => {
    // Small delay for DOM to settle after navigation
    setTimeout(runInjectors, 500);
  });

  // Initial run
  runInjectors();
})();
