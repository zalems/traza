// Fibras, colores y uniones: la lógica de las cartas de empalme, sin nada de
// pantalla. Cómo se numeran y colorean las fibras de un cable, qué lados de
// cada cable hay en un elemento, qué está unido con qué y por dónde va un pelo.

import { ELEMENTOS } from './modelo.js';

// Elementos donde se arma una carta de empalme (en el mismo orden que la API).
export const CON_CARTA = new Set(['nodo', 'caja', 'nap', 'botella']);

const color = (nombre, hex) => ({ nombre, hex });
const AZUL = color('azul', '#1f63d6');
const NARANJA = color('naranja', '#f07f1a');
const VERDE = color('verde', '#2b9a43');
const MARRON = color('marrón', '#86562c');
const GRIS = color('gris', '#8a949b');
const BLANCO = color('blanco', '#ffffff');
const ROJO = color('rojo', '#d8282b');
const NEGRO = color('negro', '#1c1c1c');
const AMARILLO = color('amarillo', '#f3d02a');
const VIOLETA = color('violeta', '#8a4bd0');
const ROSA = color('rosa', '#f49ac1');
const AGUA = color('agua', '#3cc9cf');

// Del 13 en adelante se repiten los colores con una marca (anillos o raya):
// negra, salvo sobre el negro, que la lleva amarilla.
const conMarcas = (lista, i) => {
  const base = lista[(i - 1) % lista.length];
  return { ...base, marcas: Math.floor((i - 1) / lista.length), marca: base === NEGRO ? AMARILLO.hex : NEGRO.hex };
};

const TIA = [AZUL, NARANJA, VERDE, MARRON, GRIS, BLANCO, ROJO, NEGRO, AMARILLO, VIOLETA, ROSA, AGUA];
const ABNT = [VERDE, AMARILLO, BLANCO, AZUL, ROJO, VIOLETA, MARRON, ROSA, NEGRO, GRIS, NARANJA, AGUA];

export const CODIGOS = {
  tia598: {
    label: 'TIA-598',
    detalle: 'azul, naranja, verde, marrón…',
    fibra: (pos) => conMarcas(TIA, pos),
    tubo: (t) => conMarcas(TIA, t),
  },
  abnt: {
    label: 'ABNT',
    detalle: 'verde, amarillo, blanco, azul…',
    fibra: (pos) => conMarcas(ABNT, pos),
    // Cables brasileños: tubo piloto verde, direccional amarillo, el resto blancos.
    tubo: (t) => ({ ...(t === 1 ? VERDE : t === 2 ? AMARILLO : BLANCO), marcas: 0 }),
  },
};

export const POR_TUBO = [1, 2, 4, 6, 8, 12, 16, 24];

const codigoDe = (props) => CODIGOS[props.colores] ?? CODIGOS.tia598;

// Fibras por tubo y cantidad de tubos. Automático: hasta 12 fibras en un tubo;
// más, en tubos de 12.
export function estructura(props) {
  const fibras = Math.max(1, Number(props.fibras) || 1);
  const pedido = Number(props.por_tubo) || 0;
  const porTubo = pedido > 0 ? Math.min(pedido, fibras) : (fibras <= 12 ? fibras : 12);
  return { fibras, porTubo, tubos: Math.ceil(fibras / porTubo), codigo: codigoDe(props) };
}

export function infoFibra(props, n) {
  const { porTubo, tubos, codigo } = estructura(props);
  const tubo = Math.ceil(n / porTubo);
  const pos = n - (tubo - 1) * porTubo;
  return { n, tubo, pos, tubos, color: codigo.fibra(pos), colorTubo: codigo.tubo(tubo) };
}

export const nombreColor = (c) => (c.marcas ? `${c.nombre} ${c.marcas === 1 ? 'con marca' : `con ${c.marcas} marcas`}` : c.nombre);

// "F15 (T2 naranja · verde)" o, con un solo tubo, "F3 (verde)".
export function etiquetaFibra(props, n) {
  const i = infoFibra(props, n);
  return i.tubos > 1
    ? `F${n} (T${i.tubo} ${nombreColor(i.colorTubo)} · ${nombreColor(i.color)})`
    : `F${n} (${nombreColor(i.color)})`;
}

// ------------------------------------------------------------- extremos

export const extremoCable = (cableId, lado, n) => `c${cableId}:${lado}:${n}`;
export const extremoEquipo = (equipoId, lado, n) => `q${equipoId}:${lado}:${n}`;

export function parseExtremo(ext) {
  const m = /^([cq])(\d+):([abes]):(\d+)$/.exec(ext ?? '');
  return m ? { tipo: m[1], id: Number(m[2]), lado: m[3], n: Number(m[4]) } : null;
}

// Igual que la API: 'a' (hacia el comienzo del cable) si no empieza acá, 'b'
// (hacia el final) si no termina acá; si pasa más de una vez, cuentan la
// primera entrada y la última salida.
export function ladosEn(nodos, elementoId) {
  const pos = [];
  (nodos ?? []).forEach((n, i) => { if (n === elementoId) pos.push(i); });
  const out = new Set();
  if (!pos.length) return out;
  if (pos[0] > 0) out.add('a');
  if (pos[pos.length - 1] < nodos.length - 1) out.add('b');
  return out;
}

const otroLado = (lado) => (lado === 'a' ? 'b' : 'a');

