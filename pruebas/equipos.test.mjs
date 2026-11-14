// Pruebas de lo que se calcula para dibujar una OLT (web/js/equipos.js): cómo se escribe
// un tráfico y dónde va cada slot en el frente de cada chasis. Sin navegador:
//   node pruebas/equipos.test.mjs      (Node 20.19 o más nuevo)
import assert from 'node:assert/strict';
import { bajada, bps, geometria, slotSinPlaca, subida } from '../web/js/equipos.js';

// --- el tráfico, escrito
for (const [valor, texto] of [
  [172400000, '172 Mb/s'], [9500000, '9,5 Mb/s'], [1240000000, '1,24 Gb/s'],
  // Los que terminan en cero: no se les come el cero (120 Mb/s no es 12 Mb/s).
  [120000876, '120 Mb/s'], [100e6, '100 Mb/s'], [300e6, '300 Mb/s'], [200e3, '200 kb/s'], [110e9, '110 Gb/s'],
  [50e6, '50 Mb/s'], [20e3, '20 kb/s'], [1e9, '1 Gb/s'], [10e9, '10 Gb/s'], [2.5e9, '2,5 Gb/s'], [1.05e6, '1,05 Mb/s'],
  [10.04e6, '10 Mb/s'], [1500, '1,5 kb/s'], [1000, '1 kb/s'], [999, '999 b/s'], [500, '500 b/s'], [0, '0 b/s'],
]) assert.equal(bps(valor), texto, `${valor}`);
for (const nada of [null, undefined, NaN, 'x']) assert.equal(bps(nada), '—');
// Por un puerto PON sale la bajada de los clientes; por uno de subida, entra.
assert.deepEqual([bajada({ tipo: 'pon', entra: 1, sale: 2 }), subida({ tipo: 'pon', entra: 1, sale: 2 })], [2, 1]);
assert.deepEqual([bajada({ tipo: 'eth', entra: 1, sale: 2 }), subida({ tipo: 'eth', entra: 1, sale: 2 })], [1, 2]);

// --- el frente de cada chasis
const CHASIS = { X17: 22, X15: 20, X7: 12, X2: 5, T21: 23, T19: 21, T6: 13, T2: 5 };
const lugares = (g) => Object.fromEntries(g.slots.map((x) => [x.slot, x]));
const pisa = (a, b) => a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01;
for (const [chasis, cuantos] of Object.entries(CHASIS)) {
  const g = geometria(chasis);
  assert.equal(g.slots.length, cuantos, `${chasis}: cuántos slots`);
  assert.equal(new Set(g.slots.map((x) => x.slot)).size, cuantos, `${chasis}: ningún slot repetido`);
  const cajas = [...g.slots, g.ventilador];
  for (const c of cajas) {
    assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= g.ancho + 0.01 && c.y + c.h <= g.alto + 0.01, `${chasis}: el slot ${c.slot ?? 'de los ventiladores'} se sale del chasis`);
    assert.ok(c.w > 5 && c.h > 5, `${chasis}: el slot ${c.slot ?? 'de los ventiladores'} no tiene tamaño`);
  }
  for (let i = 0; i < cajas.length; i += 1) {
    for (let j = i + 1; j < cajas.length; j += 1) {
      assert.ok(!pisa(cajas[i], cajas[j]), `${chasis}: ${cajas[i].slot ?? 'ventiladores'} y ${cajas[j].slot ?? 'ventiladores'} se pisan`);
    }
  }
}
assert.equal(geometria('otro'), null);
assert.equal(geometria(null), null);

