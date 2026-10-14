# Cambios

## 0.7.1 · 14/10/2026

Traer de Wispro, con lo que apareció en la red real.

- Elegir qué OLT de Wispro traer: la vista previa muestra cada OLT con sus cajas
  y cuántas tienen contratos, y trae las cajas (y los clientes de esas cajas) de
  las marcadas. Sin elegir, deja afuera la OLT que parece reemplazada por otra:
  casi sin contratos (5 % de sus cajas o menos) y con la mayoría de sus cajas en
  el mismo lugar que las de otra OLT que sí se usa (las de una OLT vieja,
  cargadas de nuevo en la nueva). La elección se recuerda en cada navegador.
- Lo que ya se trajo de una OLT que no se elige se quita del mapa con un toque
  (con confirmación): solo lo que agregó una importación y no se tocó después; lo
  dibujado a mano queda.
- Una caja del mapa sin vincular aparta una sola NAP de Wispro, la más cercana
  (a menos de 150 m), emparejando de a una, en vez de todas las de alrededor: con
  muchas NAPs juntas la lista se hacía interminable.
- `herramientas/ubicaciones-wispro.py RED`: cómo están las ubicaciones de las
  NAPs y de los contratos en Wispro, por OLT (solo cuentas y distancias, sin
  nombres ni coordenadas).
- API: `olts` en `GET /api/integracion/importacion?olts=A,B` y en el `POST`,
  `leer=0` (con la última lectura de Wispro) y
  `POST /api/integracion/importacion/quitar` `{red, olts}`; cada OLT trae
  `cajas`, `con_contratos`, `gemelas`, `en_mapa`, `clientes_en_mapa`,
  `reemplazada` y `elegida`.

## 0.7.0 · 14/10/2026 · commit 6be07f1

Traer la red de Wispro: todas las cajas y sus clientes al mapa, de una vez.

- Panel de redes: "Traer cajas y clientes de Wispro" (si la red está
  conectada). Primero muestra, sin cambiar nada, cuántas cajas y clientes
  faltan en el mapa y cuáles no se agregan, con el motivo: sin ubicación en
  Wispro, cliente a más de 2 km de su caja, un cliente del mapa que podría ser
  el mismo (se confirma desde la caja), contrato sin caja en Wispro. Se puede
  elegir cajas, clientes o las dos cosas.
- Las cajas van en la ubicación de Wispro, con su nombre, sus puertos y ya
  vinculadas; los clientes, en su ubicación de Wispro y vinculados a su
  contrato (los mismos datos que "Agregar al mapa" en una caja). Todo en una
  sola versión; el mapa se acomoda para mostrar lo agregado.
- Una NAP de Wispro a menos de 150 m de una caja del mapa sin vincular puede
  ser esa misma caja: no se agrega sola. Se muestra aparte, con un toque para
  abrir la caja del mapa (y vincularla desde su ficha) y una casilla para
  agregarla igual si es otra.
- "Deshacer" quita lo que agregó esa vez, salvo lo que ya se tocó o tiene
  cables, equipos o uniones. La última importación de la red se puede
  deshacer también más tarde, desde la misma pantalla (con confirmación). Si
  se cierra la pantalla mientras agrega, al terminar avisa qué se agregó y
  cómo deshacerlo.
- Repetirlo agrega solo lo nuevo: no duplica cajas ni clientes (se decide
  dentro de la misma transacción, como al agregar desde una caja), aunque
  Wispro entregue una NAP dos veces.
- Se trae toda la cuenta de Wispro: si la misma cuenta está conectada a otra
  red, lo avisa.
- Las casillas no rehacen la pantalla (el foco y lo desplegado quedan donde
  estaban); el foco va a lo leído, al resultado y a cada pregunta.
- API: `GET /api/integracion/importacion?red=N` (qué falta, las dudosas, la
  última importación), `POST /api/integracion/importacion`
  `{red, cajas, clientes, igual?}` y `POST /api/integracion/importacion/deshacer`
  `{red, version}`. Lo que se agrega queda en el historial con el número de la
  importación.

## 0.6.1 · 14/10/2026 · commit 8353557

Lecturas de la OLT con huecos: el visor no afirma más de lo que tiene.

- Si la historia de una ONT empieza hace poco (el panel de la OLT estuvo un
  tiempo sin leer), la ficha dice "desde el …" en vez de "en los últimos 7
  días" (rango de potencia, caídas, "sin caídas" y lo que varió).
- La tendencia "viene bajando X dB por semana" se calcula solo con al menos
  2 días de lecturas: sacada de unas horas exageraba cualquier variación.

## 0.6.0 · 14/10/2026 · commit 5ea5b6d

Wispro y el panel de la OLT en las NAP: clientes de cada caja, potencias,
medición virtual y estabilidad.

- Conexión por red, desde el servidor: `bin/integraciones` (`ver`, `wispro`,
  `panel`, `quitar`, `probar`). El token de Wispro se escribe sin que se vea y
  queda en `data/integraciones.json` (600, del usuario del servicio); nunca
  llega al visor, y no se manda a otro servidor si Wispro redirige. Si el
  panel tiene varias OLT, hay que decir cuáles son de la red: la de otra
  empresa nunca se lee por defecto. traza solo lee: no cambia nada en Wispro
  ni en la OLT.
