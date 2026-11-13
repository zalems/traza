// Lo de antes sigue andando después de tocar la señal, la ficha y las herramientas:
// prender y apagar la señal, la ficha de la NAP con Wispro, la del cliente, la carta
// con luz, el panel de usuarios y el mapa después de cerrar el tablero de la OLT.
//   node regresion.mjs [movil]
import { abrir, comprobar, terminar } from './lib.mjs';

const movil = process.argv.includes('movil');
const { browser, page, errores } = await abrir(movil ? { ancho: 390, alto: 844, movil: true } : {});
const texto = (sel) => page.textContent(sel).then((t) => (t ?? '').replace(/\s+/g, ' ').trim());
const visible = (capa) => page.evaluate((id) => window.ftth.map.getLayoutProperty(id, 'visibility'), capa);
const elegir = (nombre) => page.evaluate((n) => {
  const { red, ficha } = window.ftth.herramientas;
  const e = [...red.state.elementos.values()].find((x) => x.properties.nombre === n);
  window.ftth.map.jumpTo({ center: e.geometry.coordinates, zoom: 17 });
  red.seleccionar('elemento', e.id);
  ficha.verElemento(e);
  return e.id;
}, nombre);

// --- La señal se prende y se apaga, con las cajas
await page.waitForFunction(() => window.ftth.map.getLayer('senal-cajas-texto'));
comprobar((await visible('senal-linea')) === 'none' && (await visible('senal-cajas-anillo')) === 'none', 'la señal arranca apagada');
await page.click('.senal-boton:not(.olt-boton)');
await page.waitForFunction(() => (window.ftth.map.getSource('senal-cajas')?.serialize().data.features ?? []).length >= 10, null, { timeout: 20000 });
comprobar((await visible('senal-linea')) === 'visible' && (await visible('senal-cajas-anillo')) === 'visible' && (await visible('senal-cajas-texto')) === 'visible', 'al prenderla se ven las fibras y las cajas');
comprobar((await page.evaluate(() => window.ftth.map.getSource('senal').serialize().data.features.length)) > 20, 'hay tramos con luz y con sentido');
await page.click('.senal-boton:not(.olt-boton)');
comprobar((await visible('senal-linea')) === 'none' && (await visible('senal-cajas-anillo')) === 'none', 'al apagarla se van');
comprobar((await page.evaluate(() => window.ftth.map.getSource('senal-cajas').serialize().data.features.length)) === 0, 'y las cajas se vacían');
await page.click('.senal-boton:not(.olt-boton)');

// --- La ficha de la NAP con Wispro y las potencias de sus contratos
await elegir('HP1C1');
await page.waitForSelector('#ficha .integ-contratos .integ-contrato', { timeout: 30000 });
comprobar((await page.locator('#ficha .integ-contrato').count()) === 6, 'los seis contratos de HP1C1');
comprobar(/En Wispro: HP1C1/.test(await texto('#ficha')), 'la caja vinculada con su NAP de Wispro');
comprobar(/dBm/.test(await texto('#ficha .integ-contratos')), 'cada contrato con su potencia');
comprobar((await texto('#ficha .ficha-datos')).includes('Bocas libres10 de 16 (según Wispro)'), 'y las bocas libres arriba');

// --- La carta de esa caja, con luz
await page.locator('#ficha').getByRole('button', { name: 'Carta de empalme' }).click();
await page.waitForSelector('#carta .luz');
comprobar((await page.locator('#carta .luz').count()) >= 6, 'la carta marca lo que tiene luz');
await page.keyboard.press('Escape');
await page.waitForSelector('#ficha .ficha-titulo');
comprobar(await page.isHidden('#carta'), 'Escape cierra la carta y vuelve la ficha');

// --- La ficha de un cliente
await elegir('Benítez Raúl 1');
await page.waitForFunction(() => /dBm/.test(document.querySelector('#ficha')?.textContent ?? ''), null, { timeout: 30000 });
comprobar(/Contrato|contrato/.test(await texto('#ficha')), 'la ficha del cliente trae su contrato y su ONT');

// --- El tablero de la OLT no deja nada trabado al cerrarse
await page.evaluate(() => { window.ftth.herramientas.ficha.cerrar(); window.ftth.herramientas.red.seleccionar(null); });
await page.click('.olt-boton');
await page.waitForSelector('#olt .olt-pestanas');
comprobar(await page.evaluate(() => document.getElementById('map').inert && document.getElementById('herramientas').inert), 'con el tablero abierto, lo de atrás no recibe foco ni toques');
// Una lectura nueva rehace la cabecera y el cuerpo: el foco tiene que quedar donde estaba.
await page.waitForSelector('#olt .olt-cuerpo button');
await page.focus('#olt .olt-actualizar');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.querySelector('#olt .olt-actualizar')?.textContent === 'Actualizar');
comprobar(await page.evaluate(() => document.activeElement?.classList.contains('olt-actualizar')), '«Actualizar» conserva el foco después de leer');
await page.focus('#olt .olt-cuerpo button');
const antes = await page.evaluate(() => document.activeElement.textContent);
await page.evaluate(() => document.querySelector('#olt .olt-actualizar').click());
await page.waitForFunction(() => document.querySelector('#olt .olt-actualizar')?.textContent === 'Actualizar');
await page.waitForTimeout(300);
comprobar(await page.evaluate((t) => document.activeElement?.closest('.olt-cuerpo') && document.activeElement.textContent === t, antes), 'y un botón del cuerpo también');
await page.keyboard.press('Escape');
comprobar(await page.evaluate(() => ![...document.body.children].some((el) => el.inert)), 'al cerrarlo, todo vuelve a responder');
comprobar(await page.evaluate(() => document.activeElement?.classList.contains('olt-boton')), 'y el foco vuelve al botón');

// --- El panel de usuarios
if (await page.isHidden('#usuarios')) await page.click('#more-toggle');
await page.click('#usuarios');
await page.waitForFunction(() => /cuadrilla/.test(document.querySelector('#ficha')?.textContent ?? ''));
comprobar(/prueba/.test(await texto('#ficha')), 'el panel de usuarios lista a los dos');
await browser.close();
terminar(errores);