// MA5680T y MA5600T de 21 pulgadas (figura 2-3 de Huawei): a la izquierda, energía 21 y 22 sobre la interfaz universal (0);
// servicio 1 a 8, control 9 y 10 (más anchos), servicio 11 a 18; a la derecha, subida 19 arriba y 20 abajo; ventiladores arriba.
let g = geometria('T21');
let s = lugares(g);
assert.ok(s[21].x === s[22].x && s[22].x === s[0].x && s[21].y < s[22].y && s[22].y < s[0].y);
for (let n = 2; n <= 18; n += 1) assert.ok(s[n].x > s[n - 1].x && s[n].y === s[1].y && s[n].h === s[1].h, `T21: slot ${n}`);
assert.ok(s[1].x > s[0].x && s[9].w > s[8].w && s[9].w === s[10].w && s[10].w > s[11].w);
assert.ok(s[19].x === s[20].x && s[19].x > s[18].x && s[19].y < s[20].y && s[19].h === s[20].h);
assert.ok(g.ventilador.y + g.ventilador.h <= s[1].y && g.ventilador.w > g.ventilador.h);
assert.ok(g.slots.every((x) => x.parada));
assert.deepEqual([g.ancho, g.alto], [490, 447.2]);

// La de 19 pulgadas (figura 2-10): energía 19 y 20 sobre el 0; servicio 1 a 6, control 7 y 8, servicio 9 a 16; subida 17 y 18.
g = geometria('T19');
s = lugares(g);
assert.ok(s[19].x === s[20].x && s[20].x === s[0].x && s[19].y < s[20].y && s[20].y < s[0].y);
for (let n = 2; n <= 16; n += 1) assert.ok(s[n].x > s[n - 1].x, `T19: slot ${n}`);
assert.ok(s[7].w > s[6].w && s[7].w === s[8].w && s[8].w > s[9].w);
assert.ok(s[17].x === s[18].x && s[17].x > s[16].x && s[17].y < s[18].y);
assert.deepEqual([g.ancho, g.alto], [442, 441.7]);

// MA5683T y MA5603T (figura 2-21): ventiladores a la izquierda; de arriba abajo servicio 0 a 5 y control 6 y 7;
// después subida 8 y 9 lado a lado y, abajo, energía 10 y 11 e interfaz universal 12.
g = geometria('T6');
s = lugares(g);
assert.ok(g.ventilador.x + g.ventilador.w <= s[0].x && g.ventilador.h > g.ventilador.w);
for (let n = 1; n <= 7; n += 1) assert.ok(s[n].y > s[n - 1].y && s[n].x === s[0].x && s[n].w === s[0].w, `T6: slot ${n}`);
assert.ok(s[6].h > s[5].h && s[6].h === s[7].h);
assert.ok(s[8].y === s[9].y && s[8].y > s[7].y && s[8].x < s[9].x && s[8].w === s[9].w);
assert.ok(s[10].y === s[11].y && s[11].y === s[12].y && s[10].y > s[8].y && s[10].x < s[11].x && s[11].x < s[12].x);
assert.ok(g.slots.every((x) => !x.parada));

// MA5608T (figuras 2-29 y 2-30): ventiladores a la izquierda; arriba servicio 0 y 1; abajo control 2 y 3 y la energía,
// en una placa (slot 4) o en dos de la mitad (4 y 5).
g = geometria('T2');
s = lugares(g);
assert.ok(g.ventilador.x + g.ventilador.w <= s[0].x && s[1].y > s[0].y && s[2].y > s[1].y);
assert.ok(s[2].y === s[3].y && s[3].y === s[4].y && s[2].x < s[3].x && s[3].x < s[4].x && s[2].h > s[0].h && !s[5]);
const dos = lugares(geometria('T2', [0, 1, 2, 3, 4, 5]));
assert.ok(dos[5] && dos[4].y === dos[5].y && dos[4].x < dos[5].x && Math.abs(dos[4].w - dos[5].w) < 0.01 && Math.abs(dos[4].w * 2 - s[4].w) < 0.01);
assert.equal(geometria('T2', [0, 1, 2, 3, 4, 5]).slots.length, 6);

