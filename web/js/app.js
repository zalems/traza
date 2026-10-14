import * as maplibregl from '../vendor/maplibre-gl-6.11.2/maplibre-gl.mjs';
import defaults from './config.js';
import { BASES, buildStyle, allBaseLayerIds } from './style.js';
import { registerEsriProtocol } from './esri.js';
import { setupSearch } from './search.js';
import { setupHerramientas } from './herramientas.js';

const STORAGE_KEY = 'ftth.mapa.v1';
const IMAGERY_BASES = new Set(['imagery', 'hybrid']);

const LOCALE = {
  'AttributionControl.ToggleAttribution': 'Mostrar u ocultar las fuentes del mapa',
  'AttributionControl.MapFeedback': 'Comentarios sobre el mapa',
  'GeolocateControl.FindMyLocation': 'Mi ubicación',
  'GeolocateControl.LocationNotAvailable': 'Ubicación no disponible',
  'Map.Title': 'Mapa',
  'Marker.Title': 'Marcador',
  'NavigationControl.ZoomIn': 'Acercar',
  'NavigationControl.ZoomOut': 'Alejar',
  'Popup.Close': 'Cerrar',
  'ScaleControl.Meters': 'm',
  'ScaleControl.Kilometers': 'km',
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- utilidades

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Mezcla por secciones: lo local reemplaza clave por clave; `null` apaga una sección.
function mergeConfig(base, local) {
  const out = { ...base };
  for (const [name, value] of Object.entries(local ?? {})) {
    out[name] = isPlainObject(value) && isPlainObject(base[name]) ? { ...base[name], ...value } : value;
  }
  return out;
}

async function loadConfig() {
  try {
    const local = await import('../config.local.js');
    return mergeConfig(defaults, local.default);
  } catch (err) {
    console.warn('No se pudo leer config.local.js; se usa la configuración por defecto.', err);
    return defaults;
  }
}

function readState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Sin almacenamiento (modo privado, cuota): el visor funciona igual, solo no recuerda.
  }
}

// Devuelve si la marca ya estaba puesta en esta sesión y la deja puesta.
function sessionFlag(name) {
  try {
    const key = `ftth.${name}`;
    const seen = sessionStorage.getItem(key) === '1';
    sessionStorage.setItem(key, '1');
    return seen;
  } catch {
    return false;
  }
}

function showNotice(text) {
  $('notice-text').textContent = text;
  $('notice').hidden = false;
}

// Confirmación breve que desaparece sola. Va por encima de lo que esté abierto
// abajo (el cartel del modo o, en el teléfono, la ficha), y se corre si eso
// aparece o cambia de tamaño mientras se ve.
let toastTimer;
function ubicarToast() {
  const box = $('toast');
  let tope = window.innerHeight;
  for (const id of ['modo', 'ficha', 'bases']) {
    const el = $(id);
    if (!el || el.hidden) continue;
    const r = el.getBoundingClientRect();
    // Solo cuenta lo que ocupa el centro de abajo de la pantalla.
    if (r.bottom > window.innerHeight - 40 || id === 'modo') {
      if (r.left < window.innerWidth / 2 && r.right > window.innerWidth / 2) tope = Math.min(tope, r.top);
    }
  }
  box.style.bottom = `${Math.round(window.innerHeight - tope + 10)}px`;
}

function toast(text) {
  const box = $('toast');
  box.textContent = text;
  ubicarToast();
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, 2600);
}

// Ubica el archivo vigente del mapa de calles (lo nombra el manifiesto) y
// comprueba que esté y que el servidor acepte descargas parciales.
async function locateStreets(streets) {
  let url = streets.url;
  let info = null;
  try {
    if (!url) {
      const manifestUrl = new URL(streets.manifest, document.baseURI);
      const res = await fetch(manifestUrl, { cache: 'no-cache' });
      if (!res.ok) return { status: 'missing' };
      info = await res.json();
      url = new URL(info.file, manifestUrl).href;
      if (info.world) info.worldUrl = new URL(info.world, manifestUrl).href;
    }
    const res = await fetch(url, { headers: { Range: 'bytes=0-6' } });
    if (res.status === 206) {
      const magic = new TextDecoder().decode(await res.arrayBuffer());
      return magic === 'PMTiles' ? { status: 'ok', url, info } : { status: 'invalid' };
    }
    await res.body?.cancel();
    return { status: res.status === 200 ? 'no-range' : 'missing' };
  } catch {
    return { status: 'missing' };
  }
}

const STREETS_PROBLEM = {
  missing: 'Falta el mapa de calles en el servidor. Mientras tanto quedan Satélite e IGN.',
  invalid: 'El archivo del mapa de calles no es un PMTiles válido. Mientras tanto quedan Satélite e IGN.',
  'no-range': 'El servidor web no admite descargas parciales (Range), que el mapa de calles necesita. Mientras tanto quedan Satélite e IGN.',
};

const formatLngLat = ({ lng, lat }, decimals) => `${lat.toFixed(decimals)}, ${lng.toFixed(decimals)}`;

// --------------------------------------------------------------------- inicio

