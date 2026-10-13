# Mapa base FTTH · kit 0.2.0

Primer bloque de la plataforma de registro de despliegue FTTH: el mapa de fondo,
el login y su instalación en un servidor propio. Todavía no dibuja red; deja
listo el lienzo sobre el que van a ir cables, cajas, NAP y botellas.

El nombre `ftth` (carpeta `/srv/ftth`, sitio `ftth.conf`, servicio
`ftth-auth`) es neutro a propósito: la instalación no queda atada a ningún
cliente.

## Qué queda instalado

| Pieza | Qué es | De quién depende |
|---|---|---|
| Visor | MapLibre GL JS 6.11.2, sin paso de compilación | De nadie: va todo en el kit |
| Login | Usuario y contraseña propios; servicio chico en Python, sin dependencias | De nadie |
| Calles | OpenStreetMap en mosaicos vectoriales (PMTiles), Argentina y países vecinos, 2,2 GB | De nadie una vez descargado |
| Satélite | Esri World Imagery | De Esri, en línea |
| IGN | Argenmap, la cartografía oficial | Del IGN, en línea |
| Ortofotos IGN | Fotos aéreas 2011 a 2022 de algunas localidades (vuelos y dron) | Del IGN, en línea y lento |
| Buscador | Nominatim (OpenStreetMap) | Servicio público compartido |

Con el mapa "Calles" el navegador no le pide nada a terceros. Las otras capas
se consultan recién cuando alguien las elige.

## Requisitos

- Debian 12 o 13, o Ubuntu 22.04 o 24.04, con acceso root. x86_64 o arm64.
  Sirve un contenedor LXC sin privilegios.
- Disco: 3 GB para instalar y 8 GB para actualizar el mapa con holgura (cada
  copia ocupa 2,2 GB y se guarda la anterior). Memoria y CPU: lo mínimo; son
  archivos estáticos más un servicio de sesión que casi no consume.
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

(Si no se es root, anteponer `sudo` a los tres últimos. Si se recibió el kit
como `ftth-mapa-base-0.2.0.tar.gz`, `tar xzf` y entrar a la carpeta reemplaza
al `git clone`.)

El último comando tarda lo que tarde la descarga de 2,2 GB. Al terminar
comprueba por HTTP que todo se sirva bien, incluido el login, y pide crear el
primer usuario.

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
los tokens de sesión, como hash.

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

El servicio de sesión escucha solo en `127.0.0.1:8900`; si ese puerto está
ocupado, `FTTH_AUTH_PORT=8901 ./instalar.sh …` usa otro.

## Dónde queda cada cosa

```
/srv/ftth/
  web -> releases/0.2.0-xxxxxxxx         visor en uso (enlace; se cambia de forma atómica)
  releases/                              versión en uso y la anterior
  config/config.local.js                 ajustes de esta instalación; el script nunca lo pisa
  tiles/argentina-AAAAMMDD-xxxx.pmtiles  mapa de calles (xxxx resume la zona)
  tiles/mundo-AAAAMMDD.pmtiles           el mundo a poco zoom (fondo al alejar)
  tiles/basemap.json                     dice qué archivos usa el visor
  auth/ftth-auth.py                      servicio de sesión (Python, sin dependencias)
  data/ftth.db                           usuarios y sesiones (SQLite; solo lo lee el usuario ftth)
  bin/usuarios                           administración de usuarios
  bin/pmtiles                            herramienta que recorta el mapa
  acme/                                  validación de Let's Encrypt
  backups/                               copias del sitio de nginx anteriores (últimas 10)
/etc/nginx/sites-available/ftth.conf   único archivo que se agrega a nginx
/etc/systemd/system/ftth-auth.service  servicio de sesión (usuario de sistema ftth)
/var/log/nginx/ftth.access.log, ftth.error.log
journalctl -u ftth-auth                registro del servicio de sesión
```

## Mantenimiento

**Actualizar el visor.** En la carpeta del repositorio, `git pull` y
`./instalar.sh` con las mismas opciones. `--volver` deshace el cambio.

**Actualizar las calles.** `./instalar.sh --actualizar-mapa` baja el build del
día, lo verifica y recién entonces lo pone en uso. `--volver-mapa` vuelve al
anterior. Con una vez cada uno o dos meses alcanza. Si en una localidad falta
una calle, se puede cargar en openstreetmap.org y aparece en el build
siguiente.

**Copia de seguridad.** Lo único que no se puede regenerar es
`/srv/ftth/data/ftth.db` (usuarios) y `/srv/ftth/config/config.local.js`.

**Ajustes.** Se editan en `/srv/ftth/config/config.local.js`; los valores
posibles están comentados en `web/js/config.js`. Ejemplo: arrancar en híbrido
y quitar las ortofotos.

```js
export default {
  initialBase: 'hybrid',
  ortho: null,
};
```

**Quitar todo.** `./desinstalar.sh` saca el sitio de nginx, detiene el
servicio de sesión y deja los archivos. Con `--borrar-datos` también borra lo
que el kit puso en `/srv/ftth` (usuarios incluidos) y el usuario de sistema
`ftth`. No desinstala nginx ni lo detiene.

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

`./instalar.sh --sin-nginx` deja los archivos, instala el servicio de sesión y
no configura nada más. El servidor que se use tiene que:

1. publicar `/srv/ftth/web/` como raíz del sitio;
2. publicar `/srv/ftth/tiles/` en `/tiles/` aceptando peticiones `Range`;
3. publicar `/srv/ftth/config/config.local.js` en `/config.local.js`;
4. entregar los archivos `.mjs` con tipo `text/javascript`;
5. pasar `/auth/` a `http://127.0.0.1:8900` y exigir, para todo lo demás
   salvo `/login.html` y `/assets/ui/`, que `GET /auth/check` (con las cookies
   del visitante) responda 200; si responde 401, redirigir a `/login.html`.
   En nginx eso es `auth_request`; `ftth.conf` sirve de referencia.

## Qué se probó y qué no

Probado de punta a punta en Ubuntu 24.04 con nginx 1.24, en un contenedor sin
systemd: instalación desde cero, segunda ejecución sin cambios, actualización
del visor y del mapa con sus vueltas atrás, publicación por dominio, HTTPS con
un certificado de prueba, rechazo de una configuración inválida de nginx con
restauración de la anterior, login (entrar, contraseña incorrecta, bloqueo por
intentos, sesión que sobrevive a recargar, salir) y desinstalación. El visor
se probó en Chromium en tamaño de escritorio y de teléfono.

No se pudo probar, y hay que mirarlo en la primera instalación real:

- La descarga de `pmtiles` desde GitHub. La dirección y la suma SHA-256 salen
  de la página de la versión 1.31.2; si no coinciden, el script se detiene sin
  instalar nada.
- El arranque y la recarga de nginx y del servicio `ftth-auth` con systemd
  (`systemctl`).
- Debian, Ubuntu 22.04 y la arquitectura arm64.
- La emisión real de un certificado con certbot.
- Teléfonos reales, Safari y Firefox.

## Licencias

Ver `LICENCIAS.md`. Las atribuciones que exige cada fuente ya se muestran en el
mapa y no hay que quitarlas.
