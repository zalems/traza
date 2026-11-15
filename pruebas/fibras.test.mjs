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

// Puertos de la OLT: por dentro de 1 a N; se muestran desde 1 o, en Huawei, desde 0.
const olt0 = { id: 22, elemento: 1, tipo: 'olt', nombre: 'HUAWEI', entradas: 0, salidas: 16, datos: { desde: 0 }, version: 1 };
assert.equal(F.etiquetaPuerto(state.equipos.get(20), 's', 1), 'OLT-1 PON 1');
assert.equal(F.etiquetaPuerto(olt0, 's', 1), 'HUAWEI PON 0');
assert.equal(F.etiquetaPuerto(olt0, 's', 16), 'HUAWEI PON 15');
assert.equal(F.numeroPuerto(olt0, 3), 2);
assert.equal(F.numeroPuerto(state.equipos.get(20), 3), 3);
assert.equal(F.describirEquipo(olt0), '16 PON (0 a 15)');
assert.equal(F.describirEquipo(state.equipos.get(20)), '16 PON (1 a 16)');

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

// 0.10.0: señal. Con T F3 cortada en BOT (unida a R F1), la luz de PON 1 va por T hasta
// BOT y por R hasta NAP-2, donde la fibra no está unida: no llega al cliente.
let luz = F.iluminacion(state);
assert.equal(F.iluminacion(state), luz); // se calcula una vez por estado
assert.deepEqual([...luz.puertos.keys()], ['20:1']);
assert.deepEqual(luz.tramos.map((t) => [t.cable, t.fibra, t.desde, t.hasta, t.ini, t.fin, t.termina]),
  [[10, 3, 1, 2, 0, 1, 'union'], [11, 1, 2, 6, 0, 1, 'sin-union']]);
assert.equal(luz.extremos.get('1|q20:s:1').sentido, 'sale');
assert.equal(luz.extremos.get('1|c10:b:3').sentido, 'sale');
assert.equal(luz.extremos.get('2|c10:a:3').sentido, 'llega');
assert.equal(luz.extremos.get('2|c11:b:1').sentido, 'sale');
assert.equal(luz.extremos.get('6|c11:a:1').sentido, 'llega'); // llega luz a una fibra sin unir
assert.equal(luz.extremos.has('3|c10:a:3'), false); // después del corte, a oscuras
assert.equal(luz.clientes.size, 0);
assert.deepEqual(luz.conflictos, []);
// Sin el corte: T F3 pasa de largo por BOT, entra al splitter de la NAP y por la salida 2 y D llega al cliente.
state.fusiones.delete(33);
state.rev += 1;
luz = F.iluminacion(state);
const t3 = luz.tramos.find((t) => t.cable === 10 && t.fibra === 3);
assert.deepEqual([t3.desde, t3.hasta, t3.ini, t3.fin, t3.pasaPor], [1, 3, 0, 3, [2]]);
assert.equal(luz.extremos.get('2|c10:a:3').sentido, 'paso');
assert.equal(luz.extremos.get('2|c10:b:3').sentido, 'paso');
assert.equal(luz.extremos.get('3|c10:a:3').sentido, 'llega');
assert.equal(luz.extremos.get('3|q21:e:1').sentido, 'entra');
assert.equal([...luz.extremos.keys()].filter((k) => k.startsWith('3|q21:s:')).length, 8); // las 8 salidas con luz
assert.equal(luz.extremos.get('3|c12:b:1').sentido, 'sale');
assert.deepEqual([...luz.clientes.keys()], [4]);
for (const clave of ['1|q20:s:1', '1|c10:b:3', '2|c10:a:3', '3|q21:e:1', '3|q21:s:2', '3|c12:b:1']) {
  assert.deepEqual([...luz.extremos.get(clave).clientes], [4], `clientes abajo de ${clave}`);
}
assert.deepEqual([...luz.extremos.get('3|q21:s:3').clientes], []); // salida con luz sin nada abajo
assert.deepEqual([...t3.clientes], [4]);
assert.deepEqual(luz.porElemento.get(2).map((x) => x.ext).sort(), ['c10:a:3', 'c10:b:3']); // lo que tiene luz en BOT
// La potencia que llega al cliente es la misma que da el recorrido.
const rLuz = F.recorrido(state, 4, 'c12:a:1');
cerca(luz.clientes.get(4).potencia, F.potencias(state, rLuz).llega, 'potencia en el cliente');
cerca(luz.extremos.get('1|c10:b:3').potencia, 4 - F.PERDIDAS.fusion, 'potencia al salir de la OLT');
assert.ok(luz.extremos.get('2|c10:b:3').potencia < luz.extremos.get('1|c10:b:3').potencia); // en BOT, menos
assert.match(F.textoPotencia(luz.clientes.get(4)), /^≈ −\d+,\d dBm$/);
assert.equal(F.origenLuz(state, luz.clientes.get(4)), 'OLT-1 PON 1');
// Segmentos para el mapa: T de NODO a BOT y de BOT a NAP (el poste no corta), D de NAP al cliente.
const segs = F.segmentosConLuz(state);
assert.deepEqual(segs.map((x) => [x.cable, x.desde, x.hasta, x.sentido, [...x.fibras], [...x.clientes]]),
  [[10, 0, 1, 1, [3], [4]], [10, 1, 3, 1, [3], [4]], [12, 0, 1, 1, [1], [4]]]);
