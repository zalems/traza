# Cambios

## 0.4.0 · 14/10/2026

Cartas de empalme.

- Fibras de cada cable: fibras por tubo (automático: hasta 12 en un tubo, si
  no tubos de 12) y código de colores TIA-598 o ABNT (tubo piloto verde,
  direccional amarillo, el resto blancos). Del 13 en adelante, los colores
  con marca. La ficha del cable muestra las fibras por tubo y dónde está
  unida cada una; el formulario adelanta cómo quedan los tubos.
- Carta de empalme en botellas, cajas, NAP y nodos: cables a los costados
  (lo que viene del nodo a la izquierda), tubos plegables, fibras en
  colores, uniones dibujadas como líneas. Unir tocando dos extremos, "Seguir
  en orden" con el resto del tubo (o del splitter, o de la OLT), deshacer,
  quitar. Cables que pasan (sangrías): las fibras sin tocar siguen de largo y
  se dibujan de lado a lado; al unir una, queda cortada en ese elemento.
- Splitters PLC (1x2 a 1x128 y 2xN) y desbalanceados (1/99 a 50/50), con
  salidas fusionadas o con conector (en la NAP vienen con conector). OLT con
  puertos PON y potencia de salida en los nodos.
- Recorrido de un pelo, de la OLT al cliente: tramos con largo, fusiones,
  conectores y splitters, y el camino resaltado en el mapa. La ficha del
  cliente dice en qué NAP y puerto está y de qué PON viene.
- Vista en lista y copia como texto de la carta; los cables que terminan
  cerca sin pegar se pueden pegar desde la carta; de qué lado va cada cable
  se guarda para todos.
- El servidor cuida la carta: no deja bajar las fibras de un cable ni
  cambiarle el trazado si eso deja uniones colgando, ni que un cable pase dos
  veces por la misma caja; al borrar un cable, un splitter o un elemento se
  van también sus uniones (avisado antes). Esquema 2 de la base, con
  migración automática desde 0.3.0.
- Copia de seguridad diaria (timer de systemd, conserva 30) y copia de la red
  antes de cambiar la API en cada actualización. `bin/respaldo` admite
  `--conservar N` y `--etiqueta TEXTO`.
- Los datos que la versión anterior guardaba en campos que ya no están en el
  formulario (el splitter anotado de cajas y NAP) se conservan y se muestran.

## 0.3.0 · 14/10/2026 · commit 67b5a4e

Herramientas para cargar la red.

- Redes: una por cliente, localidad o despliegue, con selector en la barra.
- Siete tipos de elemento (nodo/OLT, poste, caja, NAP, botella, cliente,
  reserva), cada uno con ícono propio en el mapa y ficha con estado, datos
  propios y notas. La potencia en la ONT del cliente se califica (buena,
  justa, baja).
- Cables dibujados punto por punto; los puntos que caen sobre un elemento
  quedan pegados y lo siguen si se lo mueve. Tipo, fibras, tendido, reservas y
  largo calculado.
- Mover elementos, editar el trazado de los cables (arrastrar, agregar y
  quitar puntos) y borrar, con confirmación.
- En pantallas táctiles, una mira en el centro del mapa con botones "Colocar
  acá", "Agregar punto" y "Mover acá".
- Buscador: encuentra elementos y cables por nombre o número de abonado.
- Varios usuarios a la vez: lo que carga uno aparece a los demás en pocos
  segundos; si dos editan lo mismo, al segundo se le avisa y se le muestra la
  versión actual. Historial de cambios con usuario y fecha.
- API nueva (`api/ftth-api.py`, servicio `ftth-api`, base `data/red.db`),
  detrás de nginx con el mismo login y una clave compartida con nginx.
- `bin/respaldo`: copia coherente de usuarios, red y ajustes sin detener nada.
- Instalador: activa el visor nuevo recién cuando la API y nginx están listos;
  espera a que nginx atienda con la configuración nueva antes de verificar;
  la actualización desde 0.2.0 no reinicia el servicio de sesión.
- Pruebas automáticas de la API en `pruebas/`.

## 0.2.0 · 13/10/2026 · commit 6dc516a

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
