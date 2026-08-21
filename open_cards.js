(function () {

    /* Numéro de version du bot — affiché en bas du panneau Paramètres. */
    const WM_VERSION = '1.3.13-prod';

    console.log('[WikiMasters] script loaded v' + WM_VERSION + ' - building UI...');

    /* ===================== CONFIG ===================== */

    let KEYWORDS_ALERT = [];
    let KEYWORDS_PRIORITY = []; // mots-clés prioritaires (auto-bid forcé)
    let KEYWORDS_FOURBE = [];   // mots-clés fourbe (arme le snipe ~10s de la fin)
    let KEYWORDS_EXCLUDE = [];  // mots exclus : exclusion STRICTE (sous-chaîne de la phrase entière)
    // Chasseur ciblé : liste d'objets { text, cap, mode } (mode = 'autobid' | 'fourbe').
    // À l'apparition d'un match : mise initiale + plafond posé + mode armé jusqu'au plafond.
    let KEYWORDS_HUNTER = [];
    const KEYWORDS_STORAGE_KEY = 'wm_keywords_alert';
    const KEYWORDS_PRIORITY_KEY = 'wm_keywords_priority';
    const KEYWORDS_FOURBE_KEY = 'wm_keywords_fourbe';
    const KEYWORDS_EXCLUDE_KEY = 'wm_keywords_exclude';
    const KEYWORDS_HUNTER_KEY = 'wm_keywords_hunter';
    const MARKET_REFRESH_MS = 10000;
    const MARKET_API_BASE = "https://www.wiki-masters.com/api/marketplace";
    const MARKET_PAGE_LIMIT = 50;
    const MARKET_PAGE_CONCURRENCY = 5; // pages chargées en parallèle par lot
    const MARKET_MIN_GAP_MS = 1500;    // souffle minimal entre 2 scans
    // Discord webhook — configuré par chaque utilisateur via la section Paramètres
    function getDiscordWebhook() { return getSetting('discordWebhook').trim(); }
    function setDiscordWebhook(url) { setSetting('discordWebhook', (url || '').trim()); }

    // Limite serveur sur la longueur d'un nom de tag (au-delà : création refusée)
    const MAX_TAG_LEN = 48;
    // Nom du tag de mise en vente (configurable dans Paramètres, défaut "Trash")
    function getSellTagName() { return getSetting('sellTagName'); }
    // Config de vente par rareté (prix + durée), modifiable dans Paramètres
    const SELL_CONFIG_KEY = 'wm_sell_config';
    const SELL_CONFIG_DEFAULT = {
        L:  { price: 100, duration: 10 },
        UR: { price: 50,  duration: 10 },
        SR: { price: 25,  duration: 10 },
        R:  { price: 20,  duration: 10 },
        PC: { price: 15,  duration: 10 },
        C:  { price: 10,  duration: 10 },
    };
    const SELL_DURATION_CHOICES = [10, 30, 60, 180, 360, 720, 1440];

    function getSellConfig() {
        try {
            const raw = JSON.parse(localStorage.getItem(SELL_CONFIG_KEY) || 'null');
            if (raw && typeof raw === 'object') {
                // Merge avec les defaults pour combler les raretés manquantes
                const merged = {};
                for (const rar of Object.keys(SELL_CONFIG_DEFAULT)) {
                    merged[rar] = { ...SELL_CONFIG_DEFAULT[rar], ...(raw[rar] || {}) };
                }
                return merged;
            }
        } catch(e) {}
        return JSON.parse(JSON.stringify(SELL_CONFIG_DEFAULT));
    }
    function setSellConfig(cfg) {
        try { localStorage.setItem(SELL_CONFIG_KEY, JSON.stringify(cfg)); } catch(e) {}
    }
    function getSellPrice(rarity)    { return getSellConfig()[rarity]?.price    ?? 10; }
    function getSellDuration(rarity) { return getSellConfig()[rarity]?.duration ?? 10; }

    // Migration : si un sellDuration global existait, on l'applique à toutes les raretés
    try {
        const oldGlobal = localStorage.getItem('wm_sell_duration');
        if (oldGlobal !== null && !localStorage.getItem(SELL_CONFIG_KEY)) {
            const v = parseInt(oldGlobal, 10);
            if (Number.isFinite(v)) {
                const cfg = JSON.parse(JSON.stringify(SELL_CONFIG_DEFAULT));
                for (const rar of Object.keys(cfg)) cfg[rar].duration = v;
                setSellConfig(cfg);
            }
            localStorage.removeItem('wm_sell_duration');
        }
    } catch(e) {}

    const RARITY = {
        L:  { color: "#FFD700", bg: "rgba(255,215,0,0.15)",   label: "L"  },
        UR: { color: "#FF8C00", bg: "rgba(255,140,0,0.15)",   label: "UR" },
        SR: { color: "#FF69B4", bg: "rgba(255,105,180,0.15)", label: "SR" },
        R:  { color: "#A855F7", bg: "rgba(168,85,247,0.15)",  label: "R"  },
        PC: { color: "#3B82F6", bg: "rgba(59,130,246,0.15)",  label: "PC" },
        C:  { color: "#22C55E", bg: "rgba(34,197,94,0.15)",   label: "C"  },
    };

    /* ===================== STATE ===================== */

    let running = false;
    let packLoopEpoch = 0; // jeton de génération : invalide toute boucle Pack Opener précédente
    let totalPacks = 0;
    let totalCards = 0;
    let cardStats = {};
    let rarityStats = { L:0, UR:0, SR:0, R:0, PC:0, C:0 };
    let sessionStart = null;
    let timerInterval = null;
    let minimized = false;

    let marketWatcherInterval = null;
    let salesMonitorInterval = null;
    let knownSoldIds = new Set(); // IDs des ventes déjà notifiées

    // Historique des ventes (session)
    let sellHistory = []; // { card, rarity, price, sold, timestamp }
    const SELL_HISTORY_KEY = 'wm_sell_history';

    // Début de la JOURNÉE courante (minuit local). Les stats "du jour" s'agrègent à
    // partir de là, survivent aux refresh, et se réinitialisent au changement de date.
    function dayStartMs() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
    // "Ventes du jour" : sellHistory est déjà persisté → il suffit de filtrer depuis minuit
    // (plus besoin de remettre à zéro à chaque chargement de page).
    const SESSION_SALES_START = dayStartMs();

    // Métriques de la session courante (pour le récap "Dernières sessions").
    // Restent PAR SESSION (non amorcées depuis le cumul du jour) pour ne pas fausser cet
    // historique. Persistées dans sessionStorage : un simple F5 poursuit LA MÊME session
    // (avant, chaque rechargement repartait de zéro et fragmentait/perdait le récap).
    const SESSION_METRICS_KEY = 'wm_session_metrics';
    const emptyRarities = () => ({ L:0, UR:0, SR:0, R:0, PC:0, C:0 });
    let sessionMetrics = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        start: Date.now(),
        packsOpened: 0,
        sales: 0,          // ventes réussies
        salesGain: 0,      // 💰 encaissés
        bidsWon: 0,        // enchères gagnées
        bidsSpent: 0,      // 💰 dépensés en enchères gagnées
        rarities: emptyRarities() // cartes obtenues PENDANT cette session (≠ cumul du jour)
    };
    try {
        const raw = JSON.parse(sessionStorage.getItem(SESSION_METRICS_KEY) || 'null');
        if (raw && raw.id) {
            sessionMetrics = {
                id: raw.id,
                start: raw.start || Date.now(),
                packsOpened: raw.packsOpened || 0,
                sales: raw.sales || 0,
                salesGain: raw.salesGain || 0,
                bidsWon: raw.bidsWon || 0,
                bidsSpent: raw.bidsSpent || 0,
                rarities: { ...emptyRarities(), ...(raw.rarities || {}) }
            };
        }
    } catch(e) {}
    function saveSessionMetrics() {
        try { sessionStorage.setItem(SESSION_METRICS_KEY, JSON.stringify(sessionMetrics)); } catch(e) {}
    }
    saveSessionMetrics();

    // Stats du Pack Opener fusionnées PAR JOUR (persistées). Ne repartent plus de zéro
    // à chaque refresh ; reset automatique au changement de date (todayKey).
    const DAILY_STATS_KEY = 'wm_daily_pack_stats';
    let dailyPackStats = { date: todayKey(), packs: 0, cards: 0, rarities: { L:0, UR:0, SR:0, R:0, PC:0, C:0 } };
    try {
        const raw = JSON.parse(localStorage.getItem(DAILY_STATS_KEY) || 'null');
        if (raw && raw.date === todayKey()) {
            dailyPackStats = {
                date: todayKey(),
                packs: raw.packs || 0,
                cards: raw.cards || 0,
                rarities: { L:0, UR:0, SR:0, R:0, PC:0, C:0, ...(raw.rarities || {}) }
            };
        }
    } catch(e) {}

    // Stats du jour pour l'affichage du Pack Opener — AMORCÉES depuis le cumul persistant.
    let sessionPacks = dailyPackStats.packs;
    let sessionCards = dailyPackStats.cards;
    let sessionRarityStats = { L:0, UR:0, SR:0, R:0, PC:0, C:0, ...dailyPackStats.rarities };
    // Jour auquel appartiennent les stats ci-dessus. Sert au reset automatique à minuit même
    // si l'onglet reste ouvert (sinon les stats d'hier continuaient de s'accumuler ET étaient
    // ré-estampillées "aujourd'hui" par saveDailyPackStats → survivaient au reload).
    let sessionStatsDay = todayKey();

    // Recopie les compteurs du jour dans le store persistant (appelé après chaque pack).
    function saveDailyPackStats() {
        dailyPackStats = {
            date: todayKey(),
            packs: sessionPacks,
            cards: sessionCards,
            rarities: { ...sessionRarityStats }
        };
        try { localStorage.setItem(DAILY_STATS_KEY, JSON.stringify(dailyPackStats)); } catch(e) {}
    }

    // Reset auto des stats quotidiennes au changement de date (rollover minuit). Retourne true
    // si un reset a eu lieu. Appelé avant chaque comptage de pack + périodiquement.
    function rolloverDailyStatsIfNeeded() {
        const tk = todayKey();
        if (sessionStatsDay === tk) return false;
        sessionStatsDay = tk;
        sessionPacks = 0;
        sessionCards = 0;
        sessionRarityStats = { L:0, UR:0, SR:0, R:0, PC:0, C:0 };
        saveDailyPackStats(); // écrase le store : { date: aujourd'hui, 0… }
        // Rafraîchit l'affichage s'il est monté
        try {
            const rEl = document.getElementById('wm-rarity'); if (rEl) renderRarityStats(rEl);
            const pEl = document.getElementById('wm-packs'); if (pEl) pEl.innerText = '0 packs';
            if (window.wmUpdateDailyPacksInfo) window.wmUpdateDailyPacksInfo();
        } catch(e) {}
        wmLog('🔄 Nouveau jour : stats quotidiennes du Pack Opener remises à zéro.');
        return true;
    }
    // Vérifie le rollover même sans ouverture de pack (onglet resté ouvert la nuit).
    setInterval(rolloverDailyStatsIfNeeded, 60000);

    // Suivi des enchères GAGNÉES via l'endpoint serveur /api/marketplace/mine (champ "won").
    // Source de vérité fiable (vs détection temps réel fragile). On mémorise les IDs déjà
    // comptés pour ne créditer chaque achat qu'une fois ; tout nouvel ID vu est attribué
    // à la session courante avec son vrai prix payé (final_price).
    const WON_SEEN_KEY = 'wm_won_seen_ids';
    let wonSeenIds = new Set();
    try {
        const raw = JSON.parse(localStorage.getItem(WON_SEEN_KEY) || '[]');
        if (Array.isArray(raw)) wonSeenIds = new Set(raw);
    } catch(e) {}
    let wonInitialized = false; // au 1er fetch, on enregistre l'existant SANS le compter
    let lastWonSync = 0;        // throttle : on ne sync les achats qu'à intervalle espacé
    function saveWonSeen() {
        try { localStorage.setItem(WON_SEEN_KEY, JSON.stringify([...wonSeenIds].slice(-2000))); } catch(e) {}
    }

    /* ── Archive locale des ACHATS ──
       L'endpoint /mine ne renvoie qu'une fenêtre glissante des dernières enchères gagnées :
       au-delà, elles disparaissent définitivement côté serveur. On archive donc chaque
       snapshot en local et on en fait l'UNION au fil du temps — l'historique dépasse ainsi
       la limite du site et ne perd plus rien tant que le bot passe régulièrement.
       Limite : les achats déjà sortis de la fenêtre AVANT l'installation sont irrécupérables.
       Dédoublonné par id d'enchère ; conserve les 2000 plus récents. */
    const BUY_HISTORY_KEY = 'wm_buy_history';
    let buyHistory = [];
    try {
        const raw = JSON.parse(localStorage.getItem(BUY_HISTORY_KEY) || '[]');
        if (Array.isArray(raw)) buyHistory = raw;
    } catch(e) {}
    const buyHistoryIds = new Set(buyHistory.map(b => b && b.id).filter(Boolean));
    function saveBuyHistory() {
        try {
            buyHistory.sort((a, b) => (a.boughtAt || 0) - (b.boughtAt || 0));
            buyHistory = buyHistory.slice(-2000);
            localStorage.setItem(BUY_HISTORY_KEY, JSON.stringify(buyHistory));
        } catch(e) {}
    }
    // Archive un achat depuis une entrée `won` de l'API. true si c'est une nouveauté.
    function recordPurchase(w) {
        if (!w || !w.id || buyHistoryIds.has(w.id)) return false;
        const ts = w.settled_at ? new Date(w.settled_at).getTime()
                 : w.end_at    ? new Date(w.end_at).getTime()
                 : Date.now();
        buyHistoryIds.add(w.id);
        buyHistory.push({
            id: w.id,
            title: w.card?.wikipedia_title || '?',
            rarity: (w.snapshot_rarity || w.card?.rarity || '').toUpperCase(),
            base: w.listing_base_amount ?? w.base_amount ?? null,
            price: w.final_price ?? w.current_bid ?? 0,
            seller: w.seller?.username || w.seller_username || null,
            boughtAt: Number.isFinite(ts) ? ts : Date.now()
        });
        return true;
    }

    /* Aucun `fetch()` de ce fichier n'a de timeout par défaut : si une requête reste bloquée
       (connexion qui stagne, serveur qui ne répond pas), le `await` qui l'attend gèle
       SILENCIEUSEMENT — pas d'erreur, pas de retry, juste une boucle qui ne boucle plus. C'est
       ainsi qu'un statut affiché (ex. la boucle d'attente du Trash Seller) peut se figer sur sa
       dernière valeur pendant que le reste du bot, sur ses propres minuteries indépendantes,
       continue de tourner normalement — symptôme trompeur qui ressemble à une désynchro de
       données alors que c'est juste une requête qui n'est jamais revenue.
       Appliqué à `fetchMine`/`supabaseSelect` : les deux fonctions bas niveau qui sous-tendent
       toute la logique de vente/achat/rareté construite aujourd'hui — pas aux 52 fetch() du
       fichier, qui dépasserait largement le problème signalé. */
    const FETCH_TIMEOUT_MS = 15000;
    async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { ...opts, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    /* Un seul GET /mine, partagé. La réponse porte à la fois `selling` (ventes actives),
       `won` (enchères gagnées) et `history` (ventes conclues) : chaque module tirait sa propre
       requête sur le même endpoint, déjà sujet au rate-limit (429). Retourne null en cas
       d'échec — jamais un objet vide, que les appelants prendraient pour « rien à afficher ». */
    async function fetchMine() {
        if (!navigator.onLine) return null;
        try {
            const res = await fetchWithTimeout(`${MARKET_API_BASE}/mine`, { credentials: 'include' });
            if (!res.ok) return null;
            return await res.json();
        } catch(e) { return null; } // inclut l'abandon par timeout (AbortError)
    }

    // Récupère les enchères gagnées et crédite les nouveaux achats à la session courante.
    // `preFetched` : réponse /mine déjà en main (évite une requête de plus).
    async function syncWonAuctions(preFetched) {
        const data = preFetched || await fetchMine();
        if (!data) return;
        // /mine ne porte plus `won` : on lit les enchères gagnées en base. La branche historique
        // est conservée au cas où le champ réapparaîtrait.
        let won = Array.isArray(data?.won) ? data.won : null;
        if (!won) won = await fetchWonFromDb(100);
        if (!Array.isArray(won)) return;

        // L'archive est alimentée à CHAQUE passage, y compris le premier : c'est justement
        // lui qui capture la fenêtre serveur existante et amorce l'historique long.
        let archived = 0;
        won.forEach(w => { if (recordPurchase(w)) archived++; });
        if (archived > 0) saveBuyHistory();

        // Premier passage de la session : on mémorise les achats déjà existants sans les
        // compter (ils datent d'avant — ils ne doivent pas gonfler la session courante).
        if (!wonInitialized) {
            won.forEach(w => { if (w?.id) wonSeenIds.add(w.id); });
            wonInitialized = true;
            saveWonSeen();
            return;
        }

        // Passages suivants : tout achat dont l'ID est nouveau = gagné pendant la session
        let credited = 0;
        const newWins = [];
        won.forEach(w => {
            if (!w?.id || wonSeenIds.has(w.id)) return;
            wonSeenIds.add(w.id);
            const price = w.final_price ?? w.current_bid ?? 0;
            sessionMetrics.bidsWon++;
            sessionMetrics.bidsSpent += price;
            credited++;
            saveSessionMetrics();
            finalizeSession(); // persiste immédiatement, sans attendre la fermeture de l'onglet
            const title = w.card?.wikipedia_title || '?';
            const rar = (w.snapshot_rarity || w.card?.rarity || '').toUpperCase();
            newWins.push({ title, rar, price });
            wmLog(`🏆 Enchère gagnée : <b>${title}</b> [${rar}] → <span style="color:#ef4444;">${price} 💰</span>`);

            // Chasseur ciblé — auto-pause : cette enchère avait été armée par une chasse avec
            // `autoDisable` actif et vient d'être gagnée → on la met en pause toute seule.
            // On retire l'entrée de la map dans tous les cas (gagnée ou pas, elle est conclue).
            const hunterText = hunterAutoDisableMap.get(w.id);
            if (hunterText) {
                hunterAutoDisableMap.delete(w.id);
                saveHunterAutoDisableMap();
                const hEntry = KEYWORDS_HUNTER.find(x => x.text === hunterText);
                if (hEntry && hEntry.enabled !== false) {
                    hEntry.enabled = false;
                    saveHunterKeywords();
                    renderKeywordsPanel(); // no-op si le panneau n'est pas affiché
                    wmLog(`🎯 Chasseur mis en pause automatiquement (obtenue) : <b style="color:#5dade2;">${hunterText}</b>`);
                }
            }
        });
        if (credited > 0) {
            saveWonSeen();
            if (typeof updateBidsSumDisplay === 'function') updateBidsSumDisplay();
            // Feedback dédié « enchère gagnée » : son + badge + Discord (groupé).
            playSound('won');
            if (window.wmNotify) window.wmNotify(credited);
            const lines = newWins.map(w => `• **${w.title}** [${w.rar}] — ${w.price} 💰`).join('\n');
            sendToDiscord(`🏆 **${credited} enchère(s) gagnée(s)**\n${lines}`, 16766720, 'market');
        }
    }

    // Historique des dernières sessions (persisté, max 20)
    const SESSION_HISTORY_KEY = 'wm_session_history';
    let sessionHistory = [];
    try { sessionHistory = JSON.parse(localStorage.getItem(SESSION_HISTORY_KEY) || '[]') || []; } catch(e) {}
    function saveSessionHistory() {
        try { localStorage.setItem(SESSION_HISTORY_KEY, JSON.stringify(sessionHistory.slice(-20))); } catch(e) {}
    }
    // Enregistre / met à jour la session courante dans l'historique.
    // UPSERT par id : idempotent, donc on peut l'appeler aussi souvent qu'on veut. La session
    // est écrite dès la première activité (et non plus seulement au unload), ce qui la rend
    // résistante au crash navigateur, à l'extinction du PC et à l'onglet « discarded » par
    // Chrome — autant de cas où `beforeunload` ne se déclenche jamais.
    function finalizeSession() {
        // N'enregistre pas les sessions vides (rien ouvert, rien vendu, rien gagné)
        if (sessionMetrics.packsOpened === 0 && sessionMetrics.sales === 0 && sessionMetrics.bidsWon === 0) return;
        const entry = {
            id: sessionMetrics.id,
            end: Date.now(),
            durationMs: Date.now() - sessionMetrics.start,
            packsOpened: sessionMetrics.packsOpened,
            sales: sessionMetrics.sales,
            salesGain: sessionMetrics.salesGain,
            bidsWon: sessionMetrics.bidsWon,
            bidsSpent: sessionMetrics.bidsSpent,
            net: sessionMetrics.salesGain - sessionMetrics.bidsSpent,
            rarities: { ...sessionMetrics.rarities } // cartes obtenues PENDANT cette session
        };
        // Relit le store avant d'écrire : un autre onglet a pu ajouter ses propres sessions
        // entre-temps (localStorage est partagé) — sans ça on les écraserait.
        try {
            const stored = JSON.parse(localStorage.getItem(SESSION_HISTORY_KEY) || '[]');
            if (Array.isArray(stored)) sessionHistory = stored;
        } catch(e) {}
        const idx = sessionHistory.findIndex(s => s.id === entry.id);
        if (idx >= 0) sessionHistory[idx] = entry; else sessionHistory.push(entry);
        saveSessionHistory();
        saveSessionMetrics();
    }

    // Compteur de packs ouverts AUJOURD'HUI (pour l'alerte volume).
    // Stocké avec la date du jour ; se réinitialise automatiquement à minuit.
    const DAILY_PACKS_KEY = 'wm_daily_packs';
    function todayKey() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }
    let dailyPacks = { date: todayKey(), count: 0 };
    try {
        const raw = JSON.parse(localStorage.getItem(DAILY_PACKS_KEY) || 'null');
        if (raw && raw.date === todayKey()) dailyPacks = raw;
    } catch(e) {}
    let dailyAlertFired = false; // évite de spammer l'alerte une fois le seuil franchi
    function incrementDailyPacks() {
        const tk = todayKey();
        if (dailyPacks.date !== tk) { dailyPacks = { date: tk, count: 0 }; dailyAlertFired = false; }
        dailyPacks.count++;
        try { localStorage.setItem(DAILY_PACKS_KEY, JSON.stringify(dailyPacks)); } catch(e) {}
        // Rafraîchit l'indicateur live dans les paramètres s'il est affiché
        if (typeof window.wmUpdateDailyPacksInfo === 'function') window.wmUpdateDailyPacksInfo();
        // Alerte si activée et seuil franchi
        if (getSetting('dailyPackAlert') && !dailyAlertFired) {
            const limit = getSetting('dailyPackLimit');
            if (dailyPacks.count >= limit) {
                dailyAlertFired = true;
                wmLog(`⚠️ <b style="color:#ef4444;">Alerte volume</b> : ${dailyPacks.count} packs ouverts aujourd'hui (seuil : ${limit}). Pense à lever le pied.`);
                try { alert(`⚠️ WikiMasters Bot\n\nTu as ouvert ${dailyPacks.count} packs aujourd'hui, ce qui dépasse ton seuil d'alerte (${limit}).\n\nUn volume élevé peut attirer l'attention de la modération. Pense à faire une pause.`); } catch(e) {}
            }
        }
    }

    // Compteur par carte du nombre de mises en vente infructueuses
    // (= nombre de fois où le tag Trash a été réappliqué après un invendu).
    // Map persistée : card_id → { title, rarity, count }. Persiste à vie.
    const RETAG_COUNT_KEY = 'wm_retag_counts';
    let retagCounts = {};
    try { retagCounts = JSON.parse(localStorage.getItem(RETAG_COUNT_KEY) || '{}') || {}; } catch(e) { retagCounts = {}; }
    function saveRetagCounts() {
        try { localStorage.setItem(RETAG_COUNT_KEY, JSON.stringify(retagCounts)); } catch(e) {}
    }
    function incrementRetagCount(cardId, title, rarity) {
        if (!cardId) return;
        const cur = retagCounts[cardId] || { title: title || '?', rarity: rarity || '', count: 0 };
        cur.count++;
        cur.title = title || cur.title; // garde le titre à jour
        cur.rarity = rarity || cur.rarity;
        retagCounts[cardId] = cur;
        saveRetagCounts();
        // Rafraîchit les ventes actives pour mettre à jour le badge 🔁 si la carte est listée
        if (lastActiveSales && lastActiveSales.length) renderActiveSales(lastActiveSales);
    }
    function getRetagCount(cardId) {
        return (cardId && retagCounts[cardId]) ? retagCounts[cardId].count : 0;
    }
    function totalRetagCount() {
        return Object.values(retagCounts).reduce((s, e) => s + (e.count || 0), 0);
    }

    // Compteur du nombre de fois qu'une carte a été MISE EN VENTE (qu'elle soit vendue
    // ou revenue). Sert à prioriser les cartes jamais/peu listées pour une couverture
    // équitable de tout le pool Trash. card_id -> count.
    const LISTED_COUNT_KEY = 'wm_listed_counts';
    let listedCounts = {};
    try { listedCounts = JSON.parse(localStorage.getItem(LISTED_COUNT_KEY) || '{}') || {}; } catch(e) { listedCounts = {}; }
    function saveListedCounts() {
        try { localStorage.setItem(LISTED_COUNT_KEY, JSON.stringify(listedCounts)); } catch(e) {}
    }
    function getListedCount(cardId) {
        return (cardId && listedCounts[cardId]) ? listedCounts[cardId] : 0;
    }
    function incrementListedCount(cardId) {
        if (!cardId) return;
        listedCounts[cardId] = (listedCounts[cardId] || 0) + 1;
        saveListedCounts();
    }

    // Stats cumulées à vie (indépendantes de la troncature de sellHistory et du reset packs).
    // { sold, unsold, gain, byRarity: { L:{sold,gain}, ... } }
    const LIFETIME_STATS_KEY = 'wm_lifetime_stats';
    let lifetimeStats = { sold: 0, unsold: 0, gain: 0, byRarity: {} };
    try {
        const raw = JSON.parse(localStorage.getItem(LIFETIME_STATS_KEY) || 'null');
        if (raw && typeof raw === 'object') {
            lifetimeStats = {
                sold: raw.sold || 0,
                unsold: raw.unsold || 0,
                gain: raw.gain || 0,
                byRarity: raw.byRarity || {}
            };
        }
    } catch(e) {}
    function saveLifetimeStats() {
        try { localStorage.setItem(LIFETIME_STATS_KEY, JSON.stringify(lifetimeStats)); } catch(e) {}
    }
    function recordLifetimeSale(rarity, finalPrice) {
        rarity = (rarity || '').toUpperCase();
        lifetimeStats.sold++;
        lifetimeStats.gain += (finalPrice || 0);
        if (!lifetimeStats.byRarity[rarity]) lifetimeStats.byRarity[rarity] = { sold: 0, gain: 0 };
        lifetimeStats.byRarity[rarity].sold++;
        lifetimeStats.byRarity[rarity].gain += (finalPrice || 0);
        saveLifetimeStats();
    }
    function recordLifetimeUnsold() {
        lifetimeStats.unsold++;
        saveLifetimeStats();
    }

    // ── Clôture d'une vente : point d'entrée UNIQUE pour les compteurs ──
    // Deux réconciliateurs peuvent conclure la même vente : checkSellHistoryResults()
    // (boucle Trash Seller) et reconcilePendingSales() (toutes les 5 min, + au démarrage).
    // Avant, seul le premier créditait sessionMetrics → dès que le second gagnait la course
    // (le cas le plus fréquent), la vente disparaissait du récap de session : gains à 0, et
    // session parfois considérée « vide » donc pas enregistrée du tout.
    // Le flag `_credited` (persisté avec sellHistory) garantit un comptage exactement-une-fois.
    function creditSoldSale(s, finalPrice) {
        if (!s || s._credited) return false;
        s._credited = true;
        if (finalPrice != null) s.finalPrice = finalPrice;
        recordLifetimeSale(s.rarity, s.finalPrice);
        sessionMetrics.sales++;
        sessionMetrics.salesGain += (s.finalPrice || 0);
        saveSessionMetrics();
        finalizeSession(); // écrit la session tout de suite (résiste au crash / arrêt brutal)
        return true;
    }
    function creditUnsoldSale(s) {
        if (!s || s._credited) return false;
        s._credited = true;
        recordLifetimeUnsold();
        return true;
    }

    // Cache prix marketplace par card_id
    let marketPriceCache = {}; // { card_id: avgPrice }
    let marketWatcherActive = false;
    let lastMarketHits = new Set();
    let marketCountdownInterval = null;

    // Cache de la collection : Map<card_id, count>
    let collectionMap = new Map();
    // Raretés RÉELLEMENT possédées par carte : card_id → Set<rareté>. Sert au market watcher
    // à distinguer un vrai doublon (même carte ET même rareté) d'une carte qu'on possède dans
    // une AUTRE rareté (ex. possédée en SR, réapparue en UR après revalorisation par le site).
    let collectionRarityMap = new Map();

    // Comptage des cartes possédées par rareté : { L, UR, SR, R, PC, C }
    // Recalculé à chaque refresh complet de la collection.
    let rarityCountMap = { L:0, UR:0, SR:0, R:0, PC:0, C:0 };
    function resetRarityCount() {
        rarityCountMap = { L:0, UR:0, SR:0, R:0, PC:0, C:0 };
    }
    function addRarityCount(item) {
        const rar = (item.card?.rarity || item.rarity || '').toUpperCase();
        if (rar && rarityCountMap[rar] !== undefined) {
            rarityCountMap[rar] += (item.count || 1);
        }
        // Mémorise la/les rareté(s) possédée(s) pour cette carte précise.
        const id = item.card_id || item.card?.id;
        if (id && rar) {
            let set = collectionRarityMap.get(id);
            if (!set) { set = new Set(); collectionRarityMap.set(id, set); }
            set.add(rar);
        }
    }

    // Raretés possédées pour une carte (Set) ou null si inconnu (pas encore scanné/caché).
    function ownedRaritiesOf(cardId) { return collectionRarityMap.get(cardId) || null; }

    // Cette annonce est-elle un VRAI doublon à masquer ? = on possède la carte DANS CETTE rareté.
    // Repli sûr : si on ignore les raretés possédées (cache ancien, avant 1er refresh), on retombe
    // sur l'ancien comportement (possédée = masquée) pour ne pas tout dé-masquer d'un coup.
    function isOwnedDuplicate(cardId, listingRarity) {
        const count = collectionMap.get(cardId) || 0;
        if (count === 0) return false;                 // pas possédée du tout → on montre
        const rars = collectionRarityMap.get(cardId);
        if (!rars || rars.size === 0) return true;     // possédée mais rareté inconnue → ancien comportement
        const r = (listingRarity || '').toUpperCase();
        if (!r) return true;                           // rareté d'annonce inconnue → prudence, on masque
        return rars.has(r);                            // masque seulement si on possède CETTE rareté
    }
    function renderRarityHeader() {
        const el = document.getElementById('wm-coll-rarity');
        if (!el) return;
        const order = ['L', 'UR', 'SR', 'R', 'PC', 'C'];
        const total = order.reduce((s, r) => s + (rarityCountMap[r] || 0), 0);
        if (total === 0) { el.innerHTML = ''; return; }
        const parts = order.map(r => {
            const c = RARITY[r] || { color: '#888' };
            const n = rarityCountMap[r] || 0;
            return `<span style="color:${c.color};font-weight:700;">${r}</span> <span style="color:#bbb;">${n.toLocaleString('fr-FR')}</span>`;
        });
        el.innerHTML = ` <span style="color:#444;">|</span> ` + parts.join(` <span style="color:#333;">·</span> `);
    }

    // Nom d'utilisateur courant (pour détecter les enchères où on est meneur)
    let currentUsername = null;
    // D'où vient le pseudo courant (réglage manuel, cache, JWT, Supabase…). Affiché dans le
    // log : sans variable dédiée, il fallait le relire dans localStorage, et les chemins qui
    // sortent tôt (override, cache) n'y écrivaient rien → « ? » affiché à tort.
    let currentUsernameSource = '?';

    // Enchères sur lesquelles j'ai misé (persistées pour survivre aux reloads)
    let myBidsSet = new Set();
    const MY_BIDS_KEY = 'wm_my_bids';

    // Tri du watcher market (persisté)
    const MARKET_SORT_KEY = 'wm_market_sort';
    let marketSortKey = 'time_asc';
    try { marketSortKey = localStorage.getItem(MARKET_SORT_KEY) || 'time_asc'; } catch(e) {}

    // Filtre de recherche live du Market Watcher (transitoire, non persisté)
    let marketSearchQuery = '';
    // Masquer les enchères dont je possède déjà la carte (persisté)
    const MARKET_HIDE_OWNED_KEY = 'wm_market_hide_owned';
    let marketHideOwned = false;
    try { marketHideOwned = localStorage.getItem(MARKET_HIDE_OWNED_KEY) === '1'; } catch(e) {}
    // Vue du Market Watcher (persistée) :
    //   'detailed' — une ligne riche par annonce (tous les contrôles)
    //   'compact'  — une seule ligne condensée (nom · bid · leader · temps) → densité max
    //   'cards'    — grille de cadres avec l'image de la carte → lisibilité max
    const MARKET_VIEW_KEY = 'wm_market_view';
    const MARKET_COMPACT_KEY = 'wm_market_compact'; // héritage : ancien booléen compact
    const MARKET_VIEWS = ['detailed', 'compact', 'cards'];
    let marketView = 'detailed';
    try {
        const v = localStorage.getItem(MARKET_VIEW_KEY);
        if (MARKET_VIEWS.includes(v)) marketView = v;
        // Migration : personne ne doit perdre son réglage en passant sur cette version.
        else if (localStorage.getItem(MARKET_COMPACT_KEY) === '1') marketView = 'compact';
    } catch(e) {}
    // Enchères agrandies individuellement en mode compact (transitoire, non persisté).
    // Permet d'ouvrir une seule ligne en vue détaillée sans dérouler tout le panneau.
    let marketExpandedIds = new Set();
    const MARKET_SEARCH_DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g');
    function marketSearchNorm(s) {
        return (s || '').toString().normalize('NFD').replace(MARKET_SEARCH_DIACRITICS, '').toLowerCase();
    }
    const RARITY_ORDER = { L: 5, UR: 4, SR: 3, R: 2, PC: 1, C: 0 };
    let lastHitsCache = []; // cache pour re-render sans attendre le prochain scan

    /* ═══════ HISTORIQUE DES VENTES & VALORISATION ═══════ */
    // Cache localStorage des ventes passées par carte : card_id → { median, count, fetchedAt }
    // L'historique bouge sur des jours/semaines, donc un TTL long évite de refetcher inutilement.
    const SALES_CACHE_KEY = 'wm_sales_cache';
    const SALES_CACHE_TTL = 12 * 3600 * 1000; // 12h
    let salesCache = {};
    try { salesCache = JSON.parse(localStorage.getItem(SALES_CACHE_KEY) || '{}') || {}; } catch(e) { salesCache = {}; }
    function saveSalesCache() {
        try {
            // Purge les entrées périmées (>TTL) avant d'écrire : getCachedSales() les traite
            // déjà comme invalides à la lecture, donc les retirer du stockage ne change aucun
            // comportement (elles seront simplement re-fetchées, comme un cache-miss normal).
            // Sans ça, ce cache grossit indéfiniment (une entrée par carte distincte croisée
            // en scan) et devenait l'une des plus grosses clés localStorage du compte.
            const now = Date.now();
            for (const id in salesCache) {
                if (now - (salesCache[id].fetchedAt || 0) > SALES_CACHE_TTL) delete salesCache[id];
            }
            localStorage.setItem(SALES_CACHE_KEY, JSON.stringify(salesCache));
        } catch(e) {}
    }
    // Purge immédiatement au chargement du script (pas seulement à la prochaine vente fetchée) :
    // un cache déjà gonflé par les anciennes versions doit dégonfler dès le premier chargement
    // de la page, sans attendre qu'un fetchCardSales() ait l'occasion de tourner — sinon un
    // quota déjà dépassé ne se résorbe pas tout seul.
    saveSalesCache();
    function getCachedSales(cardId) {
        const entry = salesCache[cardId];
        if (!entry) return null;
        if (Date.now() - entry.fetchedAt > SALES_CACHE_TTL) return null; // périmé
        // Invalide les entrées de l'ancien format (avant l'ajout de avg/min/max/last)
        if (entry.count > 0 && entry.avg === undefined) return null;
        // Normalise les médianes à demi-entier des anciennes entrées (cache d'avant l'arrondi)
        if (Number.isFinite(entry.median) && entry.median % 1 !== 0) entry.median = Math.round(entry.median);
        return entry;
    }
    // File d'attente des cartes à fetcher (étalée pour ne pas flooder l'API)
    const salesFetchQueue = [];
    const salesFetchQueued = new Set(); // évite les doublons dans la file
    let salesFetchRunning = false;

    function median(nums) {
        if (!nums.length) return 0;
        const s = [...nums].sort((a, b) => a - b);
        const mid = Math.floor(s.length / 2);
        // Arrondi à l'entier : on ne peut pas miser en dessous de 1, ni en décimales
        const m = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
        return Math.round(m);
    }

    // Récupère et met en cache l'historique d'une carte (une requête)
    async function fetchCardSales(cardId) {
        try {
            const res = await fetch(
                `https://www.wiki-masters.com/api/marketplace/cards/${cardId}/sales`,
                { credentials: "include" }
            );
            if (!res.ok) return null;
            const data = await res.json();
            const sales = (data.sales || []).filter(s => Number.isFinite(s.final_price));
            const prices = sales.map(s => s.final_price);
            // "recent" est trié du plus récent au plus ancien côté API ; sinon on trie nous-mêmes
            const recent = (data.recent && data.recent.length ? data.recent : sales)
                .filter(s => Number.isFinite(s.final_price))
                .slice()
                .sort((a, b) => new Date(b.settled_at) - new Date(a.settled_at));
            const entry = {
                median: median(prices),
                count: prices.length,
                last: recent.length ? recent[0].final_price : null,
                avg: prices.length ? Math.round(prices.reduce((s, p) => s + p, 0) / prices.length) : null,
                min: prices.length ? Math.min(...prices) : null,
                max: prices.length ? Math.max(...prices) : null,
                fetchedAt: Date.now()
            };
            salesCache[cardId] = entry;
            saveSalesCache();
            return entry;
        } catch(e) { return null; }
    }

    // Traite la file d'attente, une carte à la fois avec délai aléatoire (anti-flood)
    async function processSalesQueue(onUpdate) {
        if (salesFetchRunning) return;
        salesFetchRunning = true;
        while (salesFetchQueue.length > 0) {
            const cardId = salesFetchQueue.shift();
            salesFetchQueued.delete(cardId);
            if (getCachedSales(cardId)) continue; // déjà en cache valide entre-temps
            await fetchCardSales(cardId);
            if (onUpdate) onUpdate();
            // Délai aléatoire 2-4s entre chaque requête pour étaler la charge
            await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
        }
        salesFetchRunning = false;
    }

    function queueSalesFetch(cardId) {
        if (!cardId || salesFetchQueued.has(cardId) || getCachedSales(cardId)) return;
        salesFetchQueued.add(cardId);
        salesFetchQueue.push(cardId);
    }

    // Calcule le statut de valorisation d'une enchère par rapport à son historique.
    // Retourne :
    //   - null               → pas encore chargé (afficher ⋯)
    //   - { status:'none' }  → chargé mais aucune vente
    //   - { status:'few'|'under'|'fair'|'over', ... } → données disponibles
    function computeValuation(currentPrice, cardId) {
        const entry = getCachedSales(cardId);
        if (!entry) return null; // pas en cache → en cours de chargement
        if (entry.count === 0) {
            return { status: 'none', label: 'aucune vente', color: '#555', median: 0, count: 0, tip: 'Aucune vente enregistrée pour cette carte' };
        }
        // Tooltip détaillé commun à tous les statuts
        const fmt = (n) => (n == null ? '?' : Number(n).toLocaleString('fr-FR'));
        const tip = `${entry.count} vente(s)`
            + ` · dernier ${fmt(entry.last)} 💰`
            + ` · moy. ${fmt(entry.avg)} 💰`
            + ` · méd. ${fmt(entry.median)} 💰`
            + ` · min ${fmt(entry.min)} 💰`
            + ` · max ${fmt(entry.max)} 💰`;
        if (entry.count < 3) {
            return { status: 'few', label: `~${entry.median} (${entry.count} vente${entry.count > 1 ? 's' : ''})`, color: '#666', median: entry.median, count: entry.count, tip };
        }
        const ratio = currentPrice / entry.median;
        if (ratio < 0.75) {
            return { status: 'under', label: `sous-coté · méd. ${entry.median}`, color: '#4ade80', median: entry.median, count: entry.count, tip };
        } else if (ratio > 1.25) {
            return { status: 'over', label: `surcoté · méd. ${entry.median}`, color: '#ef4444', median: entry.median, count: entry.count, tip };
        } else {
            return { status: 'fair', label: `dans la moy. · méd. ${entry.median}`, color: '#888', median: entry.median, count: entry.count, tip };
        }
    }

    // Décide si une enchère doit déclencher un auto-snipe, selon le mode configuré.
    // Retourne { snipe: bool, reason: string, cap: number }.
    // `cap` = le seuil retenu pour CETTE enchère (fixe, ou dérivé de la médiane en dynamique).
    // Il sert de plafond au Hunter agressif : miser plus haut que le seuil qui a rendu la
    // carte intéressante n'aurait aucun sens.
    //   - mode 'fixed'    : snipe si prix <= seuil fixe (autoSnipePrice)
    //   - mode 'adaptive' : snipe si prix <= ratio × médiane marché de la carte.
    //                       Si pas d'historique (cache absent ou 0 vente), on retombe
    //                       sur le seuil fixe comme garde-fou.
    function shouldAutoSnipe(auction) {
        const currentBid = auction.current_bid ?? auction.base_amount ?? 0;
        const mode = getSetting('autoSnipeMode');
        if (mode === 'adaptive') {
            const cardId = auction.card?.id ?? auction.card_id;
            const entry = getCachedSales(cardId);
            if (entry && entry.count > 0 && entry.median > 0) {
                const ratio = getSetting('autoSnipeAdaptiveRatio');
                const threshold = Math.floor(entry.median * ratio);
                if (currentBid <= threshold) {
                    return { snipe: true, reason: `≤ ${Math.round(ratio*100)}% méd. (${entry.median})`, cap: threshold };
                }
                return { snipe: false, cap: threshold };
            }
            // Pas d'historique : garde-fou sur le seuil fixe
            const fixed = getSetting('autoSnipePrice');
            return { snipe: currentBid <= fixed, reason: currentBid <= fixed ? `≤ ${fixed} (pas d'historique)` : '', cap: fixed };
        }
        // Mode fixe
        const fixed = getSetting('autoSnipePrice');
        return { snipe: currentBid <= fixed, reason: currentBid <= fixed ? `≤ ${fixed}` : '', cap: fixed };
    }

    // Historique des cartes ouvertes via pack opener qui matchent un mot-clé (persisté)
    const PACK_KW_HITS_KEY = 'wm_pack_kw_hits';
    let packKwHits = []; // [{ title, rarity, keyword, ts }] — max 100
    try { packKwHits = JSON.parse(localStorage.getItem(PACK_KW_HITS_KEY) || '[]'); } catch(e) {}
    function savePackKwHits() {
        try { localStorage.setItem(PACK_KW_HITS_KEY, JSON.stringify(packKwHits.slice(-100))); } catch(e) {}
    }
    function renderPackKwHits() {
        const el = document.getElementById('wm-pack-kw-hits');
        const lbl = document.getElementById('wm-pack-kw-count');
        if (!el) return;
        if (lbl) lbl.innerText = packKwHits.length;
        if (packKwHits.length === 0) {
            el.innerHTML = `<div style="color:#444;font-size:10px;text-align:center;padding:8px 0;font-style:italic;">Aucun match pour l'instant</div>`;
            return;
        }
        // Plus récent en premier
        const now = new Date();
        const todayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
        el.innerHTML = [...packKwHits].reverse().map(h => {
            const r = RARITY[h.rarity] || { color: '#888' };
            const d = new Date(h.ts);
            const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
            const sameDay = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` === todayKey;
            const label = sameDay
                ? time
                : `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')} ${time}`;
            return `<div style="
                display:flex;align-items:center;gap:5px;padding:3px 5px;margin-bottom:2px;
                border-radius:4px;background:linear-gradient(to right, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.03) 60%, ${r.color}66 100%);
                border:1px solid ${r.color}33;font-size:10px;">
                <span style="color:#666;font-family:monospace;font-size:9px;min-width:32px;white-space:nowrap;" title="${d.toLocaleString('fr-FR')}">${label}</span>
                <span style="color:#fff;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${h.title}">${h.title}</span>
                ${badge(h.rarity)}
                <span style="color:#00FFFF;font-size:9px;opacity:0.7;
                    background:rgba(0,255,255,0.1);padding:1px 4px;border-radius:3px;
                    box-sizing:border-box;width:82px;text-align:center;
                    display:inline-block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                    vertical-align:middle;" title="${h.keyword}">${h.keyword}</span>
            </div>`;
        }).join('');
    }

    /* ===================== SETTINGS (localStorage) ===================== */

    const SETTINGS_KEYS = {
        discordWebhook:        'wm_discord_webhook',
        discordEnabled:        'wm_discord_enabled',
        logCollection:         'wm_log_collection',
        logMarket:             'wm_log_market',
        logTrash:              'wm_log_trash',
        logAutobid:            'wm_log_autobid',
        autoSnipePrice:        'wm_autosnipe_price',
        autoSnipeMode:         'wm_autosnipe_mode',
        autoSnipeAdaptiveRatio:'wm_autosnipe_adaptive_ratio',
        minBalanceForAutoSnipe: 'wm_autosnipe_min_balance',
        autoRetagEnabled:      'wm_autoretag_enabled',
        sellTagName:           'wm_sell_tag_name',
        packCooldown:          'wm_pack_cooldown',
        maxActiveSales:        'wm_max_active_sales',
        soundsEnabled:         'wm_sounds_enabled',
        soundNewHit:           'wm_sound_new_hit',
        soundOutbid:           'wm_sound_outbid',
        soundPackOpen:         'wm_sound_pack_open',
        soundLegendary:        'wm_sound_legendary',
        soundWon:              'wm_sound_won',
        wishlistToKeyword:     'wm_wishlist_to_keyword',
        notificationsEnabled:  'wm_notifications_enabled',
        dailyPackAlert:        'wm_daily_pack_alert',
        dailyPackLimit:        'wm_daily_pack_limit',
        humanizedBidDelayMs:   'wm_humanized_bid_delay_ms',
        usernameOverride:      'wm_username_override',
        autoBackupOnStop:      'wm_autobackup_on_stop',
        periodicBackupMin:     'wm_periodic_backup_min',
        scheduleEnabled:       'wm_schedule_enabled',
        scheduleStart:         'wm_schedule_start',
        scheduleEnd:           'wm_schedule_end',
        // Horaires par module (splittés) : Pack Opener / Market Watcher / Trash Seller
        schedulePackEnabled:   'wm_schedule_pack_enabled',
        schedulePackStart:     'wm_schedule_pack_start',
        schedulePackEnd:       'wm_schedule_pack_end',
        scheduleMarketEnabled: 'wm_schedule_market_enabled',
        scheduleMarketStart:   'wm_schedule_market_start',
        scheduleMarketEnd:     'wm_schedule_market_end',
        scheduleTrashEnabled:  'wm_schedule_trash_enabled',
        scheduleTrashStart:    'wm_schedule_trash_start',
        scheduleTrashEnd:      'wm_schedule_trash_end',
        sellUseMarketPrice:    'wm_sell_use_market_price',
        sellMarketPricePct:    'wm_sell_market_pct',
        sellMarketFloor:       'wm_sell_market_floor',
        sellOnlyIfSoleTag:     'wm_sell_only_if_sole_tag',
        sellDegressive:        'wm_sell_degressive',
        sellUndercutMarket:    'wm_sell_undercut_market',
        autoTagPacksFromPresets: 'wm_autotag_packs_presets',
        autoTagSkipLegendary:  'wm_autotag_skip_legendary',
        snipeSecondsBefore:    'wm_snipe_seconds',
        trashSellStrategy:     'wm_trash_sell_strategy',
    };

    const SETTINGS_DEFAULTS = {
        discordWebhook:        '',
        discordEnabled:        true,
        logCollection:         true,
        logMarket:             true,
        logTrash:              true,
        logAutobid:            true,
        autoSnipePrice:        100,
        autoSnipeMode:         'fixed',   // 'fixed' = seuil fixe · 'adaptive' = sous la médiane marché
        autoSnipeAdaptiveRatio: 0.85,     // en mode adaptatif : snipe si prix <= ratio × médiane
        minBalanceForAutoSnipe: 2000,
        autoRetagEnabled:      true,
        sellTagName:           'Trash',
        packCooldown:          180,
        maxActiveSales:        5,
        soundsEnabled:         true,     // (déprécié — conservé pour migration) master historique
        soundNewHit:           true,     // son à l'apparition d'une enchère qui match
        soundOutbid:           true,     // son à la perte du lead (surenchéri)
        soundPackOpen:         false,    // son à chaque ouverture de pack (off par défaut : peut spammer)
        soundLegendary:        true,     // son quand une Légendaire est pack
        soundWon:              true,     // son quand une enchère est gagnée
        wishlistToKeyword:     true,     // ajout wishlist sur le site → ajoute la carte aux mots-clés
        notificationsEnabled:  true,
        dailyPackAlert:        false,
        dailyPackLimit:        300,
        humanizedBidDelayMs:   2000,      // plafond du délai "humanisé" avant une mise (0 = instantané partout)
        usernameOverride:      '',        // pseudo forcé (après changement de pseudo sur le site ; vide = auto)
        autoBackupOnStop:      true,      // envoie le backup sur Discord lors d'un "Tout arrêter"
        periodicBackupMin:     0,         // backup auto léger sur Discord toutes les N min (0 = off)
        scheduleEnabled:       false,     // (hérité) ancien horaire global — migré vers les 3 ci-dessous
        scheduleStart:         '09:00',   // heure de démarrage (HH:MM, heure locale)
        scheduleEnd:           '23:00',   // heure d'arrêt (HH:MM, heure locale)
        schedulePackEnabled:   false,     // horaire propre au Pack Opener
        schedulePackStart:     '09:00',
        schedulePackEnd:       '23:00',
        scheduleMarketEnabled: false,     // horaire propre au Market Watcher
        scheduleMarketStart:   '09:00',
        scheduleMarketEnd:     '23:00',
        scheduleTrashEnabled:  false,     // horaire propre au Trash Seller
        scheduleTrashStart:    '09:00',
        scheduleTrashEnd:      '23:00',
        sellUseMarketPrice:    false,     // Trash Seller : prix = moyenne des ventes × % (repli tableau)
        sellMarketPricePct:    100,       // % appliqué au prix moyen du marché
        sellMarketFloor:       true,      // prix marché : jamais sous le prix du tableau (plancher)
        sellOnlyIfSoleTag:     true,      // filet de sécurité : ne vendre que si le tag de vente est le SEUL tag
        sellDegressive:        true,      // Trash Seller : -15% de prix par tranche de 10 remises en vente (invendus)
        sellUndercutMarket:    true,      // Trash Seller : se placer juste sous la plus basse annonce active existante
        autoTagPacksFromPresets: false,   // étiquette auto les cartes packées selon les recherches enregistrées
        autoTagSkipLegendary:  true,      // n'auto-étiquette PAS les Légendaires (on veut souvent les garder)
        snipeSecondsBefore:    10,        // mode Fourbe : secondes restantes visées pour le snipe
        trashSellStrategy:     'coverage',// pool de vente : coverage | value | rarity | random
    };

    function getSetting(key) {
        const storageKey = SETTINGS_KEYS[key];
        const defaultVal = SETTINGS_DEFAULTS[key];
        const raw = localStorage.getItem(storageKey);
        if (raw === null) return defaultVal;
        if (typeof defaultVal === 'boolean') return raw === 'true';
        if (typeof defaultVal === 'number') {
            const n = parseFloat(raw);
            return Number.isFinite(n) ? n : defaultVal;
        }
        return raw;
    }

    function setSetting(key, value) {
        const storageKey = SETTINGS_KEYS[key];
        if (value === '' || value === null || value === undefined) {
            localStorage.removeItem(storageKey);
        } else {
            localStorage.setItem(storageKey, String(value));
        }
    }

    // Migration : purge des clés devenues obsolètes (anciennes versions du script)
    try {
        localStorage.removeItem('wm_pack_zero_ts');
        localStorage.removeItem('wm_observed_pack_cooldown_ms');
    } catch(e) {}

    // Migration : l'ancien réglage unique "Sons d'alerte" est éclaté en 2 (apparition /
    // perte du lead). On reprend l'état on/off historique pour les 2 nouveaux réglages.
    try {
        const oldSounds = localStorage.getItem('wm_sounds_enabled');
        if (oldSounds !== null) {
            if (localStorage.getItem('wm_sound_new_hit') === null) localStorage.setItem('wm_sound_new_hit', oldSounds);
            if (localStorage.getItem('wm_sound_outbid') === null) localStorage.setItem('wm_sound_outbid', oldSounds);
        }
    } catch(e) {}

    // Migration : l'ancien horaire GLOBAL (3 modules ensemble) est splitté en 3 horaires
    // par module. Si l'ancien était activé, on recopie sa plage sur les 3 modules pour ne
    // pas perdre la config. Exécuté une seule fois (flag), AVANT que le panneau ne se peuple.
    try {
        if (!localStorage.getItem('wm_schedule_split_v1')) {
            if (getSetting('scheduleEnabled')) {
                const s = getSetting('scheduleStart'), e = getSetting('scheduleEnd');
                [['schedulePackEnabled','schedulePackStart','schedulePackEnd'],
                 ['scheduleMarketEnabled','scheduleMarketStart','scheduleMarketEnd'],
                 ['scheduleTrashEnabled','scheduleTrashStart','scheduleTrashEnd']]
                .forEach(([ena, st, en]) => { setSetting(ena, true); setSetting(st, s); setSetting(en, e); });
            }
            localStorage.setItem('wm_schedule_split_v1', '1');
        }
    } catch(e) {}

    /* ===================== LOG ===================== */

    /* ── Log (accessible depuis toutes les fonctions du module) ── */
    const logEntries = [];

    // Détecte la catégorie d'un log à partir de son contenu (ordre important :
    // les patterns plus spécifiques d'abord)
    function detectLogCategory(msg) {
        const text = String(msg).replace(/<[^>]+>/g, '');
        // 1. autobid (les patterns auto-bid passent AVANT trash/market pour gagner
        //    sur "Auto-bid (riposte)" ou "Hot-lane bid")
        if (/Auto-bid|Auto-snipe|Hunter|Hot-lane bid/.test(text)) return 'autobid';
        // 2. trash
        if (/Trash|Invendu|Vendu|Mis en vente|Échec mise en vente|user_card_id|Re-tag|Annulation|Carte retirée|Carte ignorée|🔍 Scan/.test(text)) return 'trash';
        // 3. market
        if (/Market Watcher|Hot-lane|Enchère|Surenchéri|Nouveau match/.test(text)) return 'market';
        // 4. collection
        if (/Collection|Refresh collection/.test(text)) return 'collection';
        // 5. system (jamais filtré)
        return 'system';
    }

    const CATEGORY_TO_SETTING = {
        collection: 'logCollection',
        market:     'logMarket',
        trash:      'logTrash',
        autobid:    'logAutobid',
    };

    function isLogCategoryEnabled(category) {
        const setting = CATEGORY_TO_SETTING[category];
        return setting ? getSetting(setting) : true; // system → toujours visible
    }

    function wmLog(msg) {
        const category = detectLogCategory(msg);
        if (!isLogCategoryEnabled(category)) return;
        const t = new Date();
        const ts = [t.getHours(),t.getMinutes(),t.getSeconds()].map(n=>String(n).padStart(2,'0')).join(':');
        logEntries.push({ts, msg});
        if (logEntries.length > 9000000) logEntries.shift();
        const el = document.getElementById('wm-log');
        if (el) el.innerHTML = [...logEntries].reverse().map(e=>`<div class="wm-log-e"><span style="color:#333">${e.ts}</span> ${e.msg}</div>`).join('');
    }

    // Exporte le log en .txt (HTML strippé, 1 ligne par entry).
    function exportLogs() {
        if (logEntries.length === 0) {
            wmLog('⚠️ Aucun log à exporter');
            return;
        }
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        const dateStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
        const timeStr = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
        const filename = `wm-logs-${dateStr}_${timeStr}.txt`;

        // Strip HTML pour chaque entry (utilise un div temporaire — robuste face à tout markup)
        const stripper = document.createElement('div');
        const lines = logEntries.map(e => {
            stripper.innerHTML = e.msg;
            const text = (stripper.textContent || stripper.innerText || '').trim();
            return `[${e.ts}] ${text}`;
        });
        const header = `# WikiMasters Bot — log export\n# ${now.toISOString()}\n# ${logEntries.length} entrées\n\n`;
        const blob = new Blob([header + lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        wmLog(`💾 Log exporté : <b>${filename}</b> (${logEntries.length} ligne${logEntries.length>1?'s':''})`);
    }

    function sortHits(hits) {
        const arr = [...hits];
        const bidOf = (a) => a.current_bid ?? a.base_amount ?? 0;
        const rarOf = (a) => RARITY_ORDER[(a.card?.rarity || '').toUpperCase()] ?? -1;
        const titleOf = (a) => (a.card?.wikipedia_title || '').toLowerCase();
        const endOf = (a) => new Date(a.end_at).getTime();
        const seenOf = (a) => firstSeenMap.get(a.id) ?? 0;
        const ownedOf = (a) => collectionMap.get(a.card?.id ?? a.card_id) ?? 0;
        const outbidAtOf = (a) => outbidAtMap.get(a.id) ?? 0;
        switch (marketSortKey) {
            case 'outbid_recent':
                // Mises perdues d'abord (regroupées en haut), la plus récemment perdue
                // en premier ; le reste ensuite trié par fin proche.
                arr.sort((a, b) => {
                    const oa = outbidSet.has(a.id) ? 1 : 0;
                    const ob = outbidSet.has(b.id) ? 1 : 0;
                    if (oa !== ob) return ob - oa;
                    if (oa === 1) return outbidAtOf(b) - outbidAtOf(a); // plus récent en premier
                    return endOf(a) - endOf(b);
                });
                break;
            case 'time_desc':   arr.sort((a,b) => endOf(b) - endOf(a)); break;
            case 'price_asc':   arr.sort((a,b) => bidOf(a) - bidOf(b)); break;
            case 'price_desc':  arr.sort((a,b) => bidOf(b) - bidOf(a)); break;
            case 'rarity_desc': arr.sort((a,b) => rarOf(b) - rarOf(a)); break;
            case 'rarity_asc':  arr.sort((a,b) => rarOf(a) - rarOf(b)); break;
            case 'title_asc':   arr.sort((a,b) => titleOf(a).localeCompare(titleOf(b))); break;
            case 'recent':      arr.sort((a,b) => seenOf(b) - seenOf(a)); break;
            case 'owned_asc':   arr.sort((a,b) => ownedOf(a) - ownedOf(b) || endOf(a) - endOf(b)); break;
            case 'owned_desc':  arr.sort((a,b) => ownedOf(b) - ownedOf(a) || endOf(a) - endOf(b)); break;
            case 'time_asc':
            default:            arr.sort((a,b) => endOf(a) - endOf(b)); break;
        }
        return arr;
    }

    /* ===================== UTILS ===================== */

    function loadKeywords() {
        try {
            const raw = localStorage.getItem(KEYWORDS_STORAGE_KEY);
            if (raw) KEYWORDS_ALERT = JSON.parse(raw);
        } catch(e) {}
        try {
            const rawP = localStorage.getItem(KEYWORDS_PRIORITY_KEY);
            if (rawP) KEYWORDS_PRIORITY = JSON.parse(rawP);
        } catch(e) {}
        try {
            const rawF = localStorage.getItem(KEYWORDS_FOURBE_KEY);
            if (rawF) KEYWORDS_FOURBE = JSON.parse(rawF);
        } catch(e) {}
        try {
            const rawE = localStorage.getItem(KEYWORDS_EXCLUDE_KEY);
            if (rawE) KEYWORDS_EXCLUDE = JSON.parse(rawE);
        } catch(e) {}
        try {
            const rawH = localStorage.getItem(KEYWORDS_HUNTER_KEY);
            if (rawH) {
                const arr = JSON.parse(rawH);
                if (Array.isArray(arr)) {
                    // Normalise : text (string), cap (nombre > 0), mode ('autobid'|'fourbe'),
                    // rarity (l'un des 6 codes, ou '' = aucun filtre), enabled (par défaut
                    // true — seule une désactivation EXPLICITE la passe à false, pour que les
                    // chasses créées avant cette fonctionnalité restent actives), autoDisable
                    // (par défaut false — opt-in, comportement d'avant inchangé si absent).
                    // Cette reconstruction ÉCARTE tout champ non listé ici : chaque nouveau
                    // champ doit y figurer explicitement, sinon il serait effacé en silence à
                    // chaque rechargement de page (déjà vécu avec `rarity`).
                    KEYWORDS_HUNTER = arr
                        .map(h => ({
                            text: String(h && h.text || '').trim(),
                            cap: Number(h && h.cap),
                            mode: (h && h.mode === 'fourbe') ? 'fourbe' : 'autobid',
                            rarity: normalizeHunterRarity(h && h.rarity),
                            enabled: !(h && h.enabled === false),
                            autoDisable: !!(h && h.autoDisable)
                        }))
                        .filter(h => h.text && Number.isFinite(h.cap) && h.cap > 0);
                }
            }
        } catch(e) {}
    }

    function saveKeywords() {
        try { localStorage.setItem(KEYWORDS_STORAGE_KEY, JSON.stringify(KEYWORDS_ALERT)); } catch(e) {}
    }
    function savePriorityKeywords() {
        try { localStorage.setItem(KEYWORDS_PRIORITY_KEY, JSON.stringify(KEYWORDS_PRIORITY)); } catch(e) {}
    }
    function saveFourbeKeywords() {
        try { localStorage.setItem(KEYWORDS_FOURBE_KEY, JSON.stringify(KEYWORDS_FOURBE)); } catch(e) {}
    }
    function saveExcludeKeywords() {
        try { localStorage.setItem(KEYWORDS_EXCLUDE_KEY, JSON.stringify(KEYWORDS_EXCLUDE)); } catch(e) {}
    }
    function saveHunterKeywords() {
        // Diagnostic temporaire : une entrée ajoutée n'atteignait pas le localStorage (visible
        // dans le panneau — donc bien poussée en mémoire — mais absente de DevTools après coup)
        // sans qu'aucune erreur ne soit jamais remontée nulle part, `catch(e) {}` l'avalant en
        // silence comme partout ailleurs dans ce fichier. Le message réel (le plus probable :
        // QuotaExceededError, si le compte a un gros historique) permettra de confirmer la
        // cause au lieu de continuer à deviner.
        try { localStorage.setItem(KEYWORDS_HUNTER_KEY, JSON.stringify(KEYWORDS_HUNTER)); }
        catch(e) { wmLog(`⚠️ Sauvegarde Chasseur ciblé ÉCHOUÉE : <b>${e.name || 'Erreur'}</b> — ${e.message || 'inconnue'}. L'entrée reste affichée mais N'A PAS été enregistrée.`); }
    }

    // Exclusion STRICTE : la carte est exclue si un mot exclu apparaît en SOUS-CHAÎNE
    // (phrase entière) dans le titre/catégorie. Ex. "guitarre basse" n'exclut PAS
    // "guitare électrique" (la sous-chaîne complète n'y est pas).
    function hasExcludedWord(input) {
        if (KEYWORDS_EXCLUDE.length === 0) return false;
        const fields = typeof input === "string"
            ? [input]
            : [input?.wikipedia_title || "", input?.category || ""];
        return KEYWORDS_EXCLUDE.some(k =>
            fields.some(f => f.toLowerCase().includes(k.toLowerCase()))
        );
    }

    function hasPriorityKeyword(input) {
        const fields = typeof input === "string"
            ? [input]
            : [input?.wikipedia_title || "", input?.category || ""];
        return KEYWORDS_PRIORITY.some(k =>
            fields.some(f => f.toLowerCase().includes(k.toLowerCase()))
        );
    }

    // Mots-clés "Fourbe" : arment automatiquement le mode snipe (~10s de la fin) sur les
    // nouvelles enchères qui matchent, au lieu d'une riposte d'auto-bid.
    function hasFourbeKeyword(input) {
        const fields = typeof input === "string"
            ? [input]
            : [input?.wikipedia_title || "", input?.category || ""];
        return KEYWORDS_FOURBE.some(k =>
            fields.some(f => f.toLowerCase().includes(k.toLowerCase()))
        );
    }

    // Chasseur ciblé : renvoie l'entrée { text, cap, mode } qui matche (ou null).
    // On récupère l'objet et pas juste un booléen pour connaître le plafond + le mode.
    // Une entrée désactivée (`enabled === false`) est traitée comme absente : elle ne
    // déclenche rien ici, ET elle n'empêche plus le Hunter générique de reprendre la carte
    // (contrairement à une entrée active, qui le bloque volontairement plus loin).
    function matchedHunterEntry(input) {
        const fields = typeof input === "string"
            ? [input]
            : [input?.wikipedia_title || "", input?.category || ""];
        return KEYWORDS_HUNTER.find(h =>
            h.enabled !== false &&
            fields.some(f => f.toLowerCase().includes((h.text || '').toLowerCase()))
        ) || null;
    }
    function hasHunterKeyword(input) { return !!matchedHunterEntry(input); }

    function renderKeywordsPanel() {
        const el = document.getElementById('wm-keywords-panel');
        if (!el) return;
        const label = document.getElementById('wm-kw-label');
        if (label) label.innerText = `Mots-clés (${KEYWORDS_ALERT.length + KEYWORDS_PRIORITY.length + KEYWORDS_FOURBE.length + KEYWORDS_HUNTER.length}) · Exclus (${KEYWORDS_EXCLUDE.length})`;

        const renderTag = (kw, i, type) => {
            const isP = type === 'priority', isE = type === 'exclude', isF = type === 'fourbe';
            const color  = isE ? '#ef4444' : isP ? '#fbbf24' : isF ? '#c084fc' : '#06b6d4';
            const bg     = isE ? 'rgba(239,68,68,0.08)' : isP ? 'rgba(251,191,36,0.07)' : isF ? 'rgba(192,132,252,0.08)' : 'rgba(0,255,255,0.07)';
            const border = isE ? 'rgba(239,68,68,0.4)' : isP ? 'rgba(251,191,36,0.35)' : isF ? 'rgba(192,132,252,0.4)' : 'rgba(0,255,255,0.18)';
            const fn     = isE ? 'wmRemoveExcludeKeyword' : isP ? 'wmRemovePriorityKeyword' : isF ? 'wmRemoveFourbeKeyword' : 'wmRemoveKeyword';
            return `<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:4px;
                background:${bg};border:1px solid ${border};
                font-size:10px;color:${color};margin:2px 2px 0 0;">
                ${kw}
                <button onclick="window.${fn}(${i})" style="
                    background:none;border:none;color:#666;cursor:pointer;
                    font-size:12px;padding:0 0 0 2px;line-height:1;" title="Retirer">×</button>
            </span>`;
        };

        const priorityTags = KEYWORDS_PRIORITY.map((kw, i) => renderTag(kw, i, 'priority')).join('');
        const fourbeTags   = KEYWORDS_FOURBE.map((kw, i)   => renderTag(kw, i, 'fourbe')).join('');
        const normalTags   = KEYWORDS_ALERT.map((kw, i)   => renderTag(kw, i, 'normal')).join('');
        const excludeTags  = KEYWORDS_EXCLUDE.map((kw, i)  => renderTag(kw, i, 'exclude')).join('');

        // Chasseur ciblé : chaque tag affiche le mot-clé + son mode + son plafond + sa
        // rareté requise (si définie) + un indicateur d'auto-pause (si activée). Une chasse
        // en pause est grisée pour être identifiable d'un coup d'œil, sans devoir lire le
        // texte du bouton — cohérent avec le reste des indicateurs d'état du bot.
        const escH = (s) => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
        const hunterTags = KEYWORDS_HUNTER.map((h, i) => {
            const enabled = h.enabled !== false;
            const modeStr = h.mode === 'fourbe' ? '🕵️ fourbe' : '🤖 auto-bid';
            const rarStr = h.rarity ? ` · <span style="color:${(RARITY[h.rarity] || {}).color || '#5dade2'};font-weight:700;">${h.rarity}</span> requise` : '';
            const adStr = h.autoDisable ? ` · <span title="Se met en pause toute seule après avoir gagné une enchère">🔁➜⏸️</span>` : '';
            return `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 6px;border-radius:4px;
                background:${enabled ? 'rgba(52,152,219,0.1)' : 'rgba(255,255,255,0.03)'};
                border:1px solid ${enabled ? 'rgba(52,152,219,0.45)' : 'rgba(255,255,255,0.12)'};
                font-size:10px;color:${enabled ? '#5dade2' : '#666'};margin:2px 2px 0 0;
                ${enabled ? '' : 'opacity:0.65;'}">
                ${enabled ? '' : '⏸️ '}${escH(h.text)}
                <span style="color:#888;font-size:9px;">${modeStr} · ≤${h.cap} 💰${rarStr}${adStr}</span>
                <button onclick="window.wmToggleHunterEnabled(${i})" style="
                    background:none;border:none;color:${enabled ? '#4ade80' : '#888'};cursor:pointer;
                    font-size:11px;padding:0 0 0 2px;line-height:1;"
                    title="${enabled ? 'Mettre en pause (garde la config, arrête les mises)' : 'Réactiver'}">${enabled ? '⏸️' : '▶️'}</button>
                <button onclick="window.wmRemoveHunterKeyword(${i})" style="
                    background:none;border:none;color:#666;cursor:pointer;
                    font-size:12px;padding:0 0 0 2px;line-height:1;" title="Supprimer définitivement">×</button>
            </span>`;
        }).join('');

        el.innerHTML = `
            <div style="font-size:9px;color:#fbbf24;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">⭐ Prioritaires <span style="color:#666;text-transform:none;letter-spacing:0;font-size:9px;">(auto-bid forcé)</span></div>
            <div style="display:flex;flex-wrap:wrap;margin-bottom:6px;">${priorityTags || '<span style="color:#444;font-size:10px;">Aucun</span>'}</div>
            <div style="display:flex;gap:4px;margin-bottom:10px;">
                <input id="wm-kwp-input" type="text" placeholder="Ajouter… (plusieurs : sépare par ;)"
                    style="flex:1;padding:3px 6px;border-radius:4px;border:1px solid rgba(251,191,36,0.3);
                    background:#0f0f13;color:#fff;font-size:11px;outline:none;"
                    onkeydown="if(event.key==='Enter'){window.wmAddPriorityKeyword(this.value);this.value='';}" />
                <button onclick="const i=document.getElementById('wm-kwp-input');window.wmAddPriorityKeyword(i.value);i.value='';"
                    style="padding:3px 10px;border-radius:4px;border:1px solid rgba(251,191,36,0.3);
                    background:rgba(251,191,36,0.1);color:#fbbf24;font-size:13px;cursor:pointer;font-weight:700;">+</button>
            </div>
            <div style="font-size:9px;color:#c084fc;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">🕵️ Fourbe <span style="color:#666;text-transform:none;letter-spacing:0;font-size:9px;">(snipe auto en fin d'enchère)</span></div>
            <div style="display:flex;flex-wrap:wrap;margin-bottom:6px;">${fourbeTags || '<span style="color:#444;font-size:10px;">Aucun</span>'}</div>
            <div style="display:flex;gap:4px;margin-bottom:10px;">
                <input id="wm-kwf-input" type="text" placeholder="Ajouter… (plusieurs : sépare par ;)"
                    style="flex:1;padding:3px 6px;border-radius:4px;border:1px solid rgba(192,132,252,0.3);
                    background:#0f0f13;color:#fff;font-size:11px;outline:none;"
                    onkeydown="if(event.key==='Enter'){window.wmAddFourbeKeyword(this.value);this.value='';}" />
                <button onclick="const i=document.getElementById('wm-kwf-input');window.wmAddFourbeKeyword(i.value);i.value='';"
                    style="padding:3px 10px;border-radius:4px;border:1px solid rgba(192,132,252,0.3);
                    background:rgba(192,132,252,0.1);color:#c084fc;font-size:13px;cursor:pointer;font-weight:700;">+</button>
            </div>
            <div style="font-size:9px;color:#5dade2;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">🎯 Chasseur ciblé <span style="color:#666;text-transform:none;letter-spacing:0;font-size:9px;">(mise + mode + plafond par mot-clé)</span></div>
            <div style="display:flex;flex-wrap:wrap;margin-bottom:6px;">${hunterTags || '<span style="color:#444;font-size:10px;">Aucun</span>'}</div>
            <div style="display:flex;gap:4px;margin-bottom:4px;">
                <input id="wm-kwh-text" type="text" placeholder="Mot-clé (ex. gare ferroviaire japonaise)"
                    style="flex:1;min-width:0;padding:3px 6px;border-radius:4px;border:1px solid rgba(52,152,219,0.3);
                    background:#0f0f13;color:#fff;font-size:11px;outline:none;" />
                <select id="wm-kwh-mode" title="Mode" style="padding:3px 4px;border-radius:4px;border:1px solid rgba(52,152,219,0.3);background:#0f0f13;color:#fff;font-size:10px;outline:none;">
                    <option value="fourbe">🕵️ Fourbe</option>
                    <option value="autobid">🤖 Auto-bid</option>
                </select>
                <select id="wm-kwh-rarity" title="Rareté requise : la mise n'a lieu QUE si la carte est actuellement dans cette rareté précise. Utile si tu sais qu'elle va bientôt en changer et que tu ne veux pas miser au mauvais prix. « Toutes » = pas de filtre (comportement d'avant)." style="padding:3px 4px;border-radius:4px;border:1px solid rgba(52,152,219,0.3);background:#0f0f13;color:#fff;font-size:10px;outline:none;">
                    <option value="">Toutes raretés</option>
                    <option value="L">L</option>
                    <option value="UR">UR</option>
                    <option value="SR">SR</option>
                    <option value="R">R</option>
                    <option value="PC">PC</option>
                    <option value="C">C</option>
                </select>
                <input id="wm-kwh-cap" type="number" min="1" step="1" placeholder="Plafond"
                    style="width:64px;padding:3px 6px;border-radius:4px;border:1px solid rgba(52,152,219,0.3);
                    background:#0f0f13;color:#fff;font-size:11px;outline:none;" />
                <button onclick="window.wmAddHunterKeyword(document.getElementById('wm-kwh-text').value, document.getElementById('wm-kwh-cap').value, document.getElementById('wm-kwh-mode').value, document.getElementById('wm-kwh-rarity').value, document.getElementById('wm-kwh-autodisable').checked)"
                    style="padding:3px 10px;border-radius:4px;border:1px solid rgba(52,152,219,0.3);
                    background:rgba(52,152,219,0.12);color:#5dade2;font-size:13px;cursor:pointer;font-weight:700;">+</button>
            </div>
            <label style="display:flex;align-items:center;gap:5px;margin:-2px 0 6px;font-size:9px;color:#888;cursor:pointer;user-select:none;"
                title="Dès que cette chasse remporte une enchère, elle se met automatiquement en pause (⏸️) — pratique pour ne vouloir qu'UN exemplaire. Décoché (par défaut) : elle reste active, pour collectionner plusieurs fois la même carte.">
                <input type="checkbox" id="wm-kwh-autodisable" style="width:11px;height:11px;accent-color:#5dade2;cursor:pointer;margin:0;flex-shrink:0;">
                <span>Mettre en pause automatiquement après avoir gagné une enchère</span>
            </label>
            <div style="color:#555;font-size:9px;margin-bottom:10px;">Dès qu'une carte matche : mise minimale immédiate, puis <b>fourbe</b> (snipe en fin) ou <b>auto-bid</b> (riposte), jamais au-dessus du plafond. Avec une <b>rareté requise</b> : aucune mise tant que la carte n'est pas dans cette rareté précise — pratique si tu sais qu'elle va bientôt en changer et ne veux pas miser au mauvais prix entre-temps.</div>
            <div style="font-size:9px;color:#06b6d4;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Standards</div>
            <div style="display:flex;flex-wrap:wrap;margin-bottom:6px;">${normalTags || '<span style="color:#444;font-size:10px;">Aucun</span>'}</div>
            <div style="display:flex;gap:4px;margin-bottom:10px;">
                <input id="wm-kw-input" type="text" placeholder="Ajouter… (plusieurs : sépare par ;)"
                    style="flex:1;padding:3px 6px;border-radius:4px;border:1px solid rgba(6,182,212,0.3);
                    background:#0f0f13;color:#fff;font-size:11px;outline:none;"
                    onkeydown="if(event.key==='Enter'){window.wmAddKeyword(this.value);this.value='';}" />
                <button onclick="const i=document.getElementById('wm-kw-input');window.wmAddKeyword(i.value);i.value='';"
                    style="padding:3px 10px;border-radius:4px;border:1px solid rgba(6,182,212,0.3);
                    background:rgba(6,182,212,0.1);color:#06b6d4;font-size:13px;cursor:pointer;font-weight:700;">+</button>
            </div>
            <div style="font-size:9px;color:#ef4444;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">🚫 Exclus <span style="color:#666;text-transform:none;letter-spacing:0;font-size:9px;">(masque strictement les annonces contenant la phrase)</span></div>
            <div style="display:flex;flex-wrap:wrap;margin-bottom:6px;">${excludeTags || '<span style="color:#444;font-size:10px;">Aucun</span>'}</div>
            <div style="display:flex;gap:4px;">
                <input id="wm-kwe-input" type="text" placeholder="Ajouter à exclure… (plusieurs : sépare par ;)"
                    style="flex:1;padding:3px 6px;border-radius:4px;border:1px solid rgba(239,68,68,0.3);
                    background:#0f0f13;color:#fff;font-size:11px;outline:none;"
                    onkeydown="if(event.key==='Enter'){window.wmAddExcludeKeyword(this.value);this.value='';}" />
                <button onclick="const i=document.getElementById('wm-kwe-input');window.wmAddExcludeKeyword(i.value);i.value='';"
                    style="padding:3px 10px;border-radius:4px;border:1px solid rgba(239,68,68,0.3);
                    background:rgba(239,68,68,0.1);color:#ef4444;font-size:13px;cursor:pointer;font-weight:700;">+</button>
            </div>`;
    }

    // Champs texte d'une carte pour le match mots-clés.
    // - includeDesc=false (défaut) : titre + catégorie SEULEMENT → usage marketplace/auto-bid
    //   (on ne veut PAS miser sur une carte qui ne fait que MENTIONNER un mot-clé dans sa desc).
    // - includeDesc=true : titre + catégories + description/résumé/extrait, sur l'objet ET son
    //   .card imbriqué → usage PACK (une carte dont la description matche doit être détectée).
    const KEYWORD_DESC_KEYS = ['wikipedia_title', 'title', 'name', 'category', 'categories',
        'description', 'desc', 'summary', 'extract', 'wikipedia_extract'];
    function keywordFields(input, includeDesc) {
        if (typeof input === "string") return [input];
        if (!input || typeof input !== "object") return [];
        if (!includeDesc) return [input.wikipedia_title || "", input.category || ""];
        const out = [];
        for (const o of [input, input.card]) {
            if (!o || typeof o !== "object") continue;
            for (const k of KEYWORD_DESC_KEYS) {
                const v = o[k];
                if (typeof v === "string") out.push(v);
                else if (Array.isArray(v)) out.push(v.filter(x => typeof x === "string").join(" "));
            }
        }
        return out;
    }

    // Accepte une string ou un objet card. includeDesc=true → cherche aussi dans la description.
    function hasKeyword(input, includeDesc) {
        const fields = keywordFields(input, includeDesc);
        return KEYWORDS_ALERT.some(k =>
            fields.some(f => f.toLowerCase().includes(k.toLowerCase()))
        );
    }

    function matchedKeyword(input, includeDesc) {
        const fields = keywordFields(input, includeDesc);
        // Cherche dans toutes les catégories d'action pour afficher le mot-clé qui a matché.
        for (const list of [KEYWORDS_ALERT, KEYWORDS_PRIORITY, KEYWORDS_FOURBE]) {
            for (const k of list) {
                if (fields.some(f => f.toLowerCase().includes(k.toLowerCase()))) return k;
            }
        }
        return null;
    }

    /* ── Image d'une carte ──
       Champ réel de l'API : `image_url`. Les autres noms restent sondés en repli au cas où
       le schéma évoluerait — ça ne coûte qu'une boucle sur un objet déjà en mémoire.
       Le champ `hide_image` de l'API est DÉLIBÉRÉMENT ignoré : le site s'en sert pour masquer
       certaines illustrations, mais ici on veut voir la carte dès qu'une image existe. Le
       placeholder n'apparaît donc que s'il n'y a réellement aucune URL exploitable.
       Retourne l'URL, ou null. */
    const CARD_IMAGE_KEYS = ['image_url', 'image', 'thumbnail_url', 'thumbnail', 'thumb',
        'img_url', 'img', 'picture', 'photo', 'illustration'];
    function cardImageUrl(card) {
        if (!card || typeof card !== 'object') return null;
        for (const o of [card, card.card]) {
            if (!o || typeof o !== 'object') continue;
            for (const k of CARD_IMAGE_KEYS) {
                const v = o[k];
                const url = (typeof v === 'string') ? v
                          : (v && typeof v === 'object') ? (v.url || v.source || v.href) : null;
                if (typeof url !== 'string' || !url) continue;
                // Protocol-relative (//upload.wikimedia.org/…) : on complète en https.
                if (/^\/\//.test(url)) return 'https:' + url;
                if (/^https?:\/\//i.test(url)) return url;
            }
        }
        return null;
    }
    // Diagnostic tiré UNE fois, et SEULEMENT si AUCUNE carte du lot n'expose d'image : c'est
    // le seul cas qui signale un vrai décalage de schéma. Le déclencher sur la 1re carte sans
    // illustration donnait une fausse alerte (beaucoup d'articles Wikipédia n'ont pas d'image).
    let _marketCardFieldsLogged = false;
    function logMarketCardFieldsOnce(card) {
        if (_marketCardFieldsLogged || !card || typeof card !== 'object') return;
        _marketCardFieldsLogged = true;
        wmLog(`🔬 Vue cadres : aucune des annonces affichées n'expose d'image exploitable. Champs disponibles : <span style="color:#888;font-size:9px;">${Object.keys(card).join(', ')}</span>`);
    }

    // Échappement HTML pour le texte injecté dans les templates (titres, descriptions Wikipédia).
    const htmlEsc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Sous-titre de la carte. L'endpoint marketplace ne renvoie PAS de description (contrairement
    // à la fiche du site) : les clés description/summary/extract restent sondées au cas où, mais
    // en pratique c'est `category` qui fait le sous-titre.
    const CARD_DESC_KEYS = ['description', 'desc', 'summary', 'extract', 'wikipedia_extract',
        'wikipedia_description', 'category'];
    function cardDescription(card) {
        if (!card || typeof card !== 'object') return '';
        for (const o of [card, card.card]) {
            if (!o || typeof o !== 'object') continue;
            for (const k of CARD_DESC_KEYS) {
                const v = o[k];
                if (typeof v === 'string' && v.trim()) return v.trim();
            }
        }
        return '';
    }

    function badge(rarity) {
        const r = RARITY[rarity] || { color: "#aaa", bg: "rgba(170,170,170,0.1)", label: rarity };
        return `<span style="
            display:inline-block; padding:1px 5px; border-radius:4px;
            font-size:10px; font-weight:700; letter-spacing:0.5px;
            color:${r.color}; background:${r.bg}; border:1px solid ${r.color}44;
            vertical-align:middle; white-space:nowrap;
            box-sizing:border-box; width:30px; text-align:center;
        ">${r.label}</span>`;
    }

    function formatTime(ms) {
        const s = Math.floor(ms / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        if (h > 0) return `${h}h ${String(m).padStart(2,"0")}m ${String(sec).padStart(2,"0")}s`;
        return `${String(m).padStart(2,"0")}m ${String(sec).padStart(2,"0")}s`;
    }

    /* ═══════ SYNCHRO HORLOGE SERVEUR ═══════
       Le end_at des enchères est un timestamp ABSOLU du serveur (fiable). MAIS le temps
       restant = end_at − maintenant, et "maintenant" c'était l'horloge LOCALE du PC.
       Si l'horloge du PC est décalée (pas de synchro NTP), le compte à rebours est faux :
       c'est exactement ce qui explique l'écart de ~10s observé entre 2 PC sur la MÊME
       enchère, et ça sabote le timing du snipe.
       → On mesure le décalage PC↔serveur via l'en-tête HTTP "Date" des réponses, et on
       calcule désormais le temps restant contre l'heure SERVEUR corrigée (serverNow()).
       Limite : l'en-tête Date est à la seconde près, donc précision ~±1s (pas la frame
       parfaite, mais ça élimine les décalages de plusieurs secondes). */
    let serverClockOffset = 0;      // serveur − local, en ms
    let serverClockSynced = false;

    // Santé du bot : compteurs d'erreurs API + horodatage des derniers scans réussis.
    // Alimenté globalement par l'intercepteur fetch (429/5xx/réseau) et aux fins de scans.
    const apiHealth = { err429: 0, err5xx: 0, errNet: 0, lastErrTs: 0, lastErrMsg: '', lastMarketScanTs: 0, lastCollectionTs: 0 };
    function syncServerClockFromResponse(res, reqStartMs) {
        try {
            const d = res && res.headers && res.headers.get && res.headers.get('date');
            if (!d) return;
            const serverMs = Date.parse(d);
            if (!Number.isFinite(serverMs)) return;
            // Estime l'instant local correspondant : milieu de l'aller-retour de la requête
            const localMid = Number.isFinite(reqStartMs) ? (reqStartMs + Date.now()) / 2 : Date.now();
            const off = serverMs - localMid;
            // Lissage léger pour absorber le bruit (l'en-tête Date est tronqué à la seconde)
            serverClockOffset = serverClockSynced ? Math.round(serverClockOffset * 0.6 + off * 0.4) : off;
            if (!serverClockSynced) {
                serverClockSynced = true;
                if (Math.abs(off) >= 2000) {
                    wmLog(`🕒 Horloge : décalage PC↔serveur de <b>${(off / 1000).toFixed(1)}s</b> détecté et corrigé pour les compte à rebours.`);
                }
            }
        } catch(e) {}
    }
    // Heure "serveur" estimée (corrige le décalage d'horloge du PC).
    function serverNow() { return Date.now() + serverClockOffset; }

    // Formate le temps restant d'une enchère depuis end_at ISO string
    function formatCountdown(endAtStr) {
        const ms = new Date(endAtStr).getTime() - serverNow();
        if (ms <= 0) return "⏰ terminée";
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        const h = Math.floor(m / 60);
        if (h > 0) return `${h}h ${String(m % 60).padStart(2,"0")}m`;
        if (m > 0) return `${m}m ${String(s % 60).padStart(2,"0")}s`;
        return `${s}s`;
    }

    const STATS_STORAGE_KEY = 'wm_pack_stats';

    function loadSellHistory() {
        try { sellHistory = JSON.parse(localStorage.getItem(SELL_HISTORY_KEY) || '[]'); } catch(e) { sellHistory = []; }
    }
    function saveSellHistory() {
        try { localStorage.setItem(SELL_HISTORY_KEY, JSON.stringify(sellHistory.slice(-500))); } catch(e) {} // garde max 500
    }
    function loadMyBids() {
        try { myBidsSet = new Set(JSON.parse(localStorage.getItem(MY_BIDS_KEY) || '[]')); } catch(e) { myBidsSet = new Set(); }
    }
    function saveMyBids() {
        try { localStorage.setItem(MY_BIDS_KEY, JSON.stringify([...myBidsSet])); } catch(e) {}
    }
    function trackMyBid(auctionId) {
        if (!auctionId || myBidsSet.has(auctionId)) return;
        myBidsSet.add(auctionId);
        saveMyBids();
    }

    function saveStats() {
        try {
            // cardStats n'est jamais affiché ni lu nulle part dans le bot : c'est un compteur
            // par titre de carte qui grossissait indéfiniment (une entrée par carte distincte
            // jamais ouverte) sans aucun usage, jusqu'à devenir la plus grosse clé localStorage
            // du compte (2+ Mo) et provoquer des échecs silencieux d'écriture ailleurs (quota
            // dépassé). On garde le suivi en mémoire au cas où, mais on ne le persiste plus.
            localStorage.setItem(STATS_STORAGE_KEY, JSON.stringify({
                totalPacks, totalCards, rarityStats,
                sessionTotal: Date.now() // temps cumulé total, pas sessionStart
            }));
        } catch(e) {}
    }

    function loadStats() {
        try {
            const raw = localStorage.getItem(STATS_STORAGE_KEY);
            if (!raw) return;
            const s = JSON.parse(raw);
            totalPacks  = s.totalPacks  || 0;
            totalCards  = s.totalCards  || 0;
            cardStats   = s.cardStats   || {};
            rarityStats = s.rarityStats || { L:0, UR:0, SR:0, R:0, PC:0, C:0 };
        } catch(e) {}
    }

    function resetStats() {
        totalPacks = 0; totalCards = 0; cardStats = {}; rarityStats = { L:0, UR:0, SR:0, R:0, PC:0, C:0 };
        localStorage.removeItem(STATS_STORAGE_KEY);
    }

    // Reset des stats de SESSION du Pack Opener uniquement (le cumul overall reste intact)
    function resetSessionStats() {
        sessionPacks = 0;
        sessionCards = 0;
        sessionRarityStats = { L:0, UR:0, SR:0, R:0, PC:0, C:0 };
        saveDailyPackStats(); // remet aussi à zéro le cumul du jour persistant
    }

    // Délai résistant au throttling : vérifie Date.now() toutes les secondes
    async function sleepUntil(targetMs) {
        while (Date.now() < targetMs) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    async function sleep(ms) {
        return sleepUntil(Date.now() + ms);
    }

    // === Calcul de la prochaine mise minimale ===
    // - Pas de mise en cours → base_amount exactement (être 1er bidder = égaliser la base)
    // - Mise en cours → +10% arrondi sup, en compensant le bug de virgule flottante
    //   (50 * 1.1 = 55.00000000000001 en JS, donc Math.ceil donnait 56 au lieu de 55)
    function bidIncrement(amount) {
        return Math.ceil(amount * 1.1 - 1e-9);
    }
    function minNextBid(auction) {
        return auction.current_bid != null
            ? bidIncrement(auction.current_bid)
            : (auction.base_amount || 0);
    }

    function countdownColor(endAtStr) {
        const ms = new Date(endAtStr).getTime() - serverNow();
        if (ms < 5  * 60000) return "#EF4444"; // < 5min  : rouge
        if (ms < 10 * 60000) return "#FF8C00"; // < 10min : orange
        if (ms < 30 * 60000) return "#FFD700"; // < 30min : jaune
        if (ms < 60 * 60000) return "#00ff15"; // < 60min : vert
        return "#226bc5";                       // > 60min : bleu
    }

    let lastKnownBalance = null; // pour détecter les deltas de wikibidous

    // Log de solde "absorbable" : un delta positif (remboursement) est mis en attente
    // 3s avant d'être loggué, pour permettre à la hot lane de le fusionner dans son
    // propre log de surenchère (sinon on se retrouve avec 2 lignes séparées qui parlent
    // du même event).
    let pendingBalanceLog = null; // { deltaTotal, newBalance, timer }

    function flushBalanceLog(deltaTotal, newBalance) {
        const sign = deltaTotal > 0 ? '+' : '';
        const icon = deltaTotal > 0 ? '💰' : '💸';
        const color = deltaTotal > 0 ? '#4ade80' : '#ef4444';
        wmLog(`${icon} Solde <span style="color:${color};font-weight:700;">${sign}${deltaTotal.toLocaleString('fr-FR')} 💰</span> → ${newBalance.toLocaleString('fr-FR')} 💰`);
    }

    function scheduleBalanceLog(delta, newBalance) {
        if (pendingBalanceLog) {
            // Accumule les deltas successifs dans la fenêtre de 3s
            clearTimeout(pendingBalanceLog.timer);
            pendingBalanceLog.deltaTotal += delta;
            pendingBalanceLog.newBalance = newBalance;
        } else {
            pendingBalanceLog = { deltaTotal: delta, newBalance, timer: null };
        }
        pendingBalanceLog.timer = setTimeout(() => {
            const p = pendingBalanceLog;
            pendingBalanceLog = null;
            if (!p || p.deltaTotal === 0) return;
            flushBalanceLog(p.deltaTotal, p.newBalance);
        }, 3000);
    }

    // Consomme le log de solde en attente (utilisé par la hot lane lors d'une surenchère)
    function absorbPendingBalanceLog() {
        if (!pendingBalanceLog) return null;
        clearTimeout(pendingBalanceLog.timer);
        const data = { deltaTotal: pendingBalanceLog.deltaTotal, newBalance: pendingBalanceLog.newBalance };
        pendingBalanceLog = null;
        return data;
    }

    async function fetchBalance() {
        try {
            const res = await fetch("https://www.wiki-masters.com/api/wikibidous", { credentials: "include" });
            if (!res.ok) return;
            const data = await res.json();
            const newBalance = data.balance ?? data.amount ?? data.wikibidous ?? Infinity;

            // Log delta (sauf au tout premier fetch et si balance = Infinity)
            if (lastKnownBalance !== null && Number.isFinite(newBalance) && Number.isFinite(lastKnownBalance) && newBalance !== lastKnownBalance) {
                const delta = newBalance - lastKnownBalance;
                if (delta > 0) {
                    // Remboursement (refund) → on debounce pour permettre fusion avec un log de surenchère
                    scheduleBalanceLog(delta, newBalance);
                } else {
                    // Dépense → log immédiat
                    flushBalanceLog(delta, newBalance);
                }
            }
            lastKnownBalance = Number.isFinite(newBalance) ? newBalance : lastKnownBalance;
            wikibidousBalance = newBalance;

            const el = document.getElementById("wm-balance");
            if (el) {
                el.innerText = wikibidousBalance.toLocaleString("fr-FR");
                el.style.color = wikibidousBalance <= getSetting('minBalanceForAutoSnipe') ? "#EF4444" : "#FFD700";
            }
            updateBidsSumDisplay(); // rafraîchit le prévisionnel (dépend du solde)
        } catch(e) {}
    }

    // Met à jour les 2 segments à côté du solde dans le header :
    //  - mises en cours (où je suis meneur) en rouge (sortie potentielle de coins)
    //  - ventes en cours (mes cartes en vente) en vert (entrée potentielle de coins)
    // Format : 6 564 💰 | -883 💰/7 mises | +75 💰/2 ventes
    function updateBidsSumDisplay() {
        const el = document.getElementById('wm-bids-sum');
        if (!el) return;

        // ── Somme des mises où je suis meneur ──
        let bidsSum = 0, bidsCount = 0;
        leadingBidsMap.forEach((username, id) => {
            if (!isSelf(username)) return;
            const hit = activeHitsMap.get(id);
            if (!hit || !hit.auction) return;
            const endTs = new Date(hit.auction.end_at || hit.endAt).getTime();
            if (Number.isFinite(endTs) && endTs < Date.now()) return;
            bidsSum += hit.auction.current_bid ?? hit.auction.base_amount ?? 0;
            bidsCount++;
        });

        // ── Somme de mes ventes actives AYANT reçu au moins une mise ──
        // On ne compte que les ventes où quelqu'un a misé (current_bid présent),
        // pas le prix de départ des ventes sans enchérisseur.
        let salesSum = 0, salesCount = 0;
        lastActiveSales.forEach(a => {
            const endTs = new Date(a.end_at).getTime();
            if (Number.isFinite(endTs) && endTs < Date.now()) return;
            if (a.current_bid == null) return; // pas de mise → on ignore
            salesSum += a.current_bid;
            salesCount++;
        });

        const parts = [];
        if (bidsCount > 0) {
            parts.push(`<span style="color:#ef4444;">-${bidsSum.toLocaleString('fr-FR')} 💰/${bidsCount} mise${bidsCount > 1 ? 's' : ''}</span>`);
        }
        if (salesCount > 0) {
            parts.push(`<span style="color:#4ade80;">+${salesSum.toLocaleString('fr-FR')} 💰/${salesCount} vente${salesCount > 1 ? 's' : ''}</span>`);
        }

        if (parts.length > 0) {
            let html = ` <span style="color:#444;">|</span> ` + parts.join(` <span style="color:#444;">|</span> `);
            // Solde prévisionnel = solde actuel − mises engagées + ventes en cours.
            // (Les mises en tête sont une sortie POTENTIELLE non encore déduite du solde.)
            if (Number.isFinite(wikibidousBalance)) {
                const prev = wikibidousBalance - bidsSum + salesSum;
                const prevColor = prev >= wikibidousBalance ? '#4ade80' : '#fbbf24';
                html += ` <span style="color:#666;">=</span> <span style="color:${prevColor};font-weight:700;" title="Prévisionnel = solde ${wikibidousBalance.toLocaleString('fr-FR')} − mises ${bidsSum.toLocaleString('fr-FR')} + ventes ${salesSum.toLocaleString('fr-FR')} (si tout se conclut ainsi)">${prev.toLocaleString('fr-FR')} 💰 prév.</span>`;
            }
            el.innerHTML = html;
            el.title = `Mises en tête : ${bidsSum.toLocaleString('fr-FR')} 💰 sur ${bidsCount} · Ventes en cours : ${salesSum.toLocaleString('fr-FR')} 💰 sur ${salesCount}`;
        } else {
            el.innerHTML = '';
            el.title = '';
        }
    }

    // Chaque type de son a son propre réglage d'activation (extensible pour de futurs sons).
    function isSoundEnabled(type) {
        if (type === 'keyword')   return getSetting('soundNewHit');
        if (type === 'outbid')    return getSetting('soundOutbid');
        if (type === 'pack')      return getSetting('soundPackOpen');
        if (type === 'legendary') return getSetting('soundLegendary');
        if (type === 'won')       return getSetting('soundWon');
        // Son générique : joué si au moins un des sons est activé
        return getSetting('soundNewHit') || getSetting('soundOutbid');
    }

    function playSound(type) {
        if (!isSoundEnabled(type)) return;
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();

            if (type === "keyword") {
                // Montée joyeuse : do-mi-sol-do (nouveau hit keyword)
                [523, 659, 784, 1047].forEach((freq, i) => {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.connect(gain); gain.connect(ctx.destination);
                    osc.frequency.value = freq; osc.type = "sine";
                    gain.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.1);
                    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.1 + 0.18);
                    osc.start(ctx.currentTime + i * 0.1);
                    osc.stop(ctx.currentTime + i * 0.1 + 0.22);
                });
            } else if (type === "outbid") {
                // Descente douce : sol-mi-do en sine, volume réduit
                [784, 622, 494].forEach((freq, i) => {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.connect(gain); gain.connect(ctx.destination);
                    osc.frequency.value = freq; osc.type = "sine";
                    gain.gain.setValueAtTime(0.07, ctx.currentTime + i * 0.18);
                    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.18 + 0.3);
                    osc.start(ctx.currentTime + i * 0.18);
                    osc.stop(ctx.currentTime + i * 0.18 + 0.35);
                });
            } else if (type === "pack") {
                // Ouverture de pack : petit "pop" discret à 2 notes, volume faible
                [392, 587].forEach((freq, i) => {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.connect(gain); gain.connect(ctx.destination);
                    osc.frequency.value = freq; osc.type = "triangle";
                    gain.gain.setValueAtTime(0.05, ctx.currentTime + i * 0.07);
                    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.07 + 0.12);
                    osc.start(ctx.currentTime + i * 0.07);
                    osc.stop(ctx.currentTime + i * 0.07 + 0.15);
                });
            } else if (type === "legendary") {
                // Légendaire : fanfare triomphale ascendante, plus longue et sonore
                [523, 659, 784, 1047, 1319, 1568].forEach((freq, i) => {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.connect(gain); gain.connect(ctx.destination);
                    osc.frequency.value = freq; osc.type = "sawtooth";
                    const t = ctx.currentTime + i * 0.11;
                    gain.gain.setValueAtTime(0.18, t);
                    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
                    osc.start(t);
                    osc.stop(t + 0.36);
                });
                // Note finale tenue pour l'effet "jackpot"
                const fosc = ctx.createOscillator();
                const fgain = ctx.createGain();
                fosc.connect(fgain); fgain.connect(ctx.destination);
                fosc.frequency.value = 2093; fosc.type = "triangle";
                const ft = ctx.currentTime + 0.66;
                fgain.gain.setValueAtTime(0.16, ft);
                fgain.gain.exponentialRampToValueAtTime(0.001, ft + 0.6);
                fosc.start(ft);
                fosc.stop(ft + 0.65);
            } else if (type === "won") {
                // Enchère gagnée : arpège "cha-ching" claire, do-sol-do', volume moyen
                [659, 988, 1319].forEach((freq, i) => {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.connect(gain); gain.connect(ctx.destination);
                    osc.frequency.value = freq; osc.type = "triangle";
                    const t = ctx.currentTime + i * 0.09;
                    gain.gain.setValueAtTime(0.14, t);
                    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
                    osc.start(t);
                    osc.stop(t + 0.28);
                });
            } else {
                // Son générique (ancien comportement)
                [523, 659, 784].forEach((freq, i) => {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.connect(gain); gain.connect(ctx.destination);
                    osc.frequency.value = freq; osc.type = "sine";
                    gain.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.12);
                    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.12 + 0.15);
                    osc.start(ctx.currentTime + i * 0.12);
                    osc.stop(ctx.currentTime + i * 0.12 + 0.2);
                });
            }
        } catch(e) {}
    }

    function playAlertSound() { playSound("default"); }

let lastWebhook = 0;

function sendToDiscord(text, color = 5814783, category = 'general') {

    // Skip si désactivé dans Paramètres
    if (!getSetting('discordEnabled')) return;

    // Skip silencieux si pas de webhook configuré
    const webhook = getDiscordWebhook();
    if (!webhook) return;

    // anti-spam (important)
    if (Date.now() - lastWebhook < 3000) return;
    lastWebhook = Date.now();

    fetch(webhook, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            embeds: [{
                description: text,
                color: color,
                timestamp: new Date().toISOString()
            }]
        })
    }).catch(() => {});
}

    /* ===================== RÉVÉLATION ===================== */

    async function revealCards(cards, revealEl) {
        for (const c of cards) {
            const rarity = (c.rarity || "").toUpperCase();
            const r = RARITY[rarity] || { color: "#aaa", bg: "rgba(255,255,255,0.05)" };
            const title = c.wikipedia_title || "?";
            const isKW = hasKeyword(c, true); // pack : titre + catégories + description
            revealEl.innerHTML = `
                <div style="padding:6px 10px; border-radius:6px; background:${r.bg};
                    border-left:3px solid ${r.color}; display:flex; align-items:center;
                    gap:8px; animation:fadeIn 0.2s ease;">
                    ${isKW ? '<span style="font-size:16px">🚨</span>' : ''}
                    <span style="color:${r.color}; font-weight:600; font-size:13px; flex:1">${title}</span>
                    ${badge(rarity)}
                </div>`;
            await new Promise(r => setTimeout(r, 400));
        }
        revealEl.innerHTML = "";
    }

    /* ===================== ANALYSE ===================== */

    function analyzeCards(cards) {
        let keywordHits = [];
        cards.forEach(c => {
            const rarity = (c.rarity || "").toUpperCase();
            const title = c.wikipedia_title || "?";
            cardStats[title] = (cardStats[title] || 0) + 1;
            if (rarityStats[rarity] !== undefined) rarityStats[rarity]++;
            if (sessionRarityStats[rarity] !== undefined) sessionRarityStats[rarity]++;
            // Comptage séparé PAR SESSION : sessionRarityStats est amorcé depuis le cumul du
            // jour, donc l'utiliser pour le récap répétait toute la journée sur chaque session.
            if (sessionMetrics.rarities[rarity] !== undefined) sessionMetrics.rarities[rarity]++;
            totalCards++;
            sessionCards++;
            if (hasKeyword(c, true)) keywordHits.push(c); // pack : inclut la description
        });
        return { keywordHits };
    }

    /* ===================== STATS RENDER ===================== */

    function renderRarityStats(rarityEl) {
        if (!rarityEl) return;
        rarityEl.innerHTML = Object.entries(RARITY).map(([key, r]) => {
            const count = sessionRarityStats[key] || 0;
            const pct = sessionCards > 0 ? ((count / sessionCards) * 100).toFixed(2) : "0.00";
            const barW = sessionCards > 0 ? (count / sessionCards) * 100 : 0;
            return `
            <div class="wm-rarity-row" style="display:flex;align-items:center;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.03);">
                <span style="color:${r.color}; font-weight:700; font-size:12px; width:28px;">${key}</span>
                <div style="flex:1; margin:0 8px; height:4px; border-radius:2px; background:rgba(255,255,255,0.06);">
                    <div style="width:${barW}%; height:100%; border-radius:2px; background:${r.color};
                        transition:width 0.4s ease; min-width:${count > 0 ? '4px' : '0'};"></div>
                </div>
                <span style="color:${count > 0 ? r.color : '#444'}; font-weight:600; width:28px;
                    text-align:right; font-size:11px;">${count}</span>
                <span style="color:#555; width:38px; text-align:right; font-size:10px;">${pct}%</span>
            </div>`;
        }).join("");
    }

    /* ===================== COLLECTION ===================== */

    // Décode la payload d'un JWT (base64url). Retourne null si invalide.
    function decodeJWT(token) {
        if (!token) return null;
        try {
            const parts = token.split('.');
            if (parts.length !== 3) return null;
            const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            const padded = payload + '='.repeat((4 - payload.length % 4) % 4);
            return JSON.parse(atob(padded));
        } catch(e) { return null; }
    }

    // Détecte l'utilisateur connecté de manière dynamique.
    // Stratégies (dans l'ordre) : cache → JWT.user_metadata → Supabase profiles/users → email.
    const CURRENT_USER_CACHE_KEY = 'wm_current_user';
    const CURRENT_USER_CACHE_TTL = 60 * 60 * 1000; // 1h

    async function fetchCurrentUser() {
        // Override manuel (prioritaire) : indispensable après un changement de pseudo
        // sur le site, car le JWT garde souvent l'ancien pseudo dans ses métadonnées.
        const override = (getSetting('usernameOverride') || '').trim();
        if (override) {
            currentUsername = override;
            window.currentUsername = override;
            currentUsernameSource = 'réglage manuel';
            return override;
        }
        // 0) Cache (1h). On n'accepte QUE les entrées qui savent d'où vient le pseudo : une
        // entrée sans `source` a été écrite par une version antérieure, et la réutiliser
        // gèlerait l'ancienne résolution pendant 1 h (c'est ce qui faisait persister « ? »
        // même après correction de la lecture Supabase).
        try {
            const cached = JSON.parse(localStorage.getItem(CURRENT_USER_CACHE_KEY) || 'null');
            if (cached?.username && cached.source && (Date.now() - cached.ts) < CURRENT_USER_CACHE_TTL) {
                currentUsername = cached.username;
                window.currentUsername = cached.username;
                currentUsernameSource = cached.source;
                return cached.username;
            }
        } catch(e) {}

        const { token } = (typeof getSupabaseAccessToken === 'function')
            ? getSupabaseAccessToken()
            : { token: null };
        const claims = decodeJWT(token);

        let username = null;
        let source = null;

        if (claims) {
            // 1) JWT user_metadata (variantes courantes)
            const meta = claims.user_metadata || {};
            username = meta.username
                || meta.user_name
                || meta.preferred_username
                || meta.name
                || meta.full_name
                || null;
            if (username) source = 'JWT.user_metadata';

            // 2) Supabase REST — essai sur plusieurs noms de table courants
            if (!username && claims.sub) {
                const tables = ['profiles', 'users', 'user_profiles', 'accounts', 'players', 'members'];
                for (const table of tables) {
                    try {
                        // `select=*` : demander des colonnes nommées fait répondre 400 à
                        // PostgREST dès que l'une d'elles n'existe pas, et la table valide
                        // était alors écartée à tort.
                        const res = await fetch(
                            `${SUPABASE_URL}/${table}?id=eq.${claims.sub}&select=*`,
                            {
                                credentials: 'omit',
                                headers: {
                                    'apikey': SUPABASE_KEY,
                                    'Authorization': `Bearer ${token || SUPABASE_KEY}`,
                                    'Accept': 'application/json'
                                }
                            }
                        );
                        if (!res.ok) continue;
                        const data = await res.json().catch(() => null);
                        const row = Array.isArray(data) ? data[0] : null;
                        if (row) {
                            username = pickUsername(row);
                            if (username) { source = `Supabase.${table}`; break; }
                        }
                    } catch(e) {}
                }
            }

            // 3) Fallback : partie locale de l'email
            if (!username && claims.email) {
                username = claims.email.split('@')[0];
                source = 'JWT.email';
            }
        }

        if (username) {
            currentUsername = username;
            window.currentUsername = username;
            currentUsernameSource = source || 'inconnue';
            try {
                localStorage.setItem(CURRENT_USER_CACHE_KEY, JSON.stringify({
                    username, source: currentUsernameSource, ts: Date.now()
                }));
            } catch(e) {}
            return username;
        }

        return null;
    }

    const COLLECTION_CACHE_KEY  = 'wm_collection_cache';
    const COLLECTION_TS_KEY     = 'wm_collection_ts';
    const COLLECTION_TOTAL_KEY  = 'wm_collection_total';
    const COLLECTION_RARITY_KEY = 'wm_collection_rarity';
    const COLLECTION_RARITY_SET_KEY = 'wm_collection_rarity_set'; // card_id → raretés possédées

    // Sauvegarde collectionMap dans localStorage
    function saveCollectionCache(total) {
        try {
            localStorage.setItem(COLLECTION_CACHE_KEY, JSON.stringify([...collectionMap.entries()]));
            localStorage.setItem(COLLECTION_TS_KEY, new Date().toISOString());
            localStorage.setItem(COLLECTION_RARITY_KEY, JSON.stringify(rarityCountMap));
            localStorage.setItem(COLLECTION_RARITY_SET_KEY,
                JSON.stringify([...collectionRarityMap.entries()].map(([id, set]) => [id, [...set]])));
            if (total != null) localStorage.setItem(COLLECTION_TOTAL_KEY, String(total));
        } catch(e) {}
    }

    // Charge le cache localStorage dans collectionMap
    function loadCollectionCache() {
        try {
            const raw = localStorage.getItem(COLLECTION_CACHE_KEY);
            if (!raw) return false;
            const entries = JSON.parse(raw);
            const cacheSize = Array.isArray(entries) ? entries.length : 0;
            const storedTotal = getCacheTotal();

            // Garde-fou contre les caches sauvegardés à partir d'une réponse API foireuse
            // (incident serveur qui renvoie total=0 alors qu'on a des cartes).
            // Si le total stocké est nul/invalide ou très inférieur au cache, on purge.
            const cacheLooksValid =
                cacheSize > 0 &&
                Number.isFinite(storedTotal) &&
                storedTotal > 0 &&
                cacheSize >= storedTotal - 50; // tolérance d'une page

            if (!cacheLooksValid) {
                console.warn(`[WikiMasters] ⚠️ Cache collection invalide (taille=${cacheSize}, total stocké=${storedTotal}) — purge`);
                localStorage.removeItem(COLLECTION_CACHE_KEY);
                localStorage.removeItem(COLLECTION_TS_KEY);
                localStorage.removeItem(COLLECTION_TOTAL_KEY);
                localStorage.removeItem(COLLECTION_RARITY_KEY);
                localStorage.removeItem(COLLECTION_RARITY_SET_KEY);
                return false;
            }

            collectionMap.clear();
            entries.forEach(([id, count]) => collectionMap.set(id, count));

            // Restaure les raretés possédées par carte (doublon rareté-conscient)
            collectionRarityMap.clear();
            try {
                const rawRS = localStorage.getItem(COLLECTION_RARITY_SET_KEY);
                if (rawRS) {
                    const arr = JSON.parse(rawRS);
                    if (Array.isArray(arr)) arr.forEach(([id, rs]) => {
                        if (id && Array.isArray(rs)) collectionRarityMap.set(id, new Set(rs.map(x => String(x).toUpperCase())));
                    });
                }
            } catch(e) {}

            // Restaure aussi le comptage par rareté s'il est en cache
            try {
                const rawRar = localStorage.getItem(COLLECTION_RARITY_KEY);
                if (rawRar) {
                    const parsed = JSON.parse(rawRar);
                    resetRarityCount();
                    for (const k of Object.keys(rarityCountMap)) {
                        if (Number.isFinite(parsed[k])) rarityCountMap[k] = parsed[k];
                    }
                }
            } catch(e) {}

            return collectionMap.size > 0;
        } catch(e) { return false; }
    }

    function getCacheLastObtained() {
        try { return localStorage.getItem(COLLECTION_TS_KEY) || null; } catch(e) { return null; }
    }

    function getCacheTotal() {
        try { const v = localStorage.getItem(COLLECTION_TOTAL_KEY); return v ? parseInt(v) : null; } catch(e) { return null; }
    }

    // Charge uniquement les pages triées par obtained_at DESC jusqu'à trouver
    // une carte déjà connue (= on a rattrapé le cache)
    async function fetchNewCards(sinceIso, onProgress) {
        const limit = 50;
        let page = 0;
        let fetched = 0;

        while (true) {
            const url = `https://www.wiki-masters.com/api/my-collection?page=${page}&limit=${limit}&sort=obtained_at`;
            const res = await fetch(url, { credentials: "include" });
            if (!res.ok) break;
            const data = await res.json();
            const items = data.collection || [];
            if (items.length === 0) break;

            let reachedKnown = false;
            for (const item of items) {
                // Si cette carte est plus ancienne que notre cache, on s'arrête
                if (sinceIso && item.obtained_at <= sinceIso) { reachedKnown = true; break; }
                const id = item.card_id || item.card?.id;
                if (id) {
                    collectionMap.set(id, (collectionMap.get(id) || 0) + (item.count || 1));
                    addRarityCount(item);
                    fetched++;
                }
            }
            if (onProgress) onProgress(fetched);
            if (reachedKnown || items.length < limit) break;
            page++;
            await new Promise(r => setTimeout(r, 80));
        }
        if (fetched > 0) renderRarityHeader();
        return fetched;
    }

    // Signalé le 2026-08-20 : le rafraîchissement automatique toutes les 3 min (corrigé la
    // veille pour ne plus vider le cache) pouvait tourner EN MÊME TEMPS que le premier scan
    // complet du Market Watcher au chargement de la page — sur un gros compte, ce scan initial
    // prend plusieurs minutes, largement plus que l'intervalle de 3 min. Deux fetchCollection()
    // concurrents modifiaient alors collectionMap en parallèle, chacun ignorant les ajouts de
    // l'autre (collectionMap.get(id)||0 lu avant que l'autre n'ait écrit) → comptages "×N"
    // gonflés pour les cartes concernées, sans rapport avec la possession réelle. Un simple
    // verrou empêche désormais un second scan de démarrer tant que le premier tourne encore.
    let _fetchCollectionInFlight = false;
    async function fetchCollection(onProgress) {
        if (_fetchCollectionInFlight) return;
        _fetchCollectionInFlight = true;
        try {
            const limit = 50;

            // ── Cas 1 : cache localStorage existant ──
            const cacheLoaded = loadCollectionCache();
            if (cacheLoaded) {
                renderRarityHeader(); // affiche les compteurs restaurés du cache
                const lastTs = getCacheLastObtained();
                const cachedTotal = getCacheTotal();
                if (onProgress) onProgress(collectionMap.size, collectionMap.size, true);
                console.log(`[WikiMasters] Cache chargé: ${collectionMap.size} cartes (dernier: ${lastTs})`);

                // Vérifie le total actuel pour détecter des ventes
                const checkRes = await fetch(
                    `https://www.wiki-masters.com/api/my-collection?page=0&limit=1&sort=rarity`,
                    { credentials: "include" }
                );
                const checkData = checkRes.ok ? await checkRes.json() : null;
                const apiTotal = checkData?.total ?? null;

                if (apiTotal !== null && cachedTotal !== null && apiTotal < cachedTotal) {
                    // Tu as vendu des cartes → rechargement complet
                    console.log(`[WikiMasters] Ventes détectées (${cachedTotal} → ${apiTotal}), rechargement complet`);
                    if (onProgress) onProgress(0, apiTotal, false);
                    // On sort du cas 1 pour tomber dans le cas 2
                    collectionMap.clear();
                    collectionRarityMap.clear();
                } else {
                    // Récupère uniquement les nouvelles cartes depuis le cache
                    const added = await fetchNewCards(lastTs, (n) => {
                        if (onProgress) onProgress(collectionMap.size, collectionMap.size, true, n);
                    });
                    if (added > 0) {
                        saveCollectionCache(apiTotal ?? cachedTotal);
                        console.log(`[WikiMasters] +${added} nouvelles cartes ajoutées au cache`);
                    } else {
                        console.log(`[WikiMasters] Cache à jour, aucune nouvelle carte`);
                    }
                    return;
                }
            }

            // ── Cas 2 : pas de cache → chargement complet en parallèle ──
            console.log(`[WikiMasters] Pas de cache, chargement complet…`);
            resetRarityCount(); // recompte les raretés depuis zéro pour ce refresh complet
            const first = await fetch(
                `https://www.wiki-masters.com/api/my-collection?page=0&limit=${limit}&sort=rarity`,
                { credentials: "include" }
            );
            if (!first.ok) return;
            const firstData = await first.json();
            const firstItems = firstData.collection || [];

            if (firstItems.length === 0) {
                wmLog(`📚 Collection vide (page 0)`);
                return;
            }

            const apiTotal = parseInt(firstData.total, 10);
            // Si l'API renvoie un total cohérent on l'utilise. Sinon on bascule
            // en mode pagination dynamique : on charge des pages jusqu'à en trouver
            // une plus courte que `limit` (= dernière) ou totalement vide.
            const totalIsKnown = Number.isFinite(apiTotal) && apiTotal >= firstItems.length && apiTotal > 0;
            const totalPages = totalIsKnown ? Math.ceil(apiTotal / limit) : null;

            if (totalIsKnown) {
                wmLog(`📚 Refresh collection démarré : ${apiTotal.toLocaleString('fr-FR')} cartes à charger sur ${totalPages} pages…`);
            } else {
                wmLog(`📚 Refresh collection démarré : <span style="color:#fbbf24;">total API indisponible</span>, pagination dynamique…`);
            }

            // On accumule aussi les items COMPLETS (avec tags) → alimente le cache de l'étiqueteur
            // pour qu'un scan complet (démarrage à froid ou ♻️ Collection) soit réutilisé par
            // l'étiquetage en masse, sans re-scan.
            const fullItems = [];
            firstItems.forEach(item => {
                const id = item.card_id || item.card?.id;
                if (id) collectionMap.set(id, (collectionMap.get(id) || 0) + (item.count || 1));
                addRarityCount(item);
                fullItems.push(item);
            });
            renderRarityHeader();
            if (onProgress) onProgress(collectionMap.size, totalIsKnown ? apiTotal : null, false);

            // Fetch une page avec retry automatique
            async function fetchPage(p) {
                for (let attempt = 0; attempt < 3; attempt++) {
                    try {
                        const res = await fetch(
                            `https://www.wiki-masters.com/api/my-collection?page=${p}&limit=${limit}&sort=rarity`,
                            { credentials: "include" }
                        );
                        if (!res.ok) { await new Promise(r => setTimeout(r, 500 * (attempt + 1))); continue; }
                        const data = await res.json();
                        return data.collection || [];
                    } catch(e) {
                        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
                    }
                }
                return [];
            }

            const BATCH = 10;
            const MAX_PAGES = 2000; // garde-fou anti-boucle infinie (~100k cartes max)
            const upperLimit = totalIsKnown ? totalPages : MAX_PAGES;
            let reachedEnd = false;
            for (let start = 1; start < upperLimit && !reachedEnd; start += BATCH) {
                const pages = [];
                for (let p = start; p < Math.min(start + BATCH, upperLimit); p++) pages.push(p);
                const results = await Promise.all(pages.map(fetchPage));
                results.forEach(items => {
                    // Une page plus courte que `limit` = on a atteint la fin
                    if (items.length < limit) reachedEnd = true;
                    items.forEach(item => {
                        const id = item.card_id || item.card?.id;
                        if (id) collectionMap.set(id, (collectionMap.get(id) || 0) + (item.count || 1));
                        addRarityCount(item);
                        fullItems.push(item);
                    });
                });
                renderRarityHeader();
                if (onProgress) onProgress(collectionMap.size, totalIsKnown ? apiTotal : null, false);
            }

            // Alimente le cache de l'étiqueteur avec ce scan complet (items + tags) → réutilisé
            // par l'étiquetage en masse au lieu d'un nouveau scan.
            if (fullItems.length > 0) collectionItemsCache = { items: fullItems, ts: Date.now() };

            // Validation finale et sauvegarde du cache
            if (totalIsKnown) {
                if (collectionMap.size < apiTotal - limit) {
                    wmLog(`⚠️ Collection : écart détecté (${collectionMap.size}/${apiTotal}), cache non sauvegardé`);
                } else {
                    saveCollectionCache(apiTotal);
                    wmLog(`✅ Collection complète : <b>${collectionMap.size.toLocaleString('fr-FR')}/${apiTotal.toLocaleString('fr-FR')}</b> cartes`);
                }
                apiHealth.lastCollectionTs = Date.now();
            } else {
                // Total inconnu : on stocke la taille effective comme référence
                saveCollectionCache(collectionMap.size);
                wmLog(`✅ Collection chargée en mode dégradé : <b>${collectionMap.size.toLocaleString('fr-FR')}</b> cartes`);
                apiHealth.lastCollectionTs = Date.now();
            }
        } catch(e) {
            console.warn("[WikiMasters] fetchCollection error:", e);
        } finally {
            _fetchCollectionInFlight = false;
        }
    }

    function ownedCount(cardId) {
        return collectionMap.get(cardId) || 0;
    }

    /* ===================== MARKET API ===================== */

    // Fetch une page de la marketplace
    async function fetchMarketPage(page) {
        const url = `${MARKET_API_BASE}?page=${page}&limit=${MARKET_PAGE_LIMIT}&sort=ending_soon`;
        const t0 = Date.now();
        const res = await fetch(url, { credentials: "include" });
        syncServerClockFromResponse(res, t0);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    // Fetch TOUTES les pages et retourne tous les auctions
    async function fetchAllMarketAuctions(onProgress) {
        const first = await fetchMarketPage(1);
        const auctions = [...first.auctions];
        const total = first.total || 0;
        const totalPages = Math.ceil(total / MARKET_PAGE_LIMIT);

        if (onProgress) onProgress(1, totalPages, auctions.length);

        // Pagination par lots parallèles : MARKET_PAGE_CONCURRENCY pages à la fois
        // au lieu d'une par une → temps de scan divisé par ~5.
        for (let start = 2; start <= totalPages; start += MARKET_PAGE_CONCURRENCY) {
            const batch = [];
            for (let p = start; p < start + MARKET_PAGE_CONCURRENCY && p <= totalPages; p++) batch.push(p);
            const results = await Promise.all(
                batch.map(p => fetchMarketPage(p).catch(() => ({ auctions: [] }))) // page ratée n'arrête pas le scan
            );
            for (const data of results) auctions.push(...data.auctions);
            if (onProgress) onProgress(Math.min(start + batch.length - 1, totalPages), totalPages, auctions.length);
            // petite pause entre les lots, pas entre chaque page
            await new Promise(r => setTimeout(r, 100));
        }

        // Déduplication par id : comme les enchères sont triées par fin proche et que
        // le temps s'écoule pendant la pagination, une même enchère peut apparaître sur
        // 2 pages consécutives (elle glisse d'une page à l'autre entre 2 fetches).
        // On garde la première occurrence de chaque id.
        const seen = new Set();
        const deduped = [];
        for (const a of auctions) {
            if (a && a.id && !seen.has(a.id)) {
                seen.add(a.id);
                deduped.push(a);
            }
        }
        return { auctions: deduped, total, totalPages };
    }

    /* ===================== MARKET WATCHER ===================== */

    // activeHits = Map<auctionId, {auction, endAt}> pour les countdowns en cours
    let activeHitsMap = new Map();

    // Cache des ventes actives (mes mises en vente) pour le calcul header
    let lastActiveSales = [];

    // Timestamp de première détection de chaque hit (pour tri "ajout récent")
    // Map<auctionId, ms>. Conservé même quand activeHitsMap.set écrase l'entrée.
    let firstSeenMap = new Map();
    function markFirstSeen(id) {
        if (!firstSeenMap.has(id)) firstSeenMap.set(id, Date.now());
    }
    // Durée du surlignage jaune "nouvelle annonce" après sa 1re apparition.
    const NEW_HIGHLIGHT_MS = 10000;

    // Tracker les enchères où on était meneur : Map<auctionId, username>
    let leadingBidsMap = new Map();

    // Montant de MA dernière mise par enchère (id → montant). Signal d'identité
    // INDÉPENDANT du pseudo : si le prix courant ne dépasse pas ma dernière mise,
    // c'est que je mène encore, même si la comparaison de pseudo échoue.
    let myLastBidMap = new Map();

    // Comparaison de pseudo tolérante (casse + espaces) : évite que le bot ne
    // reconnaisse pas ses propres mises à cause d'une différence de casse entre
    // le pseudo détecté et celui renvoyé par l'API marketplace.
    function isSelf(username) {
        if (!username || !currentUsername) return false;
        return String(username).trim().toLowerCase() === String(currentUsername).trim().toLowerCase();
    }

    // Suis-je le meneur actuel d'une enchère ? Vrai si le current_bidder est moi
    // (pseudo tolérant) OU si le prix courant ne dépasse pas ma dernière mise connue.
    // → empêche l'auto-bid de surenchérir sur lui-même (prix qui monte inutilement).
    function iAmLeading(auction) {
        if (!auction) return false;
        if (isSelf(auction.current_bidder?.username)) return true;
        const myLast = myLastBidMap.get(auction.id);
        if (myLast != null) {
            const cur = auction.current_bid ?? auction.base_amount ?? 0;
            if (cur <= myLast) return true; // personne n'a misé au-dessus de ma dernière mise
        }
        return false;
    }

    // Enchères avec auto-bid activé : Set<auctionId> — persisté en localStorage
    const AUTOBID_SET_KEY = 'wm_autobid_set';
    let autoBidSet = new Set();
    try { autoBidSet = new Set(JSON.parse(localStorage.getItem(AUTOBID_SET_KEY) || '[]')); } catch(e) {}
    function saveAutoBidSet() {
        try { localStorage.setItem(AUTOBID_SET_KEY, JSON.stringify([...autoBidSet])); } catch(e) {}
    }

    // Mode "Fourbe" (snipe) : Set<auctionId> — au lieu de riposter à chaque contre-offre
    // (ce qui fait grimper le prix), on ne mise QU'UNE fois à ~10s de la fin. Miser sous
    // 10s rallonge le timer d'1 min côté site, donc on vise pile au-dessus de 10s pour
    // laisser un minimum de temps de réaction à l'adversaire. Persisté.
    const SNIPE_SET_KEY = 'wm_snipe_set';
    let snipeSet = new Set();
    try { snipeSet = new Set(JSON.parse(localStorage.getItem(SNIPE_SET_KEY) || '[]')); } catch(e) {}
    function saveSnipeSet() {
        try { localStorage.setItem(SNIPE_SET_KEY, JSON.stringify([...snipeSet])); } catch(e) {}
    }

    // Plafond d'auto-bid par enchère : Map<auctionId, maxAmount>
    // Si la prochaine mise dépasse ce plafond, l'auto-bid se désactive pour cette enchère.
    const AUTOBID_MAX_KEY = 'wm_autobid_max';
    let autoBidMaxMap = new Map();
    try {
        const raw = JSON.parse(localStorage.getItem(AUTOBID_MAX_KEY) || '[]');
        if (Array.isArray(raw)) autoBidMaxMap = new Map(raw);
    } catch(e) {}
    function saveAutoBidMax() {
        try { localStorage.setItem(AUTOBID_MAX_KEY, JSON.stringify([...autoBidMaxMap.entries()])); } catch(e) {}
    }
    function getAutoBidMax(id) {
        const v = autoBidMaxMap.get(id);
        return Number.isFinite(v) && v > 0 ? v : null;
    }
    function setAutoBidMax(id, val) {
        if (Number.isFinite(val) && val > 0) autoBidMaxMap.set(id, val);
        else autoBidMaxMap.delete(id);
        saveAutoBidMax();
    }

    /* ── Chasseur ciblé : auto-désactivation après obtention ──
       Associe une enchère armée par le Chasseur ciblé au texte de l'entrée qui l'a armée,
       UNIQUEMENT pour les entrées avec `autoDisable` actif (inutile de suivre les autres).
       Persistée : la victoire peut être détectée après un F5, entre l'armement de l'enchère et
       sa conclusion. `text` sert de clé plutôt que l'index du tableau, qui glisse dès qu'une
       autre entrée est retirée. */
    const HUNTER_AUTODISABLE_MAP_KEY = 'wm_hunter_autodisable_map';
    let hunterAutoDisableMap = new Map(); // auctionId -> texte de l'entrée Chasseur ciblé
    try {
        const raw = JSON.parse(localStorage.getItem(HUNTER_AUTODISABLE_MAP_KEY) || '[]');
        if (Array.isArray(raw)) hunterAutoDisableMap = new Map(raw);
    } catch(e) {}
    function saveHunterAutoDisableMap() {
        try { localStorage.setItem(HUNTER_AUTODISABLE_MAP_KEY, JSON.stringify([...hunterAutoDisableMap.entries()])); } catch(e) {}
    }
    // Vérifie si une mise prévue respecte le plafond auto-bid.
    // Si elle le dépasse : désactive l'auto-bid pour cette enchère et retourne false.
    // Sinon retourne true (la mise peut partir).
    function autoBidWithinCap(auction, plannedAmount) {
        const cap = getAutoBidMax(auction.id);
        if (cap === null) return true; // pas de plafond → illimité
        if (plannedAmount <= cap) return true;
        // Plafond atteint : on coupe l'auto-bid pour cette enchère
        if (autoBidSet.has(auction.id)) {
            autoBidSet.delete(auction.id);
            saveAutoBidSet();
            const t = auction.card?.wikipedia_title || '?';
            const r = (auction.card?.rarity || '').toUpperCase();
            wmLog(`🛑 Auto-bid coupé (plafond ${cap.toLocaleString('fr-FR')} 💰 atteint) : <b>${t}</b> [${r}] · prochaine mise aurait été ${plannedAmount.toLocaleString('fr-FR')} 💰`);
        }
        return false;
    }

    /* ── HUNTER AGRESSIF (Hunter en mode Fourbe) ──
       Le Hunter normal mise le minimum dès qu'une carte passe sous le seuil : ça prévient
       l'adversaire et lance la guerre d'enchères. En mode agressif il ne mise PLUS tout de
       suite — il arme le Fourbe (snipe à ~Ns de la fin) avec le seuil du Hunter comme
       plafond. Un clic arme tout le lot qui matche, un clic le désarme.
       hunterFourbeMap retient, pour chaque enchère armée, le plafond qui existait AVANT
       (null = aucun) : le désarmement restitue exactement l'état d'origine et ne touche
       jamais aux enchères armées à la main ou par les mots-clés fourbe. */
    const HUNTER_FOURBE_KEY = 'wm_hunter_fourbe';
    let hunterFourbeMap = new Map(); // auctionId → plafond précédent (number | null)
    try {
        const raw = JSON.parse(localStorage.getItem(HUNTER_FOURBE_KEY) || '[]');
        if (Array.isArray(raw)) hunterFourbeMap = new Map(raw);
    } catch(e) {}
    function saveHunterFourbe() {
        try { localStorage.setItem(HUNTER_FOURBE_KEY, JSON.stringify([...hunterFourbeMap.entries()])); } catch(e) {}
    }
    // Persisté (contrairement au toggle Hunter) : sinon un F5 laisserait des enchères armées
    // par un mode que le bouton affiche « OFF ».
    const HUNTER_AGGRO_KEY = 'wm_hunter_aggressive';
    let hunterAggressive = false;
    try { hunterAggressive = localStorage.getItem(HUNTER_AGGRO_KEY) === '1'; } catch(e) {}

    // Arme le Fourbe sur une enchère au nom du Hunter agressif. false si on n'y touche pas.
    function armHunterFourbe(auction, cap) {
        const id = auction && auction.id;
        if (!id || hunterFourbeMap.has(id)) return false;
        // Déjà un plan sur cette enchère (fourbe manuel/mot-clé, ou auto-bid) → on respecte.
        if (snipeSet.has(id) || autoBidSet.has(id)) return false;
        hunterFourbeMap.set(id, getAutoBidMax(id));
        snipeSet.add(id);
        if (Number.isFinite(cap) && cap > 0) setAutoBidMax(id, cap); // persiste déjà
        saveSnipeSet();
        saveHunterFourbe();
        return true;
    }
    // Désarme une enchère armée par le Hunter agressif et restaure son plafond d'origine.
    // No-op (false) si elle n'a pas été armée par ce mode.
    function disarmHunterFourbe(id) {
        if (!hunterFourbeMap.has(id)) return false;
        const prevCap = hunterFourbeMap.get(id);
        hunterFourbeMap.delete(id);
        snipeSet.delete(id);
        setAutoBidMax(id, Number.isFinite(prevCap) && prevCap > 0 ? prevCap : null);
        return true;
    }
    function disarmAllHunterFourbe() {
        let n = 0;
        for (const id of [...hunterFourbeMap.keys()]) { if (disarmHunterFourbe(id)) n++; }
        saveSnipeSet();
        saveHunterFourbe();
        return n;
    }
    // Appelé quand l'utilisateur reprend la main sur une enchère (bouton Fourbe OFF, ou
    // passage en auto-bid) : le Hunter agressif lâche prise proprement, plafond restauré.
    window.wmForgetHunterFourbe = function(id) {
        if (disarmHunterFourbe(id)) { saveHunterFourbe(); return true; }
        return false;
    };

    // Enchères où on vient de perdre le lead (pour affichage rouge)
    let outbidSet = new Set();
    // Horodatage de la surenchère (id → ms) pour le tri "mises perdues récemment".
    // Helpers centralisés pour garder outbidSet et outbidAtMap synchro.
    let outbidAtMap = new Map();
    // Anti-doublon de log : dernier montant de surenchère déjà loggué par enchère.
    // Évite de logguer 2× la même perte au même prix (id → montant).
    let outbidLogMap = new Map();
    // Vrai si cette surenchère (id, montant) n'a pas encore été loggée → à logguer une fois.
    function shouldLogOutbid(id, amount) {
        return outbidLogMap.get(id) !== amount;
    }
    function markOutbid(id) {
        if (!outbidSet.has(id)) outbidAtMap.set(id, Date.now());
        outbidSet.add(id);
    }
    function clearOutbid(id) {
        outbidSet.delete(id);
        outbidAtMap.delete(id);
        // NB : on NE supprime PAS outbidLogMap[id] ici. Reprendre le lead (parfois de façon
        // optimiste via markAuctionAsMine) effaçait la dé-dup du LOG → si le fetch suivant montrait
        // encore l'adversaire au MÊME montant, la surenchère était re-loggée + re-sonnée (doublon).
        // Les prix ne font que monter : une vraie nouvelle surenchère a un montant plus élevé, donc
        // shouldLogOutbid la détecte quand même. outbidLogMap est purgé quand l'enchère se termine.
    }
    function clearAllOutbid() {
        outbidSet.clear();
        outbidAtMap.clear();
        outbidLogMap.clear();
    }

    // Solde wikibidous
    let wikibidousBalance = Infinity; // Infinity = pas encore chargé, on laisse passer

    // Auto-snipe initial (nouvelle annonce ≤ 100 wikibidous)
    let autoSnipeEnabled = false;

    /* ── Hot lane : poller rapide dédié aux enchères trackées ── */
    // Mutex per-auction partagé entre main scan et hot lane (anti-doublons)
    const bidLockSet = new Set();
    // Timer du tick courant (setTimeout récursif, pas setInterval car intervalle adaptatif)
    let hotLaneTimeout = null;
    let hotLaneActive = false;
    // Stats légères pour debug / affichage
    let hotLaneTickCount = 0;
    let lastHotLaneInterval = null;

    // Expose closure vars to global scope for inline onclick handlers
    window.autoBidSet = autoBidSet;
    window.autoBidMaxMap = autoBidMaxMap;
    window.wmSetAutoBidMax = setAutoBidMax;
    window.wmGetAutoBidMax = getAutoBidMax;
    // Saisie du plafond auto-bid : enregistrement EN DIRECT (à chaque frappe, sans attendre
    // le blur). doLog=true (sur onchange/blur) → une seule ligne de log récapitulative.
    window.wmOnAutoBidMax = function(id, rawValue, doLog) {
        const v = parseInt(rawValue, 10);
        const val = Number.isFinite(v) && v > 0 ? v : null;
        setAutoBidMax(id, val); // persiste immédiatement
        if (doLog) {
            const card = (activeHitsMap.get(id) || {}).auction?.card;
            const title = (card && card.wikipedia_title) || '?';
            wmLog(val != null
                ? `🎯 Plafond auto-bid : <b>${title}</b> → ${val.toLocaleString('fr-FR')} 💰`
                : `♾️ Plafond auto-bid retiré : <b>${title}</b>`);
        }
    };
    window.leadingBidsMap = leadingBidsMap;
    window.wmTrackMyBid = trackMyBid;
    window.wmMarkAuctionMine = (id, amount) => markAuctionAsMine(id, amount, null);
    window.wmLog = wmLog;
    window.activeHitsMap = activeHitsMap;
    window.wmSaveAutoBidSet = saveAutoBidSet;
    window.snipeSet = snipeSet;
    window.wmSaveSnipeSet = saveSnipeSet;

    // Agrandit/réduit une ligne d'enchère en mode compact (vue détaillée pour une seule).
    window.wmToggleRowExpand = function(id) {
        if (marketExpandedIds.has(id)) marketExpandedIds.delete(id);
        else marketExpandedIds.add(id);
        const el = document.getElementById('wm-market-alert');
        if (el && lastHitsCache.length > 0) renderMarketHits(el, lastHitsCache, []);
    };

    /* ── Mode de mise d'une enchère : contrôle UNIQUE à 3 états ──
       Auto-bid et Fourbe s'excluent mutuellement (activer l'un coupait déjà l'autre), donc
       deux boutons offraient quatre combinaisons dont une impossible. Un seul contrôle qui
       cycle manuel → 🤖 auto-bid → 🕵️ fourbe → manuel dit exactement l'état courant et tient
       dans la moitié de la place.
       Aucun des trois passages ne déclenche de mise : l'auto-bid ne riposte qu'en cas de
       surenchère et le fourbe ne tire qu'en fin d'enchère — traverser un état est donc sans
       effet, contrairement à un cycle qui miserait au passage. */
    function bidModeOf(id) {
        if (autoBidSet.has(id)) return 'autobid';
        if (snipeSet.has(id)) return 'fourbe';
        return 'manual';
    }
    const BID_MODE_UI = {
        manual:  { label: '⚪ Manuel',   color: '#555',    border: 'rgba(255,255,255,0.12)', bg: 'none' },
        autobid: { label: '🤖 Auto-bid', color: '#4ade80', border: 'rgba(74,222,128,0.45)',  bg: 'rgba(74,222,128,0.07)' },
        fourbe:  { label: '🕵️ Fourbe',   color: '#c084fc', border: 'rgba(192,132,252,0.5)',  bg: 'rgba(192,132,252,0.07)' }
    };
    window.wmCycleBidMode = function(id) {
        const title = activeHitsMap.get(id)?.auction?.card?.wikipedia_title || '?';
        const mode = bidModeOf(id);
        if (mode === 'manual') {
            autoBidSet.add(id); saveAutoBidSet();
            wmLog(`🤖 Auto-bid activé (riposte auto en cas de surenchère) : <b>${title}</b>`);
        } else if (mode === 'autobid') {
            autoBidSet.delete(id); saveAutoBidSet();
            snipeSet.add(id); saveSnipeSet();
            wmLog(`🕵️ Fourbe activé (snipe à ~${getSetting('snipeSecondsBefore')}s de la fin) : <b>${title}</b>`);
        } else {
            snipeSet.delete(id); saveSnipeSet();
            // Si c'est le Hunter agressif qui avait armé cette enchère, il lâche prise et rend
            // le plafond d'origine — sinon son plafond resterait collé à la carte.
            if (disarmHunterFourbe(id)) saveHunterFourbe();
            wmLog(`⚪ Mise manuelle : <b>${title}</b> — plus d'automatisme sur cette enchère.`);
        }
        const el = document.getElementById('wm-market-alert');
        if (el && lastHitsCache.length > 0) renderMarketHits(el, lastHitsCache, []);
    };

    // Ajoute un ou plusieurs mots-clés. Plusieurs termes possibles en les séparant par « ; »
    // (le titre à virgule reste entier, ex. « Star Wars, épisode I »).
    window.wmAddKeyword = function(input) {
        const terms = String(input || '').split(';').map(s => s.trim()).filter(Boolean);
        let added = 0, last = '';
        for (const kw of terms) {
            if (KEYWORDS_ALERT.some(k => k.toLowerCase() === kw.toLowerCase())) continue;
            KEYWORDS_ALERT.push(kw); added++; last = kw;
        }
        if (added === 0) return;
        saveKeywords();
        renderKeywordsPanel();
        if (added > 1) wmLog(`➕ <b>${added}</b> mots-clés ajoutés`);
    };

    window.wmRemoveKeyword = function(idx) {
        if (idx < 0 || idx >= KEYWORDS_ALERT.length) return;
        KEYWORDS_ALERT.splice(idx, 1);
        saveKeywords();
        renderKeywordsPanel();
    };

    window.wmAddPriorityKeyword = function(input) {
        const terms = String(input || '').split(';').map(s => s.trim()).filter(Boolean);
        let added = 0, last = '';
        for (const kw of terms) {
            if (KEYWORDS_PRIORITY.some(k => k.toLowerCase() === kw.toLowerCase())) continue;
            KEYWORDS_PRIORITY.push(kw); added++; last = kw;
        }
        if (added === 0) return;
        savePriorityKeywords();
        renderKeywordsPanel();
        wmLog(added === 1
            ? `⭐ Mot-clé prioritaire ajouté : <b style="color:#fbbf24;">${last}</b>`
            : `⭐ <b>${added}</b> mots-clés prioritaires ajoutés`);
    };

    window.wmRemovePriorityKeyword = function(idx) {
        if (idx < 0 || idx >= KEYWORDS_PRIORITY.length) return;
        const removed = KEYWORDS_PRIORITY.splice(idx, 1)[0];
        savePriorityKeywords();
        renderKeywordsPanel();
        if (removed) wmLog(`⭐ Mot-clé prioritaire retiré : <b style="color:#fbbf24;">${removed}</b>`);
    };

    window.wmAddFourbeKeyword = function(input) {
        const terms = String(input || '').split(';').map(s => s.trim()).filter(Boolean);
        let added = 0, last = '';
        for (const kw of terms) {
            if (KEYWORDS_FOURBE.some(k => k.toLowerCase() === kw.toLowerCase())) continue;
            KEYWORDS_FOURBE.push(kw); added++; last = kw;
        }
        if (added === 0) return;
        saveFourbeKeywords();
        renderKeywordsPanel();
        wmLog(added === 1
            ? `🕵️ Mot-clé fourbe ajouté : <b style="color:#c084fc;">${last}</b>`
            : `🕵️ <b>${added}</b> mots-clés fourbe ajoutés`);
    };

    window.wmRemoveFourbeKeyword = function(idx) {
        if (idx < 0 || idx >= KEYWORDS_FOURBE.length) return;
        const removed = KEYWORDS_FOURBE.splice(idx, 1)[0];
        saveFourbeKeywords();
        renderKeywordsPanel();
        if (removed) wmLog(`🕵️ Mot-clé fourbe retiré : <b style="color:#c084fc;">${removed}</b>`);
    };

    // Rareté requise valide (l'un des 6 codes) — toute autre valeur (y compris vide/absente,
    // le cas normal) veut dire « pas de filtre », comportement identique à avant cette option.
    const HUNTER_RARITY_CODES = new Set(['L', 'UR', 'SR', 'R', 'PC', 'C']);
    function normalizeHunterRarity(rarity) {
        const r = String(rarity || '').trim().toUpperCase();
        return HUNTER_RARITY_CODES.has(r) ? r : '';
    }

    // Chasseur ciblé : ajoute une entrée { text, cap, mode, rarity, autoDisable, enabled }.
    // Un seul mot-clé par ajout (le plafond/mode/rareté/auto-désactivation sont propres à ce
    // mot-clé). Met à jour si le texte existe déjà — SANS toucher à `enabled` : re-soumettre
    // le formulaire sur une chasse en pause ne doit pas la réactiver en douce.
    // `rarity` optionnelle : vide = aucun filtre (n'importe quelle rareté déclenche la mise,
    // le comportement d'origine) ; sinon la mise n'a lieu que si la carte matche EXACTEMENT
    // cette rareté au moment de l'annonce — utile pour une carte dont on sait qu'elle va
    // bientôt changer de rareté et qu'on ne veut pas miser dessus au mauvais prix.
    // `autoDisable` optionnel : si vrai, la chasse se met en pause TOUTE SEULE dès qu'elle
    // remporte une enchère — pratique pour ne vouloir qu'UN exemplaire. Faux par défaut (une
    // nouvelle chasse reste active tant qu'on ne la coupe pas soi-même), pour ceux qui
    // collectionnent plusieurs fois la même carte.
    window.wmAddHunterKeyword = function(text, cap, mode, rarity, autoDisable) {
        const t = String(text || '').trim();
        const c = Number(cap);
        const m = (mode === 'fourbe') ? 'fourbe' : 'autobid';
        const rr = normalizeHunterRarity(rarity);
        const ad = !!autoDisable;
        if (!t) { wmLog('⚠️ Chasseur : mot-clé vide'); return; }
        if (!Number.isFinite(c) || c <= 0) { wmLog('⚠️ Chasseur : plafond invalide (entre un nombre &gt; 0)'); return; }
        const rarSuffix = rr ? ` · rareté <b>${rr}</b> requise` : '';
        const adSuffix = ad ? ` · <b>auto-pause</b> après obtention` : '';
        const existing = KEYWORDS_HUNTER.find(h => h.text.toLowerCase() === t.toLowerCase());
        if (existing) {
            existing.cap = c; existing.mode = m; existing.rarity = rr; existing.autoDisable = ad;
            saveHunterKeywords(); renderKeywordsPanel();
            wmLog(`🎯 Chasseur mis à jour : <b style="color:#5dade2;">${t}</b> → ${m === 'fourbe' ? 'fourbe' : 'auto-bid'} · plafond ${c} 💰${rarSuffix}${adSuffix}`);
            return;
        }
        KEYWORDS_HUNTER.push({ text: t, cap: c, mode: m, rarity: rr, autoDisable: ad, enabled: true });
        saveHunterKeywords(); renderKeywordsPanel();
        wmLog(`🎯 Chasseur ajouté : <b style="color:#5dade2;">${t}</b> → ${m === 'fourbe' ? 'fourbe' : 'auto-bid'} · plafond ${c} 💰${rarSuffix}${adSuffix}`);
    };

    // Bascule pause/active d'une chasse SANS la supprimer — pour la garder configurée
    // (mot-clé, plafond, mode, rareté) et la réactiver d'un clic plus tard.
    window.wmToggleHunterEnabled = function(idx) {
        const h = KEYWORDS_HUNTER[idx];
        if (!h) return;
        const wasEnabled = h.enabled !== false;
        h.enabled = !wasEnabled;
        saveHunterKeywords();
        renderKeywordsPanel();
        wmLog(h.enabled
            ? `🎯 Chasseur réactivé : <b style="color:#5dade2;">${h.text}</b>`
            : `🎯 Chasseur mis en pause : <b style="color:#5dade2;">${h.text}</b>`);
    };

    window.wmRemoveHunterKeyword = function(idx) {
        if (idx < 0 || idx >= KEYWORDS_HUNTER.length) return;
        const removed = KEYWORDS_HUNTER.splice(idx, 1)[0];
        saveHunterKeywords();
        renderKeywordsPanel();
        if (removed) wmLog(`🎯 Chasseur retiré : <b style="color:#5dade2;">${removed.text}</b>`);
    };

    window.wmAddExcludeKeyword = function(input) {
        const terms = String(input || '').split(';').map(s => s.trim()).filter(Boolean);
        let added = 0, last = '';
        for (const kw of terms) {
            if (KEYWORDS_EXCLUDE.some(k => k.toLowerCase() === kw.toLowerCase())) continue;
            KEYWORDS_EXCLUDE.push(kw); added++; last = kw;
        }
        if (added === 0) return;
        saveExcludeKeywords();
        renderKeywordsPanel();
        wmLog(added === 1
            ? `🚫 Mot exclu ajouté : <b style="color:#ef4444;">${last}</b>`
            : `🚫 <b>${added}</b> mots exclus ajoutés`);
        // Retire immédiatement les annonces concernées de l'affichage
        const el = document.getElementById('wm-market-alert');
        if (el && lastHitsCache.length > 0) renderMarketHits(el, lastHitsCache, []);
    };

    window.wmRemoveExcludeKeyword = function(idx) {
        if (idx < 0 || idx >= KEYWORDS_EXCLUDE.length) return;
        const removed = KEYWORDS_EXCLUDE.splice(idx, 1)[0];
        saveExcludeKeywords();
        renderKeywordsPanel();
        if (removed) wmLog(`🚫 Mot exclu retiré : <b style="color:#ef4444;">${removed}</b>`);
        const el = document.getElementById('wm-market-alert');
        if (el && lastHitsCache.length > 0) renderMarketHits(el, lastHitsCache, []);
    };

    loadKeywords();
    loadMyBids();

    function autoSnipeLabel(enabled) {
        const mode = getSetting('autoSnipeMode');
        const state = enabled ? 'ON' : 'OFF';
        // Quand le mode fourbe est actif, le Hunter ne mise PLUS immédiatement : le dire ici,
        // sinon « Hunter ≤30💰 ON » promet une mise immédiate qui n'aura jamais lieu.
        const suffix = (enabled && hunterAggressive) ? ' · 🕵️ fourbe' : '';
        if (mode === 'adaptive') {
            return `⚡ Hunter dynamique ${state}${suffix}`;
        }
        const price = getSetting('autoSnipePrice');
        return `⚡ Hunter ≤${price}💰 ${state}${suffix}`;
    }

    // Auto-bid Hunter (mise initiale selon le mode fixe/dynamique) sur une LISTE d'enchères.
    // Mutualisé entre le scan (nouvelles annonces) ET l'activation du Hunter (annonces déjà
    // présentes). bidLockSet garantit qu'une même enchère n'est pas mise deux fois en parallèle.
    async function runHunterAutoBidPass(list) {
        if (!autoSnipeEnabled || !Array.isArray(list)) return 0;
        if (hunterAggressive) return runHunterFourbePass(list); // pas de mise : on arme le snipe
        let placed = 0;
        for (const a of list) {
            if (!a || !a.id) continue;
            if (matchedHunterEntry(a.card)) continue;                       // géré par le Chasseur ciblé
            if (hasPriorityKeyword(a.card)) continue;                       // géré par la boucle prioritaire
            if (snipeSet.has(a.id) || hasFourbeKeyword(a.card)) continue;   // fourbe → snipe en fin
            const alreadyLeading = isSelf(a.current_bidder?.username);
            const alreadyOwned = (collectionMap.get(a.card?.id) || 0) > 0;
            const decision = shouldAutoSnipe(a);
            if (!(decision.snipe && !alreadyLeading && !alreadyOwned && wikibidousBalance > getSetting('minBalanceForAutoSnipe'))) continue;
            if (bidLockSet.has(a.id)) continue; // la hot lane / une autre passe bid déjà dessus
            bidLockSet.add(a.id);
            await new Promise(r => setTimeout(r, bidDelayMs(a)));
            const bidAmount = minNextBid(a);
            try {
                const res = await fetch(
                    `https://www.wiki-masters.com/api/marketplace/${a.id}/bid`,
                    { method: "POST", credentials: "include",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ amount: bidAmount }) }
                );
                const data = await res.json().catch(() => ({}));
                const title = a.card?.wikipedia_title || "?";
                const rar = (a.card?.rarity || '').toUpperCase();
                if (res.ok) {
                    markAuctionAsMine(a.id, bidAmount, a);
                    placed++;
                    const reasonStr = decision.reason ? ` <span style="color:#666;font-size:9px;">(${decision.reason})</span>` : '';
                    wmLog(`🤖 Hunter : <b>${title}</b> [${rar}] → <span style="color:#fbbf24;">${bidAmount} 💰</span>${reasonStr}`);
                    sendToDiscord("🤖 Auto-bid place : **" + title + "** a **" + bidAmount + " coins**", 5763719, 'market');
                } else {
                    wmLog(`⚠️ Hunter échoué : <b>${title}</b> [${rar}] · ${data?.error || 'erreur'}`);
                    sendToDiscord("⚠️ Auto-bid echoue : **" + title + "** - " + (data?.error || "erreur inconnue"), 15548997, 'market');
                }
            } catch(e) {} finally { bidLockSet.delete(a.id); }
            await new Promise(r => setTimeout(r, bidDelayMs(a)));
        }
        return placed;
    }

    // Variante AGRESSIVE du Hunter : mêmes cartes, même seuil, mais aucune mise immédiate —
    // on arme le Fourbe plafonné au seuil. 100 % local (aucune requête) donc instantané, et
    // sans await : appelable en boucle depuis le scan sans le ralentir.
    // NB : pas de contrôle du plancher `minBalanceForAutoSnipe` ici, comme pour tout Fourbe —
    // c'est au moment du tir que le solde est vérifié, et il peut changer d'ici là.
    function runHunterFourbePass(list) {
        if (!Array.isArray(list)) return 0;
        let armed = 0;
        for (const a of list) {
            if (!a || !a.id) continue;
            if (matchedHunterEntry(a.card)) continue;   // le Chasseur ciblé a son mode + plafond
            if (hasPriorityKeyword(a.card)) continue;   // prioritaire = mise immédiate assumée
            if (hasFourbeKeyword(a.card)) continue;     // déjà couvert par les mots-clés fourbe
            if (snipeSet.has(a.id) || autoBidSet.has(a.id)) continue;
            if (isSelf(a.current_bidder?.username)) continue;
            if ((collectionMap.get(a.card?.id) || 0) > 0) continue; // déjà en collection
            const decision = shouldAutoSnipe(a);
            if (!decision.snipe) continue;
            if (!armHunterFourbe(a, decision.cap)) continue;
            armed++;
            const title = a.card?.wikipedia_title || '?';
            const rar = (a.card?.rarity || '').toUpperCase();
            wmLog(`🕵️ Hunter agressif : <b>${title}</b> [${rar}] — snipe armé à ~${getSetting('snipeSecondsBefore')}s de la fin, plafond <span style="color:#fbbf24;">${decision.cap} 💰</span>`);
        }
        return armed;
    }

    // Repeint la case « mode fourbe » ET le libellé du bouton Hunter (ils décrivent le même
    // état : le bouton dit s'il chasse et sur quoi, la case dit comment il mise).
    function paintHunterAggro() {
        const chk = document.getElementById('wm-hunter-aggro');
        if (chk) chk.checked = hunterAggressive;
        const row = document.getElementById('wm-hunter-aggro-row');
        if (row) {
            row.style.color = hunterAggressive ? '#c084fc' : '#888';
            // Estompée quand le Hunter est éteint : la case reste réglable à l'avance, mais on
            // montre qu'elle ne pilote rien tant qu'il n'y a pas de chasse en cours.
            row.style.opacity = autoSnipeEnabled ? '1' : '0.5';
        }
        const lbl = document.getElementById('wm-hunter-aggro-lbl');
        if (lbl) {
            lbl.innerText = (hunterAggressive && !autoSnipeEnabled)
                ? '🕵️ Mode fourbe (actif dès que le Hunter est allumé)'
                : '🕵️ Mode fourbe (snipe en fin, pas de mise immédiate)';
        }
        const btn = document.getElementById('wm-autosnipe-btn');
        if (btn) btn.innerText = autoSnipeLabel(autoSnipeEnabled);
    }

    window.wmToggleHunterAggressive = function() {
        hunterAggressive = !hunterAggressive;
        try { localStorage.setItem(HUNTER_AGGRO_KEY, hunterAggressive ? '1' : '0'); } catch(e) {}
        paintHunterAggro();
        if (hunterAggressive) {
            wmLog(`🕵️ <b style="color:#c084fc;">Hunter agressif ON</b> — plus de mise immédiate : les cartes qui matchent sont snipées en fin d'enchère, plafonnées au seuil du Hunter.`);
            if (!autoSnipeEnabled) {
                wmLog(`⚠️ Le Hunter est <b>OFF</b> : l'armement commencera dès que tu l'allumeras.`);
            } else if (Array.isArray(lastHitsCache) && lastHitsCache.length > 0) {
                // Rattrapage sur les enchères déjà affichées, comme à l'activation du Hunter.
                const n = runHunterFourbePass([...lastHitsCache]);
                wmLog(n > 0
                    ? `🕵️ <b>${n}</b> enchère(s) déjà en cours armée(s) en fourbe.`
                    : `🕵️ Aucune enchère en cours ne correspond au critère du Hunter pour l'instant.`);
            }
        } else {
            const n = disarmAllHunterFourbe();
            wmLog(`🕵️ <b>Hunter agressif OFF</b> — ${n} enchère(s) désarmée(s), plafonds d'origine restaurés. Le Hunter remise à nouveau immédiatement.`);
        }
        const el = document.getElementById('wm-market-alert');
        if (el && lastHitsCache.length > 0) renderMarketHits(el, lastHitsCache, []);
    };

    window.wmToggleAutoSnipe = function(btn) {
        autoSnipeEnabled = !autoSnipeEnabled;
        if (autoSnipeEnabled) {
            btn.style.color = '#4ade80';
            btn.style.borderColor = 'rgba(74,222,128,0.4)';
            btn.style.background = 'rgba(74,222,128,0.08)';
            // Rattrapage : traite aussi les enchères DÉJÀ présentes qui matchent le critère,
            // pas seulement les prochaines. (bidLockSet évite les doublons avec le scan.)
            if (Array.isArray(lastHitsCache) && lastHitsCache.length > 0) {
                wmLog(hunterAggressive
                    ? '⚡ Hunter activé (mode fourbe) — armement des enchères déjà en cours…'
                    : '⚡ Hunter activé — vérification des enchères déjà en cours…');
                runHunterAutoBidPass([...lastHitsCache]).then(n => {
                    if (n > 0 && !hunterAggressive) wmLog(`⚡ Hunter : <b>${n}</b> mise(s) placée(s) sur des enchères déjà présentes.`);
                    // En mode fourbe, runHunterFourbePass loggue déjà chaque armement.
                }).catch(() => {});
            }
        } else {
            btn.style.color = '#555';
            btn.style.borderColor = 'rgba(255,255,255,0.1)';
            btn.style.background = 'none';
            // Les enchères déjà armées en fourbe RESTENT armées et tireront : couper le Hunter
            // arrête les nouvelles prises, il n'annule pas ce qui est engagé (même logique que
            // l'auto-bid). Pour tout désarmer, décocher « mode fourbe ».
            if (hunterAggressive && hunterFourbeMap.size > 0) {
                wmLog(`⚡ Hunter OFF — <b>${hunterFourbeMap.size}</b> enchère(s) restent armées en fourbe et seront snipées. Décoche « mode fourbe » pour les désarmer.`);
            }
        }
        paintHunterAggro(); // met à jour le libellé du bouton + l'état estompé de la case
    };

    function startCountdownTicker(marketAlertEl) {
        if (marketCountdownInterval) clearInterval(marketCountdownInterval);
        marketCountdownInterval = setInterval(() => {
            if (activeHitsMap.size === 0) return;
            // PERF : skip si onglet en arrière-plan ou overlay fermé
            // (les éléments wm-countdown-* n'existent que dans l'overlay ouvert,
            //  et chaque getElementById coûte cher * N enchères en parallèle)
            if (document.hidden) return;
            const overlay = document.getElementById('wm-overlay');
            if (!overlay || overlay.style.display === 'none') return;
            // Met à jour chaque countdown dans le DOM
            activeHitsMap.forEach((hit, id) => {
                const el = document.getElementById(`wm-countdown-${id}`);
                if (el) {
                    const cd = formatCountdown(hit.endAt);
                    const col = countdownColor(hit.endAt);
                    el.innerText = cd;
                    el.style.color = col;
                }
                // Retire les enchères terminées depuis plus de 30s
                if (new Date(hit.endAt).getTime() < Date.now() - 30000) {
                    activeHitsMap.delete(id);
                    const row = document.getElementById(`wm-hit-${id}`);
                    if (row) row.style.opacity = "0.4";
                }
            });
        }, 1000);
    }

    // Délai avant/entre les mises auto. Adapté à l'urgence : INSTANTANÉ quand
    // l'enchère se termine bientôt (précision de snipe), court sinon. Le plafond
    // du cas "froid" est réglable via Paramètres (0 = mises instantanées partout).
    function bidDelayMs(auction) {
        const maxDelay = getSetting('humanizedBidDelayMs');
        if (!(maxDelay > 0)) return 0;
        const endTs = auction && auction.end_at ? new Date(auction.end_at).getTime() : 0;
        const remaining = endTs ? endTs - Date.now() : Infinity;
        if (remaining < 15000) return 0;                       // snipe critique : 0 délai
        if (remaining < 60000) return Math.min(250, maxDelay); // chaud : très court
        return 200 + Math.random() * maxDelay;                 // froid : humanisé
    }

    // Après une mise réussie : marque IMMÉDIATEMENT l'enchère comme menée par moi
    // (état optimiste) et re-render la ligne, sans attendre le prochain scan.
    // Le prochain tick hot-lane / scan réconcilie ensuite avec l'état serveur réel.
    function markAuctionAsMine(auctionId, bidAmount, auctionObj) {
        if (currentUsername) leadingBidsMap.set(auctionId, currentUsername);
        // Mémorise le montant de ma mise (signal d'identité indépendant du pseudo)
        if (Number.isFinite(bidAmount)) myLastBidMap.set(auctionId, bidAmount);
        clearOutbid(auctionId);
        trackMyBid(auctionId);
        // Met à jour l'objet source du rendu (celui présent dans lastHitsCache)
        const target = lastHitsCache.find(h => h && h.id === auctionId) || auctionObj;
        if (target) {
            target.current_bidder = { ...(target.current_bidder || {}), username: currentUsername };
            if (Number.isFinite(bidAmount)) target.current_bid = bidAmount;
            if (target.end_at) activeHitsMap.set(auctionId, { auction: target, endAt: target.end_at });
        }
        // Re-render immédiat de la liste des hits (pose le 👑 tout de suite)
        const el = document.getElementById('wm-market-alert');
        if (el && lastHitsCache.length > 0) renderMarketHits(el, lastHitsCache, []);
    }

    // Garde-fou anti-blip : une enchère absente du scan courant a peut-être juste
    // glissé entre 2 pages (pagination) ou été ratée transitoirement. Si son end_at
    // connu est encore dans le futur, on la considère TOUJOURS vivante → on ne prune pas
    // (évite que l'auto-bid se désactive « sans raison »).
    function auctionLikelyStillLive(id) {
        const last = activeHitsMap.get(id);
        if (last && last.auction && last.auction.end_at) {
            return new Date(last.auction.end_at).getTime() > Date.now() + 5000;
        }
        return false;
    }

    async function checkMarketplace(marketAlertEl, marketStatusEl) {
        // Pause propre si le réseau est coupé
        if (!navigator.onLine) {
            if (marketStatusEl) marketStatusEl.innerHTML = `<span style="color:#ef4444;font-size:10px;">📡 hors ligne</span>`;
            return;
        }
        // Synchronise les achats gagnés depuis le serveur, au plus une fois par minute
        if (Date.now() - lastWonSync > 60000) {
            lastWonSync = Date.now();
            syncWonAuctions(); // async, non bloquant
        }
        try {
            await fetchBalance();
            marketStatusEl.innerHTML = `<span style="color:#06b6d4;font-size:10px;">⏳ scan p.1…</span>`;

            const { auctions, total, totalPages } = await fetchAllMarketAuctions((page, total, found) => {
                marketStatusEl.innerHTML =
                    `<span style="color:#06b6d4;font-size:10px;white-space:nowrap;">⏳ p.${page}/${total} · ${found} annonces</span>`;
            });

            const now = new Date().toLocaleTimeString("fr-FR",
                { hour:"2-digit", minute:"2-digit", second:"2-digit" });
            marketStatusEl.innerHTML =
                `<span style="color:#555;font-size:10px;white-space:nowrap;">✅ ${now} · ${total} annonces · ${totalPages} pages</span>`;
            apiHealth.lastMarketScanTs = Date.now(); // santé : dernier scan marché réussi

            // Auto-track : si je suis le current bidder sur une enchère, je la mémorise
            auctions.forEach(a => {
                if (isSelf(a.current_bidder?.username)) trackMyBid(a.id);
            });

            // Prune : retire de myBidsSet les enchères qui ne sont plus en cours
            const liveIds = new Set(auctions.map(a => a.id));
            let prunedAny = false;
            for (const id of [...myBidsSet]) {
                if (liveIds.has(id)) continue;
                const last = activeHitsMap.get(id);
                // Garde-fou : si on connaît end_at et qu'il est dans le futur,
                // c'est juste un blip de scan (pagination ratée, enchère qui glisse entre 2 pages…)
                // → on attend le scan suivant pour décider
                if (last && last.auction && last.auction.end_at) {
                    const endTs = new Date(last.auction.end_at).getTime();
                    if (endTs > Date.now() + 5000) continue; // 5s de marge pour éviter les races
                }
                // Tente de récupérer le dernier état connu pour logger qui a gagné / à combien
                if (last && last.auction) {
                    const a = last.auction;
                    const t = a.card?.wikipedia_title || '?';
                    const r = (a.card?.rarity || '').toUpperCase();
                    const finalBid = a.current_bid ?? a.base_amount;
                    const winner = a.current_bidder?.username || null;
                    if (winner === currentUsername) {
                        // Note : le comptage des achats (bidsWon/bidsSpent) est fait par
                        // syncWonAuctions() à partir de l'endpoint serveur, plus fiable.
                        // Ici on ne fait que logguer en temps réel.
                        wmLog(`🏆 Enchère gagnée : <b>${t}</b> [${r}] à <span style="color:#fbbf24;">${finalBid} 💰</span>`);
                    } else if (winner) {
                        wmLog(`🏳️ Enchère perdue : <b>${t}</b> [${r}] · <b>${winner}</b> à <span style="color:#fbbf24;">${finalBid} 💰</span>`);
                    } else {
                        wmLog(`📭 Enchère terminée sans vente : <b>${t}</b> [${r}]`);
                    }
                } else {
                    wmLog(`📭 Enchère ${id.slice(0,8)}… terminée`);
                }
                myBidsSet.delete(id);
                prunedAny = true;
            }
            if (prunedAny) saveMyBids();

            // Prune autoBidSet : UNIQUEMENT les enchères réellement terminées.
            // Garde-fou anti-blip → on ne coupe plus l'auto-bid sur une enchère qui a
            // juste glissé entre 2 pages du scan (cause du « il se désactive sans raison »).
            let autoBidPruned = false;
            for (const id of [...autoBidSet]) {
                if (liveIds.has(id)) continue;
                if (auctionLikelyStillLive(id)) continue; // blip de scan : on garde l'auto-bid
                const last = activeHitsMap.get(id);
                const t = last?.auction?.card?.wikipedia_title || `${id.slice(0,8)}…`;
                autoBidSet.delete(id);
                autoBidPruned = true;
                wmLog(`🤖 Auto-bid retiré (enchère terminée) : <b>${t}</b>`);
            }
            if (autoBidPruned) saveAutoBidSet();

            // Prune le mode Fourbe — même garde-fou anti-blip que l'auto-bid.
            let snipePruned = false;
            for (const id of [...snipeSet]) {
                if (liveIds.has(id)) continue;
                if (auctionLikelyStillLive(id)) continue;
                const last = activeHitsMap.get(id);
                const t = last?.auction?.card?.wikipedia_title || `${id.slice(0,8)}…`;
                snipeSet.delete(id);
                snipePruned = true;
                wmLog(`🕵️ Fourbe retiré (enchère terminée) : <b>${t}</b>`);
            }
            if (snipePruned) saveSnipeSet();

            // Prune le suivi du Hunter agressif — même garde-fou anti-blip. Sans ça, la Map
            // grossirait indéfiniment et un désarmement futur restaurerait des plafonds sur
            // des enchères mortes depuis longtemps.
            let aggroPruned = false;
            for (const id of [...hunterFourbeMap.keys()]) {
                if (liveIds.has(id)) continue;
                if (auctionLikelyStillLive(id)) continue;
                hunterFourbeMap.delete(id); aggroPruned = true;
            }
            if (aggroPruned) saveHunterFourbe();

            // Prune les plafonds auto-bid — même garde-fou (sinon on perdrait le plafond
            // sur un simple blip, et la carte repasserait en auto-bid SANS limite).
            let maxPruned = false;
            for (const id of [...autoBidMaxMap.keys()]) {
                if (liveIds.has(id)) continue;
                if (auctionLikelyStillLive(id)) continue;
                autoBidMaxMap.delete(id); maxPruned = true;
            }
            if (maxPruned) saveAutoBidMax();

            // Purge le suivi auto-désactivation pour les enchères terminées SANS être
            // gagnées (perdues, annulées…) — sinon la map grossirait indéfiniment. Une
            // victoire réelle est déjà retirée de la map par syncWonAuctions() lui-même.
            let hadPruned = false;
            for (const id of [...hunterAutoDisableMap.keys()]) {
                if (liveIds.has(id)) continue;
                if (auctionLikelyStillLive(id)) continue;
                hunterAutoDisableMap.delete(id); hadPruned = true;
            }
            if (hadPruned) saveHunterAutoDisableMap();

            // Purge le suivi "montant de ma dernière mise" pour les enchères terminées
            for (const id of [...myLastBidMap.keys()]) {
                if (liveIds.has(id)) continue;
                if (auctionLikelyStillLive(id)) continue;
                myLastBidMap.delete(id);
            }

            // Purge la dé-dup de log des surenchères pour les enchères terminées (borne la taille,
            // puisque clearOutbid ne la vide plus lors d'une reprise de lead).
            for (const id of [...outbidLogMap.keys()]) {
                if (liveIds.has(id)) continue;
                if (auctionLikelyStillLive(id)) continue;
                outbidLogMap.delete(id);
            }

            /* ── Classement mots-clés en masse : optimisé pour ~N annonces × ~M mots-clés ──
               AVANT : hasKeyword/hasPriorityKeyword/hasFourbeKeyword/hasHunterKeyword
               recalculaient `.toLowerCase()` sur le titre/catégorie ET sur chaque mot-clé À
               CHAQUE comparaison individuelle — jamais mis en cache, ni côté carte (une fois
               par annonce aurait suffi) ni côté mot-clé (une fois par scan aurait suffi).
               Avec ~260 mots-clés cumulés et un marché à ~6000 annonces, ça fait plusieurs
               MILLIONS d'appels `.toLowerCase()` redondants par scan (~toutes les 10s).
               ICI : les mots-clés sont mis en minuscules UNE fois pour tout le scan (~260
               appels, coût négligible — recalculé à chaque scan plutôt que mis en cache entre
               deux scans, pour ne jamais risquer un cache désynchronisé après un ajout/retrait
               de mot-clé), et le titre/catégorie de chaque annonce UNE fois par annonce (pas
               une fois par mot-clé testé contre elle). Comportement de matching identique
               (sous-chaîne, insensible à la casse, titre + catégorie) — seul le nombre de
               recalculs change. */
            const alertLC    = KEYWORDS_ALERT.map(k => (k || '').toLowerCase());
            const priorityLC = KEYWORDS_PRIORITY.map(k => (k || '').toLowerCase());
            const fourbeLC   = KEYWORDS_FOURBE.map(k => (k || '').toLowerCase());
            const excludeLC  = KEYWORDS_EXCLUDE.map(k => (k || '').toLowerCase());
            const hunterLC   = KEYWORDS_HUNTER.map(h => ({ h, textLC: (h.text || '').toLowerCase() }));
            function classifyAuctionKeywords(card) {
                const titleLC = (card?.wikipedia_title || '').toLowerCase();
                const categoryLC = (card?.category || '').toLowerCase();
                const matchAny = (lc) => lc.some(k => titleLC.includes(k) || categoryLC.includes(k));
                let hunterEntry = null;
                for (const { h, textLC } of hunterLC) {
                    if (titleLC.includes(textLC) || categoryLC.includes(textLC)) { hunterEntry = h; break; }
                }
                const alert = matchAny(alertLC);
                const priority = matchAny(priorityLC);
                const fourbe = matchAny(fourbeLC);
                return {
                    excluded: excludeLC.length > 0 && matchAny(excludeLC),
                    alert, priority, fourbe, hunterEntry,
                    keywordMatch: alert || priority || fourbe || !!hunterEntry
                };
            }
            // Réutilisée juste en dessous pour newHits (sinon on re-classerait les mêmes
            // annonces une seconde fois pour la même information).
            const kwClassCache = new Map(); // auction.id -> classification

            // Filtre les hits : mots-clés (standard + prioritaires) OU enchères où je mise.
            // Exclusion STRICTE : une annonce contenant un mot exclu est écartée — SAUF
            // si je mise déjà dessus (je veux toujours voir/suivre mes propres enchères).
            const hits = auctions.filter(a => {
                // Classifie D'ABORD, même pour mes propres mises : sinon kwClassCache resterait
                // sans entrée pour ces annonces, et newHits (juste en dessous) perdrait la
                // notif si une enchère où je mise DÉJÀ matche AUSSI un mot-clé (cas réel : bug
                // trouvé au test avant mise en prod — l'ancien code re-testait indépendamment
                // du court-circuit myBidsSet, mon 1er jet ne le faisait pas).
                const cls = classifyAuctionKeywords(a.card);
                kwClassCache.set(a.id, cls);
                if (myBidsSet.has(a.id)) return true;
                if (cls.excluded) return false;
                return cls.keywordMatch;
            });

            // Marque l'instant de première détection de chaque hit (pour tri "ajout récent")
            // et purge les entrées des enchères qui ne sont plus listées.
            hits.forEach(a => markFirstSeen(a.id));
            const liveHitIds = new Set(hits.map(a => a.id));
            for (const id of [...firstSeenMap.keys()]) {
                if (liveHitIds.has(id)) continue;
                // Une annonce peut disparaître d'UN cycle sans être terminée : page ratée du
                // scan, ou glissement entre pages (tri ending_soon + fetch concurrent). Si son
                // enchère est encore vivante, on GARDE son firstSeen — sinon elle repasserait
                // "nouvelle" (jaune 🆕) à son retour alors qu'elle a 3 min au compteur.
                if (auctionLikelyStillLive(id)) continue;
                firstSeenMap.delete(id);
            }

            if (hits.length === 0) {
                // Aucun hit actif → nettoie si plus rien
                if (activeHitsMap.size === 0) {
                    marketAlertEl.innerHTML = `<div style="color:#555;font-size:11px;text-align:center;padding:4px 0;">
                        Aucune carte recherchée en vente</div>`;
                }
                return;
            }

            // Sépare nouveaux hits des connus — uniquement les hits MOTS-CLÉS déclenchent son/Discord/auto-snipe
            // (mes propres enchères, je sais déjà que j'y suis, pas besoin de notif).
            // Réutilise la classification déjà calculée juste au-dessus (kwClassCache) au lieu
            // de re-tester les mots-clés une seconde fois sur les mêmes annonces. Une annonce
            // présente dans `hits` UNIQUEMENT via myBidsSet (pas de classification en cache,
            // cf. le court-circuit ci-dessus) est donc bien exclue ici si elle ne matche aucun
            // mot-clé — même comportement que l'ancien re-test explicite.
            const newHits = hits.filter(a => !lastMarketHits.has(a.id) && (kwClassCache.get(a.id)?.keywordMatch ?? false));

            if (newHits.length > 0) {
                playSound("keyword");
                if (window.wmNotify) window.wmNotify(newHits.length);
                newHits.forEach(a => {
                    lastMarketHits.add(a.id);
                    activeHitsMap.set(a.id, { auction: a, endAt: a.end_at });
                    // Log par carte dans le dashboard
                    const t = a.card?.wikipedia_title || '?';
                    const r = (a.card?.rarity || '?').toUpperCase();
                    const p = a.current_bid ?? a.base_amount;
                    const priceLabel = a.current_bid != null ? 'mise' : 'base';
                    const owned = collectionMap.get(a.card?.id) || 0;
                    const kw = matchedKeyword(a.card) || '?';
                    wmLog(`🛒 Nouveau match : <b>${t}</b> [${r}] · ${priceLabel} ${p} 💰 · possession ×${owned} · keyword <span style="color:#00FFFF;">${kw}</span>`);
                });

                // 🛒 Notification Discord groupée
                const lines = newHits.map(a => {
                    const title = a.card?.wikipedia_title || "?";
                    const rarity = (a.card?.rarity || "?").toUpperCase();
                    const bid = a.current_bid ?? a.base_amount;
                    const hasBid = a.current_bid !== null;
                    const kw = matchedKeyword(a.card);
                    const cd = formatCountdown(a.end_at);
                    const marketUrl = `https://www.wiki-masters.com/marketplace/${a.id}`;
                    const owned = collectionMap.get(a.card?.id) || 0;
                    const ownedStr = owned > 0 ? `✔ possession : **×${owned}**` : `✗ non possédée`;
                    return (
                        `• **${title}** [${rarity}] · \`${kw}\` · ${ownedStr}\n` +
                        `  ${hasBid ? `💰 **${bid} 💰**` : `🏷️ base **${bid} 💰**`} · ⏱️ ${cd}\n` +
                        `  🔗 ${marketUrl}`
                    );
                }).join("\n\n");

                sendToDiscord(
                    `🛒 **${newHits.length} MARKET HIT${newHits.length > 1 ? "S" : ""}**\n\n${lines}`,
                    3447003,
                    'market'
                );

                // 🎯 Chasseur ciblé : traité EN PREMIER (plus spécifique : plafond + mode par
                // mot-clé). Pour chaque match : pose le plafond, arme le mode, place UNE mise
                // initiale (les deux modes). Les enchères gérées ici sont ignorées par les
                // boucles prioritaire/fourbe/auto-bid ci-dessous (handledByHunter).
                const handledByHunter = new Set();
                for (const a of newHits) {
                    const h = matchedHunterEntry(a.card);
                    if (!h) continue;
                    handledByHunter.add(a.id);
                    const title = a.card?.wikipedia_title || '?';
                    const rar = (a.card?.rarity || '').toUpperCase();
                    // Sensible à la rareté (isOwnedDuplicate, déjà utilisée par le Market
                    // Watcher pour son badge « possédé ») plutôt qu'un comptage brut par
                    // card_id : posséder l'UR ne doit PAS bloquer une mise sur la Légendaire
                    // de la même carte — même modèle (card_id inchangé), rareté différente,
                    // exactement le cas d'une carte en train de dériver.
                    const alreadyOwned = isOwnedDuplicate(a.card?.id, rar);
                    if (alreadyOwned) {
                        wmLog(`🎯 Chasseur ignoré (déjà possédée en ${rar || '?'}) : <b>${title}</b>`);
                        continue;
                    }
                    // Rareté requise (optionnelle) : aucune mise tant que la carte n'affiche
                    // pas EXACTEMENT cette rareté — utile pour une carte dont la rareté est en
                    // train de dériver (cf. wmCheckRarityDrift) et qu'on ne veut pas payer au
                    // prix de la mauvaise. On NE bascule PAS sur le Hunter générique ni sur les
                    // mots-clés prioritaire/fourbe pour autant : `handledByHunter` a déjà été
                    // marqué juste au-dessus, donc l'annonce reste simplement ignorée tant que
                    // sa rareté n'est pas la bonne — jamais reprise par un autre mécanisme.
                    if (h.rarity && h.rarity !== rar) {
                        wmLog(`🎯 Chasseur ignoré (rareté <b>${rar || '?'}</b> ≠ <b>${h.rarity}</b> requise) : <b>${title}</b>`);
                        continue;
                    }
                    // 1) Plafond de l'enchère → respecté par TOUS les chemins de mise (riposte + snipe)
                    autoBidMaxMap.set(a.id, h.cap);
                    saveAutoBidMax();
                    // 2) Arme le mode pour la suite
                    if (h.mode === 'fourbe') {
                        if (!snipeSet.has(a.id)) { snipeSet.add(a.id); saveSnipeSet(); }
                    } else {
                        if (!autoBidSet.has(a.id)) { autoBidSet.add(a.id); saveAutoBidSet(); }
                    }
                    // Auto-pause : associe DÈS L'ARMEMENT (pas seulement si la mise initiale
                    // part) cette enchère à l'entrée qui l'a armée — en mode fourbe la VRAIE
                    // mise arrive plus tard via la hot lane, pas ici, donc l'association ne
                    // doit pas dépendre du succès de la mise initiale ci-dessous.
                    if (h.autoDisable) {
                        hunterAutoDisableMap.set(a.id, h.text);
                        saveHunterAutoDisableMap();
                    }
                    // 3) Mise initiale unique (les deux modes), jamais au-dessus du plafond
                    const alreadyLeading = isSelf(a.current_bidder?.username);
                    if (alreadyLeading || bidLockSet.has(a.id) || wikibidousBalance <= getSetting('minBalanceForAutoSnipe')) {
                        wmLog(`🎯 Chasseur armé (${h.mode === 'fourbe' ? 'fourbe' : 'auto-bid'}, plafond ${h.cap}) : <b>${title}</b> [${rar}] — pas de mise initiale (${alreadyLeading ? 'déjà meneur' : 'solde/lock'})`);
                        continue;
                    }
                    const bidAmount = minNextBid(a);
                    if (!autoBidWithinCap(a, bidAmount)) {
                        wmLog(`🎯 Chasseur armé (${h.mode === 'fourbe' ? 'fourbe' : 'auto-bid'}) : <b>${title}</b> [${rar}] — mise min ${bidAmount} &gt; plafond ${h.cap}, pas de mise`);
                        continue;
                    }
                    bidLockSet.add(a.id);
                    await new Promise(r => setTimeout(r, bidDelayMs(a)));
                    try {
                        const res = await fetch(
                            `https://www.wiki-masters.com/api/marketplace/${a.id}/bid`,
                            { method: "POST", credentials: "include",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ amount: bidAmount }) }
                        );
                        const data = await res.json().catch(() => ({}));
                        if (res.ok) {
                            markAuctionAsMine(a.id, bidAmount, a);
                            wmLog(`🎯 Chasseur (${h.mode === 'fourbe' ? 'fourbe' : 'auto-bid'}, plafond ${h.cap}) : <b>${title}</b> [${rar}] → mise <span style="color:#fbbf24;">${bidAmount} 💰</span>${h.mode === 'fourbe' ? ' · snipe armé en fin' : ' · riposte activée'}`);
                            sendToDiscord("🎯 Chasseur : **" + title + "** mise **" + bidAmount + " coins** (mode " + h.mode + ", plafond " + h.cap + ")", 3447003, 'market');
                        } else {
                            wmLog(`⚠️ Chasseur échoué : <b>${title}</b> [${rar}] · ${data?.error || 'erreur'}`);
                        }
                    } catch(e) {} finally { bidLockSet.delete(a.id); }
                    await new Promise(r => setTimeout(r, bidDelayMs(a)));
                }

                // ⭐ Mots-clés prioritaires : auto-bid forcé (sans seuil, sans toggle)
                for (const a of newHits) {
                    if (handledByHunter.has(a.id)) continue; // déjà géré (plafond + mode) par le chasseur
                    if (!hasPriorityKeyword(a.card)) continue;
                    const alreadyLeading = isSelf(a.current_bidder?.username);
                    const alreadyOwned = (collectionMap.get(a.card?.id) || 0) > 0;
                    if (alreadyLeading || alreadyOwned || wikibidousBalance <= getSetting('minBalanceForAutoSnipe')) continue;
                    if (bidLockSet.has(a.id)) continue;

                    // Active l'auto-bid automatiquement sur cette enchère (riposte ultérieure)
                    if (!autoBidSet.has(a.id)) {
                        autoBidSet.add(a.id);
                        saveAutoBidSet();
                    }
                    bidLockSet.add(a.id);
                    await new Promise(r => setTimeout(r, bidDelayMs(a)));
                    const bidAmount = minNextBid(a);
                    try {
                        const res = await fetch(
                            `https://www.wiki-masters.com/api/marketplace/${a.id}/bid`,
                            { method: "POST", credentials: "include",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ amount: bidAmount }) }
                        );
                        const data = await res.json().catch(() => ({}));
                        const title = a.card?.wikipedia_title || "?";
                        const rar = (a.card?.rarity || '').toUpperCase();
                        if (res.ok) {
                            markAuctionAsMine(a.id, bidAmount, a);
                            wmLog(`⭐ Mot-clé prioritaire : <b>${title}</b> [${rar}] → <span style="color:#fbbf24;">${bidAmount} 💰</span>`);
                            sendToDiscord(
                                "⭐ Auto-bid prioritaire : **" + title + "** à **" + bidAmount + " coins**",
                                16766720, 'market'
                            );
                        } else {
                            wmLog(`⚠️ Bid prioritaire échoué : <b>${title}</b> [${rar}] · ${data?.error || 'erreur'}`);
                        }
                    } catch(e) {} finally { bidLockSet.delete(a.id); }
                    await new Promise(r => setTimeout(r, bidDelayMs(a)));
                }

                // 🕵️ Mots-clés fourbe : arme le mode snipe (~10s de la fin). On ne mise PAS
                // maintenant — la hot lane tirera au dernier moment (anti-guerre d'enchères).
                let armedFourbe = false;
                for (const a of newHits) {
                    if (handledByHunter.has(a.id)) continue;     // déjà armé par le chasseur
                    if (!hasFourbeKeyword(a.card)) continue;
                    if (hasPriorityKeyword(a.card)) continue;   // le prioritaire prime (auto-bid immédiat)
                    if (autoBidSet.has(a.id)) continue;          // déjà en auto-bid → on ne double pas
                    if (snipeSet.has(a.id)) continue;            // déjà armé
                    const alreadyOwned = (collectionMap.get(a.card?.id) || 0) > 0;
                    if (alreadyOwned || isSelf(a.current_bidder?.username)) continue;
                    snipeSet.add(a.id);
                    armedFourbe = true;
                    const title = a.card?.wikipedia_title || '?';
                    const rar = (a.card?.rarity || '').toUpperCase();
                    wmLog(`🕵️ Fourbe armé (mot-clé) : <b>${title}</b> [${rar}] — snipe à ~${getSetting('snipeSecondsBefore')}s de la fin`);
                }
                if (armedFourbe) saveSnipeSet();

                // 🤖 Auto-bid Hunter : mise initiale sur les nouvelles annonces qui matchent.
                // (Même logique réutilisée à l'activation du Hunter pour les annonces déjà là.)
                if (autoSnipeEnabled) await runHunterAutoBidPass(newHits);
            }

            // Met à jour activeHitsMap pour TOUS les hits (keyword + my-bid)
            // → ainsi mes enchères entrent dans le countdown ticker à leur 1ère apparition
            // + détecte si on a été surenchéri sur une enchère où on était meneur
            // + auto-bid si activé sur cette enchère
            const outbidHits = [];
            const autoBidQueue = [];
            hits.forEach(a => {
                activeHitsMap.set(a.id, { auction: a, endAt: a.end_at });

                const bidder = a.current_bidder?.username || null;

                // On était meneur sur cette enchère et on ne l'est plus
                if (leadingBidsMap.has(a.id)) {
                    const wasLeading = leadingBidsMap.get(a.id);
                    if (bidder && !iAmLeading(a) && isSelf(wasLeading)) {
                        markOutbid(a.id); // marquer pour affichage rouge (toujours)
                        const bidOb = a.current_bid ?? a.base_amount;
                        // Anti-doublon (partagé avec la hot lane) : notif/son/log une seule fois
                        // par surenchère (id + montant).
                        if (shouldLogOutbid(a.id, bidOb)) {
                            outbidLogMap.set(a.id, bidOb);
                            outbidHits.push(a); // → son + notif Discord groupée plus bas
                            const titleOb = a.card?.wikipedia_title || '?';
                            const rarOb = (a.card?.rarity || '').toUpperCase();
                            wmLog(`😤 Surenchéri : <b>${titleOb}</b> [${rarOb}] · <b>${bidder}</b> à <span style="color:#fbbf24;">${bidOb} 💰</span>`);
                        }
                    }
                }

                // 🤖 File d'auto-bid : TOUTE enchère où auto-bid est activé,
                // où je ne suis PAS meneur actuellement (test robuste au pseudo), et
                // où j'ai du solde. Idempotent : tant que je suis dépassé et sous le
                // plafond, on re-tente à chaque scan.
                if (autoBidSet.has(a.id)
                    && !iAmLeading(a)
                    && wikibidousBalance > 0
                    && !bidLockSet.has(a.id)) {
                    autoBidQueue.push(a);
                }

                // Mémorise si on est meneur maintenant
                if (iAmLeading(a)) {
                    if (currentUsername) leadingBidsMap.set(a.id, currentUsername);
                    clearOutbid(a.id); // on a repris/gardé le lead
                } else if (leadingBidsMap.has(a.id) && bidder) {
                    leadingBidsMap.set(a.id, bidder);
                }
            });

            // 🔔 Alerte surenchère
            if (outbidHits.length > 0) {
                playSound("outbid");
                if (window.wmNotify) window.wmNotify(outbidHits.length);
                const lines = outbidHits.map(a => {
                    const title = a.card?.wikipedia_title || "?";
                    const rarity = (a.card?.rarity || "?").toUpperCase();
                    const bid = a.current_bid ?? a.base_amount;
                    const bidder = a.current_bidder?.username || "?";
                    const cd = formatCountdown(a.end_at);
                    const marketUrl = "https://www.wiki-masters.com/marketplace/" + a.id;
                    return "- **" + title + "** [" + rarity + "]\n  Surencheri par **" + bidder + "** a **" + bid + " coins** - " + cd + "\n  " + marketUrl;
                }).join("\n\n");

                sendToDiscord(
                    "SURENCHERI ! Tu n'es plus meneur sur " + outbidHits.length + " enchere" + (outbidHits.length > 1 ? "s" : "") + "\n\n" + lines,
                    15548997,
                    'market'
                );
            }

            // 🤖 Auto-bid sur surenchères
            for (const a of autoBidQueue) {
                // Skip si la hot lane a déjà pris en charge cette enchère
                if (bidLockSet.has(a.id)) continue;
                const bidAmount = minNextBid(a);
                // Respecte le plafond par enchère (coupe l'auto-bid si dépassé)
                if (!autoBidWithinCap(a, bidAmount)) continue;
                bidLockSet.add(a.id);
                await new Promise(r => setTimeout(r, bidDelayMs(a)));
                try {
                    const res = await fetch(
                        "https://www.wiki-masters.com/api/marketplace/" + a.id + "/bid",
                        { method: "POST", credentials: "include",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ amount: bidAmount }) }
                    );
                    if (res.ok) {
                        markAuctionAsMine(a.id, bidAmount, a);
                        const titleAb = a.card?.wikipedia_title || '?';
                        const rarAb = (a.card?.rarity || '').toUpperCase();
                        wmLog(`🤖 Auto-bid (riposte) : <b>${titleAb}</b> [${rarAb}] → <span style="color:#fbbf24;">${bidAmount} 💰</span>`);
                        await fetchBalance();
                        sendToDiscord(
                            "🤖 Auto-bid : **" + (a.card?.wikipedia_title || "?") + "** → **" + bidAmount + " 💰** (solde : " + wikibidousBalance + ")",
                            5763719,
                            'market'
                        );
                    } else {
                        const errData = await res.json().catch(() => ({}));
                        wmLog(`⚠️ Auto-bid (riposte) échoué : <b>${a.card?.wikipedia_title || '?'}</b> · ${errData?.error || 'erreur'}`);
                    }
                } catch(e) {} finally { bidLockSet.delete(a.id); }
            }

            // Re-render la liste complète des hits actifs
            renderMarketHits(marketAlertEl, hits, newHits);

            // Met à jour la somme des bids engagés dans le header
            updateBidsSumDisplay();

            // Lance le chargement étalé des historiques de ventes manquants.
            // À chaque historique récupéré, on re-render juste les badges concernés
            // (re-render léger de la liste avec le cache courant).
            if (salesFetchQueue.length > 0 && !salesFetchRunning) {
                processSalesQueue(() => {
                    renderMarketHits(marketAlertEl, lastHitsCache, []);
                });
            }

            // Notif dans le titre de l'onglet
            const hitCount = activeHitsMap.size;
            document.title = hitCount > 0 ? `(${hitCount}) WikiMasters` : 'WikiMasters';

        } catch(err) {
            marketStatusEl.innerHTML =
                `<span style="color:#EF4444;font-size:10px;">⚠️ ${err.message}</span>`;
        }
    }

    function renderMarketHits(marketAlertEl, hits, newHits) {
        // Cache pour permettre un re-render au changement de tri sans attendre le prochain scan
        lastHitsCache = hits;

        // 🛡️ Ne PAS reconstruire le HTML pendant que l'utilisateur édite un champ du panneau
        // (plafond auto-bid, montant de mise…). Sinon le nœud <input> est remplacé et perd
        // le focus (le champ « se désélectionne tout seul » au refresh du market). Les données
        // sont gardées à jour (lastHitsCache) et le rendu reprend au prochain cycle une fois
        // le champ quitté. Les countdowns continuent d'être mis à jour par leur ticker dédié.
        const ae = document.activeElement;
        if (marketAlertEl && ae && marketAlertEl.contains(ae)
            && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) {
            return;
        }

        // Applique le tri courant
        hits = sortHits(hits);

        // Exclusion stricte (toujours active) — retire les annonces contenant un mot
        // exclu, sauf celles où je mise déjà. Redondant avec le filtre de checkMarketplace,
        // mais nécessaire pour l'effet immédiat au clic et le rendu du cache restauré.
        if (KEYWORDS_EXCLUDE.length > 0) {
            hits = hits.filter(a => myBidsSet.has(a.id) || !hasExcludedWord(a.card));
        }

        // Filtres d'affichage : recherche live (titre/catégorie/mot-clé, sans accents)
        // + masquage des cartes déjà possédées.
        const totalBeforeFilter = hits.length;
        const sq = marketSearchNorm(marketSearchQuery.trim());
        const filterActive = sq || marketHideOwned;
        if (filterActive) {
            hits = hits.filter(a => {
                // Masque les cartes déjà possédées DANS LA MÊME RARETÉ. Une carte possédée en
                // SR mais listée en UR (revalorisée par le site) n'est PAS un doublon → visible.
                if (marketHideOwned && isOwnedDuplicate(a.card?.id ?? a.card_id, a.card?.rarity)) return false;
                if (sq) {
                    const t   = marketSearchNorm(a.card?.wikipedia_title || '');
                    const cat = marketSearchNorm(a.card?.category || '');
                    const kw  = marketSearchNorm(matchedKeyword(a.card) || '');
                    if (!(t.includes(sq) || cat.includes(sq) || kw.includes(sq))) return false;
                }
                return true;
            });
        }

        const newCount = newHits.length;
        let header;
        if (filterActive) {
            header = `<div style="font-size:10px;color:#06b6d4;letter-spacing:1px;
                text-transform:uppercase;margin-bottom:6px;">
                🔎 ${hits.length} / ${totalBeforeFilter} annonce${totalBeforeFilter>1?"s":""}
               </div>`;
        } else if (newCount > 0) {
            header = `<div style="font-size:10px;color:#00FFFF;font-weight:700;letter-spacing:1px;
                text-transform:uppercase;margin-bottom:6px;">
                🛒 ${newCount} nouvelle${newCount>1?"s":""} annonce${newCount>1?"s":""}
               </div>`;
        } else {
            header = `<div style="font-size:10px;color:#555;letter-spacing:1px;
                text-transform:uppercase;margin-bottom:6px;">
                🛒 ${hits.length} annonce${hits.length>1?"s":""} trouvée${hits.length>1?"s":""}
               </div>`;
        }

        // Comptage pour le diagnostic « schéma d'image » : n'a de sens qu'à l'échelle du lot.
        let cardsRendered = 0, cardsWithImage = 0;

        const rows = hits.map(a => {
            const title = a.card?.wikipedia_title || "?";
            const rarity = (a.card?.rarity || "").toUpperCase();
            const r = RARITY[rarity] || { color: "#aaa" };
            const myLastBidAmt = myLastBidMap.get(a.id);
            const rawBid = a.current_bid ?? a.base_amount;
            // Affichage OPTIMISTE : quand je viens de miser, un scan démarré AVANT ma mise
            // renvoie encore l'ancien prix. Si ma dernière mise connue est supérieure au
            // prix serveur, on affiche ma mise (le serveur n'a pas encore rattrapé) → le 👑
            // et mon montant restent visibles instantanément, sans clignoter au refresh.
            const optimisticMine = Number.isFinite(myLastBidAmt) && a.current_bid != null && a.current_bid < myLastBidAmt;
            const bid = optimisticMine ? myLastBidAmt : rawBid;
            const hasBid = optimisticMine ? true : (a.current_bid !== null);
            const bidder = optimisticMine ? currentUsername : (a.current_bidder?.username || null);
            // Le prix a-t-il bondi de plus de 10% au-dessus de MA dernière mise ?
            // (= quelqu'un a surenchéri au-delà de l'incrément minimum). Si oui, re-miser
            // demande un double-clic de confirmation. Basé sur le VRAI prix serveur (rawBid).
            const priceJumped = Number.isFinite(myLastBidAmt) && (Number(rawBid) || 0) > Math.ceil(myLastBidAmt * 1.10);
            const kw = matchedKeyword(a.card);
            // Surlignage "nouvelle annonce" (jaune) maintenu pendant NEW_HIGHLIGHT_MS à partir
            // de la 1re détection, au lieu de disparaître au 1er re-render (<1s). On se base sur
            // firstSeenMap (horodatage de 1re apparition) pour rester jaune même après plusieurs
            // re-renders (hot lane, etc.).
            const _firstSeen = firstSeenMap.get(a.id);
            const isNew = (Number.isFinite(_firstSeen) && (Date.now() - _firstSeen) < NEW_HIGHLIGHT_MS)
                || newHits.some(n => n.id === a.id);
            const cd = formatCountdown(a.end_at);
            const cdColor = countdownColor(a.end_at);
            const wikiUrl = a.card?.wikipedia_url || "#";
            const marketUrl = `https://www.wiki-masters.com/marketplace/${a.id}`;

            // Badge "possédé". Si possédée mais dans une AUTRE rareté que l'annonce, on le
            // signale (ambre) : ce n'est pas un vrai doublon, d'où l'affichage même en mode masqué.
            const owned = ownedCount(a.card?.id);
            const listingRar = (a.card?.rarity || '').toUpperCase();
            const ownedRars = ownedRaritiesOf(a.card?.id);
            const otherRarityOnly = owned > 0 && ownedRars && ownedRars.size > 0
                && listingRar && !ownedRars.has(listingRar);
            const ownedRarsStr = ownedRars ? [...ownedRars].join('/') : '';
            const ownedBadge = owned > 0
                ? (otherRarityOnly
                    ? `<span style="
                        display:inline-block;padding:1px 5px;border-radius:4px;
                        font-size:10px;font-weight:700;
                        color:#fbbf24;background:rgba(251,191,36,0.12);
                        border:1px solid rgba(251,191,36,0.4);
                        vertical-align:middle;white-space:nowrap;
                        box-sizing:border-box;width:46px;text-align:center;"
                        title="Possédée en ${ownedRarsStr} — mais pas en ${listingRar} (autre rareté, pas un doublon)">
                        ✔ ×${owned}
                      </span>`
                    : `<span style="
                        display:inline-block;padding:1px 5px;border-radius:4px;
                        font-size:10px;font-weight:700;
                        color:#4ade80;background:rgba(74,222,128,0.12);
                        border:1px solid rgba(74,222,128,0.35);
                        vertical-align:middle;white-space:nowrap;
                        box-sizing:border-box;width:46px;text-align:center;" title="Cartes possédées${ownedRarsStr ? ' (' + ownedRarsStr + ')' : ''}">
                        ✔ ×${owned}
                      </span>`)
                : `<span style="
                    display:inline-block;padding:1px 5px;border-radius:4px;
                    font-size:10px;font-weight:700;
                    color:#555;background:rgba(255,255,255,0.04);
                    border:1px solid rgba(255,255,255,0.08);
                    vertical-align:middle;white-space:nowrap;
                    box-sizing:border-box;width:46px;text-align:center;" title="Non possédée">
                    ✗ ×0
                  </span>`;

            // Meneur = test robuste (pseudo tolérant OU prix ≤ ma dernière mise) : garde le
            // 👑 même si un scan stale renvoie des données d'avant ma mise.
            const isLeading = iAmLeading(a);
            const isOutbid = outbidSet.has(a.id);

            // Badge de valorisation (sous-coté / dans la moyenne / surcoté)
            // basé sur l'historique des ventes de cette carte.
            const cardId = a.card?.id ?? a.card_id;
            queueSalesFetch(cardId); // met en file si pas en cache
            const val = computeValuation(bid, cardId);
            const valBadge = val
                ? `<span style="
                    display:inline-block;padding:1px 5px;border-radius:4px;
                    font-size:9px;font-weight:700;
                    color:${val.color};background:${val.color}1a;
                    border:1px solid ${val.color}55;
                    vertical-align:middle;white-space:nowrap;box-sizing:border-box;cursor:help;"
                    title="${val.tip}">
                    ${val.status === 'under' ? '📉' : val.status === 'over' ? '📈' : val.status === 'few' ? '❔' : val.status === 'none' ? '🚫' : '➖'} ${val.label}
                  </span>`
                : `<span style="display:inline-block;font-size:9px;color:#444;vertical-align:middle;" title="Chargement de l'historique…">⋯</span>`;

            // Couleur de la rareté en hex (#RRGGBB) pour la bande de droite
            const rarHex = r.color || '#888';
            // Couleur d'état (mise/lead) pour les 60% de gauche
            const stateColor = isOutbid  ? 'rgba(239,68,68,0.22)'   // rouge : surenchéri
                             : isLeading ? 'rgba(168,85,247,0.20)'  // violet : je suis meneur
                             : isNew     ? 'rgba(255,215,0,0.18)'   // or : nouvelle annonce
                             :             'rgba(255,255,255,0.04)'; // neutre : juste un hit
            // 60% solide état à gauche, puis fondu progressif sur les 40% restants vers la rareté
            const rowBg = `linear-gradient(to right, ${stateColor} 0%, ${stateColor} 60%, ${rarHex}80 100%, ${rarHex}80 100%)`;
            const rowBorder = isOutbid  ? 'rgba(239,68,68,0.7)'
                            : isLeading ? 'rgba(168,85,247,0.5)'
                            : isNew     ? 'rgba(255,215,0,0.4)'
                            :             `${rarHex}55`;

            // Vue compacte : une seule ligne (nom · bid actuel · leader · temps restant)
            // pour afficher beaucoup plus d'enchères. On garde les id wm-hit / wm-countdown
            // pour que le ticker de countdown continue de fonctionner.
            // La flèche ▸ agrandit UNE ligne en vue détaillée (marketExpandedIds) sans
            // avoir à repasser tout le panneau en mode détaillé.
            // ── Vue CADRES : une tuile par annonce, image de la carte en évidence ──
            // La bordure extérieure porte l'ÉTAT (meneur / surenchéri / nouveau), le cadre
            // intérieur porte la RARETÉ — mêmes deux dimensions que la vue en ligne, juste
            // séparées dans l'espace au lieu d'un dégradé gauche→droite.
            if (marketView === 'cards') {
                const imgUrl = cardImageUrl(a.card);
                cardsRendered++;
                if (imgUrl) cardsWithImage++;
                const desc = cardDescription(a.card);
                const nextBid = minNextBid(a);
                const bidMode = bidModeOf(a.id);
                const modeUi = BID_MODE_UI[bidMode];
                const capVal = getAutoBidMax(a.id);
                const tileBorder = isOutbid  ? 'rgba(239,68,68,0.7)'
                                 : isLeading ? 'rgba(168,85,247,0.6)'
                                 : isNew     ? 'rgba(255,215,0,0.5)'
                                 :             'rgba(255,255,255,0.07)';
                // Placeholder toujours présent dans le DOM : il prend le relais si l'URL est
                // absente OU si le chargement échoue (onerror), sans re-render.
                const placeholder = `<div class="wm-card-ph" style="display:${imgUrl ? 'none' : 'flex'};
                    position:absolute;inset:0;align-items:center;justify-content:center;flex-direction:column;gap:2px;
                    background:linear-gradient(135deg, ${rarHex}22 0%, ${rarHex}0d 100%);"
                    title="Cet article Wikipédia n'a pas d'illustration">
                    <span style="font-size:22px;opacity:0.45;filter:grayscale(0.3);">🃏</span>
                    <span style="font-size:8px;color:${rarHex};opacity:0.7;letter-spacing:1px;">SANS IMAGE</span>
                </div>`;
                // Pastille « Possédé » posée SUR l'image : quand le filtre « masquer les cartes
                // possédées » est décoché, c'est l'info qu'on veut repérer d'un coup d'œil sans
                // lire les tuiles une par une. Rien du tout si la carte n'est pas possédée —
                // l'absence de pastille suffit, et ça garde les tuiles propres.
                // Ambre = possédée dans une AUTRE rareté : ce ne serait pas un doublon ici.
                const ownedPill = owned === 0 ? '' : `<span style="
                    position:absolute;bottom:4px;left:4px;max-width:calc(100% - 8px);
                    display:inline-flex;align-items:center;gap:2px;
                    padding:1px 5px;border-radius:4px;font-size:8.5px;font-weight:700;
                    letter-spacing:0.3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                    color:${otherRarityOnly ? '#fbbf24' : '#4ade80'};
                    background:${otherRarityOnly ? 'rgba(120,80,10,0.82)' : 'rgba(10,60,30,0.82)'};
                    border:1px solid ${otherRarityOnly ? 'rgba(251,191,36,0.55)' : 'rgba(74,222,128,0.5)'};
                    backdrop-filter:blur(2px);"
                    title="${otherRarityOnly
                        ? `Possédée en ${ownedRarsStr} — mais PAS en ${listingRar} : ce n'est pas un doublon pour cette rareté`
                        : `Déjà possédée ×${owned}${ownedRarsStr ? ' (' + ownedRarsStr + ')' : ''}`}">
                    ✔ ${otherRarityOnly ? `Possédé en ${ownedRarsStr}` : `Possédé${owned > 1 ? ' ×' + owned : ''}`}
                </span>`;
                return `<div id="wm-hit-${a.id}" style="
                    display:flex;flex-direction:column;border-radius:8px;overflow:hidden;
                    background:#111114;border:1px solid ${tileBorder};animation:fadeIn 0.3s ease;
                ">
                    <!-- Cadre carte : image + panneau teinté par la rareté -->
                    <div style="padding:6px 6px 0;">
                        <div style="position:relative;width:100%;aspect-ratio:1/1;border-radius:6px 6px 0 0;overflow:hidden;background:#0b0b0e;">
                            ${imgUrl ? `<img src="${htmlEsc(imgUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer"
                                onerror="this.style.display='none';const p=this.parentElement.querySelector('.wm-card-ph');if(p)p.style.display='flex';"
                                style="width:100%;height:100%;object-fit:cover;display:block;" />` : ''}
                            ${placeholder}
                            <span style="position:absolute;top:5px;left:5px;">${badge(rarity)}</span>
                            <!-- Seulement l'ÉTAT ici : le mode (auto-bid/fourbe) est lisible en
                                 toutes lettres sur son bouton, un pictogramme de plus serait
                                 redondant sur une tuile déjà chargée. -->
                            <span style="position:absolute;top:4px;right:4px;display:flex;gap:2px;font-size:10px;">
                                ${isOutbid ? '<span title="Surenchéri">😤</span>' : isLeading ? '<span title="Meneur">👑</span>' : ''}
                                ${isNew ? '<span title="Nouvelle annonce">🆕</span>' : ''}
                            </span>
                            ${ownedPill}
                        </div>
                        <div style="padding:7px 8px 8px;border-radius:0 0 6px 6px;
                            background:linear-gradient(160deg, ${rarHex}30 0%, ${rarHex}14 100%);
                            border:1px solid ${rarHex}40;border-top:none;">
                            <a href="${marketUrl}" target="wm-card-view" rel="noopener"
                                style="display:block;color:#fff;font-size:11.5px;font-weight:700;line-height:1.25;text-decoration:none;
                                overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${htmlEsc(title)}">${htmlEsc(title)}</a>
                            ${desc ? `<div style="color:#ffffffaa;font-size:9px;line-height:1.3;margin-top:2px;max-height:24px;overflow:hidden;" title="${htmlEsc(desc)}">${htmlEsc(desc)}</div>` : ''}
                        </div>
                    </div>
                    <!-- Infos enchère -->
                    <div style="padding:6px 8px 8px;">
                        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:6px;">
                            <div style="min-width:0;">
                                <div style="font-size:8px;color:#666;letter-spacing:0.5px;text-transform:uppercase;">${hasBid ? 'Mise actuelle' : 'Mise de départ'}</div>
                                <div style="color:#FFD700;font-weight:700;font-size:12px;">${(Number(bid) || 0).toLocaleString('fr-FR')} 💰</div>
                            </div>
                            <div style="text-align:right;flex-shrink:0;">
                                <div style="font-size:8px;color:#666;letter-spacing:0.5px;text-transform:uppercase;">Durée</div>
                                <span id="wm-countdown-${a.id}" style="color:${cdColor};font-family:monospace;font-weight:700;font-size:12px;">${cd}</span>
                            </div>
                        </div>
                        <!-- La possession est portée par la pastille sur l'image : la répéter
                             ici ne ferait que rogner la place du nom de l'enchérisseur. -->
                        <div style="display:flex;align-items:center;gap:4px;margin-top:4px;font-size:9px;color:#666;">
                            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
                                title="${hasBid ? `Meilleur enchérisseur : ${htmlEsc(bidder || '?')}` : 'Aucune mise'}">${hasBid ? `🙋 ${htmlEsc(bidder || '?')}` : '🙋 aucune mise'}</span>
                        </div>
                        <!-- Le badge de valorisation est en nowrap et peut dépasser la largeur
                             d'une tuile étroite (ex. "📉 sous-coté · méd. 1000") ; sans
                             min-width:0 il gardait sa largeur intrinsèque en flexbox et
                             repoussait le bouton 🔭 hors de la zone visible (clippé par le
                             overflow:hidden du conteneur) au lieu de le laisser s'afficher à
                             côté. Le badge tronque désormais lui-même (…) plutôt que le bouton. -->
                        <div style="margin-top:4px;display:flex;align-items:center;gap:4px;overflow:hidden;">
                            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;">${valBadge}</span>
                            <button title="Vérifier si la rareté est sur le point de changer (vues Wikipédia réelles vs cache WikiMasters). Ne mise rien."
                                onclick="if(window.wmCheckAuctionRarity)window.wmCheckAuctionRarity('${a.id}', this);"
                                style="flex-shrink:0;height:16px;box-sizing:border-box;padding:0 4px;border:1px solid rgba(167,139,250,0.35);border-radius:3px;background:none;color:#a78bfa;font-size:9px;cursor:pointer;display:inline-flex;align-items:center;line-height:1;">🔭</button>
                        </div>
                        <div id="wm-raritydrift-${a.id}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${rarityDriftBadgeHtml(cachedRarityDriftRow(title))}</div>
                        <button data-jumped="${priceJumped ? 1 : 0}"
                            title="Miser le minimum (${nextBid} 💰)${priceJumped ? ' — ⚠ prix en forte hausse, double-clic requis' : ''}"
                            onclick="(async()=>{ const btn=this; const amount=${nextBid}; if(!amount||isNaN(amount)) return;
                                const base='🔨 Miser ' + amount.toLocaleString('fr-FR') + ' 💰';
                                if(btn.dataset.jumped === '1' && btn.dataset.confirm !== '1'){ btn.dataset.confirm='1'; btn.innerText='⚠ Confirmer ?'; btn.style.color='#fbbf24'; clearTimeout(btn._ct); btn._ct=setTimeout(()=>{btn.dataset.confirm='';btn.innerText=base;btn.style.color='#06b6d4';},3000); return; }
                                btn.dataset.confirm=''; clearTimeout(btn._ct);
                                btn.disabled=true; btn.innerText='⏳';
                                try { const res=await fetch('https://www.wiki-masters.com/api/marketplace/${a.id}/bid',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount})});
                                    btn.innerText=res.ok?'✔ Misé':'✗ Échec'; btn.style.color=res.ok?'#4ade80':'#ef4444';
                                    if(res.ok){ if(window.wmMarkAuctionMine) window.wmMarkAuctionMine('${a.id}', amount); else if(window.wmTrackMyBid) window.wmTrackMyBid('${a.id}'); }
                                } catch(e){ btn.innerText='✗ Échec'; btn.style.color='#ef4444'; }
                                setTimeout(()=>{btn.disabled=false;btn.innerText=base;btn.style.color='#06b6d4';},1500);
                            })()"
                            style="width:100%;margin-top:6px;height:24px;font-size:10px;font-weight:700;
                            border:1px solid rgba(6,182,212,0.4);border-radius:4px;background:rgba(6,182,212,0.06);
                            color:#06b6d4;cursor:pointer;">🔨 Miser ${nextBid.toLocaleString('fr-FR')} 💰</button>
                        <!-- Automatismes : un seul bouton à 3 états + son plafond -->
                        <div style="display:flex;gap:4px;margin-top:4px;">
                            <button onclick="window.wmCycleBidMode('${a.id}')"
                                title="Mode de mise automatique — clic pour passer au suivant : ⚪ Manuel → 🤖 Auto-bid (riposte à chaque surenchère) → 🕵️ Fourbe (une seule mise, à ~${getSetting('snipeSecondsBefore')}s de la fin) → ⚪ Manuel. Les deux automatismes respectent le plafond ci-contre."
                                style="flex:1;min-width:0;height:22px;font-size:9px;font-weight:700;cursor:pointer;
                                border:1px solid ${modeUi.border};border-radius:4px;background:${modeUi.bg};color:${modeUi.color};
                                white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${modeUi.label}</button>
                            <input id="wm-autobidmax-${a.id}" type="number" min="0" value="${capVal ?? ''}"
                                placeholder="${(() => { const e = getCachedSales(a.card?.id ?? a.card_id); return (e && e.count > 0 && e.median > 0) ? '~' + e.median : 'max'; })()}"
                                title="Plafond : au-delà de ce montant, l'automatisme se coupe pour cette enchère. Vide = sans plafond."
                                oninput="window.wmOnAutoBidMax('${a.id}', this.value, false)"
                                onchange="window.wmOnAutoBidMax('${a.id}', this.value, true)"
                                style="width:52px;flex-shrink:0;height:22px;box-sizing:border-box;padding:0 3px;border-radius:4px;
                                border:1px solid rgba(251,191,36,0.4);background:#0f0f13;color:#fbbf24;font-size:9px;text-align:center;" />
                        </div>
                    </div>
                </div>`;
            }

            if (marketView === 'compact' && !marketExpandedIds.has(a.id)) {
                return `<div id="wm-hit-${a.id}" style="display:flex;align-items:center;gap:8px;padding:3px 8px;border-radius:4px;margin-bottom:2px;background:${rowBg};border:1px solid ${rowBorder};font-size:11px;animation:fadeIn 0.3s ease;">
                    <span onclick="window.wmToggleRowExpand('${a.id}')" title="Agrandir cette enchère" style="cursor:pointer;color:#888;font-size:11px;flex-shrink:0;user-select:none;">▸</span>
                    ${isOutbid ? '<span title="Surenchéri">😤</span>' : isLeading ? '<span title="Meneur">👑</span>' : isNew ? '<span title="Nouvelle annonce">🆕</span>' : ''}
                    ${snipeSet.has(a.id) ? `<span title="Mode Fourbe activé (snipe en fin d'enchère)${getAutoBidMax(a.id) ? ` · plafond ${getAutoBidMax(a.id).toLocaleString('fr-FR')} 💰` : ' · sans plafond'}" style="flex-shrink:0;font-size:9px;">🟣</span>` : ''}
                    <a href="${marketUrl}" target="wm-card-view" rel="noopener" style="color:#fff;text-decoration:none;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${title}">${title}</a>
                    <span style="color:#FFD700;font-weight:700;white-space:nowrap;">${(Number(bid) || 0).toLocaleString('fr-FR')} 💰</span>
                    <span style="color:#888;white-space:nowrap;max-width:90px;overflow:hidden;text-overflow:ellipsis;" title="${hasBid ? (bidder || '?') : 'aucune mise'}">${hasBid ? (bidder || '?') : '—'}</span>
                    <span id="wm-countdown-${a.id}" style="color:${cdColor};font-family:monospace;font-weight:700;white-space:nowrap;min-width:50px;text-align:right;">${cd}</span>
                    <button data-jumped="${priceJumped ? 1 : 0}"
                        title="Miser le minimum (${minNextBid(a)} 💰)${priceJumped ? ' — ⚠ prix en forte hausse, double-clic requis' : ''}"
                        onclick="(async()=>{ const btn=this; const amount=${minNextBid(a)}; if(!amount||isNaN(amount)) return;
                            if(btn.dataset.jumped === '1' && btn.dataset.confirm !== '1'){ btn.dataset.confirm='1'; btn.innerText='⚠'; btn.style.color='#fbbf24'; clearTimeout(btn._ct); btn._ct=setTimeout(()=>{btn.dataset.confirm='';btn.innerText='🔨';btn.style.color='#06b6d4';},3000); return; }
                            btn.dataset.confirm=''; clearTimeout(btn._ct);
                            btn.disabled=true; btn.innerText='⏳';
                            try { const res=await fetch('https://www.wiki-masters.com/api/marketplace/${a.id}/bid',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount})});
                                btn.innerText=res.ok?'✔':'✗'; btn.style.color=res.ok?'#4ade80':'#ef4444';
                                if(res.ok){ if(window.wmMarkAuctionMine) window.wmMarkAuctionMine('${a.id}', amount); else if(window.wmTrackMyBid) window.wmTrackMyBid('${a.id}'); }
                            } catch(e){ btn.innerText='✗'; }
                            setTimeout(()=>{btn.disabled=false;btn.innerText='🔨';btn.style.color='#06b6d4';},1500);
                        })()"
                        style="flex-shrink:0;font-size:11px;line-height:1;height:20px;padding:0 6px;border:1px solid rgba(6,182,212,0.35);border-radius:3px;background:none;color:#06b6d4;cursor:pointer;">🔨</button>
                </div>`;
            }

            return `<div id="wm-hit-${a.id}" style="
                padding:6px 8px; border-radius:6px; margin-bottom:4px;
                background:${rowBg}; border:1px solid ${rowBorder};
                animation:fadeIn 0.3s ease;
            ">
                <!-- Titre + rareté -->
                <div style="display:flex;align-items:center;gap:5px;margin-bottom:3px;">
                    ${marketView === 'compact' ? `<span onclick="window.wmToggleRowExpand('${a.id}')" title="Réduire (revenir en compact)" style="cursor:pointer;color:#06b6d4;font-size:11px;flex-shrink:0;user-select:none;">▾</span>` : ''}
                    ${isNew ? '<span style="font-size:11px;" title="Nouvelle annonce">🆕</span>' : ''}
                    ${isOutbid ? '<span style="font-size:11px;" title="Vous avez perdu le lead">😤</span>' : isLeading ? '<span style="font-size:11px;" title="Vous êtes meneur">👑</span>' : ''}
                    <a href="${marketUrl}" target="wm-card-view" rel="noopener" style="color:#fff;font-size:12px;font-weight:700;flex:1;text-decoration:none;">${title}</a>
                    ${badge(rarity)}
                    ${ownedBadge}
                    ${kw
                        ? `<span style="color:#00FFFF;font-size:9px;opacity:0.7;
                            background:rgba(0,255,255,0.1);padding:1px 4px;border-radius:3px;
                            box-sizing:border-box;width:82px;text-align:center;
                            display:inline-block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                            vertical-align:middle;" title="${kw}">${kw}</span>`
                        : `<span style="box-sizing:border-box;width:82px;display:inline-block;"></span>`
                    }
                </div>
                <!-- Enchère + temps + liens -->
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <span style="font-size:11px;">
                        ${hasBid
                            ? `<span style="color:#FFD700;font-weight:700;">💰 ${(Number(bid) || 0).toLocaleString('fr-FR')} 💰</span>
                               <span style="color:#888;font-size:10px;"> par ${bidder || "?"}</span>`
                            : `<span style="color:#888;font-size:11px;">Base : ${(Number(bid) || 0).toLocaleString('fr-FR')} 💰</span>`
                        }
                    </span>
                    ${valBadge}
                    <button title="Vérifier si la rareté de cette carte est sur le point de changer : compare les vues Wikipédia RÉELLES du dernier mois complet au cache de WikiMasters (qui met du temps à se mettre à jour). Ne mise rien, juste un indice."
                        onclick="if(window.wmCheckAuctionRarity)window.wmCheckAuctionRarity('${a.id}', this);"
                        style="height:18px;box-sizing:border-box;padding:0 5px;border:1px solid rgba(167,139,250,0.35);border-radius:3px;background:none;color:#a78bfa;font-size:10px;cursor:pointer;display:inline-flex;align-items:center;line-height:1;">🔭</button>
                    <span id="wm-raritydrift-${a.id}">${rarityDriftBadgeHtml(cachedRarityDriftRow(title))}</span>
                    <div style="margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;line-height:1.1;">
                        <span id="wm-countdown-${a.id}" style="
                            font-size:11px;font-weight:700;font-family:monospace;color:${cdColor};
                        ">⏱ ${cd}</span>
                        ${(() => {
                            const seller = a.seller?.username || a.owner?.username || a.user?.username || a.lister?.username || a.created_by?.username || null;
                            return seller ? `<span style="color:#555;font-size:9px;margin-top:-1px;">vendu par <b style="color:#777;">${seller}</b></span>` : '';
                        })()}
                    </div>
                </div>
                <!-- Liens -->
                <div style="margin-top:4px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                    <input id="wm-bidinput-${a.id}" type="number" min="${minNextBid(a)}" value="${minNextBid(a)}"
                        style="width:74px;height:24px;box-sizing:border-box;padding:0 4px;border-radius:3px;border:1px solid rgba(6,182,212,0.4);
                        background:#0f0f13;color:#fff;font-size:10px;text-align:center;" />
                    <button title="Rafraîchir le prix réel de cette enchère (mise à jour du prix et de la mise minimale)"
                        onclick="if(window.wmRefreshAuction)window.wmRefreshAuction('${a.id}', this);"
                        style="height:24px;box-sizing:border-box;padding:0 7px;border:1px solid rgba(6,182,212,0.3);border-radius:3px;background:none;color:#06b6d4;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;line-height:1;">↻</button>
                    <button data-excl="${String(title).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')}"
                        onclick="if(window.wmAddExcludeKeyword)window.wmAddExcludeKeyword(this.dataset.excl);"
                        title="Exclure strictement « ${String(title).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')} » des recherches"
                        style="height:24px;box-sizing:border-box;padding:0 7px;border:1px solid rgba(239,68,68,0.3);border-radius:3px;background:none;color:#ef4444;font-size:11px;cursor:pointer;display:inline-flex;align-items:center;">🚫</button>
                    <button data-jumped="${priceJumped ? 1 : 0}"
                        title="Miser.${priceJumped ? ' ⚠ Le prix a bondi de +10% depuis ta dernière mise — double-clic requis pour confirmer.' : ''}"
                        onclick="(async()=>{
                        const btn = this;
                        const inp = document.getElementById('wm-bidinput-${a.id}');
                        const amount = parseInt(inp.value);
                        if(!amount||isNaN(amount)) return;
                        // Le prix de l'enchère a bondi >10% au-dessus de ma dernière mise → double-clic
                        if(btn.dataset.jumped === '1' && btn.dataset.confirm !== '1'){
                            btn.dataset.confirm='1';
                            btn.innerText='⚠ Re-miser ?';
                            btn.style.color='#fbbf24'; btn.style.borderColor='rgba(251,191,36,0.6)';
                            clearTimeout(btn._ct);
                            btn._ct=setTimeout(()=>{btn.dataset.confirm='';btn.innerText='🔨 Miser';btn.style.color='#06b6d4';btn.style.borderColor='rgba(6,182,212,0.3)';},3000);
                            return;
                        }
                        btn.dataset.confirm=''; clearTimeout(btn._ct);
                        btn.disabled=true; btn.innerText='⏳';
                        try {
                            const res = await fetch('https://www.wiki-masters.com/api/marketplace/${a.id}/bid',{
                                method:'POST',credentials:'include',
                                headers:{'Content-Type':'application/json'},
                                body:JSON.stringify({amount})
                            });
                            const data = await res.json();
                            btn.innerText = res.ok ? '✔ Misé' : '✗ Erreur';
                            btn.style.color = res.ok ? '#4ade80' : '#ef4444';
                            if(res.ok) {
                                if(window.wmMarkAuctionMine) window.wmMarkAuctionMine('${a.id}', amount);
                                else if(window.wmTrackMyBid) window.wmTrackMyBid('${a.id}');
                            }
                        } catch(e){ btn.innerText='✗'; }
                        setTimeout(()=>{btn.disabled=false;btn.innerText='🔨 Miser';btn.style.color='#06b6d4';btn.style.borderColor='rgba(6,182,212,0.3)';},2000);
                    })()" style="
                        font-size:10px;color:#06b6d4;cursor:pointer;
                        height:24px;box-sizing:border-box;padding:0 8px;border:1px solid rgba(6,182,212,0.3);
                        border-radius:3px;background:none;display:inline-flex;align-items:center;">
                        🔨 Miser
                    </button>
                    <button id="wm-autobid-${a.id}" onclick="(()=>{
                        const auctionId = '${a.id}';
                        const btn = document.getElementById('wm-autobid-' + auctionId);
                        const hit = window.activeHitsMap && window.activeHitsMap.get(auctionId);
                        const card = hit && hit.auction && hit.auction.card;
                        const title = (card && card.wikipedia_title) || '?';
                        const rar = ((card && card.rarity) || '').toUpperCase();
                        if(window.autoBidSet.has(auctionId)) {
                            window.autoBidSet.delete(auctionId);
                            btn.innerText = '🤖 Auto-bid OFF';
                            btn.style.color = '#555';
                            btn.style.borderColor = 'rgba(255,255,255,0.1)';
                            if(window.wmLog) window.wmLog('🛑 Auto-bid désactivé : <b>' + title + '</b> [' + rar + ']');
                        } else {
                            window.autoBidSet.add(auctionId);
                            btn.innerText = '🤖 Auto-bid ON';
                            btn.style.color = '#4ade80';
                            btn.style.borderColor = 'rgba(74,222,128,0.4)';
                            if(window.wmLog) window.wmLog('🤖 Auto-bid activé : <b>' + title + '</b> [' + rar + ']');
                            // Mutuellement exclusif avec le mode Fourbe
                            if(window.snipeSet && window.snipeSet.has(auctionId)) {
                                window.snipeSet.delete(auctionId);
                                if(window.wmForgetHunterFourbe) window.wmForgetHunterFourbe(auctionId);
                                if(window.wmSaveSnipeSet) window.wmSaveSnipeSet();
                                const sbtn = document.getElementById('wm-snipe-' + auctionId);
                                if(sbtn){ sbtn.innerText='🕵️ Fourbe OFF'; sbtn.style.color='#555'; sbtn.style.borderColor='rgba(255,255,255,0.1)'; }
                            }
                        }
                        if(window.wmSaveAutoBidSet) window.wmSaveAutoBidSet();
                    })()" style="
                        font-size:10px;color:${autoBidSet.has(a.id) ? '#4ade80' : '#555'};cursor:pointer;
                        height:24px;box-sizing:border-box;padding:0 8px;border:1px solid ${autoBidSet.has(a.id) ? 'rgba(74,222,128,0.4)' : 'rgba(255,255,255,0.1)'};
                        border-radius:3px;background:none;white-space:nowrap;display:inline-flex;align-items:center;">
                        🤖 Auto-bid ${autoBidSet.has(a.id) ? 'ON' : 'OFF'}
                    </button>
                    <input id="wm-autobidmax-${a.id}" type="number" min="0" placeholder="${(() => {
                        const cid = a.card?.id ?? a.card_id;
                        const e = getCachedSales(cid);
                        return (e && e.count > 0 && e.median > 0) ? '~' + e.median : 'max';
                    })()}"
                        value="${getAutoBidMax(a.id) ?? ''}"
                        title="Plafond auto-bid : au-delà de ce montant, l'auto-bid se coupe pour cette enchère. Laisse vide pour ne PAS plafonner (auto-bid illimité).${(() => {
                            const cid = a.card?.id ?? a.card_id;
                            const e = getCachedSales(cid);
                            return (e && e.count > 0) ? ' Médiane marché indicative : ' + e.median + ' 💰' : '';
                        })()}"
                        oninput="window.wmOnAutoBidMax('${a.id}', this.value, false)"
                        onchange="window.wmOnAutoBidMax('${a.id}', this.value, true)"
                        style="width:82px;height:24px;box-sizing:border-box;padding:0 3px;border-radius:3px;border:1px solid rgba(251,191,36,0.4);
                        background:#0f0f13;color:#fbbf24;font-size:10px;text-align:center;" />
                    <button id="wm-snipe-${a.id}" title="Mode Fourbe : ne mise qu'une seule fois, à ~${getSetting('snipeSecondsBefore')}s de la fin (anti-guerre d'enchères). Respecte le plafond auto-bid ci-contre." onclick="(()=>{
                        const auctionId = '${a.id}';
                        const btn = document.getElementById('wm-snipe-' + auctionId);
                        const abtn = document.getElementById('wm-autobid-' + auctionId);
                        const hit = window.activeHitsMap && window.activeHitsMap.get(auctionId);
                        const card = hit && hit.auction && hit.auction.card;
                        const title = (card && card.wikipedia_title) || '?';
                        if(window.snipeSet.has(auctionId)) {
                            window.snipeSet.delete(auctionId);
                            // Si c'est le Hunter agressif qui avait armé : il lâche prise et
                            // restaure le plafond d'origine (sinon son plafond resterait collé).
                            if(window.wmForgetHunterFourbe) window.wmForgetHunterFourbe(auctionId);
                            btn.innerText = '🕵️ Fourbe OFF';
                            btn.style.color = '#555';
                            btn.style.borderColor = 'rgba(255,255,255,0.1)';
                            if(window.wmLog) window.wmLog('🛑 Fourbe désactivé : <b>' + title + '</b>');
                        } else {
                            window.snipeSet.add(auctionId);
                            btn.innerText = '🕵️ Fourbe ON';
                            btn.style.color = '#c084fc';
                            btn.style.borderColor = 'rgba(192,132,252,0.5)';
                            if(window.wmLog) window.wmLog('🕵️ Fourbe activé (snipe en fin d\\'enchère) : <b>' + title + '</b>');
                            // Mutuellement exclusif avec l'auto-bid réactif
                            if(window.autoBidSet && window.autoBidSet.has(auctionId)) {
                                window.autoBidSet.delete(auctionId);
                                if(window.wmSaveAutoBidSet) window.wmSaveAutoBidSet();
                                if(abtn){ abtn.innerText='🤖 Auto-bid OFF'; abtn.style.color='#555'; abtn.style.borderColor='rgba(255,255,255,0.1)'; }
                            }
                        }
                        if(window.wmSaveSnipeSet) window.wmSaveSnipeSet();
                    })()" style="
                        font-size:10px;color:${snipeSet.has(a.id) ? '#c084fc' : '#555'};cursor:pointer;
                        height:24px;box-sizing:border-box;padding:0 8px;border:1px solid ${snipeSet.has(a.id) ? 'rgba(192,132,252,0.5)' : 'rgba(255,255,255,0.1)'};
                        border-radius:3px;background:none;white-space:nowrap;display:inline-flex;align-items:center;">
                        🕵️ Fourbe ${snipeSet.has(a.id) ? 'ON' : 'OFF'}
                    </button>
                </div>
            </div>`;
        }).join("");

        // Zéro image sur TOUT un lot d'annonces = le champ a changé de nom côté API. Une carte
        // isolée sans illustration est normal et ne doit rien déclencher.
        if (cardsRendered >= 5 && cardsWithImage === 0) logMarketCardFieldsOnce(hits[0]?.card);

        // La vue cadres s'auto-adapte à la largeur du panneau (redimensionnable) : autant de
        // colonnes que la place le permet, minimum 132px par tuile.
        const rowsWrapped = (marketView === 'cards')
            ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:8px;">${rows}</div>`
            : rows;

        const body = (filterActive && hits.length === 0)
            ? `<div style="color:#666;font-size:11px;text-align:center;padding:8px 0;">Aucune annonce ne correspond${sq ? ` à « ${marketSearchQuery.trim()} »` : ''}${marketHideOwned ? ' (cartes possédées masquées)' : ''}</div>`
            : rowsWrapped;

        marketAlertEl.innerHTML = `<div style="
            padding:6px 8px; border-radius:6px;
            background:rgba(0,255,255,0.03);
            border:1px solid rgba(0,255,255,0.2);
        ">${header}${body}</div>`;
    }

    /* ===================== HOT LANE (auto-bid réactif) ===================== */

    // Récupère UNE enchère par ID — endpoint dédié (rapide, single request)
    async function fetchSingleAuction(id) {
        const t0 = Date.now();
        const res = await fetch(`${MARKET_API_BASE}/${id}`, { credentials: "include" });
        syncServerClockFromResponse(res, t0); // recale l'horloge serveur (critique pour le snipe)
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        // Selon la forme de la réponse de l'API : { auction: {...} } ou {...} directement
        return data.auction || data;
    }

    // Rafraîchit à la demande le prix RÉEL d'une enchère (bouton ↻ de la vue déroulée). Le bot
    // ne poll pas toujours pile au bon instant → ça permet d'avoir le bon prix pour miser à la main.
    window.wmRefreshAuction = async function(id, btn) {
        if (!id) return;
        if (btn) btn.style.animation = 'wm-spin 0.7s linear infinite'; // ↻ tourne pendant le fetch
        try {
            const fresh = await fetchSingleAuction(id);
            if (fresh) {
                // Patch le cache d'affichage + activeHitsMap avec les données fraîches
                const cached = lastHitsCache.find(h => h && h.id === id);
                if (cached) {
                    if ('current_bid' in fresh)     cached.current_bid = fresh.current_bid;
                    if ('current_bidder' in fresh)  cached.current_bidder = fresh.current_bidder;
                    if ('base_amount' in fresh)     cached.base_amount = fresh.base_amount;
                    if (fresh.end_at)               cached.end_at = fresh.end_at;
                    // MàJ directe de la mise minimale (fiable même si un input est focus → pas de
                    // re-render dans ce cas ; sinon le re-render ci-dessous recrée tout proprement).
                    const inp = document.getElementById('wm-bidinput-' + id);
                    if (inp) { const mn = minNextBid(cached); inp.min = String(mn); inp.value = String(mn); }
                }
                const prev = activeHitsMap.get(id);
                if (fresh.end_at) activeHitsMap.set(id, { auction: { ...((prev && prev.auction) || {}), ...fresh }, endAt: fresh.end_at });
                const el = document.getElementById('wm-market-alert');
                if (el && lastHitsCache.length > 0) renderMarketHits(el, lastHitsCache, []);
            }
        } catch(e) {
            // échec silencieux : on ne casse pas l'affichage, l'utilisateur peut re-cliquer
        } finally {
            if (btn && btn.isConnected) btn.style.animation = '';
        }
    };

    // Calcule l'intervalle de polling en fonction de l'enchère trackée la plus urgente.
    // Retourne null si rien d'urgent à surveiller (le main scan suffit).
    function computeHotLaneInterval() {
        const tracked = new Set([...myBidsSet, ...autoBidSet, ...snipeSet]);
        if (tracked.size === 0) return null;

        let minMs = Infinity, minSnipeMs = Infinity;
        tracked.forEach(id => {
            const hit = activeHitsMap.get(id);
            if (!hit) return;
            const ms = new Date(hit.endAt).getTime() - Date.now();
            if (ms > 0 && ms < minMs) minMs = ms;
            if (snipeSet.has(id) && ms > 0 && ms < minSnipeMs) minSnipeMs = ms;
        });

        // Snipe imminent : polling très serré (~150ms) pour tirer pile au bon moment
        // quand une enchère "Fourbe" approche de sa fenêtre de ~10s.
        if (minSnipeMs < 20_000) return 150;

        // Aucune enchère trackée connue dans activeHitsMap → on poll quand même
        // toutes les 5s pour découvrir leur état initial.
        if (minMs === Infinity) return 5000;

        if (minMs < 5_000)       return 250;   // mort de l'enchère : 4 ticks/s
        if (minMs < 12_000)      return 500;   // snipe : 2 ticks/s
        if (minMs < 30_000)      return 1000;  // très chaud : 1s
        if (minMs < 90_000)      return 2000;  // chaud : 2s
        if (minMs < 5 * 60_000)  return 5000;  // tiède : 5s
        return null;                            // froid : main scan suffit
    }

    // Un tick : fetch en parallèle toutes les enchères trackées, détecte outbid, ripote.
    async function hotLaneTick() {
        const tracked = [...new Set([...myBidsSet, ...autoBidSet, ...snipeSet])];
        if (tracked.length === 0) return;

        // Ne pas fetch les enchères en cours de bid (lock)
        const toFetch = tracked.filter(id => !bidLockSet.has(id));
        if (toFetch.length === 0) return;

        hotLaneTickCount++;

        const results = await Promise.allSettled(
            toFetch.map(id => fetchSingleAuction(id))
        );

        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r.status !== 'fulfilled' || !r.value) continue;
            const a = r.value;
            if (!a.id) continue;

            // Si l'enchère n'existe plus côté API (terminée), on la nettoie
            // (la fin de l'enchère sera détaillée par le main scan via le pruning)
            const endTs = a.end_at ? new Date(a.end_at).getTime() : 0;
            if (endTs > 0) {
                activeHitsMap.set(a.id, { auction: a, endAt: a.end_at });
            }

            // 🕵️ MODE FOURBE (snipe) : ne mise QU'UNE fois, à ~10s de la fin.
            // On tire dès que le temps restant passe sous (snipe + ~1s de marge réseau),
            // pour que la mise ARRIVE encore au-dessus de 10s côté serveur (sinon le site
            // rallonge le timer d'1 min). Si je mène déjà, rien à faire. Si l'adversaire
            // re-surenchérit sous 10s, le timer se rallonge → nouvelle fenêtre → nouveau snipe.
            if (snipeSet.has(a.id) && endTs > 0 && !bidLockSet.has(a.id)) {
                const remaining = endTs - serverNow(); // temps restant côté SERVEUR (corrige l'horloge PC)
                const fireMs = (getSetting('snipeSecondsBefore') + 1) * 1000; // marge réseau ~1s
                // Le mode Fourbe est un choix EXPLICITE de l'utilisateur (bouton ou mot-clé) →
                // il n'est PAS soumis au plancher Hunter (minBalanceForAutoSnipe). Il faut juste
                // avoir de quoi miser (comme la riposte auto-bid : wikibidousBalance > 0).
                if (remaining <= fireMs && remaining > 1200
                    && !iAmLeading(a)
                    && wikibidousBalance > 0) {
                    const bidAmount = minNextBid(a);
                    if (autoBidWithinCap(a, bidAmount)) {
                        bidLockSet.add(a.id);
                        const titleSn = a.card?.wikipedia_title || '?';
                        const rarSn = (a.card?.rarity || '').toUpperCase();
                        try {
                            const res = await fetch(
                                `${MARKET_API_BASE}/${a.id}/bid`,
                                { method: "POST", credentials: "include",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ amount: bidAmount }) }
                            );
                            if (res.ok) {
                                markAuctionAsMine(a.id, bidAmount, a);
                                const secLeft = Math.round(remaining / 1000);
                                wmLog(`🕵️ Fourbe (snipe à ${secLeft}s) : <b>${titleSn}</b> [${rarSn}] → <span style="color:#fbbf24;">${bidAmount} 💰</span>`);
                                fetchBalance().catch(() => {});
                                sendToDiscord("🕵️ Snipe fourbe : **" + titleSn + "** → **" + bidAmount + " 💰**", 10181046, 'market');
                            } else {
                                const errData = await res.json().catch(() => ({}));
                                wmLog(`⚠️ Fourbe échoué : <b>${titleSn}</b> [${rarSn}] · ${errData?.error || 'erreur'}`);
                            }
                        } catch(e) {
                            wmLog(`⚠️ Fourbe exception : <b>${titleSn}</b> · ${e.message}`);
                        } finally {
                            bidLockSet.delete(a.id);
                        }
                        continue; // ce tick a servi au snipe pour cette enchère
                    }
                }
            }

            const bidder = a.current_bidder?.username || null;
            const wasLeading = leadingBidsMap.get(a.id);

            // Détection surenchère : on était meneur, qqn d'autre est passé devant.
            // Test robuste au pseudo (isSelf + montant de ma dernière mise) → n'interprète
            // plus MA propre mise comme une surenchère adverse (fini le prix qui s'auto-gonfle).
            if (isSelf(wasLeading) && bidder && !iAmLeading(a)) {
                markOutbid(a.id);
                const titleOb = a.card?.wikipedia_title || '?';
                const rarOb = (a.card?.rarity || '').toUpperCase();
                const bidOb = a.current_bid ?? a.base_amount;

                // Anti-doublon : on ne loggue/sonne/notifie qu'UNE fois par surenchère (id + montant).
                // Une nouvelle surenchère à un prix différent re-déclenchera bien un log.
                if (shouldLogOutbid(a.id, bidOb)) {
                    outbidLogMap.set(a.id, bidOb);
                    // Tente d'absorber un log de remboursement en attente (delta positif)
                    // pour fusionner les 2 events dans une seule ligne
                    const refund = absorbPendingBalanceLog();
                    const refundFragment = (refund && refund.deltaTotal > 0)
                        ? ` · <span style="color:#4ade80;font-weight:700;">+${refund.deltaTotal.toLocaleString('fr-FR')} 💰</span> (solde ${refund.newBalance.toLocaleString('fr-FR')} 💰)`
                        : '';
                    wmLog(`⚡ Hot-lane : surenchéri sur <b>${titleOb}</b> [${rarOb}] · <b>${bidder}</b> à <span style="color:#fbbf24;">${bidOb} 💰</span>${refundFragment}`);

                    // 🔴 Feedback visuel INSTANTANÉ : on patche le cache d'affichage avec les
                    // données fraîches de la hot lane et on re-render tout de suite (la ligne
                    // passe en rouge 😤 + nouveau prix), sans attendre le prochain scan complet.
                    const cachedHit = lastHitsCache.find(h => h && h.id === a.id);
                    if (cachedHit) {
                        cachedHit.current_bid = a.current_bid;
                        cachedHit.current_bidder = a.current_bidder;
                        if (a.end_at) cachedHit.end_at = a.end_at;
                    }
                    playSound('outbid');
                    if (window.wmNotify) window.wmNotify(1);
                    const _mel = document.getElementById('wm-market-alert');
                    if (_mel && lastHitsCache.length > 0) renderMarketHits(_mel, lastHitsCache, []);
                }

                // Riposte instantanée si auto-bid activé sur cette enchère ET sous le plafond.
                // ⚠️ NE PAS faire `continue` si le plafond est atteint : ça sauterait la MàJ de
                // leadingBidsMap plus bas → l'outbid serait re-détecté au tick suivant.
                if (autoBidSet.has(a.id) && wikibidousBalance > 0 && !bidLockSet.has(a.id)) {
                    const bidAmount = bidIncrement(bidOb);
                    if (autoBidWithinCap(a, bidAmount)) { // ne riposte que sous le plafond
                        bidLockSet.add(a.id);
                        try {
                            // ⚡ Pas de délai humanisé : fire instantané (c'est le but de la hot lane)
                            const res = await fetch(
                                `${MARKET_API_BASE}/${a.id}/bid`,
                                { method: "POST", credentials: "include",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ amount: bidAmount }) }
                            );
                            if (res.ok) {
                                markAuctionAsMine(a.id, bidAmount, a);
                                wmLog(`⚡ Hot-lane bid : <b>${titleOb}</b> [${rarOb}] → <span style="color:#fbbf24;">${bidAmount} 💰</span>`);
                                // Refresh balance en arrière-plan, sans bloquer le tick
                                fetchBalance().catch(() => {});
                                sendToDiscord(
                                    "⚡ Hot-lane bid : **" + titleOb + "** → **" + bidAmount + " 💰**",
                                    5763719,
                                    'market'
                                );
                            } else {
                                const errData = await res.json().catch(() => ({}));
                                wmLog(`⚠️ Hot-lane bid échoué : <b>${titleOb}</b> [${rarOb}] · ${errData?.error || 'erreur'}`);
                            }
                        } catch(e) {
                            wmLog(`⚠️ Hot-lane bid exception : <b>${titleOb}</b> · ${e.message}`);
                        } finally {
                            bidLockSet.delete(a.id);
                        }
                    }
                    // plafond atteint → autoBidWithinCap a déjà coupé l'auto-bid ; on tombe sur
                    // la MàJ du lead (pas de continue) pour ne PAS re-logguer au prochain tick.
                }
            }

            // Mémorise le lead courant (synchro avec main scan)
            if (iAmLeading(a)) {
                if (currentUsername) leadingBidsMap.set(a.id, currentUsername);
                clearOutbid(a.id);
            } else if (wasLeading !== undefined && bidder) {
                leadingBidsMap.set(a.id, bidder);
            }
        }
    }

    // Scheduler récursif (setTimeout adaptatif)
    function scheduleHotLane() {
        if (hotLaneTimeout) { clearTimeout(hotLaneTimeout); hotLaneTimeout = null; }
        if (!hotLaneActive) return;

        const interval = computeHotLaneInterval();
        // null → rien d'urgent, on retente dans 10s (au cas où une nouvelle enchère
        // suivie arrive entre-temps via le main scan)
        const nextMs = interval ?? 10000;
        lastHotLaneInterval = nextMs;

        hotLaneTimeout = setTimeout(async () => {
            try { await hotLaneTick(); }
            catch(e) { console.warn('[WikiMasters][hot-lane] tick error:', e); }
            scheduleHotLane();
        }, nextMs);
    }

    function startHotLane() {
        if (hotLaneActive) return;
        hotLaneActive = true;
        hotLaneTickCount = 0;
        wmLog('⚡ Hot-lane démarrée');
        scheduleHotLane();
    }

    function stopHotLane() {
        if (!hotLaneActive) return;
        hotLaneActive = false;
        if (hotLaneTimeout) { clearTimeout(hotLaneTimeout); hotLaneTimeout = null; }
        wmLog(`⏸️ Hot-lane stoppée (${hotLaneTickCount} ticks)`);
    }

    /* ===================== MARKET WATCHER LIFECYCLE ===================== */

    function startMarketWatcher(marketAlertEl, marketStatusEl) {
        sessionStorage.setItem('wm_watcher_active', '1');
        stopMarketWatcher();
        marketWatcherActive = true;
        lastMarketHits.clear();
        activeHitsMap.clear();
        clearAllOutbid();
        // Récupère l'utilisateur courant
        fetchCurrentUser();

        // 🚀 Démarre le scan IMMÉDIATEMENT — on n'attend PAS la collection (qui peut
        // prendre du temps sur les gros comptes) pour ne rater aucune enchère. Les infos
        // de possession (✔ ×N) se rempliront dès que la collection est chargée en parallèle.
        startCountdownTicker(marketAlertEl);
        runMarketScanLoop(marketAlertEl, marketStatusEl);
        // Hot lane : démarre peu après (elle ne fait rien tant qu'aucune enchère n'est suivie)
        setTimeout(() => { if (marketWatcherActive) startHotLane(); }, 1000);

        // 📚 Charge la collection EN PARALLÈLE. Progression affichée dans le compteur du
        // header (pas dans le statut du scan, qui reste dédié à l'avancement du watcher).
        const updateCollCount = (txt) => { const cc = document.getElementById('wm-coll-count'); if (cc) cc.innerText = txt; };
        fetchCollection((loaded, total, fromCache, newCards) => {
            if (fromCache) {
                updateCollCount(newCards != null ? `${loaded.toLocaleString('fr-FR')} (+${newCards})` : `${loaded.toLocaleString('fr-FR')} cartes`);
            } else if (total && total > 0) {
                const pct = Math.round((loaded / total) * 100);
                updateCollCount(`${loaded.toLocaleString('fr-FR')}/${total.toLocaleString('fr-FR')} (${pct}%)`);
            } else {
                updateCollCount(`${loaded.toLocaleString('fr-FR')} cartes`);
            }
        }).then(() => {
            updateCollCount(collectionMap.size.toLocaleString('fr-FR') + ' cartes');
            renderRarityHeader();
            // Re-render les hits maintenant que les badges de possession sont disponibles
            if (lastHitsCache.length > 0) {
                const el = document.getElementById('wm-market-alert');
                if (el) renderMarketHits(el, lastHitsCache, []);
            }
        });
    }

    let marketWatcherTimeout = null;
    let marketScanInProgress = false;

    async function runMarketScanLoop(marketAlertEl, marketStatusEl) {
        if (!marketWatcherActive || marketScanInProgress) return;
        marketScanInProgress = true;
        const startedAt = Date.now();
        try {
            await checkMarketplace(marketAlertEl, marketStatusEl);
        } catch (e) {
            wmLog(`⚠️ scan échoué : ${e.message || e}`);
        } finally {
            marketScanInProgress = false;
        }
        if (!marketWatcherActive) return;
        // Vise MARKET_REFRESH_MS entre deux DÉBUTS de scan ; si le scan a déjà
        // pris plus longtemps, on enchaîne après un minimum de souffle.
        const elapsed = Date.now() - startedAt;
        const wait = Math.max(MARKET_MIN_GAP_MS, MARKET_REFRESH_MS - elapsed);
        marketWatcherTimeout = setTimeout(() => runMarketScanLoop(marketAlertEl, marketStatusEl), wait);
    }

    function stopMarketWatcher(persist = true) {
        if (persist) {
            sessionStorage.removeItem('wm_watcher_active');
            sessionStorage.removeItem('wm_hits_cache');
        }
        if (marketWatcherInterval)   { clearInterval(marketWatcherInterval);   marketWatcherInterval = null; }
        if (marketWatcherTimeout)    { clearTimeout(marketWatcherTimeout);     marketWatcherTimeout = null; }
        if (marketCountdownInterval) { clearInterval(marketCountdownInterval); marketCountdownInterval = null; }
        stopHotLane();
        marketWatcherActive = false;
    }

    /* ===================== TRASH SELLER ===================== */

    let trashSellerRunning = false;
    let lastTrashCardIds = new Set(); // pour détecter les nouvelles cartes tagguées "Trash"

    // Cartes temporairement non-listables : le site renvoie 409 « déjà engagée dans un échange
    // en attente ». On les exclut du pool un moment (elles ne bloquent plus un slot) puis on les
    // réessaie après le cooldown — l'échange peut s'être dénoué entre-temps.
    const pendingTradeCards = new Map(); // cardId → timestamp d'expiration de l'exclusion
    const PENDING_TRADE_COOLDOWN_MS = 20 * 60 * 1000; // 20 min
    function markPendingTrade(cardId) {
        if (cardId) pendingTradeCards.set(cardId, Date.now() + PENDING_TRADE_COOLDOWN_MS);
    }
    function isPendingTrade(cardId) {
        const exp = pendingTradeCards.get(cardId);
        if (!exp) return false;
        if (Date.now() >= exp) { pendingTradeCards.delete(cardId); return false; } // cooldown fini
        return true;
    }
    function hasActivePendingTrades() {
        for (const exp of pendingTradeCards.values()) if (Date.now() < exp) return true;
        return false;
    }

    /* ══════════ POOL TRASH INCRÉMENTAL ══════════
       Signalé le 2026-08-19 : fetchTrashCards() re-scanne TOUTE la collection (jusqu'à ~2000
       pages sur un gros compte) à chaque appel, et scanPool() le rappelle après CHAQUE lot
       vendu → des milliers de requêtes /api/my-collection en boucle, qui semblent avoir
       saturé le serveur au point de faire échouer POST /api/marketplace (409 « vous ne
       possédez pas cette carte ») sur des cartes pourtant bien possédées (vérifié en base).
       Au lieu de re-scanner à chaque fois, on garde un pool en mémoire, mis à jour EN DIRECT
       par ce que le bot fait lui-même (vente → retrait, auto-tag après pack ou re-tag après
       annulation → ajout), et on ne relance un scan complet que périodiquement pour rattraper
       ce que le bot n'a pas vu passer (tag/détag manuel sur le site, cartes reçues par achat
       ou échange — volontairement pas suivi en direct, le bot pose déjà l'immense majorité
       des tags Trash lui-même). */
    const TRASH_POOL_RESCAN_INTERVAL_MS = 12 * 60 * 1000; // 12 min
    let trashPoolCache = [];
    let trashPoolCacheReady = false;
    let trashPoolCacheTs = 0;

    // Point d'entrée à utiliser à la place d'un appel direct à fetchTrashCards() dans les
    // boucles/actions répétées : ne re-scanne que si le pool n'a jamais été chargé ou a dépassé
    // l'intervalle de réconciliation.
    async function getTrashPool(onProgress) {
        const stale = !trashPoolCacheReady || (Date.now() - trashPoolCacheTs) > TRASH_POOL_RESCAN_INTERVAL_MS;
        if (stale) {
            trashPoolCache = await fetchTrashCards(onProgress);
            trashPoolCacheTs = Date.now();
            trashPoolCacheReady = true;
        }
        return trashPoolCache;
    }

    // Ajoute une carte fraîchement taguée Trash au pool en mémoire, sans attendre le prochain
    // scan complet. Ignoré tant qu'aucun scan initial n'a eu lieu (rien à mettre à jour).
    function pushToTrashPoolCache(cardId, title, rarity) {
        if (!trashPoolCacheReady || !cardId) return;
        trashPoolCache.push({
            card_id: cardId,
            card: { id: cardId, wikipedia_title: title || '?', rarity: (rarity || 'C').toUpperCase() },
            tags: [{ name: getSellTagName() }]
        });
    }

    // Retire UNE occurrence d'une carte du pool (une carte vendue) — par card_id, pas par
    // exemplaire précis (le pool ne connaît pas le user_card_id exact, comme sellBatch()).
    function removeFromTrashPoolCache(cardId) {
        if (!cardId) return;
        const idx = trashPoolCache.findIndex(c => (c.card_id || c.card?.id) === cardId);
        if (idx !== -1) trashPoolCache.splice(idx, 1);
    }

    async function fetchTrashCards(onProgress) {
        const limit = 50;
        let trashCards = [];

        const url = (p) => `https://www.wiki-masters.com/api/my-collection?page=${p}&limit=${limit}&sort=rarity&pending=1`;

        // Fetch une page avec retry automatique (3 tentatives, backoff linéaire)
        async function fetchPage(p) {
            for (let attempt = 0; attempt < 3; attempt++) {
                if (!trashSellerRunning) return null;
                try {
                    const res = await fetch(url(p), { credentials: "include" });
                    if (!res.ok) { await new Promise(r => setTimeout(r, 500 * (attempt + 1))); continue; }
                    const data = await res.json();
                    return data.collection || [];
                } catch(e) {
                    await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
                }
            }
            return null; // échec après 3 tentatives — distinct d'une page vide (length 0)
        }

        // Filet de sécurité : ne vendre que si le tag de vente est le SEUL tag de la carte.
        // Une carte "Trash" + un autre tag = probablement un tag Trash mis par erreur → on la garde.
        const sellTag = getSellTagName();
        const soleTagOnly = getSetting('sellOnlyIfSoleTag');
        let skippedMultiTag = 0;
        let skippedPendingTrade = 0;
        const filterTrash = (items) => items.filter(item => {
            const tags = item.tags || [];
            if (!tags.some(t => t.name === sellTag)) return false;
            if (soleTagOnly && tags.some(t => t.name !== sellTag)) { skippedMultiTag++; return false; }
            // Exclut les cartes engagées dans un échange en attente (409), le temps du cooldown.
            const cid = item.card_id || item.card?.id;
            if (isPendingTrade(cid)) { skippedPendingTrade++; return false; }
            return true;
        });

        // Page 0 d'abord pour récupérer le total (ou bascule en mode dynamique)
        const firstRes = await fetch(url(0), { credentials: "include" });
        const firstData = await firstRes.json();
        const firstItems = firstData.collection || [];
        const apiTotal = parseInt(firstData.total, 10);
        const totalIsKnown = Number.isFinite(apiTotal) && apiTotal >= firstItems.length && apiTotal > 0;
        const totalPages = totalIsKnown ? Math.ceil(apiTotal / limit) : null;

        trashCards = trashCards.concat(filterTrash(firstItems));
        if (onProgress) onProgress(1, totalPages || '?');

        // Si page 0 incomplète (< limit), c'était la seule page → on saute la boucle
        const onlyOnePage = (firstItems.length < limit) || (totalIsKnown && totalPages <= 1);
        if (!onlyOnePage) {
            // Pages restantes en parallèle, par lots. BATCH réduit + souffle entre lots
            // pour limiter les 504 sur les très grosses collections (qui, avec sort=rarity,
            // feraient sauter toujours la même tranche de rareté → C/PC sous-représentées).
            const BATCH = 8;
            const MAX_PAGES = 2000; // garde-fou
            const upperLimit = totalIsKnown ? totalPages : MAX_PAGES;
            let reachedEnd = false;
            const failedPageNums = [];
            for (let start = 1; start < upperLimit && !reachedEnd; start += BATCH) {
                if (!trashSellerRunning) break;
                const pages = [];
                for (let p = start; p < Math.min(start + BATCH, upperLimit); p++) pages.push(p);
                const results = await Promise.all(pages.map(fetchPage));
                results.forEach((items, idx) => {
                    // null = page échouée après retries : NE PAS l'interpréter comme la fin
                    // de la collection (sinon tout le reste du pool est ignoré). On la note
                    // pour une 2e passe ciblée.
                    if (items === null) { failedPageNums.push(pages[idx]); return; }
                    // Page courte = vraie fin, mais uniquement en mode dynamique (total
                    // inconnu). Quand le total est connu, on se fie à totalPages et on ne
                    // coupe jamais tôt — une page courte au milieu ne tronque plus rien.
                    if (!totalIsKnown && items.length < limit) reachedEnd = true;
                    trashCards = trashCards.concat(filterTrash(items));
                });
                if (onProgress) onProgress(start + pages.length, totalPages || '?');
                await new Promise(r => setTimeout(r, 120)); // souffle entre lots
            }
            // 2e passe : on RE-TENTE les pages échouées une à une. Crucial avec sort=rarity :
            // un échec non rattrapé prive le pool d'une tranche entière de rareté, ce qui
            // biaise la sélection équitable et fait grimper le compteur des cartes chargées.
            if (failedPageNums.length > 0 && trashSellerRunning && !reachedEnd) {
                wmLog(`🔁 Scan Trash : 2e tentative sur ${failedPageNums.length} page(s) échouée(s)…`);
                const stillFailed = [];
                for (const p of failedPageNums) {
                    if (!trashSellerRunning) break;
                    const items = await fetchPage(p);
                    if (items === null) { stillFailed.push(p); continue; }
                    trashCards = trashCards.concat(filterTrash(items));
                    await new Promise(r => setTimeout(r, 120));
                }
                if (stillFailed.length > 0) {
                    wmLog(`⚠️ Scan Trash incomplet : ${stillFailed.length} page(s) toujours injoignable(s) — pool partiel, certaines raretés (souvent C/PC) sous-représentées ce tour.`);
                }
            }
        }

        // Log : total + diff avec scan précédent
        const currentIds = new Set(trashCards.map(c => c.card_id || c.card?.id).filter(Boolean));
        const newlyTagged = trashCards.filter(c => {
            const id = c.card_id || c.card?.id;
            return id && !lastTrashCardIds.has(id);
        });
        // Répartition par rareté du pool Trash (diagnostic d'équité : permet de voir
        // si les C/PC sont réellement présentes dans le pool ou absentes/droppées).
        const rarityCount = {};
        trashCards.forEach(c => {
            const r = (c.card?.rarity || c.rarity || '?').toUpperCase();
            rarityCount[r] = (rarityCount[r] || 0) + 1;
        });
        const rarityStr = Object.entries(rarityCount).sort((a, b) => b[1] - a[1])
            .map(([r, n]) => `${r}:${n}`).join(' · ');
        wmLog(`🔍 Scan Trash : <b>${trashCards.length}</b> cartes tagguées (${newlyTagged.length > 0 ? `+${newlyTagged.length} depuis dernier scan` : 'inchangé'})${rarityStr ? ` — <span style="color:#888;">${rarityStr}</span>` : ''}`);
        if (skippedMultiTag > 0) {
            wmLog(`🛡️ Filet de sécurité : <b>${skippedMultiTag}</b> carte(s) « ${sellTag} » ignorée(s) (elles portent aussi un autre tag)`);
        }
        if (skippedPendingTrade > 0) {
            wmLog(`⏸️ <b>${skippedPendingTrade}</b> carte(s) exclue(s) temporairement (engagée(s) dans un échange en attente) — réessai après ${PENDING_TRADE_COOLDOWN_MS / 60000} min`);
        }
        // Log chaque nouvelle carte tagguée (max 10 pour éviter de spammer)
        newlyTagged.slice(0, 10).forEach(c => {
            const t = c.card?.wikipedia_title || c.wikipedia_title || '?';
            const r = (c.card?.rarity || 'C').toUpperCase();
            wmLog(`🏷️ Tag Trash : <b>${t}</b> [${r}]`);
        });
        if (newlyTagged.length > 10) {
            wmLog(`… et ${newlyTagged.length - 10} autres cartes nouvellement tagguées`);
        }
        lastTrashCardIds = currentIds;

        return trashCards;
    }

    /* ── Lecture des ventes en cours dans la réponse /mine ──
       Ni le nom du tableau ni la valeur de `status` ne sont garantis par une API non
       documentée qui a déjà bougé une fois (symptôme : le serveur refuse une mise en vente
       avec « limite de 10 atteinte » pendant que le bot en compte 0). On sonde donc les noms
       plausibles, on tolère plusieurs libellés de statut, et on loggue une fois ce qu'on a
       réellement reçu quand on ne trouve rien — seul moyen de diagnostiquer sans accès à l'API. */
    const MINE_SELLING_KEYS = ['selling', 'sales', 'listings', 'my_listings',
        'my_auctions', 'active_auctions', 'auctions'];
    // Listes de la réponse /mine qui ne sont PAS mes ventes en cours (achats, historique…).
    const MINE_NOT_SELLING_KEYS = new Set(['won', 'history', 'bidding', 'bids', 'lost',
        'purchases', 'watching', 'outbid']);
    const ACTIVE_STATUSES = new Set(['active', 'open', 'live', 'running', 'ongoing', 'in_progress']);
    function pickSellingArray(data) {
        // La charge utile est parfois enveloppée ({ data: {...} }) — on inspecte les deux.
        for (const root of [data, data && data.data]) {
            if (!root || typeof root !== 'object') continue;
            for (const k of MINE_SELLING_KEYS) {
                if (Array.isArray(root[k])) return { key: k, list: root[k] };
            }
        }
        // Repli : le premier tableau dont les entrées ressemblent à des enchères — en excluant
        // explicitement les listes qu'on sait être AUTRE CHOSE. `won` et `history` portent les
        // mêmes champs (end_at, base_amount) : sans cette exclusion, le repli pourrait compter
        // les achats comme des ventes et fausser le calcul de slots du Trash Seller.
        for (const root of [data, data && data.data]) {
            if (!root || typeof root !== 'object') continue;
            for (const [k, v] of Object.entries(root)) {
                if (MINE_NOT_SELLING_KEYS.has(k.toLowerCase())) continue;
                if (Array.isArray(v) && v.some(x => x && (x.end_at || x.ends_at || x.base_amount))) {
                    wmLog(`🔬 <b>/mine</b> : champ « selling » introuvable, ventes lues depuis « <b>${k}</b> » (${v.length} entrée(s)). Signale-le si le décompte est faux.`);
                    return { key: k + ' (déduit)', list: v };
                }
            }
        }
        return { key: null, list: [] };
    }
    // status absent → on ne filtre pas dessus (mieux vaut compter une vente de trop que
    // de toutes les perdre). Comparaison insensible à la casse.
    function isActiveSellingStatus(s) {
        if (s == null || s === '') return true;
        return ACTIVE_STATUSES.has(String(s).toLowerCase());
    }
    // Une vente est "active" pour le décompte de slots UNIQUEMENT si son enchère n'est pas
    // terminée. Le serveur laisse parfois status="active" sur une vente déjà finie le temps
    // du règlement (état "⏳") → sans ce filtre, elle gonfle le compte (ex. 6 en cours + 4 en
    // règlement = "10/10") et le Trash Seller croit être plein alors qu'il ne l'est pas.
    function activeSellingFrom(data) {
        const { key, list } = pickSellingArray(data);
        const now = Date.now();
        const kept = list.filter(a => {
            if (!isActiveSellingStatus(a && a.status)) return false;
            const end = new Date((a && (a.end_at || a.ends_at)) || NaN).getTime();
            return !(Number.isFinite(end) && end <= now);
        });
        logMineShapeOnce(data, key, list, kept);
        return kept;
    }

    /* ── État des ventes en cours ──
       Depuis août 2026 le site a réduit /mine à deux compteurs :
           { "sellingCount": 10, "maxConcurrentAuctions": 10 }
       — plus aucune liste (`selling`, `won`, `history` ont disparu). Le DÉCOMPTE reste donc
       disponible et fait autorité pour le calcul de slots ; seul le détail carte-par-carte
       manque. On sépare les deux : `count` pilote la logique, `list` l'affichage.
       La lecture des listes est conservée pour le jour où elles reviennent (ou si un compte
       les sert encore). */
    const firstFinite = (...vals) => vals.find(v => Number.isFinite(v));
    function mineSellingState(data) {
        if (!data) return null;
        const list = activeSellingFrom(data);
        const d2 = data.data || {};
        const count = firstFinite(data.sellingCount, data.selling_count, data.activeCount,
            d2.sellingCount, d2.selling_count);
        const max = firstFinite(data.maxConcurrentAuctions, data.max_concurrent_auctions,
            d2.maxConcurrentAuctions, d2.max_concurrent_auctions);
        return {
            list,
            // Le compteur serveur prime sur la longueur de liste : il est exact même quand
            // le détail n'est pas fourni.
            count: Number.isFinite(count) ? count : list.length,
            max: Number.isFinite(max) ? max : null,
            detailed: list.length > 0 || !Number.isFinite(count)
        };
    }
    // Plafond effectif = le plus contraignant entre le réglage local et celui du serveur.
    // Sans ça, régler « 15 ventes max » alors que le site en autorise 10 garantissait des 409.
    function effectiveMaxActive(serverMax) {
        const local = getSetting('maxActiveSales');
        return Number.isFinite(serverMax) && serverMax > 0 ? Math.min(local, serverMax) : local;
    }

    /* ── Reconstruction du détail des ventes actives ──
       /mine ne liste plus rien, mais le bot garde l'auctionId de CHAQUE vente qu'il a créée
       (sellHistory, status 'pending'). L'endpoint « enchère unique » /marketplace/{id}, lui,
       fonctionne toujours — la hot lane en dépend. On rejoue donc nos propres IDs pour
       reconstituer la liste avec son détail complet.
       Angle mort assumé : une vente créée à la main sur le site n'est pas dans sellHistory,
       elle manquera. Le COMPTEUR serveur reste la référence pour le nombre affiché.
       Coût : 1 requête par vente → throttlé à 2 min, et déclenché seulement quand le compteur
       annonce des ventes que /mine ne détaille pas. */
    let _rebuiltSales = [];
    let _rebuiltSalesAt = 0;
    async function rebuildActiveSalesFromHistory(expectedCount) {
        if (Date.now() - _rebuiltSalesAt < 120000) return _rebuiltSales;
        _rebuiltSalesAt = Date.now();
        const pending = sellHistory
            .filter(s => s.status === 'pending' && s.auctionId)
            .slice(-40).reverse(); // les plus récentes d'abord
        const out = [];
        const now = Date.now();
        for (const s of pending) {
            if (out.length >= expectedCount) break;
            try {
                const a = await fetchSingleAuction(s.auctionId);
                if (!a || !a.id) continue;
                if (a.status && !isActiveSellingStatus(a.status)) continue;
                const end = new Date(a.end_at || a.ends_at || NaN).getTime();
                if (Number.isFinite(end) && end <= now) continue; // terminée
                out.push(a);
            } catch(e) { /* enchère disparue ou endpoint en erreur → on passe */ }
            await new Promise(r => setTimeout(r, 200)); // on ne martèle pas le serveur
        }
        _rebuiltSales = out;
        return out;
    }

    // Diagnostic du schéma /mine. Re-tiré toutes les 3 min tant que l'anomalie dure (et non
    // une seule fois par chargement) : tiré une seule fois au démarrage, il défilait hors du
    // log avant qu'on pense à le lire. Le dernier rapport est aussi mémorisé pour être rejoué
    // à la demande via `wmDumpMine()`.
    let _mineShapeLoggedAt = 0;
    let _lastMineSnapshot = null;
    function logMineShapeOnce(data, key, list, kept, force) {
        if (!data) return;
        _lastMineSnapshot = { data, key, list: list || [], kept: kept || [] };
        if (!force && (kept || []).length > 0) return;
        // Schéma « compteurs seuls » désormais IDENTIFIÉ et géré : le décompte suffit à piloter
        // le Trash Seller, ce n'est plus une anomalie à signaler en boucle.
        if (!force && Number.isFinite(data.sellingCount)) return;
        if (!force && Date.now() - _mineShapeLoggedAt < 3 * 60 * 1000) return;
        _mineShapeLoggedAt = Date.now();
        const describe = (o) => Object.keys(o || {})
            .map(k => Array.isArray(o[k]) ? `${k}[${o[k].length}]` : k).join(', ') || '—';
        const statuses = [...new Set((list || []).map(a => a && a.status).filter(v => v != null))].join(', ') || '—';
        // Aperçu brut tronqué : c'est lui qui révèle la structure réelle quand aucun nom de
        // champ connu ne correspond (imbrication, enveloppe, pagination…).
        let raw = '';
        try { raw = JSON.stringify(data).slice(0, 500); } catch(e) { raw = '(non sérialisable)'; }
        wmLog(`🔬 <b>/mine</b> : 0 vente active retenue. Champs racine : <span style="color:#fbbf24;">${describe(data)}</span>`);
        wmLog(`🔬 Tableau retenu : <b>${key || 'AUCUN'}</b> (${(list || []).length} entrée(s)) · statuts vus : <b>${statuses}</b>`);
        if (list && list[0]) wmLog(`🔬 Champs d'une entrée : <span style="color:#888;">${describe(list[0])}</span>`);
        wmLog(`🔬 Aperçu brut : <span style="color:#888;font-family:'JetBrains Mono',monospace;font-size:9px;">${String(raw).replace(/</g, '&lt;')}</span>`);
    }

    // Rejoue le diagnostic à la demande, avec une requête fraîche. Utilisable depuis la console
    // du navigateur : wmDumpMine()
    window.wmDumpMine = async function() {
        const data = await fetchMine();
        if (!data) { wmLog(`🔬 <b>/mine</b> : requête échouée (hors ligne, 429 ou 5xx).`); return; }
        const { key, list } = pickSellingArray(data);
        logMineShapeOnce(data, key, list, [], true); // force = ignore le throttle
        return data; // consultable directement dans la console
    }

    // Retourne null (et NON un état vide) quand la requête échoue : « aucune vente active » et
    // « je n'ai pas pu savoir » sont deux choses différentes. Les confondre effaçait la liste au
    // moindre 429 ET faisait croire au Trash Seller que tous ses slots étaient libres.
    // NB : pas d'accesseur « liste seule » — depuis que /mine ne détaille plus les ventes, il
    // renverrait toujours [] et referait croire à 0 vente active. Tout passe par l'état complet.
    // Cache court du détail lu en base. `fetchSellingState` est appelée par plusieurs boucles
    // (rafraîchissement 30 s, Trash Seller, attente de slot 15 s) : sans ce cache, chacune
    // rouvrirait sa propre requête Supabase.
    let _detailCache = null;
    let _detailCacheAt = 0;
    const DETAIL_CACHE_MS = 10000;
    function invalidateSalesDetail() { _detailCacheAt = 0; }
    async function activeSalesDetail(expectedCount) {
        if (_detailCache && Date.now() - _detailCacheAt < DETAIL_CACHE_MS) return _detailCache;
        // Source primaire : la base. Filet : rejouer nos propres auctionId.
        const list = await fetchActiveSalesFromDb()
            || await rebuildActiveSalesFromHistory(expectedCount)
            || [];
        _detailCache = list;
        _detailCacheAt = Date.now();
        return list;
    }

    async function fetchSellingState() {
        const data = await fetchMine();
        if (!data) return null;
        const st = mineSellingState(data);
        // Le détail est complété ICI, dans l'accesseur, et non chez l'appelant : il y a sept
        // points d'appel, et n'en équiper qu'un faisait clignoter l'affichage — chaque tick du
        // Trash Seller réécrivait la liste avec le [] de /mine, effacé puis restauré 30 s plus
        // tard par le rafraîchissement périodique.
        if (st.list.length === 0 && st.count > 0) {
            st.list = await activeSalesDetail(st.count);
            st.detailed = st.list.length > 0;
        }
        return st;
    }

    // Annule une vente (DELETE). Ne fonctionne que tant qu'aucune mise n'a été placée.
    // Nettoie aussi sellHistory pour éviter que checkSellHistoryResults
    // déclenche un retag Trash sur cette carte (tu ne la veux plus dans Trash).
    async function cancelSale(auctionId, title, endAt) {
        if (!auctionId) return;
        const label = title || '?';
        // Capture le temps restant AVANT le DELETE (sinon end_at devient méaningless)
        const remainingStr = endAt ? formatCountdown(endAt) : null;
        try {
            const res = await fetch(`https://www.wiki-masters.com/api/marketplace/${auctionId}`, {
                method: 'DELETE',
                credentials: 'include'
            });
            if (res.ok) {
                const remainingFrag = (remainingStr && remainingStr !== '⏰ terminée')
                    ? ` · il restait <b style="color:#fbbf24;">${remainingStr}</b> d'enchère`
                    : '';
                wmLog(`🚫 Carte retirée manuellement de la vente : <b>${label}</b>${remainingFrag}`);
                invalidateSalesDetail(); // la vente annulée doit disparaître immédiatement
                // Purge l'entrée de sellHistory pour bloquer le retag auto
                const before = sellHistory.length;
                sellHistory = sellHistory.filter(s => s.auctionId !== auctionId);
                if (sellHistory.length !== before) {
                    saveSellHistory();
                    renderSellHistory();
                }
                // Refresh balance (au cas où il y aurait un remboursement) + ventes actives
                fetchBalance().catch(() => {});
                try {
                    const st = await fetchSellingState();
                    if (st) renderActiveSales(st.list, st);
                } catch(e) {}
            } else {
                const body = await res.text().catch(() => '');
                wmLog(`❌ Annulation impossible : <b>${label}</b> · HTTP ${res.status}${body ? ' · ' + body.slice(0, 80) : ''}`);
            }
        } catch(e) {
            wmLog(`❌ Annulation exception : <b>${label}</b> · ${e.message}`);
        }
    }
    window.wmCancelSale = cancelSale;

    function renderActiveSales(auctions, state) {
        // null/undefined = la récupération a échoué (429, 5xx, réseau). On GARDE l'affichage
        // précédent : annoncer « aucune vente active » sur un hoquet réseau faisait disparaître
        // des ventes bien réelles, et remettait la somme du header à zéro.
        if (!Array.isArray(auctions)) return;
        // Cache pour le calcul de la somme des ventes dans le header
        lastActiveSales = auctions;
        updateBidsSumDisplay();

        const el = document.getElementById('wm-active-sales');
        const lblCount = document.getElementById('wm-active-sales-count');
        if (!el) return;

        // Le compteur serveur prime : il reste juste même quand le détail n'est pas fourni.
        const count = state && Number.isFinite(state.count) ? state.count : auctions.length;
        const maxA = effectiveMaxActive(state && state.max);
        if (lblCount) lblCount.innerText = `${count}/${maxA}`;

        if (auctions.length === 0) {
            // Distinguer « rien en vente » de « le serveur en annonce N mais ne les détaille
            // plus » : sans ça, 10 ventes bien réelles s'affichaient « Aucune vente active ».
            el.innerHTML = count > 0
                ? `<div style="color:#fbbf24;font-size:10px;text-align:center;padding:6px 0;line-height:1.5;">
                     <b>${count} vente(s) active(s)</b><br>
                     <span style="color:#888;font-size:9px;font-style:italic;">Détail indisponible : le site ne le fournit plus, et aucune de ces ventes n'a été créée par le bot (il ne peut donc pas les retrouver).<br>Le décompte reste exact : le Trash Seller ne dépassera pas le plafond.</span>
                   </div>`
                : `<div style="color:#555;font-size:10px;text-align:center;padding:6px 0;font-style:italic;">Aucune vente active</div>`;
            return;
        }

        // Détail reconstitué mais incomplet (ventes créées à la main, hors sellHistory).
        const missing = Math.max(0, count - auctions.length);
        const partialNote = missing > 0
            ? `<div style="color:#888;font-size:9px;font-style:italic;text-align:center;padding:2px 0 4px;">+ ${missing} vente(s) non détaillée(s) (créée(s) hors du bot)</div>`
            : '';

        // Trie par fin la plus proche
        const sorted = [...auctions].sort((a, b) => new Date(a.end_at) - new Date(b.end_at));

        el.innerHTML = partialNote + sorted.map(a => {
            const title = a.card?.wikipedia_title || '?';
            const rarity = (a.card?.rarity || '').toUpperCase();
            const r = RARITY[rarity] || { color: '#888' };
            const rarHex = r.color;
            const bid = a.current_bid ?? a.base_amount ?? 0;
            const bidder = a.current_bidder?.username || null;
            const hasBid = bidder !== null;
            const marketUrl = `https://www.wiki-masters.com/marketplace/${a.id}`;
            // Échappe le titre pour l'attribut data-* (peut contenir guillemets, apostrophes…)
            const titleAttr = String(title).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
            // Badge compteur de remises en vente (nombre de fois invendue+retaguée)
            const cid = a.card?.id ?? a.card_id;
            const retagN = getRetagCount(cid);
            const retagBadge = retagN > 0
                ? `<span title="Mise en vente ${retagN} fois sans être vendue"
                    style="display:inline-flex;align-items:center;gap:2px;flex-shrink:0;
                    padding:1px 5px;border-radius:4px;font-size:9px;font-weight:700;
                    color:#fbbf24;background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.4);">
                    🔁 ${retagN}</span>`
                : '';
            return `<div style="
                margin-bottom:5px; padding:5px 7px; border-radius:5px;
                background:linear-gradient(90deg, ${rarHex}2E 0%, ${rarHex}0A 80%);
                border:1px solid ${rarHex}55;
                animation:fadeIn 0.3s ease;
            ">
                <div style="display:flex;align-items:center;gap:5px;margin-bottom:2px;">
                    <a href="${marketUrl}" target="wm-card-view" rel="noopener" style="color:#fff;font-size:11px;font-weight:700;flex:1;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;">${title}</a>
                    ${retagBadge}
                    ${badge(rarity)}
                    ${!hasBid ? `<button
                        data-auction-id="${a.id}"
                        data-title="${titleAttr}"
                        data-end-at="${a.end_at || ''}"
                        title="Annuler la vente (uniquement si aucune mise)"
                        onclick="if(window.wmCancelSale) window.wmCancelSale(this.dataset.auctionId, this.dataset.title, this.dataset.endAt);"
                        onmouseover="this.style.background='rgba(239,68,68,0.18)';this.style.borderColor='rgba(239,68,68,0.6)';"
                        onmouseout="this.style.background='none';this.style.borderColor='rgba(239,68,68,0.3)';"
                        style="background:none;border:1px solid rgba(239,68,68,0.3);color:#ef4444;font-size:10px;line-height:1;padding:1px 5px;border-radius:3px;cursor:pointer;flex-shrink:0;">✕</button>` : ''}
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;font-size:9px;gap:6px;">
                    <span style="color:${hasBid ? '#4ade80' : '#666'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1;" title="${hasBid ? bidder : 'aucune mise'}">
                        ${hasBid ? `👤 ${bidder}` : '— pas de mise'}
                    </span>
                    <span style="color:#fbbf24;font-weight:700;white-space:nowrap;">
                        ${hasBid ? `${bid} 💰` : `base ${bid} 💰`}
                    </span>
                    <span class="wm-sale-cd" data-end="${a.end_at}" style="color:${countdownColor(a.end_at)};font-family:'JetBrains Mono',monospace;white-space:nowrap;min-width:54px;text-align:right;">
                        ${formatCountdown(a.end_at)}
                    </span>
                </div>
            </div>`;
        }).join('');
    }

    // Prix de mise en vente d'une carte. Par défaut : valeur manuelle du tableau par rareté.
    // Si "prix marché" est activé ET qu'on a un historique de ventes (avg) : on applique
    // avg × (pourcentage réglé). Sinon (aucune vente connue) → repli sur le tableau.
    async function resolveSellBasePrice(rarity, cardId) {
        const manual = getSellPrice(rarity);
        let result;
        if (!getSetting('sellUseMarketPrice') || !cardId) {
            result = { price: manual, source: 'table' };
        } else {
            let entry = getCachedSales(cardId);
            if (!entry) entry = await fetchCardSales(cardId); // récupère l'historique si pas en cache
            if (entry && entry.count > 0 && Number.isFinite(entry.avg) && entry.avg > 0) {
                const pct = getSetting('sellMarketPricePct');
                let price = Math.max(1, Math.round(entry.avg * (pct / 100)));
                // Plancher : le prix marché ne descend jamais sous le prix du tableau par rareté.
                let floored = false;
                if (getSetting('sellMarketFloor') && price < manual) { price = manual; floored = true; }
                result = { price, source: 'market', avg: entry.avg, count: entry.count, pct, floored, floor: manual };
            } else {
                result = { price: manual, source: 'table' };
            }
        }
        // Prix dégressif : -15% par tranche de 10 remises en vente (invendus récurrents 🔁).
        // Volontairement APRÈS le plancher (le but est justement de brader ce qui ne part pas).
        // Plafonné à -75% et jamais sous 1 wkb.
        if (getSetting('sellDegressive') && cardId) {
            const retag = getRetagCount(cardId);
            const steps = Math.floor(retag / 10);
            if (steps > 0) {
                const discountPct = Math.min(75, steps * 15);
                const before = result.price;
                result.price = Math.max(1, Math.round(before * (1 - discountPct / 100)));
                result.degressive = { retag, discountPct, before };
            }
        }
        return result;
    }

    // Cherche la plus basse annonce ACTIVE (non terminée) d'une carte sur le marché.
    // Sert à l'undercut : se placer juste en dessous pour vendre plus vite. null si aucune.
    async function fetchLowestActiveListing(cardId) {
        if (!cardId) return null;
        try {
            const res = await fetch(`${MARKET_API_BASE}?card_id=${encodeURIComponent(cardId)}&limit=50`, { credentials: 'include' });
            if (!res.ok) return null;
            const data = await res.json();
            const now = Date.now();
            let min = Infinity, matched = 0;
            for (const a of (data.auctions || [])) {
                // ⚠️ NE PAS faire confiance au filtre ?card_id de l'API : elle peut renvoyer des
                // annonces d'AUTRES cartes → sinon on undercutait le minimum de tout le marché
                // (souvent 1 wkb) alors qu'aucune annonce de CETTE carte n'existe. On re-filtre ici.
                const aCardId = a.card?.id ?? a.card_id;
                if (aCardId !== cardId) continue;
                const end = new Date(a.end_at).getTime();
                if (Number.isFinite(end) && end <= now) continue; // terminée → ignorée
                const p = a.current_bid ?? a.base_amount;
                if (Number.isFinite(p)) { matched++; if (p < min) min = p; }
            }
            return (matched > 0 && Number.isFinite(min)) ? min : null;
        } catch(e) { return null; }
    }

    /* ══════════ MISE EN VENTE VIA L'INTERFACE (clic simulé) ══════════
       Signalé le 2026-08-19 : POST /api/marketplace échoue systématiquement pour le bot
       (« Vous ne possédez pas cette carte »), même reconstruit à l'identique (payload,
       en-têtes, cookies, fetch natif non patché) et sans aucune charge serveur concurrente —
       card_id et possession pourtant vérifiés en base. Un clic RÉEL sur le vrai bouton
       "Lancer l'enchère" du site fonctionne toujours ; un clic SIMULÉ (isTrusted:false,
       donc pas une question de geste utilisateur "de confiance") fonctionne AUSSI. La cause
       exacte reste inconnue côté serveur — mais puisque passer par l'UI du site marche de
       façon fiable, c'est ce chemin qui remplace le POST direct ci-dessous.
       Contrainte : nécessite d'être sur /collection (le bot ne peut pas cliquer une carte
       qui n'est pas affichée à l'écran). */
    const DURATION_BUTTON_LABELS = { 10: '10 min', 30: '30 min', 60: '1 h', 180: '3 h', 360: '6 h', 720: '12 h', 1440: '24 h' };
    let _lastUiListingAuctionId = null; // rempli par installPackInterceptor à la volée

    // Écrire .value directement sur un input contrôlé React ne déclenche pas son onChange
    // (React a surchargé le setter sur l'instance, pas sur le prototype) : il faut passer par
    // le setter natif du PROTOTYPE puis émettre un vrai événement 'input' pour que React le voie.
    function setReactInputValue(el, value) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function findLeafByExactText(text) {
        for (const el of document.querySelectorAll('*')) {
            if (el.children.length === 0 && el.textContent.trim() === text) return el;
        }
        return null;
    }
    function findButtonByText(text) {
        return [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text) || null;
    }

    // Sondage périodique de l'API directe : le contournement DOM est lent et dépend d'une
    // barre de recherche peu fiable côté site — si wiki-masters corrige un jour le bug serveur
    // (cause jamais identifiée, cf. commentaire de sellCardViaUI), on veut repasser sur l'API
    // automatiquement plutôt que de rester bloqué sur le contournement pour toujours.
    const API_SELL_RECHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 min
    let apiSellWorks = null;      // null = jamais sondé, true/false = dernier résultat connu
    let apiSellCheckedTs = 0;
    let _apiSellRestoredLogged = false;

    // Tentative "légère" : sert uniquement à sonder si l'API remarche, pas à gérer tous les cas
    // d'erreur comme l'ancienne version de sellBatch() — sur échec on bascule sur sellCardViaUI.
    async function trySellViaApi(cardId, price, duration) {
        try {
            const res = await fetch("https://www.wiki-masters.com/api/marketplace", {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ card_id: cardId, base_amount: price, duration_minutes: duration })
            });
            if (!res.ok) return { ok: false };
            const data = await res.json().catch(() => ({}));
            return { ok: true, auctionId: data.auction_id || null };
        } catch(e) {
            return { ok: false };
        }
    }

    // S'assure qu'on est sur /collection avant de continuer. Après une vente, le site navigue
    // vers /marketplace/{auction_id} — un état transitoire NORMAL provoqué par le bot lui-même,
    // pas une "mauvaise page" au sens d'une navigation manuelle de l'utilisateur ailleurs. On
    // retente donc le retour ici avant de conclure à un vrai blocage (réutilisé aussi en fin de
    // sellCardViaUI, juste après avoir cliqué "Lancer l'enchère").
    async function ensureOnCollectionPage() {
        if (location.pathname.startsWith('/collection')) return true;
        const backBtn = findButtonByText('Retour au marché');
        if (backBtn) {
            backBtn.click();
            for (let i = 0; i < 20; i++) {
                await new Promise(r => setTimeout(r, 150));
                if (location.pathname.startsWith('/collection')) return true;
            }
        }
        return location.pathname.startsWith('/collection');
    }

    async function sellCardViaUI(cardId, title, rarity, price, duration) {
        if (!(await ensureOnCollectionPage())) return { ok: false, reason: 'wrong_page' };

        const searchInput = document.querySelector('input[placeholder="Rechercher par titre ou catégorie..."]');
        if (!searchInput) return { ok: false, reason: 'no_search_input' };
        setReactInputValue(searchInput, title);

        // Le filtrage du site peut prendre plus d'une seconde (debounce + requête) : on sonde
        // plutôt qu'un délai fixe, jusqu'à trouver une tuile cliquable pour ce titre. Redemande
        // findLeafByExactText à chaque tour : un match "orphelin" trouvé trop tôt (avant que le
        // rendu ne se termine) disparaît une fois les vrais résultats affichés.
        let tile = null;
        for (let i = 0; i < 20 && !tile; i++) {
            await new Promise(r => setTimeout(r, 250));
            const titleEl = findLeafByExactText(title);
            if (!titleEl) continue;
            let candidate = titleEl;
            while (candidate && !candidate.classList.contains('cursor-pointer')) candidate = candidate.parentElement;
            if (candidate) tile = candidate;
        }
        if (!tile) return { ok: false, reason: 'card_not_found' };
        tile.click();
        await new Promise(r => setTimeout(r, 600));

        const sellBtn = findButtonByText('Mettre aux enchères');
        if (!sellBtn) return { ok: false, reason: 'no_sell_button' };
        sellBtn.click();
        await new Promise(r => setTimeout(r, 500));

        const priceInput = document.querySelector('input[aria-label="Mise de départ"]');
        if (priceInput) setReactInputValue(priceInput, String(Math.max(1, Math.round(price))));

        const durLabel = DURATION_BUTTON_LABELS[duration];
        const durBtn = durLabel && findButtonByText(durLabel);
        if (durBtn) durBtn.click(); // pas de retour en échec si absent : mieux vaut lister à la
                                     // durée par défaut du site que ne pas lister du tout
        await new Promise(r => setTimeout(r, 200));

        const launchBtn = findButtonByText("Lancer l'enchère");
        if (!launchBtn) return { ok: false, reason: 'no_launch_button' };
        _lastUiListingAuctionId = null;
        launchBtn.click();
        await new Promise(r => setTimeout(r, 900)); // laisse la requête + navigation vers la page de l'enchère se faire

        // Sur succès, le site NAVIGUE vers la page de l'enchère créée (le bouton et toute la
        // page collection disparaissent avec elle). Toujours présent → refusé côté site
        // (impossible de lire le message d'erreur exact depuis ce flux, contrairement au POST).
        if (document.body.contains(launchBtn)) return { ok: false, reason: 'modal_still_open' };

        // Revient sur /collection (sinon la carte suivante ne retrouverait plus la barre de
        // recherche). Pas bloquant si ça échoue : la prochaine sellCardViaUI() retentera via
        // ensureOnCollectionPage() avant de conclure à un vrai blocage.
        await ensureOnCollectionPage();

        const nextSearchInput = document.querySelector('input[placeholder="Rechercher par titre ou catégorie..."]');
        if (nextSearchInput) setReactInputValue(nextSearchInput, ''); // nettoie pour la prochaine carte

        return { ok: true, auctionId: _lastUiListingAuctionId };
    }

    async function sellBatch(cards, statusEl) {
        let sold = 0, skipped = 0, deferred = 0;
        let limitReached = false; // 409 « plafond serveur atteint » → inutile d'insister
        for (const item of cards) {
            if (limitReached) { skipped++; continue; }
            const rarity = (item.card_id ? (item.card?.rarity || "C") : "C").toUpperCase();
            const cardId = item.card_id || item.card?.id;
            const duration = getSellDuration(rarity);
            const title = item.card?.wikipedia_title || item.wikipedia_title || '?';
            if (!cardId) { skipped++; wmLog(`⚠️ Carte ignorée (ID manquant) : ${title}`); continue; }

            // Prix de base : marché (moyenne × %) si activé & historique dispo, sinon tableau
            const priceInfo = await resolveSellBasePrice(rarity, cardId);
            let price = priceInfo.price;

            // Undercut : si une annonce active existe déjà pour cette carte, se placer juste en
            // dessous de la plus basse (−1) pour vendre plus vite. Uniquement si ça BAISSE le prix.
            if (getSetting('sellUndercutMarket')) {
                const lowest = await fetchLowestActiveListing(cardId);
                if (lowest != null && (lowest - 1) < price) {
                    priceInfo.undercut = { from: price, market: lowest };
                    price = Math.max(1, lowest - 1);
                }
            }

            await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));

            // Mise en vente via sellCardViaUI (clic simulé, cf. commentaire au-dessus de sa
            // définition) : 2 essais suffisent, les échecs ici sont surtout transitoires
            // (élément pas encore rendu), pas des erreurs serveur à décoder comme avant.
            // Perte assumée par rapport à l'ancien POST direct : on ne peut plus distinguer
            // « échange en attente » / « plafond atteint » d'un échec générique (le site ne
            // renvoie plus de message JSON exploitable dans ce flux) — deferred/limitReached
            // restent donc à leur valeur neutre, gérés en amont par le comptage de slots.
            let success = false;
            let result = null;

            // Sonde l'API directe si elle n'a jamais échoué, ou si le dernier échec date de
            // plus de 15 min (le site a peut-être corrigé le bug entre-temps). Pas de sondage
            // à chaque carte tant qu'elle est confirmée cassée — inutile et ça ralentirait
            // le lot pour rien.
            const shouldProbeApi = apiSellWorks !== false || (Date.now() - apiSellCheckedTs) > API_SELL_RECHECK_INTERVAL_MS;
            if (shouldProbeApi) {
                const apiResult = await trySellViaApi(cardId, price, duration);
                apiSellWorks = apiResult.ok;
                apiSellCheckedTs = Date.now();
                if (apiResult.ok) {
                    success = true;
                    result = apiResult;
                    if (!_apiSellRestoredLogged) {
                        _apiSellRestoredLogged = true;
                        wmLog(`✅ <b>L'API de mise en vente fonctionne à nouveau</b> — retour au mode rapide (plus besoin de rester sur /collection).`);
                    }
                }
            }

            // API indisponible (ou pas encore re-sondée) → contournement DOM. 2 essais
            // suffisent, les échecs ici sont surtout transitoires (élément pas encore rendu).
            if (!success) {
                const MAX_ATTEMPTS = 2;
                let attempt = 1;
                while (attempt <= MAX_ATTEMPTS) {
                    result = await sellCardViaUI(cardId, title, rarity, price, duration);
                    if (result.ok) { success = true; break; }
                    if (result.reason === 'wrong_page' || attempt === MAX_ATTEMPTS) break;
                    wmLog(`⚠️ Mise en vente <b>${title}</b> échouée (${result.reason}), retry ${attempt}/${MAX_ATTEMPTS-1}…`);
                    await new Promise(r => setTimeout(r, 1500));
                    attempt++;
                }
            }

            if (success) {
                sold++;
                incrementListedCount(cardId); // couverture équitable du pool Trash
                removeFromTrashPoolCache(cardId); // vendue → sort du pool incrémental
                recordSale(item, price, 'pending', result.auctionId || null);
                invalidateSalesDetail(); // la nouvelle vente doit apparaître sans attendre le cache
                const rN = getRetagCount(cardId);
                const retagTag = rN > 0 ? ` · <span style="color:#fbbf24;">🔁${rN}</span>` : '';
                const priceSrc = priceInfo.source === 'market'
                    ? (priceInfo.floored
                        ? ` <span style="color:#fbbf24;font-size:9px;">(🛡️ plancher tableau ${priceInfo.floor} 💰 · moy. marché ${priceInfo.avg} 💰)</span>`
                        : ` <span style="color:#4ade80;font-size:9px;">(💹 ${priceInfo.pct}% de la moy. ${priceInfo.avg} 💰)</span>`)
                    : '';
                const degrTag = priceInfo.degressive
                    ? ` <span style="color:#f97316;font-size:9px;">(📉 -${priceInfo.degressive.discountPct}% invendus 🔁${priceInfo.degressive.retag} · avant ${priceInfo.degressive.before} 💰)</span>`
                    : '';
                const underTag = priceInfo.undercut
                    ? ` <span style="color:#22d3ee;font-size:9px;">(🃏 undercut : marché ${priceInfo.undercut.market} 💰)</span>`
                    : '';
                wmLog(`🏷️ Mis en vente : <b>${title}</b> [${rarity}] · base ${price} 💰${priceSrc}${degrTag}${underTag}${retagTag}`);
            } else if (result && result.reason === 'wrong_page') {
                skipped++;
                wmLog(`⚠️ <b>Trash Seller en pause</b> — reste sur <code>/collection</code> pour que la mise en vente automatique fonctionne (elle simule un clic sur tes cartes).`);
                break; // toutes les cartes suivantes échoueraient pour la même raison
            } else {
                skipped++;
                wmLog(`❌ Échec mise en vente : <b>${title}</b> [${rarity}] · <span style="color:#888;font-size:9px;">${result ? result.reason : '?'}</span>`);
            }
        }
        return { sold, skipped, deferred, limitReached };
    }

    /* ══════════ TEST : ciblage d'exemplaire précis à la mise en vente ══════════
       Hypothèse à vérifier : POST /api/marketplace ne reçoit que `card_id` (le MODÈLE de
       carte), jamais l'exemplaire précis (`user_card_id`) — alors que le pool Trash le connaît
       (item.id). Si le site choisit alors lui-même quel exemplaire physique consommer, et que
       ce choix ignore les tags (toujours le plus ancien, d'après le retour utilisateur), un
       doublon taggué Trash plus récent qu'un doublon non-taggué peut voir SON AÎNÉ vendu à sa
       place — la carte qu'on voulait garder part, celle qu'on voulait vendre reste.
       Ce test : trouve un cas réel (1 exemplaire taggué + 1 plus ancien non-taggué du même
       card_id), tente la mise en vente en ajoutant `user_card_id` (nom déjà utilisé PARTOUT
       ailleurs dans ce schéma pour désigner un exemplaire précis) au corps de la requête, puis
       vérifie EN BASE lequel des deux a réellement disparu de la collection.
       Détection agnostique du mécanisme exact (suppression, transfert de propriété…) : on
       compare l'ensemble des IDs possédés avant/après, sans supposer COMMENT la consommation
       se traduit en base.
       Isolé à dessein du Trash Seller réel : un seul essai contrôlé, jamais dans la boucle
       automatique tant que le résultat n'est pas confirmé. Coût réel : UNE enchère créée
       (annulée automatiquement si le mauvais exemplaire a été consommé — aucune mise n'a pu
       être placée en quelques secondes). Console : wmTestInstanceTargeting() */
    window.wmTestInstanceTargeting = async function() {
        const uid = currentUserId();
        if (!uid) { wmLog(`🧪 Test ciblage : aucun id utilisateur (JWT absent — connecté au site ?)`); return; }
        if (!TRASH_TAG_ID) { wmLog(`🧪 Test ciblage : tag Trash pas encore découvert, lance d'abord un scan (Trash Seller ou ▶ START).`); return; }

        wmLog(`🧪 Test ciblage d'exemplaire — recherche d'un doublon (1 taggué Trash + 1 plus ancien non-taggué)…`);

        // 1) Candidats : exemplaires actuellement taggués Trash, avec leur card_id et date.
        const tagged = await supabaseSelect(
            `user_card_tags?tag_id=eq.${TRASH_TAG_ID}&select=user_card_id,user_cards(id,card_id,created_at)&limit=300`);
        if (!Array.isArray(tagged)) { wmLog(`🧪 Test ciblage : lecture des tags Trash impossible (réseau/permissions).`); return; }

        let candidate = null; // { cardId, taggedId, taggedCreated, oldId, oldCreated, title }
        // Une requête Supabase par candidat testé : borné pour ne pas déclencher un rate-limit
        // sur un compte qui aurait des centaines de cartes taguées Trash.
        const CANDIDATE_CAP = 60;
        let tried = 0;
        for (const t of tagged) {
            if (tried >= CANDIDATE_CAP) {
                wmLog(`🧪 Limite de ${CANDIDATE_CAP} candidat(s) testés atteinte sans résultat, arrêt de la recherche.`);
                break;
            }
            const uc = t.user_cards;
            if (!uc || !uc.card_id) continue;
            tried++;
            if (tried % 20 === 0) wmLog(`🧪 … ${tried} candidat(s) vérifié(s), toujours en recherche.`);
            // 2) Pour ce card_id, tous MES exemplaires + leurs tags.
            const siblings = await supabaseSelect(
                `user_cards?card_id=eq.${uc.card_id}&user_id=eq.${uid}&select=id,created_at,user_card_tags(tag_id)`);
            await new Promise(r => setTimeout(r, 120)); // on ne martèle pas le serveur
            if (!Array.isArray(siblings) || siblings.length < 2) continue;
            const older = siblings
                .filter(s => s.id !== uc.id && !(s.user_card_tags || []).some(x => x.tag_id === TRASH_TAG_ID)
                    && new Date(s.created_at).getTime() < new Date(uc.created_at).getTime())
                .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];
            if (older) {
                const cardRow = await supabaseSelect(`cards?id=eq.${uc.card_id}&select=wikipedia_title,rarity&limit=1`);
                candidate = {
                    cardId: uc.card_id, taggedId: uc.id, taggedCreated: uc.created_at,
                    oldId: older.id, oldCreated: older.created_at,
                    title: (Array.isArray(cardRow) && cardRow[0]?.wikipedia_title) || '?',
                    rarity: (Array.isArray(cardRow) && cardRow[0]?.rarity) || 'C'
                };
                break;
            }
        }
        if (!candidate) {
            wmLog(`🧪 Test ciblage : aucun cas trouvé (il faut un exemplaire taggué Trash avec un doublon plus ancien non-taggué du même card_id). Rien tenté, aucun risque.`);
            return;
        }
        wmLog(`🧪 Cas trouvé : <b>${candidate.title}</b> — exemplaire taggué ${candidate.taggedId.slice(0,8)}… (${candidate.taggedCreated}) vs plus ancien ${candidate.oldId.slice(0,8)}… (${candidate.oldCreated}).`);

        // 3) Snapshot AVANT : mes exemplaires de ce card_id encore possédés.
        const before = await supabaseSelect(`user_cards?card_id=eq.${candidate.cardId}&user_id=eq.${uid}&select=id`);
        if (!Array.isArray(before)) { wmLog(`🧪 Test ciblage : snapshot « avant » impossible, abandon (aucune vente tentée).`); return; }
        const beforeIds = new Set(before.map(r => r.id));

        // 4) Mise en vente réelle, EN AJOUTANT user_card_id — seule différence avec sellBatch().
        const priceInfo = await resolveSellBasePrice(candidate.rarity.toUpperCase(), candidate.cardId);
        const duration = getSellDuration(candidate.rarity.toUpperCase());
        let auctionId = null;
        try {
            const res = await fetch("https://www.wiki-masters.com/api/marketplace", {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    card_id: candidate.cardId, base_amount: priceInfo.price, duration_minutes: duration,
                    user_card_id: candidate.taggedId // ← le paramètre à l'essai
                })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                wmLog(`🧪 Test ciblage : mise en vente refusée · HTTP ${res.status} ${data?.error || ''}. Le paramètre supplémentaire fait peut-être planter la requête (schéma strict) — à noter. Aucune vente créée.`);
                return;
            }
            auctionId = data.auction_id || null;
            wmLog(`🧪 Vente créée${auctionId ? ' (' + auctionId.slice(0,8) + '…)' : ''} — vérification en base dans 3s…`);
        } catch(e) {
            wmLog(`🧪 Test ciblage : exception réseau à la mise en vente — ${e.message}. Aucune vente créée.`);
            return;
        }

        // 5) Snapshot APRÈS. Petit délai pour laisser la transaction serveur se propager.
        await new Promise(r => setTimeout(r, 3000));
        const after = await supabaseSelect(`user_cards?card_id=eq.${candidate.cardId}&user_id=eq.${uid}&select=id`);
        if (!Array.isArray(after)) {
            wmLog(`🧪 Test ciblage : snapshot « après » impossible. La vente ${auctionId ? auctionId.slice(0,8) + '… ' : ''}est créée mais le résultat du test est INDÉTERMINÉ — vérifie ta collection manuellement.`);
            return;
        }
        const afterIds = new Set(after.map(r => r.id));
        const consumed = [...beforeIds].filter(id => !afterIds.has(id));

        if (consumed.length !== 1) {
            wmLog(`🧪 Test ciblage : résultat ambigu (${consumed.length} exemplaire(s) disparu(s) au lieu d'1). Vérifie manuellement — vente ${auctionId ? auctionId.slice(0,8) + '…' : '?'} non annulée par précaution.`);
            return;
        }
        const gotTagged = consumed[0] === candidate.taggedId;
        if (gotTagged) {
            wmLog(`🧪 <b style="color:#4ade80;">RÉSULTAT : ÇA MARCHE.</b> L'exemplaire taggué Trash a bien été mis en vente — le paramètre <code>user_card_id</code> est respecté par le site. Vente laissée en place (c'était le bon exemplaire).`);
        } else {
            wmLog(`🧪 <b style="color:#ef4444;">RÉSULTAT : ÇA NE MARCHE PAS.</b> Le site a quand même consommé le doublon plus ancien (non-taggué) — le paramètre est ignoré. Annulation immédiate de la vente pour te rendre ta carte…`);
            if (auctionId) {
                await cancelSale(auctionId, candidate.title, null);
                wmLog(`🧪 Vente annulée : <b>${candidate.title}</b> restituée (si aucune mise n'a été placée entre-temps — vérifie le log d'annulation ci-dessus).`);
            } else {
                wmLog(`🧪 Impossible d'annuler automatiquement (id d'enchère non reçu à la création) — vérifie et annule manuellement sur le site si besoin.`);
            }
        }
    };

    /* ══════════ DIAGNOSTIC : card_id périmé (pool Trash vs API mise en vente) ══════════
       Signalé le 2026-08-19 : POST /api/marketplace rejette (« Vous ne possédez pas cette
       carte ») un card_id lu depuis le pool Trash (/api/my-collection), alors que la mise en
       vente MANUELLE de la même carte réussit avec un card_id DIFFÉRENT. Compare, pour un
       titre donné : le card_id actuel du catalogue (cards) contre la possession réelle
       (user_cards) — et, si on connaît déjà l'ancien id périmé (vu dans un échec), vérifie
       s'il existe encore et si un exemplaire à toi y est encore rattaché.
       Console : wmDebugCardId("Néron") ou wmDebugCardId("Néron", "31bc83b2-f2dd-454b-bc0a-c8ca6f740ec8") */
    // Variante de supabaseSelect qui NE PERD PAS l'erreur : celui-ci renvoie juste `null` sur
    // tout échec (pratique partout ailleurs, mais inutilisable pour un outil de diagnostic).
    async function supabaseSelectDebug(path) {
        const { token } = getSupabaseAccessToken();
        if (!token) return { ok: false, status: 0, body: '(pas de JWT — connecté au site ?)' };
        try {
            const res = await fetchWithTimeout(`${SUPABASE_URL}/${path}`, {
                credentials: 'omit',
                headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
            });
            const bodyText = await res.text();
            let data = null;
            try { data = JSON.parse(bodyText); } catch(e) {}
            return { ok: res.ok, status: res.status, body: bodyText, data };
        } catch(e) {
            return { ok: false, status: 0, body: `exception réseau : ${e.message}` };
        }
    }

    window.wmDebugCardId = async function(title, staleCardId) {
        if (!title) { wmLog(`🧪 Usage : wmDebugCardId("Titre exact de la carte"[, "ancien card_id à vérifier"])`); return; }
        const uid = currentUserId();
        if (!uid) { wmLog(`🧪 Debug card_id : aucun id utilisateur (JWT absent — connecté au site ?)`); return; }

        const r1 = await supabaseSelectDebug(`cards?wikipedia_title=eq.${encodeURIComponent(title)}&select=id,wikipedia_title,rarity`);
        if (!r1.ok) { wmLog(`🧪 Catalogue (cards) : <b style="color:#ef4444;">HTTP ${r1.status}</b> — ${r1.body}`); return; }
        const cardRows = r1.data;
        if (!Array.isArray(cardRows) || cardRows.length === 0) {
            wmLog(`🧪 Catalogue (cards) : aucune ligne pour "${title}" — vérifie l'orthographe exacte (accents, ponctuation).`);
            return;
        }
        wmLog(`🧪 Catalogue (cards) pour "${title}" : <b>${cardRows.length}</b> ligne(s) → ${cardRows.map(c => `${c.id} [${c.rarity}]`).join(' · ')}`);

        for (const c of cardRows) {
            const r2 = await supabaseSelectDebug(`user_cards?card_id=eq.${c.id}&user_id=eq.${uid}&select=id`);
            if (!r2.ok) { wmLog(`🧪 user_cards pour card_id actuel <b>${c.id}</b> [${c.rarity}] : <b style="color:#ef4444;">HTTP ${r2.status}</b> — ${r2.body}`); continue; }
            wmLog(`🧪 user_cards pour card_id actuel <b>${c.id}</b> [${c.rarity}] : <b>${Array.isArray(r2.data) ? r2.data.length : '?'}</b> exemplaire(s) à toi`);
        }

        if (staleCardId) {
            const r3 = await supabaseSelectDebug(`cards?id=eq.${staleCardId}&select=id,wikipedia_title,rarity`);
            if (!r3.ok) {
                wmLog(`🧪 Ancien card_id <b>${staleCardId}</b> : <b style="color:#ef4444;">HTTP ${r3.status}</b> — ${r3.body}`);
            } else if (Array.isArray(r3.data) && r3.data.length > 0) {
                wmLog(`🧪 Ancien card_id <b>${staleCardId}</b> : existe encore dans cards → "${r3.data[0].wikipedia_title}" [${r3.data[0].rarity}]`);
            } else {
                wmLog(`🧪 Ancien card_id <b>${staleCardId}</b> : <b style="color:#ef4444;">n'existe plus</b> dans la table cards (ligne supprimée/remplacée).`);
            }
            const r4 = await supabaseSelectDebug(`user_cards?card_id=eq.${staleCardId}&user_id=eq.${uid}&select=id`);
            if (!r4.ok) { wmLog(`🧪 user_cards pour l'ancien card_id : <b style="color:#ef4444;">HTTP ${r4.status}</b> — ${r4.body}`); return; }
            const staleMine = r4.data;
            wmLog(`🧪 user_cards pour l'ancien card_id : <b>${Array.isArray(staleMine) ? staleMine.length : '?'}</b> exemplaire(s) à toi encore rattaché(s) à cet id périmé.`);
        }
    };

    // Console : wmCardTitle("dcb86746-9bdd-429a-b1c0-757153f4cb74") → retrouve le titre/la
    // rareté d'un card_id vu dans une requête réseau, sans avoir à fouiller le pool Trash.
    window.wmCardTitle = async function(cardId) {
        if (!cardId) { wmLog(`🧪 Usage : wmCardTitle("card_id")`); return; }
        const r = await supabaseSelectDebug(`cards?id=eq.${cardId}&select=wikipedia_title,rarity`);
        if (!r.ok) { wmLog(`🧪 wmCardTitle : <b style="color:#ef4444;">HTTP ${r.status}</b> — ${r.body}`); return; }
        if (Array.isArray(r.data) && r.data.length > 0) {
            wmLog(`🧪 ${cardId} → <b>${r.data[0].wikipedia_title}</b> [${r.data[0].rarity}]`);
        } else {
            wmLog(`🧪 ${cardId} → aucune ligne dans cards (id inexistant/supprimé).`);
        }
    };

    /* ══════════ DIAGNOSTIC : POST /api/marketplace précédé d'un GET « summary » ══════════
       Signalé le 2026-08-19 : POST /api/marketplace rejette systématiquement (« Vous ne
       possédez pas cette carte ») les tentatives émises par le bot OU par une requête console
       identique, alors que le clic sur le vrai bouton « Vendre » du site réussit avec un
       payload et des en-têtes identiques. Repéré dans le Network tab juste avant un succès
       manuel : un GET cards?select=summary&id=eq.<card_id> (absent de tout le code du bot —
       donc natif au site) juste avant le POST. Hypothèse : ce GET « prépare » quelque chose
       côté serveur (cache, session) que le POST exige ensuite. Ce test rejoue les deux à la
       suite pour vérifier si ça change le résultat. Console : wmTestSellWithPrecursor(cardId) */
    window.wmTestSellWithPrecursor = async function(cardId, price, duration) {
        if (!cardId) { wmLog(`🧪 Usage : wmTestSellWithPrecursor("card_id"[, prix, durée_minutes])`); return; }
        price = price || 50; duration = duration || 60;

        const r1 = await supabaseSelectDebug(`cards?select=summary&id=eq.${cardId}`);
        wmLog(`🧪 GET summary : ${r1.ok ? `<b style="color:#4ade80;">OK</b>` : `<b style="color:#ef4444;">HTTP ${r1.status}</b>`} — ${r1.body.slice(0, 200)}`);

        await new Promise(r => setTimeout(r, 300)); // laisse le temps à un éventuel traitement serveur

        try {
            const res = await fetch("https://www.wiki-masters.com/api/marketplace", {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ card_id: cardId, base_amount: price, duration_minutes: duration })
            });
            const body = await res.text();
            wmLog(`🧪 POST marketplace après précurseur : ${res.ok ? `<b style="color:#4ade80;">${res.status} — ${body}</b>` : `<b style="color:#ef4444;">${res.status} — ${body}</b>`}`);
        } catch(e) {
            wmLog(`🧪 POST marketplace : exception — ${e.message}`);
        }
    };

    // Plafond de cartes dont on récupère le prix marché réel pour la stratégie « value ».
    // On ne peut pas fetcher tout le pool (trop de requêtes) → on pré-classe par rareté et
    // on ne va chercher le vrai prix que du haut du pool (les candidats les plus probables).
    const VALUE_PREFETCH_CAP = 50;

    // Sélectionne les cartes à mettre en vente parmi le pool Trash, selon la stratégie
    // choisie (Paramètres). Toujours mélangé d'abord (Fisher-Yates) pour l'aléatoire et
    // les ex æquo, puis trié. Retourne les `slots` premières. Async : la stratégie
    // « value » récupère les prix marché manquants avant de trier.
    async function selectTrashBatch(trashCards, slots) {
        const shuffled = [...trashCards];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        const strategy = getSetting('trashSellStrategy');
        const cardIdOf = (c) => c.card_id || c.card?.id;
        const rarityOf = (c) => (c.card?.rarity || c.rarity || 'C').toUpperCase();
        const valueOf = (c) => {
            const e = getCachedSales(cardIdOf(c));
            if (e && e.count > 0 && Number.isFinite(e.avg)) return e.avg;
            return getSellPrice(rarityOf(c)); // proxy : prix par rareté si pas d'historique
        };
        if (strategy === 'value') {
            // 1) Pré-classe par rareté (proxy de valeur) pour cibler les candidats à fetcher.
            //    Le plafond suit le nb de ventes simultanées (maxActiveSales) et NON `slots`,
            //    car scanPool passe slots = pool entier (on ne listera qu'un plafond par cycle).
            const maxActive = Math.max(1, Number(getSetting('maxActiveSales')) || 1);
            const cap = Math.min(shuffled.length, Math.max(maxActive * 3, VALUE_PREFETCH_CAP));
            const ranked = [...shuffled].sort((a, b) =>
                (RARITY_ORDER[rarityOf(b)] ?? -1) - (RARITY_ORDER[rarityOf(a)] ?? -1));
            // 2) Récupère le prix marché réel de ceux qui manquent au cache (concurrence bornée).
            const toFetch = ranked.slice(0, cap)
                .filter(c => { const id = cardIdOf(c); return id && !getCachedSales(id); });
            if (toFetch.length > 0) {
                wmLog(`💹 Stratégie « plus chères » : récupération du prix marché de ${toFetch.length} carte(s)…`);
                const CONC = 4;
                for (let i = 0; i < toFetch.length; i += CONC) {
                    const grp = toFetch.slice(i, i + CONC);
                    await Promise.all(grp.map(c => fetchCardSales(cardIdOf(c)).catch(() => null)));
                    if (i + CONC < toFetch.length) await new Promise(r => setTimeout(r, 200 + Math.random() * 200));
                }
            }
            // 3) Trie tout le pool par valeur réelle (avg marché, sinon prix de tableau).
            shuffled.sort((a, b) => valueOf(b) - valueOf(a));
        } else if (strategy === 'rarity') {
            shuffled.sort((a, b) => (RARITY_ORDER[rarityOf(b)] ?? -1) - (RARITY_ORDER[rarityOf(a)] ?? -1));
        } else if (strategy === 'coverage') {
            shuffled.sort((a, b) => getListedCount(cardIdOf(a)) - getListedCount(cardIdOf(b)));
        }
        // strategy === 'random' → mélange conservé
        return shuffled.slice(0, Math.max(0, slots));
    }

    // Annule une vente SANS mise dans le cadre d'un "Refresh ventes" : DELETE l'enchère,
    // purge sellHistory, et REMET le tag Trash sur la carte (sinon elle reviendrait sans
    // tag et sortirait du pool). Retourne true si l'annulation a réussi.
    async function cancelSaleForRefresh(a) {
        try {
            const res = await fetch(`https://www.wiki-masters.com/api/marketplace/${a.id}`, {
                method: 'DELETE', credentials: 'include'
            });
            if (!res.ok) {
                wmLog(`❌ Annulation (refresh) échouée : <b>${a.card?.wikipedia_title || '?'}</b> · HTTP ${res.status}`);
                return false;
            }
            // Retire l'entrée sellHistory correspondante (n'est plus en vente)
            const before = sellHistory.length;
            sellHistory = sellHistory.filter(s => s.auctionId !== a.id);
            if (sellHistory.length !== before) saveSellHistory();
            invalidateSalesDetail();
            // Remet la carte dans le pool Trash (elle revient sans tag après un DELETE)
            const cardId = a.card?.id ?? a.card_id;
            if (cardId && getSetting('autoRetagEnabled')) {
                const targetId = await findCurrentUserCardId(cardId, a.card?.wikipedia_title);
                if (targetId && await reapplyTrashTag(targetId)) {
                    // Ajout direct au pool incrémental (re-tag réussi), sans attendre un rescan
                    pushToTrashPoolCache(cardId, a.card?.wikipedia_title, a.snapshot_rarity || a.card?.rarity);
                }
            }
            return true;
        } catch(e) {
            wmLog(`❌ Annulation (refresh) exception : <b>${a.card?.wikipedia_title || '?'}</b> · ${e.message}`);
            return false;
        }
    }

    // "Refresh ventes" : annule les ventes sans mise (les seules annulables), remet leur tag,
    // puis re-liste jusqu'à maxActiveSales cartes selon la stratégie choisie. Les ventes AVEC
    // mise sont conservées (une enchère en cours ne peut pas être retirée).
    let refreshSalesRunning = false;
    async function refreshSales(btn, statusEl) {
        if (refreshSalesRunning) return;
        refreshSalesRunning = true;
        const prevLabel = btn ? btn.innerText : '';
        if (btn) { btn.disabled = true; btn.innerText = '⏳ Refresh…'; }
        try {
            if (!navigator.onLine) { if (statusEl) statusEl.innerHTML = '<span style="color:#ef4444;">📡 hors ligne</span>'; return; }

            // 1) Annule les ventes sans mise
            if (statusEl) statusEl.innerHTML = '<span style="color:#888;">🔄 Annulation des ventes sans mise…</span>';
            let st = await fetchSellingState();
            if (!st) { // état inconnu → on ne touche à rien plutôt que d'agir à l'aveugle
                if (statusEl) statusEl.innerHTML = '<span style="color:#ef4444;">⚠ Ventes actives illisibles (serveur) — refresh annulé</span>';
                return;
            }
            // L'annulation des ventes sans mise a besoin du DÉTAIL, pas du compteur. Sans lui
            // on ne peut pas savoir lesquelles n'ont pas d'enchérisseur → on saute cette étape
            // plutôt que d'annuler à l'aveugle, et on va directement re-lister ce qui rentre.
            let cancelled = 0, keptWithBids = 0;
            if (st.detailed) {
                const cancellable = st.list.filter(a => !(a.current_bidder && a.current_bidder.username));
                keptWithBids = st.list.length - cancellable.length;
                for (const a of cancellable) {
                    const ok = await cancelSaleForRefresh(a);
                    if (ok) cancelled++;
                    await new Promise(r => setTimeout(r, 600 + Math.random() * 600));
                }
                const after = await fetchSellingState();
                if (after) renderActiveSales(after.list, after);
            } else if (st.count > 0) {
                wmLog(`ℹ️ Annulation des ventes sans mise impossible : le site ne détaille plus les ventes actives (API réduite à un compteur). Seule la remise en vente des slots libres est effectuée.`);
            }

            // 2) Scan du pool Trash (inclut de nouveau les cartes qu'on vient de re-taguer,
            //    dès que la propagation est faite — sinon elles reviendront au prochain cycle).
            if (statusEl) statusEl.innerHTML = '<span style="color:#888;">🔍 Recherche des cartes à mettre en vente…</span>';
            const trashCards = await getTrashPool((page, total) => {
                const pct = Math.round((page / total) * 100);
                if (statusEl) statusEl.innerHTML = `<span style="color:#888;">🔍 Recherche… ${pct}%</span>`;
            });

            // 3) Re-liste jusqu'au plafond
            const current = await fetchSellingState();
            if (!current) { // sans décompte fiable, re-lister risquerait de dépasser le plafond
                if (statusEl) statusEl.innerHTML = '<span style="color:#ef4444;">⚠ Ventes actives illisibles (serveur) — remise en vente annulée</span>';
                return;
            }
            const maxActive = effectiveMaxActive(current.max);
            const slots = Math.max(0, maxActive - current.count);
            if (slots === 0 || trashCards.length === 0) {
                if (statusEl) statusEl.innerHTML = `<span style="color:#4ade80;">✔ ${cancelled} vente(s) annulée(s)${keptWithBids ? ` · ${keptWithBids} gardée(s) (avec mise)` : ''}</span>${trashCards.length === 0 ? ' <span style="color:#888;">· plus de cartes Trash</span>' : ''}`;
                return;
            }
            const batch = await selectTrashBatch(trashCards, slots);
            if (statusEl) statusEl.innerHTML = `<span style="color:#06b6d4;">🛒 Mise en vente de ${batch.length} carte(s)…</span>`;
            const { sold, skipped, deferred } = await sellBatch(batch, statusEl);
            const afterSell = await fetchSellingState();
            if (afterSell) renderActiveSales(afterSell.list, afterSell);

            if (statusEl) statusEl.innerHTML =
                `<span style="color:#4ade80;">✔ Refresh : ${cancelled} annulée(s), ${sold} remise(s) en vente</span>` +
                (keptWithBids ? ` <span style="color:#888;">· ${keptWithBids} gardée(s) (avec mise)</span>` : '') +
                (deferred ? ` <span style="color:#fbbf24;">· ${deferred} reportée(s) (échange)</span>` : '') +
                (skipped ? ` <span style="color:#888;">· ${skipped} ignorée(s)</span>` : '');
            wmLog(`🔄 Refresh ventes : ${cancelled} annulée(s), ${sold} remise(s) en vente${keptWithBids ? `, ${keptWithBids} gardée(s) (avec mise)` : ''}`);
        } catch(e) {
            if (statusEl) statusEl.innerHTML = `<span style="color:#ef4444;">Erreur : ${e.message}</span>`;
        } finally {
            refreshSalesRunning = false;
            if (btn) { btn.disabled = false; btn.innerText = prevLabel || '🔄 Refresh ventes'; }
        }
    }

    async function sellTrashCards(btn, statusEl) {
        if (trashSellerRunning) {
            trashSellerRunning = false;
            btn.innerText = "▶ START";
            btn.className = "wm-btn wm-g wm-sm";
            btn.style.background = "";
            statusEl.innerHTML = '<span style="color:#888;">Arrêté.</span>';
            return;
        }

        trashSellerRunning = true;
        btn.innerText = "⏹ STOP";
        btn.className = "wm-btn wm-r wm-sm";
        btn.style.background = "";

        // Scanne le pool Trash et retourne la liste triée selon la stratégie. showProgress=false
        // → scan silencieux (préfetch en fond, on n'écrase pas le message d'attente).
        const scanPool = async (showProgress) => {
            const cards = await getTrashPool((page, total) => {
                if (showProgress) statusEl.innerHTML = `<span style="color:#888;">🔍 Recherche cartes Trash… ${Math.round((page / total) * 100)}% (p.${page}/${total})</span>`;
            });
            if (!trashSellerRunning) return [];
            return await selectTrashBatch(cards, cards.length); // tout le pool, trié
        };

        // 🗃️ Tampon de cartes prêtes à lister. On PRÉFETCH le scan du prochain lot en tâche
        // de fond pendant qu'on attend qu'un slot se libère → quand le pool actuel se termine,
        // on liste instantanément depuis le tampon sans attendre un nouveau scan.
        let buffer = [];
        let pendingScan = null;

        try {
            while (trashSellerRunning) {
                // 1) Récupère le lot : le scan préfetché (déjà prêt → instantané) sinon un scan.
                if (pendingScan) {
                    buffer = await pendingScan;
                    pendingScan = null;
                } else if (buffer.length === 0) {
                    statusEl.innerHTML = '<span style="color:#888;">🔍 Recherche cartes Trash… 0%</span>';
                    buffer = await scanPool(true);
                }
                if (!trashSellerRunning) break;
                if (buffer.length === 0) {
                    // Plus rien à lister MAIS des cartes sont exclues (échange en attente) →
                    // on ne stoppe pas : on patiente et on réessaie (le cooldown finira par expirer).
                    if (hasActivePendingTrades()) {
                        statusEl.innerHTML = `<span style="color:#fbbf24;">⏸️ Cartes restantes engagées dans des échanges — réessai dans 60s…</span>`;
                        await new Promise(r => setTimeout(r, 60000));
                        continue;
                    }
                    statusEl.innerHTML = '<span style="color:#4ade80;">✔ Plus de cartes Trash à vendre !</span>';
                    break;
                }

                // 2) Ventes actives + slots libres
                const state = await fetchSellingState();
                if (!state) { // décompte indisponible : on repasse plus tard, sans rien lister
                    statusEl.innerHTML = '<span style="color:#fbbf24;">⚠ Ventes actives illisibles (serveur) — nouvelle tentative dans 15s…</span>';
                    await new Promise(r => setTimeout(r, 15000));
                    continue;
                }
                renderActiveSales(state.list, state);
                // Le compteur serveur, pas la longueur de liste : depuis que /mine ne détaille
                // plus les ventes, la liste est vide alors que 10 ventes sont bien actives.
                const activeCount = state.count;
                const maxActive = effectiveMaxActive(state.max);
                const slots = Math.max(0, maxActive - activeCount);

                if (slots === 0) {
                    statusEl.innerHTML = `<span style="color:#888;">⏳ ${activeCount}/${maxActive} ventes actives — vérif dans 15s…</span>`;
                    await new Promise(r => setTimeout(r, 15000));
                    continue;
                }

                // 3) Mise en vente IMMÉDIATE depuis le tampon (aucun scan dans le chemin critique)
                const batch = buffer.slice(0, slots);
                statusEl.innerHTML = `<span style="color:#06b6d4;">🛒 Mise en vente de ${batch.length} carte(s) (${activeCount} actives)…</span>`;

                const { sold, skipped, deferred, limitReached } = await sellBatch(batch, statusEl);
                const newActive = activeCount + sold;

                statusEl.innerHTML =
                    `<span style="color:#4ade80;">✔ ${sold} mise(s) en vente</span>` +
                    (deferred > 0 ? ` <span style="color:#fbbf24;">· ${deferred} reportée(s) (échange)</span>` : "") +
                    (skipped > 0 ? ` <span style="color:#888;">· ${skipped} ignorée(s)</span>` : "") +
                    ` <span style="color:#555;">· ${newActive}/${maxActive} actives</span>`;

                // 4) 🔮 PRÉFETCH du prochain lot EN FOND. Les cartes qu'on vient de lister ont
                //    perdu leur tag → exclues du scan → pas de doublon. Il tourne pendant l'attente.
                if (!pendingScan && trashSellerRunning) pendingScan = scanPool(false).catch(() => []);

                // 4a) Le serveur s'est déclaré PLEIN. Il fait autorité, pas notre décompte local :
                //     l'attente en (5) sortirait aussitôt (elle compare un compteur possiblement
                //     faux au plafond) et on repartirait pour un 409 toutes les 15 s. Pause ferme.
                if (limitReached && trashSellerRunning) {
                    statusEl.innerHTML = `<span style="color:#fbbf24;">🛑 Plafond serveur atteint — pause de 2 min avant nouvelle tentative…</span>`;
                    await new Promise(r => setTimeout(r, 120000));
                    continue;
                }

                // 4b) Des cartes ont été reportées (échange) et il reste des slots libres → on
                //     repioche TOUT DE SUITE d'autres cartes (le préfetch les exclut) au lieu
                //     d'attendre 30s, pour atteindre le plafond de ventes malgré les reports.
                if (deferred > 0 && newActive < maxActive && trashSellerRunning) continue;

                // 5) Attendre qu'un slot se libère (le préfetch tourne pendant ce temps)
                statusEl.innerHTML += '<br><span style="color:#888;">⏳ Surveillance ventes actives… <span style="color:#555;">(prochain lot en préparation)</span></span>';
                while (trashSellerRunning) {
                    await new Promise(r => setTimeout(r, 15000));
                    await checkSellHistoryResults(); // met à jour sold/unsold
                    const cur = await fetchSellingState();
                    if (!cur) continue; // on ne sort pas de l'attente sur un décompte inconnu
                    renderActiveSales(cur.list, cur);
                    const mx = effectiveMaxActive(cur.max);
                    if (cur.count < mx) break;
                    statusEl.innerHTML = `<span style="color:#888;">⏳ ${cur.count}/${mx} ventes actives — attente…</span>`;
                }
            }
        } catch(e) {
            statusEl.innerHTML = '<span style="color:#ef4444;">Erreur : ' + e.message + '</span>';
        }

        if (trashSellerRunning) {
            statusEl.innerHTML += '<br><span style="color:#4ade80;">✔ Terminé !</span>';
        }
        trashSellerRunning = false;
        btn.innerText = "▶ START";
        btn.className = "wm-btn wm-g wm-sm";
        btn.style.background = "";
        sessionStorage.removeItem('wm_trashseller_active');
        document.getElementById('dot-trash')?.classList.remove('on');
    }

    /* ===================== ESTIMATION DE VALEUR ===================== */

    async function fetchMarketPrice(cardId) {
        if (marketPriceCache[cardId]) return marketPriceCache[cardId];
        try {
            // Cherche dans le marketplace les ventes actives de cette carte
            const res = await fetch(
                `https://www.wiki-masters.com/api/marketplace?card_id=${cardId}&limit=5&sort=ending_soon`,
                { credentials: "include" }
            );
            if (!res.ok) return null;
            const data = await res.json();
            const auctions = data.auctions || [];
            if (auctions.length === 0) return null;
            const prices = auctions.map(a => a.current_bid ?? a.base_amount).filter(p => p > 0);
            if (prices.length === 0) return null;
            const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
            marketPriceCache[cardId] = avg;
            return avg;
        } catch(e) { return null; }
    }

    async function estimateSessionValue(cards) {
        let total = 0;
        for (const c of cards) {
            const cardId = c.card?.id || c.card_id;
            const rarity = (c.card?.rarity || c.rarity || "C").toUpperCase();
            let price = await fetchMarketPrice(cardId);
            if (!price) price = getSellPrice(rarity);
            total += price;
        }
        return total;
    }

    /* ===================== HISTORIQUE VENTES ===================== */

    function recordSale(item, price, status, auctionId) {
        // status : 'pending' | 'sold' | 'unsold'
        sellHistory.push({
            title: item.card?.wikipedia_title || "?",
            rarity: (item.card?.rarity || "C").toUpperCase(),
            price,
            status,
            auctionId,
            userCardId: item.id || null,      // ID de l'exemplaire AU MOMENT du listing (peut être stale après retour)
            cardId: item.card_id || item.card?.id || null,  // ID catalogue (stable) → utilisé pour re-trouver l'exemplaire actuel
            timestamp: Date.now()
        });
        saveSellHistory();
        renderSellHistory();
    }

    const SUPABASE_REF   = "cyrxjeppjqsxxjayfrur";
    const SUPABASE_URL   = `https://${SUPABASE_REF}.supabase.co/rest/v1`;
    const SUPABASE_KEY   = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5cnhqZXBwanFzeHhqYXlmcnVyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4ODAzMzksImV4cCI6MjA4OTQ1NjMzOX0.BZluyXygNxuQGDPxFX1zG5i-cqp10CVK-8GGtuak4Rg";
    // Tag Trash : découvert dynamiquement par compte (par-utilisateur sur wiki-masters)
    const TRASH_TAG_CACHE_KEY = 'wm_trash_tag_id';
    let TRASH_TAG_ID = localStorage.getItem(TRASH_TAG_CACHE_KEY) || null;

    // Cherche le tag "Trash" du user connecté via Supabase REST sur la table tags.
    async function discoverTrashTagId() {
        const { token } = getSupabaseAccessToken();
        const claims = decodeJWT(token);
        const userId = claims?.sub;
        if (!userId || !token) {
            wmLog('⚠️ Découverte tag Trash impossible : JWT manquant');
            return null;
        }

        // Essai 1 : tags par-utilisateur (cas le plus probable)
        try {
            const res = await fetch(
                `${SUPABASE_URL}/tags?user_id=eq.${userId}&name=eq.${encodeURIComponent(getSellTagName())}&select=id&limit=1`,
                {
                    credentials: 'omit',
                    headers: {
                        'apikey': SUPABASE_KEY,
                        'Authorization': `Bearer ${token}`,
                        'Accept': 'application/json'
                    }
                }
            );
            if (res.ok) {
                const data = await res.json();
                if (data[0]?.id) {
                    TRASH_TAG_ID = data[0].id;
                    try { localStorage.setItem(TRASH_TAG_CACHE_KEY, TRASH_TAG_ID); } catch(e) {}
                    wmLog(`🏷️ Tag Trash découvert : <span style="color:#888;font-size:9px;">${TRASH_TAG_ID.slice(0,8)}…</span>`);
                    return TRASH_TAG_ID;
                }
            }
        } catch(e) {}

        // Essai 2 : tags globaux (sans filtre user_id) — au cas où le schéma diffère
        try {
            const res = await fetch(
                `${SUPABASE_URL}/tags?name=eq.${encodeURIComponent(getSellTagName())}&select=id&limit=1`,
                {
                    credentials: 'omit',
                    headers: {
                        'apikey': SUPABASE_KEY,
                        'Authorization': `Bearer ${token}`,
                        'Accept': 'application/json'
                    }
                }
            );
            if (res.ok) {
                const data = await res.json();
                if (data[0]?.id) {
                    TRASH_TAG_ID = data[0].id;
                    try { localStorage.setItem(TRASH_TAG_CACHE_KEY, TRASH_TAG_ID); } catch(e) {}
                    wmLog(`🏷️ Tag Trash découvert (global) : <span style="color:#888;font-size:9px;">${TRASH_TAG_ID.slice(0,8)}…</span>`);
                    return TRASH_TAG_ID;
                }
            }
        } catch(e) {}

        wmLog(`⚠️ Tag "<b>${getSellTagName()}</b>" introuvable sur ton compte — crée-le sur wiki-masters pour activer le retag auto`);
        return null;
    }

    async function ensureTrashTagId() {
        if (TRASH_TAG_ID) return TRASH_TAG_ID;
        return await discoverTrashTagId();
    }

    // Liste tous les tags du compte connecté via Supabase REST.
    // Retourne un tableau [{ id, name }] (vide en cas d'échec).
    async function fetchUserTags() {
        const { token } = getSupabaseAccessToken();
        const claims = decodeJWT(token);
        const userId = claims?.sub;
        if (!userId || !token) return [];
        try {
            const res = await fetch(
                `${SUPABASE_URL}/tags?select=id,name&user_id=eq.${userId}&order=name.asc`,
                { credentials: 'omit', headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }
            );
            if (!res.ok) return [];
            const data = await res.json();
            return Array.isArray(data) ? data.filter(t => t && t.id && t.name) : [];
        } catch(e) { return []; }
    }

    // Crée un tag sur le compte de l'utilisateur via Supabase REST (POST /tags).
    // Action explicite (modifie le compte) — ne doit être appelée que sur demande
    // claire de l'utilisateur (bouton dédié), jamais automatiquement.
    // Retourne { ok, id, alreadyExists, error }.
    async function createTrashTag(tagName) {
        let name = (tagName || '').trim();
        if (!name) return { ok: false, error: 'nom vide' };
        // Le serveur limite les noms de tag à 48 caractères → on tronque en amont
        // pour ne pas provoquer d'échec de création. La vérif d'existant et la
        // création utilisent ainsi le même nom (tronqué), donc pas de doublon.
        if (name.length > MAX_TAG_LEN) {
            const full = name;
            name = name.slice(0, MAX_TAG_LEN).trim();
            wmLog(`✂️ Tag tronqué à ${MAX_TAG_LEN} car. : « ${full} » → « ${name} »`);
        }

        const { token } = getSupabaseAccessToken();
        const claims = decodeJWT(token);
        const userId = claims?.sub;
        if (!userId || !token) return { ok: false, error: 'authentification manquante' };

        // Vérifie d'abord si un tag du même nom existe déjà (évite les doublons)
        try {
            const check = await fetch(
                `${SUPABASE_URL}/tags?user_id=eq.${userId}&name=eq.${encodeURIComponent(name)}&select=id&limit=1`,
                { credentials: 'omit', headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }
            );
            if (check.ok) {
                const existing = await check.json();
                if (existing[0]?.id) {
                    return { ok: true, id: existing[0].id, alreadyExists: true };
                }
            }
        } catch(e) {}

        // Création : POST { user_id, name } — avec Prefer pour récupérer l'objet créé
        try {
            const res = await fetch(`${SUPABASE_URL}/tags`, {
                method: 'POST',
                credentials: 'omit',
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Content-Profile': 'public',
                    'Prefer': 'return=representation'
                },
                body: JSON.stringify({ user_id: userId, name })
            });
            if (res.status === 201 || res.ok) {
                let id = null;
                try { const data = await res.json(); id = data?.[0]?.id || data?.id || null; } catch(e) {}
                return { ok: true, id, alreadyExists: false };
            }
            return { ok: false, error: `HTTP ${res.status}` };
        } catch(e) {
            return { ok: false, error: e.message };
        }
    }

    /* ===================== ÉTIQUETAGE EN MASSE ===================== */

    // Récupère TOUTE la collection (toutes les pages), de façon robuste.
    // Même garde-fou que le Trash Seller : une page échouée (null) ne tronque
    // pas le reste du pool. Items renvoyés : { id (= user_card_id), card, tags[] }.
    // Taille de page. On reste à 50 (valeur connue/sûre) : demander plus est risqué si le serveur
    // plafonne le COMPTE mais calcule l'offset sur la limite demandée → trous de pagination.
    // On détecte quand même la taille réelle renvoyée pour être robuste à un éventuel cap.
    const COLLECTION_PAGE_LIMIT = 50;
    async function fetchAllCollectionItems(onProgress) {
        const url = (p) => `https://www.wiki-masters.com/api/my-collection?page=${p}&limit=${COLLECTION_PAGE_LIMIT}&sort=rarity`;
        let items = [];

        async function fetchPage(p) {
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const res = await fetch(url(p), { credentials: 'include' });
                    if (!res.ok) { await new Promise(r => setTimeout(r, 400 * (attempt + 1))); continue; }
                    const data = await res.json();
                    return data.collection || [];
                } catch(e) {
                    await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
                }
            }
            return null; // échec après 3 tentatives (≠ page vide)
        }

        const firstRes = await fetch(url(0), { credentials: 'include' });
        const firstData = await firstRes.json();
        const firstItems = firstData.collection || [];
        items = items.concat(firstItems);
        const apiTotal = parseInt(firstData.total, 10);
        const totalIsKnown = Number.isFinite(apiTotal) && apiTotal >= firstItems.length && apiTotal > 0;
        // Taille RÉELLE d'une page pleine (= ce que le serveur a renvoyé), pas ce qu'on a demandé.
        const pageSize = firstItems.length > 0 ? firstItems.length : COLLECTION_PAGE_LIMIT;
        const totalPages = totalIsKnown ? Math.ceil(apiTotal / pageSize) : null;
        if (onProgress) onProgress(items.length, totalIsKnown ? apiTotal : null);

        const onlyOnePage = totalIsKnown ? (apiTotal <= firstItems.length) : (firstItems.length < pageSize);
        if (!onlyOnePage) {
            const BATCH = 15, MAX_PAGES = 4000; // un peu plus de pages en parallèle qu'avant (10)
            const upperLimit = totalIsKnown ? totalPages : MAX_PAGES;
            let reachedEnd = false, failed = 0;
            for (let start = 1; start < upperLimit && !reachedEnd; start += BATCH) {
                const pages = [];
                for (let p = start; p < Math.min(start + BATCH, upperLimit); p++) pages.push(p);
                const results = await Promise.all(pages.map(fetchPage));
                results.forEach(arr => {
                    if (arr === null) { failed++; return; }
                    if (!totalIsKnown && arr.length < pageSize) reachedEnd = true;
                    items = items.concat(arr);
                });
                if (onProgress) onProgress(items.length, totalIsKnown ? apiTotal : null);
            }
            if (failed > 0) wmLog(`⚠️ Étiquetage : ${failed} page(s) injoignable(s) — la collection peut être incomplète, relance le scan.`);
        }
        return items;
    }

    // Cache du dernier scan COMPLET des items de collection (avec tags), partagé par tous les
    // flux d'étiquetage : on ne re-scanne plus 95k cartes à chaque préset. Réutilisé tant qu'il
    // est récent ; invalidé par le bouton ♻️ Collection ou la case « forcer un nouveau scan ».
    let collectionItemsCache = { items: null, ts: 0 };
    const COLLECTION_ITEMS_TTL_MS = 30 * 60 * 1000; // 30 min
    function invalidateCollectionItemsCache() { collectionItemsCache = { items: null, ts: 0 }; }

    // Renvoie { items, reused, ageMin }. Réutilise le cache si récent (< TTL) sauf opts.force.
    async function getCollectionItems(onProgress, opts = {}) {
        const fresh = collectionItemsCache.items
            && (Date.now() - collectionItemsCache.ts) < (opts.maxAgeMs ?? COLLECTION_ITEMS_TTL_MS);
        if (!opts.force && fresh) {
            const ageMin = Math.round((Date.now() - collectionItemsCache.ts) / 60000);
            return { items: collectionItemsCache.items, reused: true, ageMin };
        }
        const items = await fetchAllCollectionItems(onProgress);
        // On ne met en cache qu'un scan qui a l'air complet (au moins 1 carte).
        if (Array.isArray(items) && items.length > 0) collectionItemsCache = { items, ts: Date.now() };
        return { items, reused: false, ageMin: 0 };
    }

    // Applique un tag (tag_id) à une carte (user_card_id) — upsert idempotent,
    // même mécanique que reapplyTrashTag mais générique (n'importe quel tag).
    // Retourne { ok:bool, status:number, error:string } pour permettre aux appelants de
    // savoir POURQUOI et sur quelle carte un tag a échoué (diagnostic étiquetage en masse).
    async function addTagToUserCard(userCardId, tagId, attempt = 1) {
        if (!userCardId || !tagId) return { ok: false, status: 0, error: 'user_card_id/tag_id manquant' };
        const MAX_ATTEMPTS = 5;
        const { token } = getSupabaseAccessToken();
        const url = `${SUPABASE_URL}/user_card_tags?on_conflict=user_card_id%2Ctag_id&columns=%22user_card_id%22%2C%22tag_id%22`;
        const headers = {
            "apikey": SUPABASE_KEY,
            "Authorization": `Bearer ${token || SUPABASE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "resolution=ignore-duplicates,count=exact,return=minimal"
        };
        try {
            const res = await fetch(url, {
                method: "POST", credentials: "omit", headers,
                body: JSON.stringify({ user_card_id: userCardId, tag_id: tagId })
            });
            if (res.ok) return { ok: true, status: res.status };
            if ([500, 502, 503, 504, 429].includes(res.status) && attempt < MAX_ATTEMPTS) {
                await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt - 1), 6000)));
                return addTagToUserCard(userCardId, tagId, attempt + 1);
            }
            // Échec définitif → on extrait un message lisible du corps de la réponse.
            const body = await res.text().catch(() => '');
            let error = (body || '').slice(0, 200);
            try { const j = JSON.parse(body); error = j.message || j.error || j.detail || j.hint || error; } catch(e) {}
            return { ok: false, status: res.status, error: error || `HTTP ${res.status}` };
        } catch(e) {
            if (attempt < MAX_ATTEMPTS) {
                await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt - 1), 6000)));
                return addTagToUserCard(userCardId, tagId, attempt + 1);
            }
            return { ok: false, status: 0, error: e.message || 'exception réseau' };
        }
    }

    // Cherche le user_card_id ACTUEL d'une carte (par card_id catalogue).
    // Approche : interroger directement la table user_cards via Supabase REST
    // (source de vérité, contrairement à /api/my-collection qui peut aggregate).
    async function findCurrentUserCardId(cardId, cardTitle) {
        if (!cardId) return null;

        const { token } = getSupabaseAccessToken();
        const claims = decodeJWT(token);
        const userId = claims?.sub;
        if (!userId || !token) {
            wmLog(`⚠️ findUserCardId : JWT/userId manquant`);
            return null;
        }

        const MAX_ATTEMPTS = 4;
        const DELAYS_MS = [0, 2000, 4000, 8000]; // 0s, +2s, +4s, +8s = ~14s max
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            if (DELAYS_MS[attempt] > 0) {
                await new Promise(r => setTimeout(r, DELAYS_MS[attempt]));
            }

            // 1) Tentative principale : user_cards table via Supabase REST
            try {
                const url = `${SUPABASE_URL}/user_cards?card_id=eq.${cardId}&user_id=eq.${userId}&select=id,user_card_tags(tag_id)&limit=20`;
                const res = await fetch(url, {
                    credentials: 'omit',
                    headers: {
                        'apikey': SUPABASE_KEY,
                        'Authorization': `Bearer ${token}`,
                        'Accept': 'application/json'
                    }
                });
                if (res.ok) {
                    const items = await res.json();
                    if (Array.isArray(items) && items.length > 0) {
                        // Préférer un exemplaire sans le tag Trash (= celui qui vient de revenir)
                        const untagged = items.find(i =>
                            !(i.user_card_tags || []).some(t => t.tag_id === TRASH_TAG_ID)
                        );
                        const found = untagged?.id || items[0]?.id;
                        if (found) {
                            const retryNote = attempt > 0 ? ` <span style="color:#888;font-size:9px;">(tentative ${attempt+1}/${MAX_ATTEMPTS})</span>` : '';
                            wmLog(`🔎 user_card_id résolu via Supabase : <b>${cardTitle || cardId.slice(0,8)}</b> · ${items.length} exemplaire(s), ${untagged ? 'sans tag' : 'déjà taggué'} → ${found.slice(0,8)}…${retryNote}`);
                            return found;
                        }
                    }
                    // Items vide → la carte n'est pas (encore) revenue. On retry après délai.
                } else {
                    const body = await res.text().catch(() => '');
                    wmLog(`⚠️ findUserCardId Supabase HTTP ${res.status} · ${body.slice(0, 100)}`);
                    // Erreur réseau/auth : on continue les retries
                }
            } catch(e) {
                wmLog(`⚠️ findUserCardId Supabase exception : ${e.message}`);
            }
        }

        // 2) Fallback final : scan de /api/my-collection (peut ne pas exposer le bon id)
        try {
            for (let page = 0; page < 5; page++) {
                const res = await fetch(
                    `https://www.wiki-masters.com/api/my-collection?page=${page}&limit=50&sort=obtained_at`,
                    { credentials: 'include' }
                );
                if (!res.ok) break;
                const data = await res.json();
                const items = data.collection || [];
                if (items.length === 0) break;
                const matches = items.filter(i => (i.card_id || i.card?.id) === cardId);
                const untagged = matches.find(i => !(i.tags || []).some(t => t.name === getSellTagName()));
                if (untagged?.id) return untagged.id;
                if (matches[0]?.id) return matches[0].id;
                if (items.length < 50) break;
            }
        } catch(e) {}

        wmLog(`🔍 Aucun exemplaire trouvé pour <b>${cardTitle || cardId.slice(0,8)}</b> après ${MAX_ATTEMPTS} tentatives Supabase`);
        return null;
    }

    // Extrait le JWT utilisateur depuis localStorage ou les cookies Supabase
    // (supabase-ssr stocke en cookie, parfois chunké en .0 .1, parfois préfixé "base64-")
    function getSupabaseAccessToken() {
        const key = `sb-${SUPABASE_REF}-auth-token`;

        // 1) localStorage (clients Supabase classiques)
        try {
            const raw = localStorage.getItem(key);
            if (raw) {
                const obj = JSON.parse(raw);
                if (obj?.access_token) return { token: obj.access_token, source: 'localStorage' };
                if (Array.isArray(obj) && obj[0]) return { token: obj[0], source: 'localStorage[0]' };
            }
        } catch(e) {}

        // 2) Cookies (supabase-ssr) — éventuellement chunkés en .0 .1 .2…
        try {
            const cookies = document.cookie.split(';').map(c => c.trim());
            const chunks = {};
            let single = null;
            for (const c of cookies) {
                const eq = c.indexOf('=');
                if (eq === -1) continue;
                const name = c.slice(0, eq);
                const value = c.slice(eq + 1);
                if (name === key) { single = value; continue; }
                const m = name.match(new RegExp(`^${key}\\.(\\d+)$`));
                if (m) chunks[parseInt(m[1])] = value;
            }
            let raw = single;
            if (!raw && Object.keys(chunks).length > 0) {
                raw = Object.keys(chunks).sort((a,b) => a-b).map(k => chunks[k]).join('');
            }
            if (raw) {
                raw = decodeURIComponent(raw);
                if (raw.startsWith('base64-')) raw = atob(raw.slice(7));
                const obj = JSON.parse(raw);
                if (obj?.access_token) return { token: obj.access_token, source: 'cookie' };
                if (Array.isArray(obj) && obj[0]) return { token: obj[0], source: 'cookie[0]' };
            }
        } catch(e) {}

        return { token: null, source: null };
    }

    /* ── Introspection du schéma Supabase ──
       Le site est bâti sur Supabase et le bot y est déjà authentifié (tags, user_cards, cards).
       Depuis que /api/marketplace/mine a été réduit à des compteurs, les ventes doivent être
       lues directement en base. PostgREST publie un descriptif OpenAPI à la racine de /rest/v1
       listant TOUTES les tables exposées et leurs colonnes : une seule requête donne la réponse
       exacte, au lieu de bombarder le serveur de noms de tables inventés.
       Console : wmDiscoverTables()  — ou wmDiscoverTables('auction') pour filtrer. */
    window.wmDiscoverTables = async function(filter) {
        const { token } = getSupabaseAccessToken();
        let spec;
        try {
            const res = await fetch(`${SUPABASE_URL}/`, {
                credentials: 'omit',
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${token || SUPABASE_KEY}`,
                    'Accept': 'application/openapi+json'
                }
            });
            if (!res.ok) { wmLog(`🔬 Introspection Supabase : <b>HTTP ${res.status}</b>${token ? '' : ' (aucun token utilisateur trouvé — es-tu connecté au site ?)'}`); return null; }
            spec = await res.json();
        } catch(e) {
            wmLog(`🔬 Introspection Supabase échouée : ${e.message}`);
            return null;
        }
        const defs = spec.definitions || (spec.components && spec.components.schemas) || {};
        const tables = Object.keys(defs);
        if (tables.length === 0) { wmLog(`🔬 Supabase : aucune table exposée dans le descriptif.`); return spec; }
        const rx = filter ? new RegExp(filter, 'i') : /auction|market|sale|sell|listing|bid|trade/i;
        const hits = tables.filter(t => rx.test(t));
        wmLog(`🔬 <b>Supabase</b> : ${tables.length} table(s) exposée(s) · correspondances : <b style="color:#4ade80;">${hits.join(', ') || 'aucune'}</b>`);
        for (const t of hits.slice(0, 6)) {
            const cols = Object.keys((defs[t] && defs[t].properties) || {});
            wmLog(`🔬 <b>${t}</b> → <span style="color:#888;font-size:9px;">${cols.join(', ') || '(colonnes inconnues)'}</span>`);
        }
        if (hits.length === 0) {
            wmLog(`🔬 Toutes les tables : <span style="color:#888;font-size:9px;">${tables.join(', ')}</span>`);
        }
        return spec; // consultable dans la console
    };

    /* ══════════ VENTES & ACHATS LUS DIRECTEMENT EN BASE ══════════
       L'API REST du site ne renvoie plus que des compteurs. Les données vivent dans Supabase :
         auctions(id, seller_id, card_id, base_amount, current_bid, current_bidder_id, end_at,
                  status, winner_id, final_price, settled_at, snapshot_rarity,
                  listing_base_amount, …)
       On les relit directement, puis on les remet dans la FORME que le reste du code attend
       déjà (card:{…}, current_bidder:{username}) — ainsi renderActiveSales, updateBidsSumDisplay
       et l'annulation de vente continuent de fonctionner sans être réécrits. */
    const AUCTION_COLS = 'id,seller_id,card_id,base_amount,current_bid,current_bidder_id,' +
        'end_at,status,winner_id,final_price,settled_at,created_at,snapshot_rarity,listing_base_amount';

    async function supabaseSelect(path) {
        const { token } = getSupabaseAccessToken();
        if (!token) return null; // sans JWT utilisateur la RLS ne renverra rien d'utile
        try {
            const res = await fetchWithTimeout(`${SUPABASE_URL}/${path}`, {
                credentials: 'omit',
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json'
                }
            });
            if (!res.ok) return null;
            return await res.json();
        } catch(e) { return null; }
    }

    function currentUserId() {
        const { token } = getSupabaseAccessToken();
        return decodeJWT(token)?.sub || null;
    }

    // Résolution id → pseudo. La table des profils n'est pas connue d'avance (le code
    // historique sondait déjà profiles/users/…) : on retient celle qui répond.
    const PROFILE_TABLES = ['profiles', 'users', 'user_profiles', 'accounts', 'players', 'members'];
    const PROFILE_TABLE_KEY = 'wm_profile_table';
    // Noms de colonne possibles pour le pseudo, du plus au moins spécifique.
    const USERNAME_KEYS = ['username', 'user_name', 'pseudo', 'handle', 'nickname',
        'display_name', 'displayName', 'name', 'full_name'];
    function pickUsername(row) {
        for (const k of USERNAME_KEYS) {
            const v = row && row[k];
            if (typeof v === 'string' && v.trim()) return v.trim();
        }
        return null;
    }
    let _profileTable = null;
    try { _profileTable = localStorage.getItem(PROFILE_TABLE_KEY); } catch(e) {}
    let _profileProbeLogged = false;
    const _usernameCache = new Map();
    async function resolveUsernames(ids) {
        const missing = [...new Set((ids || []).filter(id => id && !_usernameCache.has(id)))];
        if (missing.length > 0) {
            const tried = [];
            const tables = _profileTable ? [_profileTable, ...PROFILE_TABLES] : PROFILE_TABLES;
            for (const t of tables) {
                if (tried.includes(t)) continue;
                tried.push(t);
                // `select=*` et NON une liste de colonnes : PostgREST répond 400 dès qu'UNE
                // colonne demandée n'existe pas, ce qui faisait rejeter une table pourtant
                // valide (d'où les pseudos affichés « ? »). On prend la ligne entière et on
                // choisit ensuite le champ qui porte le pseudo.
                const rows = await supabaseSelect(`${t}?id=in.(${missing.join(',')})&select=*`);
                if (!Array.isArray(rows) || rows.length === 0) continue;
                if (_profileTable !== t) {
                    _profileTable = t;
                    try { localStorage.setItem(PROFILE_TABLE_KEY, t); } catch(e) {}
                }
                rows.forEach(r => { if (r && r.id) _usernameCache.set(r.id, pickUsername(r) || '?'); });
                // Diagnostic si la table répond mais qu'aucune colonne ne ressemble à un pseudo.
                if (!_profileProbeLogged && rows[0] && !pickUsername(rows[0])) {
                    _profileProbeLogged = true;
                    wmLog(`🔬 Table profils <b>${t}</b> trouvée, mais aucune colonne de pseudo reconnue. Colonnes : <span style="color:#888;font-size:9px;">${Object.keys(rows[0]).join(', ')}</span>`);
                }
                break;
            }
            if (!_profileProbeLogged && missing.some(id => !_usernameCache.has(id))) {
                _profileProbeLogged = true;
                wmLog(`🔬 Pseudos non résolus : aucune table de profils lisible parmi <span style="color:#888;">${tried.join(', ')}</span>. Les enchérisseurs s'afficheront « ? ».`);
            }
            // Les ids non résolus sont mis en cache à '?' pour ne pas être re-demandés en boucle.
            missing.forEach(id => { if (!_usernameCache.has(id)) _usernameCache.set(id, '?'); });
        }
        const out = {};
        (ids || []).forEach(id => { if (id) out[id] = _usernameCache.get(id) || '?'; });
        return out;
    }

    // Teste la résolution des pseudos sans attendre qu'un adversaire mise : on résout son
    // PROPRE id par le même chemin que celui utilisé pour les enchérisseurs. Console :
    // wmTestUsernames()  — ou wmTestUsernames('<uuid>') pour un id précis.
    window.wmTestUsernames = async function(id) {
        const uid = id || currentUserId();
        if (!uid) { wmLog(`🔬 Test pseudos : aucun id utilisateur (JWT absent — connecté au site ?)`); return null; }
        _usernameCache.delete(uid); // force une vraie requête plutôt qu'un cache
        _profileProbeLogged = false;
        const names = await resolveUsernames([uid]);
        const got = names[uid];
        wmLog(got && got !== '?'
            ? `🔬 Test pseudos : <b style="color:#4ade80;">OK</b> — ${uid.slice(0, 8)}… → <b>${got}</b> (table « ${_profileTable} »). Les enchérisseurs s'afficheront correctement.`
            : `🔬 Test pseudos : <b style="color:#ef4444;">ÉCHEC</b> — id ${uid.slice(0, 8)}… non résolu. Voir le message de diagnostic ci-dessus.`);
        return got;
    };

    // Convertit une ligne `auctions` vers la forme historique de l'API du site.
    function adaptAuctionRow(row, names) {
        const c = row.cards || null;
        return {
            id: row.id,
            card_id: row.card_id,
            card: {
                id: (c && c.id) || row.card_id,
                wikipedia_title: (c && c.wikipedia_title) || '?',
                // snapshot_rarity D'ABORD : c'est la rareté FIGÉE au moment de la mise en
                // vente, celle que le site affiche pour CETTE annonce précise. `cards.rarity`
                // est la rareté LIVE du catalogue, qui peut avoir changé depuis (dérive de
                // pageviews avec retard côté site — exactement le phénomène étudié plus haut
                // avec wmCheckRarityDrift). La préférer inversait la rareté affichée pour toute
                // carte dont la rareté catalogue a bougé après sa mise en vente. Repli sur
                // `cards.rarity` seulement si le snapshot manque (ancienne donnée). Convention
                // déjà suivie partout ailleurs dans ce fichier (syncWonAuctions, renderBuyList,
                // checkRecentSales) — seul cet endroit avait l'ordre inversé.
                rarity: row.snapshot_rarity || (c && c.rarity) || '',
                image_url: c ? c.image_url : null
            },
            base_amount: row.base_amount,
            listing_base_amount: row.listing_base_amount,
            current_bid: row.current_bid,
            current_bidder: row.current_bidder_id
                ? { username: (names && names[row.current_bidder_id]) || '?' }
                : null,
            seller: row.seller_id ? { username: (names && names[row.seller_id]) || '?' } : null,
            end_at: row.end_at,
            status: row.status,
            winner_id: row.winner_id,
            final_price: row.final_price,
            settled_at: row.settled_at,
            snapshot_rarity: row.snapshot_rarity
        };
    }

    // Requête auctions + jointure cards. L'embed PostgREST `cards(…)` n'est possible que si la
    // clé étrangère est exposée : on retente sans en cas d'échec (titres alors indisponibles,
    // mais prix / échéances / statuts restent corrects).
    async function queryAuctions(filter, order, limit) {
        const embed = `&select=${AUCTION_COLS},cards(id,wikipedia_title,rarity,image_url)`;
        const plain = `&select=${AUCTION_COLS}`;
        const tail = `${order ? '&order=' + order : ''}${limit ? '&limit=' + limit : ''}`;
        let rows = await supabaseSelect(`auctions?${filter}${embed}${tail}`);
        if (!Array.isArray(rows)) rows = await supabaseSelect(`auctions?${filter}${plain}${tail}`);
        if (!Array.isArray(rows)) return null;
        const names = await resolveUsernames(
            rows.flatMap(r => [r.current_bidder_id, r.seller_id]));
        return rows.map(r => adaptAuctionRow(r, names));
    }

    // Mes ventes en cours — remplace le `selling` disparu de /api/marketplace/mine.
    async function fetchActiveSalesFromDb() {
        const uid = currentUserId();
        if (!uid) return null;
        const nowIso = encodeURIComponent(new Date().toISOString());
        return await queryAuctions(
            `seller_id=eq.${uid}&status=eq.active&end_at=gt.${nowIso}`, 'end_at.asc', 50);
    }

    // Mes enchères gagnées — remplace le `won` disparu. Alimente l'historique des achats.
    async function fetchWonFromDb(limit) {
        const uid = currentUserId();
        if (!uid) return null;
        return await queryAuctions(`winner_id=eq.${uid}`, 'settled_at.desc', limit || 200);
    }

    // Mes ventes conclues — remplace le `history` disparu. Alimente l'historique des ventes.
    async function fetchSoldFromDb(limit) {
        const uid = currentUserId();
        if (!uid) return null;
        return await queryAuctions(
            `seller_id=eq.${uid}&winner_id=not.is.null`, 'settled_at.desc', limit || 200);
    }

    /* ── Lecture par ID exact ──
       reconcilePendingSales() et checkSellHistoryResults() ont besoin de savoir, pour CHAQUE
       vente en attente, si son enchère précise est toujours active ou déjà conclue — et à quel
       prix. Elles lisaient `data.selling` / `data.history` sur /mine, disparus comme le reste :
       sans source de vérité, la première boucle marquait à tort toute vente encore active comme
       « terminée » dès son premier passage (rien dans `selling` pour prouver le contraire).
       Une requête par ID exact sur `auctions` est même plus fiable que l'ancienne liste, qui
       pouvait être tronquée pour les enchères anciennes. Pas de jointure carte/pseudo ici :
       ces deux fonctions ne s'en servent pas. */
    async function fetchAuctionsByIds(ids) {
        const list = [...new Set((ids || []).filter(Boolean))];
        if (list.length === 0) return new Map();
        const rows = await supabaseSelect(
            `auctions?id=in.(${list.join(',')})&select=id,status,end_at,winner_id,final_price,settled_at,current_bid`);
        if (!Array.isArray(rows)) return null; // échec réseau/RLS → distinct de « aucune ligne »
        return new Map(rows.map(r => [r.id, r]));
    }
    // Vrai si une ligne `auctions` désigne une enchère toujours en cours (mêmes règles que
    // activeSellingFrom : statut actif ET échéance non dépassée).
    function auctionRowStillActive(row) {
        if (!row) return false;
        if (!isActiveSellingStatus(row.status)) return false;
        const end = new Date(row.end_at || NaN).getTime();
        return !(Number.isFinite(end) && end <= Date.now());
    }
    // Vrai si une ligne désigne une vente CONCLUE avec un gagnant (même test relâché
    // qu'ailleurs : on ne dépend plus du libellé exact `settled_sold`, absent en base).
    function auctionRowSettledSold(row) {
        return !!row && (row.winner_id != null || Number.isFinite(row.final_price));
    }

    /* ── Sonde ciblée de tables ──
       Repli quand l'introspection OpenAPI est refusée (401 : Supabase la restreint souvent).
       On interroge une liste COURTE et ordonnée de noms plausibles, avec limit=1, et on lit le
       code d'erreur PostgREST pour distinguer les trois cas qui nous intéressent :
         • 200            → la table existe et est lisible (on affiche ses colonnes)
         • 401/403        → elle existe mais la RLS nous la refuse (info utile quand même)
         • 404 + 42P01    → elle n'existe pas
       Console : wmProbeTables()  — ou wmProbeTables(['ma_table']) pour tester un nom précis. */
    const PROBE_TABLE_NAMES = ['auctions', 'marketplace_auctions', 'marketplace_listings',
        'listings', 'market_auctions', 'card_auctions', 'sales', 'auction_bids', 'bids'];
    window.wmProbeTables = async function(names) {
        const { token, source } = getSupabaseAccessToken();
        wmLog(`🔬 Sonde Supabase — token utilisateur : <b>${token ? 'trouvé (' + source + ')' : 'ABSENT'}</b>${token ? '' : ' — connecte-toi au site, sinon tout répondra 401.'}`);
        const list = Array.isArray(names) && names.length ? names : PROBE_TABLE_NAMES;
        const found = [];
        let absent = 0;
        for (const t of list) {
            let res, body = '';
            try {
                res = await fetch(`${SUPABASE_URL}/${t}?select=*&limit=1`, {
                    credentials: 'omit',
                    headers: {
                        'apikey': SUPABASE_KEY,
                        'Authorization': `Bearer ${token || SUPABASE_KEY}`,
                        'Accept': 'application/json'
                    }
                });
                body = await res.text();
            } catch(e) {
                wmLog(`🔬 <b>${t}</b> → erreur réseau : ${e.message}`);
                continue;
            }
            if (res.ok) {
                let rows = [];
                try { rows = JSON.parse(body); } catch(e) {}
                const cols = (Array.isArray(rows) && rows[0]) ? Object.keys(rows[0]) : null;
                found.push(t);
                wmLog(`🔬 ✅ <b style="color:#4ade80;">${t}</b> → lisible · colonnes : <span style="color:#888;font-size:9px;">${cols ? cols.join(', ') : '(table vide, colonnes inconnues)'}</span>`);
            } else if (res.status === 401 || res.status === 403) {
                wmLog(`🔬 🔒 <b style="color:#fbbf24;">${t}</b> → existe probablement, mais accès refusé (RLS) · HTTP ${res.status}`);
            } else if (/42P01/.test(body)) {
                absent++; // n'existe pas : normal pour la plupart des noms testés, on compte sans logguer
            } else {
                wmLog(`🔬 ❔ <b>${t}</b> → HTTP ${res.status} · <span style="color:#888;font-size:9px;">${body.slice(0, 120).replace(/</g, '&lt;')}</span>`);
            }
            await new Promise(r => setTimeout(r, 250)); // on ne martèle pas le serveur
        }
        // Bilan explicite : les tables inexistantes ne sont pas logguées une par une, mais la
        // console du navigateur affiche quand même leurs 404. Sans ce décompte, l'écart entre
        // « N noms testés » et « N−k erreurs en console » oblige à recouper à la main —
        // alors que ce sont justement les manquantes qui ont répondu 200.
        wmLog(`🔬 Sonde terminée — <b>${list.length}</b> nom(s) testé(s) · <b style="color:#4ade80;">${found.length} lisible(s)</b>${found.length ? ' : <b>' + found.join(', ') + '</b>' : ''} · ${absent} inexistante(s) (404 en console, normal).`);
        return found;
    };

    /* ══════════ VALIDATION : dérive de rareté vs vues Wikipédia réelles ══════════
       Idée : WikiMasters recalcule `pageviews`/`rarity` avec un gros retard (« 3 plombes »
       de l'aveu de l'utilisateur). Si on compare le nombre de vues RÉEL et ACTUEL d'un article
       (via l'API publique Wikimedia) à la rareté qu'il impliquerait selon les seuils du jeu,
       un écart avec la rareté ACTUELLE de la carte sur WikiMasters signale une carte dont la
       rareté est sur le point de changer, avant que le site ne la recalcule.
       Seuils fournis par l'utilisateur (vues/mois) : C <50 · PC 50+ · R 250+ · SR 1000+ ·
       UR 5000+ · L 20000+. Prototype de VALIDATION seulement — pas branché sur les décisions
       d'enchère : le but ici est de vérifier que la corrélation vues→rareté tient la route sur
       des cartes connues avant d'envisager quoi que ce soit d'automatisé. */
    function rarityFromMonthlyViews(views) {
        if (!Number.isFinite(views)) return null;
        if (views >= 20000) return 'L';
        if (views >= 5000)  return 'UR';
        if (views >= 1000)  return 'SR';
        if (views >= 250)   return 'R';
        if (views >= 50)    return 'PC';
        return 'C';
    }

    // { start, end } = 1er jour du mois précédent et 1er jour du mois en cours — le dernier
    // mois CIVIL complet (le mois en cours est partiel, le comparer aux seuils sous-estimerait
    // systématiquement les vues). L'API Wikimedia REJETTE une plage start === end avec
    // « no full months between dates » (HTTP 400, testé) : il faut une vraie plage d'un mois,
    // pas un instant unique répété deux fois.
    function lastCompleteMonthRange() {
        const stamp = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}0100`;
        const end = new Date(); end.setDate(1); // 1er du mois en cours (borne de fin, exclusive en pratique)
        const start = new Date(end); start.setMonth(start.getMonth() - 1); // 1er du mois précédent
        return { start: stamp(start), end: stamp(end) };
    }

    // Vues RÉELLES du dernier mois complet pour un article, via l'API publique Wikimedia
    // (aucune clé requise). Espaces → underscores, reste percent-encodé standard.
    // Ne renvoie JAMAIS un échec silencieux : `error` porte toujours la cause précise
    // (statut HTTP + corps, ou message d'exception réseau/CORS/CSP) — un simple `null`
    // masquerait la différence entre « Wikimedia indisponible », « titre mal formé » et
    // « bloqué par la CSP de la page », qui appellent chacun une action différente.
    async function fetchRealMonthlyViews(wikipediaTitle) {
        const { start, end } = lastCompleteMonthRange();
        const articlePath = encodeURIComponent(wikipediaTitle.trim().replace(/ /g, '_'));
        // La plage [start, end] couvre le mois précédent COMPLET + le mois en cours PARTIEL
        // (2 entrées) : on ne garde que items[0], qui correspond à `start` (le mois complet).
        const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/fr.wikipedia/all-access/user/${articlePath}/monthly/${start}/${end}`;
        try {
            const res = await fetch(url, { credentials: 'omit' });
            if (res.status === 404) return { views: 0, monthStamp: start, url }; // article sans vues ce mois = 404 côté Wikimedia
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                return { error: `HTTP ${res.status}${body ? ' · ' + body.slice(0, 150) : ''}`, url };
            }
            const data = await res.json();
            const item = Array.isArray(data.items) ? data.items[0] : null;
            return { views: item ? item.views : 0, monthStamp: start, url };
        } catch(e) {
            // Un TypeError "Failed to fetch" ici est presque toujours du CORS ou une CSP
            // (connect-src) de la page wiki-masters.com bloquant l'appel vers wikimedia.org —
            // le script tourne en @grant none (pas de GM_xmlhttpRequest pour contourner ça).
            return { error: `${e.name || 'Erreur'} : ${e.message || 'inconnue'}`, url };
        }
    }

    // Fiche WikiMasters en cache pour un titre exact (table `cards`, catalogue — pas
    // user_cards). Suppose que `wikipedia_title` matche exactement le titre d'article.
    async function fetchCachedCardStats(wikipediaTitle) {
        const rows = await supabaseSelect(
            `cards?wikipedia_title=eq.${encodeURIComponent(wikipediaTitle)}&select=id,wikipedia_title,rarity,pageviews,q_score,pageviews_refreshed_at,qscore_refreshed_at&limit=1`);
        return Array.isArray(rows) && rows[0] ? rows[0] : null;
    }

    const fmtAgoRarity = (iso) => {
        if (!iso) return 'jamais';
        const ms = Date.now() - new Date(iso).getTime();
        if (!Number.isFinite(ms) || ms < 0) return '?';
        const days = Math.floor(ms / 86400000);
        if (days >= 1) return `${days} j`;
        const hours = Math.floor(ms / 3600000);
        return hours >= 1 ? `${hours} h` : `${Math.floor(ms / 60000)} min`;
    };

    // Cœur du calcul, partagé entre l'outil console (wmCheckRarityDrift, plusieurs titres)
    // et le bouton 🔭 sur chaque enchère du Market Watcher (un seul titre) — UNE seule
    // implémentation de la comparaison cache/réel, pour ne pas la dupliquer et risquer de la
    // corriger à un seul endroit la prochaine fois (déjà vécu avec le bug de plage de dates).
    // Retourne soit { error, url? }, soit un objet complet avec `match` et les deux raretés.
    async function computeCardRarityDrift(title) {
        const [cached, real] = await Promise.all([
            fetchCachedCardStats(title),
            fetchRealMonthlyViews(title)
        ]);
        if (!cached) return { title, error: 'carte introuvable dans le catalogue WikiMasters (titre exact ?)' };
        if (real.error) return { title, error: real.error, url: real.url };
        const cachedRarity = (cached.rarity || '?').toUpperCase();
        const impliedRarity = rarityFromMonthlyViews(real.views);
        return {
            title, cachedRarity, cachedViews: cached.pageviews ?? null,
            staleness: fmtAgoRarity(cached.pageviews_refreshed_at),
            realViews: real.views, monthStamp: real.monthStamp, impliedRarity,
            match: impliedRarity === cachedRarity
        };
    }

    function logRarityDriftResult(row) {
        if (row.error) {
            wmLog(`🔭 <b>${row.title}</b> : échec · <span style="color:#ef4444;">${row.error}</span>${row.url ? ` <span style="color:#555;font-size:9px;">(${row.url})</span>` : ''}`);
            if (/failed to fetch|typeerror/i.test(row.error)) {
                wmLog(`🔭 Ouvre F12 → Console, regarde s'il y a une ligne rouge <b>CORS</b> ou <b>Content Security Policy</b> — ça confirme un blocage par la page (le script tourne en @grant none, sans moyen natif de le contourner).`);
            }
            return;
        }
        const dir = row.match ? '' : (RARITY_ORDER[row.impliedRarity] > RARITY_ORDER[row.cachedRarity] ? ' ⬆️ va probablement MONTER' : ' ⬇️ va probablement descendre');
        wmLog(row.match
            ? `🔭 ✅ <b>${row.title}</b> : WikiMasters dit <b>${row.cachedRarity}</b>, vues réelles (${row.realViews.toLocaleString('fr-FR')}/mois) impliquent aussi <b>${row.impliedRarity}</b> — cohérent.`
            : `🔭 ⚠️ <b>${row.title}</b> : WikiMasters dit <b>${row.cachedRarity}</b> (cache vieux de ${row.staleness}, ${row.cachedViews ?? '?'} vues mémorisées), mais les vues RÉELLES actuelles (${row.realViews.toLocaleString('fr-FR')}/mois) impliquent <b style="color:#fbbf24;">${row.impliedRarity}</b>.${dir}`);
    }

    // Console : wmCheckRarityDrift('Anatolie') ou wmCheckRarityDrift(['Anatolie', 'Autre titre'])
    window.wmCheckRarityDrift = async function(titles) {
        const list = (Array.isArray(titles) ? titles : [titles]).filter(t => typeof t === 'string' && t.trim());
        if (list.length === 0) {
            wmLog(`🔭 Dérive de rareté : indique au moins un titre d'article exact. Ex. <code>wmCheckRarityDrift('Anatolie')</code>`);
            return;
        }
        const results = [];
        for (const title of list) {
            wmLog(`🔭 Vérification : <b>${title}</b>…`);
            const row = await computeCardRarityDrift(title);
            results.push(row);
            logRarityDriftResult(row);
        }
        console.table(results);
        wmLog(`🔭 Terminé — détail complet dans <code>console.table</code> ci-dessus (F12 → Console).`);
        return results;
    };

    /* ── Bouton 🔭 par enchère (Market Watcher) ──
       Sur demande explicite (clic), pas automatique : contrairement au badge de valorisation
       (queueSalesFetch, pré-chargé pour toutes les annonces visibles), ce contrôle coûte DEUX
       appels réseau par carte — inutile de les déclencher pour des dizaines d'annonces que
       l'utilisateur ne compte pas forcément enchérir. Cache court (5 min) : évite de re-fetcher
       si la carte réapparaît après un re-tri ou un double-clic accidentel.
       IMPORTANT : ce cache est aussi ce qui permet au badge de SURVIVRE aux re-renders. Le
       Market Watcher redessine toutes les lignes très souvent (scan ~10s, hot lane encore plus
       vite sur une enchère suivie) — un badge écrit uniquement dans le DOM (sans être aussi lu
       depuis ce cache au moment du rendu de la ligne) disparaîtrait au prochain redessin,
       quelques secondes après le clic. `renderMarketHits` lit `_rarityDriftCache` pour
       ré-injecter le badge à chaque génération de ligne, tant que l'entrée n'a pas expiré. */
    const _rarityDriftCache = new Map(); // title -> { row, ts }
    const RARITY_DRIFT_CACHE_MS = 5 * 60 * 1000;

    // Pure (aucune écriture DOM) : utilisée à la fois par le rendu de ligne (ré-injection après
    // un redessin) et par le handler de clic (écriture DOM directe, sans attendre le prochain
    // redessin).
    function rarityDriftBadgeHtml(row) {
        if (!row) return '';
        if (row.error) {
            return `<span style="color:#ef4444;font-size:9px;cursor:help;" title="${String(row.error).replace(/"/g, '&quot;')}">⚠️ erreur</span>`;
        }
        if (row.match) {
            return `<span style="color:#4ade80;font-size:9px;cursor:help;"
                title="Vues Wikipédia réelles (${row.realViews.toLocaleString('fr-FR')}/mois, ${row.monthStamp.slice(4,6)}/${row.monthStamp.slice(0,4)}) cohérentes avec la rareté ${row.cachedRarity} affichée. Cache WikiMasters vieux de ${row.staleness}.">✅ stable</span>`;
        }
        const up = RARITY_ORDER[row.impliedRarity] > RARITY_ORDER[row.cachedRarity];
        return `<span style="color:${up ? '#fbbf24' : '#888'};font-size:9px;font-weight:700;cursor:help;"
            title="WikiMasters affiche ${row.cachedRarity} (cache vieux de ${row.staleness}, ${row.cachedViews ?? '?'} vues mémorisées). Les vues Wikipédia réelles du dernier mois complet (${row.realViews.toLocaleString('fr-FR')}) correspondent plutôt à ${row.impliedRarity}.">
            ${up ? '⬆️' : '⬇️'} ${row.impliedRarity} bientôt ?</span>`;
    }
    // Lit le cache pour un titre donné (entrée valide ou null) — utilisé au moment du RENDU de
    // la ligne, pour que le badge survive à un redessin sans re-déclencher les requêtes réseau.
    function cachedRarityDriftRow(title) {
        const entry = title ? _rarityDriftCache.get(title) : null;
        return (entry && Date.now() - entry.ts < RARITY_DRIFT_CACHE_MS) ? entry.row : null;
    }

    window.wmCheckAuctionRarity = async function(auctionId, btn) {
        const hit = activeHitsMap.get(auctionId);
        const a = hit && hit.auction;
        const title = a && a.card && a.card.wikipedia_title;
        const el = document.getElementById('wm-raritydrift-' + auctionId);
        if (!title) { if (el) el.innerHTML = '<span style="color:#666;font-size:9px;">titre inconnu</span>'; return; }

        const cachedRow = cachedRarityDriftRow(title);
        if (cachedRow) {
            if (el) el.innerHTML = rarityDriftBadgeHtml(cachedRow);
            return;
        }

        if (btn) btn.disabled = true;
        if (el) el.innerHTML = '<span style="color:#888;font-size:9px;">⏳…</span>';
        const row = await computeCardRarityDrift(title);
        _rarityDriftCache.set(title, { row, ts: Date.now() });
        if (btn) btn.disabled = false;
        if (el) el.innerHTML = rarityDriftBadgeHtml(row);
        logRarityDriftResult(row); // garde une trace dans le log, cohérent avec le reste du bot
    };

    /* ══════════ Diagnostic : quota localStorage ══════════
       Une écriture (ex. Chasseur ciblé) peut échouer en silence — `catch(e) {}` partout dans
       ce fichier — sans qu'aucun signe visible n'apparaisse, hormis l'absence de la donnée
       après coup. Ce test essaie une écriture RÉELLE (une clé jetable, retirée juste après) :
       si elle échoue, c'est très probablement le quota (~5-10 Mo/origine selon le navigateur)
       qui est atteint — repère aussi les plus grosses clés existantes pour savoir lesquelles
       purger. Console : wmStorageUsage() */
    window.wmStorageUsage = function() {
        const rows = [];
        let totalChars = 0;
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            const v = localStorage.getItem(k) || '';
            totalChars += k.length + v.length;
            rows.push({ key: k, approxKB: Math.round(v.length / 1024 * 10) / 10 });
        }
        rows.sort((a, b) => b.approxKB - a.approxKB);
        wmLog(`💾 localStorage : <b>${rows.length}</b> clé(s), <b>${(totalChars / 1024).toFixed(0)} Ko</b> au total (approximatif — 1 caractère ≈ 1 à 2 octets selon le navigateur).`);
        wmLog(`💾 Plus grosses clés : ${rows.slice(0, 8).map(r => `<b>${r.key}</b> (${r.approxKB} Ko)`).join(' · ')}`);
        // Test d'écriture réel : la seule façon de savoir avec certitude si le quota est atteint
        // MAINTENANT (la taille totale seule ne le dit pas avec précision — ça dépend du
        // navigateur et de ce qui est déjà en mémoire).
        const probeKey = 'wm_quota_probe_tmp';
        try {
            localStorage.setItem(probeKey, 'x'.repeat(10000)); // 10 Ko, écriture représentative
            localStorage.removeItem(probeKey);
            wmLog(`💾 ✅ Test d'écriture (10 Ko) réussi — le quota n'est <b>probablement pas</b> la cause.`);
        } catch(e) {
            wmLog(`💾 ⚠️ <b style="color:#ef4444;">Test d'écriture ÉCHOUÉ</b> : ${e.name || 'Erreur'} — ${e.message || 'inconnue'}. Le quota localStorage est très probablement atteint ou dépassé.`);
        }
        console.table(rows);
        return rows;
    };

    // Log debug une seule fois pour ne pas spammer
    let _jwtDebugLogged = false;

    // Remet le tag Trash sur une carte invendue.
    // Utilise un upsert idempotent (on_conflict) — un seul POST suffit.
    // Retry exponentiel sur 500/502/503/504 et erreurs réseau.
    async function reapplyTrashTag(userCardId, attempt = 1) {
        if (!userCardId) return false;
        const tagId = await ensureTrashTagId();
        if (!tagId) {
            wmLog(`⚠️ Re-tag impossible : tag Trash non découvert sur ce compte`);
            return false;
        }
        const MAX_ATTEMPTS = 6; // ~1 + 2 + 4 + 8 + 8 + 8 = ~31s max d'attente cumulée
        const { token, source } = getSupabaseAccessToken();

        // Log de diagnostic au 1er appel (ou si JWT introuvable)
        if (!_jwtDebugLogged) {
            _jwtDebugLogged = true;
            if (token) {
                wmLog(`🔑 JWT Supabase trouvé via <b>${source}</b> (${token.length} chars)`);
            } else {
                wmLog(`⚠️ JWT Supabase introuvable (localStorage + cookies vides) → fallback anon (peut échouer)`);
            }
        }

        const url = `${SUPABASE_URL}/user_card_tags?on_conflict=user_card_id%2Ctag_id&columns=%22user_card_id%22%2C%22tag_id%22`;
        const headers = {
            "apikey": SUPABASE_KEY,
            "Authorization": `Bearer ${token || SUPABASE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "resolution=ignore-duplicates,count=exact,return=minimal"
        };

        try {
            const res = await fetch(url, {
                method: "POST",
                // ⚠️ "omit" et pas "include" : Supabase ne renvoie pas
                // Access-Control-Allow-Credentials, donc include = "Failed to fetch".
                // L'auth se fait via le header Authorization Bearer.
                credentials: "omit",
                headers,
                body: JSON.stringify({ user_card_id: userCardId, tag_id: tagId })
            });

            if (res.ok) return true;

            // Erreur serveur instable → retry avec backoff exponentiel
            if ([500, 502, 503, 504, 429].includes(res.status) && attempt < MAX_ATTEMPTS) {
                const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
                wmLog(`⚠️ Re-tag Trash HTTP ${res.status}, retry ${attempt}/${MAX_ATTEMPTS-1} dans ${(backoff/1000).toFixed(0)}s…`);
                await new Promise(r => setTimeout(r, backoff));
                return reapplyTrashTag(userCardId, attempt + 1);
            }

            // Erreur définitive (401, 403, 400, etc.)
            const body = await res.text().catch(() => '');
            wmLog(`❌ Re-tag Trash échec (HTTP ${res.status})${body ? ' · ' + body.slice(0, 100) : ''}`);
            return false;
        } catch(e) {
            // Erreur réseau → retry aussi
            if (attempt < MAX_ATTEMPTS) {
                const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
                wmLog(`⚠️ Re-tag Trash exception (${e.message}), retry ${attempt}/${MAX_ATTEMPTS-1} dans ${(backoff/1000).toFixed(0)}s…`);
                await new Promise(r => setTimeout(r, backoff));
                return reapplyTrashTag(userCardId, attempt + 1);
            }
            wmLog(`❌ Re-tag Trash exception finale : ${e.message}`);
            return false;
        }
    }

    // Réconciliation des ventes en attente — robuste à l'extinction du PC pendant les
    // enchères. Contrairement à checkSellHistoryResults (qui dépend de l'endpoint history,
    // potentiellement tronqué pour d'anciennes enchères), on se fie à la COLLECTION RÉELLE :
    // pour chaque vente "pending" dont l'enchère n'est PLUS active, si la carte est de nouveau
    // à nous (revenue invendue) et sans le tag Trash → on remet le tag. Si elle n'est plus à
    // nous → vendue. Appelée au démarrage + périodiquement.
    let _reconcileRunning = false;
    async function reconcilePendingSales() {
        if (_reconcileRunning) return;
        const pending = sellHistory.filter(s => s.status === 'pending' && s.auctionId);
        if (pending.length === 0 || !navigator.onLine) return;
        _reconcileRunning = true;
        try {
            // Interroge `auctions` UNIQUEMENT sur les IDs qui nous intéressent, plutôt que
            // les listes complètes disparues de /mine — exact, et sans plafond de troncature.
            const byId = await fetchAuctionsByIds(pending.map(s => s.auctionId));
            if (!byId) return; // échec réseau/RLS → on retentera au prochain passage

            const retagOn = getSetting('autoRetagEnabled');
            let changed = false, retagged = 0, soldN = 0;

            for (const s of pending) {
                const h = byId.get(s.auctionId);
                if (auctionRowStillActive(h)) continue; // toujours en vente → on laisse

                // 1) Vendue (gagnant/prix connu en base) → on clôt (stats), pas de retag.
                if (auctionRowSettledSold(h)) {
                    s.status = 'sold';
                    creditSoldSale(s, h.final_price ?? s.finalPrice ?? null);
                    changed = true; soldN++;
                    continue;
                }

                // 2) Enchère terminée (invendue selon l'historique, OU historique trop ancien
                //    pour la connaître). On tranche via la COLLECTION : la carte est-elle revenue ?
                if (!s.cardId) { continue; } // sans id catalogue, on ne peut pas retrouver l'exemplaire
                const targetId = await findCurrentUserCardId(s.cardId, s.title);
                if (!targetId) {
                    // Plus dans la collection → considérée vendue (prix inconnu si absent de l'historique).
                    s.status = 'sold';
                    if (h && Number.isFinite(h.final_price)) creditSoldSale(s, h.final_price);
                    changed = true; soldN++;
                    continue;
                }
                // La carte est revenue invendue.
                s.status = 'unsold';
                creditUnsoldSale(s);
                changed = true;
                if (retagOn) {
                    const ok = await reapplyTrashTag(targetId); // idempotent
                    if (ok) { incrementRetagCount(s.cardId, s.title, s.rarity); retagged++; }
                    else wmLog(`⚠️ Reprise démarrage : re-tag échoué pour <b>${s.title}</b>`);
                }
            }

            if (changed) { saveSellHistory(); renderSellHistory(); }
            if (retagged > 0) {
                wmLog(`🏷️ Reprise au démarrage : tag Trash remis sur <b>${retagged}</b> carte(s) revenue(s) invendue(s) pendant ton absence.`);
            }
        } finally {
            _reconcileRunning = false;
        }
    }

    async function checkSellHistoryResults() {
        const pending = sellHistory.filter(s => s.status === 'pending' && s.auctionId);
        if (pending.length === 0) return;
        try {
            // Ex-`data.history` de /mine, disparu : lecture par ID exact sur `auctions`.
            const byId = await fetchAuctionsByIds(pending.map(s => s.auctionId));
            if (!byId) return; // échec réseau/RLS → réessai au prochain passage (15s)
            let changed = false;
            pending.forEach(s => {
                const match = byId.get(s.auctionId);
                // Une ligne encore active n'est pas une conclusion : on la laisse pending,
                // reconcilePendingSales tranchera plus tard via la collection si besoin.
                if (match && !auctionRowStillActive(match)) {
                    s.status     = auctionRowSettledSold(match) ? 'sold' : 'unsold';
                    s.finalPrice = match.final_price ?? null;
                    changed      = true;

                    if (s.status === 'sold') {
                        creditSoldSale(s, null);
                        const gain = (s.finalPrice || 0) - s.price;
                        const gainStr = gain > 0 ? ` <span style="color:#4ade80;">(+${gain} 💰 🔥)</span>` : '';
                        wmLog(`💰 Vendu : <b>${s.title}</b> [${s.rarity}] · base ${s.price} → <span style="color:#fbbf24;">${s.finalPrice} 💰</span>${gainStr}`);
                        sendToDiscord(
                            "💰 **VENDU !**\n" +
                            "**" + s.title + "** [" + s.rarity + "]\n" +
                            "Base : " + s.price + " 💰 → Vendu : **" + s.finalPrice + " 💰**" +
                            (gain > 0 ? " (+" + gain + " 💰 🔥)" : ""),
                            5763719
                        );
                    } else {
                        // Si l'entrée a été purgée entre-temps (annulation utilisateur),
                        // on ne loggue pas Invendu et on ne déclenche pas le retag.
                        if (!sellHistory.some(h => h.auctionId === s.auctionId)) return;
                        creditUnsoldSale(s);
                        wmLog(`📭 Invendu : <b>${s.title}</b> [${s.rarity}] · base ${s.price} 💰`);
                        // Skip le retag si désactivé dans Paramètres
                        if (!getSetting('autoRetagEnabled')) return;
                        // Le user_card_id d'origine peut être stale (transfert lors du listing)
                        // → on cherche le user_card_id actuel via le card_id catalogue (stable)
                        (async () => {
                            // Re-check juste avant le retag (le purge a pu arriver entre-temps)
                            if (!sellHistory.some(h => h.auctionId === s.auctionId)) return;
                            let targetId = null;
                            let sourceTag = '?';
                            if (s.cardId) {
                                // On a un cardId stable → on FAIT confiance au lookup.
                                // Si le lookup échoue (carte pas revenue ou plus à nous), on abandonne.
                                // Surtout pas de fallback sur userCardId : il est forcément stale après le listing.
                                targetId = await findCurrentUserCardId(s.cardId, s.title);
                                if (targetId) sourceTag = 'lookup';
                            } else if (s.userCardId) {
                                // Fallback uniquement pour vieilles entrées sellHistory pré-fix (sans cardId)
                                targetId = s.userCardId;
                                sourceTag = 'stale-cache';
                            }
                            if (!targetId) {
                                wmLog(`⚠️ Re-tag impossible (carte introuvable) : <b>${s.title}</b>`);
                                return;
                            }
                            // Dernier check avant l'appel réseau au retag
                            if (!sellHistory.some(h => h.auctionId === s.auctionId)) return;
                            const ok = await reapplyTrashTag(targetId);
                            if (ok) {
                                incrementRetagCount(s.cardId, s.title, s.rarity);
                                wmLog(`🏷️ Tag Trash remis : <b>${s.title}</b> [${s.rarity}] <span style="color:#555;font-size:9px;">(${sourceTag})</span>`);
                            } else {
                                wmLog(`💀 Re-tag définitivement échoué : <b>${s.title}</b> · ID tenté : ${targetId.slice(0,8)}… (${sourceTag})`);
                            }
                        })();
                    }
                }
            });
            if (changed) { saveSellHistory(); renderSellHistory(); }
        } catch(e) {}
    }

    function renderSellHistory() {
        const el = document.getElementById('wm-sell-history');
        // Ne compte que les ventes du JOUR (depuis minuit). sellHistory garde tout
        // (pour le retag), mais l'affichage est filtré et fusionné sur la journée.
        const sessionSales = sellHistory.filter(s => (s.timestamp || 0) >= SESSION_SALES_START);
        if (!el || sessionSales.length === 0) {
            if (el) el.innerHTML = '<span style="color:#444;font-size:10px;">Aucune vente aujourd\'hui.</span>';
            return;
        }
        const soldItems    = sessionSales.filter(s => s.status === 'sold');
        const unsoldItems  = sessionSales.filter(s => s.status === 'unsold');
        const pendingItems = sessionSales.filter(s => s.status === 'pending');
        const totalGained  = soldItems.reduce((a, b) => a + (b.finalPrice || b.price), 0);

        // Stats par rareté — moyenne du PRIX RÉEL de vente (finalPrice), pas du prix de base
        const byRarity = {};
        soldItems.forEach(s => {
            // Normalisée à la création, mais de vieilles entrées persistées peuvent être en
            // minuscules : sans ça « SR » et « sr » feraient deux colonnes distinctes.
            const r = (s.rarity || '').toUpperCase();
            if (!byRarity[r]) byRarity[r] = { count: 0, total: 0 };
            byRarity[r].count++;
            byRarity[r].total += (s.finalPrice ?? s.price);
        });

        // Toujours de la plus rare à la plus commune (L → C). Sans ce tri, Object.entries
        // rendait dans l'ordre d'ARRIVÉE des ventes : l'ordre changeait à chaque vente.
        // Une rareté inconnue (hors RARITY_ORDER) atterrit en fin de ligne plutôt que
        // de disparaître.
        const rarityRows = Object.entries(byRarity)
            .sort((a, b) => (RARITY_ORDER[b[0]] ?? -1) - (RARITY_ORDER[a[0]] ?? -1))
            .map(([r, d]) => {
                const rc = RARITY[r] || { color: "#aaa" };
                return `<span style="color:${rc.color};font-size:10px;">${r}: ${d.count} (moy. ${Math.round(d.total/d.count)}💰)</span>`;
            }).join(' · ');

        const settled = soldItems.length + unsoldItems.length;
        const txRate  = settled > 0 ? Math.round((soldItems.length / settled) * 100) : 0;

        el.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <span style="color:#4ade80;font-weight:700;font-size:12px;">+${totalGained} 💰</span>
                <span style="color:#888;font-size:10px;">
                    ${soldItems.length}✔ / ${unsoldItems.length}✗${pendingItems.length > 0 ? ` / ${pendingItems.length}⏳` : ''} · ${txRate}% vendues
                </span>
            </div>
            <div style="line-height:1.8;">${rarityRows || '<span style="color:#444;font-size:10px;">—</span>'}</div>`;
    }

    /* ===================== UI ===================== */

    // Rendu du panneau de statistiques cumulées (3 sections : Ventes, Packs, Invendues)
    function renderStatsPanel() {
        const el = document.getElementById('wm-stats-content');
        if (!el) return;

        const fmt = (n) => Number(n || 0).toLocaleString('fr-FR');
        const order = ['L', 'UR', 'SR', 'R', 'PC', 'C'];

        // Barre horizontale proportionnelle
        const bar = (value, max, color) => {
            const pct = max > 0 ? Math.round((value / max) * 100) : 0;
            return `<div style="flex:1;height:8px;background:rgba(255,255,255,0.05);border-radius:4px;overflow:hidden;min-width:40px;">
                <div style="width:${pct}%;height:100%;background:${color};border-radius:4px;transition:width 0.3s;"></div>
            </div>`;
        };

        // ── Section 1 : VENTES ──
        const sold = lifetimeStats.sold, unsold = lifetimeStats.unsold;
        const settled = sold + unsold;
        const txRate = settled > 0 ? Math.round((sold / settled) * 100) : 0;
        const ventesRarity = order
            .filter(r => lifetimeStats.byRarity[r]?.sold > 0)
            .map(r => {
                const d = lifetimeStats.byRarity[r];
                const rc = RARITY[r] || { color: '#888' };
                const maxSold = Math.max(...order.map(x => lifetimeStats.byRarity[x]?.sold || 0), 1);
                return `<div style="display:flex;align-items:center;gap:6px;margin:3px 0;">
                    <span style="color:${rc.color};font-weight:700;font-size:9px;min-width:24px;">${r}</span>
                    ${bar(d.sold, maxSold, rc.color)}
                    <span style="color:#bbb;font-size:9px;min-width:80px;text-align:right;">${fmt(d.sold)} · ${fmt(d.gain)} 💰</span>
                </div>`;
            }).join('');

        // ── Section 2 : PACKS ──
        const totalDrops = order.reduce((s, r) => s + (rarityStats[r] || 0), 0);

        const packsRows = order.map(r => {
            const count = rarityStats[r] || 0;
            const rc = RARITY[r] || { color: '#888' };
            const frac = totalDrops > 0 ? count / totalDrops : 0;
            const pct = (frac * 100).toFixed(2);
            // Barre = vrai pourcentage de remplissage (comme le Pack Opener)
            const barW = (frac * 100);
            // Estimation : combien de packs en moyenne pour obtenir 1 carte de cette rareté
            const perPackRate = totalPacks > 0 ? count / totalPacks : 0;
            const packsPerCard = perPackRate > 0 ? (1 / perPackRate) : null;
            const estim = packsPerCard
                ? (packsPerCard < 1.5
                    ? `≈${(perPackRate).toFixed(1)}/pack`
                    : `1 tous les ${packsPerCard < 10 ? packsPerCard.toFixed(1) : Math.round(packsPerCard)} packs`)
                : '—';
            return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
                <td style="padding:4px 6px;"><span style="color:${rc.color};font-weight:700;font-size:10px;">${r}</span></td>
                <td style="padding:4px 6px;width:35%;">
                    <div style="height:7px;background:rgba(255,255,255,0.05);border-radius:4px;overflow:hidden;">
                        <div style="width:${barW.toFixed(1)}%;height:100%;background:${rc.color};border-radius:4px;"></div>
                    </div>
                </td>
                <td style="padding:4px 6px;text-align:right;color:#bbb;font-size:9px;font-family:'JetBrains Mono',monospace;">${fmt(count)}</td>
                <td style="padding:4px 6px;text-align:right;color:${rc.color};font-size:9px;font-family:'JetBrains Mono',monospace;font-weight:700;">${pct}%</td>
                <td style="padding:4px 6px;text-align:right;color:#888;font-size:9px;white-space:nowrap;">${estim}</td>
            </tr>`;
        }).join('');

        const packsRarity = `
            <table style="width:100%;border-collapse:collapse;margin-top:4px;">
                <thead>
                    <tr style="color:#555;font-size:8px;text-transform:uppercase;letter-spacing:0.5px;">
                        <th style="text-align:left;padding:2px 6px;font-weight:600;">Rar.</th>
                        <th style="text-align:left;padding:2px 6px;font-weight:600;">Distribution</th>
                        <th style="text-align:right;padding:2px 6px;font-weight:600;">Nb</th>
                        <th style="text-align:right;padding:2px 6px;font-weight:600;">Taux</th>
                        <th style="text-align:right;padding:2px 6px;font-weight:600;">Fréquence</th>
                    </tr>
                </thead>
                <tbody>${packsRows}</tbody>
            </table>`;

        // ── Section 3 : INVENDUES (top cartes collantes) ──
        const retagEntries = Object.values(retagCounts).filter(e => e.count > 0).sort((a, b) => b.count - a.count);
        const totalRetags = totalRetagCount();
        const maxRetag = retagEntries.length ? retagEntries[0].count : 1;
        const topRetag = retagEntries.slice(0, 8).map(e => {
            const rc = RARITY[(e.rarity || '').toUpperCase()] || { color: '#888' };
            return `<div style="display:flex;align-items:center;gap:6px;margin:3px 0;">
                <span style="color:${rc.color};font-weight:700;font-size:9px;min-width:24px;">${(e.rarity || '').toUpperCase()}</span>
                <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ccc;font-size:9px;" title="${e.title}">${e.title}</span>
                ${bar(e.count, maxRetag, '#fbbf24')}
                <span style="color:#fbbf24;font-weight:700;font-size:9px;min-width:28px;text-align:right;">🔁${e.count}</span>
            </div>`;
        }).join('');

        const sectionTitle = (t) => `<div style="font-size:10px;color:#06b6d4;text-transform:uppercase;letter-spacing:1px;margin:12px 0 6px;font-weight:600;">${t}</div>`;
        const kpi = (label, value, color) => `<div style="flex:1;text-align:center;padding:6px 4px;background:rgba(255,255,255,0.03);border-radius:6px;">
            <div style="color:${color};font-weight:700;font-size:14px;font-family:'JetBrains Mono',monospace;">${value}</div>
            <div style="color:#666;font-size:8px;text-transform:uppercase;letter-spacing:0.5px;margin-top:2px;">${label}</div>
        </div>`;

        // ── Section 4 : DERNIÈRES SESSIONS ──
        const fmtDuration = (ms) => {
            const totalMin = Math.floor(ms / 60000);
            const h = Math.floor(totalMin / 60);
            const m = totalMin % 60;
            return h > 0 ? `${h}h ${String(m).padStart(2,'0')}m` : `${m}m`;
        };
        const fmtDate = (ts) => {
            const d = new Date(ts);
            return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        };
        // La session courante est désormais écrite au fil de l'eau : on la signale comme
        // « en cours » pour qu'elle ne soit pas prise pour une session déjà close.
        const sessionsRows = [...sessionHistory].reverse().slice(0, 10).map(s => {
            const live = s.id && s.id === sessionMetrics.id;
            const netColor = s.net >= 0 ? '#4ade80' : '#ef4444';
            const netSign = s.net >= 0 ? '+' : '';
            const sep = '<span style="color:#444;">|</span>';
            const parts = [
                `<span style="color:#22c55e;">📦 ${fmt(s.packsOpened)}</span>`,
                `<span style="color:#4ade80;">${fmt(s.sales)} vente${s.sales > 1 ? 's' : ''} +${fmt(s.salesGain)} 💰</span>`,
            ];
            if (s.bidsWon > 0) {
                parts.push(`<span style="color:#ef4444;">${fmt(s.bidsWon)} achat${s.bidsWon > 1 ? 's' : ''} -${fmt(s.bidsSpent)} 💰</span>`);
            }
            parts.push(`<span style="color:${netColor};font-weight:700;">Net ${netSign}${fmt(s.net)} 💰</span>`);
            // Ligne répartition par rareté (si données disponibles et au moins 1 carte)
            let rarityLine = '';
            if (s.rarities) {
                const ord = ['L', 'UR', 'SR', 'R', 'PC', 'C'];
                const totalCards = ord.reduce((sum, r) => sum + (s.rarities[r] || 0), 0);
                if (totalCards > 0) {
                    const rarParts = ord
                        .filter(r => (s.rarities[r] || 0) > 0)
                        .map(r => {
                            const rc = RARITY[r] || { color: '#888' };
                            return `<span style="color:${rc.color};font-weight:700;">${r}</span> <span style="color:#999;">${fmt(s.rarities[r])}</span>`;
                        });
                    rarityLine = `<div style="display:flex;flex-wrap:wrap;gap:5px;font-size:9px;margin-top:3px;color:#666;">
                        🃏 ${rarParts.join('<span style="color:#333;">·</span>')}
                    </div>`;
                }
            }
            return `<div style="padding:6px;margin-bottom:4px;background:rgba(255,255,255,0.02);border-radius:6px;border:1px solid rgba(255,255,255,0.04);">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
                    <span style="color:#888;font-size:9px;">${fmtDate(s.end)}${live ? ' <span style="color:#4ade80;font-weight:700;">● en cours</span>' : ''}</span>
                    <span style="color:#666;font-size:9px;">⏱ ${fmtDuration(s.durationMs)}</span>
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:6px;font-size:9px;align-items:center;">
                    ${parts.join(sep)}
                </div>
                ${rarityLine}
            </div>`;
        }).join('');

        el.innerHTML = `
            ${sectionTitle('💰 Ventes')}
            <div style="display:flex;gap:6px;margin-bottom:8px;">
                ${kpi('Vendues', fmt(sold), '#4ade80')}
                ${kpi('Invendues', fmt(unsold), '#ef4444')}
                ${kpi('Taux', txRate + '%', '#06b6d4')}
                ${kpi('Gains 💰', fmt(lifetimeStats.gain), '#fbbf24')}
            </div>
            ${ventesRarity || '<div style="color:#444;font-size:10px;font-style:italic;">Aucune vente enregistrée</div>'}

            <!-- Ventes et achats côte à côte dès que le panneau est assez large (il est
                 redimensionnable), empilés sinon : auto-fit s'en charge sans media query. -->
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:0 12px;">
                <div style="min-width:0;">
                    ${sectionTitle('🧾 Historique des ventes')}
                    <div id="wm-sold-list" style="max-height:280px;overflow-y:auto;scrollbar-width:thin;">
                        <div style="color:#444;font-size:10px;font-style:italic;">Chargement des ventes…</div>
                    </div>
                </div>
                <div style="min-width:0;">
                    ${sectionTitle('🛍️ Historique des achats')}
                    <div id="wm-buy-list" style="max-height:280px;overflow-y:auto;scrollbar-width:thin;">
                        <div style="color:#444;font-size:10px;font-style:italic;">Chargement des achats…</div>
                    </div>
                </div>
            </div>

            ${sectionTitle('📦 Packs')}
            <div style="display:flex;gap:6px;margin-bottom:8px;">
                ${kpi('Packs ouverts', fmt(totalPacks), '#22c55e')}
                ${kpi('Cartes', fmt(totalDrops), '#06b6d4')}
            </div>
            ${totalDrops > 0 ? packsRarity : '<div style="color:#444;font-size:10px;font-style:italic;">Aucun pack ouvert</div>'}

            ${sectionTitle('🔁 Invendues récurrentes')}
            <div style="display:flex;gap:6px;margin-bottom:8px;">
                ${kpi('Remises au total', fmt(totalRetags), '#fbbf24')}
                ${kpi('Cartes concernées', fmt(retagEntries.length), '#888')}
                ${kpi('Moy. / carte', retagEntries.length > 0 ? (totalRetags / retagEntries.length).toFixed(1) : '0', '#06b6d4')}
            </div>
            ${topRetag || '<div style="color:#444;font-size:10px;font-style:italic;">Aucune carte invendue</div>'}

            ${sectionTitle('🩺 Santé du bot')}
            ${(() => {
                const fmtAgo = (ts) => { if (!ts) return '—'; const s = Math.round((Date.now() - ts) / 1000); if (s < 60) return `${s}s`; const m = Math.floor(s / 60); if (m < 60) return `${m} min`; return `${Math.floor(m / 60)} h`; };
                const clockOk = serverClockSynced && Math.abs(serverClockOffset) < 2000;
                const clockVal = serverClockSynced ? `${(serverClockOffset / 1000).toFixed(1)}s` : 'n/a';
                const totalErr = apiHealth.err429 + apiHealth.err5xx + apiHealth.errNet;
                return `<div style="display:flex;gap:6px;margin-bottom:8px;">
                    ${kpi('Horloge Δ', clockVal, clockOk ? '#4ade80' : '#fbbf24')}
                    ${kpi('Erreurs API', fmt(totalErr), totalErr === 0 ? '#4ade80' : (totalErr < 20 ? '#fbbf24' : '#ef4444'))}
                </div>
                <div style="font-size:10px;color:#888;line-height:1.7;">
                    Dernier scan marché : <b style="color:#ccc;">${fmtAgo(apiHealth.lastMarketScanTs)}</b><br>
                    Dernier scan collection : <b style="color:#ccc;">${fmtAgo(apiHealth.lastCollectionTs)}</b><br>
                    Erreurs : <span style="color:#fbbf24;">429×${apiHealth.err429}</span> · <span style="color:#ef4444;">5xx×${apiHealth.err5xx}</span> · <span style="color:#f97316;">réseau×${apiHealth.errNet}</span>${apiHealth.lastErrTs ? ` <span style="color:#666;">(dernière ${fmtAgo(apiHealth.lastErrTs)} : ${String(apiHealth.lastErrMsg).replace(/</g, '&lt;')})</span>` : ''}
                </div>`;
            })()}

            ${sectionTitle('🕓 Dernières sessions')}
            ${sessionsRows || '<div style="color:#444;font-size:10px;font-style:italic;">Aucune session enregistrée pour le moment</div>'}
        `;

        // Remplit les listes détaillées en arrière-plan. /mine ne renvoyant plus ni `history`
        // ni `won`, les deux historiques sont relus directement en base (une requête chacun).
        (async () => {
            if (!navigator.onLine) { renderSoldList([]); renderBuyList([]); return; }
            const [sold, won] = await Promise.all([
                fetchSoldFromDb(300).catch(() => null),
                fetchWonFromDb(300).catch(() => null)
            ]);
            // null = lecture impossible → on passe [] : les archives LOCALES prennent le relais
            // dans les deux fonctions, elles n'affichent jamais une liste vide à tort.
            renderSoldList(sold || []);
            renderBuyList(won || []);
        })();
    }

    // Historique des ACHATS : archive locale d'abord (elle dépasse la fenêtre du serveur),
    // rafraîchie au passage par le snapshot serveur courant pour capter les tout derniers.
    function renderBuyList(serverWon) {
        const el = document.getElementById('wm-buy-list');
        if (!el) return;
        // Le snapshot serveur vient compléter l'archive avant affichage.
        let added = 0;
        (Array.isArray(serverWon) ? serverWon : []).forEach(w => { if (recordPurchase(w)) added++; });
        if (added > 0) saveBuyHistory();
        const elNow = el;
        if (buyHistory.length === 0) {
            elNow.innerHTML = `<div style="color:#444;font-size:10px;font-style:italic;">Aucun achat enregistré.</div>`;
            return;
        }
        const fmt = (n) => (n == null ? '?' : Number(n).toLocaleString('fr-FR'));
        const fmtDate = (ts) => {
            if (!ts) return '';
            const d = new Date(ts);
            return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        };
        const bought = [...buyHistory].sort((a, b) => (b.boughtAt || 0) - (a.boughtAt || 0));
        const totalSpent = bought.reduce((s, x) => s + (Number(x.price) || 0), 0);
        const header = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;font-size:10px;">
            <span style="color:#888;">${bought.length} achat(s)</span>
            <span style="color:#ef4444;font-weight:700;">−${fmt(totalSpent)} 💰 dépensés</span>
        </div>`;
        const rows = bought.slice(0, 300).map(b => {
            const rc = RARITY[b.rarity] || { color: '#888' };
            // Écart au prix de départ = ce que la surenchère a coûté au-dessus de la mise à prix.
            const over = (Number(b.price) || 0) - (Number(b.base) || 0);
            const overStr = (b.base != null && b.price != null && over > 0)
                ? `<span style="color:#f97316;" title="Payé ${fmt(over)} 💰 au-dessus du prix de départ">+${fmt(over)}</span>`
                : `<span style="color:#666;">=</span>`;
            const titleHtml = `<a href="https://www.wiki-masters.com/marketplace/${encodeURIComponent(b.id)}" target="_blank" rel="noopener"
                title="Ouvrir l'enchère : ${htmlEsc(b.title)}${b.seller ? ' · vendu par ' + htmlEsc(b.seller) : ''}"
                style="color:#8ab4f8;text-decoration:none;">${htmlEsc(b.title)} <span style="font-size:8px;opacity:0.7;">🔗</span></a>`;
            return `<div style="display:flex;align-items:center;gap:6px;padding:3px 4px;border-bottom:1px solid rgba(255,255,255,0.04);font-size:10px;">
                <span style="color:#666;font-size:9px;font-family:'JetBrains Mono',monospace;white-space:nowrap;min-width:64px;">${fmtDate(b.boughtAt)}</span>
                <span style="color:${rc.color};font-weight:700;font-size:9px;min-width:22px;">${b.rarity || '?'}</span>
                <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ccc;">${titleHtml}</span>
                <span style="color:#888;white-space:nowrap;font-size:9px;">${fmt(b.base)}→</span>
                <span style="color:#ef4444;font-weight:700;white-space:nowrap;">${fmt(b.price)} 💰</span>
                <span style="white-space:nowrap;font-size:9px;min-width:34px;text-align:right;">${overStr}</span>
            </div>`;
        }).join('');
        elNow.innerHTML = header + rows + (bought.length > 300
            ? `<div style="color:#888;font-size:10px;padding:4px 0;text-align:center;">… ${bought.length - 300} plus anciens non affichés</div>`
            : '');
    }

    // Construit la liste des cartes VENDUES : fusion de l'historique serveur
    // (/marketplace/mine → history settled_sold, inclut les ventes manuelles) et du
    // sellHistory local (ventes du bot), dédupliqué par auctionId, trié du + récent au + ancien.
    function buildSoldHistory(serverHistory) {
        const map = new Map();
        // Local (bot) d'abord
        sellHistory.filter(s => s.status === 'sold').forEach(s => {
            const id = s.auctionId || ('local-' + s.timestamp);
            map.set(id, {
                id: s.auctionId || null,   // id réel de l'enchère (null si vente locale sans id)
                title: s.title || '?',
                rarity: (s.rarity || '').toUpperCase(),
                base: Number.isFinite(s.price) ? s.price : null,
                final: Number.isFinite(s.finalPrice) ? s.finalPrice : (Number.isFinite(s.price) ? s.price : null),
                soldAt: s.timestamp || 0
            });
        });
        // Serveur ensuite (fait autorité : inclut les ventes hors bot, prix final réel).
        // Le test ne porte plus sur le libellé exact `settled_sold` : les lignes viennent
        // désormais de la table `auctions`, dont la valeur de `status` n'est pas garantie.
        // Un gagnant ou un prix final suffit à qualifier une vente conclue.
        (serverHistory || []).filter(h => h && (
            h.status === 'settled_sold' || h.winner_id != null || Number.isFinite(h.final_price)
        )).forEach(h => {
            map.set(h.id, {
                id: h.id,
                title: h.card?.wikipedia_title || '?',
                rarity: (h.snapshot_rarity || h.card?.rarity || '').toUpperCase(),
                base: h.listing_base_amount ?? h.base_amount ?? null,
                final: h.final_price ?? h.current_bid ?? null,
                soldAt: h.settled_at ? new Date(h.settled_at).getTime() : Date.now()
            });
        });
        return [...map.values()].sort((a, b) => (b.soldAt || 0) - (a.soldAt || 0));
    }

    function renderSoldList(serverHistory) {
        const el = document.getElementById('wm-sold-list');
        if (!el) return;
        const sold = buildSoldHistory(serverHistory || []);
        const elNow = el;
        if (sold.length === 0) {
            elNow.innerHTML = '<div style="color:#444;font-size:10px;font-style:italic;">Aucune vente enregistrée.</div>';
            return;
        }
        const fmt = (n) => (n == null ? '?' : Number(n).toLocaleString('fr-FR'));
        const fmtDate = (ts) => {
            if (!ts) return '';
            const d = new Date(ts);
            return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        };
        // Récap en-tête : nombre + total encaissé
        const totalFinal = sold.reduce((s, x) => s + (Number(x.final) || 0), 0);
        const header = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;font-size:10px;">
            <span style="color:#888;">${sold.length} vente(s)</span>
            <span style="color:#4ade80;font-weight:700;">+${fmt(totalFinal)} 💰 encaissés</span>
        </div>`;
        const rows = sold.slice(0, 300).map(s => {
            const rc = RARITY[s.rarity] || { color: '#888' };
            const gain = (Number(s.final) || 0) - (Number(s.base) || 0);
            const gainStr = (s.base != null && s.final != null)
                ? (gain > 0
                    ? `<span style="color:#4ade80;">+${fmt(gain)}</span>`
                    : gain < 0 ? `<span style="color:#ef4444;">${fmt(gain)}</span>` : `<span style="color:#666;">=</span>`)
                : '';
            const safeTitle = String(s.title).replace(/"/g, '&quot;');
            const titleHtml = s.id
                ? `<a href="https://www.wiki-masters.com/marketplace/${encodeURIComponent(s.id)}" target="_blank" rel="noopener" title="Ouvrir l'enchère : ${safeTitle}" style="color:#8ab4f8;text-decoration:none;">${s.title} <span style="font-size:8px;opacity:0.7;">🔗</span></a>`
                : `<span title="${safeTitle}">${s.title}</span>`;
            return `<div style="display:flex;align-items:center;gap:6px;padding:3px 4px;border-bottom:1px solid rgba(255,255,255,0.04);font-size:10px;">
                <span style="color:#666;font-size:9px;font-family:'JetBrains Mono',monospace;white-space:nowrap;min-width:64px;">${fmtDate(s.soldAt)}</span>
                <span style="color:${rc.color};font-weight:700;font-size:9px;min-width:22px;">${s.rarity || '?'}</span>
                <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ccc;">${titleHtml}</span>
                <span style="color:#888;white-space:nowrap;font-size:9px;">${fmt(s.base)}→</span>
                <span style="color:#fbbf24;font-weight:700;white-space:nowrap;">${fmt(s.final)} 💰</span>
                <span style="white-space:nowrap;font-size:9px;min-width:34px;text-align:right;">${gainStr}</span>
            </div>`;
        }).join('');
        elNow.innerHTML = header + rows + (sold.length > 300 ? `<div style="color:#888;font-size:10px;padding:4px 0;text-align:center;">… ${sold.length - 300} plus anciennes non affichées</div>` : '');
    }

    function createUI() {

        // Idempotent: si le FAB existe déjà, on ne rebuild pas
        if (document.getElementById('wm-fab')) return;
        if (!document.body) return;

        /* ── Styles ── */
        const style = document.createElement("style");
        style.textContent = `
            @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;700&family=Noto+Sans:wght@400;600&display=swap');
            @keyframes wm-pulse  { 0%,100%{opacity:1} 50%{opacity:0.55} }
            @keyframes wm-fadein { from{opacity:0;transform:translateY(5px)} to{opacity:1;transform:translateY(0)} }
            @keyframes wm-spin   { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }

            #wm-fab {
                position:fixed; bottom:20px; right:20px; z-index:2147483646;
                width:54px; height:54px; border-radius:50%; cursor:pointer;
                background:#0f0f13; border:1px solid rgba(255,255,255,0.12);
                box-shadow:0 4px 20px rgba(0,0,0,0.7);
                display:flex; align-items:center; justify-content:center;
                font-size:22px; transition:transform 0.2s;
            }
            #wm-fab:hover { transform:scale(1.08); }
            #wm-fab-gear { display:inline-block; transition:transform 0.2s; }
            #wm-fab-gear.wm-spin-once { animation:wm-spin 0.5s cubic-bezier(0.4, 0, 0.2, 1); }
            #wm-fab-badge {
                position:absolute; top:-3px; right:-3px;
                min-width:18px; height:18px; padding:0 5px;
                border-radius:10px;
                background:linear-gradient(135deg,#ef4444,#b91c1c);
                color:#fff; font-size:10px; font-weight:700;
                font-family:'JetBrains Mono', monospace;
                display:none; align-items:center; justify-content:center;
                box-shadow:0 2px 6px rgba(239,68,68,0.5);
                line-height:1; box-sizing:border-box;
                animation:wm-pulse 1.5s infinite;
            }
            #wm-fab-badge.show { display:flex; }
            #wm-fab-dots { position:absolute; top:3px; right:3px; display:flex; gap:3px; }
            .wm-dot { width:8px; height:8px; border-radius:50%; background:#222; border:1px solid #07070a; }
            .wm-dot.on { animation:wm-pulse 1.2s infinite; }
            .wm-dot-pack   { background:#22c55e; }
            .wm-dot-market { background:#06b6d4; }
            .wm-dot-trash  { background:#f59e0b; }

            #wm-overlay {
                position:fixed; inset:0; z-index:2147483645;
                /* Pas de backdrop-filter:blur — coûte ~30% GPU en permanence sur écran 4K.
                   Le fond plein opaque suffit pour cacher la page derrière. */
                background:rgba(2,2,4,0.97);
                display:flex; flex-direction:column;
                opacity:0; pointer-events:none; transition:opacity 0.2s;
            }
            #wm-overlay.open { opacity:1; pointer-events:all; }

            #wm-dash-hdr {
                display:flex; align-items:center; gap:14px; flex-shrink:0;
                padding:9px 16px; background:rgba(12,12,16,0.98);
                border-bottom:1px solid rgba(255,255,255,0.07);
            }
            .wm-logo { font-family:'Rajdhani',sans-serif; font-size:17px; font-weight:800; color:#fff; letter-spacing:1px; }
            .wm-logo span { color:#FFD700; }
            .wm-hstats { display:flex; gap:14px; flex:1; }
            .wm-hstat  { font-size:11px; color:#555; white-space:nowrap; }
            .wm-hstat b { color:#bbb; }
            .wm-hctrls { display:flex; gap:7px; }

            #wm-panels {
                display:grid; grid-template-columns:1fr 6px 1fr 6px 1fr;
                gap:0; padding:10px; flex:1; overflow:hidden; min-height:0;
            }
            .wm-col-resizer {
                cursor:col-resize; background:transparent;
                display:flex; align-items:center; justify-content:center;
                transition:background 0.15s; position:relative; z-index:5;
            }
            .wm-col-resizer::before {
                content:''; width:2px; height:40px; border-radius:2px;
                background:rgba(255,255,255,0.12); transition:background 0.15s, height 0.15s;
            }
            .wm-col-resizer:hover::before { background:rgba(6,182,212,0.7); height:60px; }
            .wm-col-resizer.dragging::before { background:rgba(6,182,212,1); height:80px; }
            /* Compense le gap retiré : marge interne sur les panels */
            .wm-panel { margin:0 4px; }
            #wm-settings-panel {
                flex-shrink:0; margin:0 10px 10px;
                background:rgba(12,12,16,0.98); border:1px solid rgba(255,255,255,0.07);
                border-radius:10px; overflow:hidden;
            }
            #wm-settings-hdr {
                padding:8px 13px; font-size:10px; font-weight:700;
                text-transform:uppercase; letter-spacing:1px; color:#888;
                cursor:pointer; background:rgba(255,255,255,0.02);
                display:flex; justify-content:space-between; align-items:center;
                user-select:none; transition:all 0.15s;
            }
            #wm-settings-hdr:hover { background:rgba(255,255,255,0.04); color:#bbb; }
            #wm-settings-body { padding:12px 13px; border-top:1px solid rgba(255,255,255,0.06); display:none; max-height:var(--wm-settings-h, 60vh); overflow-y:auto; }
            #wm-settings-body.open { display:block; }

            /* Poignée de redimensionnement vertical (hauteur) des panneaux accordéon */
            .wm-row-resizer {
                height:7px; cursor:row-resize; display:none;
                align-items:center; justify-content:center;
                background:transparent; transition:background 0.15s;
            }
            .wm-row-resizer.show { display:flex; }
            .wm-row-resizer::before {
                content:''; width:40px; height:2px; border-radius:2px;
                background:rgba(255,255,255,0.12); transition:background 0.15s, width 0.15s;
            }
            .wm-row-resizer:hover::before { background:rgba(6,182,212,0.7); width:70px; }
            .wm-row-resizer.dragging::before { background:rgba(6,182,212,1); width:90px; }
            /* Scrollbar discrète pour la section Paramètres */
            #wm-settings-body::-webkit-scrollbar { width:8px; }
            #wm-settings-body::-webkit-scrollbar-track { background:rgba(0,0,0,0.2); }
            #wm-settings-body::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.12); border-radius:4px; }
            #wm-settings-body::-webkit-scrollbar-thumb:hover { background:rgba(255,255,255,0.2); }
            #wm-settings-body .wm-set-section {
                padding:10px 0; border-bottom:1px solid rgba(255,255,255,0.05);
            }

            /* ── Panneau Statistiques (jumeau du panneau Paramètres) ── */
            #wm-stats-panel {
                flex-shrink:0; margin:0 10px 10px;
                background:rgba(12,12,16,0.98); border:1px solid rgba(255,255,255,0.07);
                border-radius:10px; overflow:hidden;
            }
            #wm-stats-hdr {
                padding:8px 13px; font-size:10px; font-weight:700;
                text-transform:uppercase; letter-spacing:1px; color:#888;
                cursor:pointer; background:rgba(255,255,255,0.02);
                display:flex; justify-content:space-between; align-items:center;
                user-select:none; transition:all 0.15s;
            }
            #wm-stats-hdr:hover { background:rgba(255,255,255,0.04); color:#bbb; }
            #wm-stats-body { padding:12px 13px; border-top:1px solid rgba(255,255,255,0.06); display:none; max-height:var(--wm-stats-h, 60vh); overflow-y:auto; }
            #wm-stats-body.open { display:block; }
            #wm-stats-body::-webkit-scrollbar { width:8px; }
            #wm-stats-body::-webkit-scrollbar-track { background:rgba(0,0,0,0.2); }
            #wm-stats-body::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.12); border-radius:4px; }
            #wm-stats-body::-webkit-scrollbar-thumb:hover { background:rgba(255,255,255,0.2); }

            /* ── Panneau Étiquetage en masse (jumeau du panneau Statistiques) ── */
            #wm-tagger-panel {
                flex-shrink:0; margin:0 10px 10px;
                background:rgba(12,12,16,0.98); border:1px solid rgba(255,255,255,0.07);
                border-radius:10px; overflow:hidden;
            }
            #wm-tagger-hdr {
                padding:8px 13px; font-size:10px; font-weight:700;
                text-transform:uppercase; letter-spacing:1px; color:#888;
                cursor:pointer; background:rgba(255,255,255,0.02);
                display:flex; justify-content:space-between; align-items:center;
                user-select:none; transition:all 0.15s;
            }
            #wm-tagger-hdr:hover { background:rgba(255,255,255,0.04); color:#bbb; }
            #wm-tagger-body { padding:12px 13px; border-top:1px solid rgba(255,255,255,0.06); display:none; max-height:var(--wm-tagger-h, 60vh); overflow-y:auto; }
            #wm-tagger-body.open { display:block; }
            #wm-tagger-body::-webkit-scrollbar { width:8px; }
            #wm-tagger-body::-webkit-scrollbar-track { background:rgba(0,0,0,0.2); }
            #wm-tagger-body::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.12); border-radius:4px; }
            #wm-tagger-body::-webkit-scrollbar-thumb:hover { background:rgba(255,255,255,0.2); }
            #wm-tagger-results::-webkit-scrollbar { width:8px; }
            #wm-tagger-results::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.12); border-radius:4px; }

            #wm-settings-body .wm-set-section:first-child { padding-top:0; }
            #wm-settings-body .wm-set-section:last-child { border-bottom:none; padding-bottom:0; }
            #wm-settings-body .wm-set-title {
                font-size:10px; font-weight:700; text-transform:uppercase;
                letter-spacing:1px; color:#888; margin-bottom:8px;
            }
            #wm-settings-body .wm-set-sub, #wm-tagger-body .wm-set-sub {
                font-size:10px; color:#666; margin:6px 0 4px;
            }
            #wm-settings-body .wm-toggle, #wm-tagger-body .wm-toggle {
                display:flex; align-items:center; gap:8px;
                padding:4px 0; cursor:pointer; font-size:11px; color:#bbb;
                user-select:none;
            }
            #wm-settings-body .wm-toggle:hover, #wm-tagger-body .wm-toggle:hover { color:#fff; }
            #wm-settings-body .wm-toggle input[type="checkbox"],
            #wm-settings-body .wm-toggle input[type="radio"],
            #wm-tagger-body .wm-toggle input[type="checkbox"],
            #wm-tagger-body .wm-toggle input[type="radio"] {
                width:14px; height:14px; cursor:pointer; accent-color:#4ade80;
                margin:0; flex-shrink:0;
            }
            #wm-settings-body .wm-input, #wm-tagger-body .wm-input {
                width:100%; background:rgba(0,0,0,0.4); border:1px solid rgba(255,255,255,0.1);
                color:#fff; font-family:'JetBrains Mono',monospace; font-size:10px;
                padding:6px 8px; border-radius:5px; box-sizing:border-box;
            }
            #wm-settings-body .wm-input:focus, #wm-tagger-body .wm-input:focus { outline:none; border-color:rgba(74,222,128,0.5); }
            #wm-settings-body .wm-srow, #wm-tagger-body .wm-srow { display:flex; gap:6px; margin-top:6px; }
            #wm-settings-body .wm-srow button, #wm-tagger-body .wm-srow button {
                flex:1; padding:5px 8px; border:1px solid rgba(255,255,255,0.1);
                background:rgba(255,255,255,0.04); color:#ccc;
                font-size:10px; border-radius:5px; cursor:pointer; transition:all 0.15s;
                font-family:inherit;
            }
            #wm-settings-body .wm-srow button:hover, #wm-tagger-body .wm-srow button:hover {
                background:rgba(255,255,255,0.08); color:#fff; border-color:rgba(255,255,255,0.2);
            }
            #wm-tagger-body .wm-srow button:disabled { opacity:0.4; cursor:not-allowed; }
            #wm-settings-status { margin-top:8px; font-size:10px; color:#666; }
            .wm-panel {
                background:rgba(12,12,16,0.98); border:1px solid rgba(255,255,255,0.07);
                border-radius:10px; display:flex; flex-direction:column; overflow:hidden;
                animation:wm-fadein 0.2s ease;
            }
            .wm-ph {
                display:flex; align-items:center; justify-content:space-between;
                padding:9px 13px; flex-shrink:0;
                background:rgba(255,255,255,0.02); border-bottom:1px solid rgba(255,255,255,0.06);
            }
            .wm-ph-title {
                font-size:10px; font-weight:700; text-transform:uppercase;
                letter-spacing:1px; color:#555; display:flex; align-items:center; gap:6px;
            }
            .wm-sdot { width:7px; height:7px; border-radius:50%; background:#222; transition:background 0.3s; }
            .wm-sdot.on { background:#22c55e; animation:wm-pulse 1.2s infinite; }
            /* IMPORTANT: display:flex + flex-direction:column requis pour que .wm-log flex:1 fonctionne */
            .wm-pb { flex:1; overflow-y:auto; padding:11px 13px; scrollbar-width:thin; scrollbar-color:rgba(255,255,255,0.07) transparent; display:flex; flex-direction:column; min-height:0; }

            /* Masque les flèches natives des inputs number du market (gagne ~16px de largeur utile) */
            .wm-pb input[type=number]::-webkit-inner-spin-button,
            .wm-pb input[type=number]::-webkit-outer-spin-button { -webkit-appearance:none; margin:0; }
            .wm-pb input[type=number] { -moz-appearance:textfield; }
            /* Placeholder médiane des champs max auto-bid : jaune atténué (plus lisible que le gris par défaut) */
            .wm-pb input[id^="wm-autobidmax-"]::placeholder { color:rgba(251,191,36,0.55); opacity:1; }

            .wm-btn { display:block; width:100%; padding:7px; border:none; border-radius:6px; font-family:'Rajdhani',sans-serif; font-size:13px; font-weight:700; letter-spacing:1px; cursor:pointer; transition:all 0.2s; text-align:center; }
            .wm-g   { background:linear-gradient(135deg,#22c55e,#16a34a); color:#fff; }
            .wm-r   { background:linear-gradient(135deg,#ef4444,#b91c1c); color:#fff; }
            .wm-c   { background:rgba(6,182,212,0.12); color:#06b6d4; border:1px solid rgba(6,182,212,0.3); }
            .wm-con { background:linear-gradient(135deg,#06b6d4,#0284c7); color:#fff; }
            .wm-a   { background:linear-gradient(135deg,#f59e0b,#d97706); color:#fff; }
            .wm-gh  { background:rgba(255,255,255,0.04); color:#666; border:1px solid rgba(255,255,255,0.09); font-size:10px; padding:4px 10px; width:auto; border-radius:4px; cursor:pointer; }
            .wm-gh:hover { background:rgba(255,255,255,0.09); color:#aaa; }
            .wm-sm  { width:auto; padding:4px 13px; font-size:12px; }

            .wm-sep  { border-top:1px solid rgba(255,255,255,0.06); margin:8px 0; }
            .wm-lbl  { font-size:10px; color:#555; text-transform:uppercase; letter-spacing:1px; margin-bottom:5px; }

            .wm-rarity-row { display:flex; align-items:center; padding:2px 0; border-bottom:1px solid rgba(255,255,255,0.03); }
            .wm-rarity-row:last-child { border-bottom:none; }

            .wm-hit { border-radius:7px; padding:7px 9px; margin-bottom:7px; border:1px solid rgba(255,255,255,0.07); transition:border-color 0.3s, background 0.3s; }
            .wm-hit:last-child { margin-bottom:0; }
            .wm-hit-title { font-size:12px; font-weight:600; margin-bottom:3px; text-decoration:none; display:block; }
            .wm-hit-meta  { display:flex; align-items:center; gap:5px; flex-wrap:wrap; font-size:10px; color:#888; margin-bottom:4px; }
            .wm-badge { display:inline-block; padding:1px 5px; border-radius:3px; font-size:10px; font-weight:700; white-space:nowrap; vertical-align:middle; }
            .wm-hit-act { display:flex; gap:4px; align-items:center; flex-wrap:wrap; }
            .wm-bid-inp { width:56px; padding:2px 4px; border-radius:3px; border:1px solid rgba(6,182,212,0.3); background:#070709; color:#fff; font-size:10px; text-align:center; }
            .wm-hbtn { padding:2px 7px; border-radius:3px; border:1px solid rgba(6,182,212,0.3); background:rgba(6,182,212,0.07); color:#06b6d4; font-size:10px; cursor:pointer; }
            .wm-hbtn:hover { background:rgba(6,182,212,0.15); }
            .wm-ab-off { border-color:rgba(255,255,255,0.1)!important; background:rgba(255,255,255,0.03)!important; color:#555!important; }
            .wm-ab-on  { border-color:rgba(74,222,128,0.4)!important; background:rgba(74,222,128,0.1)!important; color:#4ade80!important; }

            /* IMPORTANT: flex:1 (et pas max-height) pour que le log prenne toute la place dispo jusqu'en bas du panel */
            .wm-log { background:rgba(0,0,0,0.3); border-radius:5px; padding:6px 8px; font-size:10px; font-family:monospace; flex:1; min-height:140px; overflow-y:auto; color:#555; scrollbar-width:thin; }
            .wm-log-e { padding:1px 0; border-bottom:1px solid rgba(255,255,255,0.03); }
            .wm-log-e:last-child { color:#aaa; border:none; }

            .wm-cd-g{color:#22c55e} .wm-cd-y{color:#FFD700} .wm-cd-o{color:#FF8C00} .wm-cd-r{color:#ef4444}

            .wm-kw-tag { display:inline-flex; align-items:center; gap:2px; padding:2px 6px; border-radius:4px; margin:2px 2px 0 0; background:rgba(6,182,212,0.07); border:1px solid rgba(6,182,212,0.18); font-size:10px; color:#06b6d4; }
            .wm-kw-tag button { background:none; border:none; color:#555; cursor:pointer; font-size:12px; padding:0 0 0 2px; }
            .wm-kw-inp { flex:1; padding:3px 7px; border-radius:4px; border:1px solid rgba(6,182,212,0.25); background:#070709; color:#fff; font-size:10px; outline:none; }

            #wm-reveal-area { border-radius:6px; padding:6px 9px; margin-bottom:6px; font-size:13px; min-height:32px; }
        `;
        document.head.appendChild(style);

        /* ── Countdown ── */
        function cdInfo(str) {
            const ms = new Date(str).getTime() - Date.now();
            if (ms <= 0) return {text:'⏰', cls:'wm-cd-r'};
            const s=Math.floor(ms/1000), m=Math.floor(s/60), h=Math.floor(m/60);
            const text = h>0?`${h}h ${String(m%60).padStart(2,'0')}m`:m>0?`${m}m ${String(s%60).padStart(2,'0')}s`:`${s}s`;
            const cls = ms<5*60000?'wm-cd-r':ms<10*60000?'wm-cd-o':ms<30*60000?'wm-cd-y':'wm-cd-g';
            return {text, cls};
        }

        /* ════════ FAB ════════ */
        const fab = document.createElement("button");
        fab.id = "wm-fab";
        fab.innerHTML = `<span id="wm-fab-gear">⚙️</span><span id="wm-fab-badge" title="Notifications non vues">0</span>`;
        document.body.appendChild(fab);

        // ── Système de notifications visuelles (badge rouge sur le FAB) ──
        // Compteur d'événements non vus (nouveaux hits, lead perdu).
        // S'efface à l'ouverture de l'overlay.
        let pendingNotifications = 0;
        function updateBadgeDOM() {
            const badge = document.getElementById('wm-fab-badge');
            if (!badge) return;
            const overlay = document.getElementById('wm-overlay');
            const overlayOpen = overlay && overlay.classList.contains('open');
            // Le badge ne s'affiche QUE si l'overlay est fermé (sinon les notifs
            // sont visibles directement dans le dashboard, pas besoin du badge).
            if (pendingNotifications > 0 && getSetting('notificationsEnabled') && !overlayOpen) {
                badge.innerText = pendingNotifications > 99 ? '99+' : String(pendingNotifications);
                badge.classList.add('show');
            } else {
                badge.classList.remove('show');
            }
        }
        // Exposé sur window pour que les call-sites puissent incrémenter sans
        // avoir à dépendre du scope createUI()
        window.wmNotify = function(count = 1) {
            if (!getSetting('notificationsEnabled')) return;
            // Si l'overlay est déjà ouvert et visible, inutile de notifier
            const overlay = document.getElementById('wm-overlay');
            if (overlay && overlay.classList.contains('open') && !document.hidden) return;
            pendingNotifications += count;
            updateBadgeDOM();
        };
        window.wmClearNotifications = function() {
            pendingNotifications = 0;
            updateBadgeDOM();
        };
        // Force un recalcul de l'affichage du badge (sans toucher au compteur)
        window.wmRefreshBadge = updateBadgeDOM;

        function updateDots() {
            const p=document.getElementById('fd-p'), m=document.getElementById('fd-m'), t=document.getElementById('fd-t');
            if(p) p.className='wm-dot wm-dot-pack'+(running?' on':'');
            if(m) m.className='wm-dot wm-dot-market'+(marketWatcherActive?' on':'');
            if(t) t.className='wm-dot wm-dot-trash'+(trashSellerRunning?' on':'');
        }

        /* ════════ OVERLAY ════════ */
        const overlay = document.createElement("div");
        overlay.id = "wm-overlay";
        document.body.appendChild(overlay);
        fab.onclick = () => {
            const opened = overlay.classList.toggle('open');
            // À l'ouverture : reset le compteur (l'utilisateur voit les notifs dans le dashboard).
            // À la fermeture : on rafraîchit le badge (qui repart de 0 puisque reset à l'ouverture).
            if (opened) {
                if (typeof window.wmClearNotifications === 'function') window.wmClearNotifications();
                // 1re ouverture du dashboard après l'onboarding → lance le tour guidé.
                // (Petit délai pour laisser l'overlay s'afficher avant de positionner le spotlight.)
                if (localStorage.getItem('wm_onboarding_done') && !localStorage.getItem('wm_tour_done')
                    && !document.getElementById('wm-onboarding')) {
                    setTimeout(() => { if (typeof startFeatureTour === 'function') startFeatureTour(); }, 350);
                }
            } else {
                if (typeof window.wmRefreshBadge === 'function') window.wmRefreshBadge();
            }
            // Anime l'engrenage : retire la classe, force un reflow, puis la rajoute
            // (sinon l'animation ne se rejoue pas aux clics successifs)
            const gear = document.getElementById('wm-fab-gear');
            if (gear) {
                gear.classList.remove('wm-spin-once');
                void gear.offsetWidth; // reflow
                gear.classList.add('wm-spin-once');
            }
            console.log('[WikiMasters] FAB clicked, overlay open =', opened);
        };

        console.log('[WikiMasters] FAB + overlay created, attached to body');

        /* ── Header ── */
        overlay.innerHTML = `
        <div id="wm-dash-hdr">
            <div class="wm-logo">WIKI<span>MASTERS</span> Bot</div>
            <div class="wm-hstats">
                <div class="wm-hstat">📦 <b id="wm-packs">0 packs</b></div>
                <div class="wm-hstat">⏱️ <b id="wm-timer">00m 00s</b></div>
                <div class="wm-hstat">💰 <b id="wm-balance">—</b><span id="wm-bids-sum" style="font-weight:600;font-size:11px;"></span></div>
                <div class="wm-hstat">📚 <b id="wm-coll-count">—</b><span id="wm-coll-rarity" style="font-weight:600;font-size:11px;"></span></div>
            </div>
            <div class="wm-hctrls">
                <button class="wm-gh" id="wm-master-btn" style="color:#4ade80;">🚀 Tout démarrer</button>
                <button class="wm-gh" id="wm-refresh-btn">♻️ Collection</button>
                <button class="wm-gh" id="wm-close-btn">✕ Fermer</button>
            </div>
        </div>
        <div id="wm-panels">
            <!-- Panel 1: Pack Opener -->
            <div class="wm-panel">
                <div class="wm-ph">
                    <div class="wm-ph-title"><span class="wm-sdot" id="dot-pack"></span>Pack Opener</div>
                    <div style="display:flex;gap:6px;align-items:center;">
                        <button class="wm-btn wm-sm" id="wm-open-pack-btn"
                            style="background:rgba(6,182,212,0.12);border:1px solid rgba(6,182,212,0.4);color:#22d3ee;"
                            title="Ouvrir un seul pack maintenant (manuel)">📦 Ouvrir pack</button>
                        <button class="wm-btn wm-g wm-sm" id="wm-start-btn">▶ START</button>
                    </div>
                </div>
                <div class="wm-pb">
                    <div id="wm-reveal" style="min-height:32px;margin-bottom:8px;flex-shrink:0;"></div>
                    <div class="wm-lbl" style="flex-shrink:0;">Dernier pack</div>
                    <div id="wm-last-drop" style="min-height:18px;margin-bottom:8px;flex-shrink:0;"></div>
                    <div class="wm-sep" style="flex-shrink:0;"></div>
                    <div class="wm-lbl" style="flex-shrink:0;">Raretés obtenues (aujourd'hui)</div>
                    <div id="wm-rarity" style="flex-shrink:0;"></div>
                    <button id="wm-raz-btn" style="width:100%;margin-top:8px;padding:4px;border:1px solid rgba(239,68,68,0.3);border-radius:5px;background:rgba(239,68,68,0.05);color:#666;font-size:9px;cursor:pointer;letter-spacing:1px;text-transform:uppercase;flex-shrink:0;">⟳ Reset session</button>
                    <div id="wm-alert" style="margin-top:8px;font-size:11px;font-weight:600;flex-shrink:0;"></div>
                    <div class="wm-sep" style="flex-shrink:0;"></div>
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;flex-shrink:0;">
                        <div class="wm-lbl" style="margin:0;">Matchs mots-clés</div>
                        <span id="wm-pack-kw-count" style="font-size:9px;color:#888;font-family:monospace;">0</span>
                    </div>
                    <div id="wm-pack-kw-hits" style="flex:1;min-height:60px;overflow-y:auto;scrollbar-width:thin;"></div>
                </div>
            </div>
            <div class="wm-col-resizer" data-resizer="0" title="Glisser pour redimensionner"></div>
            <!-- Panel 2: Market Watcher -->
            <div class="wm-panel">
                <div class="wm-ph">
                    <div class="wm-ph-title"><span class="wm-sdot" id="dot-market"></span>Market Watcher</div>
                    <div style="display:flex;gap:5px;align-items:center;">
                        <span id="wm-market-status" style="font-size:10px;color:#555;white-space:nowrap;max-width:130px;overflow:hidden;text-overflow:ellipsis;"></span>
                        <button class="wm-btn wm-g wm-sm" id="wm-market-btn">▶ START</button>
                    </div>
                </div>
                <div class="wm-pb">
                    <div style="display:flex;gap:6px;margin-bottom:8px;">
                        <button id="wm-autosnipe-btn" class="wm-btn wm-gh" style="flex:1;">⚡ Hunter OFF</button>
                    </div>
                    <!-- Option DU Hunter, pas un second mode : une case à cocher subordonnée
                         (et non un bouton jumeau) pour que la hiérarchie soit lisible. -->
                    <label id="wm-hunter-aggro-row" style="display:flex;align-items:center;gap:6px;margin:-2px 0 8px;padding-left:2px;font-size:10px;color:#888;cursor:pointer;user-select:none;"
                        title="Change la FAÇON dont le Hunter mise. Décoché : il mise le minimum dès qu'une carte passe sous ton seuil (et lance la guerre d'enchères). Coché : il ne mise plus tout de suite — il arme le mode Fourbe et snipe en fin d'enchère, plafonné à ce même seuil. Décocher désarme tout et restaure les plafonds d'origine.">
                        <input type="checkbox" id="wm-hunter-aggro" style="width:13px;height:13px;accent-color:#c084fc;cursor:pointer;margin:0;flex-shrink:0;">
                        <span id="wm-hunter-aggro-lbl">🕵️ Mode fourbe (snipe en fin, pas de mise immédiate)</span>
                    </label>
                    <div class="wm-sep"></div>
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
                        <div class="wm-lbl" id="wm-kw-label" style="margin:0;">Mots-clés (0)</div>
                        <button class="wm-gh" id="wm-kw-toggle" style="font-size:10px;padding:2px 6px;">▶</button>
                    </div>
                    <div id="wm-keywords-panel" style="display:none;margin-bottom:8px;"></div>
                    <div class="wm-sep"></div>
                    <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
                        <input id="wm-market-search" type="text" autocomplete="off" spellcheck="false"
                            placeholder="🔎 Filtrer les annonces (titre, mot-clé…)"
                            style="flex:1;padding:3px 8px;border-radius:4px;border:1px solid rgba(6,182,212,0.35);background:#0f0f13;color:#fff;font-size:11px;outline:none;" />
                        <button id="wm-market-search-clear" title="Effacer le filtre"
                            style="padding:3px 8px;border-radius:4px;border:1px solid rgba(255,255,255,0.1);background:#0f0f13;color:#888;font-size:11px;cursor:pointer;">✕</button>
                    </div>
                    <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
                        <span class="wm-lbl" style="margin:0;white-space:nowrap;">Tri</span>
                        <select id="wm-sort-select" style="flex:1;padding:3px 6px;border-radius:4px;border:1px solid rgba(255,255,255,0.1);background:#0f0f13;color:#fff;font-size:11px;outline:none;cursor:pointer;">
                            <option value="time_asc">⏱ Fin proche</option>
                            <option value="time_desc">⏱ Fin lointaine</option>
                            <option value="recent">🆕 Ajout récent</option>
                            <option value="outbid_recent">😤 Mises perdues récemment</option>
                            <option value="price_asc">💰 Prix ↑</option>
                            <option value="price_desc">💰 Prix ↓</option>
                            <option value="rarity_desc">⭐ Rareté (L→C)</option>
                            <option value="rarity_asc">⭐ Rareté (C→L)</option>
                            <option value="title_asc">🔤 Titre A→Z</option>
                            <option value="owned_asc">📚 Possédées ↑ (manquantes d'abord)</option>
                            <option value="owned_desc">📚 Possédées ↓ (doublons d'abord)</option>
                        </select>
                        <!-- Sélecteur plutôt qu'un bouton bascule : à 3 vues, un bouton qui
                             cycle n'indique plus où l'on est ni combien de clics restent. -->
                        <select id="wm-view-select" title="Vue des annonces"
                            style="padding:3px 6px;border-radius:4px;border:1px solid rgba(255,255,255,0.1);background:#0f0f13;color:#fff;font-size:11px;outline:none;cursor:pointer;flex-shrink:0;">
                            <option value="detailed">▤ Détaillé</option>
                            <option value="compact">☰ Compact</option>
                            <option value="cards">🖼 Cadres</option>
                        </select>
                    </div>
                    <label style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:11px;color:#bbb;cursor:pointer;user-select:none;">
                        <input type="checkbox" id="wm-hide-owned" style="width:14px;height:14px;accent-color:#4ade80;cursor:pointer;margin:0;flex-shrink:0;">
                        <span>Masquer les cartes déjà possédées</span>
                    </label>
                    <div id="wm-market-alert" style="font-size:11px;"></div>
                </div>
            </div>
            <div class="wm-col-resizer" data-resizer="1" title="Glisser pour redimensionner"></div>
            <!-- Panel 3: Trash Seller -->
            <div class="wm-panel">
                <div class="wm-ph">
                    <div class="wm-ph-title"><span class="wm-sdot" id="dot-trash"></span>Trash Seller</div>
                    <button class="wm-btn wm-g wm-sm" id="wm-trash-btn">▶ START</button>
                </div>
                <div class="wm-pb">
                    <div id="wm-trash-status" style="font-size:10px;color:#888;min-height:14px;margin-bottom:6px;"></div>
                    <div class="wm-sep"></div>
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;gap:6px;">
                        <div class="wm-lbl" style="margin:0;">Ventes actives</div>
                        <div style="display:flex;align-items:center;gap:6px;">
                            <button id="wm-refresh-sales-btn" title="Annule les ventes sans mise et remet en vente les meilleures cartes selon ta stratégie (Paramètres)"
                                style="font-size:9px;color:#c084fc;background:rgba(192,132,252,0.08);border:1px solid rgba(192,132,252,0.35);border-radius:4px;padding:2px 7px;cursor:pointer;white-space:nowrap;">🔄 Refresh ventes</button>
                            <span id="wm-active-sales-count" style="font-size:9px;color:#888;font-family:'JetBrains Mono',monospace;">0/5</span>
                        </div>
                    </div>
                    <div id="wm-active-sales" style="margin-bottom:8px;"></div>
                    <div class="wm-sep"></div>
                    <div class="wm-lbl">Ventes (aujourd'hui)</div>
                    <div id="wm-sell-history" style="margin-bottom:8px;"></div>
                    <div class="wm-sep"></div>
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                        <div class="wm-lbl" style="margin:0;">Log</div>
                        <button id="wm-log-export" title="Exporter le log en .txt"
                            style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);color:#aaa;font-size:9px;padding:2px 6px;border-radius:4px;cursor:pointer;font-family:inherit;">
                            Export logs 💾
                        </button>
                    </div>
                    <div id="wm-log" class="wm-log"></div>
                </div>
            </div>
        </div>
        <div id="wm-tagger-panel">
            <div class="wm-row-resizer" data-target="wm-tagger-body" data-var="--wm-tagger-h"></div>
            <div id="wm-tagger-hdr">
                <span>🏷️ Étiquetage en masse</span>
                <span id="wm-tagger-chevron">▴</span>
            </div>
            <div id="wm-tagger-body">
                <div class="wm-set-sub">Cherche dans toute ta collection les cartes qui matchent un ou plusieurs mots, puis applique une étiquette en un clic. Astuce : coche « sans étiquette » <b>sans</b> mot-clé pour <b>lister toutes tes cartes non taguées</b>.</div>
                <div class="wm-set-sub" style="margin-top:8px;">Mot(s) recherché(s) — sépare par des <b>points-virgules ;</b> pour en chercher plusieurs (les titres à virgule ne sont pas cassés)</div>
                <input id="wm-tagger-keyword" type="text" class="wm-input" autocomplete="off" spellcheck="false" placeholder="ex. japon; marvel; star wars, épisode i">
                <div class="wm-set-sub" style="margin-top:8px;">Étiquette à appliquer (existante ou nouvelle)</div>
                <input id="wm-tagger-tag" type="text" class="wm-input" autocomplete="off" spellcheck="false" list="wm-tagger-taglist" placeholder="ex. Japon">
                <datalist id="wm-tagger-taglist"></datalist>
                <div class="wm-set-sub" style="margin-top:8px;">Catégorie de la recherche <span style="color:#666;">(optionnel — pour ranger tes présets, ex. MCU, Pays…)</span></div>
                <input id="wm-tagger-group" type="text" class="wm-input" autocomplete="off" spellcheck="false" list="wm-tagger-grouplist" placeholder="ex. MCU">
                <datalist id="wm-tagger-grouplist"></datalist>
                <label class="wm-toggle" style="margin-top:8px;">
                    <input type="checkbox" id="wm-tagger-untagged-only">
                    <span>Seulement les cartes sans aucune étiquette</span>
                </label>
                <label class="wm-toggle" style="margin-top:6px;">
                    <input type="checkbox" id="wm-tagger-extended">
                    <span>🔎 Recherche étendue (description, catégories)</span>
                </label>
                <div class="wm-set-sub" style="margin-top:2px;">Décoché (défaut) = match <b>précis</b> : on ne tague qu'une carte dont le <b>titre/nom</b> contient le mot (la carte <b>EST</b> la personne). Coché = on cherche aussi dans la description/catégories — utile pour un thème (« marvel », « japon »), mais peut taguer une fiche de <b>film</b> qui <b>mentionne</b> un acteur/réalisateur. Ce choix est mémorisé avec la recherche enregistrée.</div>
                <label class="wm-toggle" style="margin-top:6px;">
                    <input type="checkbox" id="wm-tagger-force-scan">
                    <span>🔄 Forcer un nouveau scan de la collection</span>
                </label>
                <div class="wm-set-sub" style="margin-top:2px;">Décoché (défaut) : l'étiquetage <b>réutilise le dernier scan complet</b> (≤ 30 min) au lieu de re-parcourir toute la collection à chaque préset — énorme gain sur les grosses collections. Coché : force un scan frais. Le bouton <b>♻️ Collection</b> rafraîchit aussi ce scan.</div>
                <div class="wm-srow" style="margin-top:8px;">
                    <button id="wm-tagger-scan">🔍 Scanner</button>
                    <button id="wm-tagger-apply" disabled>🏷️ Appliquer</button>
                </div>
                <div class="wm-srow" style="margin-top:6px;">
                    <button id="wm-tagger-save-preset">💾 Enregistrer cette recherche</button>
                    <button id="wm-tagger-run-all">▶▶ Lancer tous les présets</button>
                </div>
                <div class="wm-sep" style="margin:10px 0;"></div>
                <div class="wm-set-sub">Repère toutes les cartes que tu possèdes en <b>2 exemplaires ou plus</b> (même carte, même rareté) — remplit la liste ci-dessous pour relecture, exactement comme un scan normal. Étiquette « Doublon » pré-remplie, à appliquer avec le bouton <b>🏷️ Appliquer</b> ci-dessus.</div>
                <div class="wm-srow" style="margin-top:6px;">
                    <button id="wm-tagger-duplicates">🃏×2 Repérer les doublons</button>
                </div>
                <div class="wm-srow" style="margin-top:6px;">
                    <button id="wm-tagger-cancel-edit" style="display:none;border:1px solid rgba(239,68,68,0.3);background:rgba(239,68,68,0.06);color:#ef8a8a;">✖ Annuler la modification</button>
                </div>
                <label class="wm-toggle" style="margin-top:8px;">
                    <input type="checkbox" id="wm-tagger-autopack">
                    <span>Étiqueter automatiquement les cartes packées selon ces recherches</span>
                </label>
                <label class="wm-toggle" style="margin-top:6px;">
                    <input type="checkbox" id="wm-tagger-autopack-skip-l">
                    <span>🛡️ Ne pas auto-étiqueter les cartes Légendaires</span>
                </label>
                <div class="wm-set-sub" style="margin-top:2px;">Protège les Légendaires packées de l'auto-étiquetage (ex. éviter qu'une L à garder soit taguée « Trash » à cause de sa description). Elles restent étiquetables à la main.</div>
                <div class="wm-set-sub" style="margin-top:8px;">⭐ Recherches enregistrées <span style="color:#666;">(un clic ▶ = scan + application · ▶ groupe = tout le groupe en 1 scan)</span></div>
                <div id="wm-tagger-presets" style="margin-top:4px;"></div>
                <div id="wm-tagger-status" class="wm-set-sub" style="margin-top:8px;"></div>
                <div id="wm-tagger-results" style="margin-top:8px;max-height:220px;overflow-y:auto;"></div>
            </div>
        </div>
        <div id="wm-stats-panel">
            <div class="wm-row-resizer" data-target="wm-stats-body" data-var="--wm-stats-h"></div>
            <div id="wm-stats-hdr">
                <span>📊 Statistiques</span>
                <span id="wm-stats-chevron">▴</span>
            </div>
            <div id="wm-stats-body">
                <div style="display:flex;justify-content:flex-end;align-items:center;margin-bottom:10px;">
                    <button id="wm-stats-reset" style="border:1px solid rgba(239,68,68,0.3);background:rgba(239,68,68,0.06);color:#ef4444;font-size:9px;padding:3px 8px;border-radius:5px;cursor:pointer;white-space:nowrap;">
                        ⟳ Réinitialiser
                    </button>
                </div>
                <div id="wm-stats-content"></div>
            </div>
        </div>

        <div id="wm-settings-panel">
            <div class="wm-row-resizer" data-target="wm-settings-body" data-var="--wm-settings-h"></div>
            <div id="wm-settings-hdr">
                <span>⚙️ Paramètres</span>
                <span id="wm-settings-chevron">▴</span>
            </div>
            <div id="wm-settings-body">

                <!-- Discord -->
                <div class="wm-set-section">
                    <div class="wm-set-title">Notifications Discord</div>
                    <label class="wm-toggle">
                        <input type="checkbox" id="wm-set-discord-enabled">
                        <span>Activer les notifications</span>
                    </label>
                    <div class="wm-set-sub">Webhook URL (privé — ne le partage pas)</div>
                    <input id="wm-webhook-input" type="text" class="wm-input" autocomplete="off" spellcheck="false" placeholder="https://discord.com/api/webhooks/...">
                    <div class="wm-srow">
                        <button id="wm-webhook-save">💾 Enregistrer</button>
                        <button id="wm-webhook-test">🧪 Test</button>
                        <button id="wm-webhook-clear">🗑️ Effacer</button>
                    </div>
                    <div id="wm-settings-status"></div>
                </div>

                <!-- Logs -->
                <div class="wm-set-section">
                    <div class="wm-set-title">Logs affichés</div>
                    <label class="wm-toggle"><input type="checkbox" id="wm-set-log-collection"><span>📚 Actualisation de la collection</span></label>
                    <label class="wm-toggle"><input type="checkbox" id="wm-set-log-market"><span>🛒 Market Watcher (scans, enchères)</span></label>
                    <label class="wm-toggle"><input type="checkbox" id="wm-set-log-trash"><span>🏷️ Trash Seller (mises en vente, invendus, retag)</span></label>
                    <label class="wm-toggle"><input type="checkbox" id="wm-set-log-autobid"><span>🤖 Auto-bid (snipes, ripostes)</span></label>
                </div>

                <!-- Mon compte -->
                <div class="wm-set-section">
                    <div class="wm-set-title">Mon compte</div>
                    <div id="wm-set-identity-info" class="wm-set-sub"></div>
                    <div class="wm-set-sub" style="margin-top:6px;">Pseudo forcé — utile après un changement de pseudo sur le site (le bot reconnaît alors tes enchères). Laisse <b>vide</b> pour la détection auto.</div>
                    <div class="wm-srow" style="margin-top:6px;">
                        <input id="wm-set-username" type="text" class="wm-input" autocomplete="off" spellcheck="false" placeholder="ton pseudo exact" style="flex:3;">
                        <button id="wm-set-username-save" style="flex:1;">💾 Enregistrer</button>
                    </div>
                    <div class="wm-srow" style="margin-top:6px;">
                        <button id="wm-set-identity-refresh">🔄 Rafraîchir l'identité (vider le cache)</button>
                    </div>
                    <div id="wm-set-identity-status" class="wm-set-sub" style="margin-top:6px;"></div>
                </div>

                <!-- Comportement -->
                <div class="wm-set-section">
                    <div class="wm-set-title">Comportement</div>
                    <div class="wm-set-sub">Hunter : mode de décision</div>
                    <label class="wm-toggle"><input type="radio" name="wm-set-snipe-mode" value="fixed"><span>Seuil fixe (mise si prix ≤ valeur définie)</span></label>
                    <label class="wm-toggle"><input type="radio" name="wm-set-snipe-mode" value="adaptive"><span>Dynamique (mise si prix sous la médiane des ventes passées)</span></label>
                    <div class="wm-set-sub" style="margin-top:8px;">Seuil fixe : prix maximum (💰) pour mise initiale automatique</div>
                    <input id="wm-set-autosnipe-price" type="number" min="0" step="1" class="wm-input">
                    <div class="wm-set-sub" style="margin-top:8px;">Mode dynamique : % de la médiane en-dessous duquel sniper (ex. 85 = mise si prix ≤ 85% de la médiane). Si aucune vente connue, le seuil fixe ci-dessus sert de filet.</div>
                    <input id="wm-set-autosnipe-ratio" type="number" min="1" max="200" step="5" class="wm-input">
                    <div class="wm-set-sub" style="margin-top:8px;">Hunter : solde minimum (💰) en-dessous duquel les mises automatiques sont suspendues</div>
                    <input id="wm-set-autosnipe-min-balance" type="number" min="0" step="100" class="wm-input">
                    <div class="wm-set-sub" style="margin-top:8px;">Délai humanisé avant une mise (ms). Plus bas = mises plus rapides mais moins « humaines ». <b>0 = instantané</b>. Ignoré quand l'enchère se termine bientôt (snipe toujours instantané).</div>
                    <input id="wm-set-bid-delay" type="number" min="0" max="10000" step="100" class="wm-input">
                    <div class="wm-set-sub" style="margin-top:8px;">🕵️ Mode Fourbe : secondes restantes visées pour le snipe. Miser <b>sous 10s rallonge le timer d'1 min</b> côté site, donc <b>10</b> est l'idéal (mise juste au-dessus du seuil, temps de réaction minimal pour l'adversaire). Le bot tire ~1s avant pour compenser la latence réseau.</div>
                    <input id="wm-set-snipe-seconds" type="number" min="5" max="120" step="1" class="wm-input">
                    <label class="wm-toggle" style="margin-top:8px;">
                        <input type="checkbox" id="wm-set-autoretag-enabled">
                        <span>Remettre auto le tag après un invendu</span>
                    </label>
                    <label class="wm-toggle">
                        <input type="checkbox" id="wm-set-wishlist-keyword">
                        <span>⭐ Ajouter en mot-clé les cartes mises en wishlist sur le site</span>
                    </label>
                    <label class="wm-toggle">
                        <input type="checkbox" id="wm-set-sound-newhit">
                        <span>🔔 Son à l'apparition d'une enchère qui match</span>
                    </label>
                    <label class="wm-toggle">
                        <input type="checkbox" id="wm-set-sound-outbid">
                        <span>🔔 Son à la perte du lead (surenchéri)</span>
                    </label>
                    <label class="wm-toggle">
                        <input type="checkbox" id="wm-set-sound-pack">
                        <span>📦 Son à chaque ouverture de pack</span>
                    </label>
                    <label class="wm-toggle">
                        <input type="checkbox" id="wm-set-sound-legendary">
                        <span>👑 Son quand une Légendaire est pack</span>
                    </label>
                    <label class="wm-toggle">
                        <input type="checkbox" id="wm-set-sound-won">
                        <span>🏆 Son + notif quand une enchère est gagnée</span>
                    </label>
                    <label class="wm-toggle">
                        <input type="checkbox" id="wm-set-notifications-enabled">
                        <span>Badge de notifications sur le bouton ⚙ (compteur d'événements)</span>
                    </label>
                    <div class="wm-set-sub" style="margin-top:10px;">Cooldown entre les packs</div>
                    <label class="wm-toggle"><input type="radio" name="wm-set-pack-cd" value="180"><span>3 minutes (compte abonné)</span></label>
                    <label class="wm-toggle"><input type="radio" name="wm-set-pack-cd" value="600"><span>10 minutes (compte gratuit)</span></label>
                    <label class="wm-toggle" style="margin-top:10px;">
                        <input type="checkbox" id="wm-set-daily-alert">
                        <span>Alerte si trop de packs ouverts dans la journée</span>
                    </label>
                    <div class="wm-set-sub" style="margin-top:4px;">Seuil d'alerte (nombre de packs / jour)</div>
                    <input id="wm-set-daily-limit" type="number" min="1" step="10" class="wm-input">
                    <div id="wm-daily-packs-info" class="wm-set-sub" style="margin-top:4px;color:#888;"></div>
                    <div class="wm-set-sub" style="margin-top:10px;font-weight:700;color:#ccc;">⏰ Horaires programmés (un par module)</div>
                    <div class="wm-set-sub" style="margin-top:2px;">Chaque module démarre à son heure de début et s'arrête à son heure de fin. Si tu l'arrêtes manuellement pendant sa plage, il ne se relance pas tout seul.</div>

                    <label class="wm-toggle" style="margin-top:8px;">
                        <input type="checkbox" id="wm-set-schedule-pack-enabled">
                        <span>📦 Pack Opener</span>
                    </label>
                    <div class="wm-srow" style="margin-top:2px;align-items:center;gap:8px;">
                        <span style="font-size:10px;color:#888;">De</span>
                        <input id="wm-set-schedule-pack-start" type="time" class="wm-input" style="flex:1;">
                        <span style="font-size:10px;color:#888;">à</span>
                        <input id="wm-set-schedule-pack-end" type="time" class="wm-input" style="flex:1;">
                    </div>

                    <label class="wm-toggle" style="margin-top:8px;">
                        <input type="checkbox" id="wm-set-schedule-market-enabled">
                        <span>🛒 Market Watcher</span>
                    </label>
                    <div class="wm-srow" style="margin-top:2px;align-items:center;gap:8px;">
                        <span style="font-size:10px;color:#888;">De</span>
                        <input id="wm-set-schedule-market-start" type="time" class="wm-input" style="flex:1;">
                        <span style="font-size:10px;color:#888;">à</span>
                        <input id="wm-set-schedule-market-end" type="time" class="wm-input" style="flex:1;">
                    </div>

                    <label class="wm-toggle" style="margin-top:8px;">
                        <input type="checkbox" id="wm-set-schedule-trash-enabled">
                        <span>🗑️ Trash Seller</span>
                    </label>
                    <div class="wm-srow" style="margin-top:2px;align-items:center;gap:8px;">
                        <span style="font-size:10px;color:#888;">De</span>
                        <input id="wm-set-schedule-trash-start" type="time" class="wm-input" style="flex:1;">
                        <span style="font-size:10px;color:#888;">à</span>
                        <input id="wm-set-schedule-trash-end" type="time" class="wm-input" style="flex:1;">
                    </div>
                    <div class="wm-set-sub" style="margin-top:10px;">Trash Seller : nombre de ventes actives simultanées</div>
                    <input id="wm-set-max-active-sales" type="number" min="1" max="10" step="1" class="wm-input">
                    <div class="wm-set-sub" style="margin-top:10px;">Trash Seller : quelles cartes mettre en vente en priorité</div>
                    <select id="wm-set-trash-strategy" class="wm-input" style="cursor:pointer;">
                        <option value="coverage">⚖️ Équitable — les moins souvent mises en vente d'abord (couvre tout le pool)</option>
                        <option value="value">💰 Valeur — les plus chères d'abord (prix moyen marché, repli prix par rareté)</option>
                        <option value="rarity">⭐ Rareté — les plus rares d'abord (L → C)</option>
                        <option value="random">🎲 Aléatoire</option>
                    </select>
                    <div class="wm-set-sub" style="margin-top:10px;">Trash Seller : prix de mise en vente</div>
                    <label class="wm-toggle">
                        <input type="checkbox" id="wm-set-sell-market">
                        <span>Mettre en vente au prix moyen du marché (× %)</span>
                    </label>
                    <div class="wm-set-sub" style="margin-top:4px;">% du prix moyen des ventes passées appliqué comme prix de base (ex. 90 = 90% de la moyenne). Si <b>aucune vente</b> n'est connue pour la carte, le prix manuel du tableau ci-dessous est utilisé.</div>
                    <input id="wm-set-sell-market-pct" type="number" min="1" max="500" step="5" class="wm-input">
                    <label class="wm-toggle" style="margin-top:6px;">
                        <input type="checkbox" id="wm-set-sell-market-floor">
                        <span>🛡️ Ne jamais vendre sous le prix du tableau (plancher)</span>
                    </label>
                    <div class="wm-set-sub" style="margin-top:2px;">Si le prix marché calculé est inférieur au prix du tableau pour cette rareté, on garde le prix du tableau. Évite de brader une carte sous-cotée.</div>
                    <label class="wm-toggle" style="margin-top:6px;">
                        <input type="checkbox" id="wm-set-sell-degressive">
                        <span>📉 Prix dégressif sur les invendus (-15% / 10 remises)</span>
                    </label>
                    <div class="wm-set-sub" style="margin-top:2px;">Une carte remise en vente sans être vendue (🔁) voit son prix baisser de <b>15%</b> à chaque tranche de <b>10 remises</b> (plafonné à -75%, jamais sous 1 💰). S'applique après le plancher — le but est d'écouler ce qui stagne.</div>
                    <label class="wm-toggle" style="margin-top:6px;">
                        <input type="checkbox" id="wm-set-sell-undercut">
                        <span>🃏 Undercut : se placer sous une annonce existante</span>
                    </label>
                    <div class="wm-set-sub" style="margin-top:2px;">Au moment de mettre en vente, si une annonce active existe déjà pour la même carte, on se place à <b>1 💰 sous</b> la plus basse (uniquement si ça baisse le prix) pour vendre plus vite.</div>
                    <label class="wm-toggle" style="margin-top:10px;">
                        <input type="checkbox" id="wm-set-sell-sole-tag">
                        <span>🛡️ Ne vendre que si le tag de vente est le SEUL tag</span>
                    </label>
                    <div class="wm-set-sub" style="margin-top:2px;">Filet de sécurité : une carte n'est mise en vente que si elle porte <b>uniquement</b> le tag de vente. Si elle a aussi un autre tag, le tag de vente est probablement une erreur → la carte est <b>ignorée</b> et conservée.</div>
                    <div class="wm-set-sub" style="margin-top:10px;">Trash Seller : prix et durée par rareté <span style="color:#666;">(repli si prix marché indisponible · sert aussi de plancher)</span></div>
                    <table id="wm-sell-table" style="width:100%;border-collapse:separate;border-spacing:0 4px;font-size:10px;">
                        <thead>
                            <tr style="color:#666;text-transform:uppercase;letter-spacing:0.5px;font-size:9px;">
                                <th style="text-align:left;padding:2px 6px;font-weight:600;">Rareté</th>
                                <th style="text-align:left;padding:2px 6px;font-weight:600;">Prix 💰</th>
                                <th style="text-align:left;padding:2px 6px;font-weight:600;">Durée</th>
                            </tr>
                        </thead>
                        <tbody id="wm-sell-table-body"></tbody>
                    </table>
                </div>

                <!-- Tag de vente -->
                <div class="wm-set-section">
                    <div class="wm-set-title">Tag de mise en vente</div>
                    <div class="wm-set-sub">Nom du tag sur wiki-masters qui sert à marquer les cartes à vendre (défaut : Trash)</div>
                    <div class="wm-srow" style="margin-top:6px;">
                        <input id="wm-set-tag-name" type="text" class="wm-input" autocomplete="off" spellcheck="false" placeholder="Trash" style="flex:3;">
                        <button id="wm-set-tag-save" style="flex:1;">💾 Enregistrer</button>
                    </div>
                    <div id="wm-set-tag-status" class="wm-set-sub" style="margin-top:6px;"></div>
                </div>

                <div class="wm-set-section">
                    <div class="wm-set-title">Sauvegarde / Restauration</div>
                    <div class="wm-set-sub">Exporte ou importe toutes tes stats, paramètres, historiques, mots-clés et caches.<br>
                        Pratique pour transférer ton profil entre plusieurs PCs ou pour faire un backup avant de tester un nouveau setup.</div>
                    <div class="wm-srow" style="margin-top:8px;gap:8px;">
                        <button id="wm-set-export" style="flex:1;">📤 Exporter</button>
                        <button id="wm-set-import" style="flex:1;">📥 Importer</button>
                    </div>
                    <div class="wm-srow" style="margin-top:6px;">
                        <button id="wm-set-export-discord">📤 Exporter → Discord</button>
                    </div>
                    <div class="wm-set-sub" style="margin-top:6px;color:#666;">L'envoi Discord nécessite un webhook configuré plus haut. ⚠ Le fichier contient tes données (dont l'URL de ton webhook) — envoie-le sur un salon privé.</div>
                    <label class="wm-toggle" style="margin-top:8px;">
                        <input type="checkbox" id="wm-set-autobackup-stop">
                        <span>Envoyer le backup sur Discord à chaque « Tout arrêter »</span>
                    </label>
                    <div class="wm-set-sub" style="margin-top:8px;">Backup auto sur Discord toutes les N minutes (0 = désactivé). Protège contre les arrêts imprévus (coupure de courant, crash). Version <b>allégée</b> (sans le cache collection qui se régénère), donc légère.</div>
                    <input id="wm-set-periodic-backup" type="number" min="0" max="1440" step="5" class="wm-input">
                    <div id="wm-set-iox-status" class="wm-set-sub" style="margin-top:6px;"></div>
                </div>

                <div style="text-align:center;padding:8px 0 2px;">
                    <button id="wm-replay-tour" style="border:1px solid rgba(192,132,252,0.4);background:rgba(192,132,252,0.08);color:#c084fc;font-size:10px;padding:4px 12px;border-radius:5px;cursor:pointer;">📖 Revoir le tuto guidé</button>
                </div>
                <div style="text-align:center;padding:6px 0 2px;color:#444;font-size:9px;letter-spacing:0.5px;">
                    WikiMasters Bot · Ver. ${WM_VERSION}
                </div>

            </div>
        </div>`;

        /* ════════ INIT DATA ════════ */
        // Le re-save immédiat purge un éventuel cardStats hérité d'avant le correctif de
        // 2026-08-18 (poids mort jamais lu, cf. saveStats()) sans attendre une future sauvegarde
        // naturelle — sinon la clé resterait à sa taille gonflée tant qu'un pack n'a pas été
        // analysé, ce qui ne réglerait pas un quota déjà dépassé au chargement de la page.
        loadStats(); saveStats(); loadSellHistory();
        // Identification utilisateur (async : JWT → Supabase → email)
        fetchCurrentUser().then(async () => {
            // La source est portée par fetchCurrentUser (tous ses chemins la renseignent),
            // plus par une relecture de localStorage que les sorties anticipées n'alimentaient pas.
            const source = currentUsernameSource;
            if (currentUsername) {
                wmLog(`👤 Utilisateur identifié : <b style="color:#4ade80;">${currentUsername}</b> <span style="color:#555;font-size:9px;">(${source})</span>`);
                // Découverte du tag Trash si pas en cache
                if (!TRASH_TAG_ID) await discoverTrashTagId();
                // Réconciliation des ventes en attente (retag des invendues revenues pendant
                // que le PC était éteint). Petit délai pour laisser le réseau/JWT se stabiliser.
                setTimeout(() => { reconcilePendingSales().catch(() => {}); }, 4000);
            } else {
                wmLog(`⚠️ Utilisateur non identifié — connecte-toi à wiki-masters.com et recharge la page`);
            }
        });
        setTimeout(() => {
            const packsEl = document.getElementById("wm-packs");
            if (packsEl) packsEl.innerText = `${sessionPacks} pack${sessionPacks>1?'s':''}`;
            renderRarityStats(document.getElementById('wm-rarity'));
            renderSellHistory();
            renderKeywordsPanel();
            renderPackKwHits();
            const cc = document.getElementById('wm-coll-count');
            if (cc) cc.innerText = collectionMap.size > 0 ? collectionMap.size.toLocaleString('fr-FR') + ' cartes' : '—';
            // Initialise le suivi des achats gagnés (mémorise l'existant sans le compter)
            syncWonAuctions();
            lastWonSync = Date.now();
        }, 0);

        /* ════════ PACK OPENER ════════ */
        const startBtn   = document.getElementById("wm-start-btn");
        const revealEl   = document.getElementById("wm-reveal");
        const lastDropEl = document.getElementById("wm-last-drop");
        const rarityEl   = document.getElementById("wm-rarity");
        const alertEl    = document.getElementById("wm-alert");

        function setPackOpenerRunning(state) {
            running = state;
            // Nouveau jeton à CHAQUE transition : une boucle précédente encore endormie
            // (dans sleepUntil pendant une regen) verra son epoch périmé et sortira au réveil,
            // au lieu de continuer en parallèle de la nouvelle → plus de timers qui se chevauchent.
            const myEpoch = ++packLoopEpoch;
            if (state) {
                startBtn.innerText = "⏹ STOP"; startBtn.className = "wm-btn wm-r wm-sm";
                document.getElementById('dot-pack').classList.add('on');
                // Restaure le timestamp de session si présent (continuité après F5), sinon nouveau
                const savedStart = parseInt(sessionStorage.getItem('wm_session_start'), 10);
                if (Number.isFinite(savedStart) && Date.now() - savedStart < 24 * 3600 * 1000) {
                    sessionStart = savedStart;
                } else {
                    sessionStart = Date.now();
                    sessionStorage.setItem('wm_session_start', String(sessionStart));
                }
                startTimer();
                sessionStorage.setItem('wm_packopener_active', '1');
                loop(revealEl, lastDropEl, rarityEl, alertEl, myEpoch);
            } else {
                startBtn.innerText = "▶ START"; startBtn.className = "wm-btn wm-g wm-sm";
                document.getElementById('dot-pack').classList.remove('on');
                stopTimer();
                sessionStorage.removeItem('wm_packopener_active');
                sessionStorage.removeItem('wm_session_start');
            }
            updateDots();
        }

        startBtn.onclick = () => setPackOpenerRunning(!running);

        // Bouton "Ouvrir pack" : ouvre UN seul pack manuellement (utile pour écouler les packs
        // en attente sans lancer la boucle auto). Passe par openPack() → handlePackOpened, donc
        // même comptage/animation que la boucle ; openPack() incrémente botPackOpenInFlight, ce
        // qui évite le double-comptage par l'intercepteur réseau.
        const openPackBtn = document.getElementById('wm-open-pack-btn');
        if (openPackBtn) openPackBtn.onclick = async () => {
            if (openPackBtn.disabled) return;
            if (!navigator.onLine) { if (alertEl) alertEl.innerHTML = '<span style="color:#ef4444;">📡 hors ligne</span>'; return; }
            openPackBtn.disabled = true;
            const prev = openPackBtn.innerText;
            openPackBtn.innerText = '⏳ …';
            try {
                const data = await openPack();
                if (!data || !data.cards || data.cards.length === 0) {
                    if (alertEl) alertEl.innerHTML = `<span style="color:#fbbf24;">Aucun pack à ouvrir${data && data.error ? ' · ' + data.error : ' pour le moment'}.</span>`;
                    wmLog('📦 Ouverture manuelle : aucun pack disponible.');
                } else {
                    wmLog(`📦 Pack ouvert <b>manuellement</b> (bouton) — comptabilisé dans les stats`);
                    await handlePackOpened(data, { animate: true });
                }
            } catch(err) {
                if (err && err.message === '403') {
                    if (alertEl) alertEl.innerHTML = `<span style="color:#EF4444">⛔ 403 — réessaie dans un instant</span>`;
                } else {
                    if (alertEl) alertEl.innerHTML = `<span style="color:#ef4444;">Erreur : ${err && err.message ? err.message : 'ouverture échouée'}</span>`;
                }
            } finally {
                openPackBtn.disabled = false;
                openPackBtn.innerText = prev || '📦 Ouvrir pack';
            }
        };

        // Auto-restart après F5 si le Pack Opener tournait avant
        if (sessionStorage.getItem('wm_packopener_active')) {
            setPackOpenerRunning(true);
        }

        document.getElementById('wm-raz-btn').onclick = () => {
            if (!confirm("Remettre à zéro les stats du jour ?\n(Les stats cumulées dans Paramètres ne sont pas touchées.)")) return;
            resetSessionStats();
            renderRarityStats(rarityEl);
            const p = document.getElementById("wm-packs"); if (p) p.innerText = "0 packs";
        };

        /* ════════ MARKET WATCHER ════════ */
        const marketStatusEl = document.getElementById("wm-market-status");
        const marketAlertEl  = document.getElementById("wm-market-alert");
        const marketBtn      = document.getElementById("wm-market-btn");

        marketBtn.onclick = () => {
            if (!marketWatcherActive) {
                marketWatcherActive = true;
                marketBtn.className = "wm-btn wm-r wm-sm"; marketBtn.innerText = "⏹ STOP";
                document.getElementById('dot-market').classList.add('on');
                startMarketWatcher(marketAlertEl, marketStatusEl);
                wmLog("🛒 Market Watcher démarré");
            } else {
                stopMarketWatcher(true); marketWatcherActive = false;
                marketBtn.className = "wm-btn wm-g wm-sm"; marketBtn.innerText = "▶ START";
                document.getElementById('dot-market').classList.remove('on');
                marketAlertEl.innerHTML = ""; marketStatusEl.innerHTML = "";
                wmLog("⏹ Market Watcher arrêté");
            }
            updateDots();
        };

        document.getElementById('wm-kw-toggle').onclick = () => {
            const p = document.getElementById('wm-keywords-panel');
            const btn = document.getElementById('wm-kw-toggle');
            const open = p.style.display !== 'none';
            p.style.display = open ? 'none' : 'block';
            btn.innerText = open ? '▶' : '▼';
            if (!open) renderKeywordsPanel();
        };

        const autoSnipeBtn = document.getElementById('wm-autosnipe-btn');
        autoSnipeBtn.onclick = function() { window.wmToggleAutoSnipe(this); };

        const aggroChk = document.getElementById('wm-hunter-aggro');
        if (aggroChk) aggroChk.onchange = () => window.wmToggleHunterAggressive();
        paintHunterAggro(); // reflète l'état persisté au chargement (case + libellé du bouton)

        // Tri du watcher market : initialise la valeur sauvegardée et réagit aux changements
        const sortSelect = document.getElementById('wm-sort-select');
        if (sortSelect) {
            sortSelect.value = marketSortKey;
            sortSelect.onchange = () => {
                marketSortKey = sortSelect.value;
                try { localStorage.setItem(MARKET_SORT_KEY, marketSortKey); } catch(e) {}
                // Re-render immédiat sans attendre le prochain scan
                if (lastHitsCache.length > 0) {
                    renderMarketHits(marketAlertEl, lastHitsCache, []);
                }
            };
        }

        // Case "masquer les cartes déjà possédées" (persistée)
        const hideOwnedChk = document.getElementById('wm-hide-owned');
        if (hideOwnedChk) {
            hideOwnedChk.checked = marketHideOwned;
            hideOwnedChk.onchange = () => {
                marketHideOwned = hideOwnedChk.checked;
                try { localStorage.setItem(MARKET_HIDE_OWNED_KEY, marketHideOwned ? '1' : '0'); } catch(e) {}
                if (lastHitsCache.length > 0) renderMarketHits(marketAlertEl, lastHitsCache, []);
            };
        }

        // Vue des annonces : détaillé / compact / cadres (persistée)
        const viewSelect = document.getElementById('wm-view-select');
        if (viewSelect) {
            viewSelect.value = marketView;
            viewSelect.onchange = () => {
                if (!MARKET_VIEWS.includes(viewSelect.value)) return;
                marketView = viewSelect.value;
                try { localStorage.setItem(MARKET_VIEW_KEY, marketView); } catch(e) {}
                // Les lignes dépliées à la main n'ont de sens qu'en compact.
                if (marketView !== 'compact') marketExpandedIds.clear();
                if (lastHitsCache.length > 0) renderMarketHits(marketAlertEl, lastHitsCache, []);
            };
        }

        // Barre de recherche du watcher : filtre live des annonces affichées
        const marketSearchInput = document.getElementById('wm-market-search');
        const marketSearchClear = document.getElementById('wm-market-search-clear');
        if (marketSearchInput) {
            marketSearchInput.value = marketSearchQuery;
            marketSearchInput.oninput = () => {
                marketSearchQuery = marketSearchInput.value;
                if (lastHitsCache.length > 0) renderMarketHits(marketAlertEl, lastHitsCache, []);
            };
        }
        if (marketSearchClear) {
            marketSearchClear.onclick = () => {
                marketSearchQuery = '';
                if (marketSearchInput) marketSearchInput.value = '';
                if (lastHitsCache.length > 0) renderMarketHits(marketAlertEl, lastHitsCache, []);
                if (marketSearchInput) marketSearchInput.focus();
            };
        }

        if (sessionStorage.getItem('wm_watcher_active')) {
            const cached = sessionStorage.getItem('wm_hits_cache');
            let restored = false;
            if (cached) {
                try {
                    const hits = JSON.parse(cached);
                    hits.forEach(a => { lastMarketHits.add(a.id); activeHitsMap.set(a.id, { auction:a, endAt:a.end_at }); });
                    hits.sort((a,b) => new Date(a.end_at)-new Date(b.end_at));
                    renderMarketHits(marketAlertEl, hits, []);
                    startCountdownTicker(marketAlertEl);
                    marketWatcherActive = true;
                    marketBtn.className = "wm-btn wm-r wm-sm"; marketBtn.innerText = "⏹ STOP";
                    document.getElementById('dot-market').classList.add('on');
                    runMarketScanLoop(marketAlertEl, marketStatusEl);
                    // Démarre la hot lane (cas reload : on a déjà les hits en cache)
                    setTimeout(() => startHotLane(), 1000);
                    updateDots();
                    restored = true;
                } catch(e) {}
            }
            // Fallback : si cache manquant ou parse échoué, démarrage fresh
            if (!restored) {
                startMarketWatcher(marketAlertEl, marketStatusEl);
                marketBtn.className = "wm-btn wm-r wm-sm"; marketBtn.innerText = "⏹ STOP";
                document.getElementById('dot-market').classList.add('on');
                updateDots();
            }
        }

        /* ════════ TRASH SELLER ════════ */
        const trashBtn    = document.getElementById("wm-trash-btn");
        const trashStatus = document.getElementById("wm-trash-status");

        // Bouton "Refresh ventes" : annule les ventes sans mise et re-liste selon la stratégie
        const refreshSalesBtn = document.getElementById('wm-refresh-sales-btn');
        if (refreshSalesBtn) {
            refreshSalesBtn.onclick = () => {
                if (refreshSalesRunning) return;
                if (!confirm('Refresh des ventes :\n\n• Les ventes SANS mise seront annulées (celles avec mise sont gardées).\n• Les cartes annulées reçoivent à nouveau le tag.\n• On remet en vente jusqu\'au maximum selon ta stratégie de sélection.\n\nContinuer ?')) return;
                refreshSales(refreshSalesBtn, trashStatus);
            };
        }

        function startTrashSeller() {
            trashBtn.innerText = "⏹ STOP"; trashBtn.className = "wm-btn wm-r wm-sm";
            document.getElementById('dot-trash').classList.add('on');
            sessionStorage.setItem('wm_trashseller_active', '1');
            sellTrashCards(trashBtn, trashStatus);
            updateDots();
        }

        trashBtn.onclick = () => {
            if (!trashSellerRunning) {
                startTrashSeller();
            } else {
                trashSellerRunning = false;
                trashBtn.innerText = "▶ START"; trashBtn.className = "wm-btn wm-g wm-sm";
                document.getElementById('dot-trash').classList.remove('on');
                sessionStorage.removeItem('wm_trashseller_active');
                wmLog("⏹ Trash Seller arrêté");
                updateDots();
            }
        };

        // Auto-restart après F5 si le Trash Seller tournait avant
        if (sessionStorage.getItem('wm_trashseller_active')) {
            startTrashSeller();
        }

        /* ════════ HEADER CONTROLS ════════ */
        document.getElementById('wm-close-btn').onclick = () => overlay.classList.remove('open');
        document.getElementById('wm-log-export').onclick = () => exportLogs();

        /* ════════ PARAMÈTRES ════════ */
        const settingsHdr     = document.getElementById('wm-settings-hdr');
        const settingsBody    = document.getElementById('wm-settings-body');
        const settingsChevron = document.getElementById('wm-settings-chevron');
        const webhookInput    = document.getElementById('wm-webhook-input');
        const webhookSaveBtn  = document.getElementById('wm-webhook-save');
        const webhookTestBtn  = document.getElementById('wm-webhook-test');
        const webhookClearBtn = document.getElementById('wm-webhook-clear');
        const settingsStatus  = document.getElementById('wm-settings-status');

        function refreshWebhookStatus() {
            const url = getDiscordWebhook();
            const enabled = getSetting('discordEnabled');
            if (url && enabled) {
                const masked = url.length > 50 ? url.slice(0, 45) + '…' + url.slice(-5) : url;
                settingsStatus.innerHTML = `<span style="color:#4ade80;">✓ Notifications actives</span> · <span style="color:#555;font-family:'JetBrains Mono',monospace;font-size:9px;">${masked}</span>`;
            } else if (url && !enabled) {
                settingsStatus.innerHTML = `<span style="color:#fbbf24;">⏸ Webhook configuré mais notifications désactivées</span>`;
            } else {
                settingsStatus.innerHTML = `<span style="color:#888;">⚠ Webhook non configuré</span>`;
            }
        }

        // -- Init valeurs (lecture depuis settings) --
        webhookInput.value = getDiscordWebhook();
        const discordEnabledChk    = document.getElementById('wm-set-discord-enabled');
        const logColChk            = document.getElementById('wm-set-log-collection');
        const logMktChk            = document.getElementById('wm-set-log-market');
        const logTrashChk          = document.getElementById('wm-set-log-trash');
        const logAutobidChk        = document.getElementById('wm-set-log-autobid');
        const autoSnipePriceInput      = document.getElementById('wm-set-autosnipe-price');
        const autoSnipeMinBalanceInput = document.getElementById('wm-set-autosnipe-min-balance');
        const autoSnipeRatioInput      = document.getElementById('wm-set-autosnipe-ratio');
        const bidDelayInput            = document.getElementById('wm-set-bid-delay');
        const dailyAlertChk            = document.getElementById('wm-set-daily-alert');
        const dailyLimitInput          = document.getElementById('wm-set-daily-limit');
        const autoRetagChk         = document.getElementById('wm-set-autoretag-enabled');
        const wishlistKwChk        = document.getElementById('wm-set-wishlist-keyword');
        const soundNewHitChk       = document.getElementById('wm-set-sound-newhit');
        const soundOutbidChk       = document.getElementById('wm-set-sound-outbid');
        const soundPackChk         = document.getElementById('wm-set-sound-pack');
        const soundLegendaryChk    = document.getElementById('wm-set-sound-legendary');
        const soundWonChk          = document.getElementById('wm-set-sound-won');
        const notifsChk            = document.getElementById('wm-set-notifications-enabled');
        const tagNameInput         = document.getElementById('wm-set-tag-name');
        const tagSaveBtn           = document.getElementById('wm-set-tag-save');
        const tagStatusEl          = document.getElementById('wm-set-tag-status');

        discordEnabledChk.checked         = getSetting('discordEnabled');
        logColChk.checked                 = getSetting('logCollection');
        logMktChk.checked                 = getSetting('logMarket');
        logTrashChk.checked               = getSetting('logTrash');
        logAutobidChk.checked             = getSetting('logAutobid');
        autoSnipePriceInput.value         = getSetting('autoSnipePrice');
        autoSnipeMinBalanceInput.value    = getSetting('minBalanceForAutoSnipe');
        autoSnipeRatioInput.value         = Math.round(getSetting('autoSnipeAdaptiveRatio') * 100);
        if (bidDelayInput) bidDelayInput.value = getSetting('humanizedBidDelayMs');
        dailyAlertChk.checked             = getSetting('dailyPackAlert');
        dailyLimitInput.value             = getSetting('dailyPackLimit');
        autoRetagChk.checked              = getSetting('autoRetagEnabled');
        if (wishlistKwChk) wishlistKwChk.checked = getSetting('wishlistToKeyword');
        soundNewHitChk.checked            = getSetting('soundNewHit');
        soundOutbidChk.checked            = getSetting('soundOutbid');
        soundPackChk.checked              = getSetting('soundPackOpen');
        soundLegendaryChk.checked         = getSetting('soundLegendary');
        if (soundWonChk) soundWonChk.checked = getSetting('soundWon');
        notifsChk.checked                 = getSetting('notificationsEnabled');
        tagNameInput.value                = getSetting('sellTagName');

        // Radio mode auto-snipe + affichage conditionnel des champs fixe/adaptatif
        function applySnipeModeUI() {
            const mode = getSetting('autoSnipeMode');
            document.querySelectorAll('input[name="wm-set-snipe-mode"]').forEach(r => {
                r.checked = (r.value === mode);
            });
            // Grise le champ non pertinent selon le mode
            const fixedRow = autoSnipePriceInput;
            const ratioRow = autoSnipeRatioInput;
            if (mode === 'adaptive') {
                fixedRow.style.opacity = '0.4';
                ratioRow.style.opacity = '1';
            } else {
                fixedRow.style.opacity = '1';
                ratioRow.style.opacity = '0.4';
            }
        }
        applySnipeModeUI();
        document.querySelectorAll('input[name="wm-set-snipe-mode"]').forEach(radio => {
            radio.onchange = () => {
                if (radio.checked) {
                    setSetting('autoSnipeMode', radio.value);
                    applySnipeModeUI();
                    // Rafraîchit le label du bouton auto-snipe du market
                    paintHunterAggro(); // le libellé du bouton Hunter dépend du mode
                    wmLog(radio.value === 'adaptive'
                        ? '🎯 Hunter en mode <b>dynamique</b> (sous la médiane du marché)'
                        : '🎯 Hunter en mode <b>seuil fixe</b>');
                }
            };
        });

        // Ratio adaptatif
        autoSnipeRatioInput.onchange = () => {
            let pct = parseInt(autoSnipeRatioInput.value, 10);
            if (!Number.isFinite(pct) || pct < 1) pct = 85;
            if (pct > 200) pct = 200;
            autoSnipeRatioInput.value = pct;
            setSetting('autoSnipeAdaptiveRatio', pct / 100);
            wmLog(`🎯 Hunter dynamique : seuil à ${pct}% de la médiane`);
        };

        // Délai humanisé avant une mise
        if (bidDelayInput) bidDelayInput.onchange = () => {
            let v = parseInt(bidDelayInput.value, 10);
            if (!Number.isFinite(v) || v < 0) v = 0;
            if (v > 10000) v = 10000;
            bidDelayInput.value = v;
            setSetting('humanizedBidDelayMs', v);
            wmLog(v === 0
                ? '⚡ Délai de mise : <b>instantané</b> (0 ms)'
                : `⏱️ Délai de mise humanisé : plafond <b>${v} ms</b> (instantané en fin d'enchère)`);
        };

        // Mode Fourbe : secondes visées pour le snipe
        const snipeSecInput = document.getElementById('wm-set-snipe-seconds');
        if (snipeSecInput) {
            snipeSecInput.value = getSetting('snipeSecondsBefore');
            snipeSecInput.onchange = () => {
                let v = parseInt(snipeSecInput.value, 10);
                if (!Number.isFinite(v) || v < 5) v = 10;
                if (v > 120) v = 120;
                snipeSecInput.value = v;
                setSetting('snipeSecondsBefore', v);
                wmLog(`🕵️ Mode Fourbe : snipe visé à <b>${v}s</b> de la fin`);
            };
        }

        // Alerte volume packs
        dailyAlertChk.onchange = () => {
            setSetting('dailyPackAlert', dailyAlertChk.checked);
            wmLog(dailyAlertChk.checked
                ? `🔔 Alerte volume activée (seuil : ${getSetting('dailyPackLimit')} packs/jour)`
                : '🔕 Alerte volume désactivée');
            updateDailyPacksInfo();
        };
        dailyLimitInput.onchange = () => {
            let v = parseInt(dailyLimitInput.value, 10);
            if (!Number.isFinite(v) || v < 1) v = 300;
            dailyLimitInput.value = v;
            setSetting('dailyPackLimit', v);
            dailyAlertFired = false; // ré-arme l'alerte avec le nouveau seuil
            updateDailyPacksInfo();
        };
        function updateDailyPacksInfo() {
            const el = document.getElementById('wm-daily-packs-info');
            if (!el) return;
            const limit = getSetting('dailyPackLimit');
            const pct = limit > 0 ? Math.round((dailyPacks.count / limit) * 100) : 0;
            const col = dailyPacks.count >= limit ? '#ef4444' : (pct >= 80 ? '#fbbf24' : '#888');
            el.innerHTML = `Aujourd'hui : <b style="color:${col};">${dailyPacks.count}</b> / ${limit} packs (${pct}%)`;
        }
        window.wmUpdateDailyPacksInfo = updateDailyPacksInfo; // appelé depuis incrementDailyPacks
        updateDailyPacksInfo();

        // -- Plages horaires par module (démarrage/arrêt programmé) --
        [
            { label: 'Pack Opener',    ena: 'schedulePackEnabled',   start: 'schedulePackStart',   end: 'schedulePackEnd',   ids: ['pack'] },
            { label: 'Market Watcher', ena: 'scheduleMarketEnabled', start: 'scheduleMarketStart', end: 'scheduleMarketEnd', ids: ['market'] },
            { label: 'Trash Seller',   ena: 'scheduleTrashEnabled',  start: 'scheduleTrashStart',  end: 'scheduleTrashEnd',  ids: ['trash'] },
        ].forEach(mod => {
            const id = mod.ids[0];
            const ena = document.getElementById(`wm-set-schedule-${id}-enabled`);
            const st  = document.getElementById(`wm-set-schedule-${id}-start`);
            const en  = document.getElementById(`wm-set-schedule-${id}-end`);
            if (ena) ena.checked = getSetting(mod.ena);
            if (st)  st.value    = getSetting(mod.start);
            if (en)  en.value    = getSetting(mod.end);
            const onChange = () => {
                if (ena) setSetting(mod.ena, ena.checked);
                if (st && st.value) setSetting(mod.start, st.value);
                if (en && en.value) setSetting(mod.end, en.value);
                wmLog(ena && ena.checked
                    ? `⏰ Horaire ${mod.label} : <b>${getSetting(mod.start)} → ${getSetting(mod.end)}</b>`
                    : `⏰ Horaire ${mod.label} désactivé`);
                if (window.wmScheduleReeval) window.wmScheduleReeval();
            };
            if (ena) ena.onchange = onChange;
            if (st)  st.onchange  = onChange;
            if (en)  en.onchange  = onChange;
        });

        // Radio packCooldown : coche le bon bouton selon la valeur stockée
        // Helper : ajuste dynamiquement le plafond du champ "ventes actives max"
        // selon l'abonnement (compte abonné = 10 max, gratuit = 5 max).
        function applyMaxActiveCap() {
            const isSubscriber = parseInt(getSetting('packCooldown'), 10) === 180;
            const cap = isSubscriber ? 10 : 5;
            const input = document.getElementById('wm-set-max-active-sales');
            if (!input) return cap;
            input.max = String(cap);
            // Clamp la valeur courante si elle dépasse le nouveau plafond
            let cur = parseInt(input.value, 10);
            if (!Number.isFinite(cur) || cur < 1) cur = 1;
            if (cur > cap) {
                cur = cap;
                input.value = cur;
                setSetting('maxActiveSales', cur);
                // Refresh affichage du compteur
                const lbl = document.getElementById('wm-active-sales-count');
                if (lbl) {
                    const c = parseInt(lbl.innerText.split('/')[0], 10) || 0;
                    lbl.innerText = `${c}/${cur}`;
                }
            }
            return cap;
        }

        const packCdRadios = Array.from(document.querySelectorAll('input[name="wm-set-pack-cd"]'));
        const currentCd = String(getSetting('packCooldown'));
        packCdRadios.forEach(r => { r.checked = (r.value === currentCd); });
        packCdRadios.forEach(r => {
            r.onchange = () => {
                if (!r.checked) return;
                const sec = parseInt(r.value, 10);
                if (!Number.isFinite(sec)) return;
                setSetting('packCooldown', sec);
                const cap = applyMaxActiveCap();
                wmLog(`⏱️ Cooldown packs : <b>${sec === 180 ? '3 minutes (abonné)' : '10 minutes (non-abonné)'}</b> · plafond ventes : <b>${cap}</b>`);
            };
        });

        // Max ventes actives simultanées
        const maxActiveInput = document.getElementById('wm-set-max-active-sales');
        maxActiveInput.value = getSetting('maxActiveSales');
        applyMaxActiveCap(); // applique le plafond au chargement initial
        maxActiveInput.onchange = () => {
            const cap = parseInt(maxActiveInput.max, 10) || 5;
            let v = parseInt(maxActiveInput.value, 10);
            if (!Number.isFinite(v) || v < 1) v = 1;
            if (v > cap) v = cap;
            maxActiveInput.value = v;
            setSetting('maxActiveSales', v);
            wmLog(`🛒 Ventes actives max : <b>${v}</b>`);
            const lbl = document.getElementById('wm-active-sales-count');
            if (lbl) {
                const current = parseInt(lbl.innerText.split('/')[0], 10) || 0;
                lbl.innerText = `${current}/${v}`;
            }
        };

        // Tableau prix + durée par rareté
        function renderSellTable() {
            const tbody = document.getElementById('wm-sell-table-body');
            if (!tbody) return;
            const cfg = getSellConfig();
            const order = ['L', 'UR', 'SR', 'R', 'PC', 'C'];
            const durLabel = m => m < 60 ? `${m} min` : `${m/60} h`;
            tbody.innerHTML = order.map(rar => {
                const c = RARITY[rar] || { color: '#888' };
                const { price, duration } = cfg[rar];
                const opts = SELL_DURATION_CHOICES.map(m =>
                    `<option value="${m}"${m === duration ? ' selected' : ''}>${durLabel(m)}</option>`
                ).join('');
                return `<tr>
                    <td style="padding:2px 6px;">
                        <span style="display:inline-block;min-width:24px;text-align:center;padding:2px 6px;border-radius:3px;background:${c.color}33;color:${c.color};font-weight:700;font-size:10px;">${rar}</span>
                    </td>
                    <td style="padding:2px 6px;">
                        <input type="number" min="1" step="1" value="${price}" data-rar="${rar}" data-field="price" class="wm-input" style="width:80px;padding:3px 6px;">
                    </td>
                    <td style="padding:2px 6px;">
                        <select data-rar="${rar}" data-field="duration" class="wm-input" style="width:90px;padding:3px 6px;">${opts}</select>
                    </td>
                </tr>`;
            }).join('');
            // Bind onchange à chaque champ
            tbody.querySelectorAll('[data-rar]').forEach(el => {
                el.onchange = () => {
                    const rar = el.getAttribute('data-rar');
                    const field = el.getAttribute('data-field');
                    const cfg = getSellConfig();
                    if (field === 'price') {
                        let v = parseInt(el.value, 10);
                        if (!Number.isFinite(v) || v < 1) v = 1;
                        el.value = v;
                        cfg[rar].price = v;
                        setSellConfig(cfg);
                        wmLog(`💰 Prix <b>${rar}</b> : <span style="color:#fbbf24;">${v} 💰</span>`);
                    } else if (field === 'duration') {
                        const v = parseInt(el.value, 10);
                        if (!Number.isFinite(v)) return;
                        cfg[rar].duration = v;
                        setSellConfig(cfg);
                        wmLog(`🕒 Durée <b>${rar}</b> : <b>${v < 60 ? v + ' min' : (v/60) + ' h'}</b>`);
                    }
                };
            });
        }
        renderSellTable();

        // Trash Seller : prix au marché (moyenne × %) avec repli sur le tableau par rareté
        const sellMarketChk = document.getElementById('wm-set-sell-market');
        const sellMarketPctInput = document.getElementById('wm-set-sell-market-pct');
        if (sellMarketChk) sellMarketChk.checked = getSetting('sellUseMarketPrice');
        if (sellMarketPctInput) sellMarketPctInput.value = getSetting('sellMarketPricePct');
        if (sellMarketChk) sellMarketChk.onchange = () => {
            setSetting('sellUseMarketPrice', sellMarketChk.checked);
            wmLog(sellMarketChk.checked
                ? `💹 Trash Seller : prix au marché activé (${getSetting('sellMarketPricePct')}% de la moyenne · repli tableau si aucune vente)`
                : '💹 Trash Seller : prix au marché désactivé — le tableau par rareté est utilisé');
        };
        if (sellMarketPctInput) sellMarketPctInput.onchange = () => {
            let v = parseInt(sellMarketPctInput.value, 10);
            if (!Number.isFinite(v) || v < 1) v = 100;
            if (v > 500) v = 500;
            sellMarketPctInput.value = v;
            setSetting('sellMarketPricePct', v);
            wmLog(`💹 Trash Seller : prix au marché réglé à <b>${v}%</b> de la moyenne`);
        };

        // Plancher : prix marché jamais sous le tableau
        const sellMarketFloorChk = document.getElementById('wm-set-sell-market-floor');
        if (sellMarketFloorChk) {
            sellMarketFloorChk.checked = getSetting('sellMarketFloor');
            sellMarketFloorChk.onchange = () => {
                setSetting('sellMarketFloor', sellMarketFloorChk.checked);
                wmLog(sellMarketFloorChk.checked
                    ? '🛡️ Plancher activé : le prix marché ne descendra pas sous le prix du tableau'
                    : '🛡️ Plancher désactivé : le prix marché peut descendre sous le tableau');
            };
        }

        // Prix dégressif sur les invendus récurrents
        const sellDegressiveChk = document.getElementById('wm-set-sell-degressive');
        if (sellDegressiveChk) {
            sellDegressiveChk.checked = getSetting('sellDegressive');
            sellDegressiveChk.onchange = () => {
                setSetting('sellDegressive', sellDegressiveChk.checked);
                wmLog(sellDegressiveChk.checked
                    ? '📉 Prix dégressif activé : -15% par tranche de 10 remises en vente'
                    : '📉 Prix dégressif désactivé');
            };
        }

        // Undercut du marché à la mise en vente
        const sellUndercutChk = document.getElementById('wm-set-sell-undercut');
        if (sellUndercutChk) {
            sellUndercutChk.checked = getSetting('sellUndercutMarket');
            sellUndercutChk.onchange = () => {
                setSetting('sellUndercutMarket', sellUndercutChk.checked);
                wmLog(sellUndercutChk.checked
                    ? '🃏 Undercut activé : mise en vente juste sous la plus basse annonce existante'
                    : '🃏 Undercut désactivé');
            };
        }

        // Filet de sécurité : ne vendre que si le tag de vente est le SEUL tag de la carte
        const sellSoleTagChk = document.getElementById('wm-set-sell-sole-tag');
        if (sellSoleTagChk) {
            sellSoleTagChk.checked = getSetting('sellOnlyIfSoleTag');
            sellSoleTagChk.onchange = () => {
                setSetting('sellOnlyIfSoleTag', sellSoleTagChk.checked);
                wmLog(sellSoleTagChk.checked
                    ? '🛡️ Filet de sécurité activé : une carte n\'est vendue que si « ' + getSellTagName() + ' » est son SEUL tag'
                    : '⚠️ Filet de sécurité désactivé : les cartes « ' + getSellTagName() + ' » sont vendues même avec d\'autres tags');
            };
        }

        // Trash Seller : stratégie de sélection de la pool à mettre en vente
        const trashStrategySelect = document.getElementById('wm-set-trash-strategy');
        if (trashStrategySelect) {
            trashStrategySelect.value = getSetting('trashSellStrategy');
            trashStrategySelect.onchange = () => {
                setSetting('trashSellStrategy', trashStrategySelect.value);
                const labels = {
                    coverage: 'Équitable (moins listées d\'abord)',
                    value:    'Valeur (plus chères d\'abord)',
                    rarity:   'Rareté (plus rares d\'abord)',
                    random:   'Aléatoire'
                };
                wmLog(`🎯 Trash Seller : priorité de vente → <b>${labels[trashStrategySelect.value] || trashStrategySelect.value}</b>`);
            };
        }

        function refreshTagStatus() {
            const name = getSetting('sellTagName');
            const id = TRASH_TAG_ID;
            if (id) {
                tagStatusEl.innerHTML = `<span style="color:#4ade80;">✓ Tag "<b>${name}</b>"</span> · <span style="color:#555;font-family:'JetBrains Mono',monospace;font-size:9px;">${id.slice(0,8)}…</span>`;
            } else {
                tagStatusEl.innerHTML = `<span style="color:#fbbf24;">⚠ Tag "<b>${name}</b>" non découvert — crée-le sur wiki-masters</span>`;
            }
        }
        refreshTagStatus();
        refreshWebhookStatus();

        // -- Toggle de la section --
        // État ouvert/fermé des panneaux accordéon, persisté entre les sessions
        const PANEL_STATE_KEY = 'wm_panel_open_state';
        let panelOpenState = {};
        try { panelOpenState = JSON.parse(localStorage.getItem(PANEL_STATE_KEY) || '{}') || {}; } catch(e) {}
        function savePanelState() {
            try { localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(panelOpenState)); } catch(e) {}
        }

        settingsHdr.onclick = () => {
            const open = settingsBody.classList.toggle('open');
            settingsChevron.innerText = open ? '▾' : '▴';
            panelOpenState.settings = open;
            savePanelState();
        };

        // -- Panneau Statistiques (accordéon jumeau) --
        const statsHdr     = document.getElementById('wm-stats-hdr');
        const statsBody     = document.getElementById('wm-stats-body');
        const statsChevron = document.getElementById('wm-stats-chevron');
        if (statsHdr) {
            statsHdr.onclick = () => {
                const open = statsBody.classList.toggle('open');
                statsChevron.innerText = open ? '▾' : '▴';
                panelOpenState.stats = open;
                savePanelState();
                if (open) renderStatsPanel(); // recalcule à chaque ouverture
            };
        }

        // Restaure l'état ouvert/fermé sauvegardé
        if (panelOpenState.settings) {
            settingsBody.classList.add('open');
            settingsChevron.innerText = '▾';
        }
        if (panelOpenState.stats && statsBody) {
            statsBody.classList.add('open');
            if (statsChevron) statsChevron.innerText = '▾';
            renderStatsPanel();
        }

        // -- Module Étiquetage en masse --
        const taggerHdr      = document.getElementById('wm-tagger-hdr');
        const taggerBody     = document.getElementById('wm-tagger-body');
        const taggerChevron  = document.getElementById('wm-tagger-chevron');
        const taggerKeyword  = document.getElementById('wm-tagger-keyword');
        const taggerTagInput = document.getElementById('wm-tagger-tag');
        const taggerGroupInput = document.getElementById('wm-tagger-group');
        const taggerGroupList  = document.getElementById('wm-tagger-grouplist');
        const taggerUntagged = document.getElementById('wm-tagger-untagged-only');
        const taggerExtended = document.getElementById('wm-tagger-extended');
        const taggerForceScan = document.getElementById('wm-tagger-force-scan');
        const taggerDuplicatesBtn = document.getElementById('wm-tagger-duplicates');
        const taggerScanBtn  = document.getElementById('wm-tagger-scan');
        const taggerApplyBtn = document.getElementById('wm-tagger-apply');
        const taggerStatus   = document.getElementById('wm-tagger-status');
        const taggerResults  = document.getElementById('wm-tagger-results');
        const taggerDatalist = document.getElementById('wm-tagger-taglist');
        let taggerMatches = [];
        // Groupes de présets repliés (état transitoire, non persisté)
        const taggerCollapsedGroups = new Set();

        // Normalisation insensible à la casse ET aux accents (japon == Japon == JAPÓN)
        const TAGGER_DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g');
        const taggerNorm = (s) => (s || '').toString()
            .normalize('NFD').replace(TAGGER_DIACRITICS, '').toLowerCase();
        const taggerEsc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        // Découpe une saisie "japon; marvel" en termes normalisés (OU logique).
        // Séparateur = POINT-VIRGULE (;) pour ne PAS casser les titres à virgule
        // (ex. « Star Wars, épisode I »). Les anciens présets à virgules sont migrés au chargement.
        const taggerTerms = (raw) => (raw || '').split(';').map(s => taggerNorm(s.trim())).filter(Boolean);

        // Champs "texte" plausibles d'une carte. Le nom exact du champ description
        // varie selon l'API ; on ratisse large (titre + catégorie + résumé/extrait/
        // description) sur item ET item.card, pour ne rien rater.
        // Champs "identité" : ce que la carte EST (son titre/nom). Match précis par défaut.
        const TAGGER_ID_KEYS = ['wikipedia_title', 'title', 'name'];
        // Champs "étendus" : ce que la carte MENTIONNE (catégories, description, résumé…).
        // N'entrent en jeu que si le préset est en mode "recherche étendue" — sinon la fiche
        // d'un film matcherait tout acteur/réalisateur cité dans son extrait (faux positifs).
        const TAGGER_TEXT_KEYS = [...TAGGER_ID_KEYS, 'category', 'categories',
            'description', 'desc', 'summary', 'extract', 'wikipedia_extract', 'wikipedia_description',
            'subtitle', 'bio', 'text', 'content', 'abstract'];
        // scope 'full' → titre + catégories + description… ; sinon (défaut) → titre/nom seuls.
        function taggerSearchText(item, scope) {
            const keys = scope === 'full' ? TAGGER_TEXT_KEYS : TAGGER_ID_KEYS;
            const parts = [];
            const collect = (obj) => {
                if (!obj || typeof obj !== 'object') return;
                for (const k of keys) {
                    const v = obj[k];
                    if (typeof v === 'string') parts.push(v);
                    else if (Array.isArray(v)) parts.push(v.filter(x => typeof x === 'string').join(' '));
                }
            };
            collect(item);
            collect(item.card);
            return taggerNorm(parts.join('  ')); // séparateur pour éviter les collisions inter-champs
        }

        // Log unique des champs réellement renvoyés par l'API (diagnostic : permet de
        // confirmer si une description existe, et sous quel nom).
        let _taggerFieldsLogged = false;
        function logTaggerCardFields(sample) {
            if (_taggerFieldsLogged || !sample) return;
            _taggerFieldsLogged = true;
            const top = Object.keys(sample).join(', ');
            const card = sample.card && typeof sample.card === 'object' ? Object.keys(sample.card).join(', ') : '(aucun)';
            wmLog(`🔬 Champs carte disponibles — item : <span style="color:#888;font-size:9px;">${top}</span>`);
            wmLog(`🔬 Champs carte disponibles — card : <span style="color:#888;font-size:9px;">${card}</span>`);
        }

        async function populateTagDatalist() {
            if (!taggerDatalist) return;
            const tags = await fetchUserTags();
            taggerDatalist.innerHTML = tags
                .map(t => `<option value="${(t.name || '').replace(/"/g, '&quot;')}">`).join('');
        }

        const TAGGER_RENDER_CAP = 800; // au-delà, on n'affiche pas toutes les lignes (perf DOM)
        function renderTaggerResults() {
            if (!taggerResults) return;
            if (taggerMatches.length === 0) { taggerResults.innerHTML = ''; return; }
            const shown = taggerMatches.slice(0, TAGGER_RENDER_CAP);
            let html = shown.map((m, i) => {
                const title = m.card?.wikipedia_title || m.wikipedia_title || '?';
                const rar = (m.card?.rarity || m.rarity || 'C').toUpperCase();
                const tagNames = (m.tags || []).map(t => t.name).filter(Boolean).join(', ');
                return `<label style="display:flex;align-items:center;gap:6px;padding:2px 0;font-size:10px;cursor:pointer;">
                    <input type="checkbox" class="wm-tagger-cb" data-idx="${i}" checked style="accent-color:#4ade80;flex-shrink:0;">
                    <span style="flex:1;color:#ccc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${title} <span style="color:#666;">[${rar}]</span></span>
                    ${tagNames ? `<span style="color:#555;font-size:9px;white-space:nowrap;">${tagNames}</span>` : ''}
                </label>`;
            }).join('');
            if (taggerMatches.length > TAGGER_RENDER_CAP) {
                html += `<div style="color:#888;font-size:10px;padding:6px 0;text-align:center;border-top:1px solid rgba(255,255,255,0.06);margin-top:4px;">
                    … et <b>${taggerMatches.length - TAGGER_RENDER_CAP}</b> autre(s) non affichée(s). Elles seront <b>incluses</b> si tu appliques un tag — affine avec un mot-clé pour un tri précis.</div>`;
            }
            taggerResults.innerHTML = html;
        }

        function getSelectedTaggerMatches() {
            const sel = [];
            taggerResults.querySelectorAll('.wm-tagger-cb').forEach(cb => {
                if (cb.checked) { const m = taggerMatches[parseInt(cb.dataset.idx, 10)]; if (m) sel.push(m); }
            });
            // Cartes au-delà du plafond d'affichage : incluses par défaut (non décochables)
            for (let i = TAGGER_RENDER_CAP; i < taggerMatches.length; i++) sel.push(taggerMatches[i]);
            return sel;
        }

        /* ── Recherches enregistrées (presets) : un clic = scan + application du tag ── */
        const TAGGER_PRESETS_KEY = 'wm_tagger_presets';
        let taggerPresets = [];
        try { taggerPresets = JSON.parse(localStorage.getItem(TAGGER_PRESETS_KEY) || '[]') || []; } catch(e) { taggerPresets = []; }
        function saveTaggerPresets() { try { localStorage.setItem(TAGGER_PRESETS_KEY, JSON.stringify(taggerPresets)); } catch(e) {} }
        // Index du préset en cours d'édition (via le crayon ✏️), -1 = mode ajout normal.
        let editingPresetIndex = -1;

        // ── Migration séparateur virgule → point-virgule ──
        // Les présets créés avant ce changement utilisaient la VIRGULE comme séparateur de
        // termes. On convertit leurs virgules en « ; » (sémantique identique : c'était déjà
        // des séparateurs), pour qu'ils continuent de fonctionner avec le nouveau split sur « ; ».
        // Un préset ne contenant PAS de « ; » et contenant une « , » est donc considéré comme
        // ancien multi-termes → converti. (Un flag évite de re-migrer à chaque chargement.)
        (function migratePresetSeparator() {
            if (localStorage.getItem('wm_tagger_presets_sep_v2')) return; // déjà migré
            let changed = false;
            taggerPresets.forEach(p => {
                if (p && typeof p.kw === 'string' && p.kw.includes(',') && !p.kw.includes(';')) {
                    p.kw = p.kw.split(',').map(s => s.trim()).filter(Boolean).join('; ');
                    changed = true;
                }
            });
            if (changed) saveTaggerPresets();
            try { localStorage.setItem('wm_tagger_presets_sep_v2', '1'); } catch(e) {}
            if (changed) wmLog('🔀 Présets migrés : séparateur des mots-clés passé de « , » à « ; » (titres à virgule désormais préservés).');
        })();
        const presetGroupName = (p) => (((p && p.group) || '').trim()) || 'Sans catégorie';

        // Datalist des catégories existantes (autocomplétion du champ Catégorie)
        function populateGroupDatalist() {
            if (!taggerGroupList) return;
            const names = [...new Set(taggerPresets.map(p => (p.group || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
            taggerGroupList.innerHTML = names.map(n => `<option value="${taggerEsc(n)}">`).join('');
        }

        function renderTaggerPresets() {
            const el = document.getElementById('wm-tagger-presets');
            if (!el) return;
            populateGroupDatalist();
            if (taggerPresets.length === 0) {
                el.innerHTML = '<div style="color:#444;font-size:10px;font-style:italic;">Aucune recherche enregistrée.</div>';
                return;
            }
            // Regroupe par catégorie (en conservant l'index d'origine pour run/suppression)
            const groups = new Map();
            taggerPresets.forEach((p, idx) => {
                const g = presetGroupName(p);
                if (!groups.has(g)) groups.set(g, []);
                groups.get(g).push({ p, idx });
            });
            const groupNames = [...groups.keys()].sort((a, b) =>
                a === 'Sans catégorie' ? 1 : b === 'Sans catégorie' ? -1 : a.localeCompare(b));

            el.innerHTML = groupNames.map(g => {
                const list = groups.get(g);
                const collapsed = taggerCollapsedGroups.has(g);
                const rows = collapsed ? '' : list.map(({ p, idx }) => `
                    <div style="display:flex;align-items:center;gap:6px;padding:2px 0 2px 18px;font-size:11px;">
                        <button data-run="${idx}" title="Scanner et appliquer « ${taggerEsc(p.tag)} »"
                            style="flex-shrink:0;padding:1px 7px;border:1px solid rgba(74,222,128,0.4);border-radius:4px;background:rgba(74,222,128,0.08);color:#4ade80;cursor:pointer;font-size:11px;">▶</button>
                        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ccc;">
                            <span style="color:#06b6d4;">${taggerEsc(p.kw)}</span>${p.untagged ? ' <span style="color:#888;font-size:9px;">(sans tag)</span>' : ''}${p.extended ? ' <span style="color:#a78bfa;font-size:9px;" title="Recherche étendue : description et catégories incluses">🔎 étendu</span>' : ''} <span style="color:#555;">→</span> <span style="color:#4ade80;">${taggerEsc(p.tag)}</span>
                        </span>
                        <button data-edit="${idx}" title="Modifier cette recherche" style="flex-shrink:0;background:none;border:none;color:#888;cursor:pointer;font-size:12px;line-height:1;padding:0 2px;">✏️</button>
                        <button data-del="${idx}" title="Supprimer cette recherche" style="flex-shrink:0;background:none;border:none;color:#666;cursor:pointer;font-size:14px;line-height:1;">×</button>
                    </div>`).join('');
                return `<div style="margin-bottom:6px;">
                    <div style="display:flex;align-items:center;gap:6px;padding:3px 4px;border-bottom:1px solid rgba(255,255,255,0.08);margin-bottom:2px;">
                        <span data-group-toggle="${taggerEsc(g)}" style="cursor:pointer;color:#888;font-size:10px;width:12px;text-align:center;">${collapsed ? '▸' : '▾'}</span>
                        <span style="flex:1;color:#fbbf24;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${taggerEsc(g)} <span style="color:#666;font-weight:400;">(${list.length})</span></span>
                        <button data-run-group="${taggerEsc(g)}" title="Lancer les ${list.length} recherche(s) de « ${taggerEsc(g)} » en un seul scan"
                            style="flex-shrink:0;padding:1px 7px;border:1px solid rgba(6,182,212,0.4);border-radius:4px;background:rgba(6,182,212,0.08);color:#06b6d4;cursor:pointer;font-size:10px;">▶ groupe</button>
                    </div>
                    ${rows}
                </div>`;
            }).join('');

            el.querySelectorAll('button[data-run]').forEach(b => {
                b.onclick = () => runTaggerPreset(taggerPresets[parseInt(b.dataset.run, 10)]);
            });
            el.querySelectorAll('button[data-edit]').forEach(b => {
                b.onclick = () => startEditPreset(parseInt(b.dataset.edit, 10));
            });
            el.querySelectorAll('button[data-del]').forEach(b => {
                b.onclick = () => {
                    const idx = parseInt(b.dataset.del, 10);
                    // Si on supprime le préset en cours d'édition, on annule le mode édition.
                    if (idx === editingPresetIndex) cancelEditPreset();
                    else if (editingPresetIndex > idx) editingPresetIndex--; // l'index glisse
                    const removed = taggerPresets.splice(idx, 1)[0];
                    saveTaggerPresets();
                    renderTaggerPresets();
                    if (removed) wmLog(`🗑️ Recherche enregistrée retirée : « ${taggerEsc(removed.kw)} » → « ${taggerEsc(removed.tag)} »`);
                };
            });
            el.querySelectorAll('[data-group-toggle]').forEach(s => {
                s.onclick = () => {
                    const g = s.dataset.groupToggle;
                    if (taggerCollapsedGroups.has(g)) taggerCollapsedGroups.delete(g); else taggerCollapsedGroups.add(g);
                    renderTaggerPresets();
                };
            });
            el.querySelectorAll('button[data-run-group]').forEach(b => {
                b.onclick = () => {
                    const g = b.dataset.runGroup;
                    runPresetList(taggerPresets.filter(p => presetGroupName(p) === g), g);
                };
            });
        }

        // ── Édition d'un préset via le crayon ✏️ : charge ses valeurs dans le formulaire, le
        //    bouton d'enregistrement passe en mode « modifier » (met à jour au lieu d'ajouter).
        function updateSavePresetLabel() {
            if (taggerSavePresetBtn) taggerSavePresetBtn.innerText = editingPresetIndex >= 0
                ? '💾 Enregistrer les modifications' : '💾 Enregistrer cette recherche';
            const cancelBtn = document.getElementById('wm-tagger-cancel-edit');
            if (cancelBtn) cancelBtn.style.display = editingPresetIndex >= 0 ? '' : 'none';
        }
        function startEditPreset(idx) {
            const p = taggerPresets[idx];
            if (!p) return;
            editingPresetIndex = idx;
            if (taggerKeyword)    taggerKeyword.value    = p.kw || '';
            if (taggerTagInput)   taggerTagInput.value   = p.tag || '';
            if (taggerGroupInput) taggerGroupInput.value = p.group || '';
            if (taggerUntagged)   taggerUntagged.checked = !!p.untagged;
            if (taggerExtended)   taggerExtended.checked = !!p.extended;
            updateSavePresetLabel();
            if (taggerKeyword) { try { taggerKeyword.focus(); taggerKeyword.scrollIntoView({ block: 'nearest' }); } catch(e) {} }
            if (taggerStatus) taggerStatus.innerHTML = `<span style="color:#a78bfa;">✏️ Édition de « ${taggerEsc(p.tag)} » — modifie les champs puis « Enregistrer les modifications » (ou Annuler).</span>`;
        }
        function cancelEditPreset() {
            editingPresetIndex = -1;
            if (taggerKeyword)    taggerKeyword.value    = '';
            if (taggerTagInput)   taggerTagInput.value   = '';
            if (taggerGroupInput) taggerGroupInput.value = '';
            if (taggerUntagged)   taggerUntagged.checked = false;
            if (taggerExtended)   taggerExtended.checked = false;
            updateSavePresetLabel();
            if (taggerStatus) taggerStatus.innerHTML = '<span style="color:#888;">Édition annulée.</span>';
        }

        // Applique une liste de presets à partir d'une collection DÉJÀ chargée (un seul scan).
        // Précompute le texte de recherche une fois par carte → indispensable pour les
        // grosses collections (50k+ cartes × N présets sans ça = minutes de calcul).
        async function applyPresetsFromItems(presetList, all) {
            // Le texte étendu (description/catégories) n'est calculé que si au moins un préset
            // l'exige — évite un coût inutile sur les grosses collections en mode titre-seul.
            const anyExtended = presetList.some(p => p && p.extended);
            const entries = all.map(it => ({
                it,
                idText: taggerSearchText(it, 'title'),
                fullText: anyExtended ? taggerSearchText(it, 'full') : null,
                hasTags: (it.tags || []).length > 0
            }));
            let totalOk = 0, totalFail = 0, totalMatched = 0;
            const failures = []; // { title, tag, status, error }
            const titleOf = (m) => m.card?.wikipedia_title || m.wikipedia_title || (m.id ? m.id.slice(0, 8) + '…' : '?');
            for (let pi = 0; pi < presetList.length; pi++) {
                const p = presetList[pi];
                const kws = taggerTerms(p.kw);
                const tagName = (p.tag || '').trim();
                if (kws.length === 0 || !tagName) continue;
                const matches = entries
                    .filter(e => {
                        if (!e.it.id || (p.untagged && e.hasTags)) return false;
                        const text = p.extended ? e.fullText : e.idText;
                        return kws.some(k => text.includes(k));
                    })
                    .map(e => e.it);
                if (matches.length === 0) { wmLog(`⭐ « ${p.kw} » → « ${tagName} » : aucune carte`); continue; }
                totalMatched += matches.length;
                const tag = await createTrashTag(tagName);
                if (!tag.ok || !tag.id) {
                    wmLog(`⚠️ Étiquette « ${tagName} » non résolue (${tag.error || 'erreur'}) — ${matches.length} carte(s) non taguée(s)`);
                    totalFail += matches.length;
                    matches.forEach(m => failures.push({ title: titleOf(m), tag: tagName, status: 0, error: 'étiquette non créée/trouvée : ' + (tag.error || '?') }));
                    continue;
                }
                let ok = 0, fail = 0; const CONC = 5;
                for (let i = 0; i < matches.length; i += CONC) {
                    const slice = matches.slice(i, i + CONC);
                    const results = await Promise.all(slice.map(m => addTagToUserCard(m.id, tag.id)));
                    results.forEach((r, k) => {
                        if (r.ok) {
                            ok++;
                            // Reflète le tag posé sur l'item en mémoire → le cache réutilisé et les
                            // présets suivants voient la carte comme désormais taguée (filtre « sans tag »).
                            const it = slice[k];
                            if (it && !(it.tags || []).some(t => t.name === tagName)) {
                                it.tags = [...(it.tags || []), { name: tagName, id: tag.id }];
                            }
                        }
                        else { fail++; failures.push({ title: titleOf(slice[k]), tag: tagName, status: r.status, error: r.error }); }
                    });
                    taggerStatus.innerHTML = `<span style="color:#06b6d4;">🏷️ ${pi + 1}/${presetList.length} (${taggerEsc(tagName)}) · ${ok}/${matches.length}${fail ? ` · ${fail} échec` : ''}…</span>`;
                }
                totalOk += ok; totalFail += fail;
                wmLog(`✅ « ${p.kw} » → « ${tagName} » : ${ok} ok${fail ? `, <span style="color:#ef4444;">${fail} échec</span>` : ''}`);
            }
            return { totalOk, totalFail, totalMatched, failures };
        }

        // Affiche le détail des échecs d'étiquetage : un résumé par raison (statut + message)
        // puis la liste carte par carte (carte → tag tenté, statut HTTP au survol la raison).
        function renderTaggerFailures(failures) {
            if (!taggerResults) return;
            if (!failures || failures.length === 0) { taggerResults.innerHTML = ''; return; }
            const CAP = 300;
            const byReason = {};
            failures.forEach(f => { const k = `HTTP ${f.status || '?'} · ${f.error || '?'}`; byReason[k] = (byReason[k] || 0) + 1; });
            const summary = Object.entries(byReason).sort((a, b) => b[1] - a[1])
                .map(([k, n]) => `<div style="color:#ef4444;font-size:10px;margin:1px 0;">• ${taggerEsc(k)} <span style="color:#888;">×${n}</span></div>`).join('');
            const rows = failures.slice(0, CAP).map(f => `<div style="font-size:10px;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.04);display:flex;justify-content:space-between;gap:6px;align-items:center;" title="${taggerEsc(f.error || '')}">
                <span style="color:#ccc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;">${taggerEsc(f.title)} <span style="color:#555;">→</span> <span style="color:#4ade80;">${taggerEsc(f.tag)}</span></span>
                <span style="color:#ef4444;white-space:nowrap;font-size:9px;flex-shrink:0;">HTTP ${f.status || '?'}</span>
            </div>`).join('');
            taggerResults.innerHTML =
                `<div style="color:#ef4444;font-size:11px;font-weight:700;margin:4px 0;">❌ ${failures.length} échec(s) d'étiquetage — pourquoi :</div>`
                + `<div style="margin-bottom:6px;">${summary}</div>`
                + `<div style="color:#888;font-size:9px;margin-bottom:2px;">Détail par carte (survole une ligne pour le message complet) :</div>`
                + rows
                + (failures.length > CAP ? `<div style="color:#888;font-size:10px;padding:4px 0;">… et ${failures.length - CAP} autre(s)</div>` : '');
        }

        // Charge la collection UNE seule fois puis applique tous les présets fournis.
        async function runPresetList(presetList, label) {
            if (taggerScanBtn.disabled) return; // une autre opération est en cours
            if (!presetList || presetList.length === 0) {
                taggerStatus.innerHTML = '<span style="color:#fbbf24;">Aucune recherche à lancer.</span>';
                return;
            }
            if (!confirm(`Lancer ${presetList.length} recherche(s)${label ? ` de « ${label} »` : ''} en un seul scan de la collection ?`)) return;
            taggerScanBtn.disabled = true; taggerApplyBtn.disabled = true;
            taggerStatus.innerHTML = '<span style="color:#888;">🔍 Chargement de la collection…</span>';
            try {
                const force = !!(taggerForceScan && taggerForceScan.checked);
                const { items: all, reused, ageMin } = await getCollectionItems((loaded, total) => {
                    taggerStatus.innerHTML = `<span style="color:#888;">🔍 ${loaded}${total ? '/' + total : ''} cartes chargées…</span>`;
                }, { force });
                wmLog(`⭐ Lancement de ${presetList.length} recherche(s)${label ? ` [${label}]` : ''} sur ${all.length} cartes ${reused ? `(♻️ scan réutilisé, il y a ${ageMin} min)` : '(nouveau scan)'}`);
                const r = await applyPresetsFromItems(presetList, all);
                taggerStatus.innerHTML = `<span style="color:#4ade80;">✔ ${r.totalOk} tag(s) posé(s) sur ${r.totalMatched} carte(s)${r.totalFail ? ` · <span style="color:#ef4444;">${r.totalFail} échec(s)</span>` : ''} — 1 seul scan.</span>`;
                renderTaggerFailures(r.failures); // détail des échecs (carte, tag, raison)
                await populateTagDatalist();
            } catch(e) {
                taggerStatus.innerHTML = `<span style="color:#ef4444;">Erreur : ${e.message}</span>`;
            } finally {
                taggerScanBtn.disabled = false;
            }
        }

        // Exécution non-interactive d'un preset unique (un scan → application du tag).
        async function runTaggerPreset(preset) {
            if (!preset || taggerScanBtn.disabled) return;
            const kws = taggerTerms(preset.kw);
            if (kws.length === 0 || !(preset.tag || '').trim()) return;
            taggerScanBtn.disabled = true; taggerApplyBtn.disabled = true;
            taggerStatus.innerHTML = `<span style="color:#888;">🔍 « ${taggerEsc(preset.kw)} » → chargement de la collection…</span>`;
            try {
                const force = !!(taggerForceScan && taggerForceScan.checked);
                const { items: all } = await getCollectionItems((loaded, total) => {
                    taggerStatus.innerHTML = `<span style="color:#888;">🔍 ${loaded}${total ? '/' + total : ''} cartes chargées…</span>`;
                }, { force });
                const r = await applyPresetsFromItems([preset], all);
                if (r.totalMatched === 0) {
                    taggerStatus.innerHTML = `<span style="color:#fbbf24;">Aucune carte « ${taggerEsc(preset.kw)} »${preset.untagged ? ' sans étiquette' : ''} sur ${all.length}.</span>`;
                } else {
                    taggerStatus.innerHTML = `<span style="color:#4ade80;">✔ « ${taggerEsc(preset.tag)} » appliquée à ${r.totalOk} carte(s)${r.totalFail ? ` · <span style="color:#ef4444;">${r.totalFail} échec(s)</span>` : ''}</span>`;
                }
                renderTaggerFailures(r.failures); // détail des échecs (carte, tag, raison)
                await populateTagDatalist();
            } catch(e) {
                taggerStatus.innerHTML = `<span style="color:#ef4444;">Erreur : ${e.message}</span>`;
            } finally {
                taggerScanBtn.disabled = false;
            }
        }

        // Bouton "Enregistrer cette recherche" : sauve mot(s) → tag (+ catégorie) courant.
        const taggerSavePresetBtn = document.getElementById('wm-tagger-save-preset');
        if (taggerSavePresetBtn) taggerSavePresetBtn.onclick = () => {
            const kw = taggerKeyword.value.trim();
            const tag = taggerTagInput.value.trim();
            const group = (taggerGroupInput ? taggerGroupInput.value : '').trim();
            if (!kw || !tag) {
                taggerStatus.innerHTML = '<span style="color:#fbbf24;">Remplis le(s) mot(s) recherché(s) ET l\'étiquette pour enregistrer la recherche.</span>';
                return;
            }
            const untagged = !!taggerUntagged.checked;
            const extended = !!(taggerExtended && taggerExtended.checked);

            // Mode ÉDITION (crayon ✏️) : on met à jour LE préset ciblé (tous ses champs), même
            // si kw/tag ont changé, puis on ressort du mode édition.
            if (editingPresetIndex >= 0 && taggerPresets[editingPresetIndex]) {
                taggerPresets[editingPresetIndex] = { kw, tag, untagged, group, extended };
                saveTaggerPresets();
                editingPresetIndex = -1;
                renderTaggerPresets();
                updateSavePresetLabel();
                taggerStatus.innerHTML = `<span style="color:#4ade80;">✔ Recherche modifiée : « ${taggerEsc(kw)} »${untagged ? ' (sans étiquette)' : ''}${extended ? ' (étendue)' : ''} → « ${taggerEsc(tag)} »${group ? ' · catégorie « ' + taggerEsc(group) + ' »' : ''}.</span>`;
                return;
            }

            const existing = taggerPresets.find(p => p.kw.toLowerCase() === kw.toLowerCase() && p.tag.toLowerCase() === tag.toLowerCase() && !!p.untagged === untagged);
            if (existing) {
                const groupChanged = (existing.group || '') !== group;
                const scopeChanged = !!existing.extended !== extended;
                if (groupChanged || scopeChanged) {
                    existing.group = group;
                    existing.extended = extended;
                    saveTaggerPresets(); renderTaggerPresets();
                    const bits = [];
                    if (groupChanged) bits.push(group ? 'catégorie « ' + taggerEsc(group) + ' »' : 'sans catégorie');
                    if (scopeChanged) bits.push(extended ? 'recherche étendue' : 'match titre seul');
                    taggerStatus.innerHTML = `<span style="color:#4ade80;">✔ Recherche « ${taggerEsc(kw)} » mise à jour : ${bits.join(' · ')}.</span>`;
                } else {
                    taggerStatus.innerHTML = '<span style="color:#888;">Cette recherche est déjà enregistrée.</span>';
                }
                return;
            }
            taggerPresets.push({ kw, tag, untagged, group, extended });
            saveTaggerPresets();
            renderTaggerPresets();
            taggerStatus.innerHTML = `<span style="color:#4ade80;">✔ Recherche enregistrée : « ${taggerEsc(kw)} »${untagged ? ' (sans étiquette)' : ''}${extended ? ' (étendue)' : ''} → « ${taggerEsc(tag)} »${group ? ' · catégorie « ' + taggerEsc(group) + ' »' : ''}. Un clic sur ▶ la rejouera.</span>`;
        };

        // Bouton "Annuler la modification" : sort du mode édition sans rien changer.
        const taggerCancelEditBtn = document.getElementById('wm-tagger-cancel-edit');
        if (taggerCancelEditBtn) taggerCancelEditBtn.onclick = () => cancelEditPreset();

        // Bouton "Lancer tous les présets" : un seul scan pour tout appliquer.
        const taggerRunAllBtn = document.getElementById('wm-tagger-run-all');
        if (taggerRunAllBtn) taggerRunAllBtn.onclick = () => runPresetList(taggerPresets, 'toutes');

        // Case "Étiqueter auto les cartes packées selon ces recherches"
        const taggerAutopackChk = document.getElementById('wm-tagger-autopack');
        if (taggerAutopackChk) {
            taggerAutopackChk.checked = getSetting('autoTagPacksFromPresets');
            taggerAutopackChk.onchange = () => {
                setSetting('autoTagPacksFromPresets', taggerAutopackChk.checked);
                wmLog(taggerAutopackChk.checked
                    ? '🏷️ Auto-tag des packs activé : chaque carte packée est taguée selon les recherches enregistrées'
                    : '🏷️ Auto-tag des packs désactivé');
            };
        }

        // Case "Ne pas auto-étiqueter les Légendaires"
        const taggerAutopackSkipL = document.getElementById('wm-tagger-autopack-skip-l');
        if (taggerAutopackSkipL) {
            taggerAutopackSkipL.checked = getSetting('autoTagSkipLegendary');
            taggerAutopackSkipL.onchange = () => {
                setSetting('autoTagSkipLegendary', taggerAutopackSkipL.checked);
                wmLog(taggerAutopackSkipL.checked
                    ? '🛡️ Légendaires protégées : elles ne seront pas auto-étiquetées'
                    : '⚠️ Légendaires incluses dans l\'auto-étiquetage des packs');
            };
        }

        renderTaggerPresets(); // affiche les presets sauvegardés au démarrage

        if (taggerHdr) {
            taggerHdr.onclick = () => {
                const open = taggerBody.classList.toggle('open');
                taggerChevron.innerText = open ? '▾' : '▴';
                panelOpenState.tagger = open;
                savePanelState();
                document.querySelectorAll('.wm-row-resizer').forEach(rz => {
                    const b = document.getElementById(rz.dataset.target);
                    if (b) rz.classList.toggle('show', b.classList.contains('open'));
                });
                if (open) populateTagDatalist();
            };
        }
        if (panelOpenState.tagger && taggerBody) {
            taggerBody.classList.add('open');
            if (taggerChevron) taggerChevron.innerText = '▾';
            populateTagDatalist();
        }

        if (taggerScanBtn) {
            taggerScanBtn.onclick = async () => {
                const kwRaw = taggerKeyword.value.trim();
                const kws = taggerTerms(kwRaw); // plusieurs termes possibles (séparés par virgules)
                const untaggedOnly = taggerUntagged.checked;
                // Le mot-clé est optionnel SI on liste les cartes sans étiquette.
                if (kws.length === 0 && !untaggedOnly) {
                    taggerStatus.innerHTML = '<span style="color:#fbbf24;">Entre un ou plusieurs mots (séparés par des points-virgules ;), ou coche « sans étiquette ».</span>';
                    return;
                }
                taggerScanBtn.disabled = true; taggerApplyBtn.disabled = true;
                taggerMatches = []; renderTaggerResults();
                taggerStatus.innerHTML = '<span style="color:#888;">🔍 Chargement de la collection…</span>';
                try {
                    const force = !!(taggerForceScan && taggerForceScan.checked);
                    const { items: all, reused, ageMin } = await getCollectionItems((loaded, total) => {
                        taggerStatus.innerHTML = `<span style="color:#888;">🔍 ${loaded}${total ? '/' + total : ''} cartes chargées…</span>`;
                    }, { force });
                    if (all.length > 0) logTaggerCardFields(all[0]); // diag : quels champs existent
                    if (reused) wmLog(`♻️ Étiquetage : scan de collection réutilisé (il y a ${ageMin} min) — pas de re-scan`);
                    const scanScope = (taggerExtended && taggerExtended.checked) ? 'full' : 'title';
                    taggerMatches = all.filter(it => {
                        if (!it.id) return false; // besoin du user_card_id pour taguer
                        if (untaggedOnly && (it.tags || []).length > 0) return false;
                        // Match si la carte contient AU MOINS UN des termes (OU)
                        if (kws.length && !kws.some(k => taggerSearchText(it, scanScope).includes(k))) return false;
                        return true;
                    });
                    renderTaggerResults();
                    const scope = kws.length
                        ? `« ${kwRaw} »${untaggedOnly ? ' sans étiquette' : ''}`
                        : 'sans étiquette';
                    if (taggerMatches.length === 0) {
                        taggerStatus.innerHTML = `<span style="color:#fbbf24;">Aucune carte ${scope} sur ${all.length}.</span>`;
                    } else {
                        const shownNote = taggerMatches.length > TAGGER_RENDER_CAP ? ` (${TAGGER_RENDER_CAP} affichées)` : '';
                        taggerStatus.innerHTML = `<span style="color:#4ade80;">${taggerMatches.length} carte(s) ${scope} sur ${all.length}${shownNote}. Décoche celles à exclure, puis clique Appliquer si tu veux les taguer.</span>`;
                        taggerApplyBtn.disabled = false;
                    }
                } catch(e) {
                    taggerStatus.innerHTML = `<span style="color:#ef4444;">Erreur : ${e.message}</span>`;
                } finally {
                    taggerScanBtn.disabled = false;
                }
            };
        }

        // Repère toutes les cartes possédées en 2 exemplaires ou plus (même card_id, donc
        // même article + même rareté). Remplit taggerMatches exactement comme le scan par
        // mot-clé — même liste de relecture décochable, même bouton Appliquer, même logique
        // de tag find-or-create — pour ne dupliquer aucune des mécaniques déjà en place
        // (concurrence limitée, retry, rapport d'échecs détaillé).
        if (taggerDuplicatesBtn) {
            taggerDuplicatesBtn.onclick = async () => {
                taggerScanBtn.disabled = true; taggerApplyBtn.disabled = true; taggerDuplicatesBtn.disabled = true;
                taggerMatches = []; renderTaggerResults();
                // Champs du scan par mot-clé non pertinents ici (scan structurel, pas textuel) :
                // vidés pour ne pas laisser croire qu'ils ont influencé le résultat affiché.
                taggerKeyword.value = '';
                taggerUntagged.checked = false;
                taggerStatus.innerHTML = '<span style="color:#888;">🔍 Chargement de la collection…</span>';
                try {
                    const force = !!(taggerForceScan && taggerForceScan.checked);
                    const { items: all, reused, ageMin } = await getCollectionItems((loaded, total) => {
                        taggerStatus.innerHTML = `<span style="color:#888;">🔍 ${loaded}${total ? '/' + total : ''} cartes chargées…</span>`;
                    }, { force });
                    if (reused) wmLog(`♻️ Étiquetage : scan de collection réutilisé (il y a ${ageMin} min) — pas de re-scan`);

                    // Compte les exemplaires par MODÈLE de carte (card_id) — pas par carte
                    // individuelle : deux exemplaires du même article+rareté partagent le même
                    // card_id mais ont chacun leur propre id d'exemplaire (voir plus haut la
                    // distinction card_id / user_card_id).
                    const counts = new Map();
                    all.forEach(it => {
                        const cid = it.card_id || it.card?.id;
                        if (cid) counts.set(cid, (counts.get(cid) || 0) + 1);
                    });
                    taggerMatches = all.filter(it => {
                        if (!it.id) return false; // besoin du user_card_id pour taguer
                        const cid = it.card_id || it.card?.id;
                        return cid && counts.get(cid) >= 2;
                    });

                    renderTaggerResults();
                    if (taggerMatches.length === 0) {
                        taggerStatus.innerHTML = `<span style="color:#fbbf24;">Aucun doublon trouvé sur ${all.length} carte(s).</span>`;
                    } else {
                        const models = new Set(taggerMatches.map(it => it.card_id || it.card?.id)).size;
                        taggerTagInput.value = 'Doublon'; // pré-rempli, modifiable avant Appliquer
                        taggerStatus.innerHTML = `<span style="color:#4ade80;">${taggerMatches.length} carte(s) en double ou plus (${models} modèle(s) distinct(s)) sur ${all.length}. Décoche celles à exclure, puis clique Appliquer.</span>`;
                        taggerApplyBtn.disabled = false;
                    }
                } catch(e) {
                    taggerStatus.innerHTML = `<span style="color:#ef4444;">Erreur : ${e.message}</span>`;
                } finally {
                    taggerScanBtn.disabled = false; taggerDuplicatesBtn.disabled = false;
                }
            };
        }

        if (taggerApplyBtn) {
            taggerApplyBtn.onclick = async () => {
                const tagName = taggerTagInput.value.trim();
                if (!tagName) { taggerStatus.innerHTML = '<span style="color:#fbbf24;">Entre le nom de l\'étiquette à appliquer.</span>'; return; }
                const selected = getSelectedTaggerMatches();
                if (selected.length === 0) { taggerStatus.innerHTML = '<span style="color:#fbbf24;">Aucune carte sélectionnée.</span>'; return; }
                if (!confirm(`Appliquer l'étiquette « ${tagName} » à ${selected.length} carte(s) ?`)) return;
                taggerScanBtn.disabled = true; taggerApplyBtn.disabled = true;
                taggerStatus.innerHTML = '<span style="color:#888;">🏷️ Résolution de l\'étiquette…</span>';
                // createTrashTag est un find-or-create générique (vérifie l'existant puis POST /tags)
                const tag = await createTrashTag(tagName);
                if (!tag.ok || !tag.id) {
                    taggerStatus.innerHTML = `<span style="color:#ef4444;">Impossible de créer/trouver l'étiquette « ${tagName} »${tag.error ? ' : ' + tag.error : ''}.</span>`;
                    taggerScanBtn.disabled = false; taggerApplyBtn.disabled = false;
                    return;
                }
                wmLog(`🏷️ Étiquetage en masse : « <b>${tagName}</b> » ${tag.alreadyExists ? '(existante)' : '(créée)'} → ${selected.length} carte(s)`);
                let done = 0, ok = 0, fail = 0;
                const failures = [];
                const titleOf = (m) => m.card?.wikipedia_title || m.wikipedia_title || (m.id ? m.id.slice(0, 8) + '…' : '?');
                const CONC = 5;
                for (let i = 0; i < selected.length; i += CONC) {
                    const slice = selected.slice(i, i + CONC);
                    const results = await Promise.all(slice.map(m => addTagToUserCard(m.id, tag.id)));
                    results.forEach((r, k) => {
                        done++;
                        if (r.ok) ok++;
                        else { fail++; failures.push({ title: titleOf(slice[k]), tag: tagName, status: r.status, error: r.error }); }
                    });
                    taggerStatus.innerHTML = `<span style="color:#06b6d4;">🏷️ ${done}/${selected.length} traitées · ${ok} ok${fail ? ` · ${fail} échec` : ''}…</span>`;
                }
                taggerStatus.innerHTML = `<span style="color:#4ade80;">✔ « ${tagName} » appliquée à ${ok} carte(s)</span>${fail ? ` <span style="color:#ef4444;">· ${fail} échec(s)</span>` : ''}`;
                wmLog(`✅ Étiquetage terminé : ${ok} ok, ${fail} échec(s) pour « <b>${tagName}</b> »`);
                renderTaggerFailures(failures); // détail des échecs (carte, tag, raison)
                await populateTagDatalist();
                taggerScanBtn.disabled = false;
            };
        }

        // Synchronise la visibilité des poignées de resize avec l'état restauré
        document.querySelectorAll('.wm-row-resizer').forEach(rz => {
            const b = document.getElementById(rz.dataset.target);
            if (b) rz.classList.toggle('show', b.classList.contains('open'));
        });

        // -- Bouton reset des stats --
        const statsResetBtn = document.getElementById('wm-stats-reset');
        if (statsResetBtn) {
            statsResetBtn.onclick = () => {
                if (!confirm('Réinitialiser toutes les statistiques cumulées (ventes, invendues) ?\nLes stats de packs et la liste des cartes invendues ne sont PAS touchées.')) return;
                lifetimeStats = { sold: 0, unsold: 0, gain: 0, byRarity: {} };
                saveLifetimeStats();
                renderStatsPanel();
                wmLog('🔄 Statistiques de vente réinitialisées');
            };
        }

        // -- Rejouer le tour guidé --
        const replayTourBtn = document.getElementById('wm-replay-tour');
        if (replayTourBtn) replayTourBtn.onclick = () => { if (window.wmStartTour) window.wmStartTour(); };

        // -- Discord webhook --
        webhookSaveBtn.onclick = () => {
            const v = webhookInput.value.trim();
            setDiscordWebhook(v);
            refreshWebhookStatus();
            wmLog(v ? `💾 Webhook Discord enregistré` : `🗑️ Webhook Discord effacé`);
        };

        webhookTestBtn.onclick = async () => {
            const url = webhookInput.value.trim();
            if (!url) {
                settingsStatus.innerHTML = `<span style="color:#ef4444;">⚠ Renseigne d'abord un webhook</span>`;
                return;
            }
            settingsStatus.innerHTML = `<span style="color:#888;">⏳ Envoi du test…</span>`;
            try {
                const res = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        embeds: [{
                            description: `🧪 **Test depuis le userscript wiki-masters**\nSi tu vois ce message, le webhook est bien configuré.`,
                            color: 5763719,
                            timestamp: new Date().toISOString()
                        }]
                    })
                });
                if (res.ok) {
                    settingsStatus.innerHTML = `<span style="color:#4ade80;">✓ Test envoyé — vérifie ton Discord</span>`;
                } else {
                    settingsStatus.innerHTML = `<span style="color:#ef4444;">⚠ Échec : HTTP ${res.status}</span>`;
                }
            } catch(e) {
                settingsStatus.innerHTML = `<span style="color:#ef4444;">⚠ Échec : ${e.message}</span>`;
            }
        };

        webhookClearBtn.onclick = () => {
            if (!confirm('Effacer le webhook Discord ?')) return;
            setDiscordWebhook('');
            webhookInput.value = '';
            refreshWebhookStatus();
            wmLog(`🗑️ Webhook Discord effacé`);
        };

        // -- Toggles Discord enabled (ex-bouton du header) --
        discordEnabledChk.onchange = () => {
            setSetting('discordEnabled', discordEnabledChk.checked);
            refreshWebhookStatus();
            wmLog(discordEnabledChk.checked ? '🔔 Notifications Discord activées' : '🔕 Notifications Discord désactivées');
        };

        // -- Toggles logs --
        const bindLogToggle = (chk, settingKey, label) => {
            chk.onchange = () => {
                setSetting(settingKey, chk.checked);
                wmLog(`${chk.checked ? '👁️' : '🙈'} Logs ${label} ${chk.checked ? 'activés' : 'désactivés'}`);
            };
        };
        bindLogToggle(logColChk,     'logCollection', 'collection');
        bindLogToggle(logMktChk,     'logMarket',     'market watcher');
        bindLogToggle(logTrashChk,   'logTrash',      'trash seller');
        bindLogToggle(logAutobidChk, 'logAutobid',    'auto-bid');

        // -- Auto-snipe price --
        autoSnipePriceInput.onchange = () => {
            const v = parseInt(autoSnipePriceInput.value, 10);
            if (!Number.isFinite(v) || v < 0) {
                autoSnipePriceInput.value = getSetting('autoSnipePrice');
                return;
            }
            setSetting('autoSnipePrice', v);
            wmLog(`💰 Seuil Hunter : <span style="color:#fbbf24;">${v} 💰</span>`);
            // Refresh le label du bouton du market watcher pour refléter la nouvelle valeur
            paintHunterAggro(); // le seuil affiché sur le bouton Hunter suit la nouvelle valeur
        };

        autoSnipeMinBalanceInput.onchange = () => {
            const v = parseInt(autoSnipeMinBalanceInput.value, 10);
            if (!Number.isFinite(v) || v < 0) {
                autoSnipeMinBalanceInput.value = getSetting('minBalanceForAutoSnipe');
                return;
            }
            setSetting('minBalanceForAutoSnipe', v);
            wmLog(`🛡️ Solde plancher Hunter : <span style="color:#fbbf24;">${v.toLocaleString('fr-FR')} 💰</span>`);
            // Refresh la couleur du solde dans le header immédiatement
            const el = document.getElementById("wm-balance");
            if (el) el.style.color = wikibidousBalance <= v ? "#EF4444" : "#FFD700";
        };

        // -- Auto-retag --
        autoRetagChk.onchange = () => {
            setSetting('autoRetagEnabled', autoRetagChk.checked);
            wmLog(autoRetagChk.checked
                ? '🏷️ Retag auto activé : le tag sera remis sur les invendus'
                : '🚫 Retag auto désactivé : les invendus garderont leur état actuel');
        };

        // -- Wishlist → mots-clés --
        if (wishlistKwChk) wishlistKwChk.onchange = () => {
            setSetting('wishlistToKeyword', wishlistKwChk.checked);
            wmLog(wishlistKwChk.checked
                ? '⭐ Wishlist → mots-clés activé : les cartes wishlistées deviennent des mots-clés'
                : '⭐ Wishlist → mots-clés désactivé');
        };

        // -- Sons d'alerte (séparés par type) --
        soundNewHitChk.onchange = () => {
            setSetting('soundNewHit', soundNewHitChk.checked);
            if (soundNewHitChk.checked) playSound('keyword'); // aperçu du son au réglage
            wmLog(soundNewHitChk.checked ? '🔊 Son d\'apparition d\'enchère activé' : '🔇 Son d\'apparition d\'enchère coupé');
        };
        soundOutbidChk.onchange = () => {
            setSetting('soundOutbid', soundOutbidChk.checked);
            if (soundOutbidChk.checked) playSound('outbid'); // aperçu du son au réglage
            wmLog(soundOutbidChk.checked ? '🔊 Son de perte du lead activé' : '🔇 Son de perte du lead coupé');
        };
        soundPackChk.onchange = () => {
            setSetting('soundPackOpen', soundPackChk.checked);
            if (soundPackChk.checked) playSound('pack'); // aperçu du son au réglage
            wmLog(soundPackChk.checked ? '🔊 Son d\'ouverture de pack activé' : '🔇 Son d\'ouverture de pack coupé');
        };
        soundLegendaryChk.onchange = () => {
            setSetting('soundLegendary', soundLegendaryChk.checked);
            if (soundLegendaryChk.checked) playSound('legendary'); // aperçu du son au réglage
            wmLog(soundLegendaryChk.checked ? '🔊 Son Légendaire activé' : '🔇 Son Légendaire coupé');
        };
        if (soundWonChk) soundWonChk.onchange = () => {
            setSetting('soundWon', soundWonChk.checked);
            if (soundWonChk.checked) playSound('won'); // aperçu du son au réglage
            wmLog(soundWonChk.checked ? '🔊 Son « enchère gagnée » activé' : '🔇 Son « enchère gagnée » coupé');
        };

        // -- Badge de notifications --
        notifsChk.onchange = () => {
            setSetting('notificationsEnabled', notifsChk.checked);
            // Si on désactive : retire le badge immédiatement
            if (!notifsChk.checked && window.wmClearNotifications) {
                window.wmClearNotifications();
            }
            wmLog(notifsChk.checked ? '🔔 Badge de notifications activé' : '🔕 Badge de notifications désactivé');
        };

        // -- Nom du tag de vente --
        tagSaveBtn.onclick = async () => {
            const newName = tagNameInput.value.trim();
            if (!newName) {
                tagStatusEl.innerHTML = `<span style="color:#ef4444;">⚠ Nom de tag vide</span>`;
                return;
            }
            const oldName = getSetting('sellTagName');
            if (newName === oldName && TRASH_TAG_ID) {
                tagStatusEl.innerHTML = `<span style="color:#888;">Aucun changement</span>`;
                return;
            }
            setSetting('sellTagName', newName);
            // Invalide le cache du tag_id et redécouvre avec le nouveau nom
            TRASH_TAG_ID = null;
            try { localStorage.removeItem(TRASH_TAG_CACHE_KEY); } catch(e) {}
            tagStatusEl.innerHTML = `<span style="color:#888;">⏳ Découverte du tag "${newName}"…</span>`;
            wmLog(`🏷️ Nouveau nom de tag : <b>${newName}</b> · redécouverte en cours…`);
            await discoverTrashTagId();
            refreshTagStatus();
        };

        /* ════════ IDENTITÉ / PSEUDO ════════ */
        const usernameInput   = document.getElementById('wm-set-username');
        const usernameSaveBtn = document.getElementById('wm-set-username-save');
        const identityRefresh = document.getElementById('wm-set-identity-refresh');
        const identityInfo    = document.getElementById('wm-set-identity-info');
        const identityStatus  = document.getElementById('wm-set-identity-status');

        if (usernameInput) usernameInput.value = getSetting('usernameOverride');
        function refreshIdentityInfo() {
            if (!identityInfo) return;
            const ov = (getSetting('usernameOverride') || '').trim();
            identityInfo.innerHTML = currentUsername
                ? `Reconnu comme : <b style="color:#4ade80;">${currentUsername}</b>${ov ? ' <span style="color:#888;">(forcé)</span>' : ' <span style="color:#888;">(auto)</span>'}`
                : '<span style="color:#fbbf24;">Aucun pseudo détecté</span>';
        }
        refreshIdentityInfo();

        // Re-render les hits avec la nouvelle identité (couleurs meneur/surenchéri)
        function reapplyIdentityToHits() {
            // Purge les états de lead obsolètes : ils seront recalculés au prochain scan
            leadingBidsMap.clear();
            clearAllOutbid();
            const el = document.getElementById('wm-market-alert');
            if (el && lastHitsCache.length > 0) renderMarketHits(el, lastHitsCache, []);
        }

        if (usernameSaveBtn) usernameSaveBtn.onclick = async () => {
            const v = usernameInput.value.trim();
            setSetting('usernameOverride', v);
            // Vide le cache d'identité pour repartir propre
            try { localStorage.removeItem(CURRENT_USER_CACHE_KEY); } catch(e) {}
            await fetchCurrentUser();
            refreshIdentityInfo();
            reapplyIdentityToHits();
            if (v) {
                identityStatus.innerHTML = `<span style="color:#4ade80;">✓ Pseudo forcé : <b>${v}</b></span>`;
                wmLog(`👤 Pseudo forcé manuellement : <b style="color:#4ade80;">${v}</b>`);
            } else {
                identityStatus.innerHTML = `<span style="color:#888;">Override retiré — détection auto réactivée.</span>`;
                wmLog(`👤 Override de pseudo retiré → détection auto`);
            }
        };

        if (identityRefresh) identityRefresh.onclick = async () => {
            try { localStorage.removeItem(CURRENT_USER_CACHE_KEY); } catch(e) {}
            identityStatus.innerHTML = `<span style="color:#888;">⏳ Re-détection de l'identité…</span>`;
            await fetchCurrentUser();
            refreshIdentityInfo();
            reapplyIdentityToHits();
            identityStatus.innerHTML = currentUsername
                ? `<span style="color:#4ade80;">✓ Identité : <b>${currentUsername}</b></span>`
                : `<span style="color:#fbbf24;">Toujours aucun pseudo détecté — saisis-le manuellement ci-dessus.</span>`;
            wmLog(`🔄 Identité rafraîchie : <b>${currentUsername || '— non détecté'}</b>`);
        };

        /* ════════ EXPORT / IMPORT du localStorage ════════ */
        const exportBtn = document.getElementById('wm-set-export');
        const importBtn = document.getElementById('wm-set-import');
        const ioxStatus = document.getElementById('wm-set-iox-status');

        // Clés exclues du backup "léger" : elles se régénèrent seules (cache collection
        // rechargé depuis le site, cache ventes, IDs d'achats re-baselinés sur le nouveau PC).
        // → un backup léger pèse quelques Ko au lieu de plusieurs Mo.
        const BACKUP_LITE_EXCLUDE = new Set([
            'wm_collection_cache', 'wm_collection_ts', 'wm_collection_total',
            'wm_collection_rarity', 'wm_collection_rarity_set', 'wm_sales_cache', 'wm_won_seen_ids'
        ]);

        // Construit le backup des clés wm_*. opts.lite → exclut les caches régénérables.
        function buildBackup(opts = {}) {
            const lite = !!opts.lite;
            const data = {};
            let count = 0;
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (!k || !k.startsWith('wm_')) continue;
                // On exclut TOUJOURS les gros caches régénérables (cache collection/ventes…) :
                // ils sont liés au compte, se reconstruisent seuls, et faisaient dépasser le
                // quota localStorage à la réimportation. → tout export reste léger et importable.
                if (BACKUP_LITE_EXCLUDE.has(k)) continue;
                data[k] = localStorage.getItem(k); count++;
            }
            const payload = {
                version: 1,
                exported_at: new Date().toISOString(),
                username: currentUsername || 'unknown',
                lite,
                count,
                data
            };
            const jsonStr = JSON.stringify(payload, null, 2);
            const ts = new Date().toISOString().slice(0,19).replace(/[T:]/g, '-');
            const filename = `wm-backup${lite ? '-lite' : ''}-${currentUsername || 'user'}-${ts}.json`;
            return { jsonStr, filename, count };
        }

        exportBtn.onclick = () => {
            const { jsonStr, filename, count } = buildBackup();
            const blob = new Blob([jsonStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            ioxStatus.innerHTML = `<span style="color:#4ade80;">✓ Export de <b>${count}</b> clés → <b>${filename}</b></span>`;
            wmLog(`📤 Export : <b>${count}</b> clés sauvegardées dans <b>${filename}</b>`);
        };

        // Envoie le backup en pièce jointe via le webhook (multipart). Réutilisé par le
        // bouton "Exporter → Discord" ET le backup auto sur "Tout arrêter".
        // Retourne { ok, filename, count, error, status }.
        async function sendBackupToDiscord(note = '', opts = {}) {
            const webhook = getDiscordWebhook();
            if (!webhook) return { ok: false, error: 'no-webhook' };
            const { jsonStr, filename, count } = buildBackup(opts);
            const blob = new Blob([jsonStr], { type: 'application/json' });
            try {
                const form = new FormData();
                // NE PAS fixer Content-Type : le navigateur ajoute la boundary multipart.
                form.append('payload_json', JSON.stringify({
                    content: `🗄️ **Backup WikiMasters**${note ? ' ' + note : ''} · ${count} clés · ${currentUsername || 'user'} · ${new Date().toLocaleString('fr-FR')}`
                }));
                form.append('file', blob, filename);
                const res = await fetch(webhook, { method: 'POST', body: form });
                if (res.ok) {
                    wmLog(`📤 Backup envoyé sur Discord : <b>${filename}</b> (${count} clés)`);
                    return { ok: true, filename, count };
                }
                return { ok: false, error: `HTTP ${res.status}`, status: res.status };
            } catch(e) {
                return { ok: false, error: e.message };
            }
        }

        // Export → Discord (bouton manuel)
        const exportDiscordBtn = document.getElementById('wm-set-export-discord');
        if (exportDiscordBtn) exportDiscordBtn.onclick = async () => {
            if (!getDiscordWebhook()) {
                ioxStatus.innerHTML = `<span style="color:#fbbf24;">⚠ Configure d'abord un webhook Discord (section Notifications Discord).</span>`;
                return;
            }
            const prevText = exportDiscordBtn.innerText;
            exportDiscordBtn.disabled = true;
            exportDiscordBtn.innerText = '⏳ Envoi…';
            ioxStatus.innerHTML = `<span style="color:#888;">⏳ Envoi du backup sur Discord…</span>`;
            const r = await sendBackupToDiscord();
            if (r.ok) {
                ioxStatus.innerHTML = `<span style="color:#4ade80;">✓ Backup envoyé sur Discord (<b>${r.filename}</b>)</span>`;
            } else {
                const hint = r.status === 413 ? ' — fichier trop lourd pour le webhook' : '';
                ioxStatus.innerHTML = `<span style="color:#ef4444;">⚠ Échec Discord : ${r.error}${hint}</span>`;
            }
            exportDiscordBtn.disabled = false;
            exportDiscordBtn.innerText = prevText;
        };
        // Exposé pour le backup auto sur "Tout arrêter" (défini plus bas dans createUI)
        window.wmSendBackupToDiscord = sendBackupToDiscord;

        // Case : backup auto sur Discord lors d'un "Tout arrêter"
        const autoBackupStopChk = document.getElementById('wm-set-autobackup-stop');
        if (autoBackupStopChk) {
            autoBackupStopChk.checked = getSetting('autoBackupOnStop');
            autoBackupStopChk.onchange = () => {
                setSetting('autoBackupOnStop', autoBackupStopChk.checked);
                wmLog(autoBackupStopChk.checked
                    ? '🗄️ Backup auto sur Discord activé (à chaque « Tout arrêter »)'
                    : '🗄️ Backup auto sur Discord désactivé');
            };
        }

        // Champ : fréquence du backup périodique léger
        const periodicBackupInput = document.getElementById('wm-set-periodic-backup');
        if (periodicBackupInput) {
            periodicBackupInput.value = getSetting('periodicBackupMin');
            periodicBackupInput.onchange = () => {
                let v = parseInt(periodicBackupInput.value, 10);
                if (!Number.isFinite(v) || v < 0) v = 0;
                if (v > 1440) v = 1440;
                periodicBackupInput.value = v;
                setSetting('periodicBackupMin', v);
                if (v > 0 && !getDiscordWebhook()) {
                    wmLog('⚠️ Backup périodique réglé mais aucun webhook Discord configuré.');
                } else {
                    wmLog(v > 0 ? `🗄️ Backup auto Discord toutes les <b>${v} min</b> (version allégée)` : '🗄️ Backup périodique désactivé');
                }
            };
        }

        // ── Backup périodique léger (protège des arrêts imprévus : coupure, crash) ──
        // Hash rapide pour ne renvoyer un backup que si les données ont changé.
        let lastBackupHash = '';
        let lastPeriodicBackupTs = 0;
        function quickHash(str) {
            let h = 5381;
            for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
            return h.toString(36);
        }
        setInterval(async () => {
            const mins = getSetting('periodicBackupMin');
            if (!(mins > 0) || !getDiscordWebhook()) return;
            if (Date.now() - lastPeriodicBackupTs < mins * 60000) return;
            const { jsonStr } = buildBackup({ lite: true });
            const hash = quickHash(jsonStr);
            // Rien de neuf depuis le dernier backup → on ne spamme pas Discord
            if (hash === lastBackupHash) { lastPeriodicBackupTs = Date.now(); return; }
            const r = await sendBackupToDiscord('(auto périodique)', { lite: true });
            if (r.ok) { lastPeriodicBackupTs = Date.now(); lastBackupHash = hash; }
        }, 60000);

        // Best-effort à la FERMETURE du navigateur (fetch keepalive). Ne couvre PAS la
        // coupure de courant (aucun event JS n'est émis), mais capte les fermetures propres.
        // Limité à ~64 Ko par le navigateur ; au-delà, le backup périodique prend le relais.
        window.wmBackupBeacon = () => {
            try {
                if (!(getSetting('periodicBackupMin') > 0)) return;
                const webhook = getDiscordWebhook();
                if (!webhook) return;
                const { jsonStr, filename, count } = buildBackup({ lite: true });
                if (quickHash(jsonStr) === lastBackupHash) return; // identique au dernier envoi
                const form = new FormData();
                form.append('payload_json', JSON.stringify({
                    content: `🗄️ **Backup (fermeture)** · ${count} clés · ${currentUsername || 'user'} · ${new Date().toLocaleString('fr-FR')}`
                }));
                form.append('file', new Blob([jsonStr], { type: 'application/json' }), filename);
                fetch(webhook, { method: 'POST', body: form, keepalive: true }).catch(() => {});
            } catch(e) {}
        };

        importBtn.onclick = () => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = '.json,application/json';
            fileInput.onchange = async () => {
                const file = fileInput.files && fileInput.files[0];
                if (!file) return;
                try {
                    const text = await file.text();
                    const parsed = JSON.parse(text);
                    if (!parsed || typeof parsed.data !== 'object') {
                        ioxStatus.innerHTML = `<span style="color:#ef4444;">⚠ Fichier invalide</span>`;
                        return;
                    }
                    const keys = Object.keys(parsed.data).filter(k => k.startsWith('wm_'));
                    if (keys.length === 0) {
                        ioxStatus.innerHTML = `<span style="color:#ef4444;">⚠ Aucune clé wm_* dans le fichier</span>`;
                        return;
                    }
                    // On n'importe PAS les gros caches régénérables : ils font exploser le quota
                    // localStorage (le cache collection = plusieurs Mo sur 95k cartes) et se
                    // reconstruisent tout seuls après rechargement (♻️/scan). Ils sont aussi
                    // liés au compte, donc inutiles voire faux si le backup vient d'un autre.
                    const IMPORT_SKIP = new Set([
                        'wm_collection_cache', 'wm_collection_ts', 'wm_collection_total',
                        'wm_collection_rarity', 'wm_collection_rarity_set', 'wm_sales_cache', 'wm_won_seen_ids'
                    ]);
                    const importKeys = keys.filter(k => !IMPORT_SKIP.has(k));
                    const skippedCache = keys.length - importKeys.length;
                    // Écrire les PETITES clés d'abord (réglages, mots-clés, présets…) et les grosses
                    // stats en dernier : si le quota localStorage est atteint, la config essentielle
                    // est déjà en place et seules d'éventuelles grosses stats sont ignorées.
                    importKeys.sort((a, b) => String(parsed.data[a] || '').length - String(parsed.data[b] || '').length);
                    // Avertissement si le backup vient d'un autre utilisateur
                    let userWarn = '';
                    if (parsed.username && currentUsername && parsed.username !== currentUsername) {
                        userWarn = `\n\n⚠ ATTENTION : ce backup vient de l'utilisateur "${parsed.username}", tu es connecté en "${currentUsername}". Importer va mélanger des IDs (autobid, sellHistory, collection cache) qui ne correspondent pas à ton compte. Continuer quand même ?`;
                    }
                    const ok = confirm(
                        `Importer ${importKeys.length} clés depuis "${file.name}" ?\n` +
                        `Export du ${parsed.exported_at || '?'} par "${parsed.username || '?'}".\n` +
                        `\nCela ÉCRASE toutes tes données wiki-masters actuelles dans ce navigateur (stats, settings, mots-clés, sellHistory, etc.).` +
                        (skippedCache > 0 ? `\n\nLe cache de collection (${skippedCache} clé(s)) n'est PAS importé : il se reconstruira au rechargement (♻️ Collection).` : '') +
                        userWarn
                    );
                    if (!ok) {
                        ioxStatus.innerHTML = `<span style="color:#888;">Import annulé</span>`;
                        return;
                    }
                    // Purge des clés wm_* existantes
                    const toDelete = [];
                    for (let i = 0; i < localStorage.length; i++) {
                        const k = localStorage.key(i);
                        if (k && k.startsWith('wm_')) toDelete.push(k);
                    }
                    toDelete.forEach(k => localStorage.removeItem(k));
                    // Écriture des nouvelles clés — tolérante au quota : une clé trop grosse est
                    // ignorée et signalée au lieu de casser tout l'import à mi-chemin.
                    let written = 0; const failed = [];
                    importKeys.forEach(k => {
                        try { localStorage.setItem(k, parsed.data[k]); written++; }
                        catch(e) { failed.push(k); }
                    });
                    if (failed.length > 0) {
                        ioxStatus.innerHTML = `<span style="color:#fbbf24;">✓ ${written} clés importées · ⚠ ${failed.length} ignorée(s) (quota) : ${failed.slice(0,3).join(', ')}${failed.length > 3 ? '…' : ''}. Rechargement…</span>`;
                        wmLog(`📥 Import : <b>${written}</b> clés restaurées, <b>${failed.length}</b> ignorée(s) faute de place (${failed.join(', ')}).`);
                    } else {
                        ioxStatus.innerHTML = `<span style="color:#4ade80;">✓ ${written} clés importées${skippedCache ? ` (cache collection ignoré, régénéré au reload)` : ''}. Rechargement…</span>`;
                        wmLog(`📥 Import : <b>${written}</b> clés restaurées depuis <b>${file.name}</b>${skippedCache ? ` (${skippedCache} clé(s) de cache ignorées)` : ''}. La page va recharger.`);
                    }
                    setTimeout(() => location.reload(), 1200);
                } catch(e) {
                    ioxStatus.innerHTML = `<span style="color:#ef4444;">⚠ Erreur : ${e.message}</span>`;
                }
            };
            fileInput.click();
        };

        /* ════════ MASTER START/STOP (toggle 3 features at once) ════════ */
        const masterBtn = document.getElementById('wm-master-btn');
        const refreshMasterLabel = () => {
            const anyRunning = running || marketWatcherActive || trashSellerRunning;
            const allRunning = running && marketWatcherActive && trashSellerRunning;
            if (allRunning) {
                masterBtn.innerText = '⏹ Tout arrêter';
                masterBtn.style.color = '#ef4444';
            } else if (anyRunning) {
                masterBtn.innerText = '🚀 Compléter';
                masterBtn.style.color = '#fbbf24';
            } else {
                masterBtn.innerText = '🚀 Tout démarrer';
                masterBtn.style.color = '#4ade80';
            }
        };
        masterBtn.onclick = () => {
            const startBtn = document.getElementById('wm-start-btn');
            const marketBtn = document.getElementById('wm-market-btn');
            const trashBtn = document.getElementById('wm-trash-btn');
            const allRunning = running && marketWatcherActive && trashSellerRunning;
            if (allRunning) {
                if (running) startBtn.click();
                if (marketWatcherActive) marketBtn.click();
                if (trashSellerRunning) trashBtn.click();
                wmLog('⏹ Master : arrêt des 3 fonctionnalités');
                // Backup auto sur Discord (option activable dans Paramètres → Sauvegarde)
                if (getSetting('autoBackupOnStop') && getDiscordWebhook() && typeof window.wmSendBackupToDiscord === 'function') {
                    wmLog('🗄️ Backup auto (Tout arrêter) → envoi sur Discord…');
                    window.wmSendBackupToDiscord('(arrêt)').then(r => {
                        if (!r.ok && r.error !== 'no-webhook') {
                            wmLog(`⚠️ Backup auto Discord échoué : ${r.error}`);
                        }
                    });
                }
            } else {
                if (!running) startBtn.click();
                if (!marketWatcherActive) marketBtn.click();
                if (!trashSellerRunning) trashBtn.click();
                wmLog('🚀 Master : démarrage des 3 fonctionnalités');
            }
            setTimeout(refreshMasterLabel, 100);
        };
        // Auto-refresh du label (le trash seller peut s'arrêter de lui-même)
        setInterval(() => {
            // PERF : skip si onglet caché ou overlay fermé (label invisible)
            if (document.hidden) return;
            const overlay = document.getElementById('wm-overlay');
            if (!overlay || overlay.style.display === 'none') return;
            refreshMasterLabel();
        }, 1500);

        /* ════════ PLAGES HORAIRES PAR MODULE (démarrage / arrêt programmé) ════════ */
        // Parse "HH:MM" → minutes depuis minuit ; null si invalide.
        function schedParseMin(hhmm) {
            const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
            if (!m) return null;
            const v = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
            return (v >= 0 && v < 1440) ? v : null;
        }
        // Suis-je dans la plage [start,end] ? (gère le passage par minuit). null si mal réglé.
        function schedInWindowFor(startKey, endKey) {
            const s = schedParseMin(getSetting(startKey));
            const e = schedParseMin(getSetting(endKey));
            if (s == null || e == null || s === e) return null;
            const now = new Date();
            const nowMin = now.getHours() * 60 + now.getMinutes();
            return s < e ? (nowMin >= s && nowMin < e) : (nowMin >= s || nowMin < e);
        }
        // Chaque module a son propre horaire + son bouton. On n'agit qu'aux transitions.
        const SCHED_MODULES = [
            { key: 'pack',   label: '📦 Pack Opener',    btn: 'wm-start-btn',  isOn: () => running,             ena: 'schedulePackEnabled',   start: 'schedulePackStart',   end: 'schedulePackEnd' },
            { key: 'market', label: '🛒 Market Watcher', btn: 'wm-market-btn', isOn: () => marketWatcherActive, ena: 'scheduleMarketEnabled', start: 'scheduleMarketStart', end: 'scheduleMarketEnd' },
            { key: 'trash',  label: '🗑️ Trash Seller',   btn: 'wm-trash-btn',  isOn: () => trashSellerRunning,  ena: 'scheduleTrashEnabled',  start: 'scheduleTrashStart',  end: 'scheduleTrashEnd' },
        ];
        const _schedLast = {}; // key → dernier état "dans la plage" (n'agit qu'aux bascules)
        function checkSchedule() {
            let acted = false;
            for (const m of SCHED_MODULES) {
                if (!getSetting(m.ena)) { _schedLast[m.key] = null; continue; }
                const inWin = schedInWindowFor(m.start, m.end);
                if (inWin === null) continue;             // horaires mal réglés → on ignore ce module
                if (inWin === _schedLast[m.key]) continue; // pas de transition
                _schedLast[m.key] = inWin;
                const btn = document.getElementById(m.btn);
                if (!btn) continue;
                if (inWin && !m.isOn()) {
                    btn.click(); acted = true;
                    wmLog(`⏰ ${m.label} : <b>démarrage</b> programmé (${getSetting(m.start)}–${getSetting(m.end)})`);
                } else if (!inWin && m.isOn()) {
                    btn.click(); acted = true;
                    wmLog(`⏰ ${m.label} : <b>arrêt</b> programmé (hors ${getSetting(m.start)}–${getSetting(m.end)})`);
                    // Backup auto sur Discord si plus AUCUN module ne tourne (comme l'arrêt global)
                    if (getSetting('autoBackupOnStop') && !running && !marketWatcherActive && !trashSellerRunning
                        && getDiscordWebhook() && window.wmSendBackupToDiscord) {
                        window.wmSendBackupToDiscord('(arrêt programmé)');
                    }
                }
            }
            if (acted) setTimeout(refreshMasterLabel, 200);
        }
        // Exposé pour ré-évaluer immédiatement quand l'utilisateur change les réglages.
        window.wmScheduleReeval = () => { for (const k in _schedLast) _schedLast[k] = null; checkSchedule(); };
        checkSchedule();                       // applique les plages au chargement (après auto-restart F5)
        setInterval(checkSchedule, 30000);     // vérifie toutes les 30s

        const refreshBtn = document.getElementById('wm-refresh-btn');
        // Progression affichée sur le bouton, partagée entre le clic manuel (forcé) et le
        // rafraîchissement automatique (incrémental) ci-dessous.
        const collProgress = (loaded, total) => {
            if (total && total > 0) {
                const pct = Math.round((loaded/total)*100);
                refreshBtn.innerText = `⏳ ${pct}%`;
            } else {
                // Mode dégradé (total inconnu) : on affiche le compte chargé
                refreshBtn.innerText = `⏳ ${loaded.toLocaleString('fr-FR')}`;
            }
            const cc = document.getElementById('wm-coll-count');
            if (cc) cc.innerText = collectionMap.size.toLocaleString('fr-FR') + ' cartes';
        };
        refreshBtn.onclick = async () => {
            refreshBtn.disabled = true; refreshBtn.innerText = "⏳ 0%";
            invalidateCollectionItemsCache(); // le prochain étiquetage repartira sur un scan frais
            collectionMap.clear();
            collectionRarityMap.clear();
            resetRarityCount();
            renderRarityHeader();
            localStorage.removeItem('wm_collection_cache');
            localStorage.removeItem('wm_collection_ts');
            localStorage.removeItem('wm_collection_total');
            localStorage.removeItem('wm_collection_rarity');
            localStorage.removeItem('wm_collection_rarity_set');
            await fetchCollection(collProgress);
            refreshBtn.disabled = false; refreshBtn.innerText = "♻️ Collection";
            wmLog(`✅ Collection: ${collectionMap.size} cartes`);
        };

        // Rafraîchissement automatique périodique : signalé le 2026-08-19 — celui-ci simulait
        // un clic sur le bouton, ce qui effaçait le cache AVANT chaque appel et forçait donc un
        // scan COMPLET de toute la collection (~2000 pages sur un gros compte) toutes les 3 min,
        // au lieu du chemin incrémental (fetchNewCards, ne récupère que les nouvelles cartes)
        // que fetchCollection() utilise déjà quand un cache valide existe. Corrélé à des échecs
        // de mise en vente (voir Trash Seller ci-dessous) sur un compte à grosse collection —
        // le martèlement de /api/my-collection semble saturer le serveur. Appelle maintenant
        // fetchCollection() directement, sans vider le cache : reste incrémental et léger.
        setInterval(async () => {
            if (refreshBtn.disabled) return;
            await fetchCollection(collProgress);
        }, 3*60*1000);

        // Refresh auto des ventes actives toutes les 30s, indépendamment du trash seller.
        // Porte AUSSI la synchro des enchères gagnées, pour ne pas rouvrir une requête /mine.
        const refreshActiveSales = async () => {
            try {
                const st = await fetchSellingState(); // complète déjà le détail depuis la base
                if (!st) return; // échec : on garde l'affichage en place (cf. renderActiveSales)
                renderActiveSales(st.list, st);
                if (Date.now() - lastWonSync > 60000) {
                    lastWonSync = Date.now();
                    await syncWonAuctions();
                }
            } catch (e) { /* silent */ }
        };
        refreshActiveSales(); // initial
        setInterval(refreshActiveSales, 30000);

        // Filet de sécurité : réconcilie les ventes en attente toutes les 5 min (retag des
        // invendues revenues), même si le Trash Seller n'est pas lancé. Sans effet si rien
        // n'est en attente. Complète la passe unique du démarrage.
        setInterval(() => { reconcilePendingSales().catch(() => {}); }, 5 * 60 * 1000);

        // (La synchro des enchères gagnées est portée par refreshActiveSales ci-dessus : elle
        // tourne donc bien même Market Watcher à l'arrêt, sans requête supplémentaire.)

        // Sauvegarde périodique de la session en cours : si le navigateur meurt sans prévenir
        // (crash, extinction PC, onglet libéré par Chrome), on ne perd au pire qu'une minute.
        setInterval(() => { try { finalizeSession(); } catch(e) {} }, 60000);

        // Ticker seconde par seconde pour mettre à jour le temps restant des ventes actives
        // Source de vérité = data-end sur chaque span .wm-sale-cd (pas de Map à maintenir)
        setInterval(() => {
            // PERF : skip si onglet caché ou overlay fermé
            if (document.hidden) return;
            const overlay = document.getElementById('wm-overlay');
            if (!overlay || overlay.style.display === 'none') return;
            document.querySelectorAll('.wm-sale-cd').forEach(el => {
                const endAt = el.dataset.end;
                if (!endAt) return;
                el.innerText = formatCountdown(endAt);
                el.style.color = countdownColor(endAt);
            });
        }, 1000);

        /* ════════ REDIMENSIONNEMENT DES COLONNES ════════ */
        (function setupColumnResize() {
            const panels = document.getElementById('wm-panels');
            if (!panels) return;
            const COLS_KEY = 'wm_panel_cols';
            // 3 fractions de colonnes (fr). Défaut : égales.
            let cols = [1, 1, 1];
            try {
                const saved = JSON.parse(localStorage.getItem(COLS_KEY) || 'null');
                if (Array.isArray(saved) && saved.length === 3 && saved.every(n => Number.isFinite(n) && n > 0)) {
                    cols = saved;
                }
            } catch(e) {}

            const RESIZER = '6px';
            function applyCols() {
                panels.style.gridTemplateColumns =
                    `${cols[0]}fr ${RESIZER} ${cols[1]}fr ${RESIZER} ${cols[2]}fr`;
            }
            applyCols();

            const resizers = panels.querySelectorAll('.wm-col-resizer');
            resizers.forEach(resizer => {
                resizer.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    const idx = parseInt(resizer.dataset.resizer, 10); // 0 = entre col 0 et 1 ; 1 = entre col 1 et 2
                    resizer.classList.add('dragging');
                    document.body.style.userSelect = 'none';
                    document.body.style.cursor = 'col-resize';

                    const startX = e.clientX;
                    const rect = panels.getBoundingClientRect();
                    // Largeur totale dispo pour les colonnes (hors poignées + padding)
                    const totalFr = cols[0] + cols[1] + cols[2];
                    const usableWidth = rect.width - 20 - 12; // padding 10*2 + 2 resizers de 6px
                    const pxPerFr = usableWidth / totalFr;
                    const leftStart = cols[idx];
                    const rightStart = cols[idx + 1];

                    function onMove(ev) {
                        const deltaPx = ev.clientX - startX;
                        const deltaFr = deltaPx / pxPerFr;
                        let newLeft = leftStart + deltaFr;
                        let newRight = rightStart - deltaFr;
                        // Minimum 0.4fr par colonne pour éviter qu'une colonne disparaisse
                        const MIN = 0.4;
                        if (newLeft < MIN) { newRight -= (MIN - newLeft); newLeft = MIN; }
                        if (newRight < MIN) { newLeft -= (MIN - newRight); newRight = MIN; }
                        cols[idx] = newLeft;
                        cols[idx + 1] = newRight;
                        applyCols();
                    }
                    function onUp() {
                        resizer.classList.remove('dragging');
                        document.body.style.userSelect = '';
                        document.body.style.cursor = '';
                        document.removeEventListener('mousemove', onMove);
                        document.removeEventListener('mouseup', onUp);
                        try { localStorage.setItem(COLS_KEY, JSON.stringify(cols)); } catch(e) {}
                    }
                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup', onUp);
                });

                // Double-clic sur une poignée : réinitialise les 3 colonnes à égalité
                resizer.addEventListener('dblclick', () => {
                    cols = [1, 1, 1];
                    applyCols();
                    try { localStorage.setItem(COLS_KEY, JSON.stringify(cols)); } catch(e) {}
                });
            });
        })();

        /* ════════ REDIMENSIONNEMENT HAUTEUR DES PANNEAUX ACCORDÉON ════════ */
        (function setupRowResize() {
            const HEIGHTS_KEY = 'wm_panel_heights';
            let heights = {};
            try { heights = JSON.parse(localStorage.getItem(HEIGHTS_KEY) || '{}') || {}; } catch(e) {}

            // Restaure les hauteurs sauvegardées
            Object.entries(heights).forEach(([cssVar, px]) => {
                if (Number.isFinite(px)) document.documentElement.style.setProperty(cssVar, px + 'px');
            });

            document.querySelectorAll('.wm-row-resizer').forEach(resizer => {
                const targetId = resizer.dataset.target;
                const cssVar = resizer.dataset.var;
                const body = document.getElementById(targetId);
                if (!body) return;

                // La poignée n'est visible que quand le panneau est ouvert
                const syncVisibility = () => {
                    resizer.classList.toggle('show', body.classList.contains('open'));
                };
                syncVisibility();
                // Observe l'ouverture/fermeture du panneau (toggle de la classe 'open')
                new MutationObserver(syncVisibility).observe(body, { attributes:true, attributeFilter:['class'] });

                resizer.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    resizer.classList.add('dragging');
                    document.body.style.userSelect = 'none';
                    document.body.style.cursor = 'row-resize';

                    const startY = e.clientY;
                    const startH = body.getBoundingClientRect().height;

                    function onMove(ev) {
                        // Glisser vers le HAUT agrandit le panneau (il monte)
                        const delta = startY - ev.clientY;
                        let newH = startH + delta;
                        // Bornes : entre 100px et 85% de la hauteur de la fenêtre
                        const maxH = window.innerHeight * 0.85;
                        newH = Math.max(100, Math.min(newH, maxH));
                        document.documentElement.style.setProperty(cssVar, newH + 'px');
                    }
                    function onUp() {
                        resizer.classList.remove('dragging');
                        document.body.style.userSelect = '';
                        document.body.style.cursor = '';
                        document.removeEventListener('mousemove', onMove);
                        document.removeEventListener('mouseup', onUp);
                        // Persiste la hauteur finale
                        const finalH = parseInt(getComputedStyle(document.documentElement).getPropertyValue(cssVar), 10);
                        if (Number.isFinite(finalH)) {
                            heights[cssVar] = finalH;
                            try { localStorage.setItem(HEIGHTS_KEY, JSON.stringify(heights)); } catch(e) {}
                        }
                    }
                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup', onUp);
                });

                // Double-clic : réinitialise à la hauteur par défaut (60vh)
                resizer.addEventListener('dblclick', () => {
                    document.documentElement.style.removeProperty(cssVar);
                    delete heights[cssVar];
                    try { localStorage.setItem(HEIGHTS_KEY, JSON.stringify(heights)); } catch(e) {}
                });
            });
        })();

        console.log('[WikiMasters] createUI() finished - click the gear ⚙ FAB (bottom-right) to open the dashboard');
    }


    /* ===================== SALES MONITOR ===================== */

    // Ex-`data.history` de /mine, disparu : `fetchSoldFromDb` lit directement `auctions` et
    // filtre déjà sur « gagnant/prix connu » côté serveur (équivalent moderne de settled_sold).
    async function checkRecentSales() {
        try {
            const recentSales = await fetchSoldFromDb(30);
            if (!Array.isArray(recentSales)) return;

            for (const sale of recentSales) {
                if (knownSoldIds.has(sale.id)) continue;
                knownSoldIds.add(sale.id);

                // Skip si la vente est déjà tracée dans sellHistory : checkSellHistoryResults
                // s'en chargera (avec plus de contexte). Évite la double notification.
                if (sellHistory.some(s => s.auctionId === sale.id)) continue;

                // Ne notifier que les ventes récentes (< 2 minutes)
                const soldAt = new Date(sale.settled_at).getTime();
                if (!Number.isFinite(soldAt) || Date.now() - soldAt > 2 * 60 * 1000) continue;

                const title    = sale.card?.wikipedia_title || "?";
                const rarity   = (sale.snapshot_rarity || sale.card?.rarity || "?").toUpperCase();
                const base     = sale.listing_base_amount || sale.base_amount || 0;
                const final    = sale.final_price || sale.current_bid || 0;
                const gain     = final - base;

                sendToDiscord(
                    "💰 **VENDU !**\n" +
                    "**" + title + "** [" + rarity + "]\n" +
                    "Base : " + base + " 💰 → Vendu : **" + final + " 💰**" +
                    (gain > 0 ? " (+" + gain + " 💰 🔥)" : ""),
                    5763719
                );
            }
        } catch(e) {}
    }

    function startSalesMonitor() {
        if (salesMonitorInterval) return;
        // Pré-remplit les IDs connus pour ne pas notifier les anciennes ventes au démarrage.
        // Le setInterval part dans tous les cas (succès ou échec), comme avant.
        fetchSoldFromDb(50)
            .then(rows => { (rows || []).forEach(h => knownSoldIds.add(h.id)); })
            .catch(() => {})
            .finally(() => { salesMonitorInterval = setInterval(checkRecentSales, 30000); });
    }

    /* ===================== TIMER ===================== */

    function startTimer() {
        stopTimer();
        // PERF : cache la ref de l'élément (lookup unique au lieu de N getElementById/sec)
        let cachedTimerEl = null;
        timerInterval = setInterval(() => {
            // Skip si onglet caché ou overlay fermé (timer invisible de toute façon)
            if (document.hidden) return;
            const overlay = document.getElementById('wm-overlay');
            if (!overlay || overlay.style.display === 'none') return;
            if (!cachedTimerEl || !cachedTimerEl.isConnected) {
                cachedTimerEl = document.getElementById("wm-timer");
            }
            if (cachedTimerEl && sessionStart) {
                cachedTimerEl.innerText = formatTime(Date.now() - sessionStart);
                cachedTimerEl.style.color = "#888";
            }
        }, 1000);
    }

    function stopTimer() {
        if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    }

    /* ===================== API PACKS ===================== */

    // Compteur d'ouvertures initiées par le bot lui-même. Sert à l'intercepteur
    // réseau (installPackInterceptor) pour distinguer une ouverture automatique
    // (déjà comptée par la loop) d'une ouverture MANUELLE faite depuis le site.
    let botPackOpenInFlight = 0;

    async function openPack() {
        botPackOpenInFlight++;
        try {
            const res = await fetch("https://www.wiki-masters.com/api/packs/open",
                { method: "POST", credentials: "include" });
            if (res.status === 403) throw new Error("403");
            return res.json();
        } finally {
            botPackOpenInFlight--;
        }
    }

    /* ── Presets d'étiquetage : helpers partagés (module scope) ──
       Utilisés à la fois par le module Étiquetage en masse (dans createUI) et par
       l'auto-tag des cartes packées ci-dessous. Lecture directe depuis localStorage
       pour rester indépendant du scope de createUI. */
    const PRESET_DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g');
    function presetNorm(s) { return (s || '').toString().normalize('NFD').replace(PRESET_DIACRITICS, '').toLowerCase(); }
    // Séparateur = POINT-VIRGULE (;) pour préserver les titres à virgule.
    function presetTerms(raw) { return (raw || '').split(';').map(s => presetNorm(s.trim())).filter(Boolean); }
    function loadTaggerPresets() {
        try { return JSON.parse(localStorage.getItem('wm_tagger_presets') || '[]') || []; } catch(e) { return []; }
    }
    // Champs "identité" (ce que la carte EST) vs "étendus" (ce qu'elle MENTIONNE).
    // Miroir de TAGGER_ID_KEYS/TAGGER_TEXT_KEYS côté auto-tag des packs.
    const PRESET_ID_KEYS = ['wikipedia_title', 'title', 'name'];
    const PRESET_FULL_KEYS = [...PRESET_ID_KEYS, 'category', 'categories', 'description', 'desc', 'summary', 'extract', 'wikipedia_extract'];
    // Texte de recherche d'une carte. scope 'full' → titre + catégorie + description… ;
    // sinon (défaut) → titre/nom seuls (match précis, comme le tagger manuel).
    function presetCardText(card, scope) {
        const keys = scope === 'full' ? PRESET_FULL_KEYS : PRESET_ID_KEYS;
        const parts = [];
        const collect = (o) => {
            if (!o || typeof o !== 'object') return;
            for (const k of keys) {
                const v = o[k];
                if (typeof v === 'string') parts.push(v);
                else if (Array.isArray(v)) parts.push(v.filter(x => typeof x === 'string').join(' '));
            }
        };
        collect(card);
        collect(card.card);
        return presetNorm(parts.join('  '));
    }

    // Étiquette automatiquement les cartes d'un pack selon les recherches enregistrées.
    // Non bloquant (fire-and-forget) : appelé après chaque pack si l'option est activée.
    async function autoTagPackedCards(cards) {
        if (!getSetting('autoTagPacksFromPresets')) return;
        if (!Array.isArray(cards) || cards.length === 0) return;
        const presets = loadTaggerPresets()
            .map(p => ({ tag: (p.tag || '').trim(), terms: presetTerms(p.kw), kw: p.kw, extended: !!p.extended }))
            .filter(p => p.tag && p.terms.length);
        if (presets.length === 0) return;
        const anyExtended = presets.some(p => p.extended);
        const skipLegendary = getSetting('autoTagSkipLegendary');
        const tagIdCache = {}; // nom(min) → tag_id (résolu une seule fois)
        for (const c of cards) {
            // Filet de sécurité : on peut exclure les Légendaires de l'auto-tag (une L
            // rare qu'on veut garder ne doit pas finir taguée « Trash » via sa description).
            const rarity = (c.rarity || c.card?.rarity || '').toUpperCase();
            if (skipLegendary && rarity === 'L') {
                const t = c.wikipedia_title || c.card?.wikipedia_title || '?';
                wmLog(`🛡️ Auto-tag ignoré (Légendaire protégée) : <b>${t}</b>`);
                continue;
            }
            const idText = presetCardText(c, 'title');
            const fullText = anyExtended ? presetCardText(c, 'full') : null;
            const cardId = c.card_id || c.id || c.card?.id;
            if (!cardId) continue;
            for (const p of presets) {
                const text = p.extended ? fullText : idText;
                if (!p.terms.some(t => text.includes(t))) continue;
                const key = p.tag.toLowerCase();
                let tagId = tagIdCache[key];
                if (tagId === undefined) {
                    const tag = await createTrashTag(p.tag); // find-or-create idempotent
                    tagId = (tag.ok && tag.id) ? tag.id : null;
                    tagIdCache[key] = tagId;
                }
                if (!tagId) continue;
                const title = c.wikipedia_title || c.card?.wikipedia_title || '?';
                const userCardId = await findCurrentUserCardId(cardId, title);
                if (!userCardId) continue;
                const r = await addTagToUserCard(userCardId, tagId);
                if (r.ok) {
                    wmLog(`🏷️ Auto-tag pack : <b>${title}</b> → « <b>${p.tag}</b> » <span style="color:#555;font-size:9px;">(${p.kw})</span>`);
                    if (tagId === TRASH_TAG_ID) pushToTrashPoolCache(cardId, title, rarity); // ajout direct, sans rescan
                } else {
                    wmLog(`⚠️ Auto-tag pack échoué : <b>${title}</b> → « ${p.tag} » · HTTP ${r.status} ${r.error || ''}`);
                }
            }
        }
    }

    // Comptabilise un pack ouvert (auto ou manuel) : stats, affichage, alertes,
    // détection de mots-clés. Extrait de la loop pour être réutilisable par
    // l'intercepteur réseau. animate=true → joue l'animation de révélation.
    let _packCardFieldsLogged = false;
    function logPackCardFields(sample) {
        if (_packCardFieldsLogged || !sample) return;
        _packCardFieldsLogged = true;
        wmLog(`🔬 Champs carte de pack : <span style="color:#888;font-size:9px;">${Object.keys(sample).join(', ')}</span>`);
    }

    async function handlePackOpened(data, opts = {}) {
        const { animate = false } = opts;
        const cards = (data && data.cards) || [];
        if (!cards.length) return;
        logPackCardFields(cards[0]); // diag : quels identifiants sont dispo pour un deep-link

        rolloverDailyStatsIfNeeded(); // reset des stats du jour si on a passé minuit

        totalPacks++;
        sessionPacks++;
        sessionMetrics.packsOpened++;
        saveSessionMetrics();
        incrementDailyPacks();

        const packsEl = document.getElementById("wm-packs");
        if (packsEl) {
            packsEl.innerText = `${sessionPacks} pack${sessionPacks > 1 ? "s" : ""}`;
        }

        if (animate) {
            const revealEl = document.getElementById("wm-reveal");
            if (revealEl) await revealCards(cards, revealEl);
        }

        const result = analyzeCards(cards);
        saveDailyPackStats(); // fusion des stats du jour (survit aux refresh)
        saveSessionMetrics(); // raretés de la session (analyzeCards vient de les incrémenter)
        finalizeSession();    // récap de session écrit au fil de l'eau, pas au unload

        // 🔥 ALERTES RARETÉ
        const rareDrop = cards.find(c => (c.rarity || "").toUpperCase() === "L");
        const urDrop   = cards.find(c => (c.rarity || "").toUpperCase() === "UR");

        // 🔊 Sons : si une Légendaire tombe → fanfare (prioritaire) ; sinon petit son
        // d'ouverture. Chaque son est indépendamment activable dans les Paramètres.
        if (rareDrop && isSoundEnabled('legendary')) {
            playSound('legendary');
        } else {
            playSound('pack'); // ne joue que si "son d'ouverture de pack" est coché
        }

        if (rareDrop) {
            sendToDiscord(
                "🔥 **L DROP !**\n" +
                "**" + (rareDrop.wikipedia_title || "?") + "**\n" +
                "⚔️ ATK : **" + (rareDrop.atk ?? "?") + "** · 🛡️ DEF : **" + (rareDrop.def ?? "?") + "**\n" +
                "🔗 " + (rareDrop.wikipedia_url || ""),
                16766720
            );
        }

        if (urDrop) {
            sendToDiscord(
                "💎 **UR DROP !**\n" +
                "**" + (urDrop.wikipedia_title || "?") + "**\n" +
                "⚔️ ATK : **" + (urDrop.atk ?? "?") + "** · 🛡️ DEF : **" + (urDrop.def ?? "?") + "**\n" +
                "🔗 " + (urDrop.wikipedia_url || ""),
                16753920
            );
        }

        const lastDropEl = document.getElementById("wm-last-drop");
        if (lastDropEl) {
            lastDropEl.innerHTML = cards.map(c => {
                const rarity = (c.rarity || "").toUpperCase();
                const r = RARITY[rarity] || { color:"#aaa", bg:"rgba(170,170,170,0.1)" };
                const title = c.wikipedia_title || "?";
                const url = c.wikipedia_url || "";
                // Le site ouvre les cartes de collection dans une popup SANS URL → pas de
                // deep-link possible vers la collection. On pointe donc vers la page
                // Wikipédia de la carte (ouverte dans un nouvel onglet).
                const nameHtml = url
                    ? `<a href="${url}" target="wm-card-view" rel="noopener"
                        style="color:${r.color};flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:none;"
                        title="Ouvrir « ${title} » sur Wikipédia"
                        onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${title}</a>`
                    : `<span style="color:${r.color};flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${title}">${title}</span>`;

                return `<div style="padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.05);
                    display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;">
                    ${nameHtml}${badge(rarity)}</div>`;
            }).join("");
        }

        renderRarityStats(document.getElementById("wm-rarity"));
        saveStats();

        const alertEl = document.getElementById("wm-alert");
        if (result.keywordHits.length > 0) {
            const cardsNames = result.keywordHits
                .map(c => c.wikipedia_title)
                .join(", ");

            if (alertEl) alertEl.innerHTML = `🚨 MOT-CLÉ : ${cardsNames}`;
            sendToDiscord(`🚨 MOT-CLÉ détecté : ${cardsNames}`, 65535);

            // Historise chaque carte matchée et log dans le dashboard
            const now = Date.now();
            result.keywordHits.forEach(c => {
                const title = c.wikipedia_title || '?';
                const rarity = (c.rarity || 'C').toUpperCase();
                const kw = matchedKeyword(c, true) || '?';
                packKwHits.push({ title, rarity, keyword: kw, ts: now });
                wmLog(`🎯 Pack match : <b>${title}</b> [${rarity}] · keyword <span style="color:#00FFFF;">${kw}</span>`);
            });
            if (packKwHits.length > 100) packKwHits = packKwHits.slice(-100);
            savePackKwHits();
            renderPackKwHits();
        } else if (alertEl) {
            alertEl.innerHTML = "";
        }

        // Auto-tag des cartes packées selon les recherches enregistrées (non bloquant).
        autoTagPackedCards(cards).catch(() => {});
    }

    // Récupération de tags : quand le SITE échoue à poser des tags en LOT
    // (POST batch /user_card_tags qui timeout en 500 "statement timeout"), on rejoue
    // les paires du payload UNE PAR UNE via le bot (upsert idempotent, jamais en timeout).
    // N'agit que sur les tableaux (= requêtes du site) : les mises du bot sont des objets
    // uniques, donc jamais re-traitées → aucune boucle.
    async function recoverFailedTagBatch(bodyStr, status) {
        let rows;
        try { rows = JSON.parse(bodyStr); } catch(e) { return; }
        if (!Array.isArray(rows)) return; // requête du bot (objet unique) → on ignore
        const pairs = rows.filter(r => r && r.user_card_id && r.tag_id);
        if (pairs.length === 0) return;
        wmLog(`🛟 Le site a échoué (HTTP ${status}) à taguer <b>${pairs.length}</b> carte(s) en lot → reprise par le bot…`);
        let ok = 0, fail = 0;
        const CONC = 4; // upserts unitaires en parallèle par petits paquets
        for (let i = 0; i < pairs.length; i += CONC) {
            const slice = pairs.slice(i, i + CONC);
            const results = await Promise.all(slice.map(r => addTagToUserCard(r.user_card_id, r.tag_id)));
            results.forEach(x => { if (x.ok) ok++; else fail++; });
        }
        if (fail === 0) {
            wmLog(`✅ Reprise réussie : <b>${ok}</b> carte(s) taguée(s) malgré l'échec du site. Recharge la page pour voir les tags.`);
        } else {
            wmLog(`⚠️ Reprise partielle : ${ok} ok, <b>${fail}</b> échec(s) — réessaie sur les cartes restantes.`);
        }
    }

    // Suppression d'un tag qui échoue côté site (500 "statement timeout") : supprimer un tag
    // déclenche un CASCADE delete de toutes ses liaisons user_card_tags en une seule
    // transaction → trop gros → timeout. On nettoie d'abord les liaisons PAR LOTS (chaque
    // lot est rapide, sous le timeout), puis on supprime le tag lui-même (devenu léger).
    const _tagDeleteRecovering = new Set(); // évite le re-déclenchement par notre propre DELETE final
    async function recoverFailedTagDelete(tagId) {
        if (!tagId || _tagDeleteRecovering.has(tagId)) return;
        _tagDeleteRecovering.add(tagId);
        try {
            await _doRecoverTagDelete(tagId);
        } finally {
            _tagDeleteRecovering.delete(tagId);
        }
    }
    async function _doRecoverTagDelete(tagId) {
        const { token } = getSupabaseAccessToken();
        const auth = {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${token || SUPABASE_KEY}`,
            'Accept': 'application/json'
        };
        const isTransient = (s) => [500, 502, 503, 504, 429].includes(s);
        wmLog(`🛟 Le site a échoué à supprimer un tag (timeout serveur) → nettoyage par lots via le bot…`);

        // Un essai de suppression sur un ensemble d'ids. Retourne { ok, count, status, body }.
        async function tryDelete(ids) {
            try {
                const del = await fetch(
                    `${SUPABASE_URL}/user_card_tags?tag_id=eq.${tagId}&user_card_id=in.(${ids.join(',')})`,
                    { method: 'DELETE', credentials: 'omit', headers: { ...auth, 'Prefer': 'return=representation' } }
                );
                if (del.ok) { const arr = await del.json().catch(() => []); return { ok: true, count: Array.isArray(arr) ? arr.length : 0, status: del.status }; }
                const body = await del.text().catch(() => '');
                return { ok: false, count: 0, status: del.status, body };
            } catch(e) { return { ok: false, count: 0, status: 0, body: e.message }; }
        }

        // Diviser-pour-régner : si un lot timeout (500), on le coupe en deux et on réessaie,
        // jusqu'à trouver une taille qui passe — ou 1 ligne (et là c'est verrouillé serveur).
        // Retourne { deleted, stuck, rls } (rls = lignes acceptées mais non supprimées = RLS).
        async function deleteChunk(ids) {
            const r = await tryDelete(ids);
            if (r.ok) {
                if (r.count === 0 && ids.length > 0) return { deleted: 0, stuck: 0, rls: ids.length };
                return { deleted: r.count, stuck: 0, rls: 0 };
            }
            if (isTransient(r.status) || r.status === 0) {
                if (ids.length <= 1) return { deleted: 0, stuck: ids.length, rls: 0 }; // 1 ligne timeout encore → coincé
                const mid = Math.floor(ids.length / 2);
                const a = await deleteChunk(ids.slice(0, mid));
                const b = await deleteChunk(ids.slice(mid));
                return { deleted: a.deleted + b.deleted, stuck: a.stuck + b.stuck, rls: a.rls + b.rls };
            }
            throw { status: r.status, body: r.body }; // 400/401/403… → erreur définitive
        }

        const SELECT_BATCH = 100;
        let removed = 0, batches = 0, safety = 0;
        while (safety++ < 50000) {
            // 1) récupère un lot d'exemplaires encore liés à ce tag
            let rows;
            try {
                const sel = await fetch(
                    `${SUPABASE_URL}/user_card_tags?tag_id=eq.${tagId}&select=user_card_id&limit=${SELECT_BATCH}`,
                    { credentials: 'omit', headers: auth }
                );
                if (!sel.ok) {
                    if (isTransient(sel.status)) { await new Promise(r => setTimeout(r, 1500)); continue; }
                    const b = await sel.text().catch(() => '');
                    wmLog(`❌ Lecture des liaisons échouée (HTTP ${sel.status})${b ? ' · ' + b.slice(0, 140) : ''}`);
                    return;
                }
                rows = await sel.json();
            } catch(e) { await new Promise(r => setTimeout(r, 1500)); continue; }

            if (!Array.isArray(rows) || rows.length === 0) break;
            const ids = rows.map(r => r.user_card_id).filter(Boolean);
            if (ids.length === 0) break;

            // 2) supprime ce lot en diviser-pour-régner
            let res;
            try { res = await deleteChunk(ids); }
            catch(err) { wmLog(`❌ Suppression des liaisons refusée (HTTP ${err.status})${err.body ? ' · ' + String(err.body).slice(0, 160) : ''}`); return; }

            // Serveur OK mais 0 supprimé → RLS bloque la suppression directe
            if (res.rls > 0 && res.deleted === 0 && res.stuck === 0) {
                wmLog(`⛔ Le serveur accepte mais ne retire <b>aucune</b> liaison ⇒ suppression directe <b>bloquée par les permissions (RLS)</b>. Non contournable côté navigateur.`);
                return;
            }

            removed += res.deleted; batches++;

            // Des lignes intuables même une par une → un trigger côté base rend la
            // suppression trop lourde (timeout par ligne). On ne peut rien faire de plus.
            if (res.stuck > 0) {
                wmLog(`⛔ ${res.stuck} liaison(s) impossible(s) à supprimer même <b>une par une</b> (timeout serveur par ligne). Un déclencheur côté base rend la suppression trop lourde — <b>non contournable côté navigateur</b>. ${removed} liaison(s) tout de même nettoyée(s).`);
                return;
            }

            if (batches === 1) wmLog(`🗑️ Suppression tag : 1er lot OK (${res.deleted} liaison(s))…`);
            else if (batches % 10 === 0) wmLog(`🗑️ Suppression tag : <b>${removed}</b> liaison(s) nettoyée(s)…`);
            await new Promise(r => setTimeout(r, 150)); // souffle entre lots
        }

        // 3) supprime enfin le tag lui-même (plus de dépendants → rapide)
        for (let attempt = 0; attempt < 6; attempt++) {
            try {
                const del = await fetch(
                    `${SUPABASE_URL}/tags?id=eq.${tagId}`,
                    { method: 'DELETE', credentials: 'omit', headers: { ...auth, 'Prefer': 'return=representation' } }
                );
                if (del.ok) {
                    const arr = await del.json().catch(() => []);
                    const gone = Array.isArray(arr) ? arr.length : 0;
                    if (gone > 0) {
                        wmLog(`✅ Tag supprimé par le bot (${removed} liaison(s) nettoyée(s)). Recharge la page pour le voir disparaître.`);
                    } else {
                        wmLog(`⛔ Les ${removed} liaison(s) sont nettoyées mais la suppression du tag ne retire aucune ligne (RLS sur la table "tags" ?). Réessaie de le supprimer sur le site : le cascade est désormais vide, ça devrait passer.`);
                    }
                    return;
                }
                if (!isTransient(del.status)) {
                    const b = await del.text().catch(() => '');
                    wmLog(`❌ Suppression du tag échouée (HTTP ${del.status})${b ? ' · ' + b.slice(0, 140) : ''}`);
                    return;
                }
            } catch(e) {}
            await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt), 8000)));
        }
        wmLog(`⚠️ Liaisons nettoyées (${removed}) mais le tag lui-même reste — relance la suppression sur le site, ça devrait passer maintenant.`);
    }

    // Acceptation d'échange qui échoue côté site (500). CONTRAIREMENT aux tags (qu'on peut poser
    // une par une), une acceptation est une transaction ATOMIQUE : le serveur transfère TOUTES
    // les cartes de l'échange d'un coup. Si c'est trop lourd (>~30 cartes) → dépassement du
    // timeout serveur → rollback complet, et on ne peut NI la découper NI la rejouer utilement
    // côté navigateur (le transfert de propriété est autorisé côté serveur seulement).
    // Le bot se limite donc à : (a) détecter si le commit a en fait abouti malgré le 500
    // (timeout au retour, pas au traitement), (b) UNE tentative au cas où le 500 était un simple
    // hoquet, (c) sinon expliquer que c'est une limite serveur non contournable.
    // Garde `_tradeRecovering` : notre propre retry passe par le wrapper fetch et ne doit pas
    // relancer une reprise imbriquée (pas de boucle).
    const _tradeRecovering = new Set();
    async function recoverFailedTradeAccept(tradeId) {
        if (!tradeId || _tradeRecovering.has(tradeId)) return;
        _tradeRecovering.add(tradeId);
        try { await _doRecoverTradeAccept(tradeId); }
        finally { _tradeRecovering.delete(tradeId); }
    }
    // Lit l'état d'un échange. Renvoie { httpOk, data } ou { httpOk:false, status/error }.
    async function fetchTradeState(tradeId) {
        try {
            const res = await fetch(`https://www.wiki-masters.com/api/trades/${tradeId}`, { credentials: 'include' });
            if (!res.ok) return { httpOk: false, status: res.status };
            const data = await res.json().catch(() => null);
            return { httpOk: true, data };
        } catch(e) { return { httpOk: false, error: e.message }; }
    }
    // Heuristique "l'échange est-il déjà accepté/clôturé ?" — on ratisse large sur les champs
    // de statut plausibles (le shape exact de l'API n'est pas garanti).
    function tradeLooksAccepted(data) {
        if (!data || typeof data !== 'object') return false;
        const t = data.trade || data.data || data;
        if (!t || typeof t !== 'object') return false;
        const s = String(t.status || t.state || '').toLowerCase();
        if (['accepted','completed','complete','done','closed','fulfilled','settled','success'].includes(s)) return true;
        if (t.accepted_at || t.completed_at || t.closed_at) return true;
        return false;
    }
    async function _doRecoverTradeAccept(tradeId) {
        // 1) Le 500 masque-t-il un commit réussi ? (timeout AU RETOUR, pas au traitement)
        const st0 = await fetchTradeState(tradeId);
        if (st0.httpOk && tradeLooksAccepted(st0.data)) {
            wmLog(`✅ Échange finalement accepté (le serveur avait bien traité malgré l'erreur). Recharge la page.`);
            return;
        }
        // 2) UNE seule nouvelle tentative — utile uniquement si le 500 était un hoquet transitoire.
        //    Inutile de spammer : une transaction trop lourde échouera pareil à chaque fois.
        wmLog(`🛟 Acceptation d'échange échouée (500) → une tentative de reprise par le bot…`);
        try {
            const res = await fetch(`https://www.wiki-masters.com/api/trades/${tradeId}`, {
                method: 'PATCH', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'accept' })
            });
            if (res.ok) { wmLog(`✅ Échange accepté par le bot. Recharge la page.`); return; }
            if (res.status >= 400 && res.status < 500) {
                const b = await res.text().catch(() => '');
                if (/already|d[ée]j[àa]|accepted|not.?pending|invalid.?state/i.test(b)) {
                    wmLog(`✅ Échange déjà traité. Recharge la page.`);
                    return;
                }
            }
        } catch(e) {}
        // 3) La tentative a pu aboutir malgré une réponse en erreur → on revérifie l'état réel.
        const st1 = await fetchTradeState(tradeId);
        if (st1.httpOk && tradeLooksAccepted(st1.data)) {
            wmLog(`✅ Échange finalement accepté. Recharge la page.`);
            return;
        }
        // 4) Échec confirmé : limite SERVEUR, non contournable côté bot.
        wmLog(`⚠️ Acceptation impossible à reprendre : c'est une limite <b>serveur</b>. L'échange transfère toutes les cartes en <b>une seule transaction</b> — trop lourde ⇒ timeout ⇒ annulation complète. Contrairement aux tags (posables un par un), ça ne peut être ni découpé ni rejoué depuis le navigateur. <b>Contournement :</b> demande à ton partenaire de scinder l'échange en plusieurs plus petits (≤ ~20-25 cartes), ou réessaie à une heure de faible charge.`);
    }

    // Résout le titre d'une carte à partir de son card_id (UUID). Le payload wishlist
    // ne contient QUE l'id, donc on va chercher le nom : d'abord la table Supabase
    // "cards", puis le marketplace en repli (si la carte y est listée).
    async function fetchCardTitleById(cardId) {
        if (!cardId) return null;
        // 1) Table cards via Supabase REST (select=* pour éviter une 400 sur colonne inconnue)
        try {
            const { token } = getSupabaseAccessToken();
            const res = await fetch(`${SUPABASE_URL}/cards?id=eq.${cardId}&select=*&limit=1`, {
                credentials: 'omit',
                headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${token || SUPABASE_KEY}`, 'Accept': 'application/json' }
            });
            if (res.ok) {
                const data = await res.json();
                const row = Array.isArray(data) ? data[0] : null;
                const t = row && (row.wikipedia_title || row.name || row.title);
                if (t) return t;
            }
        } catch(e) {}
        // 2) Repli : marketplace filtré par card_id
        try {
            const res = await fetch(`${MARKET_API_BASE}?card_id=${cardId}&limit=1`, { credentials: 'include' });
            if (res.ok) {
                const data = await res.json();
                const a = (data.auctions || [])[0];
                const t = a?.card?.wikipedia_title;
                if (t) return t;
            }
        } catch(e) {}
        return null;
    }

    // Ajout wishlist sur le site → ajoute la carte aux mots-clés du Market Watcher,
    // pour avoir une alerte dédiée (son/Discord) au lieu de la noyer dans les notifs du site.
    async function handleWishlistAdd(bodyStr) {
        if (!getSetting('wishlistToKeyword')) return;
        let payload;
        try { payload = JSON.parse(bodyStr); } catch(e) { return; }
        const rows = Array.isArray(payload) ? payload : [payload];
        for (const row of rows) {
            const cardId = row && (row.card_id || row.cardId);
            if (!cardId) continue;
            const title = await fetchCardTitleById(cardId);
            if (!title) {
                wmLog(`⭐ Wishlist : carte <span style="color:#888;font-size:9px;">${String(cardId).slice(0,8)}…</span> ajoutée, mais titre introuvable → mot-clé non ajouté.`);
                continue;
            }
            if (KEYWORDS_ALERT.some(k => k.toLowerCase() === title.toLowerCase())) {
                wmLog(`⭐ Wishlist : <b>${title}</b> déjà dans les mots-clés.`);
                continue;
            }
            if (window.wmAddKeyword) window.wmAddKeyword(title);
            wmLog(`⭐ Wishlist → mot-clé ajouté : <b style="color:#06b6d4;">${title}</b>`);
        }
    }

    // Intercepteur réseau : (1) capte les ouvertures de pack MANUELLES pour les
    // comptabiliser, (2) récupère les tags que le site a échoué à poser en lot (500),
    // (3) ajoute aux mots-clés les cartes mises en wishlist sur le site,
    // (4) reprend l'acceptation d'un échange que le site a échoué à traiter (500, gros échange).
    (function installPackInterceptor() {
        const origFetch = window.fetch;
        // Exposé pour diagnostic (2026-08-19) : window.fetch étant remplacé juste en dessous,
        // TOUT appel fetch(...) depuis la console passe par notre wrapper, même s'il n'y touche
        // rien pour /api/marketplace — jamais testé le vrai fetch natif isolé jusqu'ici.
        window.wmOriginalFetch = origFetch;
        window.fetch = function (...args) {
            let isManualPackOpen = false;
            let tagBatch = null;  // { body?:string, reqClone?:Request } si POST /user_card_tags
            let wishlistAdd = null; // idem si POST /wishlist_items
            let tagDeleteId = null; // id du tag si DELETE /rest/v1/tags échoue (timeout cascade)
            let tradeAccept = null; // { id, cap } si PATCH /api/trades/{id} (on vérifie action=accept)
            // Mise en vente via l'UI (sellCardViaUI) : capte l'auction_id de la réponse pour
            // l'associer à sellHistory. Déclarée ici (comme les variables au-dessus) pour rester
            // accessible après le try — url/method y sont en `const`, portée bloc uniquement.
            let isMarketplaceCreate = false;
            try {
                const req = args[0];
                const url = (typeof req === 'string') ? req : (req && req.url) || '';
                const method = ((args[1] && args[1].method) || (req && req.method) || 'GET').toUpperCase();
                isManualPackOpen = method === 'POST'
                    && url.includes('/api/packs/open')
                    && botPackOpenInFlight === 0;
                // Comme les autres checks : url/method (pas args[0] brut) pour couvrir un appel
                // du site en URL relative (/api/marketplace) aussi bien qu'absolue — une égalité
                // stricte sur l'URL absolue ne matchait jamais, donc auctionId restait toujours
                // null (bug du 2026-08-20 : plus de re-tag Trash sur les invendus).
                isMarketplaceCreate = method === 'POST' && /\/api\/marketplace(\?|$)/.test(url);
                // Capture le payload d'un POST /rest/v1/... pour le rejouer/exploiter côté bot.
                const capture = () => {
                    if (args[1] && typeof args[1].body === 'string') return { body: args[1].body };
                    if (req && typeof req === 'object' && typeof req.clone === 'function') {
                        try { return { reqClone: req.clone() }; } catch(e) {}
                    }
                    return null;
                };
                // Tags en lot (site) : rejoués si la réponse est un 5xx (timeout Postgres).
                if (method === 'POST' && url.includes('/rest/v1/user_card_tags')) tagBatch = capture();
                // Ajout wishlist : on récupère le card_id pour l'ajouter aux mots-clés.
                if (method === 'POST' && url.includes('/rest/v1/wishlist_items')) wishlistAdd = capture();
                // Suppression d'un tag (site) : si elle timeout (cascade trop gros), on la reprend
                // par lots côté bot. On extrait l'id du tag depuis l'URL (?id=eq.<uuid>).
                if (method === 'DELETE' && url.includes('/rest/v1/tags?')) {
                    const m = url.match(/[?&]id=eq\.([^&]+)/);
                    if (m) tagDeleteId = decodeURIComponent(m[1]);
                }
                // Acceptation d'échange (site) : PATCH /api/trades/{id}. Si elle timeout (500)
                // sur un gros échange, on la reprend côté bot. On capte le payload pour ne
                // rejouer QUE les acceptations (action:accept), pas les refus/annulations.
                if (method === 'PATCH') {
                    const m = url.match(/\/api\/trades\/([^/?#]+)/i);
                    if (m) tradeAccept = { id: m[1], cap: capture() };
                }
            } catch (e) {}

            const p = origFetch.apply(this, args);

            if (isMarketplaceCreate) {
                p.then(res => {
                    if (res && res.ok) {
                        res.clone().json().then(d => {
                            if (d && d.auction_id) _lastUiListingAuctionId = d.auction_id;
                        }).catch(() => {});
                    }
                }).catch(() => {});
            }

            if (isManualPackOpen) {
                p.then(res => {
                    if (res && res.ok) {
                        res.clone().json().then(d => {
                            if (d && d.cards && d.cards.length) {
                                wmLog(`🖐️ Pack ouvert <b>manuellement</b> — comptabilisé dans les stats`);
                                handlePackOpened(d, { animate: false });
                            }
                        }).catch(() => {});
                    }
                }).catch(() => {});
            }

            if (tagBatch) {
                p.then(async (res) => {
                    try {
                        // Uniquement sur erreur serveur (500 statement timeout, 502/503/504).
                        // Les requêtes qui passent (200) ou les 4xx ne sont pas touchées.
                        if (res && res.status >= 500) {
                            let bodyStr = tagBatch.body;
                            if (!bodyStr && tagBatch.reqClone) {
                                try { bodyStr = await tagBatch.reqClone.text(); } catch(e) {}
                            }
                            if (bodyStr) recoverFailedTagBatch(bodyStr, res.status);
                        }
                    } catch(e) {}
                }).catch(() => {});
            }

            if (wishlistAdd) {
                p.then(async (res) => {
                    try {
                        // Ajout wishlist réussi (201/2xx) → on résout le titre et on l'ajoute aux mots-clés.
                        if (res && res.ok) {
                            let bodyStr = wishlistAdd.body;
                            if (!bodyStr && wishlistAdd.reqClone) {
                                try { bodyStr = await wishlistAdd.reqClone.text(); } catch(e) {}
                            }
                            if (bodyStr) handleWishlistAdd(bodyStr);
                        }
                    } catch(e) {}
                }).catch(() => {});
            }

            if (tagDeleteId) {
                p.then((res) => {
                    // Uniquement sur erreur serveur (500 statement timeout, 502/503/504).
                    // Le garde-fou interne (_tagDeleteRecovering) empêche que notre propre
                    // DELETE final ne relance une reprise → pas de boucle.
                    if (res && res.status >= 500) recoverFailedTagDelete(tagDeleteId);
                }).catch(() => {});
            }

            // Santé : compte les erreurs serveur (429 / 5xx) et réseau sur TOUTES les requêtes.
            p.then((res) => {
                if (!res) return;
                if (res.status === 429) { apiHealth.err429++; apiHealth.lastErrTs = Date.now(); apiHealth.lastErrMsg = 'HTTP 429 (rate limit)'; }
                else if (res.status >= 500) { apiHealth.err5xx++; apiHealth.lastErrTs = Date.now(); apiHealth.lastErrMsg = 'HTTP ' + res.status; }
            }).catch((e) => { apiHealth.errNet++; apiHealth.lastErrTs = Date.now(); apiHealth.lastErrMsg = 'réseau : ' + (e && e.message ? e.message : '?'); });

            if (tradeAccept) {
                p.then(async (res) => {
                    // Uniquement sur erreur serveur (500 timeout du site sur les gros échanges).
                    if (!res || res.status < 500) return;
                    // Vérifie que c'était bien une ACCEPTATION (pas un refus/annulation).
                    let bodyStr = tradeAccept.cap && tradeAccept.cap.body;
                    if (!bodyStr && tradeAccept.cap && tradeAccept.cap.reqClone) {
                        try { bodyStr = await tradeAccept.cap.reqClone.text(); } catch(e) {}
                    }
                    let action = '';
                    try { action = (JSON.parse(bodyStr || '{}').action || '').toLowerCase(); } catch(e) {}
                    if (action !== 'accept') return; // on ne rejoue que les acceptations
                    recoverFailedTradeAccept(tradeAccept.id);
                }).catch(() => {});
            }

            return p;
        };
    })();

    /* ===================== LOOP ===================== */

    async function loop(revealEl, lastDropEl, rarityEl, alertEl, epoch) {

    // `epoch === packLoopEpoch` : cette boucle est-elle toujours la boucle courante ?
    // Un stop→start génère un nouvel epoch ; l'ancienne boucle sort ici au lieu de doubler.
    const isCurrent = () => running && epoch === packLoopEpoch;
    while (isCurrent()) {
        try {
            // Pause propre si le réseau est coupé (évite de spammer des requêtes en échec)
            if (!navigator.onLine) {
                await new Promise(r => setTimeout(r, 5000));
                continue;
            }
            const data = await openPack();
            if (!isCurrent()) break; // stoppé/relancé pendant l'ouverture → on n'enchaîne pas

            // Comptabilisation + affichage + alertes (mutualisé avec les
            // ouvertures manuelles interceptées, cf. handlePackOpened).
            await handlePackOpened(data, { animate: true });

            // ✅ Regen
            if (data.packs_remaining === 0 || data.error) {
                // Le setting utilisateur est la source de vérité (l'API peut renvoyer
                // des valeurs liées au prochain slot, pas au cooldown complet)
                const cdSec = getSetting('packCooldown');
                const waitMs = cdSec * 1000;

                // Log uniquement au premier passage ou si la valeur a changé
                if (loop._lastLoggedCd !== cdSec) {
                    wmLog(`📦 Pack regen : <b>${cdSec}s</b> (${cdSec === 180 ? '3 min, abonné' : cdSec === 600 ? '10 min, non-abonné' : 'custom'})`);
                    loop._lastLoggedCd = cdSec;
                }

                // Ticker live qui décompte chaque seconde
                const endTime = Date.now() + waitMs + 2000;
                const updateAlert = () => {
                    // PERF : skip si overlay fermé/hidden — l'alert n'est pas visible
                    if (document.hidden) return;
                    const overlay = document.getElementById('wm-overlay');
                    if (!overlay || overlay.style.display === 'none') return;
                    const remaining = Math.max(0, endTime - Date.now() - 2000);
                    alertEl.innerHTML = `<span style="color:#888">⏳ Regen dans ${Math.round(remaining/1000)}s…</span>`;
                };
                updateAlert();
                const tickerId = setInterval(updateAlert, 1000);
                try {
                    // Attente interruptible : on sort dès que la boucle n'est plus courante
                    // (stop/restart) → le ticker est nettoyé aussitôt, pas à la fin du cooldown.
                    while (isCurrent() && Date.now() < endTime) {
                        await new Promise(r => setTimeout(r, 1000));
                    }
                } finally {
                    clearInterval(tickerId);
                }
                if (!isCurrent()) break;
                continue;
            }

            // ✅ délai humanisé
            let delay = 1200 + Math.random() * 1800;
            await sleep(delay);

        } catch (err) {

            if (err.message === "403") {
                alertEl.innerHTML = `<span style="color:#EF4444">⛔ 403 — pause 60s</span>`;
                await sleep(60000);
            } else {
                await sleep(5000);
            }
        }
    }
}

    /* ════════ ONBOARDING (première utilisation) ════════ */

    const ONBOARDING_DONE_KEY = 'wm_onboarding_done';

    function showOnboardingIfNeeded() {
        // Flag binaire dans localStorage : présent (= '1') → onboarding fait, on saute.
        // Absent (= null) → première utilisation, on affiche le modal.
        if (localStorage.getItem(ONBOARDING_DONE_KEY)) return;
        if (document.getElementById('wm-onboarding')) return;

        const modal = document.createElement('div');
        modal.id = 'wm-onboarding';
        modal.innerHTML = `
            <style>
                #wm-onboarding {
                    position:fixed; inset:0; z-index:2147483647;
                    background:rgba(2,2,4,0.85);
                    display:flex; align-items:center; justify-content:center;
                    font-family:'Rajdhani', system-ui, sans-serif;
                    padding:20px;
                }
                .wm-ob-card {
                    background:#0a0a0e; border:1px solid rgba(255,255,255,0.1);
                    border-radius:10px; padding:24px 28px;
                    max-width:580px; width:100%;
                    max-height:90vh; overflow-y:auto;
                    box-shadow:0 8px 40px rgba(0,0,0,0.8);
                    color:#bbb;
                }
                .wm-ob-card h2 {
                    margin:0 0 4px; font-size:20px; font-weight:700; color:#fff;
                    letter-spacing:0.5px;
                }
                .wm-ob-card p.intro {
                    margin:0 0 18px; font-size:12px; color:#777;
                }
                .wm-ob-step {
                    border-top:1px solid rgba(255,255,255,0.06);
                    padding:14px 0;
                }
                .wm-ob-step:first-of-type { border-top:none; padding-top:0; }
                .wm-ob-step-label {
                    display:block; font-size:11px; text-transform:uppercase;
                    letter-spacing:1px; color:#fbbf24; margin-bottom:8px; font-weight:600;
                }
                .wm-ob-step-help {
                    font-size:11px; color:#666; margin:4px 0 8px; line-height:1.4;
                }
                .wm-ob-radio {
                    display:flex; align-items:center; gap:8px; padding:8px 10px;
                    border:1px solid rgba(255,255,255,0.08); border-radius:6px;
                    margin-bottom:6px; cursor:pointer; font-size:13px;
                    transition:background 0.15s, border-color 0.15s;
                }
                .wm-ob-radio:hover { background:rgba(255,255,255,0.04); border-color:rgba(255,255,255,0.18); }
                .wm-ob-radio input { margin:0; cursor:pointer; }
                .wm-ob-input {
                    width:100%; padding:8px 10px; border-radius:6px;
                    border:1px solid rgba(255,255,255,0.12); background:#0f0f13;
                    color:#fff; font-size:13px; outline:none; box-sizing:border-box;
                    font-family:inherit;
                }
                .wm-ob-input:focus { border-color:rgba(6,182,212,0.5); }
                .wm-ob-row { display:flex; gap:6px; align-items:center; }
                .wm-ob-row .wm-ob-input { flex:1; }
                .wm-ob-btn {
                    padding:8px 14px; border-radius:6px;
                    border:1px solid rgba(255,255,255,0.12); background:rgba(255,255,255,0.04);
                    color:#bbb; font-size:12px; cursor:pointer; font-family:inherit;
                    white-space:nowrap;
                }
                .wm-ob-btn:hover { background:rgba(255,255,255,0.09); color:#fff; }
                .wm-ob-btn.primary {
                    background:linear-gradient(135deg,#22c55e,#16a34a); color:#fff;
                    border-color:transparent; font-weight:700;
                }
                .wm-ob-btn.primary:hover { background:linear-gradient(135deg,#16a34a,#15803d); }
                .wm-ob-btn.primary:disabled {
                    background:rgba(255,255,255,0.04); color:#444;
                    cursor:not-allowed; font-weight:400;
                }
                .wm-ob-btn.ghost { background:transparent; border-color:rgba(255,255,255,0.07); color:#666; }
                .wm-ob-kw-list { display:flex; flex-wrap:wrap; gap:4px; margin-top:8px; min-height:24px; }
                .wm-ob-kw-tag {
                    display:inline-flex; align-items:center; gap:4px; padding:3px 8px;
                    border-radius:4px; background:rgba(0,255,255,0.08);
                    border:1px solid rgba(0,255,255,0.25); color:#06b6d4; font-size:11px;
                }
                .wm-ob-kw-tag button {
                    background:none; border:none; color:#666; cursor:pointer;
                    font-size:13px; padding:0; line-height:1;
                }
                .wm-ob-actions {
                    display:flex; justify-content:space-between; align-items:center;
                    gap:10px; margin-top:18px; padding-top:14px;
                    border-top:1px solid rgba(255,255,255,0.06);
                }
            </style>
            <div class="wm-ob-card">
                <h2>🎉 Bienvenue dans WikiMasters Bot</h2>
                <p class="intro">Quelques infos pour configurer ton bot. Tu pourras tout modifier ensuite dans Paramètres ⚙.</p>

                <div class="wm-ob-step">
                    <span class="wm-ob-step-label">1. Type de compte</span>
                    <div class="wm-ob-step-help">Influence le cooldown entre les packs et le nombre max de ventes simultanées (5 gratuit / 10 abonné).</div>
                    <label class="wm-ob-radio"><input type="radio" name="wm-ob-cd" value="180"><span>Compte abonné (3 min entre les packs)</span></label>
                    <label class="wm-ob-radio"><input type="radio" name="wm-ob-cd" value="600" checked><span>Compte gratuit (10 min entre les packs)</span></label>
                </div>

                <div class="wm-ob-step">
                    <span class="wm-ob-step-label">2. Mots-clés du market watcher</span>
                    <div class="wm-ob-step-help">Le bot surveille les enchères dont le titre ou la catégorie contient un de ces mots. Tu peux en ajouter plusieurs séparés par des <b>points-virgules ;</b> (les titres à virgule ne sont pas cassés). Au moins 1 requis.</div>
                    <div class="wm-ob-row">
                        <input id="wm-ob-kw-input" class="wm-ob-input" type="text" placeholder="ex: japon; marvel; star wars, épisode i">
                        <button class="wm-ob-btn" id="wm-ob-kw-add">+ Ajouter</button>
                    </div>
                    <div class="wm-ob-kw-list" id="wm-ob-kw-list"></div>
                </div>

                <div class="wm-ob-step">
                    <span class="wm-ob-step-label">3. Tag pour la mise en vente auto <span style="color:#666;text-transform:none;letter-spacing:0;font-size:10px;">(optionnel)</span></span>
                    <div class="wm-ob-step-help">Le Trash Seller mettra automatiquement en vente toutes les cartes marquées avec ce tag. Choisis un tag existant de ton compte, ou crée-en un nouveau. Tu peux aussi passer cette étape et y revenir plus tard.</div>
                    <select id="wm-ob-tag-select" class="wm-ob-input" style="margin-bottom:6px;">
                        <option value="">⏳ Chargement des tags…</option>
                    </select>
                    <div id="wm-ob-tag-create-row" class="wm-ob-row" style="display:none;">
                        <input id="wm-ob-tag" class="wm-ob-input" type="text" placeholder="Nom du nouveau tag" autocomplete="off" spellcheck="false">
                        <button class="wm-ob-btn" id="wm-ob-tag-create">✨ Créer</button>
                    </div>
                    <div id="wm-ob-tag-status" style="font-size:11px;margin-top:6px;min-height:14px;"></div>
                </div>

                <div class="wm-ob-actions">
                    <button class="wm-ob-btn ghost" id="wm-ob-skip-all" title="Ignorer ce parcours et configurer manuellement plus tard">Ignorer tout</button>
                    <button class="wm-ob-btn primary" id="wm-ob-done" disabled>Terminer</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // ── Logique d'ajout/retrait de mots-clés (locale au modal) ──
        let pendingKeywords = [];
        const kwInput   = document.getElementById('wm-ob-kw-input');
        const kwAddBtn  = document.getElementById('wm-ob-kw-add');
        const kwListEl  = document.getElementById('wm-ob-kw-list');
        const doneBtn   = document.getElementById('wm-ob-done');

        function renderKwList() {
            kwListEl.innerHTML = pendingKeywords.map((kw, i) =>
                `<span class="wm-ob-kw-tag">${kw}<button data-i="${i}" title="Retirer">×</button></span>`
            ).join('') || '<span style="color:#444;font-size:10px;">Aucun mot-clé ajouté</span>';
            kwListEl.querySelectorAll('button[data-i]').forEach(b => {
                b.onclick = () => {
                    pendingKeywords.splice(parseInt(b.dataset.i, 10), 1);
                    renderKwList();
                    refreshDoneState();
                };
            });
        }
        function refreshDoneState() {
            doneBtn.disabled = pendingKeywords.length === 0;
        }
        function addKwFromInput() {
            const raw = (kwInput.value || '').trim();
            if (!raw) return;
            // Plusieurs mots-clés séparés par des points-virgules (préserve les titres à virgule)
            raw.split(';').forEach(part => {
                const kw = part.trim();
                if (kw && !pendingKeywords.some(k => k.toLowerCase() === kw.toLowerCase())) {
                    pendingKeywords.push(kw);
                }
            });
            kwInput.value = '';
            renderKwList();
            refreshDoneState();
        }
        kwAddBtn.onclick = addKwFromInput;
        kwInput.onkeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); addKwFromInput(); }
        };
        renderKwList();

        // ── Sélection / création de tag ──
        // tagChoice : { mode: 'existing'|'new'|'skip', name, id }
        let tagChoice = { mode: 'skip', name: '', id: null };
        const tagSelect    = document.getElementById('wm-ob-tag-select');
        const tagCreateRow = document.getElementById('wm-ob-tag-create-row');
        const tagInput     = document.getElementById('wm-ob-tag');
        const tagCreateBtn = document.getElementById('wm-ob-tag-create');
        const tagStatusEl  = document.getElementById('wm-ob-tag-status');

        // Charge les tags existants du compte et remplit le menu déroulant
        (async () => {
            const tags = await fetchUserTags();
            let opts = '';
            if (tags.length > 0) {
                opts += '<option value="" disabled>— Choisis un tag existant —</option>';
                tags.forEach(t => {
                    // Pré-sélectionne "Trash" s'il existe
                    const sel = t.name.toLowerCase() === 'trash' ? ' selected' : '';
                    opts += `<option value="existing:${t.id}" data-name="${t.name.replace(/"/g, '&quot;')}"${sel}>${t.name}</option>`;
                });
            }
            opts += '<option value="new">➕ Créer un nouveau tag…</option>';
            opts += '<option value="skip">⏭️ Passer cette étape</option>';
            tagSelect.innerHTML = opts;

            // Applique la sélection initiale
            applyTagSelection();
        })();

        function applyTagSelection() {
            const val = tagSelect.value;
            tagStatusEl.innerHTML = '';
            if (val === 'new') {
                tagCreateRow.style.display = 'flex';
                tagChoice = { mode: 'new', name: '', id: null };
            } else if (val === 'skip' || val === '') {
                tagCreateRow.style.display = 'none';
                tagChoice = { mode: 'skip', name: '', id: null };
            } else if (val.startsWith('existing:')) {
                tagCreateRow.style.display = 'none';
                const id = val.slice('existing:'.length);
                const opt = tagSelect.querySelector(`option[value="${CSS.escape(val)}"]`);
                const name = opt?.dataset.name || '';
                tagChoice = { mode: 'existing', name, id };
            }
        }
        tagSelect.onchange = applyTagSelection;

        // ── Bouton "Créer" : crée le tag sur le compte via Supabase (action explicite) ──
        tagCreateBtn.onclick = async () => {
            const name = (tagInput.value || '').trim();
            if (!name) {
                tagStatusEl.innerHTML = '<span style="color:#ef4444;">Saisis d\'abord un nom de tag.</span>';
                return;
            }
            tagCreateBtn.disabled = true;
            tagStatusEl.innerHTML = '<span style="color:#888;">⏳ Création en cours…</span>';
            const result = await createTrashTag(name);
            tagCreateBtn.disabled = false;
            if (result.ok) {
                tagChoice = { mode: 'existing', name, id: result.id || null };
                if (result.id) { TRASH_TAG_ID = result.id; try { localStorage.setItem(TRASH_TAG_CACHE_KEY, result.id); } catch(e) {} }
                tagStatusEl.innerHTML = result.alreadyExists
                    ? `<span style="color:#fbbf24;">⚠️ Le tag "<b>${name}</b>" existait déjà — on l'utilisera.</span>`
                    : `<span style="color:#4ade80;">✅ Tag "<b>${name}</b>" créé et sélectionné !</span>`;
            } else {
                tagStatusEl.innerHTML = `<span style="color:#ef4444;">❌ Échec : ${result.error}. Tu peux créer le tag manuellement sur wiki-masters.</span>`;
            }
        };

        // ── Bouton "Tout ignorer" : ferme sans rien sauvegarder + flag done ──
        document.getElementById('wm-ob-skip-all').onclick = () => {
            localStorage.setItem(ONBOARDING_DONE_KEY, '1');
            modal.remove();
            // Le tour guidé se lancera au 1er clic sur la roue ⚙ (cf. fab.onclick).
        };

        // ── Bouton "Terminer" : sauvegarde + ferme ──
        doneBtn.onclick = () => {
            if (pendingKeywords.length === 0) return; // safety

            // 1) Type de compte
            const checked = modal.querySelector('input[name="wm-ob-cd"]:checked');
            const cd = checked ? parseInt(checked.value, 10) : 600;
            setSetting('packCooldown', cd);
            // Synchronise aussi maxActiveSales (5 gratuit / 10 abonné)
            const maxActive = (cd === 180) ? 10 : 5;
            setSetting('maxActiveSales', maxActive);

            // 2) Mots-clés (merge avec les défauts existants)
            try {
                const existing = JSON.parse(localStorage.getItem(KEYWORDS_STORAGE_KEY) || '[]');
                const merged = [...existing];
                pendingKeywords.forEach(kw => {
                    if (!merged.some(k => k.toLowerCase() === kw.toLowerCase())) merged.push(kw);
                });
                localStorage.setItem(KEYWORDS_STORAGE_KEY, JSON.stringify(merged));
                KEYWORDS_ALERT = merged;
            } catch(e) {}

            // 3) Tag : selon le choix (existant sélectionné, créé, ou passé)
            let tagSummary = '';
            if (tagChoice.mode === 'existing' && tagChoice.name) {
                setSetting('sellTagName', tagChoice.name);
                if (tagChoice.id) { TRASH_TAG_ID = tagChoice.id; try { localStorage.setItem(TRASH_TAG_CACHE_KEY, tagChoice.id); } catch(e) {} }
                tagSummary = ` · tag <b>${tagChoice.name}</b>`;
            }
            // mode 'new' non créé ou 'skip' → on ne touche pas au réglage tag

            // Marque l'onboarding comme fait
            localStorage.setItem(ONBOARDING_DONE_KEY, '1');
            wmLog(`🎉 Configuration initiale terminée : <b>${cd === 180 ? 'abonné' : 'gratuit'}</b> · <b>${pendingKeywords.length}</b> mot-clé(s) ajouté(s)${tagSummary}`);
            modal.remove();

            // Refresh visuel du panneau Mots-clés s'il est ouvert
            if (typeof renderKeywordsPanel === 'function') renderKeywordsPanel();

            // Le tour guidé se lancera au 1er clic sur la roue ⚙ (cf. fab.onclick).
        };
    }

    /* ════════ TOUR GUIDÉ (spotlight step-by-step) ════════ */
    const TOUR_DONE_KEY = 'wm_tour_done';
    function startFeatureTour(force) {
        if (!force && localStorage.getItem(TOUR_DONE_KEY)) return;
        if (document.getElementById('wm-tour')) return;
        const overlay = document.getElementById('wm-overlay');
        if (!overlay) return;
        overlay.classList.add('open'); // le tuto pointe des éléments du dashboard

        const steps = [
            { el: () => document.getElementById('wm-start-btn') && document.getElementById('wm-start-btn').closest('.wm-panel'),
              title: '📦 Pack Opener',
              text: "Ouvre tes packs en boucle, tout seul. Il repère les cartes qui matchent tes mots-clés (alerte + son), tient les stats (raretés, drops, sessions) et respecte le cooldown de ton compte. Le bouton <b>▶ START</b> le lance." },
            { el: () => document.getElementById('wm-market-btn') && document.getElementById('wm-market-btn').closest('.wm-panel'),
              title: '🛒 Market Watcher',
              text: "Surveille le marché en continu. Tu définis des mots-clés : <b>Standards</b> (alerte), <b>⭐ Prioritaires</b> (auto-bid), <b>🕵️ Fourbe</b> (snipe pile en fin d'enchère), <b>🚫 Exclus</b>. Il peut miser et riposter tout seul, avec un plafond par carte. Le <b>⚡ Hunter</b> mise sur tout ce qui passe sous ton seuil ; la case <b>🕵️ mode fourbe</b> juste en dessous change sa façon de miser : plus de mise immédiate, snipe en fin d'enchère plafonné à ce même seuil. Le sélecteur de <b>vue</b> (à côté du tri) bascule entre <b>▤ Détaillé</b> (tous les contrôles), <b>☰ Compact</b> (une ligne par annonce, densité max) et <b>🖼 Cadres</b> (grille avec l'image de la carte et un bouton Miser sous chacune). Le bouton <b>🔭</b> sur chaque annonce (Détaillé/Cadres) compare les vues Wikipédia réelles du mois dernier au cache de WikiMasters — utile pour repérer une carte dont la rareté est sur le point de changer avant que le site ne s'en aperçoive." },
            { el: () => document.getElementById('wm-trash-btn') && document.getElementById('wm-trash-btn').closest('.wm-panel'),
              title: '🏷️ Trash Seller',
              text: "Met en vente automatiquement toutes les cartes que tu as taguées (« Trash » par défaut). Tu choisis le prix (par rareté ou au prix moyen du marché) et quelles cartes prioriser. Le bouton <b>🔄 Refresh ventes</b> renouvelle les annonces." },
            { el: () => document.getElementById('wm-master-btn'),
              title: '🚀 Tout démarrer',
              text: "Lance (ou arrête) les 3 modules d'un seul clic." },
            { el: () => document.getElementById('wm-settings-hdr'),
              title: '⚙️ Paramètres',
              text: "Tout se règle ici : notifications & <b>sauvegardes Discord</b>, sons, prix de vente & stratégie de sélection, <b>horaires programmés</b>, alerte volume de packs… Rien n'est définitif, tu ajustes quand tu veux." },
            { el: () => document.getElementById('wm-stats-hdr'),
              title: '📊 Statistiques',
              text: "Ton bilan complet : ventes (taux, gains par rareté), packs ouverts et taux de drop, cartes invendues récurrentes, et l'historique de tes dernières sessions (packs, ventes, achats, net). Les <b>historiques de ventes et d'achats</b> sont archivés en local : ils vont au-delà de la fenêtre glissante du site, qui oublie les plus anciens." },
            { el: () => document.getElementById('wm-tagger-hdr'),
              title: '🏷️ Étiquetage en masse',
              text: "Applique une étiquette à toutes les cartes qui matchent un mot, en un clic. Tu peux <b>enregistrer des recherches en présets</b> (ex. « japon » → tag « Japon »), les ranger par catégorie, et tout relancer d'un coup — pratique pour retaguer tes nouvelles cartes après chaque ouverture. Le bouton <b>🃏×2 Repérer les doublons</b> liste d'un coup toutes les cartes possédées en 2 exemplaires ou plus, prêtes à taguer « Doublon »." },
        ];

        let idx = 0;

        const root = document.createElement('div');
        root.id = 'wm-tour';
        root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;font-family:Rajdhani,system-ui,sans-serif;';
        const spot = document.createElement('div');
        spot.style.cssText = 'position:absolute;border-radius:10px;box-shadow:0 0 0 9999px rgba(2,2,4,0.80);transition:all .25s ease;pointer-events:none;';
        const tip = document.createElement('div');
        tip.style.cssText = 'position:absolute;width:320px;max-width:calc(100vw - 24px);background:#0f0f13;border:1px solid rgba(192,132,252,0.55);border-radius:10px;padding:14px 16px;box-shadow:0 8px 30px rgba(0,0,0,0.7);color:#ddd;transition:left .25s ease, top .25s ease;';
        root.appendChild(spot);
        root.appendChild(tip);
        document.body.appendChild(root);

        function end() {
            try { localStorage.setItem(TOUR_DONE_KEY, '1'); } catch(e) {}
            window.removeEventListener('resize', onResize);
            root.remove();
        }
        function onResize() { const s = steps[idx], t = s && s.el && s.el(); if (t) positionTo(t, s); }
        window.addEventListener('resize', onResize);

        function positionTo(target, step) {
            const r = target.getBoundingClientRect();
            const vw = window.innerWidth, vh = window.innerHeight;
            const pad = 6;
            spot.style.left = Math.max(0, r.left - pad) + 'px';
            spot.style.top = Math.max(0, r.top - pad) + 'px';
            spot.style.width = (r.width + pad * 2) + 'px';
            spot.style.height = (r.height + pad * 2) + 'px';

            const btn = (id, label, bg, col, br) =>
                `<button id="${id}" style="padding:6px 12px;border-radius:6px;border:1px solid ${br};background:${bg};color:${col};font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;">${label}</button>`;
            tip.innerHTML = `
                <div style="font-size:15px;font-weight:800;color:#fff;margin-bottom:6px;letter-spacing:0.3px;">${step.title}</div>
                <div style="font-size:12px;line-height:1.55;color:#bbb;">${step.text}</div>
                <div style="display:flex;align-items:center;justify-content:space-between;margin-top:14px;gap:10px;">
                    <span style="font-size:10px;color:#666;">${idx + 1} / ${steps.length}</span>
                    <div style="display:flex;gap:6px;">
                        ${btn('wm-tour-skip', 'Passer', 'transparent', '#777', 'rgba(255,255,255,0.12)')}
                        ${idx > 0 ? btn('wm-tour-prev', '‹ Précédent', 'rgba(255,255,255,0.05)', '#bbb', 'rgba(255,255,255,0.12)') : ''}
                        ${btn('wm-tour-next', idx === steps.length - 1 ? 'Terminer ✓' : 'Suivant ›', 'linear-gradient(135deg,#a855f7,#7e22ce)', '#fff', 'transparent')}
                    </div>
                </div>`;

            // Position de la bulle : sous la cible si possible, sinon au-dessus, sinon centrée
            // verticalement (cas des panneaux pleine hauteur). Centrée horizontalement sur la cible.
            const tw = tip.offsetWidth, th = tip.offsetHeight;
            const tall = r.height > vh * 0.55;
            let top;
            if (tall) top = (vh - th) / 2;
            else if (r.bottom + 12 + th <= vh) top = r.bottom + 12;
            else if (r.top - 12 - th >= 0) top = r.top - 12 - th;
            else top = (vh - th) / 2;
            let left = r.left + r.width / 2 - tw / 2;
            left = Math.max(8, Math.min(left, vw - tw - 8));
            top = Math.max(8, Math.min(top, vh - th - 8));
            tip.style.left = left + 'px';
            tip.style.top = top + 'px';

            const nx = document.getElementById('wm-tour-next');
            const pv = document.getElementById('wm-tour-prev');
            const sk = document.getElementById('wm-tour-skip');
            if (nx) nx.onclick = () => { if (idx === steps.length - 1) end(); else { idx++; render(); } };
            if (pv) pv.onclick = () => { if (idx > 0) { idx--; render(); } };
            if (sk) sk.onclick = end;
        }

        function render() {
            const step = steps[idx];
            const target = step && step.el && step.el();
            if (!target) { // élément absent → saute
                if (idx < steps.length - 1) { idx++; render(); return; }
                end(); return;
            }
            try { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch(e) {}
            setTimeout(() => { const t = step.el(); if (t) positionTo(t, step); }, 280);
        }

        render();
    }
    // Rejouer le tour à la demande (bouton Paramètres / console).
    window.wmStartTour = function() { startFeatureTour(true); };

    // Helper console pour forcer l'affichage du modal d'onboarding sans toucher
    // au reste du localStorage. Utile pour démo ou re-tester.
    // Usage : wmShowOnboarding()
    window.wmShowOnboarding = function() {
        localStorage.removeItem(ONBOARDING_DONE_KEY);
        const existing = document.getElementById('wm-onboarding');
        if (existing) existing.remove();
        showOnboardingIfNeeded();
    };

    if (document.readyState === "complete" || document.readyState === "interactive") {
        createUI();
        showOnboardingIfNeeded();
        startSalesMonitor();
    } else {
        window.addEventListener("load", () => {
            createUI();
            showOnboardingIfNeeded();
            startSalesMonitor();
        });
    }

    // Filet de sécurité SPA : si la page client-side route et remplace le DOM,
    // on ré-injecte le FAB. createUI() est idempotente, donc ce check est gratuit
    // si tout va bien.
    setInterval(() => {
        if (document.body && !document.getElementById('wm-fab')) {
            console.log('[WikiMasters] FAB perdu - re-injection (SPA navigation ?)');
            createUI();
        }
    }, 2000);

    // Enregistre la session dans l'historique avant fermeture/rechargement de l'onglet.
    // `beforeunload` n'est PAS fiable (jamais déclenché sur crash, kill du navigateur,
    // extinction du PC, ou onglet « discarded » par Chrome quand il manque de mémoire) —
    // d'où l'ajout de `pagehide` et de `visibilitychange`, seuls signaux garantis sur
    // desktop comme sur mobile. finalizeSession() étant un upsert idempotent, être appelé
    // plusieurs fois ne crée aucun doublon.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            try { finalizeSession(); } catch(e) {}
        }
    });
    window.addEventListener('pagehide', () => {
        try { finalizeSession(); } catch(e) {}
    });
    window.addEventListener('beforeunload', () => {
        try { finalizeSession(); } catch(e) {}
        // Backup best-effort à la fermeture (si le backup périodique est activé)
        try { if (window.wmBackupBeacon) window.wmBackupBeacon(); } catch(e) {}
    });

    /* ════════ DÉTECTION DE COUPURE RÉSEAU ════════ */
    // Si la connexion saute, on met les automatismes en pause propre plutôt que de
    // spammer des requêtes vouées à l'échec. Reprise auto au retour du réseau.
    let networkWasOffline = false;
    function handleNetworkChange() {
        const online = navigator.onLine;
        if (!online && !networkWasOffline) {
            networkWasOffline = true;
            if (window.wmLog) window.wmLog(`📡 <b style="color:#ef4444;">Connexion perdue</b> — les requêtes sont suspendues jusqu'au retour du réseau.`);
        } else if (online && networkWasOffline) {
            networkWasOffline = false;
            if (window.wmLog) window.wmLog(`📡 <b style="color:#4ade80;">Connexion rétablie</b> — reprise normale.`);
        }
    }
    window.addEventListener('online', handleNetworkChange);
    window.addEventListener('offline', handleNetworkChange);
    // Exposé pour que les boucles réseau puissent vérifier l'état
    window.wmIsOnline = () => navigator.onLine;

})();
