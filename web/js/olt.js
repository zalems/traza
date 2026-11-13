// El tablero de la OLT de una red: lo que se leyó de ella (el panel, o traza por su
// cuenta), mirado como red. Resumen y novedades (qué se cayó, qué está al límite),
// los equipos dibujados con sus placas y sus puertos, los puertos PON, las ONT con
// la historia de cada una, y las cajas con la potencia promedio y las bocas libres.
// Solo lee: no cambia nada en la OLT. Cruza con el mapa para decir dónde mirar.

import { api } from './api.js';
import * as F from './fibras.js';
import { dbTexto, haceCuanto, textoBocas, textoClientesCaja, tiempo, viejo } from './integracion.js';
import { bps, setupEquipos } from './equipos.js';

const SONDEO_MS = 60 * 1000; // la OLT se lee cada uno o dos minutos
const PAGINA = 120; // ONT que se dibujan de una vez
const CLAVE_PESTANA = 'ftth.olt.pestana';
const PESTANAS = [['resumen', 'Resumen'], ['equipos', 'Equipos'], ['puertos', 'Puertos PON'], ['onts', 'ONT'], ['cajas', 'Cajas']];
const RANGOS = [[24, '24 h'], [168, '7 días'], [720, '30 días']];
const MOTIVO = { fibra: 'sin luz', energia: 'sin energía', otra: 'sin señal' };
const NIVEL_ONT = { bien: 'buena', atencion: 'justa', critica: 'al límite', alta: 'alta: puede saturar', caida: 'sin señal', 'sin-dato': 'sin lectura' };
const NIVEL_CAJA = { bien: 'bien', atencion: 'para mirar', mal: 'señal baja', caida: 'sin señal', ninguno: 'sin lecturas' };
const HORA = 3600 * 1000;

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

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
const dos = (n) => String(n).padStart(2, '0');
const hora = (t) => `${dos(new Date(t).getHours())}:${dos(new Date(t).getMinutes())}`;
const dia = (t) => `${new Date(t).getDate()}/${new Date(t).getMonth() + 1}`;
const fechaHora = (t) => `${dia(t)} ${hora(t)}`;
const sinTildes = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const porNombre = (a, b) => a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' });

