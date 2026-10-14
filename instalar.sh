#!/usr/bin/env bash
#
# instalar.sh: instala o actualiza la plataforma FTTH (mapa, login y red).
#
# Es idempotente. Cada paso mira cómo está el servidor y cambia solo lo que
# falta, así que se puede ejecutar las veces que haga falta. Agrega un único
# sitio a nginx y no toca los que ya existan.
#
#   sudo ./instalar.sh                         prueba en http://IP-del-servidor:8080
#   sudo ./instalar.sh --dominio mapa.ejemplo.com.ar
#   sudo ./instalar.sh --simular               muestra lo que haría, sin cambiar nada
#   sudo ./instalar.sh --ayuda
#
set -Eeuo pipefail
umask 022

# ----------------------------------------------------------------- constantes

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_VERSION="$(tr -d '[:space:]' < "$KIT_DIR/VERSION")"

APP="ftth"
ROOT="/srv/$APP"

# Servicio de sesión (login): corre como este usuario del sistema, escucha solo
# en esta máquina y nginx le consulta cada pedido.
AUTH_USER="ftth"
AUTH_PORT="${FTTH_AUTH_PORT:-8900}"
API_PORT="${FTTH_API_PORT:-8901}"

# Herramienta que recorta el mapa (https://github.com/protomaps/go-pmtiles).
PMTILES_VERSION="1.31.2"
PMTILES_SHA256_X86_64="3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f"
PMTILES_SHA256_ARM64="f8bd47e7ea866863489cad588fbaf2f31f42e5821f7a03f009b3769f05801cb1"

# Mapa de calles: builds diarios del planeta que publica Protomaps a partir de
# OpenStreetMap. Este kit trae el estilo para el esquema de mosaicos v4.
BUILDS_INDEX="https://build-metadata.protomaps.dev/builds.json"
BUILDS_BASE="https://build.protomaps.com"
TILESET_MAJOR="4"

# Argentina continental con margen: entran también Uruguay, Chile, Paraguay y
# las zonas de frontera de Brasil y Bolivia.
BBOX="-73.60,-55.10,-53.60,-21.75"
MAP_LABEL="argentina"

# ------------------------------------------------------------------- opciones

DOMAIN=""
PORT=""
BUILD=""
UPDATE_MAP=0
SKIP_MAP=0
SKIP_NGINX=0
SIMULATE=0
ROLLBACK=0
ROLLBACK_MAP=0

usage() {
  cat <<EOF
Uso: sudo ./instalar.sh [opciones]

  --dominio NOMBRE      Nombre con el que se va a entrar (ej. mapa.ejemplo.com.ar).
                        Publica en el puerto 80 y, si ya existe un certificado de
                        Let's Encrypt para ese nombre, también en 443 con HTTPS.
  --puerto N            Puerto HTTP. Sin --dominio el valor por defecto es 8080.
                        Con --dominio sirve para quedar detrás de otro proxy
                        (en ese caso este script no configura HTTPS).
  --bbox O,S,E,N        Zona del mapa de calles (por defecto: $BBOX).
  --nombre-mapa TEXTO   Etiqueta de esa zona para el nombre del archivo (por defecto: $MAP_LABEL).
  --build AAAAMMDD      Build del mapa a usar (por defecto: el más nuevo).
  --actualizar-mapa     Baja el build más nuevo aunque ya haya un mapa instalado.
  --sin-mapa            No descarga ni actualiza el mapa de calles.
  --sin-nginx           No toca nginx: solo deja los archivos en --raiz.
  --raiz DIR            Carpeta de instalación (por defecto: $ROOT).
  --volver              Vuelve a la versión anterior del visor y termina.
  --volver-mapa         Vuelve al mapa de calles anterior y termina.
  --simular             Muestra lo que haría, sin cambiar nada.
  --ayuda               Muestra esta ayuda.
EOF
}

need_value() { [[ $# -ge 2 && -n "$2" ]] || die "La opción $1 necesita un valor."; }

# ------------------------------------------------------------------- mensajes

if [[ -t 1 ]]; then B=$'\e[1m'; R=$'\e[0m'; else B=""; R=""; fi
step() { printf '\n%s== %s%s\n' "$B" "$*" "$R"; }
info() { printf '   %s\n' "$*"; }
ok()   { printf '   ok  %s\n' "$*"; }
warn() { printf '   !!  %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
sim()  { printf '   [simulación] %s\n' "$*"; }

WORK=""
cleanup() { [[ -n "$WORK" && -d "$WORK" ]] && rm -rf "$WORK"; return 0; }
trap cleanup EXIT
trap 'die "Falló la línea $LINENO: $BASH_COMMAND"' ERR

# Se aceptan las dos formas: "--opcion valor" y "--opcion=valor".
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == --*=* ]]; then ARGS+=("${arg%%=*}" "${arg#*=}"); else ARGS+=("$arg"); fi
done
set -- "${ARGS[@]}"

while (($#)); do
  case "$1" in
    --dominio)         need_value "$@"; DOMAIN="$2"; shift 2 ;;
    --puerto)          need_value "$@"; PORT="$2"; shift 2 ;;
    --bbox)            need_value "$@"; BBOX="$2"; shift 2 ;;
    --nombre-mapa)     need_value "$@"; MAP_LABEL="$2"; shift 2 ;;
    --build)           need_value "$@"; BUILD="$2"; shift 2 ;;
    --raiz)            need_value "$@"; ROOT="${2%/}"; shift 2 ;;
    --actualizar-mapa) UPDATE_MAP=1; shift ;;
    --sin-mapa)        SKIP_MAP=1; shift ;;
    --sin-nginx)       SKIP_NGINX=1; shift ;;
    --volver)          ROLLBACK=1; shift ;;
    --volver-mapa)     ROLLBACK_MAP=1; shift ;;
    --simular)         SIMULATE=1; shift ;;
    -h|--ayuda|--help) usage; exit 0 ;;
    *) usage >&2; die "Opción desconocida: $1" ;;
  esac
done

# ---------------------------------------------------------------- validaciones

[[ "$ROOT" =~ ^/[A-Za-z0-9._/-]+$ && "$ROOT" != *..* ]] || die "--raiz tiene que ser una ruta absoluta sin espacios ni caracteres especiales."
[[ "$BBOX" =~ ^-?[0-9]+(\.[0-9]+)?(,-?[0-9]+(\.[0-9]+)?){3}$ ]] || die "--bbox tiene que ser oeste,sur,este,norte en grados decimales."
[[ "$MAP_LABEL" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "--nombre-mapa admite minúsculas, números y guiones."
[[ -z "$BUILD" || "$BUILD" =~ ^[0-9]{8}$ ]] || die "--build tiene que ser una fecha AAAAMMDD."
[[ -z "$DOMAIN" || "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || die "--dominio no parece un nombre de host válido."
[[ -z "$PORT" || ( "$PORT" =~ ^[1-9][0-9]{0,4}$ && "$PORT" -le 65535 ) ]] || die "--puerto tiene que estar entre 1 y 65535."
# certbot guarda los certificados con el nombre en minúsculas.
DOMAIN="${DOMAIN,,}"

# La carpeta de instalación es propia: se crea para esto y desinstalar.sh la borra entera.
case "$ROOT" in
  /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/usr/local|/var|/var/lib|/var/www)
    die "--raiz no puede ser $ROOT: tiene que ser una carpeta propia de esta instalación, por ejemplo /srv/ftth." ;;
esac

if [[ $EUID -ne 0 ]]; then
  (( SIMULATE )) || die "Hace falta root: ejecutá con sudo (o probá antes con --simular)."
  printf '   (sin root la simulación no ve certificados ni qué proceso usa cada puerto)\n'
fi

# Con dominio y sin puerto explícito: 80 y, si hay certificado, 443.
# Sin dominio: un puerto propio para no chocar con el sitio por defecto de nginx.
TLS_CAPABLE=0
if [[ -n "$DOMAIN" && -z "$PORT" ]]; then
  PORT=80
  TLS_CAPABLE=1
fi
PORT="${PORT:-8080}"
SERVER_NAME="${DOMAIN:-_}"
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"

PM="$ROOT/bin/pmtiles"
MANIFEST="$ROOT/tiles/basemap.json"
SOURCE=""   # URL del build elegido; la fija install_basemap

fetch() { curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 "$@"; }

manifest_value() { # manifest_value clave [archivo] -> valor de una clave de texto del manifiesto
  local file="${2:-$MANIFEST}"
  [[ -f "$file" ]] || return 0
  sed -nE "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\1/p" "$file" | head -n1
}

# known_bbox_of ARCHIVO -> zona registrada para ese archivo en el manifiesto en uso o el anterior
known_bbox_of() {
  local m
  for m in "$MANIFEST" "$ROOT/tiles/basemap.anterior.json"; do
    if [[ "$(manifest_value file "$m")" == "$1" ]]; then manifest_value bbox "$m"; return; fi
  done
}

# --------------------------------------------------------- volver a la anterior

rollback_web() {
  step "Volver a la versión anterior del visor"
  local prev_file="$ROOT/releases/.anterior" prev current
  [[ -f "$prev_file" ]] || die "No hay una versión anterior registrada en $ROOT/releases."
  prev="$(<"$prev_file")"
  [[ -d "$ROOT/releases/$prev" ]] || die "La versión anterior ($prev) ya no está en $ROOT/releases."
  [[ -L "$ROOT/web" ]] || die "$ROOT/web no es un enlace a una versión del visor."
  current="$(basename "$(readlink "$ROOT/web")")"
  [[ -n "$current" && "$current" != "$prev" ]] || die "El visor ya está en $prev."
  if (( SIMULATE )); then sim "web -> releases/$prev (hoy: $current)"; return; fi
  ln -sfn "releases/$prev" "$ROOT/web.nuevo"
  mv -T "$ROOT/web.nuevo" "$ROOT/web"
  printf '%s\n' "$current" > "$prev_file"
  ok "Visor en $prev (antes: $current). Ejecutar --volver otra vez deshace el cambio."
}

rollback_map() {
  step "Volver al mapa de calles anterior"
  local prev="$ROOT/tiles/basemap.anterior.json" file
  [[ -f "$prev" ]] || die "No hay un mapa anterior registrado en $ROOT/tiles."
  file="$(manifest_value file "$prev")"
  [[ -n "$file" && -s "$ROOT/tiles/$file" ]] || die "El archivo del mapa anterior ($file) ya no está en $ROOT/tiles."
  if (( SIMULATE )); then sim "el visor pasa a usar $file (hoy: $(manifest_value file))"; return; fi
  cp -a "$MANIFEST" "$MANIFEST.cambio"
  mv -f "$prev" "$MANIFEST"
  mv -f "$MANIFEST.cambio" "$prev"
  ok "El visor usa $file. Ejecutar --volver-mapa otra vez deshace el cambio."
}

if (( ROLLBACK )); then rollback_web; exit 0; fi
if (( ROLLBACK_MAP )); then rollback_map; exit 0; fi

# ------------------------------------------------------------- 1. chequeos previos

step "1/7 Chequeos previos"

[[ -f "$KIT_DIR/web/index.html" ]] || die "No encuentro web/index.html junto a este script."
info "Kit $KIT_VERSION en $KIT_DIR"
info "Instalación en $ROOT"

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  info "Sistema: ${PRETTY_NAME:-desconocido} ($(uname -m))"
fi

case "$(uname -m)" in
  x86_64|amd64)  PM_ARCH="x86_64"; PM_SHA="$PMTILES_SHA256_X86_64" ;;
  aarch64|arm64) PM_ARCH="arm64";  PM_SHA="$PMTILES_SHA256_ARM64" ;;
  *) die "Arquitectura $(uname -m) no soportada (hace falta x86_64 o arm64)." ;;
