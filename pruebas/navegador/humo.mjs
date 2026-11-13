// Humo: entrar, cargar la red, prender la señal y abrir una caja.
import { abrir, comprobar, terminar, CAPTURAS } from './lib.mjs';
const { browser, page, errores } = await abrir({ senal: true });
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
terminar(errores);
