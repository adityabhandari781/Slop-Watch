/* ============================================================
   Slop Watch Content Script
   ============================================================
   Injects AI-slop indicators into YouTube pages:
   - "Is video AI" button (clickable, voteable)
   - "Is channel AI" button (clickable, voteable)
   - "Is AI" overlay (read-only badge on thumbnails)
   ============================================================ */

(() => {
  "use strict";

  // ============================================================
  // MARKER CLASS & SETTINGS
  // ============================================================

  /*
   * INJECTED markers prevent duplicate DOM insertion across multiple
   * mutation cycles. Selectors check for these classes before injecting.
   */
  const INJECTED = "slop-injected";

  // Settings loaded from storage and updated via onChanged listener
  let settings = {
    enabled: true,
    hideVideos: false,
    hideVideoThreshold: 75,
    hideChannels: false,
    hideChannelThreshold: 75,
  };

  /*
   * Remove all Slop Watch DOM elements and their marker classes.
   * Called when extension is disabled to leave the page clean.
   */
  function removeSlopElements() {
    document
      .querySelectorAll(
        ".slop-overlay, .slop-channel-overlay, .slop-btn, .slop-popup, .slop-toast",
      )
      .forEach((el) => el.remove());
    document
      .querySelectorAll(`.${INJECTED}`)
      .forEach((el) => el.classList.remove(INJECTED));
    document
      .querySelectorAll(`.${INJECTED}-ch`)
      .forEach((el) => el.classList.remove(`${INJECTED}-ch`));
    document
      .querySelectorAll(".slop-hidden")
      .forEach((el) => el.classList.remove("slop-hidden"));
  }

  /*
   * Settings storage listener triggers re-injection on toggle or threshold change.
   * Disabled: clean the page. Enabled: re-run injectors to apply new thresholds.
   */
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.slopwatch_settings) {
      settings = { ...settings, ...changes.slopwatch_settings.newValue };
      if (settings.enabled) {
        runInjectors();
      } else {
        removeSlopElements();
      }
    }
  });

  // ============================================================
  // HELPERS: SIGN-IN & VIDEO/CHANNEL EXTRACTION
  // ============================================================

  function isSignedIntoYT() {
    return !!document.querySelector(
      "button#avatar-btn, img.ytd-topbar-menu-button-renderer[alt='Avatar image']",
    );
  }

  /*
   * Extract video ID from any YouTube URL (watch or shorts).
   * Handles edge cases: malformed URLs, missing params, fallback to pathname.
   */
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

  /*
   * Extract channel handle from watch page metadata.
   * Looks for the owner section link, falls back to null if not found.
   */
  function getChannelEntityIdFromUrl(url) {
    try {
      const u = new URL(url, location.origin);
      const path = u.pathname;

      if (path.startsWith("/@")) {
        return `handle:${path.slice(2).split("/")[0].toLowerCase()}`;
      }
      if (path.startsWith("/channel/")) {
        return `channel:${path.slice("/channel/".length).split("/")[0]}`;
      }
      if (path.startsWith("/user/")) {
        return `user:${path.slice("/user/".length).split("/")[0].toLowerCase()}`;
      }
      if (path.startsWith("/c/")) {
        return `custom:${path.slice("/c/".length).split("/")[0].toLowerCase()}`;
      }
    } catch {}

    return null;
  }

  function getChannelEntityId() {
    const link = document.querySelector(
      "ytd-watch-metadata #owner ytd-channel-name a",
    );
    return link ? getChannelEntityIdFromUrl(link.href) : null;
  }

  function getChannelEntityIdFromPage() {
    return getChannelEntityIdFromUrl(location.href);
  }

  /*
   * Extract a stable channel entity key from thumbnail or list context.
   * Uses canonical channel URLs when present and avoids display-name fallbacks,
   * which are ambiguous and may contain characters unsafe for database keys.
   */
  function getChannelEntityIdFromThumb(thumbEl) {
    const renderer = thumbEl.closest(
      "ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-video-renderer",
    );
    if (!renderer) return null;

    const link = renderer.querySelector(
      'a[href*="/@"], a[href*="/channel/"], a[href*="/user/"], a[href*="/c/"]',
    );

    return link ? getChannelEntityIdFromUrl(link.href) : null;
  }

  // ============================================================
  // SCORING & COLORING
  // ============================================================

  /*
   * Convert raw score to percentage. Returns null if insufficient votes,
   * which signals "no data" and should render as "?".
   */
  function scorePct(score) {
    if (score.total < 1) return null; // not enough data
    return Math.round((score.ai / score.total) * 100);
  }

  /*
   * Color scale: green (low AI %), orange (medium), red (high).
   * Returns gray if no data (pct === null).
   */
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

  // ============================================================
  // BADGE / BUTTON CREATION
  // ============================================================

  /*
   * Create a read-only overlay badge for video thumbnails.
   * Applies flagged styling if hideVideos is on and threshold exceeded.
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

  /*
   * Create a small inline channel badge (for metadata rows, channel lists).
   * Read-only, not clickable. Uses same color scheme as video overlay.
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

  /*
   * Create an interactive button with lazy-loaded score and click-to-vote handler.
   * Initially shows "?" with loading tooltip. On load, updates badge, color, and tooltip.
   * Applies flagged styling if channel threshold exceeded (channels only).
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

    // Load score from background script
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

    // Click handler opens voting popup
    container.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      showVotingPopup(container, type, entityId);
    });

    return container;
  }

  // ============================================================
  // VOTING POPUP
  // ============================================================

  /*
   * Show modal voting UI. Requires YouTube sign-in.
   * Positions popup below the anchor button using absolute positioning
   * (scrolls with page, not fixed to viewport).
   * Close-on-outside handler uses capture phase to fire before button clicks.
   */
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
    btnAi.textContent = "Mark as AI";

    const btnHuman = document.createElement("button");
    btnHuman.className = "slop-popup__btn slop-popup__btn--human";
    btnHuman.textContent = "Mark as Human";

    const btnClear = document.createElement("button");
    btnClear.className = "slop-popup__btn slop-popup__btn--clear";
    btnClear.textContent = "Clear";

    /*
     * Load and highlight user's existing vote. Fetch happens async;
     * if vote exists, button gets active class before user sees popup.
     */
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
    document.body.appendChild(popup);
    const rect = anchorEl.getBoundingClientRect();
    popup.style.position = "absolute";
    popup.style.top = `${rect.bottom + window.scrollY + 6}px`;
    popup.style.left = `${rect.left + window.scrollX + rect.width / 2}px`;
    popup.style.transform = "translateX(-50%)";

    /*
     * Close popup on click outside. Uses capture phase (third arg true)
     * to fire before event bubbles, ensuring clicks on other elements
     * are captured before button handlers see them.
     * setTimeout(0) defers handler attachment to next macrotask,
     * avoiding immediate closure from the triggering click.
     */
    const closeHandler = (ev) => {
      if (!popup.contains(ev.target) && !anchorEl.contains(ev.target)) {
        popup.remove();
        document.removeEventListener("click", closeHandler, true);
      }
    };
    setTimeout(() => document.addEventListener("click", closeHandler, true), 0);
  }

  /*
   * Update button UI after vote completes. Refreshes badge text, color, and tooltip.
   */
  function updateButton(btnEl, score) {
    const label = btnEl.querySelector(".slop-btn__label");
    if (!label) return;
    const pct = scorePct(score);
    label.textContent = createBadgeText(score);
    btnEl.style.setProperty("--slop-color", scoreColor(pct));
    btnEl.title = createTooltip(score);
  }

  /*
   * Show ephemeral toast message (e.g., "Sign in to vote").
   * Reuses existing toast if present, clears visibility after 2.5s.
   */
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

  // ============================================================
  // MESSAGE HELPER
  // ============================================================

  /*
   * Send message to background script with graceful error handling.
   * Returns null on extension unload, network error, or missing runtime.
   * Wrapped in Promise to abstract the callback API.
   */
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

  // ============================================================
  // PAGE INJECTORS
  // ============================================================

  /*
   * Inject "Is video AI" button into watch page title.
   * Uses data-slop-id comparison (not INJECTED class) to detect staleness.
   * If a button exists for a different video (SPA navigation), replaces it.
   */
  function injectWatchVideoButton() {
    const titleH1 = document.querySelector("ytd-watch-metadata #title h1");
    if (!titleH1) return;
    const videoId = getCurrentVideoId();
    if (!videoId) return;

    const existing = titleH1.querySelector(".slop-btn--video-title");
    if (existing) {
      if (existing.dataset.slopId === videoId) return; // already correct
      existing.remove(); // stale: remove before re-injecting
    }

    titleH1.style.display = "flex";
    titleH1.style.alignItems = "center";
    const btn = createButton("video", videoId, "slop-btn--video-title");
    titleH1.appendChild(btn);
  }

  /*
   * Inject "Is channel AI" button into watch page owner section.
   * Uses data-slop-id comparison to detect staleness from SPA navigation.
   * If a button exists for a different channel, replaces it.
   */
  function injectWatchChannelButton() {
    const ownerRenderer = document.querySelector(
      "ytd-watch-metadata ytd-video-owner-renderer",
    );
    if (!ownerRenderer) return;
    const uploadInfo = ownerRenderer.querySelector("#upload-info");
    if (!uploadInfo) return;
    const entityId = getChannelEntityId();
    if (!entityId) return;

    const existing = ownerRenderer.querySelector(".slop-btn--channel-watch");
    if (existing) {
      if (existing.dataset.slopId === entityId) return; // already correct
      existing.remove(); // stale: remove before re-injecting
    }

    const btn = createButton("channel", entityId, "slop-btn--channel-watch");
    uploadInfo.insertAdjacentElement("afterend", btn);
  }

  /*
   * Inject small channel badges into yt-lockup-view-model items
   * (feed items, search results, playlists). Appears in the first
   * metadata row alongside channel name. Handles both link-based
   * (homepage) and text-based (sidebar) channel name extraction.
   */
  function injectChannelOverlays() {
    const items = document.querySelectorAll(
      `yt-lockup-view-model:not(.${INJECTED}-ch)`,
    );

    items.forEach((item) => {
      item.classList.add(`${INJECTED}-ch`);

      const metaRows = item.querySelectorAll(
        ".yt-content-metadata-view-model__metadata-row",
      );
      const channelRow = metaRows[0];
      if (!channelRow) return;

      /*
       * Only use canonical channel URLs. Display-name text is not stable and
       * can introduce invalid database keys.
       */
      const channelLink = item.querySelector(
        'a[href*="/@"], a[href*="/channel/"], a[href*="/user/"], a[href*="/c/"]',
      );
      const entityId = channelLink
        ? getChannelEntityIdFromUrl(channelLink.href)
        : null;

      if (!entityId) return;
      if (channelRow.querySelector(".slop-channel-overlay")) return;

      sendMsg({ action: "getScore", type: "channel", entityId }).then(
        (resp) => {
          if (!resp?.success) return;
          if (channelRow.querySelector(".slop-channel-overlay")) return;
          const overlay = createChannelOverlay(resp.score);
          channelRow.appendChild(overlay);
        },
      );
    });
  }

  /*
   * Inject channel badges into playlist video items.
   * Handles both modern playlist page (ytd-playlist-video-renderer)
   * and playlist panel sidebar (ytd-playlist-panel-video-renderer).
   * Targets different selectors per layout; extracts handle from link or text.
   */
  function injectPlaylistChannelOverlays() {
    const items = document.querySelectorAll(
      `ytd-playlist-video-renderer:not(.${INJECTED}-ch),
       ytd-playlist-panel-video-renderer:not(.${INJECTED}-ch)`,
    );

    items.forEach((item) => {
      item.classList.add(`${INJECTED}-ch`);

      // Try two different DOM structures (page vs. sidebar)
      let target =
        item.querySelector("ytd-channel-name yt-formatted-string#text") ||
        item.querySelector("#byline-container #byline") ||
        item.querySelector("span#byline");

      if (!target) return;
      if (target.querySelector(".slop-channel-overlay")) return;
      target.style.display = "inline-flex";
      target.style.alignItems = "center";

      // Extract a stable channel key from a canonical channel URL.
      const link = target.querySelector("a[href]");
      const entityId = link ? getChannelEntityIdFromUrl(link.href) : null;
      if (!entityId) return;

      sendMsg({ action: "getScore", type: "channel", entityId }).then(
        (resp) => {
          if (!resp?.success) return;
          if (target.querySelector(".slop-channel-overlay")) return;
          const overlay = createChannelOverlay(resp.score);
          target.appendChild(overlay);
        },
      );
    });
  }

  /*
   * Inject overlays on video thumbnails across all page types.
   * Uses multiple selectors to catch feeds, search, recommendations, etc.
   * Critical: append overlay to thumbnail CONTAINER (ytd-thumbnail, yt-thumbnail-view-model),
   * not the anchor. This avoids triggering YouTube's ::before aspect-ratio pseudo-element
   * which can break layout.
   * Applies blur/hide class to renderer parent if hideVideos threshold exceeded.
   */
  function injectAllThumbnailOverlays() {
    const allThumbnailLinks = document.querySelectorAll(
      `a#thumbnail[href*="/watch"]:not(.${INJECTED}),
       a#thumbnail[href*="/shorts/"]:not(.${INJECTED}),
       a.ytd-thumbnail[href*="/watch"]:not(.${INJECTED}),
       a.ytd-thumbnail[href*="/shorts/"]:not(.${INJECTED}),
       a.yt-lockup-view-model__content-image[href*="/watch"]:not(.${INJECTED}),
       a.yt-lockup-view-model__content-image[href*="/shorts/"]:not(.${INJECTED}),
       a.reel-item-endpoint[href*="/shorts/"]:not(.${INJECTED}),
       a.shortsLockupViewModelHostEndpoint.reel-item-endpoint[href*="/shorts/"]:not(.${INJECTED})`,
    );

    allThumbnailLinks.forEach((anchor) => {
      anchor.classList.add(INJECTED);

      const videoId = getVideoIdFromUrl(anchor.href);
      if (!videoId) return;

      /*
       * Place overlay on thumbnail CONTAINER, not anchor.
       * ytd-thumbnail and yt-thumbnail-view-model have position:relative;
       * parentElement is fallback for custom layouts.
       */
      const host =
        anchor.closest("ytd-thumbnail") ||
        anchor.closest("yt-thumbnail-view-model") ||
        anchor.parentElement;

      if (!host || host.querySelector(".slop-overlay")) return;

      sendMsg({ action: "getScore", type: "video", entityId: videoId }).then(
        (resp) => {
          if (!resp?.success) return;
          if (host.querySelector(".slop-overlay")) return;
          const overlay = createOverlay(resp.score);
          host.style.position = "relative";
          host.appendChild(overlay);

          // Apply blur/hide if threshold exceeded
          const pct = scorePct(resp.score);
          if (
            settings.hideVideos &&
            pct !== null &&
            pct >= settings.hideVideoThreshold
          ) {
            const renderer = anchor.closest(
              "ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-video-renderer, ytd-grid-video-renderer, yt-lockup-view-model",
            );
            if (renderer) renderer.classList.add("slop-hidden");
          }
        },
      );
    });
  }

  /*
   * Inject "Is video AI" button into shorts player actions panel.
   * Located below/alongside other action buttons (like, comment, share).
   */
  function injectShortsVideoButton() {
    const actionsEl = document.querySelector(
      "ytd-reel-player-overlay-renderer #actions",
    );
    if (!actionsEl || actionsEl.classList.contains(INJECTED)) return;
    const videoId = getCurrentVideoId();
    if (!videoId) return;

    actionsEl.classList.add(INJECTED);
    const btn = createButton("video", videoId, "slop-btn--shorts-video");
    actionsEl.insertBefore(btn, actionsEl.firstChild);
  }

  /*
   * Inject "Is channel AI" button into shorts channel bar.
   * Handles modern layout (yt-reel-channel-bar-view-model with ytReelChannelBarViewModelChannelName).
   * Fallback for legacy layout (ytd-reel-player-overlay-renderer #channel-name).
   */
  function injectShortsChannelButton() {
    // Modern shorts layout
    const channelBars = document.querySelectorAll(
      `yt-reel-channel-bar-view-model:not(.${INJECTED})`,
    );

    channelBars.forEach((bar) => {
      bar.classList.add(INJECTED);

      const nameSpan = bar.querySelector(
        "span.ytReelChannelBarViewModelChannelName",
      );
      if (!nameSpan) return;

      const link = nameSpan.querySelector("a[href]");
      if (!link) return;
      const m = link.href.match(/\/@([^/?]+)/);
      if (!m) return;
      const entityId = getChannelEntityIdFromUrl(link.href);
      if (!entityId) return;

      const btn = createButton(
        "channel",
        entityId,
        "slop-btn--shorts-channel",
      );
      nameSpan.insertAdjacentElement("afterend", btn);
    });

    // Fallback: legacy shorts layout
    const legacyChannelEl = document.querySelector(
      `ytd-reel-player-overlay-renderer #channel-name:not(.${INJECTED})`,
    );
    if (legacyChannelEl) {
      legacyChannelEl.classList.add(INJECTED);
      const link = legacyChannelEl.querySelector("a[href]");
      if (link) {
        const entityId = getChannelEntityIdFromUrl(link.href);
        if (entityId) {
          const btn = createButton(
            "channel",
            entityId,
            "slop-btn--shorts-channel",
          );
          legacyChannelEl.parentElement.insertBefore(
            btn,
            legacyChannelEl.nextSibling,
          );
        }
      }
    }
  }

  /*
   * Inject "Is channel AI" button into channel page header.
   * Targets h1 heading in modern and legacy YouTube layouts.
   */
  function injectChannelPageButton() {
    const h1 = document.querySelector(
      "h1.dynamic-text-view-model-wiz__h1, h1.dynamicTextViewModelH1",
    );
    if (!h1 || h1.classList.contains(INJECTED)) return;
    const entityId = getChannelEntityIdFromPage();
    if (!entityId) return;

    h1.classList.add(INJECTED);
    h1.style.display = "flex";
    h1.style.alignItems = "center";
    const btn = createButton("channel", entityId, "slop-btn--channel-page");
    h1.appendChild(btn);
  }

  // ============================================================
  // MASTER INJECTOR
  // ============================================================

  /*
   * Route injections based on current page type.
   * Watch and shorts: page-specific buttons.
   * Channel page: channel button.
   * All pages: universal thumbnail and metadata overlays.
   */
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

    // Universal
    injectAllThumbnailOverlays();
    injectChannelOverlays();
    injectPlaylistChannelOverlays();
  }

  // ============================================================
  // MUTATION OBSERVER & SPA NAVIGATION
  // ============================================================

  /*
   * Debounce mutation handler to avoid thrashing on batch DOM changes.
   * YouTube pushes many mutations per navigation; debounce coalesces them.
   * 300ms delay balances responsiveness (feel snappy) with efficiency
   * (avoid redundant runs).
   *
   * navigating flag: suppresses MutationObserver-triggered injections
   * during SPA navigation. Without this, the observer fires runInjectors
   * at 300ms (before YouTube updates owner/channel metadata), re-injecting
   * buttons with stale data from the previous video.
   */
  let debounceTimer = null;
  let navigating = false;

  function onMutation() {
    if (navigating) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runInjectors, 300);
  }

  const observer = new MutationObserver(onMutation);

  /*
   * Clear ALL interactive buttons and their INJECTED markers.
   * Called on SPA navigation so stale scores from the previous page
   * don't linger. Covers watch page, shorts, and channel page layouts.
   */
  function clearPageInjections() {
    // Remove all interactive slop buttons from the page
    document
      .querySelectorAll(".slop-btn")
      .forEach((el) => el.remove());

    // Reset INJECTED markers on watch-page elements
    const titleH1 = document.querySelector("ytd-watch-metadata #title h1");
    if (titleH1) titleH1.classList.remove(INJECTED);

    const ownerRenderer = document.querySelector(
      "ytd-watch-metadata ytd-video-owner-renderer",
    );
    if (ownerRenderer) ownerRenderer.classList.remove(INJECTED);

    // Shorts elements
    const actionsEl = document.querySelector(
      "ytd-reel-player-overlay-renderer #actions",
    );
    if (actionsEl) actionsEl.classList.remove(INJECTED);

    document.querySelectorAll(
      `yt-reel-channel-bar-view-model.${INJECTED}`,
    ).forEach((bar) => bar.classList.remove(INJECTED));

    const legacyChannelEl = document.querySelector(
      `ytd-reel-player-overlay-renderer #channel-name.${INJECTED}`,
    );
    if (legacyChannelEl) legacyChannelEl.classList.remove(INJECTED);

    // Channel page
    const h1 = document.querySelector(
      "h1.dynamic-text-view-model-wiz__h1, h1.dynamicTextViewModelH1",
    );
    if (h1) h1.classList.remove(INJECTED);
  }

  /*
   * YouTube is a SPA that emits yt-navigate-finish on route change.
   *
   * 1. Set navigating=true to block the MutationObserver from
   *    re-injecting buttons with stale data while YouTube updates the DOM.
   * 2. Cancel any pending debounced runInjectors.
   * 3. clearPageInjections() removes ALL old buttons and INJECTED markers.
   * 4. After 600ms (enough for YouTube to update metadata), unblock
   *    mutations and run injectors with fresh data.
   */
  document.addEventListener("yt-navigate-finish", () => {
    navigating = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    clearPageInjections();
    setTimeout(() => {
      navigating = false;
      runInjectors();
    }, 600);
  });

  // ============================================================
  // INITIALIZATION
  // ============================================================

  /*
   * Load settings, start observer, and run initial injection.
   * Observer runs continuously to catch new items in feeds/playlists.
   */
  chrome.storage.local.get("slopwatch_settings", (data) => {
    if (data.slopwatch_settings) {
      settings = { ...settings, ...data.slopwatch_settings };
    }
    observer.observe(document.body, { childList: true, subtree: true });
    if (settings.enabled) {
      runInjectors();
    } else {
      removeSlopElements();
    }
  });
})();
