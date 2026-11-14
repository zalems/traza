// Los equipos: el chasis de cada OLT dibujado como es (X17 del panel, X2 y MA5680T leídas directo),
// el detalle de placas y puertos, y cargar, probar, cambiar y quitar una OLT desde el visor.
//   node equipos.mjs [movil] [oscuro]
import { abrir, comprobar, terminar, CAPTURAS } from './lib.mjs';

const movil = process.argv.includes('movil');
const oscuro = process.argv.includes('oscuro');
const sufijo = `${movil ? '390' : '1280'}${oscuro ? '-oscuro' : ''}`;
const opciones = movil ? { ancho: 390, alto: 844, movil: true, oscuro } : { oscuro, alto: 900 };
const CONTROL = 'http://127.0.0.1:18092/_control';
const COMUNIDAD = 'lectura-e2e';
const CLAVE = 'Clave-olt-e2e';

let { browser, page, errores } = await abrir(opciones);
const todos = [...errores];
const foto = (nombre) => page.screenshot({ path: `${CAPTURAS}t32-${sufijo}-${nombre}.png` });
const texto = (sel) => page.textContent(sel).then((t) => (t ?? '').replace(/\s+/g, ' ').trim());
// Dónde está cada slot en el dibujo (en milímetros del chasis).
const slots = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.chasis-slot')].map((g) => {
  const r = g.querySelector('.chasis-frente');
  return [g.dataset.slot, { x: Number(r.getAttribute('x')), y: Number(r.getAttribute('y')), w: Number(r.getAttribute('width')),
    h: Number(r.getAttribute('height')), placa: g.classList.contains('con-placa') }];
})));
const ventilador = () => page.evaluate(() => {
  const r = document.querySelector('.chasis-ventilador');
  return { x: Number(r.getAttribute('x')), y: Number(r.getAttribute('y')), w: Number(r.getAttribute('width')), h: Number(r.getAttribute('height')) };
});
const sinDesborde = () => page.evaluate(() => {
  const c = document.querySelector('.olt-cuerpo');
  return c.scrollWidth <= c.clientWidth + 1;
});

// --- La OLT del panel: una MA5800-X17 dibujada como en la figura del fabricante
await page.evaluate(() => window.ftth.herramientas.olt.abrir('equipos'));
await page.waitForSelector('.chasis-dibujo', { timeout: 30000 });
comprobar(/MA5800-X17 · del panel de la OLT/.test(await texto('.olt-equipo-cab')), 'la OLT del panel dice su modelo y de dónde se lee');
comprobar(await page.locator('.chasis-x17').count() === 1, 'se dibuja con el chasis X17');
let s = await slots();
comprobar(Object.keys(s).length === 22, `el X17 tiene sus 22 slots (${Object.keys(s).length})`);
comprobar(s['20'].x === s['21'].x && s['21'].x === s['0'].x && s['20'].y < s['21'].y && s['21'].y < s['0'].y,
  'a la izquierda, de arriba abajo: energía 20, energía 21 y el slot 0');
comprobar(s['1'].x > s['0'].x && [...Array(18).keys()].every((i) => s[String(i + 2)].x > s[String(i + 1)].x), 'después, los slots 1 a 19 de izquierda a derecha');
comprobar(s['9'].w > s['8'].w && s['10'].w > s['11'].w && Math.abs(s['9'].w - s['10'].w) < 0.01, 'los dos de control (9 y 10) son más anchos');
let v = await ventilador();
comprobar(v.y + v.h < s['1'].y && v.w > v.h, 'los ventiladores van arriba, a todo lo ancho');
comprobar(Object.values(s).filter((x) => x.placa).length === 3, 'tres placas puestas; el resto, slots vacíos');
comprobar(await sinDesborde(), 'el dibujo entra en la pantalla');
await foto('x17');

