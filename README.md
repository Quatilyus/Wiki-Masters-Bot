# WikiMasters Bot

Assistant d'automatisation pour **wiki-masters.com** : ouverture de packs, surveillance du marché, enchères automatiques, mise en vente et étiquetage en masse de ta collection. Le bot s'ajoute par-dessus le site sous forme d'un tableau de bord, piloté depuis un bouton flottant ⚙ en bas à droite.

> 📜 Nouveautés et corrections : voir le [CHANGELOG](CHANGELOG.md).

---

## 🌐 Compatibilité

### Sur ordinateur

| Navigateur | Compatible |
|---|---|
| **Chrome** | ✅ Oui |
| **Edge** | ✅ Oui |
| **Firefox** | ✅ Oui |
| **Safari** | ❓ Non testé |

Ces trois-là fonctionnent, à condition d'installer le script **par son URL** (voir ci-dessous) et non depuis un fichier sur ton disque.

**Windows, macOS et Linux conviennent** — c'est le navigateur qui compte, pas le système. Sur un Mac, installe simplement Chrome, Edge ou Firefox et tout se passe comme ailleurs.

Tampermonkey existe aussi pour **Safari**, mais le bot n'y a jamais été testé et Safari applique des règles plus strictes sur le chargement de code distant (la directive `@require` qu'utilise ce script). Sur Mac, prends plutôt Chrome ou Firefox.

### 📱 Sur téléphone et tablette : ❌ non supporté

Le bot est prévu pour un ordinateur :

- le tableau de bord est une interface **trois colonnes** pensée pour un grand écran ;
- les modules doivent tourner dans un **onglet laissé ouvert et actif** pendant des heures, alors que les navigateurs mobiles mettent en veille les onglets en arrière-plan.

---

## 📦 Installation

### 1. Installer Tampermonkey

Tampermonkey est l'extension qui héberge le script.

