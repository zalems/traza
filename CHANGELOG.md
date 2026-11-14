# Cambios

## 0.12.2 · 13/11/2026

Corrige cómo se escribe el tráfico.

- Corregido: un tráfico de 100 o más que terminaba en cero se mostraba sin
  ese cero: 120 Mb/s aparecía como "12 Mb/s"; 300 Mb/s, como "3 Mb/s"; un
  puerto de 100 Mb, como de "1 Mb". Pasaba desde 0.12.0 en *Equipos* (el
  tráfico de cada puerto y la velocidad de los de subida), en la columna de
  tráfico de *Puertos PON* y en la escala de las curvas de tráfico. Los
  números guardados estaban bien: era solo cómo se escribían.
- Prueba nueva, sin navegador: `node pruebas/equipos.test.mjs` (cómo se
  escribe un tráfico y dónde va cada slot en el frente de cada chasis).
- Sin cambios en la API ni en los datos. Volver a 0.12.1: `git checkout
  2ff6514` y `./instalar.sh`.

## 0.12.1 · 13/11/2026 · commit b9e1d3b

Las OLT Huawei de la familia anterior a la MA5800 (MA5680T, MA5600T, MA5683T,
MA5603T y MA5608T) se reconocen y se dibujan con su chasis.

- Cuatro chasis nuevos, con la disposición de slots y las medidas de cada
  placa de la descripción de hardware de Huawei: MA5680T y MA5600T de 21
  pulgadas (23 slots: energía 21 y 22 sobre la interfaz universal 0, a la
  izquierda; servicio 1 a 8 y 11 a 18; control 9 y 10; a la derecha, las dos
  placas de subida, 19 arriba y 20 abajo; ventiladores arriba) y de 19
  pulgadas (21 slots: energía 19 y 20, control 7 y 8, subida 17 y 18);
  MA5683T y MA5603T (placas acostadas, ventiladores a la izquierda: servicio
  0 a 5, control 6 y 7, subida 8 y 9 lado a lado y, abajo, energía 10 y 11 e
  interfaz universal 12); MA5608T (servicio 0 y 1 arriba; abajo, control 2 y
  3 y la energía en 4, o en 4 y 5 si son dos placas de la mitad).
- El chasis se reconoce solo, por dónde están las placas de control y de
  energía y por su nombre (las H80x son de esta familia; las H90x, de la
  MA5800): SCU y MCU son de control; PRT y MPW, de energía; GIU y X2C, de
  subida; CIT, la interfaz universal. Si la OLT dice ser una MA5680T y no
  informa sus placas, no se adivina si es la de 21 o la de 19 pulgadas: se
  elige en "Modelo". En el formulario están los siete modelos nuevos.