function distancia(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ------------------------------------------------------------- índices

// Lo que se calcula una vez por cada estado de la red (se rehace cuando cambia).
const cache = new WeakMap();

export function indice(state) {
  const previo = cache.get(state);
  if (previo && previo.rev === state.rev) return previo;
  const usado = new Map(); // `${elemento}|${extremo}` -> unión
  const fusionesEn = new Map(); // elemento -> [uniones]
  const equiposEn = new Map(); // elemento -> [equipos]
  const porCable = new Map(); // cable -> fibra -> [{ elemento, lado, fusion }]
  const cablesEn = new Map(); // elemento -> [cables]
  const posiciones = new Map(); // cable -> elemento -> [índices de sus puntos sobre ese elemento]
  for (const f of state.fusiones.values()) {
    usado.set(`${f.elemento}|${f.a}`, f);
    usado.set(`${f.elemento}|${f.b}`, f);
    if (!fusionesEn.has(f.elemento)) fusionesEn.set(f.elemento, []);
    fusionesEn.get(f.elemento).push(f);
    for (const ext of [f.a, f.b]) {
      const p = parseExtremo(ext);
      if (p?.tipo !== 'c') continue;
      if (!porCable.has(p.id)) porCable.set(p.id, new Map());
      const fibras = porCable.get(p.id);
      if (!fibras.has(p.n)) fibras.set(p.n, []);
      fibras.get(p.n).push({ elemento: f.elemento, lado: p.lado, fusion: f });
    }
  }
  for (const e of state.equipos.values()) {
    if (!equiposEn.has(e.elemento)) equiposEn.set(e.elemento, []);
    equiposEn.get(e.elemento).push(e);
  }
  for (const lista of equiposEn.values()) lista.sort((x, y) => x.id - y.id);
  for (const c of state.cables.values()) {
    const pos = new Map();
    (c.properties.nodos ?? []).forEach((id, i) => {
      if (id === null) return;
      if (!pos.has(id)) pos.set(id, []);
      pos.get(id).push(i);
    });
    posiciones.set(c.id, pos);
    for (const id of pos.keys()) {
      if (!cablesEn.has(id)) cablesEn.set(id, []);
      cablesEn.get(id).push(c);
    }
  }
  const out = { rev: state.rev, usado, fusionesEn, equiposEn, porCable, cablesEn, posiciones, distancias: null };
  cache.set(state, out);
  return out;
}

// --------------------------------------------------------- puntas y lados

const RANGO_CABLE = { troncal: 0, distribucion: 1, bajada: 2 };

// Hacia dónde va un lado de un cable desde un elemento: el próximo elemento con
// carta (o cliente) por ese lado, o el final del cable.
export function hacia(state, cable, elementoId, lado) {
  const nodos = cable.properties.nodos ?? [];
  const coords = cable.geometry.coordinates;
  const pos = [];
  nodos.forEach((n, i) => { if (n === elementoId) pos.push(i); });
  if (!pos.length) return null;
  const paso = lado === 'b' ? 1 : -1;
  let j = lado === 'b' ? pos[pos.length - 1] : pos[0];
  let metros = 0;
  let primero = null;
  for (let k = j + paso; k >= 0 && k < nodos.length; k += paso) {
    metros += distancia(coords[j], coords[k]);
    j = k;
    const el = nodos[j] === null ? null : state.elementos.get(nodos[j]);
    if (!el) continue;
    const info = { elemento: el, metros, indice: j };
    if (!primero) primero = info;
    if (CON_CARTA.has(el.properties.tipo) || el.properties.tipo === 'cliente') return { ...info, primero };
  }
  const fin = nodos[j] === null ? null : state.elementos.get(nodos[j]);
  return { elemento: fin ?? null, metros, indice: j, suelto: !fin, primero };
}

// Los lados de cable que hay en un elemento (cada uno es una "punta" en la carta).
export function puntas(state, elementoId) {
  const idx = indice(state);
  const out = [];
  const rotos = []; // empiezan y terminan acá: la carta no sabe qué lado es cuál
  const repetidos = []; // pasan más de una vez: cuentan la primera entrada y la última salida
  for (const cable of idx.cablesEn.get(elementoId) ?? []) {
    const lados = ladosEn(cable.properties.nodos, elementoId);
    if (!lados.size) {
      rotos.push(cable);
      continue;
    }
    if ((idx.posiciones.get(cable.id)?.get(elementoId)?.length ?? 0) > 1) repetidos.push(cable);
    for (const lado of ['a', 'b']) {
      if (!lados.has(lado)) continue;
      out.push({
        key: `c${cable.id}:${lado}`,
        cable,
        lado,
        pasante: lados.size === 2,
        hacia: hacia(state, cable, elementoId, lado),
      });
    }
  }
  out.sort((x, y) => (RANGO_CABLE[x.cable.properties.tipo] ?? 9) - (RANGO_CABLE[y.cable.properties.tipo] ?? 9)
    || String(x.cable.properties.nombre).localeCompare(String(y.cable.properties.nombre), 'es', { numeric: true })
    || x.cable.id - y.cable.id || x.lado.localeCompare(y.lado));
  return { puntas: out, rotos, repetidos };
}

// Distancia por los cables desde cada elemento hasta el nodo más cercano.
function distanciasANodos(state) {
  const idx = indice(state);
  if (idx.distancias) return idx.distancias;
  const vecinos = new Map();
  const unir = (a, b, m) => {
    if (!vecinos.has(a)) vecinos.set(a, []);
    vecinos.get(a).push([b, m]);
  };
  for (const c of state.cables.values()) {
    const nodos = c.properties.nodos ?? [];
    const coords = c.geometry.coordinates;
    let anterior = null;
    let metros = 0;
    for (let i = 0; i < nodos.length; i += 1) {
      if (i > 0) metros += distancia(coords[i - 1], coords[i]);
      if (nodos[i] === null) continue;
      if (anterior !== null && anterior !== nodos[i]) {
        unir(anterior, nodos[i], metros);
        unir(nodos[i], anterior, metros);
      }
      anterior = nodos[i];
      metros = 0;
    }
  }
  const dist = new Map();
  const cola = []; // montículo binario de [distancia, id]
  const subir = (i) => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (cola[p][0] <= cola[i][0]) break;
      [cola[p], cola[i]] = [cola[i], cola[p]];
      i = p;
    }
  };
  const bajar = (i) => {
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < cola.length && cola[l][0] < cola[m][0]) m = l;
      if (r < cola.length && cola[r][0] < cola[m][0]) m = r;
      if (m === i) break;
      [cola[m], cola[i]] = [cola[i], cola[m]];
      i = m;
    }
  };
  for (const e of state.elementos.values()) {
    if (e.properties.tipo === 'nodo') {
      dist.set(e.id, 0);
      cola.push([0, e.id]);
    }
  }
  cola.sort((x, y) => x[0] - y[0]);
  while (cola.length) {
    const [d, id] = cola[0];
    const ultimo = cola.pop();
    if (cola.length) {
      cola[0] = ultimo;
      bajar(0);
    }
    if (d > (dist.get(id) ?? Infinity)) continue;
    for (const [v, m] of vecinos.get(id) ?? []) {
      const nd = d + m;
      if (nd < (dist.get(v) ?? Infinity)) {
        dist.set(v, nd);
        cola.push([nd, v]);
        subir(cola.length - 1);
      }
    }
  }
  idx.distancias = dist;
  return dist;
}