// Una curva en el tiempo, sin librerías. series: [{ puntos: [[t, valor]], clase, escalon }];
// umbrales: [{ valor, texto, clase }] (se dibujan si entran en la escala). La línea
// se corta donde faltan lecturas (más de `hueco` ms entre dos puntos).
export function grafico({ series, desde, hasta, umbrales = [], formato = String, hueco = Infinity, positivo = false }) {
  const valores = series.flatMap((s) => s.puntos.map((p) => p[1])).filter(Number.isFinite);
  if (!valores.length) return null;
  // La escala va de lo más bajo a lo más alto que hubo, con un margen: así una
  // caída de pocas ONT entre cientos se ve. Los rótulos dicen esos dos valores.
  const bajo = Math.min(...valores);
  const alto = Math.max(...valores);
  const margen = Math.max((alto - bajo) * 0.14, positivo ? 1 : 0.4);
  let min = bajo - margen;
  const max = alto + margen;
  if (positivo) min = Math.max(0, min);
  const x = (t) => ((t - desde) / (hasta - desde)) * 1000;
  const y = (v) => 300 - ((v - min) / (max - min)) * 300;
  const lienzo = svg('svg', { viewBox: '0 0 1000 300', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const marcas = [];
  for (const u of umbrales) {
    if (!(u.valor > min && u.valor < max)) continue;
    lienzo.append(svg('line', { x1: 0, x2: 1000, y1: y(u.valor), y2: y(u.valor), class: `grafico-umbral ${u.clase ?? ''}` }));
    marcas.push(h('span.grafico-marca', { style: `top:${(y(u.valor) / 300) * 100}%`, text: u.texto }));
  }
  for (const s of series) {
    let d = '';
    let previo = null;
    for (const [t, v] of s.puntos) {
      if (!Number.isFinite(v) || t < desde || t > hasta) {
        previo = null;
        continue;
      }
      const px = x(t).toFixed(1);
      const py = y(v).toFixed(1);
      if (previo === null || t - previo[0] > hueco) d += `M${px} ${py}`;
      else d += s.escalon ? `H${px}V${py}` : `L${px} ${py}`;
      previo = [t, v];
    }
    // Un punto suelto no dibuja línea: se le da un trazo corto para que se vea.
    d = d.replace(/M([\d.]+) ([\d.]+)(?=M|$)/g, 'M$1 $2h6');
    lienzo.append(svg('path', { d, class: `grafico-linea ${s.clase ?? ''}` }));
  }
  const pasos = hasta - desde <= 26 * HORA ? 4 : hasta - desde <= 8 * 24 * HORA ? 7 : 6;
  const eje = [];
  for (let i = 0; i <= pasos; i += 1) {
    const t = desde + ((hasta - desde) * i) / pasos;
    eje.push(h('span', { text: hasta - desde <= 26 * HORA ? hora(t) : dia(t) }));
  }
  return h('div.grafico', {},
    h('div.grafico-lienzo', {}, lienzo,
      h('span.grafico-valor', { style: `top:${(y(alto) / 300) * 100}%`, text: formato(alto) }),
      alto > bajo ? h('span.grafico-valor', { style: `top:${(y(bajo) / 300) * 100}%`, text: formato(bajo) }) : null,
      ...marcas),
    h('div.grafico-eje', { 'aria-hidden': 'true' }, ...eje));
}

// Cómo llama el panel a lo que le pasa a una ONT, en castellano (lo que no se reconoce va como viene).
function nombreEvento(tipo) {
  const t = String(tipo ?? '').toLowerCase();
  if (t === 'appeared') return 'apareció en la OLT';
  if (/offline|down|\blos\b|lost|gasp|fail|ca[ií]da/.test(t)) return 'se cayó';
  if (/online|\bup\b|recover|volvi/.test(t)) return 'volvió';
  return tipo;
}

function leerPestana() {
  try {
    const v = localStorage.getItem(CLAVE_PESTANA);
    if (PESTANAS.some(([k]) => k === v)) return v;
  } catch { /* sin almacenamiento */ }
  return 'resumen';
}

export function setupOlt({ root, red, senal, acciones, toast }) {
  let pestana = leerPestana();
  let redVista = null; // la red cuya OLT se mira (en «todas las redes» se elige)
  let datos = null; // lo que respondió /api/olt
  let datosDe = null;
  let error = null;
  let pidiendo = false;
  let turno = 0; // para descartar respuestas que llegan tarde
  let sondeo = null;
  let repeticion = null; // un pedido más, a los pocos segundos de cargar o actualizar una OLT que se lee directo
  let volverA = null; // a dónde vuelve el foco al cerrar
  let horas = 24; // el lapso de las curvas
  const series = new Map(); // `${red}|${horas}|${olt}|${pon}` -> { datos | error }
  const detalles = new Map(); // `${red}|${ont}|${horas}` -> { datos | error }
  let ontAbierta = null;
  let ponAbierto = null;
  let filtro = { texto: '', estado: 'todas', pon: '', orden: 'puerto', grupo: null, mostradas: PAGINA };
  let filtroCajas = { ver: 'todas', orden: 'nombre' };
  let textoCopia = null;
  let apagados = []; // lo que queda detrás del tablero mientras está abierto (sin foco ni toques)

  const cab = h('header.olt-cab');
  const cuerpo = h('div.olt-cuerpo', { tabindex: '-1' });
  const panel = h('div.olt-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Tablero de la OLT' }, cab, cuerpo);
  root.append(panel);

  const abierta = () => !root.hidden;
  const boton = (text, onclick, attrs = {}) => h('button', { type: 'button', text, onclick, ...attrs });
  const estadoRed = () => red.state;
  const elemento = (id) => estadoRed().elementos.get(id) ?? null;

  // ------------------------------------------------------------- pedidos

  function redes() {
    const actual = acciones.redActual();
    if (!actual) return [];
    return actual.todas ? acciones.redes() : [actual];
  }

  // repetir: se vuelve a pedir a los pocos segundos (una OLT recién cargada tarda un poco en leerse).
  function pedir({ forzar = false, repetir = false } = {}) {
    if (!redVista) return;
    const redId = redVista;
    const mio = (turno += 1);
    pidiendo = true;
    pintarCabecera();
    clearTimeout(repeticion);
    const directas = datos && datosDe === redId && (datos.equipos ?? []).some((e) => e.origen === 'directa');
    if (repetir || (forzar && directas)) {
      repeticion = setTimeout(() => {
        if (abierta() && redVista === redId && !pidiendo) pedir({ repetir: repetir && !(datos?.onts?.length) });
      }, 6000);
    }
    api(`api/olt?red=${redId}${forzar ? '&refrescar=1' : ''}`, { espera: 60000 }).then((res) => {
      if (mio !== turno || redVista !== redId) return;
      for (const o of res.onts ?? []) {
        o.clave = o.panel_id ?? `sn:${o.sn}`;
        o.buscar = sinTildes([o.descripcion, o.titular, o.sn, o.interfaz, `${o.interfaz}:${o.ont_id}`, o.contrato, o.nap].filter((x) => x !== null && x !== undefined).join(' '));
      }
      datos = res;
      datosDe = redId;
      error = null;
    }, (err) => {
      if (mio !== turno || redVista !== redId) return;
      error = err.message;
    }).finally(() => {
      if (mio !== turno) return;
      pidiendo = false;
      if (abierta()) pintar({ conservar: true, lectura: true });
    });
    senal.pedirTodo(forzar ? { forzar: true } : undefined);
  }

  // Lo que traza anotó de la red (o de un puerto) en el lapso elegido.
  function serie(olt = '', pon = '') {
    const clave = `${redVista}|${horas}|${olt}|${pon}`;
    const hay = series.get(clave);
    if (hay && (hay.error || Date.now() - hay.cuando < SONDEO_MS)) return hay;
    if (hay?.pidiendo) return hay;
    const entrada = { ...(hay ?? {}), pidiendo: true };
    series.set(clave, entrada);
    const consulta = pon ? `&olt=${encodeURIComponent(olt)}&pon=${encodeURIComponent(pon)}` : '';
    api(`api/olt/historia?red=${redVista}&horas=${horas}${consulta}`).then(
      (res) => series.set(clave, { datos: res, cuando: Date.now() }),
      (err) => series.set(clave, { error: err.message, cuando: Date.now() }),
    ).finally(() => {
      if (abierta() && (pestana === 'resumen' || pestana === 'puertos')) pintar({ conservar: true });
    });
    return entrada;
  }

  function detalleOnt(o) {
    const clave = `${redVista}|${o.clave}|${horas}`;
    const hay = detalles.get(clave);
    // Lo leído vale cinco minutos (como en el servidor); mientras se vuelve a pedir, se ve lo anterior.
    if (hay && (hay.pidiendo || hay.error || Date.now() - hay.cuando < 5 * SONDEO_MS)) return hay;
    const entrada = { ...(hay ?? {}), pidiendo: true };
    detalles.set(clave, entrada);
    const cual = o.panel_id !== null ? `ont=${o.panel_id}` : `sn=${encodeURIComponent(o.sn)}`;
    api(`api/olt/ont?red=${redVista}&${cual}&horas=${horas}`, { espera: 40000 }).then(
      (res) => detalles.set(clave, { datos: res, cuando: Date.now() }),
      (err) => {
        detalles.set(clave, { error: err.message });
        setTimeout(() => detalles.delete(clave), 15000); // se puede volver a intentar
      },
    ).finally(() => {
      if (abierta() && pestana === 'onts' && ontAbierta === o.clave) pintarLista();
    });
    return entrada;
  }

  // ----------------------------------------------------------- navegación

  function irAOnts(cambios) {
    filtro = { texto: '', estado: 'todas', pon: '', orden: filtro.orden, grupo: null, mostradas: PAGINA, ...cambios };
    ontAbierta = null;
    elegirPestana('onts');
  }

  function elegirPestana(nueva, { foco = false } = {}) {
    pestana = nueva;
    try {
      localStorage.setItem(CLAVE_PESTANA, nueva);
    } catch { /* sin almacenamiento */ }
    textoCopia = null;
    pintar();
    cuerpo.scrollTop = 0;
    if (foco) cab.querySelector(`[data-pestana="${nueva}"]`)?.focus();
  }

  // Dónde mirar una novedad en el mapa. De un corte, si los clientes caídos tienen su
  // recorrido dibujado, se dice dónde se juntan: el corte está ahí o antes. Solo se
  // afirma dónde está cuando están dibujados todos los que cayeron.
  function enElMapa(n) {
    const s = estadoRed();
    const clientes = (n.clientes ?? []).filter((id) => elemento(id));
    const corte = ['pon-caido', 'caida-grupal', 'caja-caida'].includes(n.tipo);
    const comun = corte && clientes.length ? F.comunDeClientes(s, clientes) : null;
    let pista = null;
    let ir = null;
    if (comun && comun.conLuz >= 2) {
      const nombre = F.nombreElemento(s, comun.elemento);
      const cable = comun.cable !== null ? s.cables.get(comun.cable)?.properties.nombre : null;
      if (comun.todos && comun.conLuz === n.cantidad) {
        pista = `En el mapa, todas cuelgan de ${nombre} y abajo no queda nadie más: el corte está en ${nombre} o en ${cable ? `el cable ${cable}, que le llega` : 'lo que le llega'}.`;
      } else {
        const cuales = comun.conLuz === n.cantidad ? 'sus recorridos' : `los recorridos de las ${comun.conLuz} que están dibujadas`;
        pista = `En el mapa, ${cuales} se juntan en ${nombre}${comun.abajo > comun.conLuz ? `, de donde cuelgan ${comun.abajo} clientes` : ''}.`;
      }
      ir = () => acciones.irAElemento(comun.elemento);
    } else if (n.caja !== undefined && elemento(n.caja)) ir = () => acciones.irAElemento(n.caja);
    else if (clientes.length === 1) ir = () => acciones.irAElemento(clientes[0]);
    else if (clientes.length) ir = () => acciones.irAClientes(clientes);
    return { ir, pista };
  }

  // ------------------------------------------------------------- cabecera

  function pintarCabecera() {
    const actual = acciones.redActual();
    const lista = redes();
    const nombreRed = lista.find((r) => r.id === redVista)?.nombre ?? '';
    const titulo = datos && datosDe === redVista && datos.olts?.length ? datos.olts.join(' + ') : 'OLT';
    const leido = datos && datosDe === redVista ? datos.leido : null;
    const cerrarBtn = boton('', () => cerrar(), { class: 'ficha-cerrar', 'aria-label': 'Cerrar el tablero de la OLT' });
    cerrarBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    const elegir = actual?.todas && lista.length > 1
      ? h('label.olt-red', {}, h('span.sr-only', { text: 'Red' }),
        h('select', { onchange: (e) => verRed(Number(e.target.value)) },
          ...lista.map((r) => h('option', { value: r.id, selected: r.id === redVista, text: r.nombre }))))
      : null;
    const cuentas = datos && datosDe === redVista && datos.resumen ? {
      puertos: datos.pon.length, onts: datos.resumen.onts,
    } : {};
    if (datos && datosDe === redVista && datos.equipos?.length > 1) cuentas.equipos = datos.equipos.length;
    const totalCajas = senal.cajas().resumenes.size;
    // La cabecera se rehace con cada lectura: el foco queda en el mismo control.
    const conFoco = cab.contains(document.activeElement) ? document.activeElement : null;
    const mismo = !conFoco ? null : conFoco.dataset.pestana ? `[data-pestana="${conFoco.dataset.pestana}"]`
      : conFoco.tagName === 'SELECT' ? 'select' : conFoco.classList.contains('olt-actualizar') ? '.olt-actualizar' : '.ficha-cerrar';
    cab.replaceChildren(
      h('div.olt-titulo', {}, h('small', { text: elegir ? 'OLT de la red' : `OLT · ${nombreRed}` }), elegir, h('strong', { text: titulo })),
      h('div.olt-acciones', {},
        leido ? h(`span.olt-leido${viejo(leido) ? '.alerta' : ''}`, { text: `leída ${haceCuanto(leido)}` }) : null,
        // Mientras lee no se deshabilita (perdería el foco): avisa que está leyendo y no vuelve a pedir.
        boton(pidiendo ? 'Leyendo…' : 'Actualizar', () => {
          if (!pidiendo) pedir({ forzar: true });
        }, { class: 'olt-actualizar', 'aria-disabled': pidiendo ? 'true' : null }),
        cerrarBtn),
      h('div.olt-pestanas', { role: 'tablist', 'aria-label': 'Partes del tablero', onkeydown: teclaPestana },
        ...PESTANAS.map(([k, texto]) => {
          const n = k === 'cajas' ? totalCajas : cuentas[k];
          return h('button', {
            type: 'button', role: 'tab', id: `olt-pestana-${k}`, 'data-pestana': k, 'aria-selected': String(k === pestana),
            tabindex: k === pestana ? '0' : '-1', onclick: () => elegirPestana(k),
          }, texto, n ? h('span.olt-cuenta', { text: n }) : null);
        })),
    );
    if (mismo) cab.querySelector(mismo)?.focus({ preventScroll: true });
  }

  function teclaPestana(event) {
    const i = PESTANAS.findIndex(([k]) => k === pestana);
    const paso = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!paso) return;
    event.preventDefault();
    elegirPestana(PESTANAS[(i + paso + PESTANAS.length) % PESTANAS.length][0], { foco: true });
  }

  function verRed(id) {
    redVista = id;
    datos = null;
    datosDe = null;
    error = null;
    ontAbierta = null;
    ponAbierto = null;
    filtro = { ...filtro, pon: '', grupo: null, mostradas: PAGINA };
    equiposUI.cerrar();
    pintar();
    pedir();
  }

  // --------------------------------------------------------------- cuerpo

  function pintar({ conservar = false, lectura = false } = {}) {
    if (!abierta()) return;
    // Con el formulario de una OLT abierto, una lectura nueva no lo rehace (se está escribiendo).
    if (lectura && pestana === 'equipos' && equiposUI.escribiendo()) {
      pintarCabecera();
      return;
    }
    const arriba = conservar ? cuerpo.scrollTop : 0;
    // Mientras se escribe en el buscador, una lectura nueva rehace solo la lista.
    if (conservar && pestana === 'onts' && cuerpo.querySelector('.olt-lista-onts') && datos?.onts) {
      pintarCabecera();
      pintarFiltros();
      pintarLista();
      return;
    }
    pintarCabecera();
    cuerpo.setAttribute('role', 'tabpanel');
    cuerpo.setAttribute('aria-labelledby', `olt-pestana-${pestana}`);
    const partes = [];
    const listos = datos && datosDe === redVista;
    for (const e of [...(error ? [error] : []), ...(listos ? datos.errores ?? [] : [])]) partes.push(h('p.olt-aviso.alerta', { text: e }));
    if (pestana === 'cajas') partes.push(...pintarCajas());
    else if (!redVista) partes.push(h('p.olt-vacio', { text: 'Elegí una red para ver su OLT.' }));
    else if (!listos) partes.push(error ? null : h('p.olt-vacio', { text: 'Leyendo la OLT…' }));
    else if (pestana === 'equipos') partes.push(...equiposUI.pintar());
    else if (!datos.configurada?.panel) partes.push(...sinPanel());
    else if (!datos.onts) partes.push(h('p.olt-vacio', { text: 'No se pudo leer la OLT. Probá «Actualizar» en un momento.' }));
    else if (pestana === 'resumen') partes.push(...pintarResumen());
    else if (pestana === 'puertos') partes.push(...pintarPuertos());
    else partes.push(...pintarOnts());
    // Al rehacer por una lectura nueva, el foco queda en el mismo botón (si sigue estando).
    const enfocables = 'button, select, input, textarea';
    const conFoco = conservar && cuerpo.contains(document.activeElement) ? document.activeElement : null;
    const lugar = conFoco ? [...cuerpo.querySelectorAll(enfocables)].indexOf(conFoco) : -1;
    cuerpo.replaceChildren(...partes.filter(Boolean));
    if (pestana === 'onts' && listos && datos.onts) {
      pintarFiltros();
      pintarLista();
    }
    cuerpo.scrollTop = arriba;
    if (lugar >= 0) {
      const mismo = cuerpo.querySelectorAll(enfocables)[lugar];
      if (mismo && mismo.tagName === conFoco.tagName && mismo.textContent === conFoco.textContent) mismo.focus({ preventScroll: true });
    }
  }

  function sinPanel() {
    return [
      h('p.olt-vacio', { text: 'Esta red todavía no tiene una OLT de dónde leer.' }),
      datos.administra
        ? h('div.olt-novedad-botones.centro', {}, boton('Agregar una OLT', () => {
          elegirPestana('equipos');
          equiposUI.abrirFormulario(null);
        }, { class: 'primario' }))
        : h('p.olt-nota', { text: 'La carga quien administra traza, en la pestaña «Equipos».' }),
      h('p.olt-nota', { text: 'Las cajas se pueden ver igual, con lo que dicen las cartas de empalme.' }),
    ];
  }

  // -------------------------------------------------------------- resumen

  function pintarResumen() {
    const r = datos.resumen;
    const cifra = (n, texto, sub, estado, clase = '') => h(`button.olt-cifra${clase}`, { type: 'button', onclick: () => irAOnts({ estado }) },
      h('strong', { text: n }), h('span', { text: texto }), sub ? h('small', { text: sub }) : null);
    const causas = [r.fibra ? `${r.fibra} sin luz` : null, r.energia ? `${r.energia} sin energía` : null, r.otras ? `${r.otras} sin causa` : null].filter(Boolean).join(' · ');
    const bajas = r.atencion + r.criticas;
    const sinMapa = r.onts - r.en_mapa;
    const cifras = h('div.olt-cifras', {},
      cifra(r.onts, 'ONT en la OLT', null, 'todas'),
      cifra(r.en_linea, 'en línea', r.onts ? `${Math.round((r.en_linea / r.onts) * 100)} %` : null, 'en-linea', '.nivel-bien'),
      cifra(r.caidas, 'sin señal', causas, 'caidas', r.caidas ? '.nivel-caida' : ''),
      cifra(bajas, 'con señal baja', r.criticas ? `${r.criticas} al límite` : null, 'baja', bajas ? (r.criticas ? '.nivel-mal' : '.nivel-atencion') : ''),
      cifra(sinMapa, 'sin su cliente en el mapa', null, 'sin-mapa'),
    );

    const novedades = datos.novedades ?? [];
    const lista = novedades.length
      ? h('ul.olt-novedades', {}, ...novedades.map((n) => {
        const { ir, pista } = enElMapa(n);
        return h(`li.olt-novedad.nivel-${n.nivel === 'grave' ? 'caida' : 'atencion'}`, {},
          h('p.olt-novedad-texto', {}, n.texto, n.desde && n.tipo !== 'lectura-vieja' ? h('small', { text: ` · ${haceCuanto(n.desde)}` }) : null),
          pista ? h('p.olt-novedad-pista', { text: pista }) : null,
          h('div.olt-novedad-botones', {},
            n.onts?.length || n.sns?.length ? boton(n.cantidad === 1 ? 'Ver la ONT' : `Ver las ${n.cantidad} ONT`, () => irAOnts({ grupo: { titulo: n.texto, ids: new Set(n.onts ?? []), sns: new Set(n.sns ?? []) } })) : null,
            ir ? boton('Ver en el mapa', ir) : null));
      }))
      : h('p.olt-bien', { text: r.onts ? 'Sin novedades: nada caído en grupo ni al límite.' : 'No se leyó ninguna ONT de esta OLT.' });

    const bloques = [cifras, h('section.olt-bloque', {}, h('h3', { text: 'Para mirar ahora' }), lista)];

    // Las ONT en línea en el tiempo, con lo que traza anota.
    if (datos.historia) {
      const s = serie();
      const puntos = s.datos?.puntos ?? [];
      const hasta = Date.now();
      const desde = hasta - horas * HORA;
      const dibujo = puntos.length >= 2 ? grafico({
        desde, hasta, hueco: (s.datos.tramo ?? 300) * 3500, positivo: true,
        formato: (v) => String(Math.round(v)),
        series: [
          { puntos: puntos.map((p) => [tiempo(p.t), p.onts]), clase: 'registradas', escalon: true },
          { puntos: puntos.map((p) => [tiempo(p.t), p.minimo]), clase: 'en-linea', escalon: true },
        ],
      }) : null;
      let pie = null;
      if (dibujo) {
        const peor = puntos.reduce((a, b) => (b.minimo < a.minimo ? b : a));
        pie = `Ahora ${r.en_linea} de ${r.onts}. El mínimo del lapso: ${peor.minimo} (${fechaHora(tiempo(peor.t))}).`;
      } else if (s.error) pie = `No se pudo leer el historial: ${s.error}`;
      else if (s.pidiendo && !s.datos) pie = 'Leyendo el historial…';
      else pie = `El historial se junta de a poco: traza anota la OLT cada ${Math.round((datos.historia.cada_s ?? 300) / 60)} minutos${datos.historia.desde ? ` desde el ${fechaHora(tiempo(datos.historia.desde))}` : ' y recién empieza'}.`;
      bloques.push(h('section.olt-bloque', {},
        h('div.olt-bloque-cab', {}, h('h3', { text: 'ONT en línea' }), lapsos()),
        dibujo,
        dibujo ? h('p.olt-claves', {}, h('span.olt-clave.en-linea', { text: 'en línea' }), h('span.olt-clave.registradas', { text: 'en la OLT' })) : null,
        h('p.olt-nota', { text: pie })));
    }

    if (datos.recientes) {
      const filas = datos.recientes.map((g) => {
        const que = g.tipo === 'cae'
          ? `${g.cantidad === 1 ? 'cayó 1 ONT' : `cayeron ${g.cantidad} ONT`}${g.motivo ? ` (${MOTIVO[g.motivo]})` : ''}`
          : (g.cantidad === 1 ? 'volvió 1 ONT' : `volvieron ${g.cantidad} ONT`);
        return h(`li.olt-reciente.${g.tipo}`, {},
          h('time', { text: fechaHora(tiempo(g.t)) }),
          h('span', { text: `PON ${g.interfaz ?? '?'} · ${que}` }),
          boton('Ver', () => irAOnts({ grupo: { titulo: `${fechaHora(tiempo(g.t))} · PON ${g.interfaz ?? '?'}: ${que}`, sns: new Set(g.sns) } }), { class: 'enlace' }));
      });
      bloques.push(h('section.olt-bloque', {}, h('h3', { text: 'Lo que cayó y volvió en dos días' }),
        filas.length ? h('ul.olt-recientes', {}, ...filas)
          : h('p.olt-nota', { text: 'Nada anotado todavía: acá va quedando cada caída y cada vuelta, con su hora.' })));
    }
    return bloques;
  }

  function lapsos() {
    return h('div.olt-lapsos', { role: 'group', 'aria-label': 'Lapso' }, ...RANGOS.map(([n, texto]) => boton(texto, () => {
      horas = n;
      pintar({ conservar: true });
    }, { 'aria-pressed': String(horas === n) })));
  }

  // -------------------------------------------------------------- puertos

  function pintarPuertos() {
    const varias = new Set(datos.pon.map((p) => p.olt)).size > 1;
    const u = datos.umbrales;
    const filas = [];
    // Lo que se sabe de cada puerto como puerto (no por sus ONT): se muestra si alguno lo trae.
    const conTrafico = datos.pon.some((p) => Number.isFinite(p.sale) || Number.isFinite(p.entra));
    const conModulo = datos.pon.some((p) => Number.isFinite(p.tx));
    const columnas = 7 + (conTrafico ? 1 : 0) + (conModulo ? 1 : 0);
    for (const p of datos.pon) {
      const clave = `${p.olt}|${p.interfaz}`;
      const caidas = p.onts - p.en_linea;
      const causas = [p.fibra ? `${p.fibra} sin luz` : null, p.energia ? `${p.energia} sin energía` : null].filter(Boolean).join(', ');
      const estado = { caido: 'caído', parcial: 'la mitad o más sin señal', atencion: 'señal al límite', bien: '' }[p.estado] ?? '';
      const nivel = { caido: 'caida', parcial: 'mal', atencion: 'atencion', bien: 'bien' }[p.estado] ?? 'bien';
      const abierto = ponAbierto === clave;
      filas.push(h(`tr.nivel-${nivel}`, {},
        h('th', { scope: 'row', 'data-rotulo': 'Puerto' }, h('span.olt-punto', { 'aria-hidden': 'true' }), varias ? `${p.olt} · ${p.interfaz}` : p.interfaz,
          estado ? h('small', { text: estado }) : null),
        h('td', { 'data-rotulo': 'ONT' }, String(p.onts)),
        h('td', { 'data-rotulo': 'En línea' }, String(p.en_linea),
          h('span.olt-barra', { 'aria-hidden': 'true' }, h('span', { style: `width:${p.onts ? (p.en_linea / p.onts) * 100 : 0}%` }))),
        h('td', { 'data-rotulo': 'Sin señal' }, caidas ? `${caidas}${causas ? ` (${causas})` : ''}` : '0'),
        h('td', { 'data-rotulo': 'Reciben' }, p.rx_prom === null ? '—' : `${dbTexto(p.rx_prom)} dBm`),
        h(`td${p.rx_min !== null && p.rx_min <= u.critica ? '.mal' : p.rx_min !== null && p.rx_min <= u.atencion ? '.atencion' : ''}`, { 'data-rotulo': 'La peor' }, p.rx_min === null ? '—' : dbTexto(p.rx_min)),
        conTrafico ? h('td', { 'data-rotulo': 'Tráfico' }, Number.isFinite(p.sale) || Number.isFinite(p.entra) ? `↓ ${bps(p.sale)} · ↑ ${bps(p.entra)}` : '—') : null,
        conModulo ? h('td', { 'data-rotulo': 'Emite' }, Number.isFinite(p.tx) ? `${dbTexto(p.tx)} dBm` : '—') : null,
        h('td.olt-botones', {},
          boton('Ver sus ONT', () => irAOnts({ pon: clave })),
          datos.historia ? boton('Historia', () => {
            ponAbierto = abierto ? null : clave;
            pintar({ conservar: true });
          }, { 'aria-expanded': String(abierto) }) : null)));
      if (abierto) filas.push(h('tr.olt-historia-pon', {}, h('td', { colspan: String(columnas) }, ...historiaPon(p))));
    }
    const titulos = ['Puerto', 'ONT', 'En línea', 'Sin señal', 'Reciben (promedio)', 'La peor',
      conTrafico ? 'Tráfico (bajada · subida)' : null, conModulo ? 'Emite el puerto' : null, ''].filter((t) => t !== null);
    return [
      h('div.olt-tabla-marco', {}, h('table.olt-tabla', {},
        h('thead', {}, h('tr', {}, ...titulos.map((t) => h('th', { scope: 'col', text: t })))),
        h('tbody', {}, ...filas))),
      h('p.olt-nota', { text: `Potencia que recibe cada ONT, según la OLT. Para mirar: ${dbTexto(u.atencion)} dBm o menos; al límite: ${dbTexto(u.critica)} o menos.` }),
    ];
  }

  // Las curvas de un puerto PON con lo que traza anotó (sinLapsos: quien llama ya puso el selector del lapso).
  function historiaPon(p, { sinLapsos = false } = {}) {
    const s = serie(p.olt, p.interfaz);
    const puntos = s.datos?.puntos ?? [];
    if (puntos.length < 2) {
      return [h('p.olt-nota', { text: s.error ? `No se pudo leer el historial: ${s.error}` : s.pidiendo && !s.datos ? 'Leyendo el historial…'
        : 'Todavía no hay historia de este puerto en el lapso elegido: se anota cada pocos minutos.' }), sinLapsos ? null : lapsos()];
    }
    const hasta = Date.now();
    const desde = hasta - horas * HORA;
    const hueco = (s.datos.tramo ?? 300) * 3500;
    const u = datos.umbrales;
    return [
      h('div.olt-bloque-cab', {}, h('h4', { text: `PON ${p.interfaz}: ONT en línea` }), sinLapsos ? null : lapsos()),
      grafico({ desde, hasta, hueco, positivo: true, formato: (v) => String(Math.round(v)), series: [
        { puntos: puntos.map((x) => [tiempo(x.t), x.onts]), clase: 'registradas', escalon: true },
        { puntos: puntos.map((x) => [tiempo(x.t), x.minimo]), clase: 'en-linea', escalon: true }] }),
      h('h4', { text: 'Potencia que reciben sus ONT (dBm): promedio y la peor' }),
      grafico({ desde, hasta, hueco, formato: (v) => dbTexto(v), umbrales: [
        { valor: u.atencion, texto: dbTexto(u.atencion, 0), clase: 'atencion' }, { valor: u.critica, texto: dbTexto(u.critica, 0), clase: 'mal' }],
      series: [
        { puntos: puntos.map((x) => [tiempo(x.t), x.rx_min]), clase: 'peor' },
        { puntos: puntos.map((x) => [tiempo(x.t), x.rx_prom]), clase: 'en-linea' }] }),
    ];
  }

  // ------------------------------------------------------------------ ONT

  const ESTADOS_ONT = [['todas', 'Todas'], ['en-linea', 'En línea'], ['caidas', 'Sin señal'], ['baja', 'Señal baja'], ['sin-mapa', 'Sin cliente en el mapa']];
  const pasaEstado = {
    todas: () => true,
    'en-linea': (o) => o.nivel !== 'caida',
    caidas: (o) => o.nivel === 'caida',
    baja: (o) => o.nivel === 'atencion' || o.nivel === 'critica',
    'sin-mapa': (o) => o.cliente === undefined,
  };
  const ORDENES = {
    puerto: null,
    nombre: (a, b) => porNombre(String(a.descripcion ?? a.sn ?? '').replace(/^#\d+\s*/, ''), String(b.descripcion ?? b.sn ?? '').replace(/^#\d+\s*/, '')),
    potencia: (a, b) => (a.rx ?? 99) - (b.rx ?? 99),
    caida: (a, b) => (tiempo(b.ultima_caida) ?? 0) * (b.nivel === 'caida' ? 1 : 0) - (tiempo(a.ultima_caida) ?? 0) * (a.nivel === 'caida' ? 1 : 0),
  };

  function filtradas() {
    const palabras = sinTildes(filtro.texto).split(/\s+/).filter(Boolean);
    const g = filtro.grupo;
    let lista = datos.onts.filter((o) => pasaEstado[filtro.estado](o)
      && (!filtro.pon || `${o.olt}|${o.interfaz}` === filtro.pon)
      && (!g || g.ids?.has(o.panel_id) || g.sns?.has(o.sn))
      && palabras.every((p) => o.buscar.includes(p)));
    if (ORDENES[filtro.orden]) lista = [...lista].sort(ORDENES[filtro.orden]);
    return lista;
  }

  function pintarOnts() {
    return [
      h('div.olt-filtros'),
      h('p.olt-cuantas', { 'aria-live': 'polite' }),
      h('ul.olt-lista.olt-lista-onts'),
      h('div.olt-mas'),
    ];
  }

  function pintarFiltros() {
    const caja = cuerpo.querySelector('.olt-filtros');
    if (!caja) return;
    const conFoco = document.activeElement?.closest?.('.olt-filtros') ? document.activeElement : null;
    const cuenta = (k) => datos.onts.filter(pasaEstado[k]).length;
    const cambiar = (cambios) => {
      filtro = { ...filtro, ...cambios, mostradas: PAGINA };
      pintarFiltros();
      pintarLista();
    };
    // El buscador se conserva: rehacerlo le sacaría el foco a quien escribe.
    let buscar = caja.querySelector('.olt-buscar');
    if (!buscar) {
      buscar = h('label.olt-buscar', {}, h('span.sr-only', { text: 'Buscar una ONT por nombre, número de serie, contrato, puerto o caja' }),
        h('input', { type: 'search', placeholder: 'Nombre, serie, contrato, puerto o caja', autocomplete: 'off', spellcheck: 'false',
          oninput: (e) => {
            filtro = { ...filtro, texto: e.target.value, mostradas: PAGINA };
            pintarLista();
          } }));
    }
    const campo = buscar.querySelector('input');
    if (campo.value !== filtro.texto) campo.value = filtro.texto;
    const pons = datos.pon.map((p) => [`${p.olt}|${p.interfaz}`, p.interfaz]);
    caja.replaceChildren(...[
      buscar,
      h('div.olt-chips', { role: 'group', 'aria-label': 'Qué ONT ver' }, ...ESTADOS_ONT.map(([k, texto]) => {
        const b = boton('', () => cambiar({ estado: k }), { 'aria-pressed': String(filtro.estado === k), 'data-estado': k });
        b.append(texto, h('span.olt-cuenta', { text: cuenta(k) }));
        return b;
      })),
      h('div.olt-selectores', {},
        h('label', {}, h('span', { text: 'Puerto' }), h('select', { class: 'olt-sel-pon', onchange: (e) => cambiar({ pon: e.target.value }) },
          h('option', { value: '', text: 'Todos' }), ...pons.map(([v, t]) => h('option', { value: v, selected: v === filtro.pon, text: t })))),
        h('label', {}, h('span', { text: 'Orden' }), h('select', { class: 'olt-sel-orden', onchange: (e) => cambiar({ orden: e.target.value }) },
          ...[['puerto', 'Por puerto'], ['nombre', 'Por nombre'], ['potencia', 'La peor señal primero'], ['caida', 'Lo último que cayó primero']]
            .map(([v, t]) => h('option', { value: v, selected: v === filtro.orden, text: t }))))),
      filtro.grupo ? h('p.olt-grupo', {}, h('span', { text: filtro.grupo.titulo }), boton('Ver todas', () => cambiar({ grupo: null }), { class: 'enlace' })) : null,
    ].filter(Boolean));
    if (conFoco?.isConnected === false) {
      const igual = conFoco.dataset.estado ? caja.querySelector(`[data-estado="${conFoco.dataset.estado}"]`)
        : conFoco.className ? caja.querySelector(`.${conFoco.className.split(' ')[0]}`) : null;
      igual?.focus();
    }
  }

  function filaOnt(o) {
    const abiertaYa = ontAbierta === o.clave;
    const nombre = o.descripcion || o.titular || o.sn || 'ONT sin nombre';
    const donde = [`${o.interfaz ?? '?'}:${o.ont_id ?? '?'}`, o.sn, o.nap].filter(Boolean).join(' · ');
    let valor;
    let linea = donde;
    if (o.nivel === 'caida') {
      valor = 'sin señal';
      const cuando = o.ultima_caida ? `cayó ${haceCuanto(o.ultima_caida)}` : null;
      linea += ` · ${[cuando, MOTIVO[o.motivo] && o.motivo !== 'otra' ? MOTIVO[o.motivo] : null].filter(Boolean).join(', ') || 'sin señal'}`;
    } else valor = o.rx === null ? 'sin lectura' : `${dbTexto(o.rx)} dBm`;
    const fila = h('button.olt-fila', { type: 'button', 'aria-expanded': String(abiertaYa), onclick: () => {
      ontAbierta = abiertaYa ? null : o.clave;
      pintarLista();
      cuerpo.querySelector(`[data-ont="${CSS.escape(String(o.clave))}"] .olt-fila`)?.focus({ preventScroll: true });
    } },
    h('span.olt-punto', { 'aria-hidden': 'true' }),
    h('span.olt-fila-nombre', { text: nombre }),
    h('span.olt-fila-valor', { text: valor }),
    h('span.olt-fila-linea', { text: linea }));
    return h(`li.nivel-${o.nivel === 'critica' ? 'mal' : o.nivel === 'sin-dato' ? 'ninguno' : o.nivel === 'alta' ? 'mal' : o.nivel}`, { 'data-ont': o.clave },
      fila, abiertaYa ? detalleDeOnt(o) : null);
  }

  function detalleDeOnt(o) {
    const u = datos.umbrales;
    const dato = (rotulo, valor) => (valor === null || valor === undefined || valor === '' ? null : h('div', {}, h('dt', { text: rotulo }), h('dd', { text: valor })));
    const cliente = o.cliente !== undefined ? elemento(o.cliente) : null;
    const caja = o.caja !== undefined ? elemento(o.caja) : null;
    const partes = [h('dl.olt-datos', {},
      dato('Estado', o.nivel === 'caida' ? `sin señal${o.ultima_caida ? ` desde el ${fechaHora(tiempo(o.ultima_caida))}` : ''}${o.causa ? ` · la OLT dice: ${o.causa}` : ''}` : 'en línea'),
      // Una ONT caída puede conservar lo último que se le leyó: no es lo que recibe ahora.
      o.nivel === 'caida' ? dato('Recibía', o.rx === null ? null : `${dbTexto(o.rx, 2)} dBm (lo último que se leyó)`)
        : dato('Recibe', o.rx === null ? null : `${dbTexto(o.rx, 2)} dBm · ${NIVEL_ONT[o.nivel] ?? ''}`),
      dato('Emite', o.tx === null || o.nivel === 'caida' ? null : `${dbTexto(o.tx, 2)} dBm`),
      dato('Puerto', `${o.interfaz ?? '?'}, ONT ${o.ont_id ?? '?'}${datos.olts.length > 1 ? ` · ${o.olt}` : ''}`),
      dato('Fibra hasta la OLT', Number.isFinite(o.distancia) && o.distancia > 0 ? `${Math.round(o.distancia).toLocaleString('es-AR')} m` : null),
      dato('N.º de serie', o.sn),
      dato('Contrato', o.contrato !== undefined && o.contrato !== null ? `#${o.contrato}${o.titular ? ` · ${o.titular}` : ''}` : null),
      dato('Caja', o.nap),
      dato('Leída', o.cuando ? haceCuanto(o.cuando) : null),
    )];
    if (o.panel_id !== null || o.sn) {
      const d = detalleOnt(o);
      if (d.pidiendo && !d.datos) partes.push(h('p.olt-nota', { text: 'Leyendo su historia…' }));
      else if (d.error) partes.push(h('p.olt-nota.alerta', { text: `No se pudo leer su historia: ${d.error}` }));
      else {
        const puntos = d.datos.puntos ?? [];
        const hasta = Date.now();
        const desde = hasta - horas * HORA;
        const dibujo = puntos.length >= 2 ? grafico({
          desde, hasta, hueco: ((hasta - desde) / 96) * 3.5, formato: (v) => dbTexto(v),
          umbrales: [{ valor: u.atencion, texto: dbTexto(u.atencion, 0), clase: 'atencion' }, { valor: u.critica, texto: dbTexto(u.critica, 0), clase: 'mal' }],
          series: [{ puntos: puntos.map((p) => [tiempo(p.t), p.rx]), clase: 'en-linea' }],
        }) : null;
        const t = d.datos.tendencia;
        const ritmo = Number.isFinite(t?.db_semana) && Math.abs(t.db_semana) >= 0.3
          ? `${t.db_semana < 0 ? 'Viene bajando' : 'Viene subiendo'} ${dbTexto(Math.abs(t.db_semana))} dB por semana. ` : '';
        const rango = Number.isFinite(t?.rx_min) && Number.isFinite(t?.rx_max) ? `Entre ${dbTexto(t.rx_min)} y ${dbTexto(t.rx_max)} dBm en el lapso.` : '';
        partes.push(h('div.olt-bloque-cab', {}, h('h4', { text: 'Potencia que recibe (dBm)' }), lapsos()));
        partes.push(dibujo ?? h('p.olt-nota', { text: o.panel_id !== null ? 'El panel no tiene lecturas de esta ONT en el lapso elegido.'
          : 'Todavía no hay historia de esta ONT en el lapso elegido: traza anota su potencia cada 15 minutos.' }));
        if (ritmo || rango) partes.push(h(`p.olt-nota${t?.db_semana <= -0.5 ? '.alerta' : ''}`, { text: `${ritmo}${rango}` }));
        const eventos = (d.datos.eventos ?? []).slice(0, 12);
        if (eventos.length) {
          partes.push(h('h4', { text: 'Lo último que le pasó' }), h('ul.olt-eventos', {}, ...eventos.map((e) => h('li', {},
            h('time', { text: tiempo(e.cuando) === null ? '' : fechaHora(tiempo(e.cuando)) }),
            h('span', { text: [nombreEvento(e.tipo), e.causa].filter(Boolean).join(' · ') })))));
        }
      }
    }
    const botones = [
      cliente ? boton('Ver el cliente en el mapa', () => acciones.irAElemento(cliente.id)) : null,
      caja ? boton(`Ver la caja ${caja.properties.nombre}`, () => acciones.irAElemento(caja.id)) : null,
    ].filter(Boolean);
    if (botones.length) partes.push(h('div.olt-novedad-botones', {}, ...botones));
    else if (o.cliente === undefined) partes.push(h('p.olt-nota', { text: 'Esta ONT no tiene su cliente en el mapa: falta cargarlo o anotarle este número de serie.' }));
    return h('div.olt-detalle', {}, ...partes);
  }

  function pintarLista() {
    const ul = cuerpo.querySelector('.olt-lista-onts');
    if (!ul || !datos?.onts) return;
    const lista = filtradas();
    const visibles = lista.slice(0, filtro.mostradas);
    // La ONT abierta se ve aunque haya quedado más abajo.
    if (ontAbierta !== null && !visibles.some((o) => o.clave === ontAbierta)) {
      const abiertaAhora = lista.find((o) => o.clave === ontAbierta);
      if (abiertaAhora) visibles.push(abiertaAhora);
      else ontAbierta = null;
    }
    const conFoco = document.activeElement?.closest?.('[data-ont]')?.dataset.ont ?? null;
    ul.replaceChildren(...visibles.map(filaOnt));
    if (conFoco !== null) ul.querySelector(`[data-ont="${CSS.escape(conFoco)}"] .olt-fila`)?.focus({ preventScroll: true });
    cuerpo.querySelector('.olt-cuantas').textContent = lista.length === datos.onts.length
      ? plural(lista.length, 'ONT', 'ONT') : `${lista.length} de ${datos.onts.length} ONT`;
    const mas = cuerpo.querySelector('.olt-mas');
    mas.replaceChildren(...(lista.length > visibles.length ? [boton(`Mostrar ${Math.min(PAGINA, lista.length - visibles.length)} más`, () => {
      filtro.mostradas += PAGINA;
      pintarLista();
    })] : lista.length ? [] : [h('p.olt-vacio', { text: 'Ninguna ONT con eso. Probá con otra palabra o quitá un filtro.' })]));
  }

  // ---------------------------------------------------------------- cajas

  const VER_CAJAS = [['todas', 'Todas'], ['libres', 'Con bocas libres'], ['revisar', 'Para revisar'], ['caidas', 'Sin señal']];
  const pasaCaja = {
    todas: () => true,
    libres: (r) => r.libres !== null && r.libres > 0,
    revisar: (r) => ['atencion', 'mal', 'caida'].includes(r.nivel) || r.sobrecargada,
    caidas: (r) => r.nivel === 'caida',
  };
  const GRAVEDAD = { caida: 0, mal: 1, atencion: 2, bien: 3, ninguno: 4 };

  function filasCajas() {
    const s = estadoRed();
    const filas = [];
    for (const [id, r] of senal.cajas().resumenes) {
      const e = s.elementos.get(id);
      if (e) filas.push({ id, nombre: e.properties.nombre || 'NAP sin nombre', r });
    }
    return filas;
  }

  const lineaCaja = (f) => [f.nombre, f.r.capacidad === null ? null : (f.r.sobrecargada ? `llena (${f.r.ocupados} para ${f.r.capacidad} bocas)` : `${f.r.libres} de ${f.r.capacidad} libres`),
    f.r.nivel === 'caida' ? 'sin señal' : f.r.promedio === null ? null : `${dbTexto(f.r.promedio)} dBm${f.r.enLinea > 1 ? ` (peor ${dbTexto(f.r.peor)})` : ''}`,
    f.r.conLectura ? `${f.r.enLinea} de ${f.r.conLectura} en línea` : null].filter(Boolean).join(' · ');

  function pintarCajas() {
    const d = senal.cajas();
    const todas = filasCajas();
    if (!estadoRed().cargada) return [h('p.olt-vacio', { text: 'Cargando la red…' })];
    if (!todas.length) return [h('p.olt-vacio', { text: 'Todavía no hay cajas NAP en el mapa de esta red.' })];
    const filas = todas.filter((f) => pasaCaja[filtroCajas.ver](f.r));
    const orden = {
      nombre: (a, b) => porNombre(a.nombre, b.nombre),
      libres: (a, b) => (b.r.libres ?? -1) - (a.r.libres ?? -1) || porNombre(a.nombre, b.nombre),
      potencia: (a, b) => GRAVEDAD[a.r.nivel] - GRAVEDAD[b.r.nivel] || (a.r.peor ?? 0) - (b.r.peor ?? 0) || porNombre(a.nombre, b.nombre),
    }[filtroCajas.orden];
    filas.sort(orden);
    const conBocas = todas.filter((f) => f.r.libres !== null && f.r.libres > 0);
    const libres = conBocas.reduce((n, f) => n + f.r.libres, 0);
    const resumen = [plural(todas.length, 'caja', 'cajas'),
      conBocas.length ? `${plural(libres, 'boca libre', 'bocas libres')} en ${conBocas.length}` : null,
      todas.filter((f) => pasaCaja.revisar(f.r)).length ? `${todas.filter((f) => pasaCaja.revisar(f.r)).length} para revisar` : null].filter(Boolean).join(' · ');
    const fuentes = [];
    if (d.cargando) fuentes.push('Leyendo las potencias…');
    else if (!d.conWispro && !d.conPanel) fuentes.push('Sin Wispro ni OLT conectados: las bocas salen de las cartas de empalme y no hay potencias.');
    else if (!d.conPanel) fuentes.push('Sin OLT conectada: se ven las bocas, no las potencias.');
    else if (!d.conWispro) fuentes.push('Sin Wispro: las bocas y los clientes de cada caja salen de las cartas de empalme.');
    if (d.leido) fuentes.push(`OLT leída ${haceCuanto(d.leido)}.`);
    const cambiar = (cambios) => {
      filtroCajas = { ...filtroCajas, ...cambios };
      textoCopia = null;
      pintar({ conservar: true });
    };
    return [
      h('p.olt-cuantas', { text: resumen }),
      h('div.olt-filtros', {},
        h('div.olt-chips', { role: 'group', 'aria-label': 'Qué cajas ver' }, ...VER_CAJAS.map(([k, texto]) => {
          const b = boton('', () => cambiar({ ver: k }), { 'aria-pressed': String(filtroCajas.ver === k) });
          b.append(texto, h('span.olt-cuenta', { text: todas.filter((f) => pasaCaja[k](f.r)).length }));
          return b;
        })),
        h('div.olt-selectores', {},
          h('label', {}, h('span', { text: 'Orden' }), h('select', { class: 'olt-sel-orden-cajas', onchange: (e) => cambiar({ orden: e.target.value }) },
            ...[['nombre', 'Por nombre'], ['libres', 'Más bocas libres primero'], ['potencia', 'Lo peor primero']]
              .map(([v, t]) => h('option', { value: v, selected: v === filtroCajas.orden, text: t })))),
          boton('Copiar la lista', () => copiar(filas.map(lineaCaja).join('\n'))))),
      textoCopia !== null ? h('textarea.olt-copia', { readonly: true, rows: '6', 'aria-label': 'La lista, para copiar' }, textoCopia) : null,
      filas.length ? h('ul.olt-lista.olt-lista-cajas', {}, ...filas.map((f) => h(`li.nivel-${f.r.nivel}`, {},
        h('button.olt-fila', { type: 'button', title: 'Ver la caja en el mapa', onclick: () => acciones.irAElemento(f.id) },
          h('span.olt-punto', { 'aria-hidden': 'true' }),
          h('span.olt-fila-nombre', { text: f.nombre }),
          h('span.olt-fila-valor', { text: f.r.nivel === 'caida' ? 'sin señal' : f.r.promedio === null ? NIVEL_CAJA[f.r.nivel] : `${dbTexto(f.r.promedio)} dBm` }),
          h('span.olt-fila-linea', { text: [textoBocas(f.r) ? `Bocas libres: ${textoBocas(f.r)}` : null, textoClientesCaja(f.r)].filter(Boolean).join(' · ') || 'Sin datos todavía' })))))
        : h('p.olt-vacio', { text: 'Ninguna caja con eso.' }),
      ...fuentes.map((t) => h('p.olt-nota', { text: t })),
    ];
  }

  async function copiar(texto) {
    try {
      await navigator.clipboard.writeText(texto);
      toast?.('Lista copiada: pegala en un mensaje');
    } catch {
      // Sin portapapeles (permiso, HTTP): el texto queda a la vista para copiarlo a mano.
      textoCopia = texto;
      pintar({ conservar: true });
      cuerpo.querySelector('.olt-copia')?.select();
    }
  }

  // Los equipos (el chasis de cada OLT y cómo se llega a ella) tienen su módulo.
  const equiposUI = setupEquipos({
    h, boton, grafico, toast,
    redVista: () => redVista,
    nombreRed: () => redes().find((r) => r.id === redVista)?.nombre ?? '',
    datos: () => (datos && datosDe === redVista ? datos : null),
    repintar: (opciones) => pintar(opciones),
    pedir: (opciones) => pedir(opciones),
    irAOnts,
    historiaPon: (p) => historiaPon(p, { sinLapsos: true }),
    lapsos,
    horas: () => horas,
  });

  // --------------------------------------------------------- abrir, cerrar

  function abrir(cual = null) {
    const lista = redes();
    const actual = acciones.redActual();
    if (!actual) {
      toast?.('Primero elegí una red');
      return;
    }
    volverA = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (cual && PESTANAS.some(([k]) => k === cual)) pestana = cual;
    const nueva = actual.todas ? (lista.some((r) => r.id === redVista) ? redVista : lista[0]?.id ?? null) : actual.id;
    if (nueva !== redVista) {
      redVista = nueva;
      datos = null;
      datosDe = null;
      ontAbierta = null;
      ponAbierto = null;
      filtro = { texto: '', estado: 'todas', pon: '', orden: 'puerto', grupo: null, mostradas: PAGINA };
    }
    error = null;
    textoCopia = null;
    root.hidden = false;
    document.body.classList.add('con-olt');
    apagados = [...document.body.children].filter((el) => el !== root && el.id !== 'toast' && !el.inert && el.tagName !== 'SCRIPT');
    for (const el of apagados) el.inert = true;
    pintar();
    pedir();
    clearInterval(sondeo);
    sondeo = setInterval(() => {
      if (abierta() && document.visibilityState === 'visible' && !pidiendo) pedir();
    }, SONDEO_MS);
    cab.querySelector('.ficha-cerrar')?.focus({ preventScroll: true });
  }

  function cerrar({ devolverFoco = true } = {}) {
    if (!abierta()) return;
    root.hidden = true;
    document.body.classList.remove('con-olt');
    clearInterval(sondeo);
    sondeo = null;
    clearTimeout(repeticion);
    turno += 1;
    pidiendo = false;
    equiposUI.cerrar();
    cuerpo.replaceChildren();
    for (const el of apagados) el.inert = false;
    apagados = [];
    if (devolverFoco && volverA?.isConnected) volverA.focus({ preventScroll: true });
    volverA = null;
  }

  document.addEventListener('keydown', (event) => {
    if (!abierta() || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cerrar();
  }, true);
  // Un toque fuera del panel cierra.
  root.addEventListener('pointerdown', (event) => {
    if (event.target === root) cerrar();
  });
  // Las cajas llegan por la señal (lecturas de Wispro y de la OLT).
  senal.on(() => {
    if (abierta() && pestana === 'cajas') pintar({ conservar: true });
    else if (abierta()) pintarCabecera();
  });
  red.on('datos', () => {
    if (abierta() && pestana === 'cajas') pintar({ conservar: true });
  });
  red.on('cargada', () => {
    if (abierta()) cerrar({ devolverFoco: false });
  });

  return { abrir, cerrar, abierta };
}
