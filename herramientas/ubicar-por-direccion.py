#!/usr/bin/env python3
"""Cuántos clientes se pueden ubicar en el mapa por su dirección, con el normalizador de
direcciones del Estado argentino (Georef, apis.datos.gob.ar: gratis, sin clave, hasta
1000 direcciones por pedido).

Toma las ONU de un SmartOLT (todas tienen dirección) y manda cada dirección a Georef.
Informa cuántas se ubican, en qué localidad caen y, para las ONU y cajas (ODB) que ya
tienen coordenadas en SmartOLT, a qué distancia queda lo que dice Georef de lo real:
eso dice si sirve. Solo lee; no muestra nombres ni direcciones, salvo que se pida
--guardar, que deja en un archivo (solo legible por quien lo corre) las direcciones con
sus coordenadas, para después ubicar a los clientes en el mapa o cargarlas en Wispro.

Uso, en el servidor:
    python3 herramientas/ubicar-por-direccion.py --smartolt https://panel.ejemplo.net \\
        --localidad "Carcarañá" --provincia "Santa Fe" [--guardar /root/ubicaciones-carca.json]
"""

import argparse
import getpass
import json
import math
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.request

GEOREF = "https://apis.datos.gob.ar/georef/api/direcciones"
LOTE = 500  # direcciones por pedido (admite hasta 1000)


def haversine_m(a, b) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(min(1.0, math.sqrt(h)))


def numero(v):
    try:
        n = float(v)
        return n if math.isfinite(n) and abs(n) > 1e-6 else None
    except (TypeError, ValueError):
        return None


def pedir(url, cabeceras=None, datos=None, espera=120):
    cab = {"Accept": "application/json", **(cabeceras or {})}
    cuerpo = None
    if datos is not None:
        cuerpo = json.dumps(datos).encode()
        cab["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=cuerpo, headers=cab, method="POST" if cuerpo else "GET")
    try:
        with urllib.request.urlopen(req, timeout=espera) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"null")
        except ValueError:
            return e.code, None
    except Exception as e:  # sin conexión, tiempo
        return None, f"{type(e).__name__}: {e}"


def onus_de_smartolt(base, token):
    cab = {"X-Token": token}
    onus, pagina, total = [], 1, 1
    while pagina <= total and pagina <= 50:
        estado, dato = pedir(f"{base}/api/onu/get_all_onus_details?page={pagina}&page_size=100", cab)
        if estado != 200 or not isinstance(dato, dict):
            raise SystemExit(f"SmartOLT respondió {estado} en la página {pagina}: {str(dato)[:200]}")
        if pagina == 1:
            try:
                total = int(dato.get("total_pages") or 1)
            except (TypeError, ValueError):
                total = 1
        parte = dato.get("onus") or []
        if not parte:
            break
        onus += [o for o in parte if isinstance(o, dict)]
        pagina += 1
    estado, dato = pedir(f"{base}/api/system/get_odbs", cab)
    odbs = [o for o in (dato.get("response") or []) if isinstance(o, dict)] if estado == 200 and isinstance(dato, dict) else []
    return onus, odbs


def limpiar_direccion(texto: str) -> str:
    """'Av. San Martín 1234 dpto 2 (frente a la plaza)' -> 'Av. San Martín 1234'."""
    s = re.sub(r"\(.*?\)", " ", str(texto or ""))
    s = re.split(r"\b(dpto|depto|departamento|piso|local|casa|lote|mz|manzana|entre|esq|esquina|barrio|b°|bº)\b", s, 1, flags=re.I)[0]
    s = re.sub(r"\s+", " ", s).strip(" ,.-")
    return s[:120]


def geocodificar(direcciones, localidad, provincia, url=GEOREF):
    """[dirección] -> [{lon, lat, localidad, departamento, con_altura} | None]"""
    salida = []
    for i in range(0, len(direcciones), LOTE):
        parte = direcciones[i:i + LOTE]
        consultas = []
        for d in parte:
            q = {"direccion": d, "max": 1}
            if provincia:
                q["provincia"] = provincia
            if localidad:
                q["localidad_censal"] = localidad
            consultas.append(q)
        estado, dato = pedir(url, datos={"direcciones": consultas})
        if estado != 200 or not isinstance(dato, dict):
            raise SystemExit(f"Georef respondió {estado}: {str(dato)[:300]}")
        resultados = dato.get("resultados") or []
        for d, r in zip(parte, resultados):
            encontradas = (r or {}).get("direcciones") or []
            u = (encontradas[0].get("ubicacion") or {}) if encontradas else {}
            lat, lon = numero(u.get("lat")), numero(u.get("lon"))
            if lat is None or lon is None:
                salida.append(None)
                continue
            e = encontradas[0]
            salida.append({"lon": round(lon, 7), "lat": round(lat, 7),
                           "localidad": ((e.get("localidad_censal") or {}).get("nombre")),
                           "departamento": ((e.get("departamento") or {}).get("nombre")),
                           "con_altura": (e.get("altura") or {}).get("valor") is not None})
        salida += [None] * (len(parte) - len(resultados))
        time.sleep(0.5)
    return salida