// De qué lado de la carta va cada punta: a la izquierda lo que viene del nodo,
// a la derecha lo que sale. Lo que el usuario acomodó a mano manda.
export function ladosDeCarta(state, elemento, lista) {
  const guardado = elemento.properties.carta?.lados ?? {};
  const out = new Map();
  if (elemento.properties.tipo === 'nodo') {
    for (const p of lista) out.set(p.key, 'd');
  } else {
    const dist = distanciasANodos(state);
    const puntaje = (p) => {
      const sig = p.hacia?.primero;
      if (!sig) return Infinity;
      return (dist.get(sig.elemento.id) ?? Infinity) + sig.metros;
    };
    const conPuntaje = lista.map((p) => ({ p, s: puntaje(p) })).filter((x) => Number.isFinite(x.s));
    if (conPuntaje.length) {
      conPuntaje.sort((x, y) => x.s - y.s || (RANGO_CABLE[x.p.cable.properties.tipo] ?? 9) - (RANGO_CABLE[y.p.cable.properties.tipo] ?? 9)
        || y.p.cable.properties.fibras - x.p.cable.properties.fibras);
      const entrada = conPuntaje[0].p;
      for (const p of lista) out.set(p.key, 'd');
      out.set(entrada.key, 'i');
      // De los cables que pasan, el lado que viene del nodo va a la izquierda.
      const pasantes = new Map();
      for (const p of lista) if (p.pasante) pasantes.set(p.cable.id, [...(pasantes.get(p.cable.id) ?? []), p]);
      for (const [, par] of pasantes) {
        if (par.length !== 2) continue;
        const [x, y] = par;
        const izquierda = par.includes(entrada) ? entrada : (puntaje(x) <= puntaje(y) ? x : y);
        out.set(izquierda.key, 'i');
        out.set((izquierda === x ? y : x).key, 'd');
      }
    } else {
      for (const p of lista) out.set(p.key, p.lado === 'a' ? 'i' : 'd');
    }
  }
  for (const p of lista) if (guardado[p.key] === 'i' || guardado[p.key] === 'd') out.set(p.key, guardado[p.key]);
  return out;
}

// --------------------------------------------------------------- equipos

// Los puertos PON se numeran desde 1 o, en las OLT Huawei, desde 0 (placas de 0 a 15).
// Por dentro siempre van de 1 a N (`qID:s:N`): esto es solo cómo se muestran.
export const primerPuerto = (eq) => (eq?.tipo === 'olt' && eq.datos?.desde === 0 ? 0 : 1);
export const numeroPuerto = (eq, n) => n - 1 + primerPuerto(eq);

export function describirEquipo(eq) {
  if (eq.tipo === 'olt') {
    const desde = primerPuerto(eq);
    return `${eq.salidas} PON (${desde} a ${desde + eq.salidas - 1})`;
  }
  const datos = eq.datos ?? {};
  if (datos.modo === 'fbt') return `Desbalanceado ${datos.relacion ?? ''}`.trim();
  return `PLC ${eq.entradas}x${eq.salidas}`;
}

export function etiquetaPuerto(eq, lado, n) {
  const nombre = eq.nombre || (eq.tipo === 'olt' ? 'OLT' : 'Splitter');
  if (eq.tipo === 'olt') return `${nombre} PON ${numeroPuerto(eq, n)}`;
  if (lado === 'e') return eq.entradas > 1 ? `${nombre} entrada ${n}` : `${nombre} entrada`;
  if (eq.datos?.modo === 'fbt') {
    const [x, y] = String(eq.datos.relacion ?? '').split('/');
    const pct = n === 1 ? x : y;
    return pct ? `${nombre} salida ${pct} %` : `${nombre} salida ${n}`;
  }
  return `${nombre} salida ${n}`;
}

// Etiqueta de cualquier extremo, para avisos, listas y el recorrido.
export function etiquetaExtremo(state, ext) {
  const p = parseExtremo(ext);
  if (!p) return ext;
  if (p.tipo === 'q') {
    const eq = state.equipos.get(p.id);
    return eq ? etiquetaPuerto(eq, p.lado, p.n) : 'equipo borrado';
  }
  const cable = state.cables.get(p.id);
  if (!cable) return 'cable borrado';
  return `${cable.properties.nombre || 'Cable'} ${etiquetaFibra(cable.properties, p.n)}`;
}

// ------------------------------------------------------- secuencias

// La fibra o el puerto que sigue (dentro del mismo tubo), o null al final.
export function siguienteExtremo(state, ext) {
  const p = parseExtremo(ext);
  if (!p) return null;
  if (p.tipo === 'q') {
    const eq = state.equipos.get(p.id);
    if (!eq) return null;
    const limite = p.lado === 'e' ? eq.entradas : eq.salidas;
    return p.n < limite ? extremoEquipo(p.id, p.lado, p.n + 1) : null;
  }
  const cable = state.cables.get(p.id);
  if (!cable) return null;
  const { fibras, porTubo } = estructura(cable.properties);
  if (p.n >= fibras || p.n % porTubo === 0) return null;
  return extremoCable(p.id, p.lado, p.n + 1);
}

// Primera fibra del tubo siguiente, si el extremo es la última de su tubo.
export function siguienteTubo(state, ext) {
  const p = parseExtremo(ext);
  if (p?.tipo !== 'c') return null;
  const cable = state.cables.get(p.id);
  if (!cable) return null;
  const { fibras, porTubo } = estructura(cable.properties);
  if (p.n % porTubo !== 0 || p.n >= fibras) return null;
  return extremoCable(p.id, p.lado, p.n + 1);
}

// --------------------------------------------------------------- recorrido

const LIMITE_PASOS = 600;

