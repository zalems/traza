// La red en el mapa: carga los datos de una red, los dibuja en capas propias
// (siempre encima del mapa de base), los mantiene al día preguntando al
// servidor cada tanto, y resuelve qué hay bajo un toque.

import { api } from './api.js';
import { CABLES, ELEMENTOS, normalizar } from './modelo.js';
import { registrarIconos } from './iconos.js';
import { OVERLAY_ANCHOR } from './style.js';

const POLL_MS = 10000;
const REINTENTO_MS = 8000;
const ESPERA_CARGA_MS = 90000; // una red grande por 3G tarda en bajar
const SIGNAL = '#e8590c';

const FONT_REGULAR = ['Noto Sans Regular'];
const FONT_MEDIUM = ['Noto Sans Medium'];

const porTipo = (tabla, campo, fallback) => [
  'match',
  ['get', 'tipo'],
  ...Object.entries(tabla).flatMap(([tipo, def]) => [tipo, def[campo]]),
  fallback,
];

const variante = ['match', ['get', 'estado'], 'proyectado', 'proyectado', 'baja', 'baja', 'lleno'];
const iconoElemento = ['concat', 'red-', ['get', 'tipo'], '-', variante];
// Tamaño de los íconos según el zoom (la misma curva en el estilo y en el cálculo de toques).
const CURVA_ICONO = [[11, 0.55], [15, 0.85], [17, 1], [20, 1.2]];
const tamIcono = ['interpolate', ['linear'], ['zoom'], ...CURVA_ICONO.flat()];
function escalaIcono(z) {
  if (z <= CURVA_ICONO[0][0]) return CURVA_ICONO[0][1];
  for (let i = 1; i < CURVA_ICONO.length; i += 1) {
    const [z1, v1] = CURVA_ICONO[i];
    const [z0, v0] = CURVA_ICONO[i - 1];
    if (z <= z1) return v0 + ((v1 - v0) * (z - z0)) / (z1 - z0);
  }
  return CURVA_ICONO[CURVA_ICONO.length - 1][1];
}
const anchoCable = (base) => {
  const factor = porTipo(CABLES, 'ancho', 1);
  return ['interpolate', ['linear'], ['zoom'], 12, ['*', base * 0.5, factor], 16, ['*', base, factor], 20, ['*', base * 1.8, factor]];
};

const collection = (features) => ({ type: 'FeatureCollection', features });
const punto = (coordinates, properties) => ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates } });

