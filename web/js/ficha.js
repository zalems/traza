// La ficha: el panel que muestra o edita un elemento, un cable, la lista de
// redes o el recorrido de un pelo. En el teléfono es una hoja que sube desde
// abajo; en pantallas grandes, un panel a la derecha.

import {
  CABLES, CAMPOS, CAMPOS_VIEJOS, ELEMENTOS, ESTADOS, FIBRAS, TENDIDOS, evaluarPotencia, formatFecha, formatLargo, nuevo,
  sugerirNombre,
} from './modelo.js';
import * as F from './fibras.js';

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

  function verElemento(feature) {
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
        conexion = h('div.ficha-conexion', {},
          h('p', {}, h('strong', { text: `${donde} · ${F.etiquetaExtremo(s, con.union.a)}` })),
          h('p.ficha-sub', { text: origen
            ? `Llega desde ${F.etiquetaPuerto(origen, 's', con.origen.puerto)} (${F.nombreElemento(s, con.origen.elemento)}).`
            : 'Según la carta de empalme. Del otro lado el pelo todavía no llega a una OLT.' }),
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
    abrir('elemento', [
      conexion,
      detalle,
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
    const partes = [formatLargo(resultado.metros) + ' de fibra'];
    if (resultado.fusiones) partes.push(plural(resultado.fusiones, 'fusión', 'fusiones'));
    if (resultado.conectores) partes.push(plural(resultado.conectores, 'conector', 'conectores'));
    for (const eq of resultado.splitters) partes.push(`splitter ${F.describirEquipo(eq)}`);
    const pasos = resultado.pasos.map((paso, i) => {
      const t = textoPaso(s, paso, i === 0);
      return h(`li.rec-paso.rec-${t.clase}`, {}, h('strong', { text: t.texto }), t.sub ? h('small', { text: t.sub }) : null);
    });
    abrir('recorrido', [
      h('p.ficha-sub', { text: partes.join(' · ') }),
      h('ol.recorrido', {}, ...pasos),
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
