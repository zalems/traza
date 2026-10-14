#!/usr/bin/env python3
"""Cómo están las ubicaciones de las NAPs y de los contratos en Wispro, para una red
de traza conectada con Wispro. Sirve para saber si conviene ubicar las cajas donde
dice Wispro o cerca de sus clientes.

Solo lee Wispro (con el token que ya está guardado en el servidor) y muestra cuentas
y distancias: ni nombres, ni direcciones, ni coordenadas.

Uso, en el servidor (como root):
    python3 herramientas/ubicaciones-wispro.py 1      # el número de la red (integraciones ver)

Usa la API instalada (/srv/ftth/api/ftth-api.py) y su configuración
(/srv/ftth/data/integraciones.json); FTTH_API_PY y FTTH_INTEGRACIONES las cambian.
"""

import importlib.util
import os
import re
import statistics
import sys
import time
from collections import Counter

API = os.environ.get("FTTH_API_PY", "/srv/ftth/api/ftth-api.py")
CONFIG = os.environ.get("FTTH_INTEGRACIONES", "/srv/ftth/data/integraciones.json")


def cargar_api():
    spec = importlib.util.spec_from_file_location("ftth_api_ubicaciones", API)
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)
    return modulo


def repartir(valores, cortes):
    """Cuántos valores caen en cada tramo: cortes = [(hasta, etiqueta), …, (None, etiqueta)]."""
    cuenta = Counter()
    for v in valores:
        for hasta, etiqueta in cortes:
            if hasta is None or v < hasta:
                cuenta[etiqueta] += 1
                break
    return ", ".join(f"{etiqueta}: {cuenta[etiqueta]}" for _, etiqueta in cortes)


def centro(puntos):
    """El centro de un grupo de puntos: la mediana de cada coordenada (no la mueve un punto mal cargado)."""
    return [statistics.median(p[0] for p in puntos), statistics.median(p[1] for p in puntos)]