export function setupRed({ map, maplibregl, usuario }) {
  const state = {
    red: null,
    cargada: false, // la red elegida ya llegó del servidor
    version: 0,
    elementos: new Map(),
    cables: new Map(),
    equipos: new Map(), // splitters y OLT, por id
    fusiones: new Map(), // uniones de las cartas de empalme, por id
    rev: 0, // sube con cada cambio aplicado (para rehacer cálculos)
    seleccion: null, // { clase: 'elemento' | 'cable', id }
  };
  const listeners = new Map();
  let timer = null;
  let reintento = null;
  let ready = false;
  let pidiendo = false;

  const on = (evento, fn) => {
    if (!listeners.has(evento)) listeners.set(evento, new Set());
    listeners.get(evento).add(fn);
  };
  const emit = (evento, detalle) => {
    for (const fn of listeners.get(evento) ?? []) fn(detalle);
  };

  // ------------------------------------------------------------------ capas

  async function addLayers() {
    await registrarIconos(map);
    map.addSource('red-cables', { type: 'geojson', data: collection([]), promoteId: 'id' });
    map.addSource('red-elementos', { type: 'geojson', data: collection([]), promoteId: 'id' });
    map.addSource('red-dibujo', { type: 'geojson', data: collection([]) });
    map.addSource('red-recorrido', { type: 'geojson', data: collection([]) });

    const add = (layer) => map.addLayer(layer, OVERLAY_ANCHOR);
    const halo = { 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 };

    add({
      id: 'red-cables-halo',
      type: 'line',
      source: 'red-cables',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': anchoCable(7), 'line-opacity': 0.85 },
    });
    add({
      id: 'red-cables-sel',
      type: 'line',
      source: 'red-cables',
      filter: ['==', ['id'], -1],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': SIGNAL, 'line-width': anchoCable(13), 'line-opacity': 0.45 },
    });
    add({
      id: 'red-cables',
      type: 'line',
      source: 'red-cables',
      filter: ['!=', ['get', 'estado'], 'proyectado'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['case', ['==', ['get', 'estado'], 'baja'], '#8b949c', porTipo(CABLES, 'color', '#1d4ed8')],
        'line-width': anchoCable(3.2),
      },
    });
    add({
      id: 'red-cables-proyectado',
      type: 'line',
      source: 'red-cables',
      filter: ['==', ['get', 'estado'], 'proyectado'],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: { 'line-color': porTipo(CABLES, 'color', '#1d4ed8'), 'line-width': anchoCable(3.2), 'line-dasharray': [2, 1.6] },
    });
    add({
      id: 'red-cables-etiquetas',
      type: 'symbol',
      source: 'red-cables',
      minzoom: 15,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 320,
        'text-field': ['concat', ['get', 'nombre'], ' · ', ['to-string', ['get', 'fibras']], ' F'],
        'text-font': FONT_REGULAR,
        'text-size': 11.5,
        'text-offset': [0, -1.05],
        'text-max-angle': 30,
        'text-keep-upright': true,
      },
      paint: { 'text-color': '#16222c', ...halo },
    });

    // Recorrido de un pelo: por dónde va, encima de los cables y debajo de los elementos.
    add({
      id: 'red-recorrido-halo',
      type: 'line',
      source: 'red-recorrido',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 7, 18, 14], 'line-opacity': 0.9 },
    });
    add({
      id: 'red-recorrido',
      type: 'line',
      source: 'red-recorrido',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': SIGNAL, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3.5, 18, 7] },
    });

    add({
      id: 'red-elementos-sel',
      type: 'circle',
      source: 'red-elementos',
      filter: ['==', ['id'], -1],
      paint: {
        'circle-radius': ['+', ['/', porTipo(ELEMENTOS, 'tam', 24), 2], 7],
        'circle-color': 'rgba(232, 89, 12, 0.16)',
        'circle-stroke-color': SIGNAL,
        'circle-stroke-width': 3,
      },
    });
    const icono = {
      'icon-image': iconoElemento,
      'icon-size': tamIcono,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'symbol-sort-key': porTipo(ELEMENTOS, 'orden', 0),
    };
    add({
      id: 'red-postes',
      type: 'symbol',
      source: 'red-elementos',
      minzoom: 13,
      filter: ['==', ['get', 'tipo'], 'poste'],
      layout: icono,
      paint: { 'icon-opacity': ['case', ['==', ['get', 'estado'], 'baja'], 0.6, 1] },
    });
    add({
      id: 'red-elementos',
      type: 'symbol',
      source: 'red-elementos',
      filter: ['!=', ['get', 'tipo'], 'poste'],
      layout: icono,
      paint: { 'icon-opacity': ['case', ['==', ['get', 'estado'], 'baja'], 0.6, 1] },
    });
    add({
      id: 'red-elementos-etiquetas',
      type: 'symbol',
      source: 'red-elementos',
      minzoom: 16,
      filter: ['!=', ['get', 'tipo'], 'poste'],
      layout: {
        'text-field': ['get', 'nombre'],
        'text-font': FONT_MEDIUM,
        'text-size': 11.5,
        'text-anchor': 'top',
        'text-offset': [0, 1.15],
        'text-optional': true,
      },
      paint: { 'text-color': '#16222c', ...halo },
    });
    add({
      id: 'red-postes-etiquetas',
      type: 'symbol',
      source: 'red-elementos',
      minzoom: 18,
      filter: ['==', ['get', 'tipo'], 'poste'],
      layout: {
        'text-field': ['get', 'nombre'],
        'text-font': FONT_REGULAR,
        'text-size': 10.5,
        'text-anchor': 'top',
        'text-offset': [0, 0.75],
        'text-optional': true,
      },
      paint: { 'text-color': '#4d5b65', 'text-halo-color': '#ffffff', 'text-halo-width': 1.3 },
    });

    // Dibujo en curso: línea, puntos, puntos intermedios, el elemento al que
    // se va a pegar y la marca de dónde va un elemento nuevo.
    const clase = (c) => ['==', ['get', 'clase'], c];
    add({
      id: 'red-dibujo-linea',
      type: 'line',
      source: 'red-dibujo',
      filter: clase('linea'),
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': SIGNAL, 'line-width': 3.5, 'line-dasharray': [1.5, 1.5] },
    });
    add({
      id: 'red-dibujo-iman',
      type: 'circle',
      source: 'red-dibujo',
      filter: clase('iman'),
      paint: { 'circle-radius': 17, 'circle-color': 'rgba(232, 89, 12, 0.18)', 'circle-stroke-color': SIGNAL, 'circle-stroke-width': 2.5 },
    });
    add({
      id: 'red-dibujo-medio',
      type: 'circle',
      source: 'red-dibujo',
      filter: clase('medio'),
      paint: { 'circle-radius': 5, 'circle-color': '#ffffff', 'circle-stroke-color': SIGNAL, 'circle-stroke-width': 2, 'circle-opacity': 0.95 },
    });
    add({
      id: 'red-dibujo-puntos',
      type: 'circle',
      source: 'red-dibujo',
      filter: clase('vertice'),
      paint: { 'circle-radius': 6, 'circle-color': SIGNAL, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
    });
    add({
      id: 'red-dibujo-elegido',
      type: 'circle',
      source: 'red-dibujo',
      filter: clase('elegido'),
      paint: { 'circle-radius': 10, 'circle-color': '#ffffff', 'circle-stroke-color': SIGNAL, 'circle-stroke-width': 4 },
    });
    add({
      id: 'red-dibujo-marca',
      type: 'circle',
      source: 'red-dibujo',
      filter: clase('marca'),
      paint: { 'circle-radius': 9, 'circle-color': SIGNAL, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 },
    });

    ready = true;
    render();
    emit('capas');
  }

  const listo = new Promise((resolve, reject) => {
    const iniciar = () => addLayers().then(resolve, reject);
    if (map.isStyleLoaded()) iniciar();
    else map.once('load', iniciar);
  });

  // ------------------------------------------------------------------ datos

  function render() {
    if (!ready) return;
    map.getSource('red-elementos').setData(collection([...state.elementos.values()]));
    map.getSource('red-cables').setData(collection([...state.cables.values()]));
    aplicarSeleccion();
  }

  function aplicarSeleccion() {
    if (!ready) return;
    const sel = state.seleccion;
    map.setFilter('red-elementos-sel', ['==', ['id'], sel?.clase === 'elemento' ? sel.id : -1]);
    map.setFilter('red-cables-sel', ['==', ['id'], sel?.clase === 'cable' ? sel.id : -1]);
  }

  const TABLAS = { elemento: state.elementos, cable: state.cables, equipo: state.equipos, fusion: state.fusiones };
  const tablaDe = (clase) => TABLAS[clase];
  // Elementos y cables son GeoJSON (la versión va en properties); equipos y uniones, objetos simples.
  const versionDe = (item) => item.properties?.version ?? item.version;

  // Bajas vistas (clase:id -> versión): un sondeo que salió antes de una baja y
  // llega después no tiene que revivir lo borrado.
  const bajas = new Map();

  function upsert(clase, item) {
    const tabla = tablaDe(clase);
    const actual = tabla.get(item.id);
    const v = versionDe(item);
    // Lo que llega tarde (una respuesta más vieja que lo que ya se ve) no pisa.
    if (actual && versionDe(actual) >= v) return false;
    if ((bajas.get(`${clase}:${item.id}`) ?? -1) >= v) return false;
    tabla.set(item.id, item);
    return true;
  }

  function quitar(clase, id, version) {
    if (version !== undefined) bajas.set(`${clase}:${id}`, Math.max(version, bajas.get(`${clase}:${id}`) ?? -1));
    const habia = tablaDe(clase).delete(id);
    if (habia) state.rev += 1;
    if (state.seleccion?.clase === clase && state.seleccion.id === id) {
      state.seleccion = null;
      aplicarSeleccion();
      emit('seleccion', null);
    }
    return habia;
  }

  const esSeleccion = (clase, id) => state.seleccion?.clase === clase && state.seleccion.id === id;

  // Si un cambio tiene que ver con lo elegido (para rehacer su ficha). De
  // equipos y uniones, los de ese elemento o los de las fibras de ese cable; la
  // ficha de un cliente depende de uniones de otros lugares (su NAP).
  function tocaLaSeleccion(clase, item) {
    const sel = state.seleccion;
    if (!sel || !item) return false;
    if (clase === 'elemento' || clase === 'cable') return !item.borrado && esSeleccion(clase, item.id);
    if (sel.clase === 'elemento') {
      return item.elemento === sel.id || state.elementos.get(sel.id)?.properties.tipo === 'cliente';
    }
    return clase === 'fusion' && [item.a, item.b].some((ext) => String(ext).startsWith(`c${sel.id}:`));
  }

  // Aplica lo que devuelve el servidor: carga completa, cambios de otros o la
  // respuesta de una escritura propia. Devuelve cuántos cambios eran de otros.
  function aplicar(payload) {
    let ajenos = 0;
    let cambios = 0;
    let enMapa = 0;
    let tocaSeleccion = false;
    const procesar = (clase, items) => {
      for (const item of items ?? []) {
        const previo = tablaDe(clase).get(item.id);
        const hubo = item.borrado ? quitar(clase, item.id, item.version) : upsert(clase, item);
        if (!hubo) continue;
        cambios += 1;
        if (clase === 'elemento' || clase === 'cable') enMapa += 1;
        const autor = item.borrado ? item.modificado_por : (item.properties?.modificado_por ?? item.modificado_por);
        if (autor && autor !== usuario) ajenos += 1;
        if (tocaLaSeleccion(clase, item.borrado ? previo : item)) tocaSeleccion = true;
      }
    };
    procesar('elemento', payload.elementos?.features ?? payload.elementos);
    procesar('cable', payload.cables?.features ?? payload.cables);
    procesar('elemento', payload.elemento ? [payload.elemento] : []);
    procesar('cable', payload.cable ? [payload.cable] : []);
    procesar('equipo', payload.equipos);
    procesar('fusion', payload.fusiones);
    if (cambios) state.rev += 1;
    if (enMapa) render();
    if (tocaSeleccion && state.seleccion) emit('seleccion', seleccionado());
    if (cambios) emit('datos', { ajenos });
    return ajenos;
  }

  async function cargar(redId) {
    detenerSondeo();
    clearTimeout(reintento);
    state.red = redId;
    state.cargada = false;
    state.version = 0;
    state.elementos.clear();
    state.cables.clear();
    state.equipos.clear();
    state.fusiones.clear();
    bajas.clear();
    state.rev += 1;
    state.seleccion = null;
    render();
    limpiarRecorrido();
    emit('datos', { ajenos: 0 });
    if (!redId) {
      emit('cargada', null);
      return;
    }
    let datos;
    try {
      datos = await api(`api/red?red=${redId}`, { espera: ESPERA_CARGA_MS });
    } catch (err) {
      // Sin la red completa no se carga nada encima (se duplicarían nombres):
      // se vuelve a intentar sola hasta que llegue.
      if (state.red === redId && err.status !== 404) {
        reintento = setTimeout(() => {
          if (state.red === redId && !state.cargada) cargar(redId).catch(() => {});
        }, REINTENTO_MS);
      }
      throw err;
    }
    if (state.red !== redId) return; // mientras tanto se eligió otra red
    state.version = datos.version;
    state.cargada = true;
    aplicar(datos);
    emit('cargada', datos.red);
    iniciarSondeo();
  }

  // Vuelve a pedir todo (después de un conflicto o de un corte largo).
  async function recargar() {
    if (!state.red) return;
    const sel = state.seleccion;
    const red = state.red;
    const datos = await api(`api/red?red=${red}`, { espera: ESPERA_CARGA_MS });
    if (state.red !== red) return;
    state.elementos.clear();
    state.cables.clear();
    state.equipos.clear();
    state.fusiones.clear();
    state.rev += 1;
    state.version = datos.version;
    aplicar(datos);
    if (sel && tablaDe(sel.clase).has(sel.id)) seleccionar(sel.clase, sel.id);
  }

  async function sondear() {
    if (!state.red || pidiendo || document.visibilityState !== 'visible') return;
    pidiendo = true;
    const red = state.red;
    try {
      const cambios = await api(`api/cambios?red=${red}&desde=${state.version}`);
      if (state.red !== red || cambios.version <= state.version) return;
      state.version = cambios.version;
      // Cambios en otras redes mueven la versión pero no traen nada para esta.
      const hay = ['elementos', 'cables', 'equipos', 'fusiones'].some((k) => cambios[k]?.length);
      if (!hay) return;
      const ajenos = aplicar(cambios);
      if (ajenos) emit('cambios', ajenos);
    } catch (err) {
      // Sin señal un rato: se vuelve a intentar en el próximo ciclo.
      console.warn('sondeo:', err.message);
    } finally {
      pidiendo = false;
    }
  }

  function iniciarSondeo() {
    detenerSondeo();
    timer = setInterval(sondear, POLL_MS);
  }

  function detenerSondeo() {
    clearInterval(timer);
    timer = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sondear();
  });

  // ------------------------------------------------------------- selección

  function seleccionado() {
    const sel = state.seleccion;
    if (!sel) return null;
    const feature = tablaDe(sel.clase).get(sel.id);
    return feature ? { clase: sel.clase, feature } : null;
  }

  function seleccionar(clase, id) {
    state.seleccion = clase ? { clase, id } : null;
    aplicarSeleccion();
    emit('seleccion', seleccionado());
  }

  const caja = (point, r) => [[point.x - r, point.y - r], [point.x + r, point.y + r]];

  function masCercano(rendered, point) {
    let best = null;
    let bestDist = Infinity;
    for (const f of rendered) {
      const d = map.project(f.geometry.coordinates).dist(point);
      if (d < bestDist) {
        best = f;
        bestDist = d;
      }
    }
    return best;
  }

  // Elemento más cercano a un punto de la pantalla, contando el tamaño de su
  // ícono. Se calcula con los datos (no con lo último que dibujó el mapa), así
  // da bien aunque el mapa se esté moviendo.
  function elementoCercano(point, radio) {
    const z = map.getZoom();
    const escala = escalaIcono(z);
    const margen = radio + (30 * escala) / 2;
    const a = map.unproject([point.x - margen, point.y - margen]);
    const b = map.unproject([point.x + margen, point.y + margen]);
    const [w, e] = [Math.min(a.lng, b.lng), Math.max(a.lng, b.lng)];
    const [s, n] = [Math.min(a.lat, b.lat), Math.max(a.lat, b.lat)];
    let best = null;
    let bestDist = Infinity;
    for (const f of state.elementos.values()) {
      const [lng, lat] = f.geometry.coordinates;
      if (lng < w || lng > e || lat < s || lat > n) continue;
      const def = ELEMENTOS[f.properties.tipo];
      if (f.properties.tipo === 'poste' && z < 13) continue; // los postes no se ven a poco zoom
      const d = map.project([lng, lat]).dist(point) - ((def?.tam ?? 20) * escala) / 2;
      if (d <= radio && (d < bestDist || (d === bestDist && (def?.orden ?? 0) > (ELEMENTOS[best.properties.tipo]?.orden ?? 0)))) {
        best = f;
        bestDist = d;
      }
    }
    return best;
  }

  // Qué hay bajo un punto de la pantalla: primero elementos, después cables.
  function featureEn(point, radio = 10) {
    if (!ready) return null;
    const elemento = elementoCercano(point, radio);
    if (elemento) return { clase: 'elemento', feature: elemento };
    const cables = map.queryRenderedFeatures(caja(point, radio), { layers: ['red-cables-halo'] });
    for (const c of cables) {
      if (state.cables.has(c.id)) return { clase: 'cable', feature: state.cables.get(c.id) };
    }
    return null;
  }

  // Elemento al que "pegar" un punto de cable: el más cercano dentro del radio.
  function imanEn(point, radio = 20) {
    if (!ready) return null;
    const feature = elementoCercano(point, radio);
    if (!feature) return null;
    const [lng, lat] = feature.geometry.coordinates;
    return { id: feature.id, lngLat: new maplibregl.LngLat(lng, lat), feature };
  }

  // Manija del dibujo bajo un punto: { clase: 'vertice' | 'medio', i }.
  function manijaEn(point, radio = 12) {
    if (!ready) return null;
    const rendered = map.queryRenderedFeatures(caja(point, radio), {
      layers: ['red-dibujo-elegido', 'red-dibujo-puntos', 'red-dibujo-medio'],
    });
    const best = masCercano(rendered, point);
    if (!best) return null;
    const { clase, i } = best.properties;
    return { clase: clase === 'medio' ? 'medio' : 'vertice', i };
  }

  function dibujar(features) {
    if (ready) map.getSource('red-dibujo').setData(collection(features));
  }

  // Resalta en el mapa los tramos de un recorrido (listas de coordenadas).
  function resaltarRecorrido(lineas) {
    if (!ready) return;
    const features = (lineas ?? []).filter((l) => l.length >= 2)
      .map((coordinates) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }));
    map.getSource('red-recorrido').setData(collection(features));
  }

  function limpiarRecorrido() {
    if (ready) map.getSource('red-recorrido').setData(collection([]));
  }

  const nombres = (clase, tipo) => {
    const out = [];
    for (const f of tablaDe(clase).values()) if (!tipo || f.properties.tipo === tipo) out.push(f.properties.nombre);
    return out;
  };

  const cablesPegados = (elementoId) =>
    [...state.cables.values()].filter((c) => (c.properties.nodos ?? []).includes(elementoId));

  // Búsqueda por nombre (y n.º de abonado) en la red cargada.
  function buscar(texto, limite = 8) {
    const q = normalizar(texto);
    if (!q) return [];
    const out = [];
    const mirar = (clase, f) => {
      const p = f.properties;
      const campos = [p.nombre, p.datos?.abonado, p.datos?.direccion].map(normalizar);
      const exacto = campos[0] === q;
      if (exacto || campos.some((c) => c.includes(q))) out.push({ clase, feature: f, exacto });
    };
    for (const f of state.elementos.values()) mirar('elemento', f);
    for (const f of state.cables.values()) mirar('cable', f);
    out.sort((a, b) => Number(b.exacto) - Number(a.exacto)
      || String(a.feature.properties.nombre).localeCompare(String(b.feature.properties.nombre), 'es', { numeric: true }));
    return out.slice(0, limite);
  }

  return {
    state,
    listo,
    on,
    cargar,
    recargar,
    aplicar,
    quitar,
    sondear,
    seleccionar,
    seleccionado,
    featureEn,
    imanEn,
    manijaEn,
    dibujar,
    resaltarRecorrido,
    limpiarRecorrido,
    nombres,
    cablesPegados,
    buscar,
    punto,
  };
}
