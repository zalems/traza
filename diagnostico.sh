#!/usr/bin/env bash
#
# diagnostico.sh: muestra cómo está el servidor antes de instalar. Solo lee;
# no cambia nada. Con sudo también informa qué proceso usa cada puerto.
#
#   sudo ./diagnostico.sh
#
set -uo pipefail

sec()  { printf '\n== %s\n' "$*"; }
row()  { printf '   %-22s %s\n' "$1" "$2"; }
have() { command -v "$1" >/dev/null 2>&1; }

sec "Sistema"
# shellcheck disable=SC1091
[[ -r /etc/os-release ]] && . /etc/os-release
row "Sistema operativo" "${PRETTY_NAME:-desconocida}"
row "Kernel" "$(uname -r) ($(uname -m))"
have systemd-detect-virt && row "Entorno virtual" "$(systemd-detect-virt 2>/dev/null || echo ninguna)"
row "Init" "$(ps -p 1 -o comm= 2>/dev/null || echo desconocido)"
row "Hora (UTC)" "$(date -u '+%Y-%m-%d %H:%M:%S')"
have timedatectl && row "Reloj sincronizado" "$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo desconocido)"
row "Usuario" "$(id -un) (uid $EUID)"

sec "Recursos"
row "CPU" "$(nproc 2>/dev/null || echo '?') núcleos"
row "Memoria" "$(awk '/MemTotal/ { t = $2 } /MemAvailable/ { a = $2 } END { printf "%.1f GB en total, %.1f GB disponibles", t / 1048576, a / 1048576 }' /proc/meminfo)"
for dir in / /srv /var; do
  [[ -d "$dir" ]] && row "Disco $dir" "$(df -Ph "$dir" | awk 'NR == 2 { print $4 " libres de " $2 " (" $6 ")" }')"
done

sec "Red"
row "Nombre" "$(hostname -f 2>/dev/null || hostname)"
if have ip; then
  ip -br addr show scope global 2>/dev/null | awk '{ printf "   %-22s %s\n", "Interfaz " $1, substr($0, index($0, $3)) }'
  row "Salida por defecto" "$(ip route show default 2>/dev/null | head -n1 || true)"
fi
row "IPv6" "$([[ -e /proc/net/if_inet6 ]] && echo disponible || echo 'no disponible')"

sec "Puertos web en escucha"
if have ss; then
  found=0
  for port in 80 443 8080 8900; do
    line="$(ss -H -ltnp "sport = :$port" 2>/dev/null | head -n1)"
    if [[ -n "$line" ]]; then
      found=1
      proc="$(sed -nE 's/.*users:\(\("([^"]+)".*/\1/p' <<<"$line")"
      row "Puerto $port" "en uso${proc:+ por $proc}$([[ $EUID -ne 0 && -z "$proc" ]] && echo ' (con sudo se ve qué proceso)')"
    else
      row "Puerto $port" "libre"
    fi
  done
  (( found )) || true
else
  row "ss" "no está instalado (paquete iproute2)"
fi

sec "Servidores web"
if have nginx; then
  row "nginx" "$(nginx -v 2>&1 | sed 's/^nginx version: //')"
  for dir in /etc/nginx/sites-enabled /etc/nginx/conf.d; do
    [[ -d "$dir" ]] || continue
    for f in "$dir"/*; do
      [[ -e "$f" ]] || continue
      names="$(grep -hE '^\s*server_name' "$f" 2>/dev/null | sed -E 's/^\s*server_name\s+//; s/;.*$//' | sort -u | tr '\n' ' ')"
      row "  sitio" "$(basename "$f")${names:+: $names}"
    done
  done
else
  row "nginx" "no instalado"
fi
if have apache2 || have httpd; then
  row "Apache" "$( (apache2 -v 2>/dev/null || httpd -v 2>/dev/null) | head -n1 | sed 's/^Server version: //')"
  [[ -d /etc/apache2/sites-enabled ]] && row "  sitios" "$(ls /etc/apache2/sites-enabled 2>/dev/null | tr '\n' ' ')"
else
  row "Apache" "no instalado"
fi
have caddy && row "Caddy" "$(caddy version 2>/dev/null | head -n1)"
have lighttpd && row "lighttpd" "instalado"
if have docker; then
  row "Docker" "$(docker --version 2>/dev/null | sed 's/^Docker version //')"
  docker ps --format '{{.Names}}  {{.Ports}}' 2>/dev/null | grep -E ':(80|443|8080)->' | sed 's/^/   contenedor             /' || true
fi

sec "Herramientas que usa la instalación"
for cmd in curl tar sha256sum sed find awk flock runuser python3 apt-get certbot git; do
  row "$cmd" "$(have "$cmd" && echo sí || echo no)"
done

sec "Salida a internet"
if have curl; then
  for url in "https://build-metadata.protomaps.dev/builds.json" "https://build.protomaps.com/" "https://github.com/protomaps/go-pmtiles/releases"; do
    code="$(curl -sS -o /dev/null --max-time 15 -w '%{http_code}' -L "$url" 2>/dev/null || true)"
    case "$code" in
      000|"") row "${url#https://}" "sin respuesta" ;;
      *)      row "${url#https://}" "responde (HTTP $code)" ;;
    esac
  done
else
  row "curl" "no está instalado: no se pudo probar"
fi

sec "Instalación previa"
if [[ -d /srv/ftth ]]; then
  row "/srv/ftth" "existe"
  [[ -L /srv/ftth/web ]] && row "  visor" "$(readlink /srv/ftth/web)"
  [[ -f /srv/ftth/tiles/basemap.json ]] && row "  mapa de calles" "$(sed -nE 's/.*"file"[^"]*"([^"]*)".*/\1/p' /srv/ftth/tiles/basemap.json)"
  if [[ -d /run/systemd/system ]] && have systemctl; then
    row "  servicio de sesión" "ftth-auth: $(systemctl is-active ftth-auth 2>/dev/null || true)"
  fi
  if have curl; then
    code="$(curl -sS -o /dev/null --max-time 5 --noproxy '*' -w '%{http_code}' "http://127.0.0.1:${FTTH_AUTH_PORT:-8900}/auth/health" 2>/dev/null || true)"
    row "  login (puerto ${FTTH_AUTH_PORT:-8900})" "$([[ "$code" == 200 ]] && echo responde || echo 'no responde')"
  fi
  if [[ $EUID -eq 0 && -x /srv/ftth/bin/usuarios ]]; then
    n="$(/srv/ftth/bin/usuarios listar 2>/dev/null | grep -c . || true)"
    row "  usuarios del login" "$n"
  fi
else
  row "/srv/ftth" "no existe (instalación nueva)"
fi
echo
