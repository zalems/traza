// Las herramientas de carga: la barra (ver, elementos, cable), lo que pasa al
// tocar el mapa en cada modo, la mira de los teléfonos, el dibujo y la edición
// del trazado de los cables, y las acciones de la ficha. Une mapa, red y API.

import { api } from './api.js';
import { ELEMENTOS, conArticulo, formatLargo } from './modelo.js';
import { svgIcono } from './iconos.js';
import { setupRed } from './red.js';
import { setupFicha } from './ficha.js';
import { setupCarta } from './carta.js';
import { recorrido } from './fibras.js';

const RED_KEY = 'ftth.red';
const $ = (id) => document.getElementById(id);
// En pantallas táctiles el dedo tapa lo que toca: se trabaja con una mira fija
// en el centro del mapa y botones, además del toque directo.
const tactil = () => window.matchMedia('(pointer: coarse)').matches;

function largoDe(puntos) {
  let total = 0;
  for (let i = 1; i < puntos.length; i += 1) total += puntos[i - 1].lngLat.distanceTo(puntos[i].lngLat);
  return total;
}

const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

export function setupHerramientas({ map, maplibregl, usuario, notify, toast }) {
  const red = setupRed({ map, maplibregl, usuario });
  const barra = $('herramientas');
  const chip = $('red-chip');
  const modoPanel = $('modo');
  const modoTexto = $('modo-texto');
  const modoBotones = $('modo-botones');
  const mira = $('mira');
  const canvas = map.getCanvas();

  let modo = 'ver'; // ver | punto | cable | mover | trazado
  let tipoPunto = null;
  let moviendo = null; // elemento que se está moviendo
  let vertices = []; // cable en curso: [{ lngLat, nodo }]
  let trazado = null; // { feature, puntos: [{ lngLat, nodo }], elegido, cambiado }
  let arrastre = null; // { i, desde, movido, medio }
  let redes = [];
  let redActual = null;

  // ------------------------------------------------------------- errores

  // Conflictos: otro usuario cambió o borró lo que se estaba editando.
  function resolverConflicto(err, clase, feature) {
    if (err.status === 409 && err.data?.actual) {
      red.aplicar(clase === 'elemento' ? { elemento: err.data.actual } : { cable: err.data.actual });
      setModo('ver');
      mostrar({ clase, feature: err.data.actual });
      notify(err.message);
      return true;
    }
    if (err.status === 404 && feature) {
      red.quitar(clase, feature.id);
      setModo('ver');
      ficha.cerrar();
      notify(err.message);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------- acciones

  // Una respuesta que llega cuando el usuario ya cambió de red se descarta.
  const otraRed = (redId) => red.state.red !== redId;

  const acciones = {
    async guardarElemento(cuerpo, feature) {
      const redId = red.state.red;
      let res;
      try {
        res = feature
          ? await api(`api/elementos/${feature.id}`, { method: 'PUT', body: { ...cuerpo, version: feature.properties.version } })
          : await api('api/elementos', { method: 'POST', body: { ...cuerpo, red: redId } });
      } catch (err) {
        if (otraRed(redId)) return;
        if (feature && resolverConflicto(err, 'elemento', feature)) return;
        throw err;
      }
      if (otraRed(redId)) return;
      red.aplicar(res);
      red.dibujar([]);
      const nombre = res.elemento.properties.nombre;
      if (feature) {
        mostrar({ clase: 'elemento', feature: res.elemento });
        toast(`${nombre} guardado`);
      } else {
        ficha.cerrar();
        pista();
        toast(`${nombre} agregado`);
      }
    },
    async guardarCable(cuerpo, feature) {
      const redId = red.state.red;
      let res;
      try {
        res = feature
          ? await api(`api/cables/${feature.id}`, { method: 'PUT', body: { ...cuerpo, version: feature.properties.version } })
          : await api('api/cables', { method: 'POST', body: { ...cuerpo, red: redId } });
      } catch (err) {
        if (otraRed(redId)) return;
        if (feature && resolverConflicto(err, 'cable', feature)) return;
        if (!feature && err.status === 409 && err.data?.faltan) {
          // Un elemento por el que pasaba el cable ya no existe: ese punto queda
          // suelto (en el mismo lugar) y el formulario sigue abierto para guardar.
          soltarFaltantes(err.data.faltan);
          red.recargar().catch(() => {});
          throw new Error(`${err.message} Ese punto quedó suelto en el mismo lugar: guardá de nuevo.`);
        }
        throw err;
      }
      if (otraRed(redId)) return;
      red.aplicar(res);
      const nombre = res.cable.properties.nombre;
      if (feature) {
        mostrar({ clase: 'cable', feature: res.cable });
        toast(`${nombre} guardado`);
      } else {
        vertices = [];
        red.dibujar([]);
        ficha.cerrar();
        pista();
        toast(`${nombre} agregado · ${formatLargo(res.cable.properties.largo_m)}`);
      }
    },
    async borrarElemento(feature) {
      const redId = red.state.red;
      try {
        const res = await api(`api/elementos/${feature.id}?version=${feature.properties.version}`, { method: 'DELETE' });
        if (otraRed(redId)) return;
        red.aplicar(res);
        ficha.cerrar();
        toast(`${feature.properties.nombre} borrado`);
      } catch (err) {
        if (otraRed(redId)) return;
        if (!resolverConflicto(err, 'elemento', feature)) notify(err.message);
      }
    },
    async borrarCable(feature) {
      const redId = red.state.red;
      try {
        const res = await api(`api/cables/${feature.id}?version=${feature.properties.version}`, { method: 'DELETE' });
        if (otraRed(redId)) return;
        red.aplicar(res);
        ficha.cerrar();
        toast(`${feature.properties.nombre} borrado`);
      } catch (err) {
        if (otraRed(redId)) return;
        if (!resolverConflicto(err, 'cable', feature)) notify(err.message);
      }
    },
    moverElemento(feature) {
      ficha.cerrar();
      setModo('mover');
      moviendo = feature;
      red.seleccionar('elemento', feature.id);
      pista();
    },
    editarTrazado(feature) {
      ficha.cerrar();
      setModo('trazado');
      const coords = feature.geometry.coordinates;
      const nodos = feature.properties.nodos ?? [];
      trazado = {
        feature,
        puntos: coords.map(([lng, lat], i) => ({ lngLat: new maplibregl.LngLat(lng, lat), nodo: nodos[i] ?? null })),
        elegido: null,
        cambiado: false,
      };
      // Para editarlo hay que ver todos sus puntos (la ficha pudo haber corrido el mapa).
      const vista = map.getBounds();
      if (coords.some((c) => !vista.contains(c))) {
        const lngs = coords.map((c) => c[0]);
        const lats = coords.map((c) => c[1]);
        map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], {
          padding: { top: 80, bottom: 150, left: 90, right: 70 }, maxZoom: Math.max(map.getZoom(), 16), duration: 0,
        });
      }
      red.seleccionar('cable', feature.id);
      dibujarTrazado();
      pista();
    },
    seleccionar(clase, id) {
      const feature = (clase === 'elemento' ? red.state.elementos : red.state.cables).get(id);
      if (!feature) return;
      setModo('ver');
      mostrar({ clase, feature });
    },
    cancelar() {
      const m = ficha.modo();
      const actual = ficha.actual();
      ficha.cerrar();
      if (m === 'form-elemento' && modo === 'punto') {
        red.dibujar([]);
        pista();
        return;
      }
      if (m === 'form-cable' && modo === 'cable' && vertices.length) {
        // Se vuelve al dibujo, que sigue en pie.
        red.dibujar(dibujoCable());
        pista();
        return;
      }
      if ((m === 'form-elemento' || m === 'form-cable') && actual?.feature) {
        const sel = red.seleccionado();
        if (sel) mostrar(sel);
        return;
      }
      red.seleccionar(null);
    },
    async elegirRed(id) {
      try {
        await elegirRed(id);
        ficha.cerrar();
      } catch (err) {
        notify(err.message);
      }
    },
    async crearRed(nombre) {
      const res = await api('api/redes', { method: 'POST', body: { nombre } });
      redes = (await api('api/redes')).redes;
      await elegirRed(res.red.id);
      ficha.cerrar();
      toast(`Red ${res.red.nombre} creada`);
    },
    async renombrarRed(id, nombre) {
      const res = await api(`api/redes/${id}`, { method: 'PUT', body: { nombre } });
      redes = (await api('api/redes')).redes;
      if (redActual?.id === id) pintarRed(redes.find((r) => r.id === id) ?? res.red);
      ficha.redes({ lista: redes, actualId: redActual?.id ?? null });
      toast(`La red ahora se llama ${res.red.nombre}`);
    },

    // --- carta de empalme y recorridos
    abrirCarta(feature, ext = null) {
      setModo('ver');
      red.limpiarRecorrido();
      ficha.cerrar();
      red.seleccionar('elemento', feature.id);
      carta.abrir(feature.id, { ext });
    },
    // Al cerrar la carta vuelve la ficha del elemento (o un aviso si ya no existe).
    alCerrarCarta(id, aviso) {
      if (aviso) {
        notify(aviso);
        return;
      }
      const feature = red.state.elementos.get(id);
      if (!feature) return;
      red.seleccionar('elemento', id);
      ficha.verElemento(feature);
    },
    verCableDesdeCarta(cableId) {
      carta.cerrar({ silencioso: true });
      acciones.seleccionar('cable', cableId);
    },
    verRecorrido(elementoId, ext, { desdeCarta = false } = {}) {
      const resultado = recorrido(red.state, elementoId, ext);
      if (carta.abierta()) carta.cerrar({ silencioso: true });
      setModo('ver');
      red.seleccionar(null);
      const elemento = red.state.elementos.get(elementoId);
      ficha.verRecorrido({
        resultado,
        elementoId,
        ext,
        volver: desdeCarta && elemento ? () => acciones.abrirCarta(red.state.elementos.get(elementoId) ?? elemento, ext) : null,
      });
      red.resaltarRecorrido(resultado.segmentos);
      encuadrar(resultado.lineas.flat(), elemento?.geometry.coordinates);
    },
    limpiarRecorrido() {
      red.limpiarRecorrido();
    },

    // --- Wispro y el panel de la OLT (se configuran en el servidor)
    integracion: {
      // Si la red actual está conectada: null mientras se averigua.
      estado: () => estadoIntegracion(),
      leer: (tipo, id, { refrescar = false, candidatas = false } = {}) => api(
        `api/integracion/${tipo}?elemento=${id}${refrescar ? '&refrescar=1' : ''}${candidatas ? '&candidatas=1' : ''}`,
        { espera: 60000 },
      ),
      medir: (tipo, id) => api(`api/integracion/${tipo}/medir`, { method: 'POST', body: { elemento: id }, espera: 120000 }),
      async importar(napId, ids) {
        const redId = red.state.red;
        const res = await api('api/integracion/nap/importar', { method: 'POST', body: { elemento: napId, contratos: ids }, espera: 60000 });
        if (otraRed(redId)) return null;
        red.aplicar(res);
        return res;
      },
      // Guarda en la caja de traza con qué NAP de Wispro se corresponde.
      async vincularNap(feature, nap) {
        const redId = red.state.red;
        const actual = red.state.elementos.get(feature.id) ?? feature;
        const datos = { ...(actual.properties.datos ?? {}), wispro_nap: nap.id, wispro_nap_nombre: nap.nombre };
        try {
          const res = await api(`api/elementos/${feature.id}`, { method: 'PUT', body: { datos, version: actual.properties.version } });
          if (!otraRed(redId)) red.aplicar(res);
        } catch (err) {
          if (!otraRed(redId) && err.status === 409 && err.data?.actual) red.aplicar({ elemento: err.data.actual });
          throw err;
        }
      },
      // Confirma que un cliente del mapa es el de un contrato de Wispro (queda vinculado).
      async vincularCliente(clienteId, contratoId) {
        const redId = red.state.red;
        const res = await api('api/integracion/vincular', { method: 'POST', body: { cliente: clienteId, contrato: contratoId }, espera: 60000 });
        if (otraRed(redId)) return null;
        red.aplicar(res);
        return res;
      },
      // Ese cliente no es el de ese contrato: se deshace el vínculo y no se lo vuelve a
      // proponer (con deshacer: se vuelve a considerar).
      async desvincularCliente(clienteId, contratoId, { deshacer = false } = {}) {
        const redId = red.state.red;
        const body = { cliente: clienteId, contrato: contratoId, ...(deshacer ? { deshacer: true } : {}) };
        const res = await api('api/integracion/desvincular', { method: 'POST', body, espera: 60000 });
        if (otraRed(redId)) return null;
        red.aplicar(res);
        return res;
      },
      toast: (texto) => toast(texto),
      aviso: (texto) => notify(texto),
    },
  };

  // Si la red está conectada con Wispro y con el panel de la OLT: se pregunta una
  // vez por red y, cuando llega la respuesta, se rehace la ficha que esté abierta.
  // Si la pregunta falla (sin señal al entrar), se repite en una ficha posterior.
  const REPREGUNTAR_INTEGRACION_MS = 20 * 1000;
  let integracionRed = { red: null, estado: null, fallo: 0 };
  function estadoIntegracion() {
    const redId = red.state.red;
    if (!redId) return null;
    const repreguntar = integracionRed.red === redId && integracionRed.fallo
      && Date.now() - integracionRed.fallo > REPREGUNTAR_INTEGRACION_MS;
    if (integracionRed.red !== redId || repreguntar) {
      integracionRed = { red: redId, estado: null, fallo: 0 };
      api(`api/integracion?red=${redId}`).then((estado) => {
        if (integracionRed.red !== redId) return;
        integracionRed.estado = estado;
        if (!estado.wispro && !estado.panel) return;
        const sel = red.seleccionado();
        if (sel?.clase === 'elemento' && ficha.modo() === 'elemento') ficha.verElemento(sel.feature);
      }, () => {
        if (integracionRed.red === redId) integracionRed.fallo = Date.now();
      });
    }
    return integracionRed.estado;
  }

  const ficha = setupFicha({ root: $('ficha'), red, acciones });
  const carta = setupCarta({ root: $('carta'), red, acciones, toast });

  // Muestra en el mapa un conjunto de puntos, sin que lo tape la ficha.
  function encuadrar(puntos, respaldo) {
    const lista = puntos.length ? puntos : (respaldo ? [respaldo] : []);
    if (!lista.length) return;
    const lngs = lista.map((p) => p[0]);
    const lats = lista.map((p) => p[1]);
    const panel = $('ficha').getBoundingClientRect();
    const w = window.innerWidth;
    const alto = window.innerHeight;
    const padding = w < 900
      ? { top: 80, bottom: Math.min(alto - 160, Math.max(40, alto - panel.top + 24)), left: 40, right: 40 }
      : { top: 80, bottom: 70, left: 100, right: Math.min(w - 200, Math.max(40, w - panel.left + 40)) };
    if (lista.length === 1) {
      map.easeTo({ center: lista[0], zoom: Math.max(map.getZoom(), 17), padding, duration: 400 });
      return;
    }
    map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding, maxZoom: 18, duration: 500 });
  }

  // La ficha puede tapar lo que se tocó (en el teléfono sube desde abajo; en
  // pantallas grandes ocupa la derecha): el mapa se corre para que quede a la vista.
  function asegurarVisible(coords) {
    const root = $('ficha');
    if (root.hidden) return;
    const panel = root.getBoundingClientRect();
    const p = map.project(coords);
    if (window.innerWidth < 900) {
      if (p.y < panel.top - 30 && p.y > 70) return;
      map.easeTo({ center: coords, offset: [0, panel.top / 2 - window.innerHeight / 2], duration: 350 });
      return;
    }
    const tapado = p.x > panel.left - 30 && p.x < panel.right + 30 && p.y > panel.top - 30 && p.y < panel.bottom + 30;
    if (!tapado) return;
    map.easeTo({ center: coords, offset: [panel.left / 2 - window.innerWidth / 2, 0], duration: 350 });
  }

  // Punto a mitad de camino (por largo) de una línea.
  function puntoMedio(coords) {
    const tramos = [];
    let total = 0;
    for (let i = 1; i < coords.length; i += 1) {
      const d = new maplibregl.LngLat(...coords[i - 1]).distanceTo(new maplibregl.LngLat(...coords[i]));
      tramos.push(d);
      total += d;
    }
    let resto = total / 2;
    for (let i = 0; i < tramos.length; i += 1) {
      if (resto <= tramos[i] && tramos[i] > 0) {
        const t = resto / tramos[i];
        const [a, b] = [coords[i], coords[i + 1]];
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      }
      resto -= tramos[i];
    }
    return coords[0];
  }

  // Abre la ficha de lo tocado. `donde`: el punto tocado, que tiene que quedar a la vista.
  function mostrar(hit, donde = null) {
    red.seleccionar(hit.clase, hit.feature.id);
    if (hit.clase === 'elemento') {
      ficha.verElemento(hit.feature);
      asegurarVisible(hit.feature.geometry.coordinates);
    } else {
      ficha.verCable(hit.feature);
      asegurarVisible(donde ? [donde.lng, donde.lat] : puntoMedio(hit.feature.geometry.coordinates));
    }
  }

  // --------------------------------------------------------------- barra

  const botonesModo = [];
  function botonHerramienta({ icono, label, title, onclick }) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tool';
    b.innerHTML = svgIcono(icono); // dibujos fijos del propio código, sin datos
    const texto = document.createElement('span');
    texto.textContent = label;
    b.append(texto);
    b.title = title ?? label;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', onclick);
    return b;
  }

  const grupo = (...items) => {
    const g = document.createElement('div');
    g.className = 'tool-group';
    g.append(...items);
    return g;
  };
  const registrar = (b, modoBoton, tipo = null) => {
    botonesModo.push({ b, modo: modoBoton, tipo });
    return b;
  };

  barra.append(
    grupo(registrar(botonHerramienta({ icono: 'ver', label: 'Ver', title: 'Ver y tocar elementos', onclick: () => setModo('ver') }), 'ver')),
    grupo(...Object.entries(ELEMENTOS).map(([tipo, def]) => registrar(
      botonHerramienta({ icono: tipo, label: def.label, title: `Agregar: ${def.descripcion}`, onclick: () => setModo('punto', tipo) }),
      'punto', tipo,
    ))),
    grupo(registrar(botonHerramienta({ icono: 'cable', label: 'Cable', title: 'Dibujar un cable', onclick: () => setModo('cable') }), 'cable')),
  );

  chip.innerHTML = svgIcono('red');
  const chipNombre = document.createElement('span');
  chipNombre.textContent = 'Red';
  chip.append(chipNombre);
  chip.addEventListener('click', abrirRedes);

  function pintarBarra() {
    for (const item of botonesModo) {
      const activo = item.modo === modo && (item.modo !== 'punto' || item.tipo === tipoPunto);
      item.b.setAttribute('aria-pressed', String(activo));
    }
    barra.classList.toggle('sin-red', !redActual || !red.state.cargada);
  }
  red.on('cargada', () => pintarBarra());

  // ----------------------------------------------------------------- modos

  function setModo(nuevo, tipo = null) {
    if (!redActual && nuevo !== 'ver') {
      abrirRedes();
      return;
    }
    if (!red.state.cargada && nuevo !== 'ver') {
      notify(`Todavía no llegó la red ${redActual.nombre} del servidor; se sigue intentando sola. Cuando aparezca, ya se puede cargar.`);
      return;
    }
    if (nuevo === modo && tipo === tipoPunto && nuevo !== 'ver') {
      // Volver a tocar la herramienta activa: cierra el formulario abierto, si lo hay.
      if (ficha.modo()?.startsWith('form-')) acciones.cancelar();
      return;
    }
    if (arrastre) terminarArrastre(null);
    vertices = [];
    trazado = null;
    moviendo = null;
    if (ficha.modo()?.startsWith('form-') || (nuevo !== 'ver' && ficha.abierta())) ficha.cerrar();
    if (nuevo !== 'ver') red.seleccionar(null);
    modo = nuevo;
    tipoPunto = nuevo === 'punto' ? tipo : null;
    red.dibujar([]);
    canvas.style.cursor = nuevo === 'ver' ? '' : 'crosshair';
    if (nuevo === 'cable' || nuevo === 'trazado') map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
    pintarBarra();
    pista();
  }

  function boton(text, onclick, { clase = '', disabled = false } = {}) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (clase) b.className = clase;
    b.disabled = disabled;
    b.addEventListener('click', onclick);
    return b;
  }

  // El cartel de abajo: qué hacer en este modo y los botones que corresponden.
  function pista() {
    const t = tactil();
    const items = [];
    let texto = '';
    if (modo === 'punto' && !ficha.abierta()) {
      const que = conArticulo(ELEMENTOS[tipoPunto]);
      texto = t ? `Llevá la mira hasta donde va ${que}, o tocá el lugar.` : `Hacé clic donde va ${que}.`;
      if (t) items.push(boton('Colocar acá', () => colocarEnMira(), { clase: 'primario' }));
      items.push(boton('Listo', () => setModo('ver')));
    } else if (modo === 'mover' && moviendo) {
      const nombre = moviendo.properties.nombre || 'el elemento';
      texto = t ? `Llevá la mira a la nueva posición de ${nombre}, o tocá el lugar.` : `Hacé clic en la nueva posición de ${nombre}.`;
      if (t) items.push(boton('Mover acá', () => colocarEnMira(), { clase: 'primario' }));
      items.push(boton('Cancelar', () => volverAFicha('elemento', moviendo)));
    } else if (modo === 'cable' && ficha.modo() !== 'form-cable') {
      if (!vertices.length) {
        texto = t
          ? 'Llevá la mira al comienzo del cable y tocá Agregar punto. Sobre un poste o una caja, el cable queda pegado.'
          : 'Hacé clic donde empieza el cable. Si hacés clic sobre un poste o una caja, el cable queda pegado.';
      } else {
        const pegados = vertices.filter((v) => v.nodo !== null).length;
        texto = `${plural(vertices.length, 'punto', 'puntos')} · ${formatLargo(largoDe(vertices))}`
          + (pegados ? ` · ${plural(pegados, 'pegado', 'pegados')}` : '')
          + (t ? '' : ' · doble clic para terminar');
      }
      if (t) items.push(boton('Agregar punto', () => colocarEnMira(), { clase: vertices.length >= 2 ? '' : 'primario' }));
      if (vertices.length >= 2) items.push(boton('Terminar', terminarCable, { clase: 'primario' }));
      if (vertices.length) items.push(boton('Deshacer', deshacerVertice));
      items.push(boton(vertices.length ? 'Cancelar' : 'Listo', () => setModo('ver')));
    } else if (modo === 'trazado' && trazado) {
      const i = trazado.elegido;
      if (i === null) {
        texto = t
          ? 'Tocá un punto del cable para moverlo o quitarlo. Los puntos blancos agregan uno nuevo.'
          : 'Arrastrá los puntos para moverlos; los blancos agregan uno nuevo. Clic en un punto para quitarlo.';
      } else {
        texto = t
          ? `Punto ${i + 1} elegido: llevá la mira al lugar nuevo y tocá Mover acá, o tocá el lugar.`
          : `Punto ${i + 1} elegido: hacé clic en el lugar nuevo, o quitalo.`;
        if (t) items.push(boton('Mover acá', () => colocarEnMira(), { clase: 'primario' }));
        items.push(boton('Quitar punto', quitarPunto, { disabled: trazado.puntos.length <= 2 }));
      }
      items.push(boton('Guardar', guardarTrazado, { clase: i === null ? 'primario' : '', disabled: !trazado.cambiado }));
      items.push(boton('Cancelar', () => volverAFicha('cable', trazado.feature)));
    }
    modoTexto.textContent = texto;
    modoBotones.replaceChildren(...items);
    modoPanel.hidden = !texto;
    actualizarMira();
  }

  function actualizarMira() {
    const ver = tactil() && !ficha.abierta() && (
      modo === 'punto' || modo === 'mover' || modo === 'cable' || (modo === 'trazado' && (trazado && trazado.elegido !== null))
    );
    mira.hidden = !ver;
    if (ver) previsualizarMira();
  }

  function volverAFicha(clase, feature) {
    const id = feature?.id;
    setModo('ver');
    if (id) acciones.seleccionar(clase, id);
  }

  // ---------------------------------------------- la mira (pantallas táctiles)

  function centro() {
    const lngLat = map.getCenter();
    return { lngLat, point: map.project(lngLat) };
  }

  function colocarEnMira() {
    const { point, lngLat } = centro();
    if (modo === 'punto') abrirFormPunto(lngLat);
    else if (modo === 'mover') moverA(lngLat);
    else if (modo === 'cable') agregarVertice(point, lngLat);
    else if (modo === 'trazado' && (trazado && trazado.elegido !== null)) moverPunto(trazado.elegido, point, lngLat);
  }

  // Mientras se mueve el mapa, se ve a qué quedaría pegado el punto de la mira.
  function previsualizarMira() {
    if (mira.hidden) return;
    const { point, lngLat } = centro();
    const iman = modo === 'cable' || modo === 'trazado' ? red.imanEn(point, 26) : null;
    mira.classList.toggle('pegada', Boolean(iman));
    const destino = iman ? iman.lngLat : lngLat;
    if (modo === 'cable' && ficha.modo() !== 'form-cable') {
      red.dibujar(dibujoCable(destino, iman));
    } else if (modo === 'trazado' && (trazado && trazado.elegido !== null)) {
      // El punto elegido acompaña a la mira para ver cómo quedaría el cable.
      const puntos = trazado.puntos.slice();
      puntos[trazado.elegido] = { lngLat: destino, nodo: iman?.id ?? null };
      dibujarTrazado(iman ? [anillo(iman.lngLat)] : [], puntos);
    }
  }
  map.on('move', () => {
    if (!mira.hidden) previsualizarMira();
  });

  // ------------------------------------------------------------- elementos

  function abrirFormPunto(lngLat) {
    red.dibujar([red.punto([lngLat.lng, lngLat.lat], { clase: 'marca' })]);
    mira.hidden = true;
    modoPanel.hidden = true;
    ficha.formElemento({ tipo: tipoPunto, lngLat });
    // En el teléfono el formulario tapa media pantalla: la marca se sube. (En la
    // computadora no se corre el mapa entre un elemento y el siguiente.)
    if (window.innerWidth < 900) asegurarVisible([lngLat.lng, lngLat.lat]);
  }

  async function moverA(lngLat) {
    const f = moviendo;
    if (!f) return;
    const redId = red.state.red;
    moviendo = null;
    mira.hidden = true;
    modoPanel.hidden = true;
    try {
      const res = await api(`api/elementos/${f.id}`, {
        method: 'PUT',
        body: { lon: lngLat.lng, lat: lngLat.lat, version: f.properties.version },
      });
      if (otraRed(redId)) return;
      red.aplicar(res);
      // Si mientras tanto eligió otra herramienta, no se la cambia.
      if (modo !== 'mover') return toast(`${f.properties.nombre} movido`);
      setModo('ver');
      acciones.seleccionar('elemento', f.id);
      const n = res.cables?.length ?? 0;
      toast(`${f.properties.nombre} movido${n ? ` (y ${plural(n, 'cable', 'cables')})` : ''}`);
    } catch (err) {
      if (otraRed(redId)) return;
      if (!resolverConflicto(err, 'elemento', f)) {
        notify(err.message);
        if (modo === 'mover') {
          moviendo = f;
          pista();
        }
      }
    }
  }

  // ---------------------------------------------------------------- cables

  const anillo = (lngLat) => red.punto([lngLat.lng, lngLat.lat], { clase: 'iman' });

  function dibujoCable(cursor, iman) {
    const features = vertices.map((v, i) => red.punto([v.lngLat.lng, v.lngLat.lat], { clase: 'vertice', i }));
    const coords = vertices.map((v) => [v.lngLat.lng, v.lngLat.lat]);
    if (cursor) coords.push([cursor.lng, cursor.lat]);
    if (coords.length >= 2) {
      features.unshift({ type: 'Feature', properties: { clase: 'linea' }, geometry: { type: 'LineString', coordinates: coords } });
    }
    if (iman) features.push(anillo(iman.lngLat));
    return features;
  }

  function agregarVertice(point, lngLat) {
    const iman = red.imanEn(point, tactil() ? 26 : 20);
    const nuevo = { lngLat: iman ? iman.lngLat : lngLat, nodo: iman ? iman.id : null };
    const ultimo = vertices[vertices.length - 1];
    // Dos toques sobre el mismo lugar (o un doble clic) no agregan un tramo de largo cero.
    if (ultimo && ((nuevo.nodo !== null && nuevo.nodo === ultimo.nodo)
      || map.project(ultimo.lngLat).dist(map.project(nuevo.lngLat)) < 6)) return;
    vertices.push(nuevo);
    red.dibujar(dibujoCable());
    pista();
  }

  function deshacerVertice() {
    vertices.pop();
    red.dibujar(dibujoCable());
    pista();
  }

  function terminarCable() {
    if (vertices.length < 2) return;
    const coords = vertices.map((v) => [v.lngLat.lng, v.lngLat.lat]);
    const nodos = vertices.map((v) => v.nodo);
    red.dibujar(dibujoCable());
    mira.hidden = true;
    modoPanel.hidden = true;
    ficha.formCable({ coords, nodos, largo: largoDe(vertices) });
  }

  // ------------------------------------------------------- trazado de cables

  function dibujarTrazado(extra = [], pts = trazado.puntos) {
    const coords = pts.map((p) => [p.lngLat.lng, p.lngLat.lat]);
    const features = [{ type: 'Feature', properties: { clase: 'linea' }, geometry: { type: 'LineString', coordinates: coords } }];
    for (let i = 0; i < pts.length - 1; i += 1) {
      // Punto intermedio solo si el tramo se ve lo bastante largo para tocarlo.
      if (map.project(pts[i].lngLat).dist(map.project(pts[i + 1].lngLat)) < 36) continue;
      const a = pts[i].lngLat;
      const b = pts[i + 1].lngLat;
      features.push(red.punto([(a.lng + b.lng) / 2, (a.lat + b.lat) / 2], { clase: 'medio', i }));
    }
    pts.forEach((p, i) => features.push(red.punto(coords[i], { clase: i === trazado.elegido ? 'elegido' : 'vertice', i })));
    red.dibujar([...features, ...extra]);
  }

  function insertarPunto(i) {
    const a = trazado.puntos[i].lngLat;
    const b = trazado.puntos[i + 1].lngLat;
    trazado.puntos.splice(i + 1, 0, { lngLat: new maplibregl.LngLat((a.lng + b.lng) / 2, (a.lat + b.lat) / 2), nodo: null });
    trazado.cambiado = true;
    return i + 1;
  }

  function moverPunto(i, point, lngLat) {
    const iman = red.imanEn(point, tactil() ? 26 : 20);
    trazado.puntos[i] = { lngLat: iman ? iman.lngLat : lngLat, nodo: iman ? iman.id : null };
    trazado.elegido = null;
    trazado.cambiado = true;
    dibujarTrazado();
    pista();
  }

  function quitarPunto() {
    if (!trazado || trazado.elegido === null || trazado.puntos.length <= 2) return;
    trazado.puntos.splice(trazado.elegido, 1);
    trazado.elegido = null;
    trazado.cambiado = true;
    dibujarTrazado();
    pista();
  }

  function tocarTrazado(event) {
    const m = red.manijaEn(event.point, tactil() ? 22 : 10);
    if (m?.clase === 'vertice') {
      trazado.elegido = trazado.elegido === m.i ? null : m.i;
    } else if (m?.clase === 'medio') {
      trazado.elegido = insertarPunto(m.i);
    } else if (trazado.elegido !== null) {
      moverPunto(trazado.elegido, event.point, event.lngLat);
      return;
    } else {
      return;
    }
    dibujarTrazado();
    pista();
  }

  // Puntos pegados a elementos que otro usuario borró: quedan sueltos en su lugar.
  function soltarFaltantes(faltan) {
    const ids = new Set(faltan);
    for (const v of vertices) if (ids.has(v.nodo)) v.nodo = null;
    if (trazado) for (const p of trazado.puntos) if (ids.has(p.nodo)) p.nodo = null;
    const f = ficha.actual();
    if (ficha.modo() === 'form-cable' && f?.nodos) f.nodos = f.nodos.map((n) => (ids.has(n) ? null : n));
  }

  let guardando = false;
  async function guardarTrazado() {
    if (!trazado?.cambiado || guardando) return;
    const { feature, puntos } = trazado;
    const redId = red.state.red;
    const largo = largoDe(puntos);
    guardando = true;
    try {
      const res = await api(`api/cables/${feature.id}`, {
        method: 'PUT',
        body: {
          coords: puntos.map((p) => [p.lngLat.lng, p.lngLat.lat]),
          nodos: puntos.map((p) => p.nodo),
          version: feature.properties.version,
        },
      });
      if (otraRed(redId)) return;
      red.aplicar(res);
      if (modo === 'trazado' && trazado?.feature.id === feature.id) {
        setModo('ver');
        acciones.seleccionar('cable', feature.id);
      }
      toast(`Trazado de ${feature.properties.nombre} guardado · ${formatLargo(res.cable?.properties.largo_m ?? largo)}`);
    } catch (err) {
      if (otraRed(redId)) return;
      if (err.status === 409 && err.data?.faltan && trazado?.feature.id === feature.id) {
        soltarFaltantes(err.data.faltan);
        dibujarTrazado();
        pista();
        notify(`${err.message} Ese punto quedó suelto en el mismo lugar: revisalo y guardá de nuevo.`);
        red.recargar().catch(() => {});
      } else if (!resolverConflicto(err, 'cable', feature)) {
        notify(err.message);
      }
    } finally {
      guardando = false;
    }
  }

  // Con mouse, los puntos también se arrastran.
  function terminarArrastre(event) {
    const a = arrastre;
    arrastre = null;
    map.dragPan.enable();
    canvas.style.cursor = 'crosshair';
    if (!a || !trazado) return;
    if (a.movido && event) {
      moverPunto(a.i, event.point, event.lngLat);
    } else if (a.movido) {
      dibujarTrazado();
      pista();
    }
  }

  map.on('mousedown', (event) => {
    if (modo !== 'trazado' || !trazado || tactil() || event.originalEvent.button !== 0) return;
    const m = red.manijaEn(event.point, 10);
    if (!m) return;
    event.preventDefault();
    map.dragPan.disable();
    arrastre = { i: m.i, medio: m.clase === 'medio', desde: event.point, movido: false };
    canvas.style.cursor = 'grabbing';
  });

  map.on('mouseup', (event) => {
    if (arrastre) terminarArrastre(event);
  });
  // Soltado fuera del mapa (sobre un panel) o al cambiar de ventana: el punto
  // queda donde estaba al salir del mapa.
  window.addEventListener('mouseup', () => {
    if (arrastre) terminarArrastre(null);
  });
  window.addEventListener('blur', () => {
    if (arrastre) terminarArrastre(null);
  });

  // ------------------------------------------------------------- el mapa

  map.on('click', (event) => {
    if (arrastre) return;
    if (modo === 'ver') {
      const hit = red.featureEn(event.point, tactil() ? 16 : 8);
      if (hit) {
        mostrar(hit, event.lngLat);
      } else if (ficha.modo() === 'elemento' || ficha.modo() === 'cable') {
        red.seleccionar(null);
        ficha.cerrar();
      }
      return;
    }
    if (modo === 'punto') {
      // Con el formulario abierto, tocar otro lugar corrige la ubicación.
      if (ficha.modo() === 'form-elemento' && ficha.actual()?.lngLat) {
        red.dibujar([red.punto([event.lngLat.lng, event.lngLat.lat], { clase: 'marca' })]);
        ficha.actual().lngLat = event.lngLat;
        return;
      }
      if (!ficha.abierta()) abrirFormPunto(event.lngLat);
      return;
    }
    if (modo === 'cable') {
      if (ficha.modo() !== 'form-cable') agregarVertice(event.point, event.lngLat);
      return;
    }
    if (modo === 'mover') {
      moverA(event.lngLat);
      return;
    }
    if (modo === 'trazado' && trazado) tocarTrazado(event);
  });

  map.on('dblclick', (event) => {
    if (modo !== 'cable' || ficha.modo() === 'form-cable' || tactil()) return;
    event.preventDefault();
    if (vertices.length >= 2) terminarCable();
  });

  // Con mouse: la línea sigue al cursor y se ve a qué elemento se va a pegar.
  map.on('mousemove', (event) => {
    if (arrastre) {
      if (!arrastre.movido && arrastre.desde.dist(event.point) < 4) return;
      if (!arrastre.movido) {
        arrastre.movido = true;
        if (arrastre.medio) arrastre.i = insertarPunto(arrastre.i);
        trazado.elegido = null;
      }
      const iman = red.imanEn(event.point, 20);
      trazado.puntos[arrastre.i] = { lngLat: iman ? iman.lngLat : event.lngLat, nodo: iman ? iman.id : null };
      dibujarTrazado(iman ? [anillo(iman.lngLat)] : []);
      return;
    }
    if (tactil()) return;
    if (modo === 'cable' && ficha.modo() !== 'form-cable') {
      const iman = red.imanEn(event.point, 20);
      red.dibujar(dibujoCable(vertices.length ? (iman ? iman.lngLat : event.lngLat) : null, iman));
      canvas.style.cursor = iman ? 'pointer' : 'crosshair';
    } else if (modo === 'ver') {
      canvas.style.cursor = red.featureEn(event.point, 8) ? 'pointer' : '';
    } else if (modo === 'trazado' && trazado) {
      canvas.style.cursor = red.manijaEn(event.point, 10) ? 'grab' : 'crosshair';
    }
  });

  map.on('zoomend', () => {
    if (modo !== 'trazado' || !trazado || arrastre) return;
    if (!mira.hidden) previsualizarMira();
    else dibujarTrazado();
  });

  const escribiendo = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  document.addEventListener('keydown', (event) => {
    // Con la carta de empalme abierta, las teclas son de ella.
    if (carta.abierta()) return;
    // Se mira dónde se apretó la tecla (el buscador, por ejemplo, se suelta
    // solo con Escape antes de que el aviso llegue acá).
    const foco = event.target instanceof Element ? event.target : document.activeElement;
    // El Escape de un campo fuera de la ficha (el buscador) es de ese campo.
    if (escribiendo(foco) && !$('ficha').contains(foco)) return;
    if (event.key === 'Escape') {
      if (ficha.modo()?.startsWith('form-')) acciones.cancelar();
      else if (modo === 'mover') volverAFicha('elemento', moviendo);
      else if (modo === 'trazado' && trazado) volverAFicha('cable', trazado.feature);
      else if (modo !== 'ver') setModo('ver');
      else if (ficha.abierta()) acciones.cancelar();
      return;
    }
    // Enter o Borrar con el foco en un botón son de ese botón.
    if (escribiendo(foco) || foco?.tagName === 'BUTTON' || ficha.modo()?.startsWith('form-')) return;
    if (modo === 'cable' && event.key === 'Enter' && vertices.length >= 2) {
      event.preventDefault();
      terminarCable();
    } else if (modo === 'cable' && event.key === 'Backspace' && vertices.length) {
      event.preventDefault();
      deshacerVertice();
    } else if (modo === 'trazado' && trazado) {
      if (event.key === 'Enter') {
        event.preventDefault();
        guardarTrazado();
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && trazado.elegido !== null) {
        event.preventDefault();
        quitarPunto();
      }
    }
  });

  // Cuando otros cambian lo que estamos mirando, la ficha se actualiza.
  red.on('seleccion', (sel) => {
    const m = ficha.modo();
    if (!sel) {
      if (m === 'elemento' || m === 'cable') ficha.cerrar();
      return;
    }
    if (m === 'elemento' && sel.clase === 'elemento') ficha.verElemento(sel.feature);
    if (m === 'cable' && sel.clase === 'cable') ficha.verCable(sel.feature);
  });
  red.on('cambios', (n) => toast(`${plural(n, 'cambio', 'cambios')} de otros usuarios`));

  // ----------------------------------------------------------------- redes

  async function abrirRedes() {
    try {
      redes = (await api('api/redes')).redes;
    } catch (err) {
      notify(err.message);
      return;
    }
    if (modo !== 'ver') setModo('ver');
    red.seleccionar(null);
    ficha.redes({ lista: redes, actualId: redActual?.id ?? null });
  }

  function pintarRed(r) {
    redActual = r;
    chipNombre.textContent = r ? r.nombre : 'Red';
    chip.title = r ? `Red: ${r.nombre}. Tocá para cambiar de red.` : 'Elegí una red';
    pintarBarra();
  }

  async function elegirRed(id) {
    const elegida = redes.find((r) => r.id === id);
    if (!elegida) return;
    carta.cerrar({ silencioso: true });
    setModo('ver');
    pintarRed(elegida);
    try {
      localStorage.setItem(RED_KEY, String(id));
    } catch {
      // sin almacenamiento: se pregunta la próxima vez
    }
    await red.cargar(id);
    estadoIntegracion();
  }

  let avisoInicio = false;
  async function iniciar() {
    try {
      await red.listo;
      redes = (await api('api/redes')).redes;
    } catch (err) {
      // Sin señal al abrir: se avisa una vez y se reintenta solo.
      if (!avisoInicio) notify(`No se pudieron traer las redes: ${err.message} Se reintenta solo.`);
      avisoInicio = true;
      setTimeout(iniciar, 8000);
      return;
    }
    if (avisoInicio) $('notice').hidden = true;
    let guardada = null;
    try {
      guardada = Number(localStorage.getItem(RED_KEY));
    } catch {
      guardada = null;
    }
    const inicial = redes.find((r) => r.id === guardada) ?? (redes.length === 1 ? redes[0] : null);
    if (inicial) {
      try {
        await elegirRed(inicial.id);
      } catch (err) {
        notify(`No se pudo cargar la red: ${err.message}`);
      }
    } else {
      pintarBarra();
      ficha.redes({ lista: redes, actualId: null });
    }
  }

  // Búsqueda por nombre desde el buscador de arriba.
  function buscarEnRed(texto) {
    return red.buscar(texto).map(({ clase, feature }) => {
      const p = feature.properties;
      const tipo = clase === 'cable' ? `Cable · ${p.fibras} F` : (ELEMENTOS[p.tipo]?.label ?? p.tipo);
      const extra = clase === 'elemento' ? [p.datos?.abonado, p.datos?.direccion].filter(Boolean).join(' · ') : '';
      return {
        titulo: p.nombre || tipo,
        detalle: extra ? `${tipo} · ${extra}` : tipo,
        ir: () => {
          const coords = clase === 'cable' ? feature.geometry.coordinates : [feature.geometry.coordinates];
          const lngs = coords.map((c) => c[0]);
          const lats = coords.map((c) => c[1]);
          const actual = (clase === 'elemento' ? red.state.elementos : red.state.cables).get(feature.id) ?? feature;
          setModo('ver');
          if (clase === 'cable') {
            map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 80, maxZoom: 18, duration: 0 });
          } else {
            map.jumpTo({ center: coords[0], zoom: Math.max(map.getZoom(), 18) });
          }
          mostrar({ clase, feature: actual });
        },
      };
    });
  }

  pintarBarra();
  pista();
  iniciar();

  return { red, ficha, carta, setModo, modo: () => modo, redActual: () => redActual, buscarEnRed };
}
