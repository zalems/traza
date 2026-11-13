#!/usr/bin/env python3
"""Arma la red de prueba en una instalación de prueba (por nginx, con login). Nunca en producción.

  python3 sembrar.py            crea la red «Formosa prueba», la conecta con los falsos,
                                trae cajas y clientes y dibuja nodo, OLT, cables y splitters
Imprime el número de la red.
"""

import http.cookiejar
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("FTTH_BASE", "http://127.0.0.1:8080")
USUARIO, CLAVE = "prueba", "Clave-de-prueba-2026"  # el usuario de la instalación de prueba
LON0, LAT0 = -58.1700, -26.1800

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar))


def pedir(method, ruta, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + ruta, data=data, method=method, headers={
        "Origin": BASE, **({"Content-Type": "application/json"} if data else {})})
    try:
        with opener.open(req, timeout=90) as res:
            return json.loads(res.read() or b"null")
    except urllib.error.HTTPError as err:
        raise SystemExit(f"{method} {ruta} -> {err.code}: {err.read()[:400]!r}")


def integraciones(*args, entrada=None):
    cmd = ["runuser", "-u", "ftth", "--", "/usr/bin/python3", "-I", "/srv/ftth/api/ftth-api.py", "--db",
           "/srv/ftth/data/red.db", "integraciones", *args]
    r = subprocess.run(cmd, input=entrada, capture_output=True, text=True, cwd="/")
    if r.returncode:
        raise SystemExit(f"integraciones {args}: {r.stdout}{r.stderr}")


def main():
    nombre = sys.argv[1] if len(sys.argv) > 1 else "Formosa prueba"
    pedir("POST", "/auth/login", {"usuario": USUARIO, "clave": CLAVE})
    red = pedir("POST", "/api/redes", {"nombre": nombre})["red"]["id"]
    integraciones("wispro", str(red), "--token-stdin", "--wispro-url", "http://127.0.0.1:18091",
                  entrada="token-e2e-0123456789\n")
    integraciones("panel", str(red), "http://127.0.0.1:18092", "--olt", "1")
    res = pedir("POST", "/api/integracion/importacion", {"red": red, "cajas": True, "clientes": True})
    datos = pedir("GET", f"/api/red?red={red}")
    naps = {e["properties"]["nombre"]: e for e in datos["elementos"]["features"] if e["properties"]["tipo"] == "nap"}
    print(f"red {red}: {len(naps)} cajas, {sum(1 for e in datos["elementos"]["features"] if e["properties"]["tipo"] == "cliente")} clientes"
          f" ({res.get('agregados', res.get('resumen', ''))})", file=sys.stderr)

    def elemento(tipo, nombre, lon, lat, **extra):
        return pedir("POST", "/api/elementos", {"red": red, "tipo": tipo, "nombre": nombre, "lon": lon, "lat": lat, **extra})["elemento"]

    def cable(nombre, elementos, fibras, tipo="distribucion"):
        return pedir("POST", "/api/cables", {"red": red, "nombre": nombre, "tipo": tipo, "fibras": fibras,
                                             "coords": [e["geometry"]["coordinates"] for e in elementos],
                                             "nodos": [e["id"] for e in elementos]})["cable"]

    def equipo(elem, **body):
        return pedir("POST", "/api/equipos", {"elemento": elem["id"], **body})["equipos"][0]

    def unir(elem, pares, **extra):
        pedir("POST", "/api/fusiones", {"elemento": elem["id"], "pares": [{"a": a, "b": b} for a, b in pares], **extra})

    nodo = elemento("nodo", "Nodo Central", LON0, LAT0)
    olt = equipo(nodo, tipo="olt", nombre="MA5800 placa 1", salidas=16, datos={"desde": 0, "potencia": 4})
    bot = elemento("botella", "BOT-1", LON0 + 0.0011, LAT0 - 0.0010)
    t1 = cable("T1", [nodo, bot], 24, "troncal")
    unir(nodo, [(f"q{olt['id']}:s:{n}", f"c{t1['id']}:b:{n}") for n in (1, 2, 3)])
    for n, nombre_nap in ((1, "HP1C1"), (2, "HP1C3"), (3, "HP1C5")):
        nap = naps[nombre_nap]
        d = cable(f"D-{nombre_nap}", [bot, nap], 12)
        unir(bot, [(f"c{t1['id']}:a:{n}", f"c{d['id']}:b:1")])
        spl = equipo(nap, tipo="splitter", nombre="1x8", entradas=1, salidas=8, datos={"conectores": True})
        unir(nap, [(f"c{d['id']}:a:1", f"q{spl['id']}:e:1")])
        integ = pedir("GET", f"/api/integracion/nap?elemento={nap['id']}")
        clientes = [c["traza"]["id"] for c in integ.get("contratos", []) if (c.get("traza") or {}).get("id")]
        por_id = {e["id"]: e for e in datos["elementos"]["features"]}
        for k, cid in enumerate(clientes[:8], start=1):
            b = cable(f"Bajada {nombre_nap}-{k}", [nap, por_id[cid]], 1, "bajada")
            unir(nap, [(f"q{spl['id']}:s:{k}", f"c{b['id']}:b:1")], tipo="conector")
    print(red)


if __name__ == "__main__":
    main()