// Sigue la fibra n de un cable desde un elemento, por el lado indicado, hasta
// la próxima unión o hasta donde termine.
function porCable(state, idx, cable, elementoId, lado, n) {
  const nodos = cable.properties.nodos ?? [];
  const coords = cable.geometry.coordinates;
  const posiciones = idx.posiciones.get(cable.id) ?? new Map();
  const pos = posiciones.get(elementoId) ?? [];
  // ini y fin: los índices de los puntos del cable donde empieza y termina el tramo
  // (de ini a fin es el sentido en que se recorrió). pasaPorM: a cuántos metros de
  // su comienzo pasa por cada elemento de pasaPor.
  const tramo = {
    tipo: 'tramo', cable: cable.id, fibra: n, desde: elementoId, hasta: null, metros: 0, coords: [], pasaPor: [], pasaPorM: [],
    ini: null, fin: null,
  };
  // El cable ya no pasa por acá (una unión vieja que quedó colgada): no hay por dónde seguir.
  if (!pos.length) return { tramo, fin: { motivo: 'sin-union', elemento: elementoId } };
  const paso = lado === 'b' ? 1 : -1;
  let j = lado === 'b' ? pos[pos.length - 1] : pos[0];
  tramo.ini = j;
  tramo.coords.push(coords[j]);
  const llegada = otroLado(lado);
  const listo = (r) => {
    tramo.fin = j;
    return { tramo, ...r };
  };
  for (;;) {
    const k = j + paso;
    if (k < 0 || k >= nodos.length) return listo({ fin: { motivo: 'suelto' } });
    tramo.metros += distancia(coords[j], coords[k]);
    tramo.coords.push(coords[k]);
    j = k;
    const id = nodos[j];
    if (id === null || !state.elementos.has(id)) continue;
    const apariciones = posiciones.get(id) ?? [j];
    if (j !== (lado === 'b' ? apariciones[0] : apariciones[apariciones.length - 1])) continue;
    const ext = extremoCable(cable.id, llegada, n);
    const f = idx.usado.get(`${id}|${ext}`);
    if (f) {
      tramo.hasta = id;
      return listo({ siguiente: { elemento: id, ext, fusion: f } });
    }
    const lados = new Set();
    if (apariciones[0] > 0) lados.add('a');
    if (apariciones[apariciones.length - 1] < nodos.length - 1) lados.add('b');
    if (!lados.has(lado)) {
      tramo.hasta = id;
      const tipo = state.elementos.get(id).properties.tipo;
      return listo({ fin: { motivo: tipo === 'cliente' ? 'cliente' : 'sin-union', elemento: id } });
    }
    if (idx.usado.get(`${id}|${extremoCable(cable.id, lado, n)}`)) {
      tramo.hasta = id;
      return listo({ fin: { motivo: 'cortada', elemento: id } });
    }
    // En paso: la fibra sigue de largo por este elemento (los postes no se nombran).
    if (CON_CARTA.has(state.elementos.get(id).properties.tipo)) {
      tramo.pasaPor.push(id);
      tramo.pasaPorM.push(tramo.metros);
    }
    const salida = lado === 'b' ? apariciones[apariciones.length - 1] : apariciones[0];
    for (let s = j + paso; lado === 'b' ? s <= salida : s >= salida; s += paso) tramo.coords.push(coords[s]);
    j = salida;
  }
}

// Desde un extremo de un elemento, en una dirección: 'union' (cruza la unión
// de ese extremo) o 'adentro' (sigue por el cable o atraviesa el equipo).
function seguir(state, idx, elementoId, ext, direccion, vistos) {
  const pasos = [];
  let actual = { elemento: elementoId, ext, direccion };
  for (let guardia = 0; guardia < LIMITE_PASOS; guardia += 1) {
    const { elemento, ext: e, direccion: dir } = actual;
    const clave = `${elemento}|${e}|${dir}`;
    if (vistos.has(clave)) {
      pasos.push({ tipo: 'fin', motivo: 'lazo', elemento });
      return pasos;
    }
    vistos.add(clave);
    const p = parseExtremo(e);
    if (dir === 'union') {
      const f = idx.usado.get(`${elemento}|${e}`);
      if (!f) {
        pasos.push({ tipo: 'fin', motivo: 'sin-union', elemento, ext: e });
        return pasos;
      }
      const otro = f.a === e ? f.b : f.a;
      pasos.push({ tipo: 'union', elemento, fusion: f, de: e, a: otro });
      actual = { elemento, ext: otro, direccion: 'adentro' };
      continue;
    }
    if (p.tipo === 'c') {
      const cable = state.cables.get(p.id);
      if (!cable) {
        pasos.push({ tipo: 'fin', motivo: 'sin-union', elemento });
        return pasos;
      }
      const r = porCable(state, idx, cable, elemento, p.lado, p.n);
      pasos.push(r.tramo);
      if (r.fin) {
        pasos.push({ tipo: 'fin', ...r.fin });
        return pasos;
      }
      actual = { elemento: r.siguiente.elemento, ext: r.siguiente.ext, direccion: 'union' };
      continue;
    }
    const eq = state.equipos.get(p.id);
    if (!eq) {
      pasos.push({ tipo: 'fin', motivo: 'sin-union', elemento });
      return pasos;
    }
    if (eq.tipo === 'olt') {
      pasos.push({ tipo: 'fin', motivo: 'olt', elemento, equipo: eq.id, puerto: p.n });
      return pasos;
    }
    if (p.lado === 'e') {
      // Entró a un splitter: de acá se abre en varias salidas.
      pasos.push({ tipo: 'fin', motivo: 'splitter', elemento, equipo: eq.id });
      return pasos;
    }
    // Salida de splitter: se sigue por su entrada (la conectada, si hay dos).
    let entrada = extremoEquipo(eq.id, 'e', 1);
    if (eq.entradas > 1 && !idx.usado.has(`${elemento}|${entrada}`)) {
      const segunda = extremoEquipo(eq.id, 'e', 2);
      if (idx.usado.has(`${elemento}|${segunda}`)) entrada = segunda;
    }
    pasos.push({ tipo: 'equipo', elemento, equipo: eq.id, de: e, a: entrada });
    actual = { elemento, ext: entrada, direccion: 'union' };
  }
  pasos.push({ tipo: 'fin', motivo: 'largo', elemento: actual.elemento });
  return pasos;
}

function invertir(paso) {
  if (paso.tipo === 'tramo') {
    return {
      ...paso,
      desde: paso.hasta,
      hasta: paso.desde,
      coords: paso.coords.slice().reverse(),
      pasaPor: paso.pasaPor.slice().reverse(),
      pasaPorM: (paso.pasaPorM ?? []).slice().reverse().map((m) => paso.metros - m),
      ini: paso.fin,
      fin: paso.ini,
    };
  }
  if (paso.tipo === 'union' || paso.tipo === 'equipo') return { ...paso, de: paso.a, a: paso.de };
  return paso;
}

