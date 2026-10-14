// Acceso a la API de la red (/api/, detrás del login de nginx).
// Devuelve el JSON de la respuesta o lanza un ApiError con el mensaje del servidor.

export class ApiError extends Error {
  constructor(status, message, data = null) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

// Con mala señal un pedido puede quedar colgado: se corta pasado este tiempo
// (contando la descarga de la respuesta). La carga completa de una red usa más.
const ESPERA_MS = 25000;

export async function api(path, { method = 'GET', body, espera = ESPERA_MS } = {}) {
  const control = new AbortController();
  const corte = setTimeout(() => control.abort(), espera);
  const tarde = () => new ApiError(0, method === 'GET'
    ? 'El servidor no respondió a tiempo. Revisá la señal y probá de nuevo.'
    : 'El servidor no respondió a tiempo. Puede que el cambio se haya guardado igual: revisalo en unos segundos.');
  try {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        signal: control.signal,
      });
    } catch {
      throw control.signal.aborted ? tarde() : new ApiError(0, 'Sin conexión con el servidor. Revisá la señal y probá de nuevo.');
    }
    if (res.status === 401) {
      // La sesión venció: volver a la pantalla de entrada conservando la posición del mapa.
      location.replace(`login.html${location.hash}`);
      return new Promise(() => {});
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      if (control.signal.aborted) throw tarde();
      data = null;
    }
    if (!res.ok) {
      const mensaje = data?.error
        || (res.status >= 500 ? 'El servidor tuvo un problema. Probá de nuevo en un momento.' : `El servidor respondió ${res.status}.`);
      throw new ApiError(res.status, mensaje, data);
    }
    return data;
  } finally {
    clearTimeout(corte);
  }
}
