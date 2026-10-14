// Vocabulario de la red: tipos de elemento y de cable, estados, campos de
// cada ficha y colores. Lo comparten el mapa, las herramientas y las fichas.

// tam: diámetro del ícono en el mapa (px). orden: los de número mayor se
// dibujan encima cuando se superponen.
export const ELEMENTOS = {
  nodo: { label: 'Nodo', nombre: 'Nodo / OLT', genero: 'm', prefijo: 'NODO', color: '#111827', tam: 30, orden: 7, descripcion: 'Nodo, central u OLT' },
  poste: { label: 'Poste', nombre: 'Poste', genero: 'm', prefijo: 'P', color: '#6f7a85', tam: 15, orden: 1, descripcion: 'Poste donde se sostiene el cable' },
  caja: { label: 'Caja', nombre: 'Caja de distribución', genero: 'f', prefijo: 'CJ', color: '#6d28d9', tam: 26, orden: 5, descripcion: 'Caja de distribución' },
  nap: { label: 'NAP', nombre: 'NAP', genero: 'f', prefijo: 'NAP', color: '#e8590c', tam: 26, orden: 6, descripcion: 'Caja terminal de abonados' },
  botella: { label: 'Botella', nombre: 'Botella de empalme', genero: 'f', prefijo: 'BOT', color: '#0e7490', tam: 26, orden: 4, descripcion: 'Botella o mufa de empalme' },
  cliente: { label: 'Cliente', nombre: 'Cliente', genero: 'm', prefijo: 'CLI', color: '#15803d', tam: 21, orden: 3, descripcion: 'Domicilio del abonado, con su ONT' },
  reserva: { label: 'Reserva', nombre: 'Reserva de cable', genero: 'f', prefijo: 'RES', color: '#a16207', tam: 20, orden: 2, descripcion: 'Reserva (coca) de cable' },
};

export const CABLES = {
  troncal: { label: 'Troncal', color: '#c81e1e', ancho: 1.35 },
  distribucion: { label: 'Distribución', color: '#1d4ed8', ancho: 1 },
  bajada: { label: 'Bajada', color: '#15803d', ancho: 0.7 },
};

export const ESTADOS = {
  proyectado: 'Proyectado',
  instalado: 'Instalado',
  activo: 'Activo',
  baja: 'De baja',
};

export const TENDIDOS = {
  aereo: 'Aéreo',
  subterraneo: 'Subterráneo',
  fachada: 'Por fachada',
};

export const FIBRAS = [1, 2, 4, 6, 8, 12, 24, 36, 48, 72, 96, 144, 288];