// Se toca la placa en su punta (donde está el número del slot, sin puertos).
const tocarPlaca = (slot) => page.click(`.chasis-slot[data-slot="${slot}"] .chasis-frente`, { position: { x: 4, y: 4 } });
await tocarPlaca(1);
await page.waitForSelector('.chasis-chips');
comprobar(/Slot 1 · H901GPSF/.test(await texto('.chasis-placa-titulo')), 'al tocar una placa se ve cuál es');
comprobar(await page.locator('.chasis-chip').count() === 16, 'con sus 16 puertos');
await page.click('.chasis-chip >> nth=1');
await page.waitForSelector('.chasis-puerto-detalle');
let detalle = await texto('.chasis-puerto-detalle');
comprobar(/PON 0\/1\/1/.test(detalle) && /12 · 12 en línea/.test(detalle), `el puerto dice sus ONT: ${detalle.slice(0, 80)}`);
comprobar(/Tráfico ahora\s*bajada [\d,]+ Mb\/s · subida [\d,]+ Mb\/s/.test(detalle), 'y el tráfico de ahora');
comprobar(await page.locator('.chasis-puerto.elegido').count() === 1, 'el puerto queda marcado en el dibujo');
await page.click('.chasis-puerto-detalle button:has-text("Historia")');
await page.waitForSelector('.chasis-puerto-detalle .olt-lapsos');
comprobar(await page.locator('.chasis-puerto-detalle .olt-lapsos').count() === 1, 'la historia del puerto, con un solo selector de lapso');
await foto('x17-puerto');
await page.click('.chasis-puerto-detalle button:has-text("Ver sus ONT")');
await page.waitForSelector('.olt-lista-onts li');
comprobar(/^12 de \d+ ONT/.test(await texto('.olt-cuantas')), 'de ahí se va a las ONT de ese puerto');

// El uplink, en la placa de control.
await page.click('[data-pestana="equipos"]');
await tocarPlaca(9);
await page.click('.chasis-chip >> nth=0');
detalle = await texto('.chasis-puerto-detalle');
comprobar(/subida/.test(detalle) && /bajada [\d,]+ (M|G)b\/s/.test(detalle), `la subida dice su tráfico: ${detalle.slice(0, 90)}`);

// Los puertos PON traen el tráfico.
await page.click('[data-pestana="puertos"]');
await page.waitForSelector('.olt-tabla');
comprobar(/Tráfico/.test(await texto('.olt-tabla thead')), 'la tabla de puertos tiene la columna del tráfico');
comprobar(/↓ [\d,]+ Mb\/s · ↑ [\d,]+ Mb\/s/.test(await texto('.olt-tabla tbody tr >> nth=0')), 'con bajada y subida de cada puerto');

// A la OLT del panel se le puede cargar la conexión (para leerle lo que el panel no da).
await page.click('[data-pestana="equipos"]');
await page.click('.olt-equipo-cab button:has-text("Cargar su conexión")');
await page.waitForSelector('.olt-form');
comprobar(/Cargar la conexión de ALVATIC-MA5800-01/.test(await texto('.olt-form-cab')), 'el formulario dice de qué OLT es');
comprobar(await page.inputValue('input[name=host]') === '10.0.0.1', 'trae la dirección que conoce el panel');
comprobar(await page.locator('input[name=nombre]').count() === 0, 'y no pide nombre: es el del panel');
await page.click('.olt-form-botones button:has-text("Cancelar")');
await page.waitForSelector('.chasis-dibujo');
// La otra red («Sin OLT»), limpia por si una corrida anterior quedó a medias.
const red = await page.evaluate(async () => {
  const r = await (await fetch('api/redes')).json();
  const id = r.redes.find((x) => x.nombre === 'Sin OLT').id;
  const d = await (await fetch(`api/olt?red=${id}`)).json();
  for (const e of d.equipos ?? []) await fetch(`api/olt/equipos/${e.id}?red=${id}`, { method: 'DELETE' });
  return id;
});
await fetch(`${CONTROL}?olt_muda=0&olt_volver=HWTC00000065&olt_volver=HWTC00000066&olt_volver=HWTC00000067`);
await browser.close();