// Con el servicio de sesión instalado, sin sesión se va a la página de entrada.
// Si el servicio no está (404), la página funciona sin login.
async function checkSession() {
  try {
    const res = await fetch('auth/session', { cache: 'no-store' });
    if (res.status === 401) {
      location.replace('login.html');
      return new Promise(() => {});
    }
    return res.ok ? (await res.json()).usuario : null;
  } catch {
    return null;
  }
}

async function start() {
  const user = await checkSession();
  const config = await loadConfig();
  const saved = readState();

  const streets = await locateStreets(config.streets);
  const available = { streets: streets.status === 'ok' };
  if (!available.streets) showNotice(STREETS_PROBLEM[streets.status]);

  const usable = (base) => base && base.needs.every((need) => available[need]);
  const findBase = (id) => BASES.find((base) => base.id === id);
  const state = {
    base: [saved.base, config.initialBase, 'ign'].find((id) => usable(findBase(id))),
    ortho: Boolean(saved.ortho) && Boolean(config.ortho),
  };

  maplibregl.addProtocol('pmtiles', new globalThis.pmtiles.Protocol({ metadata: true }).tile);
  registerEsriProtocol(maplibregl, { template: config.imagery.template });

  const { style, groups, orthoLayerIds } = buildStyle(config, {
    streetsUrl: available.streets ? streets.url : null,
    worldUrl: streets.info?.worldUrl ?? null,
  });
  const baseLayerIds = allBaseLayerIds(groups);
  const switchable = new Set([...baseLayerIds, ...orthoLayerIds]);
  const orthoVisible = () => state.ortho && IMAGERY_BASES.has(state.base);
  const isVisible = (layerId) => (orthoLayerIds.includes(layerId) ? orthoVisible() : groups[state.base].includes(layerId));

  // Arrancar con una sola base visible: las fuentes ocultas no descargan nada.
  for (const layer of style.layers) {
    if (switchable.has(layer.id)) {
      layer.layout = { ...layer.layout, visibility: isVisible(layer.id) ? 'visible' : 'none' };
    }
  }

  const hasSavedView = Array.isArray(saved.center) && Number.isFinite(saved.zoom);
  const map = new maplibregl.Map({
    container: 'map',
    style,
    hash: true,
    maxZoom: config.maxZoom,
    ...(hasSavedView ? { center: saved.center, zoom: saved.zoom } : { bounds: config.initialBounds }),
    attributionControl: false,
    // Norte siempre arriba: en la calle, girar el mapa sin querer molesta más de lo que ayuda.
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    maxPitch: 0,
    locale: LOCALE,
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  const geolocate = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true, timeout: 15000 },
    trackUserLocation: true,
    fitBoundsOptions: { maxZoom: 18 },
  });
  map.addControl(geolocate, 'top-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left');
  map.addControl(new maplibregl.AttributionControl(), 'bottom-right');

  geolocate.on('error', (err) => {
    if (!window.isSecureContext) {
      showNotice('El navegador solo entrega la ubicación en páginas HTTPS. Falta configurar el certificado del servidor.');
    } else if (err.code === 1) {
      showNotice('El navegador no tiene permiso para usar la ubicación. Habilitalo para este sitio y volvé a intentar.');
    } else {
      showNotice('No se pudo obtener la ubicación. Probá de nuevo a cielo abierto.');
    }
  });
  // Sin HTTPS no hay GPS: avisarlo una vez por sesión, no en cada recarga.
  if (!window.isSecureContext && available.streets && !sessionFlag('https-notice')) {
    showNotice('Esta página no usa HTTPS, así que el navegador no va a entregar la ubicación del GPS.');
  }

  map.on('error', (event) => console.warn('Mapa:', event.error?.message ?? event.error));

  // Si el estilo pide un ícono que el sprite no trae, el rótulo se muestra igual, sin ícono.
  map.setMissingStyleImageResolver((id) => {
    if (!map.hasImage(id)) map.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) });
  });

  // ------------------------------------------------------------ mapas de base

  const persist = () => {
    const center = map.getCenter();
    writeState({ ...state, center: [center.lng, center.lat], zoom: map.getZoom() });
  };

  function applyVisibility() {
    for (const layerId of switchable) {
      map.setLayoutProperty(layerId, 'visibility', isVisible(layerId) ? 'visible' : 'none');
    }
  }

  function setBase(id) {
    if (!usable(findBase(id))) return;
    state.base = id;
    applyVisibility();
    for (const input of baseOptions.querySelectorAll('input')) input.checked = input.value === id;
    persist();
  }

  const baseOptions = $('base-options');
  for (const base of BASES) {
    const label = document.createElement('label');
    label.className = 'segment';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'base';
    input.id = `base-${base.id}`;
    input.value = base.id;
    input.checked = base.id === state.base;
    input.disabled = !usable(base);
    input.addEventListener('change', () => setBase(base.id));
    const text = document.createElement('span');
    text.textContent = base.label;
    label.append(input, text);
    if (input.disabled) label.title = 'Falta el mapa de calles en el servidor';
    baseOptions.append(label);
  }

  // Panel de capas adicionales: ortofotos del IGN y fecha de los datos de calles.
  const moreToggle = $('more-toggle');
  const morePanel = $('more-panel');
  const orthoToggle = $('ortho-toggle');
  const streetsDate = $('streets-date');

  const build = streets.info?.build?.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (build) streetsDate.textContent = `Calles: datos de OpenStreetMap al ${build[3]}/${build[2]}/${build[1]}.`;
  else streetsDate.hidden = true;

  const setMoreOpen = (open) => {
    morePanel.hidden = !open;
    moreToggle.setAttribute('aria-expanded', String(open));
  };
  moreToggle.addEventListener('click', () => setMoreOpen(morePanel.hidden));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setMoreOpen(false);
  });
  document.addEventListener('pointerdown', (event) => {
    if (!morePanel.hidden && !$('bases').contains(event.target)) setMoreOpen(false);
  });

  if (config.ortho) {
    orthoToggle.checked = state.ortho;
    orthoToggle.addEventListener('change', () => {
      state.ortho = orthoToggle.checked;
      // Las ortofotos van sobre el satélite: si hay otro fondo, pasar a Satélite.
      if (state.ortho && !IMAGERY_BASES.has(state.base)) {
        setBase('imagery');
      } else {
        applyVisibility();
        persist();
      }
    });
  } else {
    $('ortho-option').hidden = true;
  }
  // Sesión: quién está conectado y cómo salir.
  const session = $('session');
  if (user) {
    $('session-user').textContent = user;
    $('logout').addEventListener('click', async () => {
      try {
        await fetch('auth/logout', { method: 'POST' });
      } finally {
        location.replace('login.html');
      }
    });
  } else {
    session.hidden = true;
  }
  if (!config.ortho && !build && !user) moreToggle.hidden = true;

  // ------------------------------------------------- posición y coordenadas

  let saveTimer;
  map.on('moveend', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 400);
  });

  // Con mouse: coordenadas bajo el cursor.
  const readout = $('readout');
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    const coords = document.createElement('span');
    const zoom = document.createElement('span');
    readout.append(coords, zoom);
    map.on('mousemove', (event) => {
      readout.hidden = false;
      coords.textContent = formatLngLat(event.lngLat, 5);
      zoom.textContent = `zoom ${map.getZoom().toFixed(1)}`;
    });
    map.on('mouseout', () => {
      readout.hidden = true;
    });
  }

  // Clic derecho o toque largo: coordenadas del punto, listas para copiar.
  let pointPopup;
  let lastPopupAt = 0;
  function showPoint(lngLat) {
    if (herramientas && herramientas.modo() !== 'ver') return;
    if (Date.now() - lastPopupAt < 800) return;
    lastPopupAt = Date.now();
    const text = formatLngLat(lngLat, 6);

    const box = document.createElement('div');
    box.className = 'point';
    const coords = document.createElement('code');
    coords.textContent = text;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copiar';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = 'Copiado';
      } catch {
        // Sin acceso al portapapeles (HTTP o permiso denegado): dejar el texto seleccionado.
        window.getSelection().selectAllChildren(coords);
      }
    });
    box.append(coords, copy);

    pointPopup?.remove();
    const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: '320px' });
    pointPopup = popup.setLngLat(lngLat).setDOMContent(box).addTo(map);
    // Se cierra con el próximo toque en el mapa, pero no con el que la abrió:
    // al levantar el dedo de un toque largo el mapa también recibe un clic.
    setTimeout(() => map.once('click', () => popup.remove()), 500);
  }

  map.on('contextmenu', (event) => {
    event.originalEvent.preventDefault();
    showPoint(event.lngLat);
  });

  // iOS no dispara `contextmenu` con el toque largo: se detecta a mano.
  let pressTimer;
  let pressStart;
  const cancelPress = () => clearTimeout(pressTimer);
  map.on('touchstart', (event) => {
    cancelPress();
    if (event.originalEvent.touches.length !== 1) return;
    pressStart = event.point;
    pressTimer = setTimeout(() => showPoint(event.lngLat), 600);
  });
  map.on('touchmove', (event) => {
    if (pressStart && pressStart.dist(event.point) > 8) cancelPress();
  });
  for (const type of ['touchend', 'touchcancel', 'movestart']) map.on(type, cancelPress);

  // ---------------------------------------------------------------- buscador

  // --------------------------------------------------------- la red (carga)

  const herramientas = user ? setupHerramientas({ map, maplibregl, usuario: user, notify: showNotice, toast }) : null;
  if (!user) $('herramientas').hidden = true;

  setupSearch({ map, maplibregl, config, buscarEnRed: (texto) => herramientas?.buscarEnRed(texto) ?? [] });

  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(() => {
      if (!$('toast').hidden) ubicarToast();
    });
    for (const id of ['modo', 'ficha']) observer.observe($(id));
  }

  $('notice-close').addEventListener('click', () => {
    $('notice').hidden = true;
  });

  // Para depurar desde la consola del navegador.
  window.ftth = { map, setBase, config, state, herramientas };
}

start().catch((err) => {
  console.error(err);
  showNotice('El mapa no pudo iniciar. Revisá la consola del navegador para ver el detalle.');
});
