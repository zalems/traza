// El tablero de la OLT: resumen y novedades, puertos PON, ONT con su historia, cajas,
// los anillos de las cajas en el mapa y las filas nuevas de la ficha de la NAP.
//   node olt.mjs [movil] [oscuro]
import { abrir, comprobar, terminar, CAPTURAS } from './lib.mjs';

const movil = process.argv.includes('movil');
const oscuro = process.argv.includes('oscuro');
const sufijo = `${movil ? '390' : '1280'}${oscuro ? '-oscuro' : ''}`;
const { browser, page, errores } = await abrir(movil ? { ancho: 390, alto: 844, movil: true, oscuro, senal: true } : { oscuro, senal: true });
const foto = (nombre) => page.screenshot({ path: `${CAPTURAS}t29-${sufijo}-${nombre}.png` });
const texto = (sel) => page.textContent(sel).then((t) => (t ?? '').replace(/\s+/g, ' ').trim());

// --- En el mapa: anillos de las cajas y la leyenda
await page.waitForFunction(() => window.ftth.map.getLayer('senal-cajas-anillo'));
await page.evaluate(() => {
  const s = window.ftth.herramientas.red.state;
  const nap = [...s.elementos.values()].find((e) => e.properties.nombre === 'HP1C3');
  window.ftth.map.jumpTo({ center: nap.geometry.coordinates, zoom: 16.6 });
});
await page.waitForFunction(() => (window.ftth.map.getSource('senal-cajas')?.serialize().data.features ?? []).length >= 10, null, { timeout: 20000 });
const cajasMapa = await page.evaluate(() => Object.fromEntries(window.ftth.map.getSource('senal-cajas').serialize().data.features
  .map((f) => [window.ftth.herramientas.red.state.elementos.get(f.properties.id).properties.nombre, `${f.properties.nivel}|${f.properties.texto}`])));
comprobar(cajasMapa.HP1C1 === 'bien|−21,9 · 10 libres', `HP1C1 en el mapa: ${cajasMapa.HP1C1}`);
comprobar(cajasMapa.HP1C2 === 'bien|−20,4 · llena', `HP1C2 llena: ${cajasMapa.HP1C2}`);
comprobar(cajasMapa.HP1C3 === 'mal|−26,4 · 9 libres', `HP1C3 con señal baja: ${cajasMapa.HP1C3}`);
comprobar(cajasMapa.HP1C5 === 'caida|sin señal · 10 libres', `HP1C5 sin señal: ${cajasMapa.HP1C5}`);
comprobar(cajasMapa.HP1C9 === 'bien|−21,4 · llena', `HP1C9 sobrecargada: ${cajasMapa.HP1C9}`);
await page.waitForTimeout(1500);
if (movil) await page.click('.senal-titulo');
await page.waitForSelector('.senal-ver-cajas');
comprobar(/10 cajas con lecturas · 4 para revisar/.test(await texto('.senal-leyenda')), 'la leyenda cuenta las cajas con lecturas y para revisar');
comprobar((await page.locator('.senal-anillo').count()) === 3, 'la leyenda muestra los anillos');
await foto('mapa');

// --- La ficha de la NAP: bocas libres y sus clientes
if (movil) await page.click('.senal-titulo');
await page.evaluate(() => {
  const s = window.ftth.herramientas.red.state;
  const nap = [...s.elementos.values()].find((e) => e.properties.nombre === 'HP1C3');
  window.ftth.herramientas.red.seleccionar('elemento', nap.id);
  window.ftth.herramientas.ficha.verElemento(nap);
});
await page.waitForSelector('#ficha .ficha-datos');
const ficha = await texto('#ficha .ficha-datos');
comprobar(ficha.includes('Bocas libres9 de 16 (según Wispro)'), 'la ficha de HP1C3 dice las bocas libres');
comprobar(ficha.includes('Sus clientes7 clientes · 7 en línea · reciben −26,4 dBm en promedio (el peor, −28,6)'), `la ficha dice cómo reciben sus clientes`);
await foto('ficha-nap');
await page.evaluate(() => { window.ftth.herramientas.ficha.cerrar(); window.ftth.herramientas.red.seleccionar(null); });