// --- Una red sin OLT: se carga una desde el visor
({ browser, page, errores } = await abrir({ ...opciones, red }));
todos.push(...errores);
await page.evaluate(() => window.ftth.herramientas.olt.abrir('resumen'));
await page.waitForSelector('.olt-vacio');
comprobar(/todavía no tiene una OLT de dónde leer/.test(await texto('.olt-cuerpo')), 'una red sin OLT lo dice');
await page.click('.olt-cuerpo button:has-text("Agregar una OLT")');
await page.waitForSelector('.olt-form');
comprobar(await page.getAttribute('[data-pestana="equipos"]', 'aria-selected') === 'true', 'el botón lleva al formulario, en «Equipos»');
await page.click('.olt-form-botones button[type=submit]');
await page.waitForSelector('.olt-form [role=alert]');
comprobar(/Falta la dirección/.test(await texto('.olt-form [role=alert]')), 'sin dirección no se guarda');
await page.fill('input[name=host]', '127.0.0.1');
await page.fill('input[name=snmp_puerto]', '18161');
await page.fill('input[name=comunidad]', 'otra-comunidad');
await page.selectOption('select[name=consola]', 'telnet');
comprobar(await page.inputValue('input[name=consola_puerto]') === '23', 'al elegir Telnet propone el puerto 23');
await page.fill('input[name=consola_puerto]', '18023');
await page.fill('input[name=usuario]', 'traza');
await page.fill('input[name=clave]', 'mala');
await page.click('.olt-form-botones button:has-text("Probar la conexión")');
await page.waitForSelector('.olt-resultado', { timeout: 60000 });
let prueba = await texto('.olt-prueba');
comprobar(/No anduvo\s*Lectura por SNMP \(UDP 18161\)\s*La OLT no respondió por SNMP/.test(prueba), 'con otra comunidad, la lectura no anda');
comprobar(await page.locator('.olt-resultado.mal li').count() === 3, 'y dice qué revisar');
comprobar(/No anduvo\s*Consola por Telnet \(TCP 18023\)\s*La OLT no aceptó el usuario o la clave/.test(prueba), 'con otra clave, no entra');
await page.fill('input[name=comunidad]', COMUNIDAD);
await page.fill('input[name=clave]', CLAVE);
await page.click('.olt-form-botones button:has-text("Probar la conexión")');
await page.waitForSelector('.olt-resultado.bien', { timeout: 60000 });
await page.waitForFunction(() => document.querySelectorAll('.olt-resultado.bien').length === 2, null, { timeout: 60000 });
prueba = await texto('.olt-prueba');
comprobar(/Bien\s*Lectura por SNMP/.test(prueba) && /Puertos PON\s*32/.test(prueba) && /ONT\s*12 \(12 en línea\)/.test(prueba), 'con la buena, dice lo que la OLT entrega');
comprobar(/Chasis\s*MA5800-X2 \(por dónde tiene las placas\)/.test(prueba) && /H901GPHF en 1/.test(prueba), 'reconoce el chasis por sus placas');
comprobar(/Entró con el usuario «traza»/.test(prueba), 'y entra por Telnet');
comprobar(await page.inputValue('input[name=nombre]') === 'OLT-CARCA', 'toma el nombre que la OLT dice de sí misma');
comprobar(await sinDesborde(), 'el formulario entra en la pantalla');
await foto('formulario');
await page.click('.olt-form-botones button[type=submit]');
await page.waitForSelector('.chasis-x2', { timeout: 45000 });
comprobar(true, 'guardada: a los segundos aparece dibujada');
s = await slots();
v = await ventilador();
comprobar(Object.keys(s).length === 5, 'el X2 tiene sus 5 slots');
comprobar(s['3'].y === s['4'].y && s['4'].y === s['0'].y && s['3'].x < s['4'].x && s['4'].x < s['0'].x,
  'arriba, de izquierda a derecha: control 3, control 4 y energía 0');
comprobar(s['1'].y > s['3'].y && s['2'].y > s['1'].y && s['1'].w > 2.5 * s['3'].w, 'abajo, las dos placas de servicio, a todo lo ancho');
comprobar(v.x > s['1'].x + s['1'].w - 1 && v.h > v.w, 'y los ventiladores a la derecha');
comprobar(/lectura directa por SNMP/.test(await texto('.olt-equipo-cab')), 'dice que se lee directo');
comprobar(await texto('.olt-titulo strong') === 'OLT-CARCA', 'el tablero lleva el nombre de la OLT');
await page.click('.chasis-puerto[data-puerto="pon:0/1/0"]');
await page.waitForSelector('.chasis-puerto-detalle');
detalle = await texto('.chasis-puerto-detalle');
comprobar(/3 · 3 en línea/.test(detalle) && /emite 3,2 dBm · 41 °C · 3,31 V · 12 mA/.test(detalle), `el puerto dice sus ONT y lo que emite su módulo: ${detalle.slice(0, 120)}`);
comprobar(await sinDesborde(), 'el chasis entra en la pantalla');
await foto('x2');

