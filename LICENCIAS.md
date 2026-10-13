# Licencias y atribuciones de terceros

## Software incluido en el kit

| Componente | Versión | Licencia | Texto |
|---|---|---|---|
| MapLibre GL JS | 6.11.2 | BSD de 3 cláusulas | `web/vendor/maplibre-gl-6.11.2/LICENSE.txt` |
| PMTiles (biblioteca JavaScript) | 4.5.0 | BSD de 3 cláusulas | `web/vendor/pmtiles-4.5.0/LICENSE` |
| Protomaps Basemaps (estilos) | 5.7.2 | BSD de 3 cláusulas; diseño visual CC0 | `web/vendor/protomaps-basemaps-5.7.2/LICENSE.md` |
| Tipografías Noto Sans (glifos del mapa) | commit en `web/assets/ASSETS_COMMIT` | SIL Open Font License 1.1 | `web/assets/fonts/OFL.txt` |
| Íconos del mapa (sprites) | ídem | Derivados de tangrams/icons, licencia MIT | `web/vendor/protomaps-basemaps-5.7.2/LICENSE_DATA.md` |
| Tipografía Overpass (interfaz) | 5.3.0 de Fontsource | SIL Open Font License 1.1 | `web/assets/ui/OFL-Overpass.txt` |

## Software que descarga la instalación

| Componente | Versión | Licencia |
|---|---|---|
| pmtiles (go-pmtiles) | 1.31.2 | BSD de 3 cláusulas |
| nginx | la del sistema | BSD de 2 cláusulas |

## Datos y servicios

**Mapa de calles.** Builds de Protomaps a partir de OpenStreetMap, con licencia
ODbL: exige atribución ("© OpenStreetMap") y que las mejoras a los datos se
compartan bajo la misma licencia. Incluye además Natural Earth (dominio
público) y cobertura del suelo derivada de ESA WorldCover (CC BY 4.0). El
detalle está en `web/vendor/protomaps-basemaps-5.7.2/LICENSE_DATA.md`.

**Esri World Imagery.** Servicio de Esri bajo su Master License Agreement.
Exige mostrar "Powered by Esri" y las fuentes de las imágenes. La ficha del
servicio indica que no está pensado para exportar mosaicos para uso sin
conexión.

**Instituto Geográfico Nacional.** Sus servicios declaran: "Se permite buscar,
acceder, solicitar, recibir, copiar, analizar, reprocesar, reutilizar y
redistribuir libremente la información publicada por este servicio según el
Artículo 2 de la Ley 27.275".

**Nominatim.** Servicio público de la Fundación OpenStreetMap. Su política
pide como máximo una consulta por segundo, sin autocompletar, y advierte que
puede retirarse el acceso; para uso intensivo corresponde una instancia propia.
