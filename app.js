// ---- PWA register ----
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try { await navigator.serviceWorker.register("./sw.js"); }
    catch (e) { console.warn("SW reg failed", e); }
  });
}

// ---- State ----
const STORAGE_KEY = "padelAmericanoState_v1";

const defaultState = () => ({
  settings: { courts: 1, maxPoints: 21 },
  players: [], // {id, name}
  order: [],   // array of player ids in current rotation order
  roundNo: 0,
  currentRound: null, // { roundNo, matches:[{id, court, teamA:[id,id], teamB:[id,id]}], sittingOut:[ids] }
  history: [], // finished matches: {roundNo, court, teamA, teamB, scoreA, scoreB, ts}
  scores: {}   // per player id: {points: number, matches: number}
});

let state = loadState();

// ---- DOM ----
const elCourts = document.getElementById("courts");
const elMaxPoints = document.getElementById("maxPoints");
const btnSaveSettings = document.getElementById("btnSaveSettings");
const btnReset = document.getElementById("btnReset");

const elPlayerName = document.getElementById("playerName");
const btnAddPlayer = document.getElementById("btnAddPlayer");
const btnShuffle = document.getElementById("btnShuffle");
const btnStartRound = document.getElementById("btnStartRound");

const elPlayersList = document.getElementById("playersList");
const elPlayersHint = document.getElementById("playersHint");

const elRoundArea = document.getElementById("roundArea");
const elStandingsArea = document.getElementById("standingsArea");
const elHistoryArea = document.getElementById("historyArea");

// ---- Helpers ----
function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return defaultState();
  try {
    const parsed = JSON.parse(raw);
    return { ...defaultState(), ...parsed };
  } catch {
    return defaultState();
  }
}

function ensureScoreRow(playerId) {
  if (!state.scores[playerId]) state.scores[playerId] = { points: 0, matches: 0 };
}

function playerNameById(id) {
  return state.players.find(p => p.id === id)?.name ?? "Okänd";
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Rotate list by moving first to end (simple v1)
function rotateOrder(order) {
  if (order.length <= 1) return order;
  return [...order.slice(1), order[0]];
}

// ---- Core: round generation ----
function generateNextRound() {
  const courts = clampInt(state.settings.courts, 1, 8);
  const needed = courts * 4;

  if (state.players.length < 4) {
    alert("Minst 4 spelare krävs.");
    return;
  }

  // init order if missing or contains removed players
  const existingIds = new Set(state.players.map(p => p.id));
  state.order = (state.order || []).filter(id => existingIds.has(id));
  if (state.order.length !== state.players.length) {
    // if new/removed players: rebuild order (keep existing order then append missing)
    const missing = state.players.map(p => p.id).filter(id => !state.order.includes(id));
    state.order = [...state.order, ...missing];
  }

  // rotate order each round (simple rotation)
  state.order = rotateOrder(state.order);

  const playingIds = state.order.slice(0, needed);
  const sittingOut = state.order.slice(needed);

  // if not enough to fill all courts, reduce courts for this round
  const activeCourts = Math.floor(playingIds.length / 4);
  const matches = [];
  for (let c = 0; c < activeCourts; c++) {
    const base = c * 4;
    const p1 = playingIds[base + 0];
    const p2 = playingIds[base + 1];
    const p3 = playingIds[base + 2];
    const p4 = playingIds[base + 3];

    matches.push({
      id: uid(),
      court: c + 1,
      teamA: [p1, p2],
      teamB: [p3, p4]
    });
  }

  state.roundNo += 1;
  state.currentRound = {
    roundNo: state.roundNo,
    matches,
    sittingOut
  };

  saveState();
  renderAll();
}

// ---- Scoring (Americano points) ----
function submitMatchScore(matchId, scoreA, scoreB) {
  const round = state.currentRound;
  if (!round) return;

  const match = round.matches.find(m => m.id === matchId);
  if (!match) return;

  const maxPoints = clampInt(state.settings.maxPoints, 5, 99);

  if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0) {
    alert("Skriv in giltiga heltal (0 eller mer).");
    return;
  }
  if (scoreA > maxPoints || scoreB > maxPoints) {
    alert(`Poäng får inte överstiga maxpoäng (${maxPoints}).`);
    return;
  }
  if (scoreA === scoreB) {
    alert("Oavgjort stöds inte i v1. Justera resultatet.");
    return;
  }
  if (scoreA !== maxPoints && scoreB !== maxPoints) {
    alert(`En sida måste nå maxpoäng (${maxPoints}) i v1.`);
    return;
  }

  // Apply americano points: each player gets team's score
  const teamA = match.teamA;
  const teamB = match.teamB;

  for (const pid of teamA) {
    ensureScoreRow(pid);
    state.scores[pid].points += scoreA;
    state.scores[pid].matches += 1;
  }
  for (const pid of teamB) {
    ensureScoreRow(pid);
    state.scores[pid].points += scoreB;
    state.scores[pid].matches += 1;
  }

  // save to history
  state.history.unshift({
    roundNo: round.roundNo,
    court: match.court,
    teamA,
    teamB,
    scoreA,
    scoreB,
    ts: new Date().toISOString()
  });

  // remove match from current round (mark finished)
  round.matches = round.matches.filter(m => m.id !== matchId);

  // if all matches finished -> clear current round
  if (round.matches.length === 0) state.currentRound = null;

  saveState();
  renderAll();
}

