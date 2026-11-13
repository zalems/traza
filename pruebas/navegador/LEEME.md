# Pruebas en navegador

Prueban el visor de punta a punta en Chromium (escritorio, teléfono de 390 × 844
y modo oscuro) contra una **instalación de prueba**, con un Wispro y un panel de
la OLT falsos. No son para la instalación en uso: crean redes, conectan esas
integraciones falsas y escriben historia inventada.

Hace falta una instalación del kit en una máquina de prueba (`./instalar.sh
--sin-mapa --puerto 8080`), Node 20.19 o más nuevo y Playwright con su Chromium
(no viene con el kit; `PLAYWRIGHT_MODULOS` dice dónde está su `node_modules`).

```bash
python3 pruebas/navegador/falsos.py &                 # Wispro (18091) y panel (18092) falsos
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
| `humo.mjs` | Entrar, cargar la red y prender la señal. |
| `olt.mjs` | El tablero de la OLT: resumen y novedades, puertos PON, ONT (buscar, filtrar, la historia de una), cajas, los anillos de las cajas en el mapa y la ficha de la NAP. |
| `olt-historia.mjs` | Las curvas, lo que cayó y volvió, un puerto que pierde potencia, «todas las redes», una red sin OLT y un usuario de una sola red. |
| `regresion.mjs` | Lo de antes: prender y apagar la señal, la ficha de la NAP con Wispro, la carta con luz, la ficha del cliente, el panel de usuarios. |

El panel falso tiene cinco puertos PON: uno caído entero, una caja caída hace
tres horas, una caja con la señal al límite, dos ONT sin energía, tres ONT sin
contrato y la OLT de otra empresa (que no tiene que verse nunca). `GET
/_control?caer=0/1/0` en el puerto 18092 tira un puerto y `?volver=0/1/0` lo
levanta, para probar a mano. Las capturas quedan en la carpeta temporal del
sistema (`traza-capturas`) o donde diga `FTTH_CAPTURAS`.
