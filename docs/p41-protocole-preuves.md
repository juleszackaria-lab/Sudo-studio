# P41 - Protocole de preuves PC (projet "maquis pos")

But : fournir les preuves exigees par la mission P41 pour passer le
verdict de PARTIEL a SUCCESS. Tout est read-only (aucune modification
du projet scanne). Duree estimee : 10 minutes.

Pre-requis : Node.js + le depot Sudo-studio a jour (commit P41).

---

## Preuve 1 - Avant/apres sur "maquis pos" (nombres par gravite)

Dans le dossier du depot, lancer (remplacer le chemin) :

```
node scripts/security-scan.js "C:\chemin\vers\maquis pos" --before
node scripts/security-scan.js "C:\chemin\vers\maquis pos"
```

A coller : les DEUX sorties completes. Attendu :
- les 3 vrais constats de .env.local (AUTH_SECRET, VERCEL_OIDC_TOKEN,
  URL postgres) presents dans les DEUX sorties ;
- mode AVANT : bruit present (.next, .js.map, alphabet SQL,
  WHATSAPP_TOKEN, CRITICAL partout) ;
- mode APRES : bruit elimine, dossiers generes comptes
  ("generes ignores : N"), CRITICAL reserves aux vrais secrets.

## Preuve 2 - Detail JSON (optionnel mais utile)

```
node scripts/security-scan.js "C:\chemin\vers\maquis pos" --json > apres.json
node scripts/security-scan.js "C:\chemin\vers\maquis pos" --before --json > avant.json
```

A coller : les deux lignes "visible / bySeverity / hiddenLowConfidence"
(extraites des fichiers, pas besoin de tout coller). Les extraits sont
expurges ([REDACTED]) : aucun secret ne peut fuiter.

## Preuve 3 - Panneau Security (sans capture d'ecran)

1. Ouvrir le projet "maquis pos" dans VS Code + Sudo Studio.
2. Ouvrir le panneau Security Audit, cliquer Refresh.
3. Relever : nombre de constats visibles, badges CONF:HIGH/MEDIUM
   affiches, ligne "N finding(s) hidden (low confidence)" si presente,
   ligne "N generated folder(s) skipped".
4. Cliquer "Export secrets (JSON)", verifier que le fichier contient
   "secretsHidden" et aucun secret en clair.

A coller : les 4 infos du point 3 + "export OK / KO".

---

## Echec = preuve aussi

Si un VRAI secret disparait en mode APRES (faux negatif), c'est une
preuve : coller la ligne concernee en MASQUANT la valeur
(ex : `MA_CLE=sk-[CACHE]`), je corrige. Regle P41 : les vrais secrets
doivent TOUJOURS etre trouves.
