# Plan d'evolution technique `@p2play-js/p2p-game`

Ce document sert de feuille de route long terme pour traiter les points de qualite/reliabilite identifies pendant la revue.

Principe de priorisation:
- aller du **moins impactant** (risque de regression faible) au **plus structurant** (risque plus eleve),
- livrer en petites etapes,
- valider chaque etape avant de passer a la suivante.

---

## Regles de conduite (a garder pendant tout le chantier)

- [ ] Travailler par petits lots (1 lot = 1 PR).
- [ ] Eviter les changements API cassants au debut.
- [ ] Garder une compatibilite ascendante quand possible.
- [ ] Ajouter des tests avant les changements sensibles.
- [ ] Tagger chaque lot en version mineure/patch selon impact.

Definition de "termine" pour chaque lot:
- tests unitaires verts,
- demo `examples/complete` fonctionnelle a 2 onglets,
- pas de regression visible sur `start()`, `broadcastMove()`, `state_full/state_delta`.

---

## Lot 1 - Hygiene immediate (tres faible risque)

**Objectif:** corriger les petites anomalies sans toucher au coeur reseau.

- [X] Corriger le bug de log dans `examples/server/ws-server.mjs` (`set.size` -> `set.sockets.size`).
- [X] Nettoyer les traces debug non essentielles (ou les basculer derriere un flag explicite).
- [X] Relire et harmoniser les messages d'erreur/warn pour faciliter le debug.

Validation:
- [X] Smoke test local des serveurs demo (`serve:ws`, `serve:http`).
- [X] Verification manuelle des logs en join/leave.

---

## Lot 2 - Renforcement tests/couverture (faible risque)

**Objectif:** augmenter la securite des futurs refactors sans changer le comportement.

- [ ] Inclure `src/net/PeerManager.ts` et `src/net/WebSocketSignaling.ts` dans la couverture Vitest.
- [ ] Ajouter tests de robustesse parse message invalide/corrompu.
- [ ] Ajouter tests anti-usurpation (`from` forge) pour verifier que l'identite transport prime sur le payload.
- [ ] Ajouter tests host election (cas IDs "2" vs "10").
- [ ] Ajouter tests de cycle de vie (connexion, deconnexion, leave roster).

Validation:
- [ ] Rapport coverage mis a jour.
- [ ] Aucun changement d'API publique.

---

## Lot 3 - Typage et API interne (faible a moyen risque)

**Objectif:** reduire les zones `any` et solidifier le contrat TypeScript.

- [ ] Remplacer progressivement les `as any` evitables.
- [ ] Renforcer les signatures d'evenements (`EventBus`, `P2PGameLibrary.on`).
- [ ] Ajouter des guards runtime minimaux pour les `NetMessage` avant application.

Validation:
- [ ] Build TypeScript strict sans degradation.
- [ ] Tests existants + nouveaux tests de guards verts.

---

## Lot 4 - Resilience locale et lifecycle (moyen risque)

**Objectif:** mieux gerer la duree de vie sans changer l'architecture protocolaire.

- [ ] Ajouter `stop()/dispose()` sur `P2PGameLibrary` (close RTC, WS, timers ping, listeners).
- [ ] Eviter fuites memoire (intervals/listeners non nettoyes).
- [ ] Durcir le parsing JSON dans `PeerManager.onMessage` (try/catch + rejet propre).
- [ ] Ajouter timeout + cleanup explicite des `pendingInitiators` (echec/abandon de negociation) pour eviter le blocage de capacite.

Validation:
- [ ] Test "start -> stop -> start" sans fuite evidente.
- [ ] Aucun crash sur trames invalides.
- [ ] Aucun `pendingInitiator` orphelin apres timeout/erreur de negotiation.

---

## Lot 5 - Corrections de coherence logique (moyen risque)

**Objectif:** fiabiliser certaines decisions deterministes sans gros redesign.

- [ ] Corriger l'election d'hote (tri deterministe robuste, pas un simple tri lexicographique).
- [ ] Clarifier le comportement de `syncStrategy` (doc + eventuel renommage non cassant).
- [ ] Encadrer les mutations d'etat exposees via `getState()` (lecture seule ou clone selon compromis perf).

Validation:
- [ ] Scenarios host migration passes.
- [ ] Documentation alignee avec le comportement reel.

---

## Lot 5bis - Securite minimale anti-spoofing (moyen risque)

**Objectif:** reduire le spoofing applicatif avant les gros chantiers reseau.

- [ ] Cote reception P2P, ne jamais faire confiance au `from` entrant: recoller l'identite transport (peer RTC) sur le message applique.
- [ ] Ajouter des guards runtime stricts sur les envelopes `NetMessage` (type, champs minimaux, rejet propre).
- [ ] Ajouter un mode debug permettant de tracer les messages rejetes (sans bruit excessif).

Validation:
- [ ] Tests d'usurpation `from` verts (message forge rejete/neutralise).
- [ ] Aucun changement d'API publique.

---

## Lot 6 - Canaux RTC differencies (impact eleve, a faire apres stabilisation)

**Objectif:** separer trafic "temps reel" et trafic "critique metier".

- [ ] Introduire un canal `unreliable` pour `move/ping`.
- [ ] Introduire un canal `reliable` pour `inventory/transfer/state_full/state_delta/payload critique`.
- [ ] Garder compatibilite transitoire avec l'ancien canal unique (phase de migration).

Validation:
- [ ] Tests de non-regression des evenements metier.
- [ ] Mesure simple des pertes sur reseau degrade (avant/apres).

---

## Lot 7 - ACK/retry pour messages critiques (impact eleve)

**Objectif:** fiabiliser la livraison applicative sans serveur autoritaire.

- [ ] Definir quels messages exigent ACK.
- [ ] Ajouter identifiants de message + table de suivi.
- [ ] Implementer retry borne + timeout + abandon explicite.
- [ ] Exposer metriques/debug de livraison.

Validation:
- [ ] Tests en conditions de perte (simulation).
- [ ] Pas de duplication fonctionnelle cote etat (idempotence).

---

## Lot 8 - Reconnexion signaling (impact eleve)

**Objectif:** rendre le client robuste aux coupures reseau.

- [ ] Reconnexion WebSocket avec backoff exponentiel + jitter.
- [ ] Rejoin room automatique.
- [ ] Resync d'etat apres reconnexion (snapshot host).

Validation:
- [ ] Test de coupure/reprise reseau sur demo.
- [ ] Pas d'explosion de connexions/duplicats apres reprise.

---

## Lot 9 - Securisation signaling/auth (impact eleve, potentiellement cassant)

**Objectif:** reduire le spoofing et preparer un usage production plus propre.

- [ ] Lier identite session/socket cote serveur (ne pas faire confiance a `from` entrant).
- [ ] Ajouter token d'auth room (JWT ou token signe) en option.
- [ ] Filtrer/valider strictement les envelopes signaling.

Validation:
- [ ] Tests d'usurpation d'identite.
- [ ] Documentation "dev vs prod" explicite.

---

## Suivi d'avancement

Utilisation proposee:
- conserver cette checklist a jour,
- ajouter un petit journal en bas apres chaque PR.

### Journal

- _(a completer au fil des lots)_

