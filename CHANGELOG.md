# Changelog — WikiMasters Bot

Manifeste des nouveautés, améliorations et corrections. Du plus récent au plus ancien.
La version distribuée est celle de l'en-tête `@version` de `open_cards.user.js` (le patch est
auto-incrémenté à chaque `push.bat`). Les entrées ci-dessous sont regroupées par date de travail.

Légende : 🆕 nouveauté · ✨ amélioration · 🛠️ correction

---

## 2026-09-26 — v1.4.3

### 🛠️ Correction

- Retour du contrôle du Market Watcher à 10 secondes.
- Le filtre de rareté accepte maintenant plusieurs raretés simultanément et migre l'ancien réglage simple.
- Les enchères terminées restent exclues du scan et de l'affichage.

## 2026-09-26 — v1.4.2

### 🛠️ Correction

- L'historique des ventes est maintenant mis en pause après un `401/403/404` afin d'éviter les centaines de requêtes refusées.
- Le Market Watcher continue de scanner le marché même lorsque cet historique est indisponible.
- Le contrôle reste effectué toutes les 5 secondes, mais le scan de toutes les pages est espacé à 30 secondes ; la première page, triée par fin imminente, reste contrôlée à chaque passage.

## 2026-09-26 — v1.4.1

### 🛠️ Correction

- Le Market Watcher pouvait afficher des enchères déjà terminées lorsque l'API les
  retournait encore dans son cache. Les enchères dont la date de fin est dépassée ou dont
  le statut est terminal sont maintenant exclues avant tout filtrage et retirées du cache UI.
- Le scan du Market Watcher passe de 10 à 5 secondes. Un filtre de rareté persistant permet
  de choisir L, UR, SR, R, PC ou C ; « Toutes les raretés » reste le réglage par défaut.
- Le mode Fourbe arme désormais une enchère dès sa détection dans la fenêtre des 5 dernières
  minutes ; la mise reste déclenchée uniquement à la seconde configurée de fin.
- Le marqueur de reprise du Market Watcher n'était plus conservé au démarrage : le
  nettoyage de l'ancien watcher supprimait immédiatement le marqueur qui venait d'être écrit.
- Les requêtes avec timeout respectent maintenant aussi le signal d'annulation fourni par
  leur appelant, afin qu'un module arrêté ne reste pas bloqué jusqu'au timeout réseau.
- La détection anticipée accepte maintenant les dates de fin au format Unix secondes,
  Unix millisecondes ou ISO.

## 2026-08-20 — v1.4.x (suite 2)

### 🛠️ Correction

