// La carta de empalme de un nodo con sus placas de OLT: el zoom en columnas (botones, Control
// y la rueda, dos dedos), vincular una placa cargada a mano con una placa real de la OLT y ver
// en cada puerto lo que se lee de él, saltar al tablero de la OLT y volver, lo que alimenta un
// puerto marcado en el mapa, agregar una placa eligiendo la real (con una OLT leída directo: la
// potencia estimada sale de lo que emite el puerto) y un puerto que se queda sin ONT en línea.
//   node placas.mjs [movil] [oscuro]
import { abrir, comprobar, terminar, CAPTURAS } from './lib.mjs';

const movil = process.argv.includes('movil');
const oscuro = process.argv.includes('oscuro');
const sufijo = `${movil ? '390' : '1280'}${oscuro ? '-oscuro' : ''}`;
const opciones = movil ? { ancho: 390, alto: 844, movil: true, oscuro } : { oscuro, alto: 860 };
const CONTROL = 'http://127.0.0.1:18092/_control';
const SERIES = ['HWTC00000065', 'HWTC00000066', 'HWTC00000067']; // las tres ONT del puerto 0/1/0 de la OLT de mentira

let { browser, page, errores } = await abrir(opciones);
const todos = [errores]; // los errores de página de cada sesión (se juntan al final)
const foto = (nombre) => page.screenshot({ path: `${CAPTURAS}t33-${sufijo}-${nombre}.png` });
const texto = (sel) => page.textContent(sel).then((t) => (t ?? '').replace(/\s+/g, ' ').trim());
const pie = () => texto('#carta .carta-pie');
const zoom = () => page.textContent('#carta .carta-zoom .zoom-nivel');
const boton = (nombre) => page.locator('#carta').getByRole('button', { name: nombre, exact: true });
// La API, con la sesión de la página.
const api = (ruta, metodo = 'GET', cuerpo = null) => page.evaluate(async ([r, m, c]) => {
  const res = await fetch(r, { method: m, headers: c ? { 'Content-Type': 'application/json' } : {}, body: c ? JSON.stringify(c) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}, [ruta, metodo, cuerpo]);
const abrirCartaDelNodo = async (nombre) => {
  const id = await page.evaluate((n) => {
    const e = [...window.ftth.herramientas.red.state.elementos.values()].find((x) => x.properties.tipo === 'nodo' && (!n || x.properties.nombre === n));
    window.ftth.herramientas.carta.abrir(e.id);
    return e.id;
  }, nombre ?? null);
  await page.waitForSelector('#carta .carta-cuerpo');
  return id;
};
// Dónde arranca la primera unión dibujada y dónde está el puerto del que sale (tienen que coincidir).
const desfase = () => page.evaluate(() => {
  const linea = document.querySelector('#carta .carta-lineas .linea-union path.hebra')?.getBoundingClientRect();
  const puerto = document.querySelector('#carta .equipo .puerto.unida .punto')?.getBoundingClientRect();
  return linea && puerto ? Math.abs(puerto.left + puerto.width / 2 - linea.left) + Math.abs(puerto.top + puerto.height / 2 - linea.top) : null;
});
const medidas = () => page.evaluate(() => {
  const c = document.querySelector('#carta .carta-cuerpo');
  const e = document.querySelector('#carta .carta-escala').getBoundingClientRect();
  const r = c.getBoundingClientRect();
  const p = document.querySelector('#carta .equipo .puerto').getBoundingClientRect();
  return { ancho: e.width, alto: e.height, abajo: e.bottom - r.top, altoCuerpo: c.clientHeight, scrollW: c.scrollWidth, clientW: c.clientWidth,
    puerto: [p.left + p.width / 2, p.top + p.height / 2], pagina: window.visualViewport?.scale ?? 1 };
});

// --- Antes de empezar: la placa del nodo de la red de prueba, cargada a mano (sin vincular)
const placa1 = await page.evaluate(() => [...window.ftth.herramientas.red.state.equipos.values()].find((e) => e.tipo === 'olt'));
if (placa1.datos.placa) {
  const r = await api(`api/equipos/${placa1.id}`, 'PUT', { datos: { desde: 0, potencia: 4 }, version: placa1.version });
  if (r.status !== 200) throw new Error(`no se pudo dejar la placa sin vincular: ${JSON.stringify(r)}`);
  await browser.close();
  ({ browser, page, errores } = await abrir(opciones));
  todos.push(errores);
}

// ------------------------------------------------------------------ 1. El zoom en columnas
await page.evaluate(() => { try { localStorage.setItem('ftth.carta.modo', 'columnas'); } catch { /* sin almacenamiento */ } });
await abrirCartaDelNodo();
await page.waitForSelector('#carta .equipo.olt .puerto');
await page.waitForSelector('#carta .carta-lineas .linea-union');
comprobar(await page.isVisible('#carta .carta-zoom') && (await zoom()) === '100 %', 'en columnas, la carta tiene sus botones de zoom, en 100 %');
const m100 = await medidas();
await boton('Alejar').click();
await boton('Alejar').click();
await page.waitForTimeout(250);
let m = await medidas();
comprobar((await zoom()) === '64 %' && Math.abs(m.ancho / m100.ancho - 0.64) < 0.01 && Math.abs(m.alto / m100.alto - 0.64) < 0.02,
  `«−» dos veces la deja en 64 %: el diagrama entero se achica (${Math.round(m100.ancho)} → ${Math.round(m.ancho)} px)`);
comprobar((await desfase()) < 1.5, 'y cada unión sigue saliendo de su puerto');
await boton('Ajustar').click();
await page.waitForTimeout(250);
m = await medidas();
comprobar(m.abajo <= m.altoCuerpo + 1 && m.scrollW <= m.clientW + 1, `«Ajustar» hace entrar toda la carta (${await zoom()})`);
await foto('zoom-ajustado');
await page.click('#carta .carta-zoom .zoom-nivel');
await page.waitForTimeout(200);
m = await medidas();
comprobar((await zoom()) === '100 %' && Math.abs(m.ancho - m100.ancho) < 1 && !(await page.$eval('#carta .carta-diagrama', (d) => d.style.transform)),
  'tocar el porcentaje vuelve al 100 %, sin escala');
if (movil) {
  // Dos dedos que se separan sobre la carta: se agranda el diagrama, no la página.
  const cdp = await page.context().newCDPSession(page);
  const caja = await page.$eval('#carta .carta-cuerpo', (c) => { const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const dedos = (d) => [{ x: caja.x - d, y: caja.y, id: 0 }, { x: caja.x + d, y: caja.y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: dedos(40) });
  for (const d of [50, 60, 70, 80]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: dedos(d) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(300);
  m = await medidas();
  comprobar((await zoom()) === '200 %' && m.pagina === 1 && m.scrollW > m.clientW, `con dos dedos se agranda la carta y no la página (${await zoom()})`);
  comprobar((await desfase()) < 3, 'y las uniones siguen en su lugar');
  await foto('zoom-dos-dedos');
} else {
  // Control y la rueda sobre un puerto: se acerca y el puerto queda bajo el cursor.
  await page.$eval('#carta .carta-cuerpo', (c) => { c.scrollTop = 0; c.scrollLeft = 0; });
  const antes = (await medidas()).puerto;
  await page.mouse.move(antes[0], antes[1]);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  await page.waitForTimeout(300);
  m = await medidas();
  comprobar(Number.parseInt(await zoom(), 10) > 140 && Math.hypot(m.puerto[0] - antes[0], m.puerto[1] - antes[1]) < 3,
    `Control y la rueda acercan sin mover lo que está bajo el cursor (${await zoom()})`);
  comprobar((await desfase()) < 3, 'y las uniones siguen en su lugar');
  await foto('zoom-rueda');
}
await page.click('#carta .carta-zoom .zoom-nivel');
// En el modo libre, los mismos botones.
await page.locator('#carta .carta-modo').getByRole('button', { name: 'Libre' }).click();
await page.waitForSelector('#carta .carta-lienzo .equipo.olt');
const libre = await zoom();
await boton('Acercar').click();
comprobar(await page.isVisible('#carta .carta-zoom') && (await zoom()) !== libre, `en el modo libre los botones de zoom son los mismos (${libre} → ${await zoom()})`);
await page.locator('#carta .carta-modo').getByRole('button', { name: 'Columnas' }).click();
await page.waitForSelector('#carta .carta-diagrama .equipo.olt');

// Con zoom se sigue acomodando: en la botella, un cable de la derecha se arrastra a la izquierda al 64 %.
if (!movil) {
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const e = [...window.ftth.herramientas.red.state.elementos.values()].find((x) => x.properties.tipo === 'botella');
    window.ftth.herramientas.carta.abrir(e.id);
  });
  await page.waitForSelector('#carta .carta-col[data-col="d"] [data-asa]');
  const columnas = () => page.evaluate(() => [...document.querySelectorAll('#carta .carta-col')].map((c) => [...c.querySelectorAll('[data-bloque]')].map((b) => b.dataset.bloque)));
  const ordenAntes = await columnas();
  await boton('Alejar').click();
  await boton('Alejar').click();
  await page.waitForTimeout(250);
  const asa = await page.$eval('#carta .carta-col[data-col="d"] [data-asa]', (a) => { const r = a.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, key: a.dataset.asa }; });
  const destino = await page.$eval('#carta .carta-col[data-col="i"]', (c) => { const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 10 }; });
  await page.mouse.move(asa.x, asa.y);
  await page.mouse.down();
  await page.mouse.move(asa.x - 30, asa.y + 8, { steps: 3 });
  await page.mouse.move(destino.x, destino.y, { steps: 8 });
  await page.waitForTimeout(200);
  const vuelo = await page.evaluate(([k, x]) => {
    const b = document.querySelector(`#carta [data-bloque="${k}"]`).getBoundingClientRect();
    const hueco = document.querySelector('#carta .carta-hueco')?.getBoundingClientRect();
    const col = document.querySelector('#carta .carta-col[data-col="i"]').getBoundingClientRect();
    return { sigue: b.left < x && b.right > x - 4, hueco: hueco ? Math.abs(hueco.left - col.left) < 3 && Math.abs(hueco.width - col.width) < 3 : false };
  }, [asa.key, destino.x]);
  await page.mouse.up();
  await page.waitForFunction((k) => document.querySelector('#carta .carta-col[data-col="i"] [data-bloque]')?.dataset.bloque === k, asa.key, { timeout: 5000 }).catch(() => {});
  comprobar(vuelo.sigue && vuelo.hueco && (await columnas())[0][0] === asa.key, 'con zoom se sigue acomodando: el cable arrastrado sigue al cursor, el hueco marca su lugar y queda donde se lo soltó');
  await page.locator('#carta .carta-pie').getByRole('button', { name: 'Deshacer' }).click();
  await page.waitForFunction((antes) => JSON.stringify([...document.querySelectorAll('#carta .carta-col')].map((c) => [...c.querySelectorAll('[data-bloque]')].map((b) => b.dataset.bloque))) === antes,
    JSON.stringify(ordenAntes), { timeout: 5000 }).catch(() => {});
  comprobar(JSON.stringify(await columnas()) === JSON.stringify(ordenAntes), '«Deshacer» lo vuelve a su lugar');
  await page.click('#carta .carta-zoom .zoom-nivel');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await abrirCartaDelNodo();
  await page.waitForSelector('#carta .equipo.olt .puerto');
}

// ------------------------------------------------- 2. Vincular la placa cargada a mano con la real
comprobar((await texto('#carta .equipo.olt .puerto')).startsWith('PON 0') && !(await page.locator('#carta .equipo.vinculada').count()),
  'la placa cargada a mano muestra sus puertos como PON 0, PON 1…');
await page.click('#carta .equipo.olt .equipo-cab');
comprobar(/Sin vincular con una placa real de la OLT/.test(await pie()), 'al tocarla, dice que no está vinculada con una placa real');
await boton('Vincular con la placa real').click();
await page.waitForSelector('#carta .carta-form select[name="placa-real"]');
const ofrecidas = await page.$$eval('#carta select[name="placa-real"] option', (o) => o.map((x) => x.textContent));
comprobar(ofrecidas.length === 3 && /^ALVATIC-MA5800-01 · 0\/1 · H901GPSF · 16 puertos$/.test(ofrecidas[1]) && /0\/2/.test(ofrecidas[2]),
  `el formulario pregunta qué placa de la OLT es y ofrece las que traza lee (${ofrecidas.slice(1).join(' | ')})`);
await page.selectOption('#carta select[name="placa-real"]', { index: 1 });
comprobar(/^16 puertos, del 0\/1\/0 al 0\/1\/15 · 50 ONT, 33 en línea, en 4 puertos/.test(await texto('#carta .carta-form-nota')),
  'al elegirla dice sus puertos y sus ONT');
comprobar(await page.isHidden('#carta input[name="salidas"]') && await page.isHidden('#carta select[name="desde"]'),
  'y ya no pide los puertos ni la numeración: son los de la placa real');
await foto('vincular');
await page.locator('#carta .carta-form').getByRole('button', { name: 'Guardar' }).click();
await page.waitForSelector('#carta .equipo.olt.vinculada');
const puertos = await page.$$eval('#carta .equipo.olt .puerto', (l) => l.map((b) => b.textContent.replace(/\s+/g, ' ').trim()));
comprobar(puertos.length === 16 && puertos[0] === '0/1/014/14' && puertos[1] === '0/1/112/12' && puertos[2] === '0/1/27/13' && puertos[3] === '0/1/30/11'
  && puertos[15] === '0/1/15', `vinculada, cada puerto es el PON de verdad con sus ONT en línea (${puertos.slice(0, 5).join(', ')}…)`);
comprobar(/ALVATIC-MA5800-01 · 0\/1 · H901GPSF/.test(await texto('#carta .equipo.olt .equipo-cab')), 'y la placa dice de qué placa real es');
const clases = await page.$$eval('#carta .equipo.olt .puerto', (l) => l.slice(0, 5).map((b) => [...b.classList].filter((c) => c.startsWith('leido-') || c.startsWith('luz-')).join(' ')));
comprobar(clases[0] === 'luz-trafico leido-bien' && clases[2] === 'luz-trafico leido-atencion' && clases[3] === 'leido-caido' && clases[4] === 'leido-libre',
  `con el color de cómo está cada uno, también los que todavía no están unidos (${clases.join(' | ')})`);
await foto('vinculada');
// El pie de un puerto unido: lo que se lee de él.
await page.click('#carta .equipo.olt .puerto.unida');
comprobar(/PON 0\/1\/0: 14 ONT, 14 en línea · reciben −21,0 dBm \(la peor, −22,8\) · bajada 119 Mb\/s · subida 12,6 Mb\/s/.test(await pie()),
  'al tocar un puerto, el pie dice sus ONT, cuánto reciben y su tráfico');
// De ahí, a sus ONT en el tablero (encima de la carta) y de vuelta.
await boton('Ver sus ONT').click();
await page.waitForSelector('#olt .olt-lista-onts li');
comprobar(/14 de 66 ONT/.test(await texto('#olt .olt-cuerpo')) && await page.$eval('#carta', (c) => c.inert), '«Ver sus ONT» abre el tablero en las 14 ONT de ese puerto, encima de la carta');
await page.keyboard.press('Escape');
await page.waitForFunction(() => document.getElementById('olt').hidden);
comprobar(await page.isVisible('#carta .equipo.olt.vinculada') && !(await page.$eval('#carta', (c) => c.inert)) && /PON 0\/1\/0: 14 ONT/.test(await pie()),
  'y al cerrarlo se vuelve a la carta, donde estaba');
// Lo que alimenta el puerto, marcado en el mapa.
await boton('En el mapa').click();
await page.waitForSelector('#ficha .ficha-titulo');
await page.waitForFunction(() => window.ftth.map.getSource('red-recorrido').serialize().data.features.length > 0);
const fichaPuerto = await texto('#ficha');
comprobar(/Lo que alimenta el puerto/.test(fichaPuerto) && /Sale de Nodo Central por T1 · F1 .* y va sin dividirse .* hasta HP1C1/.test(fichaPuerto)
  && /En el mapa alimenta 8 cables, 1 caja y 6 clientes/.test(fichaPuerto), '«En el mapa» marca todo lo que alimenta el puerto y dice hasta dónde va sin dividirse');
await page.waitForTimeout(900); // (el mapa termina de acomodarse)
await foto('puerto-en-el-mapa');
await page.locator('#ficha').getByRole('button', { name: 'Ver la carta del nodo' }).click();
await page.waitForSelector('#carta .equipo.olt.vinculada');
comprobar(/PON 0\/1\/0 ↔ T1 F1/.test(await pie()) && (await page.evaluate(() => window.ftth.map.getSource('red-recorrido').serialize().data.features.length)) === 0,
  'y se vuelve a la carta con esa unión marcada, sin nada marcado en el mapa');
await page.keyboard.press('Escape');
// Agregar otra: la real que ya está en el mapa no se ofrece.
await boton('Agregar placa de OLT').click();
await page.waitForSelector('#carta .carta-form select[name="placa-real"]');
const alAgregar = await page.$$eval('#carta select[name="placa-real"] option', (o) => o.map((x) => `${x.textContent}${x.disabled ? ' [no]' : ''}${x.selected ? ' [elegida]' : ''}`));
comprobar(/0\/1 .* ya está en Nodo Central \[no\]$/.test(alAgregar[1]) && /0\/2 .*\[elegida\]$/.test(alAgregar[2])
  && (await page.inputValue('#carta input[name="nombre"]')) === 'ALVATIC-MA5800-01 0/2',
  '«Agregar placa de OLT» propone la placa real que falta (con su nombre) y no deja repetir la que ya está');
await foto('agregar');
await page.locator('#carta .carta-form').getByRole('button', { name: 'Cancelar' }).click();
const repetida = await api('api/equipos', 'POST', { elemento: placa1.elemento, tipo: 'olt', nombre: 'Repetida', salidas: 16,
  datos: { desde: 0, olt: 'ALVATIC-MA5800-01', olt_id: 'p1', placa: '0/1' } });
comprobar(repetida.status === 409 && /ya está en el mapa: es «MA5800 placa 1», en Nodo Central/.test(repetida.data?.error ?? ''),
  'y la API tampoco: una placa real va una sola vez en el mapa de la red');
await page.keyboard.press('Escape');
await page.waitForFunction(() => document.getElementById('carta').hidden);
// La ficha del nodo y la señal del mapa usan la lectura.
comprobar(/MA5800 placa 1: 16 PON \(0\/1\/0 a 0\/1\/15\), 3 de 16 puertos en uso · 50 ONT, 33 en línea/.test(await texto('#ficha')),
  'la ficha del nodo dice las ONT de su placa');
const tronco = await page.evaluate(() => {
  const s = window.ftth.herramientas.red.state;
  const t = [...s.cables.values()].find((c) => c.properties.nombre === 'T1');
  return t.id;
});
if (!(await page.evaluate(() => window.ftth.herramientas.senal.activa()))) await page.click('.senal-boton:not(.olt-boton)');
await page.waitForFunction((id) => (window.ftth.map.getSource('senal')?.serialize().data.features ?? []).some((f) => f.properties.cable === id && f.properties.onts > 0), tronco, { timeout: 20000 });
const deTronco = await page.evaluate((id) => window.ftth.map.getSource('senal').serialize().data.features.filter((f) => f.properties.cable === id).map((f) => f.properties), tronco);
comprobar(deTronco.every((f) => f.estado === 'trafico') && deTronco.some((f) => f.onts === 39 && f.ontsEnLinea === 33),
  `en el mapa, la troncal lleva las ONT de sus tres puertos (${deTronco.map((f) => `${f.ontsEnLinea}/${f.onts}`).join(', ')})`);
await page.click('.senal-boton:not(.olt-boton)');
// Desde el tablero de la OLT: dónde está cada placa en el mapa.
await page.evaluate(() => { window.ftth.herramientas.ficha.cerrar(); window.ftth.herramientas.red.seleccionar(null); window.ftth.herramientas.olt.abrir('equipos'); });
await page.waitForSelector('#olt .chasis-dibujo');
await page.click('#olt .chasis-slot[data-slot="1"]');
await page.waitForSelector('#olt .chasis-en-mapa');
comprobar(/^En el mapa: «MA5800 placa 1», en Nodo Central[.;]/.test(await texto('#olt .chasis-en-mapa')) && (await page.locator('#olt .chasis-en-mapa button').count()) >= 1,
  `en el tablero, la placa real dice en qué nodo del mapa está y deja ir a su carta (${await texto('#olt .chasis-en-mapa')})`);
await page.click('#olt .chasis-slot[data-slot="2"]');
await page.waitForFunction(() => /Todavía no está en el mapa/.test(document.querySelector('#olt .chasis-en-mapa')?.textContent ?? ''));
comprobar(true, 'y la que falta, que todavía no está y cómo se agrega');
await page.click('#olt .chasis-slot[data-slot="1"]');
await page.click('#olt .chasis-chip >> nth=3');
await page.waitForFunction(() => /este puerto todavía no está unido/.test(document.querySelector('#olt .chasis-en-mapa')?.textContent ?? ''));
await page.click('#olt .chasis-chip >> nth=2');
await page.waitForFunction(() => /Ver lo que alimenta/.test(document.querySelector('#olt .chasis-en-mapa')?.textContent ?? ''));
await page.locator('#olt .chasis-en-mapa').getByRole('button', { name: 'Ver este puerto en su carta' }).click();
await page.waitForSelector('#carta .equipo.olt.vinculada');
comprobar(await page.isHidden('#olt') && /PON 0\/1\/2 ↔ T1 F3/.test(await pie()), 'de un puerto del tablero se salta a ese puerto en la carta de su nodo');
// Las novedades de un puerto dicen por dónde sale en el mapa.
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
await page.evaluate(() => window.ftth.herramientas.olt.abrir('resumen'));
await page.waitForSelector('#olt .olt-novedades');
comprobar(/En el mapa, ese puerto sale de Nodo Central y va sin dividirse hasta HP1C3/.test(await texto('#olt .olt-novedades')),
  'una novedad de un puerto dice por dónde sale ese puerto en el mapa, aunque sus clientes no estén cruzados');
await page.keyboard.press('Escape');
// Desvincular: vuelve a ser una placa cargada a mano.
await abrirCartaDelNodo();
await page.click('#carta .equipo.olt .equipo-cab');
await boton('Editar').click();
await page.waitForSelector('#carta .carta-form select[name="placa-real"]');
comprobar(/0\/1 · H901GPSF/.test(await page.$eval('#carta select[name="placa-real"]', (x) => x.selectedOptions[0].textContent)), 'al editarla, el formulario muestra la placa real que tiene');
await page.selectOption('#carta select[name="placa-real"]', { index: 0 });
comprobar(await page.isVisible('#carta input[name="salidas"]') && (await page.inputValue('#carta input[name="salidas"]')) === '16', 'sin placa real vuelve a pedir los puertos');
await page.locator('#carta .carta-form').getByRole('button', { name: 'Guardar' }).click();
await page.waitForFunction(() => document.querySelector('#carta .equipo.olt') && !document.querySelector('#carta .equipo.olt.vinculada'));
comprobar((await texto('#carta .equipo.olt .puerto')).startsWith('PON 0'), 'desvinculada, vuelve a mostrar PON 0, PON 1… con las uniones como estaban');
comprobar((await page.locator('#carta .carta-lineas .linea-union').count()) === 3, '(las tres uniones siguen)');
await browser.close();

// -------------------------- 3. Una OLT leída directo: agregar la placa eligiendo la real, y su potencia
// (la red «Sin OLT»: se le carga la OLT de mentira, un nodo y un cable hasta la caja N-2, que tiene su splitter y su cliente)
({ browser, page, errores } = await abrir(opciones));
todos.push(errores);
await fetch(`${CONTROL}?olt_muda=0&${SERIES.map((x) => `olt_volver=${x}`).join('&')}`);
const preparar = await page.evaluate(async () => {
  const json = (r, m = 'GET', c = null) => fetch(r, { method: m, headers: c ? { 'Content-Type': 'application/json' } : {}, body: c ? JSON.stringify(c) : undefined }).then((x) => x.json());
  const red = (await json('api/redes')).redes.find((x) => x.nombre === 'Sin OLT').id;
  // Lo que haya quedado de una corrida anterior.
  for (const e of (await json(`api/olt?red=${red}`)).equipos ?? []) await fetch(`api/olt/equipos/${e.id}?red=${red}`, { method: 'DELETE' });
  let datos = await json(`api/red?red=${red}`);
  for (const c of datos.cables.features.filter((x) => x.properties.nombre === 'T-E2E')) await fetch(`api/cables/${c.id}?version=${c.properties.version}`, { method: 'DELETE' });
  for (const e of datos.elementos.features.filter((x) => x.properties.nombre === 'Central E2E')) await fetch(`api/elementos/${e.id}?version=${e.properties.version}`, { method: 'DELETE' });
  datos = await json(`api/red?red=${red}`);
  const n2 = datos.elementos.features.find((x) => x.properties.nombre === 'N-2');
  const spl = datos.equipos.find((x) => x.elemento === n2.id && x.tipo === 'splitter');
  const olt = await json('api/olt/equipos', 'POST', { red, equipo: { nombre: 'OLT E2E', host: '127.0.0.1', modelo: '', snmp_puerto: 18161, comunidad: 'lectura-e2e', consola: '', utc: -180 } });
  const nodo = (await json('api/elementos', 'POST', { red, tipo: 'nodo', nombre: 'Central E2E', lon: -58.152, lat: -26.2 })).elemento;
  const cable = (await json('api/cables', 'POST', { red, nombre: 'T-E2E', tipo: 'troncal', fibras: 12,
    coords: [nodo.geometry.coordinates, n2.geometry.coordinates], nodos: [nodo.id, n2.id] })).cable;
  const union = await json('api/fusiones', 'POST', { elemento: n2.id, pares: [{ a: `c${cable.id}:a:1`, b: `q${spl.id}:e:1` }] });
  return { red, olt: olt.id, nodo: nodo.id, cable: cable.id, unida: union.fusiones?.length === 1 };
});
comprobar(preparar.unida && Boolean(preparar.olt), 'preparado: una OLT leída directo, un nodo y su cable hasta la caja con splitter');
const red2 = preparar.red;
await browser.close();
({ browser, page, errores } = await abrir({ ...opciones, red: red2 }));
todos.push(errores);
await page.evaluate(() => { try { localStorage.setItem('ftth.carta.modo', 'columnas'); } catch { /* sin almacenamiento */ } });
await abrirCartaDelNodo('Central E2E');
await page.waitForSelector('#carta .punta');
// La OLT recién cargada tarda unos segundos en leerse: la carta lo pide sola cada minuto; acá se pide hasta que llegue.
let leida = false;
for (let i = 0; i < 12 && !leida; i += 1) {
  await page.evaluate(() => window.ftth.herramientas.senal.pedirEstados({ forzar: true }));
  leida = await page.evaluate((r) => fetch(`api/integracion/estados?red=${r}`).then((x) => x.json()).then((d) => (d.olts ?? []).some((o) => o.placas.length > 0)), red2);
  if (!leida) await page.waitForTimeout(2500);
}
comprobar(leida, 'la OLT cargada entrega sus placas PON');
await page.evaluate(() => window.ftth.herramientas.senal.pedirEstados({ forzar: true }));
await boton('Agregar placa de OLT').click();
await page.waitForSelector('#carta .carta-form select[name="placa-real"]');
const propuesta = await page.$eval('#carta select[name="placa-real"]', (x) => x.selectedOptions[0].textContent);
comprobar(/^OLT E2E · 0\/1 · H901GPHF · 16 puertos$/.test(propuesta) && (await page.inputValue('#carta input[name="nombre"]')) === 'OLT E2E 0/1',
  `en una placa nueva ya viene elegida la primera placa real, con su nombre (${propuesta})`);
comprobar(/^16 puertos, del 0\/1\/0 al 0\/1\/15 · 12 ONT, 12 en línea, en 4 puertos · emiten de 3,2 a /.test(await texto('#carta .carta-form-nota')),
  `y dice lo que emiten sus puertos (${await texto('#carta .carta-form-nota')})`);
await page.locator('#carta .carta-form').getByRole('button', { name: 'Agregar' }).click();
await page.waitForSelector('#carta .equipo.olt.vinculada .puerto');
let deLaNueva = await page.$$eval('#carta .equipo.olt.vinculada .puerto', (l) => l.map((b) => b.textContent.replace(/\s+/g, ' ').trim()));
comprobar(deLaNueva.length === 16 && deLaNueva[0] === '0/1/03/3' && deLaNueva[3] === '0/1/33/3' && deLaNueva[4] === '0/1/4',
  `agregada con sus 16 puertos, del 0/1/0 al 0/1/15, y las ONT de cada uno (${deLaNueva.slice(0, 5).join(', ')}…)`);
// Una placa ya cargada que numeraba sus puertos desde 1: al vincularla con una real (que numera desde 0), el formulario avisa que se corren.
const manual = await api('api/equipos', 'POST', { elemento: preparar.nodo, tipo: 'olt', nombre: 'Cargada a mano', salidas: 16, datos: {} });
await page.waitForSelector(`#carta [data-bloque="q${manual.data.equipos[0].id}"]`, { timeout: 15000 });
await page.click(`#carta [data-bloque="q${manual.data.equipos[0].id}"] .equipo-cab`);
await boton('Vincular con la placa real').click();
await page.waitForSelector('#carta .carta-form select[name="placa-real"]');
const paraLaManual = await page.$$eval('#carta select[name="placa-real"] option', (o) => o.map((x) => `${x.textContent}${x.disabled ? ' [no]' : ''}`));
await page.selectOption('#carta select[name="placa-real"]', { index: 2 });
comprobar(/0\/1 .*ya está en Central E2E \[no\]/.test(paraLaManual[1])
  && /Ojo: esta placa numeraba sus puertos desde 1 y la real, desde 0: su primer puerto \(PON 1\) pasa a ser el 0\/2\/0/.test(await texto('#carta .carta-form-nota')),
  'al vincular una placa que numeraba desde 1 con una real que numera desde 0, el formulario avisa que los puertos se corren');
await page.locator('#carta .carta-form').getByRole('button', { name: 'Cancelar' }).click();
// Se une el puerto 0/1/0 con la fibra 1 del cable: la luz parte de lo que emite ese puerto (3,2 dBm).
await page.click('#carta .equipo.olt .puerto');
comprobar(/PON 0\/1\/0: 3 ONT, 3 en línea · emite 3,2 dBm/.test(await pie()), 'un puerto todavía sin unir ya dice sus ONT y cuánto emite');
await page.click('#carta .punta .fibra');
await page.waitForSelector('#carta .carta-lineas .linea-union');
await page.waitForSelector('#carta .punta .fibra.luz .luz-dato');
comprobar((await texto('#carta .punta .fibra.luz .luz-dato')) === '3,1' && (await page.locator('#carta .punta .fibra.luz-trafico').count()) === 1,
  'unido a la fibra, la fibra sale con 3,1 dBm (lo que emite el puerto menos la fusión) y con tráfico: el puerto tiene ONT en línea');
await foto('directa');
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
await page.waitForFunction(() => document.getElementById('carta').hidden);
// El recorrido desde el cliente llega al puerto de verdad y estima con lo que emite.
await page.evaluate(() => {
  const { red, ficha } = window.ftth.herramientas;
  const e = [...red.state.elementos.values()].find((x) => x.properties.nombre === 'Cliente de N-2');
  red.seleccionar('elemento', e.id);
  ficha.verElemento(e);
});
await page.waitForSelector('#ficha .ficha-conexion');
const conexion = await texto('#ficha');
comprobar(/Potencia estimada en la ONT: ≈ −9,\d dBm/.test(conexion), `la ficha del cliente estima con cuánto le llega (${conexion.match(/Potencia estimada[^·]*/)?.[0] ?? ''})`);
await page.locator('#ficha').getByRole('button', { name: 'Ver recorrido' }).click();
await page.waitForSelector('#ficha .recorrido');
const recorrido = await texto('#ficha');
comprobar(/el puerto emite 3,2 dBm, leído de la OLT/.test(recorrido) && /OLT E2E PON 0\/1\/0/.test(recorrido) && /Sale de la OLT · 3 ONT, 3 en línea · emite 3,2 dBm/.test(recorrido),
  'y el recorrido sale del PON 0/1/0 de la OLT, con lo que se lee de él');
await page.evaluate(() => window.ftth.herramientas.ficha.cerrar());
// El puerto se queda sin ONT en línea: la carta y el mapa lo ven caído.
await fetch(`${CONTROL}?${SERIES.map((x) => `olt_caer=${x}`).join('&')}`);
let caido = false;
for (let i = 0; i < 10 && !caido; i += 1) {
  await page.evaluate((r) => fetch(`api/olt?red=${r}&refrescar=1`), red2);
  await page.waitForTimeout(2500);
  caido = await page.evaluate((r) => fetch(`api/integracion/estados?red=${r}`).then((x) => x.json())
    .then((d) => d.olts?.[0]?.placas?.[0]?.puertos?.[0]?.nivel === 'caido'), red2);
}
comprobar(caido, 'las tres ONT del puerto 0/1/0 se quedan sin luz: la lectura lo da caído');
await page.evaluate(() => window.ftth.herramientas.senal.pedirEstados({ forzar: true }));
await abrirCartaDelNodo('Central E2E');
await page.waitForSelector('#carta .equipo.olt .puerto.leido-caido', { timeout: 15000 });
deLaNueva = await page.$$eval('#carta .equipo.olt .puerto', (l) => l.map((b) => b.textContent.replace(/\s+/g, ' ').trim()));
comprobar(deLaNueva[0] === '0/1/00/3' && (await page.locator('#carta .equipo.olt .puerto.luz-caida').count()) === 1
  && (await page.locator('#carta .punta .fibra.luz-caida').count()) === 1, 'en la carta, el puerto y su fibra quedan en rojo (0/3)');
await foto('directa-caido');
await page.click('#carta .equipo.olt .puerto.unida');
await boton('En el mapa').click();
await page.waitForSelector('#ficha .ficha-aviso');
comprobar(/El puerto se quedó sin ninguna ONT en línea: si es un corte, está en ese primer tramo, entre Central E2E y N-2/.test(await texto('#ficha .ficha-aviso')),
  '«En el mapa» dice dónde buscar el corte: en el tramo que va sin dividirse');
await page.waitForTimeout(900);
await foto('directa-corte');
if (!(await page.evaluate(() => window.ftth.herramientas.senal.activa()))) await page.click('.senal-boton:not(.olt-boton)');
await page.waitForFunction((id) => (window.ftth.map.getSource('senal')?.serialize().data.features ?? []).some((f) => f.properties.cable === id), preparar.cable, { timeout: 20000 });
const enMapa = await page.evaluate((id) => window.ftth.map.getSource('senal').serialize().data.features.filter((f) => f.properties.estado !== 'red').map((f) => [f.properties.cable === id, f.properties.estado]), preparar.cable);
comprobar(enMapa.length >= 2 && enMapa.every(([, estado]) => estado === 'caida'), `y en el mapa su cable y la bajada del cliente se ven caídos (${enMapa.map(([, e]) => e).join(', ')})`);
await page.click('.senal-boton:not(.olt-boton)');

// --- Se deja todo como estaba
await fetch(`${CONTROL}?${SERIES.map((x) => `olt_volver=${x}`).join('&')}`);
const limpio = await page.evaluate(async ([red, olt]) => {
  const json = (r) => fetch(r).then((x) => x.json());
  const datos = await json(`api/red?red=${red}`);
  const out = [];
  for (const c of datos.cables.features.filter((x) => x.properties.nombre === 'T-E2E')) out.push((await fetch(`api/cables/${c.id}?version=${c.properties.version}`, { method: 'DELETE' })).status);
  for (const e of datos.elementos.features.filter((x) => x.properties.nombre === 'Central E2E')) out.push((await fetch(`api/elementos/${e.id}?version=${e.properties.version}`, { method: 'DELETE' })).status);
  out.push((await fetch(`api/olt/equipos/${olt}?red=${red}`, { method: 'DELETE' })).status);
  const queda = await json(`api/red?red=${red}`);
  return { out, equipos: queda.equipos.filter((e) => e.tipo === 'olt').length, olts: ((await json(`api/olt?red=${red}`)).equipos ?? []).length };
}, [red2, preparar.olt]);
comprobar(limpio.out.every((x) => x === 200) && limpio.equipos === 0 && limpio.olts === 0, 'al final se quitan el nodo, el cable y la OLT de prueba (con el nodo se va su placa)');
await browser.close();
terminar(todos.flat());