esac

for cmd in tar sha256sum sed find flock runuser; do
  command -v "$cmd" >/dev/null || die "Falta el comando '$cmd'. En Debian/Ubuntu: apt-get install -y tar coreutils sed findutils util-linux"
done
# curl y python3 faltan en un contenedor recién creado: se instalan en el paso 2.
NEED_CURL=0;   command -v curl    >/dev/null || NEED_CURL=1
NEED_PYTHON=0; command -v python3 >/dev/null || NEED_PYTHON=1

HAVE_NGINX=0
command -v nginx >/dev/null && HAVE_NGINX=1
INSTALLED_NGINX=0   # pasa a 1 si nginx lo instala este mismo script

nginx_running() {
  if [[ -d /run/systemd/system ]]; then systemctl is-active --quiet nginx
  else [[ -s /run/nginx.pid ]] && kill -0 "$(cat /run/nginx.pid)" 2>/dev/null; fi
}

# ¿Algún otro sitio de nginx (no el de este kit) escucha en el puerto?
other_site_listens() {
  local f
  for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
    [[ -e "$f" && "$(basename "$f")" != "$APP.conf" ]] || continue
    grep -qsE "^[[:space:]]*listen[[:space:]]+([^;]*:)?$1([[:space:]]|;)" "$f" && return 0
  done
  return 1
}

port_owner() { # port_owner PUERTO -> nombre del proceso que escucha, o vacío
  command -v ss >/dev/null || return 0
  ss -H -ltnp "sport = :$1" 2>/dev/null | sed -nE 's/.*users:\(\("([^"]+)".*/\1/p' | head -n1
}
port_busy() {
  command -v ss >/dev/null || return 1
  [[ -n "$(ss -H -ltn "sport = :$1" 2>/dev/null)" ]]
}

if (( SKIP_NGINX == 0 )); then
  if (( HAVE_NGINX )); then
    info "nginx: $(nginx -v 2>&1 | sed 's/^nginx version: //')"
    nginx -V 2>&1 | grep -q 'http_auth_request_module' \
      || die "Este nginx no trae el módulo auth_request, que hace falta para el login. En Debian/Ubuntu: apt-get install -y nginx (versión completa)."
    if ! nginx_running && [[ $EUID -eq 0 ]]; then
      die "nginx está instalado pero detenido. Este script no lo inicia por su cuenta: puede estar parado a propósito.
       Si corresponde, iniciarlo con: systemctl start nginx   (y revisar: journalctl -u nginx -n 30)"
    fi
  else
    command -v apt-get >/dev/null || die "nginx no está instalado y este script solo sabe instalarlo con apt. Instalalo a mano o usá --sin-nginx."
    if port_busy 80; then
      die "nginx no está instalado y el puerto 80 ya lo usa otro servicio ($(port_owner 80 || true)).
       No instalo nginx encima de otro servidor web. Opciones:
         a) usar una máquina o contenedor limpio para esta plataforma (recomendado), o
         b) ejecutar con --sin-nginx y publicar $ROOT desde el servidor web que ya tenés."
    fi
    info "nginx: no está instalado; se instala con apt"
  fi

  # Un puerto ocupado por algo que no es nginx no se puede compartir.
  for p in "$PORT" $( ((TLS_CAPABLE)) && echo 443 ); do
    owner="$(port_owner "$p" || true)"
    if port_busy "$p" && [[ -n "$owner" && "$owner" != nginx ]]; then
      die "El puerto $p ya lo usa '$owner'. Elegí otro con --puerto o usá --sin-nginx."
    fi
  done
  owner="$(port_owner "$AUTH_PORT" || true)"
  if port_busy "$AUTH_PORT" && [[ "$owner" != python3 ]]; then
    die "El puerto $AUTH_PORT (servicio de sesión) ya lo usa '${owner:-otro proceso}'. Se puede cambiar con la variable FTTH_AUTH_PORT."
  fi
  owner="$(port_owner "$API_PORT" || true)"
  if port_busy "$API_PORT" && [[ "$owner" != python3 ]]; then
    die "El puerto $API_PORT (API de la red) ya lo usa '${owner:-otro proceso}'. Se puede cambiar con la variable FTTH_API_PORT."
  fi
  # Sin dominio el sitio responde a cualquier nombre: necesita el puerto para él solo.
  if [[ -z "$DOMAIN" ]] && other_site_listens "$PORT"; then
    die "En el puerto $PORT ya escucha otro sitio de nginx. Elegí otro con --puerto o indicá --dominio para convivir por nombre."
  fi
fi
ok "Chequeos previos superados"

# ----------------------------------------------------------- 2. carpetas y nginx

step "2/7 Carpetas y paquetes"

DIRS=("$ROOT" "$ROOT/bin" "$ROOT/tiles" "$ROOT/config" "$ROOT/releases" "$ROOT/acme" "$ROOT/backups" "$ROOT/auth" "$ROOT/api" "$ROOT/data")
if [[ -d "$ROOT" && ! -f "$ROOT/.ftth-kit" && ! ( -d "$ROOT/releases" && -d "$ROOT/tiles" ) && -n "$(ls -A "$ROOT" 2>/dev/null)" ]]; then
  die "La carpeta $ROOT ya existe con contenido ajeno a este kit. Elegí una carpeta propia con --raiz."
fi
if (( SIMULATE )); then
  sim "crear si faltan: ${DIRS[*]}"
