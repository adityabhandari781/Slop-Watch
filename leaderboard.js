// ============================================================
// Slop Watch: Leaderboard Script
// ============================================================

/*
 * Communicates with the background script to fetch user stats,
 * manage usernames, and display the global leaderboard.
 */

function sendMsg(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(response);
      });
    } catch {
      resolve(null);
    }
  });
}

// ============================================================
// DOM References
// ============================================================
const els = {};

document.addEventListener("DOMContentLoaded", async () => {
  els.totalVotes = document.getElementById("total-votes");
  els.totalRank = document.getElementById("total-rank");
  els.usernameInput = document.getElementById("username-input");
  els.usernameSave = document.getElementById("username-save");
  els.usernameMsg = document.getElementById("username-msg");
  els.leaderboardBody = document.getElementById("leaderboard-body");

  await loadAll();

  els.usernameSave.addEventListener("click", saveUsername);
  els.usernameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveUsername();
  });
});

// ============================================================
// Load all data
// ============================================================
async function loadAll() {
  const [statsResp, nameResp, lbResp] = await Promise.all([
    sendMsg({ action: "getUserStats" }),
    sendMsg({ action: "getUsername" }),
    sendMsg({ action: "getLeaderboard" }),
  ]);

  // User stats
  if (statsResp?.success) {
    els.totalVotes.textContent = statsResp.stats.totalVotes;
  } else {
    els.totalVotes.textContent = "0";
  }

  // Username
  let currentUsername = null;
  if (nameResp?.success && nameResp.username) {
    currentUsername = nameResp.username;
    els.usernameInput.value = currentUsername;
  }

  // Leaderboard
  if (lbResp?.success && lbResp.leaderboard.length > 0) {
    renderLeaderboard(lbResp.leaderboard, lbResp.userUuid);

    // Show ranks if user has a username
    if (currentUsername) {
      const userEntry = lbResp.leaderboard.find(
        (e) => e.uuid === lbResp.userUuid,
      );
      if (userEntry) {
        els.totalRank.textContent = `Rank #${userEntry.rank}`;
      }
    }
  } else {
    els.leaderboardBody.innerHTML =
      '<tr><td colspan="3" class="lb-table__empty">No leaderboard data yet. Start voting!</td></tr>';
  }
}

// ============================================================
// Render leaderboard table
// ============================================================
function renderLeaderboard(entries, userUuid) {
  els.leaderboardBody.innerHTML = "";

  entries.forEach((entry) => {
    const tr = document.createElement("tr");
    const isYou = entry.uuid === userUuid;
    if (isYou) tr.classList.add("lb-table__row--you");

    // Rank
    const tdRank = document.createElement("td");
    tdRank.className = "lb-table__rank";
    if (entry.rank <= 3) tdRank.classList.add(`lb-table__rank--${entry.rank}`);
    const medals = { 1: "🥇", 2: "🥈", 3: "🥉" };
    tdRank.textContent = medals[entry.rank] || entry.rank;

    // Username
    const tdUser = document.createElement("td");
    tdUser.className = "lb-table__user";
    if (isYou) tdUser.classList.add("lb-table__user--you");
    tdUser.textContent = entry.username + (isYou ? " (you)" : "");

    // Total votes
    const tdTotal = document.createElement("td");
    tdTotal.className = "lb-table__total";
    tdTotal.textContent = entry.totalVotes;

    tr.append(tdRank, tdUser, tdTotal);
    els.leaderboardBody.appendChild(tr);
  });
}

// ============================================================
// Save username
// ============================================================
async function saveUsername() {
  const name = els.usernameInput.value.trim();
  if (!name) {
    showMsg("Please enter a username.", "error");
    return;
  }

  if (name.length < 2 || name.length > 24) {
    showMsg("Username must be 2–24 characters.", "error");
    return;
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    showMsg("Only letters, numbers, _ and - allowed.", "error");
    return;
  }

  els.usernameSave.disabled = true;
  els.usernameSave.textContent = "Saving…";

  const resp = await sendMsg({ action: "setUsername", username: name });

  if (resp?.success) {
    showMsg("Username saved! ✓", "success");
    await loadAll(); // refresh leaderboard & ranks
  } else {
    showMsg(resp?.error || "Failed to save username.", "error");
  }

  els.usernameSave.disabled = false;
  els.usernameSave.textContent = "Save";
}

function showMsg(text, type) {
  els.usernameMsg.textContent = text;
  els.usernameMsg.className = `username-msg username-msg--${type}`;
  setTimeout(() => {
    els.usernameMsg.textContent = "";
    els.usernameMsg.className = "username-msg";
  }, 4000);
}