// Estado de lo que queda abajo, según las ONT.
assert.deepEqual(F.estadoAbajo(new Set([4]), new Map([[4, { estado: 'online' }]])),
  { estado: 'trafico', clientes: 1, enLinea: 1, caidos: 0, sinDato: 0 });
assert.equal(F.estadoAbajo(new Set([4]), new Map([[4, { estado: 'offline' }]])).estado, 'caida');
assert.equal(F.estadoAbajo(new Set([4]), null).estado, 'luz');
assert.equal(F.textoAbajo(F.estadoAbajo(new Set([4, 9]), new Map([[4, { estado: 'online' }], [9, { estado: 'offline' }]]))),
  '2 clientes abajo, 1 en línea, 1 sin señal');
// R quedó sin luz: el sentido de la red va de BOT (más cerca del nodo) a NAP-2.
assert.deepEqual(F.sentidoDeRed(state), [{ cable: 11, desde: 0, hasta: 1, sentido: 1 }]);
// Un cable dibujado al revés (del cliente a la NAP): la luz va contra el orden de sus puntos.
const D2 = cab(13, 'D2', 'bajada', 1, [cli, nap]);
state.cables.set(13, D2);
fus(35, 3, 'q21:s:3', 'c13:a:1', 'conector');
state.rev += 1;
const segD2 = F.segmentosConLuz(state).find((x) => x.cable === 13);
assert.deepEqual([segD2.desde, segD2.hasta, segD2.sentido], [0, 1, -1]);
assert.equal(F.iluminacion(state).tramos.find((t) => t.cable === 13).termina, 'cliente');
state.cables.delete(13);
state.fusiones.delete(35);
// Un splitter al revés (luz que entra por una salida) se avisa y no sigue.
fus(33, 2, 'c10:a:3', 'c11:b:1');
state.equipos.set(22, { id: 22, elemento: 6, tipo: 'splitter', nombre: 'SPL-2', entradas: 1, salidas: 4, datos: { modo: 'plc' }, version: 1 });
fus(34, 6, 'c11:a:1', 'q22:s:1');
state.rev += 1;
assert.deepEqual(F.iluminacion(state).conflictos, [{ elemento: 6, ext: 'q22:s:1', motivo: 'contramano' }]);
state.fusiones.delete(34);
state.equipos.delete(22);
state.rev += 1;

