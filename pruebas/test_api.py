#!/usr/bin/env python3
"""Pruebas de la API de la red (api/ftth-api.py).

Levanta el servicio en un puerto libre con una base temporal y lo usa por
HTTP, como lo haría nginx (cabecera X-Usuario incluida).

  python3 -m unittest discover -s pruebas -v
"""

import importlib.util
import json
import os
import socket
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("ftth_api", os.path.join(RAIZ, "api", "ftth-api.py"))
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


def puerto_libre() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        api.Handler.store = api.Store(os.path.join(cls.tmp.name, "red.db"))
        cls.port = puerto_libre()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", cls.port), api.Handler)
        cls.httpd.daemon_threads = True
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def pedir(self, method, path, body=None, usuario="ana", headers=None, raw=None):
        h = {"Host": "traza.ejemplo"}
        if usuario:
            h["X-Usuario"] = usuario
        data = None
        if raw is not None:
            data = raw
        elif body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        h.update(headers or {})
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=5) as res:
                return res.status, json.loads(res.read() or b"null")
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read() or b"null")

    def ok(self, method, path, body=None, status=200, **kw):
        code, data = self.pedir(method, path, body, **kw)
        self.assertEqual(code, status, data)
        return data

    def nueva_red(self, nombre):
        return self.ok("POST", "/api/redes", {"nombre": nombre}, status=201)["red"]["id"]

    def elemento(self, red, tipo, lon, lat, nombre="", **extra):
        body = {"red": red, "tipo": tipo, "lon": lon, "lat": lat, "nombre": nombre, **extra}
        return self.ok("POST", "/api/elementos", body, status=201)["elemento"]

    # ------------------------------------------------------------- básicos

    def test_salud_y_sesion(self):
        self.assertEqual(self.pedir("GET", "/api/salud", usuario=None)[0], 200)
        self.assertEqual(self.pedir("GET", "/api/yo", usuario=None)[0], 401)
        self.assertEqual(self.ok("GET", "/api/yo")["usuario"], "ana")
        self.assertEqual(self.pedir("GET", "/api/nada")[0], 404)

    def test_redes(self):
        red = self.nueva_red("Clorinda")
        code, data = self.pedir("POST", "/api/redes", {"nombre": "clorinda"})
        self.assertEqual(code, 409)
        self.assertIn("Ya existe", data["error"])
        self.assertEqual(self.pedir("POST", "/api/redes", {"nombre": "  "})[0], 400)
        nombres = [r["nombre"] for r in self.ok("GET", "/api/redes")["redes"]]
        self.assertIn("Clorinda", nombres)
        self.ok("PUT", f"/api/redes/{red}", {"nombre": "Clorinda centro"})
        self.assertEqual(self.ok("GET", f"/api/red?red={red}")["red"]["nombre"], "Clorinda centro")
        self.assertEqual(self.pedir("GET", "/api/red?red=99999")[0], 404)
        self.assertEqual(self.pedir("GET", "/api/red?red=x")[0], 400)

    def test_validaciones(self):
        red = self.nueva_red("Validaciones")
        malos = [
            {"red": red, "tipo": "antena", "lon": -58, "lat": -26},
            {"red": red, "tipo": "poste", "lon": -580, "lat": -26},
            {"red": red, "tipo": "poste", "lon": "nan", "lat": -26},
            {"red": red, "tipo": "poste", "lon": True, "lat": -26},
            {"red": red, "tipo": "poste", "lat": -26},
            {"red": red, "tipo": "poste", "lon": -58, "lat": -26, "estado": "roto"},
            {"red": red, "tipo": "poste", "lon": -58, "lat": -26, "nombre": "x" * 81},
            {"red": red, "tipo": "poste", "lon": -58, "lat": -26, "datos": [1]},
            {"red": red, "tipo": "poste", "lon": -58, "lat": -26, "datos": {"a": {"b": 1}}},
            {"tipo": "poste", "lon": -58, "lat": -26},
        ]
        for body in malos:
            with self.subTest(body=body):
                code, data = self.pedir("POST", "/api/elementos", body)
                self.assertIn(code, (400, 404), data)
        # JSON por formulario de otro sitio: rechazado por tipo y por origen.
        code, _ = self.pedir("POST", "/api/redes", raw=b'{"nombre":"x"}', headers={"Content-Type": "text/plain"})
        self.assertEqual(code, 415)
        code, _ = self.pedir("POST", "/api/redes", {"nombre": "Ajena"}, headers={"Origin": "https://otro.sitio"})
        self.assertEqual(code, 403)
        self.ok("POST", "/api/redes", {"nombre": "Propia"}, status=201, headers={"Origin": "https://traza.ejemplo"})
        code, _ = self.pedir("POST", "/api/redes", raw=b"x" * (api.MAX_BODY + 1),
                             headers={"Content-Type": "application/json"})
        self.assertEqual(code, 413)
        code, _ = self.pedir("POST", "/api/redes", raw=b"[" * 100000, headers={"Content-Type": "application/json"})
        self.assertEqual(code, 400)

    def test_tipos_y_datos(self):
        red = self.nueva_red("Tipos")
        for tipo in api.TIPOS_ELEMENTO:
            e = self.elemento(red, tipo, -58.17, -26.18, nombre=tipo.upper(),
                              datos={"potencia": -21.5, "abonado": "1234", "vacio": ""})
            self.assertEqual(e["properties"]["tipo"], tipo)
            self.assertEqual(e["properties"]["datos"], {"potencia": -21.5, "abonado": "1234"})
            self.assertEqual(e["properties"]["creado_por"], "ana")

    # ------------------------------------------------- cables pegados

    def test_cable_pegado_sigue_al_poste(self):
        red = self.nueva_red("Anclajes")
        p1 = self.elemento(red, "poste", -58.1700, -26.1800, "P-1")
        p2 = self.elemento(red, "poste", -58.1690, -26.1800, "P-2")
        nap = self.elemento(red, "nap", -58.1680, -26.1805, "NAP-1")
        # El cliente manda coordenadas aproximadas: manda la posición del elemento.
        cable = self.ok("POST", "/api/cables", {
            "red": red, "nombre": "C-1", "tipo": "distribucion", "fibras": 24,
            "coords": [[-58.17001, -26.18001], [-58.1695, -26.1802], [-58.16901, -26.18001], [-58.1680, -26.1805]],
            "nodos": [p1["id"], None, p2["id"], nap["id"]],
        }, status=201)["cable"]
        coords = cable["geometry"]["coordinates"]
        self.assertEqual(coords[0], [-58.17, -26.18])
        self.assertEqual(coords[2], [-58.169, -26.18])
        largo = cable["properties"]["largo_m"]
        self.assertGreater(largo, 200)

        version = self.ok("GET", f"/api/red?red={red}")["version"]
        movido = self.ok("PUT", f"/api/elementos/{p2['id']}", {
            "lon": -58.1690, "lat": -26.1790, "version": p2["properties"]["version"]})
        self.assertEqual(len(movido["cables"]), 1)
        self.assertEqual(movido["cables"][0]["geometry"]["coordinates"][2], [-58.169, -26.179])
        self.assertNotEqual(movido["cables"][0]["properties"]["largo_m"], largo)

        cambios = self.ok("GET", f"/api/cambios?red={red}&desde={version}")
        self.assertEqual([e["id"] for e in cambios["elementos"]], [p2["id"]])
        self.assertEqual([c["id"] for c in cambios["cables"]], [cable["id"]])
        self.assertEqual(cambios["version"], movido["version"])

        # Borrar el poste: el cable queda suelto en ese punto y ya no lo sigue.
        borrado = self.ok("DELETE", f"/api/elementos/{p2['id']}")
        self.assertEqual(borrado["cables"][0]["properties"]["nodos"], [p1["id"], None, None, nap["id"]])
        cambios = self.ok("GET", f"/api/cambios?red={red}&desde={movido['version']}")
        self.assertEqual(cambios["elementos"][0], {"id": p2["id"], "borrado": True, "modificado_por": "ana",
                                                   "version": borrado["version"]})
        self.assertEqual(self.pedir("PUT", f"/api/elementos/{p2['id']}", {"nombre": "x"})[0], 404)
        red_actual = self.ok("GET", f"/api/red?red={red}")
        self.assertEqual(len(red_actual["elementos"]["features"]), 2)
        self.assertEqual(len(red_actual["cables"]["features"]), 1)

        # Un elemento borrado o de otra red no puede sostener un cable.
        otra = self.nueva_red("Otra red")
        ajeno = self.elemento(otra, "poste", -58.0, -26.0)
        for nodo in (p2["id"], ajeno["id"]):
            code, data = self.pedir("POST", "/api/cables", {
                "red": red, "coords": [[-58.17, -26.18], [-58.0, -26.0]], "nodos": [p1["id"], nodo]})
            self.assertEqual(code, 409, data)

    def test_trazado(self):
        red = self.nueva_red("Trazado")
        p1 = self.elemento(red, "poste", -58.17, -26.18)
        p2 = self.elemento(red, "poste", -58.16, -26.18)
        cable = self.ok("POST", "/api/cables", {"red": red, "coords": [[-58.17, -26.18], [-58.16, -26.18]],
                                                 "nodos": [p1["id"], p2["id"]]}, status=201)["cable"]
        nuevo = self.ok("PUT", f"/api/cables/{cable['id']}", {
            "coords": [[-58.17, -26.18], [-58.165, -26.181], [-58.155, -26.18]],
            "nodos": [p1["id"], None, None],
            "version": cable["properties"]["version"],
        })["cable"]
        self.assertEqual(nuevo["properties"]["nodos"], [p1["id"], None, None])
        # p2 ya no sostiene al cable: moverlo no lo toca.
        movido = self.ok("PUT", f"/api/elementos/{p2['id']}", {"lon": -58.15, "lat": -26.17})
        self.assertEqual(movido["cables"], [])
        malos = [
            {"coords": [[-58.17, -26.18]]},
            {"coords": [[-58.17, -26.18], [-58.17, -26.18]]},
            {"coords": [[-58.17, -26.18], [-58.16, -26.18]], "nodos": [p1["id"]]},
            {"coords": [[-58.17, -26.18], [-58.16, -26.18]], "nodos": [p1["id"], "2"]},
            {"coords": [[-58.17, -26.18], [-58.16, -26.18]] * 1001},
            {"fibras": 0},
            {"fibras": "doce"},
            {"tipo": "aereo"},
        ]
        for body in malos:
            with self.subTest(body=body):
                self.assertEqual(self.pedir("PUT", f"/api/cables/{cable['id']}", body)[0], 400)

    def test_conflictos(self):
        red = self.nueva_red("Conflictos")
        nap = self.elemento(red, "nap", -58.17, -26.18, "NAP-1")
        v1 = nap["properties"]["version"]
        self.ok("PUT", f"/api/elementos/{nap['id']}", {"nombre": "NAP-1A", "version": v1}, usuario="beto")
        code, data = self.pedir("PUT", f"/api/elementos/{nap['id']}", {"nombre": "NAP-1B", "version": v1})
        self.assertEqual(code, 409)
        self.assertIn("beto", data["error"])
        self.assertEqual(data["actual"]["properties"]["nombre"], "NAP-1A")
        code, _ = self.pedir("DELETE", f"/api/elementos/{nap['id']}?version={v1}")
        self.assertEqual(code, 409)
        actual = data["actual"]["properties"]["version"]
        self.ok("DELETE", f"/api/elementos/{nap['id']}?version={actual}")

    def test_historial(self):
        red = self.nueva_red("Historial")
        e = self.elemento(red, "botella", -58.17, -26.18, "BOT-1")
        self.ok("PUT", f"/api/elementos/{e['id']}", {"nombre": "BOT-2"}, usuario="carla")
        hist = self.ok("GET", f"/api/historial?red={red}")["historial"]
        self.assertEqual([h["accion"] for h in hist[:3]], ["editar", "crear", "crear"])
        self.assertEqual(hist[0]["usuario"], "carla")
        self.assertEqual(hist[0]["detalle"]["antes"]["properties"]["nombre"], "BOT-1")

    def test_entradas_raras(self):
        red = self.nueva_red("Raras")
        self.assertEqual(self.pedir("GET", f"/api/cambios?red={red}&desde={2 ** 70}")[0], 400)
        self.assertEqual(self.pedir("GET", f"/api/red?red={2 ** 70}")[0], 400)
        self.assertEqual(self.pedir("GET", "/api/elementos/%C2%B2")[0], 404)
        code, data = self.pedir("POST", "/api/elementos", raw=b'{"red": %d, "tipo": "poste", "lon": -58, "lat": -26, "nombre": "\\ud800"}' % red,
                                headers={"Content-Type": "application/json"})
        self.assertEqual(code, 400, data)
        code, _ = self.pedir("POST", "/api/cables", {"red": red, "coords": [[-58.17, -26.18], [-58.16, -26.18]],
                                                       "nodos": [2 ** 70, None]})
        self.assertEqual(code, 400)
        # Dos puntos pegados al mismo elemento: largo cero, rechazado.
        p = self.elemento(red, "poste", -58.17, -26.18)
        code, _ = self.pedir("POST", "/api/cables", {"red": red, "coords": [[-58.17, -26.18], [-58.16, -26.18]],
                                                       "nodos": [p["id"], p["id"]]})
        self.assertEqual(code, 400)

    def test_secreto(self):
        api.Handler.secreto = "s" * 40
        try:
            self.assertEqual(self.pedir("GET", "/api/salud", usuario=None)[0], 200)
            self.assertEqual(self.pedir("GET", "/api/yo")[0], 403)
            self.assertEqual(self.pedir("GET", "/api/yo", headers={"X-Ftth-Secreto": "x" * 40})[0], 403)
            self.assertEqual(self.pedir("GET", "/api/yo", headers={"X-Ftth-Secreto": "s" * 40})[0], 200)
        finally:
            api.Handler.secreto = ""

    def test_migracion_idempotente(self):
        # Abrir la misma base dos veces no vuelve a aplicar el esquema.
        path = os.path.join(self.tmp.name, "otra.db")
        api.Store(path)
        store = api.Store(path)
        self.assertEqual(store.conn().execute("PRAGMA user_version").fetchone()[0], api.ESQUEMA)


if __name__ == "__main__":
    unittest.main()
