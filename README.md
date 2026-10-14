# Plataforma FTTH · kit 0.3.0

Plataforma web para registrar de forma gráfica el despliegue de redes FTTH:
mapa de fondo, login, y las herramientas para cargar la red (postes, cajas,
NAP, botellas, nodos, clientes, reservas y cables) desde la computadora o
desde el teléfono en la calle. Se instala en un servidor propio.

El nombre `ftth` (carpeta `/srv/ftth`, sitio `ftth.conf`, servicios
`ftth-auth` y `ftth-api`) es neutro a propósito: la instalación no queda atada
a ningún cliente, y cada cliente o despliegue es una "red" aparte.

## Qué queda instalado

| Pieza | Qué es | De quién depende |
|---|---|---|
| Visor | MapLibre GL JS 6.11.2, sin paso de compilación | De nadie: va todo en el kit |
| Login | Usuario y contraseña propios; servicio chico en Python, sin dependencias | De nadie |
| Red | API en Python (sin dependencias) y base SQLite con redes, elementos y cables | De nadie |
| Calles | OpenStreetMap en mosaicos vectoriales (PMTiles), Argentina y países vecinos, 2,2 GB | De nadie una vez descargado |
| Satélite | Esri World Imagery | De Esri, en línea |
| IGN | Argenmap, la cartografía oficial | Del IGN, en línea |
| Ortofotos IGN | Fotos aéreas 2011 a 2022 de algunas localidades (vuelos y dron) | Del IGN, en línea y lento |
| Buscador | La red cargada, y Nominatim (OpenStreetMap) para lugares | Nominatim: servicio público compartido |

Con el mapa "Calles" el navegador no le pide nada a terceros. Las otras capas
se consultan recién cuando alguien las elige.

## Cómo se usa

- **Redes.** El botón de arriba de la barra muestra la red en uso; tocándolo
  se elige otra o se crea una nueva (un cliente, una localidad, un
  despliegue). Cada red tiene sus propios elementos y cables.
- **Elementos.** Nodo/OLT, poste, caja de distribución, NAP, botella de
  empalme, cliente y reserva de cable. Se elige el tipo en la barra y se
  toca el mapa donde va; el nombre se sugiere solo (P-001, NAP-002…). Cada
  ficha tiene estado (proyectado, instalado, activo, de baja), los datos
  propios del tipo (splitter y puertos de la NAP, material y altura del
  poste, ONT y potencia del cliente…) y notas. La potencia se califica como
  buena, justa o baja.
- **Cables.** Herramienta Cable: se toca punto por punto y se termina con
  Terminar (o doble clic). Los puntos que caen sobre un elemento quedan
  pegados a él: si después se mueve el poste, el cable lo sigue. Tipo
  (troncal, distribución, bajada), fibras, tendido, reservas en metros; el
  largo se calcula solo.
- **Ver, mover, editar, borrar.** Con "Ver", tocar algo abre su ficha. Desde
  la ficha: Editar, Mover (y tocar el lugar nuevo), Trazado en los cables
  (mover puntos, agregar con los puntos blancos intermedios, quitar), Borrar.
- **En el teléfono.** Al elegir una herramienta aparece una mira en el centro
  del mapa: se mueve el mapa hasta que la mira quede en el lugar y se toca
  "Colocar acá" o "Agregar punto". Así el dedo no tapa lo que se está
  ubicando; tocar el mapa directamente también funciona. Con el botón de
  ubicación, la mira queda donde está uno parado.
- **Buscar.** El buscador de arriba encuentra elementos y cables por nombre o
  por número de abonado; si no hay nada en la red, busca el lugar.
- **Varios usuarios a la vez.** Todo se guarda en el servidor al momento; lo
  que cargan otros aparece solo a los pocos segundos. Si dos personas editan
  lo mismo a la vez, al segundo que guarda se le avisa y se le muestra la
  versión actual.

## Requisitos

- Debian 12 o 13, o Ubuntu 22.04 o 24.04, con acceso root. x86_64 o arm64.
  Sirve un contenedor LXC sin privilegios.
