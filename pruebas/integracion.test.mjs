// Pruebas de las cuentas de Wispro y del panel de la OLT en el visor
// (web/js/integracion.js): qué lectura vale, la medición virtual en las bocas de
// una NAP y la estabilidad. Sin navegador:
//   node pruebas/integracion.test.mjs      (Node 20.19 o más nuevo)
import assert from 'node:assert/strict';
import * as F from '../web/js/fibras.js';
import * as I from '../web/js/integracion.js';

const cerca = (a, b, tol = 0.05) => assert.ok(Math.abs(a - b) <= tol, `${a} no está cerca de ${b}`);
const el = (id, tipo, nombre, lon, lat) => ({ type: 'Feature', id, geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { id, tipo, nombre, carta: {}, datos: {}, version: 1 } });
const cab = (id, nombre, tipo, fibras, puntos) => ({
  type: 'Feature', id,
  geometry: { type: 'LineString', coordinates: puntos.map((p) => p.geometry.coordinates) },
  properties: { id, nombre, tipo, fibras, por_tubo: 0, colores: 'tia598', nodos: puntos.map((p) => p.id), version: 1 },
});

// NODO (OLT de 5 dBm) — troncal — NAP (splitter 1x8 con conectores) — bajada — cliente.
const nodo = el(1, 'nodo', 'NODO', -58.170, -26.180);
const nap = el(2, 'nap', 'NAP-1', -58.166, -26.180);
const cli = el(3, 'cliente', 'Gómez Ana', -58.166, -26.179);
const T = cab(10, 'T', 'troncal', 12, [nodo, nap]);
const D = cab(11, 'D', 'bajada', 1, [nap, cli]);
const state = {
  rev: 1,
  elementos: new Map([nodo, nap, cli].map((e) => [e.id, e])),
  cables: new Map([T, D].map((c) => [c.id, c])),
  equipos: new Map([
    [20, { id: 20, elemento: 1, tipo: 'olt', nombre: 'OLT-1', entradas: 0, salidas: 16, datos: { potencia: 5 }, version: 1 }],
    [21, { id: 21, elemento: 2, tipo: 'splitter', nombre: 'SPL', entradas: 1, salidas: 8, datos: { modo: 'plc', conectores: true }, version: 1 }],
  ]),
  fusiones: new Map([
    [30, { id: 30, elemento: 1, a: 'q20:s:1', b: 'c10:b:1', tipo: 'fusion', version: 1 }],
    [31, { id: 31, elemento: 2, a: 'c10:a:1', b: 'q21:e:1', tipo: 'fusion', version: 1 }],
    [32, { id: 32, elemento: 2, a: 'q21:s:1', b: 'c11:b:1', tipo: 'conector', version: 1 }],
  ]),
};

// La carta: 5 dBm − troncal (≈400 m, 0,12 dB) − 2 fusiones (0,2) − splitter 1x8 (10,5).
const largoT = F.recorrido(state, 2, 'q21:e:1').metros; // solo la troncal
const enBocas = 5 - (largoT / 1000) * 0.3 - 0.2 - 10.5;
cerca(I.estimadaEnBocas(state, nap), enBocas, 0.001);

// Lectura vigente: el panel o la medición en vivo, la más nueva.
const panel = { fuente: 'panel', rx: -21, estado: 'online', cuando: '2026-10-14T10:00:00Z', interfaz: '0/19/3', panel_id: 5 };
const vivo = { fuente: 'wispro', rx: -20.4, cuando: '2026-10-14T11:00:00Z', interfaz: '0/19/3' };
assert.equal(I.medidaVigente({ medida: panel }).rx, -21);
assert.equal(I.medidaVigente({ medida: panel, vivo }).rx, -20.4);
assert.equal(I.medidaVigente({ medida: panel, vivo }).panel_id, 5); // conserva lo del panel
assert.equal(I.medidaVigente({ medida: { ...panel, cuando: '2026-10-14T12:00:00Z' }, vivo }).rx, -21);
assert.equal(I.medidaVigente({ medida: panel, vivo: { error: 'sin ONT' } }).rx, -21);
assert.equal(I.medidaVigente({ vivo }).estado, 'online');
assert.equal(I.medidaVigente({}), null);

// Nivel: el criterio del panel si lo trae.
assert.equal(I.nivelDe({ rx: -26, rx_estado: 'ok' }).texto, 'buena');
assert.equal(I.nivelDe({ rx: -26, rx_estado: 'warning' }).nivel, 'atencion');
assert.equal(I.nivelDe({ rx: -29, rx_estado: 'critical' }).nivel, 'mal');
assert.equal(I.nivelDe({ rx: -5, rx_estado: 'high' }).texto, 'alta: puede saturar la ONT');
assert.equal(I.nivelDe({ rx: null, estado: 'offline' }).texto, 'sin señal');
assert.equal(I.nivelDe({ rx: -21 }).texto, 'buena'); // sin criterio del panel: el de traza
assert.equal(I.nivelDe(null), null);