- "Probar la conexión" dice el chasis por su nombre ("MA5680T de 21 pulgadas
  (ETSI)") y de dónde lo sacó; si se eligió otro modelo, lo avisa. Suma el
  identificador del equipo (sysObjectID).
- Si la OLT no responde por SNMP, la ayuda nombra el filtro de SNMP por
  dirección de Huawei (`sysman firewall snmp`), cómo se agrega el rango del
  servidor (`sysman ip-access snmp DESDE HASTA`) y la versión (v2c).
- Si a la OLT no le entra en una respuesta todo lo que se le pide de una vez
  (contesta "tooBig"), traza le pide de a menos filas en vez de dar la tabla
  por perdida.
- Corregido: la red esperaba a que el mapa de fondo terminara de cargar. Con
  el fondo del IGN o el satélite, que vienen de otros servidores, si ese
  servidor tardaba o no contestaba (o con poca señal en la calle), la red no
  aparecía hasta que llegaran sus imágenes. Ahora se carga apenas abre la
  página y se ve aunque el fondo no llegue.
- Corregido: si una OLT no entregaba la tabla de sus placas, solo se veía la
  primera placa con puertos; ahora se ven todas.
- Corregido: en las placas de subida, el texto de cada puerto ("sin módulo")
  se salía de su casilla; esas casillas ahora son más anchas.
- La tarjeta de cada OLT dice qué chasis se dibuja (API: `chasis_nombre` en
  cada equipo de `GET /api/olt`).
- Sin cambios en los datos. Volver a 0.12.0: `git checkout ed9a577` y
  `./instalar.sh` (0.12.0 no conoce los modelos nuevos: una OLT guardada con
  uno de ellos queda cargada y se sigue leyendo, pero dibujada con un chasis
  que no es el suyo).

## 0.12.0 · 13/11/2026 · commit af287bc

Las OLT se cargan desde el visor, traza las lee por su cuenta (SNMP) y cada
una se ve dibujada como es: el chasis con sus placas y sus puertos.

- Pestaña *Equipos* en el tablero de la OLT. Cada OLT de la red dibujada como
  es de frente, con la disposición de slots de la descripción de hardware de
  Huawei (MA5800 y EA5800): X17 y X15 con las placas paradas, los
  ventiladores arriba y, a la izquierda, las dos placas de energía sobre la
  interfaz universal; X7 y X2 con las placas acostadas y los ventiladores a
  la derecha (en la X2: control 3 y 4 y energía 0 arriba, servicio 1 y 2
  abajo). Los slots vacíos se ven vacíos. Cada puerto PON lleva el color de
  cómo están sus ONT (bien, señal al límite, la mitad o más sin señal, caído,
  sin ONT) y cada puerto de subida, si tiene enlace. Tocando una placa se ve
  cuál es, su estado y sus puertos; tocando un puerto, sus ONT, la potencia
  que reciben, lo que emite el módulo del puerto (potencia, temperatura,
  tensión y corriente, cuando se lee de la OLT), el tráfico de ahora y su
  historia (ONT en línea, potencia y tráfico), con el salto a sus ONT.
- Cargar una OLT desde el visor (quien administra): nombre, dirección (IP o
  nombre; la IP pública si está en otra red), modelo, puerto y comunidad de
  SNMP, consola (SSH o Telnet, puerto, usuario y clave) y la zona de su
  reloj. "Probar la conexión" dice si la OLT responde por SNMP y qué entrega
  (nombre, placas, chasis, puertos PON, ONT, potencias) y si se puede entrar
  por la consola; si algo no anda, qué revisar (la comunidad, el permiso en
  la OLT para la dirección del servidor, el puerto). La comunidad y la clave
  quedan en el servidor (`integraciones.json`, que solo lee el servicio) y no
  vuelven a salir: al cambiar una OLT se escriben solo si cambian, y si se
  cambia la dirección o el puerto hay que escribirlas de nuevo (lo guardado
  no se le manda a otro equipo). Se puede dejar en pausa o quitar.
- Lectura directa: traza lee por SNMP v2c (solo GET y GETBULK) las OLT
  cargadas: cada minuto, el estado de cada ONT, por qué cayó y cuándo, y el
  tráfico de cada puerto; cada cinco, la potencia que recibe cada ONT, la
  distancia, las placas y lo que emite cada puerto PON. Con eso funciona todo
  lo que ya había (resumen y novedades, puertos, ONT, cajas, la señal en el
  mapa, las fichas) en una red sin panel. "Actualizar" la lee en el momento.
  Si la OLT deja de contestar, se muestra lo último leído, con el aviso.
- Una OLT que ya está en el panel puede tener cargada su conexión: sus ONT
  las sigue dando el panel y de la OLT se lee lo que el panel no informa (lo
  que emite el módulo de cada puerto PON).
- Tráfico: bajada y subida de cada puerto PON y de cada puerto de subida,
  ahora (en *Equipos* y en una columna de *Puertos PON*) y en el tiempo
  (traza lo anota cada 5 minutos, venga del panel o de la OLT).
- Historia de cada ONT de una OLT leída directo: traza anota su potencia cada
  15 minutos (a los ocho días queda una lectura cada seis horas) y sus caídas.
  Cada ONT dice también cuánta fibra hay hasta la OLT.
- El aviso de una red sin OLT ofrece agregarla (a quien administra). El
  comando `integraciones ver` lista también las OLT cargadas (sin su
  comunidad ni su clave) y `probar` las lee.
- API: `GET /api/olt` suma `equipos` (con `placas` y `puertos`) y
  `administra`, y a cada puerto PON `entra`, `sale` y `tx`;
  `GET /api/olt/ont?red=N&sn=SERIE`, `GET /api/olt/trafico?red=N&olt=&puerto=`,
  y, solo para quien administra, `POST /api/olt/equipos`,
  `PUT|DELETE /api/olt/equipos/ID` y `POST /api/olt/equipos/probar`.
- En `data/olt.db`, dos tablas nuevas (`lecturas` y `trafico`); se crean
  solas. Volver a 0.11.0: `git checkout 19f6503` y `./instalar.sh` (las OLT
  cargadas quedan guardadas, sin usarse).

## 0.11.0 · 13/11/2026 · commit 0e4602e

La OLT de cada red, dentro de traza: tablero con resumen y novedades, puertos
PON, ONT, cajas con potencia promedio y bocas libres, e historial propio.

- Botón de la OLT en el mapa (debajo del de la señal). Abre el tablero de la
  OLT de la red, con lo que el panel leyó de ella; solo lee. Cuatro partes:
  - *Resumen*: ONT en la OLT, en línea, sin señal (sin luz o sin energía), con
    señal baja y sin su cliente en el mapa. "Para mirar ahora": un puerto PON
    sin ninguna ONT en línea, ONT de un puerto que cayeron juntas (y si son
    todas de una caja), una caja con todos sus clientes sin señal, ONT al
    límite, un puerto que perdió 1 dB o más respecto de la semana pasada o de
    ayer, y la lectura vieja del panel. Si los clientes caídos tienen su
    recorrido dibujado, dice dónde se juntan (el corte está ahí o antes) y
    lleva al mapa. Curva de ONT en línea (24 h, 7 y 30 días) y lo que cayó y
    volvió en dos días.
  - *Puertos PON*: ONT, en línea, sin señal con su causa, potencia promedio y
    la peor de cada puerto, y la historia de cada uno (ONT en línea y
    potencia, con los umbrales).
  - *ONT*: buscar (nombre, serie, contrato, puerto, caja), filtrar y ordenar;
    cada una con su estado, lo que recibe y emite, contrato, caja, la curva de
    su potencia, la tendencia y sus eventos, y el salto a su cliente o a su
    caja en el mapa.
  - *Cajas*: todas las NAP con bocas libres, clientes en línea, potencia
    promedio y la peor; filtros, orden y copiar la lista. Con Wispro valen su
    capacidad y sus contratos; sin Wispro, la carta de empalme.
- Con la señal prendida, cada NAP lleva en el mapa un anillo del color de cómo
  reciben sus clientes y, de cerca, la potencia promedio y las bocas libres.
  La ficha de la NAP suma "Bocas libres" y "Sus clientes".
- Historial propio: cada 5 minutos traza anota, por puerto PON y de toda la
  red, las ONT que hay y las que están en línea, la potencia promedio y la
  peor, y qué ONT cayó o volvió (con la hora que da la OLT). Va en
  `data/olt.db` (sin nombres), entra en la copia diaria, a los ocho días queda
  una anotación por hora y se guarda poco más de un año.
- En "todas las redes" se elige de qué red se mira la OLT; una red sin OLT
  conectada dice cómo conectarla y muestra igual sus cajas. Un usuario no ve
  la OLT de una red que no tiene asignada, ni las ONT de otra OLT del panel.
- API: `GET /api/olt?red=N`, `GET /api/olt/ont?red=N&ont=ID[&horas=]`,
  `GET /api/olt/historia?red=N[&horas=][&olt=&pon=]`,
  `GET /api/integracion/cajas?red=N|todas`; `estados` suma el puerto PON de
  cada cliente.
- `herramientas/muestras-panel.py`: lista todo lo que entrega el panel y
  muestra la forma de cada respuesta de lectura (sin llamar nada que cambie
  algo ni que lea la OLT en el momento), para sumar lo que falta: potencia de
  salida de cada puerto (SFP), placas, uplinks y tráfico.
- Las pruebas en navegador quedan en el repositorio (`pruebas/navegador/`),
  con el Wispro y el panel falsos y los datos de prueba.

## 0.10.0 · 31/10/2026 · commit 4236289

Señal: qué fibras tienen luz, hacia dónde va y si hay tráfico.

- Botón de la señal en el mapa. Lo que tiene luz según las cartas de empalme
  (desde cada puerto PON unido de cada OLT, por las uniones, de largo por
  donde las fibras pasan sin cortar y abriéndose en los splitters) se pinta
  con flechas en el sentido de la señal: verde con rayas que avanzan si hay
  clientes abajo con la ONT en línea, naranja si tiene luz sin más datos,
  rojo si tiene luz y sus clientes están sin señal. Los cables sin luz
  muestran el sentido de la red, del nodo hacia afuera. Los cables de siempre
  quedan atenuados mientras la señal está prendida; la elección se recuerda.
- Leyenda con las cuentas (cables con luz, clientes a los que llega, en línea
  y sin señal, clientes en línea sin luz en el mapa, cuándo se leyó la OLT) y
  los errores de las cartas (splitter al revés, luz por dos caminos, de una
  OLT a otra) con un toque para ir al lugar; en el teléfono arranca plegada.
- Carta de empalme: fibras, puertos PON y salidas de splitter con luz, con un
  anillo del color de su estado, la potencia estimada y, en la OLT, cuántos
  clientes en línea tiene cada PON; las uniones y lo que pasa de largo con luz
  brillan. "Ver lista" y "Copiar" dicen lo que tiene luz.
- Ficha del cable: cuántas fibras llevan luz, en qué sentido y con cuántos
  clientes abajo; cada fibra con luz marcada y, al tocarla, de qué OLT y PON
  viene y con cuánto llega. Ficha de cajas, NAP, botellas y nodos: de dónde
  les llega la luz.
- API: `GET /api/integracion/estados?red=N|todas`, el estado de la ONT de
  cada cliente del mapa según el panel de la OLT (con el mismo cruce que la
  ficha de la NAP). Visor: `fibras.iluminacion`, `segmentosConLuz` y
  `sentidoDeRed` (en una red de 1000 clientes se calcula en unos 30 ms).
- Pruebas: la luz, los sentidos, las potencias (iguales a las del recorrido),
  los clientes abajo y un splitter al revés (`fibras.test.mjs`); el estado de
  las ONT por red y de todas (`test_integraciones.py`).

## 0.9.1 · 31/10/2026 · commit 77c9c12

- La OLT puede numerar sus puertos PON desde 0 (Huawei: placas de 0 a 15) o
  desde 1 (ZTE, V-SOL, Fiberhome…): se elige al cargarla o editarla, y para
  una OLT nueva se propone 0 si el equipo anotado en el nodo o el nombre dicen
  Huawei. Solo cambia cómo se muestran los números en la carta, las fichas y
  los recorridos; por dentro siguen de 1 a N, así que las uniones hechas no
  se tocan. API: `datos.desde` (0 o 1) en los equipos tipo OLT.

## 0.9.0 · 20/10/2026 · commit edb9098

Usuarios desde el visor y todas las redes en un solo mapa.

- Panel **Usuarios** para quien administra (en el panel de capas y al pie de
  la lista de redes): lista con qué ve cada uno y cuándo entró por última vez;
  crear usuario con contraseña y redes (o que administre), cambiarle las redes
  o la contraseña (le cierra las sesiones) y quitarlo. Uno no se quita a sí
  mismo ni se saca la administración. Los nombres no distinguen mayúsculas.
- "Todas las redes" en la lista de redes, para quien administra: el mapa
  muestra todas las redes juntas y cada ficha dice de qué red es; se puede
  editar, mover y borrar lo que hay, pero no agregar ni cambiar trazados (para
  eso se elige una red). Queda guardada como cualquier otra elección de red.
- Pantalla de entrada con el nombre traza y una línea que dice qué es.
- Servicio de sesión: `GET/POST /auth/usuarios`, `PUT/DELETE /auth/usuarios/NOMBRE`
  (solo administra) y `POST /auth/clave` {actual, nueva} para cambiar la
  propia. API: `GET /api/red?red=todas` y `GET /api/cambios?red=todas` (solo
  administra) y el campo `red` en cada elemento, cable, equipo y unión.
- Pruebas: del panel de usuarios y de la propia contraseña (`test_auth.py`),
  de `red=todas` (`test_api.py`).

## 0.8.0 · 19/10/2026 · commit 5db5afc

Redes por usuario: una instalación puede alojar a varias empresas.

- Cada usuario administra (ve todas las redes, crea redes y les cambia el
  nombre) o ve solo las redes que se le asignaron. Lo de una red que no tiene
  asignada no se ve ni se toca: la API responde 403 en redes, elementos,
  cables, equipos, uniones e integraciones; el visor lista solo sus redes,
  entra directo si tiene una sola y no ofrece crear ni renombrar.
- `usuarios agregar NOMBRE --red RED` y `usuarios redes NOMBRE RED …`
  (o `--todas`); `listar` muestra las redes de cada uno. Las redes se nombran
  como en el visor o por su número (el CLI lee `red.db`). Los cambios valen
  al instante para las sesiones abiertas. Los usuarios anteriores quedan como
  administradores.
- El servicio de sesión responde `X-Redes` ("*" todas, "1,3" esas, "-"
  ninguna) y nginx se la pasa a la API; `/auth/session` y `/api/yo` dicen si
  el usuario administra y qué redes ve. La base de usuarios gana la columna
  `redes` (migración automática).
- Pruebas del servicio de sesión (`pruebas/test_auth.py`).

## 0.7.1 · 14/10/2026 · commit c3ffdc3

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
