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
| `regresion.mjs` | Lo de antes: prender y apagar la señal, la ficha de la NAP con Wispro, la carta con luz, la ficha del cliente, el panel de usuarios. |
| `equipos.mjs` | Los equipos: el chasis de la OLT del panel (X17) con cada slot en su lugar, placas y puertos con su detalle y su tráfico; en la red sin OLT, cargar una (X2) desde el formulario, probar la conexión (mal y bien), verla dibujada, sus ONT, un puerto que se corta, cambiarla, que quien no administra no la toque, y quitarla. Después, una MA5680T: que se reconozca por sus placas, su chasis de 21 pulgadas con cada slot en su lugar, el de 19 al elegirlo a mano, y la geometría de todos los chasis (ningún slot se pisa ni se sale). |

El panel falso tiene cinco puertos PON: uno caído entero, una caja caída hace
tres horas, una caja con la señal al límite, dos ONT sin energía, tres ONT sin
contrato y la OLT de otra empresa (que no tiene que verse nunca). `GET
/_control?caer=0/1/0` en el puerto 18092 tira un puerto y `?volver=0/1/0` lo
levanta, para probar a mano. La OLT falsa (`pruebas/olt_falsa.py`) es una
EA5800-X2 con 12 ONT en cuatro puertos PON, que contesta SNMP con la comunidad
`lectura-e2e` y deja entrar por Telnet a `traza` con `Clave-olt-e2e`; al lado
hay otra, una MA5680T de 21 pulgadas (UDP 18162), con la misma comunidad;
`/_control?olt_caer=HWTC00000065` le corta una ONT, `olt_volver=` la levanta y
`olt_muda=1` hace que deje de contestar. Las capturas quedan en la carpeta
temporal del sistema (`traza-capturas`) o donde diga `FTTH_CAPTURAS`.