// Campos propios de cada tipo (van en `datos`). t: text | number | select.
// teclado: 'text' para números que pueden ser negativos (el teclado numérico
// del teléfono no siempre trae el signo menos).
export const CAMPOS = {
  nodo: [
    { k: 'equipo', l: 'Equipo', t: 'text', ph: 'Huawei MA5800, VSOL…' },
    { k: 'puertos_pon', l: 'Puertos PON', t: 'number', ph: '16', min: 0, max: 1024 },
    { k: 'direccion', l: 'Dirección', t: 'text' },
  ],
  poste: [
    { k: 'material', l: 'Material', t: 'select', o: ['hormigón', 'madera', 'metal', 'fibra de vidrio', 'otro'] },
    { k: 'altura', l: 'Altura (m)', t: 'number', ph: '9', min: 0, max: 60 },
    { k: 'propietario', l: 'Propietario', t: 'text', ph: 'Distribuidora eléctrica, propio…' },
  ],
  // Los splitters ya no van acá: se agregan en la carta de empalme.
  caja: [
    { k: 'modelo', l: 'Modelo', t: 'text', ph: 'Marca y modelo' },
    { k: 'capacidad', l: 'Capacidad (fusiones)', t: 'number', ph: '48', min: 0, max: 2000 },
  ],
  nap: [
    { k: 'puertos', l: 'Puertos', t: 'select', o: ['4', '8', '12', '16', '24', '32'] },
    { k: 'conector', l: 'Conectores', t: 'select', o: ['SC/APC', 'SC/UPC', 'LC/APC', 'LC/UPC', 'otro'] },
    { k: 'modelo', l: 'Modelo', t: 'text', ph: 'Marca y modelo' },
  ],
  botella: [
    { k: 'modelo', l: 'Modelo', t: 'text', ph: 'Marca y modelo' },
    { k: 'bandejas', l: 'Bandejas', t: 'number', ph: '4', min: 0, max: 100 },
    { k: 'capacidad', l: 'Capacidad (fusiones)', t: 'number', ph: '96', min: 0, max: 2000 },
  ],
  cliente: [
    { k: 'abonado', l: 'N.º de abonado', t: 'text', ph: 'Como figura en el sistema de gestión' },
    { k: 'direccion', l: 'Dirección', t: 'text' },
    { k: 'ont', l: 'ONT (modelo y serie)', t: 'text', ph: 'HG8145V5 · 48575443…' },
    { k: 'potencia', l: 'Potencia en la ONT (dBm)', t: 'number', ph: '-21.5', teclado: 'text', min: -50, max: 10 },
    { k: 'nap_puerto', l: 'NAP y puerto (anotado)', t: 'text', ph: 'NAP-012, puerto 5' },
  ],
  reserva: [
    { k: 'metros', l: 'Metros de cable', t: 'number', ph: '30', min: 0, max: 5000 },
  ],
  cable: [
    { k: 'reserva', l: 'Reservas (m en total)', t: 'number', ph: '0', min: 0, max: 50000 },
    { k: 'modelo', l: 'Modelo', t: 'text', ph: 'ADSS, drop plano…' },
    { k: 'marca', l: 'Marca', t: 'text' },
  ],
};

// Campos que versiones anteriores guardaban y hoy no tienen formulario: se
// muestran (y se conservan) con este nombre.
export const CAMPOS_VIEJOS = {
  splitter: 'Splitter (anotado)',
};

// Lectura de la potencia óptica que llega a la ONT (GPON clase B+: sensibilidad
// cerca de -28 dBm, saturación cerca de -8 dBm). Es una guía, no un veredicto.
export function evaluarPotencia(dbm) {
  if (!Number.isFinite(dbm)) return null;
  if (dbm > -8) return { texto: 'alta: puede saturar la ONT', nivel: 'mal' };
  if (dbm >= -25) return { texto: 'buena', nivel: 'bien' };
  if (dbm >= -27) return { texto: 'justa', nivel: 'atencion' };
  return { texto: 'baja', nivel: 'mal' };
}

// "el poste", "la NAP"; "Poste nuevo", "NAP nueva".
export const conArticulo = (def) => `${def.genero === 'f' ? 'la' : 'el'} ${def.label === 'NAP' ? 'NAP' : def.label.toLowerCase()}`;
export const nuevo = (def) => `${def.nombre} ${def.genero === 'f' ? 'nueva' : 'nuevo'}`;

const PAD = 3;

// Sugiere el nombre siguiente: PREFIJO-001, -002… según lo que ya hay.
export function sugerirNombre(prefijo, nombres) {
  const re = new RegExp(`^${prefijo}-(\\d+)$`, 'i');
  let max = 0;
  for (const nombre of nombres) {
    const m = re.exec(nombre ?? '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefijo}-${String(max + 1).padStart(PAD, '0')}`;
}

export function formatLargo(m) {
  if (!Number.isFinite(m)) return '';
  return m >= 1000 ? `${(m / 1000).toFixed(2).replace('.', ',')} km` : `${Math.round(m)} m`;
}

export function formatFecha(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Para buscar sin importar mayúsculas ni tildes.
export const normalizar = (texto) => String(texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