// El camino completo de un pelo que pasa por un extremo: hacia los dos lados.
export function recorrido(state, elementoId, ext) {
  const idx = indice(state);
  const p = parseExtremo(ext);
  const vistos = new Set();
  let ida;
  let vuelta;
  if (p?.tipo === 'c') {
    const cable = state.cables.get(p.id);
    const lados = cable ? ladosEn(cable.properties.nodos, elementoId) : new Set();
    vuelta = seguir(state, idx, elementoId, ext, 'adentro', vistos);
    const otro = extremoCable(p.id, otroLado(p.lado), p.n);
    if (idx.usado.has(`${elementoId}|${ext}`)) {
      ida = seguir(state, idx, elementoId, ext, 'union', vistos);
    } else if (lados.has(otroLado(p.lado)) && !idx.usado.has(`${elementoId}|${otro}`)) {
      // En paso por este elemento: sigue por el otro lado del mismo cable.
      ida = seguir(state, idx, elementoId, otro, 'adentro', vistos);
    } else if (lados.has(otroLado(p.lado))) {
      ida = [{ tipo: 'fin', motivo: 'cortada', elemento: elementoId }];
    } else {
      const tipo = state.elementos.get(elementoId)?.properties.tipo;
      ida = [{ tipo: 'fin', motivo: tipo === 'cliente' ? 'cliente' : 'sin-union', elemento: elementoId, ext }];
    }
  } else {
    ida = seguir(state, idx, elementoId, ext, 'union', vistos);
    vuelta = seguir(state, idx, elementoId, ext, 'adentro', vistos);
  }
  // Lo de un lado se recorrió alejándose del punto de partida: para leerlo de
  // punta a punta se da vuelta (orden y sentido de cada paso).
  let pasos = [...ida.slice().reverse().map(invertir), { tipo: 'inicio', elemento: elementoId, ext }, ...vuelta];
  // Se lee desde la central: primero la OLT si se llega, si no, un nodo.
  const centralEn = (paso) => (paso?.motivo === 'olt' ? 2 : state.elementos.get(paso?.elemento)?.properties.tipo === 'nodo' ? 1 : 0);
  if (centralEn(pasos[pasos.length - 1]) > centralEn(pasos[0])) pasos = pasos.reverse().map(invertir);
  const tramos = pasos.filter((x) => x.tipo === 'tramo');
  const uniones = pasos.filter((x) => x.tipo === 'union');
  return {
    pasos,
    metros: tramos.reduce((s, x) => s + x.metros, 0),
    fusiones: uniones.filter((x) => x.fusion.tipo !== 'conector').length,
    conectores: uniones.filter((x) => x.fusion.tipo === 'conector').length,
    splitters: pasos.filter((x) => x.tipo === 'equipo').map((x) => state.equipos.get(x.equipo)).filter(Boolean),
    lineas: tramos.map((x) => x.coords),
    // Cada tramo con el color de su fibra (y el de su tubo, si el cable tiene varios).
    segmentos: tramos.map((x) => ({ coords: x.coords, ...coloresDeTramo(state, x) })),
  };
}

// El color de la fibra que lleva un tramo y el de su tubo (null con un solo tubo).
export function coloresDeTramo(state, tramo) {
  const cable = state.cables.get(tramo.cable);
  if (!cable) return { color: null, tubo: null };
  const info = infoFibra(cable.properties, tramo.fibra);
  return { color: info.color, tubo: info.tubos > 1 ? info.colorTubo : null };
}

// ------------------------------------------------------------- potencias

// Pérdidas para estimar (valores de planificación, no de medición): fibra en
// 1490 nm, la bajada de GPON; una fusión; un conector (par SC); los splitters
// PLC según cuántas salidas tienen y los desbalanceados según el porcentaje de
// cada salida. Es una guía para comparar con lo medido, no un reemplazo.
export const PERDIDAS = { fibraKm: 0.3, fusion: 0.1, conector: 0.5, excesoFbt: 0.3, entradaDoble: 0.3 };
const PLC_DB = { 2: 3.8, 4: 7.2, 8: 10.5, 16: 13.8, 32: 17.1, 64: 20.5, 128: 24 };

// Lo que pierde una salida de un splitter (dB), o null si no se sabe.
export function perdidaSplitter(eq, salida) {
  const datos = eq?.datos ?? {};
  if (datos.modo === 'fbt') {
    const [x, y] = String(datos.relacion ?? '').split('/').map(Number);
    const pct = salida === 2 ? y : x;
    if (!(pct > 0 && pct < 100)) return null;
    return -10 * Math.log10(pct / 100) + PERDIDAS.excesoFbt;
  }
  const base = PLC_DB[Number(eq?.salidas)];
  if (base === undefined) return null;
  return base + (Number(eq?.entradas) > 1 ? PERDIDAS.entradaDoble : 0);
}

// Pérdida de cada paso de un recorrido y lo acumulado desde su comienzo (la
// central, si se llega). Si el recorrido sale de una OLT con su potencia
// cargada, también la potencia estimada después de cada paso. Llegar a un
// cliente suma el conector de la ONT.
export function potencias(state, resultado) {
  const pasos = resultado.pasos;
  const primero = pasos[0];
  const olt = primero?.motivo === 'olt' ? state.equipos.get(primero.equipo) ?? null : null;
  const inicial = Number.isFinite(olt?.datos?.potencia) ? olt.datos.potencia : null;
  let acumulada = 0;
  let incompleta = false;
  const porPaso = pasos.map((paso) => {
    let perdida = 0;
    if (paso.tipo === 'tramo') perdida = (paso.metros / 1000) * PERDIDAS.fibraKm;
    else if (paso.tipo === 'union') perdida = paso.fusion.tipo === 'conector' ? PERDIDAS.conector : PERDIDAS.fusion;
    else if (paso.tipo === 'equipo') {
      const eq = state.equipos.get(paso.equipo);
      const salida = [paso.de, paso.a].map(parseExtremo).find((x) => x?.lado === 's');
      const l = eq ? perdidaSplitter(eq, salida?.n) : null;
      if (l === null) incompleta = true;
      else perdida = l;
    } else if (paso.tipo === 'fin' && paso.motivo === 'cliente') perdida = PERDIDAS.conector;
    acumulada += perdida;
    return { perdida, acumulada, potencia: inicial === null ? null : inicial - acumulada };
  });
  return { porPaso, total: acumulada, olt, inicial, llega: inicial === null ? null : inicial - acumulada, incompleta };
}