// Sus ONT, con lo que se sabe de cada una.
await page.click('[data-pestana="onts"]');
await page.waitForSelector('.olt-lista-onts li');
comprobar(/^12 ONT/.test(await texto('.olt-cuantas')), 'las 12 ONT de la OLT');
await page.click('.olt-lista-onts li >> nth=0 >> button >> nth=0');
await page.waitForSelector('.olt-detalle');
await page.waitForFunction(() => !/Leyendo su historia/.test(document.querySelector('.olt-detalle')?.textContent ?? ''), null, { timeout: 20000 });
detalle = await texto('.olt-detalle');
comprobar(/Fibra hasta la OLT\s*800 m/.test(detalle) && /HWTC00000065/.test(detalle), 'una ONT dice su serie y cuánta fibra hay hasta la OLT');
comprobar(/traza anota su potencia cada 15 minutos/.test(detalle) || await page.locator('.olt-detalle .grafico').count() === 1, 'y su historia sale de lo que traza anota');

// Se cortan las tres ONT de un puerto: aparece como novedad.
await fetch(`${CONTROL}?olt_caer=HWTC00000065&olt_caer=HWTC00000066&olt_caer=HWTC00000067`);
await page.click('[data-pestana="resumen"]');
let novedad = false;
for (let i = 0; i < 8 && !novedad; i += 1) {
  await page.click('.olt-actualizar');
  novedad = await page.waitForFunction(() => /PON 0\/1\/0: ninguna de sus 3 ONT está en línea/.test(document.querySelector('.olt-cuerpo')?.textContent ?? ''),
    null, { timeout: 9000 }).then(() => true, () => false);
}
comprobar(novedad, 'un puerto que se queda sin ONT en línea sale en las novedades');
if (novedad) {
  await page.click('.olt-novedad button:has-text("Ver las 3 ONT")');
  await page.waitForSelector('.olt-lista-onts li');
  comprobar(await page.locator('.olt-lista-onts > li').count() === 3, 'y se pueden ver cuáles son');
  await page.click('[data-pestana="equipos"]');
  await page.waitForSelector('.chasis-puerto[data-puerto="pon:0/1/0"].caida');
  comprobar(true, 'en el dibujo, ese puerto queda en rojo oscuro');
  await foto('x2-caido');
}
await fetch(`${CONTROL}?olt_volver=HWTC00000065&olt_volver=HWTC00000066&olt_volver=HWTC00000067`);

// La conexión guardada: se ve cómo se llega, nunca la comunidad ni la clave.
await page.click('[data-pestana="equipos"]');
await page.click('.olt-equipo-cab button:has-text("Conexión")');
await page.waitForSelector('.olt-form');
comprobar(await page.inputValue('input[name=host]') === '127.0.0.1' && await page.inputValue('input[name=usuario]') === 'traza', 'la conexión guardada trae la dirección y el usuario');
comprobar(await page.inputValue('input[name=comunidad]') === '' && await page.inputValue('input[name=clave]') === '', 'pero no la comunidad ni la clave');
comprobar(/guardada/.test(await page.getAttribute('input[name=comunidad]', 'placeholder')), 'dice que están guardadas');
const fuente = await page.evaluate(async (id) => (await fetch(`api/olt?red=${id}`)).text(), red);
comprobar(!fuente.includes(COMUNIDAD) && !fuente.includes(CLAVE), 'la API no devuelve la comunidad ni la clave');
// Lo guardado vale para esa dirección: si se cambia, hay que escribirlo de nuevo (no se le manda a otro equipo).
await page.fill('input[name=host]', '127.0.0.2');
comprobar(/escribila de nuevo/.test(await page.getAttribute('input[name=comunidad]', 'placeholder'))
  && /escribila de nuevo/.test(await page.getAttribute('input[name=clave]', 'placeholder')), 'al cambiar la dirección pide de nuevo la comunidad y la clave');
