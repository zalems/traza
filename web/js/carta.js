// La carta de empalme de un elemento (botella, caja, NAP o nodo): los cables
// que llegan, con sus tubos y fibras en colores; los splitters y la OLT; y las
// uniones entre todo eso, dibujadas como fibras con su protector de empalme.
// Se une tocando un extremo y después el otro, y una unión hecha se puede pasar
// a otra fibra. Los cables y los equipos se ordenan en columnas o se acomodan
// libres sobre la bandeja, con zoom; esa disposición queda guardada para todos.
// También se ve como lista y se copia como texto.

import { api } from './api.js';
import { CABLES, ELEMENTOS, formatFecha, formatLargo, sugerirNombre } from './modelo.js';
import * as F from './fibras.js';

const SVG = 'http://www.w3.org/2000/svg';
const RADIO_PEGAR_M = 25; // cables que terminan así de cerca, sin pegar, se ofrecen para pegar
// Modo libre: ancho de los bloques y separación cuando se acomodan solos.
const ANCHO_PUNTA = 252;
const ANCHO_EQUIPO = 188;
const SEPARACION = 76;
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 2.5;
const UMBRAL = 6; // px que hay que mover para que un toque pase a ser arrastre
// Columnas o libre es de cada dispositivo (en el teléfono suele convenir
// columnas; en la oficina, libre). Lo que se acomoda, en cambio, es para todos.
const CLAVE_MODO = 'ftth.carta.modo';
const PASO_TECLA = 16;
// Cordón entre dos equipos (patchcord monomodo, amarillo) y adaptadores SC.
const CORDON = '#e3c21b';
const ADAPTADOR = { apc: '#2f8f4e', upc: '#2563c9', otro: '#6b7780' };
const ASA_SVG = '<svg viewBox="0 0 10 18" aria-hidden="true"><circle cx="2.5" cy="3" r="1.5"/><circle cx="7.5" cy="3" r="1.5"/>'
  + '<circle cx="2.5" cy="9" r="1.5"/><circle cx="7.5" cy="9" r="1.5"/><circle cx="2.5" cy="15" r="1.5"/><circle cx="7.5" cy="15" r="1.5"/></svg>';

// Creador de nodos: h('tag.clase', { attr }, ...hijos). Todo texto va como texto.
function h(spec, attrs = {}, ...children) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') el.textContent = value;
    else if (key === 'style') el.setAttribute('style', value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'value') el.value = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) if (value !== null && value !== undefined) el.setAttribute(key, value);
  return el;
}

const boton = (text, onclick, extra = {}) => h('button', { type: 'button', text, onclick, ...extra });
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
const limitar = (x, min, max) => Math.min(max, Math.max(min, x));

function distancia(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(x)));
}

// Punto de color de una fibra o un tubo. Las marcas (del 13 en adelante) se ven
// como una banda oscura.
function punto(c, extra = {}) {
  const marcas = c?.marcas ? `.punto-marca${c.marcas > 1 ? 's' : ''}` : '';
  return h(`span.punto${marcas}`, { style: c ? `--c:${c.hex};--m:${c.marca ?? '#1c1c1c'}` : null, ...extra });
}

// Texto oscuro sobre los colores claros (blanco, amarillo, agua…); blanco sobre los oscuros.
function luminancia(hex) {
  const n = Number.parseInt(String(hex).slice(1), 16);
  if (!Number.isFinite(n)) return 1;
  const canal = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * canal((n >> 16) & 255) + 0.7152 * canal((n >> 8) & 255) + 0.0722 * canal(n & 255);
}
const textoSobre = (hex) => (luminancia(hex) > 0.3 ? '#16222c' : '#ffffff');

// --------------------------------------------------------- geometría de las líneas

const medio = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
const xy = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
const dCurva = ([p0, p1, p2, p3]) => `M${xy(p0)}C${xy(p1)} ${xy(p2)} ${xy(p3)}`;

// Curva entre dos extremos: sale de cada uno hacia donde mira su punto.
function controles(a, b) {
  const dx = Math.max(26, Math.min(170, Math.abs(b.x - a.x) * 0.45 + Math.abs(b.y - a.y) * 0.06));
  return [[a.x, a.y], [a.x + a.mira * dx, a.y], [b.x + b.mira * dx, b.y], [b.x, b.y]];
}

// De Casteljau en la mitad: las dos mitades (cada una del color de su fibra),
// el punto medio y hacia dónde va la curva ahí (para el protector de empalme).
function partir([p0, p1, p2, p3]) {
  const p01 = medio(p0, p1);
  const p12 = medio(p1, p2);
  const p23 = medio(p2, p3);
  const p012 = medio(p01, p12);
  const p123 = medio(p12, p23);
  const m = medio(p012, p123);
  return {
    m,
    angulo: (Math.atan2(p123[1] - p012[1], p123[0] - p012[0]) * 180) / Math.PI,
    h1: [p0, p01, p012, m],
    h2: [m, p123, p23, p3],
  };
}

// Lo que pasa sin cortar (fibras en paso y bandas de tubos plegados) va todo
// junto: un trazo por color. Un cable grande que pasa entero son cientos de
// fibras, y así se dibujan rápido.
function pintarFondo(specs) {
  const g = svgEl('g', { class: 'lineas-fondo' });
  for (const tipo of ['banda', 'paso']) {
    const bordes = [];
    const porColor = new Map();
    for (const spec of specs) {
      if (spec.tipo !== tipo) continue;
      const d = dCurva(controles(spec.a, spec.b));
      bordes.push(d);
      if (!porColor.has(spec.colorA)) porColor.set(spec.colorA, []);
      porColor.get(spec.colorA).push(d);
    }
    if (!bordes.length) continue;
    g.append(svgEl('path', { d: bordes.join(''), class: `${tipo}-borde` }));
    for (const [color, ds] of porColor) {
      g.append(svgEl('path', { d: ds.join(''), class: `${tipo} linea-${tipo}`, style: `--c:${color}`, 'data-lineas': ds.length }));
    }
  }
  return g;
}

// Una unión como grupo SVG: dos medias fibras (cada una del color de su
// fibra) con su borde y su brillo, y en el medio el protector de empalme o el
// adaptador del conector.
function trazar(spec) {
  const g = svgEl('g', { class: `linea-${spec.tipo}${spec.marcada ? ' marcada' : ''}` });
  const c = controles(spec.a, spec.b);
  const d = dCurva(c);
  const { m, angulo, h1, h2 } = partir(c);
  if (spec.marcada) g.append(svgEl('path', { d, class: 'hebra-marca' }));
  g.append(
    svgEl('path', { d, class: 'hebra-borde' }),
    svgEl('path', { d: dCurva(h1), class: 'hebra', style: `--c:${spec.colorA}` }),
    svgEl('path', { d: dCurva(h2), class: 'hebra', style: `--c:${spec.colorB}` }),
    svgEl('path', { d, class: 'hebra-luz', transform: 'translate(0 -0.9)' }),
  );
  const pieza = svgEl('g', { transform: `translate(${m[0].toFixed(1)} ${m[1].toFixed(1)}) rotate(${angulo.toFixed(1)})` });
  if (spec.adaptador) {
    pieza.setAttribute('class', 'adaptador');
    pieza.append(
      svgEl('rect', { x: -8.5, y: -6, width: 17, height: 12, rx: 2.4, style: `--a:${spec.adaptador}` }),
      svgEl('rect', { x: -3.2, y: -3.2, width: 6.4, height: 6.4, rx: 1.2, class: 'adaptador-boca' }),
    );
  } else {
    pieza.setAttribute('class', 'protector');
    pieza.append(
      svgEl('rect', { x: -12.5, y: -4.3, width: 25, height: 8.6, rx: 4.3 }),
      svgEl('line', { x1: -8.5, y1: 0, x2: 8.5, y2: 0, class: 'varilla' }),
    );
  }
  g.append(pieza);
  return g;
}