- Ficha de la NAP: su NAP de Wispro (por el nombre, o elegida entre las más
  cercanas y guardada en la caja), los contratos de la caja con la potencia
  de cada ONT (del panel de la OLT por número de serie, o por el número de
  contrato con que empieza la descripción de la ONT; o en vivo por Wispro con
  "Medir ahora"), cuáles ya están en el mapa y cómo se encontró cada uno (por
  la ONT, el contrato, el abonado o el nombre cerca; un número cuenta si el
  cliente está a menos de 2 km del contrato o de su NAP) y "Agregar al mapa"
  los que faltan, con sus datos de Wispro. Lo encontrado por el abonado o el
  nombre se confirma con un toque y queda vinculado, o se descarta con "No
  es" (se puede deshacer); un contrato va con un solo cliente: si un dato
  coincide con varios clientes del mapa, se elige cuál, y un contrato que
  está dos veces en el mapa se avisa. No se agrega lo que ya podría estar, ni
  lo que en Wispro queda a más de 2 km de la caja.
- Medición virtual de la potencia en las bocas de la caja (la de cada ONT
  más lo que pierde su bajada) comparada con la estimada por la carta, y
  avisos: ONTs sin señal, caídas juntas (antes de la caja, o corte de luz si
  es "dying gasp"), una bajada que llega bajo, varía o viene bajando, PON
  distintos en una caja, la caja en otro PON en Wispro, lecturas viejas del
  panel.
- Ficha del cliente: contrato, titular y cómo se encontró (para
  confirmarlo o deshacerlo), NAP de Wispro, ONT, potencia (panel o en vivo)
  contra la estimada por la carta, historia de 7 días y caídas; si sus datos
  son los de un contrato que en el mapa es otro cliente, lo dice. Al anotarle
  el contrato o la ONT, la ficha vuelve a leer sola.
- El cliente tiene un campo nuevo, N.º de contrato. Las fechas se muestran
  con hora de 24 horas.
- API: `/api/integracion`, `/api/integracion/nap`,
  `/api/integracion/cliente` y sus `medir`, `/api/integracion/nap/importar`
  (todos o ninguno, una sola versión, decidido dentro de la misma
  transacción: dos pedidos a la vez no duplican),
  `/api/integracion/vincular` y `/api/integracion/desvincular` ("No es", y
  deshacerlo). Lo leído se guarda en memoria unos minutos; si Wispro o el
  panel fallan se sigue mostrando lo último leído, con el error, y cada
  lectura tiene un plazo para no pasar el minuto que espera nginx. Sin
  cambios en la base (esquema 2).
- La copia de seguridad incluye `integraciones.json`.
- `herramientas/muestras-olt-wispro.py`: muestra cómo responden el panel de
  la OLT y la API de Wispro (solo consulta; oculta claves, usuarios, IP, MAC
  y los datos de los clientes).

## 0.5.0 · 14/10/2026 · commit 59f7e0f

Acomodar la carta, aspecto más real, colores en el recorrido y potencias.

- Carta en columnas: cada cable y equipo se sube, se baja o se pasa de lado
  arrastrándolo desde su asa (con el mouse, también desde el nombre), con
  los botones Subir y Bajar o con las flechas. El orden queda guardado para
  todos.
- Carta libre: cada cable y equipo donde se lo deja, sobre una bandeja con
  zoom (dos dedos, rueda con Control, + y −) que se mueve arrastrando el
  fondo; "Ajustar" y "Reacomodar". Las posiciones quedan guardadas para
  todos; columnas o libre lo elige cada dispositivo. Acomodar no traba la
  carta: se ve al instante y se guarda un momento después; después de
  arrastrar o reacomodar se puede deshacer. Acomodar no choca con quien está
  editando la ficha del elemento (el servidor deja pasar la edición si lo
  único que cambió en el medio es la disposición).
- Pasar una unión a otra fibra o puerto sin quitarla (`PUT /api/fusiones/ID`),
  con el tipo recalculado (conector si el equipo tiene conectores) y quién la
  movió.
- Aspecto más real: la chaqueta de cada cable con la raya de su tipo, tubos
  con volumen y anillos del 13 en adelante, fibras como cuentas con brillo,
  uniones como fibras de dos colores con su protector de empalme (o el
  adaptador SC, verde APC o azul UPC), splitters y OLT como cajas con sus
  bocas. Lo que pasa sin cortar se dibuja junto, un trazo por color, para
  que un cable grande se vea rápido.
- Recorrido: en el mapa, cada tramo con el color de su fibra rodeado por el
  de su tubo (las marcas como anillos), cambiando en cada empalme; en la
  lista, el color de cada tramo.
- Potencia estimada a lo largo del recorrido desde la potencia de la OLT
  (0,3 dB/km, 0,1 dB por fusión, 0,5 dB por conector, PLC según salidas,
  desbalanceados según el porcentaje), y en la ficha del cliente, comparada
  con la medida en la ONT.
- `/api/salud` informa, a quien tiene la clave de nginx, el código de la API
  que atiende; el instalador verifica que sea el recién instalado antes de
  publicar el visor nuevo (que no quedó una API vieja andando).
- La API rechaza con 400 (no con un error interno) números imposibles en
  coordenadas y posiciones, y NaN o Infinity en el cuerpo.
- La disposición de la carta (`carta` del elemento) llega como cambio
  parcial: `lados`, `orden` y `pos` (las posiciones se suman; `null` quita).
- Pruebas de la lógica de fibras del visor en `pruebas/fibras.test.mjs`.

## 0.4.0 · 14/10/2026 · commit 6006a67

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