await page.click('.olt-form-botones button[type=submit]');
await page.waitForSelector('.olt-form [role=alert]');
comprobar(/escribí de nuevo la comunidad/.test(await texto('.olt-form [role=alert]')), 'y sin escribirlas no guarda');
await page.fill('input[name=host]', '127.0.0.1');
comprobar(/guardada/.test(await page.getAttribute('input[name=comunidad]', 'placeholder')), 'con la dirección de antes, siguen valiendo las guardadas');
// Una lectura nueva no borra lo que se está escribiendo.
await page.fill('input[name=nombre]', 'OLT Carcarañá');
await page.click('.olt-actualizar');
await page.waitForFunction(() => !/Leyendo/.test(document.querySelector('.olt-actualizar')?.textContent ?? ''));
comprobar(await page.inputValue('input[name=nombre]') === 'OLT Carcarañá', 'una lectura nueva no pisa lo que se está escribiendo');
await page.selectOption('select[name=modelo]', 'EA5800-X2');
await page.click('.olt-form-botones button[type=submit]');
await page.waitForFunction(() => /OLT Carcarañá/.test(document.querySelector('.olt-equipo-cab')?.textContent ?? ''), null, { timeout: 45000 });
comprobar(/EA5800-X2/.test(await texto('.olt-equipo-cab')), 'cambiarle el nombre y el modelo: queda');
await browser.close();

// --- Quien no administra la ve, pero no la toca
({ browser, page, errores } = await abrir({ ...opciones, usuario: 'cuadrilla', clave: 'Clave-cuadrilla-2026', red: null }));
todos.push(...errores);
await page.evaluate(() => window.ftth.herramientas.olt.abrir('equipos'));
await page.waitForSelector('.chasis-x2', { timeout: 45000 });
comprobar(await page.locator('.olt-equipo-cab button').count() === 0 && await page.locator('.olt-equipo-agregar').count() === 0,
  'la cuadrilla ve el chasis, sin «Conexión» ni «Agregar una OLT»');
const rechazo = await page.evaluate(async (id) => (await fetch('api/olt/equipos', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ red: id, equipo: { nombre: 'x', host: '10.0.0.9' } }) })).status, red);
comprobar(rechazo === 403, 'y la API no la deja cargar una');
await browser.close();

// --- Quitarla
({ browser, page, errores } = await abrir({ ...opciones, red }));
todos.push(...errores);
await page.evaluate(() => window.ftth.herramientas.olt.abrir('equipos'));
await page.waitForSelector('.olt-equipo-cab button');
await page.click('.olt-equipo-cab button:has-text("Conexión")');
await page.click('.olt-form-botones button:has-text("Quitar esta OLT")');
comprobar(/¿Quitar OLT Carcarañá\?/.test(await texto('.olt-form-botones')), 'quitarla pide confirmación');
await page.click('.olt-form-botones button:has-text("Sí, quitarla")');
await page.waitForFunction(() => /todavía no tiene una OLT cargada/.test(document.querySelector('.olt-cuerpo')?.textContent ?? ''), null, { timeout: 20000 });
comprobar(true, 'quitada: la red vuelve a quedar sin OLT');

// --- Una MA5680T (la familia anterior a la MA5800): se reconoce por sus placas y se dibuja con su chasis
await page.click('.olt-equipo-agregar button:has-text("Agregar una OLT")');
await page.waitForSelector('.olt-form');
comprobar(await page.locator('select[name=modelo] option[value="MA5680T-ETSI"]').count() === 1
  && await page.locator('select[name=modelo] option[value="MA5608T"]').count() === 1, 'el formulario ofrece los modelos de esa familia');