def repartir(valores, cortes):
    cuenta = {}
    for v in valores:
        for hasta, etiqueta in cortes:
            if hasta is None or v < hasta:
                cuenta[etiqueta] = cuenta.get(etiqueta, 0) + 1
                break
    return ", ".join(f"{etiqueta}: {cuenta.get(etiqueta, 0)}" for _, etiqueta in cortes)


def main() -> int:
    ap = argparse.ArgumentParser(description="Ubicar clientes por su dirección (prueba con Georef).")
    ap.add_argument("--smartolt", required=True, metavar="URL", help="dirección de SmartOLT")
    ap.add_argument("--localidad", default="", help="localidad censal para acotar la búsqueda (recomendado)")
    ap.add_argument("--provincia", default="", help="provincia para acotar la búsqueda (recomendado)")
    ap.add_argument("--guardar", metavar="ARCHIVO", help="dejar las direcciones con sus coordenadas en este archivo (JSON)")
    ap.add_argument("--georef-url", default=GEOREF, help=argparse.SUPPRESS)  # para probar contra un Georef falso
    args = ap.parse_args()
    try:
        token = getpass.getpass("Token de la API de SmartOLT (no se ve al escribir): ").strip()
    except (EOFError, KeyboardInterrupt):
        token = ""
    if not token:
        print("Sin token.")
        return 1

    t = time.monotonic()
    onus, odbs = onus_de_smartolt(args.smartolt.rstrip("/"), token)
    print(f"SmartOLT: {len(onus)} ONU y {len(odbs)} ODB ({time.monotonic() - t:.1f} s).")
    con_dir = [o for o in onus if str(o.get("address") or "").strip()]
    print(f"ONU con dirección: {len(con_dir)}; con coordenadas en SmartOLT: "
          f"{sum(1 for o in onus if numero(o.get('latitude')) and numero(o.get('longitude')))}.")
    direcciones = [limpiar_direccion(o.get("address")) for o in con_dir]
    sin_numero = sum(1 for d in direcciones if not re.search(r"\d", d))
    print(f"Direcciones sin número: {sin_numero} (Georef ubica igual la calle, con menos precisión).")

    t = time.monotonic()
    ubicadas = geocodificar(direcciones, args.localidad.strip(), args.provincia.strip(), args.georef_url)
    print(f"\nGeoref ({'localidad ' + args.localidad if args.localidad else 'sin localidad'}): "
          f"{sum(1 for u in ubicadas if u)} de {len(direcciones)} ubicadas ({time.monotonic() - t:.1f} s); "
          f"con número de altura: {sum(1 for u in ubicadas if u and u['con_altura'])}.")
    por_localidad = {}
    for u in ubicadas:
        if u:
            k = f"{u['localidad']} ({u['departamento']})"
            por_localidad[k] = por_localidad.get(k, 0) + 1
    print("Dónde cayeron:", json.dumps(por_localidad, ensure_ascii=False))

    # Contra lo que SmartOLT ya tiene ubicado: la ONU misma, o su caja (ODB).
    odb_pos = {str(o.get("name")): (numero(o.get("longitude")), numero(o.get("latitude"))) for o in odbs}
    err_onu, err_odb = [], []
    for o, u in zip(con_dir, ubicadas):
        if not u:
            continue
        lon, lat = numero(o.get("longitude")), numero(o.get("latitude"))
        if lon and lat:
            err_onu.append(haversine_m([u["lon"], u["lat"]], [lon, lat]))
        p = odb_pos.get(str(o.get("odb_name") or ""))
        if p and p[0] and p[1]:
            err_odb.append(haversine_m([u["lon"], u["lat"]], [p[0], p[1]]))
    cortes = [(50, "< 50 m"), (150, "50–150 m"), (500, "150–500 m"), (2000, "500 m–2 km"), (None, "> 2 km")]
    if err_onu:
        print(f"\nContra las {len(err_onu)} ONU con coordenadas en SmartOLT (distancia entre Georef y lo cargado): "
              f"mediana {statistics.median(err_onu):.0f} m; " + repartir(err_onu, cortes) + ".")
    if err_odb:
        print(f"Contra la caja (ODB con coordenadas) de {len(err_odb)} ONU: mediana {statistics.median(err_odb):.0f} m; "
              + repartir(err_odb, cortes) + ".")
    if not err_onu and not err_odb:
        print("\nNo hay ONU ni cajas con coordenadas en SmartOLT para comparar.")

    if args.guardar:
        filas = []
        for o, d, u in zip(con_dir, direcciones, ubicadas):
            filas.append({"sn": o.get("sn"), "nombre": o.get("name"), "direccion": o.get("address"), "direccion_buscada": d,
                          "zona": o.get("zone_name"), "odb": o.get("odb_name") or None,
                          "smartolt": {"lon": numero(o.get("longitude")), "lat": numero(o.get("latitude"))},
                          "georef": u})
        with open(args.guardar, "w", encoding="utf-8") as fh:
            json.dump({"localidad": args.localidad, "provincia": args.provincia, "cuando": time.strftime("%Y-%m-%dT%H:%M:%S"),
                       "onus": filas}, fh, ensure_ascii=False, indent=1)
        os.chmod(args.guardar, 0o600)
        print(f"\nGuardado en {args.guardar} ({len(filas)} ONU; tiene nombres y direcciones: no lo compartas).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