else
  mkdir -p "${DIRS[@]}"
  printf 'kit %s\n' "$KIT_VERSION" > "$ROOT/.ftth-kit"
  # Una ejecución por vez.
  exec 9>"$ROOT/.lock"
  flock -n 9 || die "Ya hay otra ejecución de instalar.sh en curso sobre $ROOT."
  # Restos de ejecuciones interrumpidas.
  rm -rf "$ROOT"/.tmp.* "$ROOT"/releases/.*.parcial
  rm -f "$ROOT"/tiles/*.parcial
  WORK="$(mktemp -d "$ROOT/.tmp.XXXXXX")"
  ok "Carpetas en $ROOT"
fi

PACKAGES=()
(( SKIP_NGINX == 0 && HAVE_NGINX == 0 )) && PACKAGES+=(nginx)
(( NEED_CURL )) && PACKAGES+=(curl ca-certificates)
(( NEED_PYTHON )) && PACKAGES+=(python3)
if (( ${#PACKAGES[@]} )); then
  if (( SIMULATE )); then
    sim "apt-get install -y ${PACKAGES[*]}"
  else
    command -v apt-get >/dev/null || die "Faltan paquetes (${PACKAGES[*]}) y este script solo sabe instalarlos con apt."
    info "Instalando ${PACKAGES[*]}…"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${PACKAGES[@]}" >/dev/null
    if (( HAVE_NGINX == 0 && SKIP_NGINX == 0 )); then
      HAVE_NGINX=1
      INSTALLED_NGINX=1
      nginx -V 2>&1 | grep -q 'http_auth_request_module' || die "El nginx instalado no trae el módulo auth_request."
    fi
    ok "Paquetes instalados: ${PACKAGES[*]}"
  fi
fi

# ------------------------------------------------------------- 3. mapa de calles

step "3/7 Mapa de calles (OpenStreetMap)"

install_pmtiles() {
  local marker="$ROOT/bin/.pmtiles-version"
  if [[ -x "$PM" && -f "$marker" && "$(<"$marker")" == "$PMTILES_VERSION" ]]; then
    ok "pmtiles $PMTILES_VERSION ya está instalado"
    return
  fi
  local url="${PMTILES_URL:-https://github.com/protomaps/go-pmtiles/releases/download/v$PMTILES_VERSION/go-pmtiles_${PMTILES_VERSION}_Linux_${PM_ARCH}.tar.gz}"
  local sha="${PMTILES_SHA256:-$PM_SHA}"
  if (( SIMULATE )); then sim "descargar pmtiles $PMTILES_VERSION desde $url"; return; fi
  info "Descargando pmtiles $PMTILES_VERSION…"
  fetch -o "$WORK/pmtiles.tar.gz" "$url" || die "No se pudo descargar $url"
  if ! printf '%s  %s\n' "$sha" "$WORK/pmtiles.tar.gz" | sha256sum -c --status -; then
    die "La descarga de pmtiles no coincide con la suma SHA-256 esperada.
       esperada: $sha
       obtenida: $(sha256sum "$WORK/pmtiles.tar.gz" | cut -d' ' -f1)
       pmtiles no se instaló. Revisá la conexión o un proxy que altere descargas."
  fi
  tar -xzf "$WORK/pmtiles.tar.gz" -C "$WORK" pmtiles 2>/dev/null \
    || die "El paquete descargado no trae el ejecutable 'pmtiles'. ¿Cambió el formato de la versión $PMTILES_VERSION?"
  install -m 0755 "$WORK/pmtiles" "$PM"
  printf '%s\n' "$PMTILES_VERSION" > "$marker"
  ok "pmtiles $PMTILES_VERSION instalado en $PM"
}

# Elige el build: el pedido con --build o el más nuevo del esquema que este kit entiende.
choose_build() {
  local index entry
  index="$(fetch "$BUILDS_INDEX")" || die "No se pudo leer la lista de builds ($BUILDS_INDEX)."
  if [[ -n "$BUILD" ]]; then
    entry="$(grep -oE "\{\"key\":\"$BUILD\.pmtiles\"[^}]*\}" <<<"$index" || true)"
    [[ -n "$entry" ]] || die "El build $BUILD no figura en la lista de Protomaps."
    grep -q "\"version\":\"$TILESET_MAJOR\." <<<"$entry" \
      || die "El build $BUILD no usa el esquema v$TILESET_MAJOR, que es el que este kit sabe dibujar."
    printf '%s\n' "$BUILD"
    return
  fi
  entry="$(grep -oE '\{"key":"[0-9]{8}\.pmtiles"[^}]*\}' <<<"$index" \
    | grep "\"version\":\"$TILESET_MAJOR\." | grep -oE '"key":"[0-9]{8}' | grep -oE '[0-9]{8}' | sort | tail -n1 || true)"
  [[ -n "$entry" ]] || die "No encontré builds con esquema v$TILESET_MAJOR. Hay que actualizar este kit."
  printf '%s\n' "$entry"
}

to_megabytes() { # to_megabytes "2.2 GB" -> 2253
  awk -v n="$1" -v u="$2" 'BEGIN { m = (u == "GB") ? 1024 : (u == "KB") ? 1 / 1024 : (u == "B") ? 1 / 1048576 : 1; printf "%d\n", n * m + 1 }'
}

# Baja un recorte del planeta y lo deja en su lugar solo si llegó completo y válido.
#   extract_to DESTINO opciones-de-pmtiles-extract…
extract_to() {
  local target="$1"; shift
  local -a quiet=()
  [[ -t 2 ]] || quiet=(--quiet)
  rm -f "$target.parcial"
  "$PM" extract "$SOURCE" "$target.parcial" --download-threads=4 "${quiet[@]}" "$@" || return 1
  "$PM" verify "$target.parcial" >/dev/null 2>&1 || return 1
  chmod 0644 "$target.parcial"
  mv -f "$target.parcial" "$target"
}

install_basemap() {
  local cur_file cur_build cur_bbox build target world out size need free f
  cur_file="$(manifest_value file)"
  cur_build="$(manifest_value build)"
  cur_bbox="$(manifest_value bbox)"

  # Se conserva el build instalado salvo que se pida otro, cambie la zona o falte el archivo.
  if [[ -n "$cur_file" && -s "$ROOT/tiles/$cur_file" && "$cur_bbox" == "$BBOX" && -z "$BUILD" ]] && (( UPDATE_MAP == 0 )); then
    build="$cur_build"
  else
    build="$(choose_build)" || exit 1
  fi
  # El nombre lleva la zona resumida en cuatro caracteres: otra zona, otro archivo.
  local tag
  tag="$(printf '%s' "$BBOX" | sha256sum | cut -c1-4)"
  target="$ROOT/tiles/$MAP_LABEL-$build-$tag.pmtiles"
  world="$ROOT/tiles/mundo-$build.pmtiles"
  SOURCE="$BUILDS_BASE/$build.pmtiles"

  if (( SIMULATE )); then
    if [[ -s "$target" && "$(known_bbox_of "$(basename "$target")")" == "$BBOX" ]]; then sim "el mapa de calles ya está: $(basename "$target")"
    else sim "recortar $SOURCE a la zona $BBOX y guardarlo en $target"; fi
    [[ -s "$world" ]] || sim "recortar el mundo a poco zoom y guardarlo en $world"
    return
  fi

  # 1) Recorte detallado de la zona de trabajo. Un archivo ya descargado solo
  #    sirve si algún manifiesto dice que es de esta misma zona.
  if [[ -s "$target" && "$(known_bbox_of "$(basename "$target")")" == "$BBOX" ]]; then
    ok "Mapa de calles: $(basename "$target") ya está (build $build)$( ((UPDATE_MAP)) && echo ', que es el más nuevo' )"
  else
    # Cálculo previo, sin descargar, para saber cuánto ocupa y si entra en el disco.
    info "Calculando el tamaño del recorte del build $build…"
    out="$("$PM" extract "$SOURCE" "$WORK/calculo.pmtiles" --bbox="$BBOX" --dry-run 2>&1)" \
      || die "pmtiles no pudo leer $SOURCE:
$out"
    size="$(sed -nE 's/.*archive size of ([0-9.]+) ([KMG]?B).*/\1 \2/p' <<<"$out" | tail -n1)"
    if [[ -n "$size" ]]; then
      # shellcheck disable=SC2086
      need=$(( $(to_megabytes $size) * 11 / 10 + 200 ))
      free="$(df -Pm "$ROOT/tiles" | awk 'NR == 2 { print $4 }')"
      info "El recorte ocupa $size. Espacio libre en $ROOT/tiles: $free MB."
      (( free >= need )) || die "No alcanza el espacio: hacen falta unos $need MB libres en $ROOT/tiles."
    else
      warn "No pude estimar el tamaño del recorte; sigo sin comprobar el espacio en disco."
    fi
    info "Descargando el recorte (puede tardar varios minutos)…"
    extract_to "$target" --bbox="$BBOX" \
      || die "Falló la descarga del recorte. El mapa que estaba en uso no se tocó; se puede volver a ejecutar."
    ok "Mapa de calles descargado: $(basename "$target") ($(du -h --apparent-size "$target" | cut -f1))"
  fi

  # 2) El mundo entero a poco zoom, para que al alejar no quede un hueco fuera de la zona.
  #    Es un complemento: si falla, el visor funciona igual sin él.
  if [[ -s "$world" ]]; then
    ok "Mapa del mundo: $(basename "$world") ya está"
  elif extract_to "$world" --maxzoom=5; then
    ok "Mapa del mundo descargado: $(basename "$world") ($(du -h --apparent-size "$world" | cut -f1))"
  else
    warn "No se pudo descargar el mapa del mundo. Al alejar el mapa se va a ver gris fuera de la zona."
    world=""
  fi

  # 3) El manifiesto es lo que lee el visor: reescribirlo es lo que pone en uso los archivos nuevos.
  {
    printf '{\n'
    printf '  "file": "%s",\n' "$(basename "$target")"
    [[ -n "$world" ]] && printf '  "world": "%s",\n' "$(basename "$world")"
    printf '  "build": "%s",\n' "$build"
    printf '  "bbox": "%s",\n' "$BBOX"
    printf '  "label": "%s"\n' "$MAP_LABEL"
    printf '}\n'
  } > "$WORK/basemap.json"
  if [[ -f "$MANIFEST" ]] && cmp -s "$WORK/basemap.json" "$MANIFEST"; then
    ok "El visor ya usa estos archivos"
  else
    [[ -f "$MANIFEST" ]] && cp -a "$MANIFEST" "$ROOT/tiles/basemap.anterior.json"
    install -m 0644 "$WORK/basemap.json" "$MANIFEST.nuevo"
    mv -f "$MANIFEST.nuevo" "$MANIFEST"
    ok "El visor pasa a usar el build $build${cur_file:+ (para volver al anterior: --volver-mapa)}"
  fi

  # 4) Quedan los archivos que nombran el manifiesto en uso y el anterior (para
  #    poder volver atrás con --volver-mapa); el resto se borra.
  local keep
  keep="$(sed -nE 's/.*"(file|world)"[[:space:]]*:[[:space:]]*"([^"]*)".*/\2/p' "$MANIFEST" "$ROOT/tiles/basemap.anterior.json" 2>/dev/null || true)"
  for f in "$ROOT"/tiles/*.pmtiles; do
    [[ -e "$f" ]] || continue
    if ! grep -qxF "$(basename "$f")" <<<"$keep"; then
      rm -f "$f"
      info "Borrado un mapa viejo: $(basename "$f")"
    fi
  done
}

if (( SKIP_MAP )); then
  info "Omitido (--sin-mapa)"
else
  install_pmtiles
  install_basemap
fi

# ------------------------------------------------------------------- visor
# (se activa en el paso 6, cuando la API y nginx ya están listos para él)

deploy_web() {
  local hash release current
  hash="$(cd "$KIT_DIR/web" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-8)"
  release="$KIT_VERSION-$hash"
  current=""
  [[ -L "$ROOT/web" ]] && current="$(basename "$(readlink "$ROOT/web")")"

  if (( SIMULATE )); then
    if [[ "$current" == "$release" ]]; then sim "el visor ya está en $release: nada que hacer"
    else sim "copiar web/ a $ROOT/releases/$release y apuntar $ROOT/web ahí (hoy: ${current:-nada})"; fi
    [[ -f "$ROOT/config/config.local.js" ]] || sim "crear $ROOT/config/config.local.js"
    return
  fi

  # Los ajustes locales se crean una sola vez y no se vuelven a tocar.
  if [[ ! -f "$ROOT/config/config.local.js" ]]; then
    install -m 0644 "$KIT_DIR/web/config.local.js" "$ROOT/config/config.local.js"
    ok "Creado $ROOT/config/config.local.js (ajustes de esta instalación)"
  fi

  if [[ ! -d "$ROOT/releases/$release" ]]; then
    rm -rf "$ROOT/releases/.$release.parcial"
    cp -a "$KIT_DIR/web" "$ROOT/releases/.$release.parcial"
    rm -f "$ROOT/releases/.$release.parcial/config.local.js"
    chown -R root:root "$ROOT/releases/.$release.parcial"
    chmod -R u=rwX,go=rX "$ROOT/releases/.$release.parcial"
    mv -T "$ROOT/releases/.$release.parcial" "$ROOT/releases/$release"
  fi

  if [[ "$current" == "$release" ]]; then
    ok "El visor ya está en la versión $release"
    return
  fi

  [[ -e "$ROOT/web" && ! -L "$ROOT/web" ]] && die "$ROOT/web existe y no es un enlace: no lo piso. Movelo y volvé a ejecutar."
  ln -sfn "releases/$release" "$ROOT/web.nuevo"
  mv -T "$ROOT/web.nuevo" "$ROOT/web"
  [[ -n "$current" ]] && printf '%s\n' "$current" > "$ROOT/releases/.anterior"
  ok "Visor en la versión $release${current:+ (antes: $current; para volver: --volver)}"

  # Se conservan la versión en uso y la anterior (solo carpetas reales, no enlaces).
  local d name
  while IFS= read -r -d '' d; do
    name="$(basename "$d")"
    [[ "$name" == "$release" || "$name" == "$current" ]] || { rm -rf "$d"; info "Borrada una versión vieja: $name"; }
  done < <(find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -print0)
}

# ------------------------------------------------------------- 4. servicios

step "4/7 Servicios: sesión (login) y API de la red"

AUTH_DB="$ROOT/data/ftth.db"
AUTH_PY="$ROOT/auth/ftth-auth.py"
AUTH_UNIT="/etc/systemd/system/$APP-auth.service"
API_DB="$ROOT/data/red.db"
API_PY="$ROOT/api/ftth-api.py"
API_UNIT="/etc/systemd/system/$APP-api.service"
API_SECRET="$ROOT/data/api.secreto"
API_SECRET_INC="/etc/nginx/$APP-api-secreto.inc"
BACKUP_SERVICE="/etc/systemd/system/$APP-respaldo.service"
BACKUP_TIMER="/etc/systemd/system/$APP-respaldo.timer"
BACKUP_KEEP="${FTTH_RESPALDOS:-30}"   # copias diarias que se conservan
[[ "$BACKUP_KEEP" =~ ^[1-9][0-9]{0,3}$ ]] || die "FTTH_RESPALDOS tiene que ser un número de copias (1 a 9999)."

# Responde el servicio que corresponde (no cualquier cosa que esté en ese puerto).
auth_health() { curl -fsS --noproxy '*' --max-time 3 "http://127.0.0.1:$AUTH_PORT/auth/health" 2>/dev/null | grep -q '"ok": true'; }
api_health() { curl -fsS --noproxy '*' --max-time 3 "http://127.0.0.1:$API_PORT/api/salud" 2>/dev/null | grep -q '"ok": true'; }
# El resumen del programa que atiende la API (lo informa solo con la clave de nginx;
# la cabecera va en un archivo para que la clave no quede a la vista en la lista de procesos).
api_codigo() {
  [[ -r "$API_SECRET" ]] || return 0
  ( umask 077; printf 'X-Ftth-Secreto: %s\n' "$(cat "$API_SECRET")" > "$WORK/cabecera-api" )
  curl -fsS --noproxy '*' --max-time 3 -H @"$WORK/cabecera-api" "http://127.0.0.1:$API_PORT/api/salud" 2>/dev/null \
    | sed -n 's/.*"codigo": "\([0-9a-f]*\)".*/\1/p'
}

# usuarios SUBCOMANDO [NOMBRE]: la herramienta de usuarios, siempre como el usuario del servicio.
usuarios() { runuser -u "$AUTH_USER" -- /usr/bin/python3 -I "$AUTH_PY" --db "$AUTH_DB" usuarios "$@"; }

# render_unit NOMBRE COMENTARIO DESCRIPCIÓN COMANDO: unidad de systemd de un servicio del kit.
# (La del servicio de sesión sale idéntica a la de 0.2.0: así actualizar no lo reinicia.)
render_unit() {
  cat <<UNIT
# $APP-$1: $2. Generado por instalar.sh.
[Unit]
Description=$3
After=network.target

[Service]
User=$AUTH_USER
Group=$AUTH_USER
ExecStart=$4
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=$ROOT/data

[Install]
WantedBy=multi-user.target
UNIT
}

# install_service NOMBRE COMENTARIO DESCRIPCIÓN ORIGEN DESTINO PUERTO UNIDAD SALUD COMANDO: copia
# el programa, escribe la unidad y deja el servicio andando.
install_service() {
  local name="$1" comment="$2" desc="$3" src="$4" dst="$5" port="$6" unit="$7" health="$8" command="$9" changed=0
  if ! cmp -s "$src" "$dst"; then
    install -m 0644 "$src" "$dst"
    changed=1
  fi
  if [[ -d /run/systemd/system ]]; then
    render_unit "$name" "$comment" "$desc" "$command" > "$WORK/unit-$name"
    if ! cmp -s "$WORK/unit-$name" "$unit"; then
      install -m 0644 "$WORK/unit-$name" "$unit"
      systemctl daemon-reload
      changed=1
    fi
    systemctl enable "$APP-$name.service" >/dev/null 2>&1
    if (( changed )) || ! systemctl is-active --quiet "$APP-$name.service"; then
      systemctl restart "$APP-$name.service"
    fi
  elif ! "$health"; then
    warn "Este sistema no tiene systemd: el servicio $APP-$name hay que iniciarlo a mano:"
    warn "  runuser -u $AUTH_USER -- $command &"
  elif (( changed )); then
    warn "Este sistema no tiene systemd y $APP-$name cambió: hay que reiniciarlo a mano para que tome la versión nueva."
  fi
  for _ in $(seq 1 20); do
    "$health" && break
    sleep 0.5
  done
  "$health" || die "El servicio $APP-$name no responde en 127.0.0.1:$port. Revisá: journalctl -u $APP-$name -n 30"
  ok "$desc: andando en 127.0.0.1:$port"
}

# La API solo atiende pedidos que traen esta clave, y solo nginx la conoce: así
# ningún otro programa de la máquina puede hablarle haciéndose pasar por un usuario.
install_api_secret() {
  if [[ ! -s "$API_SECRET" ]]; then
    ( umask 077; od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$API_SECRET.nuevo" )
    mv -f "$API_SECRET.nuevo" "$API_SECRET"
    ok "Clave nueva entre nginx y la API"
  fi
  chown "root:$AUTH_USER" "$API_SECRET"
  chmod 0640 "$API_SECRET"
  if [[ -d /etc/nginx ]]; then
    printf '# Generado por instalar.sh: clave que nginx le pasa a la API. No compartir.\nproxy_set_header X-Ftth-Secreto "%s";\n' \
      "$(cat "$API_SECRET")" > "$WORK/secreto.inc"
    if ! cmp -s "$WORK/secreto.inc" "$API_SECRET_INC"; then
      install -m 0640 -o root -g root "$WORK/secreto.inc" "$API_SECRET_INC"
    fi
  fi
}

# Copias de seguridad coherentes de las bases (se pueden hacer con todo andando).
install_backup_tool() {
  cat > "$WORK/respaldo" <<'TOOL'
#!/usr/bin/env bash
# Copia coherente de los usuarios, la red y los ajustes, con todo andando.
#   respaldo [--conservar N] [--etiqueta TEXTO] [CARPETA]   (por defecto /root/respaldos-ftth)
#   --conservar N   después de copiar, deja solo las N copias más nuevas de la carpeta
#   --etiqueta T    agrega T al nombre de la copia (por ejemplo, antes-de-0.4.0)
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Ejecutar con sudo." >&2; exit 1; }
TOOL
  cat >> "$WORK/respaldo" <<TOOL
ROOT="$ROOT"
SERVICE_USER="$AUTH_USER"
TOOL
  cat >> "$WORK/respaldo" <<'TOOL'
base="/root/respaldos-ftth"
conservar=0
etiqueta=""
while (( $# )); do
  case "$1" in
    --conservar) conservar="${2:-}"; shift; shift || true ;;
    --etiqueta) etiqueta="${2:-}"; shift; shift || true ;;
    -h|--ayuda|--help) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "Opción desconocida: $1" >&2; exit 2 ;;
    *) base="${1%/}"; shift ;;
  esac
done
[[ "$conservar" =~ ^[0-9]{1,4}$ ]] || { echo "--conservar espera un número de copias." >&2; exit 2; }
conservar=$((10#$conservar))
[[ -z "$etiqueta" || "$etiqueta" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || { echo "--etiqueta admite letras, números, punto y guion." >&2; exit 2; }
[[ -n "$base" ]] || { echo "Falta la carpeta de las copias." >&2; exit 2; }
dest="$base/$(date +%Y%m%d-%H%M%S)${etiqueta:+-$etiqueta}"
mkdir -p "$dest"
chmod 0700 "$dest"
# La copia la hace el usuario del servicio: si la hiciera root, SQLite podría
# dejar archivos auxiliares de root que después el servicio no puede abrir.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
chown "$SERVICE_USER:" "$tmp"
for db in ftth red; do
  [[ -f "$ROOT/data/$db.db" ]] || continue
  runuser -u "$SERVICE_USER" -- /usr/bin/python3 -I -c 'import sqlite3, sys
src = sqlite3.connect(sys.argv[1])
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)
dst.close()
src.close()' "$ROOT/data/$db.db" "$tmp/$db.db"
  install -m 0600 -o root -g root "$tmp/$db.db" "$dest/$db.db"
done
cp -p "$ROOT/config/config.local.js" "$dest/" 2>/dev/null || true
[[ ! -f "$ROOT/data/integraciones.json" ]] || install -m 0600 -o root -g root "$ROOT/data/integraciones.json" "$dest/"
echo "Respaldo en $dest:"
ls -l "$dest"
# Las copias diarias se llaman AAAAMMDD-HHMMSS: por nombre, de la más nueva a la
# más vieja. Las que llevan etiqueta (las de antes de actualizar) no se podan solas.
if (( conservar > 0 )); then
  borradas=0
  while IFS= read -r vieja; do
    rm -rf -- "${base:?}/$vieja"
    borradas=$((borradas + 1))
  done < <(find "$base" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended \
             -regex '.*/[0-9]{8}-[0-9]{6}' -printf '%f\n' | sort -r | tail -n +$((conservar + 1)))
  (( borradas == 0 )) || echo "Copias viejas borradas: $borradas (se conservan $conservar)"
fi
TOOL
  cmp -s "$WORK/respaldo" "$ROOT/bin/respaldo" || install -m 0755 "$WORK/respaldo" "$ROOT/bin/respaldo"
}

# Conectar cada red con Wispro y con el panel de la OLT: el token se escribe en el
# servidor y queda en data/integraciones.json (600, del usuario del servicio).
install_integraciones() {
  cat > "$WORK/integraciones" <<WRAP
#!/usr/bin/env bash
# Conecta una red con Wispro y con el panel de la OLT (solo lectura):
#   ver | wispro RED | panel RED URL [--olt N] | quitar RED [wispro|panel] | probar RED
[[ \$EUID -eq 0 ]] || { echo "Ejecutar con sudo." >&2; exit 1; }
cd / || exit 1
exec runuser -u $AUTH_USER -- /usr/bin/python3 -I $API_PY --db $API_DB integraciones "\$@"
WRAP
  cmp -s "$WORK/integraciones" "$ROOT/bin/integraciones" || install -m 0755 "$WORK/integraciones" "$ROOT/bin/integraciones"
  if [[ -f "$ROOT/data/integraciones.json" ]]; then
    chown "$AUTH_USER:$AUTH_USER" "$ROOT/data/integraciones.json"
    chmod 0600 "$ROOT/data/integraciones.json"
  fi
}

# Copia diaria (03:30, con un margen al azar) que conserva las últimas BACKUP_KEEP.
install_backup_timer() {
  if [[ ! -d /run/systemd/system ]]; then
    warn "Este sistema no tiene systemd: la copia diaria hay que programarla aparte, por ejemplo en /etc/cron.d/$APP:"
    warn "  30 3 * * * root $ROOT/bin/respaldo --conservar $BACKUP_KEEP >/dev/null"
    return
  fi
  cat > "$WORK/respaldo.service" <<UNIT
# $APP-respaldo: copia de seguridad de la plataforma FTTH. Generado por instalar.sh.
[Unit]
Description=Copia de seguridad de la plataforma FTTH (red, usuarios y ajustes)

[Service]
Type=oneshot
ExecStart=$ROOT/bin/respaldo --conservar $BACKUP_KEEP
Nice=10
IOSchedulingClass=idle
UNIT
  cat > "$WORK/respaldo.timer" <<UNIT
# $APP-respaldo: copia de seguridad diaria. Generado por instalar.sh.
[Unit]
Description=Copia de seguridad diaria de la plataforma FTTH

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=20m
Persistent=true

[Install]
WantedBy=timers.target
UNIT
  local changed=0
  if ! cmp -s "$WORK/respaldo.service" "$BACKUP_SERVICE"; then install -m 0644 "$WORK/respaldo.service" "$BACKUP_SERVICE"; changed=1; fi
  if ! cmp -s "$WORK/respaldo.timer" "$BACKUP_TIMER"; then install -m 0644 "$WORK/respaldo.timer" "$BACKUP_TIMER"; changed=1; fi
  (( changed )) && systemctl daemon-reload
  systemctl enable --now "$APP-respaldo.timer" >/dev/null 2>&1 || die "No se pudo activar la copia diaria. Revisá: systemctl status $APP-respaldo.timer"
  ok "Copia diaria de la red y los usuarios a las 03:30 (quedan las últimas $BACKUP_KEEP en /root/respaldos-ftth)"
}

# Antes de cambiar la API (la nueva puede actualizar el esquema de la red), una
# copia de la base: si algo sale mal, se vuelve a esa copia.
backup_before_api() {
  [[ -s "$API_DB" && -f "$API_PY" ]] || return 0
  cmp -s "$KIT_DIR/api/ftth-api.py" "$API_PY" && return 0
  local salida
  if ! salida="$("$ROOT/bin/respaldo" --etiqueta "antes-de-$KIT_VERSION" 2>&1)"; then
    printf '%s\n' "$salida" >&2
    die "No se pudo copiar la red antes de actualizar la API: la API quedó como estaba."
  fi
  ok "Copia de la red antes de actualizar: $(printf '%s\n' "$salida" | sed -n 's/^Respaldo en \(.*\):$/\1/p')"
}

install_auth() {
  if (( SIMULATE )); then
    id "$AUTH_USER" >/dev/null 2>&1 || sim "crear el usuario del sistema $AUTH_USER"
    sim "instalar $AUTH_PY y el servicio $AUTH_UNIT (puerto $AUTH_PORT)"
    [[ -s "$API_SECRET" ]] || sim "crear la clave entre nginx y la API ($API_SECRET)"
    sim "instalar $ROOT/bin/respaldo"
    if [[ -s "$API_DB" ]] && ! cmp -s "$KIT_DIR/api/ftth-api.py" "$API_PY"; then
      sim "copiar la red a /root/respaldos-ftth antes de cambiar la API"
    fi
    sim "instalar $API_PY y el servicio $API_UNIT (puerto $API_PORT)"
    sim "programar la copia diaria ($BACKUP_TIMER, conserva $BACKUP_KEEP)"
    sim "instalar $ROOT/bin/integraciones"
    return
  fi

  if ! id "$AUTH_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$ROOT/data" --no-create-home --shell /usr/sbin/nologin "$AUTH_USER"
    ok "Usuario del sistema $AUTH_USER creado"
  fi
  chown "$AUTH_USER:$AUTH_USER" "$ROOT/data"
  chmod 0750 "$ROOT/data"

  cat > "$WORK/usuarios" <<WRAP
#!/usr/bin/env bash
# Administra los usuarios del login: listar | agregar NOMBRE | clave NOMBRE | quitar NOMBRE
[[ \$EUID -eq 0 ]] || { echo "Ejecutar con sudo." >&2; exit 1; }
exec runuser -u $AUTH_USER -- /usr/bin/python3 -I $AUTH_PY --db $AUTH_DB usuarios "\$@"
WRAP
  cmp -s "$WORK/usuarios" "$ROOT/bin/usuarios" || install -m 0755 "$WORK/usuarios" "$ROOT/bin/usuarios"

  install_service auth "servicio de sesión (login) de la plataforma FTTH" "Sesión de la plataforma FTTH (login)" \
    "$KIT_DIR/auth/ftth-auth.py" "$AUTH_PY" "$AUTH_PORT" "$AUTH_UNIT" auth_health \
    "/usr/bin/python3 -I $AUTH_PY --db $AUTH_DB serve --host 127.0.0.1 --port $AUTH_PORT"
  # La base de usuarios la crea el propio usuario del servicio, así queda con su dueño.
  usuarios listar >/dev/null
  install_api_secret
  install_backup_tool
  backup_before_api
  install_service api "API de la red de la plataforma FTTH" "API de la red FTTH" \
    "$KIT_DIR/api/ftth-api.py" "$API_PY" "$API_PORT" "$API_UNIT" api_health \
    "/usr/bin/python3 -I $API_PY --db $API_DB serve --host 127.0.0.1 --port $API_PORT --secreto $API_SECRET"
  # Que atienda la API recién instalada y no una anterior que siguió andando: el
  # visor nuevo no tiene que hablar con una API vieja.
  local esperado
  esperado="$(sha256sum "$API_PY" | cut -c1-12)"
  if [[ -d /run/systemd/system && "$(api_codigo)" != "$esperado" ]]; then
    # Quedó andando otra versión (por ejemplo, de una ejecución anterior que no llegó a reiniciarla).
    systemctl restart "$APP-api.service"
  fi
  for _ in $(seq 1 20); do
    [[ "$(api_codigo)" == "$esperado" ]] && break
    sleep 0.5
  done
  if [[ "$(api_codigo)" != "$esperado" ]]; then
    [[ -d /run/systemd/system ]] && die "La API que atiende no es la recién instalada. Revisá: systemctl restart $APP-api y journalctl -u $APP-api -n 30"
    warn "La API que atiende no es la recién instalada: reiniciala a mano antes de usar la plataforma."
  fi
  install_backup_timer
  install_integraciones

  if [[ "$(usuarios listar)" == "No hay usuarios." ]]; then
    if [[ -t 0 && -t 1 ]]; then
      local name
      printf '   Todavía no hay usuarios. Nombre del primero [admin]: '
      read -r name
      name="${name:-admin}"
      [[ "$name" =~ ^[A-Za-z0-9._@-]{1,64}$ ]] || die "El nombre de usuario admite letras, números, punto, guion, guion bajo y arroba."
      usuarios agregar "$name" || die "No se pudo crear el usuario."
    else
      warn "Todavía no hay usuarios. Para crear el primero: sudo $ROOT/bin/usuarios agregar NOMBRE"
    fi
  else
    ok "Usuarios: $(usuarios listar | cut -f1 | tr '\n' ' ')"
  fi
}
install_auth

# -------------------------------------------------------------------- 6. nginx

step "5/7 Sitio en nginx"

TLS_ON=0
if (( TLS_CAPABLE )) && [[ -s "$CERT_DIR/fullchain.pem" && -s "$CERT_DIR/privkey.pem" ]]; then TLS_ON=1; fi

HAVE_IPV6=0
[[ -e /proc/net/if_inet6 ]] && HAVE_IPV6=1

listen_lines() { # listen_lines PUERTO [ssl]
  local extra="${2:+ $2}"
  printf '    listen %s%s;\n' "$1" "$extra"
  (( HAVE_IPV6 )) && printf '    listen [::]:%s%s;\n' "$1" "$extra"
  return 0
}

# nginx 1.25.1 cambió la forma de activar HTTP/2.
http2_new_syntax() {
  local v; v="$(nginx -v 2>&1 | sed -nE 's#.*nginx/([0-9]+)\.([0-9]+)\.([0-9]+).*#\1 \2 \3#p')"
  # shellcheck disable=SC2086
  set -- ${v:-0 0 0}
  (( $1 > 1 || ($1 == 1 && $2 > 25) || ($1 == 1 && $2 == 25 && $3 >= 1) ))
}

app_block() {
  cat <<EOF
    root $ROOT/web;
    index index.html;
    charset utf-8;

    access_log /var/log/nginx/$APP.access.log;
    error_log  /var/log/nginx/$APP.error.log;

    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header Permissions-Policy "geolocation=(self)" always;

    gzip on;
    gzip_min_length 1024;
    gzip_types text/css text/javascript application/javascript application/json image/svg+xml application/x-protobuf;

    # Login: antes de servir cualquier cosa, nginx le pregunta al servicio de
    # sesión si la cookie vale. Sin sesión, a la página de entrada.
    auth_request /auth/check;
    error_page 401 = @entrar;

    location @entrar {
        return 302 /login.html;
    }

    location = /auth/check {
        internal;
        proxy_pass http://127.0.0.1:$AUTH_PORT/auth/check;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
    }

    location /auth/ {
        auth_request off;
        proxy_pass http://127.0.0.1:$AUTH_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # API de la red: solo con sesión. nginx le pasa al servicio quién es el
    # usuario (lo dice el servicio de sesión) y, sin sesión, responde 401 en
    # JSON en vez de mandar a la página de entrada.
    location /api/ {
        auth_request /auth/check;
        auth_request_set \$ftth_usuario \$upstream_http_x_usuario;
        error_page 401 = @api_sin_sesion;
        proxy_pass http://127.0.0.1:$API_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Usuario \$ftth_usuario;
        # La clave que la API exige para saber que el pedido viene de nginx
        # (archivo legible solo por root).
        include $API_SECRET_INC;
        proxy_read_timeout 60s;
        client_max_body_size 1m;
        expires -1;
    }

    location = /api/salud {
        auth_request off;
        limit_except GET { deny all; }
        proxy_pass http://127.0.0.1:$API_PORT;
        proxy_set_header X-Usuario "";
    }

    location @api_sin_sesion {
        default_type application/json;
        return 401 '{"error":"sin sesión"}';
    }

    location = /login.html {
        auth_request off;
        expires -1;
    }

    # Marca de esta configuración: instalar.sh la consulta (solo desde esta
    # máquina) para saber cuándo nginx ya atiende con lo que acaba de escribir.
    location = /.ftth-config {
        auth_request off;
        default_type text/plain;
        if (\$remote_addr !~ "^(127\.0\.0\.1|::1)\$") {
            return 404;
        }
        return 200 "__FTTH_CONFIG__\n";
    }

    # La tipografía de la interfaz también la usa la página de entrada.
    location /assets/ui/ {
        auth_request off;
        expires 30d;
    }

    # Página y código propio: el navegador revalida siempre, porque cambian seguido.
    location / {
        try_files \$uri \$uri/ =404;
        expires -1;
    }

    # Ajustes de esta instalación: viven fuera del código para sobrevivir a las actualizaciones.
    location = /config.local.js {
        alias $ROOT/config/config.local.js;
        expires -1;
    }

    # Nada que empiece con punto, salvo la validación de certificados. Va antes
    # que las demás reglas con expresión regular porque se evalúan en orden.
    location ~ /\.(?!well-known/) {
        return 404;
    }

    # Librerías con la versión en la ruta: su contenido no cambia nunca.
    location /vendor/ {
        expires 1y;
    }

    # MapLibre 6 se distribuye como módulos .mjs y no todos los nginx conocen esa extensión.
    location ~ ^/vendor/.+\.mjs\$ {
        types { }
        default_type text/javascript;
        expires 1y;
    }

    location /assets/ {
        expires 30d;
    }

    # Tipografías del mapa (glifos en protobuf).
    location /assets/fonts/ {
        types { }
        default_type application/x-protobuf;
        expires 30d;
    }

    # Mapa de calles. El visor lee pedazos del archivo con peticiones Range, que
    # nginx atiende solo. Cada archivo lleva la fecha en el nombre y no cambia;
    # el manifiesto dice cuál está en uso y por eso no se guarda en caché.
    location = /tiles/basemap.json {
        alias $ROOT/tiles/basemap.json;
        default_type application/json;
        expires -1;
    }

    location /tiles/ {
        alias $ROOT/tiles/;
        expires 30d;
    }
EOF
}

acme_block() {
  cat <<EOF
    # Validación de Let's Encrypt (certbot --webroot -w $ROOT/acme).
    location ^~ /.well-known/acme-challenge/ {
        auth_request off;
        root $ROOT/acme;
        default_type text/plain;
    }
EOF
}

# El sitio lleva un identificador que es un resumen de su propio texto: mismo
# contenido, mismo identificador (la segunda ejecución no cambia nada).
render_vhost() {
  local raw
  raw="$(render_vhost_text)"
  printf '%s\n' "${raw//__FTTH_CONFIG__/$(printf '%s' "$raw" | sha256sum | cut -c1-12)}"
}

render_vhost_text() {
  cat <<EOF
# $APP: plataforma FTTH (mapa, login y red).
# Generado por instalar.sh (kit $KIT_VERSION). No editar a mano: se regenera en cada ejecución.
EOF
  if (( TLS_ON )); then
    cat <<EOF

server {
$(listen_lines 80)
    server_name $SERVER_NAME;

$(acme_block)

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
$(if http2_new_syntax; then listen_lines 443 ssl; printf '    http2 on;\n'; else listen_lines 443 "ssl http2"; fi)
    server_name $SERVER_NAME;

    ssl_certificate     $CERT_DIR/fullchain.pem;
    ssl_certificate_key $CERT_DIR/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:${APP}_tls:10m;
    ssl_session_timeout 1d;

$(app_block)
}
EOF
  else
    cat <<EOF

server {
$(listen_lines "$PORT")
    server_name $SERVER_NAME;

$( [[ -n "$DOMAIN" ]] && acme_block && echo )
$(app_block)
}
EOF
  fi
}

# Recarga sin cortar conexiones. Solo inicia nginx si lo instaló este mismo script.
nginx_apply() {
  if nginx_running; then
    if [[ -d /run/systemd/system ]]; then systemctl reload nginx
    else nginx -s reload 2>"$WORK/nginx-reload.log" || { cat "$WORK/nginx-reload.log" >&2; return 1; }; fi
    # La recarga es gradual: los procesos viejos siguen hasta cerrar sus
    # conexiones. Se espera a que no quede ninguno para verificar lo nuevo.
    for _ in $(seq 1 30); do
      ps -o args= -C nginx 2>/dev/null | grep -q 'shutting down' || break
      sleep 0.5
    done
  elif (( INSTALLED_NGINX )); then
    if [[ -d /run/systemd/system ]]; then systemctl start nginx; else nginx; fi
  else
    printf 'nginx está detenido; iniciarlo a mano (systemctl start nginx) y volver a ejecutar.\n' >&2
    return 1
  fi
}

# ¿nginx atiende los puertos de este sitio?
nginx_serving() {
  port_busy "$PORT" || return 1
  (( TLS_ON == 0 )) || port_busy 443
}

if [[ -d /etc/nginx/sites-available && -d /etc/nginx/sites-enabled ]]; then
  SITE_FILE="/etc/nginx/sites-available/$APP.conf"
else
  SITE_FILE="/etc/nginx/conf.d/$APP.conf"
fi

# La marca de la configuración escrita y la que nginx está sirviendo de verdad.
marca_esperada() { sed -nE 's/^[[:space:]]*return 200 "([0-9a-f]{12})\\n";$/\1/p' "$SITE_FILE" 2>/dev/null | head -n1; }
marca_servida() {
  local scheme="http" port="$PORT" host="${DOMAIN:-localhost}"
  if (( TLS_ON )); then scheme="https"; port=443; fi
  curl -sS -k --max-time 5 --noproxy '*' --resolve "$host:$port:127.0.0.1" "$scheme://$host:$port/.ftth-config" 2>/dev/null || true
}

install_vhost() {
  local avail="$SITE_FILE" enabled="" new backup="" had_enabled=0 had_avail=0
  [[ "$avail" == /etc/nginx/sites-available/* ]] && enabled="/etc/nginx/sites-enabled/$APP.conf"
  [[ -f "$avail" ]] && had_avail=1
  [[ -n "$enabled" && -L "$enabled" ]] && had_enabled=1

  if (( SIMULATE )); then
    new="$(mktemp)"
    if (( HAVE_NGINX )) && render_vhost > "$new" 2>/dev/null && (( had_avail )) && cmp -s "$new" "$avail"; then
      sim "el sitio de nginx ya está al día ($avail): nada que hacer"
    else
      sim "escribir $avail (puerto $PORT, nombre '$SERVER_NAME', HTTPS: $( ((TLS_ON)) && echo sí || echo no ))"
      sim "nginx -t y recarga; si la configuración no valida, se restaura la anterior"
    fi
    rm -f "$new"
    return
  fi

  # Punto de partida: la configuración actual tiene que validar. Si lo único que
  # falla es el sitio viejo de este mismo kit (por ejemplo, un certificado que ya
  # no está), se lo reemplaza; si falla otra cosa, no es de este script y se avisa.
  if ! nginx -t >"$WORK/nginx-antes.log" 2>&1; then
    local broken_ours=0
    if (( had_avail )); then
      mv "$avail" "$WORK/$APP.conf.anterior"
      (( had_enabled )) && rm -f "$enabled"
      nginx -t >"$WORK/nginx-sin-sitio.log" 2>&1 && broken_ours=1
      mv "$WORK/$APP.conf.anterior" "$avail"
      (( had_enabled )) && ln -sfn "$avail" "$enabled"
    fi
    if (( broken_ours )); then
      warn "El sitio anterior de este kit ya no validaba (detalle en $ROOT/backups); se reemplaza."
      cp -a "$avail" "$ROOT/backups/$APP.conf.roto.$(date +%Y%m%d-%H%M%S)-$$"
      cp "$WORK/nginx-antes.log" "$ROOT/backups/$APP.conf.roto.$(date +%Y%m%d-%H%M%S)-$$.log"
    else
      cat "$WORK/nginx-antes.log" >&2
      die "La configuración que nginx ya tenía no valida, antes de agregar nada (detalle arriba).
       Este script no la tocó. Corregila y volvé a ejecutar."
    fi
  fi

  new="$WORK/$APP.conf"
  render_vhost > "$new"

  if (( had_avail )) && cmp -s "$new" "$avail" && { [[ -z "$enabled" ]] || (( had_enabled )); }; then
    ok "El sitio de nginx ya está al día ($avail)"
    if ! nginx_serving; then
      info "nginx no está atendiendo el puerto $PORT: se recarga."
      nginx_apply || die "nginx no pudo recargar. Revisá: journalctl -u nginx -n 30"
      ok "nginx recargado"
    elif [[ "$(marca_servida)" != "$(marca_esperada)" ]]; then
      info "nginx todavía atiende con una configuración anterior: se recarga."
      nginx_apply || die "nginx no pudo recargar. Revisá: journalctl -u nginx -n 30"
      ok "nginx recargado"
    fi
    return
  fi

  if (( had_avail )); then
    backup="$ROOT/backups/$APP.conf.$(date +%Y%m%d-%H%M%S)-$$"
    cp -a "$avail" "$backup"
    # Se guardan las últimas 10 copias.
    find "$ROOT/backups" -maxdepth 1 -name "$APP.conf.*" -printf '%T@ %p\n' | sort -rn | awk 'NR > 10 { print $2 }' | xargs -r rm -f
  fi
  install -m 0644 "$new" "$avail"
  [[ -n "$enabled" ]] && ln -sfn "$avail" "$enabled"

  if ! nginx -t >"$WORK/nginx-test.log" 2>&1; then
    # Vuelta atrás: archivo y estado (habilitado o no) exactamente como estaban.
    if [[ -n "$backup" ]]; then cp -a "$backup" "$avail"; else rm -f "$avail"; fi
    if [[ -n "$enabled" ]] && (( had_enabled == 0 )); then rm -f "$enabled"; fi
    cat "$WORK/nginx-test.log" >&2
    die "nginx rechazó la configuración nueva. Se restauró la anterior y no se recargó nada."
  fi
  ok "Sitio escrito en $avail${backup:+ (copia de la anterior: $backup)}"

  nginx_apply || die "nginx no pudo recargar. Revisá: journalctl -u nginx -n 30"
  ok "nginx recargado"
}

if (( SKIP_NGINX )); then
  info "Omitido (--sin-nginx). Los archivos quedan en $ROOT para publicarlos con otro servidor web."
else
  install_vhost
fi

# ------------------------------------------------------------------ 6. visor

step "6/7 Visor web"
deploy_web

# -------------------------------------------------------------- 6. verificación

step "7/7 Verificación"

verify_site() {
  local scheme="http" port="$PORT" host="${DOMAIN:-localhost}" base code type magic file failures=0
  if (( TLS_ON )); then scheme="https"; port=443; fi
  # Se le habla a nginx en esta misma máquina con el nombre real del sitio y sin
  # pasar por ningún proxy que el servidor tenga configurado para salir a internet.
  local -a opts=(-sS --max-time 20 --noproxy '*' --resolve "$host:$port:127.0.0.1")
  # Acá se comprueba que nginx sirva el sitio, no la confianza en el certificado:
  # eso se avisa aparte más abajo.
  (( TLS_ON )) && opts+=(-k)
  base="$scheme://$host:$port"

  check() { # check DESCRIPCIÓN CONDICIÓN
    if eval "$2"; then ok "$1"; else warn "FALLÓ: $1"; failures=$((failures + 1)); fi
  }

  # La recarga de nginx no es instantánea (los procesos viejos atienden un rato
  # más): se espera hasta 15 s a que responda la marca de la configuración nueva.
  local location="" expected served=""
  expected="$(marca_esperada)"
  for _ in $(seq 1 30); do
    served="$(marca_servida)"
    [[ -n "$expected" && "$served" == "$expected" ]] && break
    sleep 0.5
  done
  [[ -n "$expected" && "$served" == "$expected" ]] || warn "nginx todavía no atiende con la configuración nueva (marca '$served', se esperaba '$expected')."
  code="$(curl "${opts[@]}" -o /dev/null -w '%{http_code}' "$base/" 2>/dev/null || true)"
  # shellcheck disable=SC2034  # se usa dentro de check (eval)
  location="$(curl "${opts[@]}" -o /dev/null -w '%{redirect_url}' "$base/" 2>/dev/null || true)"
  check "Sin sesión, la página manda a entrar (HTTP $code)" '[[ "$code" == 302 && "$location" == */login.html ]]'

  code="$(curl "${opts[@]}" -o "$WORK/login.html" -w '%{http_code}' "$base/login.html" || true)"
  check "La página de entrada responde" '[[ "$code" == 200 ]] && grep -q "id=\"form\"" "$WORK/login.html"'

  code="$(curl "${opts[@]}" -o /dev/null -w '%{http_code}' "$base/auth/health" || true)"
  check "El servicio de sesión responde a través de nginx" '[[ "$code" == 200 ]]'

  code="$(curl "${opts[@]}" -o "$WORK/salud.json" -w '%{http_code}' "$base/api/salud" || true)"
  check "La API de la red responde a través de nginx" '[[ "$code" == 200 ]]'
  local esquema codigo
  esquema="$(sed -n 's/^ESQUEMA = \([0-9][0-9]*\)$/\1/p' "$API_PY")"
  # El programa que atiende es el instalado (su resumen coincide): no quedó uno viejo andando.
  # shellcheck disable=SC2034  # se usa dentro de la condición que evalúa check
  codigo="$(sha256sum "$API_PY" | cut -c1-12)"
  check "La API que atiende es la de esta versión (base con esquema $esquema)" \
    '[[ -n "$esquema" ]] && grep -q "\"esquema\": $esquema[,}]" "$WORK/salud.json" && [[ "$(api_codigo)" == "$codigo" ]]'
  code="$(curl "${opts[@]}" -o /dev/null -w '%{http_code}' "$base/api/yo" || true)"
  check "Sin sesión, la API responde 401 (HTTP $code)" '[[ "$code" == 401 ]]'
  code="$(curl -sS --max-time 5 --noproxy '*' -H 'X-Usuario: verificacion' -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:$API_PORT/api/yo" || true)"
  check "La API no atiende a quien no sea nginx (HTTP $code)" '[[ "$code" == 403 ]]'

  # Recorrido completo con un usuario temporal: entrar, ver el mapa, salir.
  local probe="verificacion-$$" pw
  pw="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
  printf '%s\n' "$pw" | usuarios agregar "$probe" >/dev/null
  trap 'usuarios quitar "$probe" >/dev/null 2>&1 || true; cleanup' EXIT
  code="$(curl "${opts[@]}" -c "$WORK/cookies" -H 'Content-Type: application/json' -H "Origin: $scheme://$host" \
    -d "{\"usuario\":\"$probe\",\"clave\":\"$pw\"}" -o /dev/null -w '%{http_code}' "$base/auth/login" || true)"
  check "El login acepta usuario y contraseña" '[[ "$code" == 200 ]]'
  code="$(curl "${opts[@]}" -b "$WORK/cookies" -o "$WORK/index.html" -w '%{http_code}' "$base/" || true)"
  check "Con sesión, la página responde" '[[ "$code" == 200 ]] && grep -q "id=\"map\"" "$WORK/index.html"'
  opts+=(-b "$WORK/cookies")

  code="$(curl "${opts[@]}" -o "$WORK/yo.json" -w '%{http_code}' "$base/api/yo" || true)"
  check "Con sesión, la API sabe quién es el usuario" '[[ "$code" == 200 ]] && grep -q "\"$probe\"" "$WORK/yo.json"'

  file="$(find "$ROOT/web/vendor/" -maxdepth 2 -name 'maplibre-gl.mjs' | head -n1)"
  type="$(curl "${opts[@]}" -o /dev/null -w '%{content_type}' "$base/${file#"$ROOT/web/"}" || true)"
  check "Los módulos .mjs salen como JavaScript ($type)" '[[ "$type" == *javascript* ]]'

  code="$(curl "${opts[@]}" -o /dev/null -w '%{http_code}' "$base/config.local.js" || true)"
  check "Los ajustes locales se publican" '[[ "$code" == 200 ]]'

  code="$(curl "${opts[@]}" -o /dev/null -w '%{http_code}' "$base/assets/fonts/Noto%20Sans%20Regular/0-255.pbf" || true)"
  check "Las tipografías del mapa se publican" '[[ "$code" == 200 ]]'

  if [[ -f "$MANIFEST" ]]; then
    file="$(manifest_value file)"
    code="$(curl "${opts[@]}" -r 0-6 -o "$WORK/magic" -w '%{http_code}' "$base/tiles/$file" || true)"
    # shellcheck disable=SC2034  # se usa dentro de check (eval)
    magic="$(head -c 7 "$WORK/magic" 2>/dev/null || true)"
    check "El mapa de calles se sirve por partes (HTTP $code)" '[[ "$code" == 206 && "$magic" == "PMTiles" ]]'
  else
    warn "No hay mapa de calles instalado: el visor va a arrancar con el mapa del IGN."
  fi

  code="$(curl "${opts[@]}" -o "$WORK/redes.json" -w '%{http_code}' "$base/api/redes" || true)"
  check "La API lee la base de la red" '[[ "$code" == 200 ]] && grep -q "\"redes\"" "$WORK/redes.json"'

  code="$(curl "${opts[@]}" -X POST -o /dev/null -w '%{http_code}' "$base/auth/logout" || true)"
  check "Salir cierra la sesión" '[[ "$code" == 200 ]]'
  if [[ -d /run/systemd/system ]]; then
    check "La copia diaria está programada" 'systemctl is-active --quiet "$APP-respaldo.timer"'
  fi
  usuarios quitar "$probe" >/dev/null
  trap cleanup EXIT

  if (( TLS_ON )) && ! curl -sS --max-time 20 --noproxy '*' --resolve "$host:443:127.0.0.1" -o /dev/null "https://$host/" 2>/dev/null; then
    warn "El certificado de $host no es de confianza para este sistema (¿de prueba o de staging?). Los navegadores van a avisar."
  fi

  (( failures == 0 )) || die "$failures comprobación(es) fallaron. Revisá /var/log/nginx/$APP.error.log"
}

if (( SIMULATE )); then
  sim "comprobar por HTTP el login, la API, la página, los módulos, las tipografías y el mapa de calles"
elif (( SKIP_NGINX )); then
  info "Omitida (--sin-nginx)"
else
  verify_site
fi

# --------------------------------------------------------------------- resumen

step "Listo"
(( SIMULATE )) && { info "Fue una simulación: no se cambió nada."; exit 0; }
(( SKIP_NGINX )) && { info "Archivos en $ROOT. Falta publicarlos con un servidor web."; exit 0; }

IP="$(hostname -I 2>/dev/null | awk '{ print $1 }' || true)"
info "Usuarios del login: sudo $ROOT/bin/usuarios listar | agregar NOMBRE | clave NOMBRE | quitar NOMBRE"
info "Wispro y el panel de la OLT: sudo $ROOT/bin/integraciones ver | wispro RED | panel RED URL | probar RED"
if (( TLS_ON )); then
  info "Abrí: https://$DOMAIN/"
elif [[ -n "$DOMAIN" ]]; then
  info "Abrí: http://$DOMAIN$( [[ "$PORT" != 80 ]] && echo ":$PORT" )/"
  if (( TLS_CAPABLE == 0 )); then
    info "Con --puerto, HTTPS queda a cargo del proxy que tenga adelante. Sin HTTPS no hay GPS en el navegador."
  else
    cat <<EOF

   Falta HTTPS, y sin HTTPS el navegador no entrega la ubicación del GPS.
   Con el DNS de $DOMAIN apuntando a este servidor y el puerto 80 abierto:

     apt-get install -y certbot
     certbot certonly --webroot -w $ROOT/acme -d $DOMAIN --deploy-hook "systemctl reload nginx"
     ./instalar.sh --dominio $DOMAIN

   La última línea vuelve a ejecutar este script, que detecta el certificado y activa HTTPS.
EOF
  fi
else
  info "Abrí: http://${IP:-IP-del-servidor}:$PORT/"
  info "Es una dirección de prueba sin HTTPS: el GPS del navegador no va a funcionar."
  info "Para publicarlo: ./instalar.sh --dominio el-nombre-elegido"
fi