await page.fill('input[name=host]', '127.0.0.1');
await page.fill('input[name=snmp_puerto]', '18162');
await page.fill('input[name=comunidad]', COMUNIDAD);
await page.click('.olt-form-botones button:has-text("Probar la conexión")');
await page.waitForSelector('.olt-resultado.bien', { timeout: 60000 });
prueba = await texto('.olt-prueba');
comprobar(/Chasis\s*MA5680T de 21 pulgadas \(ETSI\) \(por dónde tiene las placas\)/.test(prueba), `la prueba dice qué chasis es: ${prueba.match(/Chasis.{0,80}/)?.[0]}`);
comprobar(/H801SCUN en 9/.test(prueba) && /H801PRTE en 21/.test(prueba) && /Puertos PON\s*28/.test(prueba), 'con sus placas y sus 28 puertos PON');
comprobar(await page.inputValue('input[name=nombre]') === 'MA5680T', 'toma el nombre que la OLT dice de sí misma');
await page.click('.olt-form-botones button[type=submit]');
await page.waitForSelector('.chasis-t21', { timeout: 45000 });
s = await slots();
v = await ventilador();
comprobar(Object.keys(s).length === 23, `la MA5680T de 21 pulgadas tiene sus 23 slots (${Object.keys(s).length})`);
comprobar(s['21'].x === s['22'].x && s['22'].x === s['0'].x && s['21'].y < s['22'].y && s['22'].y < s['0'].y,
  'a la izquierda, de arriba abajo: energía 21, energía 22 y la interfaz universal (0)');
comprobar(s['1'].x > s['0'].x && [...Array(17).keys()].every((i) => s[String(i + 2)].x > s[String(i + 1)].x), 'después, los slots 1 a 18 de izquierda a derecha');
comprobar(s['9'].w > s['8'].w && s['10'].w > s['11'].w && Math.abs(s['9'].w - s['10'].w) < 0.01, 'los dos de control (9 y 10) son más anchos');
comprobar(s['19'].x === s['20'].x && s['19'].x > s['18'].x && s['19'].y < s['20'].y && Math.abs(s['19'].h - s['20'].h) < 0.01,
  'a la derecha, las dos placas de subida: la 19 arriba y la 20 abajo');
comprobar(v.y + v.h < s['1'].y && v.w > v.h, 'los ventiladores van arriba, a todo lo ancho');
comprobar(Object.values(s).filter((x) => x.placa).length === 10, 'diez placas puestas; el resto, slots vacíos');
const puertosDe = (slot) => page.locator(`.chasis-slot[data-slot="${slot}"] .chasis-puerto`).count();
comprobar(await puertosDe(1) === 16 && await puertosDe(2) === 8 && await puertosDe(3) === 4 && await puertosDe(19) === 2,
  'cada placa con sus puertos: 16, 8 y 4 de PON; 2 en la de subida');
comprobar(/MA5600T \/ MA5680T de 21 pulgadas \(ETSI\) · lectura directa por SNMP/.test(await texto('.olt-equipo-cab')), 'la tarjeta dice qué chasis es');
await tocarPlaca(19);
await page.waitForSelector('.chasis-chips');
comprobar(/Slot 19 · H801X2CS/.test(await texto('.chasis-placa-titulo')) && /Placa de subida · 2 puertos/.test(await texto('.chasis-detalle')),
  'la placa de subida dice qué es');
comprobar(await sinDesborde(), 'el chasis entra en la pantalla');
await foto('ma5680t');
// Con el modelo elegido a mano, se dibuja el que se eligió (la de 19 pulgadas lleva el control en 7 y 8).
await page.click('.olt-equipo-cab button:has-text("Conexión")');
await page.waitForSelector('.olt-form');
await page.selectOption('select[name=modelo]', 'MA5680T-IEC');
await page.click('.olt-form-botones button[type=submit]');
await page.waitForSelector('.chasis-t19', { timeout: 45000 });
s = await slots();
comprobar(Object.keys(s).length === 21 && s['7'].w > s['6'].w && s['8'].w > s['9'].w && s['17'].x === s['18'].x && s['17'].y < s['18'].y
  && s['19'].x === s['20'].x && s['20'].x === s['0'].x, 'eligiendo la de 19 pulgadas: 21 slots, control en 7 y 8, subida en 17 y 18, energía en 19 y 20');
comprobar(/MA5680T de 19 pulgadas \(IEC\)/.test(await texto('.olt-equipo-cab')), 'y la tarjeta la nombra como se eligió');
comprobar(/parece MA5600T \/ MA5680T de 21 pulgadas \(ETSI\), y el modelo indicado es MA5680T de 19 pulgadas \(IEC\)/.test(await texto('.olt-equipo')),
  'como sus placas dicen otra cosa, avisa que el dibujo puede no ser el suyo');