// Pérdida de la bajada: por la carta si el cliente está conectado a esta caja.
const conectado = { id: 'a', cliente: 'Gómez Ana', traza: { id: 3 }, ubicacion: [-58.166, -26.179], medida: panel };
const b = I.perdidaBajada(state, nap, conectado);
assert.equal(b.exacta, true);
const largoD = F.recorrido(state, 3, 'c11:a:1').pasos.find((p) => p.tipo === 'tramo' && p.cable === 11).metros;
cerca(b.perdida, 0.5 + (largoD / 1000) * 0.3 + 0.5, 0.001); // conector de la boca, fibra, conector de la ONT
cerca(b.estimada, enBocas, 0.001);
// Sin dibujar: lo típico (dos conectores y la fibra en línea recta con un 20 % más).
const suelto = { id: 'b', cliente: 'Pereyra Luis', traza: null, ubicacion: [-58.1660, -26.1810], medida: { ...panel, rx: -20.5 } };
const t = I.perdidaBajada(state, nap, suelto);
assert.equal(t.exacta, false);
cerca(t.perdida, 1.0 + (111 * 1.2 / 1000) * 0.3, 0.01);

// Medición virtual: la mediana de las bocas; la que queda 3 dB o más por debajo, avisada.
const bajo = { id: 'c', cliente: 'Candia Carmen', traza: null, ubicacion: [-58.1662, -26.1802], medida: { ...panel, rx: -25.5 } };
const sinLectura = { id: 'd', cliente: 'Rodas', traza: null, ubicacion: null, medida: null };
const v = I.medicionVirtual(state, nap, [conectado, suelto, bajo, sinLectura]);
assert.equal(v.filas.length, 3);
cerca(v.boca, -21 + b.perdida, 0.001); // la del medio: −19,97 (las otras, −19,46 y −24,5)
assert.deepEqual(v.bajas.map((f) => f.id), ['c']);
assert.equal(v.exactas, 1);
cerca(v.estimada, enBocas, 0.001);
cerca(v.diferencia, v.boca - enBocas, 0.001);
assert.equal(I.medicionVirtual(state, nap, [sinLectura]), null);
// Con dos ONTs no se señala ninguna: no alcanza para decir cuál es la rara.
assert.deepEqual(I.medicionVirtual(state, nap, [conectado, bajo]).bajas, []);

// Estabilidad.
const ahora = Date.parse('2026-10-14T12:00:00Z');
const evento = (cuando, tipo, causa = null) => ({ cuando, tipo, causa });
const con = (id, eventos, tendencia = null, medida = { ...panel, panel_id: id }) => ({ id, cliente: id.toUpperCase(), medida, historia: { eventos, tendencia } });
const est = I.estabilidad([
  con('a', [evento('2026-10-13T22:00:00Z', 'offline', 'LOS'), evento('2026-07-17T17:45:42Z', 'appeared')],
    { rx_min: -23.5, rx_max: -21, muestras: 40, db_semana: -0.1 }),
  con('b', [evento('2026-10-13T22:01:30Z', 'state_down', 'LOS')], { rx_min: -21, rx_max: -20.5, db_semana: -0.8 }),
  con('c', [evento('2026-10-01T10:00:00Z', 'offline')]), // hace más de 7 días: no cuenta
  con('d', [], null, { ...panel, panel_id: 'd', rx: null, estado: 'offline', ultima_caida: '2026-10-14T09:00:00Z', causa: 'dying-gasp' }),
], ahora);
assert.equal(est.caidas.length, 3);
assert.equal(est.juntas.length, 1);
assert.deepEqual(est.juntas[0].items.map((x) => x.id), ['a', 'b']);
assert.deepEqual(est.inestables.map((x) => x.id), ['a']);
assert.deepEqual(est.bajando.map((x) => x.id), ['b']);
assert.deepEqual(est.fuera.map((x) => x.id), ['d']);
assert.equal(est.conLectura, 4);
assert.equal(est.conHistoria, 4);

// Una serie corta (el panel estuvo sin leer): de unas horas no se saca una tendencia
// "por semana", y la semana no se da por cubierta.
const corta = { rx_min: -21.5, rx_max: -21, muestras: 30, db_semana: -6, desde: '2026-10-14T09:00:00Z', hasta: '2026-10-14T12:00:00Z' };
const estCorta = I.estabilidad([con('a', [], corta)], ahora);
assert.equal(I.ritmoSemanal(corta), null);
assert.deepEqual(estCorta.bajando, []);
assert.equal(estCorta.desde, Date.parse('2026-10-14T09:00:00Z'));
assert.equal(I.semanaCompleta(estCorta.desde, ahora), false);
const larga = { ...corta, desde: '2026-10-07T12:00:00Z' };
assert.deepEqual(I.estabilidad([con('a', [], larga)], ahora).bajando.map((x) => x.id), ['a']);
assert.equal(I.semanaCompleta(Date.parse(larga.desde), ahora), true);
assert.equal(I.semanaCompleta(null, ahora), true);

