// Los equipos de una red: cada OLT dibujada como es (el chasis con sus placas y sus
// puertos) y lo que pasa en cada puerto. Para quien administra, también cómo se
// llega a ella: cargarla, cambiarla, quitarla y probar la conexión. La comunidad y
// la clave se escriben acá y no vuelven del servidor.

import { api } from './api.js';
import { dbTexto, haceCuanto, tiempo } from './integracion.js';

const SVG = 'http://www.w3.org/2000/svg';
const HORA = 3600 * 1000;
const MODELOS = ['MA5800-X17', 'MA5800-X15', 'MA5800-X7', 'MA5800-X2', 'EA5800-X17', 'EA5800-X15', 'EA5800-X7', 'EA5800-X2'];
const ROLES = { pon: 'PON', control: 'control', energia: 'energía', interfaz: 'interfaz universal', uplink: 'subida', ventilador: 'ventiladores', otra: '' };
const ESTADO_PLACA = { normal: 'normal', falla: 'con falla', 'sin-confirmar': 'sin confirmar', ausente: 'no está puesta', apagada: 'apagada', 'no-coincide': 'no es la configurada', otro: '' };
const NIVEL_PON = { caido: 'caida', parcial: 'mal', atencion: 'atencion', bien: 'bien' };
const TEXTO_PON = { caido: 'caído: ninguna ONT en línea', parcial: 'la mitad o más sin señal', atencion: 'con señal al límite', bien: 'bien' };

// Los chasis MA5800 y EA5800 en milímetros, como en la descripción de hardware de
// Huawei: X17 y X15 llevan las placas paradas y los ventiladores arriba; X7 y X2,
// acostadas y los ventiladores a la derecha. Cada placa de servicio mide 23,3 de
// ancho; las de control, 31; la columna de energía y de la interfaz universal, 25,4.
const SERVICIO = 23.3;
const CONTROL = 31;
const LATERAL = 25.4;
const LARGO = 399;

export function geometria(chasis) {
  const slots = [];
  if (chasis === 'X17' || chasis === 'X15') {
    const x17 = chasis === 'X17';
    const orden = x17 ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
    const control = x17 ? [9, 10] : [8, 9];
    const energia = x17 ? [20, 21] : [18, 19];
    const ancho = x17 ? 493 : 442;
    const total = LATERAL + (orden.length - 2) * SERVICIO + 2 * CONTROL;
    const x0 = (ancho - total) / 2;
    const y0 = 78;
    // A la izquierda, de arriba abajo: las dos placas de energía y la interfaz universal (slot 0).
    slots.push({ slot: energia[0], x: x0, y: y0, w: LATERAL, h: 97.5, parada: true });
    slots.push({ slot: energia[1], x: x0, y: y0 + 100.5, w: LATERAL, h: 97.5, parada: true });
    slots.push({ slot: 0, x: x0, y: y0 + 201, w: LATERAL, h: LARGO - 201, parada: true });
    let x = x0 + LATERAL;
    for (const slot of orden) {
      const w = control.includes(slot) ? CONTROL : SERVICIO;
      slots.push({ slot, x, y: y0, w, h: LARGO, parada: true });
      x += w;
    }
    return { ancho, alto: 486, slots, ventilador: { x: x0, y: 8, w: total, h: 62, cantidad: 8 } };
  }
  if (chasis === 'X7') {
    const y0 = 6.75;
    const x0 = 6;
    const largo = 393;
    // Arriba: la interfaz universal (slot 0) y las dos placas de energía; abajo de todo, las de control.
    slots.push({ slot: 0, x: x0, y: y0, w: largo * 0.5, h: LATERAL });
    slots.push({ slot: 10, x: x0 + largo * 0.5, y: y0, w: largo * 0.25, h: LATERAL });
    slots.push({ slot: 11, x: x0 + largo * 0.75, y: y0, w: largo * 0.25, h: LATERAL });
    let y = y0 + LATERAL;
    for (const slot of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const h = slot >= 8 ? CONTROL : SERVICIO;
      slots.push({ slot, x: x0, y, w: largo, h });
      y += h;
    }
    return { ancho: 442, alto: 264, slots, ventilador: { x: x0 + largo + 3, y: y0, w: 34, h: 250.5, cantidad: 6 } };
  }
  if (chasis === 'X2') {
    const y0 = 5.6;
    const x0 = 6;
    const largo = 393;
    const h = 25.6;
    // Arriba: las dos placas de control y, a la derecha, la de energía (slot 0); abajo, las dos de servicio.
    slots.push({ slot: 3, x: x0, y: y0, w: largo * 0.34, h });
    slots.push({ slot: 4, x: x0 + largo * 0.34, y: y0, w: largo * 0.32, h });
    slots.push({ slot: 0, x: x0 + largo * 0.66, y: y0, w: largo * 0.34, h });
    slots.push({ slot: 1, x: x0, y: y0 + h, w: largo, h });
    slots.push({ slot: 2, x: x0, y: y0 + 2 * h, w: largo, h });
    return { ancho: 442, alto: 88, slots, ventilador: { x: x0 + largo + 3, y: y0, w: 34, h: 3 * h, cantidad: 3 } };
  }
  return null;
}