comprobar(await sinDesborde(), 'con el aviso, sigue entrando en la pantalla');
await foto('ma5680t-otro-modelo');

// Los demás chasis de la familia, por su geometría: cada slot en su lugar, sin pisarse y adentro del chasis.
const geo = await page.evaluate(async () => {
  const { geometria } = await import('./js/equipos.js');
  const out = {};
  for (const [clave, chasis, puestos] of [['T21', 'T21', []], ['T19', 'T19', []], ['T6', 'T6', []], ['T2', 'T2', []], ['T2+5', 'T2', [5]],
    ['X17', 'X17', []], ['X15', 'X15', []], ['X7', 'X7', []], ['X2', 'X2', []]]) {
    const g = geometria(chasis, puestos);
    const cajas = [...g.slots, g.ventilador];
    const adentro = cajas.every((c) => c.x >= 0 && c.y >= 0 && c.x + c.w <= g.ancho + 0.01 && c.y + c.h <= g.alto + 0.01);
    const pisados = [];
    for (let i = 0; i < cajas.length; i += 1) {
      for (let j = i + 1; j < cajas.length; j += 1) {
        const a = cajas[i];
        const b = cajas[j];
        if (a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01) pisados.push(`${a.slot ?? 'v'}-${b.slot ?? 'v'}`);
      }
    }
    out[clave] = { n: g.slots.length, adentro, pisados, v: g.ventilador, ancho: g.ancho, alto: g.alto, s: Object.fromEntries(g.slots.map((x) => [x.slot, x])) };
  }
  return out;
});
comprobar(Object.entries({ T21: 23, T19: 21, T6: 13, T2: 5, 'T2+5': 6, X17: 22, X15: 20, X7: 12, X2: 5 }).every(([k, n]) => geo[k].n === n),
  `cada chasis tiene sus slots (${Object.entries(geo).map(([k, g]) => `${k}: ${g.n}`).join(', ')})`);
comprobar(Object.values(geo).every((g) => g.adentro && g.pisados.length === 0),
  `ningún slot se pisa con otro ni se sale del chasis (${Object.entries(geo).filter(([, g]) => !g.adentro || g.pisados.length).map(([k, g]) => `${k}: ${g.pisados}`).join('; ') || 'bien'})`);
let t = geo.T6;
comprobar(t.v.x + t.v.w <= t.s[0].x && [1, 2, 3, 4, 5, 6, 7].every((n) => t.s[n].y > t.s[n - 1].y && t.s[n].x === t.s[0].x)
  && t.s[6].h > t.s[5].h && t.s[8].y === t.s[9].y && t.s[8].y > t.s[7].y && t.s[8].x < t.s[9].x
  && t.s[10].y === t.s[11].y && t.s[11].y === t.s[12].y && t.s[10].y > t.s[8].y && t.s[10].x < t.s[11].x && t.s[11].x < t.s[12].x,
'la MA5683T: ventiladores a la izquierda; servicio 0 a 5, control 6 y 7, subida 8 y 9 lado a lado y, abajo, energía 10 y 11 e interfaz 12');
t = geo.T2;
comprobar(t.v.x + t.v.w <= t.s[0].x && t.s[1].y > t.s[0].y && t.s[2].y > t.s[1].y && t.s[2].y === t.s[3].y && t.s[3].y === t.s[4].y
  && t.s[2].x < t.s[3].x && t.s[3].x < t.s[4].x && t.s[2].h > t.s[0].h && !t.s[5],
'la MA5608T: ventiladores a la izquierda; arriba las dos de servicio y abajo control 2, control 3 y energía 4');
t = geo['T2+5'];
comprobar(t.s[5] && t.s[4].y === t.s[5].y && t.s[4].x < t.s[5].x && Math.abs(t.s[4].w - t.s[5].w) < 0.01 && t.s[4].w < geo.T2.s[4].w,
  'con dos placas de energía de la mitad, van en 4 y 5');
await page.evaluate(async (id) => {
  const d = await (await fetch(`api/olt?red=${id}`)).json();
  for (const e of d.equipos ?? []) await fetch(`api/olt/equipos/${e.id}?red=${id}`, { method: 'DELETE' });
}, red);
await browser.close();
terminar(todos);
