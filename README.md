# Plataforma FTTH · kit 0.7.0

Plataforma web para registrar de forma gráfica el despliegue de redes FTTH:
mapa de fondo, login, las herramientas para cargar la red (postes, cajas,
NAP, botellas, nodos, clientes, reservas y cables) y las cartas de empalme
(fibras con sus colores, fusiones, splitters y el recorrido de cada pelo),
desde la computadora o desde el teléfono en la calle. Si se conecta con
Wispro y con el panel de la OLT, cada NAP muestra sus clientes y la potencia
de sus ONTs. Se instala en un servidor propio.

El nombre `ftth` (carpeta `/srv/ftth`, sitio `ftth.conf`, servicios
`ftth-auth` y `ftth-api`) es neutro a propósito: la instalación no queda atada
a ningún cliente, y cada cliente o despliegue es una "red" aparte.

## Qué queda instalado

| Pieza | Qué es | De quién depende |
|---|---|---|
| Visor | MapLibre GL JS 6.11.2, sin paso de compilación | De nadie: va todo en el kit |
| Login | Usuario y contraseña propios; servicio chico en Python, sin dependencias | De nadie |
| Red | API en Python (sin dependencias) y base SQLite con redes, elementos, cables y cartas de empalme | De nadie |
| Calles | OpenStreetMap en mosaicos vectoriales (PMTiles), Argentina y países vecinos, 2,2 GB | De nadie una vez descargado |
| Satélite | Esri World Imagery | De Esri, en línea |
| IGN | Argenmap, la cartografía oficial | Del IGN, en línea |
| Ortofotos IGN | Fotos aéreas 2011 a 2022 de algunas localidades (vuelos y dron) | Del IGN, en línea y lento |
| Buscador | La red cargada, y Nominatim (OpenStreetMap) para lugares | Nominatim: servicio público compartido |
| Wispro y OLT | Opcional, red por red: traza lee las NAPs, contratos y clientes de Wispro y las potencias del panel de la OLT (SmartOLT libre); no cambia nada en ellos | De Wispro (en línea) y del panel, si se conectan |

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
  propios del tipo (puertos de la NAP, material y altura del poste, ONT y
  potencia del cliente…) y notas. La potencia se califica como buena, justa
  o baja.
- **Cables.** Herramienta Cable: se toca punto por punto y se termina con
  Terminar (o doble clic). Los puntos que caen sobre un elemento quedan
  pegados a él: si después se mueve el poste, el cable lo sigue. Tipo
  (troncal, distribución, bajada), fibras, fibras por tubo, código de
  colores (TIA-598: azul, naranja, verde…; o ABNT, el de los cables
  brasileños: verde, amarillo, blanco…), tendido, reservas en metros; el
  largo se calcula solo. La ficha del cable muestra sus fibras por tubo, en
  colores, y en qué cartas está unida cada una.
- **Carta de empalme.** En botellas, cajas, NAP y nodos, el botón "Carta de
  empalme" muestra los cables que llegan, con sus tubos y fibras en colores:
  a la izquierda lo que viene del nodo y a la derecha lo que sale (se puede
  cambiar). Se une tocando una fibra y después la otra; "Seguir en orden"
  une el resto del tubo de una vez, y "Deshacer" vuelve atrás. En un cable
  que pasa por el elemento (sangría), las fibras que no se tocan siguen de
  largo; al unir una, queda cortada ahí. Splitters PLC (1x2 a 1x128, también
  2xN) o desbalanceados (1/99 a 50/50), con salidas fusionadas o con
  conector; en el nodo, la OLT con sus puertos PON. "Ver lista" la muestra
  como tabla y "Copiar" la deja como texto para mandar por mensaje. Si un
  cable termina cerca sin quedar pegado, la carta ofrece pegarlo.
- **Acomodar la carta.** En "Columnas", cada cable y equipo se sube, se baja
  o se pasa de lado arrastrándolo desde su asa (los seis puntos), con los
  botones Subir y Bajar o con las flechas del teclado. En "Libre", cada uno
  va donde se lo deja, sobre una bandeja que se mueve arrastrando el fondo y
  se acerca con dos dedos, con la rueda y Control o con + y −; "Ajustar"
  muestra toda la carta y "Reacomodar" vuelve a ponerla en columnas. Lo que
  se acomoda queda guardado para todos (después de arrastrar o reacomodar,
  "Deshacer" lo vuelve atrás); columnas o libre lo elige cada dispositivo (en
  el teléfono suelen convenir las columnas). Acomodar no le quita a nadie lo
  que está editando en la ficha del elemento.
