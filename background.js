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
  const entry = await fetchMyVoteEntry(type, entityId);
  return entry?.vote || null;
}

/*
 * Fetch the current user's full vote entry for an entity.
 * createdAt is persisted on first vote so we can identify the earliest
 * five active votes for leaderboard scoring.
 */
async function fetchMyVoteEntry(type, entityId) {
  const uuid = await getOrCreateUUID();
  try {
    const resp = await fetch(firebaseUrl(`votes/${type}/${entityId}/${uuid}`));
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data?.vote) return null;
    return {
      vote: data.vote,
      createdAt: Number.isFinite(data.createdAt) ? data.createdAt : null,
    };
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
  const existingEntry = await fetchMyVoteEntry(type, entityId);
  const existingVote = existingEntry?.vote || null;

  // No-op if user is re-voting the same way
  if (existingVote === vote) return await fetchScore(type, entityId);

  const createdAt = existingEntry?.createdAt || Date.now();
  const voteEntry = { vote, createdAt };

  // Write the vote
  await fetch(firebaseUrl(`votes/${type}/${entityId}/${uuid}`), {
    method: "PUT",
    body: JSON.stringify(voteEntry),
  });

  // Mirror to user_votes for stats tracking (avoids broad collection reads)
  await fetch(firebaseUrl(`user_votes/${uuid}/${type}/${entityId}`), {
    method: "PUT",
    body: JSON.stringify(voteEntry),
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
  const existingEntry = await fetchMyVoteEntry(type, entityId);
  const existingVote = existingEntry?.vote || null;

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
 * Fetch all active votes for a video or channel.
 */
async function fetchEntityVotes(type, entityId) {
  try {
    const resp = await fetch(firebaseUrl(`votes/${type}/${entityId}`));
    if (!resp.ok) return {};
    const data = await resp.json();
    return data || {};
  } catch {
    return {};
  }
}

const EARLY_VOTE_SAMPLE_SIZE = 5;

function buildEntityVoteCacheKey(type, entityId) {
  return `${type}:${entityId}`;
}

async function getEntityVotesCached(type, entityId, cache = new Map()) {
  const key = buildEntityVoteCacheKey(type, entityId);
  if (!cache.has(key)) cache.set(key, fetchEntityVotes(type, entityId));
  return await cache.get(key);
}

function getSortedActiveVotes(votesByUuid) {
  return Object.entries(votesByUuid || {})
    .filter(
      ([, entry]) => entry && (entry.vote === "ai" || entry.vote === "human"),
    )
    .map(([uuid, entry]) => ({
      uuid,
      vote: entry.vote,
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : null,
    }))
    .sort((a, b) => {
      if (a.createdAt === null || b.createdAt === null) return 0;
      return a.createdAt - b.createdAt || a.uuid.localeCompare(b.uuid);
    });
}

function getEarlyVoteWindow(votesByUuid) {
  const sortedVotes = getSortedActiveVotes(votesByUuid);
  if (sortedVotes.some((entry) => entry.createdAt === null)) return null;
  if (sortedVotes.length < EARLY_VOTE_SAMPLE_SIZE) return null;
  return sortedVotes.slice(0, EARLY_VOTE_SAMPLE_SIZE);
}

function getMajorityVote(votes) {
  if (!votes?.length) return null;
  const aiVotes = votes.filter((entry) => entry.vote === "ai").length;
  const humanVotes = votes.length - aiVotes;
  if (aiVotes === humanVotes) return null;
  return aiVotes > humanVotes ? "ai" : "human";
}

/*
 * A vote counts for leaderboard scoring only when:
 * 1. The entity has at least 5 active votes.
 * 2. The user is among the earliest 5 active voters for that entity.
 * 3. The user's vote matches the majority vote within those 5 votes.
 */
function isVoteCorrect(uuid, votesByUuid) {
  const earlyVotes = getEarlyVoteWindow(votesByUuid);
  if (!earlyVotes) return false;

  const myVote = earlyVotes.find((entry) => entry.uuid === uuid);
  if (!myVote) return false;

  const majorityVote = getMajorityVote(earlyVotes);
  return Boolean(majorityVote && myVote.vote === majorityVote);
}

/*
 * Fetch user stats from Firebase.
 */
async function fetchUserStats(uuid) {
  try {
    const resp = await fetch(firebaseUrl(`user_stats/${uuid}`));
    if (!resp.ok) return { totalVotes: 0, correctVotes: 0 };
    const data = await resp.json();
    return data
      ? {
          totalVotes: data.totalVotes || 0,
          correctVotes: data.correctVotes || 0,
        }
      : { totalVotes: 0, correctVotes: 0 };
  } catch {
    return { totalVotes: 0, correctVotes: 0 };
  }
}

/*
 * Write user stats to Firebase.
 */
async function writeUserStats(uuid, stats) {
  // Preserve username field if it exists
  const existing = await fetchUserStatsRaw(uuid);
  const merged = { ...existing, ...stats };
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
 * Recount leaderboard-eligible votes for a user using their personal
 * user_votes mirror. A vote only counts when it is part of the earliest
 * five active votes on an entity and agrees with that five-vote majority.
 */
async function recountCorrectVotes(uuid, entityVotesCache = new Map()) {
  try {
    const resp = await fetch(firebaseUrl(`user_votes/${uuid}`));
    if (!resp.ok) return { totalVotes: 0, correctVotes: 0 };
    const userVotes = await resp.json();
    if (!userVotes) return { totalVotes: 0, correctVotes: 0 };

    let correctCount = 0;
    let totalCount = 0;

    const promises = [];
    for (const type of ["video", "channel"]) {
      if (!userVotes[type]) continue;
      for (const [entityId, entry] of Object.entries(userVotes[type])) {
        if (!entry?.vote) continue;
        totalCount++;
        promises.push(
          getEntityVotesCached(type, entityId, entityVotesCache).then(
            (votesByUuid) => {
              if (isVoteCorrect(uuid, votesByUuid)) correctCount++;
            },
          ),
        );
      }
    }

    await Promise.all(promises);
    return { totalVotes: totalCount, correctVotes: correctCount };
  } catch {
    return null;
  }
}

/*
 * Refresh cached leaderboard stats for everyone affected by vote changes on
 * a single entity. This keeps the leaderboard consistent when the first-five
 * window or its majority changes.
 */
async function refreshStatsForAffectedUsers(type, entityId, extraUuids = []) {
  const entityVotes = await fetchEntityVotes(type, entityId);
  const entityVotesCache = new Map([
    [buildEntityVoteCacheKey(type, entityId), Promise.resolve(entityVotes)],
  ]);

  const uuids = new Set(extraUuids);
  for (const [uuid, entry] of Object.entries(entityVotes)) {
    if (entry?.vote) uuids.add(uuid);
  }

  await Promise.all(
    [...uuids].map(async (uuid) => {
      const newStats = await recountCorrectVotes(uuid, entityVotesCache);
      if (newStats) await writeUserStats(uuid, newStats);
    }),
  );
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
 * sorted by correctVotes descending.
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
          correctVotes: stats.correctVotes || 0,
          totalVotes: stats.totalVotes || 0,
        });
      }
    }

    // Sort by correctVotes desc, then totalVotes desc
    entries.sort((a, b) => {
      if (b.correctVotes !== a.correctVotes)
        return b.correctVotes - a.correctVotes;
      return b.totalVotes - a.totalVotes;
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
          await refreshStatsForAffectedUsers(msg.type, msg.entityId, [uuid]);

          sendResponse({ success: true, score });
          break;
        }
        case "clearVote": {
          const score = await clearVote(msg.type, msg.entityId);

          const uuid = await getOrCreateUUID();
          await refreshStatsForAffectedUsers(msg.type, msg.entityId, [uuid]);

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