// --- El tablero: resumen
await page.click('.olt-boton');
await page.waitForSelector('#olt .olt-cifras');
comprobar((await texto('#olt .olt-titulo strong')) === 'ALVATIC-MA5800-01', 'el título es la OLT de la red');
const cifras = await page.locator('#olt .olt-cifra strong').allTextContents();
comprobar(cifras.join(',') === '66,47,19,7,3', `las cuentas: ${cifras.join(',')}`);
comprobar((await texto('#olt .olt-cifra.nivel-caida')).includes('17 sin luz · 2 sin energía'), 'sin señal, por causa');
const novedades = await page.locator('#olt .olt-novedad').allTextContents();
comprobar(novedades.length >= 3, `las novedades (${novedades.length})`);
const caja5 = novedades.find((n) => n.includes('HP1C5')) ?? '';
comprobar(caja5.includes('PON 0/1/2: 6 ONT cayeron juntas (sin luz: corte de fibra) · son de HP1C5 (la caja entera)') && caja5.includes('hace 3 h'), 'la caída de HP1C5, con su hora');
comprobar(caja5.includes('En el mapa, todas cuelgan de HP1C5 y abajo no queda nadie más: el corte está en HP1C5 o en el cable D-HP1C5, que le llega.'), 'la caída ubicada en el mapa');
comprobar(novedades[0].includes('PON 0/1/3: ninguna de sus 11 ONT está en línea') && novedades[1] === caja5, 'primero lo último que cayó: el PON caído hace 40 minutos');
comprobar(novedades.some((n) => n.includes('1 ONT recibe −28,0 dBm o menos')), 'la señal crítica');
comprobar(await page.evaluate(() => document.body.classList.contains('con-olt')), 'el mapa queda en pausa con el tablero abierto');
comprobar(!/\b(null|undefined|NaN)\b/.test(await texto('#olt')), 'ningún «null» a la vista en resumen');
await foto('resumen');

// --- Puertos PON
await page.click('[data-pestana="puertos"]');
await page.waitForSelector('#olt .olt-tabla tbody tr');
const filas = await page.locator('#olt .olt-tabla tbody tr').count();
comprobar(filas === 5, `cinco puertos PON (${filas})`);
const caido = await texto('#olt .olt-tabla tbody tr.nivel-caida');
comprobar(caido.includes('0/1/3') && caido.includes('caído') && caido.includes('11 (11 sin luz)'), 'el 0/1/3 figura caído, con la causa');
const justo = await texto('#olt .olt-tabla tbody tr.nivel-atencion');
comprobar(justo.includes('0/1/1') && justo.includes('−23,7 dBm') && justo.includes('−28,6'), 'el 0/1/1 con su promedio y su peor');
comprobar(!/\b(null|undefined|NaN)\b/.test(await texto('#olt')), 'ningún «null» a la vista en puertos');
await foto('puertos');
await page.locator('#olt .olt-tabla tbody tr', { hasText: '0/1/1' }).getByRole('button', { name: 'Ver sus ONT' }).click();
await page.waitForSelector('#olt .olt-lista-onts li');
comprobar((await texto('#olt .olt-cuantas')) === '12 de 66 ONT', 'las ONT del puerto elegido');