export function setupCarta({ root, red, acciones, toast }) {
  let elementoId = null;
  let vista = 'diagrama';
  let elegido = null; // extremo elegido para unir
  let foco = null; // qué muestra el pie: union, mover-elegir, hecho, quitada, punta, equipo, form, error, texto
  let mover = null; // { fusion, punta: 'a' | 'b' }: esa punta de la unión pasa a la fibra que se toque
  const abiertos = new Map(); // `${cable}:${tubo}` -> desplegado (lo que tocó el usuario)
  let ocupado = false;
  let propio = false; // un cambio propio en curso: la carta se redibuja al terminar
  let silencio = 0; // respuestas de la disposición que no tienen que redibujar dos veces
  let apertura = 0; // sube cada vez que se abre o se cierra: una respuesta tardía no toca otra carta
  let ultimaFirma = '';
  let cab = null;
  let cuerpo = null;
  let pie = null;
  let cuadro = null; // donde se miden las líneas: .carta-diagrama (columnas) o .carta-lienzo (libre)
  let visor = null; // modo libre: la bandeja que se mueve y se acerca
  let lienzo = null;
  let bloques = new Map(); // modo libre: clave -> { el, col, x, y, auto }
  let lineas = null; // las líneas dibujadas (para moverlas mientras se arrastra un bloque)
  let fondo = null; // el grupo con lo que pasa sin cortar
  let lineasPendientes = 0;
  let gesto = null; // arrastre, desplazamiento o pellizco en curso: mientras dura no se redibuja
  let rehacer = false;
  let ignorarClick = false;
  const punteros = new Map();
  let safari = null; // pellizco del panel táctil en Safari (eventos gesture*)
  let teclaReciente = 0; // cuándo se usó el teclado por última vez (para seguir el foco en libre)
  let restaurandoFoco = false;
  let modoSinGuardar = 'columnas'; // sin almacenamiento (navegación privada), el modo dura lo que la página
  const vistas = new Map(); // elemento -> { tx, ty, z } del modo libre (de cada usuario; no se guarda)
  const pendientes = new Map(); // elemento -> disposición todavía sin confirmar por el servidor
  // Las líneas se recalculan si cambia el tamaño (girar el teléfono, abrir un tubo).
  const observador = 'ResizeObserver' in window ? new ResizeObserver(() => pedirLineas()) : null;

  const state = () => red.state;
  const abierta = () => !root.hidden && elementoId !== null;

  // ------------------------------------------------------------ datos

  // Igual que merge_carta de la API: así se ve al instante lo que se acomodó,
  // antes de que el servidor lo confirme.
  function mezclar(base, patch) {
    if (patch === null) return {};
    const out = { ...base };
    for (const key of ['lados', 'orden']) {
      if (!(key in patch)) continue;
      const valor = patch[key];
      if (valor && Object.keys(valor).length) out[key] = valor;
      else delete out[key];
    }
    if ('pos' in patch) {
      const pos = patch.pos === null ? {} : { ...(out.pos ?? {}) };
      for (const [key, valor] of Object.entries(patch.pos ?? {})) {
        if (valor === null) delete pos[key];
        else pos[key] = valor;
      }
      if (Object.keys(pos).length) out.pos = pos;
      else delete out.pos;
    }
    return out;
  }

  function cartaEfectiva(elemento) {
    let carta = elemento.properties.carta ?? {};
    const p = pendientes.get(elemento.id);
    if (p?.enviando) carta = mezclar(carta, p.enviando);
    if (p?.patch) carta = mezclar(carta, p.patch);
    return carta;
  }

  function datos() {
    const s = state();
    const elemento = s.elementos.get(elementoId);
    if (!elemento) return null;
    const carta = cartaEfectiva(elemento);
    const conCarta = { ...elemento, properties: { ...elemento.properties, carta } };
    const { puntas, rotos, repetidos } = F.puntas(s, elementoId);
    const idx = F.indice(s);
    const fusiones = idx.fusionesEn.get(elementoId) ?? [];
    const equipos = idx.equiposEn.get(elementoId) ?? [];
    const usado = new Map();
    for (const f of fusiones) {
      usado.set(f.a, f);
      usado.set(f.b, f);
    }
    return {
      s, elemento, carta, puntas, rotos, repetidos, fusiones, equipos, usado,
      lados: F.ladosDeCarta(s, conCarta, puntas),
      libre: modoLocal() === 'libre',
    };
  }

  const otro = (lado) => (lado === 'a' ? 'b' : 'a');

  // La punta que se está pasando a otra fibra (se marca como elegida).
  function extremoMovido() {
    if (!mover) return null;
    return state().fusiones.get(mover.fusion)?.[mover.punta] ?? null;
  }

  // unida | paso (sigue de largo, sin cortar) | cortada (este lado quedó libre) | libre
  function estadoFibra(d, p, n) {
    if (d.usado.has(F.extremoCable(p.cable.id, p.lado, n))) return 'unida';
    if (p.pasante) return d.usado.has(F.extremoCable(p.cable.id, otro(p.lado), n)) ? 'cortada' : 'paso';
    return 'libre';
  }

  function tuboAbierto(d, p, t, est) {
    const key = `${p.cable.id}:${t}`;
    if (abiertos.has(key)) return abiertos.get(key);
    // Los cables chicos se ven enteros; en los grandes, los tubos que tienen uniones.
    if (est.tubos === 1 || est.fibras <= 24) return true;
    const desde = (t - 1) * est.porTubo + 1;
    const hasta = Math.min(t * est.porTubo, est.fibras);
    const movido = extremoMovido();
    for (let n = desde; n <= hasta; n += 1) {
      for (const lado of ['a', 'b']) {
        const ext = F.extremoCable(p.cable.id, lado, n);
        if (d.usado.has(ext) || ext === elegido || ext === movido) return true;
      }
    }
    return false;
  }

  // Lo que muestra la carta, resumido: si un cambio de la red no lo toca, no se rehace.
  function firma(d) {
    const partes = [`e${d.elemento.properties.version}`, JSON.stringify(d.carta)];
    for (const p of d.puntas) {
      partes.push(`${p.key}:${p.cable.properties.version}:${p.hacia?.elemento?.id ?? ''}:${p.hacia?.elemento?.properties.version ?? ''}`);
    }
    for (const f of d.fusiones) partes.push(`f${f.id}:${f.version}`);
    for (const e of d.equipos) partes.push(`q${e.id}:${e.version}`);
    for (const c of [...d.rotos, ...d.repetidos]) partes.push(`r${c.id}`);
    for (const c of cercanos(d)) partes.push(`p${c.cable.id}:${c.cable.properties.version}`);
    return partes.join('|');
  }

  // Un extremo libre de este elemento (se puede unir).
  function libre(d, ext) {
    const p = F.parseExtremo(ext);
    if (!p || d.usado.has(ext)) return false;
    if (p.tipo === 'q') return d.equipos.some((e) => e.id === p.id);
    return d.puntas.some((x) => x.cable.id === p.id && x.lado === p.lado);
  }

  const etiqueta = (ext) => F.etiquetaExtremo(state(), ext);

  // Etiqueta con el lado ("hacia NAP-3") cuando el cable pasa: los dos lados se llaman igual.
  function etiquetaConLado(d, ext) {
    const p = F.parseExtremo(ext);
    const base = etiqueta(ext);
    if (p?.tipo !== 'c') return base;
    const punta = d.puntas.find((x) => x.cable.id === p.id && x.lado === p.lado);
    if (!punta?.pasante) return base;
    return `${base}, lado ${haciaTexto(punta)}`;
  }

  function haciaTexto(p) {
    const destino = p.hacia;
    if (!destino) return '';
    if (destino.suelto) return `hacia el extremo suelto (${formatLargo(destino.metros)})`;
    return `hacia ${destino.elemento.properties.nombre || ELEMENTOS[destino.elemento.properties.tipo]?.nombre} (${formatLargo(destino.metros)})`;
  }

  function corto(ext) {
    const p = F.parseExtremo(ext);
    if (!p) return ext;
    if (p.tipo === 'c') return `F${p.n}`;
    const eq = state().equipos.get(p.id);
    if (eq?.tipo === 'olt') return `PON ${p.n}`;
    return p.lado === 'e' ? `E${p.n}` : `S${p.n}`;
  }

  // "T-001 F5 (hacia NAP-3)", "SPL-1 S3": para los botones del pie.
  function nombreCorto(d, ext) {
    const p = F.parseExtremo(ext);
    if (!p) return ext;
    if (p.tipo === 'q') return `${state().equipos.get(p.id)?.nombre || 'Equipo'} ${corto(ext)}`;
    const punta = d.puntas.find((x) => x.cable.id === p.id && x.lado === p.lado);
    const nombre = punta?.cable.properties.nombre || 'Cable';
    const hacia = punta?.pasante && punta.hacia?.elemento ? ` (hacia ${punta.hacia.elemento.properties.nombre})` : '';
    return `${nombre} ${corto(ext)}${hacia}`;
  }

  function nombreBloque(key) {
    if (key.startsWith('q')) {
      const eq = state().equipos.get(Number(key.slice(1)));
      return eq?.nombre || (eq?.tipo === 'olt' ? 'la OLT' : 'el splitter');
    }
    const cable = state().cables.get(Number(key.slice(1).split(':')[0]));
    return cable?.properties.nombre || 'el cable';
  }

  // Cables que terminan cerca del elemento pero no quedaron pegados a él.
  function cercanos(d) {
    const centro = d.elemento.geometry.coordinates;
    const out = [];
    for (const c of d.s.cables.values()) {
      const nodos = c.properties.nodos ?? [];
      if (nodos.includes(elementoId)) continue;
      const coords = c.geometry.coordinates;
      for (const i of [0, coords.length - 1]) {
        if (nodos[i] !== null) continue;
        const m = distancia(coords[i], centro);
        if (m <= RADIO_PEGAR_M) {
          out.push({ cable: c, indice: i, metros: m });
          break;
        }
      }
    }
    return out.sort((x, y) => x.metros - y.metros);
  }

  // Las uniones que siguen en orden después de la última: hasta el final del
  // tubo (o del splitter); si las dos quedaron al final de su tubo, el tubo siguiente.
  function paresSiguientes(d, [a, b]) {
    const s = state();
    const out = [];
    let x = a;
    let y = b;
    for (;;) {
      let nx = F.siguienteExtremo(s, x);
      let ny = F.siguienteExtremo(s, y);
      if (!out.length && !nx && !ny) {
        nx = F.siguienteTubo(s, x);
        ny = F.siguienteTubo(s, y);
      }
      if (!nx || !ny || !libre(d, nx) || !libre(d, ny)) break;
      out.push([nx, ny]);
      x = nx;
      y = ny;
    }
    return out;
  }

  // Los bloques de cada columna, de arriba abajo: lo que el usuario ordenó y,
  // después, lo que no ordenó nunca (en el orden de siempre).
  function columnasDe(d) {
    const rango = new Map((d.carta.orden ?? []).map((k, i) => [k, i]));
    const ordenar = (keys) => keys.map((k, i) => [k, rango.has(k) ? rango.get(k) : 1e6 + i])
      .sort((x, y) => x[1] - y[1]).map((x) => x[0]);
    return {
      i: ordenar(d.puntas.filter((p) => d.lados.get(p.key) === 'i').map((p) => p.key)),
      m: ordenar(d.equipos.map((e) => `q${e.id}`)),
      d: ordenar(d.puntas.filter((p) => d.lados.get(p.key) !== 'i').map((p) => p.key)),
    };
  }

  // Los lados que el usuario eligió (y los nuevos), solo de los cables que siguen llegando.
  function ladosCon(d, cambios) {
    const out = {};
    const guardados = d.carta.lados ?? {};
    for (const p of d.puntas) {
      const valor = cambios[p.key] ?? guardados[p.key];
      if (valor === 'i' || valor === 'd') out[p.key] = valor;
    }
    return out;
  }

  // ------------------------------------------------------------ armado

  function armar() {
    root.replaceChildren();
    cab = h('header.carta-cab');
    cuerpo = h('div.carta-cuerpo', { tabindex: '-1' });
    pie = h('footer.carta-pie', { 'aria-live': 'polite' });
    const panel = h('div.carta-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'carta-titulo' }, cab, cuerpo, pie);
    root.append(panel);
    cuerpo.addEventListener('click', alTocar);
    cuerpo.addEventListener('pointerdown', alApoyar);
    cuerpo.addEventListener('wheel', alRueda, { passive: false });
    for (const tipo of ['gesturestart', 'gesturechange', 'gestureend']) cuerpo.addEventListener(tipo, alGestoSafari);
    cuerpo.addEventListener('keydown', alTeclear);
    // Con el teclado, en el modo libre la bandeja va hasta lo que tiene el foco.
    cuerpo.addEventListener('focusin', (ev) => {
      if (!visor || !lienzo?.contains(ev.target) || gesto || restaurandoFoco) return;
      if (performance.now() - teclaReciente > 800) return; // solo al recorrer con el teclado
      const r = ev.target.getBoundingClientRect();
      const v = visor.getBoundingClientRect();
      if (r.top < v.top || r.bottom > v.bottom || r.left < v.left || r.right > v.right) centrarEn(ev.target);
    });
    if (observador) {
      observador.disconnect();
      observador.observe(cuerpo);
    }
  }

  function renderCab(d) {
    const def = ELEMENTOS[d.elemento.properties.tipo];
    const cerrarBtn = boton('', () => cerrar(), { class: 'ficha-cerrar', 'aria-label': 'Cerrar la carta' });
    cerrarBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    const nUniones = d.fusiones.length;
    const resumen = [
      plural(new Set(d.puntas.map((p) => p.cable.id)).size, 'cable', 'cables'),
      plural(nUniones, 'unión', 'uniones'),
      ...d.equipos.map((e) => `${e.nombre || (e.tipo === 'olt' ? 'OLT' : 'splitter')} ${F.describirEquipo(e)}`),
    ].join(' · ');
    const conBloques = d.puntas.length || d.equipos.length;
    const herr = h('div.carta-herr', {},
      boton('Agregar splitter', () => abrirForm('splitter')),
      d.elemento.properties.tipo === 'nodo' ? boton('Agregar OLT', () => abrirForm('olt')) : null,
      vista === 'diagrama' && conBloques
        ? h('div.carta-modo', { role: 'group', 'aria-label': 'Cómo se acomoda la carta' },
          boton('Columnas', () => cambiarModo('columnas'), { 'aria-pressed': String(!d.libre), title: 'Cables a los costados, equipos en el medio' }),
          boton('Libre', () => cambiarModo('libre'), { 'aria-pressed': String(d.libre), title: 'Cada cable y equipo donde lo dejes, con zoom' }))
        : null,
      vista === 'diagrama' && d.libre && conBloques
        ? boton('Reacomodar', () => reacomodar(), { title: 'Volver a poner todo en columnas, desde arriba' })
        : null,
      boton(vista === 'lista' ? 'Ver diagrama' : 'Ver lista', () => {
        vista = vista === 'lista' ? 'diagrama' : 'lista';
        if (foco?.tipo !== 'form') {
          elegido = null;
          foco = null;
          mover = null;
        }
        render();
      }, { 'aria-pressed': String(vista === 'lista') }),
      boton('Copiar', () => copiar(), { title: 'Copiar la carta como texto (para mandar por mensaje)' }),
    );
    cab.replaceChildren(
      h('div.carta-titulo', {},
        h('small', { text: 'Carta de empalme' }),
        h('strong', { id: 'carta-titulo', text: d.elemento.properties.nombre || def?.nombre }),
        h('span.chip', { text: def?.label ?? d.elemento.properties.tipo })),
      cerrarBtn,
      h('p.carta-resumen', { text: resumen }),
      herr,
    );
  }

  function render() {
    if (!abierta()) return;
    // Mientras se arrastra o se mueve la bandeja no se rehace nada: se hace al soltar.
    if (gesto) {
      rehacer = true;
      return;
    }
    rehacer = false;
    const d = datos();
    if (!d) {
      cerrar({ aviso: 'El elemento ya no existe: lo borró otro usuario.' });
      return;
    }
    // Lo elegido o enfocado que ya no vale (lo cambió otro) se suelta.
    if (elegido && !libre(d, elegido)) elegido = null;
    if (mover && !d.fusiones.some((f) => f.id === mover.fusion)) mover = null;
    if ((foco?.tipo === 'union' || foco?.tipo === 'mover-elegir') && !d.fusiones.some((f) => f.id === foco.fusion)) foco = null;
    if (foco?.tipo === 'equipo' && !d.equipos.some((e) => e.id === foco.id)) foco = null;
    if (foco?.tipo === 'punta' && !d.puntas.some((p) => p.key === foco.key)) foco = null;
    // Con teclado, el foco vuelve al mismo botón después de rehacer la carta.
    const activo = cuerpo.contains(document.activeElement) ? document.activeElement : null;
    const selector = activo?.dataset.ext ? `[data-ext="${activo.dataset.ext}"]`
      : activo?.dataset.asa ? `[data-asa="${activo.dataset.asa}"]`
        : activo?.dataset.tubo ? `[data-tubo="${activo.dataset.tubo}"]`
          : activo?.dataset.key ? `[data-key="${activo.dataset.key}"]`
            : activo?.dataset.id ? `[data-accion="equipo"][data-id="${activo.dataset.id}"]`
              : activo?.classList.contains('carta-visor') ? '.carta-visor' : null;
    renderCab(d);
    lineas = null;
    punteros.clear();
    if (vista === 'lista') {
      const scroll = cuerpo.classList.contains('libre') ? 0 : cuerpo.scrollTop;
      soltarLibre();
      cuerpo.className = 'carta-cuerpo';
      cuerpo.replaceChildren(...lista(d));
      cuerpo.scrollTop = scroll;
      cuadro = null;
    } else if (d.libre && (d.puntas.length || d.equipos.length)) {
      renderLibre(d);
    } else {
      const scroll = cuerpo.classList.contains('libre') ? 0 : cuerpo.scrollTop;
      soltarLibre();
      cuerpo.className = 'carta-cuerpo carta-bandeja';
      cuerpo.replaceChildren(...diagrama(d));
      cuerpo.scrollTop = scroll;
    }
    if (selector) {
      restaurandoFoco = true;
      try {
        cuerpo.querySelector(selector)?.focus({ preventScroll: true });
      } finally {
        restaurandoFoco = false;
      }
    }
    if (foco?.tipo !== 'form') renderPie(d);
    ultimaFirma = firma(d);
    pedirLineas();
  }

  function soltarLibre() {
    visor = null;
    lienzo = null;
    bloques = new Map();
  }

  // ---------------------------------------------------------- diagrama

  function avisos(d) {
    const out = [];
    if (d.rotos.length) {
      const nombres = d.rotos.map((c) => c.properties.nombre || 'Un cable').join(', ');
      out.push(h('p.carta-aviso', { text: `${nombres} empieza${d.rotos.length > 1 ? 'n' : ''} y termina${d.rotos.length > 1 ? 'n' : ''} acá: así la carta no sabe qué fibra es de qué lado. Dibujalo como dos cables que terminen en este elemento.` }));
    }
    if (d.repetidos.length) {
      const nombres = d.repetidos.map((c) => c.properties.nombre || 'Un cable').join(', ');
      out.push(h('p.carta-aviso', { text: `${nombres} pasa${d.repetidos.length > 1 ? 'n' : ''} más de una vez por acá: la carta toma la primera entrada y la última salida. Conviene dibujarlo como dos cables.` }));
    }
    return out;
  }

  function diagrama(d) {
    const out = avisos(d);
    if (!d.puntas.length && !d.equipos.length) {
      out.push(h('div.carta-vacia', {},
        h('p', {}, h('strong', { text: 'Todavía no llega ningún cable.' })),
        h('p', { text: `Dibujá un cable que empiece, termine o pase por ${d.elemento.properties.nombre} (tocando el elemento, el cable queda pegado) y acá vas a ver sus fibras para unirlas.` })));
    } else {
      const cols = columnasDe(d);
      const puntaDe = new Map(d.puntas.map((p) => [p.key, p]));
      const equipoDe = new Map(d.equipos.map((e) => [`q${e.id}`, e]));
      const svg = svgEl('svg', { class: 'carta-lineas', 'aria-hidden': 'true' });
      cuadro = h(`div.carta-diagrama${d.equipos.length ? '.con-equipos' : ''}`, {},
        svg,
        h('div.carta-col', { 'data-col': 'i' }, ...cols.i.map((k) => bloquePunta(d, puntaDe.get(k), 'i'))),
        h('div.carta-col.carta-medio', { 'data-col': 'm' }, ...cols.m.map((k) => bloqueEquipo(d, equipoDe.get(k)))),
        h('div.carta-col', { 'data-col': 'd' }, ...cols.d.map((k) => bloquePunta(d, puntaDe.get(k), 'd'))),
      );
      out.push(cuadro);
    }
    const cerca = cercanos(d);
    if (cerca.length) out.push(bloqueCercanos(d, cerca));
    return out;
  }

  // El asa para arrastrar un bloque (o moverlo con las flechas).
  function asa(key, nombre) {
    const b = h('button.asa', {
      type: 'button',
      'data-asa': key,
      'aria-label': `Mover ${nombre}`,
      'aria-keyshortcuts': 'ArrowUp ArrowDown ArrowLeft ArrowRight',
      title: 'Arrastrá para moverlo (o usá las flechas)',
    });
    b.innerHTML = ASA_SVG;
    return b;
  }

  // Un lado de un cable: la chaqueta con su nombre, los tubos y las fibras.
  // 'i' mira a la derecha (sus puntos a la derecha); 'd', a la izquierda.
  function bloquePunta(d, p, lado) {
    const props = p.cable.properties;
    const est = F.estructura(props);
    const tipo = CABLES[props.tipo];
    const marcado = foco?.tipo === 'punta' && foco.key === p.key;
    const movido = extremoMovido();
    const tubos = [];
    for (let t = 1; t <= est.tubos; t += 1) {
      const desde = (t - 1) * est.porTubo + 1;
      const hasta = Math.min(t * est.porTubo, est.fibras);
      const abierto = tuboAbierto(d, p, t, est);
      const colorTubo = est.codigo.tubo(t);
      const cuenta = { unida: 0, paso: 0, libre: 0, cortada: 0 };
      const filas = [];
      for (let n = desde; n <= hasta; n += 1) {
        const estado = estadoFibra(d, p, n);
        cuenta[estado] += 1;
        if (!abierto) continue;
        const ext = F.extremoCable(p.cable.id, p.lado, n);
        const info = F.infoFibra(props, n);
        const f = d.usado.get(ext);
        const nota = estado === 'unida' ? `unida con ${etiqueta(f.a === ext ? f.b : f.a)}`
          : estado === 'paso' ? 'en paso (sigue de largo)'
            : estado === 'cortada' ? 'cortada, este lado libre' : 'libre';
        const marcada = ext === elegido || ext === movido;
        filas.push(h('li', {}, h(`button.fibra.${estado}${marcada ? '.elegida' : ''}`, {
          type: 'button',
          'data-ext': ext,
          'aria-label': `Fibra ${n}, ${F.nombreColor(info.color)}${est.tubos > 1 ? `, tubo ${t} ${F.nombreColor(colorTubo)}` : ''}: ${nota}`,
          'aria-pressed': marcada ? 'true' : null,
        }, h('span.num', { text: String(n) }), h('span.color-nombre', { text: F.nombreColor(info.color) }), punto(info.color))));
      }
      const resumen = [
        cuenta.unida && `${cuenta.unida} unida${cuenta.unida > 1 ? 's' : ''}`,
        cuenta.paso && `${cuenta.paso} en paso`,
        cuenta.cortada && `${cuenta.cortada} cortada${cuenta.cortada > 1 ? 's' : ''}`,
        cuenta.libre && `${cuenta.libre} libre${cuenta.libre > 1 ? 's' : ''}`,
      ].filter(Boolean).join(' · ');
      const estiloTubo = `--c:${colorTubo.hex};--m:${colorTubo.marca};--t:${textoSobre(colorTubo.hex)}`;
      const cabTubo = est.tubos > 1
        ? h(`button.tubo-cab${colorTubo.marcas ? '.tubo-marcado' : ''}`, {
          type: 'button', 'data-accion': 'tubo', 'data-tubo': `${p.cable.id}:${t}`, 'aria-expanded': String(abierto), style: estiloTubo,
        },
        h('span.tubo-nombre', { text: `T${t} ${F.nombreColor(colorTubo)}` }),
        h('small', { text: resumen }),
        h('span.ancla', { 'data-ancla': `${p.cable.id}:${p.lado}:${t}` }))
        : null;
      tubos.push(h(`div.tubo${abierto ? '' : '.plegado'}${est.tubos > 1 ? '' : '.unico'}`, { style: estiloTubo },
        cabTubo,
        abierto ? h('ul.fibras', {}, ...filas) : null));
    }
    const sub = [`${props.fibras} F`, tipo?.label ?? props.tipo];
    if (est.tubos > 1) sub.push(`${est.tubos} tubos de ${est.porTubo}`);
    return h(`section.punta.${lado === 'i' ? 'izq' : 'der'}${marcado ? '.marcada' : ''}`,
      { 'data-bloque': p.key, style: `--tipo:${tipo?.color ?? '#555'}` },
      h('div.punta-chaqueta', {},
        asa(p.key, props.nombre || 'el cable'),
        h('button.punta-cab', { type: 'button', 'data-accion': 'punta', 'data-key': p.key },
          h('strong', { text: props.nombre || 'Cable' }),
          h('span', { text: sub.join(' · ') }),
          h('small', { text: `${p.pasante ? 'pasa · ' : ''}${haciaTexto(p)}` }))),
      h('div.punta-tubos', {}, ...tubos));
  }

  function bloqueEquipo(d, eq) {
    const marcado = foco?.tipo === 'equipo' && foco.id === eq.id;
    const movido = extremoMovido();
    const puerto = (lado, n) => {
      const ext = F.extremoEquipo(eq.id, lado, n);
      const f = d.usado.get(ext);
      const estado = f ? 'unida' : 'libre';
      const marcada = ext === elegido || ext === movido;
      let detalle = '';
      if (f && lado === 's' && eq.tipo !== 'olt') {
        const fin = F.destino(state(), elementoId, ext);
        if (fin?.motivo === 'cliente') detalle = state().elementos.get(fin.elemento)?.properties.nombre ?? '';
      }
      const texto = eq.tipo === 'olt' ? `PON ${n}` : lado === 'e' ? (eq.entradas > 1 ? `E${n}` : 'E') : String(n);
      return h(`button.puerto.${estado}${marcada ? '.elegida' : ''}`, {
        type: 'button',
        'data-ext': ext,
        title: detalle ? `${F.etiquetaPuerto(eq, lado, n)}: ${detalle}` : F.etiquetaPuerto(eq, lado, n),
        'aria-label': `${F.etiquetaPuerto(eq, lado, n)}: ${f ? `unida con ${etiqueta(f.a === ext ? f.b : f.a)}` : 'libre'}`,
        'aria-pressed': marcada ? 'true' : null,
      }, punto(null), h('span.puerto-num', { text: texto }), detalle ? h('small', { text: detalle }) : null);
    };
    const entradas = [];
    for (let n = 1; n <= eq.entradas; n += 1) entradas.push(puerto('e', n));
    const salidas = [];
    for (let n = 1; n <= eq.salidas; n += 1) salidas.push(puerto('s', n));
    const nombre = eq.nombre || (eq.tipo === 'olt' ? 'OLT' : 'Splitter');
    return h(`section.equipo${eq.tipo === 'olt' ? '.olt' : ''}${eq.datos?.conectores ? '.con-conectores' : ''}${marcado ? '.marcada' : ''}`,
      { 'data-bloque': `q${eq.id}` },
      h('div.equipo-tapa', {},
        asa(`q${eq.id}`, nombre),
        h('button.equipo-cab', { type: 'button', 'data-accion': 'equipo', 'data-id': String(eq.id) },
          h('strong', { text: nombre }),
          h('small', { text: eq.tipo === 'olt' ? `OLT · ${F.describirEquipo(eq)}` : F.describirEquipo(eq) }))),
      h('div.equipo-puertos', {},
        h('div.equipo-entradas', {}, ...entradas),
        h('div.equipo-salidas', {}, ...salidas)));
  }

  function bloqueCercanos(d, cerca) {
    return h('div.carta-cercanos', {},
      h('p', { text: `Terminan cerca y no están pegados a ${d.elemento.properties.nombre}:` }),
      h('ul', {}, ...cerca.map((c) => h('li', {},
        h('span', { text: `${c.cable.properties.nombre || 'Cable'} · ${c.cable.properties.fibras} F · a ${formatLargo(c.metros)}` }),
        boton('Pegar acá', () => pegar(c), { class: 'chico' })))));
  }

  // --------------------------------------------------------- modo libre

  function renderLibre(d) {
    cuerpo.className = 'carta-cuerpo libre';
    const arriba = avisos(d);
    const cerca = cercanos(d);
    if (cerca.length) arriba.push(bloqueCercanos(d, cerca));
    lienzo = h('div.carta-lienzo', {}, svgEl('svg', { class: 'carta-lineas', 'aria-hidden': 'true' }));
    visor = h('div.carta-visor', {
      tabindex: '0',
      'aria-label': 'Bandeja de la carta. Arrastrá el fondo para moverte; el zoom, con dos dedos, con la rueda y Control, o con + y −.',
    }, lienzo);
    // Si el navegador desplaza la bandeja (buscar en la página, un foco), se pasa a la vista.
    visor.addEventListener('scroll', () => {
      if (!visor || (!visor.scrollLeft && !visor.scrollTop)) return;
      const v = vistaActual();
      const dx = visor.scrollLeft;
      const dy = visor.scrollTop;
      visor.scrollLeft = 0;
      visor.scrollTop = 0;
      aplicarVista({ ...v, tx: v.tx - dx, ty: v.ty - dy });
    });
    bloques = new Map();
    const cols = columnasDe(d);
    const puntaDe = new Map(d.puntas.map((p) => [p.key, p]));
    const equipoDe = new Map(d.equipos.map((e) => [`q${e.id}`, e]));
    for (const col of ['i', 'm', 'd']) {
      for (const key of cols[col]) {
        const el = col === 'm' ? bloqueEquipo(d, equipoDe.get(key)) : bloquePunta(d, puntaDe.get(key), col);
        bloques.set(key, { el, col, x: 0, y: 0, auto: true });
        lienzo.append(el);
      }
    }
    cuerpo.replaceChildren(...(arriba.length ? [h('div.carta-arriba', {}, ...arriba)] : []), visor, controlesZoom());
    ubicar(d);
    cuadro = lienzo;
    const v = vistas.get(elementoId);
    if (v) aplicarVista(v);
    else ajustarVista();
  }

  // Dónde va cada bloque: donde lo dejaron; los que nunca se movieron, en
  // columnas debajo de todo lo demás.
  function ubicar(d, { todos = false } = {}) {
    const pos = todos ? {} : (d.carta.pos ?? {});
    const xCol = {
      i: 0,
      m: ANCHO_PUNTA + SEPARACION,
      d: ANCHO_PUNTA + SEPARACION + (d.equipos.length ? ANCHO_EQUIPO + SEPARACION : SEPARACION),
    };
    let fondo = null;
    for (const [key, b] of bloques) {
      b.alto = b.el.offsetHeight;
      const guardada = pos[key];
      b.auto = !Array.isArray(guardada);
      if (!b.auto) {
        [b.x, b.y] = guardada;
        fondo = Math.max(fondo ?? -Infinity, b.y + b.alto);
      }
    }
    const y0 = fondo === null ? 0 : fondo + SEPARACION;
    const y = { i: y0, m: y0 + 40, d: y0 };
    for (const b of bloques.values()) {
      if (!b.auto) continue;
      b.x = xCol[b.col];
      b.y = y[b.col];
      y[b.col] += b.alto + 28;
    }
    for (const b of bloques.values()) {
      b.el.style.left = `${b.x}px`;
      b.el.style.top = `${b.y}px`;
    }
  }

  function controlesZoom() {
    return h('div.carta-zoom', {},
      boton('−', () => zoomEn(1 / 1.25), { 'aria-label': 'Alejar', title: 'Alejar' }),
      h('span.zoom-nivel', { 'aria-hidden': 'true' }),
      boton('+', () => zoomEn(1.25), { 'aria-label': 'Acercar', title: 'Acercar' }),
      boton('Ajustar', () => ajustarVista(), { title: 'Ver todo el ancho de la carta' }));
  }

  const vistaActual = () => vistas.get(elementoId) ?? { tx: 24, ty: 24, z: 1 };

  function aplicarVista(v) {
    vistas.set(elementoId, v);
    if (!lienzo || !visor) return;
    lienzo.style.transform = `translate(${v.tx.toFixed(1)}px, ${v.ty.toFixed(1)}px) scale(${v.z.toFixed(4)})`;
    visor.style.backgroundSize = `${(22 * v.z).toFixed(2)}px ${(22 * v.z).toFixed(2)}px`;
    visor.style.backgroundPosition = `${v.tx.toFixed(1)}px ${v.ty.toFixed(1)}px`;
    const nivel = cuerpo.querySelector('.zoom-nivel');
    if (nivel) nivel.textContent = `${Math.round(v.z * 100)} %`;
  }

  function zoomEn(factor, cx = null, cy = null) {
    if (!visor) return;
    const v = vistaActual();
    const x = cx ?? visor.clientWidth / 2;
    const y = cy ?? visor.clientHeight / 2;
    const z = limitar(v.z * factor, ZOOM_MIN, ZOOM_MAX);
    aplicarVista({ z, tx: x - ((x - v.tx) * z) / v.z, ty: y - ((y - v.ty) * z) / v.z });
  }

  // Entra todo si así se lee; si no, todo el ancho, desde arriba.
  function ajustarVista() {
    if (!visor || !bloques.size) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const b of bloques.values()) {
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.el.offsetWidth);
      y1 = Math.max(y1, b.y + b.el.offsetHeight);
    }
    const ancho = visor.clientWidth || 600;
    const alto = visor.clientHeight || 400;
    const m = 28;
    const zAncho = (ancho - 2 * m) / Math.max(1, x1 - x0 + 24);
    const zTodo = Math.min(zAncho, (alto - 2 * m) / Math.max(1, y1 - y0));
    const entero = zTodo >= 0.55;
    const z = limitar(Math.min(entero ? zTodo : zAncho, 1), ZOOM_MIN, ZOOM_MAX);
    aplicarVista({
      z,
      tx: (ancho - (x1 - x0) * z) / 2 - x0 * z,
      ty: entero ? (alto - (y1 - y0) * z) / 2 - y0 * z : m - y0 * z,
    });
  }

  // Lleva la bandeja para que un extremo quede en el medio.
  function centrarEn(el) {
    if (!visor || !lienzo) return;
    const v = vistaActual();
    const r = el.getBoundingClientRect();
    const base = lienzo.getBoundingClientRect();
    const x = (r.left + r.width / 2 - base.left) / v.z;
    const y = (r.top + r.height / 2 - base.top) / v.z;
    aplicarVista({ ...v, tx: visor.clientWidth / 2 - x * v.z, ty: visor.clientHeight / 2 - y * v.z });
  }

  // Guarda dónde quedaron los bloques. Los que todavía estaban acomodados
  // solos (y nadie guardó) se guardan también, así la bandeja no cambia sola
  // después; los de cables que ya no llegan se borran. Se mira la red de ahora,
  // no la de cuando empezó el arrastre: otro pudo haber acomodado mientras tanto.
  function guardarPos(cambios, { deshacer = null, ...opciones } = {}) {
    const d = datos();
    if (!d) return;
    const vigentes = new Set([...d.puntas.map((p) => p.key), ...d.equipos.map((e) => `q${e.id}`)]);
    const guardadas = d.carta.pos ?? {};
    const pos = {};
    for (const [key, b] of bloques) {
      if (b.auto && vigentes.has(key) && !guardadas[key]) pos[key] = [Math.round(b.x), Math.round(b.y)];
    }
    for (const [key, xy] of Object.entries(cambios)) if (vigentes.has(key)) pos[key] = xy;
    for (const key of Object.keys(guardadas)) if (!vigentes.has(key)) pos[key] = null;
    const cambia = Object.entries(pos).some(([key, xy]) => (xy === null
      ? key in guardadas
      : !(guardadas[key] && guardadas[key][0] === xy[0] && guardadas[key][1] === xy[1])));
    if (!cambia) {
      if (opciones.redibujar !== false) render();
      return;
    }
    if (deshacer) ofrecerDeshacer(d, { pos }, deshacer);
    guardarDisposicion({ pos }, opciones);
  }

  // Después de arrastrar o reacomodar, el pie ofrece deshacer (para todos queda
  // como estaba). Varios movimientos seguidos se deshacen juntos.
  function ofrecerDeshacer(d, patch, texto) {
    const previo = foco?.tipo === 'acomodado' && foco.elemento === elementoId ? foco.inverso : null;
    const inverso = {};
    if ('lados' in patch) inverso.lados = d.carta.lados ?? {};
    if ('orden' in patch) inverso.orden = d.carta.orden ?? [];
    if ('pos' in patch) {
      inverso.pos = {};
      for (const key of Object.keys(patch.pos ?? {})) inverso.pos[key] = d.carta.pos?.[key] ?? null;
    }
    // Lo más viejo manda: deshacer vuelve a como estaba antes del primer movimiento.
    if (previo) {
      for (const key of ['lados', 'orden']) if (key in previo) inverso[key] = previo[key];
      if (previo.pos) inverso.pos = { ...(inverso.pos ?? {}), ...previo.pos };
    }
    elegido = null;
    mover = null;
    foco = { tipo: 'acomodado', elemento: elementoId, inverso, texto };
  }

  function modoLocal() {
    try {
      return localStorage.getItem(CLAVE_MODO) === 'libre' ? 'libre' : 'columnas';
    } catch {
      return modoSinGuardar;
    }
  }

  function cambiarModo(modo) {
    const d = datos();
    if (!d || (modo === 'libre') === d.libre) return;
    elegido = null;
    mover = null;
    if (foco?.tipo !== 'form') foco = null;
    modoSinGuardar = modo;
    try {
      localStorage.setItem(CLAVE_MODO, modo);
    } catch {
      // queda en modoSinGuardar
    }
    render();
  }

  function reacomodar() {
    const d = datos();
    if (!d || !d.libre || !bloques.size) return;
    ubicar(d, { todos: true });
    vistas.delete(elementoId);
    const todas = {};
    for (const [key, b] of bloques) todas[key] = [Math.round(b.x), Math.round(b.y)];
    guardarPos(todas, { deshacer: 'Se reacomodó la carta en columnas.' });
    ajustarVista();
  }

  // ------------------------------------------------------------ líneas

  function pedirLineas() {
    if (lineasPendientes) return;
    lineasPendientes = requestAnimationFrame(() => {
      lineasPendientes = 0;
      dibujarLineas();
    });
  }

  const colorExtremo = (ext) => {
    const p = F.parseExtremo(ext);
    if (p?.tipo !== 'c') return null;
    const cable = state().cables.get(p.id);
    return cable ? F.infoFibra(cable.properties, p.n).color.hex : null;
  };

  // El color del adaptador según los conectores de la caja (verde APC, azul UPC).
  function colorAdaptador(d) {
    const conector = String(d.elemento.properties.datos?.conector ?? '');
    if (/APC/i.test(conector)) return ADAPTADOR.apc;
    if (/UPC/i.test(conector)) return ADAPTADOR.upc;
    return d.elemento.properties.tipo === 'nap' ? ADAPTADOR.apc : ADAPTADOR.otro;
  }

  function dibujarLineas() {
    if (!abierta() || vista !== 'diagrama' || !cuadro?.isConnected || gesto) return;
    const d = datos();
    if (!d) return;
    const svg = cuadro.querySelector('svg.carta-lineas');
    if (!svg) return;
    const enLienzo = cuadro === lienzo;
    const z = enLienzo ? vistaActual().z : 1;
    if (!enLienzo) {
      // El tamaño va en línea (la regla general de los íconos SVG fija 20 px) y se
      // achica antes de medir: si no, el propio dibujo no deja que el cuadro se achique.
      svg.style.width = '0px';
      svg.style.height = '0px';
      svg.style.width = `${cuadro.scrollWidth}px`;
      svg.style.height = `${cuadro.scrollHeight}px`;
    }
    const base = cuadro.getBoundingClientRect();
    // Se lee todo primero (un solo cálculo de diseño) y se dibuja al final.
    const puntos = new Map();
    for (const b of cuadro.querySelectorAll('[data-ext]')) {
      const pto = b.querySelector('.punto');
      if (pto) puntos.set(b.dataset.ext, pto);
    }
    const anclas = new Map();
    for (const a of cuadro.querySelectorAll('[data-ancla]')) anclas.set(a.dataset.ancla, a);
    const medidas = new Map();
    const posicion = (el) => {
      if (medidas.has(el)) return medidas.get(el);
      const r = el.getBoundingClientRect();
      const bloque = el.closest('[data-bloque]');
      let mira;
      if (bloque?.classList.contains('equipo')) mira = el.closest('.equipo-salidas') ? 1 : -1;
      else mira = bloque?.classList.contains('der') ? -1 : 1;
      const out = {
        x: (r.left + r.width / 2 - base.left) / z,
        y: (r.top + r.height / 2 - base.top) / z,
        mira,
        bloque: bloque?.dataset.bloque ?? null,
      };
      medidas.set(el, out);
      return out;
    };
    // El punto de un extremo; si su tubo está plegado, el ancla del tubo.
    const lugar = (ext) => {
      const pto = puntos.get(ext);
      if (pto) return posicion(pto);
      const p = F.parseExtremo(ext);
      if (p?.tipo !== 'c') return null;
      const cable = state().cables.get(p.id);
      if (!cable) return null;
      const { tubo } = F.infoFibra(cable.properties, p.n);
      const ancla = anclas.get(`${p.id}:${p.lado}:${tubo}`);
      return ancla ? posicion(ancla) : null;
    };
    const specs = [];
    // Fibras en paso: de un lado al otro del mismo cable.
    for (const p of d.puntas) {
      if (!p.pasante || p.lado !== 'a') continue;
      const props = p.cable.properties;
      const est = F.estructura(props);
      for (let t = 1; t <= est.tubos; t += 1) {
        const desde = (t - 1) * est.porTubo + 1;
        const hasta = Math.min(t * est.porTubo, est.fibras);
        if (!tuboAbierto(d, p, t, est)) {
          const a = anclas.get(`${p.cable.id}:a:${t}`);
          const b = anclas.get(`${p.cable.id}:b:${t}`);
          let alguna = false;
          for (let n = desde; n <= hasta && !alguna; n += 1) alguna = estadoFibra(d, p, n) === 'paso';
          if (a && b && alguna) specs.push({ tipo: 'banda', a: posicion(a), b: posicion(b), colorA: est.codigo.tubo(t).hex });
          continue;
        }
        for (let n = desde; n <= hasta; n += 1) {
          if (estadoFibra(d, p, n) !== 'paso') continue;
          const a = lugar(F.extremoCable(p.cable.id, 'a', n));
          const b = lugar(F.extremoCable(p.cable.id, 'b', n));
          if (a && b) specs.push({ tipo: 'paso', a, b, colorA: F.infoFibra(props, n).color.hex });
        }
      }
    }
    // Uniones: cada mitad del color de su fibra; entre equipos, cordón amarillo.
    const adaptador = colorAdaptador(d);
    const marcadas = [];
    for (const f of d.fusiones) {
      const a = lugar(f.a);
      const b = lugar(f.b);
      if (!a || !b) continue;
      const ca = colorExtremo(f.a);
      const cb = colorExtremo(f.b);
      const marcada = ((foco?.tipo === 'union' || foco?.tipo === 'mover-elegir') && foco.fusion === f.id) || mover?.fusion === f.id;
      const spec = {
        tipo: 'union', a, b, marcada,
        colorA: ca ?? cb ?? CORDON,
        colorB: cb ?? ca ?? CORDON,
        adaptador: f.tipo === 'conector' ? adaptador : null,
      };
      (marcada ? marcadas : specs).push(spec);
    }
    specs.push(...marcadas); // lo marcado, encima
    const trazos = document.createDocumentFragment();
    fondo = pintarFondo(specs);
    trazos.append(fondo);
    for (const spec of specs) {
      if (spec.tipo !== 'union') continue;
      spec.g = trazar(spec);
      trazos.append(spec.g);
    }
    svg.replaceChildren(trazos);
    lineas = specs;
  }

  // Mientras se arrastra un bloque en el modo libre, sus líneas lo siguen.
  function moverLineas(key, dx, dy) {
    let fondoMovido = false;
    for (const spec of lineas ?? []) {
      const enA = spec.a.bloque === key;
      const enB = spec.b.bloque === key;
      if (!enA && !enB) continue;
      spec.a0 ??= spec.a;
      spec.b0 ??= spec.b;
      spec.a = enA ? { ...spec.a0, x: spec.a0.x + dx, y: spec.a0.y + dy } : spec.a0;
      spec.b = enB ? { ...spec.b0, x: spec.b0.x + dx, y: spec.b0.y + dy } : spec.b0;
      if (spec.tipo !== 'union') {
        fondoMovido = true;
        continue;
      }
      const g = trazar(spec);
      spec.g.replaceWith(g);
      spec.g = g;
    }
    if (fondoMovido && fondo?.isConnected) {
      const nuevo = pintarFondo(lineas);
      fondo.replaceWith(nuevo);
      fondo = nuevo;
    }
  }

  // ------------------------------------------------------------ lista

  function lista(d) {
    const out = [];
    const nombre = (ext) => etiquetaConLado(d, ext);
    out.push(h('h3', { text: 'Cables' }));
    if (!d.puntas.length) out.push(h('p.carta-nota', { text: 'Todavía no llega ningún cable.' }));
    out.push(h('ul.carta-lista', {}, ...d.puntas.map((p) => {
      const props = p.cable.properties;
      const est = F.estructura(props);
      const usadas = [];
      for (let n = 1; n <= est.fibras; n += 1) if (estadoFibra(d, p, n) === 'unida') usadas.push(n);
      return h('li', {},
        h('strong', { text: `${props.nombre || 'Cable'} · ${props.fibras} F · ${CABLES[props.tipo]?.label ?? props.tipo}` }),
        h('span', { text: ` ${p.pasante ? 'pasa, ' : ''}${haciaTexto(p)} · ${plural(usadas.length, 'fibra unida', 'fibras unidas')}` }));
    })));
    out.push(h('h3', { text: `Uniones (${d.fusiones.length})` }));
    if (!d.fusiones.length) out.push(h('p.carta-nota', { text: 'Todavía no hay uniones.' }));
    else {
      const filas = d.fusiones.slice().sort((x, y) => nombre(x.a).localeCompare(nombre(y.a), 'es', { numeric: true }));
      out.push(h('div.carta-tabla', {}, h('table', {},
        h('thead', {}, h('tr', {}, h('th', { text: 'De' }), h('th', { text: 'A' }), h('th', { text: 'Tipo' }))),
        h('tbody', {}, ...filas.map((f) => h('tr', {},
          h('td', { text: nombre(f.a) }), h('td', { text: nombre(f.b) }),
          h('td', { text: f.tipo === 'conector' ? 'conector' : 'fusión' })))))));
    }
    const enPaso = textoEnPaso(d);
    if (enPaso.length) {
      out.push(h('h3', { text: 'En paso (sin cortar)' }));
      out.push(h('ul.carta-lista', {}, ...enPaso.map((t) => h('li', { text: t }))));
    }
    if (d.equipos.length) {
      out.push(h('h3', { text: 'Equipos' }));
      out.push(h('ul.carta-lista', {}, ...d.equipos.map((e) => h('li', {},
        h('strong', { text: `${e.nombre || 'Equipo'} · ${F.describirEquipo(e)}` }),
        h('span', { text: ` · ${usoEquipo(d, e)}` })))));
    }
    const cerca = cercanos(d);
    if (cerca.length) out.push(bloqueCercanos(d, cerca));
    return out;
  }

  // "F1–F36, F41–F48" por cable que pasa.
  function textoEnPaso(d) {
    const out = [];
    for (const p of d.puntas) {
      if (!p.pasante || p.lado !== 'a') continue;
      const est = F.estructura(p.cable.properties);
      const rangos = [];
      let desde = null;
      for (let n = 1; n <= est.fibras + 1; n += 1) {
        const paso = n <= est.fibras && estadoFibra(d, p, n) === 'paso';
        if (paso && desde === null) desde = n;
        if (!paso && desde !== null) {
          rangos.push(desde === n - 1 ? `F${desde}` : `F${desde}–F${n - 1}`);
          desde = null;
        }
      }
      if (rangos.length) out.push(`${p.cable.properties.nombre || 'Cable'}: ${rangos.join(', ')}`);
    }
    return out;
  }

  function usoEquipo(d, e) {
    let usadas = 0;
    for (let n = 1; n <= e.salidas; n += 1) if (d.usado.has(F.extremoEquipo(e.id, 's', n))) usadas += 1;
    const entrada = e.entradas ? (d.usado.has(F.extremoEquipo(e.id, 'e', 1)) ? 'con entrada' : 'sin entrada') : '';
    return [entrada, `${usadas} de ${e.salidas} ${e.tipo === 'olt' ? 'puertos' : 'salidas'} usad${usadas === 1 ? 'a' : 'as'}`]
      .filter(Boolean).join(', ');
  }

  function textoCarta(d) {
    const props = d.elemento.properties;
    const lineasTexto = [`Carta de empalme · ${props.nombre} (${ELEMENTOS[props.tipo]?.nombre ?? props.tipo})`];
    lineasTexto.push('', 'Cables:');
    for (const p of d.puntas) {
      lineasTexto.push(`- ${p.cable.properties.nombre} ${p.cable.properties.fibras}F ${p.pasante ? 'pasa, ' : ''}${haciaTexto(p)}`);
    }
    if (d.equipos.length) {
      lineasTexto.push('', 'Equipos:');
      for (const e of d.equipos) lineasTexto.push(`- ${e.nombre} ${F.describirEquipo(e)} (${usoEquipo(d, e)})`);
    }
    lineasTexto.push('', `Uniones (${d.fusiones.length}):`);
    for (const f of d.fusiones) lineasTexto.push(`- ${etiquetaConLado(d, f.a)} ↔ ${etiquetaConLado(d, f.b)}${f.tipo === 'conector' ? ' [conector]' : ''}`);
    const enPaso = textoEnPaso(d);
    if (enPaso.length) {
      lineasTexto.push('', 'En paso:');
      for (const t of enPaso) lineasTexto.push(`- ${t}`);
    }
    return lineasTexto.join('\n');
  }

  async function copiar() {
    const d = datos();
    if (!d) return;
    const texto = textoCarta(d);
    try {
      await navigator.clipboard.writeText(texto);
      toast('Carta copiada: pegala en un mensaje');
    } catch {
      // Sin portapapeles (permiso, HTTP): el texto queda a la vista para copiarlo a mano.
      foco = { tipo: 'texto', texto };
      renderPie(d);
      pie.querySelector('textarea')?.select();
    }
  }

  // --------------------------------------------------------------- pie

  // Subir y bajar un bloque en su columna (en el modo libre se arrastra).
  function botonesOrden(d, key) {
    if (d.libre) return [];
    const cols = columnasDe(d);
    const lista = Object.values(cols).find((c) => c.includes(key)) ?? [];
    const i = lista.indexOf(key);
    return [
      boton('Subir', () => moverEnColumna(key, -1), { disabled: i <= 0 }),
      boton('Bajar', () => moverEnColumna(key, 1), { disabled: i < 0 || i >= lista.length - 1 }),
    ];
  }

  function renderPie(d = datos()) {
    if (!d) return;
    const items = [];
    let texto = '';
    let detalle = '';
    if (ocupado) {
      texto = 'Guardando…';
    } else if (foco?.tipo === 'error') {
      texto = foco.mensaje;
      items.push(boton('Entendido', () => soltar()));
    } else if (foco?.tipo === 'texto') {
      pie.replaceChildren(
        h('p', { text: 'Copiá este texto (el navegador no dejó copiarlo solo):' }),
        h('textarea.carta-texto', { rows: 6, readonly: true, value: foco.texto }),
        h('div.carta-pie-botones', {}, boton('Listo', () => soltar())));
      return;
    } else if (mover) {
      const f = state().fusiones.get(mover.fusion);
      if (f) {
        const queda = f[mover.punta === 'a' ? 'b' : 'a'];
        texto = `Tocá la fibra o el puerto nuevo para ${etiquetaConLado(d, queda)}.`;
        detalle = `Hoy está unida con ${etiquetaConLado(d, f[mover.punta])}. Si hace falta, abrí otro tubo.`;
        items.push(boton('Cancelar', () => {
          mover = null;
          foco = { tipo: 'union', fusion: f.id };
          render();
        }));
      }
    } else if (elegido) {
      const p = F.parseExtremo(elegido);
      const punta = p?.tipo === 'c' ? d.puntas.find((x) => x.cable.id === p.id && x.lado === p.lado) : null;
      const enPaso = punta?.pasante && estadoFibra(d, punta, p.n) === 'paso';
      texto = `${etiquetaConLado(d, elegido)}: tocá la fibra o el puerto con que se une.`;
      if (enPaso) detalle = 'Está en paso: al unirla queda cortada acá.';
      items.push(boton('Cancelar', () => soltar()));
    } else if (foco?.tipo === 'mover-elegir') {
      const f = state().fusiones.get(foco.fusion);
      if (f) {
        texto = '¿Qué punta pasás a otra fibra o puerto?';
        detalle = 'La otra queda donde está.';
        items.push(
          boton(nombreCorto(d, f.a), () => empezarMover(f, 'a')),
          boton(nombreCorto(d, f.b), () => empezarMover(f, 'b')),
          boton('Cancelar', () => {
            foco = { tipo: 'union', fusion: f.id };
            render();
          }),
        );
      }
    } else if (foco?.tipo === 'union') {
      const f = state().fusiones.get(foco.fusion);
      if (f) {
        texto = `${etiquetaConLado(d, f.a)} ↔ ${etiquetaConLado(d, f.b)}`;
        detalle = `${f.tipo === 'conector' ? 'Conector' : 'Fusión'} · cargada por ${f.creado_por ?? '—'} el ${formatFecha(f.creado)}`
          + (f.modificado !== f.creado ? ` · movida por ${f.modificado_por ?? '—'} el ${formatFecha(f.modificado)}` : '');
        items.push(
          boton('Pasar a otra fibra', () => {
            foco = { tipo: 'mover-elegir', fusion: f.id };
            render();
          }),
          boton('Quitar unión', () => quitarUnion(f), { class: 'peligro' }),
          boton('Recorrido', () => acciones.verRecorrido(elementoId, foco.ext ?? f.a, { desdeCarta: true })),
          boton('Cerrar', () => soltar()),
        );
      }
    } else if (foco?.tipo === 'hecho') {
      const n = foco.pares.length;
      texto = n === 1 ? `Unidas: ${etiqueta(foco.pares[0][0])} ↔ ${etiqueta(foco.pares[0][1])}` : `Se unieron ${n} en orden.`;
      const siguientes = paresSiguientes(d, foco.pares[n - 1]);
      if (siguientes.length) {
        const [a, b] = siguientes[0];
        const [y, z] = siguientes[siguientes.length - 1];
        items.push(boton(siguientes.length === 1
          ? `Seguir: ${corto(a)}→${corto(b)}`
          : `Seguir en orden: ${corto(a)}→${corto(b)} … ${corto(y)}→${corto(z)} (${siguientes.length})`,
        () => unir(siguientes), { class: 'primario' }));
      }
      items.push(boton('Deshacer', () => deshacer(foco.ids)), boton('Listo', () => soltar()));
    } else if (foco?.tipo === 'acomodado') {
      texto = foco.texto;
      detalle = 'Queda así para todos.';
      items.push(
        boton('Deshacer', () => {
          const { inverso } = foco;
          foco = null;
          guardarDisposicion(inverso);
          toast('Se deshizo');
        }),
        boton('Listo', () => soltar()),
      );
    } else if (foco?.tipo === 'quitada') {
      texto = `Se quitó la unión ${etiqueta(foco.par[0])} ↔ ${etiqueta(foco.par[1])}.`;
      items.push(boton('Deshacer', () => unir([foco.par])), boton('Listo', () => soltar()));
    } else if (foco?.tipo === 'punta') {
      const p = d.puntas.find((x) => x.key === foco.key);
      if (p) {
        const props = p.cable.properties;
        const est = F.estructura(props);
        texto = `${props.nombre} · ${props.fibras} F · ${CABLES[props.tipo]?.label ?? props.tipo} · ${haciaTexto(p)}`;
        detalle = `${est.tubos > 1 ? `${est.tubos} tubos de ${est.porTubo}` : 'Un tubo'} · colores ${est.codigo.label}`
          + (p.pasante ? ' · el cable pasa por acá: las fibras sin unir siguen de largo' : '');
        items.push(...botonesOrden(d, p.key));
        if (d.libre) {
          items.push(boton('Dar vuelta', () => darVuelta(d, p), { title: 'Que las fibras miren para el otro lado' }));
        } else {
          items.push(boton(p.pasante ? 'Intercambiar izquierda y derecha' : (d.lados.get(p.key) === 'i' ? 'Pasar a la derecha' : 'Pasar a la izquierda'),
            () => moverPunta(d, p)));
        }
        items.push(
          boton('Ver el cable', () => acciones.verCableDesdeCarta(p.cable.id)),
          boton('Cerrar', () => soltar()),
        );
      }
    } else if (foco?.tipo === 'equipo') {
      const e = state().equipos.get(foco.id);
      if (e) {
        texto = `${e.nombre || 'Equipo'} · ${F.describirEquipo(e)}${e.datos?.conectores ? ' · salidas con conector' : ''}`;
        detalle = usoEquipo(d, e) + (e.notas ? ` · ${e.notas}` : '');
        if (foco.borrar) {
          const n = d.fusiones.filter((f) => f.a.startsWith(`q${e.id}:`) || f.b.startsWith(`q${e.id}:`)).length;
          texto = `¿Borrar ${e.nombre || 'el equipo'}?${n ? ` Se quitan también sus ${plural(n, 'unión', 'uniones')}.` : ''}`;
          detalle = '';
          items.push(boton('Sí, borrar', () => borrarEquipo(e), { class: 'peligro' }), boton('No', () => {
            foco = { tipo: 'equipo', id: e.id };
            renderPie();
          }));
        } else {
          items.push(
            ...botonesOrden(d, `q${e.id}`),
            boton('Editar', () => abrirForm(e.tipo, e)),
            boton('Borrar', () => {
              foco = { tipo: 'equipo', id: e.id, borrar: true };
              renderPie();
            }),
            boton('Cerrar', () => soltar()),
          );
        }
      }
    } else if (d.libre && (d.puntas.length || d.equipos.length)) {
      texto = 'Tocá una fibra o un puerto y después con qué se une.';
      detalle = 'Los cables y equipos se arrastran desde su nombre; el fondo, para moverte.';
    } else {
      texto = d.puntas.length || d.equipos.length
        ? 'Tocá una fibra o un puerto y después con qué se une.'
        : 'Cuando lleguen cables, sus fibras aparecen acá.';
    }
    // Con teclado, el foco sigue en el pie (en el mismo botón, si sigue estando).
    const enfocado = pie.contains(document.activeElement) ? document.activeElement.textContent : null;
    pie.replaceChildren(...[
      h('div.carta-pie-texto', {}, h('p', { text: texto }), detalle ? h('small', { text: detalle }) : null),
      items.length ? h('div.carta-pie-botones', {}, ...items) : null,
    ].filter(Boolean));
    if (enfocado !== null) {
      const disponibles = [...pie.querySelectorAll('button')].filter((b) => !b.disabled);
      (disponibles.find((b) => b.textContent === enfocado) ?? disponibles[0])?.focus({ preventScroll: true });
    }
  }

  function soltar() {
    elegido = null;
    foco = null;
    mover = null;
    render();
  }

  // ------------------------------------------------------------ toques

  function alTocar(event) {
    if (ignorarClick) return;
    const b = event.target.closest('button');
    if (!b || !cuerpo.contains(b) || ocupado || b.closest('.carta-zoom')) return;
    if (b.dataset.ext) {
      tocarExtremo(b.dataset.ext);
      return;
    }
    const accion = b.dataset.accion;
    if (accion === 'tubo') {
      const d = datos();
      const [cableId, t] = b.dataset.tubo.split(':').map(Number);
      const p = d?.puntas.find((x) => x.cable.id === cableId);
      if (!p) return;
      const est = F.estructura(p.cable.properties);
      abiertos.set(`${cableId}:${t}`, !tuboAbierto(d, p, t, est));
      render();
    } else if (accion === 'punta' || (b.dataset.asa && b.dataset.asa.startsWith('c'))) {
      const key = b.dataset.key ?? b.dataset.asa;
      elegido = null;
      mover = null;
      foco = foco?.tipo === 'punta' && foco.key === key && !b.dataset.asa ? null : { tipo: 'punta', key };
      render();
    } else if (accion === 'equipo' || b.dataset.asa) {
      const id = Number(b.dataset.id ?? b.dataset.asa.slice(1));
      elegido = null;
      mover = null;
      foco = foco?.tipo === 'equipo' && foco.id === id && !b.dataset.asa ? null : { tipo: 'equipo', id };
      render();
    }
  }

  function tocarExtremo(ext) {
    const d = datos();
    if (!d) return;
    if (mover) {
      const f = state().fusiones.get(mover.fusion);
      if (!f) {
        mover = null;
        render();
        return;
      }
      if (ext === f[mover.punta]) {
        // Tocar la misma punta: se queda donde estaba.
        mover = null;
        foco = { tipo: 'union', fusion: f.id };
        render();
        return;
      }
      if (d.usado.has(ext)) {
        toast('Esa ya está unida: elegí una fibra o un puerto libre.');
        return;
      }
      moverUnion(f, mover.punta, ext);
      return;
    }
    const f = d.usado.get(ext);
    if (f) {
      elegido = null;
      foco = foco?.tipo === 'union' && foco.fusion === f.id ? null : { tipo: 'union', fusion: f.id, ext };
      render();
      return;
    }
    if (elegido === ext) {
      soltar();
      return;
    }
    if (elegido) {
      unir([[elegido, ext]]);
      return;
    }
    elegido = ext;
    foco = null;
    render();
  }

  function empezarMover(f, punta) {
    mover = { fusion: f.id, punta };
    elegido = null;
    foco = null;
    render();
    // Que se vea la punta que se mueve.
    const movido = extremoMovido();
    const el = movido ? cuerpo.querySelector(`[data-ext="${movido}"]`) : null;
    if (el && visor) centrarEn(el);
    else el?.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------- arrastrar y la bandeja

  function alApoyar(ev) {
    if (vista !== 'diagrama' || ocupado || ev.target.closest('.carta-zoom')) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    if (cuerpo.classList.contains('libre')) {
      apoyarLibre(ev);
      return;
    }
    // En columnas se arrastra desde el asa (con el dedo, el resto de la carta se
    // desplaza); con el mouse, también desde el nombre. De a un arrastre por vez.
    if (gesto) return;
    const a = ev.target.closest('[data-asa]') ?? (ev.pointerType === 'mouse' ? ev.target.closest('.punta-cab, .equipo-cab') : null);
    const bloque = a?.closest('[data-bloque]');
    if (!bloque || !cuadro?.contains(bloque)) return;
    gesto = {
      tipo: 'columna', id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, movido: false,
      asa: a, bloque, key: bloque.dataset.bloque, scroll0: cuerpo.scrollTop,
    };
  }

  function apoyarLibre(ev) {
    if (!visor || !visor.contains(ev.target)) return;
    punteros.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (punteros.size === 2) {
      // Dos dedos: zoom (y desplazamiento) con el pellizco. Si el primero había
      // empezado a arrastrar un bloque, el bloque vuelve a su lugar.
      if (gesto?.tipo === 'bloque' && gesto.movido) soltarBloque(true);
      const [p1, p2] = [...punteros.values()];
      gesto = {
        tipo: 'pellizco', movido: true, d0: Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1,
        m0: medio([p1.x, p1.y], [p2.x, p2.y]), v0: { ...vistaActual() },
      };
      visor.classList.add('moviendo');
      return;
    }
    if (punteros.size > 1) return;
    const agarre = ev.target.closest('[data-asa], .punta-cab, .equipo-cab');
    const bloque = agarre?.closest('[data-bloque]');
    gesto = {
      tipo: bloque ? 'bloque' : 'bandeja', id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, movido: false,
      bloque, key: bloque?.dataset.bloque, v0: { ...vistaActual() },
    };
  }

  function alMover(ev) {
    if (!gesto) return;
    if (gesto.tipo === 'pellizco') {
      if (!punteros.has(ev.pointerId)) return;
      punteros.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (punteros.size < 2) return;
      const [p1, p2] = [...punteros.values()];
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
      const m = medio([p1.x, p1.y], [p2.x, p2.y]);
      const r = visor.getBoundingClientRect();
      const { v0 } = gesto;
      const z = limitar((v0.z * dist) / gesto.d0, ZOOM_MIN, ZOOM_MAX);
      // El punto de la bandeja que estaba entre los dedos sigue entre los dedos.
      const lx = (gesto.m0[0] - r.left - v0.tx) / v0.z;
      const ly = (gesto.m0[1] - r.top - v0.ty) / v0.z;
      aplicarVista({ z, tx: m[0] - r.left - lx * z, ty: m[1] - r.top - ly * z });
      return;
    }
    if (ev.pointerId !== gesto.id) return;
    if (punteros.has(ev.pointerId)) punteros.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    const dx = ev.clientX - gesto.x0;
    const dy = ev.clientY - gesto.y0;
    if (!gesto.movido) {
      if (Math.hypot(dx, dy) < UMBRAL) return;
      gesto.movido = true;
      empezarGesto(ev);
    }
    gesto.ultimo = { x: ev.clientX, y: ev.clientY };
    if (gesto.tipo === 'columna') pintarColumna();
    else if (gesto.tipo === 'bandeja') aplicarVista({ ...gesto.v0, tx: gesto.v0.tx + dx, ty: gesto.v0.ty + dy });
    else if (gesto.tipo === 'bloque') moverBloque(dx / gesto.v0.z, dy / gesto.v0.z);
  }

  function empezarGesto(ev) {
    try {
      (gesto.tipo === 'columna' ? gesto.asa : visor).setPointerCapture(ev.pointerId);
    } catch {
      // Sin captura igual funciona mientras el dedo siga sobre la carta.
    }
    if (gesto.tipo === 'columna') {
      gesto.bloque.classList.add('arrastrando');
      cuadro.classList.add('reordenando');
      gesto.hueco = h('div.carta-hueco', { 'aria-hidden': 'true' });
      cuadro.append(gesto.hueco);
      const g = gesto;
      requestAnimationFrame(() => desplazarSolo(g));
    } else if (gesto.tipo === 'bloque') {
      const b = bloques.get(gesto.key);
      if (!b) {
        gesto.tipo = 'bandeja';
        return;
      }
      gesto.b = b;
      gesto.bx = b.x;
      gesto.by = b.y;
      b.el.classList.add('arrastrando');
      lienzo.append(b.el); // al frente
      visor.classList.add('moviendo');
    } else {
      visor.classList.add('moviendo');
    }
  }

  function alSoltar(ev) {
    const eraPuntero = punteros.delete(ev.pointerId);
    if (!gesto) return;
    if (gesto.tipo === 'pellizco') {
      if (!eraPuntero) return;
      if (punteros.size === 0) {
        evitarClick();
        terminarGesto();
      }
      return;
    }
    if (ev.pointerId !== gesto.id) return;
    const cancelado = ev.type === 'pointercancel';
    if (gesto.movido) {
      evitarClick();
      if (gesto.tipo === 'columna') soltarColumna(cancelado);
      else if (gesto.tipo === 'bloque') soltarBloque(cancelado);
    }
    terminarGesto();
  }

  // El toque que termina un arrastre no es un toque.
  function evitarClick() {
    ignorarClick = true;
    setTimeout(() => { ignorarClick = false; }, 0);
  }

  function terminarGesto() {
    visor?.classList.remove('moviendo');
    gesto = null;
    if (rehacer) render();
    else pedirLineas();
  }

  // Si se pierde el puntero (otra ventana, una llamada), el arrastre vuelve atrás.
  function cancelarGesto() {
    if (!gesto) return;
    if (gesto.movido) {
      if (gesto.tipo === 'columna') soltarColumna(true);
      else if (gesto.tipo === 'bloque') soltarBloque(true);
    }
    punteros.clear();
    terminarGesto();
  }

  // Dónde caería el bloque que se arrastra en columnas: qué columna y antes de cuál.
  function destinoColumna() {
    const g = gesto;
    const esEquipo = g.key.startsWith('q');
    let col;
    if (esEquipo) col = 'm';
    else {
      const r = cuadro.getBoundingClientRect();
      col = g.ultimo.x < r.left + r.width / 2 ? 'i' : 'd';
    }
    const columna = cuadro.querySelector(`.carta-col[data-col="${col}"]`);
    const hijos = [...columna.children].filter((x) => x !== g.bloque && x.dataset.bloque);
    let indice = hijos.length;
    for (let i = 0; i < hijos.length; i += 1) {
      const r = hijos[i].getBoundingClientRect();
      if (g.ultimo.y < r.top + r.height / 2) {
        indice = i;
        break;
      }
    }
    return { col, indice, hijos, columna };
  }

  function pintarColumna() {
    const g = gesto;
    if (!g?.ultimo) return;
    const dx = g.ultimo.x - g.x0;
    const dy = g.ultimo.y - g.y0 + (cuerpo.scrollTop - g.scroll0);
    g.bloque.style.transform = `translate(${dx}px, ${dy}px)`;
    g.destino = destinoColumna();
    const base = cuadro.getBoundingClientRect();
    const rc = g.destino.columna.getBoundingClientRect();
    const { hijos, indice } = g.destino;
    let y;
    if (!hijos.length) y = rc.top + 2;
    else if (indice < hijos.length) y = hijos[indice].getBoundingClientRect().top - 8;
    else y = hijos[hijos.length - 1].getBoundingClientRect().bottom + 6;
    Object.assign(g.hueco.style, { left: `${rc.left - base.left}px`, width: `${rc.width}px`, top: `${y - base.top}px` });
  }

  // Cerca del borde de arriba o de abajo, la carta se desplaza sola.
  function desplazarSolo(g) {
    if (gesto !== g || !cuerpo) return;
    if (!g.ultimo) {
      requestAnimationFrame(() => desplazarSolo(g));
      return;
    }
    const r = cuerpo.getBoundingClientRect();
    const borde = 56;
    let v = 0;
    if (g.ultimo.y < r.top + borde) v = -Math.ceil((r.top + borde - g.ultimo.y) / 4);
    else if (g.ultimo.y > r.bottom - borde) v = Math.ceil((g.ultimo.y - (r.bottom - borde)) / 4);
    if (v) {
      const antes = cuerpo.scrollTop;
      cuerpo.scrollTop += v;
      if (cuerpo.scrollTop !== antes) pintarColumna();
    }
    requestAnimationFrame(() => desplazarSolo(g));
  }

  function soltarColumna(cancelado) {
    const g = gesto;
    g.bloque.classList.remove('arrastrando');
    g.bloque.style.transform = '';
    cuadro?.classList.remove('reordenando');
    g.hueco?.remove();
    if (cancelado || !g.destino) return;
    const d = datos();
    if (!d) return;
    const cols = columnasDe(d);
    for (const lista of Object.values(cols)) {
      const i = lista.indexOf(g.key);
      if (i >= 0) lista.splice(i, 1);
    }
    cols[g.destino.col].splice(Math.min(g.destino.indice, cols[g.destino.col].length), 0, g.key);
    const antes = columnasDe(d);
    const igual = ['i', 'm', 'd'].every((c) => antes[c].join('|') === cols[c].join('|'));
    if (igual) return; // quedó donde estaba
    const patch = { orden: [...cols.i, ...cols.m, ...cols.d] };
    if (g.key.startsWith('c') && d.lados.get(g.key) !== g.destino.col) patch.lados = ladosCon(d, { [g.key]: g.destino.col });
    ofrecerDeshacer(d, patch, `Moviste ${nombreBloque(g.key)}.`);
    guardarDisposicion(patch);
  }

  function moverBloque(dx, dy) {
    const g = gesto;
    if (!g.b) return;
    g.b.x = Math.round(g.bx + dx);
    g.b.y = Math.round(g.by + dy);
    g.b.el.style.left = `${g.b.x}px`;
    g.b.el.style.top = `${g.b.y}px`;
    moverLineas(g.key, g.b.x - g.bx, g.b.y - g.by);
  }

  function soltarBloque(cancelado) {
    const g = gesto;
    if (!g.b) return;
    g.b.el.classList.remove('arrastrando');
    if (cancelado) {
      g.b.x = g.bx;
      g.b.y = g.by;
      g.b.el.style.left = `${g.bx}px`;
      g.b.el.style.top = `${g.by}px`;
      rehacer = true;
      return;
    }
    if (g.b.x === g.bx && g.b.y === g.by) return;
    g.b.auto = false;
    guardarPos({ [g.key]: [g.b.x, g.b.y] }, { deshacer: `Moviste ${nombreBloque(g.key)}.` });
  }

  function alRueda(ev) {
    if (!visor || !visor.contains(ev.target)) return;
    ev.preventDefault();
    const v = vistaActual();
    const r = visor.getBoundingClientRect();
    const escala = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? r.height : 1;
    if (ev.ctrlKey || ev.metaKey) {
      zoomEn(Math.exp(-ev.deltaY * escala * 0.0022), ev.clientX - r.left, ev.clientY - r.top);
    } else {
      aplicarVista({ ...v, tx: v.tx - ev.deltaX * escala, ty: v.ty - ev.deltaY * escala });
    }
  }

  // Safari en la Mac manda el pellizco del panel táctil como gesture*, no como
  // rueda con Control. En el teléfono también los manda, junto con los punteros:
  // ahí el pellizco ya se maneja con los punteros y esto solo evita el zoom de la página.
  function alGestoSafari(ev) {
    if (!visor || !visor.contains(ev.target)) return;
    ev.preventDefault();
    if (punteros.size >= 2 || typeof ev.scale !== 'number') return;
    if (ev.type === 'gesturestart') {
      safari = { z0: vistaActual().z };
    } else if (ev.type === 'gesturechange' && safari) {
      const r = visor.getBoundingClientRect();
      const z = limitar(safari.z0 * ev.scale, ZOOM_MIN, ZOOM_MAX);
      zoomEn(z / vistaActual().z, (ev.clientX ?? r.left + r.width / 2) - r.left, (ev.clientY ?? r.top + r.height / 2) - r.top);
    } else if (ev.type === 'gestureend') {
      safari = null;
    }
  }

  function alTeclear(ev) {
    if (ocupado || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const a = ev.target.closest?.('[data-asa]');
    const flechas = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (a && flechas[ev.key]) {
      ev.preventDefault();
      const d = datos();
      if (!d) return;
      const key = a.dataset.asa;
      const [x, y] = flechas[ev.key];
      if (d.libre) {
        const b = bloques.get(key);
        if (!b) return;
        const paso = ev.shiftKey ? PASO_TECLA * 4 : PASO_TECLA;
        b.auto = false;
        guardarPos({ [key]: [Math.round(b.x + x * paso), Math.round(b.y + y * paso)] });
      } else if (y) {
        moverEnColumna(key, y);
      } else if (key.startsWith('c')) {
        pasarALado(key, x < 0 ? 'i' : 'd');
      }
      return;
    }
    if (ev.target !== visor) return;
    if (ev.key === '+' || ev.key === '=') zoomEn(1.25);
    else if (ev.key === '-' || ev.key === '_') zoomEn(1 / 1.25);
    else if (ev.key === '0') ajustarVista();
    else if (flechas[ev.key]) {
      const v = vistaActual();
      const [x, y] = flechas[ev.key];
      aplicarVista({ ...v, tx: v.tx - x * 60, ty: v.ty - y * 60 });
    } else return;
    ev.preventDefault();
  }

  function moverEnColumna(key, delta) {
    const d = datos();
    if (!d) return;
    const cols = columnasDe(d);
    const lista = Object.values(cols).find((c) => c.includes(key));
    if (!lista) return;
    const i = lista.indexOf(key);
    const j = i + delta;
    if (j < 0 || j >= lista.length) return;
    [lista[i], lista[j]] = [lista[j], lista[i]];
    guardarDisposicion({ orden: [...cols.i, ...cols.m, ...cols.d] });
  }

  function pasarALado(key, lado) {
    const d = datos();
    if (!d || d.lados.get(key) === lado) return;
    const cols = columnasDe(d);
    const desde = cols[d.lados.get(key) === 'i' ? 'i' : 'd'];
    const i = desde.indexOf(key);
    desde.splice(i, 1);
    cols[lado].splice(Math.min(i, cols[lado].length), 0, key);
    guardarDisposicion({ orden: [...cols.i, ...cols.m, ...cols.d], lados: ladosCon(d, { [key]: lado }) });
  }

  // ---------------------------------------------------- disposición guardada

  // Acomodar no traba la carta: se ve enseguida y se guarda un momento después
  // (varios movimientos seguidos van juntos). Si no se puede guardar, vuelve a
  // como estaba y se avisa.
  function sumar(viejo, nuevo) {
    if (!viejo) return nuevo;
    const out = { ...viejo, ...nuevo };
    if (viejo.pos && nuevo.pos) out.pos = { ...viejo.pos, ...nuevo.pos };
    return out;
  }

  function guardarDisposicion(patch, { redibujar = true } = {}) {
    const id = elementoId;
    if (id === null) return;
    const p = pendientes.get(id) ?? { patch: null, enviando: null, timer: 0, red: red.state.red };
    p.patch = sumar(p.patch, patch);
    pendientes.set(id, p);
    clearTimeout(p.timer);
    p.timer = setTimeout(() => enviarDisposicion(id), 350);
    if (redibujar) render();
  }

  async function enviarDisposicion(id) {
    const p = pendientes.get(id);
    if (!p || p.enviando || !p.patch) return;
    if (red.state.red !== p.red) {
      pendientes.delete(id);
      return;
    }
    p.enviando = p.patch;
    p.patch = null;
    try {
      const res = await api(`api/elementos/${id}`, { method: 'PUT', body: { carta: p.enviando } });
      if (red.state.red === p.red) {
        silencio += 1;
        try {
          red.aplicar(res);
        } finally {
          silencio -= 1;
        }
      }
    } catch (err) {
      if (red.state.red === p.red) {
        if (err.status === 404) red.recargar().catch(() => {});
        else toast(`No se guardó cómo acomodaste la carta: ${err.message}`);
      }
    } finally {
      p.enviando = null;
      if (p.patch) p.timer = setTimeout(() => enviarDisposicion(id), 0);
      else pendientes.delete(id);
      if (abierta() && elementoId === id) render();
    }
  }

  // ---------------------------------------------------------- acciones

  // Corre una escritura: la carta muestra "Guardando…" y se redibuja una vez al
  // final. Si mientras tanto se cambió de red, la respuesta se descarta; si se
  // cerró la carta o se abrió otra, el dato se guarda pero no se toca lo que se ve.
  async function escribir(pedido, listo = () => {}) {
    if (ocupado) return;
    const mia = apertura;
    const redId = red.state.red;
    ocupado = true;
    propio = true;
    renderPie();
    try {
      const res = await pedido();
      if (red.state.red !== redId) return;
      red.aplicar(res);
      if (mia === apertura) listo(res);
    } catch (err) {
      if (red.state.red !== redId) return;
      if (err.status === 409 && err.data?.fusiones?.length && typeof err.data.fusiones[0] === 'object') {
        red.aplicar({ fusiones: err.data.fusiones });
      }
      if (err.status === 409 && (err.data?.recargar || err.data?.actual)) red.recargar().catch(() => {});
      if (err.status === 404) red.recargar().catch(() => {});
      if (mia !== apertura) return;
      elegido = null;
      mover = null;
      foco = { tipo: 'error', mensaje: err.message };
    } finally {
      ocupado = false;
      propio = false;
      if (abierta()) render();
    }
  }

  function unir(pares) {
    const elemento = elementoId;
    elegido = null; // lo elegido ya se usó: mientras se guarda, Escape cierra la carta
    return escribir(
      () => api('api/fusiones', { method: 'POST', body: { elemento, pares: pares.map(([a, b]) => ({ a, b })) } }),
      (res) => {
        elegido = null;
        foco = { tipo: 'hecho', ids: res.fusiones.map((f) => f.id), pares };
      },
    );
  }

  // Pasa una punta de una unión a otra fibra o puerto, sin quitarla.
  function moverUnion(f, punta, ext) {
    const antes = f[punta];
    return escribir(
      () => api(`api/fusiones/${f.id}`, { method: 'PUT', body: { [punta]: ext, version: f.version } }),
      () => {
        mover = null;
        foco = { tipo: 'union', fusion: f.id, ext };
        toast(`La unión pasó de ${corto(antes)} a ${corto(ext)}`);
      },
    );
  }

  function deshacer(ids) {
    return escribir(
      () => api('api/fusiones/borrar', { method: 'POST', body: { ids } }),
      () => {
        foco = null;
        toast(ids.length === 1 ? 'Se deshizo la unión' : `Se deshicieron ${ids.length} uniones`);
      },
    );
  }

  function quitarUnion(f) {
    return escribir(
      () => api(`api/fusiones/${f.id}?version=${f.version}`, { method: 'DELETE' }),
      () => { foco = { tipo: 'quitada', par: [f.a, f.b] }; },
    );
  }

  function borrarEquipo(e) {
    return escribir(
      () => api(`api/equipos/${e.id}?version=${e.version}`, { method: 'DELETE' }),
      () => {
        foco = null;
        toast(`${e.nombre || 'Equipo'} borrado`);
      },
    );
  }

  // De qué lado se dibuja un cable (columnas): se guarda en el elemento para todos.
  function moverPunta(d, p) {
    const actual = d.lados.get(p.key);
    const cambios = { [p.key]: actual === 'i' ? 'd' : 'i' };
    if (p.pasante) {
      const par = d.puntas.find((x) => x.cable.id === p.cable.id && x.key !== p.key);
      if (par) cambios[par.key] = actual === 'i' ? 'i' : 'd';
    }
    foco = { tipo: 'punta', key: p.key };
    guardarDisposicion({ lados: ladosCon(d, cambios) });
  }

  // Modo libre: las fibras del bloque pasan a mirar para el otro lado.
  function darVuelta(d, p) {
    foco = { tipo: 'punta', key: p.key };
    guardarDisposicion({ lados: ladosCon(d, { [p.key]: d.lados.get(p.key) === 'i' ? 'd' : 'i' }) });
  }

  // Pega a este elemento la punta suelta de un cable que termina cerca.
  function pegar(c) {
    const props = c.cable.properties;
    const coords = c.cable.geometry.coordinates.map((x) => x.slice());
    const nodos = (props.nodos ?? []).slice();
    const destinoNombre = state().elementos.get(elementoId).properties.nombre;
    coords[c.indice] = state().elementos.get(elementoId).geometry.coordinates.slice();
    nodos[c.indice] = elementoId;
    return escribir(
      () => api(`api/cables/${c.cable.id}`, { method: 'PUT', body: { coords, nodos, version: props.version } }),
      () => {
        foco = null;
        toast(`${props.nombre} quedó pegado a ${destinoNombre}`);
      },
    );
  }

  // ------------------------------------------------- splitters y OLT

  const RELACIONES_FBT = ['1/99', '2/98', '3/97', '5/95', '10/90', '15/85', '20/80', '25/75', '30/70', '35/65', '40/60', '45/55', '50/50'];
  const PLC = ['1x2', '1x4', '1x8', '1x16', '1x32', '1x64', '1x128', '2x2', '2x4', '2x8', '2x16', '2x32', '2x64', '2x128'];

  function abrirForm(tipo, equipo = null) {
    const d = datos();
    if (!d || ocupado) return;
    elegido = null;
    mover = null;
    foco = { tipo: 'form' };
    const datosEq = equipo?.datos ?? {};
    const nombres = [...state().equipos.values()].filter((e) => e.tipo === tipo).map((e) => e.nombre);
    const nombre = h('input', { type: 'text', name: 'nombre', maxlength: 80, autocomplete: 'off',
      value: equipo ? equipo.nombre : sugerirNombre(tipo === 'olt' ? 'OLT' : 'SPL', nombres) });
    const campo = (label, input) => h('label.campo', {}, h('span', { text: label }), input);
    const notas = h('input', { type: 'text', name: 'notas', maxlength: 2000, autocomplete: 'off', value: equipo?.notas ?? '',
      placeholder: 'Marca, bandeja, lo que haga falta' });
    let campos;
    let leer;
    if (tipo === 'olt') {
      const puertos = h('input', { type: 'text', inputmode: 'numeric', name: 'salidas', autocomplete: 'off',
        value: String(equipo?.salidas ?? (Number(d.elemento.properties.datos?.puertos_pon) || 16)) });
      const potencia = h('input', { type: 'text', name: 'potencia', autocomplete: 'off', placeholder: '4,5',
        value: datosEq.potencia !== undefined ? String(datosEq.potencia).replace('.', ',') : '' });
      campos = [campo('Nombre', nombre), campo('Puertos PON', puertos), campo('Potencia de salida (dBm)', potencia), campo('Notas', notas)];
      leer = () => {
        const salidas = Number(puertos.value.trim());
        if (!Number.isInteger(salidas) || salidas < 1 || salidas > 256) throw new Error('Puertos PON: de 1 a 256.');
        const datosNuevos = {};
        const pot = potencia.value.trim().replace(',', '.');
        if (pot) {
          const v = Number(pot);
          if (!Number.isFinite(v) || v < -10 || v > 15) throw new Error('Potencia: de -10 a 15 dBm.');
          datosNuevos.potencia = v;
        }
        return { tipo: 'olt', nombre: nombre.value.trim(), entradas: 0, salidas, datos: datosNuevos, notas: notas.value.trim() };
      };
    } else {
      const modo = h('select', { name: 'modo' },
        h('option', { value: 'plc', text: 'PLC (balanceado)', selected: datosEq.modo !== 'fbt' }),
        h('option', { value: 'fbt', text: 'Desbalanceado (FBT)', selected: datosEq.modo === 'fbt' }));
      const relacion = h('select', { name: 'relacion' });
      const rotulo = h('span', { text: 'Salidas' });
      const pintarRelaciones = () => {
        const fbt = modo.value === 'fbt';
        const actual = equipo && (datosEq.modo === 'fbt') === fbt
          ? (fbt ? datosEq.relacion : `${equipo.entradas}x${equipo.salidas}`)
          : (fbt ? '10/90' : '1x8');
        // Un tamaño cargado de otra forma (que no está en la lista) no se pierde al editar.
        const opciones = (fbt ? RELACIONES_FBT : PLC).slice();
        if (actual && !opciones.includes(actual)) opciones.push(actual);
        rotulo.textContent = fbt ? 'Relación de potencia' : 'Entradas x salidas';
        relacion.replaceChildren(...opciones.map((o) => h('option', { value: o, text: fbt ? `${o.replace('/', ' / ')} %` : o, selected: o === actual })));
      };
      pintarRelaciones();
      modo.addEventListener('change', pintarRelaciones);
      const conectores = h('input', { type: 'checkbox', name: 'conectores',
        checked: equipo ? Boolean(datosEq.conectores) : d.elemento.properties.tipo === 'nap' });
      campos = [
        campo('Nombre', nombre),
        campo('Tipo', modo),
        h('label.campo', {}, rotulo, relacion),
        h('label.check-campo', {}, conectores, h('span', { text: 'Salidas con conector (no fusionadas)' })),
        campo('Notas', notas),
      ];
      leer = () => {
        const datosNuevos = { modo: modo.value };
        let entradas = 1;
        let salidas = 2;
        if (modo.value === 'fbt') {
          datosNuevos.relacion = relacion.value;
        } else {
          [entradas, salidas] = relacion.value.split('x').map(Number);
        }
        if (conectores.checked) datosNuevos.conectores = true;
        return { tipo: 'splitter', nombre: nombre.value.trim(), entradas, salidas, datos: datosNuevos, notas: notas.value.trim() };
      };
    }
    const error = h('p.ficha-error', { role: 'alert', hidden: true });
    const form = h('form.carta-form', { autocomplete: 'off', novalidate: true },
      h('p.carta-form-titulo', {}, h('strong', { text: equipo ? `Editar ${equipo.nombre || 'equipo'}` : (tipo === 'olt' ? 'OLT nueva' : 'Splitter nuevo') })),
      error,
      h('div.carta-form-campos', {}, ...campos),
      h('div.carta-pie-botones', {},
        boton(equipo ? 'Guardar' : 'Agregar', null, { type: 'submit', class: 'primario' }),
        boton('Cancelar', () => soltar())),
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (ocupado) return;
      let cuerpoPedido;
      try {
        cuerpoPedido = leer();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        return;
      }
      const mia = apertura;
      const redId = red.state.red;
      const elemento = elementoId;
      ocupado = true; // mientras se guarda, tocar fibras no hace nada
      for (const el of form.elements) el.disabled = true;
      try {
        const res = equipo
          ? await api(`api/equipos/${equipo.id}`, { method: 'PUT', body: { ...cuerpoPedido, version: equipo.version } })
          : await api('api/equipos', { method: 'POST', body: { ...cuerpoPedido, elemento } });
        if (red.state.red !== redId) return;
        propio = true;
        red.aplicar(res);
        propio = false;
        if (mia !== apertura) return;
        ocupado = false;
        foco = { tipo: 'equipo', id: res.equipos[0].id };
        render();
        toast(equipo ? `${res.equipos[0].nombre || 'Equipo'} guardado` : `${res.equipos[0].nombre || 'Equipo'} agregado`);
      } catch (err) {
        propio = false;
        if (red.state.red !== redId || mia !== apertura) return;
        if (err.status === 409 && err.data?.actual) red.aplicar({ equipos: [err.data.actual] });
        if (!form.isConnected) {
          ocupado = false;
          foco = { tipo: 'error', mensaje: err.message };
          renderPie();
          return;
        }
        for (const el of form.elements) el.disabled = false;
        error.textContent = err.message;
        error.hidden = false;
      } finally {
        ocupado = false;
      }
    });
    pie.replaceChildren(form);
    render();
    nombre.focus({ preventScroll: true });
    nombre.select();
  }

  // ------------------------------------------------- abrir y cerrar

  function abrir(id, { ext = null } = {}) {
    if (elementoId !== id) {
      abiertos.clear();
      vista = 'diagrama';
    }
    elementoId = id;
    elegido = null;
    foco = null;
    mover = null;
    gesto = null;
    rehacer = false;
    punteros.clear();
    apertura += 1;
    ultimaFirma = '';
    armar();
    soltarLibre();
    root.hidden = false;
    document.body.classList.add('con-carta');
    render();
    // Al volver de un recorrido, se ve el extremo de donde se partió.
    if (ext) {
      const el = cuerpo.querySelector(`[data-ext="${ext}"]`);
      if (el && visor) centrarEn(el);
      else el?.scrollIntoView({ block: 'center' });
    }
    cab.querySelector('.ficha-cerrar')?.focus({ preventScroll: true });
  }

  function cerrar({ aviso = null, silencioso = false } = {}) {
    if (root.hidden) return;
    const id = elementoId;
    // Lo acomodado que esperaba para guardarse se manda ya.
    const pendiente = pendientes.get(id);
    if (pendiente?.patch) {
      clearTimeout(pendiente.timer);
      enviarDisposicion(id);
    }
    apertura += 1;
    root.hidden = true;
    root.replaceChildren();
    observador?.disconnect();
    document.body.classList.remove('con-carta');
    cuadro = null;
    soltarLibre();
    lineas = null;
    gesto = null;
    punteros.clear();
    elementoId = null;
    elegido = null;
    foco = null;
    mover = null;
    if (!silencioso) acciones.alCerrarCarta(id, aviso);
  }

  // Cambios de otros (o respuestas propias) mientras está abierta.
  red.on('datos', () => {
    if (!abierta() || propio || silencio) return;
    if (!state().elementos.has(elementoId)) {
      cerrar({ aviso: 'El elemento ya no existe: lo borró otro usuario.' });
      return;
    }
    const d = datos();
    if (d && firma(d) === ultimaFirma) return;
    render();
  });

  document.addEventListener('keydown', () => { teclaReciente = performance.now(); }, true);

  document.addEventListener('keydown', (event) => {
    if (!abierta() || event.key !== 'Escape') return;
    event.preventDefault();
    // El Escape es de la carta: que no lo vea también la ficha que vuelve al cerrarla.
    event.stopImmediatePropagation();
    if (foco || elegido || mover) soltar();
    else cerrar();
  });

  window.addEventListener('resize', () => {
    if (abierta()) pedirLineas();
  });

  // El movimiento y el final de un arrastre se escuchan en toda la ventana: el
  // dedo puede soltarse fuera de la carta.
  window.addEventListener('pointermove', alMover);
  window.addEventListener('pointerup', alSoltar);
  window.addEventListener('pointercancel', alSoltar);
  window.addEventListener('blur', cancelarGesto);

  return { abrir, cerrar, abierta, elemento: () => elementoId };
}
