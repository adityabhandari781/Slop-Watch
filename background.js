// ============================================================
// Slop Watch Background Service Worker
// ============================================================
// Handles Firebase REST interactions, browser UUID management,
// and in-memory score caching.
// ============================================================

// ============================================================
// CONFIGURATION
// ============================================================
const FIREBASE_DB_URL =
  "https://slop-watch-default-rtdb.asia-southeast1.firebasedatabase.app/";

// ============================================================
// Browser UUID (persistent per install)
// ============================================================
async function getOrCreateUUID() {
  const data = await chrome.storage.local.get("slopwatch_uuid");
  if (data.slopwatch_uuid) return data.slopwatch_uuid;
  const uuid = crypto.randomUUID();
  await chrome.storage.local.set({ slopwatch_uuid: uuid });
  return uuid;
}

// ============================================================
// In-memory score cache (TTL = 60 s)
// ============================================================
/*
 * We cache scores in memory to avoid redundant Firebase requests during
 * rapid UI interactions (e.g., rendering thumbnail grids). Cache entries
 * are automatically invalidated after TTL, and explicit cache clears happen
 * after vote changes to keep scores fresh.
 */
const scoreCache = new Map();
const CACHE_TTL = 60_000;

function getCached(key) {
  const entry = scoreCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    scoreCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  scoreCache.set(key, { data, ts: Date.now() });
}

function invalidateCache(key) {
  scoreCache.delete(key);
}

// ============================================================
// Firebase helpers
// ============================================================
function firebaseUrl(path) {
  return `${FIREBASE_DB_URL}/${path}.json`;
}

/*
 * Fetch aggregate score for a video or channel. Returns cached result if
 * available; otherwise queries Firebase and populates cache. Does not throw
 * on network errors to ensure UI remains responsive.
 */
async function fetchScore(type, entityId) {
  const cacheKey = `${type}:${entityId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const resp = await fetch(firebaseUrl(`aggregates/${type}/${entityId}`));
    if (!resp.ok) return { ai: 0, total: 0 };
    const data = await resp.json();
    const result = data
      ? { ai: data.ai || 0, total: data.total || 0 }
      : { ai: 0, total: 0 };
    setCache(cacheKey, result);
    return result;
  } catch {
    return { ai: 0, total: 0 };
  }
}

/*
 * Fetch the current user's existing vote for an entity. Returns null if no
 * vote exists (first time voting) or on network failure.
 */
async function fetchMyVote(type, entityId) {
  const uuid = await getOrCreateUUID();
  try {
    const resp = await fetch(firebaseUrl(`votes/${type}/${entityId}/${uuid}`));
    if (!resp.ok) return null;
    const data = await resp.json();
    return data ? data.vote : null;
  } catch {
    return null;
  }
}

/*
 * Submit a vote, handling both first-vote and vote-change scenarios.
 *
 * First vote: increments total and optionally increments ai count.
 * Vote change: updates ai count (increment if switching to ai, decrement if switching away).
 * Total count remains unchanged when changing votes.
 *
 * Uses fetchScoreBypass to read the current aggregate state before mutation,
 * avoiding race conditions where rapid votes could corrupt the aggregate.
 */
async function submitVote(type, entityId, vote) {
  const uuid = await getOrCreateUUID();
  const existingVote = await fetchMyVote(type, entityId);

  // No-op if user is re-voting the same way
  if (existingVote === vote) return await fetchScore(type, entityId);

  // Write the vote
  await fetch(firebaseUrl(`votes/${type}/${entityId}/${uuid}`), {
    method: "PUT",
    body: JSON.stringify({ vote }),
  });

  // Calculate aggregate delta
  let aiDelta = 0;
  let totalDelta = 0;

  if (existingVote === null) {
    // First vote
    totalDelta = 1;
    aiDelta = vote === "ai" ? 1 : 0;
  } else {
    // Changing vote
    if (vote === "ai")
      aiDelta = 1; // was human, now ai
    else aiDelta = -1; // was ai, now human
    // total stays the same
  }

  // Patch aggregates
  const currentScore = await fetchScoreBypass(type, entityId);
  const newScore = {
    ai: Math.max(0, currentScore.ai + aiDelta),
    total: Math.max(0, currentScore.total + totalDelta),
  };

  await fetch(firebaseUrl(`aggregates/${type}/${entityId}`), {
    method: "PUT",
    body: JSON.stringify(newScore),
  });

  invalidateCache(`${type}:${entityId}`);
  setCache(`${type}:${entityId}`, newScore);
  return newScore;
}

/*
 * Clear the user's vote. If the user had voted, decrements both ai (if applicable)
 * and total. Uses read-before-write via fetchScoreBypass to avoid concurrent
 * mutation issues.
 */
async function clearVote(type, entityId) {
  const uuid = await getOrCreateUUID();
  const existingVote = await fetchMyVote(type, entityId);

  if (!existingVote) return await fetchScore(type, entityId);

  // Delete vote
  await fetch(firebaseUrl(`votes/${type}/${entityId}/${uuid}`), {
    method: "DELETE",
  });

  // Patch aggregates
  const currentScore = await fetchScoreBypass(type, entityId);
  const newScore = {
    ai: Math.max(0, currentScore.ai - (existingVote === "ai" ? 1 : 0)),
    total: Math.max(0, currentScore.total - 1),
  };

  await fetch(firebaseUrl(`aggregates/${type}/${entityId}`), {
    method: "PUT",
    body: JSON.stringify(newScore),
  });

  invalidateCache(`${type}:${entityId}`);
  setCache(`${type}:${entityId}`, newScore);
  return newScore;
}

/*
 * Fetch score bypassing cache. Used during read-modify-write operations
 * (submitVote, clearVote) to ensure we read the latest aggregate state
 * before applying local mutations. This reduces (though does not eliminate)
 * the window for concurrent vote conflicts.
 */
async function fetchScoreBypass(type, entityId) {
  try {
    const resp = await fetch(firebaseUrl(`aggregates/${type}/${entityId}`));
    if (!resp.ok) return { ai: 0, total: 0 };
    const data = await resp.json();
    return data
      ? { ai: data.ai || 0, total: data.total || 0 }
      : { ai: 0, total: 0 };
  } catch {
    return { ai: 0, total: 0 };
  }
}

// ============================================================
// Message handler from content script / popup
// ============================================================
/*
 * Background service worker must stay alive to handle async responses.
 * The return true statement keeps the message channel open until sendResponse
 * is called inside the async IIFE.
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.action) {
        case "getScore": {
          const score = await fetchScore(msg.type, msg.entityId);
          sendResponse({ success: true, score });
          break;
        }
        case "getScores": {
          // Batch fetch for thumbnails
          const results = {};
          const promises = msg.items.map(async (item) => {
            const score = await fetchScore(item.type, item.entityId);
            results[`${item.type}:${item.entityId}`] = score;
          });
          await Promise.all(promises);
          sendResponse({ success: true, results });
          break;
        }
        case "getMyVote": {
          const vote = await fetchMyVote(msg.type, msg.entityId);
          sendResponse({ success: true, vote });
          break;
        }
        case "vote": {
          const score = await submitVote(msg.type, msg.entityId, msg.vote);
          sendResponse({ success: true, score });
          break;
        }
        case "clearVote": {
          const score = await clearVote(msg.type, msg.entityId);
          sendResponse({ success: true, score });
          break;
        }
        default:
          sendResponse({ success: false, error: "Unknown action" });
      }
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
  })();
  return true; // keep message channel open for async response
});
