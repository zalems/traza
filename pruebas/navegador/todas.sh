#!/usr/bin/env bash
# Corre todas las pruebas en navegador (escritorio, teléfono y modo oscuro) y dice cuáles fallaron.
cd "$(dirname "$0")" || exit 1
fallas=0
for t in "humo.mjs" "olt.mjs" "olt.mjs movil" "olt.mjs movil oscuro" "olt-historia.mjs" "olt-historia.mjs movil" "regresion.mjs" "regresion.mjs movil"; do
  a=$(date +%s)
  # shellcheck disable=SC2086
  salida="$(node $t 2>&1)"; rc=$?
  printf '%-26s %s (%s s)\n' "$t" "$([[ $rc == 0 ]] && echo bien || echo FALLA)" "$(( $(date +%s) - a ))"
  if [[ $rc != 0 ]]; then fallas=$((fallas + 1)); printf '%s\n' "$salida" | grep -v "^  ok" | head -14; fi
done
echo "fallas: $fallas"
[[ $fallas == 0 ]]
