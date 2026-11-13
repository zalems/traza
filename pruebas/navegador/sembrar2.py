#!/usr/bin/env python3
"""Una segunda red sin Wispro ni OLT («Sin OLT»), con dos cajas: una con las bocas anotadas
y otra con splitter y un cliente dibujados. Imprime su número."""
import importlib.util
spec = importlib.util.spec_from_file_location("sembrar", __file__.replace("sembrar2.py", "sembrar.py"))
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)

s.pedir("POST", "/auth/login", {"usuario": s.USUARIO, "clave": s.CLAVE})
redes = s.pedir("GET", "/api/redes")["redes"]
hay = next((r for r in redes if r["nombre"] == "Sin OLT"), None)
if hay:
    print(hay["id"])
    raise SystemExit(0)
red = s.pedir("POST", "/api/redes", {"nombre": "Sin OLT"})["red"]["id"]
def elemento(tipo, nombre, lon, lat, **extra):
    return s.pedir("POST", "/api/elementos", {"red": red, "tipo": tipo, "nombre": nombre, "lon": lon, "lat": lat, **extra})["elemento"]
n1 = elemento("nap", "N-1", -58.150, -26.200, datos={"puertos": "8"})
n2 = elemento("nap", "N-2", -58.148, -26.200)
cli = elemento("cliente", "Cliente de N-2", -58.1478, -26.1996)
spl = s.pedir("POST", "/api/equipos", {"elemento": n2["id"], "tipo": "splitter", "nombre": "1x8", "entradas": 1, "salidas": 8,
                                      "datos": {"conectores": True}})["equipos"][0]
b = s.pedir("POST", "/api/cables", {"red": red, "nombre": "Bajada N-2", "tipo": "bajada", "fibras": 1,
                                    "coords": [n2["geometry"]["coordinates"], cli["geometry"]["coordinates"]],
                                    "nodos": [n2["id"], cli["id"]]})["cable"]
s.pedir("POST", "/api/fusiones", {"elemento": n2["id"], "pares": [{"a": f"q{spl['id']}:s:1", "b": f"c{b['id']}:b:1"}], "tipo": "conector"})
print(red)