- **"method is not defined" — Market Watcher et Trash Seller cassés au démarrage**, régression
  introduite par le correctif précédent (capture de l'`auction_id`). `url`/`method` sont déclarés
  en `const` **à l'intérieur** du `try{}` de `installPackInterceptor`, donc portée bloc — le
  calcul de `isMarketplaceCreate` avait été placé juste **après** le `catch(e){}`, hors de cette
  portée, provoquant un `ReferenceError` à chaque appel `fetch()` (donc partout dans le bot).
  Déplacé : `isMarketplaceCreate` est maintenant déclarée avant le `try` (comme
  `isManualPackOpen` et les autres) et assignée à l'intérieur, sur le même modèle déjà en place.

## 2026-08-20 — v1.4.x (suite)

### 🛠️ Correction

- **Invendus plus jamais re-taggués Trash depuis le passage à la mise en vente par clic simulé
  (hier).** `checkSellHistoryResults()` ne considère une entrée `sellHistory` que si
  `s.auctionId` est renseigné (`pending.filter(s => s.status === 'pending' && s.auctionId)`) —
  sans ça, l'invendu n'est jamais détecté, donc jamais re-taggué. L'interception réseau censée
  capter l'`auction_id` de la réponse du site (`installPackInterceptor`) comparait `args[0]` en
  égalité stricte contre l'URL **absolue**, alors que le site appelle très probablement l'API en
  URL **relative** (`/api/marketplace`) — comme tous les autres checks du même intercepteur,
  qui utilisent `.includes()`/une regex sur `url` (déjà normalisée juste au-dessus), pas
  `args[0]` brut. Résultat : la condition ne matchait jamais, `auctionId` restait toujours
  `null` pour toute vente créée via le nouveau flux DOM.
  - Remplacé par `method === 'POST' && /\/api\/marketplace(\?|\$)/.test(url)`, sur les mêmes
    variables déjà extraites que les autres interceptions (gère URL relative et absolue).
  - **Limite connue** : les entrées déjà créées avec `auctionId: null` depuis hier restent
    orphelines (le filtre les ignorera toujours, l'id réel n'est plus récupérable après coup) —
    seules les ventes créées *après* ce correctif seront correctement suivies et re-taguées si
    invendues.

## 2026-08-20 — v1.4.x

### 🛠️ Correction

- **Comptage "possédé ×N" gonflé sur le Market Watcher** (ex. « ×25 » affiché sur une carte
  dont `wmDebugCardId` confirmait 1 seul exemplaire réel en base). Régression du correctif
  d'hier sur le rafraîchissement de collection : celui-ci ne vide plus le cache avant chaque
  appel automatique (bien), mais rien n'empêchait deux `fetchCollection()` de tourner **en même
  temps** — le scan complet initial du Market Watcher (plusieurs minutes sur un gros compte) et
  le rafraîchissement automatique toutes les 3 min pouvaient se chevaucher. Deux scans
  concurrents modifiant `collectionMap` en parallèle se marchent dessus : chacun lit le compte
  AVANT l'écriture de l'autre, additionnant plusieurs fois le même exemplaire.
  - Ajout d'un verrou (`_fetchCollectionInFlight`) : un second appel pendant qu'un scan tourne
    déjà ne fait plus rien, au lieu de se lancer en parallèle.
  - **Le cache déjà corrompu par le bug ne se corrige pas tout seul** au rechargement (il est
    justement rechargé tel quel depuis le localStorage). Un clic sur **♻️ Collection** force un
    scan complet propre et corrige les comptages affichés.

## 2026-08-19 — v1.4.x (suite)

### 🛠️ Correction majeure

- **Trash Seller — mise en vente définitivement cassée côté API, contournée via l'interface.**
  Après les deux correctifs de charge (pool incrémental + rafraîchissement collection non
  destructif, cf. entrée précédente), le POST `/api/marketplace` continuait d'échouer à 100%
  pour le bot (« Vous ne possédez pas cette carte »). Investigation exhaustive avant de trouver
  une solution : comparaison requête par requête bot vs manuel via plusieurs `.har` complets
  (payload, en-têtes, cookies identiques), vérification directe en base du card_id ET de la
  possession (correcte dans tous les cas testés), test après déconnexion/reconnexion (aucun
  changement), test à charge serveur nulle — tout arrêté, un seul appel isolé (échec identique),
  test avec le **vrai fetch natif du navigateur** (en exposant `window.wmOriginalFetch`, pour
  éliminer même notre propre interception de `window.fetch`) — échec identique. Dans tous les
  cas, un clic RÉEL sur le vrai bouton du site réussissait avec la même carte.
  - **Test décisif : un clic SIMULÉ (`element.click()`, donc `isTrusted:false` — un clic
    JavaScript n'est, par construction du navigateur, jamais un « vrai » geste utilisateur) sur
    le vrai bouton "Lancer l'enchère" du site a réussi.** Ça élimine à la fois l'hypothèse d'une
    détection anti-bot basée sur la confiance du geste ET confirme qu'il manque quelque chose
    dans notre reconstruction du POST que seul le code du site sait fournir. Cause exacte
    toujours inconnue côté serveur — mais la voie de contournement est confirmée fiable.
  - **Nouveau mécanisme (`sellCardViaUI`)** : au lieu de reconstruire la requête API, le bot
    simule la séquence réelle du site — recherche de la carte par titre, ouverture de sa fiche,
    clic "Mettre aux enchères", saisie du prix/de la durée configurés (mêmes valeurs qu'avant,
    juste posées via l'UI au lieu du payload), clic "Lancer l'enchère". Remplace le POST direct
    dans `sellBatch()` ; `resolveSellBasePrice`/`fetchLowestActiveListing` (lectures, jamais en
    échec) sont inchangés.
  - **Contrainte assumée : nécessite de rester sur `/collection`** — le bot ne peut pas cliquer
    une carte qui n'est pas affichée à l'écran. Si l'onglet est ailleurs, le lot s'interrompt
    avec un message explicite au lieu d'échouer en boucle silencieuse.
  - Après la création d'une enchère, le site navigue vers `/marketplace/{auction_id}` — un
    état transitoire normal (provoqué par le bot lui-même), pas une vraie "mauvaise page".
    `ensureOnCollectionPage()` retente le retour (bouton "Retour au marché") avant de conclure
    à un blocage réel, réutilisée à la fois en fin de vente et en tout début de la carte
    suivante — sinon un retour un peu lent aurait mis le lot en pause pour rien.
  - **Sondage automatique du retour de l'API directe.** Le contournement DOM est lent et
    dépend de la barre de recherche du site (peu fiable, cf. le sondage à durée variable
    ajouté à `sellCardViaUI` pour compenser). Plutôt que d'y rester bloqué indéfiniment,
    `sellBatch()` retente l'ancien POST direct avant chaque carte tant qu'il n'a jamais échoué,
    puis au maximum une fois toutes les 15 min une fois confirmé cassé. Dès qu'il refonctionne
    (site corrigé côté serveur), le bot repasse automatiquement au mode rapide — plus besoin de
    rester sur `/collection` ni d'intervention manuelle.
  - **Perte assumée** : la distinction fine « échange en attente » vs « plafond atteint » vs
    échec générique (basée avant sur le message JSON du POST) n'est plus disponible dans ce
    flux — le site ne renvoie plus d'erreur exploitable ici. Ces cas retombent en échec
    générique ; le comptage de slots en amont (`fetchSellingState`) reste la protection
    principale contre un dépassement du plafond.
  - `installPackInterceptor` capte désormais aussi l'`auction_id` de la réponse déclenchée par
    le clic simulé, pour que `sellHistory` garde le lien vers l'enchère malgré le changement de
    mécanisme.

## 2026-08-19 — v1.4.x

### 🛠️ Corrections

- **Trash Seller — mises en vente rejetées en masse (« Vous ne possédez pas cette carte »).**
  Investigation longue (comparaison exhaustive requêtes bot vs manuelles : payload, en-têtes,
  cookies, referer, durée, prix, précurseurs — tout identique) avant de trouver la vraie cause,
  révélée par un `.har` complet : **6229 requêtes vers `/api/my-collection` en 4 minutes**, avec
  des numéros de page dépassant 1900 (à 50 cartes/page, ça balaie la collection entière — ~98 000
  cartes sur ce compte). `scanPool()` relançait un **scan complet** du pool Trash via
  `fetchTrashCards()` après **chaque lot vendu**, en boucle continue tant que le Trash Seller
  tourne. Sur un gros compte, ce martèlement semble avoir saturé le serveur au point de faire
  échouer la vérification de possession du POST de mise en vente (alors que le DELETE
  d'annulation, lui, continuait à fonctionner — cohérent avec une vérification différente et
  moins coûteuse côté serveur). Confirmé comme corrélé avec l'anomalie « total API indisponible »
  observée plus tôt sur ce même compte.
  - **Le scan complet ne se relance plus après chaque vente.** Nouveau pool Trash en mémoire
    (`getTrashPool()`), scanné intégralement une fois puis mis à jour **en direct** par ce que le
    bot fait lui-même : une carte vendue en sort (`removeFromTrashPoolCache`), une carte
    fraîchement auto-taguée après un pack ou re-taguée après une annulation y entre
    (`pushToTrashPoolCache`) — sans le moindre appel réseau supplémentaire.
  - **Scan complet de réconciliation toutes les 12 min** (au lieu d'après chaque lot) pour
    rattraper ce qui échappe au suivi incrémental : tag/détag manuel depuis le site, cartes
    reçues par achat ou échange. Volontairement pas suivi en direct — le bot pose déjà l'immense
    majorité des tags Trash lui-même, l'intérêt d'intercepter le reste était jugé trop faible
    pour la complexité ajoutée.
  - Réduit le volume de requêtes vers `/api/my-collection` de plusieurs milliers par cycle à
    un seul scan complet toutes les 12 minutes.

## 2026-08-18 — v1.4.x

### 🆕 Nouveautés

- **🎯 Chasseur ciblé — trois affinages, tous optionnels et rétrocompatibles.**
  - **Possession sensible à la rareté.** Le garde-fou « déjà possédée » comptait toute
    possession sans regarder la rareté — or une carte n'a qu'un seul `card_id` quelle que soit
    sa rareté (c'est un champ modifiable sur la même ligne du catalogue, pas une carte
    séparée). Concrètement : posséder l'UR d'une carte bloquait toute mise sur sa version
    Légendaire, même volontaire. Réutilise `isOwnedDuplicate` (déjà utilisée pour le badge
    « possédé » du Market Watcher) : ne bloque plus que si la rareté **possédée** correspond à
    la rareté **de l'annonce**. Vérifié sur le scénario exact qui a révélé le problème : UR
    possédée + annonce en L → mise autorisée ; L possédée + annonce en L → bloquée (vrai
    doublon).
  - **Pause/reprise d'une chasse en un clic** (⏸️/▶️ sur chaque chasse), sans la supprimer ni
    devoir la resaisir. Une chasse en pause est grisée dans la liste, ignorée par le matching
    (`matchedHunterEntry`) — et de ce fait, **redevient éligible au Hunter générique** le temps
    de la pause (comportement volontaire : une pause explicite libère la carte plutôt que de
    la geler indéfiniment).
  - **Auto-pause après obtention** (case à cocher par chasse, décochée par défaut). Dès que la
    chasse remporte une enchère, elle se met en pause toute seule — pratique pour qui ne veut
    qu'un exemplaire, sans gêner qui collectionne plusieurs fois la même carte (laisser
    décoché = comportement d'avant, inchangé). Traçage par `auctionId → texte de la chasse`
    (persisté, résiste à un F5 entre l'armement et la fin d'enchère), nettoyé automatiquement
    pour les enchères conclues sans victoire.
  - Pièges évités, vérifiés par test : la reconstruction de l'entrée au chargement écarte tout
    champ non explicitement listé — `enabled` et `autoDisable` ont dû y être ajoutés pour ne
    pas être effacés en silence à chaque F5 (même trap que `rarity` la dernière fois).
    Remettre à jour une chasse existante (même mot-clé resaisi) ne réinitialise **jamais**
    `enabled` — sinon resoumettre le formulaire réactiverait une chasse mise en pause exprès.

## 2026-08-12 — v1.4.x

### ✨ Améliorations

- **Scan du Market Watcher optimisé** pour les gros catalogues (~6000 annonces / 110+ pages
  observées). Le goulot n'était pas la pagination réseau, déjà parallélisée — c'était le
  classement par mots-clés côté client : `hasKeyword`/`hasPriorityKeyword`/`hasFourbeKeyword`/
  `hasHunterKeyword` recalculaient `.toLowerCase()` sur le titre/catégorie de chaque annonce
  ET sur chaque mot-clé à **chaque comparaison individuelle**, jamais mis en cache. Avec
  ~260 mots-clés cumulés × ~6000 annonces, plusieurs millions d'appels `.toLowerCase()`
  redondants à chaque scan (~toutes les 10 s).
  - Les mots-clés sont désormais mis en minuscules **une fois par scan** (~260 appels, coût
    négligible — recalculé à chaque scan plutôt que mis en cache *entre* deux scans, pour
    ne jamais risquer un cache désynchronisé après un ajout/retrait de mot-clé).
  - Le titre/catégorie de chaque annonce est mis en minuscules **une fois par annonce**, puis
    réutilisé pour les 5 vérifications (standard, prioritaire, fourbe, exclus, chasseur) au
    lieu d'être recalculé à chaque liste testée.
  - `newHits` (détection des nouvelles annonces) réutilise la classification déjà calculée
    juste au-dessus au lieu de re-tester les mots-clés une seconde fois sur les mêmes
    annonces.
  - Comportement de matching **strictement identique** (sous-chaîne, insensible à la casse,
    titre + catégorie) — vérifié par rejeu de l'ancienne et de la nouvelle logique sur un jeu
    de données synthétique couvrant les 5 listes, la casse, les correspondances par catégorie
    et le cas d'une enchère déjà suivie (`myBidsSet`) qui matche *aussi* un mot-clé (piège
    trouvé au test : le court-circuit initial aurait fait manquer sa notification « nouveau
    hit » sans ce garde-fou).
  - Gain mesuré sur un jeu synthétique réaliste (260 mots-clés, 6000 annonces) : **~57 % de
    temps de classement en moins**, sur une seule des 5 listes testées — le gain réel en
    production, cumulé sur les 5 listes, est probablement plus élevé.
  - Première étape d'une liste d'optimisations proposées ; la pagination réseau elle-même
    (taille de page, concurrence) n'a pas été touchée pour l'instant.

### 🆕 Nouveautés

- **🎯 Chasseur ciblé — rareté requise (optionnelle).** Un menu déroulant, à côté du choix
  fourbe/auto-bid, sauvegardé par chasse comme le reste (mot-clé, plafond, mode). Quand elle
  est définie, **aucune mise n'a lieu tant que la carte n'affiche pas exactement cette
  rareté** — pensé pour une carte dont on sait qu'elle va bientôt changer de rareté (cf.
  `wmCheckRarityDrift` un peu plus haut) et qu'on ne veut pas payer au prix de la mauvaise.
  « Toutes raretés » (par défaut) = aucun filtre, comportement strictement identique à avant.
  - Filtre appliqué au **point de décision de la mise**, pas au matching par mot-clé : une
    carte bloquée par la rareté reste marquée comme prise en charge par le Chasseur ciblé
    (elle n'est **jamais** reprise par le Hunter générique ni par les mots-clés
    prioritaire/fourbe entre-temps) — sinon un autre mécanisme aurait pu miser à sa place
    pendant que le Chasseur attend la bonne rareté, ce qui aurait défait tout l'intérêt de
    la fonctionnalité.
  - Compatibilité ascendante vérifiée : les chasses déjà enregistrées (sans ce champ) restent
    sans filtre après rechargement — la reconstruction de l'entrée au chargement écartait
    tout champ non explicitement listé, `rarity` a donc dû y être ajoutée explicitement pour
    ne pas être effacée en silence à chaque F5.
  - Code de rareté invalide ou mal saisi → traité comme « pas de filtre » plutôt que de
    bloquer silencieusement toutes les mises.

### 🛠️ Corrections

- **Statut du Trash Seller figé sur d'anciennes valeurs** (ex. « 10/10 ventes actives —
  attente… » alors que le site n'en montre que 4, et que l'en-tête « VENTES ACTIVES » du
  panneau, lui, affichait bien 4/10). Cause : **aucun `fetch()` de ce fichier n'avait de
  timeout** — 52 appels, zéro `AbortController`. Si une requête reste bloquée (connexion qui
  stagne, serveur qui ne répond pas), le `await` qui l'attend gèle silencieusement, sans
  erreur ni retry. La boucle d'attente du Trash Seller (`checkSellHistoryResults` +
  `fetchSellingState`, toutes les 15 s) se fige alors sur son dernier statut connu, tandis que
  le reste du bot — sur ses propres minuteries indépendantes (le rafraîchissement de l'en-tête
  toutes les 30 s notamment) — continue de tourner normalement. D'où l'illusion d'une
  désynchronisation de données, alors que c'est une requête qui n'est simplement jamais
  revenue.
  - Ajout d'un timeout de 15 s (`fetchWithTimeout`, `AbortController`) sur les deux fonctions
    bas niveau qui sous-tendent toute la logique de vente/achat/rareté construite ces derniers
    jours : `fetchMine()` et `supabaseSelect()`. Au-delà du délai, la requête est abandonnée et
    traitée comme n'importe quel autre échec réseau (retour `null`, même contrat qu'avant) —
    la boucle peut alors retenter au lieu de rester figée indéfiniment.
  - Portée volontairement limitée à ces deux fonctions partagées plutôt qu'aux 52 `fetch()` du
    fichier : ce sont elles qui sont dans le chemin exact du symptôme signalé. Le reste du
    fichier partage la même lacune (aucun timeout nulle part) — à corriger plus largement si
    d'autres gels du même genre apparaissent ailleurs.
  - Vérifié fonctionnellement : une requête simulée qui ne répond jamais est bien abandonnée
    au bout du délai configuré (~200 ms sur un test raccourci) plutôt que de bloquer
    indéfiniment.

