// El tablero de la OLT con historia (curvas, lo que cayó y volvió, un puerto que pierde
// potencia), en «todas las redes», en una red sin OLT y con un usuario de una sola red.
//   node olt-historia.mjs [movil]
import { abrir, comprobar, terminar, CAPTURAS } from './lib.mjs';

const movil = process.argv.includes('movil');
const sufijo = movil ? '390' : '1280';
const texto = (page, sel) => page.textContent(sel).then((t) => (t ?? '').replace(/\s+/g, ' ').trim());
let { browser, page, errores } = await abrir(movil ? { ancho: 390, alto: 844, movil: true } : {});
const todos = [...errores];

// --- Resumen con historia
await page.click('.olt-boton');
await page.waitForSelector('#olt .grafico svg path.grafico-linea.en-linea');
const novedades = await page.locator('#olt .olt-novedad').allTextContents();
comprobar(novedades.some((n) => /PON 0\/1\/1: la potencia promedio bajó 1,[5-7] dB en una semana \(de −22,1 a −23,7 dBm\)/.test(n)), 'avisa el puerto que perdió potencia');
const baja = novedades.find((n) => n.includes('la potencia promedio bajó'));
comprobar(!/corte/.test(baja) && /Ver las 12 ONT/.test(baja) && /Ver en el mapa/.test(baja), 'de una pérdida de potencia no dice dónde está el corte');
comprobar((await page.locator('#olt .olt-bloque .grafico-linea').count()) === 2, 'la curva de ONT en línea y la de las que hay en la OLT');
const pie = await texto(page, '#olt .olt-bloque:has(.grafico) .olt-nota');
comprobar(/Ahora 47 de 66\. El mínimo del lapso: 4[0-9] \(/.test(pie), `el pie de la curva: ${pie}`);
const recientes = await page.locator('#olt .olt-reciente').allTextContents();
comprobar(recientes.length === 3 && /PON 0\/2\/0 · cayó 1 ONT \(sin energía\)/.test(recientes[0].replace(/\s+/g, ' ')), `lo que cayó y volvió: ${recientes.length}`);
comprobar(/cayeron 7 ONT \(sin luz\)/.test(recientes[2]) && /volvieron 7 ONT/.test(recientes[1]), 'la caída de ayer y su vuelta');
await page.locator('#olt .olt-lapsos button', { hasText: '7 días' }).first().click();
await page.waitForFunction(() => /^\d+\/\d+$/.test(document.querySelector('#olt .grafico-eje span')?.textContent ?? ''));
comprobar(true, 'con 7 días el eje pasa a fechas');
await page.locator('#olt .olt-bloque:has(.grafico)').scrollIntoViewIfNeeded();
await page.screenshot({ path: `${CAPTURAS}t30-${sufijo}-historia.png` });
await page.locator('#olt .olt-reciente', { hasText: 'cayeron 7' }).getByRole('button', { name: 'Ver' }).click();
await page.waitForSelector('#olt .olt-grupo');
comprobar((await texto(page, '#olt .olt-cuantas')) === '7 de 66 ONT', 'las ONT de esa caída, por su número de serie');

// --- La historia de un puerto
await page.click('[data-pestana="puertos"]');
await page.locator('#olt .olt-tabla tbody tr', { hasText: '0/1/1' }).getByRole('button', { name: 'Historia' }).click();
await page.waitForSelector('#olt .olt-historia-pon .grafico-linea.peor');
comprobar((await page.locator('#olt .olt-historia-pon .grafico').count()) === 2, 'dos curvas: ONT en línea y potencia');
comprobar((await page.locator('#olt .olt-historia-pon .grafico-umbral').count()) >= 1, 'la de potencia marca los umbrales');
await page.locator('#olt .olt-historia-pon').scrollIntoViewIfNeeded();
await page.screenshot({ path: `${CAPTURAS}t30-${sufijo}-puerto.png` });
await page.locator('#olt .olt-tabla tbody tr', { hasText: '0/1/1' }).getByRole('button', { name: 'Historia' }).click();
comprobar((await page.locator('#olt .olt-historia-pon').count()) === 0, 'la historia del puerto se pliega');
await page.keyboard.press('Escape');

// --- Todas las redes: se elige de cuál se mira la OLT
await page.evaluate(() => window.ftth.herramientas.red.state.red);
await page.click('#red-chip');
await page.waitForSelector('#red-todas');
await page.click('#red-todas', { force: true });
await page.waitForFunction(() => window.ftth.herramientas.red.state.red === 'todas' && window.ftth.herramientas.red.state.cargada);
if (await page.isVisible('#ficha .ficha-cerrar')) await page.click('#ficha .ficha-cerrar');
await page.click('.olt-boton');
await page.waitForSelector('#olt .olt-red select');
comprobar(await page.evaluate(() => document.querySelector('[data-pestana="puertos"]').getAttribute('aria-selected') === 'true'), 'se abre en la pestaña que se miró la última vez');
await page.click('[data-pestana="resumen"]');
await page.waitForSelector('#olt .olt-cifras');
comprobar((await page.locator('#olt .olt-red option').allTextContents()).join('|') === 'Formosa prueba|Sin OLT', 'en todas las redes se elige la red');
await page.selectOption('#olt .olt-red select', { label: 'Sin OLT' });
await page.waitForSelector('#olt .olt-comando');
comprobar((await texto(page, '#olt .olt-comando')) === 'sudo /srv/ftth/bin/integraciones panel "Sin OLT" http://DIRECCIÓN-DEL-PANEL:8080 --olt N', 'la red sin OLT dice cómo conectarla');
await page.screenshot({ path: `${CAPTURAS}t30-${sufijo}-sin-olt.png` });
await page.click('[data-pestana="cajas"]');
await page.waitForSelector('#olt .olt-lista-cajas li');
comprobar((await page.locator('#olt .olt-lista-cajas li').count()) === 12, 'en todas las redes, las cajas de todas');
await page.keyboard.press('Escape');
await browser.close();

// --- Un usuario de una sola red, sin OLT: las cajas salen de las cartas
({ browser, page, errores } = await abrir({ ...(movil ? { ancho: 390, alto: 844, movil: true } : {}), usuario: 'cuadrilla', clave: 'Clave-cuadrilla-2026', red: null }));
todos.push(...errores);
comprobar(await page.evaluate(() => window.ftth.herramientas.red.state.red === 2), 'entra directo a su red');
await page.click('.olt-boton');
await page.waitForSelector('#olt .olt-comando');
comprobar(await page.isHidden('#olt .olt-red'), 'no elige red');
await page.click('[data-pestana="cajas"]');
await page.waitForSelector('#olt .olt-lista-cajas li');
const cajas = (await page.locator('#olt .olt-lista-cajas li').allTextContents()).map((t) => t.replace(/\s+/g, ' '));
comprobar(cajas.length === 2 && cajas[0].includes('N-1') && cajas[0].includes('Bocas libres: 8 de 8 (según la carta)'), `la caja con las bocas anotadas: ${cajas[0]}`);
comprobar(cajas[1].includes('N-2') && cajas[1].includes('Bocas libres: 7 de 8 (según la carta) · 1 cliente'), `la caja con splitter y un cliente: ${cajas[1]}`);
comprobar((await texto(page, '#olt .olt-cuerpo')).includes('Sin Wispro ni OLT conectados'), 'dice de dónde salen los datos');
const ajena = await page.evaluate(() => fetch('api/olt?red=1').then((r) => r.status));
comprobar(ajena === 403, 'la OLT de otra red no se le entrega (403)');
await page.screenshot({ path: `${CAPTURAS}t30-${sufijo}-cajas-carta.png` });
await browser.close();
terminar(todos);