- Disco: 3 GB para instalar y 8 GB para actualizar el mapa con holgura (cada
  copia ocupa 2,2 GB y se guarda la anterior). Memoria y CPU: lo mínimo.
- Salida a internet hacia `github.com`, `build.protomaps.com` y
  `build-metadata.protomaps.dev` durante la instalación.
- Recomendado: una máquina virtual o contenedor dedicado. El script agrega un
  sitio a nginx y no toca los que ya existan, pero no instala nginx encima de
  otro servidor web (Apache, Caddy) que ya use el puerto 80.

## Instalación

Todo se ejecuta en el servidor; no hace falta copiar archivos desde afuera.

```bash
apt-get install -y git
git clone https://github.com/zalems/traza.git
cd traza

./diagnostico.sh           # solo lee: muestra cómo está el servidor
./instalar.sh --simular    # muestra lo que haría, sin cambiar nada
./instalar.sh              # instala; queda en http://IP-del-servidor:8080
```

(Si no se es root, anteponer `sudo` a los tres últimos.)

El último comando tarda lo que tarde la descarga de 2,2 GB. Al terminar
comprueba por HTTP que todo se sirva bien, login y API incluidos, y pide crear
el primer usuario.

El script es idempotente: se puede ejecutar las veces que haga falta y cada
vez cambia solo lo que falta. Instala él mismo `nginx`, `curl` y `python3` si
no están.

### Usuarios

Todos los usuarios tienen los mismos permisos. Se administran desde el
servidor; no hay registro desde la web.

```bash
/srv/ftth/bin/usuarios listar
/srv/ftth/bin/usuarios agregar NOMBRE     # pide la contraseña (mínimo 8 caracteres)
/srv/ftth/bin/usuarios clave NOMBRE       # cambia la contraseña
/srv/ftth/bin/usuarios quitar NOMBRE      # borra el usuario y cierra sus sesiones
```

La sesión dura 30 días desde el último uso, así que en el teléfono no hay que
entrar cada vez. Tras 8 intentos fallidos en 15 minutos, la IP o el usuario
quedan bloqueados hasta un cuarto de hora. Las contraseñas se guardan con scrypt;
los tokens de sesión, como hash. Cada cambio en la red queda registrado con
quién lo hizo y cuándo.

### Publicarlo con nombre y HTTPS

Sin HTTPS el navegador no entrega la ubicación del GPS, así que para usarlo en
la calle hace falta un nombre de dominio y un certificado.

```bash
./instalar.sh --dominio mapa.ejemplo.com.ar
```

Eso publica en el puerto 80. Con el DNS apuntando al servidor y el puerto 80
abierto desde internet:

```bash
apt-get install -y certbot
certbot certonly --webroot -w /srv/ftth/acme -d mapa.ejemplo.com.ar \
     --deploy-hook "systemctl reload nginx"
./instalar.sh --dominio mapa.ejemplo.com.ar
```

La segunda ejecución detecta el certificado, activa HTTPS con HTTP/2 y
redirige el puerto 80 al 443. Las renovaciones de certbot siguen funcionando
solas porque la validación queda servida por HTTP, sin login.

Si adelante ya hay un proxy que termina el HTTPS, usar
`--dominio NOMBRE --puerto 8080`: publica por nombre en ese puerto y no
configura certificados.

### Opciones

`./instalar.sh --ayuda` las lista todas. Las más usadas:

| Opción | Para qué |
|---|---|
| `--dominio NOMBRE` | Publicar por nombre (80 y, con certificado, 443) |
| `--puerto N` | Elegir el puerto HTTP |
| `--bbox O,S,E,N` y `--nombre-mapa X` | Otra zona para el mapa de calles |
| `--actualizar-mapa` | Bajar el build más nuevo de OpenStreetMap |
| `--sin-mapa`, `--sin-nginx` | Saltar esas partes |
| `--volver`, `--volver-mapa` | Volver a la versión anterior del visor o del mapa |
| `--simular` | Mostrar sin ejecutar |