// Hasta dónde llega lo que sale de un extremo (por su unión): el último paso.
export function destino(state, elementoId, ext) {
  const idx = indice(state);
  if (!idx.usado.has(`${elementoId}|${ext}`)) return null;
  const pasos = seguir(state, idx, elementoId, ext, 'union', new Set());
  return pasos[pasos.length - 1] ?? null;
}

// La conexión de un cliente: sigue la fibra 1 de su bajada hasta la primera
// unión (la NAP, casi siempre) y dice hasta dónde llega el pelo.
export function conexionCliente(state, cliente) {
  const idx = indice(state);
  for (const cable of idx.cablesEn.get(cliente.id) ?? []) {
    for (const lado of ladosEn(cable.properties.nodos, cliente.id)) {
      const ext = extremoCable(cable.id, lado, 1);
      const pasos = seguir(state, idx, cliente.id, ext, 'adentro', new Set());
      const union = pasos.find((x) => x.tipo === 'union');
      if (union) return { cable, ext, union, origen: pasos[pasos.length - 1] };
    }
  }
  return null;
}

// Los clientes de cada caja según las cartas: caja -> [clientes] cuya bajada tiene
// su primera unión en esa caja. Se calcula una vez por estado de la red.
export function clientesPorCaja(state) {
  const idx = indice(state);
  if (idx.clientesPorCaja) return idx.clientesPorCaja;
  const out = new Map();
  for (const e of state.elementos.values()) {
    if (e.properties.tipo !== 'cliente') continue;
    const caja = conexionCliente(state, e)?.union.elemento;
    if (caja === undefined) continue;
    if (!out.has(caja)) out.set(caja, []);
    out.get(caja).push(e.id);
  }
  idx.clientesPorCaja = out;
  return out;
}

export const nombreElemento = (state, id) => {
  const e = state.elementos.get(id);
  if (!e) return 'un elemento borrado';
  return e.properties.nombre || ELEMENTOS[e.properties.tipo]?.nombre || e.properties.tipo;
};

// ---------------------------------------------------------------- señal

