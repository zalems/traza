// Pruebas de la lógica de fibras del visor (web/js/fibras.js): colores, lados,
// puntas, recorridos, pérdidas y potencias. Sin navegador:
//   node pruebas/fibras.test.mjs      (Node 20.19 o más nuevo)
import assert from 'node:assert/strict';
import * as F from '../web/js/fibras.js';

const el = (id, tipo, nombre, lon, lat) => ({ type: 'Feature', id, geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { id, tipo, nombre, carta: {}, version: 1 } });
const cab = (id, nombre, tipo, fibras, puntos, extra = {}) => ({
  type: 'Feature', id,
  geometry: { type: 'LineString', coordinates: puntos.map((p) => p.geometry?.coordinates ?? p) },
  properties: { id, nombre, tipo, fibras, por_tubo: 0, colores: 'tia598', nodos: puntos.map((p) => p.id ?? null), version: 1, ...extra },
});
const nodo = el(1, 'nodo', 'NODO', -58.170, -26.180);
const bot = el(2, 'botella', 'BOT', -58.168, -26.180);
const nap = el(3, 'nap', 'NAP', -58.166, -26.180);
const cli = el(4, 'cliente', 'CLI', -58.166, -26.179);
const poste = el(5, 'poste', 'P', -58.167, -26.180);
const nap2 = el(6, 'nap', 'NAP-2', -58.168, -26.178);
const T = cab(10, 'T', 'troncal', 24, [nodo, bot, poste, nap]);
const R = cab(11, 'R', 'distribucion', 12, [bot, nap2]);
const D = cab(12, 'D', 'bajada', 1, [nap, cli]);
const state = {
  rev: 1,
  elementos: new Map([nodo, bot, nap, cli, poste, nap2].map((e) => [e.id, e])),
  cables: new Map([T, R, D].map((c) => [c.id, c])),
  equipos: new Map([
    [20, { id: 20, elemento: 1, tipo: 'olt', nombre: 'OLT-1', entradas: 0, salidas: 16, datos: {}, version: 1 }],
    [21, { id: 21, elemento: 3, tipo: 'splitter', nombre: 'SPL-1', entradas: 1, salidas: 8, datos: { modo: 'plc', conectores: true }, version: 1 }],
  ]),
  fusiones: new Map(),
};
const fus = (id, elemento, a, b, tipo = 'fusion') => state.fusiones.set(id, { id, elemento, a, b, tipo, version: 1 });

// Estructura y colores
assert.deepEqual(F.estructura({ fibras: 48, por_tubo: 0 }).tubos, 4);
assert.equal(F.estructura({ fibras: 6, por_tubo: 0 }).porTubo, 6);
assert.equal(F.estructura({ fibras: 4, por_tubo: 12 }).porTubo, 4);
assert.equal(F.etiquetaFibra({ fibras: 48, colores: 'tia598' }, 15), 'F15 (T2 naranja · verde)');
assert.equal(F.etiquetaFibra({ fibras: 12, colores: 'tia598' }, 3), 'F3 (verde)');
assert.equal(F.etiquetaFibra({ fibras: 12, colores: 'abnt' }, 3), 'F3 (blanco)');
assert.equal(F.etiquetaFibra({ fibras: 36, por_tubo: 12, colores: 'abnt' }, 30), 'F30 (T3 blanco · violeta)');
assert.equal(F.etiquetaFibra({ fibras: 24, por_tubo: 24, colores: 'tia598' }, 20), 'F20 (negro con marca)');
assert.equal(F.infoFibra({ fibras: 288, por_tubo: 12 }, 288).colorTubo.marcas, 1);

// Lados
assert.deepEqual([...F.ladosEn(T.properties.nodos, 2)].sort(), ['a', 'b']);
assert.deepEqual([...F.ladosEn(T.properties.nodos, 1)], ['b']);
assert.deepEqual([...F.ladosEn(T.properties.nodos, 3)], ['a']);
assert.deepEqual([...F.ladosEn([1, 2, 1], 1)], []);

// Puntas en BOT: T pasa (a y b), R empieza (b)
const { puntas } = F.puntas(state, 2);
assert.deepEqual(puntas.map((p) => p.key), ['c10:a', 'c10:b', 'c11:b']);
assert.equal(puntas[0].hacia.elemento.id, 1);
assert.equal(puntas[1].hacia.elemento.id, 3); // salta el poste
assert.equal(puntas[2].hacia.elemento.id, 6);
const lados = F.ladosDeCarta(state, bot, puntas);
assert.deepEqual(Object.fromEntries(lados), { 'c10:a': 'i', 'c10:b': 'd', 'c11:b': 'd' });
assert.deepEqual(Object.fromEntries(F.ladosDeCarta(state, nodo, F.puntas(state, 1).puntas)), { 'c10:b': 'd' });

// Uniones: OLT PON 1 -> T F3 en NODO; T en BOT en paso; T F3 -> SPL entrada en NAP; SPL salida 2 -> D F1
fus(30, 1, 'q20:s:1', 'c10:b:3');
fus(31, 3, 'c10:a:3', 'q21:e:1', 'conector');
fus(32, 3, 'q21:s:2', 'c12:b:1', 'conector');
state.rev += 1;
const r = F.recorrido(state, 4, 'c12:a:1');
const tipos = r.pasos.map((p) => p.tipo + (p.motivo ? ':' + p.motivo : ''));
assert.deepEqual(tipos, ['fin:olt', 'union', 'tramo', 'union', 'equipo', 'union', 'tramo', 'inicio', 'fin:cliente']);
assert.equal(r.fusiones, 1);
assert.equal(r.conectores, 2);
assert.equal(r.splitters.length, 1);
assert.ok(r.metros > 500 && r.metros < 520, r.metros);
const tramoT = r.pasos.find((p) => p.tipo === 'tramo' && p.cable === 10);
assert.deepEqual(tramoT.pasaPor, [2]); // el poste no se nombra