Los servicios escuchan solo en la propia máquina: el de sesión en
`127.0.0.1:8900` y la API en `127.0.0.1:8901`. Si alguno de esos puertos está
ocupado, `FTTH_AUTH_PORT=8910 FTTH_API_PORT=8911 ./instalar.sh …` usa otros
(hay que repetir las variables en cada ejecución). La API solo atiende
pedidos que trae nginx con una clave que comparten (generada en la
instalación): ningún otro programa de la máquina puede hablarle haciéndose
pasar por un usuario.

## Dónde queda cada cosa

```
/srv/ftth/
  web -> releases/0.3.0-xxxxxxxx         visor en uso (enlace; se cambia de forma atómica)
  releases/                              versión en uso y la anterior
  config/config.local.js                 ajustes de esta instalación; el script nunca lo pisa
  tiles/argentina-AAAAMMDD-xxxx.pmtiles  mapa de calles (xxxx resume la zona)
  tiles/mundo-AAAAMMDD.pmtiles           el mundo a poco zoom (fondo al alejar)
  tiles/basemap.json                     dice qué archivos usa el visor
  auth/ftth-auth.py                      servicio de sesión (Python, sin dependencias)
  api/ftth-api.py                        API de la red (Python, sin dependencias)
  data/ftth.db                           usuarios y sesiones (SQLite)
  data/red.db                            redes, elementos, cables e historial (SQLite)
  data/api.secreto                       clave entre nginx y la API
  bin/usuarios                           administración de usuarios
  bin/respaldo                           copia de seguridad de las bases
  bin/pmtiles                            herramienta que recorta el mapa
  acme/                                  validación de Let's Encrypt
  backups/                               copias del sitio de nginx anteriores (últimas 10)
/etc/nginx/sites-available/ftth.conf   sitio de nginx
/etc/nginx/ftth-api-secreto.inc        la clave para la API, que el sitio incluye (solo root)
/etc/systemd/system/ftth-auth.service  servicio de sesión (usuario de sistema ftth)
/etc/systemd/system/ftth-api.service   API de la red (usuario de sistema ftth)
/var/log/nginx/ftth.access.log, ftth.error.log
journalctl -u ftth-auth / -u ftth-api  registro de los servicios (cada cambio en la red deja una línea)
```

## Mantenimiento

**Actualizar.** En la carpeta del repositorio, `git pull` y `./instalar.sh`
con las mismas opciones de siempre. Si algo falla a mitad de camino, el visor
anterior sigue en uso. `--volver` vuelve al visor anterior.

**Copia de seguridad.** `sudo /srv/ftth/bin/respaldo` deja en
`/root/respaldos-ftth/FECHA/` una copia coherente de los usuarios
(`ftth.db`), la red (`red.db`) y los ajustes, sin detener nada (se le puede
pasar otra carpeta). Conviene programarla y llevarse las copias fuera del
servidor. Para restaurar: `systemctl stop ftth-api ftth-auth`, copiar los
`.db` a `/srv/ftth/data/` (dueño `ftth`, borrando los `-wal` y `-shm` que
haya), y `systemctl start ftth-auth ftth-api`.

**Actualizar las calles.** `./instalar.sh --actualizar-mapa` baja el build del
día, lo verifica y recién entonces lo pone en uso. `--volver-mapa` vuelve al
anterior. Con una vez cada uno o dos meses alcanza. Si en una localidad falta
una calle, se puede cargar en openstreetmap.org y aparece en el build
siguiente.

**Ajustes.** Se editan en `/srv/ftth/config/config.local.js`; los valores
posibles están comentados en `web/js/config.js`. Ejemplo: arrancar en híbrido
y quitar las ortofotos.

```js
export default {
  initialBase: 'hybrid',
  ortho: null,
};
```

**Quitar todo.** `./desinstalar.sh` saca el sitio de nginx, detiene los
servicios y deja los archivos. Con `--borrar-datos` también borra lo que el
kit puso en `/srv/ftth` (usuarios y red incluidos: hacer antes un respaldo) y
el usuario de sistema `ftth`. No desinstala nginx ni lo detiene.

**nginx detenido.** El script no inicia un nginx que encuentre parado (puede
estar así a propósito): avisa y se detiene. Solo lo inicia cuando lo instaló él
mismo.

## Sobre las imágenes satelitales