- **Chasseur ciblé (et potentiellement d'autres sauvegardes) échouant en silence — quota
  localStorage dépassé.** Signalé via une chasse qui disparaissait après un F5 alors qu'elle
  s'affichait bien avant le rechargement : `saveHunterKeywords()` échouait avec
  `QuotaExceededError`, avalé en silence par son `try{}catch(e){}` — comme la quasi-totalité des
  ~30 fonctions `saveXxx()` du fichier. Un nouvel outil de diagnostic (`window.wmStorageUsage()`
  dans la console : inventaire des clés par taille + test d'écriture réel de 10 Ko) a confirmé le
  quota atteint : **5120 Ko sur 74 clés**, avec deux clés à elles seules représentant plus de
  60 % du total :
  - **`wm_pack_stats` (2164,9 Ko, la plus grosse clé du compte).** Contenait `cardStats`, un
    compteur par titre de carte distinct jamais ouvert en pack — incrémenté à chaque carte
    analysée, jamais purgé, et surtout **jamais lu ni affiché nulle part** dans tout le bot
    (vérifié : les seules occurrences sont sa déclaration, sa sauvegarde/rechargement/reset, et
    l'incrément lui-même). Pur poids mort. `saveStats()` ne le persiste plus ; le suivi en
    mémoire est conservé par prudence mais n'est plus jamais écrit sur disque.
  - **`wm_sales_cache` (1186,6 Ko).** Cache de l'historique des ventes par carte, avec un TTL de
    12 h déjà en place — mais `getCachedSales()` ne faisait que **traiter** une entrée périmée
    comme invalide à la lecture, sans jamais la supprimer du stockage : le cache grossissait
    indéfiniment, une entrée par carte distincte croisée en scan, quel que soit son âge.
    `saveSalesCache()` purge désormais les entrées dépassant le TTL avant chaque écriture — sans
    aucun changement de comportement, puisqu'une entrée périmée était de toute façon déjà
    invalide à la lecture (elle sera simplement re-fetchée, comme un cache-miss normal).
  - Purge appliquée immédiatement au chargement du script (`saveStats()`/`saveSalesCache()`
    appelées une fois dès l'init), pas seulement à la prochaine sauvegarde naturelle — sinon les
    clés déjà gonflées seraient restées à leur taille tant qu'un pack/une vente n'a pas eu
    l'occasion de retrigger un save, ce qui n'aurait pas réglé un quota déjà dépassé au
    chargement de la page.
  - `wm_retag_counts` (1004,5 Ko) et `wm_listed_counts` (481,7 Ko) sont, eux, de vraies
    statistiques cumulatives affichées/utilisées dans le bot (compteurs de retag par carte,
    liste triée) — volontairement non touchés pour ne pas perdre de données auxquelles
    l'utilisateur pourrait tenir. À revisiter si le quota redevient un problème.
  - Vérifié en conditions réelles avec l'utilisateur : total localStorage retombé de 5120 Ko à
    ~1780 Ko après nettoyage, et la sauvegarde du Chasseur ciblé — qui échouait silencieusement
    depuis un certain temps, pas seulement la nouvelle entrée signalée au départ — refonctionne.

- **Rareté affichée inversée pour les ventes actives/historique, sur les cartes ayant dérivé
  après leur mise en vente.** `adaptAuctionRow` (reconstruction des ventes après la refonte de
  `/mine`) préférait la rareté **live** du catalogue (`cards.rarity`) à la rareté **figée** au
  moment de la mise en vente (`snapshot_rarity`) — l'inverse de la convention suivie partout
  ailleurs dans ce fichier. Une carte dont la rareté catalogue a dérivé *après* avoir été
  listée (le phénomène étudié plus haut avec `wmCheckRarityDrift` : WikiMasters recalcule les
  vues avec du retard) s'affichait donc avec la mauvaise rareté dans le bot, alors que le site
  affiche toujours la rareté figée de l'annonce. Corrigé : `snapshot_rarity` prioritaire,
  repli sur `cards.rarity` uniquement si le snapshot manque. Affecte trois panneaux à la fois
  (même fonction partagée) : Ventes actives, Historique des ventes, Historique des achats.

- **Audit post-changement d'API** (suite à la refonte de `/mine` du 2026-08-10) : deux fonctions
  lisaient encore les champs `selling`/`history`/`won` disparus, non couvertes par le
  correctif précédent.
  - **`reconcilePendingSales`** (démarrage + toutes les 5 min) — la plus grave : faute de liste
    `selling`, elle traitait **toute vente encore active** comme terminée dès son premier
    passage, avec un risque réel de la marquer `sold` à tort et de bloquer son comptage pour
    de bon (verrou anti-double-comptage posé une fois pour toutes). Corrigée : lecture par ID
    exact sur `auctions`, plus précise que l'ancienne liste (qui pouvait être tronquée pour les
    vieilles enchères).
  - **`checkSellHistoryResults`** (toutes les 15 s) et le **moniteur de ventes récentes**
    (notifications Discord) — devenus des no-op silencieux. Même correctif : lecture directe
    sur `auctions`.
  - Vérification complète : aucune référence résiduelle aux fonctions supprimées le 2026-08-10,
    chargement du script sans erreur de référence.

### 🆕 Nouveautés

- **🔭 `wmCheckRarityDrift()`** (console) — validation d'une hypothèse : WikiMasters recalcule
  `pageviews`/`rarity` avec un gros retard, donc une carte peut être en train de changer de
  rareté (ex. UR → Légendaire) sans que le site l'ait encore répercuté. L'outil compare, pour
  un ou plusieurs titres exacts, la rareté **en cache** sur WikiMasters à celle qu'impliquent
  les **vues Wikipédia réelles du dernier mois complet** (API publique Wikimedia, aucune clé
  requise), selon les seuils fournis : C <50 · PC 50+ · R 250+ · SR 1000+ · UR 5000+ · L 20000+
  vues/mois. `wmCheckRarityDrift('Anatolie')` ou `wmCheckRarityDrift(['Titre 1', 'Titre 2'])`.
  - Signale un écart avec la direction probable (⬆️ va monter / ⬇️ va descendre) et l'âge du
    cache WikiMasters (`pageviews_refreshed_at`) — de quoi juger concrètement le retard du site.
  - **Prototype de validation seulement**, pas branché sur le Hunter ni sur aucune décision
    d'enchère : le but est de vérifier que la corrélation vues→rareté tient sur des cartes
    connues avant d'envisager quoi que ce soit d'automatisé.
  - Limite assumée : ne couvre qu'un article à la fois, sur demande explicite — pas un scan de
    toute la collection (trop de requêtes Wikimedia d'un coup, et intérêt non démontré tant que
    l'hypothèse elle-même n'est pas validée).
  - **Devenu aussi un bouton 🔭 sur chaque annonce** (vues Détaillé et Cadres du Market
    Watcher), juste à côté du badge de valorisation (📉/📈). Clic → vérifie cette carte
    précise, affiche un badge inline (✅ stable / ⬆️ va probablement monter / ⬇️ va
    probablement descendre / ⚠️ erreur) avec le détail complet en infobulle. Toujours sur
    demande explicite, jamais automatique : contrairement au badge de valorisation (préchargé
    pour toutes les annonces visibles), ce contrôle coûte deux requêtes réseau par carte —
    inutile de les déclencher pour des dizaines d'annonces qui n'intéressent pas forcément
    l'utilisateur. Cache de 5 min pour éviter de re-fetcher au moindre re-tri ou double-clic.
    Absent de la vue Compact, cohérent avec le badge de valorisation qui n'y figure déjà pas
    (densité maximale assumée).
  - Logique de comparaison **extraite en une seule fonction partagée**
    (`computeCardRarityDrift`) entre l'outil console et le bouton, pour ne pas la dupliquer à
    deux endroits — une double implémentation aurait pu reproduire le bug de plage de dates
    découvert plus haut, corrigé un endroit à la fois.
  - **Correctif : le bouton 🔭 disparaissait en vue Cadres quand le badge de valorisation était
    long** (« 📉 sous-coté · méd. 1000 », « 📈 surcoté · méd. 5000 »). Le badge, en
    `white-space:nowrap` sans `min-width:0`, gardait sa largeur intrinsèque dans la ligne flex
    et repoussait le bouton hors de la zone visible — clippé par le `overflow:hidden` du
    conteneur au lieu de s'afficher à côté. Le badge tronque désormais lui-même (avec `…`,
    détail complet en infobulle) plutôt que le bouton. La vue Détaillée n'était pas concernée
    (elle passe à la ligne au lieu de clipper).
  - **Correctif du jour même : le badge disparaissait quelques secondes après le clic.** Il
    n'était écrit que dans le DOM, jamais dans les données qui reconstruisent la ligne. Le
    Market Watcher redessine toutes les lignes très souvent (scan ~10 s, hot lane encore plus
    vite sur une enchère suivie) — chaque redessin régénère un badge vide par défaut. Le
    rendu de chaque ligne lit désormais le cache de 5 min pour ré-injecter le badge à chaque
    passage, tant que l'entrée n'a pas expiré.
  - **Correctif du jour même** : la requête à l'API Wikimedia envoyait la même date en début
    et fin de plage (« le mois de juillet » = `start=end=juillet`), rejetée par l'API avec
    `HTTP 400 · "no full months between dates"`. Corrigé en demandant une vraie plage (1er du
    mois précédent → 1er du mois en cours) et en ne gardant que le premier élément renvoyé (le
    mois complet, pas le mois en cours partiel). L'outil n'avalait en plus jamais la cause
    réelle d'un échec (toujours le même message générique « API injoignable ») — il expose
    désormais le statut HTTP exact et le corps de la réponse.

- **🃏×2 Étiquetage en masse — « Repérer les doublons ».** Un bouton dans le module
  Étiquetage en masse qui liste en un clic **toutes les cartes possédées en 2 exemplaires ou
  plus** (même article + même rareté, donc même `card_id`), pour les taguer en lot avec une
  étiquette « Doublon » (pré-remplie, modifiable) — pratique pour repérer d'un coup ce qui
  peut être trié, vendu ou échangé.
  - Réutilise **entièrement** le mécanisme du scan par mot-clé existant : même liste de
    relecture décochable avant validation, même bouton **🏷️ Appliquer**, même find-or-create
    de l'étiquette, même limite de concurrence et rapport d'échecs détaillé. Aucune logique
    dupliquée — seul le calcul « qu'est-ce qui matche » change (comptage par `card_id` au lieu
    d'un mot-clé).
  - Compte **tous** les exemplaires d'un modèle en double (pas seulement les « extra ») :
    si tu en as 3, les 3 sont proposées à l'étiquetage, pas 2. Rien n'est jamais mis en vente
    ou déplacé — uniquement une étiquette informative, à toi de décider quoi en faire ensuite.
  - Respecte le réglage « forcer un nouveau scan » (fraîcheur des données) ; les champs du
    scan par mot-clé (recherche, « sans étiquette ») sont vidés au clic pour ne pas laisser
    croire qu'ils ont influencé le résultat.

- **🧪 `wmTestInstanceTargeting()`** (console) — diagnostic pour un bug distinct, rapporté
  utilisateur : sur une carte en double (même article + même rareté), le site vend toujours
  l'exemplaire le **plus ancien** lors d'une mise en vente, même si c'est le **plus récent**
  qui porte le tag Trash. Cause : `POST /api/marketplace` ne reçoit que `card_id` (le modèle
  de carte) — jamais l'exemplaire précis (`item.id`, pourtant connu du pool Trash) — donc le
  site choisit lui-même quel exemplaire physique consommer, sans se soucier des tags.
  - Le test ajoute `user_card_id` (nom déjà utilisé partout ailleurs dans ce schéma pour
    désigner un exemplaire précis) au corps de la requête de mise en vente, puis vérifie
    **directement en base** lequel des deux exemplaires a réellement disparu.
  - Isolé à dessein du Trash Seller réel — un seul essai contrôlé. Coût réel : **une enchère
    créée**, annulée automatiquement si le mauvais exemplaire a été consommé.
  - Trouve son propre cas de test (exemplaire taggué Trash + doublon plus ancien non-taggué du
    même `card_id`) ; rapporte clairement si aucun cas n'est trouvé (rien tenté).

### 🆕 Nouveautés

- **🕵️ Hunter en mode fourbe** — une case à cocher sous le bouton `⚡ Hunter`, dans le Market
  Watcher. Le Hunter normal mise le minimum dès qu'une carte passe sous ton seuil : ça prévient
  l'adversaire et lance la guerre d'enchères. Case cochée, il **ne mise plus tout de suite** — il
  arme le **mode Fourbe** sur les cartes qui matchent, avec **le seuil du Hunter comme plafond**
  (Hunter ≤ 30 💰 → snipe plafonné à 30 💰). Cocher arme tout le lot, décocher désarme tout.
  - Ce n'est **pas un second mode concurrent** mais une option *du* Hunter : c'est toujours lui
    qui décide s'il chasse et sur quoi (le seuil), la case ne change que **comment** il mise.
    D'où la case à cocher subordonnée plutôt qu'un bouton jumeau, qui laissait croire à deux
    interrupteurs indépendants. Le libellé du bouton devient `⚡ Hunter ≤30💰 ON · 🕵️ fourbe`
    quand les deux sont actifs — sans ça, `Hunter ≤30💰 ON` promettait une mise immédiate qui
    n'avait plus lieu.
  - En mode **dynamique**, le plafond est celui calculé pour chaque carte (% de sa médiane marché),
    pas une valeur unique.
  - **Rattrapage à l'activation** : les enchères déjà à l'écran qui correspondent sont armées
    immédiatement, pas seulement les prochaines annonces.
  - **Désarmement propre et réversible** : le bot mémorise le plafond qui existait *avant* chaque
    armement et le restaure à l'extinction. Il ne touche jamais aux enchères que tu as armées à la
    main, à celles des mots-clés 🕵️ Fourbe, du ⭐ Prioritaire ou du 🎯 Chasseur ciblé — chacun garde
    son propre mode et son propre plafond.
  - Reprendre la main sur une carte (bouton **🕵️ Fourbe OFF** ou passage en **🤖 Auto-bid**) fait
    lâcher prise au mode fourbe sur celle-ci, plafond d'origine restauré.
  - **Éteindre le Hunter ne désarme pas** ce qui est déjà armé : les snipes engagés partiront
    quand même (même logique que l'auto-bid). Le bot le dit dans le log et rappelle que c'est la
    case qu'il faut décocher pour tout annuler.
  - L'état de la case est **persisté** (contrairement au bouton Hunter) : après un F5, elle reflète
    bien les enchères encore armées au lieu d'afficher « décoché » à tort.
  - Comme tout Fourbe, le snipe n'est pas soumis au plancher de solde du Hunter
    (`solde minimum`) : le solde est vérifié au moment du tir, pas à l'armement.

- **🖼 Market Watcher — vue « Cadres ».** Troisième vue, en plus de *Détaillé* et *Compact* :
  une grille de tuiles avec **l'image de la carte**, son titre, sa description Wikipédia, le
  cadre **teinté selon la rareté**, et un **bouton « 🔨 Miser » en pleine largeur sous chaque
  carte** (avec la même sécurité double-clic quand le prix a bondi de +10 %).
  - **Contrôles avancés sous chaque carte** : un bouton unique à 3 états
    **⚪ Manuel → 🤖 Auto-bid → 🕵️ Fourbe** (clic pour passer au suivant) et son champ de
    **plafond**. Les deux automatismes étant mutuellement exclusifs, deux boutons séparés
    offraient quatre combinaisons dont une impossible ; un seul contrôle dit l'état courant et
    tient dans la moitié de la place. Aucun passage ne déclenche de mise : l'auto-bid ne riposte
    qu'en cas de surenchère et le fourbe ne tire qu'en fin d'enchère.
  - **Pastille « ✔ Possédé » sur l'image** pour les cartes déjà en collection — utile quand le
    filtre *masquer les cartes déjà possédées* est décoché : on repère les doublons d'un coup
    d'œil sans lire les tuiles une par une. En **ambre** (« Possédé en SR ») quand la carte est
    possédée dans une *autre* rareté que l'annonce : ce ne serait pas un doublon pour celle-ci.
    Rien n'est affiché si la carte n'est pas possédée.
  - **Icônes compactées** : l'overlay sur l'image ne porte plus que l'*état* (👑 / 😤 / 🆕) —
    le mode est déjà lisible en toutes lettres sur son bouton.
  - **Cartes sans image** : placeholder 🃏 teinté rareté, qui prend aussi le relais si l'image
    existe mais ne charge pas. Le champ `hide_image` de l'API est délibérément **ignoré** : dès
    qu'une image existe elle est affichée, même si le site la masque de son côté.
  - Sous-titre alimenté par `category` : l'endpoint marketplace ne renvoie pas de description
    (contrairement à la fiche du site). Le bloc est masqué quand il n'y a rien, au lieu de
    réserver une bande vide sous chaque titre.
  - La bordure extérieure porte l'**état** (👑 meneur / 😤 surenchéri / 🆕 nouveau), le cadre
    intérieur porte la **rareté** — les deux informations restent lisibles séparément.
  - Conservés depuis la vue détaillée : valorisation (sous-coté / surcoté), meilleur
    enchérisseur, et le compte à rebours qui continue de tourner.
  - La grille s'adapte à la largeur du panneau (redimensionnable) : autant de colonnes que la
    place le permet.
  - Le bouton bascule à 2 états devient un **sélecteur** : à 3 vues, un bouton qui cycle
    n'indique plus ni où l'on est ni combien de clics restent. L'ancien réglage « compact »
    est migré automatiquement.

- **🛍️ Historique des achats** (panneau Statistiques), placé à côté de l'historique des ventes.
  Date, rareté, titre cliquable vers l'enchère, prix de départ → prix payé, et l'écart payé
  au-dessus de la mise à prix. En-tête avec le nombre d'achats et le total dépensé.
  - **Il dépasse la limite du site.** L'endpoint du jeu ne renvoie qu'une fenêtre glissante des
    dernières enchères gagnées ; au-delà, elles disparaissent côté serveur. Le bot archive
    désormais chaque snapshot en local et en fait l'**union au fil du temps** — plus rien n'est
    perdu tant qu'il tourne régulièrement (2000 achats conservés, 300 affichés).
  - *Limite honnête* : les achats déjà sortis de la fenêtre du site **avant** cette mise à jour
    sont irrécupérables. L'archive démarre à la première synchro.
  - Les deux historiques se placent **côte à côte** quand le panneau est assez large, et
    s'empilent sinon.
  - Au passage : les deux listes déclenchaient chacune un appel `/mine` identique à chaque
    ouverture du panneau. Un seul appel les alimente maintenant toutes les deux.

### ✨ Améliorations

- **Trash Seller — ventes du jour : raretés toujours dans l'ordre.** La ligne des prix moyens par
  rareté s'affichait dans l'ordre d'*arrivée des ventes*, donc elle se réorganisait toute seule à
  chaque vente. Elle est désormais triée de la plus rare à la plus commune (L → UR → SR → R → PC →
  C), en réutilisant le classement `RARITY_ORDER` déjà employé ailleurs. Une rareté inconnue est
  placée en fin de ligne plutôt que masquée, et le regroupement est insensible à la casse (de
  vieilles entrées en minuscules pouvaient créer une colonne en double).

### 🛠️ Corrections

- **L'API `/mine` du site ne renvoie plus aucune liste.** Elle a été réduite à deux compteurs :
  `{ "sellingCount": 10, "maxConcurrentAuctions": 10 }`. Les tableaux `selling`, `won` et
  `history` ont disparu — d'où « Aucune vente active » et les rafales de `HTTP 409 · Limite de
  10 enchères actives atteinte ». Le bot s'appuie désormais sur le **compteur**, qui fait
  autorité, plutôt que sur la longueur d'une liste absente :
  - Le **calcul de slots du Trash Seller redevient exact** — plus de 409 en boucle.
  - Le panneau affiche « **N vente(s) active(s)** » avec la mention que le site ne fournit plus
    le détail carte par carte, au lieu du faux « Aucune vente active ».
  - Nouveau garde-fou : le plafond effectif est le **plus contraignant** entre ton réglage et
    le `maxConcurrentAuctions` du serveur. Régler 15 quand le site en autorise 10 garantissait
    des 409.
  - L'annulation des ventes sans mise (bouton *Refresh ventes*) a besoin du détail : elle est
    **sautée avec un message clair** au lieu d'annuler à l'aveugle. La remise en vente des slots
    libres, elle, continue de fonctionner.
  - Fonctions concernées supprimées plutôt que laissées en place : l'accesseur « liste seule »
    renverrait désormais toujours `[]` et referait croire à 0 vente active.
  - **Lecture directe en base (Supabase).** Le site est bâti sur Supabase et le bot y est déjà
    authentifié. Les données perdues sont relues dans la table `auctions` — ventes en cours
    (`seller_id` + `status=active`), enchères gagnées (`winner_id`) et ventes conclues. Les
    lignes sont converties dans la forme de l'ancienne API, si bien que l'affichage,
    l'annulation et le calcul de la somme du header fonctionnent sans être réécrits.
    **Les trois fonctionnalités cassées sont donc rétablies**, y compris pour les ventes créées
    à la main sur le site.
  - Filet si la base est inaccessible : le détail est reconstitué à partir des `auctionId` que
    le bot enregistre pour chaque vente qu'il crée, rejoués sur l'endpoint « enchère unique »
    `/marketplace/{id}`, qui fonctionne toujours (throttlé à 2 min).
  - **Clignotement de la liste — corrigé.** La lecture en base n'était branchée que sur *un* des
    sept points qui rafraîchissent l'affichage. À chaque tick du Trash Seller, la liste était
    réécrite avec le tableau vide de `/mine` (« Détail indisponible »), puis restaurée 30 s plus
    tard par le rafraîchissement périodique. Le complément se fait désormais dans l'accesseur
    lui-même, donc pour tous les appelants. Cache de 10 s pour ne pas multiplier les requêtes,
    invalidé immédiatement après une mise en vente ou une annulation.
  - Effet de bord bienvenu : le bouton *Refresh ventes* retrouve le détail, donc l'annulation
    des ventes sans mise refonctionne.
  - Le test « vente conclue » ne repose plus sur le libellé exact `settled_sold` : en base, la
    valeur de `status` n'est pas garantie. Un gagnant ou un prix final suffit à qualifier.
  - Table des profils (id → pseudo) découverte une fois puis mémorisée.
  - **Pseudos affichés « ? » — corrigé.** La table des profils était interrogée avec une liste
    de colonnes (`select=username,name,display_name`) : PostgREST répond **400 dès qu'UNE seule**
    d'entre elles n'existe pas, et la table pourtant valide était écartée. La requête utilise
    désormais `select=*`, puis choisit le champ qui porte le pseudo parmi les noms usuels
    (`username`, `pseudo`, `display_name`, `nickname`…). Le même défaut existait depuis
    longtemps dans la résolution de **ton propre pseudo** — d'où le `(?)` en source dans le log.
    Deux noms de tables candidats ajoutés (`players`, `members`), et un message de diagnostic
    apparaît si la table répond mais qu'aucune colonne ne ressemble à un pseudo.
  - **Source du pseudo affichée `(?)` — corrigé.** Le log relisait la source dans `localStorage`,
    or les deux chemins qui sortent tôt de la résolution (réglage manuel, cache) n'y écrivaient
    rien. Elle est désormais portée par une variable renseignée sur **tous** les chemins. Et le
    cache d'une heure n'est réutilisé que s'il connaît sa source : une entrée écrite par une
    version antérieure est re-résolue au lieu de figer l'ancienne logique pendant 1 h.
  - `wmTestUsernames()` (console) : valide la résolution des pseudos en résolvant son propre id
    par le chemin exact utilisé pour les enchérisseurs — sans attendre qu'un adversaire mise.
  - **Outils de diagnostic** (console) : `wmDumpMine()` rejoue le rapport de schéma `/mine` avec
    une requête fraîche ; `wmDiscoverTables()` introspecte le schéma Supabase du site via le
    descriptif OpenAPI de PostgREST (une seule requête, liste les tables exposées et leurs
    colonnes) — pour retrouver où lire les ventes maintenant que l'API REST ne les sert plus.

- **Ventes actives lues à 0 alors que le serveur en compte 10** (symptôme : « Aucune vente
  active » + rafale de `HTTP 409 · Limite de 10 enchères actives atteinte`). La lecture de la
  réponse `/mine` reposait sur un nom de champ (`selling`) et une valeur de statut (`active`)
  exacts. Elle est maintenant tolérante : plusieurs noms de tableau sondés, statut comparé sans
  tenir compte de la casse et acceptant plusieurs libellés, charge utile éventuellement
  enveloppée (`{ data: … }`) prise en compte, et repli sur le premier tableau dont les entrées
  ressemblent à des enchères — en excluant explicitement `won` / `history`, qui portent les
  mêmes champs et fausseraient le décompte de slots.
  - **Diagnostic intégré** : quand aucune vente n'est retenue, le bot loggue les champs
    réellement reçus (racine, tableau retenu, statuts vus, champs d'une entrée, aperçu brut du
    JSON). Rejoué toutes les 3 min tant que l'anomalie dure — tiré une seule fois au démarrage,
    il défilait hors du log avant qu'on pense à le lire. Également déclenché **au moment exact**
    d'un 409 « limite atteinte » alors que le bot lit 0 vente, et disponible à la demande via
    `wmDumpMine()` dans la console.
  - **Le Trash Seller s'arrête au premier 409 « limite atteinte »** au lieu d'enchaîner un échec
    par carte du lot : le plafond est global, les suivantes se heurteraient au même mur.
  - **Pause de 2 min après un plafond serveur.** L'attente « qu'un slot se libère » comparait le
    décompte local (faux) au plafond, sortait aussitôt et relançait un lot → un 409 toutes les
    15 s en boucle. Le serveur fait désormais autorité : quand il se déclare plein, le bot
    patiente vraiment.

- **Les ventes actives disparaissaient de l'affichage.** `fetchActiveAuctions()` renvoyait un
  tableau **vide** sur *n'importe quel* échec HTTP (429 rate-limit, 5xx, coupure réseau), sans
  le distinguer d'un vrai « aucune vente active » : la liste était donc effacée et remplacée par
  « Aucune vente active », et la somme des ventes du header retombait à zéro. Elle renvoie
  maintenant `null` en cas d'échec, et l'affichage précédent est conservé.
  - **Conséquence plus grave, corrigée au passage** : le Trash Seller se sert de ce même
    décompte pour calculer ses slots libres. Un 429 lui faisait croire à **0 vente active** —
    donc tous les slots libres — et il pouvait remettre en vente au-delà du plafond. Les trois
    chemins qui calculent des slots refusent désormais d'agir sur un décompte inconnu et
    réessaient plus tard.
  - Cause aggravante supprimée : la synchro des enchères gagnées ajoutée plus haut ouvrait une
    requête `/mine` supplémentaire toutes les 60 s. Elle est maintenant portée par le
    rafraîchissement des ventes actives, qui interroge déjà cet endpoint — la même réponse
    contient `selling` et `won`. Le nombre d'appels à `/mine` redescend **sous** son niveau
    d'avant l'ajout.

- **« Dernières sessions » : sessions manquantes.** Le récap n'était écrit qu'au moment du
  `beforeunload` — un événement que le navigateur **ne déclenche pas** en cas de crash, de kill du
  navigateur, d'extinction du PC ou d'onglet libéré par Chrome pour récupérer de la mémoire. Toute
  session terminée autrement disparaissait purement et simplement. Désormais la session est
  **enregistrée au fil de l'eau** (à chaque pack ouvert, chaque vente conclue, chaque achat, plus une
  sauvegarde de sécurité toutes les minutes) et l'écriture est un *upsert* : elle se met à jour sans
  jamais créer de doublon. Ajout des écouteurs `pagehide` et `visibilitychange`, les seuls signaux de
  fermeture réellement garantis. La session en cours apparaît dans la liste avec un badge
  **● en cours**.
- **Gains de session sous-comptés (souvent à 0).** Deux mécanismes concluent les ventes en attente :
  `checkSellHistoryResults` (boucle du Trash Seller) et la réconciliation périodique (toutes les
  5 min + au démarrage). Seul le premier créditait les gains de la session — donc dès que le second
  gagnait la course, ce qui est le cas le plus fréquent, la vente était comptée dans le cumul à vie
  mais **absente du récap de session**. Pire : une session où toutes les ventes passaient par la
  réconciliation était considérée comme « vide » et n'était pas enregistrée du tout. Les deux chemins
  passent maintenant par un point d'entrée unique, avec un verrou anti-double-comptage garantissant
  qu'une vente est comptabilisée **exactement une fois**.
- **Achats non comptés (« net » de session faux).** La synchronisation des enchères gagnées ne
  tournait qu'à l'intérieur du scan du Market Watcher : Watcher à l'arrêt = `achats` et `dépensé`
  bloqués à 0, même en remportant des enchères. Elle tourne désormais **toutes les minutes en
  permanence**, indépendamment du Watcher (sans requête en double quand celui-ci tourne aussi).
- **Répartition par rareté fausse dans le récap.** La ligne 🃏 de chaque session affichait le cumul
  **de la journée** (les compteurs étaient amorcés depuis les stats quotidiennes persistées), donc la
  journée entière était répétée sur chaque session et ne collait pas au nombre de packs affiché. Les
  raretés sont maintenant comptées séparément, réellement par session.
- **Un F5 ne coupe plus la session en deux.** Les métriques de session sont conservées en
  `sessionStorage` : un rechargement poursuit la même session (durée et totaux inclus) au lieu de
  repartir de zéro. La session se termine bien à la fermeture de l'onglet.

---

## 2026-07-27 — v1.3.x

### 🆕 Nouveautés
- **↻ Rafraîchir le prix d'une enchère (vue déroulée).** Un bouton flèche (qui tourne pendant le
  chargement) à côté du champ de mise récupère à la demande le **prix réel** de l'enchère et met à
  jour l'affichage + la mise minimale pré-remplie. Pratique quand le bot n'a pas le prix pile au bon
  moment pour miser à la main.
- **🏆 Son + notif « enchère gagnée »** — quand une enchère est remportée (source fiable serveur),
  un son dédié « cha-ching », un badge de notif et un message Discord groupé. Réglable dans
  Paramètres → Sons (« 🏆 Son + notif quand une enchère est gagnée »).
- **🩺 Tableau de santé du bot** (panneau Statistiques) — décalage d'horloge PC↔serveur, âge du
  dernier scan marché / collection, et compteurs d'erreurs API (429 / 5xx / réseau) avec la dernière
  erreur. Pour diagnostiquer rate-limits et timeouts d'un coup d'œil.
- **💰 Solde prévisionnel** dans le header : à côté du solde actuel et des segments « mises en cours »
  (rouge) / « ventes en cours » (vert), affiche `= X 💰 prév.` = **solde − mises engagées + ventes
  en cours** (ce que deviendrait le solde si tout se conclut ainsi). Vert si les ventes couvrent les
  mises, ambre sinon.
- **🟣 Infobulle du mode Fourbe (vue compacte)** : survoler le rond violet affiche désormais le
  **plafond** défini pour le snipe (ou « sans plafond ») — plus besoin de dérouler l'enchère.
- **✏️ Édition d'un préset d'étiquetage** — un crayon sur chaque recherche enregistrée charge ses
  valeurs (mot-clé, tag, catégorie, sans-tag, recherche étendue) dans le formulaire ; le bouton
  passe en « 💾 Enregistrer les modifications » et met à jour ce préset précis (bouton « ✖ Annuler »
  pour ressortir). Plus besoin de supprimer/recréer pour corriger une recherche.
- **📦 Bouton « Ouvrir pack »** — à gauche du START du Pack Opener, ouvre **un seul** pack
  manuellement (pratique pour écouler les packs en attente sans lancer la boucle auto). Même
  comptage/animation que la boucle, sans double-comptage.
- **🤝 Acceptation d'échange en échec (500)** — sur les gros échanges (> ~30 cartes), l'acceptation
  dépasse le timeout serveur. Le bot **détecte si l'échange a en fait abouti** malgré le 500
  (timeout au retour, pas au traitement) et tente **une** reprise en cas de simple hoquet. Mais
  l'acceptation est une **transaction atomique** (transfert de toutes les cartes d'un coup) : elle
  ne peut être ni découpée ni rejouée utilement côté navigateur (contrairement aux tags). Si l'échec
  persiste, le bot l'explique clairement et propose le vrai contournement : **scinder l'échange**
  en plusieurs plus petits. (Le refus, lui, marche car c'est un simple changement de statut.)
- **🎯 Chasseur ciblé** — nouvelle catégorie de mots-clés du Market Watcher. Chaque entrée a
  son **mode** (🕵️ fourbe ou 🤖 auto-bid) et son **plafond**, propres au mot-clé. Dès qu'une
  carte matche : mise initiale immédiate (les deux modes), puis snipe en fin (fourbe) ou riposte
  (auto-bid), **jamais au-dessus du plafond**. Ex. « gare ferroviaire japonaise » → fourbe · 100.
- **⏰ Horaires par module** — le planning unique (démarrage/arrêt des 3 modules ensemble) est
  **splitté en 3 horaires indépendants** : Pack Opener, Market Watcher, Trash Seller ont chacun
  leur activation + plage De/à. Migration automatique de l'ancien horaire global (config conservée).

### ✨ Améliorations
- **Hunter — mise aussi sur les enchères déjà en cours.** À l'activation, le mode Hunter ne visait
  que les **prochaines** annonces ; il évalue désormais aussi les **enchères déjà présentes** au
  marché qui matchent le critère (seuil fixe ou médiane) et mise dessus immédiatement. La logique
  d'auto-bid est mutualisée (scan + activation), avec verrou anti-doublon.
- **Trash Seller — prix dégressif sur les invendus.** Une carte remise en vente sans se vendre (🔁)
  voit son prix baisser de **-15% par tranche de 10 remises** (plafonné à -75%, jamais sous 1 💰,
  s'applique après le plancher pour écouler ce qui stagne). Réglage activable.
- **Trash Seller — undercut du marché.** À la mise en vente, si une annonce active existe déjà pour
  la même carte, on se place à **1 💰 sous** la plus basse (seulement si ça baisse le prix) pour
  vendre plus vite. Réglage activable.
- **Étiquetage — réutilisation du scan de collection (grosses collections).** L'étiquetage en masse
  re-scannait **toute** la collection (95k+ cartes) à chaque préset. Il **réutilise désormais le
  dernier scan complet** (≤ 30 min) au lieu de recommencer → gain de temps énorme quand on enchaîne
  les présets. De plus, un **scan complet de collection** (démarrage à froid ou bouton **♻️
  Collection**) **remplit ce cache** → après un ♻️, l'étiquetage ne re-scanne pas du tout. Une case
  **« 🔄 Forcer un nouveau scan »** permet de forcer. Les tags posés sont reflétés en mémoire (cache
  cohérent). Concurrence de scan légèrement relevée (15 pages en parallèle).
- **Étiquetage — match précis par défaut.** Les présets matchent désormais le **titre/nom** de la
  carte (elle *EST* la personne), plus la description. Une case **« 🔎 recherche étendue »** par
  préset réactive la recherche dans description/catégories pour les présets thématiques (marvel,
  japon…). Fini les faux positifs (ex. film taggué à cause d'un acteur cité dans son résumé).
- **Auto-tag des packs** — case **« 🛡️ ne pas auto-étiqueter les Légendaires »** (activée par
  défaut) : une L à garder ne finit plus taguée « Trash ». Ce chemin respecte aussi la portée
  `extended` des présets (avant : il matchait toujours la description).
- **Détection mots-clés des packs** — prend maintenant en compte le **titre + catégories +
  description** (avant : titre seul), sans changer le comportement du Market Watcher.
- **Trash Seller — filet de sécurité.** Une carte n'est mise en vente que si le tag de vente est
  son **seul** tag (réglage, activé par défaut). Une carte « Trash » + un autre tag est ignorée.
- **Tags** — plafond de **48 caractères** appliqué en amont de la création (le serveur refusait
  au-delà) → plus d'échecs silencieux sur les titres longs.
- **Historique des ventes** — chaque vente est un **lien cliquable** vers l'enchère.
- **Présets** — ajout des franchises **Extra + DCU** (Pacific Rim, Men in Black, Batman, DCEU…)
  via script console dédié.

### 🛠️ Corrections
- **Trash Seller — undercut faussé à 1 wkb.** Le paramètre `?card_id=` du marché ne filtrait pas
  réellement : l'undercut prenait le minimum de **tout** le marché (souvent 1 💰) et bradait la carte
  à 1, même sans annonce concurrente de cette carte. On re-filtre désormais côté client sur le vrai
  `card_id` — undercut uniquement face à une vraie annonce de la **même** carte, sinon prix normal.
- **Pack Opener — stats du jour qui ne se réinitialisaient pas.** Le reset quotidien ne se faisait
  qu'au chargement du script. Onglet laissé ouvert au passage de minuit → les stats d'hier
  continuaient de s'accumuler **et** étaient ré-estampillées « aujourd'hui » par la sauvegarde, donc
  survivaient même au rechargement (d'où le reset manuel quotidien). Ajout d'un **rollover à minuit**
  (vérifié à chaque pack + toutes les 60 s) qui remet les compteurs et raretés du jour à zéro.
- **Trash Seller — décompte de ventes actives faussé (ex. « 10/10 » alors que 6).** Les ventes qui
  venaient de se terminer et attendaient leur règlement (état « ⏳ ») étaient encore comptées comme
  actives (`status:"active"` côté serveur le temps du règlement) → le seller se croyait plein et
  attendait au lieu de relister. Le décompte ne retient désormais que les enchères **non terminées**
  (`end_at` futur), et la boucle re-vérifie **toutes les 15 s** (au lieu de 30 s) → compte fidèle et
  slots libérés plus vite.
- **Export de backup allégé par défaut.** L'export n'inclut plus les gros caches régénérables
  (cache collection/ventes, `won_seen_ids`) — ils se reconstruisent seuls et faisaient gonfler le
  fichier (~5 Mo → ~3 Mo). Les prochains exports sont donc directement réimportables sans souci de
  quota.
- **Import de backup — quota localStorage dépassé.** Réimporter un backup complet échouait
  (`exceeded the quota`) car il ré-écrivait de gros caches régénérables (cache de ventes/collection,
  plusieurs Mo). L'import **ignore désormais ces caches** (reconstruits au rechargement) et écrit
  les **petites clés d'abord** (réglages, mots-clés, présets) puis les grosses stats en dernier, de
  façon **tolérante au quota** : la config essentielle passe toujours, une éventuelle grosse clé
  dépassant le quota est ignorée et signalée au lieu de casser tout l'import.
- **Surenchère loggée/sonnée en double.** Reprendre le lead (parfois de façon optimiste — riposte
  hot-lane, mise initiale du Chasseur) effaçait la dé-dup du **log** via `clearOutbid`. Si le fetch
  suivant montrait encore le même adversaire au **même montant**, la surenchère repassait en log +
  son. La dé-dup (par montant) n'est plus effacée à la reprise de lead — les prix ne montant que,
  une vraie nouvelle surenchère (montant plus élevé) est toujours détectée ; elle est purgée à la
  fin de l'enchère. Fini le double « ⚡ surenchéri » pour une seule personne.
- **Market Watcher — doublons rareté-conscients.** « Masquer les cartes déjà possédées » masquait
  une carte même si elle apparaissait dans une **rareté différente** de celle possédée (ex. possédée
  en SR, revenue en UR après revalorisation par le site). Le bot mémorise désormais **les raretés
  réellement possédées par carte** et ne masque que les **vrais doublons** (même carte ET même
  rareté). Un badge **ambre** signale « possédée dans une autre rareté ». (Nécessite un **refresh
  complet de la collection** pour peupler les raretés ; repli sûr sur l'ancien comportement avant.)
- **Trash Seller — cartes engagées dans un échange (409).** Le site refuse de mettre en vente une
  carte « déjà engagée dans un échange en attente » ; le bot repiochait les mêmes cartes en boucle
  et restait bloqué sous le plafond (ex. 7/10). Ces cartes sont désormais **exclues temporairement**
  (cooldown 20 min), d'**autres cartes prennent le slot** pour atteindre le plafond, et les cartes
  reportées sont **réessayées après expiration** (l'échange a pu se dénouer). Si tout le reste du
  pool est en échange, le seller patiente au lieu de s'arrêter.
- **Market Watcher — faux « 🆕 nouvelle annonce ».** Une annonce qui disparaissait d'un seul cycle
  de scan (page ratée ou glissement entre pages) repassait « nouvelle » à son retour. La détection
  de nouveauté ne purge plus une annonce encore vivante → plus de faux 🆕 (et tri « ajout récent »
  stabilisé).
- **Pack Opener — timers qui se chevauchent.** Un stop→start pendant l'attente de regen laissait
  l'ancienne boucle continuer en parallèle (un timer de plus à chaque cycle). Jeton de génération
  (epoch) : une seule boucle et un seul ticker à tout instant, l'attente de regen est interruptible.

---

## Antérieur (récapitulatif)

Fonctionnalités et correctifs des sessions précédentes, non datés individuellement :

### 🆕 Nouveautés
- **Trash Seller** — stratégies de sélection de la pool (équitable / valeur / rareté / aléatoire),
  prix de vente dynamique au prix moyen du marché avec **plancher** (jamais sous le prix du tableau),
  bouton **Refresh ventes**, **réconciliation** des ventes au démarrage + toutes les 5 min, **stock
  tampon** (prefetch) pour enchaîner les pools sans latence.
- **Historique des ventes** dans le panneau Statistiques (les ventes, pas seulement les enchères
  gagnées).
- **Mode Fourbe** — catégorie de mots-clés qui arme le snipe (~10 s de la fin d'enchère).
- **Plage horaire** (démarrage/arrêt programmé) — version initiale (globale).
- **Tour guidé** au premier clic sur la roue ⚙, après l'onboarding.
- **Diagnostic des échecs d'étiquetage** en masse (quelle carte, quel tag, quelle raison).
- **Vue marché compacte** + confirmation de surenchère au-delà d'un saut de prix.
- **Présets MCU** (un tag par film et par phase) enrichis depuis MCU.txt.

### ✨ Améliorations
- **Horloge serveur** synchronisée à la milliseconde (précision du snipe).
- **Préservation du focus** des champs pendant l'auto-refresh + sauvegarde live du plafond auto-bid.
- Séparateur des présets d'étiquetage passé de la virgule au **point-virgule** (titres à virgule
  préservés), avec migration des anciens présets.

### 🛠️ Corrections
- **Double log/son de surenchère** (dé-duplication + correction de la riposte hot lane).
- **Mode Fourbe qui ne misait pas** (seuil de solde + horloge serveur au lieu de `Date.now`).
- **Re-flash jaune de toutes les annonces** à l'ajout d'un mot-clé (surlignage ciblé).
