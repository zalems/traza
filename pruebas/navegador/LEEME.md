# Pruebas en navegador

Prueban el visor de punta a punta en Chromium (escritorio, teléfono de 390 × 844
y modo oscuro) contra una **instalación de prueba**, con un Wispro, un panel de
la OLT y una OLT falsos. No son para la instalación en uso: crean redes, conectan
esas integraciones falsas, cargan y quitan una OLT y escriben historia inventada.

Hace falta una instalación del kit en una máquina de prueba (`./instalar.sh
--sin-mapa --puerto 8080`), Node 20.19 o más nuevo y Playwright con su Chromium
(no viene con el kit; `PLAYWRIGHT_MODULOS` dice dónde está su `node_modules`).

```bash
python3 pruebas/navegador/falsos.py &                 # Wispro (18091), panel (18092) y OLT (UDP 18161, TCP 18023) falsos
printf 'Clave-de-prueba-2026\n' | sudo /srv/ftth/bin/usuarios agregar prueba 
python3 pruebas/navegador/sembrar.py                  # red 1: 10 cajas, 63 clientes, nodo, OLT, cables
python3 pruebas/navegador/sembrar2.py                 # red 2, sin Wispro ni OLT
printf 'Clave-cuadrilla-2026\n' | sudo /srv/ftth/bin/usuarios agregar cuadrilla --red 2
sudo install -m 644 pruebas/navegador/sembrar-historia.py /srv/ftth/ \
  && (cd / && sudo runuser -u ftth -- python3 /srv/ftth/sembrar-historia.py); sudo rm /srv/ftth/sembrar-historia.py
pruebas/navegador/todas.sh                            # o una sola: node pruebas/navegador/olt.mjs movil
```

| Prueba | Qué mira |
|---|---|
| `humo.mjs` | Entrar, cargar la red y prender la señal; y que la red cargue aunque los servidores del mapa de fondo no contesten. |
| `olt.mjs` | El tablero de la OLT: resumen y novedades, puertos PON, ONT (buscar, filtrar, la historia de una), cajas, los anillos de las cajas en el mapa y la ficha de la NAP. |
| `olt-historia.mjs` | Las curvas, lo que cayó y volvió, un puerto que pierde potencia, «todas las redes», una red sin OLT y un usuario de una sola red. |
| `regresion.mjs` | Lo de antes: prender y apagar la señal, la ficha de la NAP con Wispro, la carta con luz, la ficha del cliente, la carta del nodo con la placa de la OLT en su lugar (en columnas y en libre), el panel de usuarios. |
| `equipos.mjs` | Los equipos: el chasis de la OLT del panel (X17) con cada slot en su lugar, placas y puertos con su detalle y su tráfico; en la red sin OLT, cargar una (X2) desde el formulario, probar la conexión (mal y bien), verla dibujada, sus ONT, un puerto que se corta, cambiarla, que quien no administra no la toque, y quitarla. Después, una MA5680T como una leída de verdad: que se reconozca por sus placas, su chasis de 19 pulgadas con cada slot en su lugar, los lugares de las placas de energía que la OLT no informa, el de 21 al elegirlo a mano (con el aviso), y la geometría de todos los chasis (ningún slot se pisa ni se sale). |

| `placas.mjs` | La carta de un nodo con sus placas de OLT: el zoom en columnas (botones, «Ajustar», Control y la rueda, dos dedos sin que se agrande la página) y en libre; vincular una placa cargada a mano con una placa real del panel y ver en cada puerto el PON de verdad con sus ONT (también en los que no están unidos); del pie de un puerto a sus ONT en el tablero y de vuelta; «En el mapa»: lo que alimenta el puerto, marcado, y hasta dónde va sin dividirse; agregar otra placa sin poder repetir la que ya está (ni por la API); la ficha del nodo y la señal del mapa con esa lectura; desde el tablero, en qué nodo está cada placa y saltar a un puerto en su carta; desvincular. Después, en la red sin OLT, carga la OLT de mentira leída directo, un nodo y un cable: agrega la placa eligiendo la real, une un puerto y comprueba que la potencia sale de lo que emite ese puerto (3,2 dBm), que el recorrido del cliente lo dice, y que al quedarse el puerto sin ONT en línea la carta, el mapa y «En el mapa» lo muestran caído y dicen dónde buscar el corte. Deja todo como estaba. |

El panel falso tiene cinco puertos PON: uno caído entero, una caja caída hace
tres horas, una caja con la señal al límite, dos ONT sin energía, tres ONT sin
contrato y la OLT de otra empresa (que no tiene que verse nunca). `GET
/_control?caer=0/1/0` en el puerto 18092 tira un puerto y `?volver=0/1/0` lo
levanta, para probar a mano. La OLT falsa (`pruebas/olt_falsa.py`) es una
EA5800-X2 con 12 ONT en cuatro puertos PON, que contesta SNMP con la comunidad
`lectura-e2e` y deja entrar por Telnet a `traza` con `Clave-olt-e2e`; al lado
hay otra, una MA5680T de 19 pulgadas (UDP 18162), con la misma comunidad;
`/_control?olt_caer=HWTC00000065` le corta una ONT, `olt_volver=` la levanta y
`olt_muda=1` hace que deje de contestar. Las capturas quedan en la carpeta
temporal del sistema (`traza-capturas`) o donde diga `FTTH_CAPTURAS`.