// --- ONT: buscar, filtrar, ordenar y la historia de una
await page.selectOption('#olt .olt-sel-pon', '');
await page.fill('#olt .olt-buscar input', 'nuñez');
await page.waitForFunction(() => /de 66 ONT/.test(document.querySelector('#olt .olt-cuantas').textContent));
comprobar(await page.evaluate(() => document.activeElement === document.querySelector('#olt .olt-buscar input')), 'el buscador conserva el foco al escribir');
const hallados = await page.locator('#olt .olt-lista-onts .olt-fila-nombre').allTextContents();
comprobar(hallados.length === 3 && hallados.every((n) => /Núñez/.test(n)), `busca sin tildes ni mayúsculas (${hallados.length})`);
await page.fill('#olt .olt-buscar input', '0/1/1:5');
await page.waitForFunction(() => document.querySelectorAll('#olt .olt-lista-onts li').length === 1);
await page.fill('#olt .olt-buscar input', '');
await page.click('#olt .olt-chips [data-estado="baja"]');
comprobar((await texto('#olt .olt-cuantas')) === '7 de 66 ONT', 'el filtro de señal baja');
await page.selectOption('#olt .olt-sel-orden', 'potencia');
const primera = await texto('#olt .olt-lista-onts li:first-child .olt-fila');
comprobar(primera.includes('−28,6 dBm') && primera.includes('HP1C3'), `la peor primero: ${primera}`);
await page.click('#olt .olt-lista-onts li:first-child .olt-fila');
await page.waitForSelector('#olt .olt-detalle .grafico svg path.grafico-linea');
const detalle = await texto('#olt .olt-detalle');
comprobar(detalle.includes('Recibe−28,60 dBm · al límite') && detalle.includes('Contrato#1') && detalle.includes('CajaHP1C3'), 'el detalle de la ONT');
comprobar(detalle.includes('Viene bajando 0,6 dB por semana'), 'la tendencia');
comprobar(detalle.includes('apareció en la OLT'), 'sus eventos');
comprobar((await page.locator('#olt .olt-detalle .grafico-umbral').count()) >= 1, 'la curva marca los umbrales');
comprobar(!/\b(null|undefined|NaN)\b/.test(await texto('#olt')), 'ningún «null» a la vista en las ONT');
await foto('ont');
await page.locator('#olt .olt-detalle .olt-lapsos button', { hasText: '24 h' }).click();
await page.waitForFunction(() => document.querySelector('#olt .olt-detalle .olt-lapsos button[aria-pressed="true"]')?.textContent === '24 h'
  && document.querySelector('#olt .olt-detalle .grafico'));
comprobar(true, 'se cambia el lapso de la curva');
// Sin señal, lo último que cayó primero.
await page.click('#olt .olt-chips [data-estado="caidas"]');
await page.selectOption('#olt .olt-sel-orden', 'caida');
const ultima = await texto('#olt .olt-lista-onts li:first-child .olt-fila');
comprobar(/sin señal/.test(ultima) && /0\/1\/3/.test(ultima) && /cayó hace (39|40|41) min, sin luz/.test(ultima), `lo último que cayó: ${ultima}`);
await page.click('#olt .olt-chips [data-estado="sin-mapa"]');
comprobar((await texto('#olt .olt-cuantas')) === '3 de 66 ONT', 'las ONT sin cliente en el mapa');
await page.click('#olt .olt-lista-onts li:first-child .olt-fila');
await page.waitForSelector('#olt .olt-detalle');
comprobar((await texto('#olt .olt-detalle')).includes('no tiene su cliente en el mapa'), 'dice que falta su cliente en el mapa');

// --- Desde una novedad a sus ONT y al mapa
await page.click('[data-pestana="resumen"]');
await page.locator('#olt .olt-novedad', { hasText: 'HP1C5' }).getByRole('button', { name: 'Ver las 6 ONT' }).click();
await page.waitForSelector('#olt .olt-grupo');
comprobar((await texto('#olt .olt-cuantas')) === '6 de 66 ONT', 'las ONT de la novedad');
await page.click('#olt .olt-grupo button');
comprobar((await texto('#olt .olt-cuantas')) === '66 ONT', '«Ver todas» quita el grupo');
await page.click('[data-pestana="resumen"]');
await page.locator('#olt .olt-novedad', { hasText: 'HP1C5' }).getByRole('button', { name: 'Ver en el mapa' }).click();
await page.waitForSelector('#ficha .ficha-titulo');
comprobar(await page.isHidden('#olt'), 'el tablero se cierra al ir al mapa');
comprobar((await texto('#ficha .ficha-titulo strong')) === 'HP1C5', 'queda abierta la caja del corte');

