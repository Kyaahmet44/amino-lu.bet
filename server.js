const http = require("http");
const https = require("https");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.FOOTBALL_DATA_TOKEN || "1b40b78c1b0347b79f544c80437f5a3a";
const API_BASE = "https://api.football-data.org/v4";
const CACHE_TTL_MS = 60 * 1000;

const LEAGUES = {
  TSL: "Super Lig",
  PL: "Premier League",
  PD: "La Liga",
  SA: "Serie A",
  BL1: "Bundesliga",
};

const cache = new Map();

function send(res, statusCode, body, contentType) {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendJson(res, statusCode, data) {
  send(res, statusCode, JSON.stringify(data), "application/json; charset=utf-8");
}

function apiGet(pathname) {
  const now = Date.now();
  const cached = cache.get(pathname);
  if (cached && now - cached.time < CACHE_TTL_MS) {
    return Promise.resolve(cached.data);
  }

  return new Promise((resolve, reject) => {
    const url = new URL(`${API_BASE}${pathname}`);
    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          "X-Auth-Token": API_TOKEN,
          Accept: "application/json",
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`football-data API ${res.statusCode}: ${raw.slice(0, 300)}`));
            return;
          }

          try {
            const parsed = JSON.parse(raw);
            cache.set(pathname, { time: now, data: parsed });
            resolve(parsed);
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on("error", reject);
    req.end();
  });
}

function normalizeStatus(status) {
  if (status === "LIVE" || status === "IN_PLAY" || status === "PAUSED") return "Canli";
  if (status === "FINISHED") return "Bitti";
  return "Baslamadi";
}

