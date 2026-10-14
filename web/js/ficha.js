// La ficha: el panel que muestra o edita un elemento, un cable, la lista de
// redes o el recorrido de un pelo. En el teléfono es una hoja que sube desde
// abajo; en pantallas grandes, un panel a la derecha.

import {
  CABLES, CAMPOS, CAMPOS_VIEJOS, ELEMENTOS, ESTADOS, FIBRAS, TENDIDOS, evaluarPotencia, formatFecha, formatLargo, nuevo,
  sugerirNombre,
} from './modelo.js';
import * as F from './fibras.js';
import * as I from './integracion.js';

// Creador de nodos: h('tag.clase', { attr }, ...hijos). Todo texto va como
// texto (nunca como HTML).
function h(spec, attrs = {}, ...children) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') el.textContent = value;
    else if (key === 'style') el.setAttribute('style', value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'value') el.value = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

const botones = (...items) => h('div.ficha-acciones', {}, ...items);
const boton = (text, onclick, extra = {}) => h('button', { type: 'button', text, onclick, ...extra });
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

function iconoCerrar() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M6 6l12 12M18 6 6 18');
  svg.append(path);
  return svg;
}

const firma = (props) => h('p.ficha-firma', {
  text: `Cargado por ${props.creado_por ?? '—'} el ${formatFecha(props.creado)}`
    + (props.modificado !== props.creado ? ` · último cambio de ${props.modificado_por ?? '—'} el ${formatFecha(props.modificado)}` : ''),
});

const marcasClase = (c) => (c?.marcas ? `.punto-marca${c.marcas > 1 ? 's' : ''}` : '');
const estiloColor = (c) => `--c:${c.hex};--m:${c.marca ?? '#1c1c1c'}`;

// Pérdidas y potencias con coma decimal y signo menos tipográfico.
const numero = (x) => Math.abs(x).toFixed(1).replace('.', ',');
const formatDb = (x) => `${numero(x)} dB`;
const formatDbm = (x) => `${x < -0.05 ? '−' : ''}${numero(x)} dBm`;

// Estado de un contrato de Wispro, en palabras.
const ESTADO_CONTRATO = { enabled: 'habilitado', alerted: 'alertado', degraded: 'degradado', disabled: 'deshabilitado' };
const FRESCO_INTEGRACION_MS = 2 * 60 * 1000;
// Dos interfaces PON son la misma si coinciden placa y puerto ('0/19/3' y '19/3').
const mismoPon = (a, b) => {
  const x = String(a ?? '').match(/\d+/g) ?? [];
  const y = String(b ?? '').match(/\d+/g) ?? [];
  return x.length >= 2 && y.length >= 2 && x.slice(-2).join('/') === y.slice(-2).join('/');
};

