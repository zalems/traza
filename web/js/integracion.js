// Wispro y el panel de la OLT en las fichas: qué lectura vale para cada ONT, la
// medición virtual de la potencia en las bocas de una NAP y la estabilidad.
// Son solo cuentas sobre lo que trae /api/integracion: la ficha las muestra.

import * as F from './fibras.js';
import { evaluarPotencia } from './modelo.js';

const MINUTO = 60 * 1000;
const DIA = 24 * 60 * MINUTO;
export const VIEJO_MS = 30 * MINUTO; // lecturas del panel más viejas que esto: se avisa
export const DESVIO_DB = 3; // una ONT, o la caja contra la carta, con esta diferencia: se avisa
const VENTANA_JUNTAS_MS = 3 * MINUTO; // caídas de varias ONTs dentro de esta ventana: juntas
const SEMANA_CASI = 6.5 * DIA; // una serie que empieza antes que esto cuenta como "los últimos 7 días"
const TENDENCIA_MIN = 2 * DIA; // con menos datos, una tendencia "por semana" exagera cualquier variación
const CAIDA = /down|offline|\blos\b|lost|gasp|fail|ca[ií]da/i;

export const tiempo = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isNaN(t) ? null : t;
};

const mediana = (valores) => {
  const v = [...valores].sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

function metros([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180;
  const h = Math.sin(((lat2 - lat1) * r) / 2) ** 2
    + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Una ONT fuera de línea puede conservar la última potencia que tuvo: no vale
// como lectura actual (queda en rx_ultima).
const sinSenal = (m) => (m && m.estado && m.estado !== 'online' && m.rx !== null && m.rx !== undefined
  ? { ...m, rx_ultima: m.rx, rx: null } : m);

// La lectura más nueva de la ONT de un contrato: la que guardó el panel de la
// OLT o la medición en vivo que se pidió por Wispro.
export function medidaVigente(c) {
  const panel = c?.medida ?? null;
  const vivo = c?.vivo && !c.vivo.error ? c.vivo : null;
  if (!vivo) return sinSenal(panel);
  if (panel && (tiempo(panel.cuando) ?? 0) > (tiempo(vivo.cuando) ?? 0)) return sinSenal(panel);
  if (Number.isFinite(vivo.rx)) return { ...(panel ?? {}), ...vivo, estado: 'online' };
  // En vivo sin potencia: la ONT no responde, aunque el panel la haya visto en línea
  // hace un rato (lo que tenía queda en rx_ultima; la causa del panel, si ya estaba caída).
  const panelCaida = Boolean(panel?.estado && panel.estado !== 'online');
  return {
    ...(panel ?? {}),
    ...vivo,
    estado: 'offline',
    causa: panelCaida ? panel.causa ?? null : null,
    rx_ultima: Number.isFinite(panel?.rx) ? panel.rx : panel?.rx_ultima ?? null,
  };
}

// Cómo está la potencia de una lectura: con el criterio del panel si lo trae,
// si no con el de traza.
export function nivelDe(m) {
  if (!m) return null;
  if (!Number.isFinite(m.rx)) {
    return m.estado && m.estado !== 'online' ? { texto: 'sin señal', nivel: 'mal' } : null;
  }
  const e = String(m.rx_estado ?? '').toLowerCase();
  if (e === 'ok' || e === 'normal') return { texto: 'buena', nivel: 'bien' };
  if (e.startsWith('warn')) return { texto: 'justa', nivel: 'atencion' };
  if (e.startsWith('crit') || e === 'low') return { texto: 'baja', nivel: 'mal' };
  if (e === 'high') return { texto: 'alta: puede saturar la ONT', nivel: 'mal' };
  return evaluarPotencia(m.rx);
}

// El splitter de una NAP del que salen las bajadas (si hay varios, el de más salidas).
function splitterDe(state, nap) {
  const equipos = (F.indice(state).equiposEn.get(nap.id) ?? []).filter((e) => e.tipo === 'splitter');
  return equipos.length ? equipos.reduce((a, b) => (b.salidas > a.salidas ? b : a)) : null;
}

// Lo que estima la carta en las bocas de la NAP: la potencia que llega a la
// entrada de su splitter menos lo que pierde el splitter. null si la carta no
// llega a una OLT con su potencia cargada.
export function estimadaEnBocas(state, nap) {
  const spl = splitterDe(state, nap);
  if (!spl) return null;
  const res = F.recorrido(state, nap.id, F.extremoEquipo(spl.id, 'e', 1));
  const pot = F.potencias(state, res);
  const l = F.perdidaSplitter(spl, 1);
  if (pot.llega === null || pot.incompleta || l === null) return null;
  return pot.llega - l;
}

const BAJADA_TIPICA_M = 150; // si la ubicación de Wispro queda muy lejos, se toma esto
const BAJADA_MAXIMA_M = 1000;

// Lo que se pierde de la boca de la NAP a la ONT de un contrato: por la carta si
// el cliente está dibujado y su bajada sale de esta caja; si no, lo típico (el
// conector de la boca, el de la ONT y la fibra en línea recta con un 20 % más).
export function perdidaBajada(state, nap, c) {
  const cli = c.traza?.id ? state.elementos.get(c.traza.id) : null;
  const con = cli ? F.conexionCliente(state, cli) : null;
  if (con && con.union.elemento === nap.id) {
    const res = F.recorrido(state, cli.id, con.ext);
    const pot = F.potencias(state, res);
    // El recorrido se lee desde la OLT si llega; si la carta todavía no llega, desde
    // el cliente: se suma lo que hay entre el splitter de la caja más cercano al
    // cliente (si la caja tiene dos en cascada, el de la bajada) y el cliente.
    const j = res.pasos.findIndex((p) => p.tipo === 'fin' && p.motivo === 'cliente');
    const enCaja = (p) => p.tipo === 'equipo' && p.elemento === nap.id;
    const antes = res.pasos.findLastIndex((p, k) => k < j && enCaja(p));
    const i = antes >= 0 ? antes : res.pasos.findIndex((p, k) => k > j && enCaja(p));
    if (i >= 0 && j >= 0) {
      const [desde, hasta] = j > i ? [i + 1, j] : [j, i - 1];
      let perdida = 0;
      for (let k = desde; k <= hasta; k += 1) perdida += pot.porPaso[k].perdida;
      return { perdida, exacta: true, estimada: j > i ? pot.porPaso[i].potencia : null };
    }
  }
  const spl = splitterDe(state, nap);
  const boca = spl && spl.datos?.conectores === false ? F.PERDIDAS.fusion : F.PERDIDAS.conector;
  let d = c.ubicacion ? metros(nap.geometry.coordinates, c.ubicacion) * 1.2 : BAJADA_TIPICA_M;
  if (d > BAJADA_MAXIMA_M) d = BAJADA_TIPICA_M; // una ubicación de Wispro equivocada no cuenta
  return { perdida: boca + F.PERDIDAS.conector + (d / 1000) * F.PERDIDAS.fibraKm, exacta: false, estimada: null };
}

// La medición virtual de la potencia en las bocas de la NAP: la de cada ONT más
// lo que pierde su bajada. La caja vale la mediana; las que quedan muy por debajo
// del resto apuntan a su bajada o a sus conectores.
export function medicionVirtual(state, nap, contratos) {
  const filas = [];
  for (const c of contratos ?? []) {
    const m = medidaVigente(c);
    if (!m || !Number.isFinite(m.rx)) continue;
    const b = perdidaBajada(state, nap, c);
    filas.push({ id: c.id, cliente: c.cliente, rx: m.rx, perdida: b.perdida, boca: m.rx + b.perdida, exacta: b.exacta,
      estimada: b.estimada, fuente: m.fuente });
  }
  if (!filas.length) return null;
  const boca = mediana(filas.map((f) => f.boca));
  const porCliente = filas.map((f) => f.estimada).filter(Number.isFinite);
  const estimada = porCliente.length ? mediana(porCliente) : estimadaEnBocas(state, nap);
  return {
    filas,
    boca,
    min: Math.min(...filas.map((f) => f.boca)),
    max: Math.max(...filas.map((f) => f.boca)),
    bajas: filas.length >= 3 ? filas.filter((f) => f.boca < boca - DESVIO_DB) : [],
    estimada,
    diferencia: Number.isFinite(estimada) ? boca - estimada : null,
    exactas: filas.filter((f) => f.exacta).length,
  };
}

// Cuánto abarca la serie de una ONT (el panel pudo haber dejado de leer un tiempo).
export function lapsoSerie(tend) {
  const d = tiempo(tend?.desde);
  const h = tiempo(tend?.hasta);
  return d !== null && h !== null && h >= d ? h - d : null;
}

// La tendencia por semana, solo si la serie alcanza para sacarla (si no, null).
export function ritmoSemanal(tend) {
  const l = lapsoSerie(tend);
  return Number.isFinite(tend?.db_semana) && (l === null || l >= TENDENCIA_MIN) ? tend.db_semana : null;
}

// Si lo leído cubre la semana: si la serie empieza hace poco (el panel estuvo sin
// leer), el visor dice "desde el …" en vez de "en los últimos 7 días".
export const semanaCompleta = (desde, ahora = Date.now()) => desde === null || desde === undefined || ahora - desde >= SEMANA_CASI;

// Caídas, potencia que varía o que viene bajando, en los últimos 7 días, y las
// ONTs que hoy están fuera de línea. desde: dónde empieza la serie más corta.
export function estabilidad(contratos, ahora = Date.now()) {
  const desde = ahora - 7 * DIA;
  const caidas = [];
  const inestables = [];
  const bajando = [];
  let conHistoria = 0;
  let desdeSerie = null;
  const vistas = new Set();
  for (const c of contratos ?? []) {
    const h = c.historia;
    if (h) conHistoria += 1;
    const ont = c.medida?.panel_id ?? c.medida?.sn ?? c.id;
    if (vistas.has(ont)) continue; // la misma ONT en dos contratos se cuenta una vez
    vistas.add(ont);
    for (const e of h?.eventos ?? []) {
      const t = tiempo(e.cuando);
      if (t !== null && t >= desde && CAIDA.test(e.tipo ?? '')) caidas.push({ id: ont, cliente: c.cliente, t, causa: e.causa });
    }
    // La última caída que informa el panel, si los eventos no la traen.
    const t = tiempo(c.medida?.ultima_caida);
    if (t !== null && t >= desde && !caidas.some((x) => x.id === ont && Math.abs(x.t - t) < 5 * MINUTO)) {
      caidas.push({ id: ont, cliente: c.cliente, t, causa: c.medida.causa });
    }
    const tend = h?.tendencia;
    const inicio = tend?.muestras > 0 ? tiempo(tend.desde) : null;
    if (inicio !== null && (desdeSerie === null || inicio > desdeSerie)) desdeSerie = inicio;
    if (Number.isFinite(tend?.rx_min) && Number.isFinite(tend?.rx_max) && tend.rx_max - tend.rx_min >= 2) {
      inestables.push({ id: c.id, cliente: c.cliente, rango: tend.rx_max - tend.rx_min });
    }
    const ritmo = ritmoSemanal(tend);
    if (ritmo !== null && ritmo <= -0.5) bajando.push({ id: c.id, cliente: c.cliente, ritmo });
  }
  caidas.sort((a, b) => a.t - b.t);
  const grupos = [];
  for (const x of caidas) {
    const g = grupos.at(-1);
    if (g && x.t - g.desde <= VENTANA_JUNTAS_MS) g.items.push(x);
    else grupos.push({ desde: x.t, items: [x] });
  }
  const juntas = grupos.filter((g) => new Set(g.items.map((x) => x.id)).size >= 2);
  const conLectura = (contratos ?? []).filter((c) => medidaVigente(c));
  const fuera = conLectura.filter((c) => {
    const m = medidaVigente(c);
    return !Number.isFinite(m.rx) && m.estado && m.estado !== 'online';
  });
  return { caidas, juntas, inestables, bajando, fuera, conLectura: conLectura.length, conHistoria, desde: desdeSerie };
}

// Los puertos PON donde están las ONTs de la caja: { '0/19/3': 6, ... }.
export function puertosPon(contratos) {
  const out = new Map();
  for (const c of contratos ?? []) {
    const m = medidaVigente(c);
    if (m?.interfaz) out.set(m.interfaz, (out.get(m.interfaz) ?? 0) + 1);
  }
  return out;
}

// Cuánto hace de una lectura, en palabras: "hace 3 min", "hace 2 h", "hace 8 días".
export function haceCuanto(iso, ahora = Date.now()) {
  const t = tiempo(iso);
  if (t === null) return '';
  const s = Math.max(0, ahora - t);
  if (s < MINUTO) return 'recién';
  if (s < 60 * MINUTO) return `hace ${Math.round(s / MINUTO)} min`;
  if (s < 2 * DIA) return `hace ${Math.round(s / (60 * MINUTO))} h`;
  return `hace ${Math.round(s / DIA)} días`;
}

export const viejo = (iso, ahora = Date.now()) => {
  const t = tiempo(iso);
  return t !== null && ahora - t > VIEJO_MS;
};