- **Edge** : [Microsoft Edge Add-ons → Tampermonkey](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)
- **Chrome** : [Chrome Web Store → Tampermonkey](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
- **Firefox** : [Modules Firefox → Tampermonkey](https://addons.mozilla.org/firefox/addon/tampermonkey/)

Clique sur **Ajouter / Installer**, puis confirme.

### 2. Activer le mode développeur *(Chrome et Edge uniquement)*

Depuis Chrome 138 / Edge équivalent, Tampermonkey exige que le **mode développeur** des extensions soit activé pour fonctionner pleinement.

- **Chrome** : va dans `chrome://extensions`, puis active l'interrupteur **« Mode développeur »** en haut à droite.
- **Edge** : va dans `edge://extensions`, puis active **« Mode développeur »** dans le menu de gauche.

> Si un bandeau d'avertissement apparaît au lancement de Tampermonkey, c'est généralement que cette étape manque.

Sur **Firefox**, cette étape ne s'applique pas : passe directement à l'étape 3.

### 3. Ajouter le script

**Méthode recommandée — installation par URL (avec mises à jour automatiques)**

Ouvre cette URL dans ton navigateur ; Tampermonkey proposera directement l'installation :

```
https://raw.githubusercontent.com/Sephiroth-ctrl/Wiki-Masters-Bot/refs/heads/main/open_cards.user.js
```

C'est un petit fichier d'en-tête : il charge le code du bot (`open_cards.js`) via sa directive `@require`, et Tampermonkey vérifie périodiquement s'il existe une nouvelle version. Compte quelques minutes de propagation après chaque mise à jour publiée.

**Méthode alternative — copier-coller** *(pas de mise à jour automatique)*

1. Clique sur l'icône Tampermonkey → **Créer un nouveau script**.
2. Efface tout le contenu par défaut.
3. Colle l'en-tête de [`open_cards.user.js`](open_cards.user.js) **sans** ses lignes `@require` / `@updateURL` / `@downloadURL`, puis l'intégralité de [`open_cards.js`](open_cards.js) à la suite.
4. Vérifie que l'en-tête `// ==UserScript==` contient bien la ligne :
   ```
   // @match        https://www.wiki-masters.com/*
   ```
   (sans elle, le bot ne s'injectera pas sur le site)
5. **Ctrl + S** pour sauvegarder.

### 4. Lancer

1. Va sur **https://www.wiki-masters.com** (connecté à ton compte).
2. Recharge la page (**Ctrl + Shift + R** pour un rechargement propre).
3. Un bouton flottant **⚙** apparaît en bas à droite. Clique dessus pour ouvrir le tableau de bord.

---

## 🚀 Première configuration

### L'assistant d'onboarding

Au tout premier lancement, un assistant s'ouvre automatiquement et te demande l'essentiel :

1. **Type de compte** — abonné (3 min de cooldown entre les packs) ou gratuit (10 min). Ça ajuste aussi le nombre de ventes simultanées autorisées : **5** en gratuit, **10** en abonné.
2. **Mots-clés du market watcher** — au moins un (ex. `japon`, `marvel`, `coupe du monde`). Le bot surveillera les enchères dont le titre ou la catégorie contient ces mots. **Sépare-les par des points-virgules `;`** — pas par des virgules, pour que les titres qui en contiennent (« star wars, épisode i ») ne soient pas coupés.
3. **Tag de mise en vente** *(optionnel)* — le tag (par défaut « Trash ») que le Trash Seller utilisera pour repérer les cartes à vendre. Tu peux choisir un tag existant de ton compte, en créer un, ou passer l'étape et y revenir plus tard.

### Le tour guidé

Juste après, une visite guidée pointe chaque zone du tableau de bord. Tu peux la relancer à tout moment via **Paramètres → 📖 Revoir le tuto guidé**.

---

## 🖥️ Le tableau de bord

Trois colonnes redimensionnables (les trois modules), puis trois panneaux dépliables en dessous : **🏷️ Étiquetage en masse**, **📊 Statistiques** et **⚙️ Paramètres**. Le bouton **🚀 Tout démarrer** lance ou arrête les trois modules d'un seul clic.

---

## 📦 Pack Opener

Ouvre les packs en boucle, en respectant le cooldown de ton compte.

- Révélation de la carte et rappel du **dernier pack** obtenu.
- **Raretés obtenues (aujourd'hui)** avec leurs taux.
- Liste des **matchs de mots-clés** parmi les cartes packées, avec compteur et alerte sonore.
- **📦 Ouvrir pack** pour un tirage manuel unique, **⟳ Reset session** pour repartir de zéro.

---

## 📡 Market Watcher

Surveille les enchères en continu et peut miser à ta place.

### Les cinq catégories de mots-clés

| Catégorie | Effet |
|---|---|
| **Standards** | Simple alerte (+ son) quand une annonce matche |
| **⭐ Prioritaires** | Auto-bid forcé : le bot riposte automatiquement |
| **🕵️ Fourbe** | Arme le snipe automatique en toute fin d'enchère |
| **🎯 Chasseur ciblé** | Mise initiale + mode (fourbe ou auto-bid) + **plafond** propre à ce mot-clé, avec **rareté requise** optionnelle et mise en pause automatique après une victoire |
| **🚫 Exclus** | Exclusion stricte : toute annonce contenant la phrase est masquée |

Dans chaque champ, plusieurs mots-clés se saisissent d'un coup en les séparant par des **points-virgules `;`**.

### ⚡ Le Hunter

Le Hunter mise tout seul sur ce qui passe sous ton seuil. Deux modes de décision (Paramètres → Comportement) :

- **Seuil fixe** — mise si le prix est inférieur ou égal à une valeur que tu définis.
- **Dynamique** — mise si le prix passe sous un pourcentage de la **médiane des ventes passées** (ex. 85 %). Si aucune vente n'est connue pour la carte, le seuil fixe sert de filet.

La case **🕵️ Mode fourbe**, juste sous le bouton, ne change pas *quand* il mise mais *comment* : plus de mise immédiate, il snipe en fin d'enchère, toujours plafonné au même seuil.

Un **solde minimum** peut suspendre automatiquement les mises, et un **délai humanisé** (en ms) temporise chaque enchère — ignoré quand l'enchère se termine bientôt, un snipe restant toujours instantané.

> 💡 Le réglage **secondes visées pour le snipe** est à **10** par défaut, et c'est l'optimum : miser sous 10 s rallonge le timer d'une minute côté site. Le bot tire environ 1 s avant pour absorber la latence réseau.

### Sur chaque annonce

- Un **badge de valorisation** (📉 sous-coté / ➖ dans la moyenne / 📈 surcoté) basé sur l'historique réel des ventes.
- Le bouton **🔨 Miser** (enchère manuelle).
- Le bouton **🤖 Auto-bid** : riposte automatique en cas de surenchère, avec un **plafond par carte**.
- Le bouton **🔭** : compare les vues Wikipédia **réelles** du dernier mois complet au cache de WikiMasters — utile pour repérer une carte dont la rareté est sur le point de changer avant que le site ne s'en aperçoive.

### Affichage

- Un **filtre texte** sur les annonces affichées.
- Onze **tris** : fin proche/lointaine, ajout récent, mises perdues récemment, prix, rareté, titre, nombre d'exemplaires possédés.
- Trois **vues** : **▤ Détaillé** (tous les contrôles), **☰ Compact** (une ligne par annonce), **🖼 Cadres** (grille avec l'image de la carte).
- Une case **Masquer les cartes déjà possédées**.

---

## 🗑️ Trash Seller

Met automatiquement en vente les cartes portant ton tag de vente, et remet le tag sur les invendues pour les relister. Un badge 🔁 indique combien de fois chaque carte est revenue invendue.

### Quelles cartes en premier

Quatre stratégies au choix (Paramètres) :

- **⚖️ Équitable** — les moins souvent mises en vente d'abord, pour couvrir tout le pool.
- **💰 Valeur** — les plus chères d'abord (prix moyen du marché, repli sur le prix par rareté).
- **⭐ Rareté** — les plus rares d'abord (L → C).
- **🎲 Aléatoire**.

### À quel prix

- Un **tableau prix + durée par rareté** (L, UR, SR, R, PC, C), qui sert aussi de repli et de plancher.
- Ou le **prix moyen du marché × un pourcentage** que tu choisis (ex. 90 %). Si aucune vente n'est connue pour la carte, le prix du tableau est utilisé.
- **🛡️ Plancher** — ne jamais descendre sous le prix du tableau, pour éviter de brader une carte sous-cotée.
- **📉 Prix dégressif** — une carte qui stagne perd 15 % par tranche de 10 remises en vente (plafonné à −75 %, jamais sous 1 💰).
- **🃏 Undercut** — s'il existe déjà une annonce active pour la même carte, se placer à 1 💰 en dessous de la plus basse (uniquement si ça baisse le prix).

### Garde-fou

L'option **🛡️ Ne vendre que si le tag de vente est le SEUL tag** ignore toute carte qui porte aussi un autre tag : dans ce cas le tag de vente est probablement une erreur, la carte est conservée.

Le bouton **🔄 Refresh ventes** annule les annonces sans mise et relance les meilleures cartes selon ta stratégie.

---

## 🏷️ Étiquetage en masse

Cherche dans toute ta collection les cartes qui matchent un ou plusieurs mots (séparés par `;`), puis applique une étiquette en un clic.

- **Catégorie** optionnelle pour ranger tes recherches (ex. « MCU », « Pays »).
- **Seulement les cartes sans aucune étiquette** — coche-la **sans** mot-clé pour lister toutes tes cartes non taguées.
- **🔎 Recherche étendue** — cherche aussi dans la description et les catégories. Utile pour un thème (« marvel », « japon »), mais peut taguer une fiche de **film** qui ne fait que *mentionner* un acteur. Décoché (défaut), seul le titre compte.
- **🔄 Forcer un nouveau scan** — par défaut l'étiquetage réutilise le dernier scan complet (≤ 30 min), ce qui change tout sur les grosses collections.
- **💾 Enregistrer cette recherche** en préset, puis **▶▶ Lancer tous les présets** (ou un groupe entier en un seul scan) — pratique pour retaguer tes nouvelles cartes après chaque session de packs.
- **🃏×2 Repérer les doublons** — liste d'un coup toutes les cartes possédées en 2 exemplaires ou plus, étiquette « Doublon » pré-remplie.
- **Étiquetage automatique des cartes packées** selon tes présets, avec un garde-fou **🛡️ ne pas auto-étiqueter les Légendaires**.

---

## ⚙️ Paramètres

### Notifications Discord
Colle l'URL d'un **webhook Discord** pour recevoir les alertes du bot, avec boutons **Test** et **Effacer**. Cette URL est privée : ne la partage pas.

### Logs affichés
Choisis ce qui apparaît dans le log : actualisation de la collection, Market Watcher, Trash Seller, Auto-bid. Le log s'exporte en `.txt`.

### Mon compte
Le pseudo est détecté automatiquement. Un champ **pseudo forcé** permet de le corriger après un changement de pseudo sur le site, et un bouton **🔄 Rafraîchir l'identité** vide le cache.

### Comportement
Mode et seuils du Hunter, solde minimum, délai humanisé, secondes de snipe, remise automatique du tag après un invendu, ajout en mot-clé des cartes mises en wishlist sur le site, sons (nouvelle enchère, perte du lead, ouverture de pack, Légendaire, victoire), badge de notifications, cooldown des packs, **alerte de volume de packs**, et les réglages du Trash Seller décrits plus haut.

### ⏰ Horaires programmés
Une plage horaire **par module** (Pack Opener, Market Watcher, Trash Seller) : chacun démarre à son heure de début et s'arrête à son heure de fin. Si tu l'arrêtes à la main pendant sa plage, il ne se relance pas tout seul.

### Tag de mise en vente
Le nom du tag wiki-masters qui marque les cartes à vendre (défaut : « Trash »).

---

## 📊 Statistiques

Ton bilan complet : ventes (taux, gains par rareté), packs ouverts et taux de drop, cartes invendables récurrentes, et l'historique de tes dernières sessions (packs, ventes, achats, net).

Les **historiques de ventes et d'achats sont archivés en local** : ils vont au-delà de la fenêtre glissante du site, qui oublie les plus anciens.

---

## 💾 Sauvegarde & restauration

Dans **Paramètres → Sauvegarde / Restauration** :

- **📤 Exporter** génère un `.json` avec tes mots-clés, réglages, stats et historiques. Les gros caches régénérables (collection, ventes) en sont **toujours** exclus : le fichier reste léger et réimportable sans saturer le stockage du navigateur.
- **📥 Importer** restaure le tout — pratique pour passer d'un PC à un autre.
- **📤 Exporter → Discord** envoie le fichier en pièce jointe via ton webhook.
- Un **backup automatique** peut partir sur Discord à chaque « Tout arrêter », et/ou **toutes les N minutes** en version allégée — utile contre les coupures et les crashs.

> ⚠️ Le fichier de backup contient tes données, **dont l'URL de ton webhook**. Ne l'envoie que sur un salon privé.

---

## 🛡️ Usage responsable

Le jeu est modéré par des humains. Ouvrir un volume de packs très élevé peut attirer leur attention. Le bot inclut une **alerte de volume** (Paramètres → Comportement) qui te prévient au-delà d'un nombre de packs par jour que tu définis. Utilise-la, et garde un rythme raisonnable.

---

## 🔧 Dépannage

| Problème | Solution |
|---|---|
| Pas de bouton ⚙ sur le site | Vérifie le `@match` du script, le mode développeur, et recharge avec Ctrl+Shift+R |
| Bandeau d'avertissement Tampermonkey | Chrome/Edge : active le mode développeur des extensions (étape 2) |
| « Utilisateur non identifié » | Connecte-toi à wiki-masters.com puis recharge la page |
| Le pseudo détecté est le mauvais | Paramètres → Mon compte → saisis un **pseudo forcé**, ou 🔄 Rafraîchir l'identité |
| Le bot ne tourne pas dans un nouvel onglet | Normal : chaque onglet est indépendant, relance les modules ou reste sur l'onglet principal |
| Comptage « possédé ×N » incohérent | Clique sur **♻️ Collection** pour forcer un scan complet |
| Le Trash Seller ne vend rien | Vérifie le nom du tag (Paramètres → Tag de mise en vente) et l'option « le tag de vente est le SEUL tag » |
| Aucune notification Discord | Webhook non renseigné ou notifications décochées (Paramètres → Notifications Discord → 🧪 Test) |