// MA5800 y EA5800: X17 (energía 20 y 21 sobre el 0, control 9 y 10), X15 (control 8 y 9, energía 18 y 19),
// X7 (arriba el 0 y energía 10 y 11; control 8 y 9 abajo) y X2 (arriba control 3 y 4 y energía 0; abajo servicio 1 y 2).
s = lugares(geometria('X17'));
assert.ok(s[20].x === s[21].x && s[21].x === s[0].x && s[20].y < s[21].y && s[21].y < s[0].y && s[9].w > s[8].w && s[10].w > s[11].w);
s = lugares(geometria('X15'));
assert.ok(s[18].x === s[19].x && s[19].x === s[0].x && s[18].y < s[19].y && s[8].w > s[7].w && s[9].w > s[10].w);
g = geometria('X7');
s = lugares(g);
assert.ok(s[0].y === s[10].y && s[10].y === s[11].y && s[0].x < s[10].x && s[10].x < s[11].x && s[9].y > s[8].y && s[8].y > s[7].y && s[8].h > s[7].h);
assert.ok(g.ventilador.x >= s[1].x + s[1].w - 0.01);
g = geometria('X2');
s = lugares(g);
assert.ok(s[3].y === s[4].y && s[4].y === s[0].y && s[3].x < s[4].x && s[4].x < s[0].x && s[1].y > s[3].y && s[2].y > s[1].y);
assert.ok(g.ventilador.x >= s[1].x + s[1].w - 0.01);

// --- para qué es cada lugar, y qué se dice de uno sin placa
const para = (chasis, puestos) => Object.fromEntries(geometria(chasis, puestos).slots.map((x) => [x.slot, x.para]));
const lugaresDe = (chasis, rol, puestos = []) => Object.entries(para(chasis, puestos)).filter(([, r]) => r === rol).map(([n]) => Number(n)).sort((a, b) => a - b);
for (const [chasis, energia, control, interfaz, uplink] of [
  ['X17', [20, 21], [9, 10], [0], []], ['X15', [18, 19], [8, 9], [0], []], ['X7', [10, 11], [8, 9], [0], []], ['X2', [0], [3, 4], [], []],
  ['T21', [21, 22], [9, 10], [0], [19, 20]], ['T19', [19, 20], [7, 8], [0], [17, 18]], ['T6', [10, 11], [6, 7], [12], [8, 9]], ['T2', [4], [2, 3], [], []],
]) {
  assert.deepEqual([lugaresDe(chasis, 'energia'), lugaresDe(chasis, 'control'), lugaresDe(chasis, 'interfaz'), lugaresDe(chasis, 'uplink')],
    [energia, control, interfaz, uplink], chasis);
  assert.ok(Object.values(para(chasis)).every((r) => ['servicio', 'energia', 'control', 'interfaz', 'uplink'].includes(r)), chasis);
}
assert.deepEqual(lugaresDe('T2', 'energia', [0, 1, 2, 3, 4, 5]), [4, 5]);
assert.equal(lugaresDe('T19', 'servicio').length, 14); // la de 19 pulgadas lleva 14 placas de servicio
assert.equal(lugaresDe('T21', 'servicio').length, 16); // y la de 21, 16
const t19 = lugares(geometria('T19'));
// La OLT no informa ninguna placa de energía: de esos lugares no se sabe qué placa tienen (vacíos no están).
assert.deepEqual(slotSinPlaca(t19[19], false), { sinInformar: true, lugar: 'energía', rotulo: 'Slot 19: lugar de una placa de energía. La OLT no informa sus placas de energía' });
// Si informa alguna, el otro lugar está vacío de verdad.
assert.deepEqual(slotSinPlaca(t19[20], true), { sinInformar: false, lugar: 'energía', rotulo: 'Slot 20: vacío (lugar de una placa de energía)' });
assert.deepEqual(slotSinPlaca(t19[0], false), { sinInformar: false, lugar: 'interfaz universal', rotulo: 'Slot 0: vacío (lugar de la interfaz universal)' });
assert.deepEqual(slotSinPlaca(t19[8], false), { sinInformar: false, lugar: 'control', rotulo: 'Slot 8: vacío (lugar de una placa de control)' });
assert.deepEqual(slotSinPlaca(t19[18], true), { sinInformar: false, lugar: 'subida', rotulo: 'Slot 18: vacío (lugar de una placa de subida)' });
assert.deepEqual(slotSinPlaca(t19[3], false), { sinInformar: false, lugar: null, rotulo: 'Slot 3: vacío' });

console.log('equipos.test.mjs: todo bien');
