// La carta de empalme de un elemento (botella, caja, NAP o nodo): los cables
// que llegan, con sus tubos y fibras en colores; los splitters y la OLT; y las
// uniones entre todo eso, dibujadas como líneas. Se une tocando un extremo y
// después el otro. También se ve como lista y se copia como texto.

import { api } from './api.js';
import { CABLES, ELEMENTOS, formatFecha, formatLargo, sugerirNombre } from './modelo.js';
import * as F from './fibras.js';

const SVG = 'http://www.w3.org/2000/svg';
const RADIO_PEGAR_M = 25; // cables que terminan así de cerca, sin pegar, se ofrecen para pegar

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

const boton = (text, onclick, extra = {}) => h('button', { type: 'button', text, onclick, ...extra });
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

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

export function setupCarta({ root, red, acciones, toast }) {
  let elementoId = null;
  let vista = 'diagrama';
  let elegido = null; // extremo elegido para unir
  let foco = null; // qué muestra el pie: union, hecho, quitada, punta, equipo, form, error
  const abiertos = new Map(); // `${cable}:${tubo}` -> desplegado (lo que tocó el usuario)
  let ocupado = false;
  let propio = false; // un cambio propio en curso: la carta se redibuja al terminar
  let apertura = 0; // sube cada vez que se abre o se cierra: una respuesta tardía no toca otra carta
  let ultimaFirma = '';
  let cab = null;
  let cuerpo = null;
  let pie = null;
  let cuadro = null; // .carta-diagrama, para las líneas
  let lineasPendientes = 0;
  // Las líneas se recalculan si cambia el tamaño (girar el teléfono, abrir un tubo).
  const observador = 'ResizeObserver' in window ? new ResizeObserver(() => pedirLineas()) : null;

  const state = () => red.state;
  const abierta = () => !root.hidden && elementoId !== null;

  // ------------------------------------------------------------ datos

  function datos() {
    const s = state();
    const elemento = s.elementos.get(elementoId);
    if (!elemento) return null;
    const { puntas, rotos, repetidos } = F.puntas(s, elementoId);
    const idx = F.indice(s);
    const fusiones = idx.fusionesEn.get(elementoId) ?? [];
    const equipos = idx.equiposEn.get(elementoId) ?? [];
    const usado = new Map();
    for (const f of fusiones) {
      usado.set(f.a, f);
      usado.set(f.b, f);
    }
    return { s, elemento, puntas, rotos, repetidos, lados: F.ladosDeCarta(s, elemento, puntas), fusiones, equipos, usado };
  }

  const otro = (lado) => (lado === 'a' ? 'b' : 'a');

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
    for (let n = desde; n <= hasta; n += 1) {
      for (const lado of ['a', 'b']) {
        const ext = F.extremoCable(p.cable.id, lado, n);
        if (d.usado.has(ext) || ext === elegido) return true;
      }
    }
    return false;
  }

  // Lo que muestra la carta, resumido: si un cambio de la red no lo toca, no se rehace.
  function firma(d) {
    const partes = [`e${d.elemento.properties.version}`];
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

  // ------------------------------------------------------------ armado

  function armar() {
    root.replaceChildren();
    cab = h('header.carta-cab');
    cuerpo = h('div.carta-cuerpo', { tabindex: '-1' });
    pie = h('footer.carta-pie', { 'aria-live': 'polite' });
    const panel = h('div.carta-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'carta-titulo' }, cab, cuerpo, pie);
    root.append(panel);
    cuerpo.addEventListener('click', alTocar);
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
    const herr = h('div.carta-herr', {},
      boton('Agregar splitter', () => abrirForm('splitter')),
      d.elemento.properties.tipo === 'nodo' ? boton('Agregar OLT', () => abrirForm('olt')) : null,
      boton(vista === 'lista' ? 'Ver diagrama' : 'Ver lista', () => {
        vista = vista === 'lista' ? 'diagrama' : 'lista';
        if (foco?.tipo !== 'form') {
          elegido = null;
          foco = null;
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
    const d = datos();
    if (!d) {
      cerrar({ aviso: 'El elemento ya no existe: lo borró otro usuario.' });
      return;
    }
    // Lo elegido o enfocado que ya no vale (lo cambió otro) se suelta.
    if (elegido && !libre(d, elegido)) elegido = null;
    if (foco?.tipo === 'union' && !d.fusiones.some((f) => f.id === foco.fusion)) foco = null;
    if (foco?.tipo === 'equipo' && !d.equipos.some((e) => e.id === foco.id)) foco = null;
    if (foco?.tipo === 'punta' && !d.puntas.some((p) => p.key === foco.key)) foco = null;
    // Con teclado, el foco vuelve al mismo botón después de rehacer la carta.
    const activo = cuerpo.contains(document.activeElement) ? document.activeElement : null;
    const selector = activo?.dataset.ext ? `[data-ext="${activo.dataset.ext}"]`
      : activo?.dataset.tubo ? `[data-tubo="${activo.dataset.tubo}"]`
        : activo?.dataset.key ? `[data-key="${activo.dataset.key}"]`
          : activo?.dataset.id ? `[data-accion="equipo"][data-id="${activo.dataset.id}"]` : null;
    renderCab(d);
    const scroll = cuerpo.scrollTop;
    cuerpo.replaceChildren(...(vista === 'lista' ? lista(d) : diagrama(d)));
    cuerpo.scrollTop = scroll;
    if (selector) cuerpo.querySelector(selector)?.focus({ preventScroll: true });
    if (foco?.tipo !== 'form') renderPie(d);
    ultimaFirma = firma(d);
    pedirLineas();
  }

  // ---------------------------------------------------------- diagrama

  function diagrama(d) {
    const out = [];
    if (d.rotos.length) {
      const nombres = d.rotos.map((c) => c.properties.nombre || 'Un cable').join(', ');
      out.push(h('p.carta-aviso', { text: `${nombres} empieza${d.rotos.length > 1 ? 'n' : ''} y termina${d.rotos.length > 1 ? 'n' : ''} acá: así la carta no sabe qué fibra es de qué lado. Dibujalo como dos cables que terminen en este elemento.` }));
    }
    if (d.repetidos.length) {
      const nombres = d.repetidos.map((c) => c.properties.nombre || 'Un cable').join(', ');
      out.push(h('p.carta-aviso', { text: `${nombres} pasa${d.repetidos.length > 1 ? 'n' : ''} más de una vez por acá: la carta toma la primera entrada y la última salida. Conviene dibujarlo como dos cables.` }));
    }
    if (!d.puntas.length && !d.equipos.length) {
      out.push(h('div.carta-vacia', {},
        h('p', {}, h('strong', { text: 'Todavía no llega ningún cable.' })),
        h('p', { text: `Dibujá un cable que empiece, termine o pase por ${d.elemento.properties.nombre} (tocando el elemento, el cable queda pegado) y acá vas a ver sus fibras para unirlas.` })));
    } else {
      const izq = d.puntas.filter((p) => d.lados.get(p.key) === 'i');
      const der = d.puntas.filter((p) => d.lados.get(p.key) !== 'i');
      cuadro = h(`div.carta-diagrama${d.equipos.length ? '.con-equipos' : ''}`, {},
        document.createElementNS(SVG, 'svg'),
        h('div.carta-col', { 'data-col': 'i' }, ...izq.map((p) => bloquePunta(d, p))),
        h('div.carta-col.carta-medio', { 'data-col': 'm' }, ...d.equipos.map((e) => bloqueEquipo(d, e))),
        h('div.carta-col', { 'data-col': 'd' }, ...der.map((p) => bloquePunta(d, p))),
      );
      cuadro.firstChild.setAttribute('class', 'carta-lineas');
      cuadro.firstChild.setAttribute('aria-hidden', 'true');
      out.push(cuadro);
    }
    const cerca = cercanos(d);
    if (cerca.length) out.push(bloqueCercanos(d, cerca));
    return out;
  }

  function bloquePunta(d, p) {
    const props = p.cable.properties;
    const est = F.estructura(props);
    const tipo = CABLES[props.tipo];
    const marcado = foco?.tipo === 'punta' && foco.key === p.key;
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
        filas.push(h('li', {}, h(`button.fibra.${estado}${ext === elegido ? '.elegida' : ''}`, {
          type: 'button',
          'data-ext': ext,
          'aria-label': `Fibra ${n}, ${F.nombreColor(info.color)}${est.tubos > 1 ? `, tubo ${t} ${F.nombreColor(colorTubo)}` : ''}: ${nota}`,
          'aria-pressed': ext === elegido ? 'true' : null,
        }, h('span.num', { text: String(n) }), h('span.color-nombre', { text: F.nombreColor(info.color) }), punto(info.color))));
      }
      const resumen = [
        cuenta.unida && `${cuenta.unida} unida${cuenta.unida > 1 ? 's' : ''}`,
        cuenta.paso && `${cuenta.paso} en paso`,
        cuenta.cortada && `${cuenta.cortada} cortada${cuenta.cortada > 1 ? 's' : ''}`,
        cuenta.libre && `${cuenta.libre} libre${cuenta.libre > 1 ? 's' : ''}`,
      ].filter(Boolean).join(' · ');
      const cabTubo = est.tubos > 1
        ? h('button.tubo-cab', { type: 'button', 'data-accion': 'tubo', 'data-tubo': `${p.cable.id}:${t}`, 'aria-expanded': String(abierto) },
          h(`span.tubo-color${colorTubo.marcas ? '.punto-marca' : ''}`, { style: `--c:${colorTubo.hex};--m:${colorTubo.marca}` }),
          h('span.tubo-nombre', { text: `T${t} ${F.nombreColor(colorTubo)}` }),
          h('small', { text: resumen }),
          h('span.ancla', { 'data-ancla': `${p.cable.id}:${p.lado}:${t}` }))
        : null;
      tubos.push(h(`div.tubo${abierto ? '' : '.plegado'}`, { style: `--c:${colorTubo.hex}` },
        cabTubo,
        abierto ? h('ul.fibras', {}, ...filas) : null));
    }
    const sub = [`${props.fibras} F`, tipo?.label ?? props.tipo];
    if (est.tubos > 1) sub.push(`${est.tubos} tubos de ${est.porTubo}`);
    return h(`section.punta${marcado ? '.marcada' : ''}`, { 'data-punta': p.key, style: `--tipo:${tipo?.color ?? '#555'}` },
      h('button.punta-cab', { type: 'button', 'data-accion': 'punta', 'data-key': p.key },
        h('strong', { text: props.nombre || 'Cable' }),
        h('span', { text: sub.join(' · ') }),
        h('small', { text: `${p.pasante ? 'pasa · ' : ''}${haciaTexto(p)}` })),
      ...tubos);
  }

  function bloqueEquipo(d, eq) {
    const marcado = foco?.tipo === 'equipo' && foco.id === eq.id;
    const puerto = (lado, n) => {
      const ext = F.extremoEquipo(eq.id, lado, n);
      const f = d.usado.get(ext);
      const estado = f ? 'unida' : 'libre';
      let detalle = '';
      if (f && lado === 's' && eq.tipo !== 'olt') {
        const fin = F.destino(state(), elementoId, ext);
        if (fin?.motivo === 'cliente') detalle = state().elementos.get(fin.elemento)?.properties.nombre ?? '';
      }
      const texto = eq.tipo === 'olt' ? `PON ${n}` : lado === 'e' ? (eq.entradas > 1 ? `E${n}` : 'E') : String(n);
      return h(`button.puerto.${estado}${ext === elegido ? '.elegida' : ''}`, {
        type: 'button',
        'data-ext': ext,
        title: detalle ? `${F.etiquetaPuerto(eq, lado, n)}: ${detalle}` : F.etiquetaPuerto(eq, lado, n),
        'aria-label': `${F.etiquetaPuerto(eq, lado, n)}: ${f ? `unida con ${etiqueta(f.a === ext ? f.b : f.a)}` : 'libre'}`,
        'aria-pressed': ext === elegido ? 'true' : null,
      }, punto(null), h('span.puerto-num', { text: texto }), detalle ? h('small', { text: detalle }) : null);
    };
    const entradas = [];
    for (let n = 1; n <= eq.entradas; n += 1) entradas.push(puerto('e', n));
    const salidas = [];
    for (let n = 1; n <= eq.salidas; n += 1) salidas.push(puerto('s', n));
    return h(`section.equipo${marcado ? '.marcada' : ''}`, { 'data-equipo': String(eq.id) },
      h('button.equipo-cab', { type: 'button', 'data-accion': 'equipo', 'data-id': String(eq.id) },
        h('strong', { text: eq.nombre || (eq.tipo === 'olt' ? 'OLT' : 'Splitter') }),
        h('small', { text: eq.tipo === 'olt' ? `OLT · ${F.describirEquipo(eq)}` : F.describirEquipo(eq) })),
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

  // ------------------------------------------------------------ líneas

  function pedirLineas() {
    if (lineasPendientes) return;
    lineasPendientes = requestAnimationFrame(() => {
      lineasPendientes = 0;
      dibujarLineas();
    });
  }

  function dibujarLineas() {
    if (!abierta() || vista !== 'diagrama' || !cuadro?.isConnected) return;
    const d = datos();
    if (!d) return;
    const svg = cuadro.querySelector('svg.carta-lineas');
    // El tamaño va en línea (la regla general de los íconos SVG fija 20 px) y se
    // achica antes de medir: si no, el propio dibujo no deja que el cuadro se achique.
    svg.style.width = '0px';
    svg.style.height = '0px';
    svg.style.width = `${cuadro.scrollWidth}px`;
    svg.style.height = `${cuadro.scrollHeight}px`;
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
      const col = el.closest('[data-col]')?.dataset.col;
      let mira = col === 'i' ? 1 : -1;
      if (col === 'm') mira = el.closest('.equipo-salidas') ? 1 : -1;
      const out = { x: r.left + r.width / 2 - base.left, y: r.top + r.height / 2 - base.top, mira };
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
    const trazos = document.createDocumentFragment();
    const curva = (a, b, clase, color) => {
      const dx = Math.max(26, Math.min(150, Math.abs(b.x - a.x) * 0.45));
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', `M${a.x},${a.y} C${a.x + a.mira * dx},${a.y} ${b.x + b.mira * dx},${b.y} ${b.x},${b.y}`);
      path.setAttribute('class', clase);
      if (color) path.style.setProperty('--c', color);
      trazos.append(path);
    };
    // Fibras en paso: de un lado al otro del mismo cable.
    const pasantes = new Map();
    for (const p of d.puntas) if (p.pasante) pasantes.set(p.cable.id, p);
    for (const [cableId, p] of pasantes) {
      const props = p.cable.properties;
      const est = F.estructura(props);
      for (let t = 1; t <= est.tubos; t += 1) {
        const desde = (t - 1) * est.porTubo + 1;
        const hasta = Math.min(t * est.porTubo, est.fibras);
        if (!tuboAbierto(d, p, t, est)) {
          const a = anclas.get(`${cableId}:a:${t}`);
          const b = anclas.get(`${cableId}:b:${t}`);
          let alguna = false;
          for (let n = desde; n <= hasta && !alguna; n += 1) alguna = estadoFibra(d, p, n) === 'paso';
          if (a && b && alguna) curva(posicion(a), posicion(b), 'linea-banda', est.codigo.tubo(t).hex);
          continue;
        }
        for (let n = desde; n <= hasta; n += 1) {
          if (estadoFibra(d, p, n) !== 'paso') continue;
          const a = lugar(F.extremoCable(cableId, 'a', n));
          const b = lugar(F.extremoCable(cableId, 'b', n));
          if (a && b) curva(a, b, 'linea-paso', F.infoFibra(props, n).color.hex);
        }
      }
    }
    // Uniones.
    for (const f of d.fusiones) {
      const a = lugar(f.a);
      const b = lugar(f.b);
      if (!a || !b) continue;
      const pa = F.parseExtremo(f.a);
      const pb = F.parseExtremo(f.b);
      const deCable = pa?.tipo === 'c' ? pa : pb?.tipo === 'c' ? pb : null;
      const cable = deCable ? state().cables.get(deCable.id) : null;
      const color = cable ? F.infoFibra(cable.properties, deCable.n).color.hex : null;
      const marcada = foco?.tipo === 'union' && foco.fusion === f.id;
      curva(a, b, `linea-fondo${marcada ? ' marcada' : ''}`);
      curva(a, b, `linea-union${color ? '' : ' sin-color'}${f.tipo === 'conector' ? ' conector' : ''}`, color);
    }
    svg.replaceChildren(trazos);
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
    const lineas = [`Carta de empalme · ${props.nombre} (${ELEMENTOS[props.tipo]?.nombre ?? props.tipo})`];
    lineas.push('', 'Cables:');
    for (const p of d.puntas) {
      lineas.push(`- ${p.cable.properties.nombre} ${p.cable.properties.fibras}F ${p.pasante ? 'pasa, ' : ''}${haciaTexto(p)}`);
    }
    if (d.equipos.length) {
      lineas.push('', 'Equipos:');
      for (const e of d.equipos) lineas.push(`- ${e.nombre} ${F.describirEquipo(e)} (${usoEquipo(d, e)})`);
    }
    lineas.push('', `Uniones (${d.fusiones.length}):`);
    for (const f of d.fusiones) lineas.push(`- ${etiquetaConLado(d, f.a)} ↔ ${etiquetaConLado(d, f.b)}${f.tipo === 'conector' ? ' [conector]' : ''}`);
    const enPaso = textoEnPaso(d);
    if (enPaso.length) {
      lineas.push('', 'En paso:');
      for (const t of enPaso) lineas.push(`- ${t}`);
    }
    return lineas.join('\n');
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
    } else if (elegido) {
      const p = F.parseExtremo(elegido);
      const punta = p?.tipo === 'c' ? d.puntas.find((x) => x.cable.id === p.id && x.lado === p.lado) : null;
      const enPaso = punta?.pasante && estadoFibra(d, punta, p.n) === 'paso';
      texto = `${etiquetaConLado(d, elegido)}: tocá la fibra o el puerto con que se une.`;
      if (enPaso) detalle = 'Está en paso: al unirla queda cortada acá.';
      items.push(boton('Cancelar', () => soltar()));
    } else if (foco?.tipo === 'union') {
      const f = state().fusiones.get(foco.fusion);
      if (f) {
        texto = `${etiquetaConLado(d, f.a)} ↔ ${etiquetaConLado(d, f.b)}`;
        detalle = `${f.tipo === 'conector' ? 'Conector' : 'Fusión'} · cargada por ${f.creado_por ?? '—'} el ${formatFecha(f.creado)}`;
        items.push(
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
        items.push(
          boton(p.pasante ? 'Intercambiar izquierda y derecha' : (d.lados.get(p.key) === 'i' ? 'Pasar a la derecha' : 'Pasar a la izquierda'),
            () => moverPunta(d, p)),
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
            boton('Editar', () => abrirForm(e.tipo, e)),
            boton('Borrar', () => {
              foco = { tipo: 'equipo', id: e.id, borrar: true };
              renderPie();
            }),
            boton('Cerrar', () => soltar()),
          );
        }
      }
    } else {
      texto = d.puntas.length || d.equipos.length
        ? 'Tocá una fibra o un puerto y después con qué se une.'
        : 'Cuando lleguen cables, sus fibras aparecen acá.';
    }
    pie.replaceChildren(...[
      h('div.carta-pie-texto', {}, h('p', { text: texto }), detalle ? h('small', { text: detalle }) : null),
      items.length ? h('div.carta-pie-botones', {}, ...items) : null,
    ].filter(Boolean));
  }

  function soltar() {
    elegido = null;
    foco = null;
    render();
  }

  // ------------------------------------------------------------ toques

  function alTocar(event) {
    const b = event.target.closest('button');
    if (!b || !cuerpo.contains(b) || ocupado) return;
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
    } else if (accion === 'punta') {
      elegido = null;
      foco = foco?.tipo === 'punta' && foco.key === b.dataset.key ? null : { tipo: 'punta', key: b.dataset.key };
      render();
    } else if (accion === 'equipo') {
      elegido = null;
      const id = Number(b.dataset.id);
      foco = foco?.tipo === 'equipo' && foco.id === id ? null : { tipo: 'equipo', id };
      render();
    }
  }

  function tocarExtremo(ext) {
    const d = datos();
    if (!d) return;
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

  // De qué lado se dibuja un cable: se guarda en el elemento para todos.
  function moverPunta(d, p) {
    const lados = { ...(d.elemento.properties.carta?.lados ?? {}) };
    const actual = d.lados.get(p.key);
    if (p.pasante) {
      const par = d.puntas.find((x) => x.cable.id === p.cable.id && x.key !== p.key);
      lados[p.key] = actual === 'i' ? 'd' : 'i';
      if (par) lados[par.key] = actual === 'i' ? 'i' : 'd';
    } else {
      lados[p.key] = actual === 'i' ? 'd' : 'i';
    }
    // Solo se guardan los lados de cables que siguen llegando acá.
    const vigentes = new Set(d.puntas.map((x) => x.key));
    for (const key of Object.keys(lados)) if (!vigentes.has(key)) delete lados[key];
    const elemento = elementoId;
    return escribir(
      () => api(`api/elementos/${elemento}`, { method: 'PUT', body: { carta: { lados } } }),
      () => { foco = { tipo: 'punta', key: p.key }; },
    );
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
    apertura += 1;
    ultimaFirma = '';
    armar();
    root.hidden = false;
    document.body.classList.add('con-carta');
    render();
    // Al volver de un recorrido, se ve el extremo de donde se partió.
    if (ext) cuerpo.querySelector(`[data-ext="${ext}"]`)?.scrollIntoView({ block: 'center' });
    cab.querySelector('.ficha-cerrar')?.focus({ preventScroll: true });
  }

  function cerrar({ aviso = null, silencioso = false } = {}) {
    if (root.hidden) return;
    const id = elementoId;
    apertura += 1;
    root.hidden = true;
    root.replaceChildren();
    observador?.disconnect();
    document.body.classList.remove('con-carta');
    cuadro = null;
    elementoId = null;
    elegido = null;
    foco = null;
    if (!silencioso) acciones.alCerrarCarta(id, aviso);
  }

  // Cambios de otros (o respuestas propias) mientras está abierta.
  red.on('datos', () => {
    if (!abierta() || propio) return;
    if (!state().elementos.has(elementoId)) {
      cerrar({ aviso: 'El elemento ya no existe: lo borró otro usuario.' });
      return;
    }
    const d = datos();
    if (d && firma(d) === ultimaFirma) return;
    render();
  });

  document.addEventListener('keydown', (event) => {
    if (!abierta() || event.key !== 'Escape') return;
    event.preventDefault();
    // El Escape es de la carta: que no lo vea también la ficha que vuelve al cerrarla.
    event.stopImmediatePropagation();
    if (foco || elegido) soltar();
    else cerrar();
  });

  window.addEventListener('resize', () => {
    if (abierta()) pedirLineas();
  });

  return { abrir, cerrar, abierta, elemento: () => elementoId };
}