// Qué tiene luz según las cartas de empalme. Desde cada puerto PON unido de cada
// OLT, la luz cruza las uniones, sigue por las fibras (de largo por donde pasan sin
// cortar) y se abre en las salidas de los splitters. De cada tramo de fibra con luz
// se sabe hacia dónde va (de `ini` a `fin`, los puntos del cable), la pérdida y la
// potencia estimadas al entrar y al llegar, de qué OLT y puerto viene y qué clientes
// quedan abajo. Se calcula una vez por estado de la red.
//
//   tramos     [{ cable, fibra, desde, hasta, ini, fin, metros, coords, perdida,
//                 perdidaFin, potencia, potenciaFin, raiz, clientes, termina }]
//   extremos   `${elemento}|${extremo}` -> { sentido: sale | llega | entra | paso,
//                 perdida, potencia, raiz, clientes, incompleta }
//   clientes   cliente -> { perdida, potencia, raiz } (con el conector de la ONT)
//   puertos    `${equipo}:${n}` -> el puerto PON (raíz): { olt, puerto, potencia0, clientes }
//   porCable   cable -> [tramos]
//   porElemento elemento -> [extremos con luz en ese elemento]
//   conflictos [{ elemento, ext, motivo }]: dos-fuentes | otra-olt | contramano
export function iluminacion(state) {
  const idx = indice(state);
  if (idx.luz) return idx.luz;
  const km = PERDIDAS.fibraKm / 1000;
  const tramos = [];
  const extremos = new Map();
  const clientes = new Map();
  const puertos = new Map();
  const porCableLuz = new Map();
  const porElemento = new Map();
  const conflictos = [];
  const anotar = (reg) => {
    if (!porElemento.has(reg.elemento)) porElemento.set(reg.elemento, []);
    porElemento.get(reg.elemento).push(reg);
  };
  const cola = [];
  const conPotencia = (raiz, perdida) => (raiz.potencia0 === null ? null : raiz.potencia0 - perdida);

  // Un extremo con luz; null si ya tenía (de otra fuente o por un lazo): por ahí no se sigue.
  function marcar(elemento, ext, sentido, perdida, padre, raiz, incompleta = false) {
    const clave = `${elemento}|${ext}`;
    const previo = extremos.get(clave);
    if (previo) {
      if (previo.raiz !== raiz) conflictos.push({ elemento, ext, motivo: 'dos-fuentes' });
      return null;
    }
    const reg = {
      tipo: 'extremo', elemento, ext, sentido, perdida, potencia: conPotencia(raiz, perdida), padre, raiz,
      // Lo que pasa de largo tiene abajo lo mismo que su tramo.
      clientes: sentido === 'paso' ? padre.clientes : new Set(),
      incompleta: incompleta || Boolean(padre?.incompleta),
    };
    extremos.set(clave, reg);
    anotar(reg);
    return reg;
  }

  for (const eq of [...state.equipos.values()].sort((a, b) => a.id - b.id)) {
    if (eq.tipo !== 'olt' || !state.elementos.has(eq.elemento)) continue;
    const potencia0 = Number.isFinite(eq.datos?.potencia) ? eq.datos.potencia : null;
    for (let n = 1; n <= eq.salidas; n += 1) {
      const ext = extremoEquipo(eq.id, 's', n);
      if (!idx.usado.has(`${eq.elemento}|${ext}`)) continue;
      const raiz = {
        tipo: 'extremo', elemento: eq.elemento, ext, sentido: 'sale', perdida: 0, potencia: potencia0, padre: null,
        olt: eq.id, puerto: n, potencia0, clientes: new Set(), incompleta: false,
      };
      raiz.raiz = raiz;
      extremos.set(`${eq.elemento}|${ext}`, raiz);
      anotar(raiz);
      puertos.set(`${eq.id}:${n}`, raiz);
      cola.push({ elemento: eq.elemento, ext, direccion: 'union', reg: raiz });
    }
  }

  for (let i = 0; i < cola.length; i += 1) {
    const { elemento, ext, direccion, reg } = cola[i];
    const { raiz } = reg;
    if (direccion === 'union') {
      const f = idx.usado.get(`${elemento}|${ext}`);
      if (!f) continue;
      const otro = f.a === ext ? f.b : f.a;
      const p = parseExtremo(otro);
      const perdida = reg.perdida + (f.tipo === 'conector' ? PERDIDAS.conector : PERDIDAS.fusion);
      const sentido = p?.tipo === 'c' ? 'sale' : 'entra';
      const siguiente = marcar(elemento, otro, sentido, perdida, reg, raiz);
      if (siguiente) cola.push({ elemento, ext: otro, direccion: 'adentro', reg: siguiente });
      continue;
    }
    const p = parseExtremo(ext);
    if (p?.tipo === 'c') {
      const cable = state.cables.get(p.id);
      if (!cable) continue;
      const r = porCable(state, idx, cable, elemento, p.lado, p.n);
      const t = r.tramo;
      const perdidaFin = reg.perdida + t.metros * km;
      const tramo = {
        tipo: 'tramo', cable: p.id, fibra: p.n, desde: elemento, hasta: t.hasta, ini: t.ini, fin: t.fin, metros: t.metros,
        coords: t.coords, pasaPor: t.pasaPor, perdida: reg.perdida, perdidaFin, potencia: reg.potencia,
        potenciaFin: conPotencia(raiz, perdidaFin), padre: reg, raiz, clientes: new Set(), incompleta: reg.incompleta,
        termina: r.siguiente ? 'union' : r.fin?.motivo ?? null,
      };
      tramos.push(tramo);
      if (!porCableLuz.has(p.id)) porCableLuz.set(p.id, []);
      porCableLuz.get(p.id).push(tramo);
      const llegada = otroLado(p.lado);
      t.pasaPor.forEach((x, k) => {
        const perdida = reg.perdida + t.pasaPorM[k] * km;
        marcar(x, extremoCable(p.id, llegada, p.n), 'paso', perdida, tramo, raiz);
        marcar(x, extremoCable(p.id, p.lado, p.n), 'paso', perdida, tramo, raiz);
      });
      if (r.siguiente) {
        const llega = marcar(r.siguiente.elemento, r.siguiente.ext, 'llega', perdidaFin, tramo, raiz);
        if (llega) cola.push({ elemento: r.siguiente.elemento, ext: r.siguiente.ext, direccion: 'union', reg: llega });
      } else if (r.fin?.motivo === 'cliente') {
        const cliente = r.fin.elemento;
        if (clientes.has(cliente)) {
          conflictos.push({ elemento: cliente, ext: null, motivo: 'dos-fuentes' });
        } else {
          const perdida = perdidaFin + PERDIDAS.conector;
          clientes.set(cliente, {
            tipo: 'cliente', elemento: cliente, perdida, potencia: conPotencia(raiz, perdida), padre: tramo, raiz, incompleta: tramo.incompleta,
          });
        }
      } else if (t.hasta !== null) {
        // La luz llega hasta acá y no sigue: la fibra no está unida (o está cortada de este lado).
        marcar(t.hasta, extremoCable(p.id, llegada, p.n), 'llega', perdidaFin, tramo, raiz);
      }
      continue;
    }
    const eq = p ? state.equipos.get(p.id) : null;
    if (!eq) continue;
    if (eq.tipo === 'olt') {
      conflictos.push({ elemento, ext, motivo: 'otra-olt' });
      continue;
    }
    if (p.lado === 's') {
      // Entra luz por una salida: el splitter está al revés (o la luz llega de dos lados).
      conflictos.push({ elemento, ext, motivo: 'contramano' });
      continue;
    }
    for (let s = 1; s <= eq.salidas; s += 1) {
      const l = perdidaSplitter(eq, s);
      const salida = extremoEquipo(eq.id, 's', s);
      const r = marcar(elemento, salida, 'sale', reg.perdida + (l ?? 0), reg, raiz, l === null);
      if (r && idx.usado.has(`${elemento}|${salida}`)) cola.push({ elemento, ext: salida, direccion: 'union', reg: r });
    }
  }

  // Cada cliente cuenta para todo lo que tiene arriba, hasta su puerto PON.
  for (const llegada of clientes.values()) {
    for (let x = llegada.padre; x; x = x.padre) x.clientes.add(llegada.elemento);
  }

  const out = { rev: state.rev, tramos, extremos, clientes, puertos, porCable: porCableLuz, porElemento, conflictos, segmentos: null };
  idx.luz = out;
  return out;
}

// Dónde se juntan los recorridos de la luz de varios clientes: el elemento (caja,
// botella o nodo) más cercano a ellos por el que pasa la luz de todos. Si cayeron
// juntos, el problema está ahí o antes. Devuelve null si ninguno tiene luz en el
// mapa; si no, { elemento, conLuz (cuántos de la lista tienen luz), abajo (cuántos
// clientes cuelgan de ese elemento por esas fibras), todos (no cuelga nadie más
// que los de la lista), cable (el cable por el que le llega la luz, si es uno solo) }.
export function comunDeClientes(state, ids) {
  const luz = iluminacion(state);
  const cadenas = [];
  for (const id of ids) {
    const llegada = luz.clientes.get(id);
    if (!llegada) continue;
    const cadena = []; // del cliente hacia la OLT: [{ elemento, regs }]
    for (let reg = llegada.padre; reg; reg = reg.padre) {
      if (reg.tipo !== 'extremo') continue;
      if (cadena.at(-1)?.elemento === reg.elemento) cadena.at(-1).regs.push(reg);
      else cadena.push({ elemento: reg.elemento, regs: [reg] });
    }
    cadenas.push(cadena.reverse());
  }
  if (!cadenas.length) return null;
  let nivel = -1;
  while (cadenas[0][nivel + 1] && cadenas.every((c) => c[nivel + 1]?.elemento === cadenas[0][nivel + 1].elemento)) nivel += 1;
  if (nivel < 0) return null; // salen de nodos distintos
  const lista = new Set(ids);
  const abajo = new Set();
  const cables = new Set();
  for (const c of cadenas) {
    // El primer registro de la luz en ese elemento (por donde entra): lo de abajo y el cable que la trae.
    const entrada = c[nivel].regs.at(-1);
    for (const cliente of entrada.clientes) abajo.add(cliente);
    cables.add(entrada.padre?.tipo === 'tramo' ? entrada.padre.cable : null);
  }
  return {
    elemento: cadenas[0][nivel].elemento,
    conLuz: cadenas.length,
    abajo: abajo.size,
    todos: [...abajo].every((cliente) => lista.has(cliente)),
    cable: cables.size === 1 ? [...cables][0] : null,
  };
}

