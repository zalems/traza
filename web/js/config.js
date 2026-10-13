// Configuración por defecto del visor.
//
// No edites este archivo en el servidor: se reemplaza en cada actualización.
// Lo que quieras cambiar va en /config.local.js, que la instalación nunca pisa.

export default {
  // Vista al abrir por primera vez: Argentina completa. Después, cada navegador
  // vuelve a la última posición que usó.
  initialBounds: [[-73.6, -55.1], [-53.6, -21.7]],
  maxZoom: 21,

  // Mapa que se muestra al entrar: 'streets' | 'hybrid' | 'imagery' | 'ign'
  initialBase: 'streets',

  // Calles: mosaicos vectoriales de OpenStreetMap servidos desde este mismo servidor
  // (archivo PMTiles que descarga instalar.sh). No depende de terceros.
  // El manifiesto dice cuál es el archivo vigente; instalar.sh lo reescribe al
  // actualizar el mapa. Para fijar un archivo a mano, usar `url` en su lugar.
  streets: {
    manifest: 'tiles/basemap.json',
    url: null,
    lang: 'es',
    attribution:
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a> | ' +
      '<a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a>',
  },

  // Satélite: Esri World Imagery.
  // Esta URL funciona sin clave y alcanza para probar. Para producción corresponde
  // una cuenta de ArcGIS Location Platform y su plantilla con token (ver README).
  imagery: {
    template: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    // Zoom más profundo que se le pide a Esri. Donde no hay imagen a ese zoom,
    // el visor amplía la del nivel anterior (ver js/esri.js).
    nativeMaxZoom: 19,
    attribution:
      'Powered by <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a> | ' +
      'Esri, Vantor, Earthstar Geographics, and the GIS User Community',
  },

  // Cartografía oficial del Instituto Geográfico Nacional (Argenmap).
  ign: {
    template: 'https://wms.ign.gob.ar/geoserver/gwc/service/tms/1.0.0/capabaseargenmap@EPSG%3A3857@png/{z}/{x}/{y}.png',
    maxZoom: 20,
    attribution:
      '<a href="https://www.ign.gob.ar" target="_blank" rel="noopener">Instituto Geográfico Nacional</a> + OpenStreetMap',
  },

  // Ortofotos aéreas del IGN: vuelos fotogramétricos (ciudades) y vuelos con
  // dron (localidades chicas). Cobertura parcial; fuera de ella no se ve nada.
  // Poné `null` para quitar la opción.
  ortho: {
    templates: [
      'https://imagenes.ign.gob.ar/geoserver/gwc/service/tms/1.0.0/mosaicos_vuelos@EPSG%3A3857@png/{z}/{x}/{y}.png',
      'https://imagenes.ign.gob.ar/geoserver/gwc/service/tms/1.0.0/mosaicos_vuelos_vant@EPSG%3A3857@png/{z}/{x}/{y}.png',
    ],
    minZoom: 11,
    maxZoom: 20,
    attribution:
      'Ortofotos: <a href="https://www.ign.gob.ar" target="_blank" rel="noopener">Instituto Geográfico Nacional</a>',
  },

  // Buscador de localidades y direcciones (Nominatim público de OpenStreetMap).
  // Es un servicio compartido y sin garantía: una búsqueda por vez, sin autocompletar.
  // Poné `null` para ocultar el buscador (las coordenadas se siguen aceptando).
  geocoder: {
    url: 'https://nominatim.openstreetmap.org/search',
    countryCodes: 'ar',
  },
};
