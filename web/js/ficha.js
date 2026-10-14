// La ficha: el panel que muestra o edita un elemento, un cable o la lista de
// redes. En el teléfono es una hoja que sube desde abajo; en pantallas
// grandes, un panel a la derecha.

import {
  CABLES, CAMPOS, ELEMENTOS, ESTADOS, FIBRAS, TENDIDOS, evaluarPotencia, formatFecha, formatLargo, nuevo, sugerirNombre,
} from './modelo.js';

// Creador de nodos: h('tag.clase', { attr }, ...hijos). Todo texto va como
// texto (nunca como HTML).
function h(spec, attrs = {}, ...children) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') el.textContent = value;
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

export function setupFicha({ root, red, acciones }) {
  let modo = null; // 'elemento' | 'cable' | 'redes' | 'form-elemento' | 'form-cable'
  let actual = null;

  function cerrar() {
    root.hidden = true;
    root.replaceChildren();
    modo = null;
    actual = null;
  }

  function abrir(nuevoModo, contenido, { titulo, chip, onCerrar, id = null }) {
    // Si es la misma ficha (se actualizó con cambios de otros), queda donde estaba.
    const mismo = !root.hidden && modo === nuevoModo && id !== null && root.dataset.id === String(id);
    const desplazamiento = mismo ? root.querySelector('.ficha-cuerpo')?.scrollTop ?? 0 : 0;
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
      input.append(h('option', { value: '', text: '—' }));
      const actualValor = String(valor ?? '');
      let esta = actualValor === '';
      for (const opcion of def.o) {
        const [value, label] = Array.isArray(opcion) ? opcion : [String(opcion), String(opcion)];
        if (value === actualValor) esta = true;
        input.append(h('option', { value, text: label, selected: actualValor === value }));
      }
      // Un valor guardado que no está entre las opciones (cargado de otra forma) no se pierde.
      if (!esta) input.append(h('option', { value: actualValor, text: actualValor, selected: true }));
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
    const propios = CAMPOS[tipo] ?? [];
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
      const cuerpo = {
        tipo,
        nombre: base.nombre,
        estado: base.estado || 'instalado',
        datos: leerForm(form, propios),
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

  function verElemento(feature) {
    const props = feature.properties;
    const def = ELEMENTOS[props.tipo] ?? { label: props.tipo, nombre: props.tipo };
    const datos = props.datos ?? {};
    const [lng, lat] = feature.geometry.coordinates;
    const pegados = red.cablesPegados(feature.id);

    const detalle = h('dl.ficha-datos', {},
      fila('Estado', ESTADOS[props.estado] ?? props.estado),
      ...(CAMPOS[props.tipo] ?? []).map((c) => filaDato(c, datos[c.k])),
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
    const confirmar = confirmacion(
      pegados.length
        ? `¿Borrar ${props.nombre}? ${pegados.length === 1 ? 'El cable que pasa por acá queda suelto' : `Los ${pegados.length} cables que pasan por acá quedan sueltos`} en este punto.`
        : `¿Borrar ${props.nombre}?`,
      () => acciones.borrarElemento(feature),
    );
    abrir('elemento', [
      detalle,
      cables,
      firma(props),
      botones(
        boton('Editar', () => formElemento({ tipo: props.tipo, feature }), { class: 'primario' }),
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
      { k: 'estado', l: 'Estado', t: 'select', o: opcionesEstado },
      { k: 'tendido', l: 'Tendido', t: 'select', o: opcionesTendido },
    ];
    const propios = CAMPOS.cable;
    const estado = { feature, coords, nodos }; // los puntos pegados pueden corregirse con el formulario abierto
    const nombreSugerido = feature ? props.nombre : sugerirNombre('CAB', red.nombres('cable'));
    const puntos = coords ?? feature.geometry.coordinates;
    const pegados = (nodos ?? props.nodos ?? []).filter((n) => n !== null).length;

    const form = h('form.ficha-form', { autocomplete: 'off', novalidate: true },
      h('p.ficha-sub', { text: `${puntos.length} puntos · ${formatLargo(largo ?? props.largo_m)}`
        + (pegados ? ` · ${pegados} pegado${pegados === 1 ? '' : 's'} a elementos` : '') }),
      campo(comunes[0], nombreSugerido),
      campo(comunes[1], props.tipo ?? ultimo.tipo ?? 'distribucion'),
      campo(comunes[2], String(props.fibras ?? ultimo.fibras ?? 12)),
      campo(comunes[3], props.estado ?? ultimo.estado ?? 'instalado'),
      campo(comunes[4], props.tendido ?? ultimo.tendido ?? 'aereo'),
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
      const cuerpo = {
        nombre: base.nombre,
        tipo: base.tipo || 'distribucion',
        fibras: Number(base.fibras || 12),
        estado: base.estado || 'instalado',
        tendido: base.tendido || 'aereo',
        datos: leerForm(form, propios),
        notas: form.elements.notas.value.trim(),
      };
      if (!feature) {
        cuerpo.coords = estado.coords;
        cuerpo.nodos = estado.nodos;
      }
      recordarCable({ tipo: cuerpo.tipo, fibras: cuerpo.fibras, tendido: cuerpo.tendido, estado: cuerpo.estado });
      await acciones.guardarCable(cuerpo, feature);
    });
    abrir('form-cable', [form], { titulo: feature ? `Editar ${props.nombre || 'cable'}` : 'Cable nuevo', chip: feature ? 'Cable' : null });
    actual = estado;
    const nombre = form.elements.nombre;
    nombre.focus({ preventScroll: true });
    if (!feature) nombre.select();
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

    const detalle = h('dl.ficha-datos', {},
      fila('Tipo', def.label),
      fila('Fibras', props.fibras),
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
    const confirmar = confirmacion(`¿Borrar ${props.nombre}?`, () => acciones.borrarCable(feature));
    abrir('cable', [
      detalle,
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
      const nuevo = h('input', { type: 'text', name: 'nombre', autocomplete: 'off', maxlength: 80, value: actualRed.nombre });
      renombrar = h('form.ficha-form.ficha-renombrar', { autocomplete: 'off', novalidate: true, hidden: true },
        h('label.campo', {}, h('span', { text: `Nuevo nombre de ${actualRed.nombre}` }), nuevo),
        botones(boton('Guardar', null, { type: 'submit', class: 'primario' })),
      );
      enviar(renombrar, async () => {
        const nombre = nuevo.value.trim();
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
    redes,
  };
}