// --- Cajas
await page.evaluate(() => window.ftth.herramientas.ficha.cerrar());
if (movil) await page.click('.senal-titulo');
await page.click('.senal-ver-cajas');
await page.waitForSelector('#olt .olt-lista-cajas li');
comprobar(await page.evaluate(() => document.querySelector('[data-pestana="cajas"]').getAttribute('aria-selected') === 'true'), '«Ver las cajas» abre esa pestaña');
comprobar((await texto('#olt .olt-cuantas')) === '10 cajas · 82 bocas libres en 8 · 5 para revisar', `el resumen de cajas: ${await texto('#olt .olt-cuantas')}`);
const c1 = await texto('#olt .olt-lista-cajas li:first-child');
comprobar(c1.includes('HP1C1') && c1.includes('−21,9 dBm') && c1.includes('Bocas libres: 10 de 16 (según Wispro)') && c1.includes('6 clientes · 6 en línea'), `la primera caja: ${c1}`);
comprobar(!/\b(null|undefined|NaN)\b/.test(await texto('#olt')), 'ningún «null» a la vista en cajas');
await foto('cajas');
await page.locator('#olt .olt-chips button', { hasText: 'Para revisar' }).click();
comprobar((await page.locator('#olt .olt-lista-cajas li').count()) === 5, 'las cajas para revisar');
await page.selectOption('#olt .olt-sel-orden-cajas', 'potencia');
const peorCaja = await texto('#olt .olt-lista-cajas li:first-child');
comprobar(/HP1C(5|7|8)/.test(peorCaja) && peorCaja.includes('sin señal'), `lo peor primero: ${peorCaja}`);
await page.locator('#olt .olt-chips button', { hasText: 'Con bocas libres' }).click();
await page.selectOption('#olt .olt-sel-orden-cajas', 'libres');
comprobar((await texto('#olt .olt-lista-cajas li:first-child .olt-fila-nombre')) === 'HP1C10', 'más bocas libres primero');
await page.getByRole('button', { name: 'Copiar la lista' }).click();
await page.waitForSelector('#olt .olt-copia, #toast:not([hidden])');
const copia = await page.evaluate(() => document.querySelector('#olt .olt-copia')?.value ?? document.querySelector('#toast').textContent);
comprobar(/HP1C10 · 12 de 16 libres · −20,[0-9] dBm \(peor −2[0-9],[0-9]\) · 3 de 4 en línea|Lista copiada/.test(copia), `la lista para copiar: ${copia.split('\n')[0]}`);
await page.locator('#olt .olt-lista-cajas li:first-child .olt-fila').click();
await page.waitForSelector('#ficha .ficha-titulo');
comprobar((await texto('#ficha .ficha-titulo strong')) === 'HP1C10' && await page.isHidden('#olt'), 'tocar una caja la abre en el mapa');

// --- Teclado: flechas entre pestañas y Escape
await page.evaluate(() => window.ftth.herramientas.ficha.cerrar());
await page.evaluate(() => window.ftth.herramientas.olt.abrir('resumen'));
await page.waitForSelector('#olt .olt-cifras');
await page.focus('[data-pestana="resumen"]');
await page.keyboard.press('ArrowRight');
comprobar(await page.evaluate(() => document.activeElement?.dataset.pestana === 'puertos' && document.activeElement.getAttribute('aria-selected') === 'true'), 'las flechas cambian de pestaña');
await page.keyboard.press('Escape');
comprobar(await page.isHidden('#olt'), 'Escape cierra el tablero');
const desborde = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
comprobar(desborde <= 0, 'la página no se desborda de costado');
await browser.close();
terminar(errores);
