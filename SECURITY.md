# SECURITY — Modèle de menace

Ce qui est couvert, ce qui ne l'est pas. Lu dans le code le 17/10/2026
(P28) ; chaque limite est un fait, pas une supposition.

## Couvert

- **Authentification** : JWT (`/api/auth/*`, expiration), mots de passe
  hashés bcrypt (`data/enterprise.json`, jamais en clair).
- **Durcissement HTTP** : `helmet` + `express-rate-limit` câblés dans
  `server.js` ; validation des entrées (`express-validator`).
- **Secrets** : clés de fournisseurs cloud dans le SecretStorage VSCode
  uniquement (prouvé P2 : absentes du fichier disque) ; masquage dans
  les journaux (suite P18) ; recherche de secrets code + historique
  propre en P28 (rapport de mission).
- **Agent** : sandbox **L1** toujours active (Windows : Job Object
  kill-on-close + jeton restreint + watchdog ; primitives prouvées par
  `scripts/pc-verify.ps1`). Outils fichiers confinés au projet,
  approbation requise pour les actions mutantes/hors projet (P25/P26).
- **Fournisseur cloud verrouillé par défaut** : `cloudEnabled=false`,
  liste blanche exigée, jamais de clé sur disque (P2).
- **Intégrité base avis** : `advisories.json` signé ; la clé fictive
  actuelle **refuse tout import** (P23-I8) en attendant la clé PROD.
- **Zéro télémétrie** : aucun module analytics/crash-report tiers dans
  le code (`backend`, `sudo-ai-extension/src`, `sudo-agent/src`).
- **Score projet local** : `securityScore.js` pur et déterministe,
  aucune donnée ne quitte la machine (`SECURITY_SCORING.md`).

## Non couvert (à lire avant mise en vente)

1. **Secret JWT par défaut** : sans variable `JWT_SECRET`, le backend
   utilise une valeur codée en dur (`auth.middleware.js`). En
   production : définir `JWT_SECRET` long et aléatoire.
2. **Backend exposé LAN** : écoute `0.0.0.0:5000` (le runtime IA reste
   en `127.0.0.1:6000`). Derrière un réseau non fiable : pare-feu ou
   reverse-proxy.
3. **Compte initial** : `admin` / `admin123` créé au 1er démarrage.
   Procédure : changer le mot de passe dès l'installation.
4. **Pas d'isolation L2** : la sandbox docker/Sandbox (P27) est
   supprimée ; L1 ne restreint **ni lectures/écritures disque ni réseau**
   (prouvé par les tests d'évasion `pc-verify.ps1` §8–§10).
5. **Installeur non signé** (choix P23 assumé) : SmartScreen alertera ;
   vérifier le hash publié avant installation.
6. **Données au repos non chiffrées** : `data/enterprise.json`,
   `~/.sudo_studio/*.json`, journaux — protégés par les ACL du compte
   uniquement (chiffrement disque conseillé).
7. **Cloud = sortie de données** : si l'administrateur active un
   fournisseur cloud, les prompts quittent la machine (liste blanche +
   SecretStorage limitent le risque, sans l'annuler).
8. **Dépendances non épinglées** : versions `^` dans `package.json`
   (lockfile commité, mais pas de porte d'audit automatisée en CI).
9. **Émulateur docker** : réservé admin, mais le contenu des conteneurs
   lancés relève de la responsabilité de l'opérateur.

## Signaler une faille

Contacter le propriétaire (adresse à compléter avant vente) en chiffré
si possible ; ne pas ouvrir d'issue publique pour une vulnérabilité.
Délai de correction visé : 30 jours.