function normalizeMinute(match) {
  if (match.status === "TIMED" || match.status === "SCHEDULED") {
    return new Date(match.utcDate).toLocaleTimeString("tr-TR", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (match.status === "FINISHED") return "MS";
  if (match.status === "PAUSED") return "Devre";
  return "Canli";
}

function matchInsight(match) {
  if (match.status === "FINISHED") return "Mac tamamlandi, sonuc tabloya yansidi.";
  if (match.status === "TIMED" || match.status === "SCHEDULED") return "Baslangic saati netlesti.";
  if (match.status === "LIVE" || match.status === "IN_PLAY") return "Canli akista skor degisebilir.";
  return "Mac verisi guncelleniyor.";
}

function mapMatch(match) {
  return {
    id: match.id,
    league: match.competition?.name || "Lig",
    status: normalizeStatus(match.status),
    minute: normalizeMinute(match),
    home: match.homeTeam?.shortName || match.homeTeam?.name || "Ev Sahibi",
    away: match.awayTeam?.shortName || match.awayTeam?.name || "Deplasman",
    homeScore: match.score?.fullTime?.home ?? match.score?.halfTime?.home ?? "-",
    awayScore: match.score?.fullTime?.away ?? match.score?.halfTime?.away ?? "-",
    venue: match.area?.name || "Stadyum bilgisi yok",
    kickoff: new Date(match.utcDate).toLocaleTimeString("tr-TR", {
      hour: "2-digit",
      minute: "2-digit",
    }),
    channel: "API Verisi",
    insight: matchInsight(match),
  };
}

function mapStandingTable(table) {
  return (table || []).slice(0, 8).map((team, index) => [
    String(index + 1),
    team.team?.shortName || team.team?.name || "Takim",
    String(team.playedGames ?? 0),
    String(team.won ?? 0),
    String(team.draw ?? 0),
    String(team.lost ?? 0),
    String((team.goalDifference ?? 0) > 0 ? `+${team.goalDifference}` : team.goalDifference ?? 0),
    String(team.points ?? 0),
  ]);
}

function mapScorers(scorers) {
  return (scorers || []).slice(0, 5).map((item) => ({
    player: item.player?.name || "Oyuncu",
    team: item.team?.shortName || item.team?.name || "Takim",
    goals: item.goals ?? 0,
  }));
}

async function buildBootstrap() {
  const codes = Object.keys(LEAGUES);
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - 2);
  const to = new Date(today);
  to.setDate(today.getDate() + 6);
  const dateFrom = from.toISOString().slice(0, 10);
  const dateTo = to.toISOString().slice(0, 10);

  const results = await Promise.allSettled([
    ...codes.map((code) =>
      apiGet(`/competitions/${code}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`)
    ),
    ...codes.map((code) => apiGet(`/competitions/${code}/standings`)),
    ...codes.map((code) => apiGet(`/competitions/${code}/scorers`)),
  ]);

  const matchResults = results.slice(0, codes.length);
  const standingsResults = results.slice(codes.length, codes.length * 2);
  const scorersResults = results.slice(codes.length * 2);
  const standingsByLeague = {};
  const scorersByLeague = {};
  const matches = [];

  matchResults.forEach((result) => {
    if (result.status === "fulfilled") {
      matches.push(...(result.value?.matches || []).map(mapMatch));
    }
  });

  if (!matches.length) {
    throw new Error("Mac verisi alinmadi");
  }

  standingsResults.forEach((result, index) => {
    const code = codes[index];
    if (result.status === "fulfilled") {
      const table = result.value?.standings?.find((row) => row.type === "TOTAL")?.table || [];
      standingsByLeague[code] = mapStandingTable(table);
    } else {
      standingsByLeague[code] = [];
    }
  });

  scorersResults.forEach((result, index) => {
    const code = codes[index];
    scorersByLeague[code] =
      result.status === "fulfilled" ? mapScorers(result.value?.scorers || []) : [];
  });

  return {
    brand: "Aminoglu.bet",
    leagues: LEAGUES,
    lastUpdated: new Date().toISOString(),
    matches: matches
      .sort((a, b) => {
        const statusOrder = { Canli: 0, Baslamadi: 1, Bitti: 2 };
        const left = statusOrder[a.status] ?? 9;
        const right = statusOrder[b.status] ?? 9;
        if (left !== right) return left - right;
        return a.kickoff.localeCompare(b.kickoff);
      })
      .slice(0, 40),
    standingsByLeague,
    scorersByLeague,
  };
}

const html = `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Aminoglu.bet</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <style>
    :root { --bg:#f4efe7; --bg-strong:#eadbc8; --surface:rgba(255,252,247,.84); --surface-strong:#fffaf2; --text:#1d1b18; --muted:#6c6458; --line:rgba(29,27,24,.08); --accent:#da3b22; --accent-2:#f1a208; --success:#118c4f; --danger:#b83232; --shadow:0 18px 50px rgba(56,40,18,.12); }
    body.dark { --bg:#121722; --bg-strong:#1b2433; --surface:rgba(16,22,33,.84); --surface-strong:#161d29; --text:#eef2f7; --muted:#98a3b3; --line:rgba(255,255,255,.08); --accent:#ff6b35; --accent-2:#ffba08; --shadow:0 18px 60px rgba(0,0,0,.28); }
    * { box-sizing:border-box; } body { margin:0; min-height:100vh; font-family:"Barlow",sans-serif; background:radial-gradient(circle at top left, rgba(241,162,8,.2), transparent 28%), linear-gradient(135deg, var(--bg), var(--bg-strong)); color:var(--text); }
    button,input { font:inherit; } .app-shell { display:grid; grid-template-columns:290px 1fr; min-height:100vh; } .sidebar { padding:28px; border-right:1px solid var(--line); background:rgba(255,255,255,.08); backdrop-filter:blur(18px); }
    .brand,.topbar,.section-header,.match-head,.match-teams,.match-meta,.detail-scoreline,.detail-meta,.scorer-row,.bulletin-meta { display:flex; align-items:center; }
    .brand { gap:14px; } .brand-mark { display:grid; place-items:center; width:52px; height:52px; border-radius:18px; background:linear-gradient(135deg, var(--accent), var(--accent-2)); color:#fff; font-weight:800; font-size:1.5rem; box-shadow:var(--shadow); }
    .eyebrow,.section-kicker,.mini-title { margin:0; color:var(--muted); text-transform:uppercase; letter-spacing:.12em; font-size:.72rem; font-weight:700; }
    .brand h1,.topbar h2,.hero h3,.section-header h3,.sidebar-card h2 { margin:0; } .sidebar-nav { display:grid; gap:10px; margin:34px 0; }
    .nav-item,.chip,.standings-chip,.ghost-button,.accent-button { border:0; border-radius:999px; cursor:pointer; transition:.2s; }
    .nav-item { padding:14px 16px; background:transparent; color:var(--text); text-align:left; border:1px solid var(--line); }
    .nav-item.active,.nav-item:hover { background:var(--surface-strong); transform:translateX(4px); }
    .sidebar-card,.hero,.table-card,.match-card,.bulletin-card,.detail-card { background:var(--surface); border:1px solid var(--line); box-shadow:var(--shadow); backdrop-filter:blur(18px); }
    .sidebar-card { padding:20px; border-radius:28px; } .compact-card { margin-top:16px; } .content { padding:28px; } .topbar,.section-header { justify-content:space-between; gap:16px; } .topbar-actions { display:flex; gap:12px; flex-wrap:wrap; }
    .ghost-button,.accent-button,.chip,.standings-chip { padding:12px 18px; } .ghost-button { background:transparent; color:var(--text); border:1px solid var(--line); } .accent-button { background:linear-gradient(135deg, var(--accent), #ef5d3c); color:#fff; }
    .hero { margin-top:24px; padding:24px; border-radius:30px; justify-content:space-between; gap:16px; } .hero-copy { max-width:620px; } .hero-copy p:last-child,.sidebar-card p:last-child,.bulletin-card p,.detail-card p { color:var(--muted); line-height:1.6; }
    .hero-metrics { display:grid; grid-template-columns:repeat(4, minmax(110px, 1fr)); gap:14px; width:min(540px, 100%); } .hero-metrics article { padding:18px; border-radius:24px; background:rgba(255,255,255,.1); border:1px solid var(--line); } .hero-metrics strong { display:block; font-size:1.8rem; }
    .league-filter,.standings-filter { display:flex; flex-wrap:wrap; gap:10px; } .league-filter { margin:24px 0 10px; } .standings-filter { margin-top:18px; } .chip,.standings-chip { background:rgba(255,255,255,.32); color:var(--text); border:1px solid var(--line); }
    .chip.active { background:var(--text); color:var(--surface-strong); } .standings-chip.active { background:var(--accent); color:#fff; border-color:transparent; }
    .api-banner { margin-top:8px; padding:12px 16px; border-radius:18px; background:rgba(17,140,79,.12); color:var(--success); border:1px solid rgba(17,140,79,.18); } .api-banner.error { background:rgba(184,50,50,.12); color:var(--danger); border-color:rgba(184,50,50,.18); }
    .panel { display:none; margin-top:18px; } .panel.active { display:block; } #searchInput { width:min(320px,100%); padding:14px 16px; border-radius:18px; border:1px solid var(--line); background:var(--surface); color:var(--text); }
    .dashboard-layout,.analytics-grid { display:grid; gap:18px; margin-top:18px; } .dashboard-layout { grid-template-columns:minmax(0,1.6fr) minmax(320px,.9fr); } .analytics-grid { grid-template-columns:minmax(0,1.3fr) minmax(280px,.8fr); }
    .match-grid,.bulletin-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(280px,1fr)); gap:18px; } .match-card,.bulletin-card,.detail-card { padding:18px; border-radius:28px; } .match-card.active { outline:2px solid rgba(218,59,34,.25); }
    .match-head,.match-meta,.detail-scoreline,.detail-meta,.bulletin-meta,.scorer-row { justify-content:space-between; gap:10px; }
    .match-card .primary-button,.favorite-button { margin-top:12px; width:100%; padding:12px; border:1px solid var(--line); border-radius:18px; background:transparent; color:var(--text); cursor:pointer; }
    .favorite-button.active,.primary-button { background:var(--text); color:var(--surface-strong); }
    .match-teams { justify-content:space-between; gap:12px; margin:20px 0 14px; } .team { display:flex; align-items:center; gap:12px; } .team-badge { display:grid; place-items:center; width:42px; height:42px; border-radius:14px; background:linear-gradient(135deg, rgba(218,59,34,.12), rgba(241,162,8,.18)); font-weight:800; }
    .team-name { font-weight:700; } .score { min-width:68px; text-align:center; } .score strong,.detail-scoreline strong { display:block; font-size:2rem; }
    .status-pill,.minute-pill,.detail-pill,.bulletin-tag { padding:7px 11px; border-radius:999px; font-size:.8rem; font-weight:700; } .status-live { background:rgba(17,140,79,.14); color:var(--success); } .status-upcoming { background:rgba(241,162,8,.18); color:#9a6300; } .status-finished { background:rgba(184,50,50,.12); color:var(--danger); }
    .detail-pill,.bulletin-tag { background:rgba(218,59,34,.12); color:var(--accent); } .match-meta,.scorer-meta,.detail-list li { color:var(--muted); font-size:.92rem; }
    .detail-card { position:sticky; top:24px; align-self:start; } .detail-card h3,.bulletin-card h4 { margin:10px 0 6px; } .detail-list { margin:16px 0 0; padding-left:18px; }
    .table-card { padding:12px; border-radius:28px; overflow:hidden; } table { width:100%; border-collapse:collapse; } th,td { padding:14px 12px; border-bottom:1px solid var(--line); text-align:left; } tbody tr:last-child td { border-bottom:0; }
    .scorers-list { display:grid; gap:12px; margin-top:14px; } .scorer-row { padding:12px; border-radius:18px; border:1px solid var(--line); background:rgba(255,255,255,.06); } .scorer-name { font-weight:700; } .scorer-meta { margin-top:4px; } .bulletin-grid { margin-top:18px; }
    .empty-state { padding:24px; border-radius:24px; border:1px dashed var(--line); color:var(--muted); }
    @media (max-width:1180px) { .dashboard-layout,.analytics-grid { grid-template-columns:1fr; } .detail-card { position:static; } }
    @media (max-width:960px) { .app-shell { grid-template-columns:1fr; } .sidebar { border-right:0; border-bottom:1px solid var(--line); } .hero,.topbar,.section-header { flex-direction:column; align-items:flex-start; } .hero-metrics { grid-template-columns:repeat(2, minmax(110px, 1fr)); width:100%; } }
    @media (max-width:640px) { .content,.sidebar { padding:18px; } .match-grid,.bulletin-grid { grid-template-columns:1fr; } .match-teams { flex-direction:column; align-items:flex-start; } .score { text-align:left; } .hero-metrics { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">A</div><div><p class="eyebrow">Canli Spor Merkezi</p><h1>Aminoglu.bet</h1></div></div>
      <nav class="sidebar-nav">
        <button class="nav-item active" data-panel="dashboard">Pano</button>
        <button class="nav-item" data-panel="favorites">Favoriler</button>
        <button class="nav-item" data-panel="standings">Puan Durumu</button>
        <button class="nav-item" data-panel="bulletin">Bulten</button>
      </nav>
      <section class="sidebar-card"><p class="section-kicker">Gunun Ozet</p><h2 id="featuredTitle">Yukleniyor</h2><p id="featuredText">Gunluk one cikan karsilasma hazirlaniyor.</p></section>
      <section class="sidebar-card compact-card"><p class="section-kicker">Sistem</p><h2 id="lastUpdatedLabel">Veri bekleniyor</h2><p id="refreshHint">Canli veri geldikce panel kendini otomatik yeniler.</p></section>
    </aside>
    <main class="content">
      <header class="topbar">
        <div><p class="eyebrow" id="currentDate">Tarih yukleniyor</p><h2>Mac Merkezi</h2></div>
        <div class="topbar-actions">
          <button class="ghost-button" id="themeToggle">Tema</button>
          <button class="ghost-button" id="refreshButton">Yenile</button>
          <button class="accent-button">Bildirimleri Ac</button>
        </div>
      </header>
      <section class="hero">
        <div class="hero-copy"><p class="section-kicker">Canli Veri Deneyimi</p><h3>Tum ligler, tek ekranda hizli takip</h3><p>Canli skorlar, puan durumu, gol kralligi ve secili mac detayi tek yerde.</p></div>
        <div class="hero-metrics">
          <article><strong id="todayMatchesCount">0</strong><span>Bugunku Mac</span></article>
          <article><strong id="liveMatchesCount">0</strong><span>Canli Karsilasma</span></article>
          <article><strong id="trackedLeaguesCount">0</strong><span>Aktif Lig</span></article>
          <article><strong id="finishedMatchesCount">0</strong><span>Tamamlanan</span></article>
        </div>
      </section>
      <section class="league-filter" id="leagueFilter"></section>
      <div class="api-banner" id="apiBanner">Gercek mac verileri yukleniyor...</div>
      <section class="panel active" id="dashboard">
        <div class="section-header"><div><p class="section-kicker">Canli ve Planli</p><h3>Maclar</h3></div><input id="searchInput" type="search" placeholder="Takim veya lig ara" /></div>
        <div class="dashboard-layout"><div id="matchList" class="match-grid"></div><aside class="detail-card" id="matchDetail"></aside></div>
      </section>
      <section class="panel" id="favorites"><div class="section-header"><div><p class="section-kicker">Kisisel Alan</p><h3>Favori Maclar</h3></div></div><div id="favoritesList" class="match-grid"></div></section>
      <section class="panel" id="standings">
        <div class="section-header"><div><p class="section-kicker">Lig Analizi</p><h3>Puan Durumu ve Gol Kralligi</h3></div></div>
        <div class="standings-filter" id="standingsFilter"></div>
        <div class="analytics-grid">
          <div class="table-card"><table><thead><tr><th>#</th><th>Takim</th><th>O</th><th>G</th><th>B</th><th>M</th><th>AV</th><th>P</th></tr></thead><tbody id="standingsBody"></tbody></table></div>
          <div class="table-card"><div class="mini-title">Gol Kralligi</div><div id="scorersList" class="scorers-list"></div></div>
        </div>
      </section>
      <section class="panel" id="bulletin"><div class="section-header"><div><p class="section-kicker">Editoryal Alan</p><h3>Gunluk Bulten</h3></div></div><div class="bulletin-grid" id="bulletinList"></div></section>
    </main>
  </div>
  <script>
    const REFRESH_INTERVAL_MS = 90000;
    const state = { leagues:{}, matches:[], standingsByLeague:{}, scorersByLeague:{}, bulletins:[], activeLeague:"all", activeStandingsLeague:"PL", searchTerm:"", favoriteIds:JSON.parse(localStorage.getItem("aminoglubet-favorites") || "[]"), selectedMatchId:null, lastUpdated:null };
    const el = {
      apiBanner: document.getElementById("apiBanner"), matchList: document.getElementById("matchList"), favoritesList: document.getElementById("favoritesList"),
      standingsBody: document.getElementById("standingsBody"), scorersList: document.getElementById("scorersList"), bulletinList: document.getElementById("bulletinList"),
      searchInput: document.getElementById("searchInput"), themeToggle: document.getElementById("themeToggle"), refreshButton: document.getElementById("refreshButton"),
      currentDate: document.getElementById("currentDate"), featuredTitle: document.getElementById("featuredTitle"), featuredText: document.getElementById("featuredText"),
      todayMatchesCount: document.getElementById("todayMatchesCount"), liveMatchesCount: document.getElementById("liveMatchesCount"), trackedLeaguesCount: document.getElementById("trackedLeaguesCount"),
      finishedMatchesCount: document.getElementById("finishedMatchesCount"), leagueFilter: document.getElementById("leagueFilter"), standingsFilter: document.getElementById("standingsFilter"),
      matchDetail: document.getElementById("matchDetail"), lastUpdatedLabel: document.getElementById("lastUpdatedLabel"), refreshHint: document.getElementById("refreshHint")
    };
    function saveFavorites() { localStorage.setItem("aminoglubet-favorites", JSON.stringify(state.favoriteIds)); }
    function statusClass(status) { if (status === "Canli") return "status-live"; if (status === "Bitti") return "status-finished"; return "status-upcoming"; }
    function teamInitials(name) { return (name || "?").split(" ").map((x) => x[0] || "").join("").slice(0, 2).toUpperCase(); }
    function renderDate() { el.currentDate.textContent = new Date().toLocaleDateString("tr-TR", { weekday:"long", day:"numeric", month:"long", year:"numeric" }); }
    function syncLeagueFilters() {
      const leagues = ["all", ...new Set(state.matches.map((m) => m.league))];
      el.leagueFilter.innerHTML = leagues.map((league) => '<button class="chip ' + (state.activeLeague === league ? "active" : "") + '" data-league="' + league + '">' + (league === "all" ? "Tum Ligler" : league) + '</button>').join("");
    }
    function syncStandingsFilters() {
      el.standingsFilter.innerHTML = Object.entries(state.leagues).map(([code, label]) => '<button class="standings-chip ' + (state.activeStandingsLeague === code ? "active" : "") + '" data-standings-league="' + code + '">' + label + '</button>').join("");
    }
    function getFilteredMatches() {
      return state.matches.filter((m) => {
        const inLeague = state.activeLeague === "all" || m.league === state.activeLeague;
        const inSearch = (m.home + " " + m.away + " " + m.league).toLowerCase().includes(state.searchTerm.toLowerCase());
        return inLeague && inSearch;
      });
    }
    function matchCardTemplate(m) {
      const isFavorite = state.favoriteIds.includes(m.id);
      const isSelected = state.selectedMatchId === m.id;
      return '<article class="match-card ' + (isSelected ? "active" : "") + '"><div class="match-head"><div><p class="section-kicker">' + m.league + '</p><strong>' + m.venue + '</strong></div><div class="status-pill ' + statusClass(m.status) + '">' + m.status + '</div></div><div class="match-teams"><div class="team"><div class="team-badge">' + teamInitials(m.home) + '</div><div class="team-name">' + m.home + '</div></div><div class="score"><strong>' + m.homeScore + ' - ' + m.awayScore + '</strong><span class="minute-pill">' + m.minute + '</span></div><div class="team"><div class="team-badge">' + teamInitials(m.away) + '</div><div class="team-name">' + m.away + '</div></div></div><div class="match-meta"><span>Yayin: ' + m.channel + '</span><span>Baslangic: ' + m.kickoff + '</span></div><button class="primary-button" data-select-match="' + m.id + '">Mac Detayi</button><button class="favorite-button ' + (isFavorite ? "active" : "") + '" data-favorite-id="' + m.id + '">' + (isFavorite ? "Favorilerden Cikar" : "Favorilere Ekle") + '</button></article>';
    }
    function renderMatches() {
      syncLeagueFilters();
      const filtered = getFilteredMatches();
      el.matchList.innerHTML = filtered.length ? filtered.map(matchCardTemplate).join("") : '<div class="empty-state">Filtreye uyan mac bulunamadi.</div>';
      const favorites = state.matches.filter((m) => state.favoriteIds.includes(m.id));
      el.favoritesList.innerHTML = favorites.length ? favorites.map(matchCardTemplate).join("") : '<div class="empty-state">Henuz favori mac eklenmedi.</div>';
    }
    function renderStandings() {
      syncStandingsFilters();
      const rows = state.standingsByLeague[state.activeStandingsLeague] || [];
      el.standingsBody.innerHTML = rows.length ? rows.map((row) => '<tr>' + row.map((cell) => '<td>' + cell + '</td>').join("") + '</tr>').join("") : '<tr><td colspan="8">Veri yok</td></tr>';
    }
    function renderScorers() {
      const scorers = state.scorersByLeague[state.activeStandingsLeague] || [];
      el.scorersList.innerHTML = scorers.length ? scorers.map((item, index) => '<div class="scorer-row"><div><div class="scorer-name">' + (index + 1) + '. ' + item.player + '</div><div class="scorer-meta">' + item.team + '</div></div><strong>' + item.goals + '</strong></div>').join("") : '<div class="empty-state">Gol kralligi verisi bulunamadi.</div>';
    }
    function renderHeroStats() {
      el.todayMatchesCount.textContent = String(state.matches.length);
      el.liveMatchesCount.textContent = String(state.matches.filter((m) => m.status === "Canli").length);
      el.trackedLeaguesCount.textContent = String(new Set(state.matches.map((m) => m.league)).size);
      el.finishedMatchesCount.textContent = String(state.matches.filter((m) => m.status === "Bitti").length);
    }
    function renderFeaturedMatch() {
      const featured = state.matches.find((m) => m.status === "Canli") || state.matches.find((m) => m.status === "Baslamadi") || state.matches[0];
      if (!featured) { el.featuredTitle.textContent = "Mac bulunamadi"; el.featuredText.textContent = "Su an gosterilecek veri yok."; return; }
      el.featuredTitle.textContent = featured.home + " - " + featured.away;
      el.featuredText.textContent = featured.league + " icinde " + featured.minute + " durumunda. " + (featured.insight || "");
    }
    function renderMatchDetail() {
      const selected = state.matches.find((m) => m.id === state.selectedMatchId) || state.matches[0];
      if (!selected) { el.matchDetail.innerHTML = '<div class="empty-state">Secili mac bulunamadi.</div>'; return; }
      const details = ["Durum: " + selected.status, "Dakika / Saat: " + selected.minute, "Stadyum: " + selected.venue, "Yayin: " + selected.channel, "Not: " + (selected.insight || "Ek analiz bilgisi yok.")];
      el.matchDetail.innerHTML = '<div class="detail-pill">' + selected.league + '</div><h3>' + selected.home + ' - ' + selected.away + '</h3><div class="detail-scoreline"><strong>' + selected.homeScore + ' - ' + selected.awayScore + '</strong><span class="status-pill ' + statusClass(selected.status) + '">' + selected.minute + '</span></div><div class="detail-meta"><span>Baslangic: ' + selected.kickoff + '</span><span>ID: #' + selected.id + '</span></div><ul class="detail-list">' + details.map((line) => '<li>' + line + '</li>').join("") + '</ul>';
    }
    function renderSystemInfo() {
      if (!state.lastUpdated) { el.lastUpdatedLabel.textContent = "Veri bekleniyor"; el.refreshHint.textContent = "Canli veri geldikce panel kendini otomatik yeniler."; return; }
      const time = new Date(state.lastUpdated).toLocaleTimeString("tr-TR", { hour:"2-digit", minute:"2-digit", second:"2-digit" });
      el.lastUpdatedLabel.textContent = "Son yenileme " + time;
      el.refreshHint.textContent = "Panel her " + Math.round(REFRESH_INTERVAL_MS / 1000) + " saniyede bir veriyi yeniler.";
    }
    function renderBulletins() {
      el.bulletinList.innerHTML = state.bulletins.map((item) => '<article class="bulletin-card"><div class="bulletin-meta"><span class="bulletin-tag">' + item.tag + '</span><span>' + (item.league || "Genel") + '</span></div><h4>' + item.title + '</h4><p>' + item.body + '</p></article>').join("");
    }
    function generateBulletinsFromMatches() {
      const live = state.matches.find((m) => m.status === "Canli");
      const upcoming = state.matches.find((m) => m.status === "Baslamadi");
      const finished = state.matches.find((m) => m.status === "Bitti");
      const leader = state.standingsByLeague[state.activeStandingsLeague]?.[0];
      const leaderLeague = state.leagues[state.activeStandingsLeague];
      const result = [];
      if (live) result.push({ tag:"Canli Gundem", league:live.league, title:live.home + " - " + live.away + " devam ediyor", body:live.minute + " itibariyla skor " + live.homeScore + " - " + live.awayScore + ". " + live.insight });
      if (upcoming) result.push({ tag:"Siradaki Mac", league:upcoming.league, title:upcoming.home + " ile " + upcoming.away + " karsilasacak", body:upcoming.kickoff + " saatli mac " + upcoming.venue + " sahasinda oynanacak." });
      if (finished) result.push({ tag:"Tamamlandi", league:finished.league, title:finished.home + " - " + finished.away + " sonucu netlesti", body:"Tam mac skoru " + finished.homeScore + " - " + finished.awayScore + "." });
      if (leader) result.push({ tag:"Lider", league:leaderLeague, title:leader[1] + " zirvede", body:leaderLeague + " icinde lider takim " + leader[7] + " puana ulasmis durumda." });
      state.bulletins = result.slice(0, 4);
      renderBulletins();
    }
    function renderAll() { renderDate(); renderHeroStats(); renderFeaturedMatch(); renderMatches(); renderStandings(); renderScorers(); renderMatchDetail(); generateBulletinsFromMatches(); renderSystemInfo(); }
    async function loadData() {
      try {
        const response = await fetch("/api/bootstrap", { cache:"no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Veri alinamadi");
        state.leagues = data.leagues || {};
        state.matches = data.matches || [];
        state.standingsByLeague = data.standingsByLeague || {};
        state.scorersByLeague = data.scorersByLeague || {};
        state.lastUpdated = data.lastUpdated || new Date().toISOString();
        if (!state.selectedMatchId && state.matches.length) state.selectedMatchId = state.matches[0].id;
        if (!state.matches.some((m) => m.id === state.selectedMatchId)) state.selectedMatchId = state.matches[0]?.id || null;
        el.apiBanner.textContent = "Gercek API verisi yuklendi.";
        el.apiBanner.classList.remove("error");
      } catch (error) {
        state.matches = [];
        state.standingsByLeague = {};
        state.scorersByLeague = {};
        state.lastUpdated = new Date().toISOString();
        el.apiBanner.textContent = "API verisi alinamadi: " + error.message;
        el.apiBanner.classList.add("error");
      }
      renderAll();
    }
    document.addEventListener("click", (event) => {
      const navButton = event.target.closest(".nav-item");
      if (navButton) {
        document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
        document.querySelectorAll(".panel").forEach((panel) => panel.classList.remove("active"));
        navButton.classList.add("active");
        document.getElementById(navButton.dataset.panel).classList.add("active");
      }
      const leagueChip = event.target.closest("[data-league]");
      if (leagueChip) { state.activeLeague = leagueChip.dataset.league; renderMatches(); }
      const standingsChip = event.target.closest("[data-standings-league]");
      if (standingsChip) { state.activeStandingsLeague = standingsChip.dataset.standingsLeague; renderStandings(); renderScorers(); generateBulletinsFromMatches(); }
      const favoriteButton = event.target.closest("[data-favorite-id]");
      if (favoriteButton) {
        const id = Number(favoriteButton.dataset.favoriteId);
        state.favoriteIds = state.favoriteIds.includes(id) ? state.favoriteIds.filter((item) => item !== id) : [...state.favoriteIds, id];
        saveFavorites();
        renderMatches();
      }
      const selectButton = event.target.closest("[data-select-match]");
      if (selectButton) { state.selectedMatchId = Number(selectButton.dataset.selectMatch); renderMatches(); renderMatchDetail(); }
    });
    el.searchInput.addEventListener("input", (event) => { state.searchTerm = event.target.value; renderMatches(); });
    el.themeToggle.addEventListener("click", () => { document.body.classList.toggle("dark"); });
    el.refreshButton.addEventListener("click", loadData);
    renderAll();
    loadData();
    setInterval(loadData, REFRESH_INTERVAL_MS);
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === "/") {
      send(res, 200, html, "text/html; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/bootstrap") {
      sendJson(res, 200, await buildBootstrap());
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Aminoglu.bet running on http://localhost:${PORT}`);
});