// --- Dónde se juntan los recorridos de varios clientes (para ubicar un corte).
// NODO (OLT) — TR — BOT (splitter 1x2) — DA — NAP-A (1x4) — clientes 1 y 2
//                                      \— DB — NAP-B (1x4) — cliente 3
{
  const n = el(101, 'nodo', 'N', -58.170, -26.180);
  const b = el(102, 'botella', 'B', -58.168, -26.180);
  const na = el(103, 'nap', 'NAP-A', -58.166, -26.180);
  const nb = el(104, 'nap', 'NAP-B', -58.168, -26.178);
  const k1 = el(105, 'cliente', 'K1', -58.1661, -26.1795);
  const k2 = el(106, 'cliente', 'K2', -58.1659, -26.1795);
  const k3 = el(107, 'cliente', 'K3', -58.1681, -26.1775);
  const sinLuz = el(108, 'cliente', 'K4', -58.1690, -26.1775);
  const cables = [cab(110, 'TR', 'troncal', 12, [n, b]), cab(111, 'DA', 'distribucion', 12, [b, na]), cab(112, 'DB', 'distribucion', 12, [b, nb]),
    cab(113, 'B1', 'bajada', 1, [na, k1]), cab(114, 'B2', 'bajada', 1, [na, k2]), cab(115, 'B3', 'bajada', 1, [nb, k3])];
  const s2 = {
    rev: 1,
    elementos: new Map([n, b, na, nb, k1, k2, k3, sinLuz].map((e) => [e.id, e])),
    cables: new Map(cables.map((c) => [c.id, c])),
    equipos: new Map([
      [120, { id: 120, elemento: 101, tipo: 'olt', nombre: 'OLT', entradas: 0, salidas: 16, datos: {}, version: 1 }],
      [121, { id: 121, elemento: 102, tipo: 'splitter', nombre: '1x2', entradas: 1, salidas: 2, datos: { modo: 'plc' }, version: 1 }],
      [122, { id: 122, elemento: 103, tipo: 'splitter', nombre: '1x4', entradas: 1, salidas: 4, datos: { modo: 'plc' }, version: 1 }],
      [123, { id: 123, elemento: 104, tipo: 'splitter', nombre: '1x4', entradas: 1, salidas: 4, datos: { modo: 'plc' }, version: 1 }],
    ]),
    fusiones: new Map(),
  };
  const unir = (id, elemento, a, b2) => s2.fusiones.set(id, { id, elemento, a, b: b2, tipo: 'fusion', version: 1 });
  unir(130, 101, 'q120:s:1', 'c110:b:1');
  unir(131, 102, 'c110:a:1', 'q121:e:1');
  unir(132, 102, 'q121:s:1', 'c111:b:1');
  unir(133, 102, 'q121:s:2', 'c112:b:1');
  unir(134, 103, 'c111:a:1', 'q122:e:1');
  unir(135, 103, 'q122:s:1', 'c113:b:1');
  unir(136, 103, 'q122:s:2', 'c114:b:1');
  unir(137, 104, 'c112:a:1', 'q123:e:1');
  unir(138, 104, 'q123:s:1', 'c115:b:1');
  assert.deepEqual([...F.iluminacion(s2).clientes.keys()].sort(), [105, 106, 107]);
  // Los dos de la misma caja: la caja, por el cable que le llega; no cuelga nadie más.
  assert.deepEqual(F.comunDeClientes(s2, [105, 106]), { elemento: 103, conLuz: 2, abajo: 2, todos: true, cable: 111 });
  // Uno solo: su caja, de la que cuelga otro más.
  assert.deepEqual(F.comunDeClientes(s2, [105]), { elemento: 103, conLuz: 1, abajo: 2, todos: false, cable: 111 });
  // De dos cajas: se juntan en la botella; el tercero de abajo no está en la lista.
  assert.deepEqual(F.comunDeClientes(s2, [105, 107]), { elemento: 102, conLuz: 2, abajo: 3, todos: false, cable: 110 });
  assert.deepEqual(F.comunDeClientes(s2, [105, 106, 107, 108]), { elemento: 102, conLuz: 3, abajo: 3, todos: true, cable: 110 });
  // Sin luz en el mapa no hay nada que decir.
  assert.equal(F.comunDeClientes(s2, [108, 999]), null);
  assert.equal(F.comunDeClientes(s2, []), null);
  assert.deepEqual([...F.clientesPorCaja(s2)].map(([caja, lista]) => [caja, lista.sort()]), [[103, [105, 106]], [104, [107]]]);

  // --- La placa del nodo vinculada con una placa real de la OLT (0.13.0)
  const placa = s2.equipos.get(120);
  const tramoDe = (cable) => F.iluminacion(s2).tramos.find((t) => t.cable === cable);
  // Sin vincular nada cambia: sin potencia cargada no hay con cuánto estimar, y nada está partido hasta el splitter.
  assert.equal(F.vinculada(placa), false);
  assert.equal(F.interfazPuerto(placa, 1), null);
  assert.equal(F.potenciaPuerto(s2, placa, 1), null);
  assert.equal(F.lecturaPuerto(s2, placa, 1), null);
  assert.deepEqual([tramoDe(110).partida, tramoDe(111).partida, tramoDe(113).partida], [false, true, true]);
  assert.equal(F.estadoLuz(s2, tramoDe(110), null).estado, 'luz');
  // Vinculada: el puerto se llama como en la OLT y la placa dice de cuál a cuál son.
  Object.assign(placa, { red: 2, nombre: 'Placa 13', datos: { desde: 0, olt: 'OLT - CARCA', olt_id: 'abc123', placa: '0/13', potencia: 3 } });
  s2.rev += 1;
  assert.equal(F.vinculada(placa), true);
  assert.equal(F.interfazPuerto(placa, 1), '0/13/0');
  assert.equal(F.etiquetaPuerto(placa, 's', 3), 'OLT - CARCA PON 0/13/2');
  assert.equal(F.describirEquipo(placa), '16 PON (0/13/0 a 0/13/15)');
  assert.equal(F.etiquetaExtremo(s2, 'q120:s:16'), 'OLT - CARCA PON 0/13/15');
  // Todavía sin lecturas: vale la potencia cargada a mano.
  assert.equal(F.placaReal(s2, placa), null);
  assert.deepEqual(F.potenciaPuerto(s2, placa, 1), { dbm: 3, leida: false });
  let luz2 = F.iluminacion(s2);
  assert.deepEqual([luz2.puertos.get('120:1').potencia0, luz2.puertos.get('120:1').leida], [3, false]);
  const perdidaK1 = luz2.clientes.get(105).perdida;
  cerca(luz2.clientes.get(105).potencia, 3 - perdidaK1, 'con la potencia cargada');
  // Llegan las lecturas (la OLT cambió de nombre: se la encuentra por su número).
  const puerto0 = { n: 0, interfaz: '0/13/0', estado: 'up', tx: 7.02, entra: 12e6, sale: 119e6, onts: 40, en_linea: 37, fibra: 1, energia: 2, otras: 0,
    criticas: 1, rx_prom: -22.1, rx_min: -27, ultima_caida: null, nivel: 'atencion' };
  const leidas = [
    { red: 9, id: 'abc123', nombre: 'OLT - CARCA', placas: [{ placa: '0/13', slot: 13, nombre: 'DE-OTRA-RED', desde: 0, puertos: [{ n: 0, interfaz: '0/13/0', tx: -3 }] }] },
    { red: 2, id: 'abc123', nombre: 'CARCARAÑÁ MA5680T', modelo: 'MA5680T', leido: '2026-11-14T23:00:00Z', error: null, placas: [
      { placa: '0/13', slot: 13, nombre: 'H805GPFD', estado: 'normal', desde: 0, puertos: [puerto0, { n: 1, interfaz: '0/13/1', estado: 'up', tx: 5.1 },
        { n: 2, interfaz: '0/13/2', estado: 'down' }] },
      { placa: '0/14', slot: 14, nombre: 'H805GPFD', estado: 'normal', desde: 0, puertos: [{ n: 0, interfaz: '0/14/0', estado: 'up', tx: 5.2 }] }] },
  ];
  const antes = F.versionLecturas(s2);
  F.ponerLecturas(s2, leidas);
  assert.equal(F.versionLecturas(s2), antes + 1);
  const real = F.placaReal(s2, placa);
  assert.deepEqual([real.olt.nombre, real.placa.nombre, real.placa.slot], ['CARCARAÑÁ MA5680T', 'H805GPFD', 13]); // la de su red, no la de otra
  assert.equal(F.lecturaPuerto(s2, placa, 1), puerto0);
  assert.equal(F.lecturaPuerto(s2, placa, 2).tx, 5.1);
  assert.equal(F.lecturaPuerto(s2, placa, 9), null); // un puerto que la OLT no informa
  assert.deepEqual(F.potenciaPuerto(s2, placa, 1), { dbm: 7.02, leida: true });
  assert.deepEqual(F.potenciaPuerto(s2, placa, 3), { dbm: 3, leida: false }); // sin lectura de lo que emite: la cargada
  // La luz se recalcula sola con las lecturas nuevas (el estado de la red no cambió) y parte de lo que emite el puerto.
  assert.notEqual(F.iluminacion(s2), luz2);
  luz2 = F.iluminacion(s2);
  assert.equal(F.iluminacion(s2), luz2);
  assert.deepEqual([luz2.puertos.get('120:1').potencia0, luz2.puertos.get('120:1').leida], [7.02, true]);
  cerca(luz2.clientes.get(105).potencia, 7.02 - perdidaK1, 'con lo que emite el puerto');
  const rK1 = F.recorrido(s2, 105, 'c113:a:1');
  assert.equal(rK1.pasos[0].motivo, 'olt');
  const potK1 = F.potencias(s2, rK1);
  assert.deepEqual([potK1.inicial, potK1.leida], [7.02, true]);
  cerca(potK1.llega, luz2.clientes.get(105).potencia, 'el recorrido y la luz dan lo mismo');
  // (la OLT se llama ahora de otra forma: de dónde viene la luz se dice con su nombre de hoy)
  assert.equal(F.origenLuz(s2, luz2.clientes.get(105)), 'CARCARAÑÁ MA5680T PON 0/13/0');
  assert.equal(F.etiquetaExtremo(s2, 'q120:s:3'), 'CARCARAÑÁ MA5680T PON 0/13/2');
  assert.equal(F.nombreOlt(s2, placa), 'CARCARAÑÁ MA5680T');
  // Cómo está la luz: hasta el primer splitter lleva todo lo del puerto (hay tráfico aunque ningún cliente del mapa
  // esté cruzado con su ONT); después del splitter, sin datos de los clientes, solo se sabe que hay luz.
  const troncal = F.estadoLuz(s2, tramoDe(110), null);
  assert.deepEqual([troncal.estado, troncal.entero, troncal.puerto, troncal.clientes], ['trafico', true, puerto0, 3]);
  assert.equal(F.textoAbajo(troncal), '40 ONT en el puerto, 37 en línea; en el mapa, 3 clientes abajo');
  const rama = F.estadoLuz(s2, tramoDe(111), null);
  assert.deepEqual([rama.estado, rama.entero], ['luz', false]);
  assert.equal(F.textoAbajo(rama), '2 clientes abajo');
  // Lo que dicen los clientes cruzados sigue valiendo después del splitter.
  const estadosK = new Map([[105, { estado: 'online' }], [107, { estado: 'offline' }]]);
  assert.equal(F.estadoLuz(s2, tramoDe(111), estadosK).estado, 'trafico');
  assert.equal(F.estadoLuz(s2, tramoDe(112), estadosK).estado, 'caida');
  const segs = F.segmentosConLuz(s2);
  const seg = (cable) => segs.find((x) => x.cable === cable);
  assert.deepEqual([F.estadoSegmento(s2, seg(110), null).estado, F.estadoSegmento(s2, seg(110), null).onts, F.estadoSegmento(s2, seg(110), null).ontsEnLinea],
    ['trafico', 40, 37]);
  assert.deepEqual([F.estadoSegmento(s2, seg(111), null).estado, F.estadoSegmento(s2, seg(111), null).onts], ['luz', 0]);
  // El puerto entero se queda sin ONT en línea: todo lo que cuelga de él está caído, antes y después del splitter.
  F.ponerLecturas(s2, [{ ...leidas[1], placas: [{ ...leidas[1].placas[0], puertos: [{ ...puerto0, en_linea: 0, fibra: 38, energia: 2, nivel: 'caido', rx_prom: null, rx_min: null }] }] }]);
  assert.deepEqual([110, 111, 113, 115].map((c) => F.estadoLuz(s2, tramoDe(c), null).estado), ['caida', 'caida', 'caida', 'caida']);
  assert.equal(F.estadoSegmento(s2, F.segmentosConLuz(s2).find((x) => x.cable === 111), null).estado, 'caida');
  assert.equal(F.textoAbajo(F.estadoLuz(s2, tramoDe(111), null)), '2 clientes abajo; su puerto PON no tiene ninguna ONT en línea');
  assert.equal(F.nivelLectura(F.lecturaPuerto(s2, placa, 1)), 'caido');
  // Las lecturas en palabras y la placa entera en números.
  F.ponerLecturas(s2, leidas);
  assert.equal(F.textoLectura(puerto0), '40 ONT, 37 en línea, 3 sin señal (2 sin energía, 1 sin luz) · emite 7,0 dBm · reciben −22,1 dBm (la peor, −27,0)');
  assert.equal(F.textoLectura(F.lecturaPuerto(s2, placa, 2)), 'en servicio, sin ONT · emite 5,1 dBm');
  assert.equal(F.textoLectura(F.lecturaPuerto(s2, placa, 3)), 'sin ONT en línea');
  assert.deepEqual([puerto0, F.lecturaPuerto(s2, placa, 2), F.lecturaPuerto(s2, placa, 3), null].map(F.nivelLectura), ['atencion', 'libre', 'apagado', null]);
  // Apagadas (sin energía) no es para mirar; sin luz, sí; y lo que ya viene como parcial o caído, tal cual.
  assert.deepEqual([{ onts: 9, en_linea: 7, energia: 2, fibra: 0, nivel: 'bien' }, { onts: 9, en_linea: 8, energia: 0, fibra: 1, nivel: 'bien' },
    { onts: 9, en_linea: 3, fibra: 6, nivel: 'parcial' }, { onts: 9, en_linea: 9, nivel: 'bien' }].map(F.nivelLectura), ['bien', 'atencion', 'parcial', 'bien']);
  assert.deepEqual(F.resumenPlaca(real.placa), { puertos: 3, conOnt: 1, onts: 40, enLinea: 37, caidos: 0, txMin: 5.1, txMax: 7.02 });
  assert.equal(F.resumenPlaca(null), null);
  // Qué placas reales ya están en el mapa (para no ofrecerlas de nuevo al agregar).
  assert.deepEqual([...F.placasEnMapa(s2)].map(([clave, eq]) => [clave, eq.id]), [['2|abc123|0/13', 120]]);
  // Sin el número de la OLT se la busca por el nombre (sin distinguir mayúsculas); una placa que la OLT ya no informa
  // queda vinculada pero sin lectura; y si la OLT no está entre las leídas, vale la potencia cargada.
  placa.datos = { desde: 0, olt: 'carcarañá ma5680t', placa: '0/14', potencia: 3 };
  assert.equal(F.placaReal(s2, placa).placa.slot, 14);
  assert.deepEqual(F.potenciaPuerto(s2, placa, 1), { dbm: 5.2, leida: true });
  placa.datos = { desde: 0, olt: 'CARCARAÑÁ MA5680T', placa: '0/15', potencia: 3 };
  assert.deepEqual([F.placaReal(s2, placa).olt.id, F.placaReal(s2, placa).placa], ['abc123', null]);
  assert.deepEqual(F.potenciaPuerto(s2, placa, 1), { dbm: 3, leida: false });
  placa.datos = { desde: 0, olt: 'Una que ya no está', olt_id: 'ffffff', placa: '0/13', potencia: 3 };
  assert.equal(F.placaReal(s2, placa), null);
  assert.deepEqual(F.potenciaPuerto(s2, placa, 1), { dbm: 3, leida: false });
  assert.equal(F.placasEnMapa(s2).size, 0);
}

console.log('fibras: TODO OK');