// Conexión del cliente
const con = F.conexionCliente(state, cli);
assert.equal(con.union.elemento, 3);
assert.equal(con.union.a, 'q21:s:2');
assert.equal(con.origen.motivo, 'olt');
assert.equal(F.etiquetaExtremo(state, con.union.a), 'SPL-1 salida 2');

// Cortar T F3 en BOT (lado a con R F1): el recorrido desde el cliente termina cortado en BOT
fus(33, 2, 'c10:a:3', 'c11:b:1');
state.rev += 1;
const r2 = F.recorrido(state, 4, 'c12:a:1');
const ultimo2 = r2.pasos[r2.pasos.length - 1];
assert.equal(r2.pasos[0].motivo, 'cliente');
assert.equal(ultimo2.motivo, 'cortada');
assert.equal(ultimo2.elemento, 2);
// Desde la OLT, el pelo va a R y termina en NAP-2 sin unión
const r3 = F.recorrido(state, 1, 'q20:s:1');
assert.deepEqual(r3.pasos.map((p) => p.tipo + (p.motivo ? ':' + p.motivo : '')), ['fin:olt', 'inicio', 'union', 'tramo', 'union', 'tramo', 'fin:sin-union']);
assert.equal(r3.pasos[r3.pasos.length - 1].elemento, 6);

// Destino de una salida de splitter
assert.equal(F.destino(state, 3, 'q21:s:2').motivo, 'cliente');
assert.equal(F.destino(state, 3, 'q21:s:3'), null);

// Secuencias
assert.equal(F.siguienteExtremo(state, 'c10:a:11'), 'c10:a:12');
assert.equal(F.siguienteExtremo(state, 'c10:a:12'), null);
assert.equal(F.siguienteTubo(state, 'c10:a:12'), 'c10:a:13');
assert.equal(F.siguienteTubo(state, 'c10:a:24'), null);
assert.equal(F.siguienteExtremo(state, 'q21:s:7'), 'q21:s:8');
assert.equal(F.siguienteExtremo(state, 'q21:s:8'), null);
// 0.5.0: pérdidas de los splitters
const cerca = (x, y, msg) => assert.ok(Math.abs(x - y) < 0.01, `${msg}: ${x} vs ${y}`);
cerca(F.perdidaSplitter({ entradas: 1, salidas: 8, datos: { modo: 'plc' } }, 3), 10.5, 'PLC 1x8');
cerca(F.perdidaSplitter({ entradas: 2, salidas: 8, datos: {} }, 1), 10.8, 'PLC 2x8');
cerca(F.perdidaSplitter({ entradas: 1, salidas: 2, datos: { modo: 'fbt', relacion: '10/90' } }, 1), 10.3, 'FBT 10 %');
cerca(F.perdidaSplitter({ entradas: 1, salidas: 2, datos: { modo: 'fbt', relacion: '10/90' } }, 2), 0.7576, 'FBT 90 %');
assert.equal(F.perdidaSplitter({ entradas: 1, salidas: 3, datos: {} }, 1), null);
assert.equal(F.perdidaSplitter({ entradas: 1, salidas: 2, datos: { modo: 'fbt', relacion: 'x' } }, 1), null);

// Potencias a lo largo del recorrido completo (OLT -> cliente)
const sinPot = F.potencias(state, r);
assert.equal(sinPot.inicial, null);
assert.equal(sinPot.llega, null);
assert.equal(sinPot.olt.id, 20);
const esperada = r.metros / 1000 * F.PERDIDAS.fibraKm + 1 * F.PERDIDAS.fusion + 2 * F.PERDIDAS.conector + 10.5 + F.PERDIDAS.conector;
cerca(sinPot.total, esperada, 'pérdida total (con el conector de la ONT)');
state.equipos.get(20).datos = { potencia: 4 };
const conPot = F.potencias(state, r);
cerca(conPot.llega, 4 - esperada, 'llega');
assert.equal(conPot.porPaso.length, r.pasos.length);
assert.equal(conPot.porPaso[0].potencia, 4); // la OLT, antes de perder nada
cerca(conPot.porPaso[conPot.porPaso.length - 1].potencia, conPot.llega, 'el último paso es lo que llega');
// Un splitter de tamaño desconocido deja la cuenta incompleta
state.equipos.get(21).salidas = 3;
assert.equal(F.potencias(state, r).incompleta, true);
state.equipos.get(21).salidas = 8;

// Colores de cada tramo (para el mapa)
assert.equal(r.segmentos.length, r.pasos.filter((p) => p.tipo === 'tramo').length);
const segT = r.segmentos[0];
assert.equal(segT.color.hex, F.infoFibra(T.properties, r.pasos.find((p) => p.tipo === 'tramo').fibra).color.hex);
assert.equal(segT.tubo.nombre, 'azul'); // T tiene 2 tubos: lleva el color del tubo
assert.equal(r.segmentos[r.segmentos.length - 1].tubo, null); // la bajada de 1 fibra no tiene tubos
assert.deepEqual(F.coloresDeTramo(state, { cable: 999, fibra: 1 }), { color: null, tubo: null });

console.log('fibras: TODO OK');
