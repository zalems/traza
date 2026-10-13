# Cambios

## 0.2.0 · 13/10/2026

Login y entrega por repositorio.

- Login con usuario y contraseña, todos con los mismos permisos. nginx no
  entrega nada sin sesión (`auth_request`); el servicio de sesión es un
  programa en Python sin dependencias (`ftth-auth`, usuario de sistema
  `ftth`, SQLite en `data/ftth.db`, contraseñas con scrypt, sesiones de 30
  días, bloqueo tras 8 intentos fallidos).
- `bin/usuarios listar | agregar | clave | quitar` para administrar usuarios
  desde el servidor. El instalador pide el primer usuario al terminar.
- Pantalla de entrada (`login.html`) con el mismo estilo del visor; conserva
  la posición del mapa al volver a entrar. Botón "Salir" en el panel del visor.
- La verificación final del instalador también prueba el login: redirección
  sin sesión, entrar, ver el mapa con sesión, salir.
- El instalador instala `curl` y `python3` si faltan (contenedores recién
  creados) y comprueba que nginx traiga `auth_request`.
- `diagnostico.sh` muestra el estado del servicio de sesión y la cantidad de
  usuarios. `desinstalar.sh` detiene y quita el servicio.
- Instalación pensada desde un `git clone` en el servidor: no hace falta
  copiar archivos desde afuera.

## 0.1.0 · 13/10/2026

Primera versión: mapa base e instalación.

- Visor con MapLibre GL JS 6.11.2 y cuatro mapas de base: Calles
  (OpenStreetMap propio), Híbrido, Satélite (Esri) e IGN (Argenmap), más las
  ortofotos del IGN (vuelos y dron) como capa opcional sobre el satélite.
- Mapa de calles servido desde el propio servidor como PMTiles, con el mundo a
  poco zoom de fondo para que al alejar no quede un hueco.
- Satélite: donde Esri no tiene imagen al zoom pedido, se amplía la del nivel
  anterior en lugar de mostrar el mosaico gris del servicio.
- Ubicación por GPS, buscador de localidades y coordenadas, coordenadas de un
  punto con clic derecho o toque largo, y recuerdo de la última posición y del
  mapa elegido.
- `instalar.sh` idempotente, con simulación, vuelta atrás del visor y del mapa,
  y verificación al terminar. `diagnostico.sh` y `desinstalar.sh`.