function clampInt(x, min, max) {
  const n = Number.parseInt(String(x), 10);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

// ---- Players ----
function addPlayer(name) {
  const clean = (name || "").trim();
  if (!clean) return;

  // prevent duplicates by name (case-insensitive)
  const exists = state.players.some(p => p.name.toLowerCase() === clean.toLowerCase());
  if (exists) {
    alert("Spelare med samma namn finns redan.");
    return;
  }

  const id = uid();
  state.players.push({ id, name: clean });
  ensureScoreRow(id);

  // append to order for stable rotation
  state.order.push(id);

  saveState();
  renderAll();
}

function removePlayer(id) {
  const p = state.players.find(x => x.id === id);
  if (!p) return;

  // block remove if player is in current round match
  if (state.currentRound) {
    const inMatch = state.currentRound.matches.some(m => m.teamA.includes(id) || m.teamB.includes(id));
    if (inMatch) {
      alert("Kan inte ta bort en spelare som är med i aktuell rond. Avsluta rond först.");
      return;
    }
  }

  state.players = state.players.filter(x => x.id !== id);
  state.order = state.order.filter(x => x !== id);
  delete state.scores[id];

  // also remove from history (optional: keep history; here we keep but names might be missing)
  saveState();
  renderAll();
}

function shufflePlayersOrder() {
  state.order = shuffleArray(state.players.map(p => p.id));
  saveState();
  renderAll();
}

// ---- Settings ----
function saveSettingsFromUI() {
  const courts = clampInt(elCourts.value, 1, 8);
  const maxPoints = clampInt(elMaxPoints.value, 5, 99);

  state.settings.courts = courts;
  state.settings.maxPoints = maxPoints;

  saveState();
  renderAll();
}

// ---- Render ----
function renderPlayers() {
  elPlayersList.innerHTML = "";

  const players = state.players;
  const courts = clampInt(state.settings.courts, 1, 8);
  const needed = courts * 4;

  for (const p of players) {
    const li = document.createElement("li");

    const left = document.createElement("div");
    left.innerHTML = `<strong>${escapeHtml(p.name)}</strong>`;

    const right = document.createElement("div");
    right.className = "row";
    right.style.margin = "0";

    const btnDel = document.createElement("button");
    btnDel.className = "btn btn--danger";
    btnDel.textContent = "Ta bort";
    btnDel.addEventListener("click", () => removePlayer(p.id));

    right.appendChild(btnDel);
    li.appendChild(left);
    li.appendChild(right);
    elPlayersList.appendChild(li);
  }

  if (players.length < 4) {
    elPlayersHint.textContent = "Lägg till minst 4 spelare för att starta.";
  } else if (players.length < needed) {
    elPlayersHint.textContent = `Ni är ${players.length} spelare. Med ${courts} bana/baneor behövs ${needed} för att fylla allt – appen kommer bara använda ${Math.floor(players.length/4)} bana/baneor denna rond.`;
  } else if (players.length > needed) {
    elPlayersHint.textContent = `Ni är ${players.length} spelare. Med ${courts} bana/baneor spelar ${needed} per rond, övriga vilar.`;
  } else {
    elPlayersHint.textContent = `Perfekt. ${needed} spelare fyller ${courts} bana/baneor.`;
  }
}

function renderRound() {
  elRoundArea.innerHTML = "";

  if (!state.currentRound) {
    elRoundArea.innerHTML = `<p class="muted">Ingen aktiv rond just nu. Skapa nästa rond.</p>`;
    return;
  }

  const round = state.currentRound;

  if (round.sittingOut.length > 0) {
    const sit = document.createElement("div");
    sit.className = "small";
    sit.textContent = `Vilar: ${round.sittingOut.map(playerNameById).join(", ")}`;
    elRoundArea.appendChild(sit);
  }

  if (round.matches.length === 0) {
    elRoundArea.innerHTML += `<p class="muted">Alla matcher i ronden är klara.</p>`;
    return;
  }

  for (const m of round.matches) {
    const wrap = document.createElement("div");
    wrap.className = "match";

    wrap.innerHTML = `
      <div class="match__top">
        <div><strong>Rond ${round.roundNo}</strong> <span class="badge">Bana ${m.court}</span></div>
        <div class="badge">Max: ${state.settings.maxPoints}</div>
      </div>

      <div class="match__teams">
        <div class="pair">
          <div><strong>${escapeHtml(playerNameById(m.teamA[0]))}</strong> &amp; <strong>${escapeHtml(playerNameById(m.teamA[1]))}</strong></div>
          <div class="badge">Lag A</div>
        </div>
        <div class="vs">vs</div>
        <div class="pair">
          <div><strong>${escapeHtml(playerNameById(m.teamB[0]))}</strong> &amp; <strong>${escapeHtml(playerNameById(m.teamB[1]))}</strong></div>
          <div class="badge">Lag B</div>
        </div>
      </div>
    `;

    const scoreRow = document.createElement("div");
    scoreRow.className = "scoreRow";

    const inputA = document.createElement("input");
    inputA.type = "number";
    inputA.min = "0";
    inputA.max = String(state.settings.maxPoints);
    inputA.placeholder = "Lag A";
    inputA.inputMode = "numeric";

    const inputB = document.createElement("input");
    inputB.type = "number";
    inputB.min = "0";
    inputB.max = String(state.settings.maxPoints);
    inputB.placeholder = "Lag B";
    inputB.inputMode = "numeric";

    const btn = document.createElement("button");
    btn.className = "btn btn--primary";
    btn.textContent = "Spara resultat";

    btn.addEventListener("click", () => {
      const a = Number.parseInt(inputA.value, 10);
      const b = Number.parseInt(inputB.value, 10);
      submitMatchScore(m.id, a, b);
    });

    scoreRow.appendChild(inputA);
    scoreRow.appendChild(inputB);
    scoreRow.appendChild(btn);

    wrap.appendChild(scoreRow);
    elRoundArea.appendChild(wrap);
  }
}

function renderStandings() {
  const rows = state.players.map(p => {
    ensureScoreRow(p.id);
    return {
      name: p.name,
      points: state.scores[p.id].points,
      matches: state.scores[p.id].matches
    };
  }).sort((a,b) => b.points - a.points);

  if (rows.length === 0) {
    elStandingsArea.innerHTML = `<p class="muted">Inga spelare än.</p>`;
    return;
  }

  const table = document.createElement("table");
  table.className = "table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>#</th>
        <th>Spelare</th>
        <th>Poäng</th>
        <th>Matcher</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map((r, i) => `
        <tr>
          <td>${i+1}</td>
          <td>${escapeHtml(r.name)}</td>
          <td>${r.points}</td>
          <td>${r.matches}</td>
        </tr>
      `).join("")}
    </tbody>
  `;
  elStandingsArea.innerHTML = "";
  elStandingsArea.appendChild(table);
}

function renderHistory() {
  const h = state.history;
  if (!h.length) {
    elHistoryArea.innerHTML = `<p class="muted">Inga matcher spelade ännu.</p>`;
    return;
  }

  const items = h.slice(0, 20).map(m => {
    const a = `${playerNameById(m.teamA[0])} & ${playerNameById(m.teamA[1])}`;
    const b = `${playerNameById(m.teamB[0])} & ${playerNameById(m.teamB[1])}`;
    return `
      <div class="match">
        <div class="match__top">
          <div><strong>Rond ${m.roundNo}</strong> <span class="badge">Bana ${m.court}</span></div>
          <div class="badge">${new Date(m.ts).toLocaleString("sv-SE")}</div>
        </div>
        <div class="small">${escapeHtml(a)} <span class="vs">vs</span> ${escapeHtml(b)}</div>
        <div><strong>${m.scoreA}</strong> – <strong>${m.scoreB}</strong></div>
      </div>
    `;
  }).join("");

  elHistoryArea.innerHTML = `<div class="stack">${items}</div>`;
}

function renderSettings() {
  elCourts.value = String(state.settings.courts);
  elMaxPoints.value = String(state.settings.maxPoints);
}

function renderAll() {
  renderSettings();
  renderPlayers();
  renderRound();
  renderStandings();
  renderHistory();
}

// ---- Events ----
btnSaveSettings.addEventListener("click", saveSettingsFromUI);

btnAddPlayer.addEventListener("click", () => {
  addPlayer(elPlayerName.value);
  elPlayerName.value = "";
  elPlayerName.focus();
});

elPlayerName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    addPlayer(elPlayerName.value);
    elPlayerName.value = "";
  }
});

btnShuffle.addEventListener("click", () => {
  if (state.players.length < 2) return;
  shufflePlayersOrder();
});

btnStartRound.addEventListener("click", () => {
  generateNextRound();
});

btnReset.addEventListener("click", () => {
  const ok = confirm("Nollställa allt? Detta tar bort spelare, tabell och historik.");
  if (!ok) return;
  state = defaultState();
  saveState();
  renderAll();
});

// ---- Utils ----
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ---- Init ----
(function init() {
  // Ensure scores exists for existing players
  for (const p of state.players) ensureScoreRow(p.id);
  // Ensure order exists
  if (!Array.isArray(state.order) || state.order.length === 0) {
    state.order = state.players.map(p => p.id);
  }
  saveState();
  renderAll();
})();