// 172400000 -> '172 Mb/s'; 9500000 -> '9,5 Mb/s'; 1240000000 -> '1,24 Gb/s'.
export function bps(valor) {
  if (!Number.isFinite(valor)) return '—';
  const escalas = [[1e9, 'Gb/s'], [1e6, 'Mb/s'], [1e3, 'kb/s']];
  for (const [base, unidad] of escalas) {
    if (valor >= base) {
      const n = valor / base;
      return `${(n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)).replace(/\.?0+$/, '').replace('.', ',')} ${unidad}`;
    }
  }
  return `${Math.round(valor)} b/s`;
}

// Por un puerto PON sale la bajada de los clientes y entra su subida; por uno de subida, al revés.
export const bajada = (puerto) => (puerto.tipo === 'pon' ? puerto.sale : puerto.entra);
export const subida = (puerto) => (puerto.tipo === 'pon' ? puerto.entra : puerto.sale);

function s(tag, attrs = {}, ...hijos) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  el.append(...hijos.flat().filter(Boolean));
  return el;
}

export function setupEquipos({ h, boton, grafico, toast, redVista, nombreRed, datos, repintar, pedir, irAOnts, historiaPon, lapsos, horas }) {
  let elegido = null; // { equipo, slot, puerto } lo que se mira del chasis
  let historia = false; // las curvas del puerto elegido, a la vista
  let form = null; // el formulario de conexión, abierto: { id, v, error, guardando, probando, prueba, quitar }
  const traficos = new Map(); // `${red}|${olt}|${puerto}|${horas}` -> { datos | error }

  const equipos = () => datos()?.equipos ?? [];
  const administra = () => Boolean(datos()?.administra);
  const ponDe = (equipo, puerto) => (puerto.tipo === 'pon'
    ? (datos()?.pon ?? []).find((p) => p.olt === equipo.nombre && p.interfaz === puerto.interfaz) ?? null : null);

  function nivelPuerto(equipo, puerto) {
    if (puerto.tipo === 'pon') {
      const p = ponDe(equipo, puerto);
      if (p) return NIVEL_PON[p.estado] ?? 'bien';
      return puerto.estado === 'up' ? 'libre' : 'apagado';
    }
    return puerto.estado === 'up' ? 'bien' : puerto.estado === 'ausente' ? 'ausente' : 'apagado';
  }

  // --------------------------------------------------------------- pedidos

  function trafico(equipo, puerto) {
    const clave = `${redVista()}|${equipo.nombre}|${puerto.clave}|${horas()}`;
    const hay = traficos.get(clave);
    if (hay && (hay.pidiendo || hay.error || Date.now() - hay.cuando < 60000)) return hay;
    const entrada = { ...(hay ?? {}), pidiendo: true };
    traficos.set(clave, entrada);
    api(`api/olt/trafico?red=${redVista()}&olt=${encodeURIComponent(equipo.nombre)}&puerto=${encodeURIComponent(puerto.clave)}&horas=${horas()}`).then(
      (res) => traficos.set(clave, { datos: res, cuando: Date.now() }),
      (err) => traficos.set(clave, { error: err.message, cuando: Date.now() }),
    ).finally(() => repintar({ conservar: true }));
    return entrada;
  }

  // ---------------------------------------------------------------- chasis

  function elegir(equipo, slot, puerto = null) {
    const mismo = elegido && elegido.equipo === equipo.id && elegido.slot === slot && elegido.puerto === puerto;
    elegido = mismo && puerto === null ? null : { equipo: equipo.id, slot, puerto };
    historia = false;
    repintar({ conservar: true });
  }

  function dibujarPuertos(equipo, placa, g, lugar) {
    const puertos = placa.puertos;
    if (!puertos.length) return;
    const n = puertos.length;
    // A lo largo de la placa: el número del slot, los puertos y, al final, el nombre.
    const largo = lugar.parada ? lugar.h : lugar.w;
    const ancho = lugar.parada ? lugar.w : lugar.h;
    const inicio = lugar.parada ? 20 : 17;
    const reserva = largo > 180 ? 50 : 6;
    const paso = Math.min(lugar.parada ? 17.4 : 22, (largo - inicio - reserva) / n);
    const lado = Math.max(2, paso - 1.8);
    const grosor = ancho - 7;
    puertos.forEach((puerto, i) => {
      const a = (lugar.parada ? lugar.y : lugar.x) + inicio + i * paso;
      const b = (lugar.parada ? lugar.x : lugar.y) + 3.5;
      const caja = lugar.parada ? { x: b, y: a, width: grosor, height: lado } : { x: a, y: b, width: lado, height: grosor };
      const marcado = elegido?.equipo === equipo.id && elegido.slot === placa.slot && elegido.puerto === puerto.clave;
      const celda = s('g', {
        class: `chasis-puerto ${nivelPuerto(equipo, puerto)}${marcado ? ' elegido' : ''}`,
        'aria-hidden': 'true',
        onclick: (event) => {
          event.stopPropagation();
          elegir(equipo, placa.slot, puerto.clave);
        },
      }, s('title', { text: puerto.nombre ?? '' }), s('rect', { ...caja, rx: 1.3 }));
      if (lado >= 9 && grosor >= 9) {
        celda.append(s('text', { x: caja.x + caja.width / 2, y: caja.y + caja.height / 2, class: 'chasis-numero', text: String(puerto.puerto) }));
      }
      g.append(celda);
    });
  }

  function dibujarChasis(equipo) {
    const geo = geometria(equipo.chasis);
    if (!geo) return null;
    const porSlot = new Map(equipo.placas.map((p) => [p.slot, p]));
    const lienzo = s('svg', { viewBox: `0 0 ${geo.ancho} ${geo.alto}`, class: `chasis-dibujo chasis-${equipo.chasis.toLowerCase()}`, role: 'group', 'aria-label': `Frente de ${equipo.nombre}: sus placas, slot por slot` });
    lienzo.append(s('rect', { x: 0.75, y: 0.75, width: geo.ancho - 1.5, height: geo.alto - 1.5, rx: 4, class: 'chasis-caja' }));
    // Los ventiladores.
    const v = geo.ventilador;
    const acostado = v.w > v.h;
    lienzo.append(s('rect', { x: v.x, y: v.y, width: v.w, height: v.h, rx: 2.5, class: 'chasis-ventilador' }));
    const radio = Math.min(acostado ? v.h : v.w, (acostado ? v.w : v.h) / v.cantidad) * 0.36;
    for (let i = 0; i < v.cantidad; i += 1) {
      const centro = (i + 0.5) / v.cantidad;
      const cx = acostado ? v.x + v.w * centro : v.x + v.w / 2;
      const cy = acostado ? v.y + v.h / 2 : v.y + v.h * centro;
      lienzo.append(s('circle', { cx, cy, r: radio, class: 'chasis-aspa' }), s('circle', { cx, cy, r: radio * 0.28, class: 'chasis-eje' }));
    }
    for (const lugar of geo.slots) {
      const placa = porSlot.get(lugar.slot) ?? null;
      const marcada = elegido?.equipo === equipo.id && elegido.slot === lugar.slot;
      const rotulo = placa
        ? `Slot ${lugar.slot}: ${placa.nombre ?? 'placa'}${ROLES[placa.rol] ? `, ${ROLES[placa.rol]}` : ''}${placa.puertos.length ? `, ${placa.puertos.length} puertos` : ''}${placa.estado !== 'normal' ? `, ${ESTADO_PLACA[placa.estado] || placa.estado}` : ''}`
        : `Slot ${lugar.slot}: vacío`;
      const g = s('g', {
        class: `chasis-slot ${placa ? `con-placa rol-${placa.rol}${placa.estado !== 'normal' ? ' con-falla' : ''}` : 'vacio'}${marcada ? ' elegida' : ''}`,
        role: placa ? 'button' : null,
        tabindex: placa ? '0' : null,
        'aria-label': rotulo,
        'aria-pressed': placa ? String(marcada && !elegido.puerto) : null,
        onclick: placa ? () => elegir(equipo, lugar.slot) : null,
        onkeydown: placa ? (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          elegir(equipo, lugar.slot);
        } : null,
      });
      g.append(s('rect', { x: lugar.x + 0.9, y: lugar.y + 0.9, width: lugar.w - 1.8, height: lugar.h - 1.8, rx: 1.6, class: 'chasis-frente' }));
      // El número del slot, en la punta donde empieza la placa.
      g.append(lugar.parada
        ? s('text', { x: lugar.x + lugar.w / 2, y: lugar.y + 11, class: 'chasis-slot-numero', text: String(lugar.slot) })
        : s('text', { x: lugar.x + 8.5, y: lugar.y + lugar.h / 2, class: 'chasis-slot-numero', text: String(lugar.slot) }));
      if (placa) {
        dibujarPuertos(equipo, placa, g, lugar);
        const nombre = placa.nombre ?? '';
        const largo = lugar.parada ? lugar.h : lugar.w;
        const cabe = placa.puertos.length === 0 ? largo > 60 : largo > 180;
        if (nombre && cabe) {
          g.append(lugar.parada
            ? s('text', { class: 'chasis-nombre', 'text-anchor': 'end', transform: `translate(${lugar.x + lugar.w / 2} ${lugar.y + lugar.h - 5}) rotate(90)`, text: nombre })
            : s('text', { class: 'chasis-nombre', 'text-anchor': 'end', x: lugar.x + lugar.w - 5, y: lugar.y + lugar.h / 2, text: nombre }));
        }
      }
      lienzo.append(g);
    }
    return lienzo;
  }

  // Un chasis que no se reconoce: las placas en orden, cada una con sus puertos.
  function listaDePlacas(equipo) {
    return h('ul.chasis-lista', {}, ...equipo.placas.map((placa) => h('li', {},
      boton(`Slot ${placa.slot} · ${placa.nombre ?? 'placa'}${ROLES[placa.rol] ? ` · ${ROLES[placa.rol]}` : ''}`, () => elegir(equipo, placa.slot),
        { 'aria-pressed': String(elegido?.equipo === equipo.id && elegido.slot === placa.slot) }))));
  }

  function leyenda() {
    const clave = (clase, texto) => h(`span.chasis-clave.${clase}`, { text: texto });
    return h('p.chasis-leyenda', { 'aria-hidden': 'true' },
      clave('bien', 'bien'), clave('atencion', 'señal al límite'), clave('mal', 'la mitad o más sin señal'),
      clave('caida', 'caído'), clave('libre', 'sin ONT'), clave('ausente', 'sin módulo'));
  }

  // -------------------------------------------------------------- detalle

  function chip(equipo, placa, puerto) {
    const p = ponDe(equipo, puerto);
    const marcado = elegido?.puerto === puerto.clave;
    let sub;
    if (puerto.tipo === 'pon') sub = p ? `${p.en_linea}/${p.onts}` : 'sin ONT';
    else sub = puerto.estado === 'up' ? (Number.isFinite(bajada(puerto)) ? bps(bajada(puerto)) : 'en servicio') : puerto.estado === 'ausente' ? 'sin módulo' : 'sin enlace';
    const rotulo = puerto.tipo === 'pon'
      ? `PON ${puerto.interfaz}: ${p ? `${p.onts} ONT, ${p.en_linea} en línea` : 'sin ONT'}`
      : `Puerto de subida ${puerto.puerto}: ${sub}`;
    return h(`button.chasis-chip.${nivelPuerto(equipo, puerto)}`, {
      type: 'button', 'aria-pressed': String(marcado), 'aria-label': rotulo, onclick: () => elegir(equipo, placa.slot, puerto.clave),
    }, h('strong', { text: String(puerto.puerto) }), h('span', { text: sub }));
  }

  function dato(rotulo, valor) {
    return valor === null || valor === undefined || valor === '' ? null : h('div', {}, h('dt', { text: rotulo }), h('dd', { text: valor }));
  }

  function curvaTrafico(equipo, puerto) {
    const t = trafico(equipo, puerto);
    const puntos = t.datos?.puntos ?? [];
    if (puntos.length < 2) {
      return [h('p.olt-nota', { text: t.error ? `No se pudo leer el historial: ${t.error}` : t.pidiendo && !t.datos ? 'Leyendo el historial…'
        : 'Todavía no hay historia del tráfico de este puerto en el lapso elegido: traza lo anota cada cinco minutos.' })];
    }
    const hasta = Date.now();
    const desde = hasta - horas() * HORA;
    const pon = puerto.tipo === 'pon';
    const pico = puntos.reduce((a, b) => ((pon ? b.sale_max : b.entra_max) > (pon ? a.sale_max : a.entra_max) ? b : a));
    return [
      grafico({ desde, hasta, hueco: (t.datos.tramo ?? 300) * 3500, positivo: true, formato: bps, series: [
        { puntos: puntos.map((x) => [tiempo(x.t), pon ? x.entra : x.sale]), clase: 'subida' },
        { puntos: puntos.map((x) => [tiempo(x.t), pon ? x.sale : x.entra]), clase: 'bajada' }] }),
      h('p.olt-claves', {}, h('span.olt-clave.bajada', { text: 'bajada' }), h('span.olt-clave.subida', { text: 'subida' })),
      h('p.olt-nota', { text: `El pico de bajada del lapso: ${bps(pon ? pico.sale_max : pico.entra_max)}.` }),
    ];
  }

  function detallePuerto(equipo, puerto) {
    const p = ponDe(equipo, puerto);
    const ahora = Number.isFinite(bajada(puerto)) || Number.isFinite(subida(puerto))
      ? `bajada ${bps(bajada(puerto))} · subida ${bps(subida(puerto))}` : null;
    const partes = [];
    if (puerto.tipo === 'pon') {
      const caidas = p ? p.onts - p.en_linea : 0;
      const causas = p ? [p.fibra ? `${p.fibra} sin luz` : null, p.energia ? `${p.energia} sin energía` : null].filter(Boolean).join(', ') : '';
      const modulo = [Number.isFinite(puerto.tx) ? `emite ${dbTexto(puerto.tx)} dBm` : null,
        Number.isFinite(puerto.temperatura) ? `${Math.round(puerto.temperatura)} °C` : null,
        Number.isFinite(puerto.tension) ? `${String(puerto.tension).replace('.', ',')} V` : null,
        Number.isFinite(puerto.corriente) ? `${Math.round(puerto.corriente)} mA` : null].filter(Boolean).join(' · ');
      partes.push(
        h('h4', { text: `PON ${puerto.interfaz}` }),
        h('dl.olt-datos', {},
          dato('Estado', p ? TEXTO_PON[p.estado] : puerto.estado === 'up' ? 'en servicio, sin ONT' : puerto.estado === 'down' ? 'sin ONT en línea' : null),
          dato('ONT', p ? `${p.onts} · ${p.en_linea} en línea${caidas ? ` · ${caidas} sin señal${causas ? ` (${causas})` : ''}` : ''}` : 'ninguna'),
          dato('Reciben', p && p.rx_prom !== null ? `${dbTexto(p.rx_prom)} dBm en promedio · la peor, ${dbTexto(p.rx_min)}` : null),
          dato('Módulo del puerto', modulo),
          dato('Tráfico ahora', ahora)),
        !modulo && equipo.origen === 'panel' && !equipo.registrado && administra()
          ? h('p.olt-nota', { text: 'El panel no informa cuánto emite el módulo de cada puerto. Si cargás la conexión de esta OLT, traza se lo lee directo.' }) : null,
      );
    } else {
      partes.push(
        h('h4', { text: `${puerto.nombre ?? `Puerto ${puerto.puerto}`}${puerto.uplink ? ' · subida' : ''}` }),
        h('dl.olt-datos', {},
          dato('Estado', puerto.estado === 'up' ? 'en servicio' : puerto.estado === 'ausente' ? 'sin módulo' : 'sin enlace'),
          dato('Velocidad', puerto.velocidad ? bps(puerto.velocidad * 1e6).replace('/s', '') : null),
          dato('Tráfico ahora', ahora)),
      );
    }
    const botones = [
      p ? boton('Ver sus ONT', () => irAOnts({ pon: `${p.olt}|${p.interfaz}` })) : null,
      boton(historia ? 'Ocultar la historia' : 'Historia', () => {
        historia = !historia;
        repintar({ conservar: true });
      }, { 'aria-expanded': String(historia) }),
    ].filter(Boolean);
    partes.push(h('div.olt-novedad-botones', {}, ...botones));
    if (historia) {
      partes.push(h('div.olt-bloque-cab', {}, h('h4', { text: 'Tráfico' }), lapsos()), ...curvaTrafico(equipo, puerto));
      if (p && datos().historia) partes.push(...historiaPon(p));
    }
    return h('div.chasis-puerto-detalle', {}, ...partes.filter(Boolean));
  }

  function detalle(equipo) {
    if (!elegido || elegido.equipo !== equipo.id) {
      const pon = equipo.placas.flatMap((p) => p.puertos).filter((p) => p.tipo === 'pon');
      const subidas = equipo.placas.flatMap((p) => p.puertos).filter((p) => p.tipo === 'eth' && p.estado === 'up');
      const baja = subidas.reduce((a, p) => a + (bajada(p) ?? 0), 0);
      const sube = subidas.reduce((a, p) => a + (subida(p) ?? 0), 0);
      const placasPon = equipo.placas.filter((p) => p.rol === 'pon').length;
      return h('div.chasis-detalle', {},
        h('dl.olt-datos', {},
          dato('Placas', equipo.placas.length ? `${equipo.placas.length}${placasPon ? ` · ${placasPon} de PON` : ''}` : null),
          dato('Puertos PON', pon.length ? `${pon.length} · ${pon.filter((p) => ponDe(equipo, p)).length} con ONT` : null),
          dato('Subida ahora', subidas.length && (baja || sube) ? `bajada ${bps(baja)} · subida ${bps(sube)}` : null),
          dato('Encendida', Number.isFinite(equipo.encendida_s) ? `hace ${equipo.encendida_s >= 2 * 86400 ? `${Math.round(equipo.encendida_s / 86400)} días` : `${Math.round(equipo.encendida_s / 3600)} h`}` : null),
          dato('Programa', equipo.firmware)),
        equipo.placas.length ? h('p.olt-nota', { text: 'Tocá una placa o un puerto para ver qué pasa ahí.' }) : null);
    }
    const placa = equipo.placas.find((p) => p.slot === elegido.slot);
    if (!placa) return h('div.chasis-detalle', {});
    const puerto = placa.puertos.find((p) => p.clave === elegido.puerto) ?? null;
    const que = [ROLES[placa.rol] ? `Placa de ${ROLES[placa.rol]}` : 'Placa', placa.puertos.length ? `${placa.puertos.length} puertos` : null,
      placa.detalle ?? (ESTADO_PLACA[placa.estado] || null)].filter(Boolean).join(' · ');
    return h('div.chasis-detalle', {},
      h('h4.chasis-placa-titulo', { text: `Slot ${placa.slot}${placa.nombre ? ` · ${placa.nombre}` : ''}` }),
      h(`p.olt-nota${placa.estado === 'normal' ? '' : '.alerta'}`, { text: que }),
      placa.puertos.length ? h('div.chasis-chips', { role: 'group', 'aria-label': `Puertos de la placa del slot ${placa.slot}` },
        ...placa.puertos.map((p) => chip(equipo, placa, p))) : null,
      puerto ? detallePuerto(equipo, puerto) : null);
  }

  // --------------------------------------------------------------- equipos

  function tarjeta(equipo) {
    const origen = equipo.origen === 'panel'
      ? `del panel de la OLT${equipo.registrado ? ' · con su conexión cargada' : ''}`
      : 'leída directo por traza';
    const leido = equipo.leido ? `leída ${haceCuanto(equipo.leido)}` : null;
    const sub = [equipo.modelo ?? (equipo.chasis ? `chasis ${equipo.chasis}` : null), origen, leido].filter(Boolean).join(' · ');
    const dibujo = equipo.placas.length ? dibujarChasis(equipo) : null;
    const alto = equipo.chasis === 'X17' || equipo.chasis === 'X15';
    const acciones = [];
    if (administra()) {
      acciones.push(boton(equipo.registrado ? 'Conexión' : 'Cargar su conexión', () => abrirFormulario(equipo)));
    }
    return h('article.equipo', { 'data-equipo': equipo.id },
      h('header.equipo-cab', {},
        h('div', {}, h('h3', { text: equipo.nombre }), h('p.olt-nota', { text: sub })),
        acciones.length ? h('div.olt-novedad-botones', {}, ...acciones) : null),
      equipo.error ? h('p.olt-aviso.alerta', { text: `${equipo.error.charAt(0).toUpperCase()}${equipo.error.slice(1)}.` }) : null,
      equipo.nota ? h('p.olt-nota.alerta', { text: equipo.nota }) : null,
      equipo.placas.length
        ? h(`div.chasis${alto ? '.alto' : ''}`, {},
          h('div.chasis-marco', {}, dibujo ?? listaDePlacas(equipo), dibujo ? leyenda() : null,
            dibujo ? null : h('p.olt-nota', { text: administra() ? 'No se reconoce el chasis: elegí el modelo en «Conexión» para verlo dibujado.' : 'No se reconoce el chasis de esta OLT.' })),
          detalle(equipo))
        : (equipo.leido || equipo.origen === 'panel') && !equipo.error ? h('p.olt-nota', { text: 'No se recibieron las placas de esta OLT.' }) : null);
  }

  function pintar() {
    if (form) return [formulario()];
    const lista = equipos();
    const partes = lista.map(tarjeta);
    if (!lista.length) {
      partes.push(h('p.olt-vacio', { text: 'Esta red todavía no tiene una OLT cargada.' }),
        h('p.olt-nota', { text: administra()
          ? 'Cargá la OLT con su dirección y su comunidad SNMP de lectura: traza la lee sola cada minuto (no cambia nada en ella) y la dibuja acá con sus placas y sus puertos.'
          : 'Las OLT las carga quien administra traza.' }));
    }
    if (administra()) {
      partes.push(h('div.equipo-agregar', {}, boton('Agregar una OLT', () => abrirFormulario(null), { class: 'primario' })));
    }
    return partes;
  }

  // ------------------------------------------------------------ formulario

  function abrirFormulario(equipo) {
    const c = equipo?.conexion ?? {};
    form = {
      id: equipo?.registrado ? equipo.id : null,
      titulo: equipo ? equipo.nombre : null,
      tieneComunidad: Boolean(c.tiene_comunidad),
      tieneClave: Boolean(c.tiene_clave),
      usuarioGuardado: c.usuario ?? '',
      v: {
        nombre: equipo?.origen === 'panel' ? '' : equipo?.nombre ?? '',
        host: c.host ?? equipo?.host_panel ?? '',
        modelo: c.modelo ?? '',
        snmp_puerto: c.snmp_puerto ?? 161,
        comunidad: '',
        consola: c.consola ?? '',
        consola_puerto: c.consola_puerto ?? 22,
        usuario: c.usuario ?? '',
        clave: '',
        utc: c.utc ?? -180,
        panel: equipo?.origen === 'panel' ? equipo.panel : null,
        leer: c.leer ?? true,
      },
      error: null, guardando: false, probando: false, prueba: null, quitar: false,
    };
    repintar();
  }

  function cerrarFormulario() {
    form = null;
    repintar();
  }

  function cuerpoEquipo() {
    const v = form.v;
    return {
      nombre: v.nombre.trim(), host: v.host.trim(), modelo: v.modelo, snmp_puerto: Number(v.snmp_puerto) || 161, comunidad: v.comunidad,
      consola: v.consola, consola_puerto: Number(v.consola_puerto) || (v.consola === 'telnet' ? 23 : 22),
      usuario: v.consola ? v.usuario.trim() : '', clave: v.consola ? v.clave : '', utc: Number(v.utc), panel: v.panel, leer: v.leer,
    };
  }

  function falta() {
    const v = form.v;
    if (!v.host.trim()) return 'Falta la dirección de la OLT.';
    if (v.panel === null && !v.nombre.trim()) return 'Ponele un nombre a la OLT.';
    return null;
  }

  async function guardar() {
    if (form.guardando) return;
    form.error = falta();
    if (form.error) {
      repintar({ conservar: true });
      return;
    }
    form.guardando = true;
    repintar({ conservar: true });
    const actual = form;
    try {
      await api(actual.id ? `api/olt/equipos/${actual.id}` : 'api/olt/equipos', {
        method: actual.id ? 'PUT' : 'POST', body: { red: redVista(), equipo: cuerpoEquipo() }, espera: 30000 });
      toast?.(actual.id ? 'Conexión guardada' : 'OLT cargada: se empieza a leer');
      if (form === actual) form = null;
      elegido = null;
      pedir({ forzar: true, repetir: true });
    } catch (err) {
      actual.error = err.message;
      actual.guardando = false;
    }
    repintar({ conservar: true });
  }

  async function probar() {
    if (form.probando) return;
    form.error = form.v.host.trim() ? null : 'Falta la dirección de la OLT.';
    if (form.error) {
      repintar({ conservar: true });
      return;
    }
    form.probando = true;
    form.prueba = null;
    repintar({ conservar: true });
    const actual = form;
    try {
      const res = await api('api/olt/equipos/probar', { method: 'POST', body: { red: redVista(), id: actual.id, equipo: cuerpoEquipo() }, espera: 58000 });
      actual.prueba = res;
      // Lo que la OLT dice de sí misma: su nombre, si todavía no se le puso uno.
      if (res.detectado?.nombre && actual.v.panel === null && !actual.v.nombre.trim()) actual.v.nombre = res.detectado.nombre;
    } catch (err) {
      actual.error = err.message;
    }
    actual.probando = false;
    repintar({ conservar: true });
    if (form === actual) document.querySelector('.equipo-prueba')?.scrollIntoView({ block: 'nearest' });
  }

  async function quitar() {
    const actual = form;
    actual.guardando = true;
    repintar({ conservar: true });
    try {
      await api(`api/olt/equipos/${actual.id}?red=${redVista()}`, { method: 'DELETE', espera: 30000 });
      toast?.('OLT quitada');
      if (form === actual) form = null;
      elegido = null;
      pedir({ forzar: true });
    } catch (err) {
      actual.error = err.message;
      actual.guardando = false;
      actual.quitar = false;
    }
    repintar({ conservar: true });
  }

  function campo(rotulo, control, ayuda = null) {
    return h('label.equipo-campo', {}, h('span', { text: rotulo }), control, ayuda ? h('small', { text: ayuda }) : null);
  }

  function entrada(clave, attrs = {}) {
    return h('input', {
      name: clave, value: form.v[clave] ?? '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
      oninput: (e) => {
        form.v[clave] = e.target.value;
      },
      ...attrs,
    });
  }

  function secreto(clave, guardado, rotulo) {
    const input = entrada(clave, { type: 'password', autocomplete: 'new-password', placeholder: guardado ? 'guardada: escribí solo para cambiarla' : '' });
    const ver = boton('ver', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
      ver.textContent = input.type === 'password' ? 'ver' : 'ocultar';
    }, { class: 'equipo-enlace', 'aria-label': `Mostrar u ocultar ${rotulo}` });
    return h('span.equipo-secreto', {}, input, ver);
  }

  function seleccion(clave, opciones, alCambiar = null) {
    return h('select', {
      name: clave,
      onchange: (e) => {
        const crudo = e.target.value;
        form.v[clave] = opciones.find(([valor]) => String(valor) === crudo)?.[0] ?? crudo;
        alCambiar?.();
      },
    }, ...opciones.map(([valor, texto]) => h('option', { value: String(valor), selected: form.v[clave] === valor, text: texto })));
  }

  function resultadoPrueba() {
    if (form.probando) return h('p.olt-nota', { text: 'Probando la conexión… puede tardar hasta medio minuto.' });
    if (!form.prueba) return null;
    return h('div', {}, ...form.prueba.pruebas.map((p) => h(`section.equipo-resultado.${p.ok ? (p.parcial ? 'atencion' : 'bien') : 'mal'}`, {},
      h('h4', {}, h('span.equipo-marca', { text: p.ok ? (p.parcial ? 'A medias' : 'Bien') : 'No anduvo' }), p.titulo),
      h('p', { text: p.texto }),
      p.datos?.length ? h('dl.olt-datos', {}, ...p.datos.map(([k, valor]) => dato(k, valor))) : null,
      p.pistas?.length ? h('div', {}, h('p.equipo-revisar', { text: 'Para revisar:' }), h('ul', {}, ...p.pistas.map((t) => h('li', { text: t })))) : null)));
  }

  function formulario() {
    const v = form.v;
    const delPanel = equipos().filter((e) => e.origen === 'panel' && (!e.registrado || e.id === form.id));
    const vinculada = v.panel !== null;
    const zonas = [-300, -240, -180, -120, 0].map((m) => [m, m === 0 ? 'UTC' : `UTC−${-m / 60}${m === -180 ? ' (Argentina)' : ''}`]);
    if (!zonas.some(([m]) => m === v.utc)) zonas.push([v.utc, `UTC${v.utc < 0 ? '−' : '+'}${Math.abs(v.utc) / 60}`]);
    const puertoConsola = entrada('consola_puerto', { type: 'number', inputmode: 'numeric', min: '1', max: '65535' });
    const ocupado = form.guardando || form.probando;
    const titulo = form.id ? `Conexión de ${form.titulo}` : vinculada && form.titulo ? `Cargar la conexión de ${form.titulo}` : 'Agregar una OLT';
    return h('form.equipo-form', {
      novalidate: true,
      onsubmit: (e) => {
        e.preventDefault();
        guardar();
      },
    },
    h('div.equipo-form-cab', {}, boton('← Equipos', () => cerrarFormulario(), { class: 'equipo-enlace' }), h('h3', { text: titulo })),
    h('p.olt-nota', { text: `Red ${nombreRed()}. traza solo lee la OLT: no cambia nada en ella. La comunidad y la clave quedan en el servidor y no se vuelven a mostrar.` }),
    h('fieldset', {}, h('legend', { text: 'La OLT' }),
      delPanel.length ? campo('¿Es una OLT del panel?', seleccion('panel', [[null, 'No: traza la lee directo'], ...delPanel.map((e) => [e.panel, `Sí: ${e.nombre}`])], () => repintar({ conservar: true })),
        'Las ONT de una OLT del panel las sigue dando el panel; de la OLT se lee lo que el panel no informa (cuánto emite cada puerto).') : null,
      vinculada ? null : campo('Nombre', entrada('nombre', { maxlength: '60', placeholder: 'OLT Centro' })),
      campo('Dirección', entrada('host', { maxlength: '253', inputmode: 'url', placeholder: '10.0.0.2 o olt.ejemplo.com.ar' }),
        'La IP o el nombre con que este servidor llega a la OLT. Si está en otra red, su IP pública (o la del router que le reenvía los puertos).'),
      campo('Modelo', seleccion('modelo', [['', 'Detectarlo por sus placas'], ...MODELOS.map((m) => [m, `Huawei ${m}`])]),
        'De acá sale cómo se dibuja el chasis.'),
      campo('Hora de la OLT', seleccion('utc', zonas), 'La zona del reloj de la OLT: sirve para ubicar las caídas que ella anota.')),
    h('fieldset', {}, h('legend', { text: 'Lectura (SNMP v2c)' }),
      campo('Puerto UDP', entrada('snmp_puerto', { type: 'number', inputmode: 'numeric', min: '1', max: '65535' })),
      campo('Comunidad de lectura', secreto('comunidad', form.tieneComunidad, 'la comunidad'),
        'Con la comunidad, traza lee las ONT, las placas y los puertos. Alcanza con una de solo lectura.'),
      h('label.equipo-tilde', {}, h('input', {
        type: 'checkbox', checked: v.leer,
        onchange: (e) => {
          v.leer = e.target.checked;
        },
      }), h('span', { text: 'Leer esta OLT (sin la tilde queda cargada, en pausa)' }))),
    h('fieldset', {}, h('legend', { text: 'Consola' }),
      campo('Protocolo', seleccion('consola', [['', 'No usar'], ['ssh', 'SSH'], ['telnet', 'Telnet']], () => {
        // El puerto de siempre de cada protocolo, si no se había puesto otro.
        if ([22, 23, '22', '23', ''].includes(v.consola_puerto)) v.consola_puerto = v.consola === 'telnet' ? 23 : 22;
        repintar({ conservar: true });
      }), 'Por ahora sirve para comprobar que se puede entrar. Conviene un usuario de solo consulta.'),
      v.consola ? campo('Puerto TCP', puertoConsola) : null,
      v.consola ? campo('Usuario', entrada('usuario', { maxlength: '64' })) : null,
      v.consola ? campo('Clave', secreto('clave', form.tieneClave && v.usuario.trim() === form.usuarioGuardado, 'la clave')) : null),
    form.error ? h('p.olt-aviso.alerta', { role: 'alert', text: form.error }) : null,
    form.quitar
      ? h('div.equipo-form-botones', {},
        h('p', { text: `¿Quitar ${form.titulo}? Deja de leerse; lo que ya se anotó queda.` }),
        boton(form.guardando ? 'Quitando…' : 'Sí, quitarla', () => quitar(), { class: 'peligro', disabled: form.guardando }),
        boton('No', () => {
          form.quitar = false;
          repintar({ conservar: true });
        }))
      : h('div.equipo-form-botones', {},
        boton(form.probando ? 'Probando…' : 'Probar la conexión', () => probar(), { disabled: ocupado }),
        h('button.primario', { type: 'submit', disabled: ocupado, text: form.guardando ? 'Guardando…' : 'Guardar' }),
        boton('Cancelar', () => cerrarFormulario(), { disabled: form.guardando }),
        form.id ? boton('Quitar esta OLT', () => {
          form.quitar = true;
          repintar({ conservar: true });
        }, { class: 'equipo-enlace peligro', disabled: ocupado }) : null),
    h('div.equipo-prueba', { 'aria-live': 'polite' }, resultadoPrueba()));
  }

  return {
    pintar,
    abrirFormulario,
    // Mientras se escribe en el formulario, una lectura nueva no lo rehace.
    escribiendo: () => Boolean(form),
    cerrar: () => {
      form = null;
      elegido = null;
      historia = false;
    },
  };
}
