// Buscador: acepta coordenadas ("-26.1849, -58.1731") o un texto que se
// consulta en Nominatim (OpenStreetMap). Una búsqueda por envío, nunca mientras
// se escribe: es la condición de uso del servicio público.

const COORDS = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;
const MIN_INTERVAL_MS = 1100;

export function setupSearch({ map, maplibregl, config }) {
  const form = document.getElementById('search');
  const input = document.getElementById('search-input');
  const results = document.getElementById('search-results');
  const geocoder = config.geocoder;

  if (!geocoder) input.placeholder = 'Coordenadas: -26.1849, -58.1731';

  let marker;
  let lastRequestAt = 0;
  let pending;

  const closeResults = () => {
    results.hidden = true;
    results.replaceChildren();
  };

  function goTo(lngLat, bounds) {
    marker?.remove();
    marker = new maplibregl.Marker({ color: '#e8590c' }).setLngLat(lngLat).addTo(map);
    if (bounds) map.fitBounds(bounds, { maxZoom: 17, padding: 60 });
    else map.flyTo({ center: lngLat, zoom: Math.max(map.getZoom(), 17) });
  }

  function showMessage(text) {
    const p = document.createElement('p');
    p.className = 'search-message';
    p.textContent = text;
    results.replaceChildren(p);
    results.hidden = false;
  }

  function showPlaces(places) {
    const list = document.createElement('ul');
    for (const place of places) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = place.display_name;
      button.addEventListener('click', () => {
        const lngLat = [Number(place.lon), Number(place.lat)];
        const [south, north, west, east] = (place.boundingbox ?? []).map(Number);
        const bounds = Number.isFinite(south) ? [[west, south], [east, north]] : null;
        goTo(lngLat, bounds);
        closeResults();
        input.blur();
      });
      item.append(button);
      list.append(item);
    }
    const credit = document.createElement('p');
    credit.className = 'search-credit';
    credit.textContent = 'Búsqueda de Nominatim con datos de © OpenStreetMap';
    results.replaceChildren(list, credit);
    results.hidden = false;
  }

  async function searchPlaces(query) {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();

    pending?.abort();
    pending = new AbortController();
    const url = new URL(geocoder.url);
    url.search = new URLSearchParams({
      format: 'jsonv2',
      q: query,
      limit: '6',
      'accept-language': 'es',
      ...(geocoder.countryCodes ? { countrycodes: geocoder.countryCodes } : {}),
    });
    const res = await fetch(url, { signal: pending.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`El buscador respondió ${res.status}`);
    return res.json();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = input.value.trim();
    if (!query) return closeResults();

    const coords = query.match(COORDS);
    if (coords) {
      const lat = Number(coords[1]);
      const lng = Number(coords[2]);
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return showMessage('Esas coordenadas están fuera de rango. El orden es latitud, longitud.');
      closeResults();
      return goTo([lng, lat]);
    }

    if (!geocoder) return showMessage('Escribí las coordenadas como latitud, longitud. Por ejemplo: -26.1849, -58.1731');

    showMessage('Buscando…');
    try {
      const places = await searchPlaces(query);
      if (places.length === 0) showMessage(`No hay resultados para "${query}". Probá con la localidad y la provincia.`);
      else showPlaces(places);
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.warn(err);
      showMessage('El buscador no respondió. Revisá la conexión y probá de nuevo.');
    }
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeResults();
      input.blur();
    }
  });
  input.addEventListener('search', () => {
    if (!input.value) {
      closeResults();
      marker?.remove();
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (!results.hidden && !form.contains(event.target)) closeResults();
  });
}
