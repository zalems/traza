#!/usr/bin/env bash
#
# desinstalar.sh: quita el sitio de nginx que agregó instalar.sh.
#
#   sudo ./desinstalar.sh                    quita el sitio; deja los archivos
#   sudo ./desinstalar.sh --borrar-datos     además borra la carpeta de instalación
#   sudo ./desinstalar.sh --raiz /otra/ruta  si se instaló con --raiz
#
# No desinstala nginx ni toca otros sitios.
#
set -Eeuo pipefail

APP="ftth"
ROOT="/srv/$APP"
PURGE=0

die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

while (($#)); do
  case "$1" in
    --borrar-datos) PURGE=1; shift ;;
    --raiz) [[ $# -ge 2 ]] || die "--raiz necesita un valor."; ROOT="${2%/}"; shift 2 ;;
    -h|--ayuda|--help) sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Opción desconocida: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Hace falta root: ejecutá con sudo."
[[ "$ROOT" == /* && "$ROOT" != "/" ]] || die "--raiz tiene que ser una ruta absoluta distinta de /."

# Servicios del kit: sesión (login) y API de la red
for svc in "$APP-auth" "$APP-api"; do
  if [[ -f "/etc/systemd/system/$svc.service" ]]; then
    if [[ -d /run/systemd/system ]]; then
      systemctl disable --now "$svc.service" >/dev/null 2>&1 || true
    fi
    rm -f "/etc/systemd/system/$svc.service"
    [[ -d /run/systemd/system ]] && systemctl daemon-reload
    echo "   quitado el servicio $svc"
  fi
done

removed=0
for f in "/etc/nginx/sites-enabled/$APP.conf" "/etc/nginx/sites-available/$APP.conf" "/etc/nginx/conf.d/$APP.conf" \
         "/etc/nginx/$APP-api-secreto.inc"; do
  if [[ -e "$f" || -L "$f" ]]; then
    rm -f "$f"
    echo "   quitado $f"
    removed=1
  fi
done

if (( removed )) && command -v nginx >/dev/null; then
  nginx -t >/dev/null 2>&1 || die "nginx no valida su configuración después de quitar el sitio. Revisá: nginx -t"
  if [[ -d /run/systemd/system ]] && systemctl is-active --quiet nginx; then
    systemctl reload nginx && echo "   nginx recargado"
  elif [[ ! -d /run/systemd/system && -s /run/nginx.pid ]] && kill -0 "$(cat /run/nginx.pid)" 2>/dev/null; then
    nginx -s reload 2>/dev/null && echo "   nginx recargado"
  else
    echo "   nginx no está corriendo: no hay nada que recargar"
  fi
elif (( ! removed )); then
  echo "   no había sitio de nginx para quitar"
fi

if (( PURGE )); then
  # Solo se borra lo que creó instalar.sh, y solo en una carpeta marcada por él.
  [[ -f "$ROOT/.ftth-kit" ]] || die "$ROOT no tiene la marca de una instalación de este kit: no borro nada."
  for entry in web web.nuevo bin tiles config releases acme backups auth api data .lock .ftth-kit; do
    rm -rf "${ROOT:?}/$entry"
  done
  rm -rf "${ROOT:?}"/.tmp.*
  if rmdir "$ROOT" 2>/dev/null; then
    echo "   borrada $ROOT"
  else
    echo "   borrado el contenido del kit; $ROOT queda porque tiene otros archivos"
  fi
  if id ftth >/dev/null 2>&1; then
    userdel ftth 2>/dev/null && echo "   quitado el usuario del sistema ftth"
  fi
else
  echo "   los archivos siguen en $ROOT (para borrarlos: --borrar-datos)"
fi
