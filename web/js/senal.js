// La señal en el mapa: qué cables llevan luz de una OLT según las cartas de
// empalme, hacia dónde va (flechas) y si hay tráfico (clientes con la ONT en línea,
// según el panel de la OLT). Los cables sin luz muestran el sentido de la red, del
// nodo hacia afuera. Se prende y se apaga con un botón del mapa; la carta y las
// fichas usan los mismos datos (el estado de las ONT se pide una vez por minuto).
// Con la señal prendida, cada NAP lleva un anillo del color de cómo reciben sus
// clientes y, al acercar, la potencia promedio y las bocas libres. Debajo del botón
// de la señal va el que abre el tablero de la OLT.

import { api } from './api.js';
import * as F from './fibras.js';
import { dbTexto, haceCuanto, resumenCaja, viejo } from './integracion.js';

const CLAVE = 'ftth.senal';
const CLAVE_LEYENDA = 'ftth.senal.leyenda'; // abierta | cerrada (en el teléfono arranca cerrada: tapa el mapa)
const ESTADOS_MS = 60 * 1000; // el panel lee la OLT cada 2 minutos: más seguido no cambia nada
const RECALCULO_MS = 250;
const PASO_FLUJO_MS = 100; // diez cuadros por segundo: se ve el movimiento sin gastar de más la batería
// red: el sentido de los cables sin luz (más oscuro que las flechas de las calles del mapa).
export const COLORES = { trafico: '#0b9d58', luz: '#ef9a00', caida: '#dc2b25', red: '#3d4852' };
const DEBAJO_DE = 'red-recorrido-halo'; // las capas de la señal van debajo del recorrido y de los elementos
const CAPAS = ['senal-halo', 'senal-linea', 'senal-flujo', 'senal-flechas', 'senal-cajas-anillo', 'senal-cajas-texto'];
// Cómo reciben los clientes de una caja (los mismos colores que las fibras).
export const NIVELES = { bien: '#0b9d58', atencion: '#ef9a00', mal: '#dc2b25', caida: '#8f1d18', ninguno: '#7c8890' };
const DEBAJO_DE_CAJAS = 'red-elementos-sel'; // el anillo va debajo del dibujo de la caja
// Rayas que avanzan en el sentido de la línea (de MapLibre, "animate a line").
const FLUJO = [
  [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
  [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
];

const vacio = { type: 'FeatureCollection', features: [] };
const ancho = (base) => ['interpolate', ['linear'], ['zoom'], 12, base * 0.55, 16, base, 20, base * 1.7];

function h(spec, attrs = {}, ...children) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

const svgFlecha = (color) => '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">'
  + '<path d="M10 6.5 17.5 14 10 21.5" fill="none" stroke="#ffffff" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"/>'
  + `<path d="M10 6.5 17.5 14 10 21.5" fill="none" stroke="${color}" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/>`
  + '</svg>';

async function cargarImagen(svg) {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  return img;
}

const ICONO_BOTON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h3l2.5-6 4 12 2.5-6H21"/></svg>';
// La OLT: un chasis con sus puertos.
const ICONO_OLT = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"/>'
  + '<path d="M7 10v4M11 10v4M15 10v4"/><circle cx="18.2" cy="12" r="0.6"/></svg>';

function leerPreferencia() {
  try {
    return localStorage.getItem(CLAVE) === '1';
  } catch {
    return false;
  }
}

function guardarPreferencia(si) {
  try {
    localStorage.setItem(CLAVE, si ? '1' : '0');
  } catch { /* sin almacenamiento: dura lo que la página */ }
}

function leyendaAbiertaGuardada() {
  try {
    const v = localStorage.getItem(CLAVE_LEYENDA);
    if (v === 'abierta' || v === 'cerrada') return v === 'abierta';
  } catch { /* sin almacenamiento */ }
  return window.innerWidth >= 640;
}

const reducido = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

// Lo que se escribe junto a una caja en el mapa: "−21,3 · 5 libres".
export function textoCaja(r) {
  const partes = [];
  if (r.nivel === 'caida') partes.push('sin señal');
  else if (r.promedio !== null) partes.push(dbTexto(r.promedio));
  if (r.sobrecargada) partes.push('llena');
  else if (r.libres !== null) partes.push(r.libres === 0 ? 'llena' : `${r.libres} ${r.libres === 1 ? 'libre' : 'libres'}`);
  return partes.join(' · ');
}

export function setupSenal({ map, red, irA, abrirOlt }) {
  let activa = leerPreferencia();
  let capas = false;
  let estados = new Map(); // cliente -> { estado, rx, cuando, causa }
  let estadosDe = null; // de qué red son
  let leido = null;
  let conectadas = null; // cuántas redes de lo que se ve tienen el panel conectado
  let errores = [];
  let pidiendo = null;
  let ultimoPedido = 0;
  let cajas = new Map(); // caja -> { nap, lecturas, sin_lectura } (de Wispro y el panel)
  let cajasDe = null;
  let conWispro = null; // cuántas redes de lo que se ve están conectadas con Wispro
  let erroresCajas = [];
  let pidiendoCajas = null;
  let ultimoPedidoCajas = 0;
  let resumenes = { clave: null, mapa: new Map() }; // el resumen de cada NAP, por estado de la red y de las lecturas
  let version = 0;
  let recalculo = null;
  let sondeo = null;
  let animacion = null;
  let pasoFlujo = -1;
  let hayTrafico = false;
  let leyendaAbierta = leyendaAbiertaGuardada();
  let ultimo = { segs: [], est: null }; // lo último dibujado (para rehacer la leyenda al plegarla)
  const oyentes = new Set();

  // ----------------------------------------------------------- el botón

  const boton = h('button.senal-boton', {
    type: 'button',
    'aria-pressed': String(activa),
    'aria-label': 'Señal de la red: fibras con luz, sentido y tráfico',
    title: 'Señal: qué fibras tienen luz, hacia dónde va y si hay tráfico',
  });
  boton.innerHTML = ICONO_BOTON;
  // Sin aria-live: se rehace con cada cambio de la red y no tiene que anunciarse cada vez.
  const leyenda = h('div.senal-leyenda', { hidden: !activa });
  const botonOlt = h('button.senal-boton.olt-boton', {
    type: 'button',
    'aria-label': 'Tablero de la OLT: puertos PON, ONT, caídas y cajas',
    title: 'OLT: puertos PON, ONT, caídas y cajas',
    hidden: !abrirOlt,
  });
  botonOlt.innerHTML = ICONO_OLT;
  botonOlt.addEventListener('click', () => abrirOlt?.());
  const contenedor = h('div.maplibregl-ctrl.senal-ctrl', {}, h('div.maplibregl-ctrl-group', {}, boton, botonOlt), leyenda);
  boton.addEventListener('click', () => alternar(!activa));
  map.addControl({ onAdd: () => contenedor, onRemove: () => contenedor.remove() }, 'top-right');

  // ------------------------------------------------------------ capas

  async function agregarCapas() {
    for (const [estado, color] of Object.entries(COLORES)) {
      const id = `senal-flecha-${estado}`;
      const img = await cargarImagen(svgFlecha(color));
      if (map.hasImage(id)) map.removeImage(id);
      map.addImage(id, img, { pixelRatio: 2 });
    }
    map.addSource('senal', { type: 'geojson', data: vacio });
    const add = (layer) => map.addLayer({ ...layer, layout: { ...layer.layout, visibility: activa ? 'visible' : 'none' } },
      map.getLayer(DEBAJO_DE) ? DEBAJO_DE : undefined);
    const conLuz = ['!=', ['get', 'estado'], 'red'];
    add({
      id: 'senal-halo',
      type: 'line',
      source: 'senal',
      filter: conLuz,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': ancho(9.5), 'line-opacity': 0.92 },
    });
    add({
      id: 'senal-linea',
      type: 'line',
      source: 'senal',
      filter: conLuz,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['match', ['get', 'estado'], 'trafico', COLORES.trafico, 'caida', COLORES.caida, COLORES.luz],
        'line-width': ancho(5.5),
      },
    });
    add({
      id: 'senal-flujo',
      type: 'line',
      source: 'senal',
      filter: ['==', ['get', 'estado'], 'trafico'],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-opacity': 0.9, 'line-width': ancho(2.2), 'line-dasharray': FLUJO[0] },
    });
    add({
      id: 'senal-flechas',
      type: 'symbol',
      source: 'senal',
      minzoom: 13,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 13, 70, 18, 120],
        'icon-image': ['concat', 'senal-flecha-', ['get', 'estado']],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.7, 17, 1, 20, 1.35],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-rotation-alignment': 'map',
        'icon-keep-upright': false,
      },
    });
    // Las cajas: un anillo del color de cómo reciben sus clientes y, de cerca, el número.
    map.addSource('senal-cajas', { type: 'geojson', data: vacio });
    const color = ['match', ['get', 'nivel'], 'bien', NIVELES.bien, 'atencion', NIVELES.atencion, 'mal', NIVELES.mal,
      'caida', NIVELES.caida, NIVELES.ninguno];
    map.addLayer({
      id: 'senal-cajas-anillo',
      type: 'circle',
      source: 'senal-cajas',
      filter: ['!=', ['get', 'nivel'], 'ninguno'],
      layout: { visibility: activa ? 'visible' : 'none' },
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4.5, 15, 13, 18, 20, 21, 26],
        'circle-color': color,
        'circle-opacity': 0.2,
        'circle-stroke-color': color,
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 1.6, 15, 3, 18, 3.6],
      },
    }, map.getLayer(DEBAJO_DE_CAJAS) ? DEBAJO_DE_CAJAS : undefined);
    map.addLayer({
      id: 'senal-cajas-texto',
      type: 'symbol',
      source: 'senal-cajas',
      minzoom: 15,
      filter: ['!=', ['get', 'texto'], ''],
      layout: {
        visibility: activa ? 'visible' : 'none',
        'text-field': ['get', 'texto'],
        'text-font': ['Noto Sans Medium'],
        'text-size': 11,
        'text-anchor': 'top',
        'text-offset': [0, 2.95], // debajo del nombre de la caja
        'text-optional': true,
      },
      paint: {
        'text-color': ['match', ['get', 'nivel'], 'bien', '#06693a', 'atencion', '#8a5200', 'mal', '#b3211c', 'caida', '#8f1d18', '#3d4852'],
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.6,
      },
    });
    capas = true;
    aplicarVisibilidad();
    if (activa) construir();
  }

  red.listo.then(() => agregarCapas()).catch((err) => console.warn('señal:', err));

  function aplicarVisibilidad() {
    if (!capas) return;
    for (const id of CAPAS) map.setLayoutProperty(id, 'visibility', activa ? 'visible' : 'none');
    // Con la señal, los cables de siempre quedan atenuados: se ve lo que tiene luz.
    for (const id of ['red-cables', 'red-cables-proyectado']) {
      if (map.getLayer(id)) map.setPaintProperty(id, 'line-opacity', activa ? 0.32 : 1);
    }
    if (map.getLayer('red-cables-etiquetas')) map.setPaintProperty('red-cables-etiquetas', 'text-opacity', activa ? 0.55 : 1);
  }

  // ---------------------------------------------------------- estados

  const estadosVigentes = () => (estadosDe !== null && estadosDe === red.state.red ? estados : null);

  // El estado de las ONT de los clientes (para el tráfico). Sin forzar, no se repite
  // antes de un minuto; si la red no tiene el panel conectado, no se vuelve a pedir.
  function pedirEstados({ forzar = false } = {}) {
    const redId = red.state.red;
    if (!redId || !red.state.cargada) return Promise.resolve(null);
    if (pidiendo) return pidiendo;
    if (!forzar && estadosDe === redId && (conectadas === 0 || Date.now() - ultimoPedido < ESTADOS_MS)) {
      return Promise.resolve(estados);
    }
    ultimoPedido = Date.now();
    pidiendo = api(`api/integracion/estados?red=${redId}`, { espera: 60000 })
      .then((res) => {
        if (red.state.red !== redId) return null;
        estados = new Map(Object.entries(res.clientes ?? {}).map(([k, v]) => [Number(k), v]));
        estadosDe = redId;
        leido = res.leido ?? null;
        conectadas = res.conectadas ?? 0;
        errores = res.errores ?? [];
        version += 1;
        avisar();
        return estados;
      })
      .catch((err) => {
        if (red.state.red === redId) {
          estadosDe = redId; // sin datos, pero no se reintenta en cada cálculo
          errores = [err.message];
          avisar();
        }
        return null;
      })
      .finally(() => {
        pidiendo = null;
      });
    return pidiendo;
  }

  // Las cajas con su NAP de Wispro y las lecturas de sus contratos. Como los estados:
  // una vez por minuto y, si ninguna red está conectada con Wispro, no se repite.
  function pedirCajas({ forzar = false } = {}) {
    const redId = red.state.red;
    if (!redId || !red.state.cargada) return Promise.resolve(null);
    if (pidiendoCajas) return pidiendoCajas;
    if (!forzar && cajasDe === redId && (conWispro === 0 || Date.now() - ultimoPedidoCajas < ESTADOS_MS)) {
      return Promise.resolve(cajas);
    }
    ultimoPedidoCajas = Date.now();
    pidiendoCajas = api(`api/integracion/cajas?red=${redId}`, { espera: 60000 })
      .then((res) => {
        if (red.state.red !== redId) return null;
        cajas = new Map(Object.entries(res.cajas ?? {}).map(([k, v]) => [Number(k), v]));
        cajasDe = redId;
        conWispro = res.conectadas ?? 0;
        erroresCajas = res.errores ?? [];
        version += 1;
        avisar();
        return cajas;
      })
      .catch((err) => {
        if (red.state.red === redId) {
          cajasDe = redId;
          erroresCajas = [err.message];
          avisar();
        }
        return null;
      })
      .finally(() => {
        pidiendoCajas = null;
      });
    return pidiendoCajas;
  }

  const pedirTodo = (opciones) => Promise.all([pedirEstados(opciones), pedirCajas(opciones)]);

  // El resumen de cada NAP (bocas y cómo reciben sus clientes): se rehace cuando
  // cambia la red o llegan lecturas nuevas.
  function resumenesDeCajas() {
    const s = red.state;
    const clave = `${s.red}|${s.rev}|${version}`;
    if (resumenes.clave === clave) return resumenes.mapa;
    const mapa = new Map();
    if (s.cargada) {
      const est = estadosVigentes();
      const deWispro = cajasDe !== null && cajasDe === s.red ? cajas : null;
      for (const e of s.elementos.values()) {
        if (e.properties.tipo === 'nap') mapa.set(e.id, resumenCaja(s, e, deWispro?.get(e.id) ?? null, est));
      }
    }
    resumenes = { clave, mapa };
    return mapa;
  }

  function avisar() {
    if (activa) construir();
    for (const fn of oyentes) fn();
  }

  function iniciarSondeo() {
    clearInterval(sondeo);
    sondeo = setInterval(() => {
      if (activa && document.visibilityState === 'visible') pedirTodo();
    }, ESTADOS_MS);
  }

  // ------------------------------------------------------------ dibujo

  function construir() {
    clearTimeout(recalculo);
    recalculo = null;
    if (!capas) return;
    const s = red.state;
    const est = estadosVigentes();
    const features = [];
    const segs = s.cargada ? F.segmentosConLuz(s) : [];
    hayTrafico = false;
    for (const seg of segs) {
      const cable = s.cables.get(seg.cable);
      if (!cable) continue;
      const coords = cable.geometry.coordinates.slice(seg.desde, seg.hasta + 1);
      if (seg.sentido < 0) coords.reverse();
      if (coords.length < 2) continue;
      const abajo = F.estadoAbajo(seg.clientes, est);
      if (abajo.estado === 'trafico') hayTrafico = true;
      features.push({
        type: 'Feature',
        properties: {
          cable: seg.cable, estado: abajo.estado, fibras: seg.fibras.size, total: cable.properties.fibras,
          clientes: abajo.clientes, enLinea: abajo.enLinea, caidos: abajo.caidos,
        },
        geometry: { type: 'LineString', coordinates: coords },
      });
    }
    if (s.cargada) {
      for (const t of F.sentidoDeRed(s)) {
        const cable = s.cables.get(t.cable);
        if (!cable) continue;
        const coords = cable.geometry.coordinates.slice(t.desde, t.hasta + 1);
        if (t.sentido < 0) coords.reverse();
        if (coords.length >= 2) {
          features.push({ type: 'Feature', properties: { cable: t.cable, estado: 'red' }, geometry: { type: 'LineString', coordinates: coords } });
        }
      }
    }
    map.getSource('senal')?.setData({ type: 'FeatureCollection', features });
    const puntos = [];
    for (const [id, r] of resumenesDeCajas()) {
      const texto = textoCaja(r);
      if (r.nivel === 'ninguno' && !texto) continue;
      puntos.push({ type: 'Feature', properties: { id, nivel: r.nivel, texto }, geometry: s.elementos.get(id).geometry });
    }
    map.getSource('senal-cajas')?.setData({ type: 'FeatureCollection', features: puntos });
    pintarLeyenda(segs, est);
    animar();
  }

  function programar() {
    if (!activa || recalculo) return;
    recalculo = setTimeout(construir, RECALCULO_MS);
  }

  function animar() {
    const seguir = activa && hayTrafico && !reducido() && capas;
    if (!seguir) {
      if (animacion) cancelAnimationFrame(animacion);
      animacion = null;
      return;
    }
    if (animacion) return;
    const cuadro = (t) => {
      if (!(activa && hayTrafico && capas)) {
        animacion = null;
        return;
      }
      const k = Math.floor(t / PASO_FLUJO_MS) % FLUJO.length;
      // Con la carta o el tablero de la OLT abiertos el mapa no se ve: no se redibuja.
      if (k !== pasoFlujo && !document.body.matches('.con-carta, .con-olt')) {
        pasoFlujo = k;
        map.setPaintProperty('senal-flujo', 'line-dasharray', FLUJO[k]);
      }
      animacion = requestAnimationFrame(cuadro);
    };
    animacion = requestAnimationFrame(cuadro);
  }

  // ----------------------------------------------------------- leyenda

  function muestra(estado, flecha = false) {
    const m = h(`span.senal-muestra.senal-${estado}`, { 'aria-hidden': 'true' });
    if (flecha) m.innerHTML = '<svg viewBox="0 0 14 14"><path d="M5 3.5 8.5 7 5 10.5"/></svg>';
    return m;
  }

  const TEXTO_CONFLICTO = {
    contramano: (nombre) => `En ${nombre} entra luz por una salida de un splitter: ¿está al revés?`,
    'otra-olt': (nombre) => `En ${nombre} la luz de una OLT llega a otra OLT.`,
    'dos-fuentes': (nombre) => `A ${nombre} llega luz por dos caminos.`,
  };

  function pintarLeyenda(segs = ultimo.segs, est = ultimo.est) {
    ultimo = { segs, est };
    if (!activa) {
      leyenda.hidden = true;
      return;
    }
    const s = red.state;
    const luz = F.iluminacion(s);
    // Plegada, una línea: cuántos cables con luz y cuántos clientes con luz están en línea.
    const cablesConLuz = new Set(segs.map((x) => x.cable)).size;
    let corto = 'sin luz todavía';
    if (cablesConLuz) {
      corto = plural(cablesConLuz, 'cable con luz', 'cables con luz');
      const abajo = est ? F.estadoAbajo(new Set(luz.clientes.keys()), est) : null;
      if (abajo && (abajo.enLinea || abajo.caidos)) corto += ` · ${abajo.enLinea} de ${abajo.enLinea + abajo.caidos} en línea`;
    }
    if (luz.conflictos.length) corto += ' · revisar cartas';
    const titulo = h('button.senal-titulo', {
      type: 'button',
      'aria-expanded': String(leyendaAbierta),
      title: leyendaAbierta ? 'Plegar la leyenda' : 'Ver la leyenda y las cuentas',
      onclick: () => {
        leyendaAbierta = !leyendaAbierta;
        try {
          localStorage.setItem(CLAVE_LEYENDA, leyendaAbierta ? 'abierta' : 'cerrada');
        } catch { /* sin almacenamiento */ }
        pintarLeyenda();
        leyenda.querySelector('.senal-titulo')?.focus();
      },
    }, h('strong', { text: 'Señal' }), h('small', { text: leyendaAbierta ? 'según las cartas de empalme' : corto }),
    h('span.senal-plegar', { 'aria-hidden': 'true' }));
    if (!leyendaAbierta) {
      leyenda.replaceChildren(titulo);
      leyenda.classList.add('plegada');
      leyenda.hidden = false;
      return;
    }
    leyenda.classList.remove('plegada');
    const items = [
      h('li', {}, muestra('trafico', true), 'Con tráfico: clientes en línea'),
      h('li', {}, muestra('luz', true), 'Con luz'),
      h('li', {}, muestra('caida', true), 'Con luz, clientes sin señal'),
      h('li', {}, muestra('red', true), 'Sin luz: sentido desde el nodo'),
    ];
    const lineas = [];
    if (!s.cargada) {
      lineas.push(h('p', { text: 'Cargando la red…' }));
    } else if (!luz.puertos.size) {
      lineas.push(h('p', { text: 'Todavía no hay luz: falta la OLT en un nodo con sus puertos PON unidos a fibras en la carta de empalme.' }));
    } else {
      const cables = new Set(segs.map((x) => x.cable)).size;
      let clientesRed = 0;
      for (const e of s.elementos.values()) if (e.properties.tipo === 'cliente') clientesRed += 1;
      lineas.push(h('p', { text: `Luz en ${plural(cables, 'cable', 'cables')} · llega a ${clientesRed ? `${luz.clientes.size} de ${clientesRed}` : '0'} clientes` }));
      if (est) {
        const abajo = F.estadoAbajo(new Set(luz.clientes.keys()), est);
        if (abajo.enLinea || abajo.caidos) {
          lineas.push(h('p', { text: `De esos, ${abajo.enLinea} en línea${abajo.caidos ? ` y ${abajo.caidos} sin señal` : ''}.` }));
        }
        let sinLuz = 0;
        for (const [id, e] of est) if (e.estado === 'online' && !luz.clientes.has(id)) sinLuz += 1;
        if (sinLuz) {
          lineas.push(h('p.senal-nota', { text: `${plural(sinLuz, 'cliente en línea', 'clientes en línea')} todavía sin luz en el mapa: falta completar su recorrido en las cartas.` }));
        }
      }
    }
    if (conectadas === 0) {
      lineas.push(h('p.senal-nota', { text: 'Sin datos de tráfico: esta red no está conectada al panel de la OLT.' }));
    } else if (leido) {
      lineas.push(h(`p.senal-nota${viejo(leido) ? '.senal-alerta' : ''}`, { text: `OLT leída ${haceCuanto(leido)}.` }));
    }
    for (const e of [...new Set([...errores, ...erroresCajas])].slice(0, 2)) lineas.push(h('p.senal-nota.senal-alerta', { text: e }));
    // Las cajas: qué quiere decir el anillo y cuántas hay con algo para mirar.
    const deCajas = [...resumenesDeCajas().values()];
    const conDatos = deCajas.filter((r) => r.nivel !== 'ninguno').length;
    if (conDatos) {
      const revisar = deCajas.filter((r) => ['mal', 'caida', 'atencion'].includes(r.nivel)).length;
      items.push(h('li.senal-clave-cajas', {},
        h('span.senal-anillos', { 'aria-hidden': 'true' }, h('span.senal-anillo.nivel-bien'), h('span.senal-anillo.nivel-atencion'), h('span.senal-anillo.nivel-mal')),
        'Cajas: cómo reciben sus clientes'));
      lineas.push(h('p', { text: `${plural(conDatos, 'caja con lecturas', 'cajas con lecturas')}${revisar ? ` · ${revisar} para revisar` : ''}` }));
    }
    const verCajas = abrirOlt && deCajas.length
      ? h('button.senal-ver-cajas', { type: 'button', text: `Ver las cajas (${deCajas.length})`, onclick: () => abrirOlt('cajas') })
      : null;
    const conflictos = [];
    const vistos = new Set();
    for (const c of luz.conflictos) {
      if (vistos.has(c.elemento) || conflictos.length >= 3) continue;
      vistos.add(c.elemento);
      const nombre = F.nombreElemento(s, c.elemento);
      conflictos.push(h('li', {}, h('button.senal-conflicto', {
        type: 'button',
        text: (TEXTO_CONFLICTO[c.motivo] ?? TEXTO_CONFLICTO['dos-fuentes'])(nombre),
        onclick: () => irA?.(c.elemento),
      })));
    }
    leyenda.replaceChildren(...[
      titulo,
      h('ul.senal-claves', {}, ...items),
      h('div.senal-cuentas', {}, ...lineas),
      verCajas,
      conflictos.length ? h('ul.senal-conflictos', {}, ...conflictos) : null,
    ].filter(Boolean));
    leyenda.hidden = false;
  }

  // ----------------------------------------------------------- estado

  function alternar(si) {
    activa = Boolean(si);
    guardarPreferencia(activa);
    boton.setAttribute('aria-pressed', String(activa));
    leyenda.hidden = !activa;
    aplicarVisibilidad();
    if (activa) {
      construir();
      pedirTodo();
      iniciarSondeo();
    } else {
      clearInterval(sondeo);
      sondeo = null;
      map.getSource('senal')?.setData(vacio);
      map.getSource('senal-cajas')?.setData(vacio);
      animar();
    }
  }

  red.on('datos', () => programar());
  red.on('cargada', () => {
    estados = new Map();
    estadosDe = null;
    leido = null;
    conectadas = null;
    errores = [];
    ultimoPedido = 0;
    cajas = new Map();
    cajasDe = null;
    conWispro = null;
    erroresCajas = [];
    ultimoPedidoCajas = 0;
    version += 1;
    if (activa) {
      construir();
      pedirTodo();
    }
    for (const fn of oyentes) fn();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && activa) pedirTodo();
  });
  if (activa) iniciarSondeo();

  return {
    activa: () => activa,
    alternar,
    estados: estadosVigentes,
    version: () => version,
    pedirEstados,
    pedirTodo,
    // El resumen de una NAP (bocas y cómo reciben sus clientes) y el de todas, para la lista.
    caja: (id) => resumenesDeCajas().get(id) ?? null,
    cajas: () => ({
      resumenes: resumenesDeCajas(),
      leido,
      conWispro,
      conPanel: conectadas,
      errores: [...new Set([...errores, ...erroresCajas])],
      cargando: Boolean(pidiendo || pidiendoCajas) && (estadosDe !== red.state.red || cajasDe !== red.state.red),
    }),
    on: (fn) => oyentes.add(fn),
  };
}
