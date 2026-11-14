// Humo: entrar, cargar la red, prender la señal y abrir una caja; y que la red cargue aunque el mapa de fondo no llegue.
import { abrir, comprobar, terminar, CAPTURAS } from './lib.mjs';
let { browser, page, errores } = await abrir({ senal: true });
const todos = [...errores];
const n = await page.evaluate(() => window.ftth.herramientas.red.state.elementos.size);
comprobar(n >= 75, `la red cargó (${n} elementos)`);
await page.waitForSelector('.senal-leyenda:not([hidden])');
await page.evaluate(() => {
  const s = window.ftth.herramientas.red.state;
  const nap = [...s.elementos.values()].find((e) => e.properties.nombre === 'HP1C1');
  window.ftth.map.jumpTo({ center: nap.geometry.coordinates, zoom: 16.2 });
});
await page.waitForTimeout(2500);
comprobar(/cables? con luz|Luz en/.test(await page.textContent('.senal-leyenda')), 'la leyenda de la señal dice cuántos cables tienen luz');
await page.screenshot({ path: `${CAPTURAS}t00-senal.png` });
await browser.close();

// El mapa de fondo viene de otros servidores (IGN, satélite): si no contestan, la red se tiene que ver igual.
// (abrir espera a que la red cargue: si dependiera del fondo, se quedaría esperando.)
({ browser, page, errores } = await abrir({ sinFondo: true, movil: true, ancho: 390, alto: 844, usuario: 'cuadrilla', clave: 'Clave-cuadrilla-2026', red: null }));
todos.push(...errores);
const sinFondo = await page.evaluate(() => ({ red: window.ftth.herramientas.red.state.red, elementos: window.ftth.herramientas.red.state.elementos.size,
  capas: Boolean(window.ftth.map.getLayer('red-elementos')) }));
comprobar(sinFondo.red !== null && sinFondo.elementos >= 1 && sinFondo.capas, `con el mapa de fondo sin contestar, la red carga igual (${sinFondo.elementos} elementos)`);
await page.screenshot({ path: `${CAPTURAS}t00-sin-fondo.png` });
await browser.close();
terminar(todos);