Es el punto débil de cualquier opción gratuita, y conviene saberlo antes de
salir a relevar:

- **Esri** tiene imagen propia hasta el nivel 17 de mosaicos (alrededor de 1 m
  por píxel) en la mayor parte del interior. Alcanza para ver manzanas, techos
  y calles; no para distinguir un poste. Más allá de ese nivel el servicio
  devuelve un mosaico gris; el visor lo detecta y amplía la imagen del nivel
  anterior, por eso al acercar mucho se ve borroso en lugar de gris.
- **Ortofotos del IGN**: donde existen son mucho más nítidas (vuelos sobre
  ciudades y vuelos con dron sobre localidades chicas), pero son de 2011 a 2022
  y el servidor del IGN es lento. La licencia permite copiarlas, así que para
  una localidad puntual conviene bajarlas una vez y servirlas desde acá.
- **Para producción con Esri** corresponde una cuenta de ArcGIS Location
  Platform (tiene un nivel gratuito) y usar en `imagery.template` la plantilla
  con `?token=` que indica su documentación. No está escrita en el kit porque
  sin una clave no se pudo probar.

## Con otro servidor web

`./instalar.sh --sin-nginx` deja los archivos e instala los dos servicios, y
no configura nada más. El servidor que se use tiene que:

1. publicar `/srv/ftth/web/` como raíz del sitio;
2. publicar `/srv/ftth/tiles/` en `/tiles/` aceptando peticiones `Range`;
3. publicar `/srv/ftth/config/config.local.js` en `/config.local.js`;
4. entregar los archivos `.mjs` con tipo `text/javascript`;
5. pasar `/auth/` a `http://127.0.0.1:8900` y exigir, para todo lo demás
   salvo `/login.html` y `/assets/ui/`, que `GET /auth/check` (con las cookies
   del visitante) responda 200; si responde 401, redirigir a `/login.html`;
6. pasar `/api/` a `http://127.0.0.1:8901` solo con sesión (sin sesión,
   responder 401 sin redirigir), agregando dos cabeceras: `X-Usuario` con lo
   que devolvió `/auth/check` en su cabecera `X-Usuario`, y `X-Ftth-Secreto`
   con el contenido de `/srv/ftth/data/api.secreto`; pisar cualquier
   `X-Usuario` que mande el navegador.

En nginx eso es `auth_request`; `/etc/nginx/sites-available/ftth.conf` de una
instalación normal sirve de referencia.

## Pruebas

`python3 -m unittest discover -s pruebas` prueba la API (validaciones,
cables pegados que siguen a los elementos, conflictos entre dos usuarios,
historial, clave de nginx) con una base temporal.

## Qué se probó y qué no

Probado de punta a punta en Ubuntu 24.04 con nginx 1.24, en un contenedor sin
systemd: instalación desde cero, actualización desde 0.2.0 tal como está en
producción (con la API caída a mitad de camino, el visor viejo sigue en uso),
segunda ejecución sin cambios, vueltas atrás, publicación por dominio, HTTPS
con un certificado de prueba, login y desinstalación. Las herramientas se
probaron en Chromium en escritorio (mouse) y en teléfono emulado (táctil,
390 × 844 y 375 × 667): crear redes, los siete tipos de elemento, cables
pegados, mover un poste y que el cable lo siga, editar el trazado (arrastrar,
agregar y quitar puntos), conflicto entre dos usuarios, borrar, buscar,
recargar, cortes de conexión, y la mira del teléfono. Hubo además una revisión
independiente del código; sus hallazgos quedaron corregidos.

Probado en una instalación real (0.2.0, Debian 13 en LXC con systemd): la
descarga de `pmtiles` desde GitHub, systemd para nginx y el servicio de
sesión, y la emisión del certificado con certbot.

No se pudo probar, y hay que mirarlo en la primera actualización real:

- El servicio nuevo `ftth-api` con systemd (unidad, arranque, reinicio).
- Teléfonos reales, Safari y Firefox.
- Ubuntu 22.04 y la arquitectura arm64.

## Licencias

Ver `LICENCIAS.md`. Las atribuciones que exige cada fuente ya se muestran en el
mapa y no hay que quitarlas.
