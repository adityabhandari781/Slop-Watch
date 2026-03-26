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

  // Mirror to user_votes for stats tracking (avoids broad collection reads)
  await fetch(firebaseUrl(`user_votes/${uuid}/${type}/${entityId}`), {
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

  // Remove from user_votes mirror
  await fetch(firebaseUrl(`user_votes/${uuid}/${type}/${entityId}`), {
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
// User Stats & Leaderboard helpers
// ============================================================

/*
 * Fetch user stats from Firebase.
 */
async function fetchUserStats(uuid) {
  try {
    const resp = await fetch(firebaseUrl(`user_stats/${uuid}`));
    if (!resp.ok) return { totalVotes: 0 };
    const data = await resp.json();
    return data
      ? {
          totalVotes: data.totalVotes || 0,
        }
      : { totalVotes: 0 };
  } catch {
    return { totalVotes: 0 };
  }
}

/*
 * Write user stats to Firebase.
 */
async function writeUserStats(uuid, stats) {
  // Preserve username field if it exists
  const existing = await fetchUserStatsRaw(uuid);
  const merged = { ...existing, ...stats };
  delete merged.correctVotes;
  await fetch(firebaseUrl(`user_stats/${uuid}`), {
    method: "PUT",
    body: JSON.stringify(merged),
  });
}

async function fetchUserStatsRaw(uuid) {
  try {
    const resp = await fetch(firebaseUrl(`user_stats/${uuid}`));
    if (!resp.ok) return {};
    const data = await resp.json();
    return data || {};
  } catch {
    return {};
  }
}

/*
 * Recount a user's total active votes from the user_votes mirror.
 */
async function recountUserStats(uuid) {
  try {
    const resp = await fetch(firebaseUrl(`user_votes/${uuid}`));
    if (!resp.ok) return { totalVotes: 0 };
    const userVotes = await resp.json();
    if (!userVotes) return { totalVotes: 0 };

    let totalCount = 0;

    for (const type of ["video", "channel"]) {
      if (!userVotes[type]) continue;
      for (const entry of Object.values(userVotes[type])) {
        if (!entry?.vote) continue;
        totalCount++;
      }
    }

    return { totalVotes: totalCount };
  } catch {
    return null;
  }
}

/*
 * Fetch username for a UUID.
 */
async function fetchUsername(uuid) {
  try {
    const resp = await fetch(firebaseUrl(`usernames/${uuid}`));
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.username || null;
  } catch {
    return null;
  }
}

/*
 * Set username for a UUID. Checks for uniqueness by scanning existing usernames.
 */
async function setUsername(uuid, username) {
  // Check uniqueness
  try {
    const resp = await fetch(firebaseUrl("usernames"));
    if (resp.ok) {
      const all = await resp.json();
      if (all) {
        for (const [existingUuid, entry] of Object.entries(all)) {
          if (
            existingUuid !== uuid &&
            entry.username &&
            entry.username.toLowerCase() === username.toLowerCase()
          ) {
            return { success: false, error: "Username already taken." };
          }
        }
      }
    }
  } catch {}

  try {
    // Save username in usernames/{uuid}
    const writeResp = await fetch(firebaseUrl(`usernames/${uuid}`), {
      method: "PUT",
      body: JSON.stringify({ username }),
    });
    if (!writeResp.ok) {
      const errBody = await writeResp.text().catch(() => "");
      return {
        success: false,
        error: `Failed to save (${writeResp.status}): ${errBody}`,
      };
    }

    // Also save in user_stats for leaderboard convenience
    const raw = await fetchUserStatsRaw(uuid);
    delete raw.correctVotes;
    raw.username = username;
    const statsResp = await fetch(firebaseUrl(`user_stats/${uuid}`), {
      method: "PUT",
      body: JSON.stringify(raw),
    });
    if (!statsResp.ok) {
      const errBody = await statsResp.text().catch(() => "");
      return {
        success: false,
        error: `Failed to update stats (${statsResp.status}): ${errBody}`,
      };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message || "Network error." };
  }
}

/*
 * Fetch full leaderboard: all user_stats entries that have a username,
 * sorted by totalVotes descending.
 */
async function fetchLeaderboard() {
  try {
    const resp = await fetch(firebaseUrl("user_stats"));
    if (!resp.ok) return [];
    const all = await resp.json();
    if (!all) return [];

    const entries = [];
    for (const [uuid, stats] of Object.entries(all)) {
      if (stats.username) {
        entries.push({
          uuid,
          username: stats.username,
          totalVotes: stats.totalVotes || 0,
        });
      }
    }

    // Sort by totalVotes desc, then username asc for stable ordering
    entries.sort((a, b) => {
      if (b.totalVotes !== a.totalVotes) return b.totalVotes - a.totalVotes;
      return a.username.localeCompare(b.username);
    });

    // Assign ranks
    entries.forEach((e, i) => (e.rank = i + 1));

    return entries;
  } catch {
    return [];
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

          const uuid = await getOrCreateUUID();
          const newStats = await recountUserStats(uuid);
          if (newStats) await writeUserStats(uuid, newStats);

          sendResponse({ success: true, score });
          break;
        }
        case "clearVote": {
          const score = await clearVote(msg.type, msg.entityId);

          const uuid = await getOrCreateUUID();
          const newStats = await recountUserStats(uuid);
          if (newStats) await writeUserStats(uuid, newStats);

          sendResponse({ success: true, score });
          break;
        }
        case "getUserStats": {
          const uuid = await getOrCreateUUID();
          const stats = await fetchUserStats(uuid);
          sendResponse({ success: true, stats });
          break;
        }
        case "getUsername": {
          const uuid = await getOrCreateUUID();
          const username = await fetchUsername(uuid);
          sendResponse({ success: true, username });
          break;
        }
        case "setUsername": {
          const uuid = await getOrCreateUUID();
          const result = await setUsername(uuid, msg.username);
          sendResponse(result);
          break;
        }
        case "getLeaderboard": {
          const uuid = await getOrCreateUUID();
          const leaderboard = await fetchLeaderboard();
          sendResponse({ success: true, leaderboard, userUuid: uuid });
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