export function setupFicha({ root, red, acciones }) {
  let modo = null; // 'elemento' | 'cable' | 'redes' | 'recorrido' | 'form-elemento' | 'form-cable'
  let actual = null;

  function cerrar() {
    const eraRecorrido = modo === 'recorrido';
    root.hidden = true;
    root.replaceChildren();
    modo = null;
    actual = null;
    if (eraRecorrido) acciones.limpiarRecorrido();
  }

  function abrir(nuevoModo, contenido, { titulo, chip, onCerrar, id = null }) {
    // Si es la misma ficha (se actualizó con cambios de otros), queda donde estaba.
    const mismo = !root.hidden && modo === nuevoModo && id !== null && root.dataset.id === String(id);
    const desplazamiento = mismo ? root.querySelector('.ficha-cuerpo')?.scrollTop ?? 0 : 0;
    if (modo === 'recorrido' && nuevoModo !== 'recorrido') acciones.limpiarRecorrido();
    modo = nuevoModo;
    root.dataset.id = id === null ? '' : String(id);
    const cerrarBtn = boton('', () => (onCerrar ?? acciones.cancelar)(), { class: 'ficha-cerrar', 'aria-label': 'Cerrar' });
    cerrarBtn.append(iconoCerrar());
    root.replaceChildren(
      h('header.ficha-cabecera', {},
        h('div.ficha-titulo', {}, h('strong', { text: titulo }), chip ? h('span.chip', { text: chip }) : null),
        cerrarBtn,
      ),
      h('div.ficha-cuerpo', {}, ...contenido),
    );
    root.hidden = false;
    root.querySelector('.ficha-cuerpo').scrollTop = desplazamiento;
  }

  // ------------------------------------------------------------ campos

  function campo(def, valor) {
    const id = `campo-${def.k}`;
    let input;
    if (def.t === 'select') {
      input = h('select', { id, name: def.k });
      if (!def.sinVacio) input.append(h('option', { value: '', text: '—' }));
      const actualValor = String(valor ?? '');
      let esta = actualValor === '' && !def.sinVacio;
      for (const opcion of def.o) {
        const [value, label] = Array.isArray(opcion) ? opcion : [String(opcion), String(opcion)];
        if (value === actualValor) esta = true;
        input.append(h('option', { value, text: label, selected: actualValor === value }));
      }
      // Un valor guardado que no está entre las opciones (cargado de otra forma) no se pierde.
      if (!esta && actualValor !== '') input.append(h('option', { value: actualValor, text: actualValor, selected: true }));
    } else if (def.t === 'textarea') {
      input = h('textarea', { id, name: def.k, rows: 2, placeholder: def.ph, maxlength: 2000 });
      input.value = valor ?? '';
    } else {
      input = h('input', {
        id,
        name: def.k,
        type: 'text',
        inputmode: def.t === 'number' && def.teclado !== 'text' ? 'decimal' : undefined,
        placeholder: def.ph,
        autocomplete: 'off',
        maxlength: def.k === 'nombre' ? 80 : 500,
        required: def.req,
      });
      input.value = valor ?? '';
    }
    return h('label.campo', { for: id }, h('span', { text: def.l }), input);
  }

  function leerForm(form, defs) {
    const out = {};
    for (const def of defs) {
      const el = form.elements[def.k];
      if (!el) continue;
      let value = el.value.trim();
      if (def.t === 'number') {
        if (value === '') continue;
        const num = Number(value.replace(',', '.').replace(/\s/g, ''));
        if (!Number.isFinite(num)) throw new Error(`${def.l}: tiene que ser un número.`);
        if ((def.min !== undefined && num < def.min) || (def.max !== undefined && num > def.max)) {
          throw new Error(`${def.l}: tiene que estar entre ${def.min} y ${def.max}.`);
        }
        value = num;
      }
      if (value !== '') out[def.k] = value;
    }
    return out;
  }

  const opcionesEstado = Object.entries(ESTADOS);
  const opcionesTendido = Object.entries(TENDIDOS);
  const opcionesTipoCable = Object.entries(CABLES).map(([k, v]) => [k, v.label]);
  const opcionesFibras = FIBRAS.map((n) => [String(n), `${n} fibras`]);
  const opcionesPorTubo = [['0', 'Automático (hasta 12 en un tubo)'], ...F.POR_TUBO.map((n) => [String(n), `${n} por tubo`])];
  const opcionesColores = Object.entries(F.CODIGOS).map(([k, c]) => [k, `${c.label} (${c.detalle})`]);
  const campoNotas = { k: 'notas', l: 'Notas', t: 'textarea', ph: 'Lo que haga falta recordar' };

  function mostrarError(form, mensaje) {
    let box = form.querySelector('.ficha-error');
    if (!box) {
      box = h('p.ficha-error', { role: 'alert' });
      form.prepend(box);
    }
    box.textContent = mensaje;
    box.scrollIntoView({ block: 'nearest' });
  }

  function enviar(form, fn) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        ocupado(form, true);
        await fn();
      } catch (err) {
        if (!form.isConnected) return; // la ficha ya cambió (conflicto, borrado)
        ocupado(form, false);
        mostrarError(form, err.message);
      }
    });
  }

  // ---------------------------------------------------------- elementos

  function formElemento({ tipo, feature, lngLat }) {
    const def = ELEMENTOS[tipo];
    const props = feature?.properties ?? {};
    const datos = props.datos ?? {};
    const nombreSugerido = feature ? props.nombre : sugerirNombre(def.prefijo, red.nombres('elemento', tipo));
    const comunes = [
      { k: 'nombre', l: 'Nombre o código', t: 'text', req: true },
      { k: 'estado', l: 'Estado', t: 'select', o: opcionesEstado },
    ];
    // Los campos de versiones anteriores que este elemento tenga cargados se
    // muestran (y se pueden borrar) como texto.
    const viejos = Object.entries(CAMPOS_VIEJOS)
      .filter(([k]) => datos[k] !== undefined && datos[k] !== '')
      .map(([k, l]) => ({ k, l, t: 'text' }));
    const propios = [...(CAMPOS[tipo] ?? []), ...viejos];
    const estado = { tipo, feature, lngLat }; // lngLat puede cambiar con el formulario abierto

    const form = h('form.ficha-form', { autocomplete: 'off', novalidate: true },
      campo(comunes[0], nombreSugerido),
      campo(comunes[1], props.estado ?? 'instalado'),
      ...propios.map((c) => campo(c, datos[c.k])),
      campo(campoNotas, props.notas),
      botones(
        boton('Guardar', null, { type: 'submit', class: 'primario' }),
        boton('Cancelar', () => acciones.cancelar()),
      ),
    );
    enviar(form, async () => {
      const base = leerForm(form, comunes);
      if (!base.nombre) throw new Error('Poné un nombre o código.');
      // Lo que se guardó con campos que este formulario no tiene se conserva.
      const editables = new Set(propios.map((c) => c.k));
      const conservados = Object.fromEntries(Object.entries(datos).filter(([k]) => !editables.has(k)));
      const cuerpo = {
        tipo,
        nombre: base.nombre,
        estado: base.estado || 'instalado',
        datos: { ...conservados, ...leerForm(form, propios) },
        notas: form.elements.notas.value.trim(),
      };
      if (!feature) {
        cuerpo.lon = estado.lngLat.lng;
        cuerpo.lat = estado.lngLat.lat;
      }
      await acciones.guardarElemento(cuerpo, feature);
    });
    abrir('form-elemento', [form], {
      titulo: feature ? `Editar ${props.nombre || def.nombre}` : nuevo(def),
      chip: feature ? def.label : null,
    });
    actual = estado;
    const nombre = form.elements.nombre;
    nombre.focus({ preventScroll: true });
    if (!feature) nombre.select();
  }

  function fila(label, valor, extra = null) {
    if (valor === undefined || valor === null || valor === '') return null;
    return h('div.fila', {}, h('dt', { text: label }), h('dd', {}, String(valor), extra));
  }

  function filaDato(c, valor) {
    if (c.k === 'potencia' && Number.isFinite(valor)) {
      const ev = evaluarPotencia(valor);
      return fila(c.l, `${String(valor).replace('.', ',')} dBm`, ev ? h(`span.nivel.${ev.nivel}`, { text: ev.texto }) : null);
    }
    return fila(c.l, valor);
  }

  function confirmacion(texto, onSi) {
    const box = h('div.ficha-confirmar', { hidden: true },
      h('p', { text: texto }),
      botones(
        boton('Sí, borrar', async () => {
          // Un doble toque no manda dos pedidos.
          for (const b of box.querySelectorAll('button')) b.disabled = true;
          try {
            await onSi();
          } finally {
            if (box.isConnected) for (const b of box.querySelectorAll('button')) b.disabled = false;
          }
        }, { class: 'peligro' }),
        boton('No', () => { box.hidden = true; }),
      ),
    );
    return box;
  }

  // Resumen de la carta de empalme de un elemento.
  function resumenCarta(feature) {
    const s = red.state;
    const idx = F.indice(s);
    const uniones = idx.fusionesEn.get(feature.id) ?? [];
    const equipos = idx.equiposEn.get(feature.id) ?? [];
    const cables = new Set(F.puntas(s, feature.id).puntas.map((p) => p.cable.id)).size;
    const usadas = (e) => {
      let n = 0;
      for (let k = 1; k <= e.salidas; k += 1) if (idx.usado.has(`${feature.id}|${F.extremoEquipo(e.id, 's', k)}`)) n += 1;
      return n;
    };
    return {
      uniones: uniones.length,
      equipos,
      texto: [plural(cables, 'cable', 'cables'), plural(uniones.length, 'unión', 'uniones')].join(' · '),
      equiposTexto: equipos.map((e) => `${e.nombre || 'Equipo'}: ${F.describirEquipo(e)}, ${usadas(e)} de ${e.salidas} ${e.tipo === 'olt' ? 'puertos' : 'salidas'} en uso`),
    };
  }

  // --------------------------------------- Wispro y el panel de la OLT

  // Lo leído de cada NAP o cliente queda un rato: la ficha se rehace seguido (con
  // los cambios de otros) y no hace falta volver a pedirlo cada vez. Se vuelve a
  // leer si cambió el elemento (su nombre, sus datos, el vínculo) y, si la
  // última lectura falló, pasados unos segundos.
  // 'nap:12' -> { datos, cuando, version, error, fallo, cargando, pedidos, candidatas, ocupado }
  const integCache = new Map();
  const REINTENTO_INTEGRACION_MS = 30 * 1000;
  const MAX_INTEGRACION = 40; // fichas leídas que se recuerdan

  // Cómo se encontró en el mapa al cliente de un contrato (lo vinculado a mano no se aclara).
  const POR = { ont: 'por la ONT', contrato: 'por el n.º de contrato', abonado: 'por el n.º de abonado', nombre: 'por el nombre, cerca' };
  const DEBIL = new Set(['abonado', 'nombre']); // coincidencias para confirmar con un toque

  // Para lectores de pantalla: lo que se leyó. Va fuera de la ficha, que se rehace.
  const anuncio = h('p.sr-only', { role: 'status' });
  document.body.append(anuncio);
  function anunciar(texto) {
    anuncio.textContent = '';
    setTimeout(() => { anuncio.textContent = texto; }, 60);
  }

  const mostrando = (id) => !root.hidden && modo === 'elemento' && root.dataset.id === `e${id}`;

  function seccionIntegracion(feature) {
    const tipo = feature.properties.tipo;
    if (tipo !== 'nap' && tipo !== 'cliente') return null;
    const estado = acciones.integracion.estado();
    if (!estado || (!estado.wispro && !estado.panel)) return null;
    const sec = h('section.integ', { 'data-integ': `${tipo}-${feature.id}`, 'aria-label': 'Wispro y la OLT' });
    pintarIntegracion(sec, feature);
    return sec;
  }

  function hayQueLeer(entrada, feature) {
    if (!entrada) return true;
    if (entrada.cargando || entrada.ocupado) return false;
    const ahora = Date.now();
    if (entrada.error) return ahora - entrada.fallo > REINTENTO_INTEGRACION_MS;
    return ahora - entrada.cuando > FRESCO_INTEGRACION_MS || entrada.version !== feature.properties.version;
  }

  function pintarIntegracion(sec, feature) {
    const tipo = feature.properties.tipo;
    const clave = `${tipo}:${feature.id}`;
    if (hayQueLeer(integCache.get(clave), feature)) {
      cargarIntegracion(feature, { candidatas: Boolean(integCache.get(clave)?.candidatas), pintar: false });
    }
    const entrada = integCache.get(clave);
    let contenido;
    if (entrada.datos) contenido = tipo === 'nap' ? vistaNap(feature, entrada) : vistaCliente(feature, entrada);
    else if (entrada.error) {
      contenido = [
        cabeceraInteg('En Wispro'),
        h('p.integ-error', { text: entrada.error }),
        botones(boton(entrada.cargando ? 'Leyendo…' : 'Reintentar', () => cargarIntegracion(feature, { refrescar: true, avisar: true }),
          { disabled: Boolean(entrada.cargando) })),
      ];
    } else contenido = [cabeceraInteg('En Wispro'), h('p.ficha-sub', { text: 'Leyendo Wispro y el panel de la OLT…' })];
    sec.replaceChildren(...contenido.filter(Boolean));
    sec.setAttribute('aria-busy', String(Boolean(entrada.cargando || entrada.ocupado)));
    // Mientras se agrega, se mide o se vincula, la sección queda trabada aunque la
    // ficha se rehaga con los cambios de otros (ir a otro elemento sí se puede).
    if (entrada.ocupado) for (const b of sec.querySelectorAll('button:not(.integ-enlace)')) b.disabled = true;
  }

  function cargarIntegracion(feature, { refrescar = false, candidatas = false, avisar = false, pintar = true } = {}) {
    const tipo = feature.properties.tipo;
    const clave = `${tipo}:${feature.id}`;
    let entrada = integCache.get(clave);
    if (!entrada) {
      entrada = { datos: null, cuando: 0, version: null, error: null, fallo: 0, cargando: null, pedidos: 0, candidatas: false, ocupado: null };
      integCache.set(clave, entrada);
      // Se olvidan las más viejas: una NAP puede traer muchos contratos.
      for (const [k, e] of integCache) {
        if (integCache.size <= MAX_INTEGRACION) break;
        if (k !== clave && !e.cargando && !e.ocupado) integCache.delete(k);
      }
    }
    entrada.pedidos += 1;
    const n = entrada.pedidos;
    const version = feature.properties.version;
    const primera = !entrada.datos;
    const pedido = acciones.integracion.leer(tipo, feature.id, { refrescar, candidatas })
      .then((datos) => {
        if (n !== entrada.pedidos) return; // se pidió de nuevo: vale la respuesta más nueva
        Object.assign(entrada, { datos, error: null, cuando: Date.now(), version, candidatas });
        if ((avisar || primera) && mostrando(feature.id)) anunciar(resumenIntegracion(tipo, datos));
      })
      .catch((err) => {
        if (n !== entrada.pedidos) return;
        // Lo leído antes se sigue mostrando (con el error arriba) y no cuenta como fresco.
        Object.assign(entrada, { error: err.message, fallo: Date.now() });
        if ((avisar || primera) && mostrando(feature.id)) anunciar(err.message);
      })
      .finally(() => {
        if (entrada.cargando === pedido) entrada.cargando = null;
        repintarIntegracion(tipo, feature.id);
      });
    entrada.cargando = pedido;
    if (pintar) repintarIntegracion(tipo, feature.id);
    return pedido;
  }

  // Si la ficha sigue mostrando ese elemento, se rehace solo su sección (una
  // respuesta tardía no aparece en la ficha de otro).
  function repintarIntegracion(tipo, id) {
    if (!mostrando(id)) return;
    const sec = root.querySelector(`[data-integ="${tipo}-${id}"]`);
    const feature = red.state.elementos.get(id);
    if (sec && feature) pintarIntegracion(sec, feature);
  }

  function resumenIntegracion(tipo, d) {
    if (tipo === 'nap' && d.nap) return `${d.nap.nombre} en Wispro: ${plural(d.contratos?.length ?? 0, 'contrato', 'contratos')}.`;
    if (tipo === 'nap' && d.wispro) return 'Esta caja no aparece en Wispro con ese nombre: hay que elegir su NAP.';
    if (tipo === 'cliente' && d.contrato) {
      return `En Wispro: contrato${Number.isFinite(d.contrato.numero) ? ` #${d.contrato.numero}` : ''} de ${d.contrato.cliente || 'un cliente sin nombre'}.`;
    }
    if (tipo === 'cliente' && d.wispro) return 'Este cliente no aparece en Wispro.';
    if (d.medida) return 'Se encontró su ONT en el panel de la OLT.';
    return d.errores?.join(' ') || 'Terminó la lectura de Wispro y del panel de la OLT.';
  }

  const cabeceraInteg = (titulo, extra = null) => h('header.integ-cab', {}, h('h3', { text: titulo }), extra);

  // Cuando falla una lectura, lo de antes queda a la vista con el error arriba.
  function errorAlActualizar(entrada) {
    if (!entrada.error || !entrada.datos) return null;
    return h('p.integ-error', { text: `No se pudo actualizar: ${entrada.error} Se muestra lo leído ${I.haceCuanto(new Date(entrada.cuando).toISOString())}.` });
  }

  // Un botón de una acción de la sección: dice "Agregando…" o lo que sea mientras corre.
  const botonAccion = (entrada, clave, texto, haciendo, alTocar, extra = {}) => boton(entrada.ocupado === clave ? haciendo : texto, alTocar, extra);

  function textoComparacion(dif, estimada, { ont = false } = {}) {
    if (!Number.isFinite(dif)) return null;
    const base = `La carta estima ${formatDbm(estimada)}${ont ? ' para esta ONT' : ''}`;
    if (Math.abs(dif) < 1.5) return `${base}: la medida coincide.`;
    const cuanto = `la medida da ${formatDb(Math.abs(dif))} ${dif < 0 ? 'menos' : 'más'}`;
    if (ont && dif <= -I.DESVIO_DB) return `${base}: ${cuanto}. Revisá conectores y empalmes en el camino.`;
    return `${base}: ${cuanto}.`;
  }

  // Una acción de la sección (agregar, medir, vincular): mientras dura, la sección
  // queda trabada; al terminar se vuelve a leer, porque lo de antes ya no sirve.
  async function accionIntegracion(feature, clave, tarea, { releer = true } = {}) {
    const tipo = feature.properties.tipo;
    const entrada = integCache.get(`${tipo}:${feature.id}`);
    if (!entrada || entrada.ocupado) return;
    entrada.ocupado = clave;
    repintarIntegracion(tipo, feature.id);
    try {
      await tarea(entrada);
    } catch (err) {
      acciones.integracion.aviso(err.message);
    } finally {
      try {
        if (releer) {
          // Un vínculo o un cliente nuevo cambian también lo que muestran otras fichas
          // (la caja, el cliente, los dudosos): se vuelven a leer cuando se abran.
          for (const e of integCache.values()) if (e !== entrada) e.cuando = 0;
          const actual = red.state.elementos.get(feature.id);
          if (actual) await cargarIntegracion(actual, { pintar: false });
        }
      } finally {
        entrada.ocupado = null;
        repintarIntegracion(tipo, feature.id);
      }
    }
  }

  function medirIntegracion(feature) {
    const tipo = feature.properties.tipo;
    return accionIntegracion(feature, 'medir', async (entrada) => {
      const res = await acciones.integracion.medir(tipo, feature.id);
      const lista = (tipo === 'nap' ? entrada.datos?.contratos : [entrada.datos?.contrato]) ?? [];
      for (const c of lista) {
        const m = c ? res.medidas?.[c.id] : null;
        if (!m) continue;
        if (m.error) c.vivoError = m.error;
        else Object.assign(c, { vivo: m, vivoError: null });
      }
      const n = Object.values(res.medidas ?? {}).filter((m) => !m.error).length;
      acciones.integracion.toast(n ? `${plural(n, 'ONT medida', 'ONTs medidas')} en vivo` : 'Wispro no devolvió ninguna medida');
    }, { releer: false });
  }

  function importarIntegracion(feature, ids) {
    return accionIntegracion(feature, `importar:${ids.join(',')}`, async () => {
      const res = await acciones.integracion.importar(feature.id, ids);
      if (!res) return;
      const n = res.elementos.length;
      const motivos = [...new Set((res.omitidos ?? []).map((o) => o.motivo))];
      const extra = res.omitidos?.length ? ` · ${plural(res.omitidos.length, 'no se agregó', 'no se agregaron')}: ${motivos.join('; ')}` : '';
      acciones.integracion.toast(`${n ? `${plural(n, 'cliente agregado', 'clientes agregados')} al mapa` : 'No se agregó ningún cliente'}${extra}`);
    });
  }

  function vincularCaja(feature, nap) {
    return accionIntegracion(feature, `caja:${nap.id}`, async () => {
      await acciones.integracion.vincularNap(feature, nap);
      acciones.integracion.toast(`${feature.properties.nombre || 'La caja'} quedó vinculada con ${nap.nombre} de Wispro`);
    });
  }

  // Confirma que un cliente del mapa es el de un contrato (queda vinculado).
  const numeroDe = (contrato) => (Number.isFinite(contrato.numero) ? ` #${contrato.numero}` : '');

  function confirmarCliente(feature, clienteId, contrato) {
    return accionIntegracion(feature, `confirmar:${contrato.id}:${clienteId}`, async () => {
      const res = await acciones.integracion.vincularCliente(clienteId, contrato.id);
      if (!res) return;
      acciones.integracion.toast(`${res.elemento?.properties?.nombre || 'El cliente'} quedó vinculado con el contrato${numeroDe(contrato)} de Wispro`);
    });
  }

  // Un «No es» tocado sin querer: el contrato se vuelve a considerar para este cliente.
  function reconsiderarContrato(feature, contrato) {
    return accionIntegracion(feature, `reconsiderar:${contrato.id}`, async () => {
      const res = await acciones.integracion.desvincularCliente(feature.id, contrato.id, { deshacer: true });
      if (res) acciones.integracion.toast(`Se vuelve a considerar el contrato${numeroDe(contrato)}`);
    });
  }

  // Un cliente del mapa no es el de ese contrato: se deshace el vínculo (si lo había)
  // y no se lo vuelve a proponer.
  function descartarCliente(feature, clienteId, contrato) {
    return accionIntegracion(feature, `descartar:${contrato.id}:${clienteId}`, async () => {
      const res = await acciones.integracion.desvincularCliente(clienteId, contrato.id);
      if (!res) return;
      acciones.integracion.toast(`Listo: ${res.elemento?.properties?.nombre || 'el cliente'} no es el contrato${numeroDe(contrato)} de Wispro`);
    });
  }

  function vistaCandidatas(feature, d, entrada) {
    const cambiando = Boolean(d.nap);
    const texto = d.perdida
      ? 'La NAP de Wispro vinculada a esta caja ya no existe. ¿Cuál es ahora?'
      : cambiando ? '¿Con qué NAP de Wispro se corresponde esta caja?' : 'Esta caja no aparece en Wispro con ese nombre. ¿Es alguna de estas?';
    const lista = d.candidatas?.length
      ? h('ul.integ-candidatas', {}, ...d.candidatas.map((n) => {
        const b = boton('', () => vincularCaja(feature, n), { class: 'enlace', 'aria-pressed': String(d.nap?.id === n.id) });
        const detalle = [n.distancia_m !== null ? `a ${formatLargo(n.distancia_m)}` : 'sin ubicación', plural(n.contratos, 'contrato', 'contratos'), n.olt,
          entrada.ocupado === `caja:${n.id}` ? 'vinculando…' : null];
        b.append(h('strong', { text: n.nombre }), h('small', { text: detalle.filter(Boolean).join(' · ') }));
        return h('li', {}, b);
      }))
      : h('p.ficha-sub', { text: 'No hay NAPs de Wispro a menos de 1,5 km ni con un nombre parecido. Revisá el nombre de la caja o su ubicación en Wispro.' });
    return [
      cabeceraInteg('En Wispro', cambiando ? boton('Cancelar', () => {
        // Lo que esté llegando con las candidatas ya no vale.
        Object.assign(entrada, { candidatas: false, pedidos: entrada.pedidos + 1, cargando: null });
        repintarIntegracion('nap', feature.id);
      }, { class: 'integ-mini' }) : null),
      errorAlActualizar(entrada),
      h('p', { text: texto }),
      lista,
    ];
  }

  function avisosNap(d, virtual, est, pons) {
    const avisos = [];
    const leido = d.panel?.leido;
    if (d.configurada?.panel && leido && I.viejo(leido)) {
      avisos.push(`El panel de la OLT no lee la OLT desde el ${formatFecha(leido)}: las potencias son de ese momento.`
        + (d.configurada?.wispro ? ' «Medir ahora» las lee en vivo por Wispro.' : ''));
    }
    if (est.fuera.length && est.fuera.length === est.conLectura && est.conLectura >= 2) {
      avisos.push('Todas las ONTs de la caja están sin señal: el corte está antes de la caja (la fibra que llega o el splitter).');
    } else if (est.fuera.length) {
      avisos.push(`Sin señal: ${est.fuera.map((c) => c.cliente || `#${c.numero}`).join(', ')}.`);
    }
    for (const g of est.juntas) {
      const causas = [...new Set(g.items.map((x) => x.causa).filter(Boolean))];
      const luz = causas.length && causas.every((x) => /gasp/i.test(x));
      avisos.push(`${plural(new Set(g.items.map((x) => x.id)).size, 'ONT', 'ONTs')} se cayeron juntas el ${formatFecha(new Date(g.desde).toISOString())}`
        + `${causas.length ? ` (${causas.join(', ')})` : ''}: ${luz ? 'parece un corte de luz.' : 'el problema estuvo antes de la caja.'}`);
    }
    if (Number.isFinite(virtual?.diferencia) && virtual.diferencia <= -I.DESVIO_DB) {
      avisos.push(`En las bocas hay ${formatDb(-virtual.diferencia)} menos de lo que estima la carta: algo pierde de más antes de la caja (empalmes, conectores o un splitter distinto del cargado).`);
    } else if (Number.isFinite(virtual?.diferencia) && virtual.diferencia >= I.DESVIO_DB) {
      avisos.push(`En las bocas hay ${formatDb(virtual.diferencia)} más de lo que estima la carta: revisá la potencia de la OLT y los splitters cargados.`);
    }
    // Lo de cada cliente, junto: llega bajo, varía o viene bajando.
    const porCliente = new Map();
    const anotar = (id, nombre, texto) => {
      if (!porCliente.has(id)) porCliente.set(id, { nombre: nombre || 'Un cliente', textos: [] });
      porCliente.get(id).textos.push(texto);
    };
    for (const f of virtual?.bajas ?? []) anotar(f.id, f.cliente, `llega ${formatDb(virtual.boca - f.boca)} por debajo del resto`);
    for (const x of est.inestables) anotar(x.id, x.cliente, `varió ${formatDb(x.rango)} en la semana`);
    for (const x of est.bajando) anotar(x.id, x.cliente, `viene bajando ${formatDb(-x.ritmo)} por semana`);
    for (const { nombre, textos } of porCliente.values()) {
      const lista = textos.length > 1 ? `${textos.slice(0, -1).join(', ')} y ${textos.at(-1)}` : textos[0];
      avisos.push(`${nombre}: ${lista}. Revisá su bajada y sus conectores.`);
    }
    if (pons.size > 1) {
      avisos.push(`Los clientes de esta caja están en ${pons.size} puertos PON: ${[...pons].map(([p, n]) => `${p} (${n})`).join(', ')}.`);
    } else if (pons.size === 1 && d.nap.fbp && !mismoPon(d.nap.fbp, [...pons.keys()][0])) {
      avisos.push(`En Wispro la caja figura en ${d.nap.olt ?? 'su OLT'} ${d.nap.fbp}, pero sus ONTs están en ${[...pons.keys()][0]}.`);
    }
    return avisos;
  }

  // Un cliente del mapa, para ir a su ficha; varios van separados por comas (la
  // coma queda pegada al nombre, no al principio de la línea siguiente).
  const enlaceCliente = (ref) => boton(ref.nombre || 'Cliente sin nombre', () => acciones.seleccionar('elemento', ref.id), { class: 'integ-enlace' });
  const enlacesClientes = (refs) => refs.flatMap((r, i) => (i < refs.length - 1 ? [h('span.junto', {}, enlaceCliente(r), ','), ' '] : [enlaceCliente(r)]));

  // Lo que va en la columna de la potencia: corto, para que entre al lado del nombre.
  function textoPotencia(c, m) {
    if (m && Number.isFinite(m.rx)) return formatDbm(m.rx);
    if (m && m.estado && m.estado !== 'online') return 'sin señal';
    return c.sn ? 'sin lectura' : 'sin ONT en Wispro';
  }

  // Dónde está en el mapa el cliente de un contrato, o por qué no está.
  // Cómo coincide un cliente del mapa con un contrato: "por el n.º de abonado, a 4,4 km".
  const comoCoincide = (x) => [POR[x.por] ?? 'por un dato que coincide', x.lejos_m ? `a ${formatLargo(x.lejos_m)}` : null]
    .filter(Boolean).join(', ');

  // Dudosos que coinciden solo lejos (a más de 2 km): no frenan agregar el contrato al mapa.
  const soloLejos = (t) => Boolean(t?.dudosos?.length && t.dudosos.every((x) => x.lejos_m));

  // "Es este" (queda vinculado) y "No es" (no se lo vuelve a proponer) para un
  // cliente del mapa que podría ser el de un contrato. "No es" no se ofrece si lo
  // que coincide es la ONT o el n.º de contrato cerca: eso se corrige en el dato.
  function botonesDuda(feature, entrada, contrato, ref, { si = 'Es este', haciendo = 'Vinculando…', etiquetaSi, etiquetaNo, por, lejos }) {
    const descartable = DEBIL.has(por) || Boolean(lejos);
    return h('span.integ-botones', {},
      botonAccion(entrada, `confirmar:${contrato.id}:${ref.id}`, si, haciendo, () => confirmarCliente(feature, ref.id, contrato),
        { class: 'integ-mini', 'aria-label': etiquetaSi }),
      descartable
        ? botonAccion(entrada, `descartar:${contrato.id}:${ref.id}`, 'No es', 'Quitando…', () => descartarCliente(feature, ref.id, contrato),
          { class: 'integ-mini', 'aria-label': etiquetaNo })
        : null);
  }

  function enElMapa(feature, entrada, c) {
    const t = c.traza;
    const quien = c.cliente || (Number.isFinite(c.numero) ? `el contrato #${c.numero}` : 'este contrato');
    if (t?.id) {
      const nombre = t.nombre || 'el cliente del mapa';
      const dudas = DEBIL.has(t.por)
        ? botonesDuda(feature, entrada, c, t, { si: 'Confirmar', haciendo: 'Confirmando…', por: t.por,
          etiquetaSi: `Confirmar que ${nombre} es ${quien}`, etiquetaNo: `${nombre} no es ${quien}` })
        : null;
      return h('span.integ-falta', {}, h('span', {}, 'En el mapa: ', enlaceCliente(t), POR[t.por] ? h('small', { text: ` (${POR[t.por]})` }) : null), dudas);
    }
    if (t?.repetidos) {
      return h('span.integ-repetido', {}, `Está ${t.repetidos.length} veces en el mapa${POR[t.por] ? ` (${POR[t.por]})` : ''}: `,
        ...enlacesClientes(t.repetidos), '. Borrá el que sobra.');
    }
    if (t?.dudosos) {
      const agregar = soloLejos(t) && c.ubicacion && !c.lejos_m
        ? botonAccion(entrada, `importar:${c.id}`, 'Agregar al mapa', 'Agregando…', () => importarIntegracion(feature, [c.id]),
          { class: 'integ-mini', 'aria-label': `Agregar al mapa a ${quien}` })
        : null;
      return h('div.integ-dudosos', {},
        h('span', { text: 'En el mapa podría ser:' }),
        h('ul', {}, ...t.dudosos.map((x) => {
          const nombre = x.nombre || 'Ese cliente del mapa';
          return h('li', {},
            h('span', {}, enlaceCliente(x), h('small', { text: ` (${comoCoincide(x)})` })),
            botonesDuda(feature, entrada, c, x, { por: x.por, lejos: x.lejos_m, etiquetaSi: `${nombre} es ${quien}`, etiquetaNo: `${nombre} no es ${quien}` }));
        })),
        agregar ? h('span.integ-falta', {}, h('span', { text: 'Si no es ninguno:' }), agregar) : null);
    }
    if (c.lejos_m) return h('span', { text: `No está en el mapa: su ubicación en Wispro está a ${formatLargo(c.lejos_m)} de la caja` });
    if (c.ubicacion) {
      return h('span.integ-falta', {}, h('span', { text: 'No está en el mapa' }),
        botonAccion(entrada, `importar:${c.id}`, 'Agregar al mapa', 'Agregando…', () => importarIntegracion(feature, [c.id]),
          { class: 'integ-mini', 'aria-label': `Agregar al mapa a ${quien}` }));
    }
    return h('span', { text: 'No está en el mapa y Wispro no tiene su ubicación' });
  }

  function filaContrato(feature, entrada, c) {
    const m = I.medidaVigente(c);
    const nivel = I.nivelDe(m);
    const sinSenal = Boolean(m && !Number.isFinite(m.rx) && m.estado && m.estado !== 'online');
    const detalle = [
      c.sn ? `ONT ${c.sn}` : null,
      m?.interfaz,
      sinSenal ? m.causa : null,
      sinSenal && Number.isFinite(m.rx_ultima) ? `tenía ${formatDbm(m.rx_ultima)}` : null,
      m?.fuente === 'wispro' ? `en vivo ${I.haceCuanto(m.cuando)}` : null,
      c.vivoError ? `en vivo: ${c.vivoError}` : null,
    ].filter(Boolean).join(' · ');
    return h('li.integ-contrato', {},
      h('div.integ-linea', {},
        h('span.integ-nombre', {}, h('strong', { text: c.cliente || 'Sin nombre' }),
          Number.isFinite(c.numero) ? h('small', { text: ` #${c.numero}` }) : null,
          c.estado && c.estado !== 'enabled' ? h('span.chip', { text: ESTADO_CONTRATO[c.estado] ?? c.estado }) : null),
        h('span.integ-pot', {}, h('span.integ-num', { text: textoPotencia(c, m) }),
          nivel && Number.isFinite(m?.rx) ? h(`span.nivel.${nivel.nivel}`, { text: nivel.texto }) : null)),
      h('div.integ-linea.integ-sub', {}, enElMapa(feature, entrada, c), detalle ? h('small', { text: detalle }) : null));
  }

  // Orden: sin señal primero, después de la peor potencia a la mejor, y al final los que no tienen lectura.
  function ordenContratos(contratos) {
    const clave = (c) => {
      const m = I.medidaVigente(c);
      if (m && !Number.isFinite(m.rx) && m.estado && m.estado !== 'online') return [0, 0];
      if (m && Number.isFinite(m.rx)) return [1, m.rx];
      return [2, 0];
    };
    return [...contratos].sort((a, b) => {
      const [x, y] = [clave(a), clave(b)];
      return x[0] - y[0] || x[1] - y[1] || String(a.cliente).localeCompare(String(b.cliente), 'es');
    });
  }

  function vistaNap(feature, entrada) {
    const d = entrada.datos;
    const errores = d.errores?.length ? h('ul.integ-errores', {}, ...d.errores.map((e) => h('li', { text: e }))) : null;
    const actualizar = boton(entrada.cargando ? 'Actualizando…' : 'Actualizar', () => cargarIntegracion(feature, { refrescar: true, avisar: true }),
      { disabled: Boolean(entrada.cargando) });
    if (!d.configurada?.wispro) {
      return [cabeceraInteg('En Wispro'),
        h('p.ficha-sub', { text: 'Esta red no está conectada con Wispro, así que no se sabe qué clientes tiene esta caja. Se conecta en el servidor con el comando integraciones.' })];
    }
    if (!d.wispro) return [cabeceraInteg('En Wispro'), errorAlActualizar(entrada), errores, botones(actualizar)];
    if (!d.nap || entrada.candidatas) return [...vistaCandidatas(feature, d, entrada), errores];

    const s = red.state;
    const contratos = d.contratos ?? [];
    const virtual = I.medicionVirtual(s, feature, contratos);
    const est = I.estabilidad(contratos);
    const pons = I.puertosPon(contratos);
    const avisos = avisosNap(d, virtual, est, pons);
    // "Sin caídas" solo si el panel está al día y llegó la semana de cada ONT que tiene.
    const conSemana = contratos.some((c) => c.historia?.tendencia?.muestras > 0);
    const historiaCompleta = contratos.every((c) => c.medida?.panel_id === undefined || c.medida?.panel_id === null || c.historia);
    const bien = !avisos.length && conSemana && historiaCompleta && !I.viejo(d.panel?.leido) && !est.caidas.length
      ? 'Sin caídas en los últimos 7 días.' : null;
    const faltan = contratos.filter((c) => (!c.traza || soloLejos(c.traza)) && c.ubicacion && !c.lejos_m);

    const cambiar = boton('Cambiar', () => cargarIntegracion(feature, { candidatas: true }),
      { class: 'integ-mini', title: 'Vincular esta caja con otra NAP de Wispro', disabled: Boolean(entrada.cargando) });
    const sub = [plural(contratos.length, 'contrato', 'contratos'), d.nap.olt, d.nap.fbp,
      d.nap.por === 'nombre' ? 'encontrada por el nombre' : null].filter(Boolean).join(' · ');
    let medida = null;
    if (virtual) {
      const rango = virtual.filas.length > 1 ? `, entre ${formatDbm(virtual.max)} y ${formatDbm(virtual.min)}` : '';
      medida = h('div.integ-medida', {},
        h('p.integ-valor', {}, h('strong', { text: `≈ ${formatDbm(virtual.boca)}` }), h('span', { text: 'en las bocas de la caja' })),
        h('p.ficha-sub', { text: `Medición virtual con ${plural(virtual.filas.length, 'ONT', 'ONTs')}${rango}.` }),
        virtual.diferencia !== null && Math.abs(virtual.diferencia) < I.DESVIO_DB
          ? h('p.integ-comparacion', { text: textoComparacion(virtual.diferencia, virtual.estimada) }) : null);
    } else if (contratos.length) {
      medida = h('p.ficha-sub', { text: d.configurada?.panel || d.configurada?.wispro
        ? 'Todavía no hay potencias de las ONTs de esta caja para la medición virtual.'
        : 'Sin potencias: la red no está conectada con el panel de la OLT.' });
    }
    const medir = contratos.some((c) => c.sn)
      ? botonAccion(entrada, 'medir', 'Medir ahora', 'Midiendo…', () => medirIntegracion(feature),
        { title: 'Lee en vivo, por Wispro, la potencia de cada ONT de la caja' })
      : null;
    let agregar = null;
    if (faltan.length) {
      const ids = faltan.map((c) => c.id);
      agregar = botonAccion(entrada, `importar:${ids.join(',')}`,
        faltan.length === 1 ? 'Agregar al mapa el que falta' : `Agregar al mapa los ${faltan.length} que faltan`, 'Agregando…',
        () => importarIntegracion(feature, ids), { class: 'primario' });
    }
    const leidos = [`Wispro: ${I.haceCuanto(d.wispro.leido)}`];
    if (d.panel?.leido) leidos.push(`panel de la OLT: lecturas del ${formatFecha(d.panel.leido)}`);
    return [
      cabeceraInteg(`En Wispro: ${d.nap.nombre}`, cambiar),
      h('p.ficha-sub', { text: sub }),
      errorAlActualizar(entrada),
      medida,
      avisos.length || bien ? h('ul.integ-avisos', {}, ...avisos.map((t) => h('li', { text: t })), bien ? h('li.bien', { text: bien }) : null) : null,
      errores,
      contratos.length
        ? h('ul.integ-contratos', { 'aria-label': 'Contratos de la caja en Wispro' }, ...ordenContratos(contratos).map((c) => filaContrato(feature, entrada, c)))
        : h('p.ficha-sub', { text: 'Wispro no tiene contratos en esta caja.' }),
      botones(agregar, medir, actualizar),
      h('p.ficha-nota', { text: `${leidos.join(' · ')}. La medición virtual suma a la potencia de cada ONT lo que pierde su bajada (conectores y fibra).` }),
    ];
  }

  // Contratos de Wispro que podrían ser de este cliente (coincide un dato, pero no
  // alcanza para darlo por hecho): se confirma con un toque.
  function vistaPosibles(feature, entrada, posibles) {
    return h('div.integ-dudosos', {},
      h('p', { text: posibles.length === 1 ? '¿Es este su contrato?' : '¿Es alguno de estos su contrato?' }),
      h('ul', {}, ...posibles.map((p) => {
        const cual = `El contrato${numeroDe(p)} de ${p.cliente || 'Wispro'}`;
        return h('li', {},
          h('span', {}, h('strong', { text: p.cliente || 'Sin nombre' }), Number.isFinite(p.numero) ? h('small', { text: ` #${p.numero}` }) : null,
            h('small', { text: ` · ${[p.nap_nombre, comoCoincide(p)].filter(Boolean).join(' · ')}` })),
          botonesDuda(feature, entrada, p, { id: feature.id },
            { por: p.por, lejos: p.lejos_m, etiquetaSi: `${cual} es el de este cliente`, etiquetaNo: `${cual} no es el de este cliente` }));
      })));
  }

  // Contratos con los que coincide algún dato del cliente pero que en el mapa son de
  // otro: puede ser el mismo cliente dibujado dos veces.
  const DATO = { vinculado: 'Su vínculo', ont: 'Su ONT', contrato: 'Su n.º de contrato', abonado: 'Su n.º de abonado', nombre: 'Su nombre' };
  function vistaOcupados(ocupados) {
    return h('div.integ-dudosos', {},
      h('ul', {}, ...ocupados.map((o) => h('li', {}, h('span', {},
        `${DATO[o.por] ?? 'Un dato'} coincide con el contrato${numeroDe(o)} de ${o.cliente || 'Wispro'}, que en el mapa es `,
        ...enlacesClientes(o.en_mapa), '.')))),
      h('p.ficha-nota', { text: 'Si es el mismo cliente, borrá uno de los dos; si no, corregí el dato en su ficha.' }));
  }

  // Los contratos marcados «No es» en este cliente: se puede deshacer (un toque sin querer).
  function vistaDescartados(feature, entrada, descartados) {
    return h('div.integ-descartados', {},
      h('p.ficha-nota', { text: 'Marcados «No es» (no se proponen para este cliente):' }),
      h('ul', {}, ...descartados.map((x) => h('li', {},
        h('span', { text: x.numero === undefined ? 'Un contrato que ya no está en Wispro' : `Contrato${numeroDe(x)} de ${x.cliente || 'Wispro'}` }),
        botonAccion(entrada, `reconsiderar:${x.id}`, 'Deshacer', 'Deshaciendo…', () => reconsiderarContrato(feature, x),
          { class: 'integ-mini', 'aria-label': `Volver a considerar el contrato${numeroDe(x)} para este cliente` })))));
  }

  function vistaCliente(feature, entrada) {
    const d = entrada.datos;
    const s = red.state;
    const c = d.contrato;
    const m = I.medidaVigente({ medida: d.medida, vivo: c?.vivo });
    const errores = d.errores?.length ? h('ul.integ-errores', {}, ...d.errores.map((e) => h('li', { text: e }))) : null;
    const actualizar = boton(entrada.cargando ? 'Actualizando…' : 'Actualizar', () => cargarIntegracion(feature, { refrescar: true, avisar: true }),
      { disabled: Boolean(entrada.cargando) });
    const posibles = d.posibles?.length ? vistaPosibles(feature, entrada, d.posibles) : null;
    const ocupados = d.ocupados?.length ? vistaOcupados(d.ocupados) : null;
    const descartados = d.descartados?.length ? vistaDescartados(feature, entrada, d.descartados) : null;
    // "No aparece" solo si Wispro se pudo leer (si falló, se ve el error) y no hay otra explicación.
    let noAparece = null;
    if (!c && d.wispro && posibles) noAparece = 'No está vinculado con ningún contrato de Wispro, pero hay datos que coinciden.';
    else if (!c && d.wispro && !ocupados) {
      noAparece = 'Este cliente no aparece en Wispro: no coinciden su ONT ni su n.º de contrato o de abonado, y no hay un contrato con su nombre cerca. Anotá alguno de esos datos en su ficha.';
    }
    if (!c && !m) {
      const texto = noAparece ?? (d.configurada?.panel && !d.configurada?.wispro
        ? 'El panel de la OLT no tiene la ONT de este cliente: anotá su número de serie en el campo ONT.' : null);
      return [cabeceraInteg('En Wispro'), errorAlActualizar(entrada), texto ? h('p.ficha-sub', { text: texto }) : null, posibles, ocupados,
        errores, botones(actualizar), descartados];
    }
    const nivel = I.nivelDe(m);
    const datos = h('dl.ficha-datos.integ-datos', {},
      c ? fila('Contrato', [`#${c.numero ?? '—'}`, ESTADO_CONTRATO[c.estado] ?? c.estado].filter(Boolean).join(' · ')) : null,
      c ? fila('Titular', c.cliente) : null,
      c && POR[c.por] ? fila('Encontrado', POR[c.por]) : null,
      c?.nap_nombre ? fila('NAP en Wispro', c.nap_nombre) : null,
      c?.sn || m?.sn ? fila('ONT', [c?.sn ?? m?.sn, m?.interfaz, m?.olt].filter(Boolean).join(' · ')) : null);
    let medida = null;
    if (m) {
      const cuando = m.fuente === 'wispro'
        ? `Medida en vivo por Wispro ${I.haceCuanto(m.cuando)}.`
        : `Lectura del panel de la OLT del ${formatFecha(m.cuando)} (${I.haceCuanto(m.cuando)}).`;
      // Lo que estima la carta para esta ONT, si el pelo llega a una OLT con su potencia cargada.
      const con = F.conexionCliente(s, feature);
      const pot = con?.origen?.motivo === 'olt' ? F.potencias(s, F.recorrido(s, feature.id, con.ext)) : null;
      const comp = pot?.llega !== null && pot?.llega !== undefined && Number.isFinite(m.rx)
        ? textoComparacion(m.rx - pot.llega, pot.llega, { ont: true }) : null;
      const sinSenal = !Number.isFinite(m.rx);
      medida = h('div.integ-medida', {},
        h('p.integ-valor', {}, h('strong', { text: sinSenal ? 'sin señal' : formatDbm(m.rx) }),
          nivel && !sinSenal ? h(`span.nivel.${nivel.nivel}`, { text: nivel.texto }) : null),
        h('p.ficha-sub', { text: [cuando, sinSenal && m.causa ? `Causa: ${m.causa}.` : null,
          sinSenal && Number.isFinite(m.rx_ultima) ? `Tenía ${formatDbm(m.rx_ultima)}.` : null].filter(Boolean).join(' ') }),
        comp ? h('p.integ-comparacion', { text: comp }) : null);
    } else if (c?.vivoError) {
      medida = h('p.ficha-sub', { text: `En vivo: ${c.vivoError}.` });
    }
    const historia = d.historia;
    const tend = historia?.tendencia;
    const lineas = [];
    if (tend && Number.isFinite(tend.rx_min) && Number.isFinite(tend.rx_max) && tend.muestras) {
      lineas.push(`En 7 días: entre ${formatDbm(tend.rx_max)} y ${formatDbm(tend.rx_min)} (${plural(tend.muestras, 'lectura', 'lecturas')})`
        + (Number.isFinite(tend.db_semana) && Math.abs(tend.db_semana) >= 0.05
          ? `; ${tend.db_semana < 0 ? 'baja' : 'sube'} ${formatDb(Math.abs(tend.db_semana))} por semana.` : '.'));
    }
    const est = I.estabilidad([{ id: c?.id ?? 'x', cliente: '', medida: d.medida, historia }]);
    if (est.caidas.length) {
      const ultimas = est.caidas.slice(-3).reverse().map((x) => `${formatFecha(new Date(x.t).toISOString())}${x.causa ? ` (${x.causa})` : ''}`);
      lineas.push(`${plural(est.caidas.length, 'caída', 'caídas')} en 7 días: ${ultimas.join(', ')}${est.caidas.length > 3 ? '…' : ''}.`);
    } else if (tend?.muestras > 0 && !I.viejo(d.panel?.leido)) lineas.push('Sin caídas en los últimos 7 días.');
    const avisos = [];
    // La lectura es vieja si el panel dejó de leer la OLT (una ONT apagada tiene su última lectura vieja, y está bien).
    if (m?.fuente === 'panel' && d.panel?.leido && I.viejo(d.panel.leido)) {
      avisos.push([`El panel de la OLT no lee la OLT desde el ${formatFecha(d.panel.leido)}: esta lectura es de ese momento.`]);
    }
    if (c?.repetidos?.length) {
      avisos.push(['Este contrato también está en el mapa como ', ...enlacesClientes(c.repetidos), '. Borrá el que sobra.']);
    }
    const medir = c?.sn && d.configurada?.wispro
      ? botonAccion(entrada, 'medir', 'Medir ahora', 'Midiendo…', () => medirIntegracion(feature), { title: 'Lee en vivo, por Wispro, la potencia de esta ONT' })
      : null;
    // Lo encontrado por el abonado o el nombre se confirma (o se descarta); lo demás
    // también se puede deshacer si no es su contrato.
    let confirmar = null;
    let noEs = null;
    if (c && DEBIL.has(c.por)) {
      confirmar = h('div.integ-confirmar', {},
        h('p', { text: `El contrato se encontró ${POR[c.por]}. ¿Es el de este cliente?` }),
        botonesDuda(feature, entrada, c, { id: feature.id }, { si: 'Sí, es su contrato', haciendo: 'Vinculando…', por: c.por,
          etiquetaSi: `El contrato${numeroDe(c)} es el de este cliente`, etiquetaNo: `El contrato${numeroDe(c)} no es el de este cliente` }));
    } else if (c?.por === 'ont' || c?.por === 'contrato') {
      // Lo encontró un dato que se anotó en la ficha: si está mal, se corrige el dato.
      noEs = h('p.ficha-nota', { text: c.por === 'ont'
        ? 'Se encontró por la ONT anotada en su ficha: si no es su contrato, corregila con «Editar».'
        : 'Se encontró por el n.º de contrato anotado en su ficha: si no es su contrato, corregilo con «Editar».' });
    } else if (c) {
      noEs = h('p.ficha-nota.integ-no-es', {}, 'Si este no es su contrato: ',
        botonAccion(entrada, `descartar:${c.id}:${feature.id}`, 'No es su contrato', 'Quitando…', () => descartarCliente(feature, feature.id, c),
          { class: 'integ-mini' }));
    }
    return [
      cabeceraInteg('En Wispro'),
      errorAlActualizar(entrada),
      datos,
      confirmar,
      medida,
      lineas.length ? h('p.integ-historia', { text: lineas.join(' ') }) : null,
      avisos.length ? h('ul.integ-avisos', {}, ...avisos.map((partes) => h('li', {}, ...partes))) : null,
      noAparece ? h('p.ficha-sub', { text: noAparece }) : null,
      posibles,
      ocupados,
      errores,
      botones(medir, actualizar),
      noEs,
      descartados,
    ];
  }

  function verElemento(feature) {
    // Al abrir la ficha de otra cosa, una caja que estaba eligiendo su NAP de Wispro
    // ("Cambiar") vuelve a su vista normal.
    if (!mostrando(feature.id)) {
      const e = integCache.get(`nap:${feature.id}`);
      if (e) e.candidatas = false;
    }
    const props = feature.properties;
    const def = ELEMENTOS[props.tipo] ?? { label: props.tipo, nombre: props.tipo };
    const datos = props.datos ?? {};
    const [lng, lat] = feature.geometry.coordinates;
    const pegados = red.cablesPegados(feature.id);
    const conCarta = F.CON_CARTA.has(props.tipo);
    const carta = conCarta ? resumenCarta(feature) : null;
    const s = red.state;

    let conexion = null;
    if (props.tipo === 'cliente') {
      const con = F.conexionCliente(s, feature);
      if (con) {
        const donde = F.nombreElemento(s, con.union.elemento);
        const origen = con.origen?.motivo === 'olt' ? s.equipos.get(con.origen.equipo) : null;
        // Potencia que debería llegar según la carta, y cómo se compara con la medida.
        const pot = origen ? F.potencias(s, F.recorrido(s, feature.id, con.ext)) : null;
        const medida = Number.isFinite(datos.potencia) ? datos.potencia : null;
        let estimada = null;
        if (pot?.llega !== null && pot?.llega !== undefined) {
          let comparacion = '';
          if (medida !== null) {
            // Con más de 3 dB menos de lo esperable, algo pierde de más en el camino.
            const dif = medida - pot.llega;
            if (Math.abs(dif) < 1.5) comparacion = ' · la medida coincide';
            else if (dif <= -3) comparacion = ` · la medida está ${formatDb(-dif)} por debajo: revisá conectores y empalmes`;
            else comparacion = ` · la medida está ${formatDb(Math.abs(dif))} ${dif < 0 ? 'por debajo' : 'por encima'}`;
          }
          estimada = h('p.ficha-sub', { text: `Potencia estimada en la ONT: ≈ ${formatDbm(pot.llega)}${comparacion}` });
        }
        conexion = h('div.ficha-conexion', {},
          h('p', {}, h('strong', { text: `${donde} · ${F.etiquetaExtremo(s, con.union.a)}` })),
          h('p.ficha-sub', { text: origen
            ? `Llega desde ${F.etiquetaPuerto(origen, 's', con.origen.puerto)} (${F.nombreElemento(s, con.origen.elemento)}).`
            : 'Según la carta de empalme. Del otro lado el pelo todavía no llega a una OLT.' }),
          estimada,
          botones(boton('Ver recorrido', () => acciones.verRecorrido(feature.id, con.ext))));
      }
    }

    const viejos = Object.entries(CAMPOS_VIEJOS).map(([k, l]) => fila(l, datos[k]));
    const detalle = h('dl.ficha-datos', {},
      fila('Estado', ESTADOS[props.estado] ?? props.estado),
      ...(CAMPOS[props.tipo] ?? []).map((c) => filaDato(c, datos[c.k])),
      ...viejos,
      carta ? fila('Carta de empalme', carta.texto) : null,
      ...(carta?.equiposTexto ?? []).map((t) => fila('Equipo', t)),
      fila('Notas', props.notas),
      fila('Posición', `${lat.toFixed(6)}, ${lng.toFixed(6)}`),
    );
    const cables = pegados.length
      ? h('div.ficha-lista', {},
        h('p.ficha-sub', { text: pegados.length === 1 ? 'Pasa por acá 1 cable' : `Pasan por acá ${pegados.length} cables` }),
        h('ul', {}, ...pegados.map((c) => h('li', {},
          boton(`${c.properties.nombre} · ${c.properties.fibras} F · ${CABLES[c.properties.tipo]?.label ?? c.properties.tipo}`,
            () => acciones.seleccionar('cable', c.id), { class: 'enlace' }),
        ))),
      )
      : null;
    const avisos = [];
    if (carta && (carta.uniones || carta.equipos.length)) {
      avisos.push(`Se pierde su carta de empalme (${plural(carta.uniones, 'unión', 'uniones')}${carta.equipos.length ? `, ${plural(carta.equipos.length, 'equipo', 'equipos')}` : ''}).`);
    }
    if (pegados.length) {
      avisos.push(pegados.length === 1 ? 'El cable que pasa por acá queda suelto en este punto.' : `Los ${pegados.length} cables que pasan por acá quedan sueltos en este punto.`);
    }
    const confirmar = confirmacion(`¿Borrar ${props.nombre}?${avisos.length ? ` ${avisos.join(' ')}` : ''}`, () => acciones.borrarElemento(feature));
    const integ = seccionIntegracion(feature);
    abrir('elemento', [
      conexion,
      props.tipo === 'cliente' ? integ : null,
      detalle,
      props.tipo === 'nap' ? integ : null,
      cables,
      firma(props),
      conCarta ? botones(boton('Carta de empalme', () => acciones.abrirCarta(feature), { class: 'primario' })) : null,
      botones(
        boton('Editar', () => formElemento({ tipo: props.tipo, feature }), { class: conCarta ? null : 'primario' }),
        boton('Mover', () => acciones.moverElemento(feature)),
        boton('Borrar', () => { confirmar.hidden = false; confirmar.scrollIntoView({ block: 'nearest' }); }),
      ),
      confirmar,
    ], { titulo: props.nombre || def.nombre, chip: def.label, id: `e${feature.id}` });
    actual = { feature };
  }

  // -------------------------------------------------------------- cables

  function formCable({ feature, coords, nodos, largo }) {
    const props = feature?.properties ?? {};
    const datos = props.datos ?? {};
    const ultimo = recordarCable();
    const comunes = [
      { k: 'nombre', l: 'Nombre o código', t: 'text', req: true },
      { k: 'tipo', l: 'Tipo', t: 'select', o: opcionesTipoCable },
      { k: 'fibras', l: 'Fibras', t: 'select', o: opcionesFibras },
      { k: 'por_tubo', l: 'Fibras por tubo', t: 'select', o: opcionesPorTubo, sinVacio: true },
      { k: 'colores', l: 'Código de colores', t: 'select', o: opcionesColores, sinVacio: true },
      { k: 'estado', l: 'Estado', t: 'select', o: opcionesEstado },
      { k: 'tendido', l: 'Tendido', t: 'select', o: opcionesTendido },
    ];
    const propios = CAMPOS.cable;
    const estado = { feature, coords, nodos }; // los puntos pegados pueden corregirse con el formulario abierto
    const nombreSugerido = feature ? props.nombre : sugerirNombre('CAB', red.nombres('cable'));
    const puntos = coords ?? feature.geometry.coordinates;
    const pegados = (nodos ?? props.nodos ?? []).filter((n) => n !== null).length;

    const vistaTubos = h('p.ficha-sub.ficha-tubos');
    const form = h('form.ficha-form', { autocomplete: 'off', novalidate: true },
      h('p.ficha-sub', { text: `${puntos.length} puntos · ${formatLargo(largo ?? props.largo_m)}`
        + (pegados ? ` · ${pegados} pegado${pegados === 1 ? '' : 's'} a elementos` : '') }),
      campo(comunes[0], nombreSugerido),
      campo(comunes[1], props.tipo ?? ultimo.tipo ?? 'distribucion'),
      campo(comunes[2], String(props.fibras ?? ultimo.fibras ?? 12)),
      campo(comunes[3], String(props.por_tubo ?? ultimo.por_tubo ?? 0)),
      campo(comunes[4], props.colores ?? ultimo.colores ?? 'tia598'),
      vistaTubos,
      campo(comunes[5], props.estado ?? ultimo.estado ?? 'instalado'),
      campo(comunes[6], props.tendido ?? ultimo.tendido ?? 'aereo'),
      ...propios.map((c) => campo(c, datos[c.k])),
      campo(campoNotas, props.notas),
      botones(
        boton('Guardar', null, { type: 'submit', class: 'primario' }),
        boton('Cancelar', () => acciones.cancelar()),
      ),
    );
    // Cómo quedan los tubos con lo elegido: "4 tubos de 12: azul, naranja, verde, marrón".
    const pintarTubos = () => {
      const est = F.estructura({
        fibras: Number(form.elements.fibras.value) || 12,
        por_tubo: Number(form.elements.por_tubo.value) || 0,
        colores: form.elements.colores.value,
      });
      // Con un tubo se muestran los colores de las fibras; con varios, los de los tubos.
      const uno = est.tubos === 1;
      const total = uno ? est.porTubo : est.tubos;
      const colores = [];
      for (let i = 1; i <= Math.min(total, 6); i += 1) colores.push(uno ? est.codigo.fibra(i) : est.codigo.tubo(i));
      const nombres = colores.map((c) => F.nombreColor(c)).join(', ') + (total > 6 ? '…' : '');
      vistaTubos.replaceChildren(
        h('span', { text: uno ? `Un tubo de ${est.porTubo}: ${nombres}` : `${est.tubos} tubos de ${est.porTubo}: ${nombres}` }),
        h('span.tubo-muestras', { 'aria-hidden': 'true' },
          ...colores.map((c) => h('span.tubo-muestra', { style: `--c:${c.hex}` }))),
      );
    };
    for (const k of ['fibras', 'por_tubo', 'colores']) form.elements[k].addEventListener('change', pintarTubos);
    pintarTubos();

    enviar(form, async () => {
      const base = leerForm(form, comunes);
      if (!base.nombre) throw new Error('Poné un nombre o código.');
      const cuerpo = {
        nombre: base.nombre,
        tipo: base.tipo || 'distribucion',
        fibras: Number(base.fibras || 12),
        por_tubo: Number(base.por_tubo || 0),
        colores: base.colores || 'tia598',
        estado: base.estado || 'instalado',
        tendido: base.tendido || 'aereo',
        datos: leerForm(form, propios),
        notas: form.elements.notas.value.trim(),
      };
      if (!feature) {
        cuerpo.coords = estado.coords;
        cuerpo.nodos = estado.nodos;
      }
      recordarCable({
        tipo: cuerpo.tipo, fibras: cuerpo.fibras, por_tubo: cuerpo.por_tubo, colores: cuerpo.colores,
        tendido: cuerpo.tendido, estado: cuerpo.estado,
      });
      await acciones.guardarCable(cuerpo, feature);
    });
    abrir('form-cable', [form], { titulo: feature ? `Editar ${props.nombre || 'cable'}` : 'Cable nuevo', chip: feature ? 'Cable' : null });
    actual = estado;
    const nombre = form.elements.nombre;
    nombre.focus({ preventScroll: true });
    if (!feature) nombre.select();
  }

  // Las fibras del cable por tubo, en colores; las que tienen uniones, marcadas.
  function bloqueFibras(feature) {
    const props = feature.properties;
    const s = red.state;
    const est = F.estructura(props);
    const usos = F.indice(s).porCable.get(feature.id) ?? new Map();
    const detalle = h('div.fibras-detalle', { hidden: true });
    let elegida = null;
    const filas = [];
    const mostrarFibra = (n, b) => {
      if (elegida) elegida.setAttribute('aria-pressed', 'false');
      if (elegida === b) {
        elegida = null;
        detalle.hidden = true;
        return;
      }
      elegida = b;
      b.setAttribute('aria-pressed', 'true');
      const lista = usos.get(n) ?? [];
      const items = lista.map((u) => {
        const ext = F.extremoCable(feature.id, u.lado, n);
        const otroExt = u.fusion.a === ext ? u.fusion.b : u.fusion.a;
        return h('li', { text: `${F.nombreElemento(s, u.elemento)}: unida con ${F.etiquetaExtremo(s, otroExt)}` });
      });
      detalle.replaceChildren(...[
        h('p', {}, h('strong', { text: F.etiquetaFibra(props, n) })),
        items.length ? h('ul', {}, ...items) : h('p.ficha-sub', { text: 'Sin uniones: va de punta a punta del cable sin cortar.' }),
        lista.length ? botones(boton('Ver recorrido', () => acciones.verRecorrido(lista[0].elemento, F.extremoCable(feature.id, lista[0].lado, n)))) : null,
      ].filter(Boolean));
      detalle.hidden = false;
    };
    for (let t = 1; t <= est.tubos; t += 1) {
      const colorTubo = est.codigo.tubo(t);
      const puntos = [];
      for (let n = (t - 1) * est.porTubo + 1; n <= Math.min(t * est.porTubo, est.fibras); n += 1) {
        const info = F.infoFibra(props, n);
        const usada = usos.has(n);
        const b = h(`button.fibra-chip${usada ? '.usada' : ''}`, {
          type: 'button',
          title: `${F.etiquetaFibra(props, n)}${usada ? ' · con uniones' : ''}`,
          'aria-label': `${F.etiquetaFibra(props, n)}${usada ? ', con uniones' : ', sin uniones'}`,
          'aria-pressed': 'false',
        }, h(`span.punto${marcasClase(info.color)}`, { style: estiloColor(info.color) }), h('span', { text: String(n) }));
        b.addEventListener('click', () => mostrarFibra(n, b));
        puntos.push(b);
      }
      filas.push(h('div.fibras-tubo', {},
        est.tubos > 1 ? h('span.fibras-tubo-nombre', {}, h(`span.tubo-color${marcasClase(colorTubo)}`, { style: estiloColor(colorTubo) }),
          `T${t} ${F.nombreColor(colorTubo)}`) : null,
        h('div.fibras-puntos', {}, ...puntos)));
    }
    const usadas = usos.size;
    return h('div.ficha-fibras', {},
      h('p.ficha-sub', { text: `${est.fibras} fibras · ${est.tubos > 1 ? `${est.tubos} tubos de ${est.porTubo}` : 'un tubo'} · colores ${est.codigo.label}`
        + ` · ${usadas ? `${plural(usadas, 'fibra', 'fibras')} con uniones` : 'sin uniones todavía'}` }),
      ...filas,
      detalle);
  }

  function verCable(feature) {
    const props = feature.properties;
    const def = CABLES[props.tipo] ?? { label: props.tipo };
    const datos = props.datos ?? {};
    const pasaPor = [...new Set((props.nodos ?? []).filter((n) => n !== null))]
      .map((id) => red.state.elementos.get(id))
      .filter(Boolean);
    const reserva = Number(datos.reserva) || 0;
    const largo = reserva
      ? `${formatLargo(props.largo_m)} + ${formatLargo(reserva)} de reservas = ${formatLargo(props.largo_m + reserva)}`
      : formatLargo(props.largo_m);
    const usos = F.indice(red.state).porCable.get(feature.id);
    const uniones = new Set();
    for (const lista of usos?.values() ?? []) for (const u of lista) uniones.add(u.fusion.id);

    const detalle = h('dl.ficha-datos', {},
      fila('Tipo', def.label),
      fila('Largo', largo),
      fila('Estado', ESTADOS[props.estado] ?? props.estado),
      fila('Tendido', TENDIDOS[props.tendido] ?? props.tendido),
      ...CAMPOS.cable.filter((c) => c.k !== 'reserva').map((c) => fila(c.l, datos[c.k])),
      fila('Notas', props.notas),
      fila('Puntos', feature.geometry.coordinates.length),
    );
    const lista = pasaPor.length
      ? h('div.ficha-lista', {},
        h('p.ficha-sub', { text: 'Pasa por' }),
        h('ul', {}, ...pasaPor.map((e) => h('li', {},
          boton(`${e.properties.nombre} · ${ELEMENTOS[e.properties.tipo]?.label ?? e.properties.tipo}`,
            () => acciones.seleccionar('elemento', e.id), { class: 'enlace' }),
        ))),
      )
      : null;
    const confirmar = confirmacion(
      `¿Borrar ${props.nombre}?${uniones.size ? ` Se quitan también sus ${plural(uniones.size, 'unión', 'uniones')} en las cartas de empalme.` : ''}`,
      () => acciones.borrarCable(feature),
    );
    abrir('cable', [
      detalle,
      bloqueFibras(feature),
      lista,
      firma(props),
      botones(
        boton('Editar', () => formCable({ feature }), { class: 'primario' }),
        boton('Trazado', () => acciones.editarTrazado(feature), { title: 'Mover, agregar o quitar puntos del cable' }),
        boton('Borrar', () => { confirmar.hidden = false; confirmar.scrollIntoView({ block: 'nearest' }); }),
      ),
      confirmar,
    ], { titulo: props.nombre || 'Cable', chip: `${def.label} · ${props.fibras} F`, id: `c${feature.id}` });
    actual = { feature };
  }

  // ---------------------------------------------------------- recorrido

  function textoPaso(s, paso, primero) {
    const nombre = (id) => F.nombreElemento(s, id);
    const etiqueta = (ext) => F.etiquetaExtremo(s, ext);
    switch (paso.tipo) {
      case 'inicio':
        return { clase: 'inicio', texto: `Elegida: ${etiqueta(paso.ext)}`, sub: `en ${nombre(paso.elemento)}` };
      case 'tramo': {
        const cable = s.cables.get(paso.cable);
        const props = cable?.properties;
        return {
          clase: 'tramo',
          texto: props ? `${props.nombre} · ${F.etiquetaFibra(props, paso.fibra)}` : 'Cable borrado',
          sub: [formatLargo(paso.metros), paso.pasaPor.length ? `pasa por ${paso.pasaPor.map(nombre).join(', ')}` : '']
            .filter(Boolean).join(' · '),
          ...F.coloresDeTramo(s, paso),
        };
      }
      case 'union':
        return {
          clase: 'union',
          texto: `${nombre(paso.elemento)}: ${paso.fusion.tipo === 'conector' ? 'conector' : 'fusión'}`,
          sub: `${etiqueta(paso.de)} ↔ ${etiqueta(paso.a)}`,
        };
      case 'equipo': {
        const eq = s.equipos.get(paso.equipo);
        return { clase: 'equipo', texto: `${nombre(paso.elemento)}: pasa por ${eq?.nombre || 'el splitter'} (${eq ? F.describirEquipo(eq) : ''})`, sub: `${etiqueta(paso.de)} → ${etiqueta(paso.a)}` };
      }
      default: {
        const eq = paso.equipo ? s.equipos.get(paso.equipo) : null;
        // El primer paso es de donde viene el pelo; el último, adonde llega.
        const textos = {
          olt: () => ({ texto: `${nombre(paso.elemento)}: ${eq ? F.etiquetaPuerto(eq, 's', paso.puerto) : 'OLT'}`,
            sub: primero ? 'Sale de la OLT' : 'Llega a la OLT' }),
          cliente: () => ({ texto: `${primero ? 'Desde' : 'Llega a'} ${nombre(paso.elemento)}`, sub: 'Cliente' }),
          'sin-union': () => ({ texto: `${primero ? 'Desde' : 'Termina en'} ${nombre(paso.elemento)}`,
            sub: s.elementos.get(paso.elemento)?.properties.tipo === 'nodo'
              ? 'Ahí no está unida a nada: falta conectarla a la OLT' : 'Ahí no está unida a nada' }),
          cortada: () => ({ texto: `${primero ? 'Desde' : 'Cortada en'} ${nombre(paso.elemento)}`,
            sub: 'La fibra está cortada ahí: este tramo quedó libre' }),
          splitter: () => {
            const idx = F.indice(s);
            let usadas = 0;
            for (let k = 1; k <= (eq?.salidas ?? 0); k += 1) if (idx.usado.has(`${paso.elemento}|${F.extremoEquipo(eq.id, 's', k)}`)) usadas += 1;
            return { texto: `${nombre(paso.elemento)}: entra a ${eq?.nombre || 'un splitter'}`, sub: eq ? `Se abre en ${eq.salidas} salidas (${usadas} en uso)` : '' };
          },
          suelto: () => ({ texto: 'Termina en el extremo suelto del cable', sub: 'No está pegado a ningún elemento' }),
          lazo: () => ({ texto: 'Vuelve sobre sí mismo', sub: 'Revisá las uniones: forman un círculo' }),
          largo: () => ({ texto: 'Recorrido demasiado largo', sub: 'Se cortó para no colgar la página' }),
        };
        return { clase: 'fin', ...(textos[paso.motivo] ?? (() => ({ texto: 'Fin', sub: '' })))() };
      }
    }
  }

  function verRecorrido({ resultado, elementoId, ext, volver }) {
    const s = red.state;
    const pot = F.potencias(s, resultado);
    const partes = [formatLargo(resultado.metros) + ' de fibra'];
    if (resultado.fusiones) partes.push(plural(resultado.fusiones, 'fusión', 'fusiones'));
    if (resultado.conectores) partes.push(plural(resultado.conectores, 'conector', 'conectores'));
    for (const eq of resultado.splitters) partes.push(`splitter ${F.describirEquipo(eq)}`);
    const pasos = resultado.pasos.map((paso, i) => {
      const t = textoPaso(s, paso, i === 0);
      const p = pot.porPaso[i];
      // Lo que se pierde en el paso y, si se sabe, con cuánto se sale de él.
      let cuenta = '';
      if (p.perdida >= 0.05) cuenta = `−${formatDb(p.perdida)}`;
      if (p.potencia !== null && (paso.tipo === 'union' || paso.tipo === 'equipo' || (paso.tipo === 'fin' && i > 0))) {
        cuenta = [cuenta, `≈ ${formatDbm(p.potencia)}`].filter(Boolean).join(' → ');
      }
      const color = t.color ? `--c:${t.color.hex};--t:${(t.tubo ?? t.color).hex};--m:${t.color.marca ?? '#1c1c1c'}` : null;
      return h(`li.rec-paso.rec-${t.clase}${t.color?.marcas ? '.rec-marca' : ''}`, { style: color },
        h('strong', {},
          t.color ? h(`span.punto${marcasClase(t.color)}`, { style: estiloColor(t.color), 'aria-hidden': 'true' }) : null,
          t.texto),
        t.sub ? h('small', { text: t.sub }) : null,
        cuenta ? h('small.rec-pot', { text: cuenta }) : null);
    });
    const balance = [];
    if (pot.total >= 0.05) balance.push(`Pérdida estimada: ${formatDb(pot.total)}${pot.incompleta ? ' (sin un splitter de tamaño desconocido)' : ''}`);
    if (pot.llega !== null) balance.push(`llega con ≈ ${formatDbm(pot.llega)} (la OLT sale con ${formatDbm(pot.inicial)})`);
    else if (pot.olt) balance.push('cargá la potencia de la OLT para estimar con cuánto llega');
    abrir('recorrido', [
      h('p.ficha-sub', { text: partes.join(' · ') }),
      balance.length ? h('p.rec-balance', { text: balance.join(' · ') }) : null,
      h('ol.recorrido', {}, ...pasos),
      h('p.ficha-nota', { text: `Estimación con ${String(F.PERDIDAS.fibraKm).replace('.', ',')} dB/km, ${String(F.PERDIDAS.fusion).replace('.', ',')} dB por fusión, ${String(F.PERDIDAS.conector).replace('.', ',')} dB por conector y la pérdida típica de cada splitter.` }),
      botones(
        volver ? boton('Volver a la carta', volver, { class: 'primario' }) : null,
        boton('Cerrar', () => acciones.cancelar()),
      ),
    ], { titulo: 'Recorrido del pelo', chip: F.etiquetaExtremo(s, ext), id: `r${elementoId}:${ext}` });
    actual = { recorrido: { elementoId, ext } };
  }

  // -------------------------------------------------------------- redes

  function redes({ lista, actualId }) {
    const items = lista.map((r) => {
      const id = `red-${r.id}`;
      return h('li', {},
        h('label.opcion', { for: id },
          h('input', { type: 'radio', name: 'red', id, value: String(r.id), checked: r.id === actualId,
            onchange: () => acciones.elegirRed(r.id) }),
          h('span', {}, h('strong', { text: r.nombre }),
            h('small', { text: `${r.elementos} elemento${r.elementos === 1 ? '' : 's'} · ${r.cables} cable${r.cables === 1 ? '' : 's'}` })),
        ),
      );
    });

    const input = h('input', { type: 'text', name: 'nombre', placeholder: 'Cliente, localidad o despliegue', autocomplete: 'off', maxlength: 80 });
    const crear = h('form.ficha-form.ficha-nueva-red', { autocomplete: 'off', novalidate: true },
      h('label.campo', {}, h('span', { text: lista.length ? 'Nueva red' : 'Nombre de la primera red' }), input),
      botones(boton('Crear', null, { type: 'submit', class: 'primario' })),
    );
    enviar(crear, async () => {
      const nombre = input.value.trim();
      if (!nombre) throw new Error('Poné un nombre para la red.');
      await acciones.crearRed(nombre);
    });

    const actualRed = lista.find((r) => r.id === actualId);
    let renombrar = null;
    if (actualRed) {
      const nuevoNombre = h('input', { type: 'text', name: 'nombre', autocomplete: 'off', maxlength: 80, value: actualRed.nombre });
      renombrar = h('form.ficha-form.ficha-renombrar', { autocomplete: 'off', novalidate: true, hidden: true },
        h('label.campo', {}, h('span', { text: `Nuevo nombre de ${actualRed.nombre}` }), nuevoNombre),
        botones(boton('Guardar', null, { type: 'submit', class: 'primario' })),
      );
      enviar(renombrar, async () => {
        const nombre = nuevoNombre.value.trim();
        if (!nombre) throw new Error('Poné un nombre para la red.');
        await acciones.renombrarRed(actualRed.id, nombre);
      });
    }

    abrir('redes', [
      h('p.ficha-sub', { text: lista.length
        ? 'Cada red (un cliente, una localidad, un despliegue) tiene sus propios elementos y cables. Elegí con cuál trabajar.'
        : 'Todavía no hay redes. Cada red (un cliente, una localidad, un despliegue) tiene sus propios elementos y cables.' }),
      lista.length ? h('ul.ficha-opciones', {}, ...items) : null,
      renombrar ? h('div.ficha-acciones.ficha-acciones-chicas', {},
        boton('Cambiar el nombre de esta red', () => {
          renombrar.hidden = !renombrar.hidden;
          if (!renombrar.hidden) renombrar.elements.nombre.focus();
        }, { class: 'enlace' })) : null,
      renombrar,
      crear,
    ], { titulo: 'Redes', onCerrar: () => (lista.length ? acciones.cancelar() : null) });
    if (!lista.length) input.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------- utilidades

  function ocupado(form, si) {
    for (const el of form.querySelectorAll('button, input, select, textarea')) el.disabled = si;
  }

  function recordarCable(valores) {
    try {
      if (valores) localStorage.setItem('ftth.cable', JSON.stringify(valores));
      return JSON.parse(localStorage.getItem('ftth.cable')) ?? {};
    } catch {
      return {};
    }
  }

  return {
    cerrar,
    abierta: () => !root.hidden,
    modo: () => modo,
    actual: () => actual,
    formElemento,
    verElemento,
    formCable,
    verCable,
    verRecorrido,
    redes,
  };
}