// La misma ONT en dos contratos: una sola caída, no "dos que se cayeron juntas".
const misma = { ...panel, panel_id: 77 };
const dobles = I.estabilidad([con('x', [evento('2026-10-13T22:00:00Z', 'offline')], null, misma),
  con('y', [evento('2026-10-13T22:00:00Z', 'offline')], null, misma)], ahora);
assert.equal(dobles.caidas.length, 1);
assert.equal(dobles.juntas.length, 0);

// Una ONT fuera de línea con la última potencia que tuvo: no es una lectura actual.
const caida = I.medidaVigente({ medida: { ...panel, estado: 'offline', rx: -27.69 } });
assert.equal(caida.rx, null);
assert.equal(caida.rx_ultima, -27.69);
assert.equal(I.nivelDe(caida).texto, 'sin señal');
assert.equal(I.medicionVirtual(state, nap, [{ ...bajo, medida: { ...panel, estado: 'offline', rx: -27.69 } }]), null);

// Una ubicación de Wispro equivocada (a 5000 km) no infla la bajada: se toma una típica.
const lejano = I.perdidaBajada(state, nap, { ...suelto, ubicacion: [-58.16, 26.18] });
cerca(lejano.perdida, 1.0 + 0.15 * 0.3, 0.001);

// Con la carta sin llegar a la OLT (el recorrido se lee desde el cliente), la bajada
// es la misma: lo que hay entre el splitter de la caja y el cliente.
const botella = { ...nodo, properties: { ...nodo.properties, tipo: 'botella' } };
const sinOlt = { ...state, rev: 2, elementos: new Map([...state.elementos].map(([id, e]) => [id, id === 1 ? botella : e])),
  fusiones: new Map([...state.fusiones].filter(([id]) => id !== 30)) };
assert.equal(F.recorrido(sinOlt, 3, 'c11:a:1').pasos[0].motivo, 'cliente'); // se lee desde el cliente
const b2 = I.perdidaBajada(sinOlt, nap, conectado);
assert.equal(b2.exacta, true);
cerca(b2.perdida, b.perdida, 0.001);
assert.equal(b2.estimada, null);

// Dos splitters en cascada en la caja (1x2 que alimenta un 1x8): la bajada empieza
// en el 1x8, se lea el recorrido desde la OLT o desde el cliente.
const cascada = (conOlt) => {
  const base = conOlt ? state : sinOlt;
  return {
    ...base,
    rev: conOlt ? 3 : 4,
    equipos: new Map([...base.equipos, [22, { id: 22, elemento: 2, tipo: 'splitter', nombre: 'SPL2', entradas: 1, salidas: 2, datos: { modo: 'plc' }, version: 1 }]]),
    fusiones: new Map([...base.fusiones].filter(([id]) => id !== 31).concat([
      [33, { id: 33, elemento: 2, a: 'c10:a:1', b: 'q22:e:1', tipo: 'fusion', version: 1 }],
      [34, { id: 34, elemento: 2, a: 'q22:s:1', b: 'q21:e:1', tipo: 'fusion', version: 1 }],
    ])),
  };
};
for (const conOlt of [true, false]) {
  const bc = I.perdidaBajada(cascada(conOlt), nap, conectado);
  assert.equal(bc.exacta, true);
  cerca(bc.perdida, b.perdida, 0.001); // conector de la boca, fibra y conector de la ONT; nada de los splitters
}

// En vivo sin potencia: la ONT no responde aunque el panel la haya visto en línea.
const apagada = I.medidaVigente({ medida: { ...panel, causa: 'LOS' }, vivo: { ...vivo, rx: null } });
assert.equal(apagada.estado, 'offline');
assert.equal(apagada.rx, null);
assert.equal(apagada.rx_ultima, -21);
assert.equal(apagada.causa, null); // la causa vieja del panel no es la de ahora
assert.equal(I.nivelDe(apagada).texto, 'sin señal');
assert.deepEqual(I.estabilidad([{ id: 'z', medida: { ...panel, causa: 'LOS' }, vivo: { ...vivo, rx: null } }], ahora).fuera.map((x) => x.id), ['z']);

// Puertos PON y tiempos.
assert.deepEqual([...I.puertosPon([conectado, suelto, { medida: { ...panel, interfaz: '0/19/5' } }])], [['0/19/3', 2], ['0/19/5', 1]]);
assert.equal(I.haceCuanto('2026-10-14T11:57:00Z', ahora), 'hace 3 min');
assert.equal(I.haceCuanto('2026-10-14T09:00:00Z', ahora), 'hace 3 h');
assert.equal(I.haceCuanto('2026-10-06T19:46:27Z', ahora), 'hace 8 días');
assert.equal(I.haceCuanto('', ahora), '');
assert.equal(I.viejo('2026-10-14T11:00:00Z', ahora), true);
assert.equal(I.viejo('2026-10-14T11:45:00Z', ahora), false);

console.log('integracion.test.mjs: todo bien');
