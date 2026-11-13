// Ayudas para las pruebas en navegador (ver LEEME.md): entrar, esperar la red y anotar lo que falla.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
// Playwright no se instala con el kit: PLAYWRIGHT_MODULOS dice dónde está su node_modules.
const require = createRequire(process.env.PLAYWRIGHT_MODULOS ?? '/opt/npm-tools/node_modules/');
export const { chromium } = require('playwright');
export const BASE = process.env.FTTH_BASE ?? 'http://127.0.0.1:8080';
export const CAPTURAS = `${process.env.FTTH_CAPTURAS ?? `${tmpdir()}/traza-capturas`}/`;
mkdirSync(CAPTURAS, { recursive: true });

export async function abrir({ ancho = 1280, alto = 800, movil = false, oscuro = false, senal = false, red = 1, escala = 1,
  usuario = 'prueba', clave = 'Clave-de-prueba-2026' } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: ancho, height: alto }, colorScheme: oscuro ? 'dark' : 'light', hasTouch: movil, isMobile: movil,
    deviceScaleFactor: escala, locale: 'es-AR', timezoneId: 'America/Argentina/Buenos_Aires',
  });
  await ctx.addInitScript(([r, s]) => {
    try {
      if (r !== null && !localStorage.getItem('ftth.red')) localStorage.setItem('ftth.red', String(r));
      if (s && localStorage.getItem('ftth.senal') === null) localStorage.setItem('ftth.senal', '1');
    } catch { /* sin almacenamiento */ }
  }, [red, senal]);
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/tiles|pmtiles|Failed to load resource|ign\.gob|arcgis/i.test(m.text())) errores.push(`console: ${m.text()}`);
  });
  await page.goto(`${BASE}/login.html`);
  await page.fill('#usuario', usuario);
  await page.fill('#clave', clave);
  await Promise.all([page.waitForURL((u) => !u.pathname.endsWith('login.html')), page.click('#entrar')]);
  const pedidos = new Map();
  const rechazos = []; // lo que la API o la sesión contestaron mal mientras cargaba
  page.on('response', (r) => {
    if (r.status() >= 400 && /\/(api|auth)\//.test(r.url())) rechazos.push(`${r.status()} ${r.request().method()} ${r.url().slice(BASE.length, BASE.length + 90)}`);
  });
  page.on('request', (r) => pedidos.set(r, Date.now()));
  page.on('requestfinished', (r) => pedidos.delete(r));
  page.on('requestfailed', (r) => pedidos.delete(r));
  try {
    await page.waitForFunction(() => window.ftth?.herramientas?.red?.state?.cargada === true, null, { timeout: 30000 });
  } catch (err) {
    // Para entender una carga que no termina: qué hay en la página y qué pedidos siguen esperando.
    const estado = await page.evaluate(() => ({ ftth: Boolean(window.ftth), red: window.ftth?.herramientas?.red?.state?.red ?? null,
      cargada: window.ftth?.herramientas?.red?.state?.cargada ?? null, url: location.href, aviso: document.querySelector('#notice-text')?.textContent ?? '' }));
    console.log('  !!  la red no cargó:', JSON.stringify(estado));
    for (const [r, t] of pedidos) console.log(`       esperando hace ${Math.round((Date.now() - t) / 1000)} s: ${r.method()} ${r.url().slice(0, 110)}`);
    for (const r of rechazos) console.log('        respondió', r);
    for (const e of errores) console.log('       ', e);
    throw err;
  }
  return { browser, ctx, page, errores };
}

let fallas = 0;
export function comprobar(cond, texto) {
  if (cond) console.log(`  ok  ${texto}`);
  else {
    fallas += 1;
    console.log(`  !!  ${texto}`);
  }
}
export function terminar(errores = []) {
  for (const e of errores) console.log(`  !!  error en la página: ${e}`);
  const total = fallas + errores.length;
  console.log(total ? `\n${total} cosas para revisar` : '\nTodo bien');
  process.exit(total ? 1 : 0);
}
