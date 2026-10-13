// Arma el estilo de MapLibre con todos los mapas de base en un solo estilo.
// Cambiar de base es prender y apagar grupos de capas: las capas de la red
// (cables, cajas, NAP) van a vivir encima y no se tocan al cambiar el fondo.

import { layers as protomapsLayers, namedFlavor } from '../vendor/protomaps-basemaps-5.7.2/index.js';

export const BASES = [
  { id: 'streets', label: 'Calles', needs: ['streets'] },
  { id: 'hybrid', label: 'Híbrido', needs: ['streets'] },
  { id: 'imagery', label: 'Satélite', needs: [] },
  { id: 'ign', label: 'IGN', needs: [] },
];

// Las capas de la red se insertan debajo de esta capa vacía, para quedar
// siempre por encima de cualquier mapa de base.
export const OVERLAY_ANCHOR = 'overlay-anchor';

// Con el mapa del mundo instalado: por debajo de este zoom se dibuja el mundo
// entero y desde acá, el recorte detallado de la zona de trabajo.
const WORLD_SWITCH_ZOOM = 6;
// Del mundo, esto queda de fondo a cualquier zoom, para que fuera de la zona
// de trabajo se vea tierra y agua en lugar de un hueco.
const WORLD_BACKDROP = new Set(['background', 'earth', 'water', 'boundaries_country']);

const absolute = (url) => new URL(url, document.baseURI).href;

export function buildStyle(config, { streetsUrl, worldUrl }) {
  const sources = {
    imagery: {
      type: 'raster',
      tiles: ['esri://{z}/{x}/{y}'],
      tileSize: 256,
      maxzoom: config.imagery.nativeMaxZoom,
      attribution: config.imagery.attribution,
    },
    ign: {
      type: 'raster',
      tiles: [config.ign.template],
      scheme: 'tms',
      tileSize: 256,
      maxzoom: config.ign.maxZoom,
      attribution: config.ign.attribution,
    },
  };

  // id de base -> ids de capas que la componen
  const groups = { streets: [], hybrid: ['imagery'], imagery: ['imagery'], ign: ['ign'] };

  const layers = [
    { id: 'backdrop', type: 'background', paint: { 'background-color': '#dfe4e1' } },
    { id: 'imagery', type: 'raster', source: 'imagery', paint: { 'raster-fade-duration': 150 } },
    { id: 'ign', type: 'raster', source: 'ign', paint: { 'raster-fade-duration': 150 } },
  ];

  // Ortofotos: una capa por servicio, todas encima del satélite.
  const orthoLayerIds = [];
  for (const [index, template] of (config.ortho?.templates ?? []).entries()) {
    const id = `ortho-${index}`;
    sources[id] = {
      type: 'raster',
      tiles: [template],
      scheme: 'tms',
      tileSize: 256,
      minzoom: config.ortho.minZoom,
      maxzoom: config.ortho.maxZoom,
      attribution: config.ortho.attribution,
    };
    layers.push({ id, type: 'raster', source: id, paint: { 'raster-fade-duration': 150 } });
    orthoLayerIds.push(id);
  }

  if (streetsUrl) {
    sources.streets = {
      type: 'vector',
      url: `pmtiles://${absolute(streetsUrl)}`,
      attribution: config.streets.attribution,
    };

    // Calles: estilo claro completo.
    const light = namedFlavor('light');
    const lang = config.streets.lang;

    if (worldUrl) {
      sources.world = {
        type: 'vector',
        url: `pmtiles://${absolute(worldUrl)}`,
        attribution: config.streets.attribution,
      };
      for (const layer of protomapsLayers('world', light, { lang })) {
        const id = `world-${layer.id}`;
        const always = WORLD_BACKDROP.has(layer.id);
        layers.push(always ? { ...layer, id } : { ...layer, id, maxzoom: Math.min(layer.maxzoom ?? 24, WORLD_SWITCH_ZOOM) });
        groups.streets.push(id);
      }
    }

    for (const layer of protomapsLayers('streets', light, { lang })) {
      if (worldUrl) {
        // El fondo lo pone el mundo; el detalle entra recién donde el mundo se queda corto.
        if (layer.id === 'background') continue;
        layers.push({ ...layer, minzoom: Math.max(layer.minzoom ?? 0, WORLD_SWITCH_ZOOM) });
      } else {
        layers.push(layer);
      }
      groups.streets.push(layer.id);
    }

    // Híbrido: sobre el satélite, el trazado de calles apenas marcado y los
    // nombres en claro con borde oscuro.
    layers.push({
      id: 'hybrid-roads',
      type: 'line',
      source: 'streets',
      'source-layer': 'roads',
      minzoom: 12,
      filter: ['match', ['get', 'kind'], ['highway', 'major_road', 'minor_road'], true, false],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0.45, 17, 0.28, 20, 0.16],
        'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 12, 0.6, 16, 2, 20, 9],
      },
    });
    groups.hybrid.push('hybrid-roads');

    for (const layer of protomapsLayers('streets', namedFlavor('dark'), { lang, labelsOnly: true })) {
      const id = `hybrid-${layer.id}`;
      layers.push({ ...layer, id });
      groups.hybrid.push(id);
    }
  }

  layers.push({ id: OVERLAY_ANCHOR, type: 'background', paint: { 'background-opacity': 0 } });

  const style = {
    version: 8,
    // Las llaves se agregan después de resolver la URL: `new URL` las codificaría.
    glyphs: `${absolute('assets/fonts/')}{fontstack}/{range}.pbf`,
    sprite: absolute('assets/sprites/v4/light'),
    sources,
    layers,
  };

  return { style, groups, orthoLayerIds };
}

// Todas las capas que pertenecen a algún mapa de base (sin repetir).
export function allBaseLayerIds(groups) {
  return [...new Set(Object.values(groups).flat())];
}
