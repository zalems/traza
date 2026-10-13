// Protocolo "esri://{z}/{x}/{y}" para MapLibre.
//
// Esri World Imagery no llega al mismo zoom en todos lados. En buena parte del
// interior la imagen propia termina en zoom 17; más allá el servicio responde
// con HTTP 200 y un mosaico gris que dice "Map data not yet available".
//
// Este protocolo reconoce ese mosaico (comparándolo byte a byte con uno de
// referencia que se pide una sola vez) y lo reemplaza por el recorte ampliado
// del nivel más detallado que sí tenga imagen. Así cada zona muestra lo mejor
// que hay: zoom 19 en las ciudades que lo tienen, zoom 17 ampliado en el resto.

const TILE = 256;
const MAX_REMEMBERED = 20000;

export function registerEsriProtocol(maplibregl, { template, name = 'esri' }) {
  const noData = new Set(); // "z/x/y" de mosaicos confirmados sin imagen propia
  let placeholder; // Promise<Uint8Array | null>

  const tileUrl = (z, x, y) => template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  const key = (z, x, y) => `${z}/${x}/${y}`;

  // z23 en la esquina del mundo (océano Ártico): nunca va a tener imagen.
  function getPlaceholder() {
    placeholder ??= fetch(tileUrl(23, 0, 0))
      .then((res) => (res.ok ? res.arrayBuffer() : null))
      .then((buf) => (buf ? new Uint8Array(buf) : null))
      .catch(() => null);
    return placeholder;
  }

  function isPlaceholder(bytes, ref) {
    if (!ref || bytes.length !== ref.length) return false;
    for (let i = 0; i < bytes.length; i += 1) {
      if (bytes[i] !== ref[i]) return false;
    }
    return true;
  }

  async function fetchTile(z, x, y, signal) {
    const res = await fetch(tileUrl(z, x, y), { signal });
    if (!res.ok) throw new Error(`Esri respondió ${res.status} para ${key(z, x, y)}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  // Recorta del mosaico ancestro la porción que corresponde a (z, x, y) y la
  // lleva a 256 px. Toma un píxel de margen para que la interpolación no deje
  // costuras entre mosaicos vecinos.
  async function cropFromAncestor(bytes, levelsUp, x, y) {
    const perSide = 2 ** levelsUp;
    const size = TILE / perSide;
    const sx = (x % perSide) * size;
    const sy = (y % perSide) * size;
    const scale = TILE / size;

    const source = await createImageBitmap(new Blob([bytes]));
    const canvas = document.createElement('canvas');
    canvas.width = TILE;
    canvas.height = TILE;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, sx - 1, sy - 1, size + 2, size + 2, -scale, -scale, TILE + 2 * scale, TILE + 2 * scale);
    source.close?.();
    return createImageBitmap(canvas);
  }

  maplibregl.addProtocol(name, async (params, abortController) => {
    const [z, x, y] = params.url.slice(name.length + 3).split('/').map(Number);
    const ref = await getPlaceholder();

    // Si la tesela o algún ancestro ya se sabe vacío, arrancar desde el padre
    // del más alto: todo lo que cuelga de un mosaico vacío también lo está.
    let zz = z;
    let xx = x;
    let yy = y;
    for (let az = z, ax = x, ay = y; az > 0; az -= 1, ax >>= 1, ay >>= 1) {
      if (noData.has(key(az, ax, ay))) {
        zz = az - 1;
        xx = ax >> 1;
        yy = ay >> 1;
      }
    }

    let bytes;
    for (;;) {
      bytes = await fetchTile(zz, xx, yy, abortController.signal);
      if (zz === 0 || !isPlaceholder(bytes, ref)) break;
      if (noData.size >= MAX_REMEMBERED) noData.clear();
      noData.add(key(zz, xx, yy));
      zz -= 1;
      xx >>= 1;
      yy >>= 1;
    }

    if (zz === z) return { data: bytes.buffer };
    return { data: await cropFromAncestor(bytes, z - zz, x, y) };
  });
}