- **Pasar una unión a otra fibra.** Tocando una unión, "Pasar a otra fibra",
  se elige qué punta se mueve y se toca la fibra o el puerto nuevo: la unión
  cambia sin quitarla y volver a hacerla, y queda dicho quién la movió.
- **Recorrido de un pelo.** Desde una unión de la carta, una fibra de la
  ficha del cable o la ficha del cliente: por dónde va el pelo, de la OLT al
  cliente, con largo, fusiones, conectores y splitters. En el mapa cada tramo
  se pinta con el color de su fibra, rodeado por el de su tubo, y cambia en
  cada empalme. La ficha del cliente dice en qué NAP y puerto está conectado
  y de qué PON viene.
- **Potencia estimada.** Si la OLT tiene cargada su potencia de salida, el
  recorrido dice con cuánto se llega después de cada fusión, conector y
  splitter, y la ficha del cliente la compara con la potencia medida en la
  ONT (3 dB o más por debajo es para revisar). Se estima con 0,3 dB/km,
  0,1 dB por fusión, 0,5 dB por conector y la pérdida típica de cada splitter
  (PLC 1x8: 10,5 dB; desbalanceado: según el porcentaje de cada salida).
- **Wispro y la OLT.** Si la red está conectada (ver más abajo), la ficha de
  cada NAP la busca en Wispro por el nombre ("P5-C4" y "P5C4" son la misma);
  si no la encuentra, ofrece las NAPs de Wispro más cercanas para elegir.
  Muestra los contratos de esa caja con la potencia de cada ONT (la última
  lectura del panel de la OLT, o en vivo por Wispro con "Medir ahora") y
  cuáles ya están en el mapa, diciendo cómo se encontró cada uno: por la ONT,
  el número de contrato o de abonado (cerca del contrato o de su NAP), o el
  nombre cerca de su ubicación. Lo encontrado por el abonado o por el nombre
  se confirma con un toque y queda vinculado, o se descarta con "No es" (no se
  vuelve a proponer; desde la ficha del cliente se puede deshacer); lo que
  coincide por la ONT o el número de contrato anotados, si está mal, se
  corrige en el dato. Un contrato va con un solo cliente del mapa: si un dato
  coincide con varios, pregunta cuál es, y si un contrato está dos veces en el
  mapa, lo avisa. Los que faltan se agregan con un toque, en la ubicación que
  tienen en Wispro (salvo que quede a más de 2 km de la caja: suele ser un
  error de carga). Con eso hace la **medición virtual** de la potencia en las
  bocas de la caja: la de cada ONT más lo que pierde su bajada (por la carta
  si está dibujada; si no, dos conectores y la fibra), y la compara con lo que
  estima la carta. Avisa lo que hay que revisar: ONTs sin señal, varias que se
  cayeron juntas (el problema estuvo antes de la caja; si la causa es "dying
  gasp", fue un corte de luz), una bajada que llega bastante por debajo del
  resto o que viene bajando, clientes de la caja en distintos puertos PON y
  lecturas viejas del panel. La ficha del cliente muestra su contrato (y cómo
  se encontró, para confirmarlo o deshacerlo), su ONT, la potencia con su
  historia de 7 días y las caídas; si no aparece en Wispro, alcanza con
  anotarle el número de contrato o la ONT, y si sus datos son los de un
  contrato que en el mapa es otro cliente, lo dice (puede estar dibujado dos
  veces).
- **Traer la red de Wispro.** En el panel de redes (tocando el nombre de la
  red), "Traer cajas y clientes de Wispro" agrega de una vez todas las cajas
  de Wispro en la ubicación que tienen ahí, con su nombre y ya vinculadas, y
  los clientes de cada caja, vinculados a su contrato. Antes de agregar
  muestra cuántas cajas y clientes van a entrar y cuáles no, con el motivo
  (sin ubicación en Wispro, a más de 2 km de su caja, un cliente del mapa que
  podría ser el mismo). Una caja de Wispro a menos de 150 m de una caja del
  mapa sin vincular puede ser esa misma: queda aparte, con un toque para abrir
  la del mapa y vincularla o, si es otra, para agregarla igual. Se puede
  deshacer en el momento o más tarde (la última importación, desde la misma
  pantalla y con confirmación), salvo lo que ya se haya tocado o tenga cables.
  Se puede repetir cuando haya cajas o clientes nuevos en Wispro: solo agrega
  lo que falta. Trae toda la cuenta de Wispro: si la misma cuenta está
  conectada a otra red, lo avisa.
- **Ver, mover, editar, borrar.** Con "Ver", tocar algo abre su ficha. Desde
  la ficha: Editar, Mover (y tocar el lugar nuevo), Trazado en los cables
  (mover puntos, agregar con los puntos blancos intermedios, quitar), Borrar.
- **En el teléfono.** Al elegir una herramienta aparece una mira en el centro
  del mapa: se mueve el mapa hasta que la mira quede en el lugar y se toca
  "Colocar acá" o "Agregar punto". Así el dedo no tapa lo que se está
  ubicando; tocar el mapa directamente también funciona. Con el botón de
  ubicación, la mira queda donde está uno parado.
- **Buscar.** El buscador de arriba encuentra elementos y cables por nombre,
  número de abonado o dirección; si no hay nada en la red, busca el lugar.
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

### Wispro y el panel de la OLT

Se conectan desde el servidor, red por red. El token de la API de Wispro (en
Wispro: Configuración avanzada → ISP) se escribe ahí mismo, sin que se vea, y
queda en `/srv/ftth/data/integraciones.json`, que solo lee el usuario del
servicio: nunca pasa por el visor.

```bash
sudo /srv/ftth/bin/integraciones ver                                 # qué tiene conectado cada red
sudo /srv/ftth/bin/integraciones wispro ALVATIC                      # pide el token y lo prueba
sudo /srv/ftth/bin/integraciones panel ALVATIC http://10.10.0.230:8080  # pregunta cuál de sus OLT es de la red
sudo /srv/ftth/bin/integraciones probar ALVATIC                      # cuánto encuentra de cada lado
sudo /srv/ftth/bin/integraciones quitar ALVATIC                      # desconecta (o: quitar ALVATIC panel)
```

La red se nombra como en el visor o por su número. traza solo lee: no cambia
nada en Wispro ni en la OLT. Lee las NAPs, los contratos y los clientes de
Wispro cada 5 minutos como mucho, las ONTs del panel cada minuto y la
historia de cada ONT cada 5 minutos ("Actualizar", en la ficha, lee todo de
nuevo). Si el panel tiene varias OLT (por ejemplo la de otra empresa),
`integraciones panel` pregunta cuáles son de la red (o se indican con
`--olt N`): sin eso no se lee ninguna. Los clientes de una OLT que no está en
el panel (por ejemplo una V-SOL) igual se pueden medir en vivo por Wispro.

Todos los usuarios de una instalación tienen los mismos permisos: cualquiera
ve los contratos de Wispro (nombres, direcciones, ONTs) de todas las redes
conectadas y puede pedir mediciones en vivo. Por eso una instalación con
Wispro conectado no se comparte entre empresas: cada una, la suya.

Para ver cómo responden Wispro y el panel, sin guardar nada y sin mostrar
claves ni datos de los clientes: `python3 herramientas/muestras-olt-wispro.py`.

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
  web -> releases/0.7.0-xxxxxxxx         visor en uso (enlace; se cambia de forma atómica)
  releases/                              versión en uso y la anterior
  config/config.local.js                 ajustes de esta instalación; el script nunca lo pisa
  tiles/argentina-AAAAMMDD-xxxx.pmtiles  mapa de calles (xxxx resume la zona)
  tiles/mundo-AAAAMMDD.pmtiles           el mundo a poco zoom (fondo al alejar)
  tiles/basemap.json                     dice qué archivos usa el visor
  auth/ftth-auth.py                      servicio de sesión (Python, sin dependencias)
  api/ftth-api.py                        API de la red (Python, sin dependencias)
  data/ftth.db                           usuarios y sesiones (SQLite)
  data/red.db                            redes, elementos, cables, cartas de empalme e historial (SQLite)
  data/api.secreto                       clave entre nginx y la API
  data/integraciones.json                Wispro y el panel de la OLT de cada red (con el token; solo el usuario ftth)
  bin/usuarios                           administración de usuarios
  bin/integraciones                      conectar una red con Wispro y con el panel de la OLT
  bin/respaldo                           copia de seguridad de las bases
  bin/pmtiles                            herramienta que recorta el mapa
  acme/                                  validación de Let's Encrypt
  backups/                               copias del sitio de nginx anteriores (últimas 10)
/etc/nginx/sites-available/ftth.conf   sitio de nginx
/etc/nginx/ftth-api-secreto.inc        la clave para la API, que el sitio incluye (solo root)
/etc/systemd/system/ftth-auth.service  servicio de sesión (usuario de sistema ftth)
/etc/systemd/system/ftth-api.service   API de la red (usuario de sistema ftth)
/etc/systemd/system/ftth-respaldo.*    copia de seguridad diaria (servicio y timer)
/root/respaldos-ftth/                  las copias de seguridad
/var/log/nginx/ftth.access.log, ftth.error.log
journalctl -u ftth-auth / -u ftth-api  registro de los servicios (cada cambio en la red deja una línea)
```

## Mantenimiento

**Actualizar.** En la carpeta del repositorio, `git pull` y `./instalar.sh`
con las mismas opciones de siempre. Si algo falla a mitad de camino, el visor
anterior sigue en uso. `--volver` vuelve al visor anterior. Antes de cambiar
la API, el script copia la red en `/root/respaldos-ftth/FECHA-antes-de-VERSIÓN/`:
una API nueva puede actualizar la estructura de la base, y una API vieja no
abre una base nueva; para volver atrás del todo se restaura esa copia.

**Volver a una versión anterior.** `--volver` vuelve solo el visor. De 0.7.0 a
0.6.1 alcanza con `git checkout 8353557` e instalar: misma estructura de base
(lo que se trajo de Wispro queda como cualquier otro elemento). De 0.6.1 a
0.6.0 alcanza con `git checkout 5ea5b6d` e instalar (solo cambia el visor). De
0.6.0 a 0.5.0 alcanza con `git checkout 59f7e0f` e instalar: misma estructura
de base; la conexión con Wispro queda guardada sin usarse y los clientes
agregados desde Wispro quedan como cualquier otro. La copia diaria de 0.5.0 no
incluye `integraciones.json` (queda igual en `data/`), y `bin/integraciones`
queda pero no anda con la API de 0.5.0: se puede borrar con
`rm /srv/ftth/bin/integraciones`. De 0.5.0 a 0.4.0 alcanza con
`git checkout 6006a67` e instalar: usan la misma estructura de base. Después
hay que recargar la página en todos los dispositivos (una pestaña de 0.5.0 que
quede abierta puede borrar cómo están acomodadas las cartas), y lo acomodado
se pierde en cada carta la primera vez que se cambia un cable de lado en
0.4.0. Para volver a una versión con una estructura de base anterior (por
ejemplo de 0.4.0 a 0.3.0), se restaura la copia que el script hizo antes de
actualizar y se instala la versión vieja; lo cargado después de esa copia se
pierde:

```bash
systemctl stop ftth-api
cp /root/respaldos-ftth/AAAAMMDD-HHMMSS-antes-de-0.4.0/red.db /srv/ftth/data/red.db
rm -f /srv/ftth/data/red.db-wal /srv/ftth/data/red.db-shm
chown ftth:ftth /srv/ftth/data/red.db
git checkout 67b5a4e          # el commit de 0.3.0 (cada versión tiene el suyo en CHANGELOG.md)
./instalar.sh --dominio …      # las mismas opciones de siempre
```

Para volver a la última: `git checkout main && git pull && ./instalar.sh …`.
Las copias con etiqueta (las de antes de actualizar) no se borran solas.

**Copia de seguridad.** Se hace sola todos los días a las 03:30 (con hasta 20
minutos de margen al azar) y quedan las últimas 30 en `/root/respaldos-ftth/`
(otra cantidad: `FTTH_RESPALDOS=60 ./instalar.sh …`). A mano:
`sudo /srv/ftth/bin/respaldo`. Cada copia es coherente aunque haya gente
cargando: los usuarios (`ftth.db`), la red (`red.db`), los ajustes y la
conexión con Wispro y el panel (`integraciones.json`, con el token). La
réplica del contenedor a otro nodo no reemplaza estas copias (replica también
lo que se borra), y conviene llevarlas además fuera del servidor. Para
restaurar: `systemctl stop ftth-api ftth-auth`, copiar los `.db` y
`integraciones.json` a `/srv/ftth/data/` (dueño `ftth`; `integraciones.json`
con permisos 600; borrando los `-wal` y `-shm` que haya), y
`systemctl start ftth-auth ftth-api`.

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

`python3 -m unittest discover -s pruebas` prueba la API (validaciones, cables
pegados que siguen a los elementos, conflictos entre dos usuarios, historial,
clave de nginx, cartas de empalme y su disposición) con una base temporal, y
las integraciones contra un Wispro y un panel de la OLT falsos que responden
como los reales (cajas, contratos y cómo se cruza cada uno con los clientes
del mapa, ONTs por número de serie o por el número de contrato de su
descripción, mediciones en vivo, fallas y plazos, agregar dos veces a la vez,
traer toda la red de Wispro, deshacerlo y traerla dos veces a la vez, el
comando `integraciones`). `node pruebas/fibras.test.mjs` prueba la lógica de
fibras, colores, recorridos y potencias del visor, y
`node pruebas/integracion.test.mjs` la medición virtual y la estabilidad (Node
20.19 o más nuevo; el de Debian 13 sirve).

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

Probado en la instalación real (Debian 13 en LXC con systemd): el servicio
`ftth-api` (0.3.0 a 0.5.0), la actualización de 0.3.0 a 0.4.0 con la copia
previa y la migración de la base, la de 0.4.0 a 0.5.0 con la comprobación de
que atiende la API nueva, y la copia diaria del timer de systemd.

La integración con Wispro y el panel de la OLT (0.6.0) se escribió con las
respuestas reales de los dos (leídas el 14/10/2026 con
`herramientas/muestras-olt-wispro.py`) y se probó contra versiones falsas que
responden igual, en las pruebas de la API y en Chromium (escritorio, teléfono,
modo oscuro), y tuvo dos revisiones independientes: sus hallazgos quedaron
corregidos (entre otros, que agregar dos veces no duplique clientes, que un
contrato no quede con dos clientes, que no se mezcle la OLT de otra empresa y
que una ficha no tarde más que el minuto que espera nginx). Contra el Wispro y
el panel reales se prueba con `integraciones probar` después de instalar.
Traer la red de Wispro (0.7.0) se probó igual, contra el Wispro falso, en las
pruebas de la API y en Chromium (escritorio, teléfono, modo oscuro), y tuvo
una revisión independiente: sus hallazgos quedaron corregidos (poder deshacer
después de cerrar la pantalla, una caja dibujada a mano cerca de una de
Wispro, una NAP que Wispro entrega dos veces, la misma cuenta en dos redes, el
foco con el teclado). Con la red real, la vista previa dice qué va a agregar y
qué no antes de cambiar nada.

No se pudo probar, y hay que mirarlo en el uso real:

- Teléfonos reales, Safari y Firefox (en especial arrastrar y pellizcar en
  la carta en modo libre).
- La medición en vivo por Wispro (`status_ont`) con una ONT real: su
  respuesta se tomó de la documentación de Wispro.
- Cómo informa el panel una ONT apagada (si conserva su última potencia:
  traza la toma como sin señal) y cómo se llaman sus eventos de caída (en las
  muestras solo apareció "appeared"; traza reconoce offline, down, LOS y
  dying gasp).
- Ubuntu 22.04 y la arquitectura arm64.

## Licencias

Ver `LICENCIAS.md`. Las atribuciones que exige cada fuente ya se muestran en el
mapa y no hay que quitarlas.
