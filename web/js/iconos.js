// Íconos: los mismos dibujos (24 × 24, de trazo) sirven para la barra de
// herramientas y, dentro de un disco del color de cada tipo, para el mapa.

import { ELEMENTOS } from './modelo.js';

export const GLIFOS = {
  ver: '<path d="M5 3l14 8-6 2-3 6z"/>',
  nodo: '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>',
  poste: '<path d="M12 3v18M7 7h10M8 21h8"/>',
  caja: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 11h16"/>',
  nap: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="10" r="1.2"/><circle cx="15" cy="10" r="1.2"/><circle cx="9" cy="15" r="1.2"/><circle cx="15" cy="15" r="1.2"/>',
  botella: '<rect x="7" y="3" width="10" height="18" rx="5"/><path d="M7 9h10M7 15h10"/>',
  cliente: '<path d="M4 11.5 12 5l8 6.5"/><path d="M6.5 10v9.5h11V10"/><path d="M10.5 19.5v-5h3v5"/>',
  reserva: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="M20 12h2"/>',
  cable: '<path d="M3 18c4 0 4-10 8-10s4 8 8 8"/><circle cx="3" cy="18" r="1.8"/><circle cx="19" cy="16" r="1.8"/>',
  red: '<circle cx="12" cy="5" r="2.2"/><circle cx="5" cy="19" r="2.2"/><circle cx="19" cy="19" r="2.2"/><path d="M12 7.2V12m0 0-5.4 5.4M12 12l5.4 5.4"/>',
};

export const svgIcono = (nombre) => `<svg viewBox="0 0 24 24" aria-hidden="true">${GLIFOS[nombre] ?? ''}</svg>`;

export const VARIANTES = ['lleno', 'proyectado', 'baja'];
const GRIS_BAJA = '#9aa3ab';

// Marcador del mapa, dibujado al doble de resolución (pixelRatio 2).
function svgMarcador(tipo, variante) {
  const def = ELEMENTOS[tipo];
  const d = def.tam * 2; // diámetro en px del dibujo
  const w = d + 8;
  const c = w / 2;
  const relleno = variante === 'proyectado' ? '#ffffff' : variante === 'baja' ? GRIS_BAJA : def.color;
  const borde = variante === 'proyectado' ? def.color : '#ffffff';
  const trazo = variante === 'proyectado' ? def.color : '#ffffff';
  const grosor = tipo === 'poste' ? 4 : 5;
  const guiones = variante === 'proyectado' ? ' stroke-dasharray="7 4"' : '';
  const r = d / 2 - grosor / 2;
  const forma = tipo === 'nodo'
    ? (k, extra) => `<rect x="${c - r - k}" y="${c - r - k}" width="${2 * (r + k)}" height="${2 * (r + k)}" rx="${d * 0.22}" ${extra}/>`
    : (k, extra) => `<circle cx="${c}" cy="${c}" r="${r + k}" ${extra}/>`;
  let glifo = '';
  if (tipo !== 'poste') {
    const escala = (d * 0.56) / 24;
    const desde = c - 12 * escala;
    glifo = `<g transform="translate(${desde} ${desde}) scale(${escala})" fill="none" stroke="${trazo}" stroke-width="2.3" `
      + `stroke-linecap="round" stroke-linejoin="round">${GLIFOS[tipo]}</g>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${w}" viewBox="0 0 ${w} ${w}">`
    + forma(grosor / 2 + 1, 'fill="none" stroke="rgba(0,0,0,0.38)" stroke-width="2"')
    + forma(0, `fill="${relleno}" stroke="${borde}" stroke-width="${grosor}"${guiones}`)
    + glifo
    + '</svg>';
}

async function cargarImagen(svg) {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  return img;
}

export const idIcono = (tipo, variante) => `red-${tipo}-${variante}`;

// Registra en el mapa un ícono por tipo y variante. Hay que esperarlo antes
// de agregar las capas que los usan.
export async function registrarIconos(map) {
  const pendientes = [];
  for (const tipo of Object.keys(ELEMENTOS)) {
    for (const variante of VARIANTES) {
      pendientes.push(cargarImagen(svgMarcador(tipo, variante)).then((img) => [idIcono(tipo, variante), img]));
    }
  }
  for (const [id, img] of await Promise.all(pendientes)) {
    if (map.hasImage(id)) map.removeImage(id);
    map.addImage(id, img, { pixelRatio: 2 });
  }
}
