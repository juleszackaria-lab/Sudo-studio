#!/usr/bin/env bash
# SUDO STUDIO - P65-C : banc d'essai de l'agent (Linux/macOS).
#
# Deux passes, dans cet ordre :
#   1. PASSE DETERMINISTE (faux fournisseur) : 38 taches sur trois projets
#      (Next.js, Flutter, Python). Aucun modele, aucun reseau. C'est la passe
#      qui prouve que le MOTEUR fait ce qu'il annonce : fichiers attendus,
#      syntaxe valide, tests qui passent, git status propre.
#   2. PASSE REELLE (optionnelle) : --model <fichier.gguf|id> lance les MEMES
#      taches contre le modele charge dans le runtime local. C'est la seule
#      passe qui donne des jetons/seconde et une note de qualite reelle.
#
# Usage :
#   scripts/agent-bench.sh                          # passe deterministe seule
#   scripts/agent-bench.sh --model qwen2.5-coder-1.5b-q4_k_m.gguf
#   scripts/agent-bench.sh --model <id> --url http://127.0.0.1:6000
#   scripts/agent-bench.sh --only M                 # sous-ensemble (prefixe)
#
# Sorties : bench-results/agent-bench-report.json (passe 1),
#           bench-results/agent-bench-reel.json    (passe 2).
# Code retour : 0 = tout ce qui a ete demande a reussi, 1 = echec, 2 = modele
# demande mais runtime injoignable (mesure reelle NON MESUREE, ecrit tel quel).
# ASCII only.

set -u

MODEL=""
URL="http://127.0.0.1:6000"
ONLY=""
OUTDIR="bench-results"
mkdir -p "$OUTDIR"

while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODEL="${2:-}"; shift 2 ;;
    --url)   URL="${2:-}"; shift 2 ;;
    --only)  ONLY="${2:-}"; shift 2 ;;
    --out)   OUTDIR="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "[FAIL] option inconnue : $1" >&2; exit 1 ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
BENCH="$HERE/ci/agent-bench.js"
if [ ! -f "$BENCH" ]; then echo "[FAIL] banc introuvable : $BENCH" >&2; exit 1; fi
if ! command -v node >/dev/null 2>&1; then echo "[FAIL] node absent du PATH" >&2; exit 1; fi

ONLY_ARG=""
if [ -n "$ONLY" ]; then ONLY_ARG="--only $ONLY"; fi

echo "=== PASSE 1/2 : deterministe (faux fournisseur, sans modele) ==="
# shellcheck disable=SC2086
node "$BENCH" $ONLY_ARG --json "$OUTDIR/agent-bench-report.json"
RC1=$?
if [ $RC1 -ne 0 ]; then
  echo "[FAIL] la passe deterministe est rouge (code $RC1) : aucun resultat reel ne peut la masquer." >&2
  exit 1
fi

if [ -z "$MODEL" ]; then
  echo ""
  echo "Passe 2 NON DEMANDEE : aucun modele fourni (--model)."
  echo "Les jetons/seconde, la RAM du runtime et la qualite reelle d'un modele"
  echo "restent donc NON MESURES. Relancer avec --model pour les obtenir."
  exit 0
fi

echo ""
echo "=== PASSE 2/2 : modele reel '$MODEL' via $URL ==="
if ! command -v curl >/dev/null 2>&1; then
  echo "[FAIL] curl absent : impossible de verifier le runtime." >&2
  exit 2
fi
if ! curl -fsS --max-time 5 "$URL/v1/models" >"$OUTDIR/runtime-models.json" 2>/dev/null; then
  echo "[NON MESURE] runtime injoignable sur $URL/v1/models." >&2
  echo "  Demarrer le runtime du produit (server.exe / serveur local) avec le modele" >&2
  echo "  '$MODEL' charge, puis relancer cette commande. Rien n'est invente ici." >&2
  exit 2
fi
echo "runtime joignable ; modeles annonces :"
cat "$OUTDIR/runtime-models.json"
echo ""

# shellcheck disable=SC2086
node "$BENCH" $ONLY_ARG --real "$URL" --model "$MODEL" --json "$OUTDIR/agent-bench-reel.json"
RC2=$?
if [ $RC2 -ne 0 ]; then
  echo "[FAIL] la passe reelle est rouge (code $RC2)." >&2
  exit 1
fi
echo ""
echo "Rapports : $OUTDIR/agent-bench-report.json (deterministe) et $OUTDIR/agent-bench-reel.json (reel)."
exit 0