// Los tramos con luz partidos en segmentos (de un elemento con carta o un cliente al
// siguiente), para dibujarlos: cada segmento con sus puntos (desde, hasta), su
// sentido (1: en el orden de los puntos del cable; -1: al revés), las fibras con luz
// que van en ese sentido y los clientes que quedan abajo.
export function segmentosConLuz(state) {
  const luz = iluminacion(state);
  if (luz.segmentos) return luz.segmentos;
  const cortesDe = new Map();
  const cortes = (cable) => {
    if (!cortesDe.has(cable.id)) {
      const nodos = cable.properties.nodos ?? [];
      const out = [0];
      for (let i = 1; i < nodos.length - 1; i += 1) {
        const tipo = nodos[i] === null ? null : state.elementos.get(nodos[i])?.properties.tipo;
        if (CON_CARTA.has(tipo) || tipo === 'cliente') out.push(i);
      }
      if (nodos.length > 1) out.push(nodos.length - 1);
      cortesDe.set(cable.id, out);
    }
    return cortesDe.get(cable.id);
  };
  const porClave = new Map();
  for (const t of luz.tramos) {
    const cable = state.cables.get(t.cable);
    if (!cable || t.ini === null || t.fin === null || t.ini === t.fin) continue;
    const c = cortes(cable);
    const sentido = t.fin > t.ini ? 1 : -1;
    const lo = Math.min(t.ini, t.fin);
    const hi = Math.max(t.ini, t.fin);
    for (let s = 0; s < c.length - 1; s += 1) {
      if (c[s] < lo || c[s + 1] > hi) continue;
      const clave = `${t.cable}:${s}:${sentido}`;
      let seg = porClave.get(clave);
      if (!seg) {
        seg = { cable: t.cable, segmento: s, desde: c[s], hasta: c[s + 1], sentido, fibras: new Set(), clientes: new Set(), tramos: [] };
        porClave.set(clave, seg);
      }
      seg.fibras.add(t.fibra);
      for (const x of t.clientes) seg.clientes.add(x);
      seg.tramos.push(t);
    }
  }
  luz.segmentos = [...porClave.values()];
  return luz.segmentos;
}

// El sentido de la red en los cables sin luz: del nodo hacia afuera, según la
// distancia por los cables (cada tramo entre dos elementos va del más cercano a un
// nodo al más lejano). Tramos seguidos en el mismo sentido van juntos. Lo que no
// llega a ningún nodo, y las puntas sueltas, quedan sin sentido.
export function sentidoDeRed(state) {
  const luz = iluminacion(state);
  const dist = distanciasANodos(state);
  const out = [];
  for (const c of state.cables.values()) {
    if (luz.porCable.has(c.id)) continue;
    const nodos = c.properties.nodos ?? [];
    const marcas = [];
    nodos.forEach((id, i) => {
      if (id !== null && dist.has(id)) marcas.push(i);
    });
    let tramo = null;
    for (let k = 1; k < marcas.length; k += 1) {
      const a = marcas[k - 1];
      const b = marcas[k];
      const da = dist.get(nodos[a]);
      const db = dist.get(nodos[b]);
      const sentido = db > da ? 1 : db < da ? -1 : 0;
      if (tramo && tramo.sentido === sentido && tramo.hasta === a) {
        tramo.hasta = b;
      } else {
        if (tramo?.sentido) out.push(tramo);
        tramo = { cable: c.id, desde: a, hasta: b, sentido };
      }
    }
    if (tramo?.sentido) out.push(tramo);
  }
  return out;
}

// Cómo está lo que queda abajo de un punto con luz, según el estado de las ONT de
// sus clientes (estados: cliente -> { estado }): con tráfico (alguna en línea),
// caída (ninguna en línea y alguna sin señal) o solo con luz (sin datos).
export function estadoAbajo(clientes, estados) {
  let enLinea = 0;
  let caidos = 0;
  for (const id of clientes ?? []) {
    const e = estados?.get(id)?.estado;
    if (!e) continue;
    if (e === 'online') enLinea += 1;
    else caidos += 1;
  }
  const total = clientes?.size ?? 0;
  return {
    estado: enLinea ? 'trafico' : caidos ? 'caida' : 'luz',
    clientes: total,
    enLinea,
    caidos,
    sinDato: total - enLinea - caidos,
  };
}

const numeroComa = (x) => Math.abs(x).toFixed(1).replace('.', ',');

// "≈ −14,2 dBm" si la OLT tiene cargada su potencia; si no, lo que se perdió desde ella.
export function textoPotencia(reg) {
  if (!reg) return '';
  const aprox = reg.incompleta ? ' (falta la pérdida de un splitter)' : '';
  if (Number.isFinite(reg.potencia)) return `≈ ${reg.potencia < -0.05 ? '−' : ''}${numeroComa(reg.potencia)} dBm${aprox}`;
  return `${numeroComa(reg.perdida)} dB perdidos desde la OLT${aprox}`;
}

// "OLT-1 PON 3": de dónde viene la luz de un punto.
export function origenLuz(state, reg) {
  const raiz = reg?.raiz;
  const eq = raiz ? state.equipos.get(raiz.olt) : null;
  return eq ? etiquetaPuerto(eq, 's', raiz.puerto) : 'una OLT';
}

// "8 clientes abajo, 7 en línea"
export function textoAbajo(abajo) {
  if (!abajo?.clientes) return 'sin clientes abajo';
  const partes = [`${abajo.clientes} cliente${abajo.clientes === 1 ? '' : 's'} abajo`];
  if (abajo.enLinea || abajo.caidos) {
    partes.push(`${abajo.enLinea} en línea`);
    if (abajo.caidos) partes.push(`${abajo.caidos} sin señal`);
  }
  return partes.join(', ');
}