def main() -> int:
    if len(sys.argv) != 2 or not sys.argv[1].isdigit():
        print(__doc__)
        return 2
    red = int(sys.argv[1])
    api = cargar_api()
    integ = api.Integraciones(CONFIG)
    if integ.wispro(red) is None:
        print(f"La red {red} no está conectada con Wispro (ver: /srv/ftth/bin/integraciones ver).")
        return 1
    t = time.monotonic()
    dw, _ = integ.datos_wispro(red)
    print(f"Wispro: {len(dw.naps)} NAPs y {len(dw.contratos)} contratos ({time.monotonic() - t:.1f} s).")

    d = api.haversine_m
    naps = {i: n for i, n in dw.naps_por_id.items() if isinstance(i, str) and i}
    lugar = {i: api.ubicacion(n.get("latitude"), n.get("longitude")) for i, n in naps.items()}
    con = [i for i in naps if lugar[i]]
    print(f"\nNAPs con ubicación: {len(con)}; sin ubicación: {len(naps) - len(con)}.")
    if con:
        vecinas = {i: sum(1 for j in con if d(lugar[i], lugar[j]) <= 150) for i in con}
        densa = max(con, key=lambda i: vecinas[i])
        exactas = Counter((round(lugar[i][0], 5), round(lugar[i][1], 5)) for i in con)
        print(f"La zona con más NAPs tiene {vecinas[densa]} a menos de 150 m de una de ellas.")
        print(f"NAPs en el mismo lugar que otra (a menos de 1 m): {sum(c for c in exactas.values() if c > 1)}, "
              f"en {sum(1 for c in exactas.values() if c > 1)} lugares.")
        ancho = d([min(lugar[i][0] for i in con), lugar[densa][1]], [max(lugar[i][0] for i in con), lugar[densa][1]])
        alto = d([lugar[densa][0], min(lugar[i][1] for i in con)], [lugar[densa][0], max(lugar[i][1] for i in con)])
        print(f"Las NAPs ocupan un área de {ancho / 1000:.1f} × {alto / 1000:.1f} km.")
        print("Distancia de cada NAP a la zona con más NAPs: "
              + repartir([d(lugar[i], lugar[densa]) for i in con],
                         [(150, "< 150 m"), (500, "150–500 m"), (2000, "500 m–2 km"), (None, "> 2 km")]) + ".")

    # Por OLT de Wispro: cuántas NAPs (y con qué prefijo de nombre) y cuántos contratos.
    print("\nPor OLT de Wispro (la de cada NAP):")
    prefijo = lambda n: (re.match(r"[A-Za-z]*", str(n.get("name") or "")).group(0).upper() or "(sin letras)")
    olt_de = {i: (dw.olts.get(n.get("olt_id")) or {}).get("name") or "sin OLT" for i, n in naps.items()}
    for olt in sorted(set(olt_de.values())):
        de_olt = [i for i in naps if olt_de[i] == olt]
        prefijos = Counter(prefijo(naps[i]) for i in de_olt)
        contratos = sum(len(dw.por_nap.get(i, [])) for i in de_olt)
        con_contratos = sum(1 for i in de_olt if dw.por_nap.get(i))
        print(f"  {olt}: {len(de_olt)} NAPs (nombres que empiezan con "
              + ", ".join(f"{k}: {v}" for k, v in prefijos.most_common(6))
              + f"); con contratos: {con_contratos}; contratos: {contratos}.")
    if con:
        grupos = {}
        for i in con:
            grupos.setdefault((round(lugar[i][0], 5), round(lugar[i][1], 5)), []).append(i)
        pares = [g for g in grupos.values() if len(g) > 1]
        if pares:
            combinaciones = Counter(" + ".join(sorted(olt_de[i] for i in g)) for g in pares)
            print(f"NAPs en el mismo lugar: {len(pares)} lugares; OLTs de cada grupo: "
                  + ", ".join(f"{k}: {v}" for k, v in combinaciones.most_common(5)) + ".")
            usadas = Counter(sum(1 for i in g if dw.por_nap.get(i)) for g in pares)
            palabra = {0: "ninguna", 1: "una", 2: "dos", 3: "tres"}
            print("En cada uno de esos lugares, cuántas NAPs tienen contratos: "
                  + ", ".join(f"{palabra.get(k, k)}: {v} lugares" for k, v in sorted(usadas.items())) + ".")
            prefijos_par = Counter(" + ".join(sorted(prefijo(naps[i]) for i in g)) for g in pares)
            print("Nombres de cada grupo: " + ", ".join(f"{k}: {v}" for k, v in prefijos_par.most_common(5)) + ".")
            con_uso = Counter(prefijo(naps[i]) for g in pares for i in g if dw.por_nap.get(i))
            print("De esos grupos, las NAPs con contratos empiezan con: "
                  + (", ".join(f"{k}: {v}" for k, v in con_uso.most_common(5)) or "ninguna tiene") + ".")

    items = [dw.contrato(c) for c in dw.contratos if c.get("id")]
    ubicados = [x for x in items if x["ubicacion"]]
    print(f"\nContratos con ubicación: {len(ubicados)} de {len(items)}; con NAP en Wispro: "
          f"{sum(1 for x in items if x['nap'] in naps)}.")
    if ubicados:
        ancho = d([min(x["ubicacion"][0] for x in ubicados), ubicados[0]["ubicacion"][1]],
                  [max(x["ubicacion"][0] for x in ubicados), ubicados[0]["ubicacion"][1]])
        alto = d([ubicados[0]["ubicacion"][0], min(x["ubicacion"][1] for x in ubicados)],
                 [ubicados[0]["ubicacion"][0], max(x["ubicacion"][1] for x in ubicados)])
        print(f"Los contratos ocupan un área de {ancho / 1000:.1f} × {alto / 1000:.1f} km.")
        a_su_nap = [d(x["ubicacion"], lugar[x["nap"]]) for x in ubicados if lugar.get(x["nap"])]
        print("Distancia de cada contrato a su NAP (según Wispro): "
              + repartir(a_su_nap, [(300, "< 300 m"), (1000, "300 m–1 km"), (2000, "1–2 km"), (None, "> 2 km")])
              + f"; sin poder medir (sin NAP o NAP sin ubicación): {len(ubicados) - len(a_su_nap)}.")

    por_nap = {}
    for x in ubicados:
        if x["nap"] in naps:
            por_nap.setdefault(x["nap"], []).append(x["ubicacion"])
    centros = {i: centro(p) for i, p in por_nap.items()}
    print(f"\nNAPs con clientes ubicados: {len(centros)} de {len(naps)}.")
    if centros:
        dispersion = [statistics.median(d(p, centros[i]) for p in por_nap[i]) for i in centros]
        print("Qué tan juntos están los clientes de cada NAP (mediana de su distancia al centro de ellos): "
              + repartir(dispersion, [(150, "< 150 m"), (300, "150–300 m"), (1000, "300 m–1 km"), (None, "> 1 km")]) + ".")
        lejos = [d(lugar[i], centros[i]) for i in centros if lugar.get(i)]
        print("Distancia de cada NAP (según Wispro) al centro de sus clientes: "
              + repartir(lejos, [(150, "< 150 m"), (500, "150–500 m"), (2000, "500 m–2 km"), (None, "> 2 km")])
              + f"; NAPs sin ubicación pero con clientes ubicados: {sum(1 for i in centros if not lugar.get(i))}.")
        if con:
            en_zona = [i for i in centros if lugar.get(i) and d(lugar[i], lugar[densa]) <= 150]
            if en_zona:
                print(f"De las NAPs de la zona con más NAPs, {len(en_zona)} tienen clientes ubicados; distancia al "
                      "centro de sus clientes: "
                      + repartir([d(lugar[i], centros[i]) for i in en_zona],
                                 [(150, "< 150 m"), (500, "150–500 m"), (2000, "500 m–2 km"), (None, "> 2 km")]) + ".")
    return 0


if __name__ == "__main__":
    sys.exit(main())
